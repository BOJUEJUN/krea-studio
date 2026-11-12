import { BRUSH_LIMITS, brushBounds, readBrushMask, type BrushMask, type RegionBox } from "./brush-mask";
export type { RegionBox } from "./brush-mask";
export const MAX_KREA_REGIONS = 24;
/** One color per box, in box order (editor, input box and canvas use the same). */
export const REGION_COLORS = ["#0766d3", "#aa2676", "#13735a", "#9d4c09", "#7652ae"];
export const MAX_REGION_NOTE = 600;
export type KreaRegion = RegionBox & { image_idx: number; label: string; note: string; mask?: BrushMask };

/** Krea takes fractions of the uncropped image, indexed in upload order. */
export function readKreaRegions(value: unknown, imageCount = 8): KreaRegion[] | null {
  if (!Array.isArray(value) || value.length > MAX_KREA_REGIONS) return null;
  const result: KreaRegion[] = [];
  const labels = new Set<string>();
  let points = 0, strokes = 0;
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const { x, y, width, height, image_idx } = item;
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 ||
        x >= 1 || y >= 1 || x + width > 1.0000001 || y + height > 1.0000001 ||
        !Number.isInteger(image_idx) || image_idx < 0 || image_idx >= imageCount) return null;
    const label = item.label ?? String(result.length + 1);
    const note = item.note ?? "";
    if (typeof label !== "string" || !label || label.length > 128 || /[\s@]/.test(label) || labels.has(label) ||
        typeof note !== "string" || note.length > MAX_REGION_NOTE) return null;
    labels.add(label);
    const region: KreaRegion = { image_idx, label, note: note.trim(), x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) };
    if (item.mask !== undefined) {
      const mask = readBrushMask(item.mask);
      if (!mask || image_idx !== 0) return null;
      strokes += mask.strokes.length;
      points += mask.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
      if (strokes > BRUSH_LIMITS.strokes || points > BRUSH_LIMITS.points) return null;
      Object.assign(region, brushBounds(mask), { mask });
    }
    result.push(region);
  }
  return result;
}

export function reindexRegions(regions: KreaRegion[], newIndex: (old: number) => number): KreaRegion[] {
  return regions.flatMap((r) => {
    const image_idx = newIndex(r.image_idx);
    // A painted edit belongs to the primary image, even if the reference wires are reordered.
    if (image_idx < 0 || (r.mask && image_idx !== 0)) return [];
    return [image_idx === r.image_idx ? r : { ...r, image_idx }];
  });
}

export function regionDescription(regions: KreaRegion[]) {
  return regions.filter((r) => r.note).map((r) => `图${r.image_idx + 1} @${r.label}：${r.note}`).join("\n");
}
