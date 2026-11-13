import { NextRequest, NextResponse } from "next/server";
import { NeedInvite, SESSION_COOKIE, changePassword, isOwner, loginWithPassword, makeSession, registerWithInvite, sessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who is signed in (null when nobody). */
export async function GET(req: NextRequest) {
  const user = sessionUser(req);
  // 用户 2026-11-12 (每次进去都要重新登录): a slow read of the accounts file must not answer "not signed in".
  const owner = user ? await isOwner(user).catch(() => false) : false;
  return NextResponse.json({ ok: true, user, owner }, { headers: { "Cache-Control": "no-store" } });
}

// 2026-11-06 (安全): at most 8 wrong sign-ins per address per 10 minutes (per warm server; enough to stop guessing).
const fails = new Map<string, number[]>();
const WINDOW = 10 * 60_000;
function ipOf(req: NextRequest) {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}
function tooMany(ip: string) {
  const now = Date.now();
  const list = (fails.get(ip) || []).filter((t) => now - t < WINDOW);
  fails.set(ip, list);
  return list.length >= 8;
}

/** { action: "login" | "register" | "change" | "logout", name, password, invite, oldPassword, newPassword } */
export async function POST(req: NextRequest) {
  const ip = ipOf(req);
  if (tooMany(ip)) return NextResponse.json({ ok: false, error: "试错太多次了，10 分钟后再试" }, { status: 429 });
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const action = String(body.action || "");
    if (action === "logout") {
      const res = NextResponse.json({ ok: true });
      res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
      return res;
    }
    const name = String(body.name || "").trim();
    const password = String(body.password ?? "");
    // 2026-11-11 (用户: 账号密码邀请码，安全一些): 登录 = 用户名 + 密码; 注册 = 用户名 + 密码 + 邀请码.
    if (action === "change") {
      const me = sessionUser(req);
      if (!me) return NextResponse.json({ ok: false, error: "请先登录" }, { status: 401 });
      await changePassword(me, String(body.oldPassword ?? ""), String(body.newPassword ?? ""));
      return NextResponse.json({ ok: true });
    }
    // Per-name limit too, so one account is not guessed from many addresses.
    const nameKey = "n:" + name.toLowerCase();
    if (tooMany(nameKey)) return NextResponse.json({ ok: false, error: "这个账号试错太多次了，10 分钟后再试" }, { status: 429 });
    let user;
    try {
      if (action === "login") user = await loginWithPassword(name, password);
      else if (action === "register") user = await registerWithInvite(name, password, String(body.invite ?? ""));
      else return NextResponse.json({ ok: false, error: "请刷新页面后再登录" }, { status: 400 });
    } catch (e) {
      if (!(e instanceof NeedInvite && /还没设密码/.test((e as Error).message))) {
        if (!fails.has(nameKey)) fails.set(nameKey, []);
        fails.get(nameKey)!.push(Date.now());
      }
      throw e;
    }
    const session = makeSession(user.name);
    const res = NextResponse.json({ ok: true, user: user.name });
    res.cookies.set(SESSION_COOKIE, session.value, {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: session.maxAge,
    });
    return res;
  } catch (e: any) {
    if (!fails.has(ip)) fails.set(ip, []);
    fails.get(ip)!.push(Date.now());
    return NextResponse.json({ ok: false, error: e?.message || "登录失败", needInvite: e instanceof NeedInvite }, { status: 400 });
  }
}
