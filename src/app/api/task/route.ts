import { NextResponse } from "next/server";
import { queryTask, extractOutputs, normalizeStatus } from "@/lib/runninghub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const taskId = searchParams.get("taskId");
  if (!taskId) {
    return NextResponse.json({ ok: false, error: "缺少 taskId" }, { status: 400 });
  }
  try {
    const raw = await queryTask(taskId);
    return NextResponse.json({
      ok: true,
      taskId,
      status: normalizeStatus(raw.status),
      outputs: extractOutputs(raw),
      raw,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "查询失败" },
      { status: 500 }
    );
  }
}
