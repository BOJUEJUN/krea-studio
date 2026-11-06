import { sessionUser, unauthorized } from "@/lib/auth";
import { NextResponse } from "next/server";
import { readImage } from "@/lib/images";
import { imageMime } from "@/lib/refs";
import { storeDirectUrl, storeGet, storeHas, storePut } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Signed-in viewers only, so the browser may keep it but no shared cache.
const FOREVER = "private, max-age=31536000, immutable";
// 1600 is the big on-screen view (2026-11-05: keeps Vercel traffic down); the original is only for downloads.
const THUMB_WIDTHS = [160, 320, 640, 1600];

/** /api/img/<id> is the original; ?w=320 is a small WebP made once and kept (history grid, thumbnails). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = sessionUser(req);
  if (!user) return unauthorized();
  try {
    const { id } = await params;
    const q = new URL(req.url).searchParams;
    const w = Number(q.get("w"));
    // 2026-11-05 (图放腾讯云): the browser is sent straight to COS, so pictures don't use the site's traffic.
    // ?raw=1 keeps the bytes on this origin for the page's own fetch() (download, 当参考图, 重新编辑).
    const direct = q.get("raw") !== "1";
    const redirect = (key: string) => {
      const to = storeDirectUrl(key);
      return to ? NextResponse.redirect(to, { status: 302, headers: { "Cache-Control": "private, max-age=3600" } }) : null;
    };
    if (THUMB_WIDTHS.includes(w) && /^[0-9A-Za-z_-]{1,64}$/.test(id)) {
      const key = `thumb-${w}-${id}`;
      if (direct && storeDirectUrl(key) && (await storeHas(key).catch(() => false))) return redirect(key)!;
      let thumb = await storeGet(key).catch(() => null);
      if (!thumb) {
        const bytes = await readImage(id);
        if (!bytes) return NextResponse.json({ ok: false, error: "图片不存在" }, { status: 404 });
        const sharp = (await import("sharp")).default;
        thumb = await sharp(bytes).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: w >= 1600 ? 86 : 74 }).toBuffer();
        await storePut(key, thumb, "image/webp").catch(() => {});
      }
      return new NextResponse(new Uint8Array(thumb), { headers: { "Content-Type": "image/webp", "Cache-Control": FOREVER } });
    }
    if (direct && /^[0-9A-Za-z_-]{1,64}$/.test(id)) {
      const r = redirect(`img-${id}`);
      if (r) return r;
    }
    const bytes = await readImage(id);
    if (!bytes) return NextResponse.json({ ok: false, error: "图片不存在" }, { status: 404 });
    return new NextResponse(new Uint8Array(bytes), {
      headers: { "Content-Type": imageMime(bytes), "Cache-Control": FOREVER },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "读取失败" }, { status: 400 });
  }
}
