import { NextRequest, NextResponse } from "next/server";
import { isOwner, sessionUser, unauthorized } from "@/lib/auth";
import { cosBucket, cosConf } from "@/lib/cos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 2026-11-11 (用户: 备份不花钱就搞): Tencent COS keeps every overwritten or deleted file as an old version for
 * 30 days, so a bad save or a wrong delete can be undone. Owner only: GET shows the state, POST turns it on.
 */
const RULE_ID = "keep-old-versions-30d";
const LIFECYCLE = `<LifecycleConfiguration><Rule><ID>${RULE_ID}</ID><Filter></Filter><Status>Enabled</Status><NoncurrentVersionExpiration><NoncurrentDays>30</NoncurrentDays></NoncurrentVersionExpiration></Rule></LifecycleConfiguration>`;

async function state() {
  const [v, l] = await Promise.all([cosBucket("GET", "versioning"), cosBucket("GET", "lifecycle")]);
  return {
    versioning: v.body.match(/<Status>([^<]+)<\/Status>/)?.[1] ?? (v.status === 200 ? "Off" : `error ${v.status}`),
    lifecycleRules: l.status === 404 ? [] : [...l.body.matchAll(/<ID>([^<]+)<\/ID>/g)].map((m) => m[1]),
    lifecycleStatus: l.status,
  };
}

async function owner(req: NextRequest) {
  const user = sessionUser(req);
  return !!user && (await isOwner(user));
}

export async function GET(req: NextRequest) {
  if (!(await owner(req))) return unauthorized();
  if (!cosConf()) return NextResponse.json({ ok: false, error: "不是腾讯云存储" });
  return NextResponse.json({ ok: true, ...(await state()) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!(await owner(req))) return unauthorized();
  if (!cosConf()) return NextResponse.json({ ok: false, error: "不是腾讯云存储" });
  const before = await state();
  // Never replace lifecycle rules someone else set up.
  const others = before.lifecycleRules.filter((id) => id !== RULE_ID);
  if (others.length) return NextResponse.json({ ok: false, error: "存储桶已有别的过期规则，没动", before });
  const v = await cosBucket("PUT", "versioning", "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>");
  if (v.status !== 200) return NextResponse.json({ ok: false, error: `开版本失败 (${v.status})`, detail: v.body.slice(0, 300) });
  const l = await cosBucket("PUT", "lifecycle", LIFECYCLE);
  if (l.status !== 200) return NextResponse.json({ ok: false, error: `设30天过期失败 (${l.status})`, detail: l.body.slice(0, 300) });
  return NextResponse.json({ ok: true, before, after: await state() });
}
