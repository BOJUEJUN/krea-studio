import { activeUser } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { deleteBoard, readBoard, writeBoard } from "@/lib/canvas-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const who = await activeUser(req);
  if ("res" in who) return who.res;
  try {
    const board = await readBoard(who.user, (await params).id);
    return NextResponse.json({ ok: true, board }, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "读取失败" }, { status: 400 });
  }
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const who = await activeUser(req);
  if ("res" in who) return who.res;
  try {
    await writeBoard(who.user, (await params).id, await req.json());
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "保存失败" }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const who = await activeUser(req);
  if ("res" in who) return who.res;
  try {
    await deleteBoard(who.user, (await params).id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "删除失败" }, { status: 400 });
  }
}
