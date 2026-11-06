import { promises as fs } from "fs";
import path from "path";
import { onNetlify, type HistoryItem } from "./history";
import { storeGet, storePut } from "./store";
import { makeThumbs } from "./thumbs";
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
  await storePut(`img-${safeId(id)}`, Buffer.from(bytes), "image/png");
  // Every display size is made now, so viewing never waits for it.
  await makeThumbs(safeId(id), Buffer.from(bytes)).catch((e) => console.error("[thumbs]", id, e?.message || e));
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

/**
 * 2026-11-06: store a finished picture that lives on another site (RunningHub, Banana…) under /api/img/<id>.
 * The Guangzhou mover is used first because RunningHub refuses the site's US server; a direct download is the
 * fallback. Returns the site's own link.
 */
export async function copyRemoteImage(id: string, url: string): Promise<string> {
  const fn = process.env.FETCH_FN_URL, token = process.env.FETCH_FN_TOKEN;
  if (fn && token && storeKind() === "cos") {
    try {
      const res = await fetch(fn, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, key: `img-${safeId(id)}`, token }),
        signal: AbortSignal.timeout(50_000),
      });
      const d: any = await res.json().catch(() => null);
      if (!d?.ok) throw new Error(d?.error || `搬图失败 (${res.status})`);
      const bytes = await storeGet(`img-${safeId(id)}`, 30_000);
      if (bytes) await makeThumbs(safeId(id), bytes).catch(() => {});
      return imageUrlFor(id);
    } catch (e: any) {
      console.error("[images] mover failed, trying direct:", id, e?.message || e);
    }
  }
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`下载结果失败 (${res.status})`);
  return saveImageBytes(id, Buffer.from(await res.arrayBuffer()));
}

/**
 * Copy a history item's RunningHub image into storage and point the item at
 * the copy. On any failure the item is returned unchanged (retried later).
 */
export async function withBackup(item: HistoryItem): Promise<HistoryItem> {
  if (!isRemoteImage(item.url)) return item;
  // 2026-11-06: RunningHub refuses downloads from the site's US server, so a small function inside Tencent's
  // Guangzhou network (tools/fetch-fn) moves the picture into COS; the sizes are made from that copy.
  const fn = process.env.FETCH_FN_URL, token = process.env.FETCH_FN_TOKEN;
  if (fn && token && storeKind() === "cos") {
    try {
      const res = await fetch(fn, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: item.url, key: `img-${safeId(item.id)}`, token }),
        signal: AbortSignal.timeout(50_000),
      });
      const d: any = await res.json().catch(() => null);
      if (!d?.ok) throw new Error(d?.error || `搬图失败 (${res.status})`);
      const bytes = await storeGet(`img-${safeId(item.id)}`, 30_000);
      if (bytes) await makeThumbs(safeId(item.id), bytes).catch((e) => console.error("[thumbs]", item.id, e?.message || e));
      return { ...item, sourceUrl: item.url, url: imageUrlFor(item.id) };
    } catch (e: any) {
      console.error("[images] mover failed:", item.id, e?.message || e);
      return item;
    }
  }
  try {
    const res = await fetch(item.url, { cache: "no-store", signal: AbortSignal.timeout(25_000) });
    if (!res.ok) throw new Error(`下载原图失败 (${res.status})`);
    const bytes = await res.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) throw new Error("原图大小异常");
    await save(item.id, bytes);
    return { ...item, sourceUrl: item.url, url: imageUrlFor(item.id) };
  } catch (e: any) {
    console.error("[images] backup failed:", item.id, e?.message || e);
    return item;
  }
}
