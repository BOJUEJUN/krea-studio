import { storeDirectUrl, storePut } from "./store";

/** Sizes the page shows: 160/320/640 for grids, 1600 for the big view (the original only for download). */
export const THUMB_WIDTHS = [160, 320, 640, 1600] as const;

/** Make and keep every size once, right when a picture is saved (2026-11-06: no per-view work later). */
export async function makeThumbs(id: string, bytes: Buffer): Promise<void> {
  const sharp = (await import("sharp")).default;
  await Promise.all(
    THUMB_WIDTHS.map(async (w) => {
      const out = await sharp(bytes).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: w >= 1600 ? 86 : 74 }).toBuffer();
      await storePut(`thumb-${w}-${id}`, out, "image/webp");
    })
  );
}

/**
 * 2026-11-06 (用户: 比之前加载慢了): signed Tencent COS links for a picture, so the browser loads it in one hop
 * instead of going through the site first. Empty when storage isn't COS.
 */
export function directLinks(url: string | undefined, refUrl?: string): { direct?: Record<string, string>; refDirect?: string } {
  const out: { direct?: Record<string, string>; refDirect?: string } = {};
  const id = url?.match(/^\/api\/img\/([0-9A-Za-z_-]{1,64})$/)?.[1];
  if (id && storeDirectUrl(`img-${id}`)) {
    const d: Record<string, string> = { full: storeDirectUrl(`img-${id}`)! };
    for (const w of THUMB_WIDTHS) d[w] = storeDirectUrl(`thumb-${w}-${id}`)!;
    out.direct = d;
  }
  const rid = refUrl?.match(/^\/api\/ref\/([0-9A-Za-z_-]{1,64})$/)?.[1];
  if (rid) out.refDirect = storeDirectUrl(`ref-${rid}`) ?? undefined;
  return out;
}
