import { randomUUID } from "node:crypto";
import { pictureDraft, readCanvasLayout, readDraft, readWorkspace } from "@/lib/edit-recipe";
import { readKreaRegions, regionDescription, type KreaRegion } from "@/lib/krea-regions";
import { REGION_JSON_LIMIT } from "@/lib/brush-mask";
import { activeUser } from "@/lib/auth";
import { NextRequest, NextResponse, after } from "next/server";
import {
  buildWorkflowNodes,
  createCustomTask,
  uploadInputForWorkflow,
} from "@/lib/runninghub";
import { GPT_IMAGE_MODELS, LEGACY_MODEL, editAspectOf, expandImageMentions, findModel, settingsOf } from "@/lib/models";
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

    if (!(file instanceof File) || !file.size) {
      return NextResponse.json({ ok: false, error: "请上传参考图" }, { status: 400 });
    }

    const model = findModel(form.get("model") || LEGACY_MODEL);
    if (!model) {
      return NextResponse.json({ ok: false, error: "未知模型" }, { status: 400 });
    }
    if (model.retired) {
      return NextResponse.json({ ok: false, error: `${model.name} 已下架，请换一个模型` }, { status: 400 });
    }
    const gptModel = GPT_IMAGE_MODELS[model.id];
    const krea = model.id === "krea-3";
    const extraFiles = form.getAll("ref").slice(0, 7).filter((f): f is File => f instanceof File && f.size > 0);
    let regions: KreaRegion[] = [];
    if (form.has("regions")) {
      const raw = form.get("regions");
      let parsed: KreaRegion[] | null = null;
      try {
        if (krea && typeof raw === "string" && raw.length <= REGION_JSON_LIMIT)
          parsed = readKreaRegions(JSON.parse(raw), 1 + extraFiles.length);
      } catch { /* malformed region payload */ }
      if (!parsed) return NextResponse.json({ ok: false, error: "框选区域无效，请检查参考图、选框和提示词" }, { status: 400 });
      regions = parsed;
    }
    if (!prompt && !regions.some((r) => r.note)) {
      return NextResponse.json({ ok: false, error: "请输入提示词" }, { status: 400 });
    }
    const recordedPrompt = prompt || regionDescription(regions);
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
      for (const f of extraFiles) {
        extras.push({ bytes: Buffer.from(await f.arrayBuffer()), mime: f.type || "image/jpeg" });
      }
    }
    const images = gptImage ? [gptImage, ...extras] : undefined;
    const modelPrompt = expandImageMentions(prompt, images?.length ?? 1);
    const text = (k: string) => String(form.get(k) || "");
    const loraRaw = Number(form.get("lora"));
    const ratioLabel = regions.some((r) => r.mask) ? "auto" : text("editRatio");
    const editAspect = editAspectOf(model.id, ratioLabel);
    if (ratioLabel && ratioLabel !== "auto" && !editAspect)
      return NextResponse.json({ ok: false, error: "这个模型不支持所选比例" }, { status: 400 });
    const shape = editAspect ? { width: editAspect * 1024, height: 1024 } : {};

    const tasks: { taskId: string; seed: number }[] = [];
    for (let i = 0; i < count; i++) {
      // The first image keeps a requested seed; the others get their own.
      const s = i === 0 ? seed : Math.floor(Math.random() * 1e12);
      if (gptModel) {
        tasks.push({ taskId: await createGptTask({ imageModel: gptModel, prompt: modelPrompt, size: Number(form.get("width")) && Number(form.get("height")) ? gptSize(Number(form.get("width")), Number(form.get("height"))) : "auto", images, quality: text("quality"), background: text("background"), complexity: text("complexity") }), seed: s });
        continue;
      }
      if (krea) {
        tasks.push({ taskId: await createKreaTask({ ...shape, prompt: modelPrompt, images, quality: text("quality"), res: text("res"), thinking: form.get("thinking") === "1", seed: s, negative: text("negative"), regional: form.get("regional") === "1", regions }), seed: s });
        continue;
      }
      if (hosted) {
        tasks.push({ taskId: await createRhHostedTask({ ...shape, model: model.id, prompt: modelPrompt, images, quality: text("quality"), res: text("res"), background: text("background") }), seed: s });
        continue;
      }
      const nodeInfoList = buildWorkflowNodes(spec!, { prompt, seed: s, denoise, imageFileName, lora: form.get("lora") ? loraRaw : undefined });
      tasks.push({ taskId: await createCustomTask({ workflowId: spec!.workflowId, nodeInfoList, fast: form.get("speed") === "fast" }), seed: s });
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
    let editorDraft;
    const draft = form.get("editorDraft");
    if (typeof draft === "string" && draft.length <= REGION_JSON_LIMIT + 40_000) {
      try { editorDraft = readDraft(JSON.parse(draft)); } catch {}
    }
    if (ratioLabel) settings["改图比例"] = editAspect ? ratioLabel : "自适应";
    if (regions.length) {
      settings["深度思考"] = form.get("thinking") === "1" ? "开" : "关";
      settings["修改范围"] = regions.some((r) => r.mask) ? `画笔重绘 · ${regions.length} 处` : `框选 ${regions.length} 处`;
      editorDraft ??= pictureDraft({ id: "", mode: "i2i", model: model.id, prompt, settings, seed });
      editorDraft.regions = regions;
    } else if (editorDraft) delete editorDraft.regions;
    const workspace = readWorkspace(form.get("workspace"));
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
        prompt: recordedPrompt.slice(0, 2000),
        url: "",
        refUrl, refUrls, canvasLayout, editorDraft, workspace,
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
        refUrl, refUrls, settings, canvasLayout, editorDraft, workspace,
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
