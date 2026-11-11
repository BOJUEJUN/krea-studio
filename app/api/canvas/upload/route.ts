import { activeUser } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { refUrlFor, saveReference } from "@/lib/refs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A picture dragged or pasted onto the board: kept like a reference picture, the board stores only its link. */
export async function POST(req: NextRequest) {
  const who = await activeUser(req);
  if ("res" in who) return who.res;
  try {
    const fd = await req.formData();
    const f = fd.get("image");
    if (!(f instanceof Blob) || !f.size) return NextResponse.json({ ok: false, error: "没有图片" }, { status: 400 });
    if (f.size > 15 * 1024 * 1024) return NextResponse.json({ ok: false, error: "图片太大（最多 15MB）" }, { status: 400 });
    const id = `cv${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
    await saveReference(id, f);
    return NextResponse.json({ ok: true, url: refUrlFor(id) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "上传失败" }, { status: 500 });
  }
}
