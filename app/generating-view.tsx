"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Loading view while an image is generated (ChatGPT-style): a light rounded
 * card at the output's aspect ratio with faint, sparse dots drifting in a soft
 * patch, and the percentage in a pill at the bottom right.
 */

type Props = { aspect: number; progress: number };

/** Fits an aspect-correct, rounded frame inside whatever space it is given. */
function Frame({ aspect, children }: { aspect: number; children: React.ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => {
      const W = el.clientWidth - 24;
      const H = el.clientHeight - 24;
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
  return (
    <div ref={wrapRef} className="flex h-full w-full items-center justify-center">
      {/* Always mounted so children (e.g. canvases) exist from the first render. */}
      <div
        className="relative overflow-hidden rounded-[22px] bg-[#eef1f8] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.06)]"
        style={box ? { width: box.w, height: box.h } : { width: 0, height: 0, visibility: "hidden" }}
      >
        {children}
      </div>
    </div>
  );
}

/** ChatGPT-like: faint, sparse dots gathered in a soft patch that drifts. */
export function GeneratingView({ aspect, progress }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let W = 0,
      H = 0;
    const size = () => {
      W = wrap.clientWidth;
      H = wrap.clientHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(wrap);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const gap = 13;
    let raf = 0;
    const t0 = performance.now();
    const draw = (now: number) => {
      const t = reduce ? 0 : (now - t0) / 1000;
      ctx.clearRect(0, 0, W, H);
      // Centre of the dot patch wanders slowly around the upper half.
      const cx = W * (0.5 + 0.22 * Math.sin(t * 0.35));
      const cy = H * (0.38 + 0.16 * Math.sin(t * 0.27 + 1.3));
      const rx = W * 0.42,
        ry = H * 0.3;
      for (let y = gap / 2; y < H; y += gap) {
        for (let x = gap / 2; x < W; x += gap) {
          const dx = (x - cx) / rx,
            dy = (y - cy) / ry;
          const d = dx * dx + dy * dy;
          if (d > 1) continue;
          const ripple = 0.5 + 0.5 * Math.sin(x * 0.045 + y * 0.03 - t * 1.6);
          const a = (1 - d) * (0.15 + 0.45 * ripple);
          if (a < 0.03) continue;
          ctx.fillStyle = `rgba(60, 60, 67, ${a.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(x, y, 0.9, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <Frame aspect={aspect}>
      <div ref={wrapRef} className="absolute inset-0 bg-[#f2f2f4]">
        <canvas ref={ref} className="absolute inset-0 h-full w-full" />
      </div>
      <span className="absolute bottom-4 right-4 rounded-full bg-white px-4 py-1.5 text-[17px] font-medium tabular-nums text-[#0071e3] shadow-[0_2px_10px_rgba(0,0,0,0.1)]">
        {Math.floor(progress)}%
      </span>
    </Frame>
  );
}
