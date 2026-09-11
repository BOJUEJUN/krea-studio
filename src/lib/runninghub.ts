/**
 * RunningHub client — standard OpenAPI v2 + custom workflow create.
 */

const DEFAULT_BASE = "https://www.runninghub.cn/openapi/v2";
const RH_HOST = "https://www.runninghub.cn";

export type RHResultItem = {
  url?: string;
  outputUrl?: string;
  text?: string;
  content?: string;
  output?: string;
  outputType?: string;
};

export type NodeOverride = {
  nodeId: string;
  fieldName: string;
  fieldValue: string | number;
};

function apiKey(): string {
  const key =
    process.env.RUNNINGHUB_API_KEY || process.env.RH_API_KEY || "";
  if (!key) throw new Error("缺少 RUNNINGHUB_API_KEY");
  return key;
}

function authHeaders(json = true): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${apiKey()}` };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function parseJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`RunningHub 非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

export function customWorkflowIds() {
  return {
    t2i: process.env.CUSTOM_T2I_WORKFLOW_ID || "",
    i2i: process.env.CUSTOM_I2I_WORKFLOW_ID || "",
  };
}

export function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Official: POST /task/openapi/create with workflowId + nodeInfoList */
export async function createCustomTask(opts: {
  workflowId: string;
  nodeInfoList: NodeOverride[];
}): Promise<string> {
  const res = await fetch(`${RH_HOST}/task/openapi/create`, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({
      apiKey: apiKey(),
      workflowId: opts.workflowId,
      nodeInfoList: opts.nodeInfoList,
    }),
    cache: "no-store",
  });
  const json = await parseJson(res);
  if (json.code !== 0) {
    throw new Error(json.msg || JSON.stringify(json));
  }
  const taskId = json.data?.taskId;
  if (!taskId) throw new Error("未返回 taskId");
  return String(taskId);
}

/** Official outputs poll — data may be array of file items */
export async function queryCustomTask(taskId: string): Promise<{
  status: string;
  outputs: string[];
  cost?: string;
  errorMessage?: string;
  raw: any;
}> {
  const res = await fetch(`${RH_HOST}/task/openapi/outputs`, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify({ apiKey: apiKey(), taskId }),
    cache: "no-store",
  });
  const json = await parseJson(res);

  const outputs: string[] = [];
  let cost: string | undefined;
  let errorMessage: string | undefined;
  let status = "";

  // 804 = still running
  if (json.code === 804) {
    return { status: "RUNNING", outputs: [], raw: json };
  }

  // data is array of output files when done
  if (Array.isArray(json.data)) {
    for (const item of json.data) {
      if (!item || typeof item !== "object") continue;
      const url = item.fileUrl || item.url;
      if (typeof url === "string" && url.startsWith("http")) outputs.push(url);
      const m = item.consumeMoney ?? item.thirdPartyConsumeMoney;
      if (m != null && m !== "" && cost === undefined) cost = String(m);
    }
    if (outputs.length) status = "SUCCESS";
  } else if (json.data && typeof json.data === "object") {
    const data = json.data;
    status = String(data.taskStatus || data.status || "");
    const walk = (v: any) => {
      if (!v) return;
      if (typeof v === "string" && /^https?:\/\//.test(v)) outputs.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === "object") {
        if (typeof v.url === "string") outputs.push(v.url);
        if (typeof v.fileUrl === "string") outputs.push(v.fileUrl);
        Object.values(v).forEach(walk);
      }
    };
    walk(data.outputs);
    walk(data.images);
    walk(data.files);
    const fr = data.failedReason;
    if (fr && typeof fr === "object") {
      errorMessage =
        fr.exception_message ||
        (fr.node_name ? `节点 ${fr.node_name} 失败` : undefined) ||
        (fr.traceback ? String(fr.traceback).slice(0, 180) : undefined);
    }
  }

  if (json.code && json.code !== 0 && json.code !== 804 && json.msg && !outputs.length) {
    // 805 = status error (often audit fail)
    if (json.code === 805) {
      const fr = (json.data as any)?.failedReason;
      errorMessage =
        errorMessage ||
        fr?.exception_message ||
        fr?.traceback ||
        json.msg;
      status = "FAILED";
    } else if (!status) {
      status = "RUNNING";
    }
  }

  const uniq = Array.from(new Set(outputs)).filter((u) => u.includes("http"));
  if (!status) {
    if (uniq.length) status = "SUCCESS";
    else if (errorMessage) status = "FAILED";
    else status = "RUNNING";
  }

  return { status: status.toUpperCase(), outputs: uniq, cost, errorMessage, raw: json };
}

export async function waitForCustomTask(
  taskId: string,
  opts?: { timeoutMs?: number; intervalMs?: number }
): Promise<{
  status: string;
  outputs: string[];
  cost?: string;
  errorMessage?: string;
  raw: any;
}> {
  const timeoutMs = opts?.timeoutMs ?? 180_000;
  const intervalMs = opts?.intervalMs ?? 3000;
  const start = Date.now();
  let last: any = { status: "RUNNING", outputs: [], raw: {} };

  while (Date.now() - start < timeoutMs) {
    try {
      last = await queryCustomTask(taskId);
    } catch (e: any) {
      last = { status: "RUNNING", outputs: [], errorMessage: e?.message, raw: {} };
      await new Promise((s) => setTimeout(s, intervalMs));
      continue;
    }
    if (last.status === "SUCCESS" && last.outputs.length) return last;
    if (last.status === "FAILED" || last.status === "CANCEL") return last;
    await new Promise((s) => setTimeout(s, intervalMs));
  }
  return { ...last, status: "FAILED", errorMessage: last.errorMessage || "轮询超时" };
}

/** Standard model API (v2) — keep as fallback */
export async function runStandardModel(opts: {
  endpoint: string;
  payload: Record<string, unknown>;
}): Promise<{ taskId: string; outputs: string[]; status: string; raw: any; cost?: string }> {
  const res = await fetch(`${DEFAULT_BASE}/${opts.endpoint.replace(/^\//, "")}`, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify(opts.payload),
    cache: "no-store",
  });
  const json = await parseJson(res);
  const taskId = json?.taskId || "";
  if (!taskId) throw new Error(json?.errorMessage || json?.msg || "提交失败");

  const start = Date.now();
  while (Date.now() - start < 180_000) {
    const q = await fetch(`${DEFAULT_BASE}/query`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ taskId }),
      cache: "no-store",
    });
    const rj = await parseJson(q);
    const st = String(rj.status || "").toUpperCase();
    if (st === "SUCCESS") {
      const outputs: string[] = [];
      if (Array.isArray(rj.results)) {
        for (const r of rj.results) {
          if (typeof r === "string") outputs.push(r);
          else if (r?.url) outputs.push(r.url);
        }
      }
      const cost =
        rj.usage?.thirdPartyConsumeMoney != null
          ? String(rj.usage.thirdPartyConsumeMoney)
          : undefined;
      return { taskId, outputs, status: st, raw: rj, cost };
    }
    if (st === "FAILED" || st === "CANCEL") {
      throw new Error(rj.errorMessage || `任务失败 ${st}`);
    }
    await new Promise((s) => setTimeout(s, 3000));
  }
  throw new Error("轮询超时");
}

export async function uploadMedia(file: Blob, filename = "input.png"): Promise<string> {
  const form = new FormData();
  form.append("file", file, filename);
  const res = await fetch(`${DEFAULT_BASE}/media/upload/binary`, {
    method: "POST",
    headers: authHeaders(false),
    body: form,
    cache: "no-store",
  });
  const json = await parseJson(res);
  const url = json?.data?.download_url;
  if (!url) throw new Error(json?.msg || "上传失败");
  return url as string;
}

/** For custom i2i, RH LoadImage accepts fileName from /task/openapi/upload */
export async function uploadInputForWorkflow(
  file: Blob,
  filename = "input.png"
): Promise<string> {
  const form = new FormData();
  form.append("apiKey", apiKey());
  form.append("fileType", "input");
  form.append("file", file, filename);
  const res = await fetch(`${RH_HOST}/task/openapi/upload`, {
    method: "POST",
    body: form,
    cache: "no-store",
  });
  const json = await parseJson(res);
  const name = json?.data?.fileName;
  if (!name) throw new Error(json?.msg || "上传失败");
  return name as string;
}

export async function getAccountStatus() {
  const res = await fetch(`${RH_HOST}/uc/openapi/accountStatus`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: apiKey() }),
    cache: "no-store",
  });
  return parseJson(res);
}

export function buildCustomT2INodes(opts: {
  prompt: string;
  seed: number;
  width?: number;
  height?: number;
}): NodeOverride[] {
  const promptNode = process.env.T2I_PROMPT_NODE || "208";
  const seedNode = process.env.T2I_SEED_NODE || "215";
  const widthNode = process.env.T2I_WIDTH_NODE || "423";
  const heightNode = process.env.T2I_HEIGHT_NODE || "423";
  const list: NodeOverride[] = [
    { nodeId: promptNode, fieldName: "text", fieldValue: opts.prompt },
    { nodeId: seedNode, fieldName: "seed", fieldValue: opts.seed },
  ];
  if (opts.width) {
    list.push({ nodeId: widthNode, fieldName: "width", fieldValue: opts.width });
  }
  if (opts.height) {
    list.push({ nodeId: heightNode, fieldName: "height", fieldValue: opts.height });
  }
  return list;
}

export function buildCustomI2INodes(opts: {
  prompt: string;
  seed: number;
  denoise: number;
  imageFileName: string;
}): NodeOverride[] {
  const promptNode = process.env.I2I_PROMPT_NODE || "208";
  const seedNode = process.env.I2I_SEED_NODE || "215";
  const denoiseNode = process.env.I2I_DENOISE_NODE || "215";
  const imageNode = process.env.I2I_IMAGE_NODE || "213";
  return [
    { nodeId: promptNode, fieldName: "text", fieldValue: opts.prompt },
    { nodeId: seedNode, fieldName: "seed", fieldValue: opts.seed },
    { nodeId: denoiseNode, fieldName: "denoise", fieldValue: opts.denoise },
    {
      nodeId: imageNode,
      fieldName: "image",
      fieldValue: opts.imageFileName,
    },
  ];
}
