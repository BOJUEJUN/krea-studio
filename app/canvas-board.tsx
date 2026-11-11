"use client";

import { createPortal } from "react-dom";

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

export type BoardSource = { id: string; url: string; status?: string; prompt?: string; model?: string; cover?: string; mode?: string };
export type BoardApi = {
  add: (gid: string) => void;
  has: (gid: string) => boolean;
  /** References (data URLs) on the left, the result they made on the right, linked; the references end up selected. */
  importSet: (refs: string[], resultGid: string | null) => void;
  /** Zoom around the middle of the board: in / out a step, fit everything, or an exact scale (1 = 100%). */
  zoom: (to: "in" | "out" | "fit" | number) => void;
  /** Pasted pictures: placed under the mouse when it is over the board, else in the middle. */
  paste: (files: File[]) => void;
  /** The compose box edits the selected text node. */
  setText: (text: string) => void;
  /** The board with every picture as a link (for 分享); null while a picture is still uploading. */
  snapshot: (onlySelected?: boolean) => { nodes: any[]; view: View } | null;
  /** 生成新图: an empty 生成框 in the middle of the view, selected. */
  addFrame: () => void;
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
  /** 用户 2026-11-11: a text node; its words drive the pictures it is linked to. */
  kind?: "text" | "gen"; // gen = an empty frame a picture will be made into, fed by its links
  text?: string;
  /** The original picture's pixel size, looked up once. */
  nw?: number;
  nh?: number;
};
type View = { x: number; y: number; s: number };
type Saved = { nodes: Node[]; view: View; updatedAt?: number };

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

/** A dropped file, shrunk to at most 2048 px; PNG / WebP stay PNG so see-through parts survive. */
async function fileToDataUrl(file: File, max = 2048): Promise<{ url: string; w: number; h: number }> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  const keepAlpha = /png|webp|gif/.test(file.type);
  return { url: keepAlpha ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.9), w: c.width, h: c.height };
}

export function CanvasBoard({
  storageKey,
  cloudId,
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
  onGidsChange,
  onRetry,
  onAgain,
  onUpscale,
  onScale,
  onCompose,
  onOpenHistory,
  onCompare,
  prefs,
  onSelectionText,
  summaryFor,
  onShare,
  onDescribe,
}: {
  /** History ids currently on this board (history cards mark them). */
  onGidsChange?: (gids: string[]) => void;
  /** Failed placeholder → make it again; the placeholder is removed and its sources get selected. */
  onRetry?: (gid: string) => void;
  /** 再来一张 / 高清放大 for one picture from history (用户 2026-11-10). */
  onAgain?: (gid: string, text?: string, refs?: string[]) => void;
  onUpscale?: (gid: string) => void;
  /** When set the board hides its own zoom buttons; the page shows the level in its rail instead. */
  onScale?: (s: number) => void;
  /** Right-click menu on empty space: open the compose box / the history list. */
  onCompose?: () => void;
  onOpenHistory?: () => void;
  /** 对比 (用户 2026-11-11): before may be null, then the page uses the picture's saved reference (gid). */
  onCompare?: (before: string | null, after: string, gid: string | null) => void;
  /** 更多设置: snapping, the dot grid and the source lines can be turned off. */
  prefs?: { snap: boolean; grid: boolean; lines: boolean; map?: boolean };
  /** Selected text nodes' words (null when none is selected), so the compose box can edit them. */
  onSelectionText?: (text: string | null) => void;
  onShare?: (onlySelected?: boolean) => void;
  /** 图片连到文本: the page writes a description of the picture (提示词反推). */
  onDescribe?: (url: string) => Promise<string>;
  /** The settings chosen for a picture (model + short list), shown under it when it is not being edited. */
  summaryFor?: (nodeId: string) => { model: string; cover?: string; detail: string } | null;
  /** Where the selection sits on screen (client px), so the compose box can hug it; null when nothing is selected. */
  onSelectionBox?: (r: { left: number; top: number; right: number; bottom: number } | null) => void;
  apiRef?: React.MutableRefObject<BoardApi | null>;
  /** The selected pictures' urls (in canvas mode they become the reference images). */
  onSelectionChange?: (urls: string[], nodeKey?: string, frame?: boolean) => void;
  storageKey: string;
  /** The board's id on the server (用户 2026-11-11: 云端保存); without it the board lives in this browser only. */
  cloudId?: string;
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
  const [panning, setPanning] = useState(false);
  /** Right-click menu: where it opens (board pixels), the world point, and the picture under it. */
  const [ctx, setCtx] = useState<{ x: number; y: number; wx: number; wy: number; node: string | null } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fileAt = useRef<{ x: number; y: number } | null>(null);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const urlOfRef = useRef<(n: Node) => string | null>(() => null);
  const addGenRef = useRef<() => void>(() => {});
  const prefsRef = useRef(prefs ?? { snap: true, grid: true, lines: true });
  prefsRef.current = prefs ?? { snap: true, grid: true, lines: true };
  useEffect(() => {
    if (!ctx) return;
    const down = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-canvas-menu]")) setCtx(null);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setCtx(null);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [ctx]);
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
  // The browser copy shows at once; the server copy wins when it is newer (another computer, a cleared browser).
  const editedAt = useRef(0);
  const remoteReady = useRef(!cloudId);
  const lastPushed = useRef("");
  useEffect(() => {
    const saved = load(storageKey);
    if (saved) {
      setNodesRaw(saved.nodes);
      setView(saved.view);
    } else {
      const r = boxRef.current?.getBoundingClientRect();
      setView({ x: (r?.width ?? 800) / 2, y: (r?.height ?? 600) / 2, s: 1 });
    }
    editedAt.current = saved?.updatedAt ?? 0;
    loaded.current = true;
    if (!cloudId) return;
    remoteReady.current = false;
    let alive = true;
    fetch(`/api/canvas/${encodeURIComponent(cloudId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return;
        const b = d?.board;
        if (b && Array.isArray(b.nodes) && (b.updatedAt ?? 0) > editedAt.current) {
          setNodesRaw(b.nodes);
          if (b.view) setView(b.view);
          editedAt.current = b.updatedAt;
          lastPushed.current = JSON.stringify({ nodes: b.nodes, view: b.view });
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!alive) return;
        remoteReady.current = true;
        firstSave.current = true;
        setSyncTick((n) => n + 1);
      });
    return () => {
      alive = false;
    };
  }, [storageKey, cloudId]);
  const push = useCallback(
    (keepalive = false) => {
      if (!cloudId || !remoteReady.current) return;
      const nodesNow = nodesRef.current.filter((n) => !n.src?.startsWith("data:"));
      const body = JSON.stringify({ nodes: nodesNow, view: viewRef.current });
      if (body === lastPushed.current) return;
      lastPushed.current = body;
      fetch(`/api/canvas/${encodeURIComponent(cloudId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodes: nodesNow, view: viewRef.current, updatedAt: editedAt.current || Date.now() }),
        keepalive,
      }).catch(() => {
        lastPushed.current = "";
      });
    },
    [cloudId]
  );
  const firstSave = useRef(true);
  const [syncTick, setSyncTick] = useState(0);
  useEffect(() => {
    if (!loaded.current) return;
    // The first run is the load itself, not an edit; nothing counts as an edit until the server copy has been
    // checked, or an empty board opening in a fresh browser would look newer than the saved one and replace it.
    if (!remoteReady.current) return;
    if (firstSave.current) {
      firstSave.current = false;
    } else {
      editedAt.current = Date.now();
    }
    const t = setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify({ nodes, view, updatedAt: editedAt.current }));
      } catch {
        // Too big for the browser (pictures not uploaded yet); the server copy still keeps the board.
        if (!cloudId) flash("画布太大，浏览器存不下了；删掉几张从电脑拖进来的图试试");
      }
    }, 400);
    const t2 = setTimeout(() => push(), 1500);
    return () => {
      clearTimeout(t);
      clearTimeout(t2);
    };
  }, [nodes, view, storageKey, flash, push, cloudId, syncTick]);
  useEffect(() => {
    const flush = () => push(true);
    window.addEventListener("pagehide", flush);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
    };
  }, [push]);

  // Pictures from the computer go up to the server; the board then keeps only their link.
  const uploading = useRef(new Set<string>());
  const dataKey = nodes.filter((n) => n.src?.startsWith("data:")).map((n) => n.id).join(",");
  useEffect(() => {
    if (!cloudId || !dataKey) return;
    for (const n of nodesRef.current) {
      if (!n.src?.startsWith("data:") || uploading.current.has(n.id)) continue;
      const id = n.id;
      const src = n.src;
      uploading.current.add(id);
      (async () => {
        try {
          const blob = await (await fetch(src)).blob();
          const fd = new FormData();
          fd.append("image", blob, `canvas.${blob.type.includes("png") ? "png" : "jpg"}`);
          const d = await (await fetch("/api/canvas/upload", { method: "POST", body: fd })).json();
          if (!d?.ok || !d.url) throw new Error(d?.error || "上传失败");
          const swap = (list: Node[]) => list.map((m) => (m.src === src ? { ...m, src: d.url } : m));
          setNodesRaw(swap);
          undo.current = undo.current.map(swap);
          redo.current = redo.current.map(swap);
        } catch {
          // Stays in this browser; tried again next time the board opens.
        } finally {
          uploading.current.delete(id);
        }
      })();
    }
  }, [dataKey, cloudId]);

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
    let lastWheel = 0;
    let wheelIsMouse = false;
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
      // A mouse wheel notch zooms at the pointer (用户: 滚轮是放大); a trackpad two-finger scroll still pans, a pinch zooms.
      // Mouse wheels report whole 120-unit notches and no sideways part; a gesture keeps the kind it started with.
      const now = performance.now();
      if (now - lastWheel > 220) {
        const wd = (e as any).wheelDeltaY as number | undefined;
        wheelIsMouse = e.deltaMode !== 0 || (e.deltaX === 0 && !!wd && Math.abs(wd) % 120 === 0);
      } else if (e.deltaX !== 0) wheelIsMouse = false;
      lastWheel = now;
      if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, viewRef.current.s * Math.exp(-e.deltaY * 0.01));
      else if (wheelIsMouse && !e.shiftKey) zoomAt(e.clientX, e.clientY, viewRef.current.s * Math.exp(-Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY) * (e.deltaMode ? 33 : 1), 200) * 0.0015));
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
      zoom: () => {},
      paste: () => {},
      setText: () => {},
      snapshot: () => null,
      addFrame: () => {},
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
    api.addFrame = () => addGenRef.current();
    api.snapshot = (onlySelected) => {
      const pick = onlySelected ? nodesRef.current.filter((n) => selRef.current.has(n.id)) : nodesRef.current;
      const ids = new Set(pick.map((n) => n.id));
      const list = pick.map((n) => ({ ...n, from: n.from?.filter((f) => ids.has(f)) })).map((n) => (n.kind === "text" ? n : { ...n, src: urlOfRef.current(n) ?? undefined, gid: undefined }));
      if (list.some((n) => n.src?.startsWith("data:"))) return null;
      return { nodes: list.filter((n) => n.kind === "text" || n.src), view: viewRef.current };
    };
    api.paste = (files) => {
      const r = boxRef.current?.getBoundingClientRect();
      if (!r) return;
      const p = lastPointer.current;
      const inside = p && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
      const at = inside ? toWorld(p.x, p.y) : toWorld(r.left + r.width / 2, r.top + r.height / 2);
      addFilesRef.current(files, at);
    };
    api.setText = (text) => {
      const picked = nodesRef.current.filter((n) => selRef.current.has(n.id));
      const ids = new Set(
        picked
          .flatMap((n) => (n.kind === "gen" ? (n.from ?? []).map((id) => nodesRef.current.find((m) => m.id === id)).filter((m): m is Node => !!m) : [n]))
          .filter((n) => n.kind === "text")
          .map((n) => n.id)
      );
      if (ids.size !== 1) return;
      setNodesRaw((list) => list.map((m) => (ids.has(m.id) && m.text !== text ? { ...m, text } : m)));
    };
    api.zoom = (to) => {
      if (to === "fit") return fitAll();
      const r = boxRef.current?.getBoundingClientRect();
      if (!r) return;
      const cur = viewRef.current.s;
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, to === "in" ? cur * 1.25 : to === "out" ? cur / 1.25 : to);
    };
    apiRef.current = api;
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, toWorld, commit, zoomAt, fitAll]);
  // The page shows the zoom level in its tool rail (用户 2026-11-10).
  useEffect(() => {
    onScale?.(view.s);
  }, [view.s, onScale]);

  // ---- placeholders for pictures being made: next to the selection, else in the middle of the view
  const anchor = useRef<{ x: number; y: number; from: string[]; into?: string } | null>(null);
  useEffect(() => {
    if (!loading) {
      anchor.current = null;
      return;
    }
    if (anchor.current) return;
    const picked = nodesRef.current.filter((n) => sel.has(n.id));
    if (picked.length === 1 && picked[0].kind === "gen" && !picked[0].gid) {
      anchor.current = { x: picked[0].x, y: picked[0].y, from: picked[0].from ?? [], into: picked[0].id };
    } else if (picked.length) {
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
    const into = a.into && !already ? a.into : null;
    const added: Node[] = missing.slice(into ? 1 : 0).map((gid, i) => {
      const k = already + i + (into ? 1 : 0);
      return { id: uid(), gid, x: a.x + (k % 2) * (w + GAP), y: a.y + Math.floor(k / 2) * (h + GAP), w, h, from: a.from, fit: true };
    });
    // The first picture goes into the empty frame it was made for; it keeps the frame's links.
    commit((n) => [...n.map((m) => (into && m.id === into ? { ...m, kind: undefined, gid: missing[0], fit: true } : m)), ...added]);
    setSel(new Set([...(into ? [into] : []), ...added.map((n) => n.id)]));
  }, [pendingIds, jobAspect, commit]);

  // ---- pointer: pan, marquee, move, resize
  const drag = useRef<
    | { kind: "pan"; sx: number; sy: number; vx: number; vy: number; moved: boolean }
    | { kind: "marquee"; x0: number; y0: number; add: Set<string> }
    | { kind: "move"; sx: number; sy: number; start: Map<string, { x: number; y: number }>; before: Node[]; moved: boolean }
    | { kind: "resize"; id: string; sx: number; w: number; h: number; before: Node[] }
    | { kind: "link"; src: string }
    | null
  >(null);

  // 用户 2026-11-10: left drag on empty space = box select, wheel-button (middle) drag = pan, wheel = zoom,
  // right click = menu. Space + left drag still pans (Figma habit).
  const onBgDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    setCtx(null);
    setLinkMenu(null);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (e.button === 0 && !spaceDown) {
      const w = toWorld(e.clientX, e.clientY);
      drag.current = { kind: "marquee", x0: w.x, y0: w.y, add: e.shiftKey ? new Set(sel) : new Set() };
      setMarquee({ x0: w.x, y0: w.y, x1: w.x, y1: w.y });
      if (!e.shiftKey) setSel(new Set());
    } else {
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, moved: false };
      setPanning(true);
    }
  };
  const onNodeDown = (e: React.PointerEvent, n: Node) => {
    if (e.button !== 0) return;
    setCtx(null);
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
    // 用户 2026-11-11 (置顶没必要): the picture you touch comes to the top by itself.
    setNodesRaw((list) => {
      const top = list.filter((m) => next.has(m.id));
      const rest = list.filter((m) => !next.has(m.id));
      const same = top.every((m, i) => list[list.length - top.length + i]?.id === m.id);
      return same ? list : [...rest, ...top];
    });
    const start = new Map(nodesRef.current.filter((m) => next.has(m.id)).map((m) => [m.id, { x: m.x, y: m.y }]));
    drag.current = { kind: "move", sx: e.clientX, sy: e.clientY, start, before: nodesRef.current, moved: false };
  };
  const onHandleDown = (e: React.PointerEvent, n: Node) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind: "resize", id: n.id, sx: e.clientX, w: n.w, h: n.h, before: nodesRef.current };
  };
  const onMove = (e: React.PointerEvent) => {
    lastPointer.current = { x: e.clientX, y: e.clientY };
    const d = drag.current;
    if (!d) return;
    moving.current = true;
    const s = viewRef.current.s;
    if (d.kind === "link") {
      setLinkTo(toWorld(e.clientX, e.clientY));
      const hit = (document.elementFromPoint(e.clientX, e.clientY) as Element | null)?.closest?.("[data-node-id]")?.getAttribute("data-node-id") ?? null;
      setLinkHover(hit && hit !== d.src ? hit : null);
      return;
    }
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
      if (moving.length && others.length && !e.altKey && prefsRef.current.snap) {
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
    if (d.kind === "link") {
      const end = linkToRef.current;
      setLinkTo(null);
      setLinkHover(null);
      const p = lastPointer.current;
      const hit = p ? (document.elementFromPoint(p.x, p.y) as Element | null)?.closest?.("[data-node-id]")?.getAttribute("data-node-id") : null;
      if (hit && hit !== d.src) link(d.src, hit);
      else if (!hit && end && p) {
        const r = boxRef.current!.getBoundingClientRect();
        setLinkMenu({ x: p.x - r.left, y: p.y - r.top, wx: end.x, wy: end.y, src: d.src });
      }
      return;
    }
    if (d.kind === "pan") setPanning(false);
    if (d.kind === "pan" && !d.moved && !spaceDown) setSel(new Set());
    if (d.kind === "marquee") setMarquee(null);
    setGuides({ v: [], h: [] });
    if ((d.kind === "move" && d.moved) || d.kind === "resize") {
      undo.current.push(d.before);
      redo.current = [];
    }
  };

  // ---- keyboard
  /** Two pictures: left one is "before". One picture: the picture it was made from, else its saved reference. */
  /** Words of the text nodes a picture was made from: 再来一张 uses their current text (一个文本控制多个生图). */
  const linkedText = (n: Node): string | undefined => {
    const t = (n.from ?? []).map((id) => nodesRef.current.find((m) => m.id === id)).filter((m) => m?.kind === "text").map((m) => m!.text ?? "").filter(Boolean);
    return t.length ? t.join("\n\n") : undefined;
  };
  const linkedRefs = (n: Node): string[] | undefined => {
    const u = (n.from ?? []).map((id) => nodesRef.current.find((m) => m.id === id)).filter((m) => m && m.kind !== "text").map((m) => urlOf(m!)).filter((x): x is string => !!x);
    return u.length ? u : undefined;
  };
  const compareSel = () => {
    if (!onCompare) return;
    const list = nodesRef.current.filter((n) => sel.has(n.id));
    if (list.length === 2) {
      const [a, b] = [...list].sort((p, q) => p.x - q.x);
      const ua = urlOf(a), ub = urlOf(b);
      if (ua && ub) onCompare(ua, ub, null);
      return;
    }
    const n = list[0];
    const u = n && urlOf(n);
    if (!u) return;
    const src = n.from?.map((id) => nodesRef.current.find((m) => m.id === id)).find((m) => m && urlOf(m));
    onCompare(src ? urlOf(src)! : null, u, n.gid ?? null);
  };
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
    const frameId = (document.elementFromPoint(e.clientX, e.clientY) as Element | null)?.closest?.("[data-node-id]")?.getAttribute("data-node-id");
    const frame = frameId ? nodesRef.current.find((m) => m.id === frameId && m.kind === "gen" && !m.gid) : undefined;
    if (frame) {
      const made = await addFiles(Array.from(e.dataTransfer.files ?? []), { x: frame.x - 400 + 160, y: frame.y + 160 }, true);
      if (made.length) {
        commit((l) => l.map((m) => (m.id === frame.id ? { ...m, from: [...(m.from ?? []), ...made] } : m)));
        setSel(new Set([frame.id]));
      }
      return;
    }
    await addFiles(Array.from(e.dataTransfer.files ?? []), at);
  };
  const addFiles = async (all: File[], at: { x: number; y: number }, stack = false): Promise<string[]> => {
    const files = all.filter((f) => f.type.startsWith("image/"));
    const added: Node[] = [];
    let y = at.y - 160;
    for (const [i, f] of files.entries()) {
      try {
        const d = await fileToDataUrl(f);
        const w = 320;
        const h = (w * d.h) / d.w;
        added.push({ id: uid(), src: d.url, x: stack ? at.x - 160 : at.x - 160 + i * (w + GAP), y: stack ? y : at.y - 160, w, h });
        y += h + GAP;
      } catch {}
    }
    if (added.length) {
      commit((list) => [...list, ...added]);
      setSel(new Set(added.map((n) => n.id)));
    }
    return added.map((n) => n.id);
  };

  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  const gidKey = nodes.map((n) => n.gid ?? "").filter(Boolean).sort().join(",");
  const onGidsRef = useRef(onGidsChange);
  onGidsRef.current = onGidsChange;
  useEffect(() => {
    onGidsRef.current?.(gidKey ? gidKey.split(",") : []);
  }, [gidKey]);
  const retry = (n: Node) => {
    if (!n.gid) return;
    const from = n.from ?? [];
    commit((list) => list.filter((m) => m.id !== n.id));
    setSel(new Set(from));
    onRetry?.(n.gid);
  };

  const urlOf = (n: Node): string | null => (n.kind === "text" ? null : n.src ?? (n.gid ? sources.get(n.gid)?.url || null : null));
  urlOfRef.current = urlOf;
  // A selected empty frame stands for what is linked into it: its pictures are the references, its text the description.
  const expandSel = (n: Node): Node[] => (n.kind === "gen" && !n.gid ? (n.from ?? []).map((id) => nodes.find((m) => m.id === id)).filter((m): m is Node => !!m) : [n]);
  const selFlat = nodes.filter((n) => sel.has(n.id)).flatMap(expandSel);
  const selKey = selFlat.map((n) => urlOf(n) ?? "").filter(Boolean).join("|");
  const onSelRef = useRef(onSelectionChange);
  onSelRef.current = onSelectionChange;
  // Which nodes are picked (the page keeps each node's own settings by this).
  const selIdKey = [...sel].sort().join("|");
  const selIdRef = useRef(selIdKey);
  selIdRef.current = selIdKey;
  const selHasFrameRef = useRef(false);
  selHasFrameRef.current = nodes.some((n) => sel.has(n.id) && n.kind === "gen" && !n.gid);
  useEffect(() => {
    onSelRef.current?.(selKey ? selKey.split("|") : [], selIdRef.current, selHasFrameRef.current);
  }, [selKey, selIdKey]);
  const selected = nodes.filter((n) => sel.has(n.id));
  const selRef = useRef(sel);
  selRef.current = sel;
  const selTexts = selFlat.filter((n) => n.kind === "text");
  // 用户 2026-11-11: a text node on its own is just text (no compose box); with a picture or a 生成框 it is the description.
  const withPicture = selected.some((n) => n.kind !== "text");
  const selTextKey = selTexts.length && withPicture ? selTexts.map((n) => n.text ?? "").join("\n\n") : null;
  const onSelTextRef = useRef(onSelectionText);
  onSelTextRef.current = onSelectionText;
  useEffect(() => {
    onSelTextRef.current?.(selTextKey);
  }, [selTextKey]);
  const [editing, setEditing] = useState<string | null>(null);
  const addText = (at: { x: number; y: number }) => {
    const n: Node = { id: uid(), kind: "text", text: "", x: at.x, y: at.y, w: 320, h: 180 };
    commit((list) => [...list, n]);
    setSel(new Set([n.id]));
    setEditing(n.id);
  };
  // ---- links (用户 2026-11-11: 选择图片点哪里连到哪里，什么节点连什么节点会变成什么样)
  const [linkTo, setLinkTo] = useState<{ x: number; y: number } | null>(null); // the loose end while dragging
  const [linkMenu, setLinkMenu] = useState<{ x: number; y: number; wx: number; wy: number; src: string } | null>(null);
  const [linkHover, setLinkHover] = useState<string | null>(null);
  const linkToRef = useRef(linkTo);
  linkToRef.current = linkTo;
  const isAncestor = (maybe: string, of: string, list: Node[]): boolean => {
    const seen = new Set<string>();
    const walk = (id: string): boolean => {
      if (id === maybe) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return (list.find((n) => n.id === id)?.from ?? []).some(walk);
    };
    return walk(of);
  };
  const describeInto = async (srcId: string, textId: string) => {
    const src = nodesRef.current.find((n) => n.id === srcId);
    const u = src && urlOf(src);
    if (!u || !onDescribe) return;
    setNodesRaw((list) => list.map((m) => (m.id === textId ? { ...m, text: (m.text ? m.text + "\n\n" : "") + "（正在看图写描述…）" } : m)));
    try {
      const words = await onDescribe(u);
      setNodesRaw((list) => list.map((m) => (m.id === textId ? { ...m, text: (m.text ?? "").replace("（正在看图写描述…）", words) } : m)));
    } catch (e: any) {
      setNodesRaw((list) => list.map((m) => (m.id === textId ? { ...m, text: (m.text ?? "").replace("（正在看图写描述…）", "") } : m)));
      flash(e?.message || "看图写描述失败");
    }
  };
  /** Link src → tgt. Pictures feed as references, text as the description; a picture into text writes its description. */
  const link = (srcId: string, tgtId: string) => {
    const list = nodesRef.current;
    const src = list.find((n) => n.id === srcId), tgt = list.find((n) => n.id === tgtId);
    if (!src || !tgt || srcId === tgtId) return;
    if (tgt.from?.includes(srcId)) return flash("已经连着了");
    if (isAncestor(tgtId, srcId, list)) return flash("不能连成一圈");
    if (src.kind === "text" && tgt.kind === "text") return flash("文本不能连文本");
    if (src.kind !== "text" && !urlOf(src)) return flash("这张还没有图");
    commit((l) => l.map((m) => (m.id === tgtId ? { ...m, from: [...(m.from ?? []), srcId] } : m)));
    if (tgt.kind === "text") describeInto(srcId, tgtId);
    else if (tgt.kind !== "gen") flash(src.kind === "text" ? "已连上：再来一张会用这段文字" : "已连上：再来一张会带上这张参考图");
  };
  const unlink = (srcId: string, tgtId: string) => {
    commit((l) => l.map((m) => (m.id === tgtId ? { ...m, from: (m.from ?? []).filter((f) => f !== srcId) } : m)));
  };
  const addGen = (at: { x: number; y: number }, from: string[]) => {
    const n: Node = { id: uid(), kind: "gen", x: at.x, y: at.y, w: 320, h: 320, from: from.length ? from : undefined };
    commit((l) => [...l, n]);
    setSel(new Set([n.id]));
    return n;
  };
  addGenRef.current = () => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return;
    const c = toWorld(r.left + r.width / 2, r.top + r.height * 0.4);
    // Step aside if something already sits there.
    let x = c.x - 160, y = c.y - 160;
    while (nodesRef.current.some((m) => m.x < x + 320 && m.x + m.w > x && m.y < y + 320 && m.y + m.h > y)) x += 360;
    addGen({ x, y }, []);
  };
  const startLink = (e: React.PointerEvent, n: Node) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    setCtx(null);
    setLinkMenu(null);
    boxRef.current?.setPointerCapture(e.pointerId);
    drag.current = { kind: "link", src: n.id };
    const w = toWorld(e.clientX, e.clientY);
    setLinkTo(w);
  };

  // Look up each picture's real size once (shown above it).
  const sizing = useRef(new Set<string>());
  useEffect(() => {
    for (const n of nodes) {
      if (n.kind === "text" || n.nw || sizing.current.has(n.id)) continue;
      const u = urlOf(n);
      if (!u || u.startsWith("data:") || !u.startsWith("/api/")) continue;
      sizing.current.add(n.id);
      fetch(`/api/imginfo?u=${encodeURIComponent(u.split("?")[0])}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.w) setNodesRaw((list) => list.map((m) => (m.id === n.id ? { ...m, nw: d.w, nh: d.h } : m)));
        })
        .catch(() => {});
    }
  });
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
    const r = boxRef.current?.getBoundingClientRect();
    if (!selRect || !r) return cb(null);
    const [x0, y0, x1, y1] = selRect.split(",").map(Number);
    cb({ left: r.left + view.x + x0 * view.s, top: r.top + view.y + y0 * view.s, right: r.left + view.x + x1 * view.s, bottom: r.top + view.y + y1 * view.s });
  }, [selRect, view, settled]);
  const grid = 24 * view.s;

  const btn = "flex h-8 items-center gap-1 rounded-full px-2.5 text-[12px] text-[#1d1d1f] transition hover:bg-black/[0.06]";
  const ibtn = "flex h-8 min-w-8 items-center justify-center rounded-full px-1.5 text-[#1d1d1f] transition hover:bg-black/[0.06] active:scale-[0.94]";
  const ico = "h-[18px] w-[18px] fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.6]";
  return (
    <div
      ref={boxRef}
      className={`relative h-full w-full touch-none select-none overflow-hidden bg-[#f6f6f8] ${panning ? "cursor-grabbing" : spaceDown ? "cursor-grab" : ""}`}
      style={{
        backgroundImage: prefs?.grid === false ? "none" : "radial-gradient(circle, rgba(0,0,0,0.13) 1px, transparent 1.2px)",
        backgroundSize: `${grid}px ${grid}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onPointerDown={onBgDown}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const w = toWorld(e.clientX, e.clientY);
        const hitEl = (e.target as Element).closest?.("[data-node-id]");
        const node = hitEl?.getAttribute("data-node-id") ?? null;
        if (node && !sel.has(node)) setSel(new Set([node]));
        setCtx({ x: e.clientX, y: e.clientY, wx: w.x, wy: w.y, node });
      }}
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
          {prefs?.lines !== false && nodes.flatMap((n) =>
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
          {linkTo && drag.current?.kind === "link" && (() => {
            const f = byId.get((drag.current as { src: string }).src);
            if (!f) return null;
            const x0 = f.x + f.w, y0 = f.y + f.h / 2, x1 = linkTo.x, y1 = linkTo.y;
            const c = Math.max(40, Math.abs(x1 - x0) / 2);
            return <path d={`M${x0},${y0} C${x0 + c},${y0} ${x1 - c},${y1} ${x1},${y1}`} fill="none" stroke="#0071e3" strokeWidth={2 / view.s} />;
          })()}
        </svg>
        {prefs?.lines !== false && nodes.flatMap((n) => {
          let pic = 0;
          return (n.from ?? []).map((fid) => {
            const f = byId.get(fid);
            if (!f) return null;
            const label = n.kind === "text" ? "看图写描述" : f.kind === "text" ? "文本" : `图片${++pic}`;
            const x = (f.x + f.w + n.x) / 2, y = (f.y + f.h / 2 + n.y + n.h / 2) / 2;
            return (
              <button
                type="button"
                key={"l" + fid + n.id}
                data-tip="点一下断开这根线"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => unlink(fid, n.id)}
                className="group absolute flex items-center gap-0.5 whitespace-nowrap rounded-full bg-white px-1.5 py-px text-[10px] font-medium text-[#6e6e73] shadow-[0_1px_6px_rgba(0,0,0,0.1)] ring-1 ring-black/[0.06] hover:text-[#d70015] hover:ring-[#d70015]/30"
                style={{ left: x, top: y, transform: `translate(-50%, -50%) scale(${1 / view.s})` }}
              >
                {label}
                <span className="hidden group-hover:inline">×</span>
              </button>
            );
          });
        })}
        {nodes.map((n) => {
          const url = urlOf(n);
          const src = n.gid ? sources.get(n.gid) : undefined;
          const status = src?.status;
          const on = sel.has(n.id);
          const k = 1 / view.s; // header and labels keep their screen size at any zoom
          const isText = n.kind === "text";
          const isGen = n.kind === "gen" && !n.gid;
          const canLinkOut = isText || !!url;
          return (
            <div
              key={n.id}
              data-node-id={n.id}
              className={`group/node absolute rounded-[10px] ${isGen ? "border-2 border-dashed border-[#0071e3]/40 bg-[#0071e3]/[0.03]" : "bg-white shadow-[0_6px_24px_rgba(0,0,0,0.12)]"} ${on ? "ring-[3px] ring-[#0071e3]" : linkHover === n.id ? "ring-[3px] ring-[#34c759]" : isGen ? "" : "ring-1 ring-black/[0.06]"}`}
              style={{ left: n.x, top: n.y, width: n.w, height: n.h, outlineWidth: 0 }}
              onPointerDown={(e) => onNodeDown(e, n)}
              onDoubleClick={() => (isText ? setEditing(n.id) : url && onView(url))}
            >
              {/* 用户 2026-11-11: what the node is and its size, above it. */}
              <div
                className="pointer-events-none absolute left-0 flex items-center justify-between whitespace-nowrap text-[#86868b]"
                style={{ bottom: "100%", width: n.w * view.s, transform: `scale(${k})`, transformOrigin: "bottom left", paddingBottom: 5, fontSize: 12 }}
              >
                <span className="flex items-center gap-1 font-medium text-[#6e6e73]">
                  {isText ? (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 4h10M3 8h10M3 12h6" /></svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M2.5 11l3.5-3.5 2.5 2.5 2-2 3 3" /></svg>
                  )}
                  {isText ? "文本" : isGen ? "生成框" : n.gid ? "图片生成" : "图片资源"}
                </span>
                {!isText && n.nw ? <span className="tabular-nums">{n.nw}×{n.nh}</span> : null}
              </div>
              {isText ? (
                editing === n.id ? (
                  <textarea
                    autoFocus
                    value={n.text ?? ""}
                    placeholder="写下描述，连到图片上生成…"
                    onPointerDown={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const v = e.target.value.slice(0, 2000);
                      setNodesRaw((list) => list.map((m) => (m.id === n.id ? { ...m, text: v } : m)));
                    }}
                    onBlur={() => setEditing(null)}
                    onKeyDown={(e) => e.key === "Escape" && (e.currentTarget as HTMLTextAreaElement).blur()}
                    className="h-full w-full resize-none rounded-[10px] bg-transparent p-3 text-[13px] leading-[20px] text-[#1d1d1f] outline-none"
                  />
                ) : (
                  <div className="flex h-full w-full flex-col overflow-hidden rounded-[10px] p-3">
                    <div className={`min-h-0 flex-1 overflow-hidden whitespace-pre-wrap break-words text-[13px] leading-[20px] ${n.text ? "text-[#1d1d1f]" : "text-[#aeaeb2]"}`}>
                      {n.text || "双击输入文字。选中它再选图片，就用这段文字生成"}
                    </div>
                    <div className="pt-1 text-[11px] text-[#aeaeb2]">{(n.text ?? "").length} 字</div>
                  </div>
                )
              ) : isGen ? (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-6 text-center text-[12px] leading-[18px] text-[#86868b]">
                  <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" className="text-[#0071e3]/70"><path d="M8 1.5l1.6 4.9L14.5 8l-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" /></svg>
                  {(n.from?.length ?? 0) ? "选中它，在输入框点生成，图就出在这里" : "把图片或文本的 + 拖到这里连上，再选中它生成"}
                </div>
              ) : url ? (
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
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-[10px] bg-[#fff1f1] text-[13px] text-[#d70015]">
                  没有生成成功
                  {onRetry && (
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => retry(n)}
                      className="rounded-full bg-[#d70015] px-3 py-1 text-[12px] font-medium text-white hover:bg-[#b80012]"
                    >
                      重试
                    </button>
                  )}
                </div>
              ) : (
                // The site's own generating animation, sized to the placeholder (用户: 生成动画也要同步).
                <div className="h-full w-full overflow-hidden rounded-[10px]">
                  <GeneratingView aspect={n.w / Math.max(1, n.h)} progress={loading ? progress : 0} compact />
                </div>
              )}
              {!isText && url && !on && (() => {
                // Only the settings someone chose for this picture (用户 2026-11-11: 生成记录那条不用显示).
                const sm = summaryFor?.(n.id) ?? null;
                if (!sm?.model) return null;
                return (
                <div
                  className="pointer-events-none absolute left-0 top-full flex items-center gap-1.5 whitespace-nowrap rounded-full bg-white/90 px-2 py-1 text-[11px] text-[#6e6e73] shadow-[0_2px_10px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.05]"
                  style={{ transform: `translate(0, 6px) scale(${k})`, transformOrigin: "top left", maxWidth: n.w * view.s }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {sm.cover && <img src={sm.cover} alt="" className="h-4 w-4 shrink-0 rounded object-cover" />}
                  <span className="shrink-0 font-medium text-[#1d1d1f]">{sm.model}</span>
                  {sm.detail && <span className="truncate text-[#aeaeb2]">· {sm.detail}</span>}
                </div>
                );
              })()}
              {canLinkOut && (
                <span
                  role="button"
                  aria-label="拖出连线"
                  data-tip="拖到别的节点上连线，拖到空白处新建"
                  className={`absolute left-full top-1/2 flex h-6 w-6 cursor-crosshair items-center justify-center rounded-full bg-white text-[15px] leading-none text-[#0071e3] shadow-[0_2px_8px_rgba(0,0,0,0.15)] ring-1 ring-[#0071e3]/30 transition-opacity hover:bg-[#0071e3] hover:text-white ${on ? "opacity-100" : "opacity-0 group-hover/node:opacity-100"}`}
                  style={{ transform: `translate(${10 * k}px, -50%) scale(${k})`, transformOrigin: "left center" }}
                  onPointerDown={(e) => startLink(e, n)}
                >
                  +
                </span>
              )}
              {on && selected.length === 1 && (url || isText) && (
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
              <line key={"v" + i} x1={x} x2={x} y1={-100000} y2={100000} stroke="#0071e3" strokeOpacity={0.28} strokeWidth={1 / view.s} strokeDasharray={`${3 / view.s} ${4 / view.s}`} />
            ))}
            {guides.h.map((y, i) => (
              <line key={"h" + i} y1={y} y2={y} x1={-100000} x2={100000} stroke="#0071e3" strokeOpacity={0.28} strokeWidth={1 / view.s} strokeDasharray={`${3 / view.s} ${4 / view.s}`} />
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
          style={{ left: Math.max(150, Math.min(selBox.x, (boxRef.current?.clientWidth ?? 800) - 150)), top: Math.max(44, selBox.y - 48) }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* 用户 2026-11-10: icons only, the name shows on hover. A selected picture already is the reference, so no 用作参考图. */}
          {onCompare && (selected.length === 2 || (selected.length === 1 && (selected[0].from?.length || selected[0].gid))) && (
            <button type="button" aria-label="对比" data-tip={selected.length === 2 ? "对比这两张" : "和原图对比"} className={ibtn} onClick={compareSel}>
              <svg viewBox="0 0 20 20" className={ico}><rect x="3" y="4" width="14" height="12" rx="2.5" /><path d="M10 2.5v15" /><path d="M5.5 10h2M12.5 10h2" /></svg>
            </button>
          )}
          {selected.length === 1 && selected[0].gid && onAgain && (
            <button type="button" aria-label="再来一张" data-tip="再来一张（同样设置）" className={ibtn} onClick={() => onAgain(selected[0].gid!, linkedText(selected[0]), linkedRefs(selected[0]))}>
              <svg viewBox="0 0 20 20" className={ico}><path d="M15.5 8A6 6 0 1 0 16 11" /><path d="M16 4v4h-4" /></svg>
            </button>
          )}
          {selected.length === 1 && selected[0].gid && onUpscale && (
            <button type="button" aria-label="高清放大" data-tip="高清放大 2 倍（约 ¥0.7）" className={ibtn} onClick={() => onUpscale(selected[0].gid!)}>
              <svg viewBox="0 0 20 20" className={ico}><path d="M11.5 3.5h5v5" /><path d="M16.5 3.5L11 9" /><path d="M8.5 16.5h-5v-5" /><path d="M3.5 16.5L9 11" /></svg>
            </button>
          )}
          {selected.length === 1 && (
            <>
              <button type="button" aria-label="看大图" data-tip="看大图" className={ibtn} onClick={() => onView(urlOf(selected[0])!)}>
                <svg viewBox="0 0 20 20" className={ico}><circle cx="8.8" cy="8.8" r="5.3" /><path d="M12.8 12.8L17 17" /><path d="M8.8 6.6v4.4M6.6 8.8h4.4" /></svg>
              </button>
              <button type="button" aria-label="下载" data-tip="下载" className={ibtn} onClick={() => onDownload(selected[0].gid ?? null, urlOf(selected[0])!)}>
                <svg viewBox="0 0 20 20" className={ico}><path d="M10 3.5v9" /><path d="M6 8.8l4 4 4-4" /><path d="M4 16.5h12" /></svg>
              </button>
            </>
          )}
          {selected.length === 1 && <span className="mx-0.5 h-4 w-px bg-black/10" />}
          <button type="button" aria-label="复制" data-tip="复制一份" className={ibtn} onClick={duplicateSel}>
            <svg viewBox="0 0 20 20" className={ico}><rect x="7" y="7" width="9.5" height="9.5" rx="2" /><rect x="3.5" y="3.5" width="9.5" height="9.5" rx="2" /></svg>
          </button>
          <button type="button" aria-label="移出画布" data-tip="移出画布" className={`${ibtn} text-[#d70015] hover:bg-[#d70015]/[0.08]`} onClick={removeSel}>
            <svg viewBox="0 0 20 20" className={ico}><path d="M4 6h12" /><path d="M8 6V4.5h4V6" /><path d="M5.5 6l.8 10h7.4l.8-10" /></svg>
          </button>
        </div>
      )}

      {/* Dropped a link on empty space: what to make there. */}
      {linkMenu && (() => {
        const srcNode = nodesRef.current.find((m) => m.id === linkMenu.src);
        const item = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-[#1d1d1f] hover:bg-black/[0.05]";
        const close = () => setLinkMenu(null);
        return (
          <div
            className="animate-pop-in absolute z-30 w-52 rounded-xl bg-white/95 p-1 shadow-[0_14px_40px_rgba(0,0,0,0.18)] ring-1 ring-black/[0.06] backdrop-blur"
            style={{ left: Math.min(linkMenu.x, (boxRef.current?.clientWidth ?? 800) - 220), top: Math.min(linkMenu.y, (boxRef.current?.clientHeight ?? 600) - 160) }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="px-2.5 pb-1 pt-0.5 text-[11px] text-[#86868b]">连到新节点</div>
            <button type="button" className={item} onClick={() => { close(); addGen({ x: linkMenu.wx, y: linkMenu.wy - 160 }, [linkMenu.src]); }}>
              生成新图（建一个生成框）
            </button>
            {srcNode && srcNode.kind !== "text" && (
              <button
                type="button"
                className={item}
                onClick={() => {
                  close();
                  const t: Node = { id: uid(), kind: "text", text: "", x: linkMenu.wx, y: linkMenu.wy - 90, w: 320, h: 180, from: [linkMenu.src] };
                  commit((l) => [...l, t]);
                  setSel(new Set([t.id]));
                  describeInto(linkMenu.src, t.id);
                }}
              >
                看图写描述（建一个文本）
              </button>
            )}
            <button type="button" className={`${item} text-[#86868b]`} onClick={close}>取消</button>
          </div>
        );
      })()}

      {/* Right-click menu (用户 2026-11-10: 右键是插入节点等功能). */}
      {ctx && (() => {
        const one = ctx.node ? nodesRef.current.find((m) => m.id === ctx.node) : undefined;
        const url = one ? urlOf(one) : undefined;
        const item = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-[#1d1d1f] hover:bg-black/[0.05]";
        const go = (f: () => void) => () => { setCtx(null); f(); };
        const W = window.innerWidth, H = window.innerHeight;
        return createPortal(
          <div
            data-canvas-menu=""
            className="animate-pop-in fixed z-[90] w-48 rounded-xl bg-white/95 p-1 shadow-[0_14px_40px_rgba(0,0,0,0.18)] ring-1 ring-black/[0.06] backdrop-blur"
            style={{ left: Math.min(ctx.x, W - 200), top: Math.min(ctx.y, H - (one ? 300 : 190)) }}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
          >
            {one ? (
              <>
                {onCompare && (selected.length === 2 || one.from?.length || one.gid) && <button type="button" className={item} onClick={go(compareSel)}>{selected.length === 2 ? "对比这两张" : "和原图对比"}</button>}
                {one.gid && onAgain && <button type="button" className={item} onClick={go(() => onAgain(one.gid!, linkedText(one), linkedRefs(one)))}>再来一张</button>}
                {one.gid && onUpscale && <button type="button" className={item} onClick={go(() => onUpscale(one.gid!))}>高清放大 2 倍</button>}
                {url && <button type="button" className={item} onClick={go(() => onView(url))}>看大图</button>}
                {url && <button type="button" className={item} onClick={go(() => onDownload(one.gid ?? null, url))}>下载</button>}
                <div className="my-1 h-px bg-black/[0.07]" />
                <button type="button" className={item} onClick={go(duplicateSel)}>复制一份</button>
                {onShare && <button type="button" className={item} onClick={go(() => onShare(true))}>分享选中的{selected.length > 1 ? ` ${selected.length} 个` : "这张"}…</button>}
                <button type="button" className={`${item} text-[#d70015]`} onClick={go(removeSel)}>移出画布</button>
              </>
            ) : (
              <>
                <button type="button" className={item} onClick={go(() => addGen({ x: ctx.wx - 160, y: ctx.wy - 160 }, []))}>生成新图</button>
                <button type="button" className={item} onClick={go(() => addText({ x: ctx.wx, y: ctx.wy }))}>添加文本</button>
                <button type="button" className={item} onClick={go(() => { fileAt.current = { x: ctx.wx, y: ctx.wy }; fileRef.current?.click(); })}>上传图片…</button>
                {onOpenHistory && <button type="button" className={item} onClick={go(onOpenHistory)}>从历史添加</button>}
                <div className="my-1 h-px bg-black/[0.07]" />
                <button type="button" className={item} onClick={go(() => setSel(new Set(nodesRef.current.map((m) => m.id))))}>全选</button>
                <button type="button" className={item} onClick={go(() => fitAll())}>显示全部</button>
                {onShare && <button type="button" className={item} onClick={go(() => onShare())}>分享整个画布…</button>}
              </>
            )}
          </div>,
          document.body
        );
      })()}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          const at = fileAt.current ?? toWorld(0, 0);
          fileAt.current = null;
          await addFiles(files, { x: at.x + 160, y: at.y + 160 });
        }}
      />

      {/* 用户 2026-11-11 (画布小地图): the whole board in the corner; click or drag to move there. */}
      {/* 用户 2026-11-11: only when zoomed far out, looking for things. */}
      {prefs?.map !== false && nodes.length > 0 && view.s < 0.6 && boxRef.current && (() => {
        const W = boxRef.current.clientWidth, H = boxRef.current.clientHeight;
        const vx0 = -view.x / view.s, vy0 = -view.y / view.s, vx1 = vx0 + W / view.s, vy1 = vy0 + H / view.s;
        const x0 = Math.min(vx0, ...nodes.map((n) => n.x)), y0 = Math.min(vy0, ...nodes.map((n) => n.y));
        const x1 = Math.max(vx1, ...nodes.map((n) => n.x + n.w)), y1 = Math.max(vy1, ...nodes.map((n) => n.y + n.h));
        const MW = 168, MH = 112, pad = 6;
        const k = Math.min((MW - pad * 2) / (x1 - x0), (MH - pad * 2) / (y1 - y0));
        const ox = pad + (MW - pad * 2 - (x1 - x0) * k) / 2, oy = pad + (MH - pad * 2 - (y1 - y0) * k) / 2;
        const goTo = (e: React.PointerEvent) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const wx = (e.clientX - r.left - ox) / k + x0, wy = (e.clientY - r.top - oy) / k + y0;
          setView((v) => ({ ...v, x: W / 2 - wx * v.s, y: H / 2 - wy * v.s }));
        };
        return (
          <div
            className="absolute bottom-3 right-3 z-20 overflow-hidden rounded-xl bg-white/85 shadow-[0_6px_20px_rgba(0,0,0,0.12)] ring-1 ring-black/[0.06] backdrop-blur"
            style={{ width: MW, height: MH }}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              goTo(e);
            }}
            onPointerMove={(e) => e.buttons === 1 && goTo(e)}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
          >
            {nodes.map((n) => (
              <div
                key={n.id}
                className={`absolute rounded-[2px] ${sel.has(n.id) ? "bg-[#0071e3]" : n.kind === "text" ? "bg-[#c7c7cc]" : "bg-[#8e8e93]"}`}
                style={{ left: ox + (n.x - x0) * k, top: oy + (n.y - y0) * k, width: Math.max(2, n.w * k), height: Math.max(2, n.h * k) }}
              />
            ))}
            <div
              className="pointer-events-none absolute rounded-[3px] border-[1.5px] border-[#0071e3] bg-[#0071e3]/[0.06]"
              style={{ left: ox + (vx0 - x0) * k, top: oy + (vy0 - y0) * k, width: (vx1 - vx0) * k, height: (vy1 - vy0) * k }}
            />
          </div>
        );
      })()}

      {/* Zoom controls (only when the page does not host them). */}
      {!onScale && <div
        className="absolute bottom-3 left-3 z-20 flex items-center gap-0.5 rounded-full bg-white/90 p-0.5 text-[12px] shadow-[0_4px_16px_rgba(0,0,0,0.12)] ring-1 ring-black/[0.06] backdrop-blur"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button type="button" aria-label="缩小" className="h-7 w-7 rounded-full hover:bg-black/[0.06]" onClick={() => { const r = boxRef.current!.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, view.s / 1.25); }}>−</button>
        <button type="button" className="h-7 w-12 rounded-full tabular-nums hover:bg-black/[0.06]" data-tip="回到 100%" onClick={() => { const r = boxRef.current!.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1); }}>{Math.round(view.s * 100)}%</button>
        <button type="button" aria-label="放大" className="h-7 w-7 rounded-full hover:bg-black/[0.06]" onClick={() => { const r = boxRef.current!.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, view.s * 1.25); }}>+</button>
        <button type="button" className="h-7 rounded-full px-2.5 hover:bg-black/[0.06]" data-tip="显示全部（Shift+1）" onClick={() => fitAll()}>适应</button>
      </div>}

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
