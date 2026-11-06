import { NextRequest, NextResponse } from "next/server";
import { NeedInvite, SESSION_COOKIE, checkLogin, enterByName, isOwner, makeSession, registerUser, sessionUser, signIn } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who is signed in (null when nobody). */
export async function GET(req: NextRequest) {
  const user = sessionUser(req);
  return NextResponse.json({ ok: true, user, owner: user ? await isOwner(user) : false }, { headers: { "Cache-Control": "no-store" } });
}

/** { action: "login" | "register" | "logout", name, password, invite } */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const action = String(body.action || "");
    if (action === "logout") {
      const res = NextResponse.json({ ok: true });
      res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
      return res;
    }
    const name = String(body.name || "").trim();
    const password = String(body.password || "");
    const user =
      action === "signin"
        ? await signIn(name, password, String(body.invite || ""))
        : action === "enter"
        ? await enterByName(name, String(body.invite ?? ""))
        : action === "register"
        ? await registerUser(name, password, String(body.invite || ""))
        : await checkLogin(name, password);
    if (!user) return NextResponse.json({ ok: false, error: "用户名或密码不对" }, { status: 401 });
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
    return NextResponse.json({ ok: false, error: e?.message || "登录失败", needInvite: e instanceof NeedInvite }, { status: 400 });
  }
}
