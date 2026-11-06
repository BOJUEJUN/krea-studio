"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MODELS, findModel } from "@/lib/models";

/**
 * enzoban.com/admin — the owner's back office as a real page (2026-11-05 用户: 管理要是一个正常的页面，多功能的).
 * 概览: spend, pictures, success rate, 30-day chart, models. 用户: every account, its numbers, stop / restore.
 * 生图记录: every picture from everyone, filtered by account, model, state, time and words. 设置: invite code.
 */

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
type Summary = {
  today: number;
  week: number;
  month: number;
  total: number;
  todayImages: number;
  failed: number;
  images: number;
  successRate: number;
  avgMs: number;
  users: number;
};
type Day = { day: string; cost: number; images: number; failed: number };
type ModelStat = { model: string; images: number; failed: number; cost: number; avgMs: number };
type Rec = {
  id: string;
  owner: string;
  url: string;
  refUrl?: string;
  prompt: string;
  model: string;
  mode: "t2i" | "i2i";
  status: string;
  error?: string;
  cost?: string | null;
  durationMs?: number;
  seed?: number;
  fav: boolean;
  createdAt: number;
};
type Data = { invite: string; summary: Summary; users: Row[]; daily: Day[]; models: ModelStat[]; records: Rec[] };
type Tab = "overview" | "users" | "records" | "settings";

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "overview", label: "概览", icon: "M3 13h4v8H3zM10 8h4v13h-4zM17 3h4v18h-4z" },
  { key: "users", label: "用户", icon: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-8 9a8 8 0 0 1 16 0" },
  { key: "records", label: "生图记录", icon: "M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4" },
  { key: "settings", label: "设置", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" },
];

const modelName = (id: string) => findModel(id)?.name ?? (id || "其他");
const modelIcon = (id: string) => {
  const m = findModel(id);
  return m ? m.cover.replace("/models/", "/models/icon/") + "?v=2" : null;
};
const thumb = (url: string, w: number) => (url.startsWith("/api/img/") ? `${url}?w=${w}` : url);
const yuan = (n: number) => `¥${n.toFixed(2)}`;
const when = (t: number) =>
  t ? new Date(t).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const date = (t: number) => (t ? new Date(t).toLocaleDateString("zh-CN") : "—");
const secs = (ms?: number) => (ms ? (ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`) : "—");

function Icon({ d, className = "h-[18px] w-[18px]" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={d} />
    </svg>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl bg-white px-4 py-3.5 ring-1 ring-black/[0.05]">
      <div className="text-[12px] text-[#86868b]">{label}</div>
      <div className="mt-1 text-[24px] font-semibold tabular-nums tracking-tight text-[#1d1d1f]">{value}</div>
      {sub && <div className="mt-0.5 text-[12px] text-[#86868b]">{sub}</div>}
    </div>
  );
}

function Card({ title, right, children, className = "" }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl bg-white p-4 ring-1 ring-black/[0.05] ${className}`}>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-[14px] font-semibold text-[#1d1d1f]">{title}</h2>
        <div className="ml-auto">{right}</div>
      </div>
      {children}
    </section>
  );
}

/** Daily spend, one bar per day (single series: no legend; hover shows the day). */
function DailyChart({ days, metric }: { days: Day[]; metric: "cost" | "images" }) {
  const [hover, setHover] = useState<number | null>(null);
  const val = (d: Day) => (metric === "cost" ? d.cost : d.images);
  const max = Math.max(...days.map(val), metric === "cost" ? 0.5 : 2);
  const top = metric === "cost" ? Math.ceil(max * 2) / 2 : Math.ceil(max);
  const h = 180;
  const d = hover != null ? days[hover] : null;
  return (
    <div className="relative">
      <div className="flex">
        <div className="flex w-10 shrink-0 flex-col justify-between pr-2 text-right text-[10px] tabular-nums text-[#aeaeb2]" style={{ height: h }}>
          <span>{metric === "cost" ? `¥${top}` : top}</span>
          <span>{metric === "cost" ? `¥${top / 2}` : Math.round(top / 2)}</span>
          <span>0</span>
        </div>
        <div className="relative min-w-0 flex-1" style={{ height: h }} onMouseLeave={() => setHover(null)}>
          {[0, 0.5, 1].map((f) => (
            <div key={f} className="absolute inset-x-0 border-t border-black/[0.05]" style={{ top: `${f * 100}%` }} />
          ))}
          <div className="absolute inset-0 flex items-end gap-[2px]">
            {days.map((x, i) => (
              <div key={x.day} className="flex h-full min-w-0 flex-1 cursor-default items-end" onMouseEnter={() => setHover(i)}>
                <div
                  className={`w-full rounded-t-[4px] transition-colors ${hover === i ? "bg-[#0058b0]" : "bg-[#0071e3]"}`}
                  style={{ height: `${(val(x) / top) * 100}%`, minHeight: val(x) > 0 ? 2 : 0 }}
                />
              </div>
            ))}
          </div>
          {d && hover != null && (
            <div
              className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-xl bg-[#1d1d1f] px-2.5 py-1.5 text-[11px] text-white shadow-lg"
              style={{ left: `${((hover + 0.5) / days.length) * 100}%` }}
            >
              <div className="font-semibold">{d.day.slice(5).replace("-", "月")}日</div>
              <div className="tabular-nums">花费 {yuan(d.cost)} · {d.images} 张{d.failed ? ` · 失败 ${d.failed}` : ""}</div>
            </div>
          )}
        </div>
      </div>
      <div className="ml-10 mt-1.5 flex justify-between text-[10px] tabular-nums text-[#aeaeb2]">
        <span>{days[0]?.day.slice(5)}</span>
        <span>{days[Math.floor(days.length / 2)]?.day.slice(5)}</span>
        <span>今天</span>
      </div>
    </div>
  );
}

function Seg<T extends string>({ value, options, onPick }: { value: T; options: [T, string][]; onPick: (v: T) => void }) {
  return (
    <div className="flex rounded-full bg-[#f2f2f4] p-0.5">
      {options.map(([k, l]) => (
        <button
          key={k}
          type="button"
          onClick={() => onPick(k)}
          className={`rounded-full px-2.5 py-1 text-[12px] transition ${value === k ? "bg-white text-[#1d1d1f] shadow-sm" : "text-[#6e6e73] hover:text-[#1d1d1f]"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

const select = "rounded-full bg-[#f2f2f4] px-3 py-1.5 text-[12px] text-[#1d1d1f] outline-none focus:ring-2 focus:ring-[#0071e3]/30";

export default function AdminPage() {
  const [state, setState] = useState<"checking" | "ok" | "no">("checking");
  const [me, setMe] = useState("");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [toast, setToast] = useState<string | null>(null);
  const [open, setOpen] = useState<Rec | null>(null);
  // Records filters
  const [fUser, setFUser] = useState("all");
  const [fModel, setFModel] = useState("all");
  const [fStatus, setFStatus] = useState<"all" | "done" | "failed" | "fav">("all");
  const [fTime, setFTime] = useState<"all" | "today" | "7" | "30">("all");
  const [fText, setFText] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [limit, setLimit] = useState(60);
  const [metric, setMetric] = useState<"cost" | "images">("cost");
  const [userQuery, setUserQuery] = useState("");
  const [inviteDraft, setInviteDraft] = useState("");

  const flash = (t: string) => {
    setToast(t);
    window.setTimeout(() => setToast((x) => (x === t ? null : x)), 2200);
  };

  const load = useCallback(async () => {
    const res = await fetch("/api/admin", { cache: "no-store" });
    const d = await res.json().catch(() => ({}));
    if (!d?.ok) return setError(d?.error || "读取失败");
    setError(null);
    setData(d);
  }, []);

  useEffect(() => {
    fetch("/api/auth", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setMe(d?.user || "");
        setState(d?.owner ? "ok" : "no");
        if (d?.owner) load();
      })
      .catch(() => setState("no"));
    const h = window.location.hash.slice(1) as Tab;
    if (TABS.some((t) => t.key === h)) setTab(h);
  }, [load]);

  const go = (t: Tab) => {
    setTab(t);
    history.replaceState(null, "", `#${t}`);
    window.scrollTo({ top: 0 });
  };

  const act = async (body: Record<string, string>, done?: string) => {
    const res = await fetch("/api/admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    if (!d?.ok) return flash(d?.error || "操作失败");
    if (done) flash(done);
    load();
  };

  const showUser = (name: string) => {
    setFUser(name);
    setFModel("all");
    setFStatus("all");
    setFTime("all");
    setFText("");
    setLimit(60);
    go("records");
  };

  const records = useMemo(() => {
    if (!data) return [];
    const now = Date.now();
    const dayStart = new Date(new Date().toDateString()).getTime();
    const q = fText.trim().toLowerCase();
    return data.records.filter(
      (r) =>
        (fUser === "all" || r.owner === fUser) &&
        (fModel === "all" || r.model === fModel) &&
        (fStatus === "all" || (fStatus === "done" ? !!r.url : fStatus === "fav" ? r.fav : !r.url && r.status !== "pending")) &&
        (fTime === "all" || (fTime === "today" ? r.createdAt >= dayStart : r.createdAt >= now - Number(fTime) * 86_400_000)) &&
        (!q || r.prompt.toLowerCase().includes(q))
    );
  }, [data, fUser, fModel, fStatus, fTime, fText]);
  const recCost = records.reduce((s, r) => s + (Number(r.cost) || 0), 0);

  const exportCsv = () => {
    const head = ["时间", "账号", "模型", "方式", "状态", "花费", "用时(秒)", "提示词", "图片"];
    const rows = records.map((r) => [
      new Date(r.createdAt).toLocaleString("zh-CN"),
      r.owner,
      modelName(r.model),
      r.mode === "i2i" ? "图生图" : "文生图",
      r.url ? "成功" : r.status === "pending" ? "生成中" : "失败",
      r.cost ?? "",
      r.durationMs ? Math.round(r.durationMs / 1000) : "",
      r.prompt,
      r.url ? location.origin + r.url : "",
    ]);
    const csv = "﻿" + [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `生图记录-${new Date().toLocaleDateString("en-CA")}.csv`;
    a.click();
  };

  if (state === "checking") return <div className="flex h-[100dvh] items-center justify-center bg-[#f5f5f7] text-[13px] text-[#86868b]">读取中…</div>;
  if (state === "no")
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 bg-[#f5f5f7] text-[14px] text-[#1d1d1f]">
        只有管理员账号能看
        <a href="/" className="rounded-full bg-[#0071e3] px-4 py-1.5 text-[13px] text-white">回到首页</a>
      </div>
    );

  const s = data?.summary;
  const users = (data?.users ?? []).filter((u) => !userQuery.trim() || u.name.toLowerCase().includes(userQuery.trim().toLowerCase()));
  const topModel = data?.models.reduce((m, x) => Math.max(m, x.cost), 0) || 1;

  return (
    <div className="min-h-[100dvh] bg-[#f5f5f7] text-[#1d1d1f]">
      {/* Side bar (desktop) / top bar (phone) */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[220px] flex-col border-r border-black/[0.06] bg-white/80 px-3 py-4 backdrop-blur-xl lg:flex">
        <div className="px-2 pb-5">
          <div className="text-[17px] font-semibold tracking-tight">AI Studio</div>
          <div className="text-[12px] text-[#86868b]">管理后台</div>
        </div>
        <nav className="flex flex-col gap-0.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => go(t.key)}
              className={`flex items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[14px] transition ${tab === t.key ? "bg-[#0071e3]/10 font-medium text-[#0071e3]" : "text-[#3a3a3c] hover:bg-black/[0.04]"}`}
            >
              <Icon d={t.icon} />
              {t.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto space-y-1 px-1">
          <a href="/" className="flex items-center gap-2 rounded-xl px-2 py-2 text-[13px] text-[#0071e3] hover:bg-[#0071e3]/10">‹ 回到画图</a>
          <div className="px-2 text-[11px] text-[#aeaeb2]">已登录：{me}</div>
        </div>
      </aside>
      <header className="sticky top-0 z-30 border-b border-black/[0.06] bg-white/85 backdrop-blur-xl lg:hidden">
        <div className="flex items-center px-4 pt-3">
          <div className="text-[16px] font-semibold">管理后台</div>
          <a href="/" className="ml-auto text-[13px] text-[#0071e3]">回到画图</a>
        </div>
        <div className="flex gap-1 overflow-x-auto px-3 py-2">
          {TABS.map((t) => (
            <button key={t.key} type="button" onClick={() => go(t.key)} className={`shrink-0 rounded-full px-3 py-1 text-[13px] ${tab === t.key ? "bg-[#0071e3] text-white" : "bg-black/[0.05] text-[#3a3a3c]"}`}>
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <main className="px-4 py-5 lg:ml-[220px] lg:px-8 lg:py-7">
        <div className="mx-auto max-w-[1200px]">
          <div className="mb-5 hidden items-center lg:flex">
            <h1 className="text-[24px] font-semibold tracking-tight">{TABS.find((t) => t.key === tab)?.label}</h1>
            <button type="button" onClick={() => { load(); flash("已刷新"); }} className="ml-auto rounded-full bg-white px-3 py-1.5 text-[12px] text-[#3a3a3c] ring-1 ring-black/[0.06] hover:bg-black/[0.03]">
              刷新
            </button>
          </div>
          {error && <div className="mb-4 rounded-xl bg-[#fff1f0] px-3 py-2 text-[13px] text-[#d70015]">{error}</div>}
          {!data ? (
            <div className="py-20 text-center text-[13px] text-[#aeaeb2]">读取中…</div>
          ) : tab === "overview" ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="今天花费" value={yuan(s!.today)} sub={`${s!.todayImages} 张`} />
                <Stat label="近 7 天" value={yuan(s!.week)} />
                <Stat label="近 30 天" value={yuan(s!.month)} />
                <Stat label="总花费" value={yuan(s!.total)} sub={`${s!.images} 张`} />
                <Stat label="账号" value={String(s!.users)} />
                <Stat label="成功率" value={`${Math.round(s!.successRate * 100)}%`} sub={`失败 ${s!.failed} 次`} />
                <Stat label="平均用时" value={secs(s!.avgMs)} />
                <Stat label="平均每张" value={yuan(s!.images ? s!.total / s!.images : 0)} />
              </div>
              <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
                <Card title="近 30 天" right={<Seg value={metric} options={[["cost", "花费"], ["images", "张数"]]} onPick={setMetric} />}>
                  <DailyChart days={data.daily} metric={metric} />
                </Card>
                <Card title="各模型花费">
                  <div className="space-y-2.5">
                    {data.models.slice(0, 8).map((m) => {
                      const icon = modelIcon(m.model);
                      return (
                        <button key={m.model} type="button" onClick={() => { setFModel(m.model); setFUser("all"); setFStatus("all"); setFTime("all"); go("records"); }} className="block w-full text-left">
                          <div className="flex items-center gap-2 text-[12px]">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            {icon ? <img src={icon} alt="" className="h-5 w-5 rounded-md" /> : <span className="h-5 w-5 rounded-md bg-[#f2f2f4]" />}
                            <span className="min-w-0 flex-1 truncate">{modelName(m.model)}</span>
                            <span className="tabular-nums text-[#86868b]">{m.images} 张</span>
                            <span className="w-16 text-right tabular-nums">{yuan(m.cost)}</span>
                          </div>
                          <div className="ml-7 mt-1 h-[6px] rounded-full bg-[#f2f2f4]">
                            <div className="h-full rounded-full bg-[#0071e3]" style={{ width: `${Math.max(2, (m.cost / topModel) * 100)}%` }} />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </Card>
              </div>
              <div className="grid gap-4 xl:grid-cols-[1fr_1.6fr]">
                <Card title="最活跃的账号" right={<button type="button" onClick={() => go("users")} className="text-[12px] text-[#0071e3]">全部 ›</button>}>
                  <div className="divide-y divide-black/[0.05]">
                    {data.users.slice(0, 6).map((u) => (
                      <button key={u.name} type="button" onClick={() => showUser(u.name)} className="flex w-full items-center gap-3 py-2 text-left text-[13px] hover:opacity-80">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#0071e3]/10 text-[13px] font-semibold text-[#0071e3]">{u.name.slice(0, 1).toUpperCase()}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{u.name}</span>
                          <span className="block text-[11px] text-[#86868b]">最近 {when(u.last)}</span>
                        </span>
                        <span className="tabular-nums text-[#86868b]">{u.images} 张</span>
                        <span className="w-16 text-right tabular-nums">{yuan(u.cost)}</span>
                      </button>
                    ))}
                  </div>
                </Card>
                <Card title="最新生成" right={<button type="button" onClick={() => { setFUser("all"); setFModel("all"); setFStatus("all"); setFTime("all"); go("records"); }} className="text-[12px] text-[#0071e3]">全部 ›</button>}>
                  <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                    {data.records.filter((r) => r.url).slice(0, 12).map((r) => (
                      <button key={r.id} type="button" onClick={() => setOpen(r)} className="overflow-hidden rounded-xl bg-[#f2f2f4]">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={thumb(r.url, 160)} alt="" loading="lazy" className="aspect-square w-full object-cover transition hover:scale-[1.04]" />
                      </button>
                    ))}
                  </div>
                </Card>
              </div>
            </div>
          ) : tab === "users" ? (
            <Card
              title={`全部账号 · ${data.users.length}`}
              right={<input value={userQuery} onChange={(e) => setUserQuery(e.target.value)} placeholder="搜索账号" className={`${select} w-40`} />}
            >
              <div className="-mx-4 overflow-x-auto">
                <table className="w-full min-w-[820px] text-[13px]">
                  <thead>
                    <tr className="text-left text-[11px] text-[#86868b]">
                      <th className="px-4 py-2 font-normal">账号</th>
                      <th className="px-2 py-2 font-normal">加入</th>
                      <th className="px-2 py-2 text-right font-normal">图片</th>
                      <th className="px-2 py-2 text-right font-normal">失败</th>
                      <th className="px-2 py-2 text-right font-normal">花费</th>
                      <th className="px-2 py-2 font-normal">常用模型</th>
                      <th className="px-2 py-2 font-normal">最近</th>
                      <th className="px-4 py-2 text-right font-normal">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-black/[0.05]">
                    {users.map((u) => {
                      const top = Object.entries(u.models).sort((a, b) => b[1] - a[1]).slice(0, 2);
                      return (
                        <tr key={u.name} className={`hover:bg-black/[0.02] ${u.disabled ? "opacity-50" : ""}`}>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2">
                              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#0071e3]/10 text-[12px] font-semibold text-[#0071e3]">{u.name.slice(0, 1).toUpperCase()}</span>
                              <span className="truncate">{u.name}</span>
                              {u.owner && <span className="rounded-full bg-[#0071e3]/10 px-1.5 py-px text-[10px] text-[#0071e3]">管理员</span>}
                              {u.disabled && <span className="rounded-full bg-[#d70015]/10 px-1.5 py-px text-[10px] text-[#d70015]">已停用</span>}
                            </div>
                          </td>
                          <td className="px-2 py-2.5 text-[12px] text-[#86868b]">{date(u.createdAt)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{u.images}</td>
                          <td className={`px-2 py-2.5 text-right tabular-nums ${u.failed ? "text-[#d70015]" : "text-[#aeaeb2]"}`}>{u.failed}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{yuan(u.cost)}</td>
                          <td className="max-w-[200px] truncate px-2 py-2.5 text-[12px] text-[#6e6e73]">{top.map(([m, n]) => `${modelName(m)} ${n}`).join(" · ") || "—"}</td>
                          <td className="px-2 py-2.5 text-[12px] tabular-nums text-[#86868b]">{when(u.last)}</td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-right">
                            <button type="button" onClick={() => showUser(u.name)} className="rounded-full px-2 py-1 text-[12px] text-[#0071e3] hover:bg-[#0071e3]/10">看记录</button>
                            {!u.owner && (
                              <button
                                type="button"
                                onClick={() => {
                                  if (u.disabled || confirm(`停用 ${u.name}？停用后他不能再生成图片，但还能看自己的图。`)) act({ action: u.disabled ? "enable" : "disable", name: u.name }, u.disabled ? "已恢复" : "已停用");
                                }}
                                className={`rounded-full px-2 py-1 text-[12px] ${u.disabled ? "text-[#0071e3] hover:bg-[#0071e3]/10" : "text-[#d70015] hover:bg-[#d70015]/10"}`}
                              >
                                {u.disabled ? "恢复" : "停用"}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : tab === "records" ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 ring-1 ring-black/[0.05]">
                <input value={fText} onChange={(e) => { setFText(e.target.value); setLimit(60); }} placeholder="搜索提示词" className={`${select} w-full sm:w-52`} />
                <select value={fUser} onChange={(e) => { setFUser(e.target.value); setLimit(60); }} className={select} aria-label="账号">
                  <option value="all">全部账号</option>
                  {data.users.map((u) => <option key={u.name} value={u.name}>{u.name}</option>)}
                </select>
                <select value={fModel} onChange={(e) => { setFModel(e.target.value); setLimit(60); }} className={select} aria-label="模型">
                  <option value="all">全部模型</option>
                  {[...new Set([...MODELS.map((m) => m.id as string), ...data.models.map((m) => m.model)])].map((id) => <option key={id} value={id}>{modelName(id)}</option>)}
                </select>
                <Seg value={fStatus} options={[["all", "全部"], ["done", "成功"], ["failed", "失败"], ["fav", "收藏"]]} onPick={(v) => { setFStatus(v); setLimit(60); }} />
                <Seg value={fTime} options={[["all", "全部时间"], ["today", "今天"], ["7", "7 天"], ["30", "30 天"]]} onPick={(v) => { setFTime(v); setLimit(60); }} />
                <div className="ml-auto flex items-center gap-2">
                  <Seg value={view} options={[["grid", "图"], ["list", "表"]]} onPick={setView} />
                  <button type="button" onClick={exportCsv} className="rounded-full bg-[#f2f2f4] px-3 py-1.5 text-[12px] text-[#1d1d1f] hover:bg-black/[0.08]">导出表格</button>
                </div>
              </div>
              <div className="px-1 text-[12px] text-[#86868b]">
                共 {records.length} 条 · 花费 {yuan(recCost)}
                {(fUser !== "all" || fModel !== "all" || fStatus !== "all" || fTime !== "all" || fText) && (
                  <button type="button" onClick={() => { setFUser("all"); setFModel("all"); setFStatus("all"); setFTime("all"); setFText(""); }} className="ml-2 text-[#0071e3]">清除筛选</button>
                )}
              </div>
              {records.length === 0 ? (
                <div className="rounded-2xl bg-white py-16 text-center text-[13px] text-[#aeaeb2] ring-1 ring-black/[0.05]">没有符合条件的记录</div>
              ) : view === "grid" ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
                  {records.slice(0, limit).map((r) => (
                    <button key={r.id} type="button" onClick={() => setOpen(r)} className="group overflow-hidden rounded-2xl bg-white text-left ring-1 ring-black/[0.05] transition hover:shadow-[0_8px_24px_rgba(0,0,0,0.08)]">
                      <span className="relative block aspect-square bg-[#f2f2f4]">
                        {r.url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={thumb(r.url, 320)} alt="" loading="lazy" className="h-full w-full object-cover transition group-hover:scale-[1.03]" />
                        ) : (
                          <span className="flex h-full flex-col items-center justify-center gap-1 px-3 text-center">
                            <span className={`text-[12px] font-semibold ${r.status === "pending" ? "text-[#0071e3]" : "text-[#d70015]"}`}>{r.status === "pending" ? "生成中" : "失败"}</span>
                            <span className="line-clamp-3 text-[10px] text-[#86868b]">{r.error}</span>
                          </span>
                        )}
                        {r.fav && <span className="absolute right-1.5 top-1.5 rounded-full bg-black/35 px-1.5 text-[11px] text-[#ffcc00]">★</span>}
                      </span>
                      <span className="block px-2.5 py-2">
                        <span className="block truncate text-[12px]">{r.prompt || "（没写描述）"}</span>
                        <span className="mt-0.5 flex items-center gap-1 text-[11px] text-[#86868b]">
                          <span className="truncate">{r.owner}</span>
                          <span>·</span>
                          <span className="truncate">{modelName(r.model)}</span>
                          <span className="ml-auto shrink-0 tabular-nums">{r.cost ? `¥${r.cost}` : ""}</span>
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-black/[0.05]">
                  <table className="w-full min-w-[900px] text-[12px]">
                    <thead>
                      <tr className="text-left text-[11px] text-[#86868b]">
                        <th className="px-3 py-2 font-normal">图</th>
                        <th className="px-2 py-2 font-normal">时间</th>
                        <th className="px-2 py-2 font-normal">账号</th>
                        <th className="px-2 py-2 font-normal">模型</th>
                        <th className="px-2 py-2 font-normal">提示词</th>
                        <th className="px-2 py-2 text-right font-normal">用时</th>
                        <th className="px-3 py-2 text-right font-normal">花费</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-black/[0.05]">
                      {records.slice(0, limit).map((r) => (
                        <tr key={r.id} onClick={() => setOpen(r)} className="cursor-pointer hover:bg-black/[0.02]">
                          <td className="px-3 py-1.5">
                            {r.url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={thumb(r.url, 160)} alt="" loading="lazy" className="h-10 w-10 rounded-lg object-cover" />
                            ) : (
                              <span className={`flex h-10 w-10 items-center justify-center rounded-lg bg-[#f2f2f4] text-[10px] ${r.status === "pending" ? "text-[#0071e3]" : "text-[#d70015]"}`}>{r.status === "pending" ? "生成中" : "失败"}</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-2 tabular-nums text-[#86868b]">{when(r.createdAt)}</td>
                          <td className="px-2">{r.owner}</td>
                          <td className="whitespace-nowrap px-2">{modelName(r.model)}</td>
                          <td className="max-w-[360px] truncate px-2 text-[#3a3a3c]">{r.prompt}</td>
                          <td className="whitespace-nowrap px-2 text-right tabular-nums text-[#86868b]">{secs(r.durationMs)}</td>
                          <td className="px-3 text-right tabular-nums">{r.cost ? `¥${r.cost}` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {records.length > limit && (
                <div className="text-center">
                  <button type="button" onClick={() => setLimit((n) => n + 60)} className="rounded-full bg-white px-4 py-1.5 text-[13px] text-[#0071e3] ring-1 ring-black/[0.06]">
                    再看 60 条（还有 {records.length - limit}）
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="邀请码">
                <p className="mb-3 text-[12px] text-[#86868b]">新朋友第一次进网站要填这个码。换了以后，已经进来的人不受影响。</p>
                <div className="flex items-center gap-2">
                  <span className="rounded-xl bg-[#f2f2f4] px-3 py-2 font-mono text-[18px] tracking-[0.15em]">{data.invite || "—"}</span>
                  <button type="button" onClick={() => { navigator.clipboard?.writeText(data.invite); flash("已复制"); }} className="rounded-full px-3 py-1.5 text-[12px] text-[#0071e3] hover:bg-[#0071e3]/10">复制</button>
                  <button type="button" onClick={() => confirm("换一个随机邀请码？") && act({ action: "invite" }, "已换新邀请码")} className="rounded-full px-3 py-1.5 text-[12px] text-[#0071e3] hover:bg-[#0071e3]/10">随机换一个</button>
                </div>
                <div className="mt-3 flex gap-2">
                  <input value={inviteDraft} onChange={(e) => setInviteDraft(e.target.value)} placeholder="自己设一个，例如 nikizhao" className={`${select} min-w-0 flex-1`} />
                  <button
                    type="button"
                    disabled={!inviteDraft.trim()}
                    onClick={() => act({ action: "setInvite", code: inviteDraft.trim() }, "邀请码已更新").then(() => setInviteDraft(""))}
                    className="rounded-full bg-[#0071e3] px-4 py-1.5 text-[12px] text-white disabled:opacity-40"
                  >
                    保存
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-[#aeaeb2]">不分大小写。</p>
              </Card>
              <Card title="说明">
                <ul className="space-y-2 text-[13px] text-[#3a3a3c]">
                  <li>· 花费里，RunningHub 工作流是真实扣费；GPT、Banana、Krea 是按官方价估算的。</li>
                  <li>· 停用的账号还能看自己的图，但不能再生成。</li>
                  <li>· 生图记录最多显示最近 1500 条，可以导出成表格。</li>
                </ul>
              </Card>
            </div>
          )}
        </div>
      </main>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-3 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && setOpen(null)}>
          <div className="flex max-h-[92vh] w-full max-w-[1000px] flex-col overflow-hidden rounded-[22px] bg-white md:flex-row">
            <div className="flex min-h-[240px] min-w-0 flex-1 items-center justify-center bg-[#f2f2f4]">
              {open.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumb(open.url, 1600)} alt="" className="max-h-[80vh] max-w-full object-contain" />
              ) : (
                <div className="p-10 text-center text-[13px] text-[#d70015]">{open.status === "pending" ? "还在生成" : open.error || "生成失败"}</div>
              )}
            </div>
            <div className="w-full shrink-0 overflow-y-auto p-5 text-[13px] md:w-[300px]">
              <div className="flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {modelIcon(open.model) && <img src={modelIcon(open.model)!} alt="" className="h-7 w-7 rounded-lg" />}
                <div className="text-[15px] font-semibold">{modelName(open.model)}</div>
                <button type="button" onClick={() => setOpen(null)} className="ml-auto rounded-full px-2 py-0.5 text-[12px] text-[#6e6e73] hover:bg-black/[0.05]">关闭</button>
              </div>
              <dl className="mt-4 grid grid-cols-[64px_1fr] gap-y-1.5 text-[12px]">
                <dt className="text-[#86868b]">账号</dt>
                <dd><button type="button" onClick={() => { setOpen(null); showUser(open.owner); }} className="text-[#0071e3]">{open.owner}</button></dd>
                <dt className="text-[#86868b]">时间</dt>
                <dd className="tabular-nums">{new Date(open.createdAt).toLocaleString("zh-CN")}</dd>
                <dt className="text-[#86868b]">方式</dt>
                <dd>{open.mode === "i2i" ? "图生图" : "文生图"}</dd>
                <dt className="text-[#86868b]">用时</dt>
                <dd className="tabular-nums">{secs(open.durationMs)}</dd>
                <dt className="text-[#86868b]">花费</dt>
                <dd className="tabular-nums">{open.cost ? `¥${open.cost}` : "—"}</dd>
                {open.seed != null && (
                  <>
                    <dt className="text-[#86868b]">种子</dt>
                    <dd className="tabular-nums">{open.seed}</dd>
                  </>
                )}
              </dl>
              {open.refUrl && (
                <div className="mt-4">
                  <div className="mb-1 text-[12px] text-[#86868b]">参考图</div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={open.refUrl} alt="" className="max-h-32 rounded-xl" />
                </div>
              )}
              <div className="mt-4 mb-1 text-[12px] text-[#86868b]">提示词</div>
              <div className="max-h-[30vh] overflow-y-auto whitespace-pre-wrap rounded-xl bg-[#f5f5f7] p-3 text-[12px] leading-relaxed">{open.prompt || "（没写描述）"}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={() => { navigator.clipboard?.writeText(open.prompt); flash("已复制提示词"); }} className="rounded-full bg-[#f2f2f4] px-3 py-1.5 text-[12px] hover:bg-black/[0.08]">复制提示词</button>
                {open.url && (
                  <a href={open.url} download={`${open.owner}-${open.id}.png`} className="rounded-full bg-[#0071e3] px-3 py-1.5 text-[12px] text-white">下载</a>
                )}
                {open.url && (
                  <a href={open.url} target="_blank" rel="noreferrer" className="rounded-full bg-[#f2f2f4] px-3 py-1.5 text-[12px] hover:bg-black/[0.08]">看原图</a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-full bg-[#1d1d1f]/90 px-4 py-2 text-[13px] text-white shadow-lg">{toast}</div>
      )}
    </div>
  );
}
