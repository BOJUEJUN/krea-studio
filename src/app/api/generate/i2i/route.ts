import { NextRequest, NextResponse } from "next/server";
import {
  buildI2IPayload,
  findModel,
  runModel,
  uploadMedia,
} from "@/lib/runninghub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const prompt = String(form.get("prompt") || "").trim();
    const file = form.get("image") as File | null;
    const modelId = String(form.get("modelId") || "jimeng-4.6");

    if (!prompt) {
      return NextResponse.json({ ok: false, error: "请输入提示词" }, { status: 400 });
    }
    if (!file) {
      return NextResponse.json({ ok: false, error: "请上传参考图" }, { status: 400 });
    }

    const model = findModel("i2i", modelId);
    if (!model) {
      return NextResponse.json({ ok: false, error: "未知模型" }, { status: 400 });
    }

    // Official contract: upload first, then submit with URL
    const imageUrl = await uploadMedia(file, file.name || "input.png");

    const width = form.get("width") ? Number(form.get("width")) : undefined;
    const height = form.get("height") ? Number(form.get("height")) : undefined;

    const payload = buildI2IPayload({
      modelId,
      prompt,
      imageUrl,
      width,
      height,
    });

    const result = await runModel({
      endpoint: model.endpoint,
      payload,
      timeoutMs: 180_000,
    });

    if (result.status !== "SUCCESS") {
      return NextResponse.json(
        {
          ok: false,
          error:
            result.raw.errorMessage ||
            result.raw.errorCode ||
            `任务失败 (${result.status})`,
          taskId: result.taskId,
          status: result.status,
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      taskId: result.taskId,
      model: model.name,
      imageUrl: result.outputs[0],
      images: result.outputs,
      raw: result.raw,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "服务器错误" },
      { status: 500 }
    );
  }
}
