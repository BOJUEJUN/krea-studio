import { activeUser } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { readImage } from "@/lib/images";
import { storeDirectUrl } from "@/lib/store";
import { createKreaUpscale } from "@/lib/krea";
import { overLimit } from "@/lib/quota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 2026-11-10 (用户: 高清放大): POST { id } → { taskId } for a history picture; the page polls it like any task. */
export async function POST(req: NextRequest) {
  const who = await activeUser(req);
  if ("res" in who) return who.res;
  try {
    if (!process.env.KREA_API_KEY) return NextResponse.json({ ok: false, error: "高清放大未配置" }, { status: 400 });
    const limitMsg = await overLimit(who.user, 1);
    if (limitMsg) return NextResponse.json({ ok: false, error: limitMsg }, { status: 429 });
    const body = await req.json().catch(() => ({}));
    const id = String(body?.id || "");
    if (!/^[0-9A-Za-z_-]{1,64}$/.test(id)) return NextResponse.json({ ok: false, error: "图片不对" }, { status: 400 });
    const bytes = await readImage(id);
    if (!bytes) return NextResponse.json({ ok: false, error: "图片不存在" }, { status: 404 });
    const sharp = (await import("sharp")).default;
    const meta = await sharp(bytes).metadata();
    const w = meta.width || 1024;
    const h = meta.height || 1024;
    // Krea needs a public link: a signed storage link, else a smaller data URL would be too long, so refuse.
    const url = storeDirectUrl(`img-${id}`);
    if (!url || url.length > 1024) return NextResponse.json({ ok: false, error: "这张图暂时不能放大" }, { status: 400 });
    // 2× up to about 8K on the long side.
    const factor = Math.max(1, Math.min(2, 8192 / Math.max(w, h)));
    const taskId = await createKreaUpscale(url, w, h, factor);
    return NextResponse.json({ ok: true, taskId, width: Math.round(w * factor), height: Math.round(h * factor) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "高清放大失败" }, { status: 500 });
  }
}
