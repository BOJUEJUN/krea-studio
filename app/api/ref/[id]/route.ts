import { sessionUser, unauthorized } from "@/lib/auth";
import { NextResponse } from "next/server";
import { imageMime, readReference } from "@/lib/refs";
import { storeDirectUrl } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = sessionUser(_req);
  if (!user) return unauthorized();
  try {
    const { id } = await params;
    // Straight from COS unless the page fetches the bytes itself (?raw=1).
    if (new URL(_req.url).searchParams.get("raw") !== "1" && /^[0-9A-Za-z_-]{1,64}$/.test(id)) {
      const to = storeDirectUrl(`ref-${id}`);
      if (to) return NextResponse.redirect(to, { status: 302, headers: { "Cache-Control": "private, max-age=3600" } });
    }
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
