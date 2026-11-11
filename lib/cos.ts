import { createHash, createHmac } from "crypto";

/**
 * Tencent Cloud COS (2026-11-05 用户: 图放腾讯云): private objects under one prefix of the bucket, signed requests
 * (COS v5 signature, signature in the query). Env: COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION,
 * COS_PREFIX (e.g. "enzoban-studio/").
 */
type Conf = { id: string; key: string; bucket: string; region: string; prefix: string };

export function cosConf(): Conf | null {
  const { COS_SECRET_ID: id, COS_SECRET_KEY: key, COS_BUCKET: bucket, COS_REGION: region } = process.env;
  if (!id || !key || !bucket || !region) return null;
  // COS_PREFIX "root" = keys at the top of their own bucket (the Hong Kong bucket, 2026-11-06).
  const p = process.env.COS_PREFIX ?? "enzoban-studio/";
  return { id, key, bucket, region, prefix: p === "root" ? "" : p };
}

function host(c: Conf) {
  return `${c.bucket}.cos.${c.region}.myqcloud.com`;
}

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());

/** Signature as query string; `from`/`to` in seconds. Fixed windows keep the same URL (browser cache) all day. */
function sign(c: Conf, method: string, path: string, from: number, to: number, params: Record<string, string> = {}): string {
  const keyTime = `${from};${to}`;
  const signKey = createHmac("sha1", c.key).update(keyTime).digest("hex");
  const names = Object.keys(params).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(params).map(([k, v]) => [k.toLowerCase(), v]));
  const httpParams = names.map((k) => `${enc(k)}=${enc(lower[k])}`).join("&");
  const httpString = `${method.toLowerCase()}\n${path}\n${httpParams}\n\n`;
  const stringToSign = `sha1\n${keyTime}\n${createHash("sha1").update(httpString).digest("hex")}\n`;
  const signature = createHmac("sha1", signKey).update(stringToSign).digest("hex");
  return [
    "q-sign-algorithm=sha1",
    `q-ak=${enc(c.id)}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    "q-header-list=",
    `q-url-param-list=${enc(names.join(";"))}`,
    `q-signature=${signature}`,
  ].join("&");
}

function objectPath(c: Conf, key: string) {
  return "/" + (c.prefix + key).split("/").map(enc).join("/");
}

function url(c: Conf, method: string, key: string, ttl = 600) {
  const now = Math.floor(Date.now() / 1000);
  const path = objectPath(c, key);
  return `https://${host(c)}${path}?${sign(c, method, decodeURIComponent(path), now - 60, now + ttl)}`;
}

/** A GET link the browser can use directly; it stays the same for a whole (UTC) day so the picture is cached. */
export function cosSignedGet(key: string, params: Record<string, string> = {}): string {
  const c = cosConf()!;
  const day = 86_400;
  const start = Math.floor(Date.now() / 1000 / day) * day;
  const path = objectPath(c, key);
  const qs = Object.entries(params).map(([k, v]) => `${enc(k)}=${enc(v)}&`).join("");
  return `https://${host(c)}${path}?${qs}${sign(c, "get", decodeURIComponent(path), start - 3600, start + 2 * day, params)}`;
}

export async function cosGet(key: string, timeoutMs = 15_000): Promise<Buffer | null> {
  const c = cosConf()!;
  const res = await fetch(url(c, "get", key), { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`存储读取失败 (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Removes one object; a missing one counts as removed. */
export async function cosDelete(key: string): Promise<void> {
  const c = cosConf()!;
  const res = await fetch(url(c, "delete", key), { method: "DELETE", cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!res.ok && res.status !== 404) throw new Error(`存储删除失败 (${res.status})`);
}

export async function cosHas(key: string): Promise<boolean> {
  const c = cosConf()!;
  const res = await fetch(url(c, "head", key), { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(8000) });
  return res.ok;
}

export async function cosPut(key: string, body: Buffer | string, contentType: string, timeoutMs = 30_000, createOnly = false): Promise<void> {
  const c = cosConf()!;
  const res = await fetch(url(c, "put", key), {
    method: "PUT",
    headers: { "Content-Type": contentType, "x-cos-acl": "private", ...(createOnly ? { "x-cos-forbid-overwrite": "true" } : {}) },
    body: typeof body === "string" ? body : new Uint8Array(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`存储写入失败 (${res.status})`);
}

/** Keys (without the site prefix) that start with `prefix`. */
export async function cosKeys(prefix: string): Promise<string[]> {
  return (await cosList(prefix)).map((x) => x.key);
}

/** Keys with their last-change time (ms). */
export async function cosList(prefix: string): Promise<{ key: string; mtime: number; size: number }[]> {
  const c = cosConf()!;
  const keys: { key: string; mtime: number; size: number }[] = [];
  let marker = "";
  for (let page = 0; page < 50; page++) {
    const params: Record<string, string> = { prefix: c.prefix + prefix, "max-keys": "1000" };
    if (marker) params.marker = marker;
    const now = Math.floor(Date.now() / 1000);
    const qs = Object.entries(params).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
    const res = await fetch(`https://${host(c)}/?${qs}&${sign(c, "get", "/", now - 60, now + 600, params)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`存储列表失败 (${res.status})`);
    const xml = await res.text();
    const blocks = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => m[1]);
    const found = blocks.map((b) => b.match(/<Key>([^<]+)<\/Key>/)?.[1] ?? "").filter(Boolean);
    for (const b of blocks) {
      const k = b.match(/<Key>([^<]+)<\/Key>/)?.[1];
      if (k) keys.push({
        key: k.slice(c.prefix.length),
        mtime: Date.parse(b.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] ?? "") || 0,
        size: Number(b.match(/<Size>(\d+)<\/Size>/)?.[1]) || 0,
      });
    }
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !found.length) break;
    marker = xml.match(/<NextMarker>([^<]+)<\/NextMarker>/)?.[1] || found[found.length - 1];
  }
  return keys;
}
