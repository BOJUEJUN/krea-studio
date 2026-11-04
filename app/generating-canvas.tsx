"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Loading placeholder: a halftone dot field whose brightness drifts like
 * flowing light, framed at the aspect ratio of the image being generated.
 */
export function GeneratingCanvas({
  aspect,
  progress,
}: {
  aspect: number;
  progress: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);

  // Fit an aspect-correct frame inside the available area.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => {
      const W = el.clientWidth;
      const H = el.clientHeight - 28; // room for the percentage line
      if (W <= 0 || H <= 0) return;
      const a = aspect > 0 ? aspect : 1;
      const w = Math.min(W, H * a);
      setBox({ w: Math.round(w), h: Math.round(w / a) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !box) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = box.w * dpr;
    canvas.height = box.h * dpr;
    ctx.scale(dpr, dpr);

    const gap = 8;
    const cols = Math.ceil(box.w / gap) + 1;
    const rows = Math.ceil(box.h / gap) + 1;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const start = performance.now();

    const draw = (now: number) => {
      const t = reduce ? 0 : (now - start) / 1000;
      ctx.clearRect(0, 0, box.w, box.h);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const x = i * gap + (j % 2 ? gap / 2 : 0);
          const y = j * gap;
          const u = x / box.w;
          const v = y / box.h;
          // Layered travelling waves give a soft, flowing light field.
          const n =
            Math.sin(u * 5.2 + t * 1.1) * 0.45 +
            Math.sin(v * 4.4 - t * 0.8 + u * 2.1) * 0.35 +
            Math.sin((u + v) * 7.5 + t * 1.7) * 0.2;
          const k = Math.min(1, Math.max(0, (n + 1) / 2)); // 0..1
          const kk = k * k * k;
          const r = 0.35 + kk * 3.3;
          const hue = 222 + u * 50 - v * 30 + Math.sin(t * 0.4) * 12;
          ctx.fillStyle = `hsla(${hue}, 80%, ${66 - kk * 30}%, ${0.1 + kk * 0.85})`;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [box]);

  return (
    <div ref={wrapRef} className="flex h-full w-full flex-col items-center justify-center p-3">
      {box && (
        <div
          className="generating-frame relative overflow-hidden rounded-[18px] bg-[#f3f5fb]"
          style={{ width: box.w, height: box.h }}
        >
          <div className="generating-glow pointer-events-none absolute inset-0" />
          <canvas ref={canvasRef} style={{ width: box.w, height: box.h }} className="relative block" />
          <div className="generating-sheen pointer-events-none absolute inset-0" />
        </div>
      )}
      <p className="mt-2.5 h-[18px] text-[12px] tabular-nums text-[#6e6e73]">
        正在生成 · {Math.floor(progress)}%
      </p>
    </div>
  );
}
