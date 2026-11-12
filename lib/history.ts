import type { EditMetadata } from "./edit-recipe";
import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import { ownerName } from "./auth";
import { persistentStore, storeGet, storeKeys, storeList, storePut } from "./store";

export type HistoryStatus = "pending" | "done" | "failed" | "expired";

export type HistoryItem = EditMetadata & {
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
    // The page measures from the click (includes 提示词优化 + upload), so its number wins when it has one.
    durationMs: Math.max(prev.durationMs ?? 0, next.durationMs ?? 0) || undefined,
    owner: prev.owner ?? next.owner,
    fav: next.fav ?? prev.fav,
    settings: next.settings ?? prev.settings,
    refUrls: next.refUrls ?? prev.refUrls,
    canvasLayout: next.canvasLayout ?? prev.canvasLayout,
    workspace: prev.workspace ?? next.workspace,
    editorDraft: next.editorDraft ?? prev.editorDraft,
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

/**
 * 2026-11-06 (用户: 删掉的图在别的设备还在): two writes at the same moment could each rewrite the index and drop
 * the other's change. Deletions are kept in their own small list as well, which reads always respect.
 */
const DELETED_KEY = "deleted.json";

async function readLegacyDeleted(): Promise<Set<string>> {
  if (!onNetlify()) return new Set();
  const list = await blobGet<string[]>(DELETED_KEY).catch(() => null);
  return new Set(Array.isArray(list) ? list : []);
}

// Every account's pictures, cached for 10 s on a warm server.
let historyCache: { at: number; items: HistoryItem[] } | null = null;

/** The shared list every account used before 2026-11-11; read only to move pictures into per-account lists. */
async function readLegacyRaw(): Promise<HistoryItem[]> {
  if (!onNetlify()) return sortAndCap(await readFileList());
  let listed: { key: string; mtime: number }[] = [];
  const [index, ok] = await Promise.all([
    readIndex(),
    storeList("item").then((l) => ((listed = l), true)).catch(() => false),
  ]);
  if (!ok) return sortAndCap(index);
  // 2026-11-06: two writes at once could leave the index with an older copy of a picture. Each picture's own
  // record is the truth: re-read records missing from the index and those changed in the last minutes (the
  // only ones a racing write can have overwritten). 15 minutes is plenty and keeps reads fast.
  const known = new Set(index.map((x) => x.id));
  const recent = Date.now() - 15 * 60_000;
  const stale = listed
    .filter((x) => x.key.startsWith(ITEM_PREFIX))
    .filter((x) => !known.has(x.key.slice(ITEM_PREFIX.length)) || x.mtime > recent)
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.key.slice(ITEM_PREFIX.length));
  if (!stale.length) return sortAndCap(index);
  const fresh = (await Promise.all(stale.slice(0, 24).map((id) => blobGet<HistoryItem>(ITEM_PREFIX + id).catch(() => null)))).filter(
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

/**
 * 2026-11-11 (用户: 用户多了会有什么问题): one shared list of at most 5000 pictures for every account meant old
 * pictures fell out of history once a few dozen people used the site, and every finished picture rewrote that
 * big list. Now each account has its own list (hidx-<key>), its own per-picture records (hitem-<key>-<id>, the
 * truth when two writes race) and its own deletions (hdel-<key>). The first read of an account copies its
 * pictures out of the old shared list.
 */
const MAX_PER_USER = 20000;
const userKeyOf = (user: string) => createHash("sha1").update(user).digest("hex").slice(0, 20);
const UIDX = (uk: string) => `hidx-${uk}.json`;
const UITEM = (uk: string, id: string) => `hitem-${uk}-${id}`;
const UDEL = (uk: string) => `hdel-${uk}.json`;

function capUser(list: HistoryItem[]): HistoryItem[] {
  return list.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_PER_USER);
}

async function ownerOf(item: HistoryItem): Promise<string> {
  return item.owner ?? (await ownerName()) ?? "";
}

async function userIndex(user: string): Promise<HistoryItem[]> {
  const uk = userKeyOf(user);
  const saved = await blobGet<HistoryItem[]>(UIDX(uk));
  if (Array.isArray(saved)) return saved;
  const [owner, all, del] = await Promise.all([ownerName(), readLegacyRaw(), readLegacyDeleted()]);
  const mine = capUser(all.filter((x) => (x.owner ?? owner) === user).map((x) => (del.has(x.id) ? { ...x, deleted: true } : x)));
  // Create-only: a copy written meanwhile by another request is never replaced by this older one.
  try {
    await storePut(UIDX(uk), JSON.stringify(mine), "application/json", 8000, true);
  } catch {
    const now = await blobGet<HistoryItem[]>(UIDX(uk));
    if (Array.isArray(now)) return now;
    throw new Error("历史迁移失败");
  }
  return mine;
}

async function userDeleted(user: string): Promise<Set<string>> {
  const list = await blobGet<string[]>(UDEL(userKeyOf(user))).catch(() => null);
  return new Set(Array.isArray(list) ? list : []);
}

/** The account's list plus any picture record a racing write left out of it. */
async function readUserRaw(user: string): Promise<HistoryItem[]> {
  const uk = userKeyOf(user);
  const prefix = `hitem-${uk}-`;
  let listed: { key: string; mtime: number }[] = [];
  const [index, ok] = await Promise.all([
    userIndex(user),
    storeList(prefix).then((l) => ((listed = l), true)).catch(() => false),
  ]);
  if (!ok) return index;
  const known = new Set(index.map((x) => x.id));
  const recent = Date.now() - 15 * 60_000;
  const stale = listed
    .filter((x) => !known.has(x.key.slice(prefix.length)) || x.mtime > recent)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 24)
    .map((x) => x.key);
  if (!stale.length) return index;
  const fresh = (await Promise.all(stale.map((k) => blobGet<HistoryItem>(k).catch(() => null)))).filter((x): x is HistoryItem => !!x);
  const byId = new Map(index.map((x) => [x.id, x]));
  let changed = false;
  for (const f of fresh) {
    const before = byId.get(f.id);
    const after = merge(before, f);
    if (!before || JSON.stringify(before) !== JSON.stringify(after)) changed = true;
    byId.set(f.id, after);
  }
  const next = capUser([...byId.values()]);
  if (changed) await blobPut(UIDX(uk), next).catch(() => {});
  return next;
}

const userCache = new Map<string, { at: number; items: HistoryItem[] }>();

export function forgetHistoryCache() {
  historyCache = null;
  userCache.clear();
}

/** One account's pictures (deleted ones flagged), newest first. */
export async function readUserHistory(user: string): Promise<HistoryItem[]> {
  if (!onNetlify()) {
    const owner = await ownerName();
    return sortAndCap(await readFileList()).filter((x) => (x.owner ?? owner) === user);
  }
  const hit = userCache.get(user);
  if (hit && Date.now() - hit.at < 10_000) return hit.items;
  const [raw, del] = await Promise.all([readUserRaw(user), userDeleted(user)]);
  const items = del.size ? raw.map((x) => (del.has(x.id) ? { ...x, deleted: true } : x)) : raw;
  userCache.set(user, { at: Date.now(), items });
  return items;
}

/** Every account's pictures (admin page, storage cleanup). */
export async function readHistory(): Promise<HistoryItem[]> {
  if (!onNetlify()) return sortAndCap(await readFileList());
  if (historyCache && Date.now() - historyCache.at < 10_000) return historyCache.items;
  const [legacy, legacyDel, idx] = await Promise.all([readLegacyRaw(), readLegacyDeleted(), storeList("hidx-")]);
  const byId = new Map<string, HistoryItem>(legacy.map((x) => [x.id, legacyDel.has(x.id) ? { ...x, deleted: true } : x]));
  await Promise.all(
    idx.map(async ({ key }) => {
      const uk = key.slice("hidx-".length).replace(/\.json$/, "");
      const [list, del] = await Promise.all([blobGet<HistoryItem[]>(key), blobGet<string[]>(UDEL(uk)).catch(() => null)]);
      const gone = new Set(Array.isArray(del) ? del : []);
      for (const x of Array.isArray(list) ? list : []) byId.set(x.id, gone.has(x.id) ? { ...x, deleted: true } : x);
    })
  );
  const items = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  historyCache = { at: Date.now(), items };
  return items;
}

/** Insert or update one task: its own record first, then its account's list. */
export async function upsertHistory(item: HistoryItem): Promise<HistoryItem> {
  historyCache = null;
  if (!onNetlify()) {
    const list = await readFileList();
    const merged = merge(list.find((x) => sameTask(x, item)), item);
    const next = sortAndCap([merged, ...list.filter((x) => !sameTask(x, item))]);
    await fs.mkdir(path.dirname(LEGACY_FILE), { recursive: true });
    await fs.writeFile(LEGACY_FILE, JSON.stringify(next, null, 2), "utf-8");
    return merged;
  }
  const user = await ownerOf(item);
  const uk = userKeyOf(user);
  userCache.delete(user);
  const prev = (await blobGet<HistoryItem>(UITEM(uk, item.id))) ?? (await userIndex(user)).find((x) => sameTask(x, item));
  const merged = merge(prev ?? undefined, item);
  await blobPut(UITEM(uk, merged.id), merged);
  let mergedIndex = merged;
  for (let attempt = 0; attempt < 3; attempt++) {
    const index = await userIndex(user);
    mergedIndex = merge(index.find((x) => sameTask(x, merged)), merged);
    await blobPut(UIDX(uk), capUser([mergedIndex, ...index.filter((x) => !sameTask(x, merged))]));
    const check = (await userIndex(user)).find((x) => sameTask(x, merged));
    if (check && check.url === mergedIndex.url && check.fav === mergedIndex.fav && check.status === mergedIndex.status) break;
  }
  userCache.delete(user);
  return mergedIndex;
}

/** Hide pictures from their owner's history (records stay; the admin page still lists them). */
export async function markDeleted(user: string, ids: string[]): Promise<void> {
  historyCache = null;
  userCache.delete(user);
  if (!onNetlify()) return;
  const set = await userDeleted(user);
  for (const id of ids) set.add(id);
  await blobPut(UDEL(userKeyOf(user)), [...set]);
}
