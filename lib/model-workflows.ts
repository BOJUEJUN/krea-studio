/**
 * Server-only: which RunningHub workflow each model/mode runs.
 *
 * 棕色尘埃 keeps reading its IDs from the existing environment variables.
 * A null workflow shows the model as 待接入 for that mode.
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
      lora: { nodeId: "374", fieldName: "strength_model" },
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
    lora: { nodeId: "244", fieldName: "strength_model" },
  };
}

/**
 * Krea2 turbo + LoRA workflows published on RunningHub. They share one node
 * layout: 208 prompt, 215 KSampler (seed / denoise), 423 latent size, 213 image,
 * and the LoRA loader at 374 (text-to-image) / 244 (image-to-image).
 */
function krea2(workflowId: string, mode: Mode): WorkflowSpec {
  if (mode === "t2i") {
    return {
      workflowId,
      prompt: { nodeId: "208", fieldName: "text" },
      seed: { nodeId: "215", fieldName: "seed" },
      width: { nodeId: "423", fieldName: "width" },
      height: { nodeId: "423", fieldName: "height" },
      lora: { nodeId: "374", fieldName: "strength_model" },
    };
  }
  return {
    workflowId,
    prompt: { nodeId: "208", fieldName: "text" },
    seed: { nodeId: "215", fieldName: "seed" },
    denoise: { nodeId: "215", fieldName: "denoise" },
    image: { nodeId: "213", fieldName: "image" },
    lora: { nodeId: "244", fieldName: "strength_model" },
  };
}

type Entry = string | { id: string; loraName: string } | null;

const WORKFLOW_IDS: Record<Exclude<ModelId, "brown-dust">, Record<Mode, Entry>> = {
  "little-legend": { t2i: "2117874901527912450", i2i: "2117873102267961345" },
  "lol-236-v11": { t2i: "2117877015239028737", i2i: "2117877879672492034" },
  // The published 图生图 workflow loads the CherryCHE LoRA, so swap in the LOL2.36MP file.
  "lol-236": {
    t2i: "2117876136859492354",
    i2i: { id: "2117830038564458498", loraName: "LOL2.36MP.safetensors" },
  },
  cherryche: { t2i: "2117875544472768514", i2i: "2117873712153325569" },
};

export function workflowFor(model: ModelId, mode: Mode): WorkflowSpec | null {
  if (model === "brown-dust") return brownDust(mode);
  const entry = WORKFLOW_IDS[model]?.[mode];
  if (!entry) return null;
  if (typeof entry === "string") return krea2(entry, mode);
  return { ...krea2(entry.id, mode), loraName: entry.loraName };
}

export function availability(model: ModelId): Record<Mode, boolean> {
  return { t2i: !!workflowFor(model, "t2i"), i2i: !!workflowFor(model, "i2i") };
}
