import { createHash } from "crypto";
import { storeGet, storePut } from "./store";

/**
 * 2026-11-11 (用户: 做云端保存): free-canvas boards live on the server, so they survive a cleared browser and
 * follow the account to another computer. One small index per user and one JSON file per board.
 */
function userKey(user: string): string {
  return createHash("sha1").update(user).digest("hex").slice(0, 20);
}
function safeBoard(id: string): string {
  if (!/^[0-9A-Za-z_-]{1,32}$/.test(id)) throw new Error("画布编号不对");
  return id;
}
const idxKey = (user: string) => `canvas-idx-${userKey(user)}.json`;
const boardKeyFor = (user: string, id: string) => `canvas-${userKey(user)}-${safeBoard(id)}.json`;

async function readJson(key: string): Promise<any | null> {
  const b = await storeGet(key, 15_000).catch(() => null);
  if (!b) return null;
  try {
    return JSON.parse(b.toString("utf8"));
  } catch {
    return null;
  }
}

export type CanvasIndex = { boards: { id: string; name: string }[]; current: string; updatedAt: number; canvas?: boolean };

export async function readCanvasIndex(user: string): Promise<CanvasIndex | null> {
  return readJson(idxKey(user));
}
export async function writeCanvasIndex(user: string, idx: CanvasIndex): Promise<void> {
  const boards = (Array.isArray(idx.boards) ? idx.boards : [])
    .filter((b) => b && typeof b.id === "string" && /^[0-9A-Za-z_-]{1,32}$/.test(b.id))
    .slice(0, 50)
    .map((b) => ({ id: b.id, name: String(b.name || "画布").slice(0, 20) }));
  if (!boards.length) throw new Error("至少要有一个画布");
  const current = boards.some((b) => b.id === idx.current) ? idx.current : boards[0].id;
  // 用户 2026-11-11: 单图 / 画布 follows the account to other devices.
  const canvas = typeof idx.canvas === "boolean" ? idx.canvas : (await readCanvasIndex(user).catch(() => null))?.canvas;
  await storePut(idxKey(user), JSON.stringify({ boards, current, updatedAt: Number(idx.updatedAt) || Date.now(), ...(typeof canvas === "boolean" ? { canvas } : {}) }), "application/json");
}

export async function readBoard(user: string, id: string): Promise<{ nodes: any[]; view: any; updatedAt: number } | null> {
  return readJson(boardKeyFor(user, id));
}
const MAX_BOARD = 1_500_000; // pictures are links, so a board is small; this stops a data URL sneaking in
export async function writeBoard(user: string, id: string, data: { nodes: any[]; view: any; updatedAt: number }): Promise<void> {
  const nodes = (Array.isArray(data.nodes) ? data.nodes : []).filter((n) => !(typeof n?.src === "string" && n.src.startsWith("data:")));
  const body = JSON.stringify({ nodes, view: data.view ?? null, updatedAt: Number(data.updatedAt) || Date.now() });
  if (body.length > MAX_BOARD) throw new Error("画布太大了");
  await storePut(boardKeyFor(user, id), body, "application/json");
}
export async function deleteBoard(user: string, id: string): Promise<void> {
  // The store has no delete for every backend; an empty board is the same to the page.
  await storePut(boardKeyFor(user, id), JSON.stringify({ nodes: [], view: null, updatedAt: Date.now(), deleted: true }), "application/json");
}
