import { activeUser } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { hasDeepSeek, polishPrompt, type PolishLevel } from "@/lib/deepseek";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 2026-11-10: 提示词润色 (低 / 中 / 高), keeping every @图N token. */
export async function POST(req: NextRequest) {
  const who = await activeUser(req);
  if ("res" in who) return who.res;
  try {
    if (!hasDeepSeek()) return NextResponse.json({ ok: false, error: "未配置提示词优化" }, { status: 400 });
    const body = await req.json().catch(() => ({}));
    const prompt = String(body?.prompt || "").trim().slice(0, 4000);
    const level: PolishLevel = ["low", "medium", "high"].includes(body?.level) ? body.level : "low";
    if (!prompt) return NextResponse.json({ ok: false, error: "先写点提示词再优化" }, { status: 400 });
    const polished = await polishPrompt(prompt, level);
    return NextResponse.json({ ok: true, prompt: polished });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "提示词优化失败" }, { status: 500 });
  }
}
