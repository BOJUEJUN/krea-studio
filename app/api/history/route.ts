import { ownerName, sessionUser, unauthorized } from "@/lib/auth";
import { NextRequest, NextResponse, after } from "next/server";
import { findModel } from "@/lib/models";
import { queryCustomTask } from "@/lib/runninghub";
import { markDeleted, readHistory, upsertHistory, type HistoryItem } from "@/lib/history";
import { isRemoteImage, withBackup } from "@/lib/images";
import { directLinks } from "@/lib/thumbs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
          await upsertHistory(
            await withBackup({
              ...item,
              url: r.outputs[0],
              cost: r.cost ?? item.cost ?? null,
              durationMs: item.durationMs ?? Date.now() - item.createdAt,
            })
          );
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

const MAX_BACKUPS_PER_REQUEST = 3;

/** Copy images still served from RunningHub (older or failed backups). */
async function backfillImages(items: HistoryItem[]): Promise<boolean> {
  // 2026-11-05: a dead RunningHub link was retried on every page load (20 s each, history took 30–40 s).
  // Now at most 3 tries, an hour apart.
  const now = Date.now();
  const todo = items
    .filter((x) => isRemoteImage(x.url) && (x.backupTries ?? 0) < 3 && (!x.backupAt || now - x.backupAt > 3_600_000))
    .slice(0, MAX_BACKUPS_PER_REQUEST);
  if (!todo.length) return false;
  const done = await Promise.all(todo.map((x) => withBackup(x)));
  let changed = false;
  for (const item of done) {
    if (!isRemoteImage(item.url)) {
      await upsertHistory(item);
      changed = true;
    } else {
      await upsertHistory({ ...item, backupTries: (item.backupTries ?? 0) + 1, backupAt: now }).catch(() => {});
    }
  }
  return changed;
}

export async function GET(req: Request) {
  const user = sessionUser(req);
  if (!user) return unauthorized();
  try {
    // Each account sees only its own pictures; records from before accounts belong to the owner account.
    const [owner, all] = await Promise.all([ownerName(), readHistory()]);
    const items = all.filter((x) => (x.owner ?? owner) === user && !x.deleted);
    // Finished-but-unsaved pictures are settled after answering (2026-11-06: it made history wait seconds);
    // the page polls its own running tasks anyway.
    const pendingNow = items;
    after(() => settlePending(pendingNow).catch(() => false));
    // Copying RunningHub images can take a while from abroad: do it after answering (2026-11-05: history took 30 s).
    const snapshot = items;
    after(() => backfillImages(snapshot).catch(() => {}));
    return NextResponse.json(
      {
        ok: true,
        items: items
          .filter((x) => x.url || x.status === "failed" || x.status === "expired")
          .map((x) => ({ ...x, ...directLinks(x.url, x.refUrl) })),
        pending: items.filter((x) => !x.url && x.status === "pending").length,
        // 2026-11-05 (用户: 刷新后生成进度没了): tasks still running, so a reloaded page picks them up again.
        running: items
          .filter((x) => !x.url && x.status === "pending" && x.taskId && Date.now() - x.createdAt < 30 * 60_000)
          .map((x) => ({ taskId: x.taskId, seed: x.seed, mode: x.mode, model: x.model, prompt: x.prompt, refUrl: x.refUrl, createdAt: x.createdAt })),
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
  const user = sessionUser(req);
  if (!user) return unauthorized();
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const url = String(body.url || "");
    // Records without an image are only accepted as failed / expired entries.
    const status = body.status === "failed" || body.status === "expired" ? body.status : undefined;
    if (!url && !status) {
      return NextResponse.json({ ok: false, error: "缺少 url" }, { status: 400 });
    }
    if (url && !/^https:\/\/[a-z0-9.-]+\.(xiaoyaoyou\.com|runninghub\.cn)\//i.test(url) && !/^\/api\/img\/[0-9A-Za-z_-]+$/.test(url)) {
      return NextResponse.json({ ok: false, error: "不支持的图片地址" }, { status: 400 });
    }
    const item: HistoryItem = {
      owner: user,
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
    const d = Number(body.durationMs);
    if (url) item.durationMs = d > 0 && d < 86_400_000 ? Math.round(d) : Math.max(0, Date.now() - item.createdAt);
    const saved = await upsertHistory(await withBackup(item));
    return NextResponse.json({ ok: true, item: { ...saved, ...directLinks(saved.url, saved.refUrl) } });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "写入失败" },
      { status: 500 }
    );
  }
}

/** Star / unstar one of your own pictures. */
export async function PATCH(req: NextRequest) {
  const user = sessionUser(req);
  if (!user) return unauthorized();
  try {
    const body = (await req.json()) as { id?: string; fav?: boolean };
    const owner = await ownerName();
    const item = (await readHistory()).find((x) => x.id === String(body.id || ""));
    if (!item || (item.owner ?? owner) !== user) {
      return NextResponse.json({ ok: false, error: "找不到这张图" }, { status: 404 });
    }
    const saved = await upsertHistory({ ...item, fav: !!body.fav });
    return NextResponse.json({ ok: true, fav: !!saved.fav });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "收藏失败" }, { status: 500 });
  }
}

/** 2026-11-06 (用户: 历史加删除 / 批量删除): remove your own pictures (?id=… or JSON {ids: […]}). */
export async function DELETE(req: NextRequest) {
  const user = sessionUser(req);
  if (!user) return unauthorized();
  try {
    const one = new URL(req.url).searchParams.get("id");
    const body = one ? null : ((await req.json().catch(() => null)) as { ids?: unknown } | null);
    const ids = one ? [one] : Array.isArray(body?.ids) ? body!.ids.map(String).slice(0, 200) : [];
    const owner = await ownerName();
    const all = await readHistory();
    const mine = all.filter((x) => ids.includes(x.id) && (x.owner ?? owner) === user);
    if (!mine.length) return NextResponse.json({ ok: false, error: "找不到这些图" }, { status: 404 });
    await markDeleted(mine.map((x) => x.id));
    return NextResponse.json({ ok: true, deleted: mine.length });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "删除失败" }, { status: 500 });
  }
}
