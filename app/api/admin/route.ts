import { NextRequest, NextResponse } from "next/server";
import { dailyLimit, inviteCode, isOwner, listUsers, sessionUser, setDailyLimit, setDisabled, setInviteCode, unauthorized } from "@/lib/auth";
import { readHistory, readUserHistory } from "@/lib/history";
import { recordWorkspace } from "@/lib/edit-recipe";
import { directLinks } from "@/lib/thumbs";
import { ownerName } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function ownerOnly(req: Request) {
  const user = sessionUser(req);
  if (!user) return unauthorized();
  if (!(await isOwner(user))) return NextResponse.json({ ok: false, error: "只有管理员能看" }, { status: 403 });
  return null;
}

/** Accounts with pictures made and spend, plus the invite code (owner only). */
export async function GET(req: NextRequest) {
  const deny = await ownerOnly(req);
  if (deny) return deny;
  const query = req.nextUrl.searchParams;
  if (query.has("record")) {
    const id = query.get("record"), account = query.get("account");
    if (!id || !account || id.length > 128 || account.length > 64) return NextResponse.json({ ok: false, error: "记录无效" }, { status: 400 });
    const item = (await readUserHistory(account)).find((it) => it.id === id);
    if (!item) return NextResponse.json({ ok: false, error: "找不到这条记录" }, { status: 404 });
    const { mode, model, label, prompt, url, status, seed, refUrl, refUrls, settings, canvasLayout, editorDraft, createdAt } = item;
    return NextResponse.json({ ok: true, viewer: sessionUser(req), item: { id, mode, model, label, prompt, url, status, seed, refUrl, refUrls,
      settings, canvasLayout, editorDraft, createdAt, workspace: recordWorkspace(item) } }, { headers: { "Cache-Control": "private, no-store" } });
  }
  const [users, items, owner, code, limitPerDay] = await Promise.all([listUsers(), readHistory(), ownerName(), inviteCode(), dailyLimit()]);
  const want = new URL(req.url).searchParams.get("user");
  if (want) {
    // One account's records, newest first (2026-11-05 用户: 后台要看到用户的生图记录).
    const mine = items
      .filter((it) => (it.owner ?? owner) === want)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 300)
      .map((it) => ({
        id: it.id,
        url: it.url,
        prompt: it.prompt,
        model: it.model ?? it.label ?? "",
        mode: it.mode,
        status: it.url ? "done" : it.status ?? "pending",
        error: it.error,
        cost: it.cost,
        durationMs: it.durationMs,
        createdAt: it.createdAt,
      }));
    return NextResponse.json({ ok: true, items: mine }, { headers: { "Cache-Control": "no-store" } });
  }
  const dayStart = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }) + "T00:00:00+08:00").getTime();
  const summary = { today: 0, week: 0, total: 0, todayImages: 0, failed: 0 };
  for (const it of items) {
    const c = Number(it.cost) || 0;
    summary.total += c;
    if (it.createdAt >= dayStart) {
      summary.today += c;
      if (it.url) summary.todayImages++;
    }
    if (it.createdAt >= Date.now() - 7 * 86_400_000) summary.week += c;
    if (!it.url && (it.status === "failed" || it.status === "expired")) summary.failed++;
  }
  const stats = new Map<string, { images: number; cost: number; last: number; failed: number; today: number; models: Record<string, number> }>();
  for (const it of items) {
    const who = it.owner ?? owner ?? "";
    const s = stats.get(who) ?? { images: 0, cost: 0, last: 0, failed: 0, today: 0, models: {} as Record<string, number> };
    // Same rule as the daily limit (lib/quota): today's pictures that did not fail.
    if (it.createdAt >= dayStart && it.status !== "failed" && it.status !== "expired") s.today++;
    if (it.url) s.images++;
    else if (it.status === "failed" || it.status === "expired") s.failed++;
    const m = it.model ?? it.label ?? "其他";
    s.models[m] = (s.models[m] ?? 0) + 1;
    s.cost += Number(it.cost) || 0;
    s.last = Math.max(s.last, it.createdAt || 0);
    stats.set(who, s);
  }
  // 2026-11-05 (用户: 管理要是正常的多功能页面): daily spend for 30 days, per-model totals, and every record.
  const dayKey = (t: number) => new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const daily: { day: string; cost: number; images: number; failed: number }[] = [];
  for (let i = 29; i >= 0; i--) daily.push({ day: dayKey(dayStart - i * 86_400_000 + 3_600_000), cost: 0, images: 0, failed: 0 });
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const models = new Map<string, { model: string; images: number; failed: number; cost: number; ms: number; timed: number }>();
  let month = 0, okAll = 0, failAll = 0, msAll = 0, timedAll = 0;
  for (const it of items) {
    const c = Number(it.cost) || 0;
    const bad = !it.url && (it.status === "failed" || it.status === "expired");
    if (it.createdAt >= dayStart - 29 * 86_400_000) month += c;
    const d = byDay.get(dayKey(it.createdAt));
    if (d) {
      d.cost += c;
      if (it.url) d.images++;
      if (bad) d.failed++;
    }
    const key = it.model ?? it.label ?? "其他";
    const m = models.get(key) ?? { model: key, images: 0, failed: 0, cost: 0, ms: 0, timed: 0 };
    if (it.url) m.images++;
    if (bad) m.failed++;
    m.cost += c;
    if (it.url && it.durationMs) {
      m.ms += it.durationMs;
      m.timed++;
      msAll += it.durationMs;
      timedAll++;
    }
    models.set(key, m);
    if (it.url) okAll++;
    if (bad) failAll++;
  }
  const records = items
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 1500)
    .map((it) => ({
      id: it.id,
      owner: it.owner ?? owner ?? "",
      url: it.url,
      refUrl: it.refUrl,
      refUrls: it.refUrls,
      workspace: recordWorkspace(it),
      nodeCount: it.canvasLayout ? 1 + it.canvasLayout.inputs.length : undefined,
      seed: it.seed,
      polishLevel: it.editorDraft?.polishLevel,
      reverseOn: it.editorDraft?.reverseOn,
      prompt: it.prompt,
      model: it.model ?? it.label ?? "",
      mode: it.mode,
      status: it.url ? "done" : it.status ?? "pending",
      error: it.error,
      cost: it.cost,
      durationMs: it.durationMs,
      settings: it.settings,
      userPrompt: it.userPrompt,
      fav: !!it.fav,
      deleted: !!it.deleted,
      ...directLinks(it.url, it.refUrl),
      createdAt: it.createdAt,
    }));
  return NextResponse.json(
    {
      ok: true,
      invite: code,
      dailyLimit: limitPerDay,
      summary: {
        ...summary,
        month,
        images: okAll,
        successRate: okAll + failAll ? okAll / (okAll + failAll) : 1,
        avgMs: timedAll ? msAll / timedAll : 0,
        users: users.length,
      },
      daily,
      models: [...models.values()]
        .map(({ ms, timed, ...m }) => ({ ...m, avgMs: timed ? ms / timed : 0 }))
        .sort((a, b) => b.cost - a.cost || b.images - a.images),
      records,
      users: users
        .map((u) => ({ ...u, ...(stats.get(u.name) ?? { images: 0, cost: 0, last: 0, failed: 0, today: 0, models: {} }) }))
        .sort((a, b) => b.last - a.last),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/** { action: "disable" | "enable", name } or { action: "invite" } (new random code). */
export async function POST(req: NextRequest) {
  const deny = await ownerOnly(req);
  if (deny) return deny;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    if (body.action === "setInvite") {
      const code = String(body.code || "").trim();
      if (!/^[0-9A-Za-z_-]{4,32}$/.test(code)) throw new Error("邀请码 4–32 位，只能用字母、数字、_ -");
      await setInviteCode(code);
      return NextResponse.json({ ok: true, invite: code });
    }
    if (body.action === "setLimit") {
      const n = Math.round(Number(body.limit));
      if (!Number.isFinite(n) || n < 0 || n > 10000) throw new Error("上限填 0–10000 的整数，0 表示不限");
      await setDailyLimit(n);
      return NextResponse.json({ ok: true, dailyLimit: n });
    }
    if (body.action === "invite") {
      const abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
      const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => abc[b % abc.length]).join("");
      await setInviteCode(code);
      return NextResponse.json({ ok: true, invite: code });
    }
    await setDisabled(String(body.name || ""), body.action === "disable");
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "操作失败" }, { status: 400 });
  }
}
