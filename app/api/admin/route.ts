import { NextRequest, NextResponse } from "next/server";
import { inviteCode, isOwner, listUsers, sessionUser, setDisabled, setInviteCode, unauthorized } from "@/lib/auth";
import { readHistory } from "@/lib/history";
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
  const [users, items, owner, code] = await Promise.all([listUsers(), readHistory(), ownerName(), inviteCode()]);
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
  const stats = new Map<string, { images: number; cost: number; last: number; failed: number; models: Record<string, number> }>();
  for (const it of items) {
    const who = it.owner ?? owner ?? "";
    const s = stats.get(who) ?? { images: 0, cost: 0, last: 0, failed: 0, models: {} as Record<string, number> };
    if (it.url) s.images++;
    else if (it.status === "failed" || it.status === "expired") s.failed++;
    const m = it.model ?? it.label ?? "其他";
    s.models[m] = (s.models[m] ?? 0) + 1;
    s.cost += Number(it.cost) || 0;
    s.last = Math.max(s.last, it.createdAt || 0);
    stats.set(who, s);
  }
  return NextResponse.json(
    {
      ok: true,
      invite: code,
      summary,
      users: users
        .map((u) => ({ ...u, ...(stats.get(u.name) ?? { images: 0, cost: 0, last: 0, failed: 0, models: {} }) }))
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
