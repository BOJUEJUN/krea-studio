"use client";

import { useState } from "react";

/** 2026-11-05 (用户: 不用真登录): just a name, so each person's pictures stay in their own history. */
export function LoginView({ onDone }: { onDone: (user: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enter", name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data?.ok) throw new Error(data?.error || "进入失败");
      onDone(data.user);
    } catch (err: any) {
      setError(err?.message || "进入失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#f5f5f7] px-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(800px 400px at 50% 0%, rgba(0,113,227,0.08), transparent 60%)" }}
      />
      <form onSubmit={submit} className="animate-pop-in relative w-full max-w-[340px] rounded-[24px] bg-white p-6 shadow-[0_24px_70px_rgba(0,0,0,0.12)] ring-1 ring-black/[0.05]">
        <div className="mb-1 text-[22px] font-semibold tracking-[-0.02em] text-[#1d1d1f]">AI Studio</div>
        <div className="mb-5 text-[13px] text-[#86868b]">起个名字，你画的图会存在这个名字下</div>
        <input
          autoFocus
          className="w-full rounded-xl border border-black/[0.08] bg-[#f5f5f7] px-3.5 py-2.5 text-[14px] text-[#1d1d1f] outline-none transition focus:border-[rgba(0,113,227,0.45)] focus:bg-white focus:ring-4 focus:ring-[rgba(0,113,227,0.12)]"
          placeholder="你的名字"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {error && <div className="mt-3 rounded-xl bg-[#fff1f0] px-3 py-2 text-[12px] text-[#d70015]">{error}</div>}
        <button type="submit" disabled={busy || !name.trim()} className="apple-btn-primary mt-4 flex w-full items-center justify-center py-3 text-[15px]">
          {busy ? "请稍候…" : "进入"}
        </button>
      </form>
    </div>
  );
}
