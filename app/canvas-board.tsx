"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GeneratingView } from "./generating-view";

/**
 * 2026-11-10 (用户: 页面可以切换成自由画布). An infinite board, modelled on what makes Krea / Visual Electric /
 * Flora / Freepik Spaces / Figma boards pleasant:
 * - drag empty space (or hold Space) to pan; pinch or ⌘/Ctrl + wheel zooms at the pointer; "适应" fits everything;
 * - drop pictures from history or from the computer; click / Shift-click / Shift-drag to select; drag to move;
 *   the corner handle resizes with the picture's own shape; ⌘Z / ⌘⇧Z undo and redo; Delete removes; ⌘D copies;
 * - a toolbar floats over the selection (参考图 / 看大图 / 下载 / 置顶 / 删除);
 * - new results appear next to the selected pictures as placeholders that fill in, joined to their sources by a line;
 * - everything is saved in this browser per account.
 */

export type BoardSource = { id: string; url: string; status?: string; prompt?: string };
export type BoardApi = {
  add: (gid: string) => void;
  has: (gid: string) => boolean;
  /** References (data URLs) on the left, the result they made on the right, linked; the references end up selected. */
  importSet: (refs: string[], resultGid: string | null) => void;
};

type Node = {
  id: string;
  gid?: string; // a history item
  src?: string; // a picture dropped from the computer (data URL)
  x: number;
  y: number;
  w: number;
  h: number;
  from?: string[]; // node ids this one was made from
  fit?: boolean; // adopt the picture's real shape once it loads
};
type View = { x: number; y: number; s: number };
type Saved = { nodes: Node[]; view: View };

const MIN_S = 0.1;
const MAX_S = 4;
const GAP = 40;

const uid = () => Math.random().toString(36).slice(2, 10);

function load(key: string): Saved | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (Array.isArray(v?.nodes) && v?.view) return v;
  } catch {}
  return null;
}

/** A dropped file, shrunk so the board still fits in browser storage. */
async function fileToDataUrl(file: File, max = 1024): Promise<{ url: string; w: number; h: number }> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return { url: c.toDataURL("image/jpeg", 0.86), w: c.width, h: c.height };
}

export function CanvasBoard({
  storageKey,
  sources,
  pendingIds,
  loading,
  progress,
  jobAspect,
  dragType,
  thumb,
  onUseAsRef,
  onView,
  onDownload,
  flash,
  apiRef,
  onSelectionChange,
  onSelectionBox,
}: {
  /** Where the selection sits on screen (client px), so the compose box can hug it; null when nothing is selected. */
  onSelectionBox?: (r: { left: number; top: number; right: number; bottom: number } | null) => void;
  apiRef?: React.MutableRefObject<BoardApi | null>;
  /** The selected pictures' urls (in canvas mode they become the reference images). */
  onSelectionChange?: (urls: string[]) => void;
  storageKey: string;
  sources: Map<string, BoardSource>;
  pendingIds: string[];
  loading: boolean;
  progress: number;
  jobAspect: number;
  dragType: string;
  thumb: (url: string, w: number) => string;
  onUseAsRef: (urls: string[]) => void;
  onView: (url: string) => void;
  onDownload: (id: string | null, url: string) => void;
  flash: (text: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodesRaw] = useState<Node[]>([]);
  const [view, setView] = useState<View>({ x: 0, y: 0, s: 1 });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  // 2026-11-10 (用户: 自动对齐吸附，移动时有虚线): alignment guides while dragging.
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] });
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const viewRef = useRef(view);
  viewRef.current = view;
  const undo = useRef<Node[][]>([]);
  const redo = useRef<Node[][]>([]);
  const loaded = useRef(false);

  /** Change the board and remember the previous state for ⌘Z. */
  const commit = useCallback((next: Node[] | ((n: Node[]) => Node[])) => {
    setNodesRaw((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      if (value !== prev) {
        undo.current.push(prev);
        if (undo.current.length > 60) undo.current.shift();
        redo.current = [];
      }
      return value;
    });
  }, []);

  // ---- load / save
  useEffect(() => {
    const saved = load(storageKey);
    if (saved) {
      setNodesRaw(saved.nodes);
      setView(saved.view);
    } else {
      const r = boxRef.current?.getBoundingClientRect();
      setView({ x: (r?.width ?? 800) / 2, y: (r?.height ?? 600) / 2, s: 1 });
    }
    loaded.current = true;
  }, [storageKey]);
  useEffect(() => {
    if (!loaded.current) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify({ nodes, view }));
      } catch {
        flash("画布太大，浏览器存不下了；删掉几张从电脑拖进来的图试试");
      }
    }, 400);
    return () => clearTimeout(t);
  }, [nodes, view, storageKey, flash]);

  // ---- coordinates
  const toWorld = useCallback((cx: number, cy: number) => {
    const r = boxRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (cx - r.left - v.x) / v.s, y: (cy - r.top - v.y) / v.s };
  }, []);
  const zoomAt = useCallback((cx: number, cy: number, s: number) => {
    const r = boxRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    const ns = Math.min(MAX_S, Math.max(MIN_S, s));
    const px = cx - r.left;
    const py = cy - r.top;
    setView({ s: ns, x: px - ((px - v.x) / v.s) * ns, y: py - ((py - v.y) / v.s) * ns });
  }, []);
  const fitAll = useCallback((only?: Node[]) => {
    const list = only ?? nodesRef.current;
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return;
    if (!list.length) {
      setView({ x: r.width / 2, y: r.height / 2, s: 1 });
      return;
    }
    const x0 = Math.min(...list.map((n) => n.x));
    const y0 = Math.min(...list.map((n) => n.y));
    const x1 = Math.max(...list.map((n) => n.x + n.w));
    const y1 = Math.max(...list.map((n) => n.y + n.h));
    const pad = 60;
    const s = Math.min(MAX_S, Math.max(MIN_S, Math.min((r.width - pad * 2) / (x1 - x0), (r.height - pad * 2 - 40) / (y1 - y0))));
    setView({ s, x: r.width / 2 - ((x0 + x1) / 2) * s, y: r.height / 2 - ((y0 + y1) / 2) * s });
  }, []);

  // Wheel: pinch / ⌘ zooms at the pointer, two-finger scroll pans (like Figma).
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!moving.current) {
        moving.current = true;
        onBoxRef.current?.(null);
      }
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => {
        moving.current = false;
        setSettled((n) => n + 1);
      }, 180);
      if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, viewRef.current.s * Math.exp(-e.deltaY * 0.01));
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // History cards call in here: put a picture on the board, or jump to it when it is already there.
  useEffect(() => {
    if (!apiRef) return;
    const api: BoardApi = {
      importSet: () => {},
      has: (gid) => nodesRef.current.some((n) => n.gid === gid),
      add: (gid) => {
        const found = nodesRef.current.find((n) => n.gid === gid);
        const r = boxRef.current?.getBoundingClientRect();
        if (found) {
          setSel(new Set([found.id]));
          if (r) {
            const v = viewRef.current;
            setView({ ...v, x: r.width / 2 - (found.x + found.w / 2) * v.s, y: r.height / 2 - (found.y + found.h / 2) * v.s });
          }
          return;
        }
        const c = r ? toWorld(r.left + r.width / 2, r.top + r.height / 2) : { x: 0, y: 0 };
        // Nudge each new one a little so several clicks do not stack exactly.
        const k = nodesRef.current.length % 6;
        const n: Node = { id: uid(), gid, x: c.x - 160 + k * 24, y: c.y - 160 + k * 24, w: 320, h: 320, fit: true };
        commit((list) => [...list, n]);
        setSel(new Set([n.id]));
      },
    };
    api.importSet = (refs, resultGid) => {
      const list = nodesRef.current;
      const r = boxRef.current?.getBoundingClientRect();
      const c = r ? toWorld(r.left + r.width / 2, r.top + r.height / 2) : { x: 0, y: 0 };
      const added: Node[] = [];
      const refIds: string[] = [];
      const w = 240;
      refs.forEach((src, i) => {
        const old = list.find((n) => n.src === src);
        if (old) return void refIds.push(old.id);
        const n: Node = { id: uid(), src, x: c.x - w - GAP * 2 - 140, y: c.y - 160 + i * (w + GAP), w, h: w, fit: true };
        added.push(n);
        refIds.push(n.id);
      });
      if (resultGid && !list.some((n) => n.gid === resultGid)) {
        added.push({ id: uid(), gid: resultGid, x: c.x - 140, y: c.y - 160, w: 320, h: 320, from: refIds.length ? refIds : undefined, fit: true });
      }
      if (added.length) commit((l) => [...l, ...added]);
      if (refIds.length) setSel(new Set(refIds));
    };
    apiRef.current = api;
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, toWorld, commit]);

  // ---- placeholders for pictures being made: next to the selection, else in the middle of the view
  const anchor = useRef<{ x: number; y: number; from: string[] } | null>(null);
  useEffect(() => {
    if (!loading) {
      anchor.current = null;
      return;
    }
    if (anchor.current) return;
    const picked = nodesRef.current.filter((n) => sel.has(n.id));
    if (picked.length) {
      const x = Math.max(...picked.map((n) => n.x + n.w)) + GAP * 2;
      const y = Math.min(...picked.map((n) => n.y));
      anchor.current = { x, y, from: picked.map((n) => n.id) };
    } else {
      const r = boxRef.current?.getBoundingClientRect();
      const c = r ? toWorld(r.left + r.width / 2, r.top + r.height / 2) : { x: 0, y: 0 };
      anchor.current = { x: c.x - 160, y: c.y - 160 / Math.max(0.2, jobAspect), from: [] };
    }
  }, [loading, sel, toWorld, jobAspect]);
  useEffect(() => {
    const missing = pendingIds.filter((id) => !nodesRef.current.some((n) => n.gid === id));
    if (!missing.length) return;
    const a = anchor.current ?? { x: 0, y: 0, from: [] };
    const w = 320;
    const h = Math.round(w / Math.max(0.2, jobAspect || 1));
    const already = nodesRef.current.filter((n) => pendingIds.includes(n.gid ?? "")).length;
    const added: Node[] = missing.map((gid, i) => {
      const k = already + i;
      return { id: uid(), gid, x: a.x + (k % 2) * (w + GAP), y: a.y + Math.floor(k / 2) * (h + GAP), w, h, from: a.from, fit: true };
    });
    commit((n) => [...n, ...added]);
    setSel(new Set(added.map((n) => n.id)));
  }, [pendingIds, jobAspect, commit]);

  // ---- pointer: pan, marquee, move, resize
  const drag = useRef<
    | { kind: "pan"; sx: number; sy: number; vx: number; vy: number; moved: boolean }
    | { kind: "marquee"; x0: number; y0: number; add: Set<string> }
    | { kind: "move"; sx: number; sy: number; start: Map<string, { x: number; y: number }>; before: Node[]; moved: boolean }
    | { kind: "resize"; id: string; sx: number; w: number; h: number; before: Node[] }
    | null
  >(null);

  const onBgDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (e.shiftKey && !spaceDown && e.button === 0) {
      const w = toWorld(e.clientX, e.clientY);
      drag.current = { kind: "marquee", x0: w.x, y0: w.y, add: new Set(sel) };
      setMarquee({ x0: w.x, y0: w.y, x1: w.x, y1: w.y });
    } else {
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, moved: false };
    }
  };
  const onNodeDown = (e: React.PointerEvent, n: Node) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (spaceDown) return onBgDown(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    let next = sel;
    if (e.shiftKey) {
      next = new Set(sel);
      if (next.has(n.id)) next.delete(n.id);
      else next.add(n.id);
    } else if (!sel.has(n.id)) next = new Set([n.id]);
    setSel(next);
    const start = new Map(nodesRef.current.filter((m) => next.has(m.id)).map((m) => [m.id, { x: m.x, y: m.y }]));
    drag.current = { kind: "move", sx: e.clientX, sy: e.clientY, start, before: nodesRef.current, moved: false };
  };
  const onHandleDown = (e: React.PointerEvent, n: Node) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind: "resize", id: n.id, sx: e.clientX, w: n.w, h: n.h, before: nodesRef.current };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!moving.current) {
      moving.current = true;
      onBoxRef.current?.(null);
    }
    const s = viewRef.current.s;
    if (d.kind === "pan") {
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
      setView((v) => ({ ...v, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy }));
    } else if (d.kind === "marquee") {
      const w = toWorld(e.clientX, e.clientY);
      const box = { x0: d.x0, y0: d.y0, x1: w.x, y1: w.y };
      setMarquee(box);
      const lx = Math.min(box.x0, box.x1), hx = Math.max(box.x0, box.x1), ly = Math.min(box.y0, box.y1), hy = Math.max(box.y0, box.y1);
      const hit = nodesRef.current.filter((n) => n.x < hx && n.x + n.w > lx && n.y < hy && n.y + n.h > ly).map((n) => n.id);
      setSel(new Set([...d.add, ...hit]));
    } else if (d.kind === "move") {
      let dx = (e.clientX - d.sx) / s;
      let dy = (e.clientY - d.sy) / s;
      if (Math.abs(dx) + Math.abs(dy) > 2 / s) d.moved = true;
      // Snap the moving group's edges / centre to the other pictures' edges / centres (Alt turns it off).
      const moving = nodesRef.current.filter((n) => d.start.has(n.id));
      const others = nodesRef.current.filter((n) => !d.start.has(n.id));
      const v: number[] = [];
      const h: number[] = [];
      if (moving.length && others.length && !e.altKey) {
        const bx0 = Math.min(...moving.map((n) => d.start.get(n.id)!.x)) + dx;
        const by0 = Math.min(...moving.map((n) => d.start.get(n.id)!.y)) + dy;
        const bx1 = Math.max(...moving.map((n) => d.start.get(n.id)!.x + n.w)) + dx;
        const by1 = Math.max(...moving.map((n) => d.start.get(n.id)!.y + n.h)) + dy;
        const xs = others.flatMap((n) => [n.x, n.x + n.w / 2, n.x + n.w]);
        const ys = others.flatMap((n) => [n.y, n.y + n.h / 2, n.y + n.h]);
        const tol = 6 / s;
        const best = (mine: number[], targets: number[]) => {
          let off = Infinity;
          for (const m of mine) for (const t of targets) if (Math.abs(t - m) < Math.abs(off) && Math.abs(t - m) <= tol) off = t - m;
          return off;
        };
        const ox = best([bx0, (bx0 + bx1) / 2, bx1], xs);
        const oy = best([by0, (by0 + by1) / 2, by1], ys);
        if (Number.isFinite(ox)) {
          dx += ox;
          for (const m of [bx0 + ox, (bx0 + bx1) / 2 + ox, bx1 + ox]) if (xs.some((t) => Math.abs(t - m) < 0.5)) v.push(m);
        }
        if (Number.isFinite(oy)) {
          dy += oy;
          for (const m of [by0 + oy, (by0 + by1) / 2 + oy, by1 + oy]) if (ys.some((t) => Math.abs(t - m) < 0.5)) h.push(m);
        }
      }
      setGuides({ v, h });
      setNodesRaw((list) => list.map((n) => (d.start.has(n.id) ? { ...n, x: d.start.get(n.id)!.x + dx, y: d.start.get(n.id)!.y + dy } : n)));
    } else if (d.kind === "resize") {
      const w = Math.max(60, d.w + (e.clientX - d.sx) / s);
      setNodesRaw((list) => list.map((n) => (n.id === d.id ? { ...n, w, h: (w * d.h) / d.w, fit: false } : n)));
    }
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (moving.current) {
      moving.current = false;
      setSettled((n) => n + 1);
    }
    if (!d) return;
    if (d.kind === "pan" && !d.moved) setSel(new Set());
    if (d.kind === "marquee") setMarquee(null);
    setGuides({ v: [], h: [] });
    if ((d.kind === "move" && d.moved) || d.kind === "resize") {
      undo.current.push(d.before);
      redo.current = [];
    }
  };

  // ---- keyboard
  const removeSel = useCallback(() => {
    if (!sel.size) return;
    commit((n) => n.filter((m) => !sel.has(m.id)));
    setSel(new Set());
  }, [sel, commit]);
  const duplicateSel = useCallback(() => {
    const copies = nodesRef.current.filter((n) => sel.has(n.id)).map((n) => ({ ...n, id: uid(), x: n.x + 30, y: n.y + 30, from: undefined }));
    if (!copies.length) return;
    commit((n) => [...n, ...copies]);
    setSel(new Set(copies.map((c) => c.id)));
  }, [sel, commit]);
  const toFront = useCallback(() => {
    commit((n) => [...n.filter((m) => !sel.has(m.id)), ...n.filter((m) => sel.has(m.id))]);
  }, [sel, commit]);
  useEffect(() => {
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.code === "Space") {
        setSpaceDown(true);
        e.preventDefault();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (sel.size) {
          e.preventDefault();
          removeSel();
        }
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        const [from, to] = e.shiftKey ? [redo.current, undo.current] : [undo.current, redo.current];
        const prev = from.pop();
        if (prev) {
          to.push(nodesRef.current);
          setNodesRaw(prev);
        }
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSel();
      } else if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSel(new Set(nodesRef.current.map((n) => n.id)));
      } else if (e.key === "Escape") setSel(new Set());
      else if (e.key.startsWith("Arrow") && sel.size) {
        e.preventDefault();
        const step = e.shiftKey ? 20 : 2;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        commit((n) => n.map((m) => (sel.has(m.id) ? { ...m, x: m.x + dx, y: m.y + dy } : m)));
      } else if (e.key === "1" && e.shiftKey) fitAll();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceDown(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [sel, removeSel, duplicateSel, fitAll, commit]);

  // ---- drop from history or the computer
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropHover(false);
    const at = toWorld(e.clientX, e.clientY);
    const gid = e.dataTransfer.getData(dragType);
    if (gid) {
      const src = sources.get(gid);
      if (!src?.url) return;
      const n: Node = { id: uid(), gid, x: at.x - 160, y: at.y - 160, w: 320, h: 320, fit: true };
      commit((list) => [...list, n]);
      setSel(new Set([n.id]));
      return;
    }
    const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith("image/"));
    const added: Node[] = [];
    for (const [i, f] of files.entries()) {
      try {
        const d = await fileToDataUrl(f);
        const w = 320;
        added.push({ id: uid(), src: d.url, x: at.x - 160 + i * (w + GAP), y: at.y - 160, w, h: (w * d.h) / d.w });
      } catch {}
    }
    if (added.length) {
      commit((list) => [...list, ...added]);
      setSel(new Set(added.map((n) => n.id)));
    }
  };

  const urlOf = (n: Node): string | null => n.src ?? (n.gid ? sources.get(n.gid)?.url || null : null);
  const selKey = nodes.filter((n) => sel.has(n.id)).map((n) => urlOf(n) ?? "").filter(Boolean).join("|");
  const onSelRef = useRef(onSelectionChange);
  onSelRef.current = onSelectionChange;
  useEffect(() => {
    onSelRef.current?.(selKey ? selKey.split("|") : []);
  }, [selKey]);
  const selected = nodes.filter((n) => sel.has(n.id));
  const selBox = useMemo(() => {
    if (!selected.length) return null;
    const x0 = Math.min(...selected.map((n) => n.x));
    const y0 = Math.min(...selected.map((n) => n.y));
    const x1 = Math.max(...selected.map((n) => n.x + n.w));
    return { x: view.x + ((x0 + x1) / 2) * view.s, y: view.y + y0 * view.s };
  }, [selected, view]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const onBoxRef = useRef(onSelectionBox);
  onBoxRef.current = onSelectionBox;
  const selRect = selected.length
    ? [
        Math.min(...selected.map((n) => n.x)),
        Math.min(...selected.map((n) => n.y)),
        Math.max(...selected.map((n) => n.x + n.w)),
        Math.max(...selected.map((n) => n.y + n.h)),
      ].join(",")
    : "";
  // Performance (用户: 不要卡): the page is only told where the selection is when nothing is being dragged or panned,
  // so moving pictures and the board never re-renders the whole page on every frame.
  const [settled, setSettled] = useState(0);
  const moving = useRef(false);
  useEffect(() => {
    const cb = onBoxRef.current;
    if (!cb) return;
    if (moving.current) return;
    const r = boxRef.current?.getBoundingClientRect();
    if (!selRect || !r) return cb(null);
    const [x0, y0, x1, y1] = selRect.split(",").map(Number);
    cb({ left: r.left + view.x + x0 * view.s, top: r.top + view.y + y0 * view.s, right: r.left + view.x + x1 * view.s, bottom: r.top + view.y + y1 * view.s });
  }, [selRect, view, settled]);
  const grid = 24 * view.s;

  const btn = "flex h-8 items-center gap-1 rounded-full px-2.5 text-[12px] text-[#1d1d1f] transition hover:bg-black/[0.06]";
  return (
    <div
      ref={boxRef}
      className={`relative h-full w-full touch-none select-none overflow-hidden rounded-[16px] bg-[#f6f6f8] ${drag.current?.kind === "pan" || spaceDown ? "cursor-grab active:cursor-grabbing" : ""}`}
      style={{
        backgroundImage: "radial-gradient(circle, rgba(0,0,0,0.13) 1px, transparent 1.2px)",
        backgroundSize: `${grid}px ${grid}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onPointerDown={onBgDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        if (!dropHover) setDropHover(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node)) setDropHover(false);
      }}
      onDrop={onDrop}
    >
      <div className="absolute left-0 top-0 origin-top-left will-change-transform" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}>
        {/* Lines from each source picture to what was made from it. */}
        <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1">
          {nodes.flatMap((n) =>
            (n.from ?? []).map((fid) => {
              const f = byId.get(fid);
              if (!f) return null;
              const x0 = f.x + f.w, y0 = f.y + f.h / 2, x1 = n.x, y1 = n.y + n.h / 2;
              const c = Math.max(40, (x1 - x0) / 2);
              return (
                <path
                  key={fid + n.id}
                  d={`M${x0},${y0} C${x0 + c},${y0} ${x1 - c},${y1} ${x1},${y1}`}
                  fill="none"
                  stroke="#0071e3"
                  strokeOpacity={0.35}
                  strokeWidth={2 / view.s}
                  strokeDasharray={`${6 / view.s} ${5 / view.s}`}
                />
              );
            })
          )}
        </svg>
        {nodes.map((n) => {
          const url = urlOf(n);
          const status = n.gid ? sources.get(n.gid)?.status : undefined;
          const on = sel.has(n.id);
          return (
            <div
              key={n.id}
              className={`absolute rounded-[10px] bg-white shadow-[0_6px_24px_rgba(0,0,0,0.12)] ${on ? "ring-[3px] ring-[#0071e3]" : "ring-1 ring-black/[0.06]"}`}
              style={{ left: n.x, top: n.y, width: n.w, height: n.h, outlineWidth: 0 }}
              onPointerDown={(e) => onNodeDown(e, n)}
              onDoubleClick={() => url && onView(url)}
            >
              {url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={n.src ? n.src : thumb(url, n.w * view.s > 480 ? 1280 : 640)}
                  alt=""
                  draggable={false}
                  decoding="async"
                  className="h-full w-full rounded-[10px] object-cover"
                  onLoad={(e) => {
                    if (!n.fit) return;
                    const im = e.currentTarget;
                    if (!im.naturalWidth) return;
                    const h = (n.w * im.naturalHeight) / im.naturalWidth;
                    setNodesRaw((list) => list.map((m) => (m.id === n.id ? { ...m, h, fit: false } : m)));
                  }}
                />
              ) : status === "failed" || status === "expired" ? (
                <div className="flex h-full w-full items-center justify-center rounded-[10px] bg-[#fff1f1] text-[13px] text-[#d70015]">没有生成成功</div>
              ) : (
                // The site's own generating animation, sized to the placeholder (用户: 生成动画也要同步).
                <div className="h-full w-full overflow-hidden rounded-[10px]">
                  <GeneratingView aspect={n.w / Math.max(1, n.h)} progress={loading ? progress : 0} compact />
                </div>
              )}
              {on && selected.length === 1 && url && (
                <span
                  className="absolute -bottom-2 -right-2 h-4 w-4 cursor-nwse-resize rounded-full border-2 border-white bg-[#0071e3] shadow"
                  style={{ transform: `scale(${1 / view.s})`, transformOrigin: "center" }}
                  onPointerDown={(e) => onHandleDown(e, n)}
                />
              )}
            </div>
          );
        })}
        {(guides.v.length > 0 || guides.h.length > 0) && (
          <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1">
            {guides.v.map((x, i) => (
              <line key={"v" + i} x1={x} x2={x} y1={-100000} y2={100000} stroke="#ff2e93" strokeWidth={1 / view.s} strokeDasharray={`${5 / view.s} ${4 / view.s}`} />
            ))}
            {guides.h.map((y, i) => (
              <line key={"h" + i} y1={y} y2={y} x1={-100000} x2={100000} stroke="#ff2e93" strokeWidth={1 / view.s} strokeDasharray={`${5 / view.s} ${4 / view.s}`} />
            ))}
          </svg>
        )}
        {marquee && (
          <div
            className="pointer-events-none absolute border border-[#0071e3] bg-[#0071e3]/10"
            style={{
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0),
              borderWidth: 1 / view.s,
            }}
          />
        )}
      </div>

      {/* Toolbar over the selection. */}
      {selBox && selected.some((n) => urlOf(n)) && (
        <div
          className="animate-pop-in absolute z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-white/95 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.16)] ring-1 ring-black/[0.06] backdrop-blur"
          style={{ left: Math.max(200, Math.min(selBox.x, (boxRef.current?.clientWidth ?? 800) - 200)), top: Math.max(44, selBox.y - 48) }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button type="button" className={`${btn} text-[#0071e3]`} onClick={() => onUseAsRef(selected.map(urlOf).filter((u): u is string => !!u))}>
            用作参考图{selected.length > 1 ? `（${selected.length}）` : ""}
          </button>
          {selected.length === 1 && (
            <>
              <button type="button" className={btn} onClick={() => onView(urlOf(selected[0])!)}>看大图</button>
              <button type="button" className={btn} onClick={() => onDownload(selected[0].gid ?? null, urlOf(selected[0])!)}>下载</button>
            </>
          )}
          <button type="button" className={btn} onClick={toFront}>置顶</button>
          <button type="button" className={btn} onClick={duplicateSel}>复制</button>
          <button type="button" className={`${btn} text-[#d70015]`} onClick={removeSel}>移出画布</button>
        </div>
      )}

      {/* Zoom controls. */}
      <div
        className="absolute bottom-3 left-3 z-20 flex items-center gap-0.5 rounded-full bg-white/90 p-0.5 text-[12px] shadow-[0_4px_16px_rgba(0,0,0,0.12)] ring-1 ring-black/[0.06] backdrop-blur"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button type="button" aria-label="缩小" className="h-7 w-7 rounded-full hover:bg-black/[0.06]" onClick={() => { const r = boxRef.current!.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, view.s / 1.25); }}>−</button>
        <button type="button" className="h-7 w-12 rounded-full tabular-nums hover:bg-black/[0.06]" data-tip="回到 100%" onClick={() => { const r = boxRef.current!.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1); }}>{Math.round(view.s * 100)}%</button>
        <button type="button" aria-label="放大" className="h-7 w-7 rounded-full hover:bg-black/[0.06]" onClick={() => { const r = boxRef.current!.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, view.s * 1.25); }}>+</button>
        <button type="button" className="h-7 rounded-full px-2.5 hover:bg-black/[0.06]" data-tip="显示全部（Shift+1）" onClick={() => fitAll()}>适应</button>
      </div>

      {!nodes.length && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-[13px] text-[#86868b]">
          <div className="text-[15px] font-semibold text-[#1d1d1f]">自由画布</div>
          <div>把右边历史里的图拖进来，或从电脑拖图片进来</div>
          <div>选中图片后再生成，新图会出现在它旁边</div>
          <div className="text-[12px]">拖空白处移动画布 · 双指捏合 / ⌘+滚轮 缩放 · Shift+拖动 框选 · ⌘Z 撤销</div>
        </div>
      )}
      {dropHover && (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-[14px] border-2 border-dashed border-[#0071e3] bg-[#0071e3]/[0.04] text-[14px] font-medium text-[#0071e3]">
          松开，放到画布上
        </div>
      )}
    </div>
  );
}
