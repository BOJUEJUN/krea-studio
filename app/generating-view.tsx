"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Loading view while an image is generated (ChatGPT-style): a light rounded
 * card at the output's aspect ratio with faint, sparse dots drifting in a soft
 * patch, and the percentage in a pill at the bottom right.
 */

type Props = { aspect: number; progress: number; compact?: boolean };

/** Fits an aspect-correct, rounded frame inside whatever space it is given. */
function Frame({ aspect, children, tight }: { aspect: number; children: React.ReactNode; tight?: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => {
      const W = el.clientWidth - (tight ? 0 : 24);
      const H = el.clientHeight - (tight ? 0 : 24);
      if (W <= 0 || H <= 0) return;
      const a = aspect > 0 ? aspect : 1;
      const w = Math.min(W, H * a);
      setBox({ w: Math.round(w), h: Math.round(w / a) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect, tight]);
  return (
    <div ref={wrapRef} className="flex h-full w-full items-center justify-center">
      {/* Always mounted so children (e.g. canvases) exist from the first render. */}
      <div
        className={`relative overflow-hidden bg-[#eef1f8] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.06)] ${tight ? "rounded-[18px]" : "rounded-[22px]"}`}
        style={box ? { width: box.w, height: box.h } : { width: 0, height: 0, visibility: "hidden" }}
      >
        {children}
      </div>
    </div>
  );
}

/** ChatGPT-like: faint, sparse dots gathered in a soft patch that drifts. */
// ---- Smooth noise for the "liquid" dot field ------------------------------
// Classic 3D Perlin gradient noise (z = time) with domain warping, which bends
// the field into irregular, merging droplets instead of straight wave bands.
const PERM = (() => {
  const p = Array.from({ length: 256 }, (_, i) => i);
  let seed = 1337;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 16807) % 2147483647;
    const j = seed % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  return Uint8Array.from([...p, ...p]);
})();

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function grad(h: number, x: number, y: number, z: number) {
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}
function noise3(x: number, y: number, z: number) {
  const X = Math.floor(x) & 255,
    Y = Math.floor(y) & 255,
    Z = Math.floor(z) & 255;
  x -= Math.floor(x);
  y -= Math.floor(y);
  z -= Math.floor(z);
  const u = fade(x),
    v = fade(y),
    w = fade(z);
  const A = PERM[X] + Y,
    AA = PERM[A] + Z,
    AB = PERM[A + 1] + Z;
  const B = PERM[X + 1] + Y,
    BA = PERM[B] + Z,
    BB = PERM[B + 1] + Z;
  return lerp(
    lerp(
      lerp(grad(PERM[AA] & 15, x, y, z), grad(PERM[BA] & 15, x - 1, y, z), u),
      lerp(grad(PERM[AB] & 15, x, y - 1, z), grad(PERM[BB] & 15, x - 1, y - 1, z), u),
      v
    ),
    lerp(
      lerp(grad(PERM[AA + 1] & 15, x, y, z - 1), grad(PERM[BA + 1] & 15, x - 1, y, z - 1), u),
      lerp(grad(PERM[AB + 1] & 15, x, y - 1, z - 1), grad(PERM[BB + 1] & 15, x - 1, y - 1, z - 1), u),
      v
    ),
    w
  );
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * 0..1 dot opacity at (u, v), in units of the frame's short side.
 *
 * Shape: a soft body whose centre wanders slowly; domain-warped noise bends
 * its outline so it stretches, splits into two drops and merges back over
 * ~10 s. Inside, a finer noise layer makes denser and sparser areas drift.
 * Parameters were tuned offline against rendered frame sequences.
 */
/** Per-animation randomness (2026-11-06 用户: 生成动画不要一模一样，每次随机): where the noise starts, which way it
 * drifts and the phase of the wandering blob. */
type Seed = { ox: number; oy: number; oz: number; dx: number; dy: number; p1: number; p2: number; p3: number };
export function randomSeed(): Seed {
  const r = Math.random;
  return { ox: r() * 200, oy: r() * 200, oz: r() * 200, dx: (r() - 0.5) * 0.05, dy: (r() - 0.5) * 0.04, p1: r() * 6.28, p2: r() * 6.28, p3: r() * 6.28 };
}

function blobDensity(u: number, v: number, w: number, h: number, t: number, sd: Seed) {
  const F = 1.2;
  const z = t * 0.06 + sd.oz; // slow: the shape morphs, it never twitches
  const px = u * F + t * sd.dx + sd.ox;
  const py = v * F + t * sd.dy + sd.oy;
  const qx = noise3(px, py, z);
  const qy = noise3(px + 5.2, py + 1.3, z + 2.7);
  const n =
    noise3(px + qx, py + qy, z * 1.3) +
    0.35 * noise3(2.1 * px + 1.8 * qx, 2.1 * py + 1.8 * qy, z * 1.7 + 9.1);

  const ws = 0.6;
  const cx = w * (0.5 + 0.18 * Math.sin(t * 0.21 * ws + sd.p1)) + 0.08 * Math.sin(t * 0.53 * ws + sd.p2);
  const cy = h * (0.45 + 0.14 * Math.sin(t * 0.17 * ws + sd.p3)) + 0.06 * Math.cos(t * 0.41 * ws + sd.p1);
  const R = 0.38 + 0.05 * Math.sin(t * 0.33 * ws + sd.p2);
  const d = Math.hypot(u - cx, (v - cy) * 1.1) / R + 1.4 * n;
  let blob = 1 - smooth(0.45, 1.15, d);

  const tn = noise3(px * 3 + 3.3, py * 3 - 1.7, z * 1.6 + 4.4);
  blob *= 0.55 + 0.45 * smooth(-0.35, 0.45, tn);

  const m = Math.max(0.0001, Math.min(w, h));
  const edge =
    smooth(0, 0.14, Math.min(u, w - u) / m) * smooth(0, 0.14, Math.min(v, h - v) / m);
  return blob * edge;
}

export function GeneratingView({ aspect, progress, compact }: Props) {
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
    // Dot spacing follows the frame (7-12 px) so small and large frames show a
    // similar number of dots across the droplet.
    const BUCKETS = 10; // dots are batched by opacity: one fill per bucket
    let raf = 0;
    let last = 0;
    const t0 = performance.now() - Math.random() * 60_000; // each one starts somewhere else in its motion
    const sd = randomSeed();
    const draw = (now: number) => {
      raf = reduce ? 0 : requestAnimationFrame(draw);
      if (now - last < 33 && !reduce) return; // ~30 fps is plenty for slow motion
      last = now;
      const t = reduce ? 0 : (now - t0) / 1000;
      ctx.clearRect(0, 0, W, H);
      // Work in units of the frame's short side so a big frame shows the same
      // few soft blobs as a small one, just larger, instead of more streaks.
      const S = Math.max(1, Math.min(W, H));
      const GAP = Math.min(12, Math.max(7, S / 40));
      const paths: Path2D[] = Array.from({ length: BUCKETS }, () => new Path2D());
      for (let y = GAP / 2; y < H; y += GAP) {
        for (let x = GAP / 2; x < W; x += GAP) {
          const a = blobDensity(x / S, y / S, W / S, H / S, t, sd);
          if (a < 0.04) continue;
          const k = Math.min(BUCKETS - 1, Math.floor(a * BUCKETS));
          const r = 0.55 + a * 0.75;
          paths[k].moveTo(x + r, y);
          paths[k].arc(x, y, r, 0, Math.PI * 2);
        }
      }
      for (let k = 0; k < BUCKETS; k++) {
        ctx.fillStyle = `rgba(60, 60, 67, ${(0.06 + ((k + 0.5) / BUCKETS) * 0.5).toFixed(3)})`;
        ctx.fill(paths[k]);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <Frame aspect={aspect} tight={compact}>
      <div ref={wrapRef} className="absolute inset-0 bg-[#f2f2f4]">
        <canvas ref={ref} className="absolute inset-0 h-full w-full" />
      </div>
      <span
        className={`absolute rounded-full bg-white font-medium tabular-nums text-[#0071e3] shadow-[0_2px_10px_rgba(0,0,0,0.1)] ${
          compact ? "bottom-2.5 right-2.5 px-2.5 py-1 text-[12px]" : "bottom-4 right-4 px-4 py-1.5 text-[17px]"
        }`}
      >
        {Math.floor(progress)}%
      </span>
    </Frame>
  );
}
