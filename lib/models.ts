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
  | "cherryche"
  | "banana-21"
  | "krea-3"
  | "gpt-26-flare"
  | "gpt-26-sunburst";

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
  /** Estimated ¥ per image for models billed outside RunningHub China (no real cost comes back). */
  price?: number;
  /** Which account pays, shown next to the price. */
  billing?: string;
  /** Controls this model understands; missing means a Krea2 workflow (everything). */
  params?: ModelParams;
};

export type ModelParams = {
  /** 重绘幅度 for 图生图. */
  denoise: boolean;
  /** Free width × height input; otherwise only the listed ratios. */
  customSize: boolean;
  /** Ratio labels offered for 文生图 (all presets when omitted). */
  ratios?: string[];
  /** 画质 choice and the estimated ¥ per image for each offered level. */
  quality?: Partial<Record<Quality, number>>;
  /** Labels for the quality levels (default 快速 / 标准 / 精细). */
  qualityLabels?: Partial<Record<Quality, string>>;
  /** Krea 3 深度思考: extra ¥ per image when on. */
  thinking?: number;
  /** How many reference images 图生图 takes (default 1). */
  maxRefs?: number;
  /** 种子 (repeatable results). */
  seed?: boolean;
  /** 不想要的内容 (negative prompt). */
  negative?: boolean;
  /** LoRA 强度 (Krea2 workflows). */
  lora?: boolean;
  /** GPT 背景: 自动 / 透明 / 不透明. */
  background?: boolean;
  /** GPT 构思程度 (complexity). */
  complexity?: boolean;
  /** Krea 3 只改局部 (regional_edit, 图生图 only). */
  regional?: boolean;
  /** Price scales with output pixels (GPT custom sizes); base price is for ~1 MP. */
  pricePerMegapixel?: boolean;
};

export const WORKFLOW_PARAMS: ModelParams = {
  denoise: true,
  customSize: true,
  seed: true,
  lora: true,
  ratios: ["1:1", "3:4", "2:3", "9:16", "4:3", "3:2", "16:9", "21:9"],
};

export function paramsOf(id: unknown): ModelParams {
  return findModel(id)?.params ?? WORKFLOW_PARAMS;
}


export type Quality = "low" | "medium" | "high";
export const QUALITY_LABELS: Record<Quality, string> = { low: "快速", medium: "标准", high: "精细" };
/** Estimated ¥ per GPT image by quality (OpenAI bills by tokens; both 2.6 models share the rates). */
export const GPT_PRICE: Record<Quality, number> = { low: 0.1, medium: 0.3, high: 1.0 };

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
  {
    id: "banana-21",
    name: "Nano Banana 2.1",
    tagline: "谷歌 · 约 40 秒 · 改图细",
    cover: "/models/google.svg",
    price: 0.22,
    billing: "RunningHub 海外",
    params: {
      denoise: false,
      customSize: false,
      ratios: ["1:1", "4:5", "3:4", "2:3", "9:16", "5:4", "4:3", "3:2", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1"],
      quality: { low: 0.22, medium: 0.22, high: 0.43 },
      qualityLabels: { low: "1K", medium: "2K", high: "4K" },
      maxRefs: 8,
    },
  },
  {
    id: "krea-3",
    name: "Krea 3",
    tagline: "Krea · 号称几秒出图 · 改图听话",
    cover: "/models/krea.svg",
    price: 0.43,
    billing: "Krea",
    params: {
      denoise: false,
      customSize: false,
      ratios: ["1:1", "4:5", "3:4", "2:3", "9:16", "5:4", "4:3", "3:2", "16:9", "21:9"],
      quality: { low: 0.22, medium: 0.43, high: 0.86 },
      qualityLabels: { low: "1K", medium: "2K", high: "4K" },
      thinking: 0.15,
      maxRefs: 8,
      seed: true,
      negative: true,
      regional: true,
    },
  },
  {
    id: "gpt-26-flare",
    name: "GPT Image 2.6 Flare",
    tagline: "OpenAI 快速版 · 改图听话",
    cover: "/models/openai.svg",
    price: 0.3,
    billing: "OpenAI",
    params: {
      denoise: false,
      customSize: true,
      ratios: ["1:1", "4:5", "3:4", "2:3", "9:16", "5:4", "4:3", "3:2", "16:9", "21:9"],
      quality: GPT_PRICE,
      maxRefs: 8,
      background: true,
      complexity: true,
      pricePerMegapixel: true,
    },
  },
  {
    id: "gpt-26-sunburst",
    name: "GPT Image 2.6 Sunburst",
    tagline: "OpenAI 精细版 · 更慢更细",
    cover: "/models/openai.svg",
    price: 0.3,
    billing: "OpenAI",
    params: {
      denoise: false,
      customSize: true,
      ratios: ["1:1", "4:5", "3:4", "2:3", "9:16", "5:4", "4:3", "3:2", "16:9", "21:9"],
      quality: GPT_PRICE,
      maxRefs: 8,
      background: true,
      complexity: true,
      pricePerMegapixel: true,
    },
  },
];

/** Models served by OpenAI instead of a RunningHub workflow. */
export const GPT_IMAGE_MODELS: Partial<Record<ModelId, string>> = {
  "gpt-26-flare": "gpt-image-2.6-flare",
  "gpt-26-sunburst": "gpt-image-2.6-sunburst",
};

/** Pre-selected on the page. */
export const DEFAULT_MODEL: ModelId = "lol-236-v11";

/** Requests without a model come from pages cached before the picker existed. */
export const LEGACY_MODEL: ModelId = "brown-dust";

export function findModel(id: unknown): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}
