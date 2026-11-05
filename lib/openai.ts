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

/** GPT Image 2.6 renders 1024x1024, 1536x1024 or 1024x1536; pick the closest shape. */
export function gptSize(width?: number, height?: number): string {
  if (!width || !height) return "auto";
  const r = width / height;
  if (r > 1.2) return "1536x1024";
  if (r < 1 / 1.2) return "1024x1536";
  return "1024x1024";
}

export async function createGptTask(opts: {
  imageModel: string;
  prompt: string;
  size: string;
  image?: { bytes: Buffer; mime: string };
  quality?: string;
}): Promise<string> {
  const quality = ["low", "medium", "high"].includes(opts.quality || "") ? opts.quality : "medium";
  const content: any[] = [
    {
      type: "input_text",
      text: opts.image
        ? `Use the image_generation tool to edit the attached image as follows:\n${opts.prompt}`
        : `Use the image_generation tool to create this image:\n${opts.prompt}`,
    },
  ];
  if (opts.image) {
    content.push({
      type: "input_image",
      image_url: `data:${opts.image.mime};base64,${opts.image.bytes.toString("base64")}`,
    });
  }
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
        ...(opts.image ? { action: "edit" } : {}),
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
    const quality = (json?.tools || []).find((t: any) => t?.type === "image_generation")?.quality;
    // Estimate in ¥ (OpenAI bills USD by tokens and returns no per-image price here).
    const cost = GPT_PRICE[(quality as Quality) in GPT_PRICE ? (quality as Quality) : "medium"];
    return { status: "SUCCESS", outputs: [url], cost: cost.toFixed(2) };
  }
  const err = image?.error || json?.error;
  const text = JSON.stringify(err || {});
  const errorMessage = /moderation/i.test(text)
    ? "内容没通过 OpenAI 审核，换个描述试试"
    : err?.message || (status === "completed" ? "OpenAI 没有返回图片" : `生成失败（${status || "未知状态"}）`);
  return { status: "FAILED", outputs: [], errorMessage };
}
