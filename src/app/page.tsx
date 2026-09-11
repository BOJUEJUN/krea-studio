"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Mode = "t2i" | "i2i";

type GalleryItem = {
  id: string;
  mode: Mode;
  prompt: string;
  url: string;
  cost?: string | null;
  createdAt: number;
};

const QUICK_RATIOS = [
  { label: "1:1", w: 1024, h: 1024 },
  { label: "3:4", w: 1152, h: 1536 },
  { label: "16:9", w: 1920, h: 1080 },
];

const MORE_RATIOS = [
  { label: "1:1", w: 1024, h: 1024 },
  { label: "1:1 大", w: 2048, h: 2048 },
  { label: "3:4", w: 1152, h: 1536 },
  { label: "4:3", w: 1536, h: 1152 },
  { label: "2:3", w: 1024, h: 1536 },
  { label: "3:2", w: 1536, h: 1024 },
  { label: "9:16", w: 1080, h: 1920 },
  { label: "16:9", w: 1920, h: 1080 },
  { label: "4:5", w: 1024, h: 1280 },
  { label: "5:4", w: 1280, h: 1024 },
  { label: "21:9", w: 2016, h: 864 },
  { label: "1:2", w: 1024, h: 2048 },
];

const MAX_RES = 2048;
const MIN_RES = 256;
const EST_COST = "0.04";

function clampRes(n: number) {
  if (!Number.isFinite(n)) return MIN_RES;
  return Math.min(MAX_RES, Math.max(MIN_RES, Math.round(n)));
}

export default function StudioPage() {
  const [mode, setMode] = useState<Mode>("t2i");
  const [prompt, setPrompt] = useState("");
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [widthText, setWidthText] = useState("1024");
  const [heightText, setHeightText] = useState("1024");
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

  const fileRef = useRef<HTMLInputElement>(null);
  const fileBlobRef = useRef<File | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((d) => {
        if (d?.account?.remainMoney != null) setMoney(String(d.account.remainMoney));
      })
      .catch(() => {});
    fetch("/api/history")
      .then((r) => r.json())
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

  const generate = useCallback(async () => {
    setError(null);
    if (!prompt.trim()) {
      setError("请先输入描述");
      return;
    }
    setLoading(true);
    setResultUrl(null);
    setLastCost(null);
    try {
      let res: Response;
      if (mode === "t2i") {
        res = await fetch("/api/generate/t2i", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: prompt.trim(),
            width: clampRes(Number(widthText) || width),
            height: clampRes(Number(heightText) || height),
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
        fd.append("denoise", String(denoise));
        res = await fetch("/api/generate/i2i", { method: "POST", body: fd });
      }
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "生成失败");
        return;
      }
      if (data.cost) setLastCost(String(data.cost));
      if (data.account?.remainMoney != null) {
        setMoney(String(data.account.remainMoney));
      }
      const url = data.imageUrl || data.images?.[0];
      if (!url) {
        setError("任务完成但未返回图片");
        return;
      }
      setResultUrl(url);
      setResultKey((k) => k + 1);
      const item = {
        id: String(Date.now()),
        mode,
        prompt: prompt.trim(),
        url,
        cost: data.cost || null,
        createdAt: Date.now(),
      };
      setGallery((g) => [item, ...g].slice(0, 200));
      fetch("/api/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
      }).catch(() => {});
    } catch (e: any) {
      setError(e?.message || "网络错误");
    } finally {
      setLoading(false);
    }
  }, [mode, prompt, width, height, widthText, heightText, denoise]);

  const btnPrice = lastCost || EST_COST;

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

      <main className="relative z-10 mx-auto grid min-h-0 w-full max-w-[1440px] flex-1 gap-3 p-3 sm:gap-4 lg:grid-cols-[minmax(300px,360px)_1fr] lg:p-4">
        <section className="apple-card stagger-1 flex min-h-0 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center justify-between border-b border-black/[0.06] px-4 py-3 sm:px-5">
            <span className="text-[14px] font-semibold tracking-[-0.02em] text-[#1d1d1f]">
              棕色尘埃风格化
            </span>
            {money != null && (
              <span className="animate-chip-in rounded-full bg-black/[0.04] px-2.5 py-1 text-[12px] font-medium tabular-nums text-[#6e6e73]">
                ¥{money}
              </span>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
            <div className="apple-seg mb-4 grid grid-cols-2">
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
                      <div className="text-[12px] text-[#86868b]">点击或拖入图片</div>
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
                <div className="mb-2 flex items-center justify-between">
                  <label className="text-[11px] font-medium uppercase tracking-[0.06em] text-[#86868b]">
                    分辨率
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowMoreRatio((v) => !v)}
                    className="text-[12px] font-medium text-[#0071e3]"
                  >
                    {showMoreRatio ? "收起" : "更多"}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(showMoreRatio ? MORE_RATIOS : QUICK_RATIOS).map((p) => {
                    const on = width === p.w && height === p.h;
                    return (
                      <button
                        key={p.label + p.w}
                        onClick={() => applyRatio(p.w, p.h)}
                        className={`apple-chip rounded-full px-2.5 py-1.5 text-[12px] font-medium ${
                          on
                            ? "bg-[#0071e3] text-white"
                            : "bg-black/[0.05] text-[#1d1d1f] hover:bg-black/[0.08]"
                        }`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    inputMode="numeric"
                    value={widthText}
                    onChange={(e) => setWidthText(e.target.value.replace(/[^\d]/g, ""))}
                    onBlur={commitWidth}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitWidth();
                    }}
                    className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-[13px] tabular-nums text-[#1d1d1f] outline-none focus:border-[rgba(0,113,227,0.45)]"
                    aria-label="宽度"
                    placeholder="宽"
                  />
                  <span className="text-[#aeaeb2]">×</span>
                  <input
                    inputMode="numeric"
                    value={heightText}
                    onChange={(e) => setHeightText(e.target.value.replace(/[^\d]/g, ""))}
                    onBlur={commitHeight}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitHeight();
                    }}
                    className="w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-[13px] tabular-nums text-[#1d1d1f] outline-none focus:border-[rgba(0,113,227,0.45)]"
                    aria-label="高度"
                    placeholder="高"
                  />
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

            <button
              onClick={generate}
              disabled={loading || !prompt.trim()}
              className="apple-btn-primary flex w-full items-center justify-center gap-2 py-3.5 text-[15px]"
            >
              {loading ? (
                <>
                  <span className="animate-spin-slow h-3.5 w-3.5 rounded-full border-[1.5px] border-white/40 border-t-white" />
                  生成中 {elapsed}s
                </>
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

        <section className="apple-card stagger-2 flex min-h-0 flex-col overflow-hidden p-3 sm:p-4">
          <div className="mb-2 flex shrink-0 items-center justify-between px-1">
            <h2 className="text-[13px] font-medium text-[#1d1d1f]">结果</h2>
            {resultUrl && (
              <a
                href={resultUrl}
                target="_blank"
                rel="noreferrer"
                className="apple-chip rounded-full bg-black/[0.05] px-3 py-1 text-[12px] font-medium text-[#0071e3]"
              >
                原图
              </a>
            )}
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
