import { canvasImagePath, pictureRefs, pictureDraft, type CanvasLayout, type EditablePicture, type CanvasDraft } from "./edit-recipe";
export { pictureDraft, readDraft, type CanvasDraft } from "./edit-recipe";
import { reindexRegions } from "./krea-regions";
import type { GenerationIssue } from "./generation-issue";

export type BoardNode = {
  issue?: GenerationIssue;
  id: string; gid?: string; src?: string; pendingGid?: string;
  x: number; y: number; w: number; h: number;
  from?: string[]; fit?: boolean;
  kind?: "text" | "gen" | "result" | "image";
  text?: string; nw?: number; nh?: number; editOf?: string; draft?: CanvasDraft;
};

export const uid = () => Math.random().toString(36).slice(2, 10);
// Older boards did not mark generated previews. New, deliberately placed resources have their own kind.
export const isResult = (n: BoardNode) => n.kind === "result" || (!n.kind && !!n.gid);
export const isGeneration = (n: BoardNode) => n.kind === "gen" || isResult(n);
export const inputsOf = (n: BoardNode, list: BoardNode[]) =>
  (n.from ?? []).map((id) => list.find((m) => m.id === id)).filter((m): m is BoardNode => !!m);
/** Older boards put an empty generation frame between the inputs and the result. Its pictures keep their order. */
export function generationInputs(n: BoardNode, list: BoardNode[], selectedFrames?: ReadonlySet<string>) {
  const incoming = inputsOf(n, list).flatMap((m) => m.kind === "gen" && !selectedFrames?.has(m.id) ? inputsOf(m, list) : [m]);
  return [...new Map(incoming.filter((m) => m.id !== n.id).map((m) => [m.id, m])).values()];
}
export function selectedGeneration(picked: BoardNode[]) {
  return picked.length === 1 && isGeneration(picked[0]) ? picked[0] : undefined;
}

/** Keep each box on its original input when a wire or image resource is changed. */
export function updateRegionInputs(before: BoardNode[], after: BoardNode[], urlOf: (n: BoardNode) => string | null) {
  function imageKeys(frame: BoardNode, nodes: BoardNode[]) {
    return generationInputs(frame, nodes).filter((n) => urlOf(n)).map((n) =>
      isGeneration(n) ? n.id : n.id + ":" + (n.gid ?? n.src ?? ""));
  }
  return after.map((frame) => {
    const draft = frame.draft;
    if (!draft?.regions?.length) return frame;
    const old = before.find((n) => n.id === frame.id);
    if (!old || old.draft !== draft) return frame;
    const previous = imageKeys(old, before), current = imageKeys(frame, after);
    if (previous.length === current.length && previous.every((id, i) => id === current[i])) return frame;
    const regions = reindexRegions(draft.regions, (i) => current.indexOf(previous[i]));
    return { ...frame, draft: { ...draft, regions } };
  });
}
const box = ({ x, y, w, h }: Pick<BoardNode, "x" | "y" | "w" | "h">) => ({ x, y, w, h });

export function captureLayout(picked: BoardNode[], list: BoardNode[], urlOf: (n: BoardNode) => string | null, branch?: BoardNode[]): CanvasLayout | undefined {
  const frame = selectedGeneration(picked);
  if (!frame) return;
  const inputs: CanvasLayout["inputs"] = [];
  let ref = 0;
  branch ??= generationInputs(frame, list);
  const ids = new Set(branch.map((n) => n.id));
  for (const n of branch) {
    const from = isResult(n) ? undefined : n.from?.filter((id) => ids.has(id));
    if (n.kind === "text") inputs.push({ ...box(n), node: n.id, from, text: n.text ?? "" });
    else {
      const url = urlOf(n);
      if (url) inputs.push({ ...box(n), node: n.id, from, ref: ref++, source: canvasImagePath(url) });
    }
  }
  return { frame: { ...box(frame), node: frame.id }, inputs };
}

/** Restore this result's input branch, keeping other work on this board. Reopening focuses the same branch. */
export function restoreWorkflow(list: BoardNode[], g: EditablePicture, urlOf: (n: BoardNode) => string | null, snapshot = false) {
  const results = list.filter((n) => !n.pendingGid && ((isResult(n) && n.gid === g.id) ||
    (snapshot && !g.url && n.kind === "gen" && n.editOf === g.id)));
  const result = results.find((n) => n.id === g.canvasLayout?.frame.node) ?? results.find((n) => n.editOf === g.id) ?? results[0];
  const upstream = result ? generationInputs(result, list) : [];
  const urls = pictureRefs(g);
  const texts = g.canvasLayout?.inputs.filter((i) => "text" in i) ?? [];

  const layout = g.canvasLayout;
  const left = list.length ? Math.max(...list.map((n) => n.x + n.w)) + 80 : -400;
  const origin = layout?.frame ?? { x: 0, y: 0, w: 320, h: 320 };
  const minX = layout?.inputs.length ? Math.min(origin.x, ...layout.inputs.map((n) => n.x)) : origin.x - 360;
  const frameBox = result ?? { ...origin, x: list.length ? left + origin.x - minX : origin.x };
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
  const savedRefs = new Map(urls.entries());
  if (snapshot) for (const s of layout?.inputs ?? []) {
    if ("ref" in s && s.source && !savedRefs.has(s.ref)) savedRefs.set(s.ref, s.source);
  }
  for (const [i, src] of savedRefs) {
    const slot = layout?.inputs.find((v) => "ref" in v && v.ref === i);
    const pos = position(slot);
    const old = upstreamImages.find((n) => urlOf(n) === src && !inputs.includes(n)) ??
      list.find((n) => n !== result && n.id === slot?.node && !!urlOf(n) &&
        (!snapshot || ("source" in slot && urlOf(n) === slot.source)) && !inputs.includes(n)) ??
      list.find((n) => !isGeneration(n) && urlOf(n) === src && !inputs.includes(n));
    const input: BoardNode = old ?? { id: uid(), kind: "image", src, ...pos, fit: !slot };
    inputs.push(input);
    if (slot) slotted.set(slot, input);
  }
  // Old histories saved only their first reference; the original board may still have the others.
  const used = Number(g.settings?.["参考图"]?.match(/\d+/)?.[0] ?? (urls.length || 1));
  if (g.mode === "i2i") for (const n of upstreamImages.slice(urls.length, used)) if (!inputs.includes(n)) inputs.push(n);
  const editorPrompt = g.editorDraft?.regions?.length ? g.editorDraft.prompt : g.prompt;
  const promptTexts = texts.length ? texts : !layout && editorPrompt ? [{ text: editorPrompt }] : [];
  for (const t of promptTexts) {
    const pos = position("x" in t ? t : undefined, true);
    const old = upstream.find((n) => n.kind === "text" && n.text === t.text && !inputs.includes(n)) ??
      list.find((n) => "node" in t && n.id === t.node && n.kind === "text" && n.text === t.text && !inputs.includes(n));
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
  if (!snapshot && result?.editOf === g.id && result.from?.length === from.length && result.from.every((id, i) => id === from[i])) {
    return { list, frame: result, focus: [...inputs, result] };
  }
  const frame: BoardNode = { ...(result ?? { id: uid(), gid: g.id, ...box(frameBox), fit: true }), kind: "result", from, editOf: g.id };
  if (snapshot) {
    frame.draft = g.editorDraft ?? pictureDraft(g);
    if (g.url) frame.src = g.url;
    else { frame.kind = "gen"; delete frame.gid; delete frame.src; }
  }
  const focus = [...inputs, frame];
  const replacements = new Map(focus.map((n) => [n.id, n]));
  return { list: [...list.map((n) => replacements.get(n.id) ?? n), ...focus.filter((n) => !list.some((m) => m.id === n.id))], frame, focus };
}
