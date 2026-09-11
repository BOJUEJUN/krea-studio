import { NextResponse } from "next/server";
import { getAccountStatus, I2I_MODELS, T2I_MODELS } from "@/lib/runninghub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const account = await getAccountStatus();
    return NextResponse.json({
      ok: true,
      mode: "standard-model-api",
      models: { t2i: T2I_MODELS, i2i: I2I_MODELS },
      account: account?.data || null,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "状态检查失败" },
      { status: 500 }
    );
  }
}
