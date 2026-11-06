import { sessionUser, unauthorized } from "@/lib/auth";
import { NextResponse } from "next/server";
import { readImage } from "@/lib/images";
import { imageMime } from "@/lib/refs";
import { storeGet, storePut } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Signed-in viewers only, so the browser may keep it but no shared cache.
const FOREVER = "private, max-age=31536000, immutable";
const THUMB_WIDTHS = [160, 320, 640];

/** /api/img/<id> is the original; ?w=320 is a small WebP made once and kept (history grid, thumbnails). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = sessionUser(req);
  if (!user) return unauthorized();
  try {
    const { id } = await params;
    const w = Number(new URL(req.url).searchParams.get("w"));
    if (THUMB_WIDTHS.includes(w) && /^[0-9A-Za-z_-]{1,64}$/.test(id)) {
      const key = `thumb-${w}-${id}`;
      let thumb = await storeGet(key).catch(() => null);
      if (!thumb) {
        const bytes = await readImage(id);
        if (!bytes) return NextResponse.json({ ok: false, error: "图片不存在" }, { status: 404 });
        const sharp = (await import("sharp")).default;
        thumb = await sharp(bytes).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 74 }).toBuffer();
        await storePut(key, thumb, "image/webp").catch(() => {});
      }
      return new NextResponse(new Uint8Array(thumb), { headers: { "Content-Type": "image/webp", "Cache-Control": FOREVER } });
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
