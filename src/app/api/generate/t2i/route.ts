import { NextRequest, NextResponse } from "next/server";
import {
  buildCustomT2INodes,
  createCustomTask,
  customWorkflowIds,
  getAccountStatus,
  waitForCustomTask,
} from "@/lib/runninghub";
import { appendHistory } from "@/lib/history";

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

    const ids = customWorkflowIds();
    if (!ids.t2i) {
      return NextResponse.json(
        { ok: false, error: "未配置文生图工作流" },
        { status: 400 }
      );
    }

    const seed =
      body.seed === undefined || body.seed === null || body.seed === ""
        ? Math.floor(Math.random() * 1e12)
        : Number(body.seed);

    const nodeInfoList = buildCustomT2INodes({
      prompt,
      seed,
      width: body.width ? Number(body.width) : undefined,
      height: body.height ? Number(body.height) : undefined,
    });

    const taskId = await createCustomTask({ workflowId: ids.t2i, nodeInfoList });
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
        mode: "t2i",
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
