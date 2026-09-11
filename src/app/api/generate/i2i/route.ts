import { NextRequest, NextResponse } from "next/server";
import {
  buildCustomI2INodes,
  createCustomTask,
  customWorkflowIds,
  getAccountStatus,
  uploadInputForWorkflow,
  waitForCustomTask,
} from "@/lib/runninghub";
import { appendHistory } from "@/lib/history";

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
        ? Math.floor(Math.random() * 1e12)
        : Number(seedRaw);

    if (!prompt) {
      return NextResponse.json({ ok: false, error: "请输入提示词" }, { status: 400 });
    }
    if (!file) {
      return NextResponse.json({ ok: false, error: "请上传参考图" }, { status: 400 });
    }

    const ids = customWorkflowIds();
    if (!ids.i2i) {
      return NextResponse.json(
        { ok: false, error: "未配置图生图工作流" },
        { status: 400 }
      );
    }

    const imageFileName = await uploadInputForWorkflow(file, file.name || "input.png");
    const nodeInfoList = buildCustomI2INodes({
      prompt,
      seed,
      denoise,
      imageFileName,
    });

    const taskId = await createCustomTask({ workflowId: ids.i2i, nodeInfoList });
    const result = await waitForCustomTask(taskId, { timeoutMs: 180_000 });

    if (!result.outputs.length) {
      return NextResponse.json(
        {
          ok: false,
          error: result.errorMessage || `任务未返回图片 (${result.status})`,
          taskId,
          status: result.status,
        },
        { status: 502 }
      );
    }

    let account: any = null;
    try {
      account = (await getAccountStatus())?.data || null;
    } catch {}

    try {
      await appendHistory({
        id: `${Date.now()}`,
        mode: "i2i",
        prompt,
        url: result.outputs[0],
        cost: result.cost || null,
        seed,
        taskId,
        createdAt: Date.now(),
      });
    } catch {}

    return NextResponse.json({
      ok: true,
      taskId,
      seed,
      imageUrl: result.outputs[0],
      images: result.outputs,
      cost: result.cost || null,
      account,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "服务器错误" },
      { status: 500 }
    );
  }
}
