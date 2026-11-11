/**
 * Server-only: which RunningHub workflow each model/mode runs.
 *
 * 棕色尘埃 keeps reading its IDs from the existing environment variables.
 * A null workflow shows the model as 待接入 for that mode.
 */

import { RH_HOSTED_MODELS, rhHostedReady } from "./rh-models";
import { GPT_IMAGE_MODELS, type Mode, type ModelId, type WorkflowSpec } from "./models";

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

const WORKFLOW_IDS: Partial<Record<ModelId, Record<Mode, string | null>>> = {
  "little-legend": { t2i: "2117874901527912450", i2i: "2117873102267961345" },
  "lol-236-v11": { t2i: "2117877015239028737", i2i: "2117877879672492034" },
  "lol-236": { t2i: "2117876136859492354", i2i: "2117830038564458498" },
  cherryche: { t2i: "2117875544472768514", i2i: "2117873712153325569" },
  "lol-ingame": { t2i: "2118543962234511362", i2i: "2118543371127058434" },
};

export function workflowFor(model: ModelId, mode: Mode): WorkflowSpec | null {
  if (model === "brown-dust") return brownDust(mode);
  const id = WORKFLOW_IDS[model]?.[mode];
  if (!id) return null;
  // 局内视角 chains two LoRAs (用户): LOL0811 at 2, LOL1105 at 0.7 (用户 2026-11-11: 1.0 → 0.7).
  if (model === "lol-ingame") {
    const base = krea2(id, mode);
    return mode === "t2i"
      ? { ...base, lora: undefined, fixed: [{ nodeId: "374", fieldName: "strength_model", fieldValue: 2 }, { nodeId: "435", fieldName: "strength_model", fieldValue: 0.7 }] }
      : { ...base, lora: undefined, fixed: [{ nodeId: "244", fieldName: "strength_model", fieldValue: 2 }, { nodeId: "380", fieldName: "strength_model", fieldValue: 0.7 }] };
  }
  // CherryCHE: LoRA strength 1, not the workflow's 2 (用户 2026-11-06).
  if (model === "cherryche") {
    const base = krea2(id, mode);
    return { ...base, lora: undefined, fixed: [{ nodeId: mode === "t2i" ? "374" : "244", fieldName: "strength_model", fieldValue: 1 }] };
  }
  return krea2(id, mode);
}

export function availability(model: ModelId): Record<Mode, boolean> {
  if (RH_HOSTED_MODELS[model]) {
    const ready = rhHostedReady(model);
    return { t2i: ready, i2i: ready };
  }
  if (model === "krea-3") {
    const ready = !!process.env.KREA_API_KEY;
    return { t2i: ready, i2i: ready };
  }
  if (GPT_IMAGE_MODELS[model]) {
    const ready = !!process.env.OPENAI_API_KEY;
    return { t2i: ready, i2i: ready };
  }
  return { t2i: !!workflowFor(model, "t2i"), i2i: !!workflowFor(model, "i2i") };
}
