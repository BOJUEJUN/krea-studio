import { NextRequest, NextResponse } from "next/server";
import { NeedInvite, SESSION_COOKIE, enterByName, isOwner, makeSession, sessionUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who is signed in (null when nobody). */
export async function GET(req: NextRequest) {
  const user = sessionUser(req);
  return NextResponse.json({ ok: true, user, owner: user ? await isOwner(user) : false }, { headers: { "Cache-Control": "no-store" } });
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

/** { action: "enter" | "logout", name, invite } */
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
    // 2026-11-06 (安全): only 用户名 + 邀请码 sign-in is open. The old password actions let an account without a
    // password be taken by anyone (no invite needed), so they are closed.
    if (action !== "enter") return NextResponse.json({ ok: false, error: "不支持的操作" }, { status: 400 });
    const user = await enterByName(name, String(body.invite ?? ""));
    if (!user) {
      fails.get(ip)?.push(Date.now());
      return NextResponse.json({ ok: false, error: "用户名或密码不对" }, { status: 401 });
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
    fails.get(ip)?.push(Date.now());
    return NextResponse.json({ ok: false, error: e?.message || "登录失败", needInvite: e instanceof NeedInvite }, { status: 400 });
  }
}
