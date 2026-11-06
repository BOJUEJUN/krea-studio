import { activeUser } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { describeImage, hasDeepSeek } from "@/lib/deepseek";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const who = await activeUser(req);
  if ("res" in who) return who.res;
  const user = who.user;
  try {
    if (!hasDeepSeek()) {
      return NextResponse.json({ ok: false, error: "未配置提示词反推" }, { status: 400 });
    }
    const form = await req.formData();
    const file = form.get("image") as File | null;
    if (!file) {
      return NextResponse.json({ ok: false, error: "请上传参考图" }, { status: 400 });
    }
    const prompt = await describeImage(file);
    return NextResponse.json({ ok: true, prompt });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "提示词反推失败" },
      { status: 500 }
    );
  }
}
