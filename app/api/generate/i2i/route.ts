import { randomUUID } from "node:crypto";
import { readCanvasLayout } from "@/lib/edit-recipe";
import { activeUser } from "@/lib/auth";
import { NextRequest, NextResponse, after } from "next/server";
import {
  buildWorkflowNodes,
  createCustomTask,
  uploadInputForWorkflow,
} from "@/lib/runninghub";
import { GPT_IMAGE_MODELS, LEGACY_MODEL, expandImageMentions, findModel, settingsOf } from "@/lib/models";
import { createGptTask, gptSize } from "@/lib/openai";
import { RH_HOSTED_MODELS, createRhHostedTask } from "@/lib/rh-models";
import { createKreaTask } from "@/lib/krea";
import { workflowFor } from "@/lib/model-workflows";
import { upsertHistory } from "@/lib/history";
import { overLimit } from "@/lib/quota";
import { refUrlFor, saveReference } from "@/lib/refs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const who = await activeUser(req);
  if ("res" in who) return who.res;
  const user = who.user;
  try {
    const form = await req.formData();
    const prompt = String(form.get("prompt") || "").trim();
    const file = form.get("image") as File | null;
    const denoiseRaw = Number(form.get("denoise") || 0.5);
    const denoise = Number.isFinite(denoiseRaw)
      ? Math.min(1, Math.max(0.01, Math.round(denoiseRaw * 100) / 100))
      : 0.5;
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
    const gptModel = GPT_IMAGE_MODELS[model.id];
    const krea = model.id === "krea-3";
    const hosted = !!RH_HOSTED_MODELS[model.id] || krea;
    const spec = gptModel || hosted ? null : workflowFor(model.id, "i2i");
    if (!spec && !gptModel && !hosted) {
      return NextResponse.json(
        { ok: false, error: `${model.name} 的图生图还在接入中` },
        { status: 400 }
      );
    }

    const count = Math.min(4, Math.max(1, Math.round(Number(form.get("count") || 1)) || 1));
    // 2026-11-06 (用户: 加上限): each friend has a daily picture limit.
    const limitMsg = await overLimit(user, count);
    if (limitMsg) return NextResponse.json({ ok: false, error: limitMsg }, { status: 429 });
    // Upload the reference once; every image of the batch reuses it.
    const imageFileName = gptModel || hosted ? "" : await uploadInputForWorkflow(file, file.name || "input.png");
    const gptImage = gptModel || hosted
      ? { bytes: Buffer.from(await file.arrayBuffer()), mime: file.type || "image/png" }
      : undefined;
    // Extra reference images (Krea 3 / Banana / GPT take up to 8 in all).
    const extras: { bytes: Buffer; mime: string }[] = [];
    if (gptImage) {
      for (const f of form.getAll("ref").slice(0, 7)) {
        if (f instanceof File && f.size) extras.push({ bytes: Buffer.from(await f.arrayBuffer()), mime: f.type || "image/jpeg" });
      }
    }
    const images = gptImage ? [gptImage, ...extras] : undefined;
    const modelPrompt = expandImageMentions(prompt, images?.length ?? 1);
    const text = (k: string) => String(form.get(k) || "");
    const loraRaw = Number(form.get("lora"));

    const tasks: { taskId: string; seed: number }[] = [];
    for (let i = 0; i < count; i++) {
      // The first image keeps a requested seed; the others get their own.
      const s = i === 0 ? seed : Math.floor(Math.random() * 1e12);
      if (gptModel) {
        tasks.push({ taskId: await createGptTask({ imageModel: gptModel, prompt: modelPrompt, size: Number(form.get("width")) && Number(form.get("height")) ? gptSize(Number(form.get("width")), Number(form.get("height"))) : "auto", images, quality: text("quality"), background: text("background"), complexity: text("complexity") }), seed: s });
        continue;
      }
      if (krea) {
        tasks.push({ taskId: await createKreaTask({ prompt: modelPrompt, images, quality: text("quality"), res: text("res"), thinking: form.get("thinking") === "1", seed: s, negative: text("negative"), regional: form.get("regional") === "1" }), seed: s });
        continue;
      }
      if (hosted) {
        tasks.push({ taskId: await createRhHostedTask({ model: model.id, prompt: modelPrompt, images, quality: text("quality"), res: text("res") }), seed: s });
        continue;
      }
      const nodeInfoList = buildWorkflowNodes(spec!, { prompt, seed: s, denoise, imageFileName, lora: form.get("lora") ? loraRaw : undefined });
      tasks.push({ taskId: await createCustomTask({ workflowId: spec!.workflowId, nodeInfoList }), seed: s });
    }

    // Keep the reference for the compare view, after answering so it never slows generation down.
    const references = [gptImage?.bytes ?? Buffer.from(await file.arrayBuffer()), ...extras.map((r) => r.bytes)];
    const refIds = references.map((_, i) => i === 0 ? tasks[0].taskId : randomUUID());
    const refUrls = refIds.map(refUrlFor);
    const refUrl = refUrls[0];
    after(async () => {
      await Promise.all(references.map((bytes, i) => saveReference(refIds[i], bytes)
        .catch((e) => console.error("[refs] save failed:", e?.message || e))));
    });

    // Record the tasks right away so images reach history even if the page closes.
    const settings = settingsOf(model.id, "i2i", (k) =>
      k === "refs" ? String(references.length) : k === "denoise" ? String(denoise) : String(form.get(k) ?? "")
    );
    const encodedLayout = form.get("canvasLayout");
    let canvasLayout;
    if (typeof encodedLayout === "string" && encodedLayout.length < 100_000) {
      try { canvasLayout = readCanvasLayout(JSON.parse(encodedLayout)); } catch {}
    }
    const userPrompt = String(form.get("userPrompt") || "").slice(0, 2000) || undefined;
    const now = Date.now();
    for (const [i, t] of tasks.entries()) {
      await upsertHistory({
        owner: user,
        id: t.taskId,
        taskId: t.taskId,
        mode: "i2i",
        model: model.id,
        prompt: prompt.slice(0, 2000),
        url: "",
        refUrl, refUrls, canvasLayout,
        seed: t.seed,
        settings,
        userPrompt,
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
        mode: "i2i",
        model: model.id,
        prompt,
        refUrl, refUrls, settings, canvasLayout,
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
