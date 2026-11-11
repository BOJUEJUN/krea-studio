"use client";

import { createPortal } from "react-dom";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PictureMention } from "./picture-mention";
import { GeneratingView } from "./generating-view";
import { pictureRefs, type CanvasLayout, type EditablePicture } from "@/lib/edit-recipe";
import { copyNodes, decodeNodes, encodeNodes, nodeMime, pasteNodes } from "@/lib/canvas-clipboard";
import { shareCodeIn } from "@/lib/canvas-share-code";
import { captureLayout, generationInputs, isGeneration, isResult, inputsOf as upstreamOf, pictureDraft, restoreWorkflow, selectedGeneration, uid, type CanvasDraft, type BoardNode as Node } from "@/lib/canvas-workflow";

/**
 * 2026-11-10 (用户: 页面可以切换成自由画布). An infinite board, modelled on what makes Krea / Visual Electric /
 * Flora / Freepik Spaces / Figma boards pleasant:
 * - drag empty space (or hold Space) to pan; pinch or ⌘/Ctrl + wheel zooms at the pointer; "适应" fits everything;
 * - drop pictures from history or from the computer; click / Shift-click / Shift-drag to select; drag to move;
 *   the corner handle resizes with the picture's own shape; ⌘Z / ⌘⇧Z undo and redo; Delete removes; ⌘D copies;
 * - a toolbar floats over the selection (参考图 / 看大图 / 下载 / 置顶 / 删除);
 * - generation updates the frame that submitted it and keeps its input wires;
 * - everything is saved in this browser per account.
 */

export type BoardSource = { id: string; url: string; status?: string; prompt?: string; model?: string; cover?: string; mode?: string; recipe?: EditablePicture };
export type BoardJob = { gid: string; frame?: string; board?: string; failed?: boolean };
export type BoardApi = {
  add: (gid: string) => void;
  reedit: (g: EditablePicture) => void;
  layout: () => CanvasLayout | undefined;
  startFrame: (busy: ReadonlySet<string>, draft: CanvasDraft) => CanvasLayout | undefined;
  saveDraft: (id: string, draft: CanvasDraft) => void;
  removeInput: (slot: number) => void;
  attachFiles: (files: File[], slot?: number) => void;
  attachHistory: (gid: string, targetId?: string) => void;
  has: (gid: string) => boolean;
  /** References (data URLs) on the left, the result they made on the right, linked; the references end up selected. */
  importSet: (refs: string[], resultGid: string | null) => void;
  /** Zoom around the middle of the board: in / out a step, fit everything, or an exact scale (1 = 100%). */
  zoom: (to: "in" | "out" | "fit" | number) => void;
  /** Pasted pictures: placed under the mouse when it is over the board, else in the middle. */
  paste: (files: File[]) => void;
  pasteNodes: (data: DataTransfer) => boolean;
  /** The compose box edits the selected text node. */
  setText: (text: string) => void;
  /** The board with every picture as a link (for 分享); null while a picture is still uploading. */
  snapshot: (onlySelected?: boolean) => { nodes: any[]; view: View } | null;
};

type View = { x: number; y: number; s: number };
type Saved = { nodes: Node[]; view: View; updatedAt?: number };

const MIN_S = 0.1;
const MAX_S = 4;
const GAP = 40;
const typing = (target: EventTarget | null) => target instanceof HTMLElement &&
  (target.matches("input,textarea,select") || target.isContentEditable);
function writeNodeCopy(e: ClipboardEvent, text: string) {
  if (!e.clipboardData) return false;
  e.clipboardData.setData("text/plain", text);
  try { e.clipboardData.setData(nodeMime, text); } catch { /* Plain text also works in Safari. */ }
  e.preventDefault();
  return true;
}

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
  boardJobs,
  onJobsPlaced,
  pendingIds,
  frameProgress,
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
  onReedit,
  onUpscale,
  onScale,
  onOpenHistory,
  onCompare,
  prefs,
  onSelectionText,
  summaryFor,
  onShare,
  onDescribe,
  polishLevel, onPolishLevel, onPolish,
}: {
  /** History ids currently on this board (history cards mark them). */
  onGidsChange?: (gids: string[]) => void;
  /** Failed placeholder → make it again; the placeholder is removed and its sources get selected. */
  onRetry?: (gid: string) => void;
  /** 再来一张 / 高清放大 for one picture from history (用户 2026-11-10). */
  onReedit?: (gid: string) => void;
  onAgain?: (gid: string, text?: string, refs?: string[]) => void;
  onUpscale?: (gid: string) => void;
  /** When set the board hides its own zoom buttons; the page shows the level in its rail instead. */
  onScale?: (s: number) => void;
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
  polishLevel: CanvasDraft["polishLevel"];
  onPolishLevel: (level: CanvasDraft["polishLevel"]) => void;
  onPolish: (text: string, level: CanvasDraft["polishLevel"]) => Promise<string>;
  /** The settings chosen for a picture (model + short list), shown under it when it is not being edited. */
  summaryFor?: (node: Node, hasPictures: boolean) => { model: string; cover?: string; detail: string } | null;
  /** Where the selection sits on screen (client px), so the compose box can hug it; null when nothing is selected. */
  onSelectionBox?: (r: { left: number; top: number; right: number; bottom: number } | null) => void;
  apiRef?: React.MutableRefObject<BoardApi | null>;
  /** The selected pictures' urls (in canvas mode they become the reference images). */
  onSelectionChange?: (urls: string[], nodeKey?: string, frame?: boolean, editOf?: string, restore?: boolean, draft?: CanvasDraft) => void;
  storageKey: string;
  /** The board's id on the server (用户 2026-11-11: 云端保存); without it the board lives in this browser only. */
  cloudId?: string;
  sources: Map<string, BoardSource>;
  boardJobs: BoardJob[];
  onJobsPlaced: (jobs: BoardJob[]) => void;
  pendingIds: string[];
  frameProgress: ReadonlyMap<string, number>;
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
  // 用户 2026-11-11: the minimap shows only while moving around zoomed far out, then fades.
  const [navOn, setNavOn] = useState(false);
  const [mapHold, setMapHold] = useState(false); // the pointer is on the minimap
  const navTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navRef = useRef<() => void>(() => {});
  const nav = useCallback(() => {
    setNavOn(true);
    if (navTimer.current) clearTimeout(navTimer.current);
    navTimer.current = setTimeout(() => setNavOn(false), 1500);
  }, []);
  navRef.current = nav;
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
    const flush = () => {
      if (!loaded.current || !remoteReady.current) return;
      try {
        localStorage.setItem(storageKey, JSON.stringify({ nodes: nodesRef.current, view: viewRef.current, updatedAt: editedAt.current }));
      } catch { /* Large uploads may only fit in the cloud copy. */ }
      push(true);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
    };
  }, [push, storageKey]);

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
      navRef.current();
      if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, viewRef.current.s * Math.exp(-e.deltaY * 0.01));
      else if (wheelIsMouse && !e.shiftKey) zoomAt(e.clientX, e.clientY, viewRef.current.s * Math.exp(-Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY) * (e.deltaMode ? 33 : 1), 200) * 0.0015));
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const deferred = useRef<(() => void)[]>([]);
  const selectionClip = useCallback(() => copyNodes(nodesRef.current, selRef.current), []);
  const placeClip = useCallback((clip: ReturnType<typeof copyNodes>, at?: { x: number; y: number }) => {
    if (!clip.selected.length) return;
    const copies = pasteNodes(clip, nodesRef.current, at);
    commit((list) => [...list, ...copies.nodes]);
    setSel(copies.selected);
  }, [commit]);
  const pasteAt = useCallback(() => {
    const r = boxRef.current!.getBoundingClientRect(), p = lastPointer.current;
    return p && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom
      ? toWorld(p.x, p.y) : toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }, [toWorld]);
  const pasteText = useCallback((text: string, at: { x: number; y: number }) => {
    const clip = decodeNodes(text);
    if (clip) { placeClip(clip, at); return true; }
    const token = shareCodeIn(text), board = boxRef.current;
    if (!token || !board) return false;
    void (async () => {
      try {
        const d = await (await fetch(`/api/canvas/share?t=${encodeURIComponent(token)}`, { cache: "no-store" })).json();
        if (!d?.ok || !Array.isArray(d.nodes) || !d.nodes.length) throw new Error(d?.error || "分享口令无效");
        if (board !== boxRef.current) return;
        placeClip({ selected: d.nodes.map((n: Node) => n.id), nodes: d.nodes }, at);
        flash(`已导入 ${d.nodes.length} 个节点`);
      } catch (e) { flash(e instanceof Error ? e.message : "导入失败"); }
    })();
    return true;
  }, [placeClip, flash]);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const [editClick, setEditClick] = useState(0);
  const explicitEdit = useRef<string | null>(null);
  // History cards call in here: put a picture on the board, or jump to it when it is already there.
  useEffect(() => {
    if (!apiRef) return;
    const api: BoardApi = {
      importSet: () => {},
      saveDraft: (id, draft) => {
        setNodesRaw((list) => {
          const n = list.find((m) => m.id === id);
          if (!n || !isGeneration(n) || JSON.stringify(n.draft) === JSON.stringify(draft)) return list;
          return list.map((m) => m === n ? { ...n, draft } : m);
        });
      },
      removeInput: (slot) => {
        const list = nodesRef.current;
        const n = selectedGeneration(list.filter((m) => selRef.current.has(m.id)));
        if (!n) return;
        const inputs = generationInputs(n, list);
        const removed = inputs.filter((m) => urlOfRef.current(m))[slot];
        if (removed) commit(list.map((m) => m.id === n.id ? { ...m, from: inputs.filter((p) => p.id !== removed.id).map((p) => p.id) } : m));
      },
      attachHistory: (gid, targetId) => {
        const list = nodesRef.current;
        const target = targetId ? list.find((n) => n.id === targetId && isGeneration(n)) : selectedGeneration(list.filter((n) => selRef.current.has(n.id)));
        if (target?.gid === gid) return flash("生成结果不能连回自己");
        const r = boxRef.current?.getBoundingClientRect();
        if (!r) return;
        const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
        const frame: Node = target ?? { id: uid(), kind: "gen", x: c.x + 40, y: c.y - 160, w: 320, h: 320 };
        const incoming = generationInputs(frame, list);
        if (incoming.some((n) => n.gid === gid)) return flash("这张已经连上了");
        const ref = list.find((n) => n.kind === "image" && n.gid === gid && !isAncestor(frame.id, n.id, list)) ??
          { id: uid(), gid, kind: "image" as const, x: frame.x - 400, y: Math.max(frame.y, ...incoming.map((n) => n.y + n.h + GAP)), w: 320, h: 320, fit: true };
        const next = { ...frame, from: [...incoming.map((n) => n.id), ref.id] };
        commit([...list.map((n) => n.id === frame.id ? next : n), ...(list.includes(ref) ? [] : [ref]), ...(target ? [] : [next])]);
        setSel(new Set([frame.id]));
      },
      attachFiles: (files, slot) => {
        const list = nodesRef.current;
        const n = selectedGeneration(list.filter((m) => selRef.current.has(m.id)));
        if (n) void attachFilesRef.current(n, files, slot);
      },
      layout: () => {
        const list = nodesRef.current;
        return captureLayout(list.filter((n) => selRef.current.has(n.id)), list, urlOfRef.current);
      },
      startFrame: (busy, draft) => {
        const list = nodesRef.current;
        const frame = selectedGeneration(list.filter((n) => selRef.current.has(n.id)));
        if (!frame) return;
        if (!busy.has(frame.id) && !frame.pendingGid) return captureLayout([frame], list, urlOfRef.current);
        const fork: Node = { id: uid(), kind: "gen", draft: { ...draft }, x: frame.x + frame.w + 2 * GAP,
          y: frame.y, w: frame.w, h: frame.h, from: generationInputs(frame, list).map((n) => n.id) };
        while (list.some((m) => m.x < fork.x + fork.w && m.x + m.w > fork.x && m.y < fork.y + fork.h && m.y + m.h > fork.y))
          fork.y += fork.h + 2 * GAP;
        commit((ns) => [...ns, fork]);
        return captureLayout([fork], [...list, fork], urlOfRef.current);
      },
      reedit: (g) => {
        if (!remoteReady.current) { deferred.current.push(() => api.reedit(g)); return; }
        const restored = restoreWorkflow(nodesRef.current, g, urlOfRef.current);
        if (restored.list !== nodesRef.current) commit(restored.list);
        explicitEdit.current = restored.frame.id;
        setEditClick((n) => n + 1);
        setSel(new Set([restored.frame.id]));
        fitAll(restored.focus);
      },
      zoom: () => {},
      paste: () => {},
      pasteNodes: (data) => pasteText(data.getData(nodeMime) || data.getData("text/plain"), pasteAt()),
      setText: () => {},
      snapshot: () => null,
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
        const n: Node = { id: uid(), kind: "image", gid, x: c.x - 160 + k * 24, y: c.y - 160 + k * 24, w: 320, h: 320, fit: true };
        commit((list) => [...list, n]);
        setSel(new Set([n.id]));
      },
    };
    api.importSet = (refs, resultGid) => {
      if (!remoteReady.current) { deferred.current.push(() => api.importSet(refs, resultGid)); return; }
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
        added.push({ id: uid(), kind: "result", gid: resultGid, x: c.x - 140, y: c.y - 160, w: 320, h: 320, from: refIds.length ? refIds : undefined, fit: true });
      }
      if (added.length) commit((l) => [...l, ...added]);
      if (refIds.length) setSel(new Set(refIds));
    };
    api.snapshot = (onlySelected) => {
      const pick = onlySelected ? nodesRef.current.filter((n) => selRef.current.has(n.id)) : nodesRef.current;
      const ids = new Set(pick.map((n) => n.id));
      const list = pick.map((n) => {
        const recipe = sourcesRef.current.get(n.gid ?? n.editOf ?? "")?.recipe;
        const from = isGeneration(n) ? generationInputs(n, nodesRef.current).map((m) => m.id) : n.from;
        return { ...n, from: from?.filter((id) => ids.has(id)), kind: isResult(n) ? "result" as const : n.kind,
          src: urlOfRef.current(n) ?? undefined, gid: undefined, editOf: undefined, pendingGid: undefined,
          draft: n.draft ?? (isGeneration(n) && recipe ? pictureDraft(recipe) : undefined) };
      });
      if (list.some((n) => n.src?.startsWith("data:"))) return null;
      return { nodes: list.filter((n) => n.kind === "text" || n.kind === "gen" || n.src), view: viewRef.current };
    };
    api.paste = (files) => { void addFilesRef.current(files, pasteAt()); };
    api.setText = (text) => {
      const picked = nodesRef.current.filter((n) => selRef.current.has(n.id));
      const frame = selectedGeneration(picked);
      const ids = new Set(frame ? generationInputs(frame, nodesRef.current).filter((n) => n.kind === "text").map((n) => n.id) : []);
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
  }, [apiRef, toWorld, commit, zoomAt, fitAll, flash, pasteAt, pasteText]);
  useEffect(() => {
    if (remoteReady.current) deferred.current.splice(0).forEach((run) => run());
  }, [syncTick]);
  // The page shows the zoom level in its tool rail (用户 2026-11-10).
  useEffect(() => {
    onScale?.(view.s);
  }, [view.s, onScale]);

  // Bind a task to the node captured when Generate was clicked, independent of the current selection.
  // Keep the last successful preview until a replacement is ready, including across reloads.
  const pendingKey = nodes.map((n) => n.pendingGid ?? "").filter(Boolean).join("|");
  useEffect(() => {
    if (!remoteReady.current || !loaded.current) return;
    const list = nodesRef.current;
    const placed = boardJobs.filter((job) => job.board ? job.board === cloudId : list.some((n) => n.id === job.frame));
    if (!placed.length && !pendingKey) return;
    setNodesRaw((prev) => {
      let next = prev;
      const replace = (node: Node, patch: Partial<Node>) => {
        if (next === prev) next = [...prev];
        next[next.indexOf(node)] = { ...node, ...patch };
      };
      for (const job of placed) {
        const frame = next.find((n) => n.id === job.frame);
        if (job.failed) {
          if (frame?.pendingGid === job.gid) replace(frame, { pendingGid: undefined });
        } else if (job.frame) {
          if (frame && isGeneration(frame) && frame.gid !== job.gid && frame.pendingGid !== job.gid) replace(frame, { pendingGid: job.gid });
        } else if (!next.some((n) => n.gid === job.gid)) {
          // A standalone operation such as upscaling a resource has no generator to update.
          const p = pasteAt(), w = 320, h = w / Math.max(0.2, jobAspect || 1);
          next = [...next, { id: uid(), kind: "result", gid: job.gid, x: p.x - w / 2, y: p.y - h / 2, w, h, from: [], fit: true }];
        }
      }
      for (const n of next) {
        if (!n.pendingGid) continue;
        const src = sources.get(n.pendingGid);
        if (src?.url) replace(n, { gid: n.pendingGid, pendingGid: undefined, kind: "result", editOf: undefined, src: undefined, nw: undefined, nh: undefined, from: n.from ?? [], fit: true });
        else if (src?.status === "failed" || src?.status === "expired") replace(n, { pendingGid: undefined });
      }
      return next;
    });
    if (placed.length) onJobsPlaced(placed);
  }, [boardJobs, cloudId, pendingKey, sources, syncTick, pasteAt, jobAspect, onJobsPlaced]);

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
      nav();
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
  const sourceNodes = (n: Node) => generationInputs(n, nodesRef.current);
  const linkedText = (n: Node) => sourceNodes(n).filter((m) => m.kind === "text").map((m) => m.text).filter(Boolean).join("\n\n") || undefined;
  const linkedRefs = (n: Node) => {
    const urls = sourceNodes(n).map((m) => urlOf(m)).filter((u): u is string => !!u);
    return urls.length || (isGeneration(n) && n.from !== undefined) ? urls : undefined;
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
    const src = sourceNodes(n).find((m) => urlOf(m));
    onCompare(src ? urlOf(src)! : null, u, n.gid ?? null);
  };
  const removeSel = useCallback(() => {
    if (!sel.size) return;
    commit((n) => n.filter((m) => !sel.has(m.id)));
    setSel(new Set());
  }, [sel, commit]);
  const duplicateSel = useCallback(() => {
    const clip = selectionClip();
    const selected = new Set(clip.selected);
    const group = clip.nodes.filter((n) => selected.has(n.id));
    const board = boxRef.current;
    if (!group.length || !board) return;
    const left = Math.min(...group.map((n) => n.x)), top = Math.min(...group.map((n) => n.y));
    const width = Math.max(...group.map((n) => n.x + n.w)) - left;
    const height = Math.max(...group.map((n) => n.y + n.h)) - top;
    const list = nodesRef.current, v = viewRef.current;
    const candidates = [
      { x: left + width + GAP, y: top }, { x: left - width - GAP, y: top },
      { x: left, y: top + height + GAP }, { x: left, y: top - height - GAP },
    ].filter(({ x, y }) => !list.some((n) => n.x < x + width && n.x + n.w > x && n.y < y + height && n.y + n.h > y));
    const visible = ({ x, y }: { x: number; y: number }) =>
      x * v.s + v.x >= 0 && y * v.s + v.y >= 0 &&
      (x + width) * v.s + v.x <= board.clientWidth && (y + height) * v.s + v.y <= board.clientHeight;
    const target = candidates.find(visible) ?? candidates[0] ?? { x: Math.max(...list.map((n) => n.x + n.w)) + GAP, y: top };
    const center = { x: target.x + width / 2, y: target.y + height / 2 };
    placeClip(clip, center);
    if (!visible(target)) setView({ ...v, x: board.clientWidth / 2 - center.x * v.s, y: board.clientHeight / 2 - center.y * v.s });
  }, [selectionClip, placeClip]);
  const copySel = async () => {
    const clip = selectionClip();
    if (!clip.selected.length) return;
    const text = encodeNodes(clip);
    // Write in the click gesture so even an immediate Paste reads this selection.
    let copied = false;
    const copy = (e: ClipboardEvent) => { copied = writeNodeCopy(e, text); };
    document.addEventListener("copy", copy, true);
    try { document.execCommand("copy"); } catch {} finally { document.removeEventListener("copy", copy, true); }
    try {
      if (!copied) await navigator.clipboard.writeText(text);
      flash("节点已复制");
    } catch {
      flash("请用系统复制快捷键");
    }
  };
  const pasteMenu = async (at: { x: number; y: number }) => {
    try {
      if (!pasteText(await navigator.clipboard.readText(), at)) flash("剪贴板里没有节点或分享口令");
    } catch { flash("请用系统粘贴快捷键"); }
  };
  useEffect(() => {
    const copy = (e: ClipboardEvent) => {
      if (e.defaultPrevented || typing(e.target) || window.getSelection()?.isCollapsed === false || !e.clipboardData) return;
      const clip = selectionClip();
      if (!clip.selected.length) return;
      writeNodeCopy(e, encodeNodes(clip));
      flash("节点已复制");
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
    window.addEventListener("copy", copy);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("copy", copy);
      window.removeEventListener("keyup", up);
    };
  }, [sel, removeSel, duplicateSel, selectionClip, flash, fitAll, commit]);

  // ---- drop from history or the computer
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropHover(false);
    const at = toWorld(e.clientX, e.clientY);
    const frameId = (e.target as Element).closest?.("[data-node-id]")?.getAttribute("data-node-id");
    const frame = frameId ? nodesRef.current.find((m) => m.id === frameId && isGeneration(m)) : undefined;
    const gid = e.dataTransfer.getData(dragType);
    if (gid) {
      const src = sources.get(gid);
      if (!src?.url) return;
      if (frame && apiRef?.current) return apiRef.current.attachHistory(gid, frame.id);
      const n: Node = { id: uid(), kind: "image", gid, x: at.x - 160, y: at.y - 160, w: 320, h: 320, fit: true };
      commit((list) => [...list, n]);
      setSel(new Set([n.id]));
      return;
    }
    if (frame) {
      setSel(new Set([frame.id]));
      await attachFiles(frame, Array.from(e.dataTransfer.files ?? []));
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
      if (!stack) setSel(new Set(added.map((n) => n.id)));
    }
    return added.map((n) => n.id);
  };

  const attachFiles = async (frame: Node, files: File[], slot?: number) => {
    const inputs = generationInputs(frame, nodesRef.current);
    const replace = slot === undefined ? undefined : inputs.filter((m) => urlOfRef.current(m))[slot];
    const y = slot !== undefined ? replace?.y ?? frame.y : Math.max(frame.y, ...inputs.map((n) => n.y + n.h + GAP));
    const made = await addFiles(slot === undefined ? files : files.slice(0, 1), { x: frame.x - 240, y: y + 160 }, true);
    if (made.length) commit((list) => list.map((m) => {
      if (m.id !== frame.id) return m;
      const ids = generationInputs(m, list).map((n) => n.id);
      return { ...m, from: replace && ids.includes(replace.id) ? ids.map((id) => id === replace.id ? made[0] : id) : [...ids, ...made] };
    }));
  };
  const attachFilesRef = useRef(attachFiles);
  attachFilesRef.current = attachFiles;

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
    commit((list) => list.map((m) => m.id === n.id ? { ...m, gid: undefined, kind: "gen", editOf: n.gid, from: generationInputs(n, list).map((p) => p.id) } : m));
    setSel(new Set([n.id]));
    onRetry?.(n.gid);
  };

  const urlOf = (n: Node): string | null => (n.kind === "text" ? null : n.src ?? (n.gid ? sources.get(n.gid)?.url || null : null));
  urlOfRef.current = urlOf;
  // The generated picture itself only becomes input through an explicit outgoing wire.
  const selected = nodes.filter((n) => sel.has(n.id));
  const frame = selectedGeneration(selected);
  const selFlat = frame ? generationInputs(frame, nodes) : [];
  const selKey = selFlat.map((n) => urlOf(n) ?? "").filter(Boolean).join("|");
  const onSelRef = useRef(onSelectionChange);
  onSelRef.current = onSelectionChange;
  // Which nodes are picked (the page keeps each node's own settings by this).
  const selIdKey = [...sel].sort().join("|");
  const selIdRef = useRef(selIdKey);
  selIdRef.current = selIdKey;
  const recipeId = frame && (isResult(frame) ? frame.gid : frame.editOf);
  const original = recipeId ? sources.get(recipeId)?.recipe : undefined;
  const orphan = !!(frame && isResult(frame) && frame.from === undefined && original && pictureRefs(original).length);
  const ready = !!frame && !orphan && (!recipeId || !!original || !!frame.draft);
  useEffect(() => {
    if (orphan && original) {
      const current = nodesRef.current;
      commit(restoreWorkflow(current, original, urlOfRef.current).list);
      return;
    }
    const restore = !!frame && explicitEdit.current === frame.id;
    explicitEdit.current = null;
    onSelRef.current?.(ready && selKey ? selKey.split("|") : [], selIdRef.current, ready, recipeId, restore, frame?.draft);
  }, [selKey, selIdKey, frame?.id, recipeId, ready, orphan, editClick, commit]);
  const selRef = useRef(sel);
  selRef.current = sel;
  const selTexts = selFlat.filter((n) => n.kind === "text");
  const selTextKey = selTexts.length ? selTexts.map((n) => n.text ?? "").join("\n\n") : null;
  const onSelTextRef = useRef(onSelectionText);
  onSelTextRef.current = onSelectionText;
  useEffect(() => {
    onSelTextRef.current?.(selTextKey);
  }, [selTextKey, selIdKey]);
  const [editing, setEditing] = useState<string | null>(null);
  const picsForText = (textId: string): { n: number; url: string }[] => {
    const target = nodes.find((n) => isGeneration(n) && generationInputs(n, nodes).some((m) => m.id === textId));
    if (!target) return [];
    return generationInputs(target, nodes).flatMap((m) => urlOf(m) ?? []).map((url, i) => ({ n: i + 1, url }));
  };
  const [mention, setMention] = useState<{ id: string; at: number } | null>(null);
  // Each "@图N" shows that picture's thumbnail but keeps the hidden text's width, so the caret of the textarea
  // on top stays where the eye expects it (用户 2026-11-11: 输入编辑的时候也要显示图片).
  const mentionTokens = (text: string, pics: { n: number; url: string }[]) =>
    text.split(/(@图\d+)/g).map((part, i) => {
      const m = part.match(/^@图(\d+)$/);
      if (!m) return part;
      const p = pics.find((x) => x.n === Number(m[1]));
      if (!p) return <span key={i} className="rounded bg-[#ff3b30]/10 text-danger underline decoration-dashed underline-offset-2">{part}</span>;
      return <PictureMention key={i} token={part} src={p.url.startsWith("data:") ? p.url : thumb(p.url, 160)} />;
    });
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
    if (!isGeneration(tgt) && tgt.kind !== "text") return flash("请把参考图连到「生成图片」");
    const incoming = isGeneration(tgt) ? generationInputs(tgt, list).map((m) => m.id) : tgt.from ?? [];
    if (incoming.includes(srcId)) return flash("已经连着了");
    if (isAncestor(tgtId, srcId, list)) return flash("不能连成一圈");
    if (src.kind === "text" && tgt.kind === "text") return flash("文本不能连文本");
    if (src.kind !== "text" && !urlOf(src)) return flash("这张还没有图");
    commit((l) => l.map((m) => (m.id === tgtId ? { ...m, from: [...incoming, srcId] } : m)));
    if (tgt.kind === "text") describeInto(srcId, tgtId);

  };
  const unlink = (srcId: string, tgtId: string) => {
    commit((l) => l.map((m) => (m.id === tgtId ? { ...m, from: (isGeneration(m) ? generationInputs(m, l).map((p) => p.id) : m.from ?? []).filter((f) => f !== srcId) } : m)));
  };
  const addGen = (at: { x: number; y: number }, from: string[]) => {
    const n: Node = { id: uid(), kind: "gen", x: at.x, y: at.y, w: 320, h: 320, from: from.length ? from : undefined };
    commit((l) => [...l, n]);
    setSel(new Set([n.id]));
    return n;
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
      if (n.kind === "text" || n.nw) continue;
      const u = urlOf(n);
      if (!u || u.startsWith("data:") || !u.startsWith("/api/")) continue;
      const key = n.id + ":" + u;
      if (sizing.current.has(key)) continue;
      sizing.current.add(key);
      fetch(`/api/imginfo?u=${encodeURIComponent(u.split("?")[0])}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.w) setNodesRaw((list) => list.map((m) => (m.id === n.id && urlOfRef.current(m) === u ? { ...m, nw: d.w, nh: d.h } : m)));
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
  const wires = useMemo(() => new Map(nodes.map((n) => [n.id, isGeneration(n) ? generationInputs(n, nodes) : upstreamOf(n, nodes)])), [nodes]);
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

  const btn = "flex h-8 items-center gap-1 rounded-full px-2.5 text-[12px] text-ink transition hover:bg-edge/[0.06]";
  const ibtn = "flex h-8 min-w-8 items-center justify-center rounded-full px-1.5 text-ink transition hover:bg-edge/[0.06] active:scale-[0.94]";
  const ico = "h-[18px] w-[18px] fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.6]";
  return (
    <div
      ref={boxRef}
      className={`relative h-full w-full touch-none select-none overflow-hidden bg-[light-dark(#f6f6f8,#27292e)] ${panning ? "cursor-grabbing" : spaceDown ? "cursor-grab" : ""}`}
      style={{
        backgroundImage: prefs?.grid === false ? "none" : `radial-gradient(circle, color-mix(in srgb, var(--color-edge) 13%, transparent) ${view.s}px, transparent ${1.2 * view.s}px)`,
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
            (wires.get(n.id) ?? []).map((f) => {
              const fid = f.id;
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
            const f = nodes.find((node) => node.id === (drag.current as { src: string }).src);
            if (!f) return null;
            const x0 = f.x + f.w, y0 = f.y + f.h / 2, x1 = linkTo.x, y1 = linkTo.y;
            const c = Math.max(40, Math.abs(x1 - x0) / 2);
            return <path d={`M${x0},${y0} C${x0 + c},${y0} ${x1 - c},${y1} ${x1},${y1}`} fill="none" stroke="#0071e3" strokeWidth={2 / view.s} />;
          })()}
        </svg>
        {prefs?.lines !== false && nodes.flatMap((n) => {
          let pic = 0;
          return (wires.get(n.id) ?? []).map((f) => {
            const fid = f.id;
            const label = n.kind === "text" ? "看图写描述" : f.kind === "text" ? "文本" : urlOf(f) ? `图${++pic}` : "图片";
            const x = (f.x + f.w + n.x) / 2, y = (f.y + f.h / 2 + n.y + n.h / 2) / 2;
            const style = { left: x, top: y, transform: "translate(-50%, -50%)" };
            return (
              <button
                type="button"
                key={"l" + fid + n.id}
                aria-label={`断开${label}`}
                data-tip="点一下断开这根线"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => unlink(fid, n.id)}
                className="group absolute flex items-center gap-0.5 whitespace-nowrap rounded-full bg-panel px-1.5 py-px text-[10px] font-medium text-secondary shadow-[0_1px_6px_rgba(0,0,0,0.1)] ring-1 ring-edge/[0.06] hover:text-danger hover:ring-danger/30"
                style={style}
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
          const k = 1 / view.s; // keep pointer targets usable at any zoom
          const isText = n.kind === "text";
          const task = n.pendingGid ?? (isGeneration(n) ? n.gid : undefined);
          const running = frameProgress.has(n.id) || (!!task && pendingIds.includes(task) && !sources.get(task)?.url);
          const isGen = n.kind === "gen" && !n.gid;
          const hintScale = Math.min(1, n.w / 128, n.h / 88);
          const canLinkOut = isText || !!url;
          return (
            <div
              key={n.id}
              data-node-id={n.id}
              data-node-kind={isResult(n) ? "result" : n.kind ?? "image"}
              className={`group/node absolute rounded-[10px] ${isGen && !running ? (on ? "bg-accent/[0.03]" : "border border-dashed border-accent/40 bg-accent/[0.03]") : "bg-panel shadow-[0_6px_24px_rgba(0,0,0,0.12)]"} ${on || linkHover === n.id ? "" : isGen ? "" : "ring-1 ring-edge/[0.06]"}`}
              style={{ left: n.x, top: n.y, width: n.w, height: n.h, boxShadow: on || linkHover === n.id ? `0 0 0 ${1.25 * k}px ${on ? "var(--color-accent)" : "#34c759"}` : undefined }}
              onPointerDown={(e) => onNodeDown(e, n)}
              onDoubleClick={() => (isText ? setEditing(n.id) : url && onView(url))}
            >
              {/* 用户 2026-11-11: what the node is and its size, above it. */}
              <div
                className="pointer-events-none absolute left-0 flex items-center justify-between whitespace-nowrap text-muted"
                style={{ bottom: "100%", width: n.w, gap: 6, paddingBottom: 5, fontSize: 12 }}
              >
                <span className="flex min-w-0 items-center gap-1 overflow-hidden font-medium text-secondary">
                  {isText ? (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 4h10M3 8h10M3 12h6" /></svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M2.5 11l3.5-3.5 2.5 2.5 2-2 3 3" /></svg>
                  )}
                  {isText ? "文本" : isGeneration(n) ? "生成图片" : "图片资源"}
                </span>
                {!isText && n.nw ? <span className="tabular-nums">{n.nw}×{n.nh}</span> : null}
              </div>
              {isText ? (
                <div className="flex h-full w-full flex-col rounded-[10px]">
                  <div className="relative min-h-0 flex-1">
                  {editing === n.id ? (
                  <>
                  <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words rounded-[10px] p-3 text-[13px] leading-[20px] text-ink">
                    {mentionTokens(n.text ?? "", picsForText(n.id))}
                    {"\n"}
                  </div>
                  <textarea
                    onScroll={(e) => {
                      const mirror = e.currentTarget.previousElementSibling;
                      if (mirror) mirror.scrollTop = e.currentTarget.scrollTop;
                    }}
                    autoFocus
                    value={n.text ?? ""}
                    placeholder="写下描述，连到图片上生成…"
                    onPointerDown={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const v = e.target.value.slice(0, 2000);
                      const c = e.target.selectionStart ?? v.length;
                      setMention(v[c - 1] === "@" && v.length > (n.text ?? "").length ? { id: n.id, at: c - 1 } : null);
                      setNodesRaw((list) => list.map((m) => (m.id === n.id ? { ...m, text: v } : m)));
                    }}
                    onBlur={() => setTimeout(() => { setEditing((cur) => (cur === n.id ? null : cur)); setMention(null); }, 150)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        if (mention) setMention(null);
                        else (e.currentTarget as HTMLTextAreaElement).blur();
                      }
                      if (e.key === "Backspace" && !e.metaKey && !e.altKey) {
                        const el = e.currentTarget;
                        const at = el.selectionStart ?? 0;
                        const t = n.text ?? "";
                        const m = at === el.selectionEnd ? /@图\d+ ?$/.exec(t.slice(0, at)) : null;
                        if (m && m[0].length > 2) {
                          e.preventDefault();
                          const v = t.slice(0, at - m[0].length) + t.slice(at);
                          setNodesRaw((list) => list.map((x) => (x.id === n.id ? { ...x, text: v } : x)));
                          requestAnimationFrame(() => el.setSelectionRange(at - m[0].length, at - m[0].length));
                        }
                      }
                    }}
                    className="relative h-full w-full resize-none overflow-y-auto rounded-[10px] bg-transparent p-3 text-[13px] leading-[20px] text-transparent caret-ink outline-none placeholder:text-hint"
                  />
                  {mention?.id === n.id && (() => {
                    const pics = picsForText(n.id);
                    return (
                      <div
                        className="animate-pop-in absolute left-3 top-9 z-30 w-56 rounded-xl bg-panel p-1 shadow-[0_12px_36px_rgba(0,0,0,0.18)] ring-1 ring-edge/[0.06]"
                        style={{ transform: `scale(${k})`, transformOrigin: "top left" }}
                        onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
                      >
                        {pics.length ? (
                          pics.map((p) => (
                            <button
                              key={p.n}
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => {
                                const t = n.text ?? "";
                                const at = mention.at;
                                const v = t.slice(0, at) + `@图${p.n} ` + t.slice(at + 1);
                                setNodesRaw((list) => list.map((m) => (m.id === n.id ? { ...m, text: v } : m)));
                                setMention(null);
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-ink hover:bg-edge/[0.05]"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={p.url.startsWith("data:") ? p.url : thumb(p.url, 160)} alt="" className="h-8 w-8 rounded-md object-cover" />
                              图{p.n}
                            </button>
                          ))
                        ) : (
                          <div className="px-2 py-1.5 text-[12px] leading-[18px] text-muted">先把这段文本的「+」连到「生成图片」上，就能 @ 那里的图</div>
                        )}
                      </div>
                    );
                  })()}
                  </>
                ) : (
                  <div className="flex h-full w-full flex-col overflow-hidden rounded-[10px] p-3">
                    <div className={`min-h-0 flex-1 overflow-hidden whitespace-pre-wrap break-words text-[13px] leading-[20px] ${n.text ? "text-ink" : "text-hint"}`}>
                      {n.text ? mentionTokens(n.text, picsForText(n.id)) : "双击输入文字，连到「生成图片」作为提示词；输入 @ 可以指定参考图"}
                    </div>
                  </div>
                  )}
                  </div>
                  <TextNodeFooter text={n.text ?? ""} level={polishLevel} setLevel={onPolishLevel} polish={onPolish} flash={flash}
                    replace={(before, after) => {
                      const current = nodesRef.current.find((m) => m.id === n.id);
                      if (!current || current.text !== before) return false;
                      commit((list) => list.map((m) => m.id === n.id && m.text === before ? { ...m, text: after } : m));
                      return true;
                    }} />
                </div>
              ) : running ? (
                <div data-node-generating="" className="h-full w-full overflow-hidden rounded-[10px]"><GeneratingView aspect={n.w / Math.max(1, n.h)} progress={frameProgress.get(n.id) ?? progress} zoom={view.s} compact fill /></div>
              ) : isGen ? (
                <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-[10px]">
                  <div className="flex shrink-0 flex-col items-center gap-1.5 px-2 text-center text-[13px] font-medium leading-[19px] text-ink"
                    style={{ width: n.w / hintScale, transform: `scale(${hintScale})` }}>
                    <svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="1.4" /><path d="m4 17 4-4 3 3 4-6 6 8" /></svg>
                    <span>{n.from?.length ? "点「生成」查看结果" : "拖入图片或文本的连线，再点「生成」"}</span>
                  </div>
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
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-[10px] bg-[light-dark(#fff1f1,#382022)] text-[13px] text-danger">
                  没有生成成功
                  {onRetry && (
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => retry(n)}
                      className="rounded-full bg-danger px-3 py-1 text-[12px] font-medium text-white hover:bg-[#b80012]"
                    >
                      重试
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex h-full w-full items-center justify-center rounded-[10px] bg-well text-[12px] text-muted">暂无预览</div>
              )}
              {isGeneration(n) && (() => {
                const sm = summaryFor?.(n, (wires.get(n.id) ?? []).some((m) => !!urlOf(m)));
                if (!sm) return null;
                return (
                  <div data-node-summary="" title={[sm.model, sm.detail].filter(Boolean).join(" · ")}
                    className="absolute left-0 top-full flex h-6 items-center gap-1.5 overflow-hidden rounded-md bg-panel px-2 text-[11px] text-secondary shadow-sm ring-1 ring-edge/10"
                    style={{ transform: "translateY(5px)", width: n.w }}>
                    {sm.cover && <img src={sm.cover} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm object-cover" />}
                    <span className="max-w-[65%] shrink-0 truncate font-medium text-ink">{sm.model}</span>
                    {sm.detail && <span className="truncate border-l border-edge/15 pl-1.5">{sm.detail}</span>}
                  </div>
                );
              })()}
              {canLinkOut && (
                <span
                  role="button"
                  aria-label="拖出连线"
                  data-tip="拖到别的节点上连线，拖到空白处新建"
                  className={`absolute left-full top-1/2 flex h-6 w-6 cursor-crosshair items-center justify-center rounded-full bg-panel text-[15px] leading-none text-accent shadow-[0_2px_8px_rgba(0,0,0,0.15)] ring-1 ring-accent/30 transition-opacity hover:bg-accent hover:text-panel ${on ? "opacity-100" : "opacity-0 group-hover/node:opacity-100"}`}
                  style={{ transform: `translate(${10 * k}px, -50%) scale(${k})`, transformOrigin: "left center" }}
                  onPointerDown={(e) => startLink(e, n)}
                >
                  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" className="pointer-events-none block" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M8 3v10M3 8h10" />
                  </svg>
                </span>
              )}
              {on && selected.length === 1 && (url || isText) && (
                <span
                  className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize rounded-full border border-white bg-accent shadow"
                  style={{ transform: `translate(50%, 50%) scale(${k})`, transformOrigin: "center" }}
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
            className="pointer-events-none absolute border border-accent bg-accent/10"
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
      {selBox && selected.length > 0 && (
        <div
          className="animate-pop-in absolute z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-panel/95 p-1 shadow-[0_10px_30px_rgba(0,0,0,0.16)] ring-1 ring-edge/[0.06] backdrop-blur"
          style={{ left: Math.max(150, Math.min(selBox.x, (boxRef.current?.clientWidth ?? 800) - 150)), top: Math.max(8, selBox.y - 48 - 24) }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* 用户 2026-11-10: icons only, the name shows on hover. A selected picture already is the reference, so no 用作参考图. */}
          {onCompare && (selected.length === 2 || (selected.length === 1 && (selected[0].from?.length || selected[0].gid))) && (
            <button type="button" aria-label="对比" data-tip={selected.length === 2 ? "对比这两张" : "和原图对比"} className={ibtn} onClick={compareSel}>
              <svg viewBox="0 0 20 20" className={ico}><rect x="3" y="4" width="14" height="12" rx="2.5" /><path d="M10 2.5v15" /><path d="M5.5 10h2M12.5 10h2" /></svg>
            </button>
          )}
          {selected.length === 1 && urlOf(selected[0]) && (
            <>
              <button type="button" aria-label="下载" data-tip="下载" className={ibtn} onClick={() => onDownload(selected[0].gid ?? null, urlOf(selected[0])!)}>
                <svg viewBox="0 0 20 20" className={ico}><path d="M10 3.5v9" /><path d="M6 8.8l4 4 4-4" /><path d="M4 16.5h12" /></svg>
              </button>
            </>
          )}
          {selected.length === 1 && <span className="mx-0.5 h-4 w-px bg-edge/10" />}
          <button type="button" aria-label="复制" data-tip="复制到旁边" className={ibtn} onClick={duplicateSel}>
            <svg viewBox="0 0 20 20" className={ico}><rect x="7" y="7" width="9.5" height="9.5" rx="2" /><rect x="3.5" y="3.5" width="9.5" height="9.5" rx="2" /></svg>
          </button>
          {onShare && <button type="button" aria-label="分享选中节点" data-tip="分享选中节点（复制口令）" className={ibtn} onClick={() => onShare(true)}>
            <svg viewBox="0 0 20 20" className={ico}><path d="M10 12V2.5M6.5 6 10 2.5 13.5 6M6.5 8.5H4v8h12v-8h-2.5" /></svg>
          </button>}
          <button type="button" aria-label="移出画布" data-tip="移出画布" className={`${ibtn} text-danger hover:bg-danger/[0.08]`} onClick={removeSel}>
            <svg viewBox="0 0 20 20" className={ico}><path d="M4 6h12" /><path d="M8 6V4.5h4V6" /><path d="M5.5 6l.8 10h7.4l.8-10" /></svg>
          </button>
        </div>
      )}

      {/* Dropped a link on empty space: what to make there. */}
      {linkMenu && (() => {
        const srcNode = nodesRef.current.find((m) => m.id === linkMenu.src);
        const item = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink hover:bg-edge/[0.05]";
        const close = () => setLinkMenu(null);
        return (
          <div
            className="animate-pop-in absolute z-30 w-52 rounded-xl bg-panel/95 p-1 shadow-[0_14px_40px_rgba(0,0,0,0.18)] ring-1 ring-edge/[0.06] backdrop-blur"
            style={{ left: Math.min(linkMenu.x, (boxRef.current?.clientWidth ?? 800) - 220), top: Math.min(linkMenu.y, (boxRef.current?.clientHeight ?? 600) - 160) }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="px-2.5 pb-1 pt-0.5 text-[11px] text-muted">连到新节点</div>
            <button type="button" className={item} onClick={() => { close(); addGen({ x: linkMenu.wx, y: linkMenu.wy - 160 }, [linkMenu.src]); }}>
              新建「生成图片」
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
            <button type="button" className={`${item} text-muted`} onClick={close}>取消</button>
          </div>
        );
      })()}

      {/* Right-click menu (用户 2026-11-10: 右键是插入节点等功能). */}
      {ctx && (() => {
        const one = ctx.node ? nodesRef.current.find((m) => m.id === ctx.node) : undefined;
        const url = one ? urlOf(one) : undefined;
        const item = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ink hover:bg-edge/[0.05]";
        const go = (f: () => void) => () => { setCtx(null); f(); };
        const W = window.innerWidth, H = window.innerHeight;
        return createPortal(
          <div
            data-canvas-menu=""
            className="animate-pop-in fixed z-[90] w-48 rounded-xl bg-panel/95 p-1 shadow-[0_14px_40px_rgba(0,0,0,0.18)] ring-1 ring-edge/[0.06] backdrop-blur"
            style={{ left: Math.min(ctx.x, W - 200), top: Math.min(ctx.y, H - (one ? 348 : 252)) }}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
          >
            {one ? (
              <>
                {onCompare && (selected.length === 2 || one.from?.length || one.gid) && <button type="button" className={item} onClick={go(compareSel)}>{selected.length === 2 ? "对比这两张" : "和原图对比"}</button>}
                {one.gid && onReedit && url && <button type="button" className={item} onClick={go(() => onReedit(one.gid!))}>重新编辑</button>}
                {one.gid && onAgain && <button type="button" className={item} onClick={go(() => onAgain(one.gid!, linkedText(one), linkedRefs(one)))}>再来一张</button>}
                {one.gid && onUpscale && <button type="button" className={item} onClick={go(() => onUpscale(one.gid!))}>高清放大 2 倍</button>}
                {url && <button type="button" className={item} onClick={go(() => onView(url))}>看大图</button>}
                {url && <button type="button" className={item} onClick={go(() => onDownload(one.gid ?? null, url))}>下载</button>}
                <div className="my-1 h-px bg-edge/[0.07]" />
                <button type="button" className={item} onClick={go(copySel)}>复制节点</button>
                <button type="button" className={item} onClick={go(duplicateSel)}>复制到旁边</button>
                {onShare && <button type="button" className={item} onClick={go(() => onShare(true))}>分享选中的{selected.length > 1 ? ` ${selected.length} 个` : "这张"}…</button>}
                <button type="button" className={`${item} text-danger`} onClick={go(removeSel)}>移出画布</button>
              </>
            ) : (
              <>
                <button type="button" className={item} onClick={go(() => addGen({ x: ctx.wx - 160, y: ctx.wy - 160 }, []))}>生成图片</button>
                <button type="button" className={item} onClick={go(() => pasteMenu({ x: ctx.wx, y: ctx.wy }))}>粘贴节点</button>
                <button type="button" className={item} onClick={go(() => addText({ x: ctx.wx, y: ctx.wy }))}>添加文本</button>
                <button type="button" className={item} onClick={go(() => { fileAt.current = { x: ctx.wx, y: ctx.wy }; fileRef.current?.click(); })}>上传图片…</button>
                {onOpenHistory && <button type="button" className={item} onClick={go(onOpenHistory)}>从历史添加</button>}
                <div className="my-1 h-px bg-edge/[0.07]" />
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
      {prefs?.map !== false && nodes.length > 0 && view.s < 0.6 && (navOn || mapHold) && boxRef.current && (() => {
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
            className="absolute bottom-3 right-3 z-20 overflow-hidden rounded-xl bg-panel/85 shadow-[0_6px_20px_rgba(0,0,0,0.12)] ring-1 ring-edge/[0.06] backdrop-blur"
            style={{ width: MW, height: MH }}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              goTo(e);
            }}
            onPointerMove={(e) => e.buttons === 1 && goTo(e)}
            onPointerEnter={() => setMapHold(true)}
            onPointerLeave={() => { setMapHold(false); nav(); }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
          >
            {nodes.map((n) => (
              <div
                key={n.id}
                className={`absolute rounded-[2px] ${sel.has(n.id) ? "bg-accent" : n.kind === "text" ? "bg-[#c7c7cc]" : "bg-[#8e8e93]"}`}
                style={{ left: ox + (n.x - x0) * k, top: oy + (n.y - y0) * k, width: Math.max(2, n.w * k), height: Math.max(2, n.h * k) }}
              />
            ))}
            <div
              className="pointer-events-none absolute rounded-[3px] border-[1.5px] border-accent bg-accent/[0.06]"
              style={{ left: ox + (vx0 - x0) * k, top: oy + (vy0 - y0) * k, width: (vx1 - vx0) * k, height: (vy1 - vy0) * k }}
            />
          </div>
        );
      })()}

      {/* Zoom controls (only when the page does not host them). */}
      {!onScale && <div
        className="absolute bottom-3 left-3 z-20 flex items-center gap-0.5 rounded-full bg-panel/90 p-0.5 text-[12px] shadow-[0_4px_16px_rgba(0,0,0,0.12)] ring-1 ring-edge/[0.06] backdrop-blur"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button type="button" aria-label="缩小" className="h-7 w-7 rounded-full hover:bg-edge/[0.06]" onClick={() => { const r = boxRef.current!.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, view.s / 1.25); }}>−</button>
        <button type="button" className="h-7 w-12 rounded-full tabular-nums hover:bg-edge/[0.06]" data-tip="回到 100%" onClick={() => { const r = boxRef.current!.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1); }}>{Math.round(view.s * 100)}%</button>
        <button type="button" aria-label="放大" className="h-7 w-7 rounded-full hover:bg-edge/[0.06]" onClick={() => { const r = boxRef.current!.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, view.s * 1.25); }}>+</button>
        <button type="button" className="h-7 rounded-full px-2.5 hover:bg-edge/[0.06]" data-tip="显示全部（Shift+1）" onClick={() => fitAll()}>适应</button>
      </div>}

      {!nodes.length && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-[13px] text-muted">
          <div className="text-[15px] font-semibold text-ink">自由画布</div>
          <div>把右边历史里的图拖进来，或从电脑拖图片进来</div>
          <div>选中图片后再生成，新图会出现在它旁边</div>
          <div className="text-[12px]">拖空白处移动画布 · 双指捏合 / ⌘+滚轮 缩放 · Shift+拖动 框选 · ⌘Z 撤销</div>
        </div>
      )}
      {dropHover && (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-[14px] border-2 border-dashed border-accent bg-accent/[0.04] text-[14px] font-medium text-accent">
          松开，放到画布上
        </div>
      )}
    </div>
  );
}

function TextNodeFooter({ text, level, setLevel, polish, replace, flash }: {
  text: string; level: CanvasDraft["polishLevel"]; setLevel: (v: CanvasDraft["polishLevel"]) => void;
  polish: (text: string, level: CanvasDraft["polishLevel"]) => Promise<string>;
  replace: (before: string, after: string) => boolean; flash: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{ before: string; after: string } | null>(null);
  const run = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      const after = await polish(text, level);
      if (after.length > 2000) throw new Error("润色结果超过 2000 字，已保留原文");
      if (replace(text, after)) setUndo({ before: text, after });
      else flash("文本已修改，已保留当前内容");
    } catch (e) { flash(e instanceof Error ? e.message : "润色失败"); }
    finally { setBusy(false); }
  };
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2 text-[11px]"
      onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <span className="mr-auto text-muted">{text.length} 字</span>
      {undo?.after === text && <button type="button" className="text-secondary" onClick={() => { replace(text, undo.before); setUndo(null); }}>撤销润色</button>}
      <div className="inline-flex items-center rounded-full bg-accent/10 text-accent">
        <button type="button" onClick={run} disabled={busy || !text.trim()} className="px-2 py-1 font-medium disabled:opacity-50">{busy ? "润色中…" : "提示词润色"}</button>
        <select aria-label="文本润色程度" value={level} onChange={(e) => setLevel(e.target.value as typeof level)}
          className="rounded-r-full border-l border-accent/25 bg-transparent py-1 pl-1">
          <option value="low">低</option><option value="medium">中</option><option value="high">高</option>
        </select>
      </div>
    </div>
  );
}
