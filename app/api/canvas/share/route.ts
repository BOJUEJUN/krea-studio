import { readNumbers } from "@/lib/reference-numbers";
import { activeUser } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { randomInt } from "crypto";
import { storeGet, storePut } from "@/lib/store";
import { readDraft } from "@/lib/canvas-workflow";
import { isShortShareCode, shareLifetime, shortAlphabet } from "@/lib/canvas-share-code";

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
    if (body?.nodes?.length > 400) return NextResponse.json({ ok: false, error: "一次最多分享 400 个节点" }, { status: 400 });
    const nodes = (Array.isArray(body?.nodes) ? body.nodes : [])
      .filter((n: any) => n && typeof n.id === "string" && (n.kind === "text" || n.kind === "gen" || okSrc(n.src)))
      .map((n: any) => ({
        id: String(n.id).slice(0, 40),
        kind: ["text", "gen", "result", "image"].includes(n.kind) ? n.kind : undefined,
        text: n.kind === "text" ? String(n.text ?? "").slice(0, 2000) : undefined,
        src: n.kind === "text" || n.kind === "gen" ? undefined : n.src,
        x: Number(n.x) || 0,
        y: Number(n.y) || 0,
        w: Math.max(20, Number(n.w) || 320),
        h: Math.max(20, Number(n.h) || 320),
        refNumbers: readNumbers(n.refNumbers),
        from: Array.isArray(n.from) ? n.from.map(String).slice(0, 20) : undefined,
        nw: Number(n.nw) || undefined,
        nh: Number(n.nh) || undefined,
        draft: n.kind === "gen" || n.kind === "result" ? readDraft(n.draft) : undefined,
      }));
    if (!nodes.length) return NextResponse.json({ ok: false, error: "画布是空的" }, { status: 400 });
    const name = String(body?.name || "画布").slice(0, 20);
    const createdAt = Date.now(), expiresAt = createdAt + shareLifetime;
    const snapshot = JSON.stringify({ owner: who.user, name, nodes, view: body?.view ?? null, createdAt, expiresAt });
    for (let attempt = 0; attempt < 8; attempt++) {
      let token = "";
      do {
        token = Array.from({ length: 6 }, () => shortAlphabet[randomInt(shortAlphabet.length)]).join("");
      } while (!isShortShareCode(token));
      if (await storeGet(key(token))) continue;
      try { await storePut(key(token), snapshot, "application/json", 20_000, true); }
      catch (error) { if (await storeGet(key(token))) continue; throw error; }
      return NextResponse.json({ ok: true, token, expiresAt });
    }
    throw new Error("暂时无法创建分享，请重试");
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "分享失败" }, { status: 500 });
  }
}

// Short codes are bearer credentials. Limit repeated misses by signed-in account.
const misses = new Map<string, { count: number; until: number }>();
export async function GET(req: NextRequest) {
  const who = await activeUser(req);
  if ("res" in who) return who.res;
  const t = new URL(req.url).searchParams.get("t") || "";
  const short = isShortShareCode(t);
  if (!short && !/^[0-9A-Za-z_-]{8,32}$/.test(t)) return NextResponse.json({ ok: false, error: "链接不对" }, { status: 400 });
  const now = Date.now();
  for (const [account, limit] of misses) if (limit.until <= now) misses.delete(account);
  const limit = misses.get(who.user);
  if (short && limit && limit.count >= 20) return NextResponse.json({ ok: false, error: "请稍后再试" }, { status: 429 });
  const b = await storeGet(key(t));
  if (short && !b) misses.set(who.user, { count: (limit?.count ?? 0) + 1, until: limit?.until ?? now + 60_000 });
  if (!b) return NextResponse.json({ ok: false, error: "这个分享链接不存在了" }, { status: 404 });
  try {
    const d = JSON.parse(b.toString("utf8"));
    if (d.expiresAt && Date.now() >= d.expiresAt)
      return NextResponse.json({ ok: false, error: "分享口令已过期，请让对方重新分享" }, { status: 410 });
    return NextResponse.json({ ok: true, owner: d.owner, name: d.name, nodes: d.nodes, view: d.view });
  } catch {
    return NextResponse.json({ ok: false, error: "分享内容坏了" }, { status: 500 });
  }
}
