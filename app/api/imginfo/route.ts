import { sessionUser, unauthorized } from "@/lib/auth";
import { NextResponse } from "next/server";
import { readImage } from "@/lib/images";
import { readReference } from "@/lib/refs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 2026-11-11 (用户: 画布上显示分辨率): ?u=/api/img/<id> or /api/ref/<id> → { w, h } of the original picture. */
export async function GET(req: Request) {
  if (!sessionUser(req)) return unauthorized();
  const u = new URL(req.url).searchParams.get("u") || "";
  const m = u.match(/^\/api\/(img|ref)\/([0-9A-Za-z_-]{1,64})/);
  if (!m) return NextResponse.json({ ok: false, error: "地址不对" }, { status: 400 });
  try {
    const bytes = m[1] === "img" ? await readImage(m[2]) : await readReference(m[2]);
    if (!bytes) return NextResponse.json({ ok: false, error: "图片不存在" }, { status: 404 });
    const sharp = (await import("sharp")).default;
    const meta = await sharp(bytes).metadata();
    return NextResponse.json({ ok: true, w: meta.width ?? 0, h: meta.height ?? 0 }, { headers: { "Cache-Control": "private, max-age=31536000, immutable" } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "读取失败" }, { status: 500 });
  }
}
