import { promises as fs } from "fs";
import path from "path";
import { getStore } from "@netlify/blobs";

export type HistoryItem = {
  id: string;
  mode: "t2i" | "i2i";
  model?: string;
  prompt: string;
  /** Empty while the RunningHub task is still running. */
  url: string;
  status?: "pending" | "done";
  cost?: string | null;
  seed?: number;
  taskId?: string;
  createdAt: number;
};

const MAX_ITEMS = 300;
const BLOB_KEY = "items";
// Snapshot of the history written before persistent storage existed.
const LEGACY_FILE = path.join(process.cwd(), "data", "history.json");

/**
 * Netlify functions have a read-only, per-instance filesystem, so history
 * lives in Netlify Blobs there. Local `next dev` keeps using data/history.json.
 */
function onNetlify(): boolean {
  return !!(process.env.NETLIFY_BLOBS_CONTEXT || process.env.NETLIFY);
}

function store() {
  return getStore({ name: "history", consistency: "strong" });
}

async function readFileList(): Promise<HistoryItem[]> {
  try {
    const arr = JSON.parse(await fs.readFile(LEGACY_FILE, "utf-8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function readAll(): Promise<HistoryItem[]> {
  if (!onNetlify()) return readFileList();
  const saved = (await store().get(BLOB_KEY, { type: "json" })) as HistoryItem[] | null;
  if (Array.isArray(saved)) return saved;
  return readFileList();
}

async function writeAll(list: HistoryItem[]): Promise<void> {
  const next = list.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ITEMS);
  if (onNetlify()) {
    await store().setJSON(BLOB_KEY, next);
    return;
  }
  await fs.mkdir(path.dirname(LEGACY_FILE), { recursive: true });
  await fs.writeFile(LEGACY_FILE, JSON.stringify(next, null, 2), "utf-8");
}

function sameTask(a: HistoryItem, b: HistoryItem): boolean {
  return a.id === b.id || (!!a.taskId && a.taskId === b.taskId);
}

/** Insert or update by id / taskId; finished data wins over pending data. */
export async function upsertHistory(item: HistoryItem): Promise<HistoryItem[]> {
  const list = await readAll();
  const prev = list.find((x) => sameTask(x, item));
  const merged: HistoryItem = prev
    ? {
        ...prev,
        ...item,
        model: item.model ?? prev.model,
        url: item.url || prev.url,
        status: item.url || prev.url ? "done" : "pending",
        createdAt: prev.createdAt || item.createdAt,
      }
    : { ...item, status: item.url ? "done" : "pending" };
  await writeAll([merged, ...list.filter((x) => !sameTask(x, item))]);
  return readAll();
}

export async function removeHistory(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const list = await readAll();
  await writeAll(list.filter((x) => !ids.includes(x.id)));
}

export async function readHistory(): Promise<HistoryItem[]> {
  return readAll();
}

/** Back-compat for callers that only append finished images. */
export const appendHistory = upsertHistory;
