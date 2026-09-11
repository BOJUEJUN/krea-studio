import { NextRequest, NextResponse } from "next/server";
import {
  createTask,
  createWorkflowTask,
  requireWorkflowIds,
  waitForTask,
} from "@/lib/runninghub";
import { buildT2INodes } from "@/lib/workflow-map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const prompt = String(body.prompt || "").trim();
    if (!prompt) {
      return NextResponse.json({ ok: false, error: "请输入提示词" }, { status: 400 });
    }

    const width = Number(body.width) || 1024;
    const height = Number(body.height) || 1024;
    const seed =
      body.seed === undefined || body.seed === null || body.seed === ""
        ? Math.floor(Math.random() * 1e15)
        : Number(body.seed);

    const ids = requireWorkflowIds();
    if (!ids.t2i) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "尚未配置 RUNNINGHUB_T2I_WORKFLOW_ID。请先在 RunningHub 上传 LoRA 并发布文生图工作流，再把 ID 写入 .env.local。",
        },
        { status: 400 }
      );
    }

    const nodeInfoList = buildT2INodes({ prompt, seed, width, height });

    let taskId: string;
    try {
      taskId = await createTask({ workflowId: ids.t2i, nodeInfoList });
    } catch {
      taskId = await createWorkflowTask({ workflowId: ids.t2i, nodeInfoList });
    }

    const result = await waitForTask(taskId);

    if (result.status !== "SUCCESS") {
      return NextResponse.json(
        {
          ok: false,
          error: result.errorMessage || "生成失败",
          taskId,
          status: result.status,
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      taskId,
      seed,
      imageUrl: result.imageUrl,
      images: result.images,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "服务器错误" },
      { status: 500 }
    );
  }
}
