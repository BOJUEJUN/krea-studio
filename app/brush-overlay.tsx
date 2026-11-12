"use client";

import type { KreaRegion } from "@/lib/krea-regions";
import { useId } from "react";
import { strokeGeometry, type BrushMask } from "@/lib/brush-mask";

export function BrushOverlay({ mask, color }: { mask: BrushMask; color: string }) {
  const id = "paint" + useId().replace(/[^\w-]/g, "");
  return <svg aria-hidden="true" data-brush-overlay="" viewBox="0 0 1 1" preserveAspectRatio="none"
    className="pointer-events-none absolute inset-0 h-full w-full">
    <defs><mask id={id} x="0" y="0" width="1" height="1" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse">
      {mask.base && <rect {...mask.base} fill="white" />}
      {mask.strokes.map((s, i) => <path key={i} {...strokeGeometry(s)} fill="none" stroke={s.erase ? "black" : "white"} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />)}
    </mask></defs>
    <rect width="1" height="1" fill={color} opacity=".46" mask={`url(#${id})`} />
  </svg>;
}

export function RegionMark({ region, color, numbered }: {
  region: KreaRegion; color: string; numbered?: boolean;
}) {
  const at = { left: region.x * 100 + "%", top: region.y * 100 + "%" };
  return <span aria-hidden="true" className="pointer-events-none absolute inset-0 z-[2] overflow-hidden rounded-[inherit]">
    {region.mask ? <BrushOverlay mask={region.mask} color={color} /> :
      <span className={numbered ? "absolute border-2" : "absolute border"}
        style={{ ...at, width: region.width * 100 + "%", height: region.height * 100 + "%", borderColor: color, background: color + "29" }} />}
    {numbered && <span className="absolute rounded-br px-1 text-[11px] font-bold leading-4 text-white" style={{ ...at, background: color }}>{region.label}</span>}
  </span>;
}
