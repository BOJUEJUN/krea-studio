import { activeUser } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { readCanvasIndex, writeCanvasIndex } from "@/lib/canvas-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The user's board list (names and which one is open). */
export async function GET(req: NextRequest) {
  const who = await activeUser(req);
  if ("res" in who) return who.res;
  const idx = await readCanvasIndex(who.user).catch(() => null);
  return NextResponse.json({ ok: true, index: idx }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: NextRequest) {
  const who = await activeUser(req);
  if ("res" in who) return who.res;
  try {
    const body = await req.json();
    await writeCanvasIndex(who.user, body);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "保存失败" }, { status: 400 });
  }
}
