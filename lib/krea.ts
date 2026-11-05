import { saveImageBytes } from "./images";

/**
 * Krea 3 through Krea's own API (env KREA_API_KEY): submit returns a job id, the page
 * polls /api/task like the others, and the finished image is copied into the site's
 * store and served from /api/img/<task id>. Task ids are krea-<job uuid>.
 */
const API = "https://api.krea.ai";

export const KREA_RATIOS = ["1:1", "4:5", "3:4", "2:3", "9:16", "5:4", "4:3", "3:2", "16:9", "21:9"];

export function isKreaTask(taskId: string): boolean {
  return /^krea-[0-9a-f-]{20,60}$/i.test(taskId);
}

async function call(path: string, body?: unknown): Promise<any> {
  const key = process.env.KREA_API_KEY;
  if (!key) throw new Error("Krea 3 未配置");
  const res = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(45_000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = String(json?.message || json?.error || "");
    throw new Error(/balance|top up/i.test(msg) ? "Krea API 余额不足，请先充值" : msg || `Krea 错误 ${res.status}`);
  }
  return json;
}

function nearestRatio(w: number, h: number): string {
  const r = w / h;
  const value = (label: string) => {
    const [a, b] = label.split(":").map(Number);
    return a / b;
  };
  return KREA_RATIOS.reduce((best, cur) =>
    Math.abs(Math.log(value(cur) / r)) < Math.abs(Math.log(value(best) / r)) ? cur : best
  );
}

export async function createKreaTask(opts: {
  prompt: string;
  width?: number;
  height?: number;
  image?: { bytes: Buffer; mime: string };
  quality?: string;
}): Promise<string> {
  const body: Record<string, unknown> = {
    prompt: opts.prompt,
    thinking_mode: "fast",
    // 快速 = 1K, otherwise 2K (Krea's recommended final size).
    resolution: opts.quality === "low" ? "1K" : "2K",
  };
  if (opts.image) {
    body.image_urls = [`data:${opts.image.mime};base64,${opts.image.bytes.toString("base64")}`];
  } else if (opts.width && opts.height) {
    body.aspect_ratio = nearestRatio(opts.width, opts.height);
  }
  const json = await call("/generate/image/krea/krea-3", body);
  if (!json?.job_id) throw new Error("Krea 没有返回任务编号");
  return `krea-${json.job_id}`;
}

export async function queryKreaTask(taskId: string): Promise<{
  status: string;
  outputs: string[];
  cost?: string;
  errorMessage?: string;
}> {
  const job = await call(`/jobs/${taskId.slice(5)}`);
  const status = String(job?.status || "");
  if (status === "completed") {
    const url = job?.result?.urls?.[0];
    if (!url) return { status: "FAILED", outputs: [], errorMessage: "Krea 没有返回图片" };
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`下载结果失败 (${res.status})`);
    const saved = await saveImageBytes(taskId, Buffer.from(await res.arrayBuffer()));
    // Estimate in ¥: $0.03 at 1K, $0.06 at 2K, +$0.02 per reference.
    const big = /2k/i.test(String(job?.input?.resolution || job?.params?.resolution || "2K"));
    const refs = (job?.input?.image_urls || job?.params?.image_urls || []).length;
    return { status: "SUCCESS", outputs: [saved], cost: ((big ? 0.43 : 0.22) + refs * 0.15).toFixed(2) };
  }
  if (status === "failed" || status === "cancelled") {
    return { status: "FAILED", outputs: [], errorMessage: job?.error?.message || job?.error || "生成失败" };
  }
  return { status: "RUNNING", outputs: [] };
}
