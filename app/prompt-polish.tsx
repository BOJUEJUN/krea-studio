"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PolishLevel } from "@/lib/deepseek";

const levels = [
  { value: "low", label: "低", detail: "理顺表达，保留原意" },
  { value: "medium", label: "中", detail: "重写描述，补足动作与画面细节" },
  { value: "high", label: "高", detail: "深入设计构图、光影与材质" },
] as const;

export function PromptPolish({ level, busy, canUndo, onRun, onLevel, onUndo, onOpen }: {
  level: PolishLevel; busy: boolean; canUndo: boolean; onRun: () => void;
  onLevel: (level: PolishLevel) => void; onUndo: () => void; onOpen?: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [anchor, setAnchor] = useState<React.CSSProperties | null>(null);
  const close = () => setAnchor(null);

  useEffect(() => {
    if (!anchor) return;
    menu.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !menu.current?.contains(target)) close();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
      trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    document.addEventListener("wheel", outside, { capture: true, passive: true });
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      document.removeEventListener("wheel", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", close);
    };
  }, [anchor]);

  function toggle() {
    if (anchor) { close(); return; }
    onOpen?.();
    const r = trigger.current!.getBoundingClientRect();
    const width = Math.min(235, window.innerWidth - 16);
    const above = r.top - 8, below = window.innerHeight - r.bottom - 8;
    const up = above >= 210 || above >= below;
    setAnchor({ width, left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)),
      maxHeight: Math.max(40, (up ? above : below) - 6),
      ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }) });
  }

  return <>
    <div data-prompt-polish="" className={`compose-split inline-flex h-8 shrink-0 items-center overflow-hidden whitespace-nowrap rounded-full text-[12px] ${busy ? "bg-accent/[0.08] text-accent ring-1 ring-accent/25" : "bg-edge/[0.05] text-ink"}`}>
      <button type="button" disabled={busy} onClick={onRun} title="按当前程度润色，保留 @图 编号"
        className="flex h-full items-center gap-1 hover:bg-edge/[0.08] disabled:opacity-60">
        {busy ? <span aria-hidden className="animate-spin-slow h-3 w-3 rounded-full border-[1.5px] border-accent/30 border-t-accent" /> :
          <svg aria-hidden width="14" height="14" className="text-accent" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l1.4 3.6L13 6 9.4 7.4 8 11 6.6 7.4 3 6l3.6-1.4L8 1zm4.5 8l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" /></svg>}
        {busy ? "润色中…" : "提示词润色"}
      </button>
      <button ref={trigger} type="button" aria-label="润色程度" aria-haspopup="dialog" aria-expanded={!!anchor} aria-controls={anchor ? menuId : undefined}
        onClick={toggle} className="flex h-full items-center gap-1 border-l border-edge/10 hover:bg-edge/[0.08] aria-expanded:text-accent">
        {levels.find((l) => l.value === level)?.label}
        <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="none" className={anchor ? "rotate-180" : ""}><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </button>
    </div>
    {canUndo && <button type="button" aria-label="撤销润色" title="撤销润色" disabled={busy} onClick={onUndo}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-secondary hover:bg-edge/[0.08] hover:text-ink">
      <svg aria-hidden width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 2-4 4 4 4M2 6h7a4 4 0 0 1 0 8H7" /></svg>
    </button>}
    {anchor && createPortal(<div id={menuId} ref={menu} role="dialog" aria-label="润色程度" data-setting-menu="polish"
      style={anchor} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      className="fixed z-[100] overflow-y-auto overscroll-contain rounded-2xl bg-panel p-1.5 text-ink shadow-[0_12px_36px_rgba(0,0,0,0.18)] ring-1 ring-edge/[0.08]">
      <div className="px-2.5 py-1 text-xs font-semibold text-secondary">润色程度</div>
      {levels.map((l) => <button key={l.value} type="button" aria-pressed={level === l.value}
        className="flex w-full items-center justify-between rounded-xl px-2.5 py-1.5 text-left text-[13px] hover:bg-edge/[0.05] aria-pressed:bg-accent/[0.08] aria-pressed:text-accent"
        onClick={() => { onLevel(l.value); close(); trigger.current?.focus({ preventScroll: true }); }}>
        <span>{l.label}{l.value === "low" ? "（默认）" : ""}<span className="block text-[11px] text-secondary">{l.detail}</span></span>
        {level === l.value && <span aria-hidden>✓</span>}
      </button>)}
    </div>, document.body)}
  </>;
}
