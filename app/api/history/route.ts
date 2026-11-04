import { NextRequest, NextResponse } from "next/server";
import { findModel } from "@/lib/models";
import { queryCustomTask } from "@/lib/runninghub";
import { readHistory, upsertHistory, type HistoryItem } from "@/lib/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CHECKS_PER_REQUEST = 8;

/**
 * Tasks are recorded when they are submitted, so a closed tab no longer loses
 * the image. Pending ones are checked against RunningHub here; failures stay
 * in history (marked failed) so it lines up with RunningHub's own records.
 */
async function settlePending(items: HistoryItem[]): Promise<boolean> {
  const pending = items
    .filter((x) => x.status === "pending" && !x.url && x.taskId)
    .slice(0, MAX_CHECKS_PER_REQUEST);
  if (!pending.length) return false;

  let changed = false;
  await Promise.all(
    pending.map(async (item) => {
      const expired = Date.now() - item.createdAt > PENDING_TTL_MS;
      try {
        const r = await queryCustomTask(item.taskId as string);
        if (r.status === "SUCCESS" && r.outputs[0]) {
          await upsertHistory({ ...item, url: r.outputs[0], cost: r.cost ?? item.cost ?? null });
          changed = true;
        } else if (r.status === "FAILED" || r.status === "CANCEL" || expired) {
          await upsertHistory({
            ...item,
            status: "failed",
            error: r.errorMessage || (expired ? "超过 24 小时未返回结果" : "任务失败"),
          });
          changed = true;
        }
      } catch {
        if (expired) {
          await upsertHistory({ ...item, status: "failed", error: "超过 24 小时未返回结果" });
          changed = true;
        }
      }
    })
  );
  return changed;
}

export async function GET() {
  try {
    let items = await readHistory();
    if (await settlePending(items)) items = await readHistory();
    return NextResponse.json(
      {
        ok: true,
        items: items.filter((x) => x.url || x.status === "failed" || x.status === "expired"),
        pending: items.filter((x) => !x.url && x.status === "pending").length,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "读取失败" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const url = String(body.url || "");
    // Records without an image are only accepted as failed / expired entries.
    const status = body.status === "failed" || body.status === "expired" ? body.status : undefined;
    if (!url && !status) {
      return NextResponse.json({ ok: false, error: "缺少 url" }, { status: 400 });
    }
    if (url && !/^https:\/\/[a-z0-9.-]+\.(xiaoyaoyou\.com|runninghub\.cn)\//i.test(url)) {
      return NextResponse.json({ ok: false, error: "不支持的图片地址" }, { status: 400 });
    }
    const item: HistoryItem = {
      id: String(body.id || `${Date.now()}`),
      mode: body.mode === "i2i" ? "i2i" : "t2i",
      model: findModel(body.model)?.id,
      label: typeof body.label === "string" ? body.label.slice(0, 40) : undefined,
      status,
      error: status && typeof body.error === "string" ? body.error.slice(0, 200) : undefined,
      prompt: String(body.prompt || "").slice(0, 2000),
      url,
      refUrl:
        typeof body.refUrl === "string" && /^\/api\/ref\/[0-9A-Za-z_-]+$/.test(body.refUrl)
          ? body.refUrl
          : undefined,
      cost: body.cost != null ? String(body.cost) : null,
      seed: body.seed != null ? Number(body.seed) : undefined,
      taskId: body.taskId ? String(body.taskId) : undefined,
      createdAt: Number(body.createdAt) || Date.now(),
    };
    const saved = await upsertHistory(item);
    return NextResponse.json({ ok: true, item: saved });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "写入失败" },
      { status: 500 }
    );
  }
}
