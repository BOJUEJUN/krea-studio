"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GeneratingView } from "./generating-view";
import { COMPARE_MODES, CompareView, type CompareMode } from "./compare-view";
import { DEFAULT_MODEL, MODELS, findModel, type Mode, type ModelId } from "@/lib/models";

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
};

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
];

const MAX_RES = 2560;
const MIN_RES = 256;
const EST_COST = "0.04";
const PENDING_KEY = "krea-studio.pending-job";
const MODEL_KEY = "krea-studio.model";
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
  const [mode, setMode] = useState<Mode>("i2i");
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
  const [lastCost, setLastCost] = useState<string | null>(null);
  const [money, setMoney] = useState<string | null>(null);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
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
    if (g.cost) setLastCost(String(g.cost));
  }, []);

  // paste image upload — defined after onPickFile
  const applyRatio = useCallback((w: number, h: number) => {
    const cw = clampRes(w);
    const ch = clampRes(h);
    setWidth(cw);
    setHeight(ch);
    setWidthText(String(cw));
    setHeightText(String(ch));
  }, []);

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
      if (file) {
        onPickFile(file);
        if (mode !== "i2i") setMode("i2i");
      }
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
  }, [mode, onPickFile]);

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
        localStorage.removeItem(PENDING_KEY);
        throw new Error(d.error || "任务失败");
      }
      await sleep(3000);
    }
    return null;
  }, []);

  const finishPending = useCallback(async (pending: PendingJob, job: number) => {
    const done = await pollTask(pending.taskId, job);
    if (done === null || jobRef.current !== job) return;
    const url = done.outputs?.[0];
    if (!url) throw new Error(done.error || "任务完成但未返回图片");
    if (done.cost) setLastCost(String(done.cost));
    const t = timingRef.current;
    if (t.step === "render" && t.renderKey && t.stepStart) {
      recordSeconds(t.renderKey, (Date.now() - t.stepStart) / 1000);
    }
    setProgress(100);
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
    };
    showItem(item);
    setGallery((g) => [
      item,
      ...g.filter((x) => x.taskId !== item.taskId && x.url !== item.url),
    ]);
    await fetchJson("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item),
    });
    localStorage.removeItem(PENDING_KEY);
    fetchJson("/api/status")
      .then((d) => {
        if (d?.account?.remainMoney != null) setMoney(String(d.account.remainMoney));
      })
      .catch(() => {});
  }, [pollTask, showItem]);

  const resumePending = useCallback((pending: PendingJob) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const job = ++jobRef.current;
    const renderKey = `${pending.model ?? "brown-dust"}:${pending.mode}`;
    timingRef.current = {
      step: "render",
      stepStart: pending.createdAt || Date.now(),
      est: { describe: 0, submit: 0, render: estimateSeconds(renderKey, DEFAULT_SECONDS[pending.mode]) },
      renderKey: "", // resumed runs started earlier; don't learn from them
    };
    setJobVisual({ aspect: 1, reference: pending.mode === "i2i" ? pending.refUrl ?? null : null });
    setLoading(true);
    setError(null);
    finishPending(pending, job)
      .catch((e: any) => {
        if (jobRef.current !== job) return;
        const message = e?.message || "查询任务失败";
        setError(`${message}（任务号：${pending.taskId}，刷新页面可继续查询）`);
        if (/任务失败|已完成但未返回|不存在|错误码/.test(message)) {
          localStorage.removeItem(PENDING_KEY);
        }
      })
      .finally(() => {
        if (jobRef.current === job) {
          busyRef.current = false;
          setLoading(false);
        }
      });
  }, [finishPending]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PENDING_KEY);
      if (!raw) return;
      const pending = JSON.parse(raw) as PendingJob;
      if (pending?.taskId && pending?.prompt && pending?.mode) resumePending(pending);
    } catch {
      localStorage.removeItem(PENDING_KEY);
    }
  }, [resumePending]);

  const generate = useCallback(async () => {
    if (busyRef.current) return;
    try {
      const raw = localStorage.getItem(PENDING_KEY);
      if (raw) {
        const pending = JSON.parse(raw) as PendingJob;
        if (pending?.taskId) {
          resumePending(pending);
          return;
        }
      }
    } catch {
      localStorage.removeItem(PENDING_KEY);
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
    setResultRef(null);
    setResultSize(null);
    setLastCost(null);
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
            width: clampRes(Number(widthText) || width),
            height: clampRes(Number(heightText) || height),
          }),
        });
      } else {
        const fd = new FormData();
        fd.append("prompt", finalPrompt);
        fd.append("model", model);
        fd.append("image", await prepareReferenceImage(imageFile as File));
        fd.append("denoise", String(denoise));
        data = await fetchJson("/api/generate/i2i", { method: "POST", body: fd });
      }
      if (jobRef.current !== job) return;
      if (!data?.ok || !data?.taskId) {
        throw new Error(data?.error || "任务创建失败");
      }
      startStep("render");
      const pending: PendingJob = {
        taskId: String(data.taskId),
        seed: data.seed,
        mode,
        model,
        prompt: finalPrompt,
        refUrl: typeof data.refUrl === "string" ? data.refUrl : undefined,
        createdAt: Date.now(),
      };
      localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
      await finishPending(pending, job);
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
  }, [mode, model, reverse, readiness, preview, previewAspect, startStep, prompt, width, height, widthText, heightText, denoise, finishPending, resumePending]);

  const btnPrice = lastCost || EST_COST;
  const currentItem = gallery.find((g) => g.id === currentId) ?? null;
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
    setLastCost(null);
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
            {money != null && (
              <span className="animate-chip-in rounded-full bg-black/[0.04] px-2 py-0.5 text-[11px] font-medium tabular-nums text-[#6e6e73]">
                ¥{money}
              </span>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
            <div className="apple-seg mb-3 grid grid-cols-2">
              {(
                [
                  ["t2i", "文生图"],
                  ["i2i", "图生图"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  data-active={mode === key}
                  onClick={() => {
                    setMode(key);
                    setLastCost(null);
                  }}
                  className="apple-seg-item px-3 py-2 text-[13px] font-medium text-[#6e6e73]"
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="mb-4">
              <label className="mb-2 block text-[11px] font-medium uppercase tracking-[0.06em] text-[#86868b]">
                模型
              </label>
              {(() => {
                const cur = findModel(model) ?? MODELS[0];
                const ready = isReady(cur.id);
                return (
                  <button
                    type="button"
                    aria-expanded={modelOpen}
                    onClick={() => setModelOpen((v) => !v)}
                    className="model-current flex w-full items-center gap-3 rounded-2xl bg-white p-2 text-left ring-1 ring-black/[0.08] transition hover:ring-black/[0.2] active:scale-[0.99]"
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

            {mode === "i2i" && (
              <div className="mb-4">
                <div className="mb-2 flex items-center justify-between">
                  <label className="block text-[11px] font-medium uppercase tracking-[0.06em] text-[#86868b]">
                    参考图
                  </label>
                  {preview && (
                    <div className="animate-chip-in flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => fileRef.current?.click()}
                        className="ref-action rounded-full px-2 py-0.5 text-[11px] font-medium text-[#0071e3] transition hover:bg-[#0071e3]/10 active:scale-[0.96]"
                      >
                        更换
                      </button>
                      <button
                        type="button"
                        onClick={() => onPickFile(null)}
                        className="ref-action rounded-full px-2 py-0.5 text-[11px] font-medium text-[#d70015] transition hover:bg-[#d70015]/10 active:scale-[0.96]"
                      >
                        删除
                      </button>
                    </div>
                  )}
                </div>
                <div
                  onClick={() => fileRef.current?.click()}
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
                    const f = Array.from(e.dataTransfer.files ?? []).find((x) => x.type.startsWith("image/"));
                    if (f) onPickFile(f);
                    else if (e.dataTransfer.files?.length) setError("请拖入图片文件（JPG / PNG / WEBP）");
                  }}
                  data-drag={dragState}
                  className={`ref-drop relative flex cursor-pointer items-center justify-center overflow-hidden rounded-2xl border border-dashed border-black/[0.12] bg-white/70 transition hover:border-[rgba(0,113,227,0.45)] ${
                    preview ? "p-1.5" : "h-32"
                  }`}
                >
                  {dragState !== "none" && (
                    <span className="ref-drop-overlay pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 rounded-2xl">
                      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#0071e3] text-[18px] text-white shadow-[0_6px_18px_rgba(0,113,227,0.35)]">
                        ↓
                      </span>
                      <span className="text-[12px] font-medium text-[#0071e3]">
                        {dragState === "zone" ? "松开即可上传" : "拖到这里上传参考图"}
                      </span>
                    </span>
                  )}
                  {preview ? (
                    // Natural aspect ratio, never cropped; tall images are capped and letterboxed.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={preview}
                      alt="参考图"
                      onLoad={(e) => {
                        const el = e.currentTarget;
                        if (el.naturalHeight) setPreviewAspect(el.naturalWidth / el.naturalHeight);
                      }}
                      className="animate-image-reveal block h-auto max-h-[46vh] w-auto max-w-full rounded-xl object-contain"
                    />
                  ) : null}
                  {preview ? (
                    <span className="ref-hint pointer-events-none absolute inset-x-0 bottom-2 mx-auto w-fit rounded-full bg-black/55 px-2.5 py-1 text-[11px] text-white opacity-0 transition-opacity duration-300">
                      点击或拖入新图片即可更换
                    </span>
                  ) : (
                    <div className="text-center">
                      <div className="mx-auto mb-1.5 flex h-8 w-8 items-center justify-center rounded-full bg-black/[0.05] text-[16px] text-[#6e6e73]">
                        +
                      </div>
                      <div className="text-[12px] text-[#86868b]">点击 / 拖入 / 粘贴图片</div>
                    </div>
                  )}
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onPickFile(f);
                    // Allow picking the same file again after deleting it.
                    e.target.value = "";
                  }}
                />
              </div>
            )}

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
                onChange={(e) => setPrompt(e.target.value)}
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
            </div>

            {mode === "t2i" && (
              <div className="mb-4">
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowMoreRatio((v) => !v)}
                    className="flex w-full items-center justify-between rounded-2xl border border-black/[0.08] bg-white px-3.5 py-3 text-left transition hover:border-black/[0.12]"
                  >
                    <span className="text-[13px] text-[#86868b]">比例</span>
                    <span className="flex items-center gap-1.5 text-[13px] font-medium text-[#1d1d1f]">
                      {width}×{height}
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
                        {RATIOS.map((p) => {
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
                    </div>
                  )}
                </div>
              </div>
            )}

            {mode === "i2i" && (
              <div className="mb-4">
                <div className="mb-2 flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.06em] text-[#86868b]">
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
                <div className="mt-1 flex justify-between text-[10px] tabular-nums text-[#aeaeb2]">
                  <span>0.01 更像原图</span>
                  <span>1.00 变化最大</span>
                </div>
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-black/[0.06] p-4 sm:p-5">
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
                    ¥{btnPrice}
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
            className="relative m-2 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-[16px] sm:m-3"
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
              {histStats.done} 张{histStats.pending ? ` · 进行中 ${histStats.pending}` : ""} · ¥{histStats.cost}
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

          {currentItem && currentItem.url && (
            <div key={currentItem.id} className="history-detail shrink-0 border-b border-black/[0.06] px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[11px] text-[#86868b]">
                <span className="truncate font-semibold text-[#1d1d1f]">
                  {findModel(currentItem.model)?.name ?? currentItem.label ?? "棕色尘埃"}
                </span>
                <span>·</span>
                <span className="shrink-0">{currentItem.mode === "i2i" ? "图生图" : "文生图"}</span>
                <span>·</span>
                <span className="shrink-0 tabular-nums">{formatTime(currentItem.createdAt)}</span>
                {currentItem.cost && (
                  <span className="ml-auto shrink-0 tabular-nums">¥{currentItem.cost}</span>
                )}
              </div>
              {currentItem.prompt && (
                <button
                  type="button"
                  onClick={() => setPromptOpen((v) => !v)}
                  className="prompt-toggle mt-1.5 block w-full rounded-xl px-2 py-1.5 -mx-2 text-left transition hover:bg-black/[0.035]"
                  aria-expanded={promptOpen}
                  title={promptOpen ? "收起" : "展开全文"}
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
              <div className="mt-1.5 flex items-center gap-1">
                {(
                  [
                    ["复制", () => copyPrompt(currentItem)],
                    ["复用", () => reuseItem(currentItem)],
                    ["作参考", () => useAsReference(currentItem)],
                  ] as const
                ).map(([label, fn]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={fn}
                    className="item-action rounded-full px-2.5 py-1 text-[11px] font-medium text-[#1d1d1f] ring-1 ring-black/[0.08] transition hover:text-[#0071e3] hover:ring-[#0071e3]/50 active:scale-[0.96]"
                  >
                    {label}
                  </button>
                ))}
                <a
                  href={currentItem.url}
                  target="_blank"
                  rel="noreferrer"
                  className="item-action rounded-full px-2.5 py-1 text-[11px] font-medium text-[#1d1d1f] ring-1 ring-black/[0.08] transition hover:text-[#0071e3] hover:ring-[#0071e3]/50 active:scale-[0.96]"
                >
                  原图
                </a>
                {notice && (
                  <span className="animate-chip-in ml-auto truncate rounded-full bg-[#0071e3] px-2 py-0.5 text-[10px] text-white">
                    {notice}
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {visibleHistory.length === 0 ? (
              <p className="px-2 py-8 text-center text-[12px] text-[#aeaeb2]">
                {gallery.length ? "没有符合条件的记录" : "生成的图片会保存在这里"}
              </p>
            ) : (
              <div key={`${page}-${histMode}-${histFilter}`} className="history-grid grid grid-cols-2 gap-2">
                {pageItems.map((g) => {
                  const on = g.id === currentId;
                  return (
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
                        </span>
                      </span>
                    </button>
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
