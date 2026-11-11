import { pictureRefs, type CanvasLayout, type EditablePicture } from "./edit-recipe";

export type BoardNode = {
  id: string; gid?: string; src?: string;
  x: number; y: number; w: number; h: number;
  from?: string[]; fit?: boolean;
  kind?: "text" | "gen" | "result" | "image";
  text?: string; nw?: number; nh?: number; editOf?: string;
};

export const uid = () => Math.random().toString(36).slice(2, 10);
// Older boards did not mark generated previews. New, deliberately placed resources have their own kind.
export const isResult = (n: BoardNode) => n.kind === "result" || (!n.kind && !!n.gid);
export const inputsOf = (n: BoardNode, list: BoardNode[]) =>
  (n.from ?? []).map((id) => list.find((m) => m.id === id)).filter((m): m is BoardNode => !!m);
export function selectionInputs(picked: BoardNode[], list: BoardNode[]) {
  const inputs = picked.flatMap((n) => isResult(n) ? [] : n.kind === "gen" ? inputsOf(n, list) :
    n.kind === "text" ? [n] : [n, ...inputsOf(n, list)]);
  return [...new Map(inputs.map((n) => [n.id, n])).values()];
}
const box = ({ x, y, w, h }: Pick<BoardNode, "x" | "y" | "w" | "h">) => ({ x, y, w, h });

export function captureLayout(picked: BoardNode[], list: BoardNode[], urlOf: (n: BoardNode) => string | null): CanvasLayout | undefined {
  if (!picked.length || picked.every(isResult)) return;
  const frame = picked.find((n) => n.kind === "gen");
  const inputs: CanvasLayout["inputs"] = [];
  let ref = 0;
  const branch = selectionInputs(picked, list);
  const ids = new Set(branch.map((n) => n.id));
  for (const n of branch) {
    const from = isResult(n) ? undefined : n.from?.filter((id) => ids.has(id));
    if (n.kind === "text") inputs.push({ ...box(n), node: n.id, from, text: n.text ?? "" });
    else if (urlOf(n)) inputs.push({ ...box(n), node: n.id, from, ref: ref++ });
  }
  return { frame: frame ? { ...box(frame), node: frame.id } : { x: Math.max(...picked.map((n) => n.x + n.w)) + 80, y: picked[0].y, w: 320, h: 320 }, inputs };
}

/** Restore this result's input branch, keeping other work on this board. Reopening focuses the same branch. */
export function restoreWorkflow(list: BoardNode[], g: EditablePicture, urlOf: (n: BoardNode) => string | null) {
  const result = list.find((n) => isResult(n) && n.gid === g.id);
  const parents = result ? inputsOf(result, list) : [];
  const existing = list.find((n) => n.kind === "gen" && n.editOf === g.id);
  const parent = parents.find((n) => n.kind === "gen");
  const upstream = parent ? inputsOf(parent, list) : parents.flatMap((n) => isResult(n) || n.kind === "text" ? [n] : [n, ...inputsOf(n, list)]);
  const urls = pictureRefs(g);
  const texts = g.canvasLayout?.inputs.filter((i) => "text" in i) ?? [];
  if (existing && result?.from?.includes(existing.id)) return { list, frame: existing, focus: [...inputsOf(existing, list), existing, result] };

  const layout = g.canvasLayout;
  const left = list.length ? Math.max(...list.map((n) => n.x + n.w)) + 80 : -400;
  const origin = layout?.frame ?? { x: 0, y: 0, w: 320, h: 320 };
  const minX = layout?.inputs.length ? Math.min(origin.x, ...layout.inputs.map((n) => n.x)) : origin.x - 360;
  const x = result ? Math.max(result.x - origin.w - 80, ...upstream.map((n) => n.x + n.w + 80)) : list.length ? left + origin.x - minX : origin.x;
  const frameBox = existing ?? parent ?? { ...origin, x, y: result?.y ?? origin.y };
  const dx = frameBox.x - origin.x, dy = frameBox.y - origin.y;
  let y = frameBox.y;
  const position = (slot?: CanvasLayout["inputs"][number], text = false) => {
    const fallback = { x: frameBox.x - 360, y, w: 280, h: text ? 140 : 280 };
    y += fallback.h + 50;
    return slot ? { x: slot.x + dx, y: slot.y + dy, w: slot.w, h: slot.h } : fallback;
  };
  const inputs: BoardNode[] = [];
  const slotted = new Map<CanvasLayout["inputs"][number], BoardNode>();
  const upstreamImages = upstream.filter((n) => !!urlOf(n));
  for (const [i, src] of urls.entries()) {
    const slot = layout?.inputs.find((v) => "ref" in v && v.ref === i);
    const pos = position(slot);
    const old = upstreamImages.find((n) => n.id === slot?.node || urlOf(n) === src) ?? (!layout ? upstreamImages[i] : undefined);
    const input: BoardNode = old ?? { id: uid(), kind: "image", src, ...pos, fit: !slot };
    inputs.push(input);
    if (slot) slotted.set(slot, input);
  }
  // Old histories saved only their first reference; the original board may still have the others.
  const used = Number(g.settings?.["参考图"]?.match(/\d+/)?.[0] ?? (urls.length || 1));
  if (g.mode === "i2i") for (const n of upstreamImages.slice(urls.length, used)) if (!inputs.includes(n)) inputs.push(n);
  const promptTexts = texts.length ? texts : !layout && g.prompt ? [{ text: g.prompt }] : [];
  for (const t of promptTexts) {
    const pos = position("x" in t ? t : undefined, true);
    const old = upstream.find((n) => n.kind === "text" && n.text === t.text && !inputs.includes(n));
    const input: BoardNode = old ?? { id: uid(), kind: "text", text: t.text, ...pos };
    inputs.push(input);
    if ("x" in t) slotted.set(t, input);
  }
  // A new board gets the input nodes' original connections and ordering too.
  const remap = new Map([...slotted].map(([slot, n]) => [slot.node, n.id]));
  for (const [slot, n] of slotted) {
    if (slot.from?.length && !list.includes(n)) n.from = slot.from.flatMap((id) => remap.get(id) ?? []);
  }
  const ordered = layout ? layout.inputs.flatMap((slot) => slotted.get(slot) ?? []) : [];
  const from = [...new Set([...ordered, ...inputs].map((n) => n.id))];
  // Keep an original generation frame when it still has exactly these inputs.
  const same = parent && !parent.editOf && (parent.from ?? []).join("|") === from.join("|");
  const base = existing ?? (same ? parent : undefined);
  const frame: BoardNode = { ...box(base ?? frameBox), id: base?.id ?? uid(), kind: "gen", from, editOf: g.id };
  const output: BoardNode = { ...(result ?? { id: uid(), gid: g.id, x: frame.x + frame.w + 80, y: frame.y, w: 320, h: 320, fit: true }), kind: "result", from: [frame.id] };
  if (result && !base && !parent) output.x = Math.max(result.x, frame.x + frame.w + 80);
  const focus = [...inputs, frame, output];
  const replacements = new Map(focus.map((n) => [n.id, n]));
  return { list: [...list.map((n) => replacements.get(n.id) ?? n), ...focus.filter((n) => !list.some((m) => m.id === n.id))], frame, focus };
}
