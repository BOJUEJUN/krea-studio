"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Loading placeholder framed at the output's aspect ratio: large, soft colour
 * fields drifting slowly with a gentle light sweep. For image-to-image the
 * reference sits underneath, heavily blurred, and "develops" (less blur, more
 * opacity) as progress advances.
 */
export function GeneratingCanvas({
  aspect,
  progress,
  reference,
}: {
  aspect: number;
  progress: number;
  reference?: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => {
      const W = el.clientWidth - 24;
      const H = el.clientHeight - 56; // room for the progress line
      if (W <= 0 || H <= 0) return;
      const a = aspect > 0 ? aspect : 1;
      const w = Math.min(W, H * a);
      setBox({ w: Math.round(w), h: Math.round(w / a) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);

  const p = Math.max(0, Math.min(100, progress)) / 100;

  return (
    <div ref={wrapRef} className="flex h-full w-full flex-col items-center justify-center p-3">
      {box && (
        <div
          className="gen-frame relative overflow-hidden rounded-[22px]"
          style={{ width: box.w, height: box.h }}
        >
          {reference && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={reference}
              alt=""
              aria-hidden
              className="absolute inset-0 h-full w-full scale-110 object-cover transition-[filter,opacity] duration-700 ease-out"
              style={{
                filter: `blur(${Math.round(36 - p * 22)}px) saturate(1.15)`,
                opacity: 0.35 + p * 0.4,
              }}
            />
          )}
          <div className="gen-blob gen-blob-a" />
          <div className="gen-blob gen-blob-b" />
          <div className="gen-blob gen-blob-c" />
          <div className="gen-sheen" />
        </div>
      )}
      <div className="mt-4 flex w-48 flex-col items-center gap-1.5">
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-black/[0.06]">
          <div
            className="h-full rounded-full bg-[#0071e3] transition-[width] duration-500 ease-out"
            style={{ width: `${Math.floor(progress)}%` }}
          />
        </div>
        <p className="text-[12px] tabular-nums text-[#6e6e73]">正在生成 · {Math.floor(progress)}%</p>
      </div>
    </div>
  );
}
