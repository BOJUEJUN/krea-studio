import { NextRequest, NextResponse } from "next/server";
import {
  buildCustomT2INodes,
  createCustomTask,
  customWorkflowIds,
} from "@/lib/runninghub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const prompt = String(body.prompt || "").trim();
    if (!prompt) {
      return NextResponse.json({ ok: false, error: "请输入提示词" }, { status: 400 });
    }

    const ids = customWorkflowIds();
    if (!ids.t2i) {
      return NextResponse.json(
        { ok: false, error: "未配置文生图工作流" },
        { status: 400 }
      );
    }

    const seed =
      body.seed === undefined || body.seed === null || body.seed === ""
        ? Math.floor(Math.random() * 1e12)
        : Number(body.seed);

    const nodeInfoList = buildCustomT2INodes({
      prompt,
      seed,
      width: body.width ? Number(body.width) : undefined,
      height: body.height ? Number(body.height) : undefined,
    });

    const taskId = await createCustomTask({ workflowId: ids.t2i, nodeInfoList });

    return NextResponse.json(
      {
        ok: true,
        pending: true,
        taskId,
        seed,
        mode: "t2i",
        prompt,
      },
      { status: 202 }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "服务器错误" },
      { status: 500 }
    );
  }
}
