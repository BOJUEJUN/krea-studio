import { generationInputs, isGeneration, readDraft, uid, type BoardNode } from "./canvas-workflow";

export const nodeMime = "application/x-enzoban-canvas";
const prefix = "enzoban:canvas-nodes:v1\n";
type Clip = { selected: string[]; nodes: BoardNode[] };

// Keep upstream snapshots so a single generator can reuse its wires here or recreate them on another board.
export function copyNodes(list: BoardNode[], selection: Set<string>): Clip {
  const byId = new Map(list.map((n) => [n.id, n]));
  const selected = list.filter((n) => selection.has(n.id)).map((n) => n.id);
  const nodes = new Map<string, BoardNode>();
  const visit = (id: string) => {
    const n = byId.get(id);
    if (!n || nodes.has(id)) return;
    const from = isGeneration(n) ? generationInputs(n, list).map((m) => m.id) : n.from;
    nodes.set(id, { ...n, pendingGid: undefined, from, draft: n.draft && { ...n.draft } });
    from?.forEach(visit);
  };
  selected.forEach(visit);
  return { selected, nodes: [...nodes.values()] };
}

export const encodeNodes = (clip: Clip) => prefix + JSON.stringify(clip);
export function decodeNodes(text: string): Clip | null {
  if (!text.startsWith(prefix)) return null;
  try {
    const c = JSON.parse(text.slice(prefix.length));
    const idOk = (v: unknown) => typeof v === "string" && /^[\w-]{1,64}$/.test(v);
    if (!Array.isArray(c.nodes) || !Array.isArray(c.selected) || !c.selected.length ||
        !c.selected.every(idOk) || !c.nodes.every((n: BoardNode) => n && idOk(n.id) &&
          [n.x, n.y, n.w, n.h].every(Number.isFinite) && n.w > 0 && n.h > 0 &&
          [undefined, "gen", "result", "image", "text"].includes(n.kind) &&
          [n.text, n.src, n.gid, n.editOf].every((v) => v === undefined || typeof v === "string") &&
          (!n.from || (Array.isArray(n.from) && n.from.every(idOk))) &&
          (!n.draft || (typeof n.draft.prompt === "string" && typeof n.draft.summary === "string" &&
            Number.isFinite(n.draft.denoise) && Number.isFinite(n.draft.lora))))) return null;
    const ids = new Set(c.nodes.map((n: BoardNode) => n.id));
    if (ids.size !== c.nodes.length || !c.selected.every((id: string) => ids.has(id))) return null;
    return { ...c, nodes: c.nodes.map((n: BoardNode) => ({ ...n, draft: readDraft(n.draft) })) };
  } catch { return null; }
}

export function pasteNodes(clip: Clip, list: BoardNode[], at?: { x: number; y: number }) {
  const picked = new Set(clip.selected);
  const sources = new Map(clip.nodes.map((n) => [n.id, n]));
  const existing = new Set(list.map((n) => n.id));
  const ids = new Map<string, string>();
  const make = (id: string) => {
    const n = sources.get(id);
    if (!n || ids.has(id) || (!picked.has(id) && existing.has(id))) return;
    ids.set(id, uid());
    n.from?.forEach(make);
  };
  clip.selected.forEach(make);
  const group = clip.nodes.filter((n) => ids.has(n.id));
  const x = Math.min(...group.map((n) => n.x)), y = Math.min(...group.map((n) => n.y));
  let dx = at ? at.x - (x + Math.max(...group.map((n) => n.x + n.w))) / 2 : 32;
  let dy = at ? at.y - (y + Math.max(...group.map((n) => n.y + n.h))) / 2 : 32;
  const first = group[0];
  while (first && list.some((n) => Math.abs(n.x - first.x - dx) < 2 && Math.abs(n.y - first.y - dy) < 2)) {
    dx += 32; dy += 32;
  }
  const nodes = group.map((n) => ({
    ...n, pendingGid: undefined, id: ids.get(n.id)!, x: n.x + dx, y: n.y + dy, draft: n.draft && { ...n.draft },
    from: n.from?.flatMap((id) => ids.get(id) ?? (existing.has(id) ? [id] : [])),
  }));
  return { nodes, selected: new Set(clip.selected.map((id) => ids.get(id)!)) };
}
