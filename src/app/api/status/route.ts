import { NextRequest, NextResponse } from "next/server";
import { getAccountStatus, requireWorkflowIds } from "@/lib/runninghub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ids = requireWorkflowIds();
    const account = await getAccountStatus();
    return NextResponse.json({
      ok: true,
      workflows: {
        t2iConfigured: Boolean(ids.t2i),
        i2iConfigured: Boolean(ids.i2i),
      },
      account: account?.data || null,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "状态检查失败" },
      { status: 500 }
    );
  }
}
