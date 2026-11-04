import { NextRequest, NextResponse } from "next/server";
import { findModel } from "@/lib/models";
import { queryCustomTask } from "@/lib/runninghub";
import {
  readHistory,
  removeHistory,
  upsertHistory,
  type HistoryItem,
} from "@/lib/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CHECKS_PER_REQUEST = 6;

/**
 * Tasks are recorded when they are submitted, so a closed tab no longer loses
 * the image. Pending ones are checked against RunningHub here.
 */
async function settlePending(items: HistoryItem[]): Promise<boolean> {
  const pending = items
    .filter((x) => x.status === "pending" && !x.url && x.taskId)
    .slice(0, MAX_CHECKS_PER_REQUEST);
  if (!pending.length) return false;

  const stale: string[] = [];
  let changed = false;
  await Promise.all(
    pending.map(async (item) => {
      try {
        const r = await queryCustomTask(item.taskId as string);
        if (r.status === "SUCCESS" && r.outputs[0]) {
          await upsertHistory({ ...item, url: r.outputs[0], cost: r.cost ?? item.cost ?? null });
          changed = true;
        } else if (r.status === "FAILED" || r.status === "CANCEL") {
          stale.push(item.id);
        } else if (Date.now() - item.createdAt > PENDING_TTL_MS) {
          stale.push(item.id);
        }
      } catch {
        if (Date.now() - item.createdAt > PENDING_TTL_MS) stale.push(item.id);
      }
    })
  );
  if (stale.length) {
    await removeHistory(stale);
    changed = true;
  }
  return changed;
}

export async function GET() {
  try {
    let items = await readHistory();
    if (await settlePending(items)) items = await readHistory();
    return NextResponse.json(
      {
        ok: true,
        items: items.filter((x) => x.url),
        pending: items.filter((x) => !x.url).length,
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
    if (!url) {
      return NextResponse.json({ ok: false, error: "缺少 url" }, { status: 400 });
    }
    const item: HistoryItem = {
      id: String(body.id || `${Date.now()}`),
      mode: body.mode === "i2i" ? "i2i" : "t2i",
      model: findModel(body.model)?.id,
      prompt: String(body.prompt || "").slice(0, 2000),
      url,
      cost: body.cost != null ? String(body.cost) : null,
      seed: body.seed != null ? Number(body.seed) : undefined,
      taskId: body.taskId ? String(body.taskId) : undefined,
      createdAt: Number(body.createdAt) || Date.now(),
    };
    const items = await upsertHistory(item);
    return NextResponse.json({ ok: true, item, count: items.length });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "写入失败" },
      { status: 500 }
    );
  }
}
