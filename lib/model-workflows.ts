/**
 * Server-only: which RunningHub workflow each model/mode runs.
 *
 * 棕色尘埃 keeps reading its IDs from the existing environment variables.
 * The other models are placeholders until their published workflows arrive:
 * fill in `workflowId` and the node IDs shown in the RunningHub workflow editor.
 */

import type { Mode, ModelId, WorkflowSpec } from "./models";

function envValue(name: string): string {
  return process.env[name] || "";
}

function brownDust(mode: Mode): WorkflowSpec | null {
  if (mode === "t2i") {
    const workflowId = envValue("CUSTOM_T2I_WORKFLOW_ID");
    if (!workflowId) return null;
    return {
      workflowId,
      prompt: { nodeId: envValue("T2I_PROMPT_NODE") || "208", fieldName: "text" },
      seed: { nodeId: envValue("T2I_SEED_NODE") || "215", fieldName: "seed" },
      width: { nodeId: envValue("T2I_WIDTH_NODE") || "423", fieldName: "width" },
      height: { nodeId: envValue("T2I_HEIGHT_NODE") || "423", fieldName: "height" },
    };
  }
  const workflowId = envValue("CUSTOM_I2I_WORKFLOW_ID");
  if (!workflowId) return null;
  return {
    workflowId,
    prompt: { nodeId: envValue("I2I_PROMPT_NODE") || "208", fieldName: "text" },
    seed: { nodeId: envValue("I2I_SEED_NODE") || "215", fieldName: "seed" },
    denoise: { nodeId: envValue("I2I_DENOISE_NODE") || "215", fieldName: "denoise" },
    image: { nodeId: envValue("I2I_IMAGE_NODE") || "213", fieldName: "image" },
  };
}

// 待接入：拿到 RunningHub 发布后的工作流 ID 与节点 ID 再填写。
const PENDING: Record<Exclude<ModelId, "brown-dust">, Record<Mode, WorkflowSpec | null>> = {
  "little-legend": { t2i: null, i2i: null },
  "lol-236": { t2i: null, i2i: null },
  cherryche: { t2i: null, i2i: null },
};

export function workflowFor(model: ModelId, mode: Mode): WorkflowSpec | null {
  if (model === "brown-dust") return brownDust(mode);
  return PENDING[model]?.[mode] ?? null;
}

export function availability(model: ModelId): Record<Mode, boolean> {
  return { t2i: !!workflowFor(model, "t2i"), i2i: !!workflowFor(model, "i2i") };
}
