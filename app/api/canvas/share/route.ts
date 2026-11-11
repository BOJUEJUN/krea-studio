import { activeUser } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { storeGet, storePut } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 2026-11-11 (用户: 分享画布，对方能在自己的画布里打开继续编辑): a share link holds a copy of the board as it was
 * when shared. Opening it puts a new board with that copy into the viewer's own list; the two never touch again.
 */
const key = (t: string) => `canvas-share-${t}.json`;
const okSrc = (s: unknown) => typeof s === "string" && /^(\/api\/(img|ref)\/[0-9A-Za-z_-]{1,64}|https:\/\/)/.test(s) && s.length < 2000;

export async function POST(req: NextRequest) {
  const who = await activeUser(req);
  if ("res" in who) return who.res;
  try {
    const body = await req.json();
    const nodes = (Array.isArray(body?.nodes) ? body.nodes : [])
      .slice(0, 400)
      .filter((n: any) => n && typeof n.id === "string" && (n.kind === "text" || okSrc(n.src)))
      .map((n: any) => ({
        id: String(n.id).slice(0, 40),
        kind: n.kind === "text" ? "text" : undefined,
        text: n.kind === "text" ? String(n.text ?? "").slice(0, 2000) : undefined,
        src: n.kind === "text" ? undefined : n.src,
        x: Number(n.x) || 0,
        y: Number(n.y) || 0,
        w: Math.max(20, Number(n.w) || 320),
        h: Math.max(20, Number(n.h) || 320),
        from: Array.isArray(n.from) ? n.from.map(String).slice(0, 20) : undefined,
        nw: Number(n.nw) || undefined,
        nh: Number(n.nh) || undefined,
      }));
    if (!nodes.length) return NextResponse.json({ ok: false, error: "画布是空的" }, { status: 400 });
    const t = randomBytes(9).toString("base64url");
    const name = String(body?.name || "画布").slice(0, 20);
    await storePut(key(t), JSON.stringify({ owner: who.user, name, nodes, view: body?.view ?? null, createdAt: Date.now() }), "application/json");
    return NextResponse.json({ ok: true, token: t });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "分享失败" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const who = await activeUser(req);
  if ("res" in who) return who.res;
  const t = new URL(req.url).searchParams.get("t") || "";
  if (!/^[0-9A-Za-z_-]{8,32}$/.test(t)) return NextResponse.json({ ok: false, error: "链接不对" }, { status: 400 });
  const b = await storeGet(key(t)).catch(() => null);
  if (!b) return NextResponse.json({ ok: false, error: "这个分享链接不存在了" }, { status: 404 });
  try {
    const d = JSON.parse(b.toString("utf8"));
    return NextResponse.json({ ok: true, owner: d.owner, name: d.name, nodes: d.nodes, view: d.view });
  } catch {
    return NextResponse.json({ ok: false, error: "分享内容坏了" }, { status: 500 });
  }
}
