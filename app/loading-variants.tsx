"use client";

import { useEffect, useRef } from "react";
import { GeneratingCanvas } from "./generating-canvas";

export type LoadingVariant = "dots" | "glow" | "scan" | "ring" | "mosaic" | "aurora";

export const LOADING_VARIANTS: { key: LoadingVariant; name: string; desc: string }[] = [
  { key: "dots", name: "F · 轻点阵（ChatGPT 风格）", desc: "浅灰圆角卡片，稀疏淡点成团缓慢流动，右下角白色百分比胶囊" },
  { key: "glow", name: "A · 柔光显影", desc: "柔和色光漂移，参考图从模糊慢慢变清晰" },
  { key: "scan", name: "B · 扫描显影", desc: "一条柔光从上往下扫，扫过的部分逐渐清晰" },
  { key: "ring", name: "C · 毛玻璃进度环", desc: "磨砂玻璃卡片 + 中央圆环进度，最克制" },
  { key: "mosaic", name: "D · 马赛克渐清", desc: "从大色块逐步细化到清晰，像图像在“长”出来" },
  { key: "aurora", name: "E · 极光流动", desc: "缓慢旋转的极光渐变，适合没有参考图时" },
];

type Props = { aspect: number; progress: number; reference?: string | null };

function Frame({ aspect, children }: { aspect: number; children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-3">
      <div
        className="relative max-h-full max-w-full overflow-hidden rounded-[22px] bg-[#eef1f8] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.06)]"
        style={{ aspectRatio: String(aspect > 0 ? aspect : 1), height: "100%" }}
      >
        {children}
      </div>
    </div>
  );
}

function Percent({ progress, dark }: { progress: number; dark?: boolean }) {
  return (
    <span
      className={`absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full px-2.5 py-1 text-[11px] tabular-nums backdrop-blur-md ${
        dark ? "bg-black/35 text-white" : "bg-white/60 text-[#3a3a3c]"
      }`}
    >
      正在生成 · {Math.floor(progress)}%
    </span>
  );
}

function Scan({ aspect, progress, reference }: Props) {
  const p = Math.max(0, Math.min(100, progress));
  return (
    <Frame aspect={aspect}>
      {reference ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={reference} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover blur-[28px] saturate-150" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={reference}
            alt=""
            className="absolute inset-0 h-full w-full object-cover blur-[6px] transition-[clip-path] duration-700 ease-out"
            style={{ clipPath: `inset(0 0 ${100 - p}% 0)` }}
          />
        </>
      ) : (
        <div className="absolute inset-0 bg-[linear-gradient(160deg,#dfe7ff,#efe4ff_55%,#dff4ff)]" />
      )}
      <div
        className="pointer-events-none absolute inset-x-0 h-16 -translate-y-1/2 transition-[top] duration-700 ease-out"
        style={{
          top: `${p}%`,
          background:
            "linear-gradient(180deg, transparent, rgba(255,255,255,0.65) 50%, transparent)",
        }}
      />
      <Percent progress={progress} dark={!!reference} />
    </Frame>
  );
}

function Ring({ aspect, progress, reference }: Props) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, progress)) / 100;
  return (
    <Frame aspect={aspect}>
      {reference ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={reference} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-[40px]" />
      ) : (
        <div className="absolute inset-0 bg-[radial-gradient(80%_60%_at_30%_20%,#dbe6ff,transparent),radial-gradient(70%_60%_at_80%_90%,#eadcff,transparent)]" />
      )}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="loading-breathe flex h-32 w-32 flex-col items-center justify-center rounded-[32px] bg-white/55 shadow-[0_8px_30px_rgba(0,0,0,0.08)] backdrop-blur-xl">
          <svg width="84" height="84" viewBox="0 0 84 84" className="-rotate-90">
            <circle cx="42" cy="42" r={r} fill="none" stroke="rgba(0,0,0,0.08)" strokeWidth="5" />
            <circle
              cx="42"
              cy="42"
              r={r}
              fill="none"
              stroke="#0071e3"
              strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray={c}
              strokeDashoffset={c * (1 - p)}
              style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(0.25,0.1,0.25,1)" }}
            />
          </svg>
          <span className="-mt-[58px] mb-[30px] text-[15px] font-semibold tabular-nums text-[#1d1d1f]">
            {Math.floor(progress)}%
          </span>
        </div>
      </div>
    </Frame>
  );
}

function Mosaic({ aspect, progress, reference }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const step = Math.floor(Math.max(0, Math.min(99, progress)) / 12); // 0..8

  useEffect(() => {
    if (!reference) return;
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      draw();
    };
    img.src = reference;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reference]);

  const draw = () => {
    const canvas = ref.current;
    const img = imgRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = 480;
    const H = Math.round(W / (aspect > 0 ? aspect : 1));
    canvas.width = W;
    canvas.height = H;
    const block = [48, 36, 28, 22, 16, 12, 9, 7, 5][step] ?? 5;
    const sw = Math.max(1, Math.round(W / block));
    const sh = Math.max(1, Math.round(H / block));
    const tmp = document.createElement("canvas");
    tmp.width = sw;
    tmp.height = sh;
    const t = tmp.getContext("2d");
    if (!t) return;
    if (img) {
      t.drawImage(img, 0, 0, sw, sh);
    } else {
      const g = t.createLinearGradient(0, 0, sw, sh);
      g.addColorStop(0, "#c9d8ff");
      g.addColorStop(0.5, "#e6d6ff");
      g.addColorStop(1, "#cdeeff");
      t.fillStyle = g;
      t.fillRect(0, 0, sw, sh);
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, W, H);
  };

  useEffect(draw);

  return (
    <Frame aspect={aspect}>
      <canvas key={step} ref={ref} className="loading-fade absolute inset-0 h-full w-full" />
      <Percent progress={progress} dark={!!reference} />
    </Frame>
  );
}

function Aurora({ aspect, progress }: Props) {
  return (
    <Frame aspect={aspect}>
      <div className="loading-aurora absolute -inset-1/2" />
      <div className="absolute inset-0 bg-white/25" />
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="loading-shimmer-text text-[15px] font-semibold tracking-wide">正在生成</span>
      </div>
      <Percent progress={progress} />
    </Frame>
  );
}

/** ChatGPT-like: faint, sparse dots gathered in a soft patch that drifts. */
function Dots({ aspect, progress }: Props) {
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

export function LoadingView({ variant, ...props }: Props & { variant: LoadingVariant }) {
  if (variant === "dots") return <Dots {...props} />;
  if (variant === "scan") return <Scan {...props} />;
  if (variant === "ring") return <Ring {...props} />;
  if (variant === "mosaic") return <Mosaic {...props} />;
  if (variant === "aurora") return <Aurora {...props} />;
  return <GeneratingCanvas {...props} />;
}
