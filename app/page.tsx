"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GeneratingView } from "./generating-view";
import { ImageViewer } from "./image-viewer";
import { BatchGrid } from "./batch-grid";
import { LoginView } from "./login-view";
import { loadDraft, saveDraft } from "@/lib/draft";
import { COMPARE_MODES, CompareView, type CompareMode } from "./compare-view";
import { PictureMention } from "./picture-mention";
import { CanvasBoard, type BoardApi, type BoardJob, type BoardSource } from "./canvas-board";
import {
  DEFAULT_MODEL,
  editAspectOf,
  RES_PIXELS,
  type Res,
  MODELS,
  QUALITY_LABELS,
  findModel,
  paramsOf,
  type Mode,
  type ModelId,
  type Quality,
} from "@/lib/models";

import type { RunFrame } from "@/lib/canvas-execution";
import type { BoardNode, CanvasDraft } from "@/lib/canvas-workflow";
import { pictureParams, pictureRefs, restoredPolishLevel, type EditMetadata } from "@/lib/edit-recipe";

type Readiness = Record<string, Record<Mode, boolean>>;

type GalleryItem = EditMetadata & {
  id: string;
  mode: Mode;
  model?: string;
  prompt: string;
  url: string;
  status?: "pending" | "done" | "failed" | "expired";
  label?: string;
  error?: string;
  refUrl?: string;
  cost?: string | null;
  seed?: number;
  taskId?: string;
  createdAt: number;
  durationMs?: number;
  fav?: boolean;
};

/**
 * Text with every "@图N" marked. 2026-11-10 (用户: @图片不要显示文字，要显示图片的小图): when picture N is known
 * the token shows that picture's thumbnail. The chip keeps the exact width of the hidden "@图N" text, so the
 * textarea underneath (which holds the real text) keeps its caret where the eye expects it.
 */
function withMentions(text: string, thumbs: (string | null | undefined)[] = []) {
  return text.split(/(@图\d+)/g).map((part, i) => {
    if (!/^@图\d+$/.test(part)) return part;
    const src = thumbs[Number(part.slice(2)) - 1];
    if (!src)
      // No picture N uploaded yet: say so instead of looking broken (用户: 怎么只有图1是图片).
      return (
        <span key={i} className="rounded bg-[#ff3b30]/10 text-danger underline decoration-dashed underline-offset-2" title={`还没放${part.slice(1)}，点 + 加图`}>
          {part}
        </span>
      );
    return <PictureMention key={i} token={part} src={src} />;
  });
}

/** A reference file shrunk to a data URL, so it can live on the canvas (kept in browser storage). */
async function fileToDataUrl(file: File, max = 1024): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.86);
}

/** A row of choices for one setting (shown when its chip is opened). */
function Choice({ options, value, onPick, note }: { options: ([string, string] | [string, string, string])[]; value: string; onPick: (v: string) => void; note?: string }) {
  return (
    <div className="flex flex-col">
      {note && <div className="max-w-[200px] px-2.5 pb-1 text-[11px] text-muted">{note}</div>}
      {options.map(([v, t, sub]) => (
        <button
          key={v}
          type="button"
          onClick={() => onPick(v)}
          className={`flex items-center justify-between gap-6 whitespace-nowrap rounded-xl px-2.5 py-1.5 text-left text-[13px] transition ${value === v ? "bg-accent/[0.08] text-accent" : "text-ink hover:bg-edge/[0.04]"}`}
        >
          <span className="flex flex-col">
            {t}
            {sub && <span className="text-[11px] text-muted">{sub}</span>}
          </span>
          {value === v && <span>✓</span>}
        </button>
      ))}
    </div>
  );
}

/** 96 px model icon (the full cover is ~100 KB). */
function iconOf(cover: string): string {
  return cover.replace("/models/", "/models/icon/") + "?v=2";
}

/** Pixel position of the caret inside a textarea (a hidden copy measures where the text before it ends). */
function caretXY(el: HTMLTextAreaElement, pos: number): { x: number; y: number } {
  const cs = getComputedStyle(el);
  const div = document.createElement("div");
  for (const k of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "padding", "border", "boxSizing", "whiteSpace", "wordWrap", "width"] as const) {
    (div.style as any)[k] = (cs as any)[k];
  }
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.overflowWrap = "break-word";
  div.textContent = el.value.slice(0, pos);
  const mark = document.createElement("span");
  mark.textContent = "\u200b";
  div.appendChild(mark);
  document.body.appendChild(div);
  const x = mark.offsetLeft;
  const y = mark.offsetTop - el.scrollTop;
  div.remove();
  return { x: Math.min(x, el.clientWidth - 200), y };
}

/** Same picture as bytes on this site (for fetch(): download, 当参考图, 重新编辑); <img> loads go straight to COS. */
function rawOf(url: string): string {
  return url.startsWith("/api/") ? `${url}${url.includes("?") ? "&" : "?"}raw=1` : url;
}

/** GPT takes a free size: the ratio scaled to the 清晰度 tier's pixel count; other models keep their own size. */
const sizeFor = (model: ModelId, res: Res, ratio: number, fallback?: { width: number; height: number }) => {
  if (!paramsOf(model).pricePerMegapixel && fallback) return fallback;
  const px = RES_PIXELS[res];
  const w = Math.round(Math.sqrt(px * ratio) / 16) * 16;
  return { width: w, height: Math.round(w / ratio / 16) * 16 };
};

/** Extra request fields for the selected model (only what it supports). */
const advanced = ({ model, seedText, negative, lora, background, complexity }: CanvasDraft): Record<string, string | number> => {
  const p = paramsOf(model);
  const out: Record<string, string | number> = {};
  if (p.seed && seedText.trim() && Number.isFinite(Number(seedText))) out.seed = Math.floor(Number(seedText));
  if (p.negative && negative.trim()) out.negative = negative.trim();
  if (p.lora) out.lora = lora;
  if (p.background && background !== "auto") out.background = background;
  if (p.complexity && complexity !== "auto") out.complexity = complexity;
  return out;
};

function referenceFiles(urls: string[]) {
  return Promise.all(urls.map(async (url, i) => {
    const response = await fetch(rawOf(url));
    if (!response.ok) throw new Error("参考图读取失败");
    const blob = await response.blob();
    return new File([blob], `ref-${i + 1}.${blob.type.split("/")[1] || "png"}`, { type: blob.type || "image/png" });
  }));
}

/**
 * 2026-11-06 (用户: 加载慢了): signed Tencent links per picture, from the history answer, so the browser loads
 * straight from storage. If a size is missing the <img> falls back to the site's own path (see the error hook).
 */
const DIRECT = new Map<string, Record<string, string>>();
const FALLBACK = new Map<string, string>();
function rememberDirect(items: { url?: string; refUrl?: string; direct?: Record<string, string>; refDirect?: string }[]) {
  for (const g of items) {
    if (g.url && g.direct) DIRECT.set(g.url, g.direct);
    if (g.refUrl && g.refDirect) DIRECT.set(g.refUrl, { full: g.refDirect });
  }
}
function viaDirect(url: string, size: string, fallback: string): string {
  const d = DIRECT.get(url)?.[size];
  if (!d) return fallback;
  FALLBACK.set(d, fallback);
  return d;
}
if (typeof window !== "undefined") {
  window.addEventListener(
    "error",
    (e) => {
      const img = e.target as HTMLImageElement;
      if (img?.tagName === "IMG" && FALLBACK.has(img.src)) img.src = FALLBACK.get(img.src)!;
    },
    true
  );
}

/** Small WebP for grids; originals stay for the big view and downloads. */
function thumbOf(url: string, w: number): string {
  return url.startsWith("/api/img/") ? viaDirect(url, String(w), `${url}?w=${w}`) : url;
}
async function polishText(prompt: string, level: CanvasDraft["polishLevel"]): Promise<string> {
  const res = await fetch("/api/polish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, level }) });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok || typeof data.prompt !== "string" || !data.prompt.trim()) throw new Error(data?.error || "提示词润色失败");
  return data.prompt;
}

/** The original picture, straight from storage when possible. */
function fullOf(url: string): string {
  return url.startsWith("/api/") ? viaDirect(url, "full", url) : url;
}

/** 24 秒 / 1 分 05 秒 */
function formatDuration(ms?: number): string | null {
  if (!ms || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, "0")} 秒`;
}

type PendingJob = EditMetadata & {
  renderTiming?: Timing;
  canvasBoard?: string;
  /** When 生成 was clicked (2026-11-06 用户: 用时比体感短 — it now includes 提示词优化 and the upload). */
  startedAt?: number;
  taskId: string;
  seed?: number;
  mode: Mode;
  model?: ModelId;
  prompt: string;
  refUrl?: string;
  createdAt: number;
};

// Every preset is ~2.36 MP (1536 x 1536), the resolution the LoRAs were tuned for.
const RATIOS = [
  { label: "1:1", w: 1536, h: 1536, kind: "square" as const },
  { label: "3:4", w: 1328, h: 1776, kind: "portrait" as const },
  { label: "2:3", w: 1248, h: 1888, kind: "portrait" as const },
  { label: "9:16", w: 1152, h: 2048, kind: "portrait" as const },
  { label: "4:3", w: 1776, h: 1328, kind: "landscape" as const },
  { label: "3:2", w: 1888, h: 1248, kind: "landscape" as const },
  { label: "16:9", w: 2048, h: 1152, kind: "landscape" as const },
  { label: "21:9", w: 2352, h: 1008, kind: "landscape" as const },
  { label: "4:5", w: 1376, h: 1720, kind: "portrait" as const },
  { label: "5:4", w: 1720, h: 1376, kind: "landscape" as const },
  { label: "1:4", w: 640, h: 2560, kind: "portrait" as const },
  { label: "4:1", w: 2560, h: 640, kind: "landscape" as const },
  { label: "1:8", w: 320, h: 2560, kind: "portrait" as const },
  { label: "8:1", w: 2560, h: 320, kind: "landscape" as const },
];

const MAX_RES = 2560;
const MIN_RES = 256;
/** 高速 (48G plus machine) vs 标准 on RunningHub, measured 2026-11-11 with LOL V1.1 1328×1776: same 13 s once warm,
 *  ¥0.029 vs ¥0.023 a picture (a cold first run took 33 s and ¥0.074). */
const SPEED_PRICE_X = 1.3;
const EST_COST = "0.07";
const PENDING_KEY = "krea-studio.pending-job";
const HIST_CACHE_KEY = "krea-studio.history-cache";
const ME_KEY = "krea-studio.me";
/** Drag type for a history picture dropped into the compose box (2026-11-05 用户: 拖历史图进来没反应). */
const HIST_DRAG = "application/x-studio-item";
// 2026-11-05 (用户: 刷新后进度从 22% 掉回 11%): the running job's timing, so a reload continues the same bar.
const TIMING_KEY = "krea-studio.pending-timing";
const MODEL_KEY = "krea-studio.model";
const COUNT_KEY = "krea-studio.count";
const REVERSE_KEY = "krea-studio.reverse-prompt";
const PANEL_LEFT_KEY = "krea-studio.panel-left";
const PANEL_RIGHT_KEY = "krea-studio.panel-right-2";
// Netlify buffers function requests and binary uploads incur Base64 overhead.
// Leave room for multipart fields and the platform's 6 MB request limit.
// 2026-11-06: smaller uploads keep the site's Vercel traffic down; 2048 px JPEG stays sharp for every model.
const MAX_UPLOAD_BYTES = 1.5 * 1024 * 1024;

function clampRes(n: number) {
  if (!Number.isFinite(n)) return MIN_RES;
  return Math.min(MAX_RES, Math.max(MIN_RES, Math.round(n)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function imageToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("参考图处理失败，请换一张图片重试"))),
      "image/jpeg",
      quality
    );
  });
}

async function prepareReferenceImage(file: File): Promise<File> {
  if (file.size <= MAX_UPLOAD_BYTES) return file;

  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("无法读取参考图，请换用 JPG 或 PNG 图片"));
      image.src = objectUrl;
    });

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法处理参考图，请换用 JPG 或 PNG 图片");

    // The model works at up to 2048 px, so larger source pixels only increase upload size.
    for (const maxSide of [2048, 1600, 1280, 1024]) {
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      for (const quality of [0.92, 0.85, 0.75]) {
        const blob = await imageToBlob(canvas, quality);
        if (blob.size <= MAX_UPLOAD_BYTES) {
          return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", {
            type: "image/jpeg",
          });
        }
      }
    }
    throw new Error("参考图过大，压缩后仍超过上传限制，请换一张图片");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** Small JPEG for DeepSeek: it only needs to read the picture, not its pixels. */
async function describeCopy(file: File): Promise<Blob> {
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("无法读取参考图，请换用 JPG 或 PNG 图片"));
      image.src = objectUrl;
    });
    const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await imageToBlob(canvas, 0.85);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// One 0-100% bar for prompt reverse + upload + generation, driven by time.
// Defaults come from RunningHub records (submit → image: 图生图 ≈ 50 s,
// 文生图 ≈ 42 s; DeepSeek reverse ≈ 8 s). Each finished run refines the
// estimate per model/mode (stored locally), so the bar tracks real timing.
type ProgressStep = "describe" | "submit" | "render";
const DURATIONS_KEY = "krea-studio.durations";
const DEFAULT_SECONDS = { describe: 8, submit: 1.5, t2i: 42, i2i: 50 };

function loadDurations(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(DURATIONS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function estimateSeconds(key: string, fallback: number): number {
  const v = loadDurations()[key];
  return Number.isFinite(v) && v > 2 && v < 600 ? v : fallback;
}

/** Exponential moving average so one slow queue doesn't skew the estimate. */
function recordSeconds(key: string, seconds: number) {
  if (!(seconds > 2 && seconds < 600)) return;
  const all = loadDurations();
  const prev = all[key];
  all[key] = Number.isFinite(prev) ? prev * 0.7 + seconds * 0.3 : seconds;
  try {
    localStorage.setItem(DURATIONS_KEY, JSON.stringify(all));
  } catch {}
}

type Timing = {
  step: ProgressStep;
  stepStart: number;
  est: Record<ProgressStep, number>;
  renderKey: string;
};

/** Share of the bar already earned by finished steps plus the running one. */
function progressFor(t: Timing, now: number): number {
  const order: ProgressStep[] = ["describe", "submit", "render"];
  const total = order.reduce((n, k) => n + t.est[k], 0) || 1;
  let done = 0;
  for (const k of order) {
    if (k === t.step) break;
    done += t.est[k];
  }
  const elapsed = (now - t.stepStart) / 1000;
  const est = t.est[t.step];
  let p = (done + Math.min(elapsed, est)) / total;
  if (t.step === "render") {
    // Linear to 97 % at the estimate; past it, creep toward 99 % until the image lands.
    p = Math.min(p, 0.97);
    if (elapsed > est) p = 0.97 + 0.02 * (1 - Math.exp(-(elapsed - est) / 30));
  } else {
    p = Math.min(p, (done + est) / total);
  }
  return Math.max(0, Math.min(99, p * 100));
}

/** Pending tasks survive a reload; older pages stored a single object. */
function readPending(): PendingJob[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_KEY) || "null");
    const list: PendingJob[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list.filter((p) => p?.taskId && p?.mode);
  } catch {
    return [];
  }
}
function writePending(list: PendingJob[]) {
  if (list.length) localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  else localStorage.removeItem(PENDING_KEY);
}
function addPending(list: PendingJob[]) {
  const byId = new Map(readPending().map((p) => [p.taskId, p]));
  for (const p of list) byId.set(p.taskId, p);
  writePending([...byId.values()]);
}
function dropPending(taskId: string) {
  writePending(readPending().filter((p) => p.taskId !== taskId));
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error("网络连接失败，请检查网络后重试");
  }
  const text = await res.text();
  if (res.status === 401) {
    window.dispatchEvent(new Event("need-login"));
    throw new Error("请先登录");
  }
  if (res.status === 413) {
    throw new Error("参考图超过网站上传限制，请换一张较小的图片重试");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      res.ok ? "网关响应异常，请稍后重试" : `网关错误 (${res.status})，请稍后重试`
    );
  }
}

export default function StudioPage() {
  // undefined = still checking, null = signed out.
  const [user, setUser] = useState<string | null | undefined>(undefined);
  const [userMenu, setUserMenu] = useState(false);
  const [isOwnerUser, setIsOwnerUser] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  // The name menu closes when you click anywhere else.
  useEffect(() => {
    if (!userMenu) return;
    const close = (e: MouseEvent) => {
      if (!userMenuRef.current?.contains(e.target as Node)) setUserMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [userMenu]);
  // Model icons are tiny; load them up front so the model menu opens instantly.
  useEffect(() => {
    for (const m of MODELS) {
      const img = new Image();
      img.src = iconOf(m.cover);
    }
  }, []);
  useEffect(() => {
    // 2026-11-06 (性能): a returning visitor is shown as signed in at once; the check below confirms it.
    try {
      const me = JSON.parse(localStorage.getItem(ME_KEY) || "null");
      if (me?.user) {
        setUser(me.user);
        setIsOwnerUser(!!me.owner);
      }
    } catch {}
    fetch("/api/auth", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setUser(d?.user ?? null);
        setIsOwnerUser(!!d?.owner);
        try {
          if (d?.user) localStorage.setItem(ME_KEY, JSON.stringify({ user: d.user, owner: !!d.owner }));
          else localStorage.removeItem(ME_KEY);
        } catch {}
      })
      .catch(() => setUser(null));
    const onNeed = () => {
      setUser(null);
      try {
        localStorage.removeItem(ME_KEY);
      } catch {}
    };
    window.addEventListener("need-login", onNeed);
    return () => window.removeEventListener("need-login", onNeed);
  }, []);
  // 2026-11-05 (用户: 不分了，合成吧): one form — a reference image makes it 图生图, none makes it 文生图.
  const [mode, setMode] = useState<Mode>("t2i");
  const [model, setModel] = useState<ModelId>(DEFAULT_MODEL);
  const [reverseOn, setReverse] = useState(true);
  // AI 写描述 only for the RunningHub workflow models (用户 2026-11-05); GPT / Krea 3 / Banana read the picture themselves.
  const reverse = reverseOn && !findModel(model)?.billing;
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [prompt, setPrompt] = useState("");
  const [width, setWidth] = useState(1536);
  const [height, setHeight] = useState(1536);
  const [widthText, setWidthText] = useState("1536");
  const [heightText, setHeightText] = useState("1536");
  const [showMoreRatio, setShowMoreRatio] = useState(false);
  const [denoise, setDenoise] = useState(0.5);
  const [quality, setQuality] = useState<Quality>("medium");
  const [thinking, setThinking] = useState(false);
  const [res, setRes] = useState<Res>("2K");
  // More settings (each shown only for models that support it).
  const [seedText, setSeedText] = useState("");
  const [negative, setNegative] = useState("");
  const [lora, setLora] = useState(2);
  // 用户 2026-11-11 (速度可以选，标准 / 高速): RunningHub workflow models can run on the 48G "plus" machines.
  const [speed, setSpeed] = useState<"standard" | "fast">("standard"); // always 标准 now; the option is hidden
  const chooseSpeed = (v: "standard" | "fast") => {
    setSpeed(v);
    try {
      localStorage.setItem("ais-speed", v);
    } catch {}
  };
  const [background, setBackground] = useState<"auto" | "transparent" | "opaque">("auto");
  const [complexity, setComplexity] = useState<"auto" | "low" | "medium" | "high">("auto");
  // 2026-11-10 (用户: 提示词润色，默认低): rewrite the current prompt; 撤销 brings the old text back.
  // 2026-11-10 (用户: 页面可以切换成自由画布): 单图 / 画布.
  // 2026-11-10 (用户: 提示词反推可选 直接反推 / 先反推到提示词框，默认直接).
  const [reverseMode, setReverseMode] = useState<"direct" | "fill">("direct");
  const [reversing, setReversing] = useState(false);
  const reversedForRef = useRef<string | null>(null);
  const [canvasWant, setCanvasOn] = useState(false);
  // 用户 2026-11-11 (手机不用画布，就简单生图): phones always get the plain single-picture page.
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const set = () => setPhone(mq.matches);
    set();
    mq.addEventListener("change", set);
    return () => mq.removeEventListener("change", set);
  }, []);
  const canvasOn = canvasWant && !phone;
  const canvasOnRef = useRef(false);
  canvasOnRef.current = canvasOn;
  const canvasApi = useRef<BoardApi | null>(null);
  const [canvasScale, setCanvasScale] = useState(1);
  const canvasScaleRef = useRef(1);
  canvasScaleRef.current = canvasScale;
  const [zoomMenu, setZoomMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);
  useEffect(() => {
    if (!moreMenu) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-more-menu]")) setMoreMenu(false);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [moreMenu]);
  // 用户 2026-11-11 (深浅色调节): 浅色 / 深色 / 跟随系统, remembered in this browser.
  const [theme, setTheme] = useState<"light" | "dark" | "auto">("auto"); // 用户 2026-11-11: 默认跟随系统
  useEffect(() => {
    try {
      const t = localStorage.getItem("ais-theme");
      if (t === "dark" || t === "auto" || t === "light") setTheme(t);
    } catch {}
  }, []);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("theme-dark", theme === "dark" || (theme === "auto" && mq.matches));
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
  const chooseTheme = (t: "light" | "dark" | "auto") => {
    setTheme(t);
    try {
      localStorage.setItem("ais-theme", t);
    } catch {}
  };
  const [boardPrefs, setBoardPrefs] = useState({ snap: true, grid: true, lines: true, map: true });
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem("ais-board-prefs") || "null");
      if (v) setBoardPrefs((p) => ({ ...p, ...v }));
    } catch {}
  }, []);
  const setBoardPref = (k: "snap" | "grid" | "lines" | "map", v: boolean) =>
    setBoardPrefs((p) => {
      const next = { ...p, [k]: v };
      try {
        localStorage.setItem("ais-board-prefs", JSON.stringify(next));
      } catch {}
      return next;
    });
  const [boardCompare, setBoardCompare] = useState<{ before: string; after: string } | null>(null);
  useEffect(() => {
    if (!boardCompare) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setBoardCompare(null);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [boardCompare]);
  useEffect(() => {
    if (!zoomMenu) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-zoom-menu]")) setZoomMenu(false);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [zoomMenu]);
  // 2026-11-10 (用户: 画布要能新建 画布1 2 3): several boards per account, kept in this browser.
  const [boards, setBoards] = useState<{ id: string; name: string }[]>([{ id: "1", name: "画布1" }]);
  const [boardId, setBoardId] = useState("1");
  const [boardJobs, setBoardJobs] = useState<BoardJob[]>([]);
  const jobsPlaced = useCallback((done: BoardJob[]) => {
    setBoardJobs((list) => list.filter((job) => !done.includes(job)));
  }, []);
  const placeJobs = useCallback((jobs: PendingJob[], failed = false) => {
    const added = jobs.filter((p) => p.canvasBoard || p.canvasLayout?.frame.node)
      .map((p) => ({ gid: p.taskId, frame: p.canvasLayout?.frame.node, board: p.canvasBoard, failed }));
    if (added.length) setBoardJobs((list) => [...list.filter((j) => !added.some((a) => a.gid === j.gid)), ...added]);
  }, []);
  const [boardMenu, setBoardMenu] = useState(false);
  const [boardDelArm, setBoardDelArm] = useState<string | null>(null);
  const boardMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!boardMenu) return;
    const close = () => { setBoardMenu(false); setBoardDelArm(null); };
    const outside = (e: Event) => { if (!(e.target instanceof Node && boardMenuRef.current?.contains(e.target))) close(); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [boardMenu]);
  // In canvas mode the settings show once pictures are selected (用户: 点击图片之后才显示参数) or on request.
  const [canvasSel, setCanvasSel] = useState<string[]>([]);
  const [editingNode, setEditingNode] = useState("");
  const [multiOnly, setMultiOnly] = useState(false);
  const textSelRef = useRef(false);
  const editPrompt = (value: string) => {
    setPrompt(value);
    if (canvasOnRef.current && textSelRef.current) canvasApi.current?.setText(value);
  };
  const [onBoard, setOnBoard] = useState<Set<string>>(new Set());
  const [composeOpen, setComposeOpen] = useState(false);
  const chipsMore = true; // 用户 2026-11-11 (参数不搞更多了，全部展开，自适应缩放)
  // 2026-11-10 (用户: 参数要紧贴素材): the compose box hugs the selected pictures.
  // The box follows the selection every frame by moving its own style (no page re-render while panning).
  type Box = { left: number; top: number; right: number; bottom: number };
  const selBoxRef = useRef<Box | null>(null);
  const [hugOn, setHugOn] = useState(false);
  const leftColRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLElement>(null);
  const [polishLevel, setPolishLevel] = useState<"low" | "medium" | "high">("low");
  const [polishing, setPolishing] = useState(false);
  const [polishUndo, setPolishUndo] = useState<{ before: string; after: string } | null>(null);
  const [regional, setRegional] = useState(false);
  const [extraRefs, setExtraRefs] = useState<{ file: File; url: string }[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [countOpen, setCountOpen] = useState(false);
  const [openPanel, setOpenPanel] = useState<string | null>(null);
  useEffect(() => {
    if (openPanel !== "model") setMultiOnly(false);
  }, [openPanel]);
  const [panelLeft, setPanelLeft] = useState(0);
  const chipRowRef = useRef<HTMLDivElement>(null);
  const modelPopupRef = useRef<HTMLDivElement>(null);
  const [modelAnchor, setModelAnchor] = useState<React.CSSProperties | null>(null);
  const anchorModel = (trigger: HTMLElement) => {
    const r = trigger.getBoundingClientRect(), w = Math.min(300, window.innerWidth - 16);
    const above = r.top - 16, below = window.innerHeight - r.bottom - 16;
    const up = above >= below;
    setModelAnchor({ left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)), width: w,
      ...(up ? { bottom: window.innerHeight - r.top + 8 } : { top: r.bottom + 8 }),
      maxHeight: Math.max(48, Math.min(window.innerHeight * 0.56, up ? above : below)) });
  };
  const renderSettingPanel = (panel: React.ReactElement) => openPanel === "model" && modelAnchor ? createPortal(panel, document.body) : panel;
  // 用户 2026-11-11 (参数不要两排): the settings row stays on one line and shrinks to fit a narrow box.
  useEffect(() => {
    const row = chipRowRef.current;
    const box = row?.parentElement;
    if (!row || !box) return;
    let raf = 0;
    let lastWidth = -1;
    const fit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const was = row.style.zoom;
        row.style.zoom = "1";
        const room = row.clientWidth;
        const controls = [...row.children].filter((el): el is HTMLElement =>
          el instanceof HTMLElement && getComputedStyle(el).position !== "absolute" && el.offsetWidth > 0);
        const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
        const natural = controls.reduce((width, el) => width + Math.ceil(parseFloat(getComputedStyle(el).width)), 0) +
          Math.max(0, controls.length - 1) * gap;
        if (!room) {
          row.style.zoom = was;
          return;
        }
        const z = Math.min(1, (room - 1) / Math.max(1, natural));
        row.style.zoom = z < 0.995 ? String(z) : "";
      });
    };
    const ro = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === lastWidth) return;
      lastWidth = entry.contentRect.width;
      fit();
    });
    ro.observe(box);
    const mo = new MutationObserver(fit);
    mo.observe(row, { childList: true, subtree: true, characterData: true });
    fit();
    return () => {
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);
  // A setting's menu closes when you click anywhere else.
  useEffect(() => {
    if (!openPanel) return;
    const close = (e: PointerEvent) => {
      const el = e.target as Node;
      if (!chipRowRef.current?.contains(el) && !modelPopupRef.current?.contains(el)) setOpenPanel(null);
    };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpenPanel(null); } };
    const resized = () => setOpenPanel(null);
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", resized);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", resized);
    };
  }, [openPanel]);
  // History is open by default (用户 2026-11-05); fold it to a corner icon any time.
  const [histHidden, setHistHidden] = useState(false);
  const histOff = histHidden && !phone; // phones always list history under the picture
  const toggleHistory = (hide: boolean) => setHistHidden(hide);
  const [histToolsOpen, setHistToolsOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  // Text being typed into the 重绘幅度 number; null while not editing.
  const [denoiseText, setDenoiseText] = useState<string | null>(null);
  const commitDenoise = useCallback((raw: string) => {
    const v = Number(raw);
    if (Number.isFinite(v)) setDenoise(Math.min(1, Math.max(0.01, Math.round(v * 100) / 100)));
    setDenoiseText(null);
  }, []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultRef, setResultRef] = useState<string | null>(null);
  // Every reference of the latest batch (图1, 图2, …) so 对比 can pick which one.
  const [jobRefs, setJobRefs] = useState<string[]>([]);
  const [compareIdx, setCompareIdx] = useState(0);
  const [resultSize, setResultSize] = useState<{ w: number; h: number } | null>(null);
  const [compareOn, setCompareOn] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [histMode, setHistMode] = useState<"all" | Mode>("all");
  // "all" | "ok" | "bad" | "model:<id>"
  const [histFilter, setHistFilter] = useState<string>("all");
  // 2026-11-05 (用户: 筛选里加排序).
  const [histSort, setHistSort] = useState<"new" | "old" | "cost" | "slow">("new");
  /** History card whose full description is unfolded. */
  const [promptOpenId, setPromptOpenId] = useState<string | null>(null);
  /** Height / width of each history picture once loaded, for the two-column layout. */
  const [aspects, setAspects] = useState<Record<string, number>>({});
  const noteAspect = (id: string, el: HTMLImageElement) => {
    if (!el.naturalWidth) return;
    const a = el.naturalHeight / el.naturalWidth;
    setAspects((m) => (Math.abs((m[id] ?? 0) - a) < 0.01 ? m : { ...m, [id]: a }));
  };
  const [histQuery, setHistQuery] = useState("");
  const [histPage, setHistPage] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [count, setCount] = useState(1);
  // Task ids of the latest batch, for the result strip under the preview.
  const [batch, setBatch] = useState<string[]>([]);
  // 2026-11-05 (用户: 多张时出一张就先显示一张): how many of the current batch are done.
  const [batchDone, setBatchDone] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);
  // 2026-11-05 (用户: 多张时并排加载，好一张先显示一张，要极简): pictures in this run, known from the click.
  const [jobCount, setJobCount] = useState(1);
  // 2026-11-05 (用户: 多张生成后并排显示，点开看大图可切换，关掉回到并排): after a batch, the grid first.
  const [batchGrid, setBatchGrid] = useState(false);
  const showingPartial = loading && jobCount <= 1 && batchDone > 0 && batchDone < batchTotal;
  const [editRatio, setEditRatio] = useState("auto");
  const fixedEditAspect = editAspectOf(model, editRatio);
  const [previewAspect, setPreviewAspect] = useState(1);
  // "page": an image is being dragged somewhere over the window; "zone": over the drop area.
  const [dragState, setDragState] = useState<"none" | "page" | "zone">("none");
  // What the loading view shows, captured when the job starts so later edits
  // to the form (a new reference, another ratio) don't change it mid-run.
  const [jobVisual, setJobVisual] = useState<{ aspect: number; reference: string | null }>({
    aspect: 1,
    reference: null,
  });
  const [compareMode, setCompareMode] = useState<CompareMode>("slider");
  const [resultKey, setResultKey] = useState(0);
  const [progress, setProgress] = useState(0);
  const frameTimes = useRef(new Map<string, Timing>());
  const watchedCanvasTasks = useRef(new Set<string>());
  const [frameProgress, setFrameProgress] = useState(new Map<string, number>());
  const paintProgress = useCallback(() => {
    setFrameProgress(new Map([...frameTimes.current].map(([id, t]) => [id, progressFor(t, Date.now())])));
  }, []);
  const hasFrameJobs = frameProgress.size > 0;
  useEffect(() => {
    if (!hasFrameJobs) return;
    const timer = window.setInterval(paintProgress, 400);
    return () => clearInterval(timer);
  }, [hasFrameJobs, paintProgress]);
  const timingRef = useRef<Timing>({
    step: "render",
    stepStart: 0,
    est: { describe: 0, submit: 0, render: DEFAULT_SECONDS.i2i },
    renderKey: "",
  });
  const startStep = useCallback((step: ProgressStep) => {
    const t = timingRef.current;
    const now = Date.now();
    // Learn how long the step that just ended really took.
    if (t.step === "describe" && step !== "describe" && t.stepStart) {
      recordSeconds("describe", (now - t.stepStart) / 1000);
    }
    timingRef.current = { ...t, step, stepStart: now };
  }, []);
  const [money, setMoney] = useState<string | null>(null);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => setMode(preview ? "i2i" : "t2i"), [preview]);
  const [leftPx, setLeftPx] = useState(300);
  const [rightPx, setRightPx] = useState(320);
  const [isDesktop, setIsDesktop] = useState(false);
  const draggingRef = useRef<"left" | "right" | null>(null);

  useEffect(() => {
    const sync = () => {
      const desktop = window.innerWidth >= 1024;
      setIsDesktop(desktop);
      if (desktop) {
        setLeftPx((p) => Math.min(480, Math.max(240, p || Math.round(window.innerWidth * 0.28))));
      }
    };
    // Restore the panel widths the user dragged to last time.
    const savedL = Number(localStorage.getItem(PANEL_LEFT_KEY));
    const savedR = Number(localStorage.getItem(PANEL_RIGHT_KEY));
    if (savedL >= 240 && savedL <= 480) setLeftPx(savedL);
    // 2026-11-05 (用户: 历史默认大一些，还能拉更大): about a third of the window by default, up to all but 420px.
    const maxR = () => Math.max(320, window.innerWidth - 420);
    if (savedR >= 240) setRightPx(Math.min(savedR, maxR()));
    else setRightPx(Math.min(maxR(), Math.max(320, Math.round(window.innerWidth * 0.34))));
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  const fileRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const promptMirrorRef = useRef<HTMLDivElement>(null);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [promptOverflows, setPromptOverflows] = useState(false);
  useEffect(() => { setPromptExpanded(false); }, [editingNode, canvasOn]);
  useEffect(() => {
    const el = promptRef.current;
    if (!el || !canvasOn || !editingNode) return;
    const measure = () => {
      if (!el.clientWidth) return;
      const css = getComputedStyle(el);
      const threeLines = parseFloat(css.lineHeight) * 3 + parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
      setPromptOverflows(el.scrollHeight > Math.ceil(threeLines) + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [prompt, canvasOn, editingNode]);
  const resultRef_ = useRef<HTMLElement>(null);
  const fileBlobRef = useRef<File | null>(null);
  /** A reference still downloading after 重新编辑 (the picture already shows). */
  const refVersion = useRef(0);
  const refLoadRef = useRef<Promise<File[] | null> | null>(null);
  const timerRef = useRef<number | null>(null);

  const jobRef = useRef(0);
  const busyRef = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      jobRef.current++;
    };
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const side = draggingRef.current;
      if (!side) return;
      if (side === "left") {
        const next = Math.min(480, Math.max(240, e.clientX - 8));
        setLeftPx(next);
        localStorage.setItem(PANEL_LEFT_KEY, String(next));
      } else {
        const next = Math.min(Math.max(320, window.innerWidth - 420), Math.max(240, window.innerWidth - e.clientX - 8));
        setRightPx(next);
        localStorage.setItem(PANEL_RIGHT_KEY, String(next));
      }
    };
    const onUp = () => {
      draggingRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  useEffect(() => {
    // 2026-11-06 (用户: 每次刷新默认 LOL 2.36MP V1.1): the last-used model is not restored.
    if (localStorage.getItem(REVERSE_KEY) === "off") setReverse(false);
    if (localStorage.getItem("ais-canvas-on") === "1") {
      setCanvasOn(true);
      setHistHidden(true);
    }
    if (localStorage.getItem("ais-reverse-mode") === "fill") setReverseMode("fill");
    const pl = localStorage.getItem("ais-polish-level-v2");
    setPolishLevel(restoredPolishLevel(pl ?? localStorage.getItem("ais-polish-level"), pl ? 2 : 1));
    const savedCount = Number(localStorage.getItem(COUNT_KEY));
    void savedCount; // 张数 removed 2026-11-10: always one picture per click
    fetchJson("/api/status")
      .then((d) => {
        if (d?.account?.remainMoney != null) setMoney(String(d.account.remainMoney));
        if (Array.isArray(d?.models)) {
          const next: Readiness = {};
          for (const m of d.models) if (m?.id && m?.ready) next[m.id] = m.ready;
          setReadiness(next);
        }
      })
      .catch(() => {});
    // 2026-11-06 (用户: 刷新要等几秒): show the history this browser saw last time at once, then refresh it.
    let fromCache = false;
    const cachedDone = new Set<string>();
    try {
      const cached = JSON.parse(localStorage.getItem(HIST_CACHE_KEY) || "null");
      if (Array.isArray(cached) && cached.length) {
        fromCache = true;
        for (const item of cached) if (item.url || item.status === "failed" || item.status === "expired") cachedDone.add(item.taskId || item.id);
        rememberDirect(cached);
        setGallery(cached);
        const first = (cached as GalleryItem[]).find((x) => x.url);
        if (first && !busyRef.current) showItem(first);
      }
    } catch {}
    const recent = (p: PendingJob) => Date.now() - p.createdAt < 30 * 60_000;
    const localFrames = readPending().filter((p) => p.canvasLayout?.frame.node && recent(p) && !cachedDone.has(p.taskId));
    const earlyIds = new Set(localFrames.map((p) => p.taskId));
    if (localFrames.length) resumePendingRef.current(localFrames);
    fetchJson("/api/history")
      .then((d) => {
        if (d?.ok && Array.isArray(d.items)) {
          try {
            localStorage.setItem(HIST_CACHE_KEY, JSON.stringify(d.items.slice(0, 80)));
          } catch {}
        }
        if (d?.ok && Array.isArray(d.items) && d.items.length) {
          rememberDirect(d.items);
          const remoteIds = new Set(d.items.map((x: GalleryItem) => x.id));
          setGallery((cur) => [...cur.filter((x) => earlyIds.has(x.taskId ?? x.id) && x.url && !remoteIds.has(x.id)), ...d.items]);
          const first = (d.items as GalleryItem[]).find((x) => x.url);
          if (first && !busyRef.current && !fromCache) showItem(first);
        }
        // 2026-11-05 (用户: 刷新后进度没了): the server remembers every submitted task; pick unfinished ones up again.
        const local = readPending();
        const server: PendingJob[] = Array.isArray(d?.running) ? d.running.filter((p: any) => p?.taskId && p?.mode) : [];
        const final = new Map<string, GalleryItem>((d?.items ?? []).map((x: GalleryItem) => [x.taskId || x.id, x]));
        const remaining = local.filter((p) => !final.has(p.taskId) && recent(p));
        for (const p of local) {
          const item = final.get(p.taskId);
          if (item) placeJobs([p], !item.url);
        }
        const all = [...remaining, ...server.filter((p) => !final.has(p.taskId) && !remaining.some((l) => l.taskId === p.taskId))];
        writePending(all);
        if (all.length) {
          resumePendingRef.current?.(all);
        }
      })
      .catch(() => {
        const local = readPending().filter((p) => recent(p) && !cachedDone.has(p.taskId));
        if (local.length) resumePendingRef.current?.(local);
      });
  }, []);

  useEffect(() => {
    if (loading) {
      setProgress(progressFor(timingRef.current, Date.now()));
      timerRef.current = window.setInterval(() => {
        const next = progressFor(timingRef.current, Date.now());
        setProgress((p) => Math.max(p, next)); // never move backwards
      }, 400); // 2026-11-06 (性能): the whole page re-renders on each tick; 2.5×/s is smooth enough for a number
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [loading]);

  // 2026-11-06 (用户: 点历史图预览慢): show the picture the history already loaded at once, then the sharp one.
  const [mainSrc, setMainSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!resultUrl) return setMainSrc(null);
    const big = thumbOf(resultUrl, 1600);
    setMainSrc(thumbOf(resultUrl, isDesktop && rightPx > 620 ? 640 : 320));
    const im = new Image();
    im.onload = () => setMainSrc((cur) => (cur === big ? cur : big));
    im.onerror = () => setMainSrc(big); // let the <img> fall back on its own
    im.src = big;
    return () => {
      im.onload = null;
      im.onerror = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultUrl]);

  const showItem = useCallback((g: GalleryItem) => {
    setBatchGrid(false);
    setCurrentId(g.id);
    setPromptOpen(false);
    setResultUrl(g.url);
    setResultRef(g.mode === "i2i" && g.refUrl ? g.refUrl : null);
    setResultSize(null);
    setResultKey((k) => k + 1);
  }, []);

  // paste image upload — defined after onPickFile
  // A model with a fixed ratio list snaps the size to its first ratio when the current one is not offered.
  useEffect(() => {
    const allowed = paramsOf(model).ratios;
    if (!allowed || paramsOf(model).customSize) return;
    const cur = RATIOS.find((r) => r.w === width && r.h === height);
    if (cur && allowed.includes(cur.label)) return;
    const next = RATIOS.find((r) => r.label === allowed[0]);
    if (next) applyRatioRef.current?.(next.w, next.h);
  }, [model, width, height]);
  const applyRatioRef = useRef<((w: number, h: number) => void) | null>(null);

  const applyRatio = useCallback((w: number, h: number) => {
    const cw = clampRes(w);
    const ch = clampRes(h);
    setWidth(cw);
    setHeight(ch);
    setWidthText(String(cw));
    setHeightText(String(ch));
  }, []);
  applyRatioRef.current = applyRatio;

  const commitWidth = useCallback(() => {
    const v = clampRes(Number(widthText));
    setWidth(v);
    setWidthText(String(v));
  }, [widthText]);

  const commitHeight = useCallback(() => {
    const v = clampRes(Number(heightText));
    setHeight(v);
    setHeightText(String(v));
  }, [heightText]);

  const onPickFile = useCallback((file: File | null) => {
    refVersion.current++;
    refLoadRef.current = null;
    fileBlobRef.current = file;
    setPreview(file ? URL.createObjectURL(file) : null);
  }, []);

  /** The first picture becomes the main reference; more go to the extra references (up to the model's limit). */

  const [mentionOpen, setMentionOpen] = useState(false);
  // 2026-11-06 (用户: @ 的菜单在我 @ 的旁边出来): where the caret is, inside the description box.
  const [mentionAt, setMentionAt] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  /** Inserts "@图N " at the caret in the description. */
  const insertMention = (n: number, replaceAt?: boolean) => {
    const el = promptRef.current;
    const tag = `@图${n} `;
    const start = el?.selectionStart ?? prompt.length;
    const end = el?.selectionEnd ?? prompt.length;
    // When opened by typing "@", replace that "@".
    const from = replaceAt && prompt[start - 1] === "@" ? start - 1 : start;
    const next = prompt.slice(0, from) + tag + prompt.slice(end);
    editPrompt(next);
    setMentionOpen(false);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = from + tag.length;
      el?.setSelectionRange(pos, pos);
    });
  };

  /** Removing the first picture promotes the next one. */
  const removeMainRef = () => {
    const [next, ...others] = extraRefs;
    onPickFile(next ? next.file : null);
    setExtraRefs(others);
  };

  /** Phones stack the panels inside <main>; scroll only that container. */
  const scrollToResult = useCallback(() => {
    const el = resultRef_.current;
    const main = el?.closest("main");
    if (el && main) main.scrollTo({ top: Math.max(0, el.offsetTop - 8), behavior: "smooth" });
  }, []);

  const flash = useCallback((text: string, ms = 2600) => {
    setNotice(text);
    window.setTimeout(() => setNotice((n) => (n === text ? null : n)), ms);
  }, []);

  /**
   * Adds pictures up to what the model takes (2026-11-05 用户: 第二张传不上去要有提示). A one-picture model
   * swaps the picture; a full multi-picture model says how many it takes.
   */
  /** Which picture 换图 replaces (null = add new ones), and the one shown large. */
  const replaceSlot = useRef<number | null>(null);
  const refLimitRef = useRef(1);
  const addRefs = useCallback(
    (files: File[], quiet = false) => {
      if (!files.length) return;
      setReverse(localStorage.getItem(REVERSE_KEY) !== "off");
      const limit = refLimitRef.current;
      if (limit <= 1) {
        onPickFile(files[0]);
        setExtraRefs([]);
        if (!quiet || files.length > 1)
          flash(fileBlobRef.current && files.length >= 1 ? (files.length > 1 ? "这个模型只用 1 张参考图，已用第一张" : "已换成新的参考图") : "已放入参考图");
        return;
      }
      let rest = files;
      if (!fileBlobRef.current) {
        onPickFile(files[0]);
        rest = files.slice(1);
      }
      setExtraRefs((list) => {
        const room = Math.max(0, limit - 1 - list.length);
        if (rest.length > room) flash(`这个模型最多 ${limit} 张参考图，多出的 ${rest.length - room} 张没放进来`);
        return [...list, ...rest.slice(0, room).map((file) => ({ file, url: URL.createObjectURL(file) }))];
      });
    },
    [onPickFile, flash]
  );

  // 2026-11-05 (用户: 刷新后上传的图片没了): reference pictures and the description come back after a reload.
  const draftReady = useRef(false);
  useEffect(() => {
    if (!user || draftReady.current) return;
    loadDraft(user).then((d) => {
      if (d && !fileBlobRef.current) {
        const files = d.images.map((x) => new File([x.blob], x.name || "ref.png", { type: x.blob.type }));
        if (files[0]) onPickFile(files[0]);
        if (files.length > 1) setExtraRefs(files.slice(1).map((file) => ({ file, url: URL.createObjectURL(file) })));
        if (d.prompt) setPrompt((p) => p || d.prompt);
      }
      draftReady.current = true;
    });
  }, [user, onPickFile]);
  useEffect(() => {
    if (!user || !draftReady.current) return;
    const t = window.setTimeout(() => {
      const files = [fileBlobRef.current, ...extraRefs.map((r) => r.file)].filter((f): f is File => !!f);
      saveDraft(user, { prompt, images: files.map((f) => ({ blob: f, name: f.name })) });
    }, 400);
    return () => clearTimeout(t);
  }, [user, prompt, preview, extraRefs]);

  /** 2026-11-05 (用户: 历史加收藏，能筛选找到): star a picture; saved on the server. */
  const toggleFav = useCallback(
    (g: GalleryItem) => {
      const fav = !g.fav;
      setGallery((list) => list.map((x) => (x.id === g.id ? { ...x, fav } : x)));
      fetchJson("/api/history", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: g.id, fav }),
      })
        .then((d) => {
          if (!d?.ok) throw new Error(d?.error);
          flash(fav ? "已收藏" : "已取消收藏");
        })
        .catch(() => {
          setGallery((list) => list.map((x) => (x.id === g.id ? { ...x, fav: !fav } : x)));
          flash("收藏失败，请重试");
        });
    },
    [flash]
  );

  /** 2026-11-06 (用户: 历史加删除): tap the bin, tap again within 3 s to delete. */
  const [deleteArm, setDeleteArm] = useState<string | null>(null);
  const [cardMenu, setCardMenu] = useState<string | null>(null);
  const [cardMenuAt, setCardMenuAt] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  useEffect(() => {
    if (!cardMenu) return;
    const close = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.("[data-card-menu]")) return;
      setCardMenu(null);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [cardMenu]);
  const deleteItem = useCallback(
    (g: GalleryItem) => {
      if (deleteArm !== g.id) {
        setDeleteArm(g.id);
        window.setTimeout(() => setDeleteArm((x) => (x === g.id ? null : x)), 3000);
        return;
      }
      setDeleteArm(null);
      setGallery((list) => list.filter((x) => x.id !== g.id));
      if (currentId === g.id) {
        setResultUrl(null);
        setCurrentId(null);
      }
      fetchJson(`/api/history?id=${encodeURIComponent(g.id)}`, { method: "DELETE" })
        .then((d) => {
          if (!d?.ok) throw new Error(d?.error);
          flash("已删除");
        })
        .catch(() => {
          setGallery((list) => [g, ...list].sort((a, b) => b.createdAt - a.createdAt));
          flash("删除失败，请重试");
        });
    },
    [deleteArm, currentId, flash]
  );
  // 2026-11-06 (用户: 筛选里加批量选择，批量删除或下载).
  const [selMode, setSelMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkArm, setBulkArm] = useState(false);
  const toggleSel = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const endSel = () => {
    setSelMode(false);
    setSelected(new Set());
    setBulkArm(false);
  };
  const bulkDelete = () => {
    if (!bulkArm) {
      setBulkArm(true);
      window.setTimeout(() => setBulkArm(false), 3000);
      return;
    }
    const ids = [...selected];
    const removed = gallery.filter((g) => selected.has(g.id));
    setGallery((list) => list.filter((g) => !selected.has(g.id)));
    if (currentId && selected.has(currentId)) {
      setResultUrl(null);
      setCurrentId(null);
    }
    endSel();
    fetchJson("/api/history", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) })
      .then((d) => {
        if (!d?.ok) throw new Error(d?.error);
        flash(`已删除 ${d.deleted} 张`);
      })
      .catch(() => {
        setGallery((list) => [...removed, ...list].sort((a, b) => b.createdAt - a.createdAt));
        flash("删除失败，请重试");
      });
  };
  const bulkDownload = async () => {
    const list = gallery.filter((g) => selected.has(g.id) && g.url);
    flash(`开始下载 ${list.length} 张`);
    for (const g of list) {
      await downloadItem(g);
      await sleep(350);
    }
  };

  // Full-screen viewer (用户: 点击图片打开查看细节，支持缩放).
  const [viewer, setViewer] = useState<string | null>(null);

  const copyPrompt = useCallback(
    async (g: GalleryItem) => {
      try {
        await navigator.clipboard.writeText(g.prompt);
        flash("提示词已复制");
      } catch {
        flash("复制失败，请手动选择文本");
      }
    },
    [flash]
  );

  const applyEditorDraft = useCallback((v: CanvasDraft) => {
    setModel(v.model);
    setPrompt(v.prompt);
    setDenoise(v.denoise);
    setQuality(v.quality);
    setRes(v.res);
    setSeedText(v.seedText);
    setNegative(v.negative);
    setLora(v.lora);
    setWidth(v.width);
    setHeight(v.height);
    setWidthText(v.widthText);
    setHeightText(v.heightText);
    setPolishLevel(restoredPolishLevel(v.polishLevel, v.polishVersion));
    setThinking(v.thinking);
    setRegional(v.regional);
    setBackground(v.background);
    setComplexity(v.complexity);
    setReverse(v.reverseOn);
    setEditRatio(v.editRatio ?? "auto");
    if (v.reverseMode) setReverseMode(v.reverseMode);
    setPolishUndo(null);
    setError(null);
  }, []);

  const restorePictureParams = useCallback((g: GalleryItem) => {
    if (g.editorDraft) return applyEditorDraft(g.editorDraft);
    const v = pictureParams(g);
    setModel(v.model);
    setPrompt(v.prompt);
    setDenoise(v.denoise);
    setQuality(v.quality);
    setRes(v.res);
    setThinking(v.thinking);
    setRegional(v.regional);
    setBackground(v.background);
    setComplexity(v.complexity);
    setNegative(v.negative);
    setSeedText(v.seedText);
    setLora(v.lora);
    // Older hosted records kept output pixels only; recover the matching editor aspect ratio.
    const p = paramsOf(v.model);
    const ratios = p.customSize ? [] : RATIOS.filter((r) => p.ratios?.includes(r.label));
    const nearest = ratios.sort((a, b) => Math.abs(Math.log((a.w / a.h) / (v.width / v.height))) - Math.abs(Math.log((b.w / b.h) / (v.width / v.height))))[0];
    applyRatio(nearest?.w ?? v.width, nearest?.h ?? v.height);
    setEditRatio(g.settings?.["改图比例"] ?? "auto");
    setReverse(false); // The saved prompt already includes any reverse description.
    setPolishUndo(null);
    setError(null);
  }, [applyRatio, applyEditorDraft]);

  // A selection can change before its files arrive. Only the current selection may fill the form.
  const replaceReferenceUrls = useCallback((urls: string[]) => {
    refVersion.current++;
    refLoadRef.current = null;
    fileBlobRef.current = null;
    setExtraRefs([]);
    setPreview(urls.length ? fullOf(urls[0]) : null);
    setMode(urls.length ? "i2i" : "t2i");
    if (!urls.length) return;
    const loading: Promise<File[] | null> = referenceFiles(urls).then((files) => {
      if (refLoadRef.current !== loading) return files;
      refLoadRef.current = null;
      fileBlobRef.current = files[0];
      setExtraRefs(files.slice(1).map((file, i) => ({ file, url: fullOf(urls[i + 1]) })));
      return files;
    }).catch(() => {
      if (refLoadRef.current === loading) flash("参考图读取失败，请重新打开或替换参考图");
      return null;
    });
    refLoadRef.current = loading;
    return loading;
  }, [flash]);

  const reuseItem = useCallback((g: GalleryItem, refs = pictureRefs(g)) => {
    restorePictureParams(g);
    replaceReferenceUrls(refs);
  }, [restorePictureParams, replaceReferenceUrls]);

  const [requestedEdit, setRequestedEdit] = useState<{ board: string; item: GalleryItem } | null>(null);
  useEffect(() => {
    if (!requestedEdit) return;
    if (!canvasOn || requestedEdit.board !== boardId) { setRequestedEdit(null); return; }
    const board = canvasApi.current;
    if (!board) return;
    board.reedit(requestedEdit.item);
    setRequestedEdit(null);
  }, [requestedEdit, canvasOn, boardId, user]);

  const editHistoryItem = (g: GalleryItem) => {
    setOpenPanel(null);
    setMentionOpen(false);
    if (canvasOnRef.current) {
      setRequestedEdit({ board: boardId, item: g });
    } else {
      reuseItem(g);
      if (g.url) showItem(g);
      setCompareOn(false);
      requestAnimationFrame(() => composeRef.current?.scrollIntoView({ block: "nearest" }));
    }
    const refs = pictureRefs(g);
    if (g.mode === "i2i" && refs.length < Number(g.settings?.["参考图"]?.match(/\d+/)?.[0] || 1)) {
      flash("已还原已保存的参数和参考图；旧记录缺少部分参考图");
    }
  };

  /** Save an image with a readable name (works for our copies and remote links). */
  const downloadItem = useCallback(
    async (g: GalleryItem) => {
      const name = `AI-Studio_${(findModel(g.model)?.name ?? g.label ?? "image").replace(/\s+/g, "-")}_${formatTime(
        g.createdAt
      ).replace(/[: ]/g, "-")}.png`;
      try {
        let href = g.url;
        let revoke = false;
        const direct = DIRECT.get(g.url)?.download;
        if (direct) {
          href = direct;
        } else if (g.url.startsWith("/api/")) {
          href = rawOf(g.url);
        } else {
          const res = await fetch(rawOf(g.url));
          if (!res.ok) throw new Error();
          href = URL.createObjectURL(await res.blob());
          revoke = true;
        }
        const a = document.createElement("a");
        a.href = href;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        if (revoke) window.setTimeout(() => URL.revokeObjectURL(href), 4000);
      } catch {
        flash("下载失败，请稍后重试");
      }
    },
    [flash]
  );

  const useAsReference = useCallback(
    async (g: GalleryItem) => {
      try {
        if (canvasOnRef.current && canvasApi.current) return canvasApi.current.attachHistory(g.id);
        const res = await fetch(rawOf(g.url));
        if (!res.ok) throw new Error();
        const blob = await res.blob();
        const ext = blob.type.includes("png") ? "png" : "jpg";
        onPickFile(new File([blob], `result-${g.id}.${ext}`, { type: blob.type || "image/png" }));
        setMode("i2i");
        flash("已设为参考图");
      } catch {
        flash("图片读取失败，请稍后重试");
      }
    },
    [flash, onPickFile]
  );

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      if (!data || e.defaultPrevented) return;
      const target = e.target;
      const editingText = target instanceof HTMLElement && (target.matches("input,textarea,select") || target.isContentEditable);
      if (canvasOnRef.current && !editingText && canvasApi.current?.pasteNodes(data)) {
        e.preventDefault();
        return;
      }
      if (editingText && data.getData("text/plain")) return;
      const files = data.files;
      if (!files || !files.length) return;
      const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (!images.length) return;
      // On the board a pasted picture becomes a new picture there (用户 2026-11-10), not the reference.
      if (canvasOnRef.current && canvasApi.current) {
        e.preventDefault();
        canvasApi.current.paste(images);
        return;
      }
      addRefs([images[0]]);
    };
    window.addEventListener("paste", onPaste);
    let depth = 0;
    // Files from the computer, or a picture dragged from history (its id rides along).
    const hasFiles = (e: DragEvent) => {
      const t = Array.from(e.dataTransfer?.types ?? []);
      return t.includes("Files") || t.includes(HIST_DRAG);
    };
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragState((d) => (d === "zone" ? d : "page"));
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragState("none");
    };
    const onEnd = () => {
      depth = 0;
      setDragState("none");
    };
    // Dropping outside the zone must not navigate the tab to the image.
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onEnd, true);
    window.addEventListener("dragend", onEnd, true);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onEnd, true);
      window.removeEventListener("dragend", onEnd, true);
    };
  }, [addRefs]);

  const pollTask = useCallback(async (taskId: string, job: number | null) => {
    const start = Date.now();
    let failures = 0;
    while (mounted.current && (job === null || jobRef.current === job)) {
      if (Date.now() - start > 600_000) {
        throw new Error("生成超时，请稍后重试");
      }
      let d: any;
      try {
        d = await fetchJson(`/api/task?taskId=${encodeURIComponent(taskId)}`);
      } catch (e) {
        if ((job !== null && jobRef.current !== job)) return null;
        if (++failures >= 8) throw e;
        await sleep(2000);
        continue;
      }
      if ((job !== null && jobRef.current !== job)) return null;
      if (!d?.ok) {
        if (++failures >= 8) throw new Error(d?.error || "查询任务失败");
        await sleep(2000);
        continue;
      }
      failures = 0;
      const st = String(d.status || "").toUpperCase();
      if (st === "SUCCESS" && d.outputs?.length) return d;
      if (st === "FAILED" || st === "CANCEL") {
        // A finished-but-failed task must not be resumed by the next click.
        dropPending(taskId);
        throw new Error(d.error || "任务失败");
      }
      await sleep(3000);
    }
    return null;
  }, []);

  /** Wait for one task, then show (first of the batch only) and record it. */
  const finishPending = useCallback(
    async (pending: PendingJob, job: number | null, shown: { v: boolean }): Promise<GalleryItem | null> => {
      const done = await pollTask(pending.taskId, job);
      if (!mounted.current || done === null || (job !== null && jobRef.current !== job)) return null;
      const url = done.outputs?.[0];
      if (!url) throw new Error(done.error || "任务完成但未返回图片");
      const item: GalleryItem = {
        id: pending.taskId,
        taskId: pending.taskId,
        seed: pending.seed,
        mode: pending.mode,
        model: pending.model,
        prompt: pending.prompt,
        url,
        refUrl: pending.refUrl, refUrls: pending.refUrls, settings: pending.settings, canvasLayout: pending.canvasLayout, editorDraft: pending.editorDraft,
        cost: done.cost || null,
        createdAt: pending.createdAt,
        durationMs: Date.now() - (pending.startedAt ?? pending.createdAt),
      };
      setGallery((g) => [item, ...g.filter((x) => x.taskId !== item.taskId && x.url !== item.url)].sort(
        (a, b) => b.createdAt - a.createdAt
      ));
      if (job !== null) setBatchDone((n) => n + 1);
      if (job !== null && !shown.v) {
        shown.v = true;
        showItem(item);
        setDetailOpen(false);
      }
      dropPending(pending.taskId);
      // Saved in the background so the finished picture shows at once.
      fetchJson("/api/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
      })
        .then((saved) => {
          if (saved?.item) rememberDirect([saved.item]);
          // The server keeps a permanent copy; point history at it.
          const kept = saved?.item?.url;
          if (typeof kept === "string" && kept) {
            setGallery((g) => g.map((x) => (x.id === item.id ? { ...x, ...saved.item, url: kept } : x)));
          }
        })
        .catch(() => {});
      return item;
    },
    [pollTask, showItem]
  );

  /** Run a whole batch in parallel; errors only surface if every image failed. */
  const finishBatch = useCallback(
    async (pendings: PendingJob[], job: number) => {
      placeJobs(pendings);
      setBatch(pendings.map((p) => p.taskId));
      setBatchTotal(pendings.length);
      setBatchDone(0);
      const shown = { v: false };
      const results = await Promise.allSettled(pendings.map((p) => finishPending(p, job, shown)));
      if (jobRef.current !== job) return;
      const t = timingRef.current;
      if (t.step === "render" && t.renderKey && t.stepStart) {
        recordSeconds(t.renderKey, (Date.now() - t.stepStart) / 1000);
      }
      setProgress(100);
      if (pendings.length > 1) setBatchGrid(true);
      fetchJson("/api/status")
        .then((d) => {
          if (d?.account?.remainMoney != null) setMoney(String(d.account.remainMoney));
        })
        .catch(() => {});
      placeJobs(pendings.filter((_, i) => results[i].status === "rejected"), true);
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed.length === results.length) throw failed[0].reason;
      if (failed.length) {
        setError(`${failed.length} 张没有生成成功：${failed[0].reason?.message || "任务失败"}`);
      }
    },
    [finishPending, placeJobs]
  );

  const resumePending = useCallback((jobs: PendingJob[]) => {
    for (const p of jobs) {
      const frame = p.canvasLayout?.frame.node;
      if (!frame || watchedCanvasTasks.current.has(p.taskId)) continue;
      watchedCanvasTasks.current.add(p.taskId);
      const renderKey = `${p.model ?? "brown-dust"}:${p.mode}`;
      const timing: Timing = p.renderTiming ?? {
        step: "render", stepStart: p.createdAt, renderKey,
        est: { describe: 0, submit: 0, render: estimateSeconds(renderKey, DEFAULT_SECONDS[p.mode]) },
      };
      frameTimes.current.set(frame, timing);
      paintProgress();
      placeJobs([p]);
      void finishPending(p, null, { v: true }).catch((error) => {
        placeJobs([p], true);
        setError(error?.message || "查询任务失败");
      }).finally(() => {
        if (frameTimes.current.get(frame) === timing) frameTimes.current.delete(frame);
        if (mounted.current) paintProgress();
      });
    }
    const pendings = jobs.filter((p) => !p.canvasLayout?.frame.node);
    if (busyRef.current || !pendings.length) return;
    busyRef.current = true;
    const job = ++jobRef.current;
    const first = pendings[0];
    const renderKey = `${first.model ?? "brown-dust"}:${first.mode}`;
    let saved: { ids?: string[]; t?: Timing; aspect?: number } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(TIMING_KEY) || "null");
    } catch {}
    timingRef.current =
      saved?.t && saved.ids?.includes(first.taskId)
        ? { ...saved.t, renderKey: "" } // same bar as before the reload; resumed runs don't teach the estimate
        : {
            step: "render",
            stepStart: first.createdAt || Date.now(),
            est: { describe: 0, submit: 0, render: estimateSeconds(renderKey, DEFAULT_SECONDS[first.mode]) },
            renderKey: "",
          };
    setJobVisual({ aspect: saved?.aspect && saved.ids?.includes(first.taskId) ? saved.aspect : 1, reference: first.mode === "i2i" ? first.refUrl ?? null : null });
    setJobCount(pendings.length);
    setLoading(true);
    setError(null);
    finishBatch(pendings, job)
      .catch((e: any) => {
        if (jobRef.current !== job) return;
        const message = e?.message || "查询任务失败";
        setError(`${message}（刷新页面可继续查询）`);
        if (/任务失败|已完成但未返回|不存在|错误码|审核/.test(message)) pendings.forEach((p) => dropPending(p.taskId));
      })
      .finally(() => {
        if (jobRef.current === job) {
          busyRef.current = false;
          setLoading(false);
        }
      });
  }, [finishBatch, finishPending, paintProgress, placeJobs]);

  /** 高清放大 (用户 2026-11-10): Topaz 2× through Krea; the result lands in history and on the board like any picture. */
  const upscaleItem = useCallback(
    async (gid: string) => {
      if (busyRef.current) {
        setError("等当前这张生成完再放大");
        return;
      }
      const g = gallery.find((x) => x.id === gid);
      const id = g?.url?.match(/\/api\/img\/([0-9A-Za-z_-]+)/)?.[1];
      if (!g || !id) {
        setError("这张图暂时不能放大");
        return;
      }
      const canvasBoard = canvasOnRef.current ? boardId : undefined;
      const canvasLayout = canvasBoard ? canvasApi.current?.layout() : undefined;
      try {
        const d = await fetchJson("/api/upscale", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        if (!d?.ok || !d.taskId) throw new Error(d?.error || "高清放大失败");
        const now = Date.now();
        const p: PendingJob = { canvasBoard, canvasLayout, taskId: d.taskId, mode: g.mode, model: g.model as ModelId | undefined, prompt: g.prompt, createdAt: now, startedAt: now };
        addPending([p]);
        resumePending([p]);
      } catch (e: any) {
        setError(e?.message || "高清放大失败");
      }
    },
    [gallery, resumePending, boardId]
  );

  const resumePendingRef = useRef(resumePending);
  resumePendingRef.current = resumePending;

  const editorMode = mode;
  const generate = useCallback(async (target?: RunFrame, urls: string[] = []) => {
    const editorDraft = target?.draft ?? { ...composeSnapRef.current, summary: liveSummaryRef.current };
    const { model, prompt, res, quality, thinking, widthText, heightText, width, height, denoise, regional } = editorDraft;
    const mode = target ? (urls.length ? "i2i" : "t2i") : editorMode;
    const reverse = editorDraft.reverseOn && !findModel(model)?.billing;
    const editRatio = editorDraft.editRatio ?? "auto";
    const fixedEditAspect = editAspectOf(model, editRatio);
    const canvasBoard = target || canvasOnRef.current ? boardId : undefined;
    const hasFrame = !!target || !!(canvasBoard && canvasApi.current?.layout()?.frame.node);
    if (!hasFrame && busyRef.current) return;
    const leftover = hasFrame ? [] : readPending().filter((p) => !p.canvasLayout?.frame.node);
    if (leftover.length) { resumePending(leftover); return; }
    setError(null);
    if ((mode === "t2i" || !reverse) && !prompt.trim()) { setError("请先输入描述"); return; }
    if (readiness && !readiness[model]?.[mode]) {
      setError(`${findModel(model)?.name ?? "该模型"}还在接入中，请先选择其他模型`);
      return;
    }
    const refAtClick = refVersion.current, loadingRefs = target ? null : refLoadRef.current;
    const firstFile = target ? null : fileBlobRef.current, extraFiles = target ? [] : extraRefs.map((r) => r.file);
    if (!target && mode === "i2i" && !loadingRefs && !firstFile) { setError("请先上传参考图"); return; }
    if (target && frameTimes.current.has(target.id)) return;
    const canvasLayout = target?.layout ?? (hasFrame ? canvasApi.current?.startFrame(new Set(frameTimes.current.keys()),
      editorDraft, preview ? previewAspect : undefined) : undefined);
    const frameId = canvasLayout?.frame.node;
    const job = frameId ? null : ++jobRef.current;
    if (!frameId) busyRef.current = true;
    const clickedAt = Date.now();
    const useReverse = mode === "i2i" && reverse && (!!target || reversedForRef.current !== preview);
    const renderKey = `${model}:${mode}`;
    let timing: Timing = {
      step: useReverse ? "describe" : "submit", stepStart: clickedAt,
      est: { describe: useReverse ? estimateSeconds("describe", DEFAULT_SECONDS.describe) : 0,
        submit: DEFAULT_SECONDS.submit, render: estimateSeconds(renderKey, DEFAULT_SECONDS[mode]) }, renderKey,
    };
    const step = (s: ProgressStep) => {
      if (!frameId) return startStep(s);
      timing = { ...timing, step: s, stepStart: Date.now() };
      frameTimes.current.set(frameId, timing); paintProgress();
    };
    if (frameId) { frameTimes.current.set(frameId, timing); paintProgress(); }
    else {
      timingRef.current = timing;
      setJobVisual({
        aspect: mode === "i2i" && preview ? fixedEditAspect ?? previewAspect : width / height,
        reference: mode === "i2i" ? preview : null,
      });
      setJobRefs(mode === "i2i" && preview ? [preview, ...extraRefs.map((r) => r.url)] : []);
      setCompareIdx(0);
      setLoading(true);
      // On phones the result sits below the form: bring it into view.
      if (window.innerWidth < 1024) {
        window.setTimeout(scrollToResult, 60);
      }
      setResultUrl(null);
      setBatch([]);
      setJobCount(count);
      setResultRef(null);
      setResultSize(null);
    }
    try {
      const restored = target ? await referenceFiles(urls.slice(0, paramsOf(model).maxRefs ?? 1)) : loadingRefs ? await loadingRefs : undefined;
      if (restored === null || (!frameId && refVersion.current !== refAtClick)) {
        if (frameId) throw new Error("参考图读取失败，请重新选择");
        return;
      }
      const imageFile = restored?.[0] ?? firstFile;
      const supplemental = restored ? restored.slice(1) : extraFiles;
      let data: any;
      const userPrompt = prompt.trim();
      let finalPrompt = userPrompt;
      if (useReverse) {
        // Reverse a prompt from the reference first; the user's text is kept as an extra request.
        try {
          const fd = new FormData();
          fd.append("image", await describeCopy(imageFile as File), "reference.jpg");
          const described = await fetchJson("/api/describe", { method: "POST", body: fd });
          if (!described?.ok || !described?.prompt) {
            throw new Error(described?.error || "提示词反推失败");
          }
          finalPrompt = [String(described.prompt).trim(), userPrompt].filter(Boolean).join("\n");
        } catch (e: any) {
          if (!userPrompt) throw new Error(`${e?.message || "提示词反推失败"}，请手动填写描述后重试`);
        }
        if (!mounted.current || (job !== null && jobRef.current !== job)) return;
        step("submit");
      }
      if (mode === "t2i") {
        data = await fetchJson("/api/generate/t2i", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: finalPrompt, canvasLayout, editorDraft,
            editorWidth: clampRes(Number(widthText) || width), editorHeight: clampRes(Number(heightText) || height),
            model,
            count: frameId ? 1 : count,
            ...sizeFor(model, res, clampRes(Number(widthText) || width) / clampRes(Number(heightText) || height), {
              width: clampRes(Number(widthText) || width),
              height: clampRes(Number(heightText) || height),
            }),
            res,
            quality,
            thinking: thinking && !!paramsOf(model).thinking,
            speed: paramsOf(model).denoise ? speed : undefined,
            ...advanced(editorDraft),
          }),
        });
      } else {
        const fd = new FormData();
        fd.append("prompt", finalPrompt);
        fd.append("editorDraft", JSON.stringify(editorDraft));
        if (canvasLayout) fd.append("canvasLayout", JSON.stringify(canvasLayout));
        if (finalPrompt !== userPrompt) {
          fd.append("optimized", "1");
          if (userPrompt) fd.append("userPrompt", userPrompt);
        }
        fd.append("model", model);
        fd.append("count", String(frameId ? 1 : count));
        fd.append("image", await prepareReferenceImage(imageFile as File));
        fd.append("denoise", String(denoise));
        if (paramsOf(model).denoise && speed === "fast") fd.append("speed", "fast");
        fd.append("quality", quality);
        fd.append("res", res);
        if (paramsOf(model).editRatio) fd.append("editRatio", fixedEditAspect ? editRatio : "auto");
        if (paramsOf(model).pricePerMegapixel) {
          const sz = sizeFor(model, res, fixedEditAspect ?? (target ? target.aspect || 1 : previewAspect || 1));
          fd.append("width", String(sz.width));
          fd.append("height", String(sz.height));
        }
        if (thinking && paramsOf(model).thinking) fd.append("thinking", "1");
        for (const [k, v] of Object.entries(advanced(editorDraft))) fd.append(k, String(v));
        if (regional && paramsOf(model).regional) fd.append("regional", "1");
        for (const f of supplemental.slice(0, (paramsOf(model).maxRefs ?? 1) - 1)) fd.append("ref", await describeCopy(f), "ref.jpg");
        data = await fetchJson("/api/generate/i2i", { method: "POST", body: fd });
      }
      if (!mounted.current || (job !== null && jobRef.current !== job)) return;
      if (!data?.ok || !data?.taskId) {
        throw new Error(data?.error || "任务创建失败");
      }
      step("render");
      const created: { taskId: string; seed?: number }[] =
        Array.isArray(data.tasks) && data.tasks.length
          ? data.tasks
          : [{ taskId: String(data.taskId), seed: data.seed }];
      const now = Date.now();
      const pendings: PendingJob[] = created.map((t, i) => ({
        taskId: String(t.taskId),
        seed: t.seed,
        mode,
        model,
        prompt: finalPrompt,
        refUrl: typeof data.refUrl === "string" ? data.refUrl : undefined,
        refUrls: data.refUrls, settings: data.settings, canvasLayout: canvasLayout ?? data.canvasLayout, canvasBoard, editorDraft,
        createdAt: now + i,
        startedAt: clickedAt,
        renderTiming: frameId ? timing : undefined,
      }));
      addPending(pendings);
      if (frameId) {
        for (const p of pendings) watchedCanvasTasks.current.add(p.taskId);
        placeJobs(pendings);
        try {
          const [item] = await Promise.all(pendings.map((p) => finishPending(p, null, { v: true })));
          recordSeconds(renderKey, (Date.now() - timing.stepStart) / 1000);
          void fetchJson("/api/status").then((d) => { if (d?.account?.remainMoney != null) setMoney(String(d.account.remainMoney)); }).catch(() => {});
          return item?.url;
        } catch (error) { placeJobs(pendings, true); throw error; }
      }
      try {
        localStorage.setItem(TIMING_KEY, JSON.stringify({ ids: pendings.map((p) => p.taskId), t: timingRef.current, aspect: mode === "i2i" && preview ? previewAspect : width / height }));
      } catch {}
      await finishBatch(pendings, job!);
    } catch (e: any) {
      if (mounted.current && (frameId || jobRef.current === job)) {
        setError(e?.message || "网络错误");
      }
    } finally {
      if (frameId) { frameTimes.current.delete(frameId); if (mounted.current) paintProgress(); }
      else if (jobRef.current === job) {
        busyRef.current = false;
        setLoading(false);
      }
    }
  }, [editorMode, readiness, preview, previewAspect, startStep, count, extraRefs, finishBatch, resumePending, boardId, placeJobs, paintProgress, finishPending]);

  // 2026-11-05 (用户: 生成时能继续排队): clicks while a picture is being made wait in line and run next,
  // with the settings on screen at that moment.
  const [queued, setQueued] = useState(0);
  /** 先反推到提示词框: describe the reference into the box; the next 生成 uses the box as it is. */
  const reverseToBox = async () => {
    const file = fileBlobRef.current;
    if (!file || reversing) return;
    setReversing(true);
    try {
      const fd = new FormData();
      fd.append("image", await describeCopy(file), "reference.jpg");
      const described = await fetchJson("/api/describe", { method: "POST", body: fd });
      if (!described?.ok || !described?.prompt) throw new Error(described?.error || "提示词反推失败");
      const mine = prompt.trim();
      editPrompt([String(described.prompt).trim(), mine].filter(Boolean).join("\n"));
      reversedForRef.current = preview;
      flash("已反推到提示词框，改好后再点生成");
    } catch (e: any) {
      flash(e?.message || "提示词反推失败");
    } finally {
      setReversing(false);
    }
  };

  const startOrQueueRef = useRef<() => void>(() => {});
  const startOrQueue = () => {
    if (mode === "i2i" && reverse && reverseMode === "fill" && preview && reversedForRef.current !== preview && !busyRef.current) {
      reverseToBox();
      return;
    }
    if (busyRef.current && !(canvasOnRef.current && canvasApi.current?.layout()?.frame.node)) {
      setQueued((n) => Math.min(9, n + 1));
      flash("已排队，这张画完就开始");
      return;
    }
    generate();
  };
  startOrQueueRef.current = startOrQueue;
  useEffect(() => {
    if (!loading && queued > 0 && !busyRef.current) {
      setQueued((n) => n - 1);
      generate();
    }
  }, [loading, queued, generate]);

  // Estimated price: median real cost of recent images from the same model
  // and mode (falls back to any recent image, then a default), times the count.
  const btnPrice = (() => {
    const costs = (pick: (g: GalleryItem) => boolean) =>
      gallery
        .filter((g) => g.url && Number(g.cost) > 0 && pick(g))
        .slice(0, 15)
        .map((g) => Number(g.cost))
        .sort((a, b) => a - b);
    const p = paramsOf(model);
    const tier = p.resolutions?.[res];
    const base = p.pricePerMegapixel ? (p.quality?.[quality] ?? 0) * (tier ?? 1) : tier ?? p.quality?.[quality];
    const refsUsed = mode === "i2i" ? Math.min(p.maxRefs ?? 1, (preview ? 1 : 0) + extraRefs.length) : 0;
    const fixed = base != null ? base + (thinking && p.thinking ? p.thinking : 0) + (p.refPrice ?? 0) * refsUsed : findModel(model)?.price;
    if (fixed) {
      const total = fixed * count;
      return total >= 1 ? total.toFixed(2) : total.toFixed(3).replace(/0$/, "");
    }
    let list = costs((g) => (g.model ?? "brown-dust") === model && g.mode === mode && !findModel(g.model)?.price);
    if (!list.length) list = costs((g) => !findModel(g.model)?.price);
    const each = (list.length ? list[Math.floor(list.length / 2)] : Number(EST_COST)) * (p.denoise && speed === "fast" ? SPEED_PRICE_X : 1);
    const total = each * count;
    return total >= 1 ? total.toFixed(2) : total.toFixed(3).replace(/0$/, "");
  })();
  const currentItem = gallery.find((g) => g.id === currentId) ?? null;
  const modelParams = paramsOf(model);
  refLimitRef.current = modelParams.maxRefs ?? 1;
  /** References this result can be compared with: the whole batch's pictures, or the saved one from history. */
  const compareRefs = currentId && batch.includes(currentId) && jobRefs.length ? jobRefs : currentItem ? pictureRefs(currentItem) : resultRef ? [resultRef] : [];
  useEffect(() => {
    if (!user) return;
    try {
      const raw = localStorage.getItem(`ais-canvas-boards:${user}`);
      const list = raw ? JSON.parse(raw) : null;
      if (Array.isArray(list) && list.length) setBoards(list);
      const cur = localStorage.getItem(`ais-canvas-current:${user}`);
      if (cur) setBoardId(cur);
    } catch {}
    // 用户 2026-11-11 (云端保存): the board list on the server wins; a first visit uploads this browser's list.
    let alive = true;
    fetchJson("/api/canvas")
      .then((d) => {
        if (!alive) return;
        const idx = d?.index;
        if (idx && Array.isArray(idx.boards) && idx.boards.length) {
          importShare(idx.boards);
          setBoards(idx.boards);
          setBoardId(idx.current || idx.boards[0].id);
          try {
            localStorage.setItem(`ais-canvas-boards:${user}`, JSON.stringify(idx.boards));
            localStorage.setItem(`ais-canvas-current:${user}`, idx.current || idx.boards[0].id);
          } catch {}
        } else {
          let list = [{ id: "1", name: "画布1" }];
          let cur = "1";
          try {
            const raw = JSON.parse(localStorage.getItem(`ais-canvas-boards:${user}`) || "null");
            if (Array.isArray(raw) && raw.length) list = raw;
            cur = localStorage.getItem(`ais-canvas-current:${user}`) || list[0].id;
          } catch {}
          pushBoardIndex(list, cur);
          importShare(list);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [user]);
  /** 用户 2026-11-11 (分享画布): a link to a copy of the board on screen. */
  const shareBoard = async (onlySelected?: boolean) => {
    const snap = canvasApi.current?.snapshot(onlySelected);
    if (!snap) return flash("还有图片在上传，稍等几秒再分享");
    if (!snap.nodes.length) return flash("画布是空的");
    // 用户 2026-11-11 (点了要提示复制成功没有): say at once that it is working, then clearly whether it was copied.
    flash("正在生成分享口令…", 15000);
    try {
      const d = await fetchJson("/api/canvas/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...snap, view: onlySelected ? null : snap.view, name: (boards.find((b) => b.id === boardId)?.name ?? "画布") + (onlySelected ? "（部分）" : "") }),
      });
      if (!d?.ok || !d.token) throw new Error(d?.error || "分享失败");
      try {
        await navigator.clipboard.writeText(d.token);
        flash(`✓ 已复制分享口令 ${d.token}，发给朋友在画布里粘贴就行（7 天有效）`, 5000);
      } catch {
        setNotice(null);
        window.prompt("没能自动复制，请手动复制这个口令（7 天有效）", d.token);
      }
    } catch (e: any) {
      flash(e?.message || "分享失败");
    }
  };
  /** Opening ?share=… puts a copy of that board into this account's list and opens it. */
  const importShare = async (list: { id: string; name: string }[]) => {
    const t = new URLSearchParams(location.search).get("share");
    if (!t) return;
    history.replaceState(null, "", location.pathname);
    try {
      const d = await fetchJson(`/api/canvas/share?t=${encodeURIComponent(t)}`);
      if (!d?.ok) throw new Error(d?.error || "打不开这个分享");
      const id = Math.random().toString(36).slice(2, 8);
      const name = `${String(d.name || "画布").slice(0, 10)}·${String(d.owner || "").slice(0, 8)}`.slice(0, 20);
      const now = Date.now();
      const ns: any[] = d.nodes ?? [];
      let view = d.view;
      if (!view && ns.length) {
        // A shared part has no view of its own: frame its pictures.
        const x0 = Math.min(...ns.map((n) => n.x)), y0 = Math.min(...ns.map((n) => n.y));
        const x1 = Math.max(...ns.map((n) => n.x + n.w)), y1 = Math.max(...ns.map((n) => n.y + n.h));
        const W = window.innerWidth, H = window.innerHeight;
        const sc = Math.max(0.1, Math.min(1.5, (W - 200) / Math.max(1, x1 - x0), (H - 220) / Math.max(1, y1 - y0)));
        view = { s: sc, x: W / 2 - ((x0 + x1) / 2) * sc, y: H / 2 - ((y0 + y1) / 2) * sc };
      }
      const board = { nodes: ns, view: view ?? { x: 400, y: 300, s: 1 }, updatedAt: now };
      try {
        localStorage.setItem(id === "1" ? `ais-canvas-v1:${user}` : `ais-canvas-v1:${user}:${id}`, JSON.stringify(board));
      } catch {}
      await fetchJson(`/api/canvas/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(board) }).catch(() => {});
      saveBoards([...list, { id, name }], id);
      setCanvasOn(true);
      try {
        localStorage.setItem("ais-canvas-on", "1");
      } catch {}
      flash(phone ? `已放进你的画布「${name}」，在电脑上打开就能编辑` : `已放进你的画布「${name}」，可以接着改了`);
    } catch (e: any) {
      flash(e?.message || "打不开这个分享");
    }
  };
  const pushBoardIndex = (list: { id: string; name: string }[], current: string) => {
    fetchJson("/api/canvas", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boards: list, current, updatedAt: Date.now() }),
    }).catch(() => {});
  };
  const saveBoards = (list: { id: string; name: string }[], current: string) => {
    setBoards(list);
    setBoardId(current);
    try {
      localStorage.setItem(`ais-canvas-boards:${user}`, JSON.stringify(list));
      localStorage.setItem(`ais-canvas-current:${user}`, current);
    } catch {}
    pushBoardIndex(list, current);
  };
  const boardKey = (id: string) => (id === "1" ? `ais-canvas-v1:${user}` : `ais-canvas-v1:${user}:${id}`);
  const newBoard = () => {
    let n = boards.length + 1;
    while (boards.some((b) => b.name === `画布${n}`)) n++;
    const b = { id: Math.random().toString(36).slice(2, 8), name: `画布${n}` };
    saveBoards([...boards, b], b.id);
    setBoardMenu(false);
  };
  const renameBoard = (id: string) => {
    const b = boards.find((x) => x.id === id);
    const name = window.prompt("画布名字", b?.name ?? "")?.trim();
    if (!name) return;
    saveBoards(boards.map((x) => (x.id === id ? { ...x, name: name.slice(0, 20) } : x)), boardId);
  };
  const deleteBoard = (id: string) => {
    if (boards.length <= 1) return flash("至少要留一个画布");
    if (boardDelArm !== id) return setBoardDelArm(id);
    try { localStorage.removeItem(boardKey(id)); } catch {}
    fetch(`/api/canvas/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    const rest = boards.filter((x) => x.id !== id);
    saveBoards(rest, boardId === id ? rest[0].id : boardId);
    setBoardDelArm(null);
  };
  // 2026-11-10 (用户: 点击画布后，已有的输入自动变成画布上的节点): the current references and result follow onto the board.
  const pendingImport = useRef<{ refs: string[]; result: string | null } | null>(null);
  const enterCanvas = async (on: boolean) => {
    if (on) {
      const files = [fileBlobRef.current, ...extraRefs.map((r) => r.file)].filter((f): f is File => !!f);
      const refs = (await Promise.all(files.map((f) => fileToDataUrl(f).catch(() => null)))).filter((u): u is string => !!u);
      const result = resultUrl && currentId ? currentId : null;
      pendingImport.current = refs.length || result ? { refs, result } : null;
    }
    setCanvasOn(on);
    try { localStorage.setItem("ais-canvas-on", on ? "1" : "0"); } catch {}
    // 2026-11-10 (用户: 进入画布全屏，历史默认收起；回到单图历史也回来).
    toggleHistory(on);
  };
  useEffect(() => {
    if (!canvasOn || !pendingImport.current) return;
    let tries = 0;
    const t = setInterval(() => {
      const api = canvasApi.current;
      if (api || ++tries > 40) {
        clearInterval(t);
        const job = pendingImport.current;
        pendingImport.current = null;
        if (api && job) api.importSet(job.refs, job.result);
      }
    }, 50);
    return () => clearInterval(t);
  }, [canvasOn]);
  // Selected pictures become the references (in canvas mode only).
  // 用户 2026-11-11 (每个图片点进去的编辑是独立的): each picture (or group of pictures) on the board keeps its own
  // description and settings; a picture opened for the first time starts clean instead of reusing the last one's.
  const composeSnap: CanvasDraft = { prompt, model, denoise, quality, res, seedText, negative, lora, width, height, widthText, heightText, polishLevel, polishVersion: 2, editRatio, thinking, regional, background, complexity, reverseOn, reverseMode, summary: "" };
  const composeSnapRef = useRef(composeSnap);
  composeSnapRef.current = composeSnap;
  const composeMem = useRef(new Map<string, typeof composeSnap>());
  const composeKey = useRef("");
  const liveSummaryRef = useRef("");
  const switchCompose = (key: string, editOf?: string, restore = false, draft?: CanvasDraft) => {
    if (key === composeKey.current && !restore) return;
    composeMem.current.set(composeKey.current, { ...composeSnapRef.current, summary: liveSummaryRef.current });
    composeKey.current = key;
    const remembered = composeMem.current.get(key) ?? draft;
    const original = editOf && (restore || !remembered) ? gallery.find((g) => g.id === editOf) : undefined;
    if (original) return restorePictureParams(original);
    const cur = composeSnapRef.current;
    const v = remembered ?? { ...cur, prompt: "", denoise: 0.5, seedText: "", negative: "", lora: 2 };
    applyEditorDraft(v);
  };
  const switchComposeRef = useRef(switchCompose);
  switchComposeRef.current = switchCompose;
  const onBoardSelection = useCallback(
    (urls: string[], nodeKey?: string, frame?: boolean, editOf?: string, restore?: boolean, draft?: CanvasDraft) => {
      if (!canvasOnRef.current) return;
      const key = frame ? nodeKey ?? "" : "";
      switchComposeRef.current(key, editOf, restore, draft);
      setEditingNode(key);
      setCanvasSel(urls);
      setComposeOpen(false);
      replaceReferenceUrls(urls);
    },
    [replaceReferenceUrls]
  );

  const boardSources = useMemo(
    () =>
      new Map<string, BoardSource>(
        gallery.map((g) => {
          const m = findModel(g.model);
          return [g.id, { id: g.id, recipe: g, url: g.url, status: g.status, prompt: g.prompt, model: m?.name, cover: m?.cover, mode: g.mode === "i2i" ? "图生图" : "文生图" }];
        })
      ),
    [gallery]
  );
  const boardUseAsRef = useCallback(
    async (urls: string[]) => {
      try {
        const files = await Promise.all(
          urls.map(async (u, i) => {
            const r = await fetch(u.startsWith("data:") ? u : rawOf(u));
            if (!r.ok) throw new Error();
            const b = await r.blob();
            return new File([b], `canvas-${i + 1}.${b.type.includes("png") ? "png" : "jpg"}`, { type: b.type || "image/jpeg" });
          })
        );
        addRefs(files);
        setMode("i2i");
      } catch {
        flash("图片读取失败，请稍后重试");
      }
    },
    [addRefs, flash]
  );
  const boardDownload = useCallback(
    (id: string | null, url: string) => {
      const g = id ? gallery.find((x) => x.id === id) : undefined;
      if (g) return void downloadItem(g);
      const a = document.createElement("a");
      a.href = url;
      a.download = "canvas.jpg";
      a.click();
    },
    [gallery, downloadItem]
  );

  // Under the selection when it fits, else above it, else at the bottom; always inside the board.
  const hugFor = (selBox: Box | null): { left: number; top: number; width: number } | null => {
    if (!canvasOn || !selBox) return null;
    const col = leftColRef.current?.getBoundingClientRect();
    if (!col) return null;
    // 用户 2026-11-11 (输入框也适当缩小): narrower when the board is zoomed out, never under 440 px; the settings row
    // shrinks itself to fit, the text keeps its size.
    const zf = Math.min(1, Math.max(0.7, canvasScaleRef.current));
    const w = Math.min(col.width - 32, Math.max(440, 640 * zf));
    const h = composeRef.current?.offsetHeight || 200;
    const cx = (selBox.left + selBox.right) / 2 - col.left;
    const left = Math.max(16, Math.min(cx - w / 2, col.width - w - 16));
    const below = selBox.bottom - col.top + 14;
    if (below + h <= col.height - 12) return { left, top: Math.max(56, below), width: w };
    const above = selBox.top - col.top - 14 - h - 72; // leave room for the selection toolbar and the label row
    if (above >= 56) return { left, top: above, width: w };
    return { left, top: col.height - h - 16, width: w };
  };
  const hugForRef = useRef(hugFor);
  hugForRef.current = hugFor;
  const hugStyle = hugOn && editingNode ? hugFor(selBoxRef.current) : null;
  const onSelectionBox = useCallback((r: Box | null) => {
    selBoxRef.current = r;
    setHugOn(!!r);
    const el = composeRef.current;
    const st = hugForRef.current(r);
    if (el && st) {
      el.style.left = `${st.left}px`;
      el.style.top = `${st.top}px`;
      el.style.width = `${st.width}px`;
    }
  }, []);

  const changePolishLevel = (level: CanvasDraft["polishLevel"]) => {
    setPolishLevel(level);
    try { localStorage.setItem("ais-polish-level-v2", level); } catch {}
  };
  const runPolish = async () => {
    const before = prompt;
    if (!before.trim() || polishing) return;
    setPolishing(true);
    try {
      const after = await polishText(before, polishLevel);
      editPrompt(after);
      setPolishUndo({ before, after });
    } catch (e: any) {
      flash(e?.message || "提示词优化失败");
    } finally {
      setPolishing(false);
    }
  };

  const chips: { key: string; label: string }[] = [
    { key: "model", label: (findModel(model) ?? MODELS[0]).name },
    ...(mode === "t2i" ? [{ key: "ratio", label: RATIOS.find((r) => r.w === width && r.h === height)?.label ?? `${width}×${height}` }]
      : modelParams.editRatio ? [{ key: "ratio", label: fixedEditAspect ? editRatio : "自适应" }] : []),
    ...(modelParams.resolutions ? [{ key: "res", label: res }] : []),
    ...(modelParams.quality ? [{ key: "quality", label: `画质 ${QUALITY_LABELS[quality]}` }] : []),
    ...(modelParams.thinking != null ? [{ key: "thinking", label: thinking ? "深度思考" : "普通思考" }] : []),
    ...(modelParams.background ? [{ key: "background", label: `背景 ${{ auto: "自动", transparent: "透明", opaque: "不透明" }[background]}` }] : []),
    ...(modelParams.complexity ? [{ key: "complexity", label: `构思 ${{ auto: "自动", low: "快", medium: "标准", high: "精细" }[complexity]}` }] : []),
    // 2026-11-06 (用户: "整体改"听不懂): say what gets changed.
    ...(mode === "i2i" && modelParams.regional ? [{ key: "regional", label: regional ? "只改说的地方" : "改整张图" }] : []),
    ...(mode === "i2i" && modelParams.denoise ? [{ key: "denoise", label: `重绘 ${denoise.toFixed(2)}` }] : []),
    ...(modelParams.lora ? [{ key: "lora", label: `风格 ${lora.toFixed(1)}` }] : []),
    // 速度 (标准 / 高速) removed 2026-11-11: 高速 measured no faster and ~30% dearer (用户: 高速没用就去掉).
    // 2026-11-05 (用户: 随机种子去掉吧，没什么人用): every picture gets a random seed.
    // 不想要 removed (用户 2026-11-06: 去掉).
    // 2026-11-10 (用户: 去掉生成张数，点一次就是生成一次): no 张数 chip; every click makes one picture.
  ];
  // 用户 2026-11-11 (小预览跟随我选择的参数): the short line under a picture on the board.
  const liveSummary = chips.filter((c) => c.key !== "model").map((c) => c.label).join(" · ");
  liveSummaryRef.current = liveSummary;
  useEffect(() => {
    if (canvasOn && editingNode && editingNode === composeKey.current)
      canvasApi.current?.saveDraft(editingNode, { ...composeSnapRef.current, summary: liveSummary });
  }, [canvasOn, editingNode, liveSummary, prompt, model, width, height, widthText, heightText, denoise, quality, res, seedText, negative, lora, polishLevel, thinking, regional, background, complexity, reverseOn, reverseMode, editRatio]);
  const boardSummary = (n: BoardNode, hasPictures: boolean) => {
    if (n.id === editingNode) return null;
    const saved = composeMem.current.get(n.id) ?? n.draft;
    const g = !saved ? gallery.find((x) => x.id === (n.gid ?? n.editOf)) : undefined;
    const md = findModel(saved?.model ?? (g ? pictureParams(g).model : DEFAULT_MODEL)) ?? MODELS[0];
    const size = g && pictureParams(g);
    const ratio = size ? RATIOS.find((r) => r.w === size.width && r.h === size.height)?.label ?? `${size.width}×${size.height}` : "1:1";
    const s = g?.settings;
    const detail = saved?.summary || [hasPictures ? (paramsOf(md.id).denoise ? `重绘 ${s?.["重绘幅度"] ?? "0.50"}` : s?.["改图比例"] || "自适应") : ratio, s?.["清晰度"], s?.["画质"]].filter(Boolean).join(" · ");
    return { model: md.name, cover: md.cover, detail };
  };
  // 用户 2026-11-10: 模型 + 两个参数 + 更多.
  const primaryChips = [
    "model",
    ...(mode === "t2i" ? ["ratio", "res", "quality", "lora"] : ["denoise", "res", "quality", "lora"])
      .filter((k) => chips.some((c) => c.key === k))
      .slice(0, 2),
  ];
  const hiddenChipCount = chips.filter((c) => !primaryChips.includes(c.key)).length;
  /** One line for the folded 参数 row: 1:1 · 2K · 标准 · 深度思考 … */
  const paramSummary = [
    mode === "t2i" ? RATIOS.find((r) => r.w === width && r.h === height)?.label ?? `${width}×${height}` : "跟参考图",
    modelParams.resolutions ? res : null,
    modelParams.quality ? QUALITY_LABELS[quality] : null,
    modelParams.thinking != null && thinking ? "深度思考" : null,
    mode === "i2i" && modelParams.denoise ? `重绘 ${denoise.toFixed(2)}` : null,
    seedText ? `种子 ${seedText}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const histStats = (() => {
    let done = 0,
      failed = 0,
      pending = 0,
      cost = 0;
    for (const g of gallery) {
      if (g.url) done++;
      else if (g.status === "failed" || g.status === "expired") failed++;
      else pending++;
      cost += Number(g.cost) || 0;
    }
    return { done, failed, pending, cost: cost.toFixed(2) };
  })();
  const query = histQuery.trim().toLowerCase();
  const visibleHistory = gallery.filter(
    (g) =>
      (histMode === "all" || g.mode === histMode) &&
      (histFilter === "all" ||
        (histFilter === "fav" && !!g.fav) ||
        (histFilter === "ok" && !!g.url) ||
        (histFilter === "bad" && !g.url) ||
        histFilter === `model:${g.model ?? (g.label ? "" : "brown-dust")}`) &&
      (!query || g.prompt.toLowerCase().includes(query))
  );
  if (histSort !== "new") {
    visibleHistory.sort((a, b) =>
      histSort === "old"
        ? a.createdAt - b.createdAt
        : histSort === "cost"
          ? (Number(b.cost) || 0) - (Number(a.cost) || 0)
          : (b.durationMs || 0) - (a.durationMs || 0)
    );
  }
  // 2026-11-05 (用户: 历史上下页怎么设计): no pages — more pictures load as you scroll down.
  const HIST_PAGE_SIZE = 30;
  const pageItems = visibleHistory.slice(0, (histPage + 1) * HIST_PAGE_SIZE);
  const histHasMore = pageItems.length < visibleHistory.length;
  const isReady = (id: ModelId, m: Mode = mode) => !readiness || !!readiness[id]?.[m];
  const modelReady = isReady(model);
  const pickModel = (id: ModelId) => {
    setModel(id);
    setError(null);
    localStorage.setItem(MODEL_KEY, id);
  };

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden">
      {/* Signed out: the real studio stays visible behind a frosted sign-in card. */}
      {user === null && <LoginView onDone={(u) => { setUser(u); window.location.reload(); }} />}
      {notice && (
        <div key={notice} className="animate-pop-in pointer-events-none fixed left-1/2 top-5 z-[95] -translate-x-1/2 rounded-full bg-ink/85 px-4 py-2 text-[13px] text-panel shadow-[0_10px_30px_rgba(0,0,0,0.2)] backdrop-blur">
          {notice}
        </div>
      )}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0"
        style={{
          background:
            "radial-gradient(900px 420px at 50% -6%, rgba(0,113,227,0.06), transparent 55%), linear-gradient(180deg,light-dark(#fbfbfd,#2b2d32),var(--color-page))",
        }}
      />

      {user && (
        <nav aria-label="工作室工具" className="fixed left-5 top-5 md:top-1/2 md:-translate-y-1/2 z-50 flex flex-col items-center gap-1 rounded-full bg-panel/90 p-1 shadow-[0_6px_20px_rgba(0,0,0,0.12)] ring-1 ring-edge/[0.06] backdrop-blur-xl">
          <div ref={userMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setUserMenu((v) => !v)}
              aria-label="用户信息"
              aria-expanded={userMenu}
              data-tip={userMenu ? undefined : user} data-tip-start=""
              className="flex h-8 w-8 items-center justify-center rounded-full text-[14px] font-semibold text-ink transition hover:bg-edge/[0.06] aria-expanded:bg-edge/[0.06]"
            >
              {/^1\d{10}$/.test(user) ? user.slice(-2) : user.slice(0, 1).toUpperCase()}
            </button>
            {userMenu && (
              <div className="animate-pop-in absolute left-0 top-11 md:left-11 md:top-0 min-w-[140px] rounded-2xl bg-panel p-1.5 shadow-[0_18px_50px_rgba(0,0,0,0.16)] ring-1 ring-edge/[0.06]">
                <div className="px-2.5 py-1.5 text-[12px] text-muted">
                  {/^1\d{10}$/.test(user) ? `${user.slice(0, 3)}****${user.slice(-4)}` : user}
                </div>
                {isOwnerUser && (
                  <button
                    type="button"
                    onClick={() => {
                      // 2026-11-05 (用户: 管理要是正常的页面): its own page, not a pop-up.
                      window.location.href = "/admin";
                    }}
                    className="w-full rounded-xl px-2.5 py-1.5 text-left text-[13px] text-ink hover:bg-edge/[0.04]"
                  >
                    管理
                  </button>
                )}
                <button
                  type="button"
                  onClick={async () => {
                    // 用户 2026-11-11 (账号密码，安全一些): change the password here.
                    setUserMenu(false);
                    const oldPassword = window.prompt("原密码（还没设过密码就留空）") ?? null;
                    if (oldPassword === null) return;
                    const newPassword = window.prompt("新密码（至少 6 位）") ?? "";
                    if (!newPassword) return;
                    if (window.prompt("再输一次新密码") !== newPassword) return flash("两次输入的新密码不一样");
                    const d = await fetchJson("/api/auth", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "change", oldPassword, newPassword }),
                    }).catch((e: any) => ({ ok: false, error: e?.message }));
                    flash(d?.ok ? "密码已修改" : d?.error || "修改失败");
                  }}
                  className="w-full rounded-xl px-2.5 py-1.5 text-left text-[13px] text-ink hover:bg-edge/[0.04]"
                >
                  修改密码
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "logout" }) });
                    try {
                      localStorage.removeItem(HIST_CACHE_KEY); // the next account must not see this one's pictures
                      localStorage.removeItem(ME_KEY);
                    } catch {}
                    setUser(null);
                    setUserMenu(false);
                  }}
                  className="w-full rounded-xl px-2.5 py-1.5 text-left text-[13px] text-danger hover:bg-edge/[0.04]"
                >
                  退出登录
                </button>
              </div>
            )}
          </div>
          {!phone && <div className="flex flex-col items-center gap-1">
          {([
            ["single", "单图", <path key="p" d="M4 5h16v14H4zM4 15l4.5-4.5 4 4 2.5-2.5L20 17" />],
            ["canvas", "自由画布", <path key="p" d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />],
          ] as const).map(([k, tip, icon]) => {
            const on = (k === "canvas") === canvasOn;
            return (
              <button
                key={k}
                type="button"
                data-tip={tip}
                data-tip-start=""
                aria-label={tip}
                onClick={() => enterCanvas(k === "canvas")}
                className={`flex h-8 w-8 items-center justify-center rounded-full transition ${on ? "bg-ink text-panel" : "text-secondary hover:bg-edge/[0.06] hover:text-ink"}`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
              </button>
            );
          })}
          {canvasOn && (
            <div className="relative" ref={boardMenuRef}>
              <button
                type="button"
                aria-expanded={boardMenu}
                data-tip={`画布列表（当前：${boards.find((b) => b.id === boardId)?.name ?? "画布1"}）`}
                data-tip-start=""
                aria-label="画布列表"
                onClick={() => { setBoardMenu((v) => !v); setBoardDelArm(null); }}
                className={`flex h-8 w-8 items-center justify-center rounded-full transition ${boardMenu ? "bg-accent/10 text-accent" : "text-secondary hover:bg-edge/[0.06] hover:text-ink"}`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5" /></svg>
              </button>
              {boardMenu && (
                <div className="animate-pop-in absolute left-11 top-0 max-h-[50dvh] w-56 overflow-y-auto rounded-2xl bg-panel p-1.5 shadow-[0_18px_50px_rgba(0,0,0,0.16)] ring-1 ring-edge/[0.06]">
                  <div className="px-2 pb-1 pt-0.5 text-[12px] font-semibold text-muted">画布</div>
                  {boards.map((b) => (
                    <div key={b.id} className={`group flex items-center gap-1 rounded-xl px-2 py-1.5 text-[13px] ${b.id === boardId ? "bg-accent/[0.08] text-accent" : "text-ink hover:bg-edge/[0.04]"}`}>
                      <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => { saveBoards(boards, b.id); setBoardMenu(false); }}>
                        {b.name}
                      </button>
                      <button type="button" data-tip="改名" className="rounded-md px-1 text-muted opacity-0 hover:bg-edge/[0.06] group-hover:opacity-100" onClick={() => renameBoard(b.id)}>✎</button>
                      <button type="button" data-tip={boardDelArm === b.id ? "再点一次删除" : "删除画布"} className={`rounded-md px-1 hover:bg-edge/[0.06] ${boardDelArm === b.id ? "text-danger opacity-100" : "text-muted opacity-0 group-hover:opacity-100"}`} onClick={() => deleteBoard(b.id)}>
                        {boardDelArm === b.id ? "删除?" : "×"}
                      </button>
                    </div>
                  ))}
                  <button type="button" onClick={newBoard} className="mt-1 w-full rounded-xl px-2 py-1.5 text-left text-[13px] text-accent hover:bg-accent/[0.08]">
                    ＋ 新建画布
                  </button>
                  <button type="button" onClick={() => { setBoardMenu(false); shareBoard(); }} className="w-full rounded-xl px-2 py-1.5 text-left text-[13px] text-ink hover:bg-edge/[0.04]">
                    分享当前画布…
                  </button>
                </div>
              )}
            </div>
          )}
          {canvasOn && (
            // 用户 2026-11-10: the zoom level as a small "67%" chip in the rail; click it for − / + / 100% / 适应.
            <div className="relative" data-zoom-menu="">
              <button
                type="button"
                data-tip={zoomMenu ? undefined : "缩放"}
                data-tip-start=""
                aria-label="缩放"
                onClick={() => setZoomMenu((v) => !v)}
                className={`flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums tracking-tight transition ${zoomMenu ? "bg-accent/10 text-accent" : "text-secondary hover:bg-edge/[0.06] hover:text-ink"}`}
              >
                {Math.round(canvasScale * 100)}%
              </button>
              {zoomMenu && (
                <>
                  <div className="animate-pop-in absolute left-11 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-full bg-panel p-1 text-[12px] text-ink shadow-[0_12px_36px_rgba(0,0,0,0.16)] ring-1 ring-edge/[0.06]">
                    <button type="button" aria-label="缩小" data-tip="缩小" className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-edge/[0.06]" onClick={() => canvasApi.current?.zoom("out")}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M3.5 8h9" /></svg>
                    </button>
                    <span className="w-11 text-center font-medium tabular-nums">{Math.round(canvasScale * 100)}%</span>
                    <button type="button" aria-label="放大" data-tip="放大" className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-edge/[0.06]" onClick={() => canvasApi.current?.zoom("in")}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M3.5 8h9M8 3.5v9" /></svg>
                    </button>
                    <span className="mx-0.5 h-4 w-px bg-edge/10" />
                    <button type="button" className="h-7 whitespace-nowrap rounded-full px-2.5 hover:bg-edge/[0.06]" onClick={() => canvasApi.current?.zoom(1)}>100%</button>
                    <button type="button" data-tip="显示全部（Shift+1）" className="h-7 whitespace-nowrap rounded-full px-2.5 hover:bg-edge/[0.06]" onClick={() => canvasApi.current?.zoom("fit")}>适应</button>
                  </div>
                </>
              )}
            </div>
          )}
          <div className="my-0.5 h-px w-5 bg-edge/[0.08]" />
          <button
            type="button"
            data-tip={histHidden ? "打开历史记录" : "收起历史记录"}
            data-tip-start=""
            aria-label="历史记录"
            onClick={() => toggleHistory(!histHidden)}
            className={`flex h-8 w-8 items-center justify-center rounded-full transition ${histHidden ? "text-secondary hover:bg-edge/[0.06] hover:text-ink" : "bg-accent/10 text-accent"}`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7.5V12l3 2" /></svg>
          </button>
          {/* 用户 2026-11-11: 更多设置 (深浅色 and board options) at the end of the rail. */}
          <div className="relative" data-more-menu="">
            <button
              type="button"
              data-tip={moreMenu ? undefined : "更多设置"}
              data-tip-start=""
              aria-label="更多设置"
              onClick={() => setMoreMenu((v) => !v)}
              className={`flex h-8 w-8 items-center justify-center rounded-full transition ${moreMenu ? "bg-accent/10 text-accent" : "text-secondary hover:bg-edge/[0.06] hover:text-ink"}`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
            </button>
            {moreMenu && (
              <div className="animate-pop-in absolute bottom-0 left-11 max-h-[65dvh] w-60 overflow-y-auto rounded-2xl bg-panel p-2 text-[13px] text-ink shadow-[0_18px_50px_rgba(0,0,0,0.16)] ring-1 ring-edge/[0.06]">
                <div className="px-1.5 pb-1 text-[12px] font-semibold text-muted">外观</div>
                <div className="apple-seg mb-2 flex">
                  {([["light", "浅色"], ["dark", "深色"], ["auto", "跟随系统"]] as const).map(([k, label]) => (
                    <button key={k} type="button" data-active={theme === k} onClick={() => chooseTheme(k)} className="apple-seg-item flex-1 py-1 text-[12px] font-medium text-secondary">
                      {label}
                    </button>
                  ))}
                </div>
                {canvasOn && (
                  <>
                    <div className="px-1.5 pb-1 pt-1 text-[12px] font-semibold text-muted">画布</div>
                    {([
                      ["snap", "移动时自动对齐", boardPrefs.snap],
                      ["grid", "显示网格点", boardPrefs.grid],
                      ["lines", "显示来源连线", boardPrefs.lines],
                      ["map", "显示小地图", boardPrefs.map],
                    ] as const).map(([k, label, on]) => (
                      <button key={k} type="button" onClick={() => setBoardPref(k, !on)} className="flex w-full items-center justify-between rounded-lg px-1.5 py-1.5 hover:bg-edge/[0.04]">
                        <span>{label}</span>
                        <span className={`relative h-5 w-9 rounded-full transition ${on ? "bg-[#34c759]" : "bg-edge/15"}`}>
                          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
                        </span>
                      </button>
                    ))}
                    <div className="mt-2 rounded-xl bg-page px-2.5 py-2 text-[11px] leading-[18px] text-secondary">
                      滚轮 缩放 · 按住滚轮 拖动画布<br />
                      左键 选择 / 框选 · 右键 菜单<br />
                      ⌘Z 撤销 · ⌘A 全选 · Delete 移出<br />
                      Shift+1 显示全部 · ⌘V 粘贴图片 · Alt 拖动不对齐
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          </div>}
        </nav>
      )}
      <main className={`relative z-10 flex min-h-0 w-full flex-1 flex-col gap-2 overflow-y-auto lg:flex-row lg:gap-0 lg:overflow-hidden ${canvasOn ? "p-0" : phone ? "p-2 pt-[68px]" : "p-2"}`}>
        <div ref={leftColRef} className="relative flex min-w-0 shrink-0 flex-col gap-2 lg:min-h-0 lg:flex-1 lg:shrink">
        <section
          ref={resultRef_}
          className={`stagger-2 flex h-[55vh] min-w-0 flex-col overflow-hidden lg:h-auto lg:min-h-0 lg:flex-1 ${canvasOn ? "" : "apple-card rounded-[22px]"}`}>
                    <div
            className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden ${canvasOn ? "" : "result-box m-2 rounded-[16px] sm:m-3"}`}

          >
            {canvasOn && user && (
              <div className="absolute inset-0 z-20">
                <CanvasBoard
                  key={boardId}
                  storageKey={boardKey(boardId)}
                  cloudId={boardId}
                  onRunFrame={generate}
                  onSelectionChange={onBoardSelection}
                  onSelectionBox={onSelectionBox}
                  onGidsChange={(ids) => setOnBoard(new Set(ids))}
                  onReedit={(gid) => { const g = gallery.find((v) => v.id === gid); if (g) editHistoryItem(g); }}
                  onRetry={(gid) => {
                    // Same prompt, model and references as the failed one, made again (用户: 失败的格子加重试).
                    const g = gallery.find((x) => x.id === gid);
                    if (!g) return;
                    reuseItem(g);
                    setTimeout(() => startOrQueueRef.current(), 600);
                  }}
                  onDescribe={async (url) => {
                    const r = await fetch(url.startsWith("data:") ? url : rawOf(url));
                    if (!r.ok) throw new Error("图片读取失败");
                    const b = await r.blob();
                    const fd = new FormData();
                    fd.append("image", await describeCopy(new File([b], "pic.jpg", { type: b.type || "image/jpeg" })), "reference.jpg");
                    const d = await fetchJson("/api/describe", { method: "POST", body: fd });
                    if (!d?.ok || !d?.prompt) throw new Error(d?.error || "看图写描述失败");
                    return String(d.prompt).trim();
                  }}
                  onAgain={(gid, text, refs) => {
                    const g = gallery.find((x) => x.id === gid);
                    if (!g) return;
                    reuseItem(g, refs ?? pictureRefs(g));
                    if (text) setPrompt(text);
                    setTimeout(() => startOrQueueRef.current(), 0);
                  }}
                  onUpscale={(gid) => upscaleItem(gid)}
                  sources={boardSources}
                  frameProgress={frameProgress}
                  pendingIds={loading ? batch : []}
                  loading={loading}
                  progress={progress}
                  jobAspect={jobVisual.aspect}
                  dragType={HIST_DRAG}
                  thumb={thumbOf}
                  onUseAsRef={boardUseAsRef}
                  onView={(u) => setViewer(u)}
                  onDownload={boardDownload}
                  flash={flash}
                  apiRef={canvasApi}
                  onScale={setCanvasScale}
                  boardJobs={boardJobs}
                  onJobsPlaced={jobsPlaced}
                  polishLevel={polishLevel}
                  onPolishLevel={changePolishLevel}
                  onPolish={polishText}
                  onOpenHistory={() => toggleHistory(false)}
                  onShare={shareBoard}
                  prefs={boardPrefs}
                  summaryFor={boardSummary}
                  onSelectionText={(t) => {
                    // 用户 2026-11-11 (文本节点): a selected text node is the description; the box edits it.
                    textSelRef.current = t !== null;
                    if (t !== null) setPrompt((p) => (p === t ? p : t));
                  }}
                  onCompare={(before, after, gid) => {
                    const ref = before ?? (gid ? gallery.find((x) => x.id === gid)?.refUrl : null);
                    if (!ref) return flash("这张没有原图可以对比");
                    setBoardCompare({ before: ref, after });
                  }}
                />
              </div>
            )}
            {loading && jobCount > 1 ? (
              // One cell per picture (2 side by side, 3 in a row, 4 as 2×2); each fills in as soon as it is ready.
              <BatchGrid
                count={jobCount}
                aspect={jobVisual.aspect}
                cell={(i) => {
                  const g = gallery.find((x) => x.id === batch[i]);
                  return g?.url ? (
                    <button type="button" onClick={() => showItem(g)} className="h-full w-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={thumbOf(g.url, 640)} alt={`第 ${i + 1} 张`} className="animate-image-reveal h-full w-full rounded-[18px] object-cover" />
                    </button>
                  ) : (
                    <GeneratingView aspect={jobVisual.aspect} progress={progress} compact />
                  );
                }}
              />
            ) : loading && !showingPartial ? (
              <GeneratingView aspect={jobVisual.aspect} progress={progress} />
            ) : batchGrid && batch.length > 1 ? (
              <BatchGrid
                count={batch.length}
                aspect={(() => {
                  const first = batch.map((id) => aspects[id]).find(Boolean);
                  return first ? 1 / first : jobVisual.aspect;
                })()}
                cell={(i) => {
                  const g = gallery.find((x) => x.id === batch[i]);
                  return g?.url ? (
                    <button type="button" onClick={() => showItem(g)} className="h-full w-full" aria-label={`看第 ${i + 1} 张大图`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={thumbOf(g.url, 640)} alt={`第 ${i + 1} 张`} className="h-full w-full rounded-[18px] object-cover transition duration-300 hover:brightness-95" />
                    </button>
                  ) : (
                    <span className="flex h-full w-full items-center justify-center rounded-[18px] bg-well text-[12px] text-danger">第 {i + 1} 张没画成</span>
                  );
                }}
              />
            ) : resultUrl && compareRefs.length > 0 && compareOn && !loading ? (
              <div className="h-full w-full p-2">
                <CompareView key={`${resultKey}-${compareMode}-${compareIdx}`} before={fullOf((compareRefs[compareIdx] ?? resultRef) as string)} after={fullOf(resultUrl)} mode={compareMode} />
              </div>
            ) : resultUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={resultKey}
                src={mainSrc ?? thumbOf(resultUrl, 1600)}
                alt="生成结果"
                onClick={() => setViewer(resultUrl)}
                onDragStart={(e) => currentId && e.dataTransfer.setData(HIST_DRAG, currentId)}
                onLoad={(e) => {
                  const el = e.currentTarget;
                  setResultSize({ w: el.naturalWidth, h: el.naturalHeight });
                }}
                className="animate-image-reveal max-h-full w-auto max-w-full cursor-zoom-in object-contain"
              />
            ) : (
              <div className="max-w-sm px-6 text-center">
                <div
                  className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-[14px] text-[20px]"
                  style={{ background: "rgba(0,113,227,0.1)", color: "var(--color-accent)" }}
                >
                  ✦
                </div>
                <p className="text-[15px] font-medium text-ink">
                  从一句描述开始
                </p>
              </div>
            )}
            {showingPartial && (
              <div className="animate-pop-in absolute left-3 top-3 z-20 flex items-center gap-1.5 rounded-full bg-panel/85 px-2.5 py-1 text-[12px] text-ink shadow-[0_2px_10px_rgba(0,0,0,0.08)] backdrop-blur">
                <span className="animate-spin-slow h-3 w-3 rounded-full border-[1.5px] border-edge/10 border-t-accent" />
                {batchDone}/{batchTotal}
              </div>
            )}
            {!loading && !batchGrid && batch.length > 1 && currentId && batch.includes(currentId) && (() => {
              const done = batch.map((id) => gallery.find((x) => x.id === id)).filter((g): g is GalleryItem => !!g?.url);
              const at = done.findIndex((g) => g.id === currentId);
              const go = (d: number) => done.length && showItem(done[(at + d + done.length) % done.length]);
              const arrow = "absolute top-1/2 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-panel/85 text-ink shadow-[0_4px_16px_rgba(0,0,0,0.12)] backdrop-blur hover:bg-panel";
              return (
                <>
                  <button type="button" onClick={() => setBatchGrid(true)} data-tip="回到全部" data-tip-end="" className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded-full bg-panel/85 px-2.5 py-1 text-[12px] tabular-nums text-ink shadow-[0_2px_10px_rgba(0,0,0,0.08)] backdrop-blur hover:bg-panel">
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round"><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></svg>
                    {at + 1}/{done.length}
                  </button>
                  {done.length > 1 && (
                    <>
                      <button type="button" aria-label="上一张" onClick={() => go(-1)} className={`${arrow} left-3`}>
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round"><path d="M15 5l-7 7 7 7" /></svg>
                      </button>
                      <button type="button" aria-label="下一张" onClick={() => go(1)} className={`${arrow} right-3`}>
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round"><path d="M9 5l7 7-7 7" /></svg>
                      </button>
                    </>
                  )}
                </>
              );
            })()}
          </div>
          {/* Under the picture: only 对比 (when there was a reference) and 下载, centred (用户 2026-11-05). */}
          {!canvasOn && resultUrl && (!loading || showingPartial) && !(batchGrid && batch.length > 1) && (
            <div className="flex shrink-0 flex-wrap items-center justify-center gap-1.5 px-3 pb-3">
              {compareRefs.length > 0 && (
                <button
                  type="button"
                  aria-pressed={compareOn}
                  onClick={() => setCompareOn((v) => !v)}
                  className={`rounded-full px-3.5 py-1.5 text-[12px] font-medium transition active:scale-[0.97] ${
                    compareOn ? "bg-accent text-panel" : "bg-edge/[0.05] text-ink hover:bg-edge/[0.09]"
                  }`}
                >
                  {compareOn ? "退出对比" : "对比"}
                </button>
              )}
              {compareOn && compareRefs.length > 1 && (
                <div className="flex items-center gap-1">
                  {compareRefs.map((url, i) => (
                    <button
                      key={url}
                      type="button"
                      data-tip={`和图${i + 1}对比`}
                      onClick={() => setCompareIdx(i)}
                      className={`relative h-8 w-8 overflow-hidden rounded-lg transition ${compareIdx === i ? "ring-2 ring-accent" : "opacity-60 hover:opacity-100"}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt={`图${i + 1}`} className="h-full w-full object-cover" />
                      <span className="absolute inset-x-0 bottom-0 bg-black/55 text-[8px] leading-[11px] text-white">图{i + 1}</span>
                    </button>
                  ))}
                </div>
              )}
              {compareOn && (
                <div className="apple-seg flex">
                  {COMPARE_MODES.map((m) => (
                    <button
                      key={m.key}
                      type="button"
                      data-active={compareMode === m.key}
                      onClick={() => setCompareMode(m.key)}
                      className="apple-seg-item px-2.5 py-1 text-[11px] font-medium text-secondary"
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
              {currentItem && (
                <button
                  type="button"
                  onClick={() => downloadItem(currentItem)}
                  className="rounded-full bg-accent px-4 py-1.5 text-[12px] font-medium text-panel transition hover:bg-accent-hover active:scale-[0.97]"
                >
                  下载
                </button>
              )}
            </div>
          )}

        </section>
        <section
          ref={composeRef}
          className={
            canvasOn && !editingNode && !composeOpen
              ? "hidden"
              : canvasOn
              ? // 画布: the compose box floats over the board (用户: 输入框也是画布里的功能), hugging the selection.
                `absolute z-40 m-0 flex flex-col overflow-visible rounded-[22px] bg-panel shadow-[0_18px_50px_rgba(0,0,0,0.18)] ${hugStyle ? "" : "bottom-4 left-1/2 w-[min(860px,calc(100%-32px))] -translate-x-1/2"}`
              : "stagger-1 m-0 flex w-full shrink-0 flex-col overflow-visible"
          }
          style={hugStyle ?? undefined}
        >

          <div className="min-h-0">
            {/* 2026-11-05 (用户: 极简，参考图跟提示词在同一个框): one compose box — pictures on top, words below, + to add. */}
            <div>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                  if (dragState !== "zone") setDragState("zone");
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragState("page");
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragState("none");
                  const sid = e.dataTransfer.getData(HIST_DRAG);
                  const fromHistory = sid ? gallery.find((x) => x.id === sid) : undefined;
                  if (fromHistory?.url) {
                    if (canvasOn && editingNode) return canvasApi.current?.attachHistory(fromHistory.id);
                    // History pictures load from COS, so fetch the bytes through the site.
                    fetch(rawOf(fromHistory.url))
                      .then((r) => (r.ok ? r.blob() : Promise.reject()))
                      .then((b) => addRefs([new File([b], `history-${sid}.${b.type.includes("png") ? "png" : "jpg"}`, { type: b.type || "image/png" })]))
                      .catch(() => flash("图片读取失败，请稍后重试"));
                    return;
                  }
                  const files = Array.from(e.dataTransfer.files ?? []).filter((x) => x.type.startsWith("image/"));
                  if (!files.length) {
                    if (e.dataTransfer.files?.length) setError("请拖入图片文件（JPG / PNG / WEBP）");
                    return;
                  }
                  if (canvasOn && editingNode) canvasApi.current?.attachFiles(files);
                  else addRefs(files);
                }}
                data-drag={dragState}
                className={`apple-card ${canvasOn ? "canvas-compose-card" : ""} relative rounded-[22px] border bg-panel transition focus-within:border-[rgba(0,113,227,0.45)] ${
                  dragState === "zone"
                    ? "scale-[1.01] border-accent ring-4 ring-accent/20"
                    : dragState === "page" && !canvasOn
                      ? "border-accent/60 ring-4 ring-accent/10"
                      : "border-edge/[0.08]"
                }`}
              >
                {/* While a picture is dragged anywhere on the page, the card lights up to say where it goes. */}
                {/* On the board a drop lands on the board, so the hint only shows right over the box (用户 2026-11-10). */}
                {(canvasOn ? dragState === "zone" : dragState !== "none") && (
                  <div className="animate-pop-in pointer-events-none absolute inset-1.5 z-30 flex flex-col items-center justify-center gap-1.5 rounded-[18px] border-2 border-dashed border-accent bg-[light-dark(#eef6ff,#162b42)]/90 backdrop-blur-sm">
                    <span className={`flex h-10 w-10 items-center justify-center rounded-full bg-accent text-[18px] text-panel shadow-[0_8px_22px_rgba(0,113,227,0.35)] ${dragState === "zone" ? "" : "animate-bounce"}`}>
                      ↓
                    </span>
                    <span className="text-[13px] font-medium text-accent">
                      {dragState === "zone" ? "松开，放进参考图" : "拖到这里，当参考图"}
                    </span>
                  </div>
                )}
                {(
                  <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
                    {[...(preview ? [{ url: preview, file: null as File | null }] : []), ...(canvasOn ? extraRefs : extraRefs.slice(0, Math.max(0, (modelParams.maxRefs ?? 1) - 1)))].map((r, i) => (
                      <span key={i + ":" + r.url} tabIndex={0} className="group/ref relative h-12 w-12 overflow-hidden rounded-lg border border-edge/[0.08] outline-none">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={r.url}
                          alt={`图${i + 1}`}
                          onLoad={
                            i === 0
                              ? (e) => {
                                  const el = e.currentTarget;
                                  if (el.naturalHeight) setPreviewAspect(el.naturalWidth / el.naturalHeight);
                                }
                              : undefined
                          }
                          className="h-full w-full object-cover"
                        />
                        {/* 2026-11-05 (用户: 换图合并到图片里，切换、查看按钮): hover a picture to swap or enlarge it. */}
                        <span className="absolute inset-0 flex items-center justify-center gap-0.5 bg-black/45 opacity-0 transition-opacity group-hover/ref:opacity-100 group-focus-within/ref:opacity-100">
                          <button
                            type="button"
                            data-tip="查看大图"
                            aria-label={`查看图${i + 1}`}
                            onClick={() => setViewer(r.url)}
                            className="flex h-5 w-5 items-center justify-center rounded-full text-white hover:bg-white/25"
                          >
                            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
                          </button>
                          <button
                            type="button"
                            data-tip="换一张"
                            aria-label={`换掉图${i + 1}`}
                            onClick={() => {
                              replaceSlot.current = i;
                              fileRef.current?.click();
                            }}
                            className="flex h-5 w-5 items-center justify-center rounded-full text-white hover:bg-white/25"
                          >
                            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M4 9a8 8 0 0 1 14-3l2 2M20 4v4h-4M20 15a8 8 0 0 1-14 3l-2-2M4 20v-4h4" /></svg>
                          </button>
                        </span>
                        {(modelParams.maxRefs ?? 1) > 1 ? (
                          <button
                            type="button"
                            onClick={() => insertMention(i + 1)}
                            data-tip="在描述里 @ 这张图" data-tip-start=""
                            className="absolute inset-x-0 bottom-0 z-10 bg-black/55 text-center text-[9px] leading-[14px] text-white hover:bg-accent"
                          >
                            图{i + 1}
                          </button>
                        ) : (
                          // One-picture models don't take @, so the label is only a label.
                          <span className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-black/55 text-center text-[9px] leading-[14px] text-white">{canvasOn ? `图${i + 1}` : "参考图"}</span>
                        )}
                        <button
                          type="button"
                          onClick={() => (canvasOn && editingNode ? canvasApi.current?.removeInput(i) : i === 0 ? removeMainRef() : setExtraRefs((list) => list.filter((x) => x.url !== r.url)))}
                          className="absolute right-0.5 top-0.5 z-10 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-black/60 text-[9px] text-white"
                          aria-label={`删除图${i + 1}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                                      {(() => {
                      const limit = modelParams.maxRefs ?? 1;
                      const used = (preview ? 1 : 0) + Math.min(extraRefs.length, limit - 1);
                      const full = !!preview && used >= limit;
                      return (
                        <>
                          {!full && (
                            <button
                              type="button"
                              onClick={() => {
                                replaceSlot.current = null;
                                fileRef.current?.click();
                              }}
                              data-tip="添加参考图，也可拖入或粘贴" data-tip-start=""
                              className="flex h-12 w-12 items-center justify-center rounded-lg border border-dashed border-edge/[0.15] text-muted transition hover:border-accent hover:text-accent"
                            >
                              <span className="text-[18px] leading-none">+</span>
                            </button>
                          )}
                          {/* 用户 2026-11-11 (怎么没有显示连进来的内容): say plainly when this model cannot take every linked picture. */}
                          {canvasOn && canvasSel.length > limit && (
                            <button
                              type="button"
                              onClick={(e) => { anchorModel(chipRowRef.current?.querySelector<HTMLElement>('[data-setting="model"]') ?? e.currentTarget); setMultiOnly(true); setOpenPanel("model"); }}
                              aria-label={`${limit === 1 ? "模型仅支持单图" : `模型最多支持 ${limit} 张`}，切换模型`}
                              title={`已连接 ${canvasSel.length} 张，当前模型支持 ${limit} 张`}
                              className="inline-flex items-center gap-2 self-center whitespace-nowrap rounded-md px-1.5 py-1 text-[11px] text-secondary hover:bg-edge/[0.05]"
                            >
                              <span>{limit === 1 ? "模型仅支持单图" : `模型最多支持 ${limit} 张`}</span>
                              <span className="font-medium text-accent">换模型</span>
                            </button>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
                <div className="relative">
                  {prompt && (
                    <div
                      ref={promptMirrorRef}
                      aria-hidden
                      className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3.5 py-3 text-[14px] leading-relaxed text-ink"
                    >
                      {withMentions(prompt, [preview, ...extraRefs.map((r) => r.url)])}
                      {"\n"}
                    </div>
                  )}
                  <textarea
                    ref={promptRef}
                    id="studio-prompt"
                    onScroll={(e) => {
                      if (promptMirrorRef.current) promptMirrorRef.current.scrollTop = e.currentTarget.scrollTop;
                    }}
                    value={prompt}
                    onChange={(e) => {
                      const v = e.target.value;
                      editPrompt(v);
                      const at = e.target.selectionStart ?? v.length;
                      const open = !!preview && (modelParams.maxRefs ?? 1) > 1 && v[at - 1] === "@";
                      if (open) setMentionAt(caretXY(e.target, at));
                      setMentionOpen(open);
                    }}
                    onKeyDown={(e) => {
                      if (mentionOpen && e.key === "Escape") setMentionOpen(false);
                      // A picture token deletes as one piece (it shows as one thumbnail).
                      if (e.key === "Backspace" && !e.metaKey && !e.altKey) {
                        const el = e.currentTarget;
                        const at = el.selectionStart ?? 0;
                        if (at === el.selectionEnd) {
                          const m = /@图\d+$/.exec(prompt.slice(0, at));
                          if (m && m[0].length > 1) {
                            e.preventDefault();
                            const next = prompt.slice(0, at - m[0].length) + prompt.slice(at);
                            editPrompt(next);
                            requestAnimationFrame(() => el.setSelectionRange(at - m[0].length, at - m[0].length));
                          }
                        }
                      }
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        startOrQueue();
                      }
                    }}
                    rows={2}
                    placeholder={
                      mode === "t2i"
                        ? "描述你想要的画面，或点 + 放参考图改图…"
                        : reverse
                          ? `可不填，会根据参考图优化提示词${(modelParams.maxRefs ?? 1) > 1 ? "；输入 @ 指定哪张图" : ""}`
                          : `想怎么改？${(modelParams.maxRefs ?? 1) > 1 ? "输入 @ 指定哪张图" : ""}`
                    }
                    className="relative block w-full resize-none bg-transparent px-3.5 py-3 text-[14px] leading-relaxed text-transparent caret-ink outline-none placeholder:text-hint selection:bg-accent/25"
                    style={{
                      // Grows with the text, 3 lines to ~22% of the screen (then scrolls).
                      fieldSizing: "content",
                      minHeight: 76,
                      maxHeight: canvasOn ? (promptExpanded ? "48vh" : "calc(3lh + 1.5rem)") : "22vh",
                      overflowY: canvasOn && !promptExpanded ? "hidden" : "auto",
                      ...(prompt ? {} : { color: "var(--color-ink)" }),
                    } as React.CSSProperties}
                  />
                  {mentionOpen && (
                    <div
                      className="animate-pop-in absolute z-40 flex gap-1 rounded-2xl bg-panel p-1 shadow-[0_10px_30px_rgba(0,0,0,0.14)] ring-1 ring-edge/[0.06]"
                      style={{ left: Math.max(4, mentionAt.x), top: mentionAt.y + 22 }}
                    >
                      {[preview, ...extraRefs.map((r) => r.url)].filter(Boolean).map((url, i) => (
                        <button
                          key={i}
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => insertMention(i + 1, true)}
                          className="flex items-center gap-1.5 rounded-xl px-1.5 py-1 text-[12px] text-ink hover:bg-accent/10"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={url as string} alt="" className="h-7 w-7 rounded-lg object-cover" />
                          图{i + 1}
                        </button>
                      ))}
                    </div>
                  )}
                </div>


                {canvasOn && promptOverflows && <button type="button" aria-expanded={promptExpanded} aria-controls="studio-prompt"
                  aria-label={promptExpanded ? "收起提示词" : "展开提示词"} title={promptExpanded ? "收起提示词" : "展开提示词"}
                  className="mb-1 ml-2 inline-flex h-7 w-7 items-center justify-center rounded-full text-secondary hover:bg-edge/[0.06] hover:text-ink"
                  onClick={() => {
                    if (promptExpanded && promptRef.current) {
                      promptRef.current.scrollTop = 0;
                      if (promptMirrorRef.current) promptMirrorRef.current.scrollTop = 0;
                    }
                    setPromptExpanded((v) => !v);
                  }}>
                  <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={promptExpanded ? "rotate-180" : ""}><path d="m4 6 4 4 4-4" /></svg>
                </button>}
                {/* Every setting is its own chip; tap one to choose (用户: 每个参数拆开单独展开选择). */}
                {false && (
                  <div className="flex items-center gap-2 px-2 pb-2 pt-1">
                    <button type="button" onClick={() => setComposeOpen(true)} className="flex h-8 items-center gap-1 rounded-full bg-edge/[0.04] px-3 text-[12px] text-secondary hover:bg-edge/[0.08]">
                      {(findModel(model) ?? MODELS[0]).name} · 参数
                      <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none"><path d="M4 10l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                    </button>
                    <span className="text-[11px] text-hint">选中画布上的图，就会拿它当参考图改图</span>
                    <div className="ml-auto">
                      <button onClick={startOrQueue} disabled={!modelReady || !prompt.trim()} className="apple-btn-primary generate-button flex items-center justify-center gap-2 px-5 py-2.5 text-[14px]">
                        {loading ? `${Math.floor(progress)}%` : "生成"}
                      </button>
                    </div>
                  </div>
                )}
                <div className="px-2.5">
                <div ref={chipRowRef} className="compose-settings relative flex flex-nowrap items-center gap-1.5 whitespace-nowrap pb-2 pt-1">
                  {canvasOn && !editingNode && composeOpen && (
                    <button type="button" aria-label="收起" data-tip="收起" onClick={() => setComposeOpen(false)} className="flex h-8 w-8 items-center justify-center rounded-full bg-edge/[0.04] text-secondary hover:bg-edge/[0.08]">×</button>
                  )}
                  {openPanel && renderSettingPanel(
                    <div
                      ref={openPanel === "model" ? modelPopupRef : undefined}
                      data-setting-menu={openPanel}
                      className={`${openPanel === "model" ? "fixed z-[100] overscroll-contain" : "animate-pop-in absolute bottom-full z-50 mb-2"} max-h-[56vh] overflow-y-auto rounded-2xl bg-panel p-1.5 shadow-[0_18px_50px_rgba(0,0,0,0.16)] ring-1 ring-edge/[0.06] ${["model", "ratio", "negative", "seed", "lora"].includes(openPanel) ? "w-[300px]" : openPanel === "denoise" ? "w-[260px]" : "w-max min-w-[112px]"}`}
                      style={openPanel === "model" && modelAnchor ? modelAnchor : { left: panelLeft }}
                    >
                      {openPanel !== "denoise" && <div className="whitespace-nowrap px-2.5 pb-1 pt-1 text-[12px] font-semibold text-muted">
                        {({ model: "模型", ratio: "比例", res: "清晰度", quality: "画质", thinking: "深度思考", background: "背景", complexity: "构思程度", regional: "修改范围", denoise: "重绘幅度", lora: "风格强度", seed: "种子", negative: "不想要的内容", count: "张数", polish: "润色程度", reverse: "提示词反推", speed: "出图速度" } as Record<string, string>)[openPanel]}
                      </div>}
                    
                    {openPanel === "model" && (
                      <div className="flex flex-col">
                        {/* 用户 2026-11-11: opened from 「换成能用多张图的模型」 → only models that take several pictures. */}
                        {multiOnly && (
                          <div className="px-2.5 pb-1 text-[11px] text-muted">能用 {canvasSel.length} 张参考图的模型</div>
                        )}
                        {MODELS.filter((m) => !multiOnly || (paramsOf(m.id).maxRefs ?? 1) > 1).map((m) => {
                          const on = model === m.id;
                          const ready = isReady(m.id);
                          return (
                            <button
                              key={m.id}
                              type="button"
                              disabled={!ready}
                              onClick={() => { pickModel(m.id); setOpenPanel(null); }}
                              className={`flex items-center gap-3 rounded-xl px-2.5 py-2 text-left transition ${on ? "bg-accent/[0.08]" : "hover:bg-edge/[0.04]"} disabled:opacity-40`}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={iconOf(m.cover)} alt="" className="h-9 w-9 shrink-0 rounded-[10px] object-cover ring-1 ring-edge/[0.06]" />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13px] font-medium text-ink">{m.name}</span>
                                <span className="block truncate text-[11px] text-muted">{ready ? m.tagline : "待接入"}</span>
                              </span>
                              {on && <span className="text-[13px] text-accent">✓</span>}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {openPanel === "ratio" && (
                      <div>
                        <div className="grid grid-cols-5 gap-1.5">
                          {mode === "i2i" && modelParams.editRatio && <button type="button" aria-pressed={!fixedEditAspect}
                            onClick={() => { setEditRatio("auto"); setOpenPanel(null); }}
                            className={`rounded-lg px-1 py-1.5 text-[12px] font-medium ${!fixedEditAspect ? "bg-accent text-panel" : "bg-edge/[0.04]"}`}>自适应</button>}
                          {RATIOS.filter((r) => !modelParams.ratios || modelParams.ratios.includes(r.label)).map((r) => (
                            <button
                              key={r.label}
                              type="button"
                              onClick={() => { if (mode === "i2i") setEditRatio(r.label); else applyRatio(r.w, r.h); setOpenPanel(null); }}
                              className={`rounded-lg py-1.5 text-[12px] font-medium transition ${(mode === "i2i" ? editRatio === r.label : width === r.w && height === r.h) ? "bg-accent text-panel" : "bg-edge/[0.04] text-ink hover:bg-edge/[0.08]"}`}
                            >
                              {r.label}
                            </button>
                          ))}
                        </div>
                        {modelParams.customSize && (
                          <div className="mt-2 flex items-center gap-2 text-[12px] text-secondary">
                            自定义
                            <input inputMode="numeric" value={widthText} onChange={(e) => setWidthText(e.target.value.replace(/[^\d]/g, ""))} onBlur={commitWidth} className="w-20 rounded-lg bg-page px-2 py-1 text-center tabular-nums outline-none" aria-label="宽度" />
                            ×
                            <input inputMode="numeric" value={heightText} onChange={(e) => setHeightText(e.target.value.replace(/[^\d]/g, ""))} onBlur={commitHeight} className="w-20 rounded-lg bg-page px-2 py-1 text-center tabular-nums outline-none" aria-label="高度" />
                          </div>
                        )}
                      </div>
                    )}
                    {openPanel === "res" && <Choice options={(Object.keys(modelParams.resolutions ?? {}) as Res[]).map((r) => [r, r])} value={res} onPick={(v) => { setRes(v as Res); setOpenPanel(null); }} />}
                    {openPanel === "quality" && <Choice options={(Object.keys(QUALITY_LABELS) as Quality[]).filter((q) => modelParams.quality?.[q] != null).map((q) => [q, QUALITY_LABELS[q]])} value={quality} onPick={(v) => { setQuality(v as Quality); setOpenPanel(null); }} />}
                    {openPanel === "thinking" && <Choice note={`更懂复杂描述，慢一点，+¥${(modelParams.thinking ?? 0).toFixed(2)}`} options={[["0", "关"], ["1", "开"]]} value={thinking ? "1" : "0"} onPick={(v) => { setThinking(v === "1"); setOpenPanel(null); }} />}
                    {openPanel === "background" && <Choice options={[["auto", "自动"], ["transparent", "透明"], ["opaque", "不透明"]]} value={background} onPick={(v) => { setBackground(v as typeof background); setOpenPanel(null); }} />}
                    {openPanel === "reverse" && <Choice note="根据参考图自动写画面描述" options={[["direct", "直接生成（默认）", "反推完马上出图"], ["fill", "先填到提示词框", "反推结果放进框里，你改好再点生成"]]} value={reverseMode} onPick={(v) => { setReverseMode(v as "direct" | "fill"); try { localStorage.setItem("ais-reverse-mode", v); } catch {} setOpenPanel(null); }} />}
                    {openPanel === "polish" && <Choice note="@图 编号会保留" options={[["low", "低（默认）", "理顺表达，保留原意"], ["medium", "中", "重写描述，补足动作与画面细节"], ["high", "高", "深入设计构图、光影与材质"]]} value={polishLevel} onPick={(v) => { changePolishLevel(v as typeof polishLevel); setOpenPanel(null); }} />}
                    {openPanel === "complexity" && <Choice note="画之前想多久；不影响价格" options={[["auto", "自动（推荐）", "交给模型自己判断"], ["low", "快", "简单画面，出图更快"], ["medium", "标准", "一般画面"], ["high", "精细", "多人、多物体、细节多时更准，稍慢"]]} value={complexity} onPick={(v) => { setComplexity(v as typeof complexity); setOpenPanel(null); }} />}
                    {openPanel === "regional" && <Choice note="只改说的地方：描述里没提到的部分保持原样" options={[["0", "改整张图"], ["1", "只改说的地方"]]} value={regional ? "1" : "0"} onPick={(v) => { setRegional(v === "1"); setOpenPanel(null); }} />}
                    {openPanel === "count" && <Choice options={[["1", "1 张"], ["2", "2 张"], ["3", "3 张"], ["4", "4 张"]]} value={String(count)} onPick={(v) => { setCount(Number(v)); localStorage.setItem(COUNT_KEY, v); setOpenPanel(null); }} />}
                    {openPanel === "denoise" && (
                      // Same look as the other menus (用户 2026-11-06: 要统一): small grey title, then the control.
                      <div className="px-2.5 pb-2">
                        <div className="flex items-center pb-1 pt-1">
                          <span className="text-[12px] font-semibold text-muted">重绘幅度</span>
                          <span className="ml-auto text-[14px] tabular-nums text-accent">{denoise.toFixed(2)}</span>
                        </div>
                        <input
                          type="range"
                          min={0.01}
                          max={1}
                          step={0.01}
                          value={denoise}
                          onChange={(e) => setDenoise(Number(e.target.value))}
                          aria-label="重绘幅度"
                          className="soft-range w-full"
                          style={{ "--p": `${((denoise - 0.01) / 0.99) * 100}%` } as React.CSSProperties}
                        />
                        <div className="flex justify-between text-[11px] text-muted">
                          <span>更像原图</span>
                          <span>改得更多</span>
                        </div>
                      </div>
                    )}
                    {openPanel === "speed" && (
                      <div className="flex flex-col gap-1">
                        {([
                          ["standard", "标准", "24G 机器，平时用这个"],
                          ["fast", "高速", `48G 机器，贵约 30%；实测出图速度差不多`],
                        ] as const).map(([k, label, note]) => (
                          <button
                            key={k}
                            type="button"
                            onClick={() => { chooseSpeed(k); setOpenPanel(null); }}
                            className={`flex items-center justify-between rounded-xl px-2.5 py-2 text-left transition ${speed === k ? "bg-accent/[0.08]" : "hover:bg-edge/[0.04]"}`}
                          >
                            <span>
                              <span className="block text-[13px] font-medium text-ink">{label}</span>
                              <span className="block text-[11px] text-secondary">{note}</span>
                            </span>
                            {speed === k && <span className="text-accent">✓</span>}
                          </button>
                        ))}
                      </div>
                    )}
                    {openPanel === "lora" && (
                      <div className="flex items-center gap-3">
                        <span className="shrink-0 text-[12px] text-secondary">风格越强越像这个模型</span>
                        <input type="range" min={0} max={3} step={0.1} value={lora} onChange={(e) => setLora(Number(e.target.value))} aria-label="风格强度" className="flex-1" />
                        <span className="w-10 text-right text-[12px] tabular-nums text-accent">{lora.toFixed(1)}</span>
                      </div>
                    )}
                    {openPanel === "seed" && (
                      <div className="px-1.5 pb-1">
                        <div className="mb-1.5 text-[11px] text-muted">同一个种子出相似的图，留空就随机</div>
                        <input autoFocus inputMode="numeric" value={seedText} placeholder="随机" onChange={(e) => setSeedText(e.target.value.replace(/[^\d]/g, "").slice(0, 12))} className="w-full rounded-lg bg-page px-3 py-1.5 text-[13px] tabular-nums outline-none focus:ring-2 focus:ring-accent/30" aria-label="种子" />
                      </div>
                    )}
                    {openPanel === "negative" && (
                      <input autoFocus value={negative} placeholder="不想出现的东西，比如：文字、水印、多余的手指" onChange={(e) => setNegative(e.target.value.slice(0, 300))} className="w-full rounded-lg bg-page px-3 py-2 text-[12px] outline-none" aria-label="不想要的内容" />
                    )}
                  
                    </div>
                  )}
                  {chips.filter((c) => chipsMore || primaryChips.includes(c.key)).map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      data-setting={c.key}
                      aria-expanded={openPanel === c.key}
                      onClick={(e) => {
                        if (c.key === "model") anchorModel(e.currentTarget);
                        const row = chipRowRef.current;
                        const x = e.currentTarget.offsetLeft;
                        setPanelLeft(Math.max(0, Math.min(x, (row?.clientWidth ?? 600) - 300)));
                        setOpenPanel((v) => (v === c.key ? null : c.key));
                      }}
                      className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] transition ${openPanel === c.key ? "bg-accent/10 text-accent" : "bg-edge/[0.04] text-ink hover:bg-edge/[0.08]"}`}
                    >
                      {c.key === "model" && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={iconOf((findModel(model) ?? MODELS[0]).cover)} alt="" className="h-5 w-5 rounded-[5px] object-cover ring-1 ring-edge/[0.06]" />
                      )}
                      {c.label}
                      <svg className={`h-3 w-3 text-muted transition-transform ${openPanel === c.key ? "rotate-180" : ""}`} viewBox="0 0 16 16" fill="none"><path d="M4 10l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                    </button>
                  ))}
                  {chipsMore && mode === "i2i" && !findModel(model)?.billing && (
                    // 用户 2026-11-11: one chip — 提示词反推 is the parent switch, how to use it is its child option.
                    <div className={`compose-split flex h-8 items-center overflow-hidden rounded-full text-[12px] transition ${reverse ? "bg-accent/[0.08] ring-1 ring-accent/25" : "bg-edge/[0.04]"}`}>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={reverse}
                        data-tip="根据参考图自动写出画面描述（人物、服装、动作、背景），再和你写的要求一起用来生成"
                        onClick={() => {
                          const next = !reverse;
                          setReverse(next);
                          localStorage.setItem(REVERSE_KEY, next ? "on" : "off");
                          if (!next && openPanel === "reverse") setOpenPanel(null);
                        }}
                        className={`flex h-full items-center gap-1.5 pl-3 ${reverse ? "pr-2 font-medium text-accent hover:bg-accent/[0.06]" : "pr-3 text-ink hover:bg-edge/[0.04]"}`}
                      >
                        <span className={`relative inline-block h-[14px] w-[24px] rounded-full transition-colors ${reverse ? "bg-accent" : "bg-edge/[0.18]"}`}>
                          <span className={`absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white shadow transition-[left] ${reverse ? "left-[12px]" : "left-[2px]"}`} />
                        </span>
                        提示词反推
                      </button>
                      {reverse && (
                        <button
                          type="button"
                          aria-expanded={openPanel === "reverse"}
                          data-tip="直接生成：反推完马上出图；先填到框里：反推结果放进提示词框，你改好再生成"
                          onClick={(e) => {
                            const row = chipRowRef.current;
                            const x = (e.currentTarget.parentElement as HTMLElement).offsetLeft;
                            setPanelLeft(Math.max(0, Math.min(x, (row?.clientWidth ?? 600) - 300)));
                            setOpenPanel((v) => (v === "reverse" ? null : "reverse"));
                          }}
                          className={`flex h-full items-center gap-1 border-l border-accent/20 pl-2 pr-2.5 text-accent transition ${openPanel === "reverse" ? "bg-accent/15" : "hover:bg-accent/[0.12]"}`}
                        >
                          {reversing ? "反推中…" : reverseMode === "fill" ? "先填到框里" : "直接生成"}
                          <svg className={`h-3 w-3 text-muted transition-transform ${openPanel === "reverse" ? "rotate-180" : ""}`} viewBox="0 0 16 16" fill="none"><path d="M4 10l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                        </button>
                      )}
                    </div>
                  )}
                  {/* 用户 2026-11-10: 提示词润色 shows once there is a prompt to polish. */}
                  {(prompt.trim() || polishing) && (
                  <div className="compose-split animate-pop-in flex h-8 items-center overflow-hidden rounded-full bg-accent/[0.08] text-[12px] font-medium text-accent ring-1 ring-accent/25 transition hover:ring-accent/50">
                    <button
                      type="button"
                      onClick={runPolish}
                      disabled={!prompt.trim() || polishing}
                      data-tip="按当前提示词润色，@图 原样保留"
                      className="flex h-full items-center gap-1 pl-3 pr-2 transition hover:bg-accent/[0.12] active:scale-[0.97] disabled:opacity-40"
                    >
                      {polishing ? (
                        <span className="animate-spin-slow h-3 w-3 rounded-full border-[1.5px] border-accent/30 border-t-accent" />
                      ) : (
                        <svg className="h-3.5 w-3.5 text-accent" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l1.4 3.6L13 6 9.4 7.4 8 11 6.6 7.4 3 6l3.6-1.4L8 1zm4.5 8l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" /></svg>
                      )}
                      {polishing ? "润色中…" : "提示词润色"}
                    </button>
                    <button
                      type="button"
                      aria-expanded={openPanel === "polish"}
                      onClick={(e) => {
                        const row = chipRowRef.current;
                        const x = (e.currentTarget.parentElement as HTMLElement).offsetLeft;
                        setPanelLeft(Math.max(0, Math.min(x, (row?.clientWidth ?? 600) - 300)));
                        setOpenPanel((v) => (v === "polish" ? null : "polish"));
                      }}
                      className={`flex h-full items-center gap-1 border-l border-accent/20 pl-2 pr-2.5 transition ${openPanel === "polish" ? "bg-accent/15" : "hover:bg-accent/[0.12]"}`}
                    >
                      {{ low: "低", medium: "中", high: "高" }[polishLevel]}
                      <svg className={`h-3 w-3 text-muted transition-transform ${openPanel === "polish" ? "rotate-180" : ""}`} viewBox="0 0 16 16" fill="none"><path d="M4 10l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                    </button>
                  </div>
                  )}
                  {polishUndo && polishUndo.after === prompt && (
                    <button
                      type="button"
                      onClick={() => { editPrompt(polishUndo.before); setPolishUndo(null); }}
                      className="rounded-full px-2 py-1 text-[12px] text-accent hover:bg-accent/10"
                    >
                      撤销润色
                    </button>
                  )}
                  <div className="compose-submit">
                    <button
              onClick={startOrQueue}
              disabled={
                !modelReady || ((mode === "t2i" || !reverse) && !prompt.trim())
              }
              className="apple-btn-primary generate-button flex h-9 items-center justify-center gap-1.5 whitespace-nowrap px-4 text-[13px]"
            >
              {canvasOn && frameProgress.has(editingNode) ? (
                <><span>继续生成</span><span className="generate-price">¥{btnPrice}</span></>
              ) : loading && !(canvasOn && editingNode) ? (
                <>
                  <span className="animate-spin-slow h-3.5 w-3.5 rounded-full border-[1.5px] border-white/40 border-t-white" />
                  {batchTotal > 1 ? `${batchDone}/${batchTotal} 张` : `${Math.floor(progress)}%`}{queued ? ` · 排队 ${queued}` : " · 再点排队"}
                </>
              ) : !modelReady ? (
                <span>{findModel(model)?.name} 待接入</span>
              ) : (
                <>
                  <span>生成</span>
                  <span className="generate-price rounded-full bg-white/20 px-1.5 py-px text-[12px] font-semibold tabular-nums">
                    ¥{btnPrice}
                  </span>
                </>
              )}
            </button>
                  </div>
                </div>
                </div>


          
              </div>
              {error && (
              <div className="animate-chip-in mt-2 rounded-2xl bg-[light-dark(#fff1f0,#382022)] px-3.5 py-2.5 text-[12px] text-danger">
                {error}
              </div>
            )}
              {boardCompare && createPortal(
                // 用户 2026-11-11: 对比 on the board, full screen, same four ways as the single-picture view.
                <div className="animate-pop-in fixed inset-0 z-[96] flex flex-col bg-black/80 backdrop-blur-sm" onClick={() => setBoardCompare(null)}>
                  <div className="flex shrink-0 items-center justify-center gap-2 p-3" onClick={(e) => e.stopPropagation()}>
                    <div className="apple-seg flex bg-panel/90">
                      {COMPARE_MODES.map((m) => (
                        <button key={m.key} type="button" data-active={compareMode === m.key} onClick={() => setCompareMode(m.key)} className="apple-seg-item px-3 py-1 text-[12px] font-medium text-secondary">
                          {m.label}
                        </button>
                      ))}
                    </div>
                    <button type="button" aria-label="关闭对比" onClick={() => setBoardCompare(null)} className="flex h-8 w-8 items-center justify-center rounded-full bg-panel/90 text-[16px] text-ink hover:bg-panel">×</button>
                  </div>
                  <div className="min-h-0 flex-1 p-4 pt-0" onClick={(e) => e.stopPropagation()}>
                    <CompareView key={`${boardCompare.before}-${boardCompare.after}-${compareMode}`} before={fullOf(boardCompare.before)} after={fullOf(boardCompare.after)} mode={compareMode} />
                  </div>
                </div>, document.body
              )}
              {viewer && (() => {
                // Several pictures from this run: ← → move between them.
                const done = batch.map((id) => gallery.find((x) => x.id === id)).filter((g): g is GalleryItem => !!g?.url);
                const at = done.findIndex((g) => g.url === viewer);
                const step = at >= 0 && done.length > 1 ? (d: number) => () => { const g = done[(at + d + done.length) % done.length]; showItem(g); setViewer(g.url); } : null;
                return (
                  <ImageViewer
                    src={fullOf(viewer)}
                    onClose={() => setViewer(null)}
                    onPrev={step?.(-1)}
                    onNext={step?.(1)}
                    caption={at >= 0 && done.length > 1 ? `${at + 1}/${done.length}` : undefined}
                  />
                );
              })()}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
                  const slot = replaceSlot.current;
                  replaceSlot.current = null;
                  e.target.value = "";
                  if (canvasOn && editingNode) return canvasApi.current?.attachFiles(files, slot ?? undefined);
                  if (slot != null && files[0]) {
                    // 换图 on a picture swaps just that one.
                    if (slot === 0) onPickFile(files[0]);
                    else setExtraRefs((list) => list.map((x, j) => (j === slot - 1 ? { file: files[0], url: URL.createObjectURL(files[0]) } : x)));
                    flash(`已换掉图${slot + 1}`);
                    return;
                  }
                  addRefs(files);
                }}
              />
            </div>

          </div>

        </section>
        </div>

        {!histOff && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整历史栏宽度"
          onPointerDown={(e) => {
            draggingRef.current = "right";
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          }}
          className="panel-resizer hidden w-1.5 shrink-0 cursor-col-resize lg:block"
        />
        )}

        {/* Folded history: one small clock button in the corner (用户: 改成历史的图标). 2026-11-10: lives in the left rail now. */}
        {false && <button
          type="button"
          onClick={() => toggleHistory(false)}
          data-tip="历史记录" data-tip-end=""
          aria-label="打开历史记录"
          className="absolute right-4 top-4 z-40 flex h-10 w-10 items-center justify-center rounded-full bg-panel/90 text-ink shadow-[0_6px_20px_rgba(0,0,0,0.12)] ring-1 ring-edge/[0.06] backdrop-blur-xl transition hover:scale-105 active:scale-95"
          style={{ opacity: histOff ? 1 : 0, transform: histOff ? "none" : "scale(0.6)", pointerEvents: histOff ? undefined : "none", transition: "opacity 260ms ease, transform 320ms cubic-bezier(0.22, 1, 0.36, 1)" }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v5h5" />
            <path d="M12 7.5V12l3 2" />
          </svg>
        </button>}
        <aside
          className={`apple-card stagger-3 relative w-full shrink-0 overflow-hidden rounded-[22px] lg:min-h-0 lg:w-[34vw] lg:max-w-[calc(100vw-420px)] ${histOff ? "pointer-events-none min-h-0 max-lg:hidden" : "min-h-[40vh]"}`}
          style={
            isDesktop
              ? {
                  width: histOff ? 0 : rightPx,
                  opacity: histOff ? 0 : 1,
                  // Glides open / closed; follows the pointer instantly while being dragged.
                  transition: draggingRef.current ? "none" : "width 420ms cubic-bezier(0.22, 1, 0.36, 1), opacity 300ms ease",
                }
              : undefined
          }
        >
          <div
            className="flex h-full flex-col"
            style={{
              width: isDesktop ? rightPx : undefined,
              opacity: histOff ? 0 : 1,
              transform: histOff ? "translateX(24px)" : "none",
              transition: "opacity 260ms ease, transform 420ms cubic-bezier(0.22, 1, 0.36, 1)",
              pointerEvents: histOff ? "none" : undefined,
              display: !isDesktop && histOff ? "none" : undefined,
            }}
          >
          <div className="panel-header flex h-[52px] shrink-0 items-center gap-2 border-b border-edge/[0.06] px-4 justify-between">
            {/* 2026-11-05 (用户选方案 A): 历史 + count, two icons; spend lives in the filter panel. */}
            <h2 className="text-[14px] font-semibold tracking-[-0.02em] text-ink">
              历史 <span className="ml-0.5 text-[12px] font-normal tabular-nums text-muted">{histStats.done}{histStats.pending ? ` · 画着 ${histStats.pending}` : ""}</span>
            </h2>
            <span className="ml-auto" />
            <button
              type="button"
              onClick={() => setHistToolsOpen((v) => !v)}
              data-tip="搜索 / 筛选" data-tip-end=""
              aria-label="搜索 / 筛选"
              aria-pressed={histToolsOpen}
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition ${histToolsOpen || histQuery || histMode !== "all" || histFilter !== "all" || histSort !== "new" ? "bg-accent/10 text-accent" : "text-secondary hover:bg-edge/[0.05]"}`}
            >
              <svg viewBox="0 0 24 24" className="h-[15px] w-[15px]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16l-6 7.5V19l-4 1.5v-8z" /></svg>
            </button>
            <button
              type="button"
              onClick={() => toggleHistory(true)}
              data-tip="收起历史" data-tip-end=""
              aria-label="收起历史"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-secondary transition hover:bg-edge/[0.05]"
            >
              <svg viewBox="0 0 24 24" className="h-[15px] w-[15px]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M13 6l6 6-6 6M5 6l6 6-6 6" /></svg>
            </button>
          </div>
          {histToolsOpen && (
          // 2026-11-05 (用户: 筛选点开后要极简): one search line and one row of chips (state, model, order).
          <div className="animate-pop-in shrink-0 space-y-2 px-3 pb-2.5 pt-1">
            <label className="flex items-center gap-2 rounded-full bg-well px-3 py-1.5">
              <svg viewBox="0 0 24 24" className="h-[14px] w-[14px] shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
              <input
                value={histQuery}
                onChange={(e) => {
                  setHistQuery(e.target.value);
                  setHistPage(0);
                }}
                placeholder="搜索描述"
                className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-hint"
              />
            </label>
            <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
              {(
                [
                  ["all", "全部"],
                  ["fav", "★ 收藏"],
                  ["bad", "失败"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setHistFilter(key);
                    setHistMode("all");
                    setHistPage(0);
                  }}
                  className={`rounded-full px-2.5 py-1 ${histFilter === key ? "bg-ink text-panel" : "bg-well text-[color:light-dark(#3a3a3c,#d3d3d6)] hover:bg-edge/[0.08]"}`}
                >
                  {label}
                </button>
              ))}
              {/* Model and order: chips that open the system picker. */}
              <label className={`relative flex items-center gap-1 rounded-full px-2.5 py-1 ${histFilter.startsWith("model:") ? "bg-ink text-panel" : "bg-well text-[color:light-dark(#3a3a3c,#d3d3d6)] hover:bg-edge/[0.08]"}`}>
                <span className="max-w-[110px] truncate">{histFilter.startsWith("model:") ? findModel(histFilter.slice(6))?.name ?? "模型" : "模型"}</span>
                <svg viewBox="0 0 24 24" className="h-3 w-3 opacity-60" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg>
                <select
                  value={histFilter.startsWith("model:") ? histFilter : ""}
                  onChange={(e) => {
                    setHistFilter(e.target.value || "all");
                    setHistPage(0);
                  }}
                  className="absolute inset-0 cursor-pointer opacity-0"
                  aria-label="按模型筛选"
                >
                  <option value="">全部模型</option>
                  {MODELS.map((m) => (
                    <option key={m.id} value={`model:${m.id}`}>{m.name}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => (selMode ? endSel() : setSelMode(true))}
                className={`ml-auto rounded-full px-2.5 py-1 ${selMode ? "bg-accent text-panel" : "bg-well text-[color:light-dark(#3a3a3c,#d3d3d6)] hover:bg-edge/[0.08]"}`}
              >
                多选
              </button>
              <label className="relative flex items-center gap-1 rounded-full px-2 py-1 text-secondary hover:bg-edge/[0.05]">
                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4" /></svg>
                {{ new: "最新", old: "最早", cost: "最贵", slow: "最久" }[histSort]}
                <select
                  value={histSort}
                  onChange={(e) => {
                    setHistSort(e.target.value as typeof histSort);
                    setHistPage(0);
                  }}
                  className="absolute inset-0 cursor-pointer opacity-0"
                  aria-label="排序"
                >
                  <option value="new">最新在前</option>
                  <option value="old">最早在前</option>
                  <option value="cost">最贵在前</option>
                  <option value="slow">用时最久在前</option>
                </select>
              </label>
            </div>
            <div className="text-[11px] tabular-nums text-hint">{visibleHistory.length} 张 · 累计约 ¥{histStats.cost}</div>
          </div>
          )}

          <div
            className="min-h-0 flex-1 overflow-y-auto p-2"
            onScroll={(e) => {
              const el = e.currentTarget;
              if (histHasMore && el.scrollTop + el.clientHeight > el.scrollHeight - 500) setHistPage((p) => p + 1);
            }}
          >
            {visibleHistory.length === 0 ? (
              <p className="px-2 py-8 text-center text-[12px] text-hint">
                {gallery.length ? "没有符合条件的记录" : "生成的图片会保存在这里"}
              </p>
            ) : (
              <div key={`${histMode}-${histFilter}-${histSort}`} className="history-grid flex flex-col gap-2">
                {(() => {
                  // 2026-11-05 (用户: 历史图片之间缺一块): columns stacked by picture height, no gaps.
                  const heightOf = (g: GalleryItem) => (g.url ? aspects[g.id] ?? 1 : 1) + 0.05;
                  // More columns as the panel is dragged wider.
                  const nCols = !isDesktop ? 2 : rightPx >= 900 ? 4 : rightPx >= 620 ? 3 : 2;
                  const place = (list: GalleryItem[]) => {
                    const h = Array(nCols).fill(0) as number[];
                    return list.map((g) => {
                      const c = h.indexOf(Math.min(...h));
                      const top = h[c];
                      h[c] += heightOf(g);
                      return { g, c, top, bottom: h[c] };
                    });
                  };
                  const laid = place(pageItems);
                  const iconBtn =
                    "relative flex h-7 w-7 items-center justify-center rounded-full text-white transition hover:bg-white/25 active:scale-90";
                  // 2026-11-05 (用户: 历史再简化，信息和按钮合进鼠标悬停): hover (or the selected picture on phones)
                  // shows the actions on top and model · time · cost + the description at the bottom.
                  const card = (g: GalleryItem) => {
                    const on = g.id === currentId;
                    // The picture being viewed always shows its buttons and details (用户: 当前预览的直接显示，不然用户不知道);
                    // the others show them on hover.
                    const show = selMode ? "pointer-events-none opacity-0" : on ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100";
                    const picked = selected.has(g.id);
                    const open = promptOpenId === g.id;
                    const meta = [
                      findModel(g.model)?.name ?? g.label ?? "棕色尘埃",
                      formatDuration(g.durationMs),
                      g.cost ? `¥${g.cost}` : "",
                    ].filter(Boolean).join(" · ");
                    const act = (e: React.MouseEvent, fn: () => void) => {
                      e.stopPropagation();
                      fn();
                    };
                    return (
                    <div
                      role="button"
                      tabIndex={0}
                      draggable={!!g.url}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(HIST_DRAG, g.id);
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      onClick={() => {
                        if (selMode) {
                          toggleSel(g.id);
                          return;
                        }
                        if (g.url && canvasOn && canvasApi.current) {
                          // 画布模式: the picture goes onto the board (or the board jumps to it).
                          canvasApi.current.add(g.id);
                          return;
                        }
                        if (g.url) {
                          setError(null);
                          setCompareOn(false);
                          showItem(g);
                          if (window.innerWidth < 1024) scrollToResult();
                        } else {
                          setError(
                            g.status === "expired"
                              ? `这张图已过期：${g.error || "RunningHub 已清理原图"}`
                              : `这条记录生成失败：${g.error || "任务失败"}`
                          );
                        }
                      }}
                      className={`history-card group relative cursor-pointer overflow-hidden rounded-xl bg-panel text-left outline-none ${
                        on ? "outline outline-2 -outline-offset-2 outline-accent" : "ring-1 ring-edge/[0.08] hover:ring-edge/[0.2]"
                      }`}
                    >
                      <span className={`relative block w-full bg-well ${g.url ? "min-h-[60px]" : "aspect-square"}`}>
                        {g.url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={thumbOf(g.url, isDesktop && rightPx / nCols > 200 ? 640 : 320)} alt="" loading="lazy" decoding="async" className="block h-auto w-full" onLoad={(e) => noteAspect(g.id, e.currentTarget)} />
                        ) : (
                          <span className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center">
                            <span className={`text-[12px] font-semibold ${g.status === "expired" ? "text-muted" : "text-danger"}`}>
                              {g.status === "expired" ? "已过期" : "失败"}
                            </span>
                            <span className="line-clamp-3 text-[10px] leading-snug text-muted">{g.error || "任务失败"}</span>
                          </span>
                        )}
                      </span>
                      {selMode && (
                        <span className={`pointer-events-none absolute inset-0 z-10 transition ${picked ? "bg-accent/15 ring-[3px] ring-inset ring-accent" : "bg-white/10"}`}>
                          <span className={`absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border-2 text-[13px] text-white shadow ${picked ? "border-accent bg-accent" : "border-white bg-edge/20"}`}>
                            {picked ? "✓" : ""}
                          </span>
                        </span>
                      )}
                      {g.url && (
                        <>
                          <span className={`pointer-events-none absolute inset-0 bg-gradient-to-b from-black/35 via-transparent to-black/70 transition-opacity duration-300 ${show}`} />
                          {/* 2026-11-10 (用户: 不要显示那么多，两个最重要的加一个收纳菜单): 看大图 and 下载 on the card,
                              the rest in the ⋯ menu. A favourite keeps its gold star visible. */}
                          {(g.fav || onBoard.has(g.id)) && (
                            <span className="pointer-events-none absolute left-2 top-2 flex items-center gap-1 drop-shadow-[0_1px_2px_rgba(0,0,0,0.55)]">
                              {g.fav && <span className="text-[15px] leading-none text-[#ffcc00]">★</span>}
                              {onBoard.has(g.id) && (
                                // 用户 2026-11-10: 历史里已经放到画布上的图做个小标记.
                                <span className="rounded-full bg-[#1d1d1f]/70 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">画布</span>
                              )}
                            </span>
                          )}
                          <span className="absolute right-1 top-1 flex items-center drop-shadow-[0_1px_2px_rgba(0,0,0,0.55)]">
                            <button type="button" data-tip="看大图" aria-label="看大图" onClick={(e) => act(e, () => setViewer(g.url))} className={`${iconBtn} transition-opacity duration-300 ${show}`}>
                              <svg viewBox="0 0 24 24" className="h-[14px] w-[14px]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
                            </button>
                            <button type="button" data-tip="下载" aria-label="下载" onClick={(e) => act(e, () => downloadItem(g))} className={`${iconBtn} transition-opacity duration-300 ${show}`}>
                              <svg viewBox="0 0 24 24" className="h-[14px] w-[14px]" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
                            </button>
                            <button
                              type="button"
                              data-tip="更多" data-tip-end=""
                              aria-label="更多"
                              aria-expanded={cardMenu === g.id}
                              onClick={(e) => {
                                const r = e.currentTarget.getBoundingClientRect();
                                setCardMenuAt({ x: Math.min(r.right, window.innerWidth - 8), y: r.bottom + 4 });
                                act(e, () => { setCardMenu((v) => (v === g.id ? null : g.id)); setDeleteArm(null); });
                              }}
                              className={`${iconBtn} transition-opacity duration-300 ${cardMenu === g.id ? "opacity-100" : show}`}
                            >
                              <svg viewBox="0 0 24 24" className="h-[14px] w-[14px]" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
                            </button>
                          </span>
                          {cardMenu === g.id && createPortal(
                            <div
                              data-card-menu=""
                              className="animate-pop-in fixed z-[90] w-[132px] -translate-x-full rounded-xl bg-panel p-1 text-[12px] text-ink shadow-[0_12px_32px_rgba(0,0,0,0.22)] ring-1 ring-edge/[0.06]"
                              style={{ left: cardMenuAt.x, top: Math.min(cardMenuAt.y, window.innerHeight - 220) }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {[
                                [g.fav ? "取消收藏" : "收藏", () => toggleFav(g)],
                                ["重新编辑", () => editHistoryItem(g)],
                                ["当参考图", () => useAsReference(g)],
                                ["复制描述", () => copyPrompt(g)],
                                ...(canvasOn ? [["放到画布", () => canvasApi.current?.add(g.id)]] : []),
                              ].map(([t, fn]) => (
                                <button
                                  key={t as string}
                                  type="button"
                                  onClick={() => { (fn as () => void)(); setCardMenu(null); }}
                                  className="block w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-edge/[0.05]"
                                >
                                  {t as string}
                                </button>
                              ))}
                              <button
                                type="button"
                                onClick={() => { deleteItem(g); if (deleteArm === g.id) setCardMenu(null); }}
                                className={`block w-full rounded-lg px-2.5 py-1.5 text-left ${deleteArm === g.id ? "bg-[#ff3b30] text-white" : "text-danger hover:bg-[#ff3b30]/10"}`}
                              >
                                {deleteArm === g.id ? "再点一次删除" : "删除"}
                              </button>
                            </div>,
                            document.body
                          )}
                          <span
                            className={`absolute inset-x-0 bottom-0 px-2.5 pb-2 text-white transition-opacity duration-300 ${open ? "max-h-full overflow-y-auto bg-black/70 pt-2 opacity-100 backdrop-blur-sm" : show}`}
                            onClick={(e) => open && e.stopPropagation()}
                          >
                            <span className="block truncate text-[10px] font-medium tabular-nums opacity-80">{meta}</span>
                            {g.prompt && <span className={`mt-0.5 text-[11px] leading-snug ${open ? "block whitespace-pre-wrap" : "line-clamp-2"}`}>{g.prompt}</span>}
                            {g.prompt.length > 70 && (
                              <button
                                type="button"
                                onClick={(e) => act(e, () => setPromptOpenId(open ? null : g.id))}
                                className="mt-0.5 text-[11px] font-medium text-white/80 underline-offset-2 hover:text-white hover:underline"
                              >
                                {open ? "收起" : "展开"}
                              </button>
                            )}
                          </span>
                        </>
                      )}
                    </div>
                    );
                  };
                  return (
                    <div className="flex items-start gap-2">
                      {Array.from({ length: nCols }, (_, ci) => ci).map((ci) => (
                        <div key={ci} className="flex min-w-0 flex-1 flex-col gap-2">
                          {laid.filter((x) => x.c === ci).map((x) => <Fragment key={x.g.id}>{card(x.g)}</Fragment>)}
                        </div>
                      ))}
                    </div>
                  );
                })()}
                {histHasMore && (
                  <button type="button" onClick={() => setHistPage((p) => p + 1)} className="mx-auto mt-1 block rounded-full px-3 py-1 text-[11px] text-muted hover:bg-edge/[0.04]">
                    加载更多
                  </button>
                )}
              </div>
            )}
          </div>
          {selMode && (
            <div className="animate-pop-in flex shrink-0 items-center gap-1.5 border-t border-edge/[0.06] px-3 py-2 text-[12px]">
              <span className="tabular-nums text-secondary">已选 {selected.size}</span>
              <button
                type="button"
                onClick={() => setSelected(selected.size === pageItems.filter((g) => g.url).length ? new Set() : new Set(pageItems.filter((g) => g.url).map((g) => g.id)))}
                className="rounded-full px-2 py-1 text-accent hover:bg-accent/10"
              >
                {selected.size && selected.size === pageItems.filter((g) => g.url).length ? "全不选" : "全选"}
              </button>
              <span className="ml-auto" />
              <button type="button" disabled={!selected.size} onClick={bulkDownload} className="rounded-full bg-well px-3 py-1 text-ink hover:bg-edge/[0.08] disabled:opacity-40">
                下载
              </button>
              <button
                type="button"
                disabled={!selected.size}
                onClick={bulkDelete}
                className={`rounded-full px-3 py-1 disabled:opacity-40 ${bulkArm ? "bg-[#ff3b30] text-white" : "bg-[#ff3b30]/10 text-[#ff3b30] hover:bg-[#ff3b30]/15"}`}
              >
                {bulkArm ? "再点一次删除" : "删除"}
              </button>
              <button type="button" onClick={endSel} className="rounded-full px-2 py-1 text-secondary hover:bg-edge/[0.05]">
                完成
              </button>
            </div>
          )}
          </div>
        </aside>
      </main>

    </div>
  );
}
