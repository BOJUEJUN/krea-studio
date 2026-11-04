/**
 * RunningHub client — standard OpenAPI v2 + custom workflow create.
 */

import { LORA_STRENGTH } from "./models";

const DEFAULT_BASE = "https://www.runninghub.cn/openapi/v2";
const RH_HOST = "https://www.runninghub.cn";

function envValue(name: string): string {
  return process.env[name] || "";
}

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
  const key = envValue("RUNNINGHUB_API_KEY") || envValue("RH_API_KEY");
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

export function envNum(name: string, fallback: number): number {
  const v = envValue(name);
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

/** RunningHub's content review rejects some outputs at the SaveImage node. */
function auditMessage(fr: any): string | undefined {
  if (!fr || typeof fr !== "object") return undefined;
  const text = `${fr.exception_type || ""} ${fr.traceback || ""}`;
  if (/Audit|平台禁止/i.test(text)) {
    return "生成结果未通过 RunningHub 内容审核（平台禁止色情、暴力等内容），请调整描述后重试";
  }
  return undefined;
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

  // 804 = running, 813 = queued: both are still in progress, not failures.
  if (json.code === 804 || json.code === 813 || /RUNNING|QUEUED/i.test(String(json.msg || ""))) {
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
        auditMessage(fr) ||
        fr.exception_message ||
        (fr.node_name ? `节点 ${fr.node_name} 失败` : undefined) ||
        (fr.traceback ? String(fr.traceback).slice(0, 180) : undefined);
    }
  }

  if (json.code && json.code !== 0 && json.code !== 804 && !outputs.length) {
    const fr = (json.data as any)?.failedReason;
    errorMessage =
      errorMessage ||
      auditMessage(fr) ||
      fr?.exception_message ||
      fr?.traceback ||
      json.msg ||
      `RunningHub 错误码 ${json.code}`;
    status = "FAILED";
  } else if (json.code === 0 && Array.isArray(json.data) && !outputs.length) {
    errorMessage = "任务已完成但未返回图片";
    status = "FAILED";
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

/** Map site inputs onto a model's workflow nodes; unset fields are skipped. */
export function buildWorkflowNodes(
  spec: import("./models").WorkflowSpec,
  input: {
    prompt: string;
    seed: number;
    width?: number;
    height?: number;
    denoise?: number;
    imageFileName?: string;
  }
): NodeOverride[] {
  const list: NodeOverride[] = [{ ...spec.prompt, fieldValue: input.prompt }];
  const add = (ref: { nodeId: string; fieldName: string } | undefined, value: unknown) => {
    if (ref && value !== undefined && value !== null && value !== "") {
      list.push({ ...ref, fieldValue: value as string | number });
    }
  };
  add(spec.seed, input.seed);
  add(spec.width, input.width);
  add(spec.height, input.height);
  add(spec.denoise, input.denoise);
  add(spec.image, input.imageFileName);
  add(spec.lora, LORA_STRENGTH);
  return list;
}
