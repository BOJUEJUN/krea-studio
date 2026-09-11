import { NextRequest, NextResponse } from "next/server";
import { appendHistory, readHistory, type HistoryItem } from "@/lib/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const items = await readHistory();
    return NextResponse.json({ ok: true, items });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "读取失败" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const url = String(body.url || "");
    if (!url) {
      return NextResponse.json({ ok: false, error: "缺少 url" }, { status: 400 });
    }
    const item: HistoryItem = {
      id: String(body.id || `${Date.now()}`),
      mode: body.mode === "i2i" ? "i2i" : "t2i",
      prompt: String(body.prompt || "").slice(0, 2000),
      url,
      cost: body.cost != null ? String(body.cost) : null,
      seed: body.seed != null ? Number(body.seed) : undefined,
      taskId: body.taskId ? String(body.taskId) : undefined,
      createdAt: Number(body.createdAt) || Date.now(),
    };
    const items = await appendHistory(item);
    return NextResponse.json({ ok: true, item, count: items.length });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "写入失败" },
      { status: 500 }
    );
  }
}
