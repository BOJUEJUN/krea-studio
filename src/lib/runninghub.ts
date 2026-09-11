const BASE = "https://www.runninghub.cn";

export type NodeOverride = {
  nodeId: string;
  fieldName: string;
  fieldValue: string | number;
};

export type TaskStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCESS"
  | "FAILED"
  | "UNKNOWN";

export type TaskResult = {
  taskId: string;
  status: TaskStatus;
  imageUrl?: string;
  images?: string[];
  errorMessage?: string;
  errorCode?: string;
};

function apiKey(): string {
  const key = process.env.RUNNINGHUB_API_KEY;
  if (!key) throw new Error("缺少 RUNNINGHUB_API_KEY");
  return key;
}

export function requireWorkflowIds() {
  return {
    t2i: process.env.RUNNINGHUB_T2I_WORKFLOW_ID || "",
    i2i: process.env.RUNNINGHUB_I2I_WORKFLOW_ID || "",
  };
}

async function rhFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`RunningHub 返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 200)}`);
  }
  return json;
}

/** 上传输入图，返回 RunningHub 文件名 */
export async function uploadInputImage(
  file: File | Blob,
  filename = "input.png"
): Promise<string> {
  const form = new FormData();
  form.append("apiKey", apiKey());
  form.append("fileType", "input");
  form.append("file", file, filename);

  const res = await fetch(`${BASE}/task/openapi/upload`, {
    method: "POST",
    body: form,
    cache: "no-store",
  });
  const json = await res.json();
  if (json.code !== 0 || !json.data?.fileName) {
    throw new Error(json.msg || "上传失败");
  }
  return json.data.fileName as string;
}

/** 提交工作流任务（AI 应用 / 已发布工作流） */
export async function createTask(opts: {
  workflowId: string;
  nodeInfoList: NodeOverride[];
}): Promise<string> {
  const { workflowId, nodeInfoList } = opts;
  // 兼容 webappId / workflowId 两种形态
  const numericId = Number(workflowId);
  const payload: Record<string, unknown> = {
    apiKey: apiKey(),
    nodeInfoList,
  };
  if (Number.isFinite(numericId)) {
    payload.webappId = numericId;
  } else {
    payload.workflowId = workflowId;
  }

  const json = await rhFetch("/task/openapi/ai-app/run", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (json.code !== 0) {
    throw new Error(json.msg || JSON.stringify(json));
  }
  const taskId = json.data?.taskId;
  if (!taskId) throw new Error("未返回 taskId");
  return String(taskId);
}

/** 也支持经典 create 接口（工作流 API） */
export async function createWorkflowTask(opts: {
  workflowId: string;
  nodeInfoList: NodeOverride[];
}): Promise<string> {
  const json = await rhFetch("/task/openapi/create", {
    method: "POST",
    body: JSON.stringify({
      apiKey: apiKey(),
      workflowId: opts.workflowId,
      nodeInfoList: opts.nodeInfoList,
    }),
  });
  if (json.code !== 0) throw new Error(json.msg || JSON.stringify(json));
  return String(json.data?.taskId || json.data);
}

export async function queryTask(taskId: string): Promise<TaskResult> {
  const json = await rhFetch("/task/openapi/query", {
    method: "POST",
    body: JSON.stringify({ apiKey: apiKey(), taskId }),
  });

  if (json.code !== 0) {
    return {
      taskId,
      status: "FAILED",
      errorMessage: json.msg || "查询失败",
    };
  }

  const data = json.data || {};
  const status = (data.taskStatus || data.status || "UNKNOWN") as TaskStatus;

  // 输出可能是 results 数组，或 outputs / imageUrl
  const images: string[] = [];
  if (Array.isArray(data.results)) {
    for (const r of data.results) {
      if (typeof r === "string") images.push(r);
      else if (r?.url) images.push(r.url);
      else if (r?.fileUrl) images.push(r.fileUrl);
    }
  }
  if (Array.isArray(data.outputs)) {
    for (const o of data.outputs) {
      if (typeof o === "string") images.push(o);
      else if (o?.url) images.push(o.url);
    }
  }
  if (typeof data.imageUrl === "string") images.push(data.imageUrl);

  return {
    taskId,
    status,
    images,
    imageUrl: images[0],
    errorMessage: data.errorMessage || data.failMsg,
    errorCode: data.errorCode,
  };
}

/** 轮询直到完成 */
export async function waitForTask(
  taskId: string,
  opts?: { timeoutMs?: number; intervalMs?: number }
): Promise<TaskResult> {
  const timeoutMs = opts?.timeoutMs ?? 180_000;
  const intervalMs = opts?.intervalMs ?? 2500;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const r = await queryTask(taskId);
    if (r.status === "SUCCESS") return r;
    if (r.status === "FAILED") return r;
    await new Promise((s) => setTimeout(s, intervalMs));
  }
  return { taskId, status: "FAILED", errorMessage: "轮询超时" };
}

export async function getAccountStatus() {
  const json = await rhFetch("/uc/openapi/accountStatus", {
    method: "POST",
    body: JSON.stringify({ apikey: apiKey() }),
  });
  return json;
}
