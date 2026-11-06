import { sessionUser, unauthorized } from "@/lib/auth";
import { NextResponse } from "next/server";
import { queryCustomTask } from "@/lib/runninghub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const user = sessionUser(req);
  if (!user) return unauthorized();
  const { searchParams } = new URL(req.url);
  const taskId = searchParams.get("taskId");
  if (!taskId) {
    return NextResponse.json({ ok: false, error: "缺少 taskId" }, { status: 400 });
  }
  try {
    const r = await queryCustomTask(taskId);
    return NextResponse.json(
      {
        ok: true,
        taskId,
        status: r.status,
        outputs: r.outputs,
        cost: r.cost,
        error: r.errorMessage,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "查询失败" },
      { status: 500 }
    );
  }
}
