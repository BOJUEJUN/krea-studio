import { NextRequest, NextResponse } from "next/server";
import {
  createTask,
  createWorkflowTask,
  requireWorkflowIds,
  uploadInputImage,
  waitForTask,
} from "@/lib/runninghub";
import { buildI2INodes } from "@/lib/workflow-map";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const prompt = String(form.get("prompt") || "").trim();
    const file = form.get("image") as File | null;
    const denoise = Number(form.get("denoise") || 0.5);
    const seedRaw = form.get("seed");
    const seed =
      seedRaw === null || seedRaw === undefined || seedRaw === ""
        ? Math.floor(Math.random() * 1e15)
        : Number(seedRaw);

    if (!prompt) {
      return NextResponse.json({ ok: false, error: "请输入提示词" }, { status: 400 });
    }
    if (!file) {
      return NextResponse.json({ ok: false, error: "请上传参考图" }, { status: 400 });
    }

    const ids = requireWorkflowIds();
    if (!ids.i2i) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "尚未配置 RUNNINGHUB_I2I_WORKFLOW_ID。请先在 RunningHub 上传 LoRA 并发布图生图工作流，再把 ID 写入 .env.local。",
        },
        { status: 400 }
      );
    }

    const fileName = await uploadInputImage(file, file.name || "input.png");
    const nodeInfoList = buildI2INodes({
      prompt,
      seed,
      denoise,
      imageFileName: fileName,
    });

    let taskId: string;
    try {
      taskId = await createTask({ workflowId: ids.i2i, nodeInfoList });
    } catch {
      taskId = await createWorkflowTask({ workflowId: ids.i2i, nodeInfoList });
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
