"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { GeneratingView } from "./generating-view";
import { COMPARE_MODES, CompareView, type CompareMode } from "./compare-view";
import {
  DEFAULT_MODEL,
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

type Readiness = Record<string, Record<Mode, boolean>>;

type GalleryItem = {
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
};

/** 24 秒 / 1 分 05 秒 */
function formatDuration(ms?: number): string | null {
  if (!ms || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, "0")} 秒`;
}

type PendingJob = {
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
const EST_COST = "0.07";
const PENDING_KEY = "krea-studio.pending-job";
const MODEL_KEY = "krea-studio.model";
const COUNT_KEY = "krea-studio.count";
const REVERSE_KEY = "krea-studio.reverse-prompt";
const PANEL_LEFT_KEY = "krea-studio.panel-left";
const PANEL_RIGHT_KEY = "krea-studio.panel-right";
// Netlify buffers function requests and binary uploads incur Base64 overhead.
// Leave room for multipart fields and the platform's 6 MB request limit.
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

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
  // 2026-11-05 (用户: 不分了，合成吧): one form — a reference image makes it 图生图, none makes it 文生图.
  const [mode, setMode] = useState<Mode>("t2i");
  const [model, setModel] = useState<ModelId>(DEFAULT_MODEL);
  const [reverse, setReverse] = useState(true);
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
  const [background, setBackground] = useState<"auto" | "transparent" | "opaque">("auto");
  const [complexity, setComplexity] = useState<"auto" | "low" | "medium" | "high">("auto");
  const [regional, setRegional] = useState(false);
  const [extraRefs, setExtraRefs] = useState<{ file: File; url: string }[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  /** GPT takes a free size: the ratio scaled to the 清晰度 tier's pixel count; other models keep their own size. */
  const sizeFor = (ratio: number, fallback?: { width: number; height: number }) => {
    if (!paramsOf(model).pricePerMegapixel && fallback) return fallback;
    const px = RES_PIXELS[res];
    const w = Math.round(Math.sqrt(px * ratio) / 16) * 16;
    return { width: w, height: Math.round(w / ratio / 16) * 16 };
  };

  /** Extra request fields for the selected model (only what it supports). */
  const advanced = (): Record<string, string | number> => {
    const p = paramsOf(model);
    const out: Record<string, string | number> = {};
    if (p.seed && seedText.trim() && Number.isFinite(Number(seedText))) out.seed = Math.floor(Number(seedText));
    if (p.negative && negative.trim()) out.negative = negative.trim();
    if (p.lora) out.lora = lora;
    if (p.background && background !== "auto") out.background = background;
    if (p.complexity && complexity !== "auto") out.complexity = complexity;
    return out;
  };
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
  const [resultSize, setResultSize] = useState<{ w: number; h: number } | null>(null);
  const [compareOn, setCompareOn] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [histMode, setHistMode] = useState<"all" | Mode>("all");
  // "all" | "ok" | "bad" | "model:<id>"
  const [histFilter, setHistFilter] = useState<string>("all");
  const [histQuery, setHistQuery] = useState("");
  const [histPage, setHistPage] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [count, setCount] = useState(1);
  // Task ids of the latest batch, for the result strip under the preview.
  const [batch, setBatch] = useState<string[]>([]);
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
    if (savedR >= 240 && savedR <= 560) setRightPx(savedR);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  const fileRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const resultRef_ = useRef<HTMLElement>(null);
  const fileBlobRef = useRef<File | null>(null);
  const timerRef = useRef<number | null>(null);

  // Grow the description box with its text, up to a cap (then it scrolls).
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    const max = Math.max(160, Math.round(window.innerHeight * 0.4));
    el.style.height = "auto";
    el.style.height = `${Math.min(max, Math.max(104, el.scrollHeight + 2))}px`;
    el.style.overflowY = el.scrollHeight + 2 > max ? "auto" : "hidden";
  }, [prompt, mode]);
  const jobRef = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    return () => {
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
        const next = Math.min(560, Math.max(240, window.innerWidth - e.clientX - 8));
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
    const saved = findModel(localStorage.getItem(MODEL_KEY));
    if (saved) setModel(saved.id);
    if (localStorage.getItem(REVERSE_KEY) === "off") setReverse(false);
    const savedCount = Number(localStorage.getItem(COUNT_KEY));
    if (savedCount >= 1 && savedCount <= 4) setCount(savedCount);
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
    fetchJson("/api/history")
      .then((d) => {
        if (d?.ok && Array.isArray(d.items) && d.items.length) {
          setGallery(d.items);
          const first = (d.items as GalleryItem[]).find((x) => x.url);
          if (first) showItem(first);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (loading) {
      setProgress(progressFor(timingRef.current, Date.now()));
      timerRef.current = window.setInterval(() => {
        const next = progressFor(timingRef.current, Date.now());
        setProgress((p) => Math.max(p, next)); // never move backwards
      }, 200);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [loading]);

  const showItem = useCallback((g: GalleryItem) => {
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
    if (!allowed) return;
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
    fileBlobRef.current = file;
    setPreview(file ? URL.createObjectURL(file) : null);
  }, []);

  /** The first picture becomes the main reference; more go to the extra references (up to the model's limit). */
  const addRefs = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      let rest = files;
      if (!fileBlobRef.current) {
        onPickFile(files[0]);
        rest = files.slice(1);
      }
      if (rest.length) setExtraRefs((list) => [...list, ...rest.map((file) => ({ file, url: URL.createObjectURL(file) }))].slice(0, 7));
    },
    [onPickFile]
  );

  const [mentionOpen, setMentionOpen] = useState(false);
  /** Inserts "@图N " at the caret in the description. */
  const insertMention = (n: number, replaceAt?: boolean) => {
    const el = promptRef.current;
    const tag = `@图${n} `;
    const start = el?.selectionStart ?? prompt.length;
    const end = el?.selectionEnd ?? prompt.length;
    // When opened by typing "@", replace that "@".
    const from = replaceAt && prompt[start - 1] === "@" ? start - 1 : start;
    const next = prompt.slice(0, from) + tag + prompt.slice(end);
    setPrompt(next);
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

  const flash = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((n) => (n === text ? null : n)), 1800);
  }, []);

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

  /** Load a history item's settings back into the form. */
  const reuseItem = useCallback(
    (g: GalleryItem) => {
      setMode(g.mode);
      const m = findModel(g.model);
      if (m) {
        setModel(m.id);
        localStorage.setItem(MODEL_KEY, m.id);
      }
      setPrompt(g.prompt);
      flash("已填入这条记录的模型与提示词");
    },
    [flash]
  );

  /** Save an image with a readable name (works for our copies and remote links). */
  const downloadItem = useCallback(
    async (g: GalleryItem) => {
      const name = `AI-Studio_${(findModel(g.model)?.name ?? g.label ?? "image").replace(/\s+/g, "-")}_${formatTime(
        g.createdAt
      ).replace(/[: ]/g, "-")}.png`;
      try {
        let href = g.url;
        let revoke = false;
        if (!g.url.startsWith("/")) {
          const res = await fetch(g.url);
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
        const res = await fetch(g.url);
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
      const files = e.clipboardData?.files;
      if (!files || !files.length) return;
      const file = Array.from(files).find((f) => f.type.startsWith("image/"));
      if (file) addRefs([file]);
    };
    window.addEventListener("paste", onPaste);
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
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
    window.addEventListener("drop", onEnd);
    window.addEventListener("dragend", onEnd);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onEnd);
      window.removeEventListener("dragend", onEnd);
    };
  }, [addRefs]);

  const pollTask = useCallback(async (taskId: string, job: number) => {
    const start = Date.now();
    let failures = 0;
    while (jobRef.current === job) {
      if (Date.now() - start > 600_000) {
        throw new Error("生成超时，请稍后重试");
      }
      let d: any;
      try {
        d = await fetchJson(`/api/task?taskId=${encodeURIComponent(taskId)}`);
      } catch (e) {
        if (jobRef.current !== job) return null;
        if (++failures >= 8) throw e;
        await sleep(2000);
        continue;
      }
      if (jobRef.current !== job) return null;
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
    async (pending: PendingJob, job: number, shown: { v: boolean }): Promise<GalleryItem | null> => {
      const done = await pollTask(pending.taskId, job);
      if (done === null || jobRef.current !== job) return null;
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
        refUrl: pending.refUrl,
        cost: done.cost || null,
        createdAt: pending.createdAt,
        durationMs: Date.now() - pending.createdAt,
      };
      setGallery((g) => [item, ...g.filter((x) => x.taskId !== item.taskId && x.url !== item.url)].sort(
        (a, b) => b.createdAt - a.createdAt
      ));
      if (!shown.v) {
        shown.v = true;
        showItem(item);
      }
      dropPending(pending.taskId);
      const saved = await fetchJson("/api/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
      }).catch(() => null);
      // The server keeps a permanent copy; point history at it.
      const kept = saved?.item?.url;
      if (typeof kept === "string" && kept !== url) {
        setGallery((g) => g.map((x) => (x.id === item.id ? { ...x, url: kept } : x)));
      }
      return item;
    },
    [pollTask, showItem]
  );

  /** Run a whole batch in parallel; errors only surface if every image failed. */
  const finishBatch = useCallback(
    async (pendings: PendingJob[], job: number) => {
      setBatch(pendings.map((p) => p.taskId));
      const shown = { v: false };
      const results = await Promise.allSettled(pendings.map((p) => finishPending(p, job, shown)));
      if (jobRef.current !== job) return;
      const t = timingRef.current;
      if (t.step === "render" && t.renderKey && t.stepStart) {
        recordSeconds(t.renderKey, (Date.now() - t.stepStart) / 1000);
      }
      setProgress(100);
      fetchJson("/api/status")
        .then((d) => {
          if (d?.account?.remainMoney != null) setMoney(String(d.account.remainMoney));
        })
        .catch(() => {});
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed.length === results.length) throw failed[0].reason;
      if (failed.length) {
        setError(`${failed.length} 张没有生成成功：${failed[0].reason?.message || "任务失败"}`);
      }
    },
    [finishPending]
  );

  const resumePending = useCallback((pendings: PendingJob[]) => {
    if (busyRef.current || !pendings.length) return;
    busyRef.current = true;
    const job = ++jobRef.current;
    const first = pendings[0];
    const renderKey = `${first.model ?? "brown-dust"}:${first.mode}`;
    timingRef.current = {
      step: "render",
      stepStart: first.createdAt || Date.now(),
      est: { describe: 0, submit: 0, render: estimateSeconds(renderKey, DEFAULT_SECONDS[first.mode]) },
      renderKey: "", // resumed runs started earlier; don't learn from them
    };
    setJobVisual({ aspect: 1, reference: first.mode === "i2i" ? first.refUrl ?? null : null });
    setLoading(true);
    setError(null);
    finishBatch(pendings, job)
      .catch((e: any) => {
        if (jobRef.current !== job) return;
        const message = e?.message || "查询任务失败";
        setError(`${message}（刷新页面可继续查询）`);
        if (/任务失败|已完成但未返回|不存在|错误码|审核/.test(message)) writePending([]);
      })
      .finally(() => {
        if (jobRef.current === job) {
          busyRef.current = false;
          setLoading(false);
        }
      });
  }, [finishBatch]);

  useEffect(() => {
    const pendings = readPending();
    if (pendings.length) resumePending(pendings);
  }, [resumePending]);

  const generate = useCallback(async () => {
    if (busyRef.current) return;
    const leftover = readPending();
    if (leftover.length) {
      resumePending(leftover);
      return;
    }
    setError(null);
    if ((mode === "t2i" || !reverse) && !prompt.trim()) {
      setError("请先输入描述");
      return;
    }
    if (readiness && !readiness[model]?.[mode]) {
      setError(`${findModel(model)?.name ?? "该模型"}还在接入中，请先选择其他模型`);
      return;
    }
    const imageFile = fileBlobRef.current;
    if (mode === "i2i" && !imageFile) {
      setError("请先上传参考图");
      return;
    }
    busyRef.current = true;
    const job = ++jobRef.current;
    const useReverse = mode === "i2i" && reverse;
    const renderKey = `${model}:${mode}`;
    timingRef.current = {
      step: useReverse ? "describe" : "submit",
      stepStart: Date.now(),
      est: {
        describe: useReverse ? estimateSeconds("describe", DEFAULT_SECONDS.describe) : 0,
        submit: DEFAULT_SECONDS.submit,
        render: estimateSeconds(renderKey, DEFAULT_SECONDS[mode]),
      },
      renderKey,
    };
    setJobVisual({
      aspect: mode === "i2i" && preview ? previewAspect : width / height,
      reference: mode === "i2i" ? preview : null,
    });
    setLoading(true);
    // On phones the result sits below the form: bring it into view.
    if (window.innerWidth < 1024) {
      window.setTimeout(scrollToResult, 60);
    }
    setResultUrl(null);
    setBatch([]);
    setResultRef(null);
    setResultSize(null);
    try {
      let data: any;
      const userPrompt = prompt.trim();
      let finalPrompt = userPrompt;
      if (mode === "i2i" && reverse) {
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
        if (jobRef.current !== job) return;
        startStep("submit");
      }
      if (mode === "t2i") {
        data = await fetchJson("/api/generate/t2i", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: finalPrompt,
            model,
            count,
            ...sizeFor(clampRes(Number(widthText) || width) / clampRes(Number(heightText) || height), {
              width: clampRes(Number(widthText) || width),
              height: clampRes(Number(heightText) || height),
            }),
            res,
            quality,
            thinking: thinking && !!paramsOf(model).thinking,
            ...advanced(),
          }),
        });
      } else {
        const fd = new FormData();
        fd.append("prompt", finalPrompt);
        fd.append("model", model);
        fd.append("count", String(count));
        fd.append("image", await prepareReferenceImage(imageFile as File));
        fd.append("denoise", String(denoise));
        fd.append("quality", quality);
        fd.append("res", res);
        if (paramsOf(model).pricePerMegapixel) {
          const sz = sizeFor(previewAspect || 1);
          fd.append("width", String(sz.width));
          fd.append("height", String(sz.height));
        }
        if (thinking && paramsOf(model).thinking) fd.append("thinking", "1");
        for (const [k, v] of Object.entries(advanced())) fd.append(k, String(v));
        if (regional && paramsOf(model).regional) fd.append("regional", "1");
        for (const r of extraRefs.slice(0, (paramsOf(model).maxRefs ?? 1) - 1)) fd.append("ref", await describeCopy(r.file), "ref.jpg");
        data = await fetchJson("/api/generate/i2i", { method: "POST", body: fd });
      }
      if (jobRef.current !== job) return;
      if (!data?.ok || !data?.taskId) {
        throw new Error(data?.error || "任务创建失败");
      }
      startStep("render");
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
        createdAt: now + i,
      }));
      writePending(pendings);
      await finishBatch(pendings, job);
    } catch (e: any) {
      if (jobRef.current === job) {
        setError(e?.message || "网络错误");
      }
    } finally {
      if (jobRef.current === job) {
        busyRef.current = false;
        setLoading(false);
      }
    }
  }, [mode, model, reverse, readiness, preview, previewAspect, startStep, count, prompt, width, height, widthText, heightText, denoise, quality, res, thinking, seedText, negative, lora, background, complexity, regional, extraRefs, finishBatch, resumePending]);

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
    const fixed = base != null ? base + (thinking && p.thinking ? p.thinking : 0) : findModel(model)?.price;
    if (fixed) {
      const total = fixed * count;
      return total >= 1 ? total.toFixed(2) : total.toFixed(3).replace(/0$/, "");
    }
    let list = costs((g) => (g.model ?? "brown-dust") === model && g.mode === mode && !findModel(g.model)?.price);
    if (!list.length) list = costs((g) => !findModel(g.model)?.price);
    const each = list.length ? list[Math.floor(list.length / 2)] : Number(EST_COST);
    const total = each * count;
    return total >= 1 ? total.toFixed(2) : total.toFixed(3).replace(/0$/, "");
  })();
  const currentItem = gallery.find((g) => g.id === currentId) ?? null;
  const modelParams = paramsOf(model);
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
        (histFilter === "ok" && !!g.url) ||
        (histFilter === "bad" && !g.url) ||
        histFilter === `model:${g.model ?? (g.label ? "" : "brown-dust")}`) &&
      (!query || g.prompt.toLowerCase().includes(query))
  );
  const HIST_PAGE_SIZE = 20;
  const histPages = Math.max(1, Math.ceil(visibleHistory.length / HIST_PAGE_SIZE));
  const page = Math.min(histPage, histPages - 1);
  const pageItems = visibleHistory.slice(page * HIST_PAGE_SIZE, (page + 1) * HIST_PAGE_SIZE);
  const isReady = (id: ModelId, m: Mode = mode) => !readiness || !!readiness[id]?.[m];
  const modelReady = isReady(model);
  const pickModel = (id: ModelId) => {
    setModel(id);
    setError(null);
    localStorage.setItem(MODEL_KEY, id);
  };

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0"
        style={{
          background:
            "radial-gradient(900px 420px at 50% -6%, rgba(0,113,227,0.06), transparent 55%), linear-gradient(180deg,#fbfbfd 0%,#f5f5f7 100%)",
        }}
      />

      <main className="relative z-10 flex min-h-0 w-full flex-1 flex-col gap-2 overflow-y-auto p-2 lg:flex-row lg:gap-0 lg:overflow-hidden">
        <section
          className="apple-card stagger-1 m-0 flex min-h-0 w-full shrink-0 flex-col overflow-visible rounded-[22px] lg:overflow-hidden"
          style={isDesktop ? { width: leftPx } : undefined}
        >
          <div className="panel-header flex h-[52px] shrink-0 items-center gap-2 border-b border-black/[0.06] px-4 justify-between">
            <h1 className="text-[14px] font-semibold tracking-[-0.02em] text-[#1d1d1f]">AI Studio</h1>
            <span
              title="所有生成记录的花费合计（GPT / Krea / Banana 为估算）"
              className="animate-chip-in rounded-full bg-black/[0.04] px-2 py-0.5 text-[11px] font-medium tabular-nums text-[#6e6e73]"
            >
              已花费约 ¥{histStats.cost}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
            <div className="mb-4">
              <div className="mb-2 flex items-center justify-between">
                <label className="block text-[11px] font-medium uppercase tracking-[0.06em] text-[#86868b]">
                  参考图{" "}
                  <span className="normal-case tracking-normal text-[#aeaeb2]">
                    可选 · 放了就是改图{(modelParams.maxRefs ?? 1) > 1 ? ` · 最多 ${modelParams.maxRefs} 张，描述里输入 @ 指定哪张` : ""}
                  </span>
                </label>
              </div>
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
                  const files = Array.from(e.dataTransfer.files ?? []).filter((x) => x.type.startsWith("image/"));
                  if (!files.length) {
                    if (e.dataTransfer.files?.length) setError("请拖入图片文件（JPG / PNG / WEBP）");
                    return;
                  }
                  addRefs(files);
                }}
                data-drag={dragState}
                className={`ref-drop relative flex flex-wrap gap-1.5 rounded-2xl border border-dashed p-1.5 transition ${
                  dragState !== "none" ? "border-[#0071e3] bg-[#0071e3]/[0.04]" : "border-black/[0.10] bg-white/70"
                }`}
              >
                {preview && (
                  <span className="group relative h-16 w-16 overflow-hidden rounded-xl border border-black/[0.08]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={preview}
                      alt="图1"
                      onLoad={(e) => {
                        const el = e.currentTarget;
                        if (el.naturalHeight) setPreviewAspect(el.naturalWidth / el.naturalHeight);
                      }}
                      className="h-full w-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => insertMention(1)}
                      title="在描述里 @ 这张图"
                      className="absolute inset-x-0 bottom-0 bg-black/55 py-px text-center text-[10px] text-white hover:bg-[#0071e3]"
                    >
                      @图1
                    </button>
                    <button
                      type="button"
                      onClick={removeMainRef}
                      className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-[10px] text-white"
                      aria-label="删除图1"
                    >
                      ×
                    </button>
                  </span>
                )}
                {preview &&
                  extraRefs.slice(0, Math.max(0, (modelParams.maxRefs ?? 1) - 1)).map((r, i) => (
                    <span key={r.url} className="relative h-16 w-16 overflow-hidden rounded-xl border border-black/[0.08]">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={r.url} alt={`图${i + 2}`} className="h-full w-full object-cover" />
                      <button
                        type="button"
                        onClick={() => insertMention(i + 2)}
                        title="在描述里 @ 这张图"
                        className="absolute inset-x-0 bottom-0 bg-black/55 py-px text-center text-[10px] text-white hover:bg-[#0071e3]"
                      >
                        @图{i + 2}
                      </button>
                      <button
                        type="button"
                        onClick={() => setExtraRefs((list) => list.filter((x) => x !== r))}
                        className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-[10px] text-white"
                        aria-label="删除这张参考图"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                {(!preview || extraRefs.length + 1 < (modelParams.maxRefs ?? 1)) && (
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className={`flex h-16 items-center justify-center gap-1.5 rounded-xl text-[12px] text-[#86868b] transition hover:bg-black/[0.03] hover:text-[#0071e3] ${
                      preview ? "w-16" : "w-full"
                    }`}
                  >
                    <span className="text-[18px] leading-none">+</span>
                    {!preview && <span>{dragState !== "none" ? "松开即可添加" : "点击 / 拖入 / 粘贴图片"}</span>}
                  </button>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  addRefs(Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/")));
                  // Allow picking the same file again after deleting it.
                  e.target.value = "";
                }}
              />
            </div>

            <div className="mb-4">
              <div className="mb-2 flex items-center justify-between">
                <label className="block text-[11px] font-medium uppercase tracking-[0.06em] text-[#86868b]">
                  描述
                </label>
                {mode === "i2i" && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={reverse}
                    onClick={() => {
                      const next = !reverse;
                      setReverse(next);
                      localStorage.setItem(REVERSE_KEY, next ? "on" : "off");
                    }}
                    className="reverse-switch flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium text-[#6e6e73] transition hover:bg-black/[0.04] active:scale-[0.97]"
                  >
                    提示词反推
                    <span
                      className={`relative inline-block h-[18px] w-[30px] rounded-full transition-colors ${
                        reverse ? "bg-[#0071e3]" : "bg-black/[0.15]"
                      }`}
                    >
                      <span
                        className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-[left] ${
                          reverse ? "left-[14px]" : "left-[2px]"
                        }`}
                      />
                    </span>
                  </button>
                )}
              </div>
              <textarea
                ref={promptRef}
                value={prompt}
                onChange={(e) => {
                  const v = e.target.value;
                  setPrompt(v);
                  const at = e.target.selectionStart ?? v.length;
                  setMentionOpen(!!preview && (modelParams.maxRefs ?? 1) > 1 && v[at - 1] === "@");
                }}
                onKeyDown={(e) => {
                  if (mentionOpen && e.key === "Escape") setMentionOpen(false);
                }}
                rows={4}
                placeholder={
                  mode === "t2i"
                    ? "描述你想要的画面…"
                    : reverse
                      ? "可不填：会根据参考图自动反推提示词，这里可补充想要的变化"
                      : "希望参考图如何变化…"
                }
                className="w-full resize-none rounded-2xl border border-black/[0.08] bg-white px-3.5 py-3 text-[14px] leading-relaxed text-[#1d1d1f] outline-none transition placeholder:text-[#aeaeb2] focus:border-[rgba(0,113,227,0.45)] focus:ring-4 focus:ring-[rgba(0,113,227,0.12)]"
              />
              {mentionOpen && (
                <div className="animate-chip-in mt-1.5 flex flex-wrap gap-1.5 rounded-2xl border border-black/[0.08] bg-white p-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.08)]">
                  {[preview, ...extraRefs.map((r) => r.url)].filter(Boolean).map((url, i) => (
                    <button
                      key={i}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => insertMention(i + 1, true)}
                      className="flex items-center gap-1.5 rounded-xl px-1.5 py-1 text-[12px] text-[#1d1d1f] transition hover:bg-[#0071e3]/10"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url as string} alt="" className="h-7 w-7 rounded-lg object-cover" />
                      图{i + 1}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="mb-4 rounded-2xl bg-white ring-1 ring-black/[0.08]">
              <div className="px-3.5 pt-3 text-[11px] font-medium uppercase tracking-[0.06em] text-[#86868b]">模型与参数</div>
            <div className="px-2 pb-2 pt-2">
              {(() => {
                const cur = findModel(model) ?? MODELS[0];
                const ready = isReady(cur.id);
                return (
                  <button
                    type="button"
                    aria-expanded={modelOpen}
                    onClick={() => setModelOpen((v) => !v)}
                    className="model-current flex w-full items-center gap-3 rounded-xl p-1.5 text-left transition hover:bg-black/[0.03] active:scale-[0.99]"
                  >
                    {/* Natural aspect ratio: fixed height, width follows the cover. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={cur.cover}
                      alt=""
                      className="block h-14 w-auto max-w-[96px] shrink-0 rounded-xl object-cover"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-[#1d1d1f]">
                        {cur.name}
                      </span>
                      <span className="block truncate text-[11px] text-[#86868b]">
                        {ready ? cur.tagline : "待接入"}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-[#0071e3]">
                      {modelOpen ? "收起" : "更换"}
                      <svg
                        className={`h-3.5 w-3.5 transition-transform ${modelOpen ? "rotate-180" : ""}`}
                        viewBox="0 0 16 16"
                        fill="none"
                      >
                        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </span>
                  </button>
                );
              })()}
              <div className={`collapse-grid ${modelOpen ? "is-open" : ""}`} inert={!modelOpen}>
                <div className="min-h-0 overflow-hidden">
                <div className="pt-2">
              <div className="columns-2 gap-2" role="radiogroup" aria-label="模型">
                    {MODELS.map((m) => {
                      const on = model === m.id;
                      const ready = isReady(m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          onClick={() => {
                            pickModel(m.id);
                            setModelOpen(false);
                          }}
                          className={`model-card group relative mb-2 block w-full break-inside-avoid overflow-hidden rounded-2xl text-left transition ${
                            on
                              ? "ring-2 ring-[#0071e3] ring-offset-2 ring-offset-white"
                              : "ring-1 ring-black/[0.08] hover:ring-black/[0.2]"
                          }`}
                        >
                          {/* Cover at its own aspect ratio: no letterbox, no crop, no stretch. */}
                          <div className="relative w-full overflow-hidden bg-[#ececf0]">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={m.cover}
                              alt=""
                              loading="lazy"
                              className={`block h-auto w-full transition duration-300 group-hover:scale-[1.03] ${
                                ready ? "" : "grayscale-[0.6] opacity-70"
                              }`}
                            />
                            {!ready && (
                              <span className="absolute right-1.5 top-1.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white">
                                待接入
                              </span>
                            )}
                          </div>
                          <div className="bg-white px-2 py-1.5">
                            <div className="truncate text-[12px] font-semibold leading-tight text-[#1d1d1f]">
                              {m.name}
                            </div>
                            <div className="truncate text-[10px] leading-tight text-[#86868b]">
                              {m.tagline}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
                </div>
              </div>
            </div>

            {mode === "t2i" && (
              <div className="border-t border-black/[0.06] px-3.5 py-1">
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowMoreRatio((v) => !v)}
                    className="flex w-full items-center justify-between py-1.5 text-left"
                  >
                    <span className="text-[12px] text-[#6e6e73]">比例</span>
                    <span className="flex items-center gap-1.5 text-[13px] font-medium text-[#1d1d1f]">
                      {/* A preset shows its ratio name; custom sizes show the resolution. */}
                      {RATIOS.find((r) => r.w === width && r.h === height)?.label ?? `${width}×${height}`}
                      <svg
                        className={`h-3.5 w-3.5 text-[#86868b] transition-transform ${showMoreRatio ? "rotate-180" : ""}`}
                        viewBox="0 0 16 16"
                        fill="none"
                      >
                        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </span>
                  </button>

                  {showMoreRatio && (
                    <div className="animate-chip-in absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-2xl border border-black/[0.08] bg-white p-3 shadow-[0_12px_40px_rgba(0,0,0,0.12)]">
                      <div className="grid grid-cols-4 gap-2">
                        {RATIOS.filter((p) => !modelParams.ratios || modelParams.ratios.includes(p.label)).map((p) => {
                          const on = width === p.w && height === p.h;
                          return (
                            <button
                              key={p.label}
                              onClick={() => {
                                applyRatio(p.w, p.h);
                                setShowMoreRatio(false);
                              }}
                              className={`flex flex-col items-center gap-1.5 rounded-xl px-1 py-2.5 transition ${
                                on
                                  ? "bg-[#eef6ff] ring-1 ring-[#0071e3]"
                                  : "hover:bg-black/[0.04]"
                              }`}
                            >
                              <span
                                className={`rounded-[4px] border ${
                                  on ? "border-[#0071e3] bg-[#0071e3]/10" : "border-[#c7c7cc]"
                                }`}
                                style={{
                                  width:
                                    p.kind === "square"
                                      ? 22
                                      : p.kind === "portrait"
                                        ? 16
                                        : 26,
                                  height:
                                    p.kind === "square"
                                      ? 22
                                      : p.kind === "portrait"
                                        ? 24
                                        : 16,
                                }}
                              />
                              <span
                                className={`text-[11px] font-medium ${
                                  on ? "text-[#0071e3]" : "text-[#1d1d1f]"
                                }`}
                              >
                                {p.label}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      {modelParams.customSize && (
                      <div className="mt-3 flex items-center gap-2 border-t border-black/[0.06] pt-3">
                        <input
                          inputMode="numeric"
                          value={widthText}
                          onChange={(e) =>
                            setWidthText(e.target.value.replace(/[^\d]/g, ""))
                          }
                          onBlur={commitWidth}
                          className="w-full rounded-xl border border-black/[0.08] bg-[#f5f5f7] px-3 py-2 text-center text-[13px] tabular-nums text-[#1d1d1f] outline-none focus:border-[rgba(0,113,227,0.45)]"
                          aria-label="宽度"
                        />
                        <span className="text-[#aeaeb2]">×</span>
                        <input
                          inputMode="numeric"
                          value={heightText}
                          onChange={(e) =>
                            setHeightText(e.target.value.replace(/[^\d]/g, ""))
                          }
                          onBlur={commitHeight}
                          className="w-full rounded-xl border border-black/[0.08] bg-[#f5f5f7] px-3 py-2 text-center text-[13px] tabular-nums text-[#1d1d1f] outline-none focus:border-[rgba(0,113,227,0.45)]"
                          aria-label="高度"
                        />
                      </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {modelParams.resolutions && (
              <div className="flex items-center justify-between border-t border-black/[0.06] px-3.5 py-2.5">
                <span className="text-[12px] text-[#6e6e73]">清晰度</span>
                <div className="apple-seg flex" role="radiogroup" aria-label="清晰度">
                  {(Object.keys(modelParams.resolutions) as Res[]).map((r) => (
                    <button
                      key={r}
                      type="button"
                      role="radio"
                      aria-checked={res === r}
                      onClick={() => setRes(r)}
                      className={`rounded-full px-3 py-1 text-[12px] font-medium transition ${
                        res === r ? "bg-white text-[#1d1d1f] shadow-sm" : "text-[#6e6e73] hover:text-[#1d1d1f]"
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {modelParams.quality && (
              <div className="flex items-center justify-between border-t border-black/[0.06] px-3.5 py-2.5">
                <span className="text-[12px] text-[#6e6e73]">画质</span>
                <div className="apple-seg flex" role="radiogroup" aria-label="画质">
                  {(Object.keys(QUALITY_LABELS) as Quality[]).filter((q) => modelParams.quality?.[q] != null).map((q) => (
                    <button
                      key={q}
                      type="button"
                      role="radio"
                      aria-checked={quality === q}
                      onClick={() => setQuality(q)}
                      className={`rounded-full px-3 py-1 text-[12px] font-medium transition ${
                        quality === q ? "bg-white text-[#1d1d1f] shadow-sm" : "text-[#6e6e73] hover:text-[#1d1d1f]"
                      }`}
                    >
                      {QUALITY_LABELS[q]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {modelParams.thinking != null && (
              <div className="flex items-center justify-between border-t border-black/[0.06] px-3.5 py-2.5">
                <span className="text-[12px] text-[#6e6e73]">
                  深度思考 <span className="text-[#aeaeb2]">更懂复杂描述 · 慢一点 · +¥{modelParams.thinking.toFixed(2)}</span>
                </span>
                <div className="apple-seg flex" role="radiogroup" aria-label="深度思考">
                  {[false, true].map((on) => (
                    <button
                      key={String(on)}
                      type="button"
                      role="radio"
                      aria-checked={thinking === on}
                      onClick={() => setThinking(on)}
                      className={`rounded-full px-3 py-1 text-[12px] font-medium transition ${
                        thinking === on ? "bg-white text-[#1d1d1f] shadow-sm" : "text-[#6e6e73] hover:text-[#1d1d1f]"
                      }`}
                    >
                      {on ? "开" : "关"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {mode === "i2i" && modelParams.denoise && (
              <div className="border-t border-black/[0.06] px-3.5 py-2.5">
                <div className="mb-1 flex items-center justify-between text-[12px] text-[#6e6e73]">
                  <span>重绘幅度</span>
                  {denoiseText === null ? (
                    <button
                      type="button"
                      onClick={() => setDenoiseText(denoise.toFixed(2))}
                      title="点击输入数值（0.01 – 1）"
                      className="denoise-value rounded-full px-2 py-0.5 tabular-nums text-[12px] text-[#0071e3] transition hover:bg-[#0071e3]/10"
                    >
                      {denoise.toFixed(2)}
                    </button>
                  ) : (
                    <input
                      autoFocus
                      inputMode="decimal"
                      value={denoiseText}
                      onChange={(e) => setDenoiseText(e.target.value.replace(/[^\d.]/g, ""))}
                      onFocus={(e) => e.currentTarget.select()}
                      onBlur={(e) => commitDenoise(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitDenoise(e.currentTarget.value);
                        if (e.key === "Escape") setDenoiseText(null);
                      }}
                      aria-label="重绘幅度数值"
                      className="w-16 rounded-full border border-[#0071e3]/50 bg-white px-2 py-0.5 text-center text-[12px] tabular-nums text-[#0071e3] outline-none ring-4 ring-[#0071e3]/10"
                    />
                  )}
                </div>
                <input
                  type="range"
                  min={0.01}
                  max={1}
                  step={0.01}
                  value={denoise}
                  onChange={(e) => setDenoise(Number(e.target.value))}
                  aria-label="重绘幅度"
                  className="w-full"
                />
              </div>
            )}
            {(modelParams.seed || modelParams.negative || modelParams.lora || modelParams.background || modelParams.complexity || (mode === "i2i" && modelParams.regional)) && (
              <div>
                {(
                  <div className="space-y-3 border-t border-black/[0.06] px-3.5 py-3">
                    {mode === "i2i" && modelParams.regional && (
                      <div className="flex items-center justify-between">
                        <span className="text-[12px] text-[#6e6e73]">只改局部 <span className="text-[#aeaeb2]">其他地方一点不动</span></span>
                        <div className="apple-seg flex" role="radiogroup" aria-label="只改局部">
                    {([[false, "关"], [true, "开"]] as const).map(([v, t]) => (
                      <button
                        key={String(v)}
                        type="button"
                        role="radio"
                        aria-checked={regional === v}
                        onClick={() => setRegional(v as any)}
                        className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition ${
                          regional === v ? "bg-white text-[#1d1d1f] shadow-sm" : "text-[#6e6e73] hover:text-[#1d1d1f]"
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                      </div>
                    )}
                    {modelParams.background && (
                      <div className="flex items-center justify-between">
                        <span className="text-[12px] text-[#6e6e73]">背景</span>
                        <div className="apple-seg flex" role="radiogroup" aria-label="背景">
                    {([["auto", "自动"], ["transparent", "透明"], ["opaque", "不透明"]] as const).map(([v, t]) => (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        aria-checked={background === v}
                        onClick={() => setBackground(v as any)}
                        className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition ${
                          background === v ? "bg-white text-[#1d1d1f] shadow-sm" : "text-[#6e6e73] hover:text-[#1d1d1f]"
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                      </div>
                    )}
                    {modelParams.complexity && (
                      <div className="flex items-center justify-between">
                        <span className="text-[12px] text-[#6e6e73]">构思程度 <span className="text-[#aeaeb2]">高=复杂画面更准</span></span>
                        <div className="apple-seg flex" role="radiogroup" aria-label="构思程度">
                    {([["auto", "默认"], ["low", "低"], ["medium", "中"], ["high", "高"]] as const).map(([v, t]) => (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        aria-checked={complexity === v}
                        onClick={() => setComplexity(v as any)}
                        className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition ${
                          complexity === v ? "bg-white text-[#1d1d1f] shadow-sm" : "text-[#6e6e73] hover:text-[#1d1d1f]"
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                      </div>
                    )}
                    {modelParams.lora && (
                      <div>
                        <div className="mb-1 flex items-center justify-between text-[12px] text-[#6e6e73]">
                          <span>风格强度（LoRA）</span>
                          <span className="tabular-nums text-[#0071e3]">{lora.toFixed(1)}</span>
                        </div>
                        <input type="range" min={0} max={3} step={0.1} value={lora} onChange={(e) => setLora(Number(e.target.value))} aria-label="风格强度" className="w-full" />
                      </div>
                    )}
                    {modelParams.seed && (
                      <div className="flex items-center justify-between gap-3">
                        <span className="shrink-0 text-[12px] text-[#6e6e73]">种子 <span className="text-[#aeaeb2]">同种子出相似图</span></span>
                        <input
                          inputMode="numeric"
                          value={seedText}
                          placeholder="随机"
                          onChange={(e) => setSeedText(e.target.value.replace(/[^\d]/g, "").slice(0, 12))}
                          className="w-24 min-w-0 rounded-xl border border-black/[0.08] bg-[#f5f5f7] px-3 py-1.5 text-right text-[12px] tabular-nums outline-none focus:border-[rgba(0,113,227,0.45)]"
                          aria-label="种子"
                        />
                      </div>
                    )}
                    {modelParams.negative && (
                      <div>
                        <div className="mb-1 text-[12px] text-[#6e6e73]">不想要的内容</div>
                        <input
                          value={negative}
                          placeholder="比如：文字、水印、多余的手指"
                          onChange={(e) => setNegative(e.target.value.slice(0, 300))}
                          className="w-full rounded-xl border border-black/[0.08] bg-[#f5f5f7] px-3 py-2 text-[12px] outline-none focus:border-[rgba(0,113,227,0.45)]"
                          aria-label="不想要的内容"
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            </div>
          </div>

          <div className="shrink-0 border-t border-black/[0.06] p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-[#86868b]">
                张数
              </span>
              <div className="apple-seg flex" role="radiogroup" aria-label="出图数量">
                {[1, 2, 3, 4].map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={count === n}
                    data-active={count === n}
                    disabled={loading}
                    onClick={() => {
                      setCount(n);
                      localStorage.setItem(COUNT_KEY, String(n));
                    }}
                    className="apple-seg-item w-9 py-1 text-[12px] font-medium tabular-nums text-[#6e6e73]"
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={generate}
              disabled={
                loading || !modelReady || ((mode === "t2i" || !reverse) && !prompt.trim())
              }
              className="apple-btn-primary flex w-full items-center justify-center gap-2 py-3.5 text-[15px]"
            >
              {loading ? (
                <>
                  <span className="animate-spin-slow h-3.5 w-3.5 rounded-full border-[1.5px] border-white/40 border-t-white" />
                  生成中 {Math.floor(progress)}%
                </>
              ) : !modelReady ? (
                <span>{findModel(model)?.name} 待接入</span>
              ) : (
                <>
                  <span>开始生成</span>
                  <span className="rounded-full bg-white/20 px-2 py-0.5 text-[13px] font-semibold tabular-nums">
                    {findModel(model)?.price ? "约 " : ""}¥{btnPrice}
                    {findModel(model)?.billing ? ` · ${findModel(model)?.billing}` : ""}
                  </span>
                </>
              )}
            </button>
            {error && (
              <div className="animate-chip-in mt-2 rounded-2xl bg-[#fff1f0] px-3.5 py-2.5 text-[12px] text-[#d70015]">
                {error}
              </div>
            )}
          </div>
        </section>

        {/* drag handle */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整左栏宽度"
          onPointerDown={(e) => {
            draggingRef.current = "left";
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          }}
          className="panel-resizer hidden w-1.5 shrink-0 cursor-col-resize lg:block"
        />

        <section
          ref={resultRef_}
          className="apple-card stagger-2 flex min-h-[50vh] min-w-0 flex-1 flex-col overflow-hidden rounded-[22px] lg:min-h-0">
          <div className="panel-header flex h-[52px] shrink-0 items-center gap-2 border-b border-black/[0.06] px-4">
            <h2 className="text-[14px] font-semibold tracking-[-0.02em] text-[#1d1d1f]">结果</h2>
            {resultUrl && !loading && resultSize && (
              <span className="rounded-full bg-black/[0.04] px-2 py-0.5 text-[11px] tabular-nums text-[#6e6e73]">
                {resultSize.w} × {resultSize.h}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {resultUrl && resultRef && !loading && compareOn && (
                <div className="apple-seg flex">
                  {COMPARE_MODES.map((m) => (
                    <button
                      key={m.key}
                      type="button"
                      data-active={compareMode === m.key}
                      onClick={() => setCompareMode(m.key)}
                      className="apple-seg-item px-2.5 py-1 text-[11px] font-medium text-[#6e6e73]"
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
              {resultUrl && resultRef && !loading && (
                <button
                  type="button"
                  aria-pressed={compareOn}
                  onClick={() => setCompareOn((v) => !v)}
                  className={`compare-btn rounded-full px-3 py-1 text-[12px] font-medium transition active:scale-[0.97] ${
                    compareOn
                      ? "bg-[#0071e3] text-white hover:bg-[#0077ed]"
                      : "bg-black/[0.05] text-[#1d1d1f] hover:bg-black/[0.09]"
                  }`}
                >
                  {compareOn ? "退出对比" : "对比"}
                </button>
              )}
            </div>
          </div>
          <div
            className="result-box relative m-2 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-[16px] sm:m-3"
            style={{
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.92), rgba(245,245,247,0.96))",
              boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.06)",
            }}
          >
            {loading ? (
              <GeneratingView aspect={jobVisual.aspect} progress={progress} />
            ) : resultUrl && resultRef && compareOn ? (
              <div className="h-full w-full p-2">
                <CompareView key={`${resultKey}-${compareMode}`} before={resultRef} after={resultUrl} mode={compareMode} />
              </div>
            ) : resultUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={resultKey}
                src={resultUrl}
                alt="生成结果"
                onLoad={(e) => {
                  const el = e.currentTarget;
                  setResultSize({ w: el.naturalWidth, h: el.naturalHeight });
                }}
                className="animate-image-reveal max-h-full w-auto max-w-full object-contain"
              />
            ) : (
              <div className="max-w-sm px-6 text-center">
                <div
                  className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-[14px] text-[20px]"
                  style={{ background: "rgba(0,113,227,0.1)", color: "#0071e3" }}
                >
                  ✦
                </div>
                <p className="text-[15px] font-medium text-[#1d1d1f]">
                  从一句描述开始
                </p>
              </div>
            )}
            {!loading && batch.length > 1 && (
              <div className="batch-strip absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 gap-1.5 rounded-2xl bg-white/80 p-1.5 shadow-[0_6px_24px_rgba(0,0,0,0.12)] backdrop-blur-xl">
                {batch.map((id, i) => {
                  const g = gallery.find((x) => x.id === id);
                  const on = id === currentId;
                  return (
                    <button
                      key={id}
                      type="button"
                      disabled={!g?.url}
                      onClick={() => g && showItem(g)}
                      title={`第 ${i + 1} 张`}
                      className={`h-12 w-12 overflow-hidden rounded-xl bg-[#f2f2f4] transition active:scale-[0.95] ${
                        on ? "outline outline-2 -outline-offset-2 outline-[#0071e3]" : "opacity-80 hover:opacity-100"
                      }`}
                    >
                      {g?.url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={g.url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center text-[10px] text-[#d70015]">
                          失败
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

        </section>

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

        <aside
          className="apple-card stagger-3 flex min-h-[40vh] w-full shrink-0 flex-col overflow-hidden rounded-[22px] lg:min-h-0"
          style={isDesktop ? { width: rightPx } : undefined}
        >
          <div className="panel-header flex h-[52px] shrink-0 items-center gap-2 border-b border-black/[0.06] px-4 justify-between">
            <h2 className="text-[14px] font-semibold tracking-[-0.02em] text-[#1d1d1f]">历史</h2>
            <span className="truncate text-[11px] tabular-nums text-[#86868b]">
              {histStats.done} 张{histStats.pending ? ` · 进行中 ${histStats.pending}` : ""} · 累计约 ¥{histStats.cost}
            </span>
          </div>
          <div className="shrink-0 border-b border-black/[0.06] px-3 py-2.5">
            <input
              value={histQuery}
              onChange={(e) => {
                setHistQuery(e.target.value);
                setHistPage(0);
              }}
              placeholder="搜索提示词…"
              className="mb-2 w-full rounded-xl border border-black/[0.08] bg-[#f5f5f7] px-3 py-1.5 text-[12px] text-[#1d1d1f] outline-none focus:border-[rgba(0,113,227,0.45)]"
            />
            <div className="flex items-center gap-1.5">
              <div className="apple-seg flex">
                {(
                  [
                    ["all", "全部"],
                    ["t2i", "文生图"],
                    ["i2i", "图生图"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    data-active={histMode === key}
                    onClick={() => {
                      setHistMode(key);
                      setHistPage(0);
                    }}
                    className="apple-seg-item px-2 py-1 text-[11px] font-medium text-[#6e6e73]"
                  >
                    {label}
                  </button>
                ))}
              </div>
              <select
                value={histFilter}
                onChange={(e) => {
                  setHistFilter(e.target.value);
                  setHistPage(0);
                }}
                className={`hist-filter min-w-0 flex-1 rounded-full border bg-white px-2.5 py-1 text-[11px] outline-none transition ${
                  histFilter === "all"
                    ? "border-black/[0.08] text-[#1d1d1f]"
                    : "border-[#0071e3]/40 text-[#0071e3]"
                }`}
                aria-label="筛选历史"
              >
                <option value="all">全部记录</option>
                <optgroup label="按模型">
                  {MODELS.map((m) => (
                    <option key={m.id} value={`model:${m.id}`}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="按状态">
                  <option value="ok">已生成（{histStats.done}）</option>
                  <option value="bad">失败 / 已过期（{histStats.failed}）</option>
                </optgroup>
              </select>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {visibleHistory.length === 0 ? (
              <p className="px-2 py-8 text-center text-[12px] text-[#aeaeb2]">
                {gallery.length ? "没有符合条件的记录" : "生成的图片会保存在这里"}
              </p>
            ) : (
              <div key={`${page}-${histMode}-${histFilter}`} className="history-grid grid grid-cols-2 gap-2">
                {pageItems.map((g, i) => {
                  const on = g.id === currentId;
                  const sel = pageItems.findIndex((x) => x.id === currentId);
                  // Details open under the row that holds the selected card (2 columns).
                  const rowEnd = sel < 0 ? -1 : Math.min(sel % 2 === 0 ? sel + 1 : sel, pageItems.length - 1);
                  return (
                    <Fragment key={g.id}>
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => {
                        if (g.url) {
                          setError(null);
                          setCompareOn(false);
                          showItem(g);
                          if (window.innerWidth < 1024) {
                            scrollToResult();
                          }
                        } else {
                          setError(
                            g.status === "expired"
                              ? `这张图已过期：${g.error || "RunningHub 已清理原图"}`
                              : `这条记录生成失败：${g.error || "任务失败"}`
                          );
                        }
                      }}
                      title={g.url ? g.prompt : `失败：${g.error || "任务失败"}\n${g.prompt}`}
                      className={`history-card overflow-hidden rounded-xl bg-white text-left ${
                        on
                          ? "outline outline-2 -outline-offset-2 outline-[#0071e3]"
                          : "ring-1 ring-black/[0.08] hover:ring-black/[0.2]"
                      }`}
                    >
                      <span className="relative block aspect-square w-full bg-[#f2f2f4]">
                        {g.url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={g.url} alt="" loading="lazy" className="h-full w-full object-cover" />
                        ) : (
                          <span className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center">
                            <span
                              className={`text-[12px] font-semibold ${
                                g.status === "expired" ? "text-[#86868b]" : "text-[#d70015]"
                              }`}
                            >
                              {g.status === "expired" ? "已过期" : "失败"}
                            </span>
                            <span className="line-clamp-3 text-[10px] leading-snug text-[#86868b]">
                              {g.error || "任务失败"}
                            </span>
                          </span>
                        )}
                        <span className="absolute left-1 top-1 rounded-full bg-black/50 px-1.5 py-px text-[9px] font-medium text-white">
                          {g.mode === "i2i" ? "图生图" : "文生图"}
                        </span>
                        {g.cost && g.url && (
                          <span className="absolute right-1 top-1 rounded-full bg-black/50 px-1.5 py-px text-[9px] tabular-nums text-white">
                            ¥{g.cost}
                          </span>
                        )}
                      </span>
                      <span className="block px-1.5 py-1">
                        <span className="block truncate text-[10px] font-medium text-[#1d1d1f]">
                          {findModel(g.model)?.name ?? g.label ?? "棕色尘埃"}
                        </span>
                        <span className="block text-[10px] tabular-nums text-[#86868b]">
                          {formatTime(g.createdAt)}
                          {formatDuration(g.durationMs) && <> · {formatDuration(g.durationMs)}</>}
                        </span>
                      </span>
                    </button>
                    {i === rowEnd && currentItem && currentItem.url && (
                      <div
                        key={`detail-${currentItem.id}`}
                        className="history-detail relative col-span-2 rounded-2xl bg-[#f5f5f7] px-3 py-2.5"
                      >
                        <span
                          aria-hidden
                          className="absolute -top-1.5 h-3 w-3 rotate-45 rounded-[2px] bg-[#f5f5f7]"
                          style={{ left: sel % 2 === 0 ? "calc(25% - 6px)" : "calc(75% - 6px)" }}
                        />
                        <div className="flex items-center gap-1.5 text-[11px] text-[#86868b]">
                          <span className="truncate font-semibold text-[#1d1d1f]">
                            {findModel(currentItem.model)?.name ?? currentItem.label ?? "棕色尘埃"}
                          </span>
                          <span className="shrink-0">{currentItem.mode === "i2i" ? "图生图" : "文生图"}</span>
                          {(currentItem.cost || formatDuration(currentItem.durationMs)) && (
                            <span className="ml-auto shrink-0 tabular-nums">
                              {formatDuration(currentItem.durationMs) && `用时 ${formatDuration(currentItem.durationMs)}`}
                              {currentItem.cost && formatDuration(currentItem.durationMs) ? " · " : ""}
                              {currentItem.cost && `¥${currentItem.cost}`}
                            </span>
                          )}
                        </div>
                        {currentItem.prompt && (
                          <button
                            type="button"
                            onClick={() => setPromptOpen((v) => !v)}
                            aria-expanded={promptOpen}
                            className="prompt-toggle mt-1 block w-full text-left"
                          >
                            <span
                              className={`text-[12px] leading-relaxed text-[#3a3a3c] ${
                                promptOpen ? "block max-h-[30vh] overflow-y-auto" : "line-clamp-2"
                              }`}
                            >
                              {currentItem.prompt}
                            </span>
                            {(currentItem.prompt.length > 60 || promptOpen) && (
                              <span className="mt-0.5 block text-[11px] font-medium text-[#0071e3]">
                                {promptOpen ? "收起" : "展开全文"}
                              </span>
                            )}
                            {promptOpen && currentItem.seed != null && (
                              <span className="mt-1 block text-[11px] tabular-nums text-[#86868b]">
                                种子 {currentItem.seed}
                              </span>
                            )}
                          </button>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-1">
                          {(
                            [
                              ["下载", () => downloadItem(currentItem)],
                              ["复制", () => copyPrompt(currentItem)],
                              ["复用", () => reuseItem(currentItem)],
                              ["作参考", () => useAsReference(currentItem)],
                            ] as const
                          ).map(([label, fn]) => (
                            <button
                              key={label}
                              type="button"
                              onClick={fn}
                              className={`item-action rounded-full px-2.5 py-1 text-[11px] font-medium transition active:scale-[0.96] ${
                                label === "下载"
                                  ? "bg-[#0071e3] text-white hover:bg-[#0077ed]"
                                  : "bg-white text-[#1d1d1f] hover:text-[#0071e3]"
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                          {notice && (
                            <span className="animate-chip-in ml-auto truncate rounded-full bg-[#1d1d1f]/80 px-2 py-0.5 text-[10px] text-white">
                              {notice}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                    </Fragment>
                  );
                })}
              </div>
            )}
          </div>
          {histPages > 1 && (
            <div className="flex shrink-0 items-center justify-between border-t border-black/[0.06] px-3 py-2">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setHistPage(page - 1)}
                className="pager-btn rounded-full px-3 py-1 text-[12px] font-medium text-[#1d1d1f] ring-1 ring-black/[0.08] transition hover:text-[#0071e3] hover:ring-[#0071e3]/50 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-35"
              >
                上一页
              </button>
              <span className="text-[11px] tabular-nums text-[#6e6e73]">
                {page + 1} / {histPages}
              </span>
              <button
                type="button"
                disabled={page >= histPages - 1}
                onClick={() => setHistPage(page + 1)}
                className="pager-btn rounded-full px-3 py-1 text-[12px] font-medium text-[#1d1d1f] ring-1 ring-black/[0.08] transition hover:text-[#0071e3] hover:ring-[#0071e3]/50 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-35"
              >
                下一页
              </button>
            </div>
          )}
        </aside>
      </main>

    </div>
  );
}
