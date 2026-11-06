import { promises as fs } from "fs";
import path from "path";
import { onNetlify } from "./history";
import { storeGet, storePut } from "./store";

/**
 * 图生图 reference images, kept so a result can be compared with its source
 * later from history. Netlify Blobs in production, data/refs locally.
 */
const LOCAL_DIR = path.join(process.cwd(), "data", "refs");
const MAX_BYTES = 6 * 1024 * 1024;

function safeId(id: string): string {
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(id)) throw new Error("无效的参考图编号");
  return id;
}

export function refUrlFor(id: string): string {
  return `/api/ref/${safeId(id)}`;
}

export async function saveReference(id: string, image: Blob | Buffer): Promise<void> {
  let bytes = Buffer.isBuffer(image) ? image : Buffer.from(await image.arrayBuffer());
  if (!onNetlify()) {
    if (bytes.length > MAX_BYTES) throw new Error("参考图过大，未保存对比原图");
    await fs.mkdir(LOCAL_DIR, { recursive: true });
    await fs.writeFile(path.join(LOCAL_DIR, safeId(id)), bytes);
    return;
  }
  // 2026-11-06 (用户: 最新的图没有对比): a 3 MB reference timed out on its way to Tencent. The compare copy is
  // a WebP of at most 2048 px (a few hundred KB), and the upload is retried.
  try {
    const sharp = (await import("sharp")).default;
    bytes = await sharp(bytes).rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
  } catch {}
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      await storePut(`ref-${safeId(id)}`, bytes, "image/webp", 40_000);
      return;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

export async function readReference(id: string): Promise<Buffer | null> {
  if (!onNetlify()) {
    try {
      return await fs.readFile(path.join(LOCAL_DIR, safeId(id)));
    } catch {
      return null;
    }
  }
  return storeGet(`ref-${safeId(id)}`, 20_000);
}

export function imageMime(bytes: Buffer): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") {
    return "image/webp";
  }
  if (bytes.subarray(0, 3).toString() === "GIF") return "image/gif";
  return "application/octet-stream";
}
