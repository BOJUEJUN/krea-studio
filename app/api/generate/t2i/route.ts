import { NextRequest, NextResponse } from "next/server";
import { buildWorkflowNodes, createCustomTask } from "@/lib/runninghub";
import { DEFAULT_MODEL, findModel } from "@/lib/models";
import { workflowFor } from "@/lib/model-workflows";
import { upsertHistory } from "@/lib/history";

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

    const model = findModel(body.model || DEFAULT_MODEL);
    if (!model) {
      return NextResponse.json({ ok: false, error: "未知模型" }, { status: 400 });
    }
    const spec = workflowFor(model.id, "t2i");
    if (!spec) {
      return NextResponse.json(
        { ok: false, error: `${model.name} 的文生图还在接入中` },
        { status: 400 }
      );
    }

    const seed =
      body.seed === undefined || body.seed === null || body.seed === ""
        ? Math.floor(Math.random() * 1e12)
        : Number(body.seed);

    const nodeInfoList = buildWorkflowNodes(spec, {
      prompt,
      seed,
      width: body.width ? Number(body.width) : undefined,
      height: body.height ? Number(body.height) : undefined,
    });

    const taskId = await createCustomTask({ workflowId: spec.workflowId, nodeInfoList });

    // Record the task right away so the image reaches history even if the page closes.
    await upsertHistory({
      id: taskId,
      taskId,
      mode: "t2i",
      model: model.id,
      prompt: prompt.slice(0, 2000),
      url: "",
      seed,
      createdAt: Date.now(),
    }).catch(() => {});

    return NextResponse.json(
      { ok: true, pending: true, taskId, seed, mode: "t2i", model: model.id, prompt },
      { status: 202 }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "服务器错误" },
      { status: 500 }
    );
  }
}
