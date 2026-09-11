/**
 * RunningHub OpenAPI v2 client — follows developer-kit contract strictly.
 * Base: https://www.runninghub.cn/openapi/v2
 * Auth: Authorization: Bearer <RH_API_KEY>
 */

const DEFAULT_BASE = "https://www.runninghub.cn/openapi/v2";

export type RHStatus =
  | "CREATE"
  | "QUEUED"
  | "RUNNING"
  | "SUCCESS"
  | "FAILED"
  | "CANCEL"
  | "UNKNOWN";

export type RHResultItem = {
  url?: string;
  outputUrl?: string;
  text?: string;
  content?: string;
  output?: string;
  outputType?: string;
};

export type RHQueryResponse = {
  taskId?: string;
  status?: string;
  errorCode?: string;
  errorMessage?: string;
  results?: RHResultItem[] | null;
  usage?: unknown;
};

export type RHRunResult = {
  taskId: string;
  status: RHStatus;
  outputs: string[];
  raw: RHQueryResponse;
};

export type ModelSpec = {
  id: string;
  endpoint: string;
  name: string;
  desc: string;
  kind: "t2i" | "i2i";
};

/** Curated CN-available endpoints verified via smoke tests. */
export const T2I_MODELS: ModelSpec[] = [
  {
    id: "jimeng-4.6",
    endpoint: "bytedance/jimeng-4.6/text-to-image",
    name: "即梦 4.6",
    desc: "快 · 便宜 · 动漫/写实都稳",
    kind: "t2i",
  },
  {
    id: "seedream-v5-pro",
    endpoint: "seedream-v5-pro/text-to-image",
    name: "Seedream V5 Pro",
    desc: "质感强 · 商业摄影风",
    kind: "t2i",
  },
  {
    id: "qwen-image-3.0-pro",
    endpoint: "alibaba/qwen-image-3.0-pro/text-to-image",
    name: "千问 3.0 Pro",
    desc: "中文提示词友好",
    kind: "t2i",
  },
  {
    id: "wan-2.7",
    endpoint: "alibaba/wan-2.7/text-to-image",
    name: "万相 2.7",
    desc: "细节丰富 · 略慢",
    kind: "t2i",
  },
];

export const I2I_MODELS: ModelSpec[] = [
  {
    id: "jimeng-4.6",
    endpoint: "bytedance/jimeng-4.6/image-to-image",
    name: "即梦 4.6",
    desc: "改图快 · 成本低",
    kind: "i2i",
  },
  {
    id: "seedream-v5-pro",
    endpoint: "seedream-v5-pro/image-to-image",
    name: "Seedream V5 Pro",
    desc: "重绘质感更好",
    kind: "i2i",
  },
];

function baseUrl() {
  return process.env.RH_API_BASE_URL || DEFAULT_BASE;
}

function apiKey(): string {
  const key =
    process.env.RUNNINGHUB_API_KEY || process.env.RH_API_KEY || "";
  if (!key) throw new Error("缺少 RUNNINGHUB_API_KEY");
  return key;
}

function authHeaders(json = true): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${apiKey()}`,
  };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function parseJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`RunningHub 非 JSON 响应 (HTTP ${res.status}): ${text.slice(0, 240)}`);
  }
}

/** POST {base}/media/upload/binary — field name: file */
export async function uploadMedia(file: Blob, filename = "input.png"): Promise<string> {
  const form = new FormData();
  form.append("file", file, filename);

  const res = await fetch(`${baseUrl()}/media/upload/binary`, {
    method: "POST",
    headers: authHeaders(false),
    body: form,
    cache: "no-store",
  });
  const json = await parseJson(res);
  const url = json?.data?.download_url;
  if (!url) {
    throw new Error(json?.msg || json?.message || "上传失败");
  }
  return url as string;
}

/** POST {base}/{endpoint} → taskId */
export async function submitTask(
  endpoint: string,
  payload: Record<string, unknown>
): Promise<string> {
  const res = await fetch(`${baseUrl()}/${endpoint.replace(/^\//, "")}`, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const json = await parseJson(res);

  // Compliance / offline models return taskId="" with errorCode
  const taskId = json?.taskId || json?.task_id || "";
  if (!taskId) {
    const msg =
      json?.errorMessage ||
      json?.msg ||
      `提交失败 code=${json?.errorCode || "?"}`;
    throw new Error(msg);
  }
  return String(taskId);
}

export function normalizeStatus(s?: string): RHStatus {
  const v = (s || "").toUpperCase();
  if (
    v === "CREATE" ||
    v === "QUEUED" ||
    v === "RUNNING" ||
    v === "SUCCESS" ||
    v === "FAILED" ||
    v === "CANCEL"
  ) {
    return v;
  }
  return "UNKNOWN";
}

export function extractOutputs(raw: RHQueryResponse): string[] {
  const out: string[] = [];
  const results = raw.results;
  if (Array.isArray(results)) {
    for (const r of results) {
      if (!r) continue;
      if (typeof r === "string") {
        out.push(r);
        continue;
      }
      const url = r.url || r.outputUrl;
      if (url) out.push(url);
      else {
        const t = r.text || r.content || r.output;
        if (t) out.push(t);
      }
    }
  }
  return out;
}

/** POST {base}/query {"taskId"} */
export async function queryTask(taskId: string): Promise<RHQueryResponse> {
  const res = await fetch(`${baseUrl()}/query`, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({ taskId }),
    cache: "no-store",
  });
  return parseJson(res);
}

/** Poll until terminal or timeout. Never forever. */
export async function waitForTask(
  taskId: string,
  opts?: { timeoutMs?: number; intervalMs?: number }
): Promise<RHRunResult> {
  const timeoutMs = opts?.timeoutMs ?? 180_000;
  const intervalMs = opts?.intervalMs ?? 3000;
  const start = Date.now();
  let last: RHQueryResponse = { taskId, status: "UNKNOWN" };

  while (Date.now() - start < timeoutMs) {
    try {
      last = await queryTask(taskId);
    } catch (e) {
      // tolerate transient poll failures
      await new Promise((s) => setTimeout(s, intervalMs));
      continue;
    }
    const status = normalizeStatus(last.status);
    if (status === "SUCCESS") {
      return { taskId, status, outputs: extractOutputs(last), raw: last };
    }
    if (status === "FAILED" || status === "CANCEL") {
      return { taskId, status, outputs: [], raw: last };
    }
    await new Promise((s) => setTimeout(s, intervalMs));
  }

  return {
    taskId,
    status: "FAILED",
    outputs: [],
    raw: {
      ...last,
      errorMessage: last.errorMessage || `轮询超时 (${Math.round(timeoutMs / 1000)}s)`,
    },
  };
}

export async function runModel(opts: {
  endpoint: string;
  payload: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<RHRunResult> {
  const taskId = await submitTask(opts.endpoint, opts.payload);
  return waitForTask(taskId, { timeoutMs: opts.timeoutMs });
}

export function findModel(kind: "t2i" | "i2i", id: string): ModelSpec | undefined {
  const list = kind === "t2i" ? T2I_MODELS : I2I_MODELS;
  return list.find((m) => m.id === id) || list[0];
}

/** Build payload from registry-validated fields only. */
export function buildT2IPayload(opts: {
  modelId: string;
  prompt: string;
  width?: number;
  height?: number;
  seed?: number;
  aspectRatio?: string;
}): Record<string, unknown> {
  const model = findModel("t2i", opts.modelId);
  const ep = model?.endpoint || "";
  const body: Record<string, unknown> = { prompt: opts.prompt };

  if (ep.includes("jimeng-4.6")) {
    if (opts.width && opts.height) {
      body.width = opts.width;
      body.height = opts.height;
    }
    body.forceSingle = true;
    if (opts.seed !== undefined) {
      // jimeng schema has no seed field in registry — omit rather than invent
    }
  } else if (ep.includes("seedream-v5-pro")) {
    body.resolution = "1k";
    if (opts.width && opts.height) {
      body.resolution = "empty";
      body.width = opts.width;
      body.height = opts.height;
    }
  } else if (ep.includes("qwen-image-3.0-pro")) {
    const size = opts.width && opts.height ? `${opts.width}*${opts.height}` : "1024*1024";
    body.size = size;
    body.imageNum = 1;
    if (opts.seed !== undefined) body.seed = opts.seed;
  } else if (ep.includes("wan-2.7")) {
    body.width = opts.width || 1024;
    body.height = opts.height || 1024;
  } else if (ep.includes("rhart-image-g-2")) {
    if (opts.aspectRatio && opts.aspectRatio !== "empty") {
      body.aspectRatio = opts.aspectRatio;
    }
    body.resolution = "1k";
  }

  return body;
}

export function buildI2IPayload(opts: {
  modelId: string;
  prompt: string;
  imageUrl: string;
  width?: number;
  height?: number;
}): Record<string, unknown> {
  const model = findModel("i2i", opts.modelId);
  const ep = model?.endpoint || "";
  const body: Record<string, unknown> = { prompt: opts.prompt };

  if (ep.includes("jimeng-4.6")) {
    body.imageUrls = [opts.imageUrl];
    body.forceSingle = true;
    if (opts.width && opts.height) {
      body.width = opts.width;
      body.height = opts.height;
    }
  } else if (ep.includes("seedream-v5-pro")) {
    body.imageUrls = [opts.imageUrl];
    body.resolution = "1k";
  } else if (ep.includes("rhart-image-g-2")) {
    body.imageUrls = [opts.imageUrl];
    body.resolution = "1k";
  } else {
    // fallback shape used by several registry entries
    body.imageUrls = [opts.imageUrl];
  }

  return body;
}

/** Account status — legacy endpoint still used by RunningHub console. */
export async function getAccountStatus() {
  const key = apiKey();
  const res = await fetch("https://www.runninghub.cn/uc/openapi/accountStatus", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: key }),
    cache: "no-store",
  });
  return parseJson(res);
}
