"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 2026-11-06 (用户: 4 张排版中间突然隔开不好看): the cells are sized to the picture's shape and packed together
 * in the middle (2 side by side, 3 in a row, 4 as 2×2), instead of stretching over the whole area.
 */
export function BatchGrid({ count, aspect, cell }: { count: number; aspect: number; cell: (i: number) => React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const cols = count === 3 ? 3 : count === 1 ? 1 : 2;
  const rows = Math.ceil(count / cols);
  const gap = 10;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const W = el.clientWidth - 16, H = el.clientHeight - 16;
      const a = aspect > 0 ? aspect : 1;
      const w = Math.max(40, Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * a));
      setBox({ w: Math.floor(w), h: Math.floor(w / a) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect, cols, rows]);
  return (
    <div ref={ref} className="flex h-full w-full items-center justify-center">
      {box && (
        <div className="grid" style={{ gap, gridTemplateColumns: `repeat(${cols}, ${box.w}px)`, gridAutoRows: `${box.h}px` }}>
          {Array.from({ length: count }, (_, i) => (
            <div key={i} className="relative min-h-0 min-w-0">
              {cell(i)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
