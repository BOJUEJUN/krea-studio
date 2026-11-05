import { NextRequest, NextResponse } from "next/server";
import { buildWorkflowNodes, createCustomTask } from "@/lib/runninghub";
import { GPT_IMAGE_MODELS, LEGACY_MODEL, findModel } from "@/lib/models";
import { createGptTask, gptSize } from "@/lib/openai";
import { RH_HOSTED_MODELS, createRhHostedTask } from "@/lib/rh-models";
import { createKreaTask } from "@/lib/krea";
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

    const model = findModel(body.model || LEGACY_MODEL);
    if (!model) {
      return NextResponse.json({ ok: false, error: "未知模型" }, { status: 400 });
    }
    const gptModel = GPT_IMAGE_MODELS[model.id];
    const krea = model.id === "krea-3";
    const hosted = !!RH_HOSTED_MODELS[model.id] || krea;
    const spec = gptModel || hosted ? null : workflowFor(model.id, "t2i");
    if (!spec && !gptModel && !hosted) {
      return NextResponse.json(
        { ok: false, error: `${model.name} 的文生图还在接入中` },
        { status: 400 }
      );
    }

    const seed =
      body.seed === undefined || body.seed === null || body.seed === ""
        ? Math.floor(Math.random() * 1e12)
        : Number(body.seed);

    const count = Math.min(4, Math.max(1, Math.round(Number(body.count || 1)) || 1));
    const width = body.width ? Number(body.width) : undefined;
    const height = body.height ? Number(body.height) : undefined;

    const tasks: { taskId: string; seed: number }[] = [];
    for (let i = 0; i < count; i++) {
      // The first image keeps a requested seed; the others get their own.
      const s = i === 0 ? seed : Math.floor(Math.random() * 1e12);
      if (gptModel) {
        tasks.push({ taskId: await createGptTask({ imageModel: gptModel, prompt, size: gptSize(width, height), quality: String(body.quality || "") }), seed: s });
        continue;
      }
      if (krea) {
        tasks.push({ taskId: await createKreaTask({ prompt, width, height, quality: String(body.quality || "") }), seed: s });
        continue;
      }
      if (hosted) {
        tasks.push({ taskId: await createRhHostedTask({ model: model.id, prompt, width, height }), seed: s });
        continue;
      }
      const nodeInfoList = buildWorkflowNodes(spec!, { prompt, seed: s, width, height });
      tasks.push({ taskId: await createCustomTask({ workflowId: spec!.workflowId, nodeInfoList }), seed: s });
    }

    // Record the tasks right away so images reach history even if the page closes.
    const now = Date.now();
    for (const [i, t] of tasks.entries()) {
      await upsertHistory({
        id: t.taskId,
        taskId: t.taskId,
        mode: "t2i",
        model: model.id,
        prompt: prompt.slice(0, 2000),
        url: "",
        seed: t.seed,
        createdAt: now + i,
      }).catch((e) => console.error("[history] record on submit failed:", e?.message || e));
    }

    return NextResponse.json(
      {
        ok: true,
        pending: true,
        taskId: tasks[0].taskId,
        seed: tasks[0].seed,
        tasks,
        mode: "t2i",
        model: model.id,
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
