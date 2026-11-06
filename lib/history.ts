import { promises as fs } from "fs";
import path from "path";
import { persistentStore, storeGet, storeKeys, storeList, storePut } from "./store";

export type HistoryStatus = "pending" | "done" | "failed" | "expired";

export type HistoryItem = {
  id: string;
  /** Account that made it (missing on records from before accounts: those belong to the owner account). */
  owner?: string;
  mode: "t2i" | "i2i";
  model?: string;
  /** Display name for models no longer offered (e.g. 即梦 4.6 from the first version). */
  label?: string;
  prompt: string;
  /** Empty while the task runs or when it failed. */
  url: string;
  status?: HistoryStatus;
  error?: string;
  /** Original RunningHub URL once `url` points at the backed-up copy. */
  sourceUrl?: string;
  /** 图生图 reference kept for the compare view, e.g. /api/ref/<taskId>. */
  refUrl?: string;
  cost?: string | null;
  seed?: number;
  taskId?: string;
  createdAt: number;
  /** Submit → finished image, in ms. */
  durationMs?: number;
  /** Starred by its owner (2026-11-05 用户: 历史加收藏). */
  fav?: boolean;
  /** Settings it was made with, in plain words (尺寸, 重绘幅度, 清晰度 …). */
  settings?: Record<string, string>;
  /** What the user typed, when 提示词优化 rewrote it into `prompt`. */
  userPrompt?: string;
  /** Removed by its owner from their history (kept in storage; the admin page still lists it). */
  deleted?: boolean;
  /** Failed attempts to copy a RunningHub image, and when the last one ran (stops endless retries). */
  backupTries?: number;
  backupAt?: number;
};

const MAX_ITEMS = 5000;
const INDEX_KEY = "items";
const ITEM_PREFIX = "item-";
// Snapshot of the history written before persistent storage existed.
const LEGACY_FILE = path.join(process.cwd(), "data", "history.json");

/**
 * History lives in the site's store (lib/store.ts: Vercel Blob, Netlify Blobs);
 * local `next dev` uses data/history.json.
 *
 * Every task is written to its own record (`item-<id>`) first, so concurrent
 * requests can never overwrite each other's records. The `items` index is a
 * read cache; on each read it is checked against the per-item records and any
 * record missing from it is merged back in.
 */
async function blobGet<T>(key: string): Promise<T | null> {
  const bytes = await storeGet(key, 8000);
  return bytes ? (JSON.parse(bytes.toString("utf8")) as T) : null;
}

async function blobPut(key: string, value: unknown): Promise<void> {
  await storePut(key, JSON.stringify(value), "application/json", 8000);
}

const blobKeys = storeKeys;

/** True on a deployed site with persistent storage. */
export function onNetlify(): boolean {
  return persistentStore();
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
  if (item.status === "failed" || item.status === "expired") return item.status;
  return "pending";
}

/** Later information wins, but a finished image is never replaced by less. */
function merge(prev: HistoryItem | undefined, next: HistoryItem): HistoryItem {
  if (!prev) return { ...next, status: statusOf(next) };
  const merged: HistoryItem = {
    ...prev,
    ...next,
    model: next.model ?? prev.model,
    label: next.label ?? prev.label,
    prompt: next.prompt || prev.prompt,
    refUrl: next.refUrl || prev.refUrl,
    // A backed-up copy (/api/img/...) always wins over a RunningHub link.
    url: [next.url, prev.url].find((u) => u?.startsWith("/api/img/")) || next.url || prev.url,
    sourceUrl: next.sourceUrl ?? prev.sourceUrl,
    cost: next.cost ?? prev.cost,
    seed: next.seed ?? prev.seed,
    durationMs: prev.durationMs ?? next.durationMs,
    owner: prev.owner ?? next.owner,
    fav: next.fav ?? prev.fav,
    settings: next.settings ?? prev.settings,
    userPrompt: next.userPrompt ?? prev.userPrompt,
    deleted: next.deleted ?? prev.deleted,
    backupTries: next.backupTries ?? prev.backupTries,
    backupAt: next.backupAt ?? prev.backupAt,
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
  let mergedIndex = merged;
  for (let attempt = 0; attempt < 3; attempt++) {
    const index = await readIndex();
    mergedIndex = merge(index.find((x) => sameTask(x, merged)), merged);
    await blobPut(INDEX_KEY, sortAndCap([mergedIndex, ...index.filter((x) => !sameTask(x, merged))]));
    // Someone else may have rewritten the index from an older copy at the same moment: check and redo.
    const check = (await readIndex()).find((x) => sameTask(x, merged));
    if (check && check.url === mergedIndex.url && check.fav === mergedIndex.fav && check.status === mergedIndex.status) break;
  }
  return mergedIndex;
}

/**
 * 2026-11-06 (用户: 删掉的图在别的设备还在): two writes at the same moment could each rewrite the index and drop
 * the other's change. Deletions are kept in their own small list as well, which reads always respect.
 */
const DELETED_KEY = "deleted.json";

export async function readDeleted(): Promise<Set<string>> {
  if (!onNetlify()) return new Set();
  const list = await blobGet<string[]>(DELETED_KEY).catch(() => null);
  return new Set(Array.isArray(list) ? list : []);
}

export async function markDeleted(ids: string | string[]): Promise<void> {
  const set = await readDeleted();
  for (const id of Array.isArray(ids) ? ids : [ids]) set.add(id);
  await blobPut(DELETED_KEY, [...set]);
}

/** Index plus any per-item record the index lost to a concurrent write. */
export async function readHistory(): Promise<HistoryItem[]> {
  const [items, deleted] = await Promise.all([readHistoryRaw(), readDeleted()]);
  return deleted.size ? items.map((x) => (deleted.has(x.id) ? { ...x, deleted: true } : x)) : items;
}

async function readHistoryRaw(): Promise<HistoryItem[]> {
  if (!onNetlify()) return sortAndCap(await readFileList());
  let listed: { key: string; mtime: number }[] = [];
  const [index, ok] = await Promise.all([
    readIndex(),
    storeList("item").then((l) => ((listed = l), true)).catch(() => false),
  ]);
  if (!ok) return sortAndCap(index);
  // 2026-11-06: two writes at once could leave the index with an older copy of a picture. Each picture's own
  // record is the truth: re-read records missing from the index and those changed in the last 2 hours (the
  // only ones a racing write can have overwritten).
  const known = new Set(index.map((x) => x.id));
  const recent = Date.now() - 2 * 3_600_000;
  const stale = listed
    .filter((x) => x.key.startsWith(ITEM_PREFIX))
    .filter((x) => !known.has(x.key.slice(ITEM_PREFIX.length)) || x.mtime > recent)
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.key.slice(ITEM_PREFIX.length));
  if (!stale.length) return sortAndCap(index);
  const fresh = (await Promise.all(stale.slice(0, 60).map((id) => blobGet<HistoryItem>(ITEM_PREFIX + id).catch(() => null)))).filter(
    (x): x is HistoryItem => !!x
  );
  const byId = new Map(index.map((x) => [x.id, x]));
  let changed = false;
  for (const f of fresh) {
    const before = byId.get(f.id);
    const after = merge(before, f);
    if (!before || JSON.stringify(before) !== JSON.stringify(after)) changed = true;
    byId.set(f.id, after);
  }
  const next = sortAndCap([...byId.values()]);
  if (changed) await blobPut(INDEX_KEY, next).catch(() => {});
  return next;
}
