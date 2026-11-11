"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type CompareMode = "slider" | "side" | "toggle" | "blend";

export const COMPARE_MODES: { key: CompareMode; label: string }[] = [
  { key: "slider", label: "滑动" },
  { key: "side", label: "左右" },
  { key: "toggle", label: "点击切换" },
  { key: "blend", label: "叠加" },
];

function Tag({ children, style }: { children: string; style?: React.CSSProperties }) {
  return (
    <span
      className="pointer-events-none absolute z-10 rounded-full bg-black/55 px-2.5 py-0.5 text-[11px] font-medium text-white backdrop-blur"
      style={style}
    >
      {children}
    </span>
  );
}

/**
 * 2026-11-06 (用户: 原图/结果没对称): where the picture really sits inside the box (object-contain), so labels and
 * controls go on its own corners, mirrored left / right, and clear of the account button in the card corner.
 */
function usePictureRect(boxRef: React.RefObject<HTMLDivElement | null>, src: string) {
  const [ratio, setRatio] = useState(0);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const im = new Image();
    im.onload = () => im.naturalHeight && setRatio(im.naturalWidth / im.naturalHeight);
    im.src = src;
  }, [src]);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const fit = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [boxRef]);
  const r = ratio || 1;
  const w = Math.min(box.w, box.h * r);
  const h = w / r;
  const x = (box.w - w) / 2;
  const y = (box.h - h) / 2;
  // Keep 10px inside the picture, but never under the round account button (about 56px from the corner).
  const inset = y < 50 ? Math.max(10, 56 - x) : 10;
  return {
    topLeft: { left: x + inset, top: y + 10 } as React.CSSProperties,
    topRight: { right: x + inset, top: y + 10 } as React.CSSProperties,
    bottomLeft: { left: x + 10, bottom: y + 10 } as React.CSSProperties,
    bottomRight: { right: x + 10, bottom: y + 10 } as React.CSSProperties,
  };
}

type View = { s: number; x: number; y: number };
const MAX = 8;
/** 2026-11-10 (用户: 对比要支持缩小): down to 25%, kept centred. */
const MIN = 0.25;

/**
 * 2026-11-05 (用户: 对比要支持放大查看细节): one zoom shared by both pictures. Wheel or pinch zooms at the
 * pointer, drag pans while zoomed, double-click jumps to 3× there and back.
 */
export function useZoom() {
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; s: number } | null>(null);
  const moved = useRef(false);

  const clamp = (v: View, el: HTMLElement): View => {
    const s = Math.min(MAX, Math.max(MIN, Math.abs(v.s - 1) < 0.01 ? 1 : v.s));
    if (s <= 1) return { s, x: 0, y: 0 };
    const mx = (el.clientWidth * (s - 1)) / 2;
    const my = (el.clientHeight * (s - 1)) / 2;
    return { s, x: Math.min(mx, Math.max(-mx, v.x)), y: Math.min(my, Math.max(-my, v.y)) };
  };

  /** Zoom to scale `s` keeping the screen point (cx, cy) still. */
  const zoomAt = useCallback((el: HTMLElement, cx: number, cy: number, s: number) => {
    const r = el.getBoundingClientRect();
    const px = cx - r.left - r.width / 2;
    const py = cy - r.top - r.height / 2;
    const v = viewRef.current;
    const k = Math.min(MAX, Math.max(MIN, s)) / v.s;
    setView(clamp({ s: v.s * k, x: px - (px - v.x) * k, y: py - (py - v.y) * k }, el));
  }, []);

  const bind = {
    onWheel: (e: React.WheelEvent<HTMLElement>) => {
      zoomAt(e.currentTarget, e.clientX, e.clientY, viewRef.current.s * Math.exp(-e.deltaY * 0.0025));
    },
    onDoubleClick: (e: React.MouseEvent<HTMLElement>) => {
      zoomAt(e.currentTarget, e.clientX, e.clientY, viewRef.current.s !== 1 ? 1 : 3);
    },
  };

  /** Returns true when the pointer is used for zooming / panning (so the caller ignores it). */
  const down = (e: React.PointerEvent<HTMLElement>, wantsPan: boolean) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = false;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), s: viewRef.current.s };
      return true;
    }
    if (wantsPan && viewRef.current.s > 1) {
      e.currentTarget.setPointerCapture(e.pointerId);
      return true;
    }
    return false;
  };
  const move = (e: React.PointerEvent<HTMLElement>, panning: boolean) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const el = e.currentTarget;
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      zoomAt(el, (a.x + b.x) / 2, (a.y + b.y) / 2, (pinch.current.s * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.current.d);
      moved.current = true;
      return;
    }
    if (panning) {
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      if (Math.abs(dx) + Math.abs(dy) > 1) moved.current = true;
      const v = viewRef.current;
      setView(clamp({ s: v.s, x: v.x + dx, y: v.y + dy }, el));
    }
  };
  const up = (e: React.PointerEvent<HTMLElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  const style = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transformOrigin: "center" } as const;
  return { view, setView, style, bind, down, move, up, moved, zoomAt };
}

/** One button step; crossing 100% stops there, so the buttons always come back to it. */
export function stepScale(s: number, k: number) {
  const next = s * k;
  return (s < 1 && next > 1) || (s > 1 && next < 1) ? 1 : next;
}

function ZoomBar({ z, boxRef, style }: { z: ReturnType<typeof useZoom>; boxRef: React.RefObject<HTMLDivElement | null>; style?: React.CSSProperties }) {
  const step = (k: number) => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    z.zoomAt(el, r.left + r.width / 2, r.top + r.height / 2, stepScale(z.view.s, k));
  };
  const btn = "flex h-7 min-w-7 items-center justify-center rounded-full px-1.5 text-[13px] text-ink hover:bg-edge/[0.06]";
  return (
    <div
      className="absolute z-20 flex items-center gap-0.5 rounded-full bg-panel/85 p-0.5 shadow-[0_4px_16px_rgba(0,0,0,0.12)] backdrop-blur"
      style={style ?? { right: 8, bottom: 8 }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <button type="button" className={btn} onClick={() => step(1 / 1.5)} aria-label="缩小">−</button>
      <button type="button" className={`${btn} w-11 text-[11px] tabular-nums`} onClick={() => z.setView({ s: 1, x: 0, y: 0 })} data-tip="还原">
        {Math.round(z.view.s * 100)}%
      </button>
      <button type="button" className={btn} onClick={() => step(1.5)} aria-label="放大">+</button>
    </div>
  );
}

/**
 * Before/after views for an image-to-image result. Both images are laid out
 * with object-contain in the same box; the workflows keep the reference's
 * aspect ratio, so they line up pixel for pixel.
 */
export function CompareView({
  before,
  after,
  mode,
}: {
  before: string;
  after: string;
  mode: CompareMode;
}) {
  const [pos, setPos] = useState(50);
  const [blend, setBlend] = useState(50);
  const [showBefore, setShowBefore] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<"divider" | "pan" | null>(null);
  const z = useZoom();
  const at = usePictureRect(boxRef, after);
  // The wheel zooms the pictures instead of scrolling the page.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", stop, { passive: false });
    return () => el.removeEventListener("wheel", stop);
  }, [mode]);

  const moveTo = useCallback((clientX: number) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    setPos(Math.min(100, Math.max(0, ((clientX - box.left) / box.width) * 100)));
  }, []);

  const img = "absolute inset-0 h-full w-full select-none object-contain";
  const layer = "absolute inset-0 will-change-transform";
  const cursor = z.view.s > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in";
  const hint = z.view.s === 1 && (
    <span className="pointer-events-none absolute z-10 rounded-full bg-black/45 px-2.5 py-1 text-[10px] text-white backdrop-blur" style={at.bottomLeft}>
      滚轮 / 双击放大
    </span>
  );

  // Pan handlers for the plain views (side / toggle / blend).
  const panProps = {
    ...z.bind,
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      dragging.current = z.down(e, true) ? "pan" : null;
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => z.move(e, dragging.current === "pan"),
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
      z.up(e);
      dragging.current = null;
    },
    onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => {
      z.up(e);
      dragging.current = null;
    },
  };

  if (mode === "side") {
    return (
      <div ref={boxRef} className="relative grid h-full w-full grid-cols-2 gap-1.5">
        {[
          ["原图", before],
          ["结果", after],
        ].map(([label, src]) => (
          <div key={label} className={`relative h-full min-h-0 touch-none overflow-hidden rounded-xl bg-edge/[0.03] ${cursor}`} {...panProps}>
            <Tag style={{ left: "50%", top: 10, translate: "-50% 0" }}>{label}</Tag>
            <div className={layer} style={z.style}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={label} draggable={false} className={img} />
            </div>
          </div>
        ))}
        <ZoomBar z={z} boxRef={boxRef} />
      </div>
    );
  }

  if (mode === "toggle") {
    return (
      <div
        ref={boxRef}
        {...panProps}
        onDoubleClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={() => !z.moved.current && setShowBefore((v) => !v)}
        className={`compare-toggle relative h-full w-full touch-none overflow-hidden ${z.view.s > 1 ? cursor : "cursor-pointer"}`}
        role="button"
        aria-label="点击切换原图与结果"
      >
        <Tag style={at.topLeft}>{showBefore ? "原图" : "结果"}</Tag>
        <span className="pointer-events-none absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/55 px-2.5 py-1 text-[11px] text-white">
          点击切换
        </span>
        <div className={layer} style={z.style}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={after} alt="结果" draggable={false} className={img} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={before}
            alt="原图"
            draggable={false}
            className={`${img} transition-opacity duration-200 ${showBefore ? "opacity-100" : "opacity-0"}`}
          />
        </div>
        <ZoomBar z={z} boxRef={boxRef} style={at.bottomRight} />
      </div>
    );
  }

  if (mode === "blend") {
    return (
      <div className="flex h-full w-full flex-col gap-2">
        <div ref={boxRef} className={`relative min-h-0 flex-1 touch-none overflow-hidden ${cursor}`} {...panProps}>
          <div className={layer} style={z.style}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={before} alt="原图" draggable={false} className={img} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={after} alt="结果" draggable={false} className={img} style={{ opacity: blend / 100 }} />
          </div>
          {hint}
          <ZoomBar z={z} boxRef={boxRef} style={at.bottomRight} />
        </div>
        <label className="flex shrink-0 items-center gap-2 px-2 text-[11px] text-secondary">
          原图
          <input
            type="range"
            min={0}
            max={100}
            value={blend}
            onChange={(e) => setBlend(Number(e.target.value))}
            className="flex-1"
            aria-label="结果透明度"
          />
          结果
        </label>
      </div>
    );
  }

  // slider (default): drag the divider; left of it shows the reference. Zoomed in, dragging away from the
  // divider pans both pictures together.
  return (
    <div
      ref={boxRef}
      className={`relative h-full w-full touch-none select-none overflow-hidden ${z.view.s > 1 ? cursor : "cursor-ew-resize"}`}
      {...z.bind}
      onPointerDown={(e) => {
        const box = boxRef.current!.getBoundingClientRect();
        const nearDivider = Math.abs(e.clientX - (box.left + (box.width * pos) / 100)) < 28;
        if (z.down(e, !nearDivider)) {
          dragging.current = "pan";
          return;
        }
        dragging.current = "divider";
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        moveTo(e.clientX);
      }}
      onPointerMove={(e) => {
        z.move(e, dragging.current === "pan");
        if (dragging.current === "divider") moveTo(e.clientX);
      }}
      onPointerUp={(e) => {
        z.up(e);
        dragging.current = null;
      }}
      onPointerCancel={(e) => {
        z.up(e);
        dragging.current = null;
      }}
    >
      <Tag style={at.topLeft}>原图</Tag>
      <Tag style={at.topRight}>结果</Tag>
      <div className={layer} style={z.style}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={after} alt="结果" draggable={false} className={img} />
      </div>
      <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
        <div className={layer} style={z.style}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={before} alt="原图" draggable={false} className={img} />
        </div>
      </div>
      <div className="pointer-events-none absolute inset-y-0 z-10" style={{ left: `${pos}%` }}>
        <div className="absolute inset-y-0 -translate-x-1/2 border-l-2 border-white shadow-[0_0_6px_rgba(0,0,0,0.45)]" />
        <div className="absolute top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-panel text-[12px] text-ink shadow-[0_2px_10px_rgba(0,0,0,0.3)]">
          ⇆
        </div>
      </div>
      {hint}
      <ZoomBar z={z} boxRef={boxRef} style={at.bottomRight} />
    </div>
  );
}
