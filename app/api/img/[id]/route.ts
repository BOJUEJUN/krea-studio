import { NextResponse } from "next/server";
import { readImage } from "@/lib/images";
import { imageMime } from "@/lib/refs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FOREVER = "public, max-age=31536000, immutable";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const bytes = await readImage(id);
    if (!bytes) return NextResponse.json({ ok: false, error: "图片不存在" }, { status: 404 });
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": imageMime(bytes),
        "Cache-Control": FOREVER,
        // Let Netlify's CDN keep it too, so repeat views skip the function.
        "Netlify-CDN-Cache-Control": FOREVER,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "读取失败" }, { status: 400 });
  }
}
