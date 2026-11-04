import { NextRequest, NextResponse } from "next/server";
import {
  buildWorkflowNodes,
  createCustomTask,
  uploadInputForWorkflow,
} from "@/lib/runninghub";
import { LEGACY_MODEL, findModel } from "@/lib/models";
import { workflowFor } from "@/lib/model-workflows";
import { upsertHistory } from "@/lib/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const prompt = String(form.get("prompt") || "").trim();
    const file = form.get("image") as File | null;
    const denoise = Number(form.get("denoise") || 0.5);
    const seedRaw = form.get("seed");
    const seed =
      seedRaw === null || seedRaw === undefined || seedRaw === ""
        ? Math.floor(Math.random() * 1e12)
        : Number(seedRaw);

    if (!prompt) {
      return NextResponse.json({ ok: false, error: "请输入提示词" }, { status: 400 });
    }
    if (!file) {
      return NextResponse.json({ ok: false, error: "请上传参考图" }, { status: 400 });
    }

    const model = findModel(form.get("model") || LEGACY_MODEL);
    if (!model) {
      return NextResponse.json({ ok: false, error: "未知模型" }, { status: 400 });
    }
    const spec = workflowFor(model.id, "i2i");
    if (!spec) {
      return NextResponse.json(
        { ok: false, error: `${model.name} 的图生图还在接入中` },
        { status: 400 }
      );
    }

    const imageFileName = await uploadInputForWorkflow(file, file.name || "input.png");
    const nodeInfoList = buildWorkflowNodes(spec, { prompt, seed, denoise, imageFileName });

    const taskId = await createCustomTask({ workflowId: spec.workflowId, nodeInfoList });

    // Record the task right away so the image reaches history even if the page closes.
    await upsertHistory({
      id: taskId,
      taskId,
      mode: "i2i",
      model: model.id,
      prompt: prompt.slice(0, 2000),
      url: "",
      seed,
      createdAt: Date.now(),
    }).catch((e) => console.error("[history] record on submit failed:", e?.message || e));

    return NextResponse.json(
      { ok: true, pending: true, taskId, seed, mode: "i2i", model: model.id, prompt },
      { status: 202 }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "服务器错误" },
      { status: 500 }
    );
  }
}
