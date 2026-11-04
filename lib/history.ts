import { promises as fs } from "fs";
import path from "path";

export type HistoryStatus = "pending" | "done" | "failed";

export type HistoryItem = {
  id: string;
  mode: "t2i" | "i2i";
  model?: string;
  prompt: string;
  /** Empty while the task runs or when it failed. */
  url: string;
  status?: HistoryStatus;
  error?: string;
  /** 图生图 reference kept for the compare view, e.g. /api/ref/<taskId>. */
  refUrl?: string;
  cost?: string | null;
  seed?: number;
  taskId?: string;
  createdAt: number;
};

const MAX_ITEMS = 5000;
const INDEX_KEY = "items";
const ITEM_PREFIX = "item-";
// Snapshot of the history written before persistent storage existed.
const LEGACY_FILE = path.join(process.cwd(), "data", "history.json");

/**
 * Netlify functions have a read-only, per-instance filesystem, so history
 * lives in Netlify Blobs there; local `next dev` uses data/history.json.
 *
 * Every task is written to its own blob (`item-<id>`) first, so concurrent
 * requests can never overwrite each other's records. The `items` index is a
 * read cache; on each read it is checked against the per-item blobs and any
 * record missing from it is merged back in.
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

export function storeUrl(key = ""): { url: string; headers: Record<string, string> } {
  const ctx = blobsContext();
  const base = ctx?.uncachedEdgeURL || ctx?.edgeURL;
  if (!ctx || !base || !ctx.token || !ctx.siteID) throw new Error("历史存储不可用");
  const region = ctx.primaryRegion ? `/region:${ctx.primaryRegion}` : "";
  const suffix = key ? `/${encodeURIComponent(key)}` : "";
  return {
    url: `${base}${region}/${ctx.siteID}/site:history${suffix}`,
    headers: { authorization: `Bearer ${ctx.token}` },
  };
}

async function blobGet<T>(key: string): Promise<T | null> {
  const req = storeUrl(key);
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
  const req = storeUrl(key);
  const res = await fetch(req.url, {
    method: "PUT",
    headers: req.headers,
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`历史写入失败 (${res.status})`);
}

async function blobKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "";
  for (let page = 0; page < 50; page++) {
    const req = storeUrl();
    const qs = new URLSearchParams({ prefix });
    if (cursor) qs.set("cursor", cursor);
    const res = await fetch(`${req.url}?${qs}`, {
      headers: req.headers,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) break;
    if (!res.ok) throw new Error(`历史列表读取失败 (${res.status})`);
    const json: any = await res.json();
    for (const b of json?.blobs ?? []) if (typeof b?.key === "string") keys.push(b.key);
    if (!json?.next_cursor) break;
    cursor = json.next_cursor;
  }
  return keys;
}

export function onNetlify(): boolean {
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

function sortAndCap(list: HistoryItem[]): HistoryItem[] {
  return list.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ITEMS);
}

function sameTask(a: HistoryItem, b: HistoryItem): boolean {
  return a.id === b.id || (!!a.taskId && a.taskId === b.taskId);
}

function statusOf(item: HistoryItem): HistoryStatus {
  if (item.url) return "done";
  return item.status === "failed" ? "failed" : "pending";
}

/** Later information wins, but a finished image is never replaced by less. */
function merge(prev: HistoryItem | undefined, next: HistoryItem): HistoryItem {
  if (!prev) return { ...next, status: statusOf(next) };
  const merged: HistoryItem = {
    ...prev,
    ...next,
    model: next.model ?? prev.model,
    prompt: next.prompt || prev.prompt,
    refUrl: next.refUrl || prev.refUrl,
    url: next.url || prev.url,
    cost: next.cost ?? prev.cost,
    seed: next.seed ?? prev.seed,
    createdAt: prev.createdAt || next.createdAt,
  };
  if (merged.url) delete merged.error;
  merged.status = statusOf(merged);
  return merged;
}

async function readIndex(): Promise<HistoryItem[]> {
  const saved = await blobGet<HistoryItem[]>(INDEX_KEY);
  // Before the first write, start from the snapshot bundled with the deploy.
  return Array.isArray(saved) ? saved : readFileList();
}

/** Insert or update one task; its own blob is written before the index. */
export async function upsertHistory(item: HistoryItem): Promise<HistoryItem> {
  if (!onNetlify()) {
    const list = await readFileList();
    const merged = merge(list.find((x) => sameTask(x, item)), item);
    const next = sortAndCap([merged, ...list.filter((x) => !sameTask(x, item))]);
    await fs.mkdir(path.dirname(LEGACY_FILE), { recursive: true });
    await fs.writeFile(LEGACY_FILE, JSON.stringify(next, null, 2), "utf-8");
    return merged;
  }
  const prev = await blobGet<HistoryItem>(ITEM_PREFIX + item.id);
  const merged = merge(prev ?? undefined, item);
  await blobPut(ITEM_PREFIX + merged.id, merged);
  const index = await readIndex();
  const mergedIndex = merge(index.find((x) => sameTask(x, merged)), merged);
  await blobPut(
    INDEX_KEY,
    sortAndCap([mergedIndex, ...index.filter((x) => !sameTask(x, merged))])
  );
  return mergedIndex;
}

/** Index plus any per-item record the index lost to a concurrent write. */
export async function readHistory(): Promise<HistoryItem[]> {
  if (!onNetlify()) return sortAndCap(await readFileList());
  const index = await readIndex();
  let keys: string[] = [];
  try {
    keys = await blobKeys(ITEM_PREFIX);
  } catch {
    return sortAndCap(index);
  }
  const known = new Set(index.map((x) => x.id));
  const missing = keys.map((k) => k.slice(ITEM_PREFIX.length)).filter((id) => !known.has(id));
  if (!missing.length) return sortAndCap(index);
  const recovered = (
    await Promise.all(missing.slice(0, 50).map((id) => blobGet<HistoryItem>(ITEM_PREFIX + id)))
  ).filter((x): x is HistoryItem => !!x);
  const next = sortAndCap([...recovered, ...index]);
  await blobPut(INDEX_KEY, next).catch(() => {});
  return next;
}
