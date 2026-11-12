import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Which deploy is live, so a page left open can offer to refresh after an update (2026-11-12). */
export async function GET() {
  return NextResponse.json({ build: process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_URL || "dev" }, { headers: { "Cache-Control": "no-store" } });
}
