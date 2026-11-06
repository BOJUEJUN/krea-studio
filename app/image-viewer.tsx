"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useZoom } from "./compare-view";

/**
 * 2026-11-05 (用户: 点击图片打开查看细节，支持缩放): full-screen picture. Wheel / pinch / double-click zoom at the
 * pointer, drag to move while zoomed, Esc or a click on the dark area closes; ← → switch when there are several.
 */
export function ImageViewer({
  src,
  onClose,
  onPrev,
  onNext,
  caption,
}: {
  src: string;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  caption?: string;
}) {
  const z = useZoom();
  const boxRef = useRef<HTMLDivElement>(null);
  const panning = useRef(false);

  useEffect(() => {
    z.setView({ s: 1, x: 0, y: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") onPrev?.();
      if (e.key === "ArrowRight") onNext?.();
    };
    window.addEventListener("keydown", key);
    const el = boxRef.current;
    const stop = (e: WheelEvent) => e.preventDefault();
    el?.addEventListener("wheel", stop, { passive: false });
    return () => {
      window.removeEventListener("keydown", key);
      el?.removeEventListener("wheel", stop);
    };
  }, [onClose, onPrev, onNext]);

  const round = "flex h-10 w-10 items-center justify-center rounded-full bg-white/12 text-white backdrop-blur hover:bg-white/25";

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-black/85 backdrop-blur-sm">
      <div
        ref={boxRef}
        className={`absolute inset-0 touch-none overflow-hidden ${z.view.s > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"}`}
        {...z.bind}
        onPointerDown={(e) => {
          panning.current = z.down(e, true);
        }}
        onPointerMove={(e) => z.move(e, panning.current)}
        onPointerUp={(e) => {
          z.up(e);
          panning.current = false;
        }}
        onPointerCancel={(e) => {
          z.up(e);
          panning.current = false;
        }}
        onClick={(e) => {
          // A plain click on the dark area (not a drag, not zoomed in) closes.
          if (e.target === e.currentTarget && !z.moved.current && z.view.s === 1) onClose();
        }}
      >
        <div className="pointer-events-none absolute inset-6 will-change-transform sm:inset-12" style={z.style}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="" draggable={false} className="animate-pop-in h-full w-full select-none object-contain" />
        </div>
      </div>
      <button type="button" aria-label="关闭" onClick={onClose} className={`${round} absolute right-4 top-4`}>
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
      {onPrev && (
        <button type="button" aria-label="上一张" onClick={onPrev} className={`${round} absolute left-4 top-1/2 -translate-y-1/2`}>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
      )}
      {onNext && (
        <button type="button" aria-label="下一张" onClick={onNext} className={`${round} absolute right-4 top-1/2 -translate-y-1/2`}>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round"><path d="M9 5l7 7-7 7" /></svg>
        </button>
      )}
      <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-white/12 p-1 text-white backdrop-blur">
        <button type="button" aria-label="缩小" onClick={() => z.zoomAt(boxRef.current!, innerWidth / 2, innerHeight / 2, z.view.s / 1.5)} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/20">−</button>
        <button type="button" onClick={() => z.setView({ s: 1, x: 0, y: 0 })} className="h-8 min-w-12 rounded-full px-2 text-[12px] tabular-nums hover:bg-white/20" data-tip="还原">
          {Math.round(z.view.s * 100)}%
        </button>
        <button type="button" aria-label="放大" onClick={() => z.zoomAt(boxRef.current!, innerWidth / 2, innerHeight / 2, z.view.s * 1.5)} className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/20">+</button>
        {caption && <span className="px-2 text-[12px] tabular-nums opacity-80">{caption}</span>}
      </div>
    </div>,
    document.body
  );
}
