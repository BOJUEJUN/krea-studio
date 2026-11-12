import { promises as fs } from "fs";
import path from "path";
import { onNetlify, type HistoryItem } from "./history";
import { storeGet, storeHas, storePut } from "./store";
import { makeThumbs } from "./thumbs";
import { after } from "next/server";
import { storeKind } from "./store";

/**
 * Permanent copies of generated images. RunningHub only keeps outputs for a
 * limited time, so every finished image is copied into the site's own
 * storage (Netlify Blobs; data/imgs locally) and served from /api/img/<id>.
 */
const LOCAL_DIR = path.join(process.cwd(), "data", "imgs");
const MAX_BYTES = 15 * 1024 * 1024;
const REMOTE = /^https:\/\/[a-z0-9.-]+\.(xiaoyaoyou\.com|runninghub\.cn)\//i;

function safeId(id: string): string {
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(id)) throw new Error("无效的图片编号");
  return id;
}

export function imageUrlFor(id: string): string {
  return `/api/img/${safeId(id)}`;
}

export function isBackedUp(url: string | undefined): boolean {
  return !!url && url.startsWith("/api/img/");
}

export function isRemoteImage(url: string | undefined): boolean {
  return !!url && REMOTE.test(url);
}

/** Store a finished image under /api/img/<id> (GPT results arrive as bytes). */
export async function saveImageBytes(id: string, bytes: Buffer): Promise<string> {
  await save(id, bytes);
  return imageUrlFor(id);
}

async function save(id: string, input: ArrayBuffer | Buffer): Promise<void> {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(new Uint8Array(input));
  if (!onNetlify()) {
    await fs.mkdir(LOCAL_DIR, { recursive: true });
    await fs.writeFile(path.join(LOCAL_DIR, safeId(id)), Buffer.from(bytes));
    return;
  }
  await putWithRetry(`img-${safeId(id)}`, Buffer.from(bytes), "image/png");
  thumbsLater(safeId(id), Buffer.from(bytes));
}

/** Big PNGs from the US to Tencent can be slow: a long limit and up to 3 tries. */
async function putWithRetry(key: string, body: Buffer, type: string): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      await storePut(key, body, type, 50_000);
      return;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** Display sizes are made after the answer is sent, so a finished picture shows at once (fallback: on demand). */
function thumbsLater(id: string, bytes: Buffer) {
  const run = () => makeThumbs(id, bytes).catch((e) => console.error("[thumbs]", id, e?.message || e));
  try {
    after(run);
  } catch {
    void run(); // outside a request (scripts)
  }
}

export async function readImage(id: string): Promise<Buffer | null> {
  if (!onNetlify()) {
    try {
      return await fs.readFile(path.join(LOCAL_DIR, safeId(id)));
    } catch {
      return null;
    }
  }
  return storeGet(`img-${safeId(id)}`, 20_000);
}

export async function hasSavedImage(id: string): Promise<boolean> {
  return onNetlify() ? storeHas(`img-${safeId(id)}`) : fs.access(path.join(LOCAL_DIR, safeId(id))).then(() => true, () => false);
}

/**
 * 2026-11-06: store a finished picture that lives on another site (RunningHub, Banana…) under /api/img/<id>.
 * The Guangzhou mover is used first because RunningHub refuses the site's US server; a direct download is the
 * fallback. Returns the site's own link.
 */
/** Make the display sizes in the background when the saved picture has none yet. */
function ensureThumbsLater(id: string) {
  const run = async () => {
    if (await storeHas(`thumb-1600-${safeId(id)}`).catch(() => true)) return;
    const bytes = await storeGet(`img-${safeId(id)}`, 40_000);
    if (bytes) await makeThumbs(safeId(id), bytes);
  };
  try {
    after(() => run().catch(() => {}));
  } catch {
    void run().catch(() => {});
  }
}

export async function copyRemoteImage(id: string, url: string): Promise<string> {
  // Already saved by an earlier poll (the page asked again while we were saving): answer at once.
  if (storeKind() === "cos" && (await storeHas(`img-${safeId(id)}`).catch(() => false))) {
    ensureThumbsLater(id);
    return imageUrlFor(id);
  }
  const fn = process.env.FETCH_FN_URL, token = process.env.FETCH_FN_TOKEN;
  if (fn && token && storeKind() === "cos") {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(fn, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, key: `img-${safeId(id)}`, token }),
          signal: AbortSignal.timeout(45_000),
        });
        const d: any = await res.json().catch(() => null);
        if (!d?.ok) throw new Error(d?.error || `搬图失败 (${res.status})`);
        // Display sizes from the stored copy, in the background.
        const run = async () => {
          const bytes = await storeGet(`img-${safeId(id)}`, 40_000);
          if (bytes) await makeThumbs(safeId(id), bytes);
        };
        try {
          after(() => run().catch(() => {}));
        } catch {
          await run().catch(() => {});
        }
        return imageUrlFor(id);
      } catch (e: any) {
        console.error("[images] mover failed:", id, attempt, e?.message || e);
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`下载结果失败 (${res.status})`);
  return saveImageBytes(id, Buffer.from(await res.arrayBuffer()));
}

/** Pictures that arrive as bytes (GPT): skip the work when an earlier poll already saved it. */
export async function saveFinishedBytes(id: string, bytes: () => Buffer): Promise<string> {
  if (storeKind() === "cos" && (await storeHas(`img-${safeId(id)}`).catch(() => false))) {
    ensureThumbsLater(id);
    return imageUrlFor(id);
  }
  return saveImageBytes(id, bytes());
}

/**
 * Copy a history item's RunningHub image into storage and point the item at
 * the copy. On any failure the item is returned unchanged (retried later).
 */
export async function withBackup(item: HistoryItem): Promise<HistoryItem> {
  if (!isRemoteImage(item.url)) return item;
  // Same single save routine as finished tasks: Tencent relay first (RunningHub refuses the US server),
  // retries, background display sizes, instant answer when it is already saved.
  try {
    const url = await copyRemoteImage(item.id, item.url);
    return { ...item, sourceUrl: item.url, url };
  } catch (e: any) {
    console.error("[images] backup failed:", item.id, e?.message || e);
    return item;
  }
}
