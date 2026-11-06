"use client";

import { useEffect, useState } from "react";
import { findModel } from "@/lib/models";

type Row = {
  name: string;
  owner: boolean;
  disabled: boolean;
  images: number;
  failed: number;
  cost: number;
  last: number;
  createdAt: number;
  models: Record<string, number>;
};
type Summary = { today: number; week: number; total: number; todayImages: number; failed: number };
type Item = {
  id: string;
  url: string;
  prompt: string;
  model: string;
  mode: "t2i" | "i2i";
  status: string;
  error?: string;
  cost?: string | null;
  durationMs?: number;
  createdAt: number;
};

const modelName = (id: string) => findModel(id)?.name ?? (id || "其他");
const when = (t: number) =>
  t ? new Date(t).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const secs = (ms?: number) => (ms ? `${Math.round(ms / 1000)} 秒` : "");

/**
 * Owner dashboard (2026-11-05 用户: 后台要看到更多信息，比如用户的生图记录): spend today / this week / total,
 * every account with pictures, failures, spend and favourite models; tap an account to see its pictures.
 */
export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [invite, setInvite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [who, setWho] = useState<string | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [open, setOpen] = useState<Item | null>(null);

  const load = async () => {
    const res = await fetch("/api/admin", { cache: "no-store" });
    const d = await res.json().catch(() => ({}));
    if (!d?.ok) return setError(d?.error || "读取失败");
    setRows(d.users);
    setSummary(d.summary);
    setInvite(d.invite);
  };
  useEffect(() => {
    load();
  }, []);

  const showUser = async (name: string) => {
    setWho(name);
    setItems(null);
    const res = await fetch(`/api/admin?user=${encodeURIComponent(name)}`, { cache: "no-store" });
    const d = await res.json().catch(() => ({}));
    if (!d?.ok) return setError(d?.error || "读取失败");
    setItems(d.items);
  };

  const act = async (body: Record<string, string>) => {
    const res = await fetch("/api/admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    if (!d?.ok) return setError(d?.error || "操作失败");
    if (d.invite) setInvite(d.invite);
    load();
  };

  const card = "rounded-2xl bg-[#f5f5f7] px-4 py-3";
  const user = rows?.find((r) => r.name === who);

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/25 px-3 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="animate-pop-in flex max-h-[90vh] w-full max-w-[900px] flex-col overflow-hidden rounded-[22px] bg-white shadow-[0_24px_70px_rgba(0,0,0,0.18)]">
        <div className="flex shrink-0 items-center gap-2 border-b border-black/[0.06] px-5 py-3.5">
          {who && (
            <button type="button" onClick={() => { setWho(null); setItems(null); }} className="rounded-full px-2 py-0.5 text-[13px] text-[#0071e3] hover:bg-[#0071e3]/10">
              ‹ 返回
            </button>
          )}
          <div className="text-[15px] font-semibold text-[#1d1d1f]">{who ? `${who} 的生图记录` : "管理"}</div>
          <button type="button" onClick={onClose} className="ml-auto rounded-full px-2 py-0.5 text-[13px] text-[#6e6e73] hover:bg-black/[0.05]">关闭</button>
        </div>
        {error && <div className="mx-5 mt-3 rounded-xl bg-[#fff1f0] px-3 py-2 text-[12px] text-[#d70015]">{error}</div>}

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!who ? (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className={card}><div className="text-[11px] text-[#86868b]">今天花费</div><div className="mt-0.5 text-[20px] font-semibold tabular-nums">¥{(summary?.today ?? 0).toFixed(2)}</div><div className="text-[11px] text-[#86868b]">{summary?.todayImages ?? 0} 张</div></div>
                <div className={card}><div className="text-[11px] text-[#86868b]">近 7 天</div><div className="mt-0.5 text-[20px] font-semibold tabular-nums">¥{(summary?.week ?? 0).toFixed(2)}</div></div>
                <div className={card}><div className="text-[11px] text-[#86868b]">总花费</div><div className="mt-0.5 text-[20px] font-semibold tabular-nums">¥{(summary?.total ?? 0).toFixed(2)}</div></div>
                <div className={card}><div className="text-[11px] text-[#86868b]">邀请码</div>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span className="font-mono text-[17px] tracking-[0.12em]">{invite || "—"}</span>
                    <button type="button" onClick={() => navigator.clipboard?.writeText(invite)} className="rounded-full px-1.5 text-[11px] text-[#0071e3] hover:bg-[#0071e3]/10">复制</button>
                    <button type="button" onClick={() => act({ action: "invite" })} className="rounded-full px-1.5 text-[11px] text-[#0071e3] hover:bg-[#0071e3]/10">换</button>
                  </div>
                </div>
              </div>

              <div className="mt-4 overflow-x-auto">
                <div className="min-w-[620px]">
                  <div className="flex px-3 pb-1 text-[11px] text-[#86868b]">
                    <span className="flex-1">账号</span><span className="w-14 text-right">图片</span><span className="w-12 text-right">失败</span><span className="w-20 text-right">花费</span><span className="w-40 pl-4">常用模型</span><span className="w-24 text-right">最近</span><span className="w-14" />
                  </div>
                  {rows === null ? (
                    <div className="px-3 py-6 text-center text-[12px] text-[#aeaeb2]">读取中…</div>
                  ) : (
                    rows.map((r) => {
                      const top = Object.entries(r.models).sort((a, b) => b[1] - a[1]).slice(0, 2);
                      return (
                        <div
                          key={r.name}
                          onClick={() => showUser(r.name)}
                          className={`flex cursor-pointer items-center rounded-xl px-3 py-2.5 text-[13px] transition hover:bg-black/[0.04] ${r.disabled ? "opacity-50" : ""}`}
                        >
                          <span className="min-w-0 flex-1 truncate text-[#1d1d1f]">
                            {r.name}
                            {r.owner && <span className="ml-1.5 rounded-full bg-[#0071e3]/10 px-1.5 py-px text-[10px] text-[#0071e3]">管理员</span>}
                            {r.disabled && <span className="ml-1.5 rounded-full bg-[#d70015]/10 px-1.5 py-px text-[10px] text-[#d70015]">已停用</span>}
                          </span>
                          <span className="w-14 text-right tabular-nums text-[#6e6e73]">{r.images}</span>
                          <span className={`w-12 text-right tabular-nums ${r.failed ? "text-[#d70015]" : "text-[#aeaeb2]"}`}>{r.failed}</span>
                          <span className="w-20 text-right tabular-nums text-[#1d1d1f]">¥{r.cost.toFixed(2)}</span>
                          <span className="w-40 truncate pl-4 text-[12px] text-[#6e6e73]">{top.map(([m, n]) => `${modelName(m)} ${n}`).join(" · ") || "—"}</span>
                          <span className="w-24 text-right tabular-nums text-[12px] text-[#86868b]">{when(r.last)}</span>
                          <span className="w-14 text-right">
                            {!r.owner && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); act({ action: r.disabled ? "enable" : "disable", name: r.name }); }}
                                className={`rounded-full px-2 py-0.5 text-[11px] ${r.disabled ? "text-[#0071e3] hover:bg-[#0071e3]/10" : "text-[#d70015] hover:bg-[#d70015]/10"}`}
                              >
                                {r.disabled ? "恢复" : "停用"}
                              </button>
                            )}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
              <div className="mt-2 px-3 text-[11px] text-[#aeaeb2]">点一个账号，看他画过的每一张图。停用后他还能看自己的图，但不能再生成。</div>
            </>
          ) : (
            <>
              {user && (
                <div className="mb-3 grid grid-cols-3 gap-2">
                  <div className={card}><div className="text-[11px] text-[#86868b]">图片</div><div className="text-[18px] font-semibold tabular-nums">{user.images}</div></div>
                  <div className={card}><div className="text-[11px] text-[#86868b]">失败</div><div className="text-[18px] font-semibold tabular-nums">{user.failed}</div></div>
                  <div className={card}><div className="text-[11px] text-[#86868b]">花费</div><div className="text-[18px] font-semibold tabular-nums">¥{user.cost.toFixed(2)}</div></div>
                </div>
              )}
              {items === null ? (
                <div className="py-10 text-center text-[12px] text-[#aeaeb2]">读取中…</div>
              ) : items.length === 0 ? (
                <div className="py-10 text-center text-[12px] text-[#aeaeb2]">还没有生图记录</div>
              ) : (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {items.map((it) => (
                    <button key={it.id} type="button" onClick={() => setOpen(it)} className="group overflow-hidden rounded-xl bg-[#f5f5f7] text-left ring-1 ring-black/[0.05]">
                      <span className="relative block aspect-square">
                        {it.url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={it.url.startsWith("/api/img/") ? `${it.url}?w=320` : it.url} alt="" loading="lazy" className="h-full w-full object-cover transition group-hover:scale-[1.03]" />
                        ) : (
                          <span className="flex h-full w-full items-center justify-center text-[11px] text-[#d70015]">{it.status === "pending" ? "生成中" : "失败"}</span>
                        )}
                      </span>
                      <span className="block px-2 py-1.5">
                        <span className="block truncate text-[11px] text-[#1d1d1f]">{it.prompt || "（没写描述）"}</span>
                        <span className="block truncate text-[10px] text-[#86868b]">{modelName(it.model)} · {when(it.createdAt)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && setOpen(null)}>
          <div className="animate-pop-in flex max-h-[90vh] w-full max-w-[760px] flex-col overflow-hidden rounded-[20px] bg-white sm:flex-row">
            <div className="flex min-h-0 flex-1 items-center justify-center bg-[#f5f5f7]">
              {open.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={open.url} alt="" className="max-h-[70vh] max-w-full object-contain" />
              ) : (
                <div className="p-10 text-[13px] text-[#d70015]">{open.error || "生成失败"}</div>
              )}
            </div>
            <div className="w-full shrink-0 space-y-2 p-4 text-[12px] text-[#6e6e73] sm:w-[240px]">
              <div className="text-[14px] font-semibold text-[#1d1d1f]">{modelName(open.model)}</div>
              <div>{open.mode === "i2i" ? "图生图" : "文生图"} · {when(open.createdAt)}</div>
              <div>{[secs(open.durationMs) && `用时 ${secs(open.durationMs)}`, open.cost && `¥${open.cost}`].filter(Boolean).join(" · ")}</div>
              <div className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap rounded-xl bg-[#f5f5f7] p-2.5 text-[12px] leading-relaxed text-[#1d1d1f]">{open.prompt || "（没写描述）"}</div>
              <button type="button" onClick={() => setOpen(null)} className="w-full rounded-full bg-black/[0.05] py-1.5 text-[12px] text-[#1d1d1f] hover:bg-black/[0.09]">关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
