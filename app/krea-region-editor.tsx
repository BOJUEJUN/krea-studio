"use client";

import { Fragment, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { MAX_KREA_REGIONS, MAX_REGION_NOTE, REGION_COLORS as colors, type KreaRegion, type RegionBox } from "@/lib/krea-regions";
import { BRUSH_LIMITS, brushBounds, rounded, transformBrush, type BrushMask, type BrushPoint, type BrushStroke } from "@/lib/brush-mask";
import { BrushOverlay } from "./brush-overlay";

type Point = { x: number; y: number };
type Drag = { pointer: number; start: Point; region?: KreaRegion; action: "draw" | "move" | "resize" };
type Tool = "box" | "paint" | "erase";
type Trace = { pointer: number; label: string; before?: KreaRegion; stroke: BrushStroke; room: number };
const boxOf = ({ x, y, width, height }: RegionBox) => ({ x, y, width, height });
function tracedRegion(t: Trace): KreaRegion {
  const old = t.before?.mask;
  const base = old ? old.base : t.before && boxOf(t.before);
  const mask: BrushMask = { ...(base ? { base } : {}), strokes: [...(old?.strokes ?? []), { ...t.stroke, points: [...t.stroke.points] }] };
  return { ...brushBounds(mask), image_idx: 0, label: t.label, note: t.before?.note ?? "", mask };
}

function hasInk(mask: BrushMask) {
  const c = document.createElement("canvas"); c.width = c.height = 512;
  const ctx = c.getContext("2d");
  if (!ctx) return true;
  if (mask.base) { const b = mask.base; ctx.fillRect(b.x * 512, b.y * 512, b.width * 512, b.height * 512); }
  for (const s of mask.strokes) {
    ctx.setTransform(s.rx * 512, 0, 0, s.ry * 512, 0, 0);
    ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
    ctx.lineWidth = 2; ctx.lineCap = ctx.lineJoin = "round";
    const [first, ...rest] = s.points;
    ctx.beginPath();
    if (!rest.length) { ctx.arc(first[0] / s.rx, first[1] / s.ry, 1, 0, 2 * Math.PI); ctx.fill(); }
    else { ctx.moveTo(first[0] / s.rx, first[1] / s.ry); for (const [x, y] of rest) ctx.lineTo(x / s.rx, y / s.ry); ctx.stroke(); }
  }
  const bytes = ctx.getImageData(0, 0, 512, 512).data;
  for (let i = 3; i < bytes.length; i += 4) if (bytes[i]) return true;
  return false;
}
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

export function KreaRegionEditor({ images, initial, initialLabel, onSave, onClose }: {
  images: string[]; initial: KreaRegion[]; initialLabel?: string; onSave: (regions: KreaRegion[]) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const fields = useRef(new Map<string, HTMLTextAreaElement>());
  const drag = useRef<Drag | null>(null);
  const initialRegion = initial.find((r) => r.label === initialLabel);
  const [regions, setRegions] = useState(initial);
  const [index, setIndex] = useState(initialRegion?.image_idx ?? 0);
  const [active, setActive] = useState<string | null>(initialRegion?.label ?? null);
  const [sketch, setSketch] = useState<RegionBox | null>(null);
  const [tool, setTool] = useState<Tool>(initialRegion?.mask ? "paint" : "box");
  const [size, setSize] = useState(24);
  const trace = useRef<Trace | null>(null);
  const [ink, setInk] = useState<KreaRegion | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [hint, setHint] = useState("");
  const [undo, setUndo] = useState<{ label: string; before?: KreaRegion }[]>([]);
  const [space, setSpace] = useState({ w: 0, h: 0 });
  const [loaded, setLoaded] = useState({ url: "", w: 0, h: 0 });
  const [failed, setFailed] = useState(false);
  /** Boxes on 图1 still missing their 怎么改 (shown after 完成 is pressed). */
  const [missing, setMissing] = useState<string[]>([]);
  const url = images[index];
  const ready = loaded.url === url && loaded.w > 0 && loaded.h > 0;
  const scale = ready ? Math.min(space.w / loaded.w, space.h / loaded.h) : 0;
  const visible = regions.filter((r) => r.image_idx === index);
  const displayed = ink ? [...visible.filter((r) => r.label !== ink.label), ink] : visible;
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
  function nextLabel() {
    let n = 1;
    while (regions.some((r) => r.label === String(n))) n++;
    return String(n);
  }
  function add(box: RegionBox) {
    if (atLimit) return;
    const label = nextLabel();
    setUndo((list) => list.filter((v) => v.label !== label));
    setRegions((list) => [...list, { ...box, image_idx: index, label, note: "" }]);
    select(label);
  }
  function cancelDrag() { drag.current = null; trace.current = null; setSketch(null); setInk(null); }
  function chooseTool(t: Tool) { cancelDrag(); setHint(""); setCursor(null); setTool(t); }
  function undoStroke() {
    if (trace.current) { cancelDrag(); return; }
    const last = undo.at(-1);
    if (!last) return;
    setUndo((list) => list.slice(0, -1)); setHint("");
    setRegions((list) => {
      const current = list.find((r) => r.label === last.label);
      if (!last.before) return list.filter((r) => r.label !== last.label);
      const restored = { ...last.before, note: current?.note ?? last.before.note };
      return current ? list.map((r) => r === current ? restored : r) : [...list, restored];
    });
    setActive(last.before?.label ?? null);
  }
  function remove(label: string) {
    setUndo((list) => list.filter((v) => v.label !== label));
    setRegions((list) => list.filter((v) => v.label !== label));
    setMissing((m) => m.filter((l) => l !== label));
    if (active === label) setActive(null);
  }
  /** 用户 2026-11-11 (优化局部重绘的操作): a box on 图1 without words does nothing, so point at it instead of closing. */
  function save() {
    const empty = regions.filter((r) => r.image_idx === 0 && !r.note.trim());
    if (empty.length) {
      setMissing(empty.map((r) => r.label));
      if (index !== 0) { cancelDrag(); setIndex(0); }
      select(empty[0].label);
      return;
    }
    onSave(regions.map((r) => ({ ...r, note: r.note.trim() })));
  }
  function position(e: { clientX: number; clientY: number }): Point {
    const rect = surface.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - rect.left) / rect.width), y: clamp((e.clientY - rect.top) / rect.height) };
  }
  function extendTrace(t: Trace, p: Point) {
    let points = t.stroke.points;
    const last = points[points.length - 1];
    if (Math.hypot((last[0] - p.x) * loaded.w * scale, (last[1] - p.y) * loaded.h * scale) < 0.9) return;
    // Compact a long continuous gesture while retaining its beginning and its newest samples.
    if (points.length >= t.room) t.stroke.points = points = points.filter((_, i) => i % 2 === 0);
    points.push([rounded(p.x), rounded(p.y)]);
  }
  function startTrace(e: ReactPointerEvent<HTMLDivElement>, p: Point) {
    let before = visible.find((r) => r.label === active);
    if (tool === "erase" && !before) before = [...visible].reverse().find((r) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height);
    if ((!before && (atLimit || tool === "erase")) || index !== 0) return;
    const strokes = visible.flatMap((r) => r.mask?.strokes ?? []);
    const room = Math.min(BRUSH_LIMITS.perStroke, BRUSH_LIMITS.points - strokes.reduce((n, s) => n + s.points.length, 0));
    if (room < 2 || strokes.length >= BRUSH_LIMITS.strokes) { setHint("笔迹已满，可撤销几笔或删除区域"); return; }
    const label = before?.label ?? nextLabel(), pt: BrushPoint = [rounded(p.x), rounded(p.y)];
    const t: Trace = { pointer: e.pointerId, label, before, room, stroke: { erase: tool === "erase",
      rx: Math.min(1, rounded(size / (2 * loaded.w * scale))), ry: Math.min(1, rounded(size / (2 * loaded.h * scale))), points: [pt] } };
    trace.current = t; setActive(label); setHint(""); setInk(tracedRegion(t));
    e.preventDefault(); surface.current!.setPointerCapture(e.pointerId);
  }
  function start(e: ReactPointerEvent<HTMLDivElement>) {
    if (!ready || !scale || e.button !== 0 || !e.isPrimary) return;
    const handle = (e.target as Element).closest<HTMLElement>("[data-region-handle]");
    const p = position(e);
    if (tool !== "box") { startTrace(e, p); return; }
    // 用户 2026-11-11 (框选中间也能移动): pressing anywhere inside a box grabs it; outside draws a new one.
    const inside = handle ? undefined : [...visible].reverse().find((r) => p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height);
    const region = handle ? visible.find((r) => r.label === handle.dataset.label) : inside;
    const action = handle?.dataset.regionHandle === "resize" ? "resize" : region ? "move" : "draw";
    e.preventDefault();
    surface.current!.setPointerCapture(e.pointerId);
    drag.current = { pointer: e.pointerId, start: p, region, action };
    if (region) setActive(region.label);
  }
  function finish(e: ReactPointerEvent<HTMLDivElement>) {
    const t = trace.current;
    if (t?.pointer === e.pointerId) {
      extendTrace(t, position(e));
      const updated = tracedRegion(t);
      const empty = t.stroke.erase && !hasInk(updated.mask!);
      cancelDrag();
      setUndo((list) => [...list.slice(-29), { label: t.label, before: t.before }]);
      setRegions((list) => empty ? list.filter((r) => r.label !== t.label) : t.before
        ? list.map((r) => r.label === t.label ? updated : r) : [...list, updated]);
      if (empty) { setActive(null); setMissing((m) => m.filter((l) => l !== t.label)); }
      else if (!t.before) select(t.label);
      return;
    }
    const d = drag.current;
    if (d?.pointer !== e.pointerId) return;
    const p = position(e), box = boxAt(d, p);
    cancelDrag();
    if (d.region) {
      const moved = d.region.x !== box.x || d.region.y !== box.y || d.region.width !== box.width || d.region.height !== box.height;
      if (moved) {
        setUndo((list) => list.filter((v) => v.label !== d.region!.label));
        setRegions((list) => list.map((r) => r.label === d.region!.label ? { ...r, ...box, ...(r.mask ? { mask: transformBrush(r.mask, r, box) } : {}) } : r));
      }
      if (d.action === "move" && Math.abs(p.x - d.start.x) + Math.abs(p.y - d.start.y) < 0.005) select(d.region.label);
    } else if (box.width * loaded.w * scale >= 4 && box.height * loaded.h * scale >= 4) add(box);
    else {
      const hit = [...visible].reverse().find((r) => p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height);
      if (hit) select(hit.label);
    }
  }

  return <dialog ref={dialog} aria-labelledby="region-heading"
    className="m-auto w-[min(1000px,96vw)] max-w-none overflow-hidden rounded-2xl border border-edge/10 bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/55 backdrop:backdrop-blur-sm"
    onCancel={(e) => { e.preventDefault(); onClose(); }} onKeyDown={(e) => {
      e.stopPropagation();
      const typing = (e.target as HTMLElement).closest("textarea, input");
      if (!typing && tool !== "box" && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undoStroke(); return; }
      if (!typing && active && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); remove(active); }
    }}
    onPaste={(e) => e.stopPropagation()} onClick={(e) => { if (e.target === dialog.current) onClose(); }}>
    <div className="flex h-[min(680px,90dvh)] flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-edge/10 px-4 py-3">
        <div className="min-w-0">
          <h2 id="region-heading" className="text-[16px] font-semibold">局部重绘</h2>
          <p className="truncate text-[12px] text-secondary">{index === 0 ? "框选或涂出要改的地方，再写修改要求" : "框选要引用的素材"}</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1.5 text-sm text-secondary hover:bg-well">取消</button>
          <button type="button" onClick={save} className="apple-btn-primary rounded-full px-4 py-1.5 text-sm">{regions.length ? "完成" : "关闭"}</button>
        </div>
      </header>
      {images.length > 1 && <nav aria-label="选择标注图片" className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-edge/10 px-4 py-2">
        {images.map((src, i) => <button key={i} type="button" aria-pressed={i === index} aria-label={`标注图${i + 1}`}
          onClick={() => { chooseTool("box"); setFailed(false); setIndex(i); setActive(null); }}
          className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-xs ${i === index ? "border-accent bg-accent/10 text-accent" : "border-transparent text-secondary hover:bg-well"}`}>
          <img src={src} alt="" className="h-6 w-6 rounded object-cover" />图{i + 1}
        </button>)}
      </nav>}
      {index === 0 && <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge/10 px-3 py-1.5">
        <div role="group" aria-label="选区工具" className="flex rounded-lg bg-well p-0.5 text-xs font-medium">
          {([["box", "框选"], ["paint", "画笔"], ["erase", "橡皮"]] as const).map(([key, label]) =>
            <button key={key} type="button" aria-pressed={tool === key} onClick={() => chooseTool(key)}
              className={`rounded-md px-3 py-1.5 ${tool === key ? "bg-panel text-accent shadow-sm" : "text-secondary hover:text-ink"}`}>{label}</button>)}
        </div>
        {tool !== "box" && <>
          <label className="flex items-center gap-1.5 text-xs text-secondary">笔刷大小
            <input type="range" aria-label="笔刷大小" min={4} max={96} value={size} onChange={(e) => setSize(Number(e.target.value))} className="w-16 accent-accent sm:w-24" />
            <span className="w-7 tabular-nums">{size}px</span>
          </label>
          <button type="button" onClick={undoStroke} disabled={!undo.length} className="rounded-md px-2 py-1 text-xs text-secondary hover:bg-well disabled:opacity-40">撤销一笔</button>
        </>}
      </div>}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1.2fr)_minmax(0,1fr)] md:grid-cols-[minmax(0,1fr)_260px] md:grid-rows-1">
        <div className="min-h-0 bg-page p-2 md:p-4">
          <div ref={stage} className="grid h-full w-full place-items-center">
            <div ref={surface} data-region-surface="" aria-label={`图${index + 1}重绘画面`}
              style={scale ? { width: loaded.w * scale, height: loaded.h * scale } : { width: "100%", height: "100%" }}
              className={`relative touch-none select-none overflow-hidden ${tool === "box" ? "cursor-crosshair" : "cursor-none"}`}
              onPointerDown={start} onPointerUp={finish} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
              onPointerLeave={() => setCursor(null)}
              onPointerMove={(e) => {
                const p = position(e);
                if (tool !== "box") {
                  if (e.pointerType !== "touch") setCursor(p);
                  const t = trace.current;
                  if (t?.pointer === e.pointerId) {
                    for (const sample of e.nativeEvent.getCoalescedEvents?.() ?? []) extendTrace(t, position(sample));
                    extendTrace(t, p); setInk(tracedRegion(t));
                  }
                  return;
                }
                const d = drag.current;
                if (d?.pointer === e.pointerId && (d.region || !atLimit)) setSketch(boxAt(d, p));
              }}>
              <img key={url} src={url} draggable={false} alt={`待修改的图${index + 1}`} className="pointer-events-none h-full w-full object-contain"
                onLoad={(e) => setLoaded({ url, w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} onError={() => setFailed(true)} />
              {failed && <span role="alert" className="absolute inset-0 grid place-items-center bg-page text-sm text-secondary">图片加载失败，请重新打开</span>}
              {ready && displayed.map((r) => {
                const pos = regions.findIndex((v) => v.label === r.label);
                const selected = r.label === active, color = colors[(pos < 0 ? regions.length : pos) % colors.length];
                const box = drag.current?.region?.label === r.label && sketch ? sketch : r;
                return <Fragment key={r.label}>
                  {r.mask && <BrushOverlay mask={box === r ? r.mask : transformBrush(r.mask, r, box)} color={color} />}
                  <div data-region-box={r.label} className={`absolute ${tool === "box" ? "cursor-move" : "pointer-events-none"} ${r.mask ? (selected && tool === "box" ? "border border-dashed" : "") : "border-2"}`}
                    style={{ ...bounds(box), borderColor: color, backgroundColor: r.mask ? undefined : color + (selected ? "29" : "14") }}>
                  <button type="button" data-region-handle="move" data-label={r.label} aria-label={`选中区域 ${r.label}`} onClick={(e) => { if (!e.detail) select(r.label); }}
                    style={{ background: color }} className={`absolute left-0 top-0 min-w-5 rounded-br px-1 text-center text-[12px] font-bold leading-5 text-white ${tool === "box" ? "pointer-events-auto cursor-move" : "pointer-events-none"}`}>{r.label}</button>
                  {selected && tool === "box" && <span data-region-handle="resize" data-label={r.label} title="拖动调整大小" className="pointer-events-auto absolute -bottom-1.5 -right-1.5 h-5 w-5 cursor-nwse-resize rounded-full border-2 border-white shadow" style={{ background: color }} />}
                </div></Fragment>;
              })}
              {tool !== "box" && cursor && <span aria-hidden="true" className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white shadow-[0_0_0_1px_#222]"
                style={{ left: cursor.x * 100 + "%", top: cursor.y * 100 + "%", width: size, height: size }} />}
              {sketch && !drag.current?.region && <div className="pointer-events-none absolute border-2 border-dashed border-accent bg-accent/15" style={bounds(sketch)} />}
              {ready && !visible.length && !sketch && !ink && <div className="pointer-events-none absolute inset-0 grid place-items-center">
                <span className="rounded-full bg-black/55 px-4 py-2 text-[13px] text-white backdrop-blur-sm">{tool === "paint" ? "按住涂抹，松开保存笔迹" : tool === "erase" ? "先用框选或画笔添加选区" : "按住拖动，框出要改的地方"}</span>
              </div>}
            </div>
          </div>
        </div>
        <aside className="flex min-h-0 flex-col border-t border-edge/10 md:border-l md:border-t-0">
          <div className="px-4 pb-2 pt-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">{index === 0 ? "修改区域" : "素材区域"}</span>
              <button type="button" aria-label="添加区域" title="添加区域" disabled={!ready || atLimit}
                onClick={() => { if (tool === "box") add({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }); else { chooseTool("paint"); setActive(null); setHint("画下一笔以新建区域"); } }}
                className="grid h-7 w-7 place-items-center rounded-full bg-well text-lg leading-none disabled:opacity-40">+</button>
            </div>
            <p className="mt-1 text-xs text-secondary">{hint || (atLimit ? "最多 24 个区域" : index !== 0 ? "在图1的要求里用 @编号 引用素材。" : tool === "erase" ? "擦除当前区域里不想改的部分。" : tool === "paint" ? active ? `正在涂区域 @${active}，点 + 可另建区域。` : "涂出要修改的部分。" : "拖出一个框，写上这里怎么改。")}</p>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
            {visible.map((r) => <div key={r.label} className={`rounded-xl border p-2 ${missing.includes(r.label) ? "border-danger/60" : r.label === active ? "border-accent/60" : "border-edge/10"}`}>
              <div className="mb-1 flex items-center justify-between">
                <label htmlFor={`region-note-${r.label}`} className="flex items-center gap-2 text-xs font-semibold">
                  <span className="rounded px-1.5 py-0.5 text-white" style={{ background: colors[regions.indexOf(r) % colors.length] }}>@{r.label}</span>
                  图{index + 1}
                </label>
                <button type="button" aria-label={`删除区域 ${r.label}`} title="删除区域" className="h-6 w-6 rounded-full text-sm text-secondary hover:bg-well"
                  onClick={() => remove(r.label)}>×</button>
              </div>
              <textarea ref={(el) => { if (el) fields.current.set(r.label, el); else fields.current.delete(r.label); }}
                id={`region-note-${r.label}`} aria-label={`区域 ${r.label} 提示词`} rows={2} maxLength={MAX_REGION_NOTE}
                value={r.note} placeholder={index === 0 ? "这里怎么改？" : "这处素材怎么用？"} onFocus={() => setActive(r.label)}
                onChange={(e) => { const note = e.target.value; setRegions((list) => list.map((v) => v.label === r.label ? { ...v, note } : v)); if (note.trim()) setMissing((m) => m.filter((l) => l !== r.label)); }}
                className="block w-full resize-y rounded-md bg-well px-2 py-1.5 text-[14px] leading-relaxed text-ink outline-none focus:ring-1 focus:ring-accent" />
              {missing.includes(r.label) && <p role="alert" className="mt-1 text-[12px] text-danger">写一下这里要怎么改</p>}
            </div>)}
          </div>
          {tool === "box" && <div className="shrink-0 border-t border-edge/10 px-4 py-2 text-[11px] text-secondary">框里按住可移动，右下角圆点调大小，Delete 删除</div>}
        </aside>
      </div>
    </div>
  </dialog>;
}
