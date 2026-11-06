"use client";

import { useEffect, useState } from "react";
import { AdminPanel } from "../admin-panel";

/** enzoban.com/admin — the owner's dashboard as its own page (accounts, pictures, spend, invite code). */
export default function AdminPage() {
  const [state, setState] = useState<"checking" | "ok" | "no">("checking");
  useEffect(() => {
    fetch("/api/auth", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setState(d?.owner ? "ok" : "no"))
      .catch(() => setState("no"));
  }, []);
  if (state === "checking") return <div className="flex h-[100dvh] items-center justify-center text-[13px] text-[#86868b]">读取中…</div>;
  if (state === "no")
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 text-[14px] text-[#1d1d1f]">
        只有管理员账号能看
        <a href="/" className="rounded-full bg-[#0071e3] px-4 py-1.5 text-[13px] text-white">回到首页</a>
      </div>
    );
  return <AdminPanel onClose={() => (window.location.href = "/")} />;
}
