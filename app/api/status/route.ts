import { NextResponse } from "next/server";
import { customWorkflowIds, getAccountStatus } from "@/lib/runninghub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const account = await getAccountStatus();
    const ids = customWorkflowIds();
    return NextResponse.json({
      ok: true,
      mode: "custom-lora",
      brand: "棕色尘埃风格化",
      workflows: { t2i: ids.t2i, i2i: ids.i2i },
      account: account?.data || null,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "状态检查失败" },
      { status: 500 }
    );
  }
}
