"use client";

import { useEffect, useState } from "react";
import { LOADING_VARIANTS, LoadingView } from "../loading-variants";

/** Side-by-side preview of the loading animations, with simulated progress. */
export default function LoadingLab() {
  const [progress, setProgress] = useState(0);
  const [withRef, setWithRef] = useState(true);

  useEffect(() => {
    const id = window.setInterval(() => setProgress((p) => (p >= 100 ? 0 : p + 1.25)), 120);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="min-h-[100dvh] bg-[#f5f5f7] px-4 py-6 sm:px-8">
      <div className="mx-auto mb-5 flex max-w-6xl flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold text-[#1d1d1f]">生成动画方案</h1>
          <p className="text-[13px] text-[#6e6e73]">进度为模拟，循环播放。告诉我选哪个字母即可。</p>
        </div>
        <div className="apple-seg flex">
          {(
            [
              [true, "图生图（有参考图）"],
              [false, "文生图（无参考图）"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={String(v)}
              type="button"
              data-active={withRef === v}
              onClick={() => setWithRef(v)}
              className="apple-seg-item px-3 py-1.5 text-[12px] font-medium text-[#6e6e73]"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="mx-auto grid max-w-6xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {LOADING_VARIANTS.map((v) => (
          <div key={v.key} className="overflow-hidden rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="h-[380px]">
              <LoadingView
                variant={v.key}
                aspect={withRef ? 507 / 720 : 1}
                progress={progress}
                reference={withRef ? "/models/lol-236-v11.jpg" : null}
              />
            </div>
            <div className="border-t border-black/[0.06] px-4 py-3">
              <div className="text-[14px] font-semibold text-[#1d1d1f]">{v.name}</div>
              <div className="text-[12px] text-[#6e6e73]">{v.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
