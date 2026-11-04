"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GeneratingCanvas } from "./generating-canvas";
import { COMPARE_MODES, CompareView, type CompareMode } from "./compare-view";
import { DEFAULT_MODEL, MODELS, findModel, type Mode, type ModelId } from "@/lib/models";

type Readiness = Record<string, Record<Mode, boolean>>;

type GalleryItem = {
  id: string;
  mode: Mode;
  model?: string;
  prompt: string;
  url: string;
  status?: "pending" | "done" | "failed";
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

// One 0-100% bar for prompt reverse + submit + generation. Each step eases
// toward its cap; the bar only reaches 100% when the image arrives.
const PROGRESS_STEPS = {
  describe: { cap: 15, rate: 0.06 },
  submit: { cap: 22, rate: 0.08 },
  render: { cap: 97, rate: 0.012 },
} as const;
type ProgressStep = keyof typeof PROGRESS_STEPS;

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultRef, setResultRef] = useState<string | null>(null);
  const [resultSize, setResultSize] = useState<{ w: number; h: number } | null>(null);
  const [compareOn, setCompareOn] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [histMode, setHistMode] = useState<"all" | Mode>("all");
  const [histModel, setHistModel] = useState<"all" | ModelId>("all");
  const [histQuery, setHistQuery] = useState("");
  const [histFailed, setHistFailed] = useState(false);
  const [histPage, setHistPage] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [previewAspect, setPreviewAspect] = useState(1);
  const [compareMode, setCompareMode] = useState<CompareMode>("slider");
  const [resultKey, setResultKey] = useState(0);
  const [progress, setProgress] = useState(0);
  const stepRef = useRef<ProgressStep>("render");
  const [lastCost, setLastCost] = useState<string | null>(null);
  const [money, setMoney] = useState<string | null>(null);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [leftPx, setLeftPx] = useState(300);
  const [isDesktop, setIsDesktop] = useState(false);
  const draggingRef = useRef(false);

  useEffect(() => {
    const sync = () => {
      const desktop = window.innerWidth >= 1024;
      setIsDesktop(desktop);
      if (desktop) {
        setLeftPx((p) => Math.min(480, Math.max(240, p || Math.round(window.innerWidth * 0.28))));
      }
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  const fileRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
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
      if (!draggingRef.current) return;
      const next = Math.min(480, Math.max(240, e.clientX));
      setLeftPx(next);
    };
    const onUp = () => {
      draggingRef.current = false;
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
      setProgress(0);
      timerRef.current = window.setInterval(() => {
        const { cap, rate } = PROGRESS_STEPS[stepRef.current];
        setProgress((p) => (p >= cap ? p : p + Math.max(0.05, (cap - p) * rate)));
      }, 250);
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
    return () => window.removeEventListener("paste", onPaste);
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
        await sleep(3000);
        continue;
      }
      if (jobRef.current !== job) return null;
      if (!d?.ok) {
        if (++failures >= 8) throw new Error(d?.error || "查询任务失败");
        await sleep(3000);
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
    stepRef.current = "render";
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
    stepRef.current = mode === "i2i" && reverse ? "describe" : "submit";
    setLoading(true);
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
        stepRef.current = "submit";
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
      stepRef.current = "render";
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
  }, [mode, model, reverse, readiness, prompt, width, height, widthText, heightText, denoise, finishPending, resumePending]);

  const btnPrice = lastCost || EST_COST;
  const currentItem = gallery.find((g) => g.id === currentId) ?? null;
  const histStats = (() => {
    let done = 0,
      failed = 0,
      pending = 0,
      cost = 0;
    for (const g of gallery) {
      if (g.url) done++;
      else if (g.status === "failed") failed++;
      else pending++;
      cost += Number(g.cost) || 0;
    }
    return { done, failed, pending, cost: cost.toFixed(2) };
  })();
  const query = histQuery.trim().toLowerCase();
  const visibleHistory = gallery.filter(
    (g) =>
      (histMode === "all" || g.mode === histMode) &&
      (histModel === "all" || (g.model ?? "brown-dust") === histModel) &&
      (!histFailed || (!g.url && g.status === "failed")) &&
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

      <main className="relative z-10 flex min-h-0 w-full flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <section
          className="apple-card stagger-1 m-0 flex min-h-0 w-full shrink-0 flex-col overflow-visible rounded-none border-x-0 border-t-0 lg:overflow-hidden lg:border-y-0 lg:border-l-0"
          style={isDesktop ? { width: leftPx } : undefined}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-black/[0.06] px-3 py-2.5 sm:px-4">
            <span className="text-[13px] font-semibold tracking-[-0.02em] text-[#1d1d1f]">
              AI Studio
            </span>
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
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const f = e.dataTransfer.files?.[0];
                    if (f) onPickFile(f);
                  }}
                  className={`ref-drop relative flex cursor-pointer items-center justify-center overflow-hidden rounded-2xl border border-dashed border-black/[0.12] bg-white/70 transition hover:border-[rgba(0,113,227,0.45)] ${
                    preview ? "p-1.5" : "h-32"
                  }`}
                >
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
                  <span className="tabular-nums text-[#0071e3]">
                    {denoise.toFixed(2)}
                  </span>
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={denoise}
                  onChange={(e) => setDenoise(Number(e.target.value))}
                  className="w-full"
                />
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
          onPointerDown={(e) => {
            draggingRef.current = true;
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          }}
          className="hidden w-1 shrink-0 cursor-col-resize bg-black/[0.06] transition hover:bg-[#0071e3]/40 lg:block"
        />

        <section className="apple-card stagger-2 flex min-h-[50vh] min-w-0 flex-1 flex-col overflow-hidden rounded-none border-x-0 border-b-0 p-2 sm:p-3 lg:min-h-0 lg:border-y-0 lg:border-r-0">
          <div className="mb-2 flex min-h-[28px] shrink-0 flex-wrap items-center gap-2 px-1">
            <h2 className="text-[13px] font-medium text-[#1d1d1f]">结果</h2>
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
            className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-[16px]"
            style={{
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.92), rgba(245,245,247,0.96))",
              boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.06)",
            }}
          >
            {loading ? (
              <GeneratingCanvas
                aspect={mode === "i2i" && preview ? previewAspect : width / height}
                progress={progress}
                reference={mode === "i2i" ? preview : null}
              />
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

          {currentItem && currentItem.url && !loading && (
            <div className="mt-2 shrink-0 rounded-2xl bg-black/[0.025] px-3 py-2.5">
              <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#6e6e73]">
                <span className="font-semibold text-[#1d1d1f]">
                  {findModel(currentItem.model)?.name ?? "棕色尘埃"}
                </span>
                <span>{currentItem.mode === "i2i" ? "图生图" : "文生图"}</span>
                <span className="tabular-nums">{formatTime(currentItem.createdAt)}</span>
                {currentItem.seed != null && <span className="tabular-nums">种子 {currentItem.seed}</span>}
                {currentItem.cost && <span className="tabular-nums">¥{currentItem.cost}</span>}
                {notice && (
                  <span className="animate-chip-in ml-auto rounded-full bg-[#0071e3] px-2 py-0.5 text-white">
                    {notice}
                  </span>
                )}
              </div>
              <p className="line-clamp-2 text-[12px] leading-relaxed text-[#3a3a3c]" title={currentItem.prompt}>
                {currentItem.prompt}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(
                  [
                    ["复制提示词", () => copyPrompt(currentItem)],
                    ["复用参数", () => reuseItem(currentItem)],
                    ["作参考图", () => useAsReference(currentItem)],
                  ] as const
                ).map(([label, fn]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={fn}
                    className="item-action rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-[#1d1d1f] ring-1 ring-black/[0.08] transition hover:text-[#0071e3] hover:ring-[#0071e3]/50 active:scale-[0.97]"
                  >
                    {label}
                  </button>
                ))}
                <a
                  href={currentItem.url}
                  target="_blank"
                  rel="noreferrer"
                  className="item-action rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-[#1d1d1f] ring-1 ring-black/[0.08] transition hover:text-[#0071e3] hover:ring-[#0071e3]/50 active:scale-[0.97]"
                >
                  打开原图
                </a>
              </div>
            </div>
          )}
        </section>

        <aside className="apple-card stagger-3 flex min-h-[40vh] w-full shrink-0 flex-col overflow-hidden rounded-none border-x-0 border-b-0 lg:min-h-0 lg:w-[300px] lg:border-y-0 lg:border-r-0 xl:w-[340px]">
          <div className="shrink-0 border-b border-black/[0.06] px-3 py-2.5">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h2 className="text-[13px] font-semibold text-[#1d1d1f]">历史</h2>
              <span className="truncate text-[11px] tabular-nums text-[#86868b]">
                {histStats.done} 张{histStats.failed ? ` · 失败 ${histStats.failed}` : ""}
                {histStats.pending ? ` · 进行中 ${histStats.pending}` : ""} · 共 ¥{histStats.cost}
              </span>
            </div>
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
                value={histModel}
                onChange={(e) => {
                  setHistModel(e.target.value as "all" | ModelId);
                  setHistPage(0);
                }}
                className="min-w-0 flex-1 rounded-lg border border-black/[0.08] bg-white px-1.5 py-1 text-[11px] text-[#1d1d1f] outline-none"
                aria-label="按模型筛选"
              >
                <option value="all">全部模型</option>
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-pressed={histFailed}
                onClick={() => {
                  setHistFailed((v) => !v);
                  setHistPage(0);
                }}
                className={`rounded-lg px-1.5 py-1 text-[11px] font-medium transition ${
                  histFailed ? "bg-[#d70015] text-white" : "text-[#6e6e73] hover:bg-black/[0.05]"
                }`}
              >
                失败
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {visibleHistory.length === 0 ? (
              <p className="px-2 py-8 text-center text-[12px] text-[#aeaeb2]">
                {gallery.length ? "没有符合条件的记录" : "生成的图片会保存在这里"}
              </p>
            ) : (
              <div key={`${page}-${histMode}-${histModel}-${histFailed}`} className="history-grid grid grid-cols-2 gap-2">
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
                        } else {
                          setError(`这条记录生成失败：${g.error || "任务失败"}`);
                        }
                      }}
                      title={g.url ? g.prompt : `失败：${g.error || "任务失败"}\n${g.prompt}`}
                      className={`history-card apple-thumb overflow-hidden rounded-xl bg-white text-left transition ${
                        on ? "ring-2 ring-[#0071e3]" : "ring-1 ring-black/[0.08] hover:ring-black/[0.2]"
                      }`}
                    >
                      <span className="relative block aspect-square w-full bg-[#f2f2f4]">
                        {g.url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={g.url} alt="" loading="lazy" className="h-full w-full object-cover" />
                        ) : (
                          <span className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center">
                            <span className="text-[12px] font-semibold text-[#d70015]">失败</span>
                            <span className="line-clamp-3 text-[10px] leading-snug text-[#86868b]">
                              {g.error || "任务失败"}
                            </span>
                          </span>
                        )}
                        <span className="absolute left-1 top-1 rounded-md bg-black/50 px-1 py-px text-[9px] font-medium text-white">
                          {g.mode === "i2i" ? "图生图" : "文生图"}
                        </span>
                        {g.cost && g.url && (
                          <span className="absolute right-1 top-1 rounded-md bg-black/50 px-1 py-px text-[9px] tabular-nums text-white">
                            ¥{g.cost}
                          </span>
                        )}
                      </span>
                      <span className="block px-1.5 py-1">
                        <span className="block truncate text-[10px] font-medium text-[#1d1d1f]">
                          {findModel(g.model)?.name ?? "棕色尘埃"}
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
