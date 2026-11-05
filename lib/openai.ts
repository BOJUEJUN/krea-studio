import { saveImageBytes } from "./images";
import { GPT_PRICE, type Quality } from "./models";

/**
 * GPT Image 2.6 through the OpenAI Responses API in background mode: submit returns a
 * response id (used as the task id) right away and the page polls /api/task as for
 * RunningHub. When the image is ready it is copied into the site's store and served
 * from /api/img/<task id>. The key stays on the server (env OPENAI_API_KEY).
 */
const API = "https://api.openai.com/v1/responses";
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-5.4-mini";

export function isGptTask(taskId: string): boolean {
  return /^resp_[0-9A-Za-z]{10,58}$/.test(taskId);
}

function key(): string {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error("GPT 模型未配置");
  return k;
}

async function call(url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message ? `OpenAI：${json.error.message}` : `OpenAI 错误 ${res.status}`);
  return json;
}

/**
 * GPT Image 2.6 takes custom WIDTHxHEIGHT: multiples of 16, aspect 1:3..3:1, edges <= 3840,
 * 655,360..8,294,400 pixels. The requested size is fitted into those limits.
 */
export function gptSize(width?: number, height?: number): string {
  if (!width || !height) return "auto";
  let r = Math.min(3, Math.max(1 / 3, width / height));
  let px = Math.min(8_294_400, Math.max(655_360, width * height));
  let w = Math.sqrt(px * r), h = w / r;
  const k = Math.min(1, 3840 / w, 3840 / h);
  w *= k; h *= k;
  const snap = (v: number) => Math.max(16, Math.round(v / 16) * 16);
  let W = snap(w), H = snap(h);
  while (W * H > 8_294_400) { W -= 16; H = snap(W / r); }
  while (W * H < 655_360) { W += 16; H = snap(W / r); }
  return `${W}x${H}`;
}

export async function createGptTask(opts: {
  imageModel: string;
  prompt: string;
  size: string;
  image?: { bytes: Buffer; mime: string };
  images?: { bytes: Buffer; mime: string }[];
  quality?: string;
  background?: string;
  complexity?: string;
}): Promise<string> {
  const refs = opts.images?.length ? opts.images : opts.image ? [opts.image] : [];
  const quality = ["low", "medium", "high"].includes(opts.quality || "") ? opts.quality : "medium";
  const content: any[] = [
    {
      type: "input_text",
      text: refs.length
        ? `Use the image_generation tool to edit the first attached image${refs.length > 1 ? " (the other images are references)" : ""} as follows:\n${opts.prompt}`
        : `Use the image_generation tool to create this image:\n${opts.prompt}`,
    },
  ];
  for (const r of refs.slice(0, 8)) {
    content.push({ type: "input_image", image_url: `data:${r.mime};base64,${r.bytes.toString("base64")}` });
  }
  const background = ["transparent", "opaque"].includes(opts.background || "") ? opts.background : undefined;
  const complexity = ["low", "medium", "high"].includes(opts.complexity || "") ? opts.complexity : undefined;
  const json = await call(API, {
    model: TEXT_MODEL,
    background: true,
    store: true,
    input: [{ role: "user", content }],
    tools: [
      {
        type: "image_generation",
        model: opts.imageModel,
        size: opts.size,
        quality,
        output_format: "png",
        moderation: "low",
        ...(background ? { background } : {}),
        ...(complexity ? { complexity } : {}),
        ...(refs.length ? { action: "edit" } : {}),
      },
    ],
    tool_choice: { type: "image_generation" },
  });
  if (!isGptTask(String(json?.id || ""))) throw new Error("OpenAI 没有返回任务编号");
  return json.id;
}

/** Same shape as queryCustomTask so /api/task and history treat both alike. */
export async function queryGptTask(taskId: string): Promise<{
  status: string;
  outputs: string[];
  cost?: string;
  errorMessage?: string;
}> {
  const json = await call(`${API}/${taskId}`);
  const status = String(json?.status || "");
  if (status === "queued" || status === "in_progress") return { status: "RUNNING", outputs: [] };
  const image = (json?.output || []).find((o: any) => o?.type === "image_generation_call");
  if (status === "completed" && image?.result) {
    const url = await saveImageBytes(taskId, Buffer.from(image.result, "base64"));
    const tool = (json?.tools || []).find((t: any) => t?.type === "image_generation") || {};
    const quality = tool.quality;
    // Estimate in ¥ (OpenAI bills USD by tokens and returns no per-image price here); scales with pixels.
    const [w, h] = String(image.size || tool.size || "1024x1024").split("x").map(Number);
    const mp = w && h ? Math.max(1, (w * h) / 1_048_576) : 1;
    const cost = GPT_PRICE[(quality as Quality) in GPT_PRICE ? (quality as Quality) : "medium"] * mp;
    return { status: "SUCCESS", outputs: [url], cost: cost.toFixed(2) };
  }
  const err = image?.error || json?.error;
  const text = JSON.stringify(err || {});
  const errorMessage = /moderation/i.test(text)
    ? "内容没通过 OpenAI 审核，换个描述试试"
    : err?.message || (status === "completed" ? "OpenAI 没有返回图片" : `生成失败（${status || "未知状态"}）`);
  return { status: "FAILED", outputs: [], errorMessage };
}
