import { NextRequest, NextResponse } from "next/server";
import { isOwner, sessionUser, unauthorized } from "@/lib/auth";
import { cleanupUploads } from "@/lib/upload-cleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Weekly Vercel cron (Bearer CRON_SECRET) deletes; the owner can look (GET) or run it now (POST). */
async function allowed(req: NextRequest): Promise<"cron" | "owner" | null> {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") === `Bearer ${secret}`) return "cron";
  const user = sessionUser(req);
  return user && (await isOwner(user)) ? "owner" : null;
}

export async function GET(req: NextRequest) {
  const who = await allowed(req);
  if (!who) return unauthorized();
  const report = await cleanupUploads(who === "cron").catch((e) => ({ ok: false as const, error: String(e?.message || e) }));
  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if ((await allowed(req)) !== "owner") return unauthorized();
  const report = await cleanupUploads(true).catch((e) => ({ ok: false as const, error: String(e?.message || e) }));
  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
}
