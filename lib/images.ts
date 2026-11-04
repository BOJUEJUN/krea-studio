import { promises as fs } from "fs";
import path from "path";
import { onNetlify, storeUrl, type HistoryItem } from "./history";

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

async function save(id: string, bytes: ArrayBuffer): Promise<void> {
  if (!onNetlify()) {
    await fs.mkdir(LOCAL_DIR, { recursive: true });
    await fs.writeFile(path.join(LOCAL_DIR, safeId(id)), Buffer.from(bytes));
    return;
  }
  const req = storeUrl(`img-${safeId(id)}`);
  const res = await fetch(req.url, {
    method: "PUT",
    headers: req.headers,
    body: bytes,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`图片备份写入失败 (${res.status})`);
}

export async function readImage(id: string): Promise<Buffer | null> {
  if (!onNetlify()) {
    try {
      return await fs.readFile(path.join(LOCAL_DIR, safeId(id)));
    } catch {
      return null;
    }
  }
  const req = storeUrl(`img-${safeId(id)}`);
  const res = await fetch(req.url, {
    headers: req.headers,
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`图片读取失败 (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Copy a history item's RunningHub image into storage and point the item at
 * the copy. On any failure the item is returned unchanged (retried later).
 */
export async function withBackup(item: HistoryItem): Promise<HistoryItem> {
  if (!isRemoteImage(item.url)) return item;
  try {
    const res = await fetch(item.url, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
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
