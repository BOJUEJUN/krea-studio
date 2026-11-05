import { promises as fs } from "fs";
import path from "path";
import { get as blobGet, list as blobList, put as blobPut } from "@vercel/blob";

/**
 * One small key/value store for history records, image copies and references.
 *
 * - Vercel (BLOB_READ_WRITE_TOKEN set): private Vercel Blob, read uncached.
 * - Netlify (NETLIFY_BLOBS_CONTEXT set): Netlify Blobs edge API, as before.
 * - Local `next dev`: files under data/store.
 *
 * Talks to the Netlify Blobs edge directly: the @netlify/blobs client hung inside
 * the Next.js handler (its retry loop waits 5 s x 5), which timed the function out.
 */
export type StoreKind = "vercel" | "netlify" | "local";

const LOCAL_DIR = path.join(process.cwd(), "data", "store");

export function storeKind(): StoreKind {
  if (process.env.BLOB_READ_WRITE_TOKEN) return "vercel";
  if (process.env.NETLIFY_BLOBS_CONTEXT) return "netlify";
  return "local";
}

/** True when the store survives deploys (not the local folder). */
export function persistentStore(): boolean {
  return storeKind() !== "local";
}

function safeKey(key: string): string {
  if (!/^[0-9A-Za-z_.-]{1,120}$/.test(key)) throw new Error("无效的存储键");
  return key;
}

type NetlifyContext = {
  uncachedEdgeURL?: string;
  edgeURL?: string;
  token?: string;
  siteID?: string;
  primaryRegion?: string;
};

function netlifyUrl(key = ""): { url: string; headers: Record<string, string> } {
  let ctx: NetlifyContext | null = null;
  try {
    ctx = JSON.parse(Buffer.from(process.env.NETLIFY_BLOBS_CONTEXT || "", "base64").toString("utf8"));
  } catch {
    ctx = null;
  }
  const base = ctx?.uncachedEdgeURL || ctx?.edgeURL;
  if (!ctx || !base || !ctx.token || !ctx.siteID) throw new Error("存储不可用");
  const region = ctx.primaryRegion ? `/region:${ctx.primaryRegion}` : "";
  const suffix = key ? `/${encodeURIComponent(key)}` : "";
  return {
    url: `${base}${region}/${ctx.siteID}/site:history${suffix}`,
    headers: { authorization: `Bearer ${ctx.token}` },
  };
}

export async function storeGet(key: string, timeoutMs = 10_000): Promise<Buffer | null> {
  safeKey(key);
  const kind = storeKind();
  if (kind === "local") {
    try {
      return await fs.readFile(path.join(LOCAL_DIR, key));
    } catch {
      return null;
    }
  }
  if (kind === "vercel") {
    const res = await blobGet(key, { access: "private", useCache: false, abortSignal: AbortSignal.timeout(timeoutMs) });
    if (!res || res.statusCode !== 200 || !res.stream) return null;
    return Buffer.from(await new Response(res.stream).arrayBuffer());
  }
  const req = netlifyUrl(key);
  const res = await fetch(req.url, { headers: req.headers, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`存储读取失败 (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export async function storePut(
  key: string,
  body: Buffer | string,
  contentType = "application/octet-stream",
  timeoutMs = 20_000
): Promise<void> {
  safeKey(key);
  const kind = storeKind();
  if (kind === "local") {
    await fs.mkdir(LOCAL_DIR, { recursive: true });
    await fs.writeFile(path.join(LOCAL_DIR, key), body);
    return;
  }
  if (kind === "vercel") {
    await blobPut(key, body, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType,
      cacheControlMaxAge: 60,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    return;
  }
  const req = netlifyUrl(key);
  const res = await fetch(req.url, {
    method: "PUT",
    headers: req.headers,
    body: typeof body === "string" ? body : new Uint8Array(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`存储写入失败 (${res.status})`);
}

export async function storeKeys(prefix: string): Promise<string[]> {
  const kind = storeKind();
  const keys: string[] = [];
  if (kind === "local") {
    try {
      return (await fs.readdir(LOCAL_DIR)).filter((k) => k.startsWith(prefix));
    } catch {
      return [];
    }
  }
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    if (kind === "vercel") {
      const res = await blobList({ prefix, cursor, limit: 1000 });
      for (const b of res.blobs) keys.push(b.pathname);
      if (!res.hasMore || !res.cursor) break;
      cursor = res.cursor;
      continue;
    }
    const req = netlifyUrl();
    const qs = new URLSearchParams({ prefix });
    if (cursor) qs.set("cursor", cursor);
    const res = await fetch(`${req.url}?${qs}`, {
      headers: req.headers,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) break;
    if (!res.ok) throw new Error(`存储列表读取失败 (${res.status})`);
    const json: any = await res.json();
    for (const b of json?.blobs ?? []) if (typeof b?.key === "string") keys.push(b.key);
    if (!json?.next_cursor) break;
    cursor = json.next_cursor;
  }
  return keys;
}
