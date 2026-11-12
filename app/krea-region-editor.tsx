"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { MAX_KREA_REGIONS, MAX_REGION_NOTE, type KreaRegion, type RegionBox } from "@/lib/krea-regions";

type Point = { x: number; y: number };
type Drag = { pointer: number; start: Point; region?: KreaRegion; action: "draw" | "move" | "resize" };
const colors = ["#0766d3", "#aa2676", "#13735a", "#9d4c09", "#7652ae"];
const clamp = (v: number, max = 1) => Math.max(0, Math.min(max, v));
const bounds = (r: RegionBox) => ({ left: r.x * 100 + "%", top: r.y * 100 + "%", width: r.width * 100 + "%", height: r.height * 100 + "%" });

function boxAt(drag: Drag, p: Point): RegionBox {
  const { start, region } = drag;
  if (region && drag.action === "move") {
    return { ...region, x: clamp(region.x + p.x - start.x, 1 - region.width), y: clamp(region.y + p.y - start.y, 1 - region.height) };
  }
  if (region && drag.action === "resize") {
    return { ...region, width: clamp(Math.max(0.001, region.width + p.x - start.x), 1 - region.x),
      height: clamp(Math.max(0.001, region.height + p.y - start.y), 1 - region.y) };
  }
  return { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), width: Math.abs(p.x - start.x), height: Math.abs(p.y - start.y) };
}

export function KreaRegionEditor({ images, initial, onSave, onClose }: {
  images: string[]; initial: KreaRegion[]; onSave: (regions: KreaRegion[]) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const fields = useRef(new Map<string, HTMLTextAreaElement>());
  const drag = useRef<Drag | null>(null);
  const [regions, setRegions] = useState(initial);
  const [index, setIndex] = useState(0);
  const [active, setActive] = useState<string | null>(null);
  const [sketch, setSketch] = useState<RegionBox | null>(null);
  const [space, setSpace] = useState({ w: 0, h: 0 });
  const [loaded, setLoaded] = useState({ url: "", w: 0, h: 0 });
  const [failed, setFailed] = useState(false);
  const url = images[index];
  const ready = loaded.url === url && loaded.w > 0 && loaded.h > 0;
  const scale = ready ? Math.min(space.w / loaded.w, space.h / loaded.h) : 0;
  const visible = regions.filter((r) => r.image_idx === index);
  const atLimit = regions.length >= MAX_KREA_REGIONS;

  useEffect(() => {
    const modal = dialog.current!;
    modal.showModal();
    const observer = new ResizeObserver(([entry]) => setSpace({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(stage.current!);
    return () => { observer.disconnect(); modal.close(); };
  }, []);

  function select(label: string) {
    setActive(label);
    requestAnimationFrame(() => {
      const field = fields.current.get(label);
      field?.scrollIntoView({ block: "nearest" });
      if (window.matchMedia("(pointer: fine)").matches) field?.focus({ preventScroll: true });
    });
  }
  function add(box: RegionBox) {
    if (atLimit) return;
    let n = 1;
    while (regions.some((r) => r.label === String(n))) n++;
    const label = String(n);
    setRegions((list) => [...list, { ...box, image_idx: index, label, note: "" }]);
    select(label);
  }
  function cancelDrag() { drag.current = null; setSketch(null); }
  function position(e: ReactPointerEvent): Point {
    const rect = surface.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - rect.left) / rect.width), y: clamp((e.clientY - rect.top) / rect.height) };
  }
  function start(e: ReactPointerEvent<HTMLDivElement>) {
    if (!ready || e.button !== 0 || !e.isPrimary) return;
    const handle = (e.target as Element).closest<HTMLElement>("[data-region-handle]");
    const region = handle ? visible.find((r) => r.label === handle.dataset.label) : undefined;
    const action = handle?.dataset.regionHandle === "resize" ? "resize" : region ? "move" : "draw";
    e.preventDefault();
    surface.current!.setPointerCapture(e.pointerId);
    drag.current = { pointer: e.pointerId, start: position(e), region, action };
    if (region) setActive(region.label);
  }
  function finish(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (d?.pointer !== e.pointerId) return;
    const p = position(e), box = boxAt(d, p);
    cancelDrag();
    if (d.region) {
      setRegions((list) => list.map((r) => r.label === d.region!.label ? { ...r, ...box } : r));
      if (d.action === "move" && Math.abs(p.x - d.start.x) + Math.abs(p.y - d.start.y) < 0.005) select(d.region.label);
    } else if (box.width * loaded.w * scale >= 4 && box.height * loaded.h * scale >= 4) add(box);
    else {
      const hit = [...visible].reverse().find((r) => p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height);
      if (hit) select(hit.label);
    }
  }

  return <dialog ref={dialog} aria-labelledby="region-heading"
    className="m-auto w-[min(1000px,96vw)] max-w-none overflow-hidden rounded-2xl border border-edge/10 bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/55 backdrop:backdrop-blur-sm"
    onCancel={(e) => { e.preventDefault(); onClose(); }} onKeyDown={(e) => e.stopPropagation()}
    onPaste={(e) => e.stopPropagation()} onClick={(e) => { if (e.target === dialog.current) onClose(); }}>
    <div className="flex h-[min(680px,90dvh)] flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-edge/10 px-4 py-3">
        <h2 id="region-heading" className="text-[16px] font-semibold">框选修改</h2>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1.5 text-sm text-secondary hover:bg-well">取消</button>
          <button type="button" onClick={() => onSave(regions.map((r) => ({ ...r, note: r.note.trim() })))} className="apple-btn-primary rounded-full px-4 py-1.5 text-sm">完成</button>
        </div>
      </header>
      {images.length > 1 && <nav aria-label="选择标注图片" className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-edge/10 px-4 py-2">
        {images.map((src, i) => <button key={i} type="button" aria-pressed={i === index} aria-label={`标注图${i + 1}`}
          onClick={() => { cancelDrag(); setFailed(false); setIndex(i); setActive(null); }}
          className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-xs ${i === index ? "border-accent bg-accent/10 text-accent" : "border-transparent text-secondary hover:bg-well"}`}>
          <img src={src} alt="" className="h-6 w-6 rounded object-cover" />图{i + 1}
        </button>)}
      </nav>}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1.2fr)_minmax(0,1fr)] md:grid-cols-[minmax(0,1fr)_260px] md:grid-rows-1">
        <div className="min-h-0 bg-page p-2 md:p-4">
          <div ref={stage} className="grid h-full w-full place-items-center">
            <div ref={surface} data-region-surface="" aria-label={`图${index + 1}框选画面`}
              style={scale ? { width: loaded.w * scale, height: loaded.h * scale } : { width: "100%", height: "100%" }}
              className="relative touch-none select-none overflow-hidden cursor-crosshair"
              onPointerDown={start} onPointerUp={finish} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
              onPointerMove={(e) => { const d = drag.current; if (d?.pointer === e.pointerId && (d.region || !atLimit)) setSketch(boxAt(d, position(e))); }}>
              <img key={url} src={url} draggable={false} alt={`待修改的图${index + 1}`} className="pointer-events-none h-full w-full object-contain"
                onLoad={(e) => setLoaded({ url, w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} onError={() => setFailed(true)} />
              {failed && <span role="alert" className="absolute inset-0 grid place-items-center bg-page text-sm text-secondary">图片加载失败，请重新打开</span>}
              {ready && visible.map((r) => {
                const selected = r.label === active, color = colors[regions.indexOf(r) % colors.length];
                const box = drag.current?.region?.label === r.label && sketch ? sketch : r;
                return <div key={r.label} data-region-box={r.label} className="pointer-events-none absolute border-2" style={{ ...bounds(box), borderColor: color, backgroundColor: color + (selected ? "29" : "14") }}>
                  <button type="button" data-region-handle="move" data-label={r.label} aria-label={`选中区域 ${r.label}`} onClick={(e) => { if (!e.detail) select(r.label); }}
                    style={{ background: color }} className="pointer-events-auto absolute left-0 top-0 min-w-5 cursor-move rounded-br px-1 text-center text-[12px] font-bold leading-5 text-white">{r.label}</button>
                  {selected && <span data-region-handle="resize" data-label={r.label} title="拖动调整大小" className="pointer-events-auto absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize rounded-tl border-2 border-white" style={{ background: color }} />}
                </div>;
              })}
              {sketch && !drag.current?.region && <div className="pointer-events-none absolute border-2 border-dashed border-accent bg-accent/15" style={bounds(sketch)} />}
            </div>
          </div>
        </div>
        <aside className="flex min-h-0 flex-col border-t border-edge/10 md:border-l md:border-t-0">
          <div className="px-4 pb-2 pt-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">{index === 0 ? "修改区域" : "素材区域"}</span>
              <button type="button" aria-label="添加区域" title="添加区域" disabled={!ready || atLimit}
                onClick={() => add({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 })} className="grid h-7 w-7 place-items-center rounded-full bg-well text-lg leading-none disabled:opacity-40">+</button>
            </div>
            <p className="mt-1 text-xs text-secondary">{atLimit ? "已达 24 个区域上限" : index === 0 ? "在图上拖出选框，再写修改要求。" : "框选素材，可用 @编号 在图1的要求里引用。"}</p>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
            {visible.map((r) => <div key={r.label} className={`rounded-xl border p-2 ${r.label === active ? "border-accent/60" : "border-edge/10"}`}>
              <div className="mb-1 flex items-center justify-between">
                <label htmlFor={`region-note-${r.label}`} className="flex items-center gap-2 text-xs font-semibold">
                  <span className="rounded px-1.5 py-0.5 text-white" style={{ background: colors[regions.indexOf(r) % colors.length] }}>@{r.label}</span>
                  图{index + 1}
                </label>
                <button type="button" aria-label={`删除区域 ${r.label}`} title="删除区域" className="h-6 w-6 rounded-full text-sm text-secondary hover:bg-well"
                  onClick={() => { setRegions((list) => list.filter((v) => v.label !== r.label)); if (active === r.label) setActive(null); }}>×</button>
              </div>
              <textarea ref={(el) => { if (el) fields.current.set(r.label, el); else fields.current.delete(r.label); }}
                id={`region-note-${r.label}`} aria-label={`区域 ${r.label} 提示词`} rows={2} maxLength={MAX_REGION_NOTE}
                value={r.note} placeholder={index === 0 ? "这里怎么改？" : "这处素材怎么用？"} onFocus={() => setActive(r.label)}
                onChange={(e) => setRegions((list) => list.map((v) => v.label === r.label ? { ...v, note: e.target.value } : v))}
                className="block w-full resize-y rounded-md bg-well px-2 py-1.5 text-[14px] leading-relaxed text-ink outline-none focus:ring-1 focus:ring-accent" />
            </div>)}
          </div>
          <div className="shrink-0 border-t border-edge/10 px-4 py-2 text-[11px] text-secondary">框选使用深度思考</div>
        </aside>
      </div>
    </div>
  </dialog>;
}
