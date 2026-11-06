import { sessionUser, unauthorized } from "@/lib/auth";
import { NextResponse } from "next/server";
import { imageMime, readReference } from "@/lib/refs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = sessionUser(_req);
  if (!user) return unauthorized();
  try {
    const { id } = await params;
    const bytes = await readReference(id);
    if (!bytes) return NextResponse.json({ ok: false, error: "参考图不存在" }, { status: 404 });
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": imageMime(bytes),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "读取失败" }, { status: 400 });
  }
}
