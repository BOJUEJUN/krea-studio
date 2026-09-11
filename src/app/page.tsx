"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Mode = "t2i" | "i2i";

type ModelInfo = {
  id: string;
  endpoint: string;
  name: string;
  desc: string;
  kind: "t2i" | "i2i";
};

type GalleryItem = {
  id: string;
  mode: Mode;
  prompt: string;
  url: string;
  model?: string;
  createdAt: number;
};

const RES_PRESETS = [
  { label: "1:1", w: 1024, h: 1024 },
  { label: "3:4", w: 768, h: 1024 },
  { label: "4:3", w: 1024, h: 768 },
  { label: "16:9", w: 1280, h: 720 },
  { label: "9:16", w: 720, h: 1280 },
];

export default function StudioPage() {
  const [mode, setMode] = useState<Mode>("t2i");
  const [prompt, setPrompt] = useState("");
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [t2iModel, setT2iModel] = useState("jimeng-4.6");
  const [i2iModel, setI2iModel] = useState("jimeng-4.6");
  const [models, setModels] = useState<{ t2i: ModelInfo[]; i2i: ModelInfo[] }>({
    t2i: [],
    i2i: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [status, setStatus] = useState<{
    ready: boolean;
    message: string;
    coins?: string;
    money?: string;
  } | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const fileBlobRef = useRef<File | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) {
          setStatus({ ready: false, message: d.error || "服务未就绪" });
          return;
        }
        if (d.models) setModels(d.models);
        setStatus({
          ready: true,
          message: "RunningHub 已连接",
          coins: d.account?.remainCoins,
          money: d.account?.remainMoney,
        });
      })
      .catch(() =>
        setStatus({ ready: false, message: "无法连接后端，请检查服务是否启动" })
      );
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

  const onPickFile = useCallback((file: File | null) => {
    fileBlobRef.current = file;
    if (!file) {
      setPreview(null);
      return;
    }
    setPreview(URL.createObjectURL(file));
  }, []);

  const generate = useCallback(async () => {
    setError(null);
    if (!prompt.trim()) {
      setError("请先输入提示词");
      return;
    }
    setLoading(true);
    setResultUrl(null);
    setTaskId(null);
    try {
      let res: Response;
      if (mode === "t2i") {
        res = await fetch("/api/generate/t2i", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: prompt.trim(),
            modelId: t2iModel,
            width,
            height,
          }),
        });
      } else {
        if (!fileBlobRef.current) {
          setError("请先上传参考图");
          setLoading(false);
          return;
        }
        const fd = new FormData();
        fd.append("prompt", prompt.trim());
        fd.append("image", fileBlobRef.current);
        fd.append("modelId", i2iModel);
        res = await fetch("/api/generate/i2i", { method: "POST", body: fd });
      }

      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "生成失败");
        return;
      }
      setTaskId(data.taskId || null);
      const url = data.imageUrl || data.images?.[0];
      if (!url) {
        setError("任务完成但未返回图片");
        return;
      }
      setResultUrl(url);
      setGallery((g) =>
        [
          {
            id: `${Date.now()}`,
            mode,
            prompt: prompt.trim(),
            url,
            model: data.model,
            createdAt: Date.now(),
          },
          ...g,
        ].slice(0, 24)
      );
    } catch (e: any) {
      setError(e?.message || "网络错误");
    } finally {
      setLoading(false);
    }
  }, [mode, prompt, width, height, t2iModel, i2iModel]);

  const modelList = mode === "t2i" ? models.t2i : models.i2i;
  const activeModel = mode === "t2i" ? t2iModel : i2iModel;
  const setActiveModel = mode === "t2i" ? setT2iModel : setI2iModel;

  return (
    <div className="min-h-screen">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-40 top-[-10%] h-[480px] w-[480px] rounded-full bg-accent/20 blur-[120px]" />
        <div className="absolute right-[-10%] top-[30%] h-[420px] w-[420px] rounded-full bg-mint/10 blur-[120px]" />
      </div>

      <div className="relative mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-lg font-semibold text-white shadow-glow">
              K
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-ink-50">
                Krea Studio
              </h1>
              <p className="text-xs text-ink-400">
                RunningHub OpenAPI · 标准模型 · 文生图 / 图生图
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-ink-400">
            {status && (
              <span
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 ${
                  status.ready
                    ? "border-mint/30 bg-mint/10 text-mint"
                    : "border-amber-400/30 bg-amber-400/10 text-amber-300"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    status.ready ? "bg-mint" : "bg-amber-300"
                  }`}
                />
                {status.message}
              </span>
            )}
            {status?.coins && (
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 font-mono">
                {status.coins} RH · ¥{status.money}
              </span>
            )}
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
          <section className="rounded-2xl border border-white/8 bg-ink-900/80 p-5 shadow-card backdrop-blur-xl">
            <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-ink-800 p-1">
              {(
                [
                  ["t2i", "文生图"],
                  ["i2i", "图生图"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setMode(key)}
                  className={`rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                    mode === key
                      ? "bg-accent text-white shadow-glow"
                      : "text-ink-400 hover:text-ink-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-ink-400">
              模型
            </label>
            <div className="mb-4 grid gap-2">
              {(modelList.length
                ? modelList
                : [
                    {
                      id: "jimeng-4.6",
                      name: "即梦 4.6",
                      desc: "加载中…",
                      endpoint: "",
                      kind: mode,
                    } as ModelInfo,
                  ]
              ).map((m) => (
                <button
                  key={m.id}
                  onClick={() => setActiveModel(m.id)}
                  className={`rounded-xl border px-3 py-2.5 text-left transition ${
                    activeModel === m.id
                      ? "border-accent/60 bg-accent/15"
                      : "border-white/10 bg-ink-800/60 hover:border-white/20"
                  }`}
                >
                  <div className="text-sm font-medium text-ink-50">{m.name}</div>
                  <div className="text-[11px] text-ink-400">{m.desc}</div>
                </button>
              ))}
            </div>

            <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-ink-400">
              提示词
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              placeholder={
                mode === "t2i"
                  ? "例如：一只橘猫坐在窗台上晒太阳，写实摄影，柔和自然光"
                  : "描述你希望参考图如何变化…"
              }
              className="mb-4 w-full resize-y rounded-xl border border-white/10 bg-ink-800/80 px-3 py-3 text-sm text-ink-50 outline-none ring-accent/40 transition placeholder:text-ink-600 focus:ring-2"
            />

            {mode === "i2i" && (
              <div className="mb-4">
                <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-ink-400">
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
                  className="group relative flex h-36 cursor-pointer items-center justify-center overflow-hidden rounded-xl border border-dashed border-white/15 bg-ink-800/50 transition hover:border-accent/50"
                >
                  {preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={preview}
                      alt="参考图"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="text-center text-xs text-ink-400">
                      <div className="mb-1 text-2xl">＋</div>
                      点击或拖拽上传图片
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

            {mode === "t2i" && (
              <div className="mb-5">
                <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-ink-400">
                  画幅
                </label>
                <div className="flex flex-wrap gap-2">
                  {RES_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      onClick={() => {
                        setWidth(p.w);
                        setHeight(p.h);
                      }}
                      className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                        width === p.w && height === p.h
                          ? "border-accent bg-accent/20 text-accent-glow"
                          : "border-white/10 bg-ink-800 text-ink-400 hover:border-white/20"
                      }`}
                    >
                      {p.label}
                      <span className="ml-1 opacity-60">
                        {p.w}×{p.h}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={generate}
              disabled={loading || !prompt.trim()}
              className="group relative w-full overflow-hidden rounded-xl bg-accent px-4 py-3.5 text-sm font-semibold text-white shadow-glow transition disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <span className="inline-flex items-center justify-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  生成中 {elapsed}s
                </span>
              ) : (
                "开始生成"
              )}
            </button>

            {error && (
              <div className="mt-3 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2.5 text-xs text-red-300">
                {error}
              </div>
            )}

            {taskId && (
              <p className="mt-3 truncate font-mono text-[11px] text-ink-600">
                task: {taskId}
              </p>
            )}
          </section>

          <section className="flex min-h-[520px] flex-col rounded-2xl border border-white/8 bg-ink-900/60 p-5 shadow-card backdrop-blur-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-medium text-ink-200">输出</h2>
              {resultUrl && (
                <a
                  href={resultUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-ink-400 transition hover:border-accent/40 hover:text-accent-glow"
                >
                  打开原图
                </a>
              )}
            </div>

            <div className="relative flex flex-1 items-center justify-center overflow-hidden rounded-xl border border-white/5 bg-[radial-gradient(circle_at_30%_20%,rgba(124,92,255,0.08),transparent_50%),radial-gradient(circle_at_80%_70%,rgba(94,234,212,0.05),transparent_45%)]">
              {loading ? (
                <div className="flex flex-col items-center gap-3 text-ink-400">
                  <div className="h-16 w-16 animate-pulse-soft rounded-2xl bg-accent/20" />
                  <p className="text-sm">RunningHub 排队 / 推理中…</p>
                  <p className="font-mono text-xs text-ink-600">{elapsed}s</p>
                </div>
              ) : resultUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={resultUrl}
                  alt="生成结果"
                  className="max-h-[70vh] w-auto max-w-full object-contain"
                />
              ) : (
                <div className="max-w-sm px-6 text-center">
                  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-2xl">
                    ✦
                  </div>
                  <p className="text-sm text-ink-300">输入提示词，生成你的第一张图</p>
                  <p className="mt-2 text-xs leading-relaxed text-ink-600">
                    API Key 只保存在服务器端，朋友打开网页即可直接使用。
                  </p>
                </div>
              )}
            </div>

            {gallery.length > 0 && (
              <div className="mt-5">
                <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-ink-400">
                  本次会话 · {gallery.length}
                </h3>
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
                  {gallery.map((g) => (
                    <button
                      key={g.id}
                      onClick={() => setResultUrl(g.url)}
                      title={g.prompt}
                      className="group relative aspect-square overflow-hidden rounded-lg border border-white/10"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={g.url}
                        alt=""
                        className="h-full w-full object-cover transition group-hover:scale-105"
                      />
                      <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[9px] uppercase text-white/80">
                        {g.mode === "t2i" ? "T2I" : "I2I"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>

        <footer className="mt-8 text-center text-[11px] text-ink-600">
          Krea Studio · RunningHub 标准模型 API · 生成内容由使用者自行负责
        </footer>
      </div>
    </div>
  );
}
