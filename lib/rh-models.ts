import { saveImageBytes } from "./images";

/**
 * Hosted models on RunningHub's standard API (openapi/v2), no workflow needed:
 * Seedream 4.7 on the China site (RUNNINGHUB_API_KEY) and Nano Banana 2.1 on the
 * global site (RUNNINGHUB_AI_KEY). Task ids carry the site: rhs-<id> / rhb-<id>.
 * Finished images are copied into the site's store and served from /api/img/<task id>.
 */
type Site = "s" | "b";

const HOSTS: Record<Site, { base: string; env: string }> = {
  s: { base: "https://www.runninghub.cn/openapi/v2", env: "RUNNINGHUB_API_KEY" },
  b: { base: "https://www.runninghub.ai/openapi/v2", env: "RUNNINGHUB_AI_KEY" },
};

export const RH_HOSTED_MODELS: Record<string, { site: Site; path: string }> = {
  "banana-21": { site: "b", path: "rhart-image-n-nb21" },
};

export function rhHostedReady(model: string): boolean {
  const m = RH_HOSTED_MODELS[model];
  return !!m && !!process.env[HOSTS[m.site].env];
}

export function isRhHostedTask(taskId: string): boolean {
  return /^rh[sb]-[0-9A-Za-z]{4,60}$/.test(taskId);
}

async function call(site: Site, path: string, body: unknown): Promise<any> {
  const key = process.env[HOSTS[site].env];
  if (!key) throw new Error("模型未配置");
  const res = await fetch(`${HOSTS[site].base}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(45_000),
  });
  return res.json().catch(() => ({}));
}

const RATIOS: [string, number][] = [
  ["1:1", 1], ["3:4", 3 / 4], ["4:3", 4 / 3], ["2:3", 2 / 3], ["3:2", 3 / 2], ["9:16", 9 / 16], ["16:9", 16 / 9],
];

function nearestRatio(w: number, h: number): string {
  const r = w / h;
  return RATIOS.reduce((best, cur) => (Math.abs(Math.log(cur[1] / r)) < Math.abs(Math.log(best[1] / r)) ? cur : best))[0];
}

function clampSide(v: number): number {
  return Math.min(4096, Math.max(1024, Math.round(v / 16) * 16));
}

/** Width and height of a PNG, JPEG or WebP, so 图生图 keeps the reference's shape. */
function imageSize(b: Buffer): [number, number] | null {
  if (b[0] === 0x89 && b[1] === 0x50) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(12, 16).toString() === "VP8X") {
    return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

export async function createRhHostedTask(opts: {
  model: string;
  prompt: string;
  width?: number;
  height?: number;
  image?: { bytes: Buffer; mime: string };
}): Promise<string> {
  const m = RH_HOSTED_MODELS[opts.model];
  if (!m) throw new Error("未知模型");
  const ref = opts.image ? imageSize(opts.image.bytes) : null;
  const w = opts.width || ref?.[0] || 1024;
  const h = opts.height || ref?.[1] || 1024;
  const body: Record<string, unknown> = { prompt: opts.prompt };
  if (opts.image) body.imageUrls = [`data:${opts.image.mime};base64,${opts.image.bytes.toString("base64")}`];
  if (m.site === "b") {
    body.aspectRatio = nearestRatio(w, h);
    body.resolution = "2k";
  } else {
    // Keep the requested shape at about 4 MP or less (Seedream accepts 1024-4096 per side).
    const scale = Math.min(1, Math.sqrt((2048 * 2048) / (w * h)));
    body.width = clampSide(w * scale);
    body.height = clampSide(h * scale);
  }
  const json = await call(m.site, `${m.path}/${opts.image ? "image-to-image" : "text-to-image"}`, body);
  if (!json?.taskId) throw new Error(json?.errorMessage || "RunningHub 没有返回任务编号");
  return `rh${m.site}-${json.taskId}`;
}

export async function queryRhHostedTask(taskId: string): Promise<{
  status: string;
  outputs: string[];
  cost?: string;
  errorMessage?: string;
}> {
  const site = taskId[2] as Site;
  const json = await call(site, "query", { taskId: taskId.slice(4) });
  const status = String(json?.status || "");
  if (status === "SUCCESS") {
    const item = (json.results || [])[0] || {};
    const url = item.url || item.outputUrl;
    if (!url) return { status: "FAILED", outputs: [], errorMessage: "没有返回图片" };
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`下载结果失败 (${res.status})`);
    const saved = await saveImageBytes(taskId, Buffer.from(await res.arrayBuffer()));
    // Estimate in ¥: the global site bills about $0.03 per 2K image.
    return { status: "SUCCESS", outputs: [saved], cost: site === "b" ? "0.22" : undefined };
  }
  if (status === "FAILED") {
    const msg = String(json?.errorMessage || "");
    const errorMessage = /sensitive|审核/i.test(msg) ? "内容没通过审核，换个描述试试" : msg || "生成失败";
    return { status: "FAILED", outputs: [], errorMessage };
  }
  return { status: "RUNNING", outputs: [] };
}
