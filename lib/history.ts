import { promises as fs } from "fs";
import path from "path";

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
 *
 * Talks to the Blobs edge directly: the @netlify/blobs client hung inside the
 * Next.js handler (its retry loop waits 5 s x 5), which timed the function out.
 */
type BlobsContext = {
  uncachedEdgeURL?: string;
  edgeURL?: string;
  token?: string;
  siteID?: string;
  primaryRegion?: string;
};

function blobsContext(): BlobsContext | null {
  const raw = process.env.NETLIFY_BLOBS_CONTEXT;
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function blobRequest(key: string): { url: string; headers: Record<string, string> } | null {
  const ctx = blobsContext();
  const base = ctx?.uncachedEdgeURL || ctx?.edgeURL;
  if (!ctx || !base || !ctx.token || !ctx.siteID) return null;
  const region = ctx.primaryRegion ? `/region:${ctx.primaryRegion}` : "";
  return {
    url: `${base}${region}/${ctx.siteID}/site:history/${key}`,
    headers: { authorization: `Bearer ${ctx.token}` },
  };
}

async function blobGet<T>(key: string): Promise<T | null> {
  const req = blobRequest(key);
  if (!req) throw new Error("历史存储不可用");
  const res = await fetch(req.url, {
    headers: req.headers,
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`历史读取失败 (${res.status})`);
  return (await res.json()) as T;
}

async function blobPut(key: string, value: unknown): Promise<void> {
  const req = blobRequest(key);
  if (!req) throw new Error("历史存储不可用");
  const res = await fetch(req.url, {
    method: "PUT",
    headers: req.headers,
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`历史写入失败 (${res.status})`);
}

function onNetlify(): boolean {
  return !!process.env.NETLIFY_BLOBS_CONTEXT;
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
  const saved = await blobGet<HistoryItem[]>(BLOB_KEY);
  if (Array.isArray(saved)) return saved;
  return readFileList();
}

async function writeAll(list: HistoryItem[]): Promise<void> {
  const next = list.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ITEMS);
  if (onNetlify()) {
    await blobPut(BLOB_KEY, next);
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
