"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_MODEL, MODELS, findModel, type Mode, type ModelId } from "@/lib/models";

type Readiness = Record<string, Record<Mode, boolean>>;

type GalleryItem = {
  id: string;
  mode: Mode;
  model?: string;
  prompt: string;
  url: string;
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
  createdAt: number;
};

const RATIOS = [
  { label: "1:1", w: 2048, h: 2048, kind: "square" as const },
  { label: "3:4", w: 1536, h: 2048, kind: "portrait" as const },
  { label: "2:3", w: 1360, h: 2048, kind: "portrait" as const },
  { label: "9:16", w: 1152, h: 2048, kind: "portrait" as const },
  { label: "4:3", w: 2048, h: 1536, kind: "landscape" as const },
  { label: "3:2", w: 2048, h: 1360, kind: "landscape" as const },
  { label: "16:9", w: 2048, h: 1152, kind: "landscape" as const },
  { label: "21:9", w: 2048, h: 878, kind: "landscape" as const },
];

const MAX_RES = 2048;
const MIN_RES = 256;
const EST_COST = "0.04";
const PENDING_KEY = "krea-studio.pending-job";
const MODEL_KEY = "krea-studio.model";
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
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [prompt, setPrompt] = useState("");
  const [width, setWidth] = useState(2048);
  const [height, setHeight] = useState(2048);
  const [widthText, setWidthText] = useState("2048");
  const [heightText, setHeightText] = useState("2048");
  const [showMoreRatio, setShowMoreRatio] = useState(false);
  const [denoise, setDenoise] = useState(0.5);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultKey, setResultKey] = useState(0);
  const [elapsed, setElapsed] = useState(0);
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
  const fileBlobRef = useRef<File | null>(null);
  const timerRef = useRef<number | null>(null);
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
          setResultUrl(d.items[0].url);
          if (d.items[0].cost) setLastCost(String(d.items[0].cost));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (loading) {
      setElapsed(0);
      timerRef.current = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [loading]);

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
    setResultUrl(url);
    setResultKey((k) => k + 1);
    const item: GalleryItem = {
      id: pending.taskId,
      taskId: pending.taskId,
      seed: pending.seed,
      mode: pending.mode,
      model: pending.model,
      prompt: pending.prompt,
      url,
      cost: done.cost || null,
      createdAt: pending.createdAt,
    };
    setGallery((g) => [
      item,
      ...g.filter((x) => x.taskId !== item.taskId && x.url !== item.url),
    ].slice(0, 200));
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
  }, [pollTask]);

  const resumePending = useCallback((pending: PendingJob) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const job = ++jobRef.current;
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
    if (!prompt.trim()) {
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
    setLoading(true);
    setResultUrl(null);
    setLastCost(null);
    try {
      let data: any;
      if (mode === "t2i") {
        data = await fetchJson("/api/generate/t2i", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: prompt.trim(),
            model,
            width: clampRes(Number(widthText) || width),
            height: clampRes(Number(heightText) || height),
          }),
        });
      } else {
        const fd = new FormData();
        fd.append("prompt", prompt.trim());
        fd.append("model", model);
        fd.append("image", await prepareReferenceImage(imageFile as File));
        fd.append("denoise", String(denoise));
        data = await fetchJson("/api/generate/i2i", { method: "POST", body: fd });
      }
      if (jobRef.current !== job) return;
      if (!data?.ok || !data?.taskId) {
        throw new Error(data?.error || "任务创建失败");
      }
      const pending: PendingJob = {
        taskId: String(data.taskId),
        seed: data.seed,
        mode,
        model,
        prompt: prompt.trim(),
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
  }, [mode, model, readiness, prompt, width, height, widthText, heightText, denoise, finishPending, resumePending]);

  const btnPrice = lastCost || EST_COST;
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
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="模型">
                {MODELS.map((m) => {
                  const on = model === m.id;
                  const ready = isReady(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => pickModel(m.id)}
                      className={`model-card group relative overflow-hidden rounded-2xl text-left transition ${
                        on
                          ? "ring-2 ring-[#0071e3] ring-offset-2 ring-offset-white"
                          : "ring-1 ring-black/[0.08] hover:ring-black/[0.2]"
                      }`}
                    >
                      <div className="relative aspect-[4/3] w-full overflow-hidden bg-gradient-to-br from-[#e8e8ed] to-[#f5f5f7]">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={m.cover}
                          alt=""
                          loading="lazy"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
                          }}
                          className={`h-full w-full object-cover transition duration-300 group-hover:scale-[1.04] ${
                            ready ? "" : "grayscale-[0.6] opacity-70"
                          }`}
                        />
                        {!ready && (
                          <span className="absolute right-1.5 top-1.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white">
                            待接入
                          </span>
                        )}
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent px-2 pb-1.5 pt-5">
                          <div className="truncate text-[12px] font-semibold leading-tight text-white">
                            {m.name}
                          </div>
                          <div className="truncate text-[10px] leading-tight text-white/80">
                            {m.tagline}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {mode === "i2i" && (
              <div className="mb-4">
                <label className="mb-2 block text-[11px] font-medium uppercase tracking-[0.06em] text-[#86868b]">
                  参考图
                </label>
                <div
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const f = e.dataTransfer.files?.[0];
                    if (f) onPickFile(f);
                  }}
                  className="flex h-32 cursor-pointer items-center justify-center overflow-hidden rounded-2xl border border-dashed border-black/[0.12] bg-white/70 transition hover:border-[rgba(0,113,227,0.45)]"
                >
                  {preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={preview}
                      alt="参考图"
                      className="animate-image-reveal h-full w-full object-cover"
                    />
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
                  onChange={(e) => onPickFile(e.target.files?.[0] || null)}
                />
              </div>
            )}

            <div className="mb-4">
              <label className="mb-2 block text-[11px] font-medium uppercase tracking-[0.06em] text-[#86868b]">
                描述
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                placeholder={
                  mode === "t2i" ? "描述你想要的画面…" : "希望参考图如何变化…"
                }
                className="w-full resize-y rounded-2xl border border-black/[0.08] bg-white px-3.5 py-3 text-[14px] leading-relaxed text-[#1d1d1f] outline-none transition placeholder:text-[#aeaeb2] focus:border-[rgba(0,113,227,0.45)] focus:ring-4 focus:ring-[rgba(0,113,227,0.12)]"
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
              disabled={loading || !prompt.trim() || !modelReady}
              className="apple-btn-primary flex w-full items-center justify-center gap-2 py-3.5 text-[15px]"
            >
              {loading ? (
                <>
                  <span className="animate-spin-slow h-3.5 w-3.5 rounded-full border-[1.5px] border-white/40 border-t-white" />
                  生成中 {elapsed}s
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
          <div className="mb-2 shrink-0 px-1">
            <h2 className="text-[13px] font-medium text-[#1d1d1f]">结果</h2>
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
              <div className="flex flex-col items-center gap-3">
                <div
                  className="animate-shimmer animate-pulse-ring h-14 w-14 rounded-[18px]"
                  style={{
                    background:
                      "linear-gradient(135deg, rgba(0,113,227,0.18), rgba(90,200,250,0.28))",
                  }}
                />
                <p className="text-[14px] text-[#6e6e73]">生成中</p>
                <p className="text-[12px] tabular-nums text-[#aeaeb2]">{elapsed}s</p>
              </div>
            ) : resultUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={resultKey}
                src={resultUrl}
                alt="生成结果"
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

          {gallery.length > 0 && (
            <div className="mt-3 shrink-0">
              <div className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-[0.06em] text-[#86868b]">
                历史 · {gallery.length}
              </div>
              <div className="flex gap-2 overflow-x-auto px-1 pb-1">
                {gallery.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => {
                      setResultUrl(g.url);
                      setResultKey((k) => k + 1);
                      if (g.cost) setLastCost(g.cost);
                    }}
                    title={g.prompt}
                    className="apple-thumb relative h-14 w-14 shrink-0 overflow-hidden rounded-xl"
                    style={{ boxShadow: "0 0 0 0.5px rgba(0,0,0,0.08)" }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={g.url} alt="" className="h-full w-full object-cover" />
                    {g.cost && (
                      <span className="absolute inset-x-0 bottom-0 bg-black/45 px-1 py-0.5 text-[9px] tabular-nums text-white">
                        ¥{g.cost}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
