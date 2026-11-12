// All coordinates are fractions of the oriented reference image. Separate radii keep a round brush round on a portrait or landscape image.
export type RegionBox = { x: number; y: number; width: number; height: number };
export type BrushPoint = [number, number];
export type BrushStroke = { erase: boolean; rx: number; ry: number; points: BrushPoint[] };
export type BrushMask = { base?: RegionBox; strokes: BrushStroke[] };
export const BRUSH_LIMITS = { points: 8192, perStroke: 512, strokes: 192 };
export const REGION_JSON_LIMIT = 240_000;
const fraction = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
export const rounded = (v: number) => Math.round(v * 100_000) / 100_000;

export function readBrushMask(value: unknown): BrushMask | null {
  if (!value || typeof value !== "object" || !("strokes" in value) || !Array.isArray(value.strokes) ||
      !value.strokes.length || value.strokes.length > BRUSH_LIMITS.strokes) return null;
  let base: RegionBox | undefined;
  if ("base" in value) {
    const b = value.base as RegionBox | null;
    if (!b || ![b.x, b.y, b.width, b.height].every(fraction) || b.width <= 0 || b.height <= 0 ||
        b.x + b.width > 1.000001 || b.y + b.height > 1.000001) return null;
    base = { x: b.x, y: b.y, width: b.width, height: b.height };
  }
  const strokes: BrushStroke[] = [];
  let count = 0;
  for (const s of value.strokes) {
    if (!s || typeof s.erase !== "boolean" || !fraction(s.rx) || !fraction(s.ry) || s.rx < 0.00001 || s.ry < 0.00001 ||
        !Array.isArray(s.points) || !s.points.length || s.points.length > BRUSH_LIMITS.perStroke) return null;
    count += s.points.length;
    if (count > BRUSH_LIMITS.points || !s.points.every((p: unknown) => Array.isArray(p) && p.length === 2 && p.every(fraction))) return null;
    strokes.push({ erase: s.erase, rx: s.rx, ry: s.ry, points: s.points });
  }
  return base || strokes.some((s) => !s.erase) ? { ...(base ? { base } : {}), strokes } : null;
}

export function brushBounds(mask: BrushMask): RegionBox {
  let l = mask.base?.x ?? 1, t = mask.base?.y ?? 1;
  let r = mask.base ? l + mask.base.width : 0, b = mask.base ? t + mask.base.height : 0;
  for (const s of mask.strokes) if (!s.erase) for (const [x, y] of s.points) {
    l = Math.min(l, x - s.rx); t = Math.min(t, y - s.ry);
    r = Math.max(r, x + s.rx); b = Math.max(b, y + s.ry);
  }
  l = Math.max(0, l); t = Math.max(0, t);
  return { x: l, y: t, width: Math.min(1, r) - l, height: Math.min(1, b) - t };
}

export function transformBrush(mask: BrushMask, from: RegionBox, to: RegionBox): BrushMask {
  const sx = to.width / from.width, sy = to.height / from.height;
  const unit = (v: number) => Math.min(1, Math.max(0, rounded(v)));
  const x = (v: number) => unit(to.x + (v - from.x) * sx), y = (v: number) => unit(to.y + (v - from.y) * sy);
  const b = mask.base;
  return { ...(b ? { base: { x: x(b.x), y: y(b.y), width: x(b.x + b.width) - x(b.x), height: y(b.y + b.height) - y(b.y) } } : {}),
    strokes: mask.strokes.map((s) => ({ erase: s.erase, rx: Math.max(0.00001, unit(s.rx * sx)), ry: Math.max(0.00001, unit(s.ry * sy)),
      points: s.points.map(([px, py]) => [x(px), y(py)]) })) };
}

// Shared by the interactive overlay and the final pixel mask. A zero-length round line also paints a tap.
export function strokeGeometry(s: BrushStroke) {
  const points = s.points.map(([x, y]) => rounded(x / s.rx) + " " + rounded(y / s.ry));
  return { d: "M" + points[0] + "L" + (points.length === 1 ? points[0] : points.slice(1).join(" ")),
    transform: "scale(" + s.rx + " " + s.ry + ")" };
}

type MaskRegion = RegionBox & { mask?: BrushMask };
const rect = (b: RegionBox) => `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="white"/>`;
export function maskSvg(regions: MaskRegion[], width: number, height: number): string {
  const shapes = regions.map((region, i) => {
    if (!region.mask) return rect(region);
    const { base, strokes } = region.mask;
    const paths = strokes.map((s) => {
      const { d, transform } = strokeGeometry(s);
      return `<path d="${d}" transform="${transform}" fill="none" stroke="${s.erase ? "black" : "white"}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }).join("");
    return `<defs><mask id="b${i}" x="0" y="0" width="1" height="1" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse">${base ? rect(base) : ""}${paths}</mask></defs><rect width="1" height="1" fill="white" mask="url(#b${i})"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1 1" preserveAspectRatio="none">${shapes}</svg>`;
}
