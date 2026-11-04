/**
 * Model catalogue shared by the page and the API routes (no secrets here).
 *
 * Each model runs a RunningHub workflow published on the web console:
 * POST /task/openapi/create with workflowId + nodeInfoList.
 * A mode without a workflow is shown as "待接入" and cannot be submitted.
 */

export type Mode = "t2i" | "i2i";

export type ModelId =
  | "brown-dust"
  | "little-legend"
  | "lol-236-v11"
  | "lol-236"
  | "cherryche";

export type FieldRef = { nodeId: string; fieldName: string };

export type WorkflowSpec = {
  workflowId: string;
  prompt: FieldRef;
  seed?: FieldRef;
  width?: FieldRef;
  height?: FieldRef;
  denoise?: FieldRef;
  image?: FieldRef;
  /** LoraLoaderModelOnly strength; always sent so the site controls it. */
  lora?: FieldRef;
};

/** LoRA strength sent with every request (workflows default to 1-1.5). */
export const LORA_STRENGTH = 2.0;

export type ModelInfo = {
  id: ModelId;
  name: string;
  tagline: string;
  cover: string;
};

export const MODELS: ModelInfo[] = [
  {
    id: "brown-dust",
    name: "棕色尘埃",
    tagline: "清透日系插画",
    cover: "/models/brown-dust.jpg",
  },
  {
    id: "little-legend",
    name: "小小英雄",
    tagline: "KV · 美宣 · 插图（A级）",
    cover: "/models/little-legend.jpg",
  },
  {
    id: "lol-236-v11",
    name: "LOL 2.36MP V1.1",
    tagline: "英雄联盟风格首选",
    cover: "/models/lol-236-v11.jpg",
  },
  {
    id: "lol-236",
    name: "LOL 2.36MP",
    tagline: "英雄联盟风格",
    cover: "/models/lol-236.jpg",
  },
  {
    id: "cherryche",
    name: "CherryCHE Skills",
    tagline: "速写线稿风",
    cover: "/models/cherryche.jpg",
  },
];

/** Pre-selected on the page. */
export const DEFAULT_MODEL: ModelId = "lol-236-v11";

/** Requests without a model come from pages cached before the picker existed. */
export const LEGACY_MODEL: ModelId = "brown-dust";

export function findModel(id: unknown): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}
