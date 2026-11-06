import { sessionUser, unauthorized } from "@/lib/auth";
import { NextResponse } from "next/server";
import { getAccountStatus } from "@/lib/runninghub";
import { MODELS } from "@/lib/models";
import { availability } from "@/lib/model-workflows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = sessionUser(req);
  if (!user) return unauthorized();
  const models = MODELS.map((m) => ({ id: m.id, ready: availability(m.id) }));
  try {
    const account = await getAccountStatus();
    return NextResponse.json({ ok: true, models, account: account?.data || null });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, models, error: e?.message || "状态检查失败" },
      { status: 500 }
    );
  }
}
