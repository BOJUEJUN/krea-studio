import { promises as fs } from "fs";
import path from "path";
import { onNetlify, storeUrl } from "./history";

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

export async function saveReference(id: string, image: Blob): Promise<void> {
  const bytes = Buffer.from(await image.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error("参考图过大，未保存对比原图");
  if (!onNetlify()) {
    await fs.mkdir(LOCAL_DIR, { recursive: true });
    await fs.writeFile(path.join(LOCAL_DIR, safeId(id)), bytes);
    return;
  }
  const req = storeUrl(`ref-${safeId(id)}`);
  const res = await fetch(req.url, {
    method: "PUT",
    headers: req.headers,
    body: bytes,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`参考图保存失败 (${res.status})`);
}

export async function readReference(id: string): Promise<Buffer | null> {
  if (!onNetlify()) {
    try {
      return await fs.readFile(path.join(LOCAL_DIR, safeId(id)));
    } catch {
      return null;
    }
  }
  const req = storeUrl(`ref-${safeId(id)}`);
  const res = await fetch(req.url, {
    headers: req.headers,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`参考图读取失败 (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
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
