"use client";

import { useState } from "react";
import { MODELS } from "@/lib/models";

// Model covers (already public) drift behind the sign-in card as a soft collage.
const COVERS = MODELS.map((m) => m.cover).filter((c) => c.endsWith(".jpg"));


/** 2026-11-05: a plain 账号 + 密码 sign-in; the first sign-in with a new 账号 creates it. */
export function LoginView({ onDone }: { onDone: (user: string) => void }) {
  const [name, setName] = useState("");
  const [invite, setInvite] = useState("");
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
        body: JSON.stringify({ action: "enter", name, invite }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data?.ok) throw new Error(data?.error || "登录失败");
      onDone(data.user);
    } catch (err: any) {
      setError(err?.message || "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#f5f5f7] px-4">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="login-drift absolute -inset-[10%] grid grid-cols-3 gap-4 opacity-90 sm:grid-cols-5" style={{ transform: "rotate(-8deg)" }}>
          {Array.from({ length: 20 }, (_, i) => COVERS[i % COVERS.length]).map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={src} alt="" className="aspect-[3/4] w-full rounded-2xl object-cover" style={{ marginTop: i % 2 ? 40 : 0 }} />
          ))}
        </div>
        <div className="absolute inset-0 bg-white/30 backdrop-blur-[6px]" />
        <div className="absolute inset-0" style={{ background: "radial-gradient(600px 360px at 50% 50%, rgba(255,255,255,0.65), transparent 70%)" }} />
      </div>
      <form onSubmit={submit} className="animate-pop-in relative w-full max-w-[340px] rounded-[24px] bg-white/80 p-6 shadow-[0_24px_70px_rgba(0,0,0,0.16)] ring-1 ring-white/60 backdrop-blur-2xl">
        <div className="mb-1 text-[22px] font-semibold tracking-[-0.02em] text-[#1d1d1f]">AI Studio</div>
        <div className="mb-5 text-[13px] text-[#86868b]">填用户名和邀请码进入</div>
        <input
          autoFocus
          className="w-full rounded-xl border border-black/[0.08] bg-[#f5f5f7] px-3.5 py-2.5 text-[14px] text-[#1d1d1f] outline-none transition focus:border-[rgba(0,113,227,0.45)] focus:bg-white focus:ring-4 focus:ring-[rgba(0,113,227,0.12)]"
          placeholder="用户名"
          autoComplete="username"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="mt-2.5 w-full rounded-xl border border-black/[0.08] bg-[#f5f5f7] px-3.5 py-2.5 text-[14px] uppercase tracking-[0.2em] text-[#1d1d1f] outline-none transition placeholder:normal-case placeholder:tracking-normal focus:border-[rgba(0,113,227,0.45)] focus:bg-white focus:ring-4 focus:ring-[rgba(0,113,227,0.12)]"
          placeholder="邀请码"
          value={invite}
          onChange={(e) => setInvite(e.target.value)}
        />
        <div className="mt-2 text-[11px] text-[#aeaeb2]">同一个用户名看到的是同一份历史</div>
        {error && <div className="mt-3 rounded-xl bg-[#fff1f0] px-3 py-2 text-[12px] text-[#d70015]">{error}</div>}
        <button type="submit" disabled={busy || !name.trim() || !invite.trim()} className="apple-btn-primary mt-4 flex w-full items-center justify-center py-3 text-[15px]">
          {busy ? "请稍候…" : "进入"}
        </button>
      </form>
    </div>
  );
}
