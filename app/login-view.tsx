"use client";

import { useState } from "react";
import { MODELS } from "@/lib/models";

// Model covers (already public) drift behind the sign-in card as a soft collage.
const COVERS = MODELS.map((m) => m.cover).filter((c) => c.endsWith(".jpg"));


/** 2026-11-11 (用户: 账号密码邀请码系统): 登录 with 用户名 + 密码; 注册 (or first password for an old account) adds the invite code. */
export function LoginView({ onDone }: { onDone: (user: string) => void }) {
  const [tab, setTab] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
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
        body: JSON.stringify({ action: tab, name, password, invite: tab === "register" ? invite : "" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data?.ok) {
        if (data?.needInvite && tab === "login") setTab("register");
        throw new Error(data?.error || "登录失败");
      }
      onDone(data.user);
    } catch (err: any) {
      setError(err?.message || "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-page px-4">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="login-drift absolute -inset-[10%] grid grid-cols-3 gap-4 opacity-90 sm:grid-cols-5" style={{ transform: "rotate(-8deg)" }}>
          {Array.from({ length: 20 }, (_, i) => COVERS[i % COVERS.length]).map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={src} alt="" className="aspect-[3/4] w-full rounded-2xl object-cover" style={{ marginTop: i % 2 ? 40 : 0 }} />
          ))}
        </div>
        <div className="absolute inset-0 bg-panel/30 backdrop-blur-[6px]" />
        <div className="absolute inset-0" style={{ background: "radial-gradient(600px 360px at 50% 50%, color-mix(in srgb, var(--color-panel) 65%, transparent), transparent 70%)" }} />
      </div>
      <form onSubmit={submit} className="animate-pop-in relative w-full max-w-[340px] rounded-[24px] bg-panel/80 p-6 shadow-[0_24px_70px_rgba(0,0,0,0.16)] ring-1 ring-white/60 backdrop-blur-2xl">
        <div className="mb-1 text-[22px] font-semibold tracking-[-0.02em] text-ink">AI Studio</div>
        <div className="apple-seg mb-4 mt-3 flex">
          {([["login", "登录"], ["register", "注册"]] as const).map(([k, label]) => (
            <button key={k} type="button" data-active={tab === k} onClick={() => { setTab(k); setError(null); }} className="apple-seg-item flex-1 py-1.5 text-[13px] font-medium text-secondary">
              {label}
            </button>
          ))}
        </div>
        <input
          autoFocus
          className="w-full rounded-xl border border-edge/[0.08] bg-page px-3.5 py-2.5 text-[14px] text-ink outline-none transition focus:border-[rgba(0,113,227,0.45)] focus:bg-panel focus:ring-4 focus:ring-[rgba(0,113,227,0.12)]"
          placeholder="用户名"
          autoComplete="username"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="password"
          className="mt-2.5 w-full rounded-xl border border-edge/[0.08] bg-page px-3.5 py-2.5 text-[14px] text-ink outline-none transition focus:border-[rgba(0,113,227,0.45)] focus:bg-panel focus:ring-4 focus:ring-[rgba(0,113,227,0.12)]"
          placeholder={tab === "register" ? "设置密码（至少 6 位）" : "密码"}
          autoComplete={tab === "register" ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {tab === "register" && (
          <input
            className="mt-2.5 w-full rounded-xl border border-edge/[0.08] bg-page px-3.5 py-2.5 text-[14px] text-ink outline-none transition focus:border-[rgba(0,113,227,0.45)] focus:bg-panel focus:ring-4 focus:ring-[rgba(0,113,227,0.12)]"
            placeholder="邀请码"
            autoComplete="off"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
          />
        )}
        <div className="mt-2 text-[11px] leading-[16px] text-hint">
          {tab === "register" ? "新账号要邀请码。以前只用用户名进来的老账号，也在这里用邀请码设一次密码。" : "没有账号？点上面的「注册」"}
        </div>
        {error && <div className="mt-3 rounded-xl bg-[light-dark(#fff1f0,#382022)] px-3 py-2 text-[12px] text-danger">{error}</div>}
        <button type="submit" disabled={busy || !name.trim() || password.length < (tab === "register" ? 6 : 1) || (tab === "register" && !invite.trim())} className="apple-btn-primary mt-4 flex w-full items-center justify-center py-3 text-[15px]">
          {busy ? "请稍候…" : tab === "register" ? "注册并进入" : "登录"}
        </button>
      </form>
    </div>
  );
}
