import { NextRequest, NextResponse } from "next/server";
import {
  buildT2IPayload,
  findModel,
  runModel,
} from "@/lib/runninghub";

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

    const modelId = String(body.modelId || "jimeng-4.6");
    const model = findModel("t2i", modelId);
    if (!model) {
      return NextResponse.json({ ok: false, error: "未知模型" }, { status: 400 });
    }

    const width = body.width ? Number(body.width) : undefined;
    const height = body.height ? Number(body.height) : undefined;
    const seed =
      body.seed === undefined || body.seed === null || body.seed === ""
        ? undefined
        : Number(body.seed);

    const payload = buildT2IPayload({
      modelId,
      prompt,
      width,
      height,
      seed,
      aspectRatio: body.aspectRatio,
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
