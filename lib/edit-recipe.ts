import { LEGACY_MODEL, QUALITY_LABELS, findModel, paramsOf, type Mode, type Quality, type Res } from "./models";
import { readKreaRegions, type KreaRegion } from "./krea-regions";

type Box = { node?: string; x: number; y: number; w: number; h: number };
export type CanvasLayout = { frame: Box; inputs: (Box & { from?: string[] } & ({ ref: number; source?: string } | { text: string }))[] };
export const canvasImagePath = (url: unknown) =>
  typeof url === "string" && /^\/api\/(?:img|ref)\/[\w-]{1,64}$/.test(url) ? url : undefined;
export type RecordWorkspace = { kind: "single" } | { kind: "canvas"; boardId?: string; boardName?: string };
export function readWorkspace(value: unknown): RecordWorkspace | undefined {
  if (typeof value === "string" && value.length < 512) {
    try { value = JSON.parse(value); } catch { return; }
  }
  if (!value || typeof value !== "object" || !("kind" in value)) return;
  if (value.kind === "single") return { kind: "single" };
  if (value.kind !== "canvas") return;
  return { kind: "canvas",
    boardId: "boardId" in value && typeof value.boardId === "string" && /^[\w-]{1,32}$/.test(value.boardId) ? value.boardId : undefined,
    boardName: "boardName" in value && typeof value.boardName === "string" ? value.boardName.trim().slice(0, 20) || undefined : undefined };
}
export function recordWorkspace(g: EditMetadata): RecordWorkspace | undefined {
  // 用户 2026-11-12 (工作区显示未记录): pages opened before the workspace was recorded still send a canvas layout for
  // every canvas run, so a record without either came from the single-picture page.
  return g.workspace ?? (g.canvasLayout ? { kind: "canvas" } : { kind: "single" });
}
export type EditMetadata = {
  workspace?: RecordWorkspace;
  editorDraft?: CanvasDraft;
  settings?: Record<string, string>;
  refUrls?: string[];
  canvasLayout?: CanvasLayout;
};
export type EditablePicture = EditMetadata & {
  id: string; mode: Mode; model?: string; prompt: string; refUrl?: string; seed?: number; url?: string;
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
    if (Number.isInteger(v.ref) && v.ref >= 0 && v.ref < 8) inputs.push({ ...b, from, ref: v.ref, source: canvasImagePath(v.source) });
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
  const res = (["1K", "1.5K", "2K", "4K"] as Res[]).find((r) => r === s["清晰度"]) ?? "2K";
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

export type CanvasDraft = ReturnType<typeof pictureParams> & {
  regions?: KreaRegion[];
  widthText: string; heightText: string; polishLevel: "low" | "medium" | "high"; polishVersion?: number; editRatio?: string; reverseOn: boolean; reverseMode?: "direct" | "fill"; summary: string;
};
export function restoredPolishLevel(level: unknown, version: unknown): CanvasDraft["polishLevel"] {
  if (level === "high") return "high";
  return version === 2 && level === "medium" ? "medium" : "low";
}
export function pictureDraft(g: EditablePicture): CanvasDraft {
  const p = pictureParams(g);
  return { ...p, widthText: String(p.width), heightText: String(p.height), polishLevel: "low", polishVersion: 2, editRatio: g.settings?.["改图比例"] || "auto", reverseOn: false, reverseMode: "direct", summary: "" };
}
/** Share only editor fields, never account or task metadata. */
export function readDraft(v: unknown): CanvasDraft | undefined {
  if (!v || typeof v !== "object") return;
  const data = v as Record<string, unknown>;
  if (typeof data.model !== "string" || typeof data.prompt !== "string") return;
  const base = pictureDraft({ id: "", mode: "t2i", prompt: "", model: typeof data.model === "string" ? data.model : undefined });
  const out: Record<string, unknown> = { ...base };
  for (const [k, fallback] of Object.entries(base)) {
    const x = data[k];
    if (k !== "model" && typeof x === typeof fallback && (typeof x !== "number" || Number.isFinite(x)))
      out[k] = typeof x === "string" ? x.slice(0, 8000) : x;
  }
  out.polishLevel = restoredPolishLevel(data.polishLevel, data.polishVersion);
  out.polishVersion = 2;
  if (out.model === "krea-3" && data.regions) {
    const regions = readKreaRegions(data.regions);
    if (regions?.length) out.regions = regions;
  }
  if (out.reverseMode !== "fill") out.reverseMode = "direct";
  return out as CanvasDraft;
}
/** A completion may arrive before the original pending history entry has been saved. */
export function readEditMetadata(body: Record<string, unknown>): EditMetadata {
  const refs = body.refUrls;
  const refUrls = Array.isArray(refs) && refs.length > 0 && refs.length <= 8 &&
    refs.every((u) => typeof u === "string" && /^\/api\/ref\/[\w-]{1,64}$/.test(u)) ? refs as string[] : undefined;
  const settings = body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)
    ? Object.fromEntries(Object.entries(body.settings).filter(([key, v]) => key.length <= 30 && typeof v === "string").slice(0, 32)
      .map(([key, v]) => [key, String(v).slice(0, 300)])) : undefined;
  return { refUrls, settings, workspace: readWorkspace(body.workspace), editorDraft: readDraft(body.editorDraft), canvasLayout: readCanvasLayout(body.canvasLayout) };
}
