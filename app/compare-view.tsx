"use client";

import { useCallback, useRef, useState } from "react";

export type CompareMode = "slider" | "side" | "toggle" | "blend";

export const COMPARE_MODES: { key: CompareMode; label: string }[] = [
  { key: "slider", label: "滑动" },
  { key: "side", label: "左右" },
  { key: "toggle", label: "点击切换" },
  { key: "blend", label: "叠加" },
];

function Tag({ children, side }: { children: string; side: "left" | "right" }) {
  return (
    <span
      className={`pointer-events-none absolute top-2 z-10 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white ${
        side === "left" ? "left-2" : "right-2"
      }`}
    >
      {children}
    </span>
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
  const dragging = useRef(false);

  const moveTo = useCallback((clientX: number) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    setPos(Math.min(100, Math.max(0, ((clientX - box.left) / box.width) * 100)));
  }, []);

  const img = "absolute inset-0 h-full w-full select-none object-contain";

  if (mode === "side") {
    return (
      <div className="grid h-full w-full grid-cols-2 gap-1.5">
        {[
          ["原图", before],
          ["结果", after],
        ].map(([label, src]) => (
          <div key={label} className="relative h-full min-h-0 overflow-hidden rounded-xl bg-black/[0.03]">
            <Tag side="left">{label}</Tag>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={label} draggable={false} className={img} />
          </div>
        ))}
      </div>
    );
  }

  if (mode === "toggle") {
    return (
      <button
        type="button"
        onClick={() => setShowBefore((v) => !v)}
        className="compare-toggle relative h-full w-full cursor-pointer"
        aria-label="点击切换原图与结果"
      >
        <Tag side="left">{showBefore ? "原图" : "结果"}</Tag>
        <span className="pointer-events-none absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/55 px-2.5 py-1 text-[11px] text-white">
          点击图片切换
        </span>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={after} alt="结果" draggable={false} className={img} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={before}
          alt="原图"
          draggable={false}
          className={`${img} transition-opacity duration-200 ${showBefore ? "opacity-100" : "opacity-0"}`}
        />
      </button>
    );
  }

  if (mode === "blend") {
    return (
      <div className="flex h-full w-full flex-col gap-2">
        <div className="relative min-h-0 flex-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={before} alt="原图" draggable={false} className={img} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={after} alt="结果" draggable={false} className={img} style={{ opacity: blend / 100 }} />
        </div>
        <label className="flex shrink-0 items-center gap-2 px-2 text-[11px] text-[#6e6e73]">
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

  // slider (default): drag the divider; left of it shows the reference.
  return (
    <div
      ref={boxRef}
      className="relative h-full w-full cursor-ew-resize touch-none select-none"
      onPointerDown={(e) => {
        dragging.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        moveTo(e.clientX);
      }}
      onPointerMove={(e) => dragging.current && moveTo(e.clientX)}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
    >
      <Tag side="left">原图</Tag>
      <Tag side="right">结果</Tag>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={after} alt="结果" draggable={false} className={img} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={before}
        alt="原图"
        draggable={false}
        className={img}
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
      />
      <div className="pointer-events-none absolute inset-y-0 z-10" style={{ left: `${pos}%` }}>
        <div className="absolute inset-y-0 -translate-x-1/2 border-l-2 border-white shadow-[0_0_6px_rgba(0,0,0,0.45)]" />
        <div className="absolute top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-[12px] text-[#1d1d1f] shadow-[0_2px_10px_rgba(0,0,0,0.3)]">
          ⇆
        </div>
      </div>
    </div>
  );
}
