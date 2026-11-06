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
  const stats = new Map<string, { images: number; cost: number; last: number }>();
  for (const it of items) {
    const who = it.owner ?? owner ?? "";
    const s = stats.get(who) ?? { images: 0, cost: 0, last: 0 };
    if (it.url) s.images++;
    s.cost += Number(it.cost) || 0;
    s.last = Math.max(s.last, it.createdAt || 0);
    stats.set(who, s);
  }
  return NextResponse.json(
    {
      ok: true,
      invite: code,
      users: users
        .map((u) => ({ ...u, ...(stats.get(u.name) ?? { images: 0, cost: 0, last: 0 }) }))
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
