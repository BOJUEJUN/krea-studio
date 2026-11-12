// RunningHub's hosted model API returns an error code, a message, or a nested failedReason.
const reasons: Record<string, string> = {
  "1002": "模型服务的凭据无效，请联系管理员",
  "1003": "模型请求过多，请稍后再试",
  "1004": "任务不存在或已过期，请重新生成",
  "1005": "模型服务暂时异常，请稍后再试",
  "1006": "模型处理超时，请稍后再试",
  "1007": "生成参数未通过校验，请检查提示词、尺寸和参考图",
  "1008": "参考图过大，请缩小图片后再试",
  "1010": "模型服务暂时不可用，请稍后再试",
  "1011": "模型繁忙，请稍后再试",
  "1012": "模型返回了异常结果，请再试一次",
  "1013": "参考图读取失败，请重新上传图片",
  "1014": "模型访问受限，请联系管理员",
  "1501": "内容审核未通过，请调整提示词或更换参考图",
  "1504": "模型处理超时，请稍后再试",
  "1505": "模型不支持这类真人图像，请更换参考图",
  "1516": "模型无法读取参考图，请重新上传",
  "1517": "参考图上传失败，请重新上传",
  "1518": "参考图无法解码，请换用 JPG 或 PNG 图片",
};

function detail(value: unknown, depth = 0): string {
  if (!value || depth > 3) return "";
  if (typeof value === "string") {
    const text = value.trim().slice(0, 2000);
    if (text.startsWith("{")) {
      try { return detail(JSON.parse(text), depth + 1); } catch { return ""; }
    }
    return text;
  }
  if (typeof value !== "object") return "";
  const v = value as Record<string, unknown>;
  for (const field of ["failedReason", "exception_message", "errorMessage", "message", "reason", "msg", "error"]) {
    const found = detail(v[field], depth + 1);
    if (found) return found;
  }
  return "";
}

export function hostedFailure(body: any, fallback: string): string {
  const code = String(body?.errorCode || body?.data?.errorCode || body?.code || "");
  const message = detail(body?.failedReason) || detail(body?.data?.failedReason) || detail(body?.data) || detail(body);
  const signal = code + " " + message;
  if (reasons[code] && code !== "1007") return reasons[code];
  if (/content.?policy|sensitive|moderation|safety.?filter|risk.?control|security.?audit|审核|违规|敏感/i.test(signal)) return reasons["1501"];
  if (/insufficient.*(balance|credit)|余额不足|额度不足/i.test(signal)) return "模型服务余额不足，请联系管理员";
  if (/rate.?limit|too many requests|overload|model.*busy|限流|繁忙/i.test(signal)) return reasons["1011"];
  if (/timeout|timed.?out|超时/i.test(signal)) return reasons["1006"];
  if (/prompt.*(too short|at least|minimum length)|提示词.*(过短|至少)/i.test(signal)) return "提示词太短，请补充画面或修改要求";
  if (/image.*(dimension|aspect ratio|too (large|small))|invalid (width|height|resolution)/i.test(signal)) return "参考图尺寸或比例不受支持，请调整尺寸后再试";
  if (/invalid.*(image|format)|decode.*(image|base64)|unsupported.*image/i.test(signal)) return reasons["1518"];
  // Preserve specific provider guidance without exposing request payloads or traces.
  if (message && !/^(success|failed|error|unknown error|generation failed|task failed|request failed|任务失败|生成失败)[.!。]?$/i.test(message) &&
      !/https?:|data:|bearer|token|api.?key|traceback|authorization|password|[{}<>]|[A-Za-z0-9+/=_-]{32,}/i.test(message))
    return message.split(/\r?\n/)[0].slice(0, 160);
  return reasons[code] || (code && /^[\w-]{1,32}$/.test(code) && code !== "0" ? `${fallback}（${code}）` : fallback);
}
