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
  | "lol-ingame"
  | "banana-21"
  | "krea-3"
  | "seedream-55"
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
  /** Values always sent as they are (e.g. a second LoRA's strength). */
  fixed?: (FieldRef & { fieldValue: string | number })[];
};

/** LoRA strength sent with every request (workflows default to 1-1.5). */
export const LORA_STRENGTH = 2.0;

export type ModelInfo = {
  id: ModelId;
  name: string;
  /** Taken off the site: old pictures keep its name, but it can't be picked or used. */
  retired?: boolean;
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
  editRatio?: boolean;
  /** 画质 choice and the estimated ¥ per image for each offered level. */
  quality?: Partial<Record<Quality, number>>;
  /**
   * 清晰度 tiers. Price in ¥ per image (Krea / Banana), or — with pricePerMegapixel — a multiplier
   * on the 画质 price (GPT, billed by output pixels).
   */
  resolutions?: Partial<Record<Res, number>>;
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
  /** GPT 构思程度 (complexity). Measured 2026-11-05: same image tokens at every level, so no price change. */
  complexity?: boolean;
  /** ¥ added per reference picture (Krea 3 bills each one). */
  refPrice?: number;
  /** Krea 3 只改局部 (regional_edit, 图生图 only). */
  regional?: boolean;
  /** Price scales with output pixels (GPT custom sizes); base price is for ~1 MP. */
  pricePerMegapixel?: boolean;
};

export const WORKFLOW_PARAMS: ModelParams = {
  denoise: true,
  customSize: true,
  seed: true,
  // 风格强度 is no longer offered on the page (用户 2026-11-05); workflows use the site default.
  ratios: ["1:1", "3:4", "2:3", "9:16", "4:3", "3:2", "16:9", "21:9"],
};

export function paramsOf(id: unknown): ModelParams {
  return findModel(id)?.params ?? WORKFLOW_PARAMS;
}


export type Quality = "low" | "medium" | "high";
export type Res = "1K" | "1.5K" | "2K" | "4K";
/** Output pixels per 清晰度 tier for models that take a free size (GPT). */
export const RES_PIXELS: Record<Res, number> = { "1K": 1_048_576, "1.5K": 2_359_296, "2K": 4_194_304, "4K": 8_294_400 };
export const QUALITY_LABELS: Record<Quality, string> = { low: "快速", medium: "标准", high: "精细" };
/** Estimated ¥ per GPT image by quality (OpenAI bills by tokens; both 2.6 models share the rates). */
export const GPT_PRICE: Record<Quality, number> = { low: 0.1, medium: 0.3, high: 1.0 };

const ALL_MODELS: ModelInfo[] = [
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
    // 2026-11-05 用户新加的 RunningHub 工作流：串联两个 LoRA，LOL0811 强度 2、LOL1105 强度 1（固定，不在网站上改）.
    id: "lol-ingame",
    name: "局内视角",
    tagline: "英雄联盟局内视角",
    cover: "/models/lol-ingame.jpg",
    params: {
      denoise: true,
      customSize: true,
      seed: true,
      ratios: ["1:1", "3:4", "2:3", "9:16", "4:3", "3:2", "16:9", "21:9"],
    },
  },
  {
    id: "banana-21",
    name: "Nano Banana 2.1",
    // 用户 2026-11-11: 下架 banana 模型.
    retired: true,
    tagline: "谷歌 · 约 40 秒 · 改图细",
    cover: "/models/google.svg",
    price: 0.22,
    billing: "RunningHub 海外",
    params: {
      denoise: false,
      customSize: false,
      ratios: ["1:1", "4:5", "3:4", "2:3", "9:16", "5:4", "4:3", "3:2", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1"],
      resolutions: { "1K": 0.22, "2K": 0.22, "4K": 0.43 },
      maxRefs: 8,
      editRatio: true,
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
      resolutions: { "1K": 0.22, "2K": 0.43, "4K": 0.86 },
      thinking: 0.15,
      refPrice: 0.15,
      maxRefs: 8,
      editRatio: true,
      seed: true,
      negative: true,
      regional: true,
    },
  },
  {
    // 用户 2026-11-11 (即梦 5.5 RunningHub 上有，你自己去接): measured 16 s and ¥0.28 for a 2K edit; only the asked-for
    // part changed. Edits are said in words (no boxes).
    id: "seedream-55",
    name: "即梦 5.5",
    tagline: "字节 Seedream · 约 16 秒 · 改图只动说的地方",
    cover: "/models/seedream.png",
    price: 0.28,
    billing: "RunningHub",
    params: {
      denoise: false,
      customSize: false,
      ratios: ["1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9"],
      // Measured 2026-11-12: 1K / 1.5K new pictures ¥0.13, a 2K edit ¥0.28 (the input picture is billed too).
      resolutions: { "1K": 0.13, "1.5K": 0.13, "2K": 0.28 },
      maxRefs: 8,
      background: true,
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
      customSize: false,
      ratios: ["1:1", "4:5", "3:4", "2:3", "9:16", "5:4", "4:3", "3:2", "16:9", "21:9"],
      quality: GPT_PRICE,
      resolutions: { "1K": 1, "2K": 4, "4K": 7.9 },
      maxRefs: 8,
      editRatio: true,
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
      customSize: false,
      ratios: ["1:1", "4:5", "3:4", "2:3", "9:16", "5:4", "4:3", "3:2", "16:9", "21:9"],
      quality: GPT_PRICE,
      resolutions: { "1K": 1, "2K": 4, "4K": 7.9 },
      maxRefs: 8,
      editRatio: true,
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

/** Models the page offers (retired ones left out). */
export const MODELS: ModelInfo[] = ALL_MODELS.filter((m) => !m.retired);

/** Any model, retired ones included (names and settings of old pictures). */
export function findModel(id: unknown): ModelInfo | undefined {
  return ALL_MODELS.find((m) => m.id === id);
}

/**
 * "@图2" in a description → "image 2", plus a note on how the pictures are numbered, so Krea 3 / GPT / Banana
 * know which reference is meant (2026-11-05 用户: 提示词里支持 @ 图片).
 */
export function expandImageMentions(prompt: string, count: number): string {
  if (count < 1 || !/@图\d/.test(prompt)) return prompt;
  const text = prompt.replace(/@图(\d+)/g, (_, n) => `image ${n}`);
  return `Reference images are numbered in the order given: ${Array.from({ length: count }, (_, i) => `image ${i + 1}`).join(", ")}.\n${text}`;
}

/**
 * 2026-11-05 (用户: 后台要看到完整参数，比如重绘幅度): the settings a picture was made with, in plain words,
 * only those the model takes. `get` reads one request field.
 */
export function settingsOf(model: string, mode: "t2i" | "i2i", get: (k: string) => string): Record<string, string> {
  const p = paramsOf(model);
  const out: Record<string, string> = {};
  const w = Number(get("width")), h = Number(get("height"));
  if (mode === "t2i" && w && h) out["尺寸"] = `${w}×${h}`;
  if (mode === "i2i") out["尺寸"] = "跟参考图";
  if (p.resolutions && get("res")) out["清晰度"] = get("res");
  if (p.quality && get("quality")) out["画质"] = QUALITY_LABELS[get("quality") as Quality] ?? get("quality");
  if (p.thinking != null) out["深度思考"] = get("thinking") === "1" || get("thinking") === "true" ? "开" : "关";
  if (p.background && get("background") && get("background") !== "auto") out["背景"] = { transparent: "透明", opaque: "不透明" }[get("background")] ?? get("background");
  if (p.complexity && get("complexity") && get("complexity") !== "auto") out["构思"] = { low: "低", medium: "中", high: "高" }[get("complexity")] ?? get("complexity");
  if (mode === "i2i" && p.regional) out["修改范围"] = get("regional") === "1" ? "只改说的地方" : "改整张图";
  if (mode === "i2i" && p.denoise && get("denoise")) out["重绘幅度"] = Number(get("denoise")).toFixed(2);
  if (p.lora && get("lora")) out["风格强度"] = get("lora");
  if (p.negative && get("negative")) out["不想要"] = get("negative").slice(0, 200);
  if (get("refs")) out["参考图"] = `${get("refs")} 张`;
  if (get("count")) out["张数"] = get("count");
  if (get("optimized") === "1") out["提示词优化"] = "开";
  return out;
}

/** Explicit edit geometry, when the model accepts this particular ratio. */
export function editAspectOf(model: string, label: unknown): number | undefined {
  const p = paramsOf(model);
  if (!p.editRatio || typeof label !== "string" || !p.ratios?.includes(label)) return;
  const [w, h] = label.split(":").map(Number);
  return w / h;
}
