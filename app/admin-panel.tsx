"use client";

import { useEffect, useState } from "react";

type Row = { name: string; owner: boolean; disabled: boolean; images: number; cost: number; last: number; createdAt: number };

/** Owner-only: every account with pictures made and spend; stop / restore an account; new invite code. */
export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [invite, setInvite] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch("/api/admin", { cache: "no-store" });
    const d = await res.json().catch(() => ({}));
    if (!d?.ok) return setError(d?.error || "读取失败");
    setRows(d.users);
    setInvite(d.invite);
  };
  useEffect(() => {
    load();
  }, []);

  const act = async (body: Record<string, string>) => {
    const res = await fetch("/api/admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    if (!d?.ok) return setError(d?.error || "操作失败");
    if (d.invite) setInvite(d.invite);
    load();
  };

  const day = (t: number) => (t ? new Date(t).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "—");
  const total = rows?.reduce((a, r) => a + r.cost, 0) ?? 0;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/25 px-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="animate-pop-in max-h-[80vh] w-full max-w-[560px] overflow-hidden rounded-[22px] bg-white shadow-[0_24px_70px_rgba(0,0,0,0.18)]">
        <div className="flex items-center justify-between border-b border-black/[0.06] px-5 py-3.5">
          <div className="text-[15px] font-semibold text-[#1d1d1f]">管理</div>
          <button type="button" onClick={onClose} className="rounded-full px-2 py-0.5 text-[13px] text-[#6e6e73] hover:bg-black/[0.05]">关闭</button>
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-black/[0.06] px-5 py-3">
          <div>
            <div className="text-[12px] text-[#86868b]">邀请码（新账号注册要填）</div>
            <div className="mt-0.5 font-mono text-[20px] tracking-[0.25em] text-[#1d1d1f]">{invite || "—"}</div>
          </div>
          <div className="flex gap-1.5">
            <button type="button" onClick={() => navigator.clipboard?.writeText(invite)} className="rounded-full bg-black/[0.05] px-3 py-1.5 text-[12px] hover:bg-black/[0.09]">复制</button>
            <button type="button" onClick={() => act({ action: "invite" })} className="rounded-full bg-[#0071e3] px-3 py-1.5 text-[12px] text-white">换一个</button>
          </div>
        </div>
        {error && <div className="mx-5 mt-3 rounded-xl bg-[#fff1f0] px-3 py-2 text-[12px] text-[#d70015]">{error}</div>}
        <div className="max-h-[52vh] overflow-y-auto px-2 py-2">
          <div className="flex px-3 pb-1 text-[11px] text-[#86868b]">
            <span className="flex-1">账号</span><span className="w-14 text-right">图片</span><span className="w-20 text-right">花费</span><span className="w-16 text-right">最近</span><span className="w-16" />
          </div>
          {rows === null ? (
            <div className="px-3 py-6 text-center text-[12px] text-[#aeaeb2]">读取中…</div>
          ) : (
            rows.map((r) => (
              <div key={r.name} className={`flex items-center rounded-xl px-3 py-2 text-[13px] ${r.disabled ? "opacity-50" : ""} hover:bg-black/[0.03]`}>
                <span className="min-w-0 flex-1 truncate text-[#1d1d1f]">
                  {r.name}
                  {r.owner && <span className="ml-1.5 rounded-full bg-[#0071e3]/10 px-1.5 py-px text-[10px] text-[#0071e3]">管理员</span>}
                  {r.disabled && <span className="ml-1.5 rounded-full bg-[#d70015]/10 px-1.5 py-px text-[10px] text-[#d70015]">已停用</span>}
                </span>
                <span className="w-14 text-right tabular-nums text-[#6e6e73]">{r.images}</span>
                <span className="w-20 text-right tabular-nums text-[#1d1d1f]">¥{r.cost.toFixed(2)}</span>
                <span className="w-16 text-right tabular-nums text-[#86868b]">{day(r.last)}</span>
                <span className="w-16 text-right">
                  {!r.owner && (
                    <button
                      type="button"
                      onClick={() => act({ action: r.disabled ? "enable" : "disable", name: r.name })}
                      className={`rounded-full px-2 py-0.5 text-[11px] ${r.disabled ? "text-[#0071e3] hover:bg-[#0071e3]/10" : "text-[#d70015] hover:bg-[#d70015]/10"}`}
                    >
                      {r.disabled ? "恢复" : "停用"}
                    </button>
                  )}
                </span>
              </div>
            ))
          )}
        </div>
        <div className="border-t border-black/[0.06] px-5 py-2.5 text-right text-[12px] text-[#6e6e73]">合计约 ¥{total.toFixed(2)}</div>
      </div>
    </div>
  );
}
