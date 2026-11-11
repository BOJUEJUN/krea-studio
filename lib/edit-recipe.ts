import { LEGACY_MODEL, QUALITY_LABELS, findModel, paramsOf, type Mode, type Quality, type Res } from "./models";

type Box = { node?: string; x: number; y: number; w: number; h: number };
export type CanvasLayout = { frame: Box; inputs: (Box & { from?: string[] } & ({ ref: number } | { text: string }))[] };
export type EditMetadata = {
  settings?: Record<string, string>;
  refUrls?: string[];
  canvasLayout?: CanvasLayout;
};
export type EditablePicture = EditMetadata & {
  id: string; mode: Mode; model?: string; prompt: string; refUrl?: string; seed?: number;
};

/** Only geometry and ordered input slots travel with the picture. Image bytes stay in the reference archive. */
export function readCanvasLayout(value: unknown): CanvasLayout | undefined {
  const box = (v: any): Box | undefined => {
    if (!v || ![v.x, v.y, v.w, v.h].every(Number.isFinite) || v.w <= 0 || v.h <= 0) return;
    if (Math.max(Math.abs(v.x), Math.abs(v.y), v.w, v.h) > 1_000_000) return;
    return { x: v.x, y: v.y, w: v.w, h: v.h, node: typeof v.node === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(v.node) ? v.node : undefined };
  };
  if (!value || typeof value !== "object" || !("frame" in value) || !("inputs" in value) || !Array.isArray(value.inputs)) return;
  const frame = box(value.frame);
  if (!frame || value.inputs.length > 32) return;
  const inputs: CanvasLayout["inputs"] = [];
  for (const v of value.inputs) {
    const b = box(v);
    if (!b) return;
    const from: string[] | undefined = Array.isArray(v.from) ? v.from.slice(0, 32).filter((id: unknown) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(id)) : undefined;
    if (Number.isInteger(v.ref) && v.ref >= 0 && v.ref < 8) inputs.push({ ...b, from, ref: v.ref });
    else if (typeof v.text === "string") inputs.push({ ...b, from, text: v.text.slice(0, 2000) });
    else return;
  }
  return { frame, inputs };
}

export function pictureRefs(g: EditablePicture): string[] {
  return g.mode === "i2i" ? (g.refUrls?.length ? g.refUrls : g.refUrl ? [g.refUrl] : []) : [];
}

export function pictureParams(g: EditablePicture) {
  const model = findModel(g.model)?.id ?? LEGACY_MODEL;
  const p = paramsOf(model), s = g.settings ?? {};
  const size = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(s["画幅"] || s["尺寸"] || "");
  const quality = (Object.keys(QUALITY_LABELS) as Quality[]).find((q) => q === s["画质"] || QUALITY_LABELS[q] === s["画质"]) ?? "medium";
  const res = (["1K", "2K", "4K"] as Res[]).find((r) => r === s["清晰度"]) ?? "2K";
  const background = s["背景"] === "透明" ? "transparent" : s["背景"] === "不透明" ? "opaque" : "auto";
  const complexity = s["构思"] === "低" ? "low" : s["构思"] === "中" ? "medium" : s["构思"] === "高" ? "high" : "auto";
  const denoise = Number(s["重绘幅度"]), lora = Number(s["风格强度"]);
  return {
    model, prompt: g.prompt, width: Number(size?.[1]) || 1536, height: Number(size?.[2]) || 1536,
    quality, res, thinking: s["深度思考"] === "开", regional: s["修改范围"] === "只改说的地方",
    background, complexity, negative: s["不想要"] ?? "", seedText: p.seed && Number.isFinite(g.seed) ? String(g.seed) : "",
    denoise: Number.isFinite(denoise) ? Math.max(0.01, Math.min(1, denoise)) : 0.5,
    lora: Number.isFinite(lora) ? lora : 2,
  } as const;
}
