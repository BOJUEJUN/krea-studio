export type GenerationIssue = { title: string; detail: string };

export class FailedGeneration extends Error {}
export class UnavailableProgress extends Error {}

export function generationIssue(model: string | undefined, error: unknown): GenerationIssue {
  const prefix = model ? model + " · " : "";
  if (error instanceof UnavailableProgress) return { title: prefix + "暂时查不到进度", detail: error.message };
  if (!(error instanceof FailedGeneration) && error instanceof Error && /提交状态未确认|网络连接失败|网关错误|网关响应异常/.test(error.message))
    return { title: prefix + "提交状态未确认", detail: "请先查看历史记录，再决定是否重新生成" };
  return { title: prefix + "生成失败", detail: error instanceof Error ? error.message : "请稍后再试" };
}
