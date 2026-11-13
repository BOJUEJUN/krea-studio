"use client";

import { useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type Ref } from "react";
import { createPortal } from "react-dom";
import { normalizeMentions } from "@/lib/image-mentions";

export type MentionPicture = { n: number; url: string };
export type MentionEditorHandle = {
  element: HTMLDivElement | null;
  insertReference: (n: number) => void;
};
type Cursor = { start: number; end: number };
type DomPoint = { node: Node; offset: number };
type Snapshot = { text: string; cursor: Cursor };
const emptyCursor = { start: 0, end: 0 };

/** A plain-text representation and DOM positions, including the text of atomic picture references. */
function documentText(root: Node) {
  let text = "";
  const points: DomPoint[] = [{ node: root, offset: 0 }];
  function walk(node: Node) {
    const parent = node.parentNode!;
    const index = parent ? [...parent.childNodes].indexOf(node as ChildNode) : 0;
    if (node.nodeType === Node.TEXT_NODE) {
      for (let i = 0; i < (node.textContent?.length ?? 0); i++) {
        const char = node.textContent![i];
        if (char === "\u200b") continue;
        text += char; points.push({ node, offset: i + 1 });
      }
      return;
    }
    const el = node as HTMLElement;
    const token = el.dataset?.mention;
    if (token) {
      text += token;
      for (let i = 0; i < token.length; i++) points.push({ node: parent, offset: index + 1 });
      return;
    }
    if (node.nodeName === "BR") {
      if (root.childNodes.length === 1 && root.firstChild === node) return;
      text += "\n"; points.push({ node: parent, offset: index + 1 }); return;
    }
    if (/^(DIV|P)$/.test(node.nodeName) && text && !text.endsWith("\n")) {
      text += "\n"; points.push({ node, offset: 0 });
    }
    node.childNodes.forEach(walk);
  }
  root.childNodes.forEach(walk);
  return { text, points };
}

function cursorIn(root: HTMLElement): Cursor | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const prefix = document.createRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = documentText(prefix.cloneContents()).text.length;
  prefix.setEnd(range.endContainer, range.endOffset);
  return { start, end: documentText(prefix.cloneContents()).text.length };
}

function setCursor(root: HTMLElement, cursor: Cursor) {
  const { points } = documentText(root);
  const point = (offset: number) => points[Math.min(points.length - 1, Math.max(0, offset))];
  const start = point(cursor.start), end = point(cursor.end);
  const range = document.createRange();
  range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
  const selection = window.getSelection();
  selection?.removeAllRanges(); selection?.addRange(range);
}

export function MentionEditor({ ref, value, pictures, onChange, onPointerDown, onSubmit, onFocus, onBlur,
  className = "", style, id, placeholder, nodeText, maxLength = 8000, autoFocus }: {
  ref?: Ref<MentionEditorHandle>; value: string; pictures: MentionPicture[]; onChange: (text: string) => void;
  onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void; onSubmit?: () => void;
  onFocus?: () => void; onBlur?: () => void; className?: string; style?: CSSProperties; id?: string;
  placeholder?: string; nodeText?: boolean; maxLength?: number; autoFocus?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef(value), cursor = useRef<Cursor>(emptyCursor), composing = useRef(false), signature = useRef("");
  const history = useRef<Snapshot[]>([]), historyIndex = useRef(-1);
  const [picker, setPicker] = useState<{ at: number; style: CSSProperties } | null>(null);

  function remember() {
    const current = root.current && cursorIn(root.current);
    if (current) cursor.current = current;
  }

  function paint(text: string, selection?: Cursor) {
    const el = root.current!;
    const scrollTop = el.scrollTop, scrollLeft = el.scrollLeft;
    const focused = document.activeElement === el;
    const fragment = document.createDocumentFragment();
    for (const part of text.split(/(@图\d+)/g)) {
      if (!/^@图\d+$/.test(part)) { fragment.append(document.createTextNode(part)); continue; }
      const n = Number(part.slice(2)), picture = pictures.find((p) => p.n === n);
      const token = document.createElement("span");
      token.dataset.mention = part; token.contentEditable = "false";
      token.title = picture ? "图" + n : "缺少图" + n;
      token.setAttribute("aria-label", token.title);
      if (picture) {
        token.className = "picture-mention";
        const img = document.createElement("img");
        img.src = picture.url; img.alt = "图" + n; img.draggable = false;
        token.append(img);
      } else {
        token.className = "text-danger underline decoration-dashed underline-offset-2";
        token.textContent = part;
      }
      fragment.append(token);
    }
    fragment.append(document.createTextNode("\u200b"));
    el.replaceChildren(fragment);
    if (focused && selection) setCursor(el, selection);
    el.scrollTop = scrollTop; el.scrollLeft = scrollLeft;
    signature.current = JSON.stringify([text, pictures]);
  }

  function findPicker(text: string, selection: Cursor) {
    const el = root.current!, range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0).cloneRange() : null;
    if (!pictures.length || selection.start !== selection.end || text[selection.start - 1] !== "@" || !range) { setPicker(null); return; }
    range.collapse(true);
    const r = range.getBoundingClientRect(), fallback = el.getBoundingClientRect();
    const x = r.height ? r.left : fallback.left + 12, y = r.height ? r.bottom : fallback.top + 30;
    const width = Math.min(210, window.innerWidth - 16);
    const above = y - (r.height || 24), below = window.innerHeight - y;
    const up = below < Math.min(270, pictures.length * 46 + 12) && above > below;
    setPicker({ at: selection.start - 1, style: { width, left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      maxHeight: Math.max(48, Math.min(280, (up ? above : below) - 12)),
      ...(up ? { bottom: window.innerHeight - above + 6 } : { top: y + 6 }) } });
  }

  function accept(raw: string, position = cursorIn(root.current!) ?? cursor.current) {
    const text = normalizeMentions(raw).slice(0, maxLength);
    const selection = {
      start: Math.min(text.length, normalizeMentions(raw.slice(0, position.start)).length),
      end: Math.min(text.length, normalizeMentions(raw.slice(0, position.end)).length),
    };
    if (text !== latest.current) {
      const previous = history.current[historyIndex.current];
      if (previous) previous.cursor = cursor.current;
      const states = history.current.slice(0, historyIndex.current + 1);
      states.push({ text, cursor: selection });
      history.current = states.slice(-80); historyIndex.current = history.current.length - 1;
    }
    latest.current = text; cursor.current = selection;
    paint(text, selection);
    onChange(text);
    findPicker(text, selection);
  }

  function insert(text: string, from = cursor.current.start, to = cursor.current.end) {
    root.current!.focus({ preventScroll: true });
    const raw = latest.current.slice(0, from) + text + latest.current.slice(to);
    accept(raw, { start: from + text.length, end: from + text.length });
  }

  useImperativeHandle(ref, () => ({ element: root.current, insertReference: (n) => {
    const selection = cursor.current, from = latest.current[selection.start - 1] === "@" ? selection.start - 1 : selection.start;
    insert("@图" + n + " ", from, selection.end); setPicker(null);
  } }));

  useLayoutEffect(() => {
    if (composing.current) return;
    const text = normalizeMentions(value);
    if (signature.current !== JSON.stringify([text, pictures])) {
      const position = cursorIn(root.current!) ?? cursor.current;
      if (latest.current !== text || historyIndex.current < 0) {
        history.current = [{ text, cursor: position }]; historyIndex.current = 0;
      }
      latest.current = text;
      cursor.current = { start: Math.min(position.start, text.length), end: Math.min(position.end, text.length) };
      paint(text, cursor.current);
    }
    if (text !== value) onChange(text);
  });

  useLayoutEffect(() => { if (autoFocus) root.current?.focus({ preventScroll: true }); }, [autoFocus]);

  function keyDown(e: KeyboardEvent<HTMLDivElement>) {
    e.stopPropagation();
    if (composing.current || e.nativeEvent.isComposing) return;
    remember();
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && onSubmit) { e.preventDefault(); setPicker(null); onSubmit(); return; }
    if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
      e.preventDefault();
      const redo = e.shiftKey || e.key.toLowerCase() === "y";
      const next = historyIndex.current + (redo ? 1 : -1), snapshot = history.current[next];
      if (!snapshot) return;
      historyIndex.current = next; latest.current = snapshot.text; cursor.current = snapshot.cursor;
      paint(snapshot.text, snapshot.cursor); onChange(snapshot.text); setPicker(null); return;
    }
    if (e.key === "Escape") { e.preventDefault(); if (picker) setPicker(null); else root.current?.blur(); return; }
    if (e.key === "Enter") { e.preventDefault(); insert("\n"); }
  }

  return <>
    <div ref={root} id={id} role="textbox" aria-label={nodeText ? "文本节点内容" : "提示词"} aria-multiline="true"
      data-node-text={nodeText ? "" : undefined} data-placeholder={placeholder} data-empty={!normalizeMentions(value)}
      contentEditable suppressContentEditableWarning spellCheck={false}
      className={"mention-editor studio-text-scroll whitespace-pre-wrap break-words text-ink caret-ink outline-none " + className}
      style={style} onPointerDown={onPointerDown}
      onFocus={() => { onFocus?.(); }} onBlur={() => { remember(); setPicker(null); onBlur?.(); }}
      onBeforeInput={(e) => {
        if (composing.current) return;
        remember();
        if (/^insert(Paragraph|LineBreak)$/.test((e.nativeEvent as InputEvent).inputType)) {
          e.preventDefault(); insert("\n");
        }
      }}
      onInput={() => { if (!composing.current) accept(documentText(root.current!).text); }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; accept(documentText(root.current!).text); }}
      onKeyDown={keyDown} onKeyUp={remember} onPointerUp={remember}
      onScroll={() => setPicker(null)}
      onCopy={(e) => {
        const selected = cursorIn(root.current!);
        if (!selected || selected.start === selected.end) return;
        e.preventDefault(); e.stopPropagation();
        e.clipboardData.setData("text/plain", latest.current.slice(selected.start, selected.end));
      }}
      onCut={(e) => {
        const selected = cursorIn(root.current!);
        if (!selected || selected.start === selected.end) return;
        e.preventDefault(); e.stopPropagation();
        e.clipboardData.setData("text/plain", latest.current.slice(selected.start, selected.end));
        insert("", selected.start, selected.end);
      }}
      onPaste={(e) => {
        const text = e.clipboardData.getData("text/plain");
        if (!text) return;
        e.preventDefault(); e.stopPropagation(); remember(); insert(text.replace(/\r\n?/g, "\n"));
      }} />
    {picker && createPortal(<div role="listbox" aria-label="选择参考图" data-mention-picker=""
      className="fixed z-[110] overflow-y-auto overscroll-contain rounded-xl bg-panel p-1 shadow-[0_12px_36px_rgba(0,0,0,0.18)] ring-1 ring-edge/10"
      style={picker.style} onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {pictures.map((p) => <button key={p.n} type="button" role="option" aria-selected={false}
        onClick={() => { insert("@图" + p.n + " ", picker.at, picker.at + 1); setPicker(null); }}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-ink hover:bg-edge/[0.06]">
        <img src={p.url} alt="" draggable={false} className="max-h-10 max-w-16 rounded object-contain" />图{p.n}
      </button>)}
    </div>, document.body)}
  </>;
}
