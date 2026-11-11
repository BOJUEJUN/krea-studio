import { cosDelete, cosGet, cosList } from "./cos";
import { readHistory } from "./history";
import { storeKind } from "./store";

/**
 * 2026-11-11 (用户: 清理没用的上传图): pictures dragged or pasted onto a board are stored as `ref-cv…`.
 * Removing the node (or the whole board) leaves the file behind. Files are deleted only when they are
 * older than KEEP_DAYS and no board, unexpired share or history record mentions them anywhere.
 */
export const KEEP_DAYS = 14;

const ID_RE = /cv[0-9a-z]{8,40}/g;

async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    })
  );
  return out;
}

export type CleanupReport = { ok: true; uploads: number; uploadBytes: number; orphans: number; orphanBytes: number; deleted: number; failed: number } | { ok: false; error: string };

export async function cleanupUploads(apply: boolean): Promise<CleanupReport> {
  if (storeKind() !== "cos") return { ok: false, error: "只有腾讯云存储需要清理" };
  const [uploads, docs, history, smalls] = await Promise.all([cosList("ref-cv"), cosList("canvas-"), readHistory(), cosList("rthumb-")]);
  // An empty history means it could not be read, not that nothing uses the uploads.
  if (!history.length) return { ok: false, error: "历史没读到，这次不清理" };
  const used = new Set<string>();
  const note = (text: string) => {
    for (const m of text.matchAll(ID_RE)) used.add(m[0]);
  };
  // Every board, board list and share snapshot. A file that can't be read stops the run: never guess.
  await mapLimit(
    docs.filter((d) => d.key.endsWith(".json")),
    8,
    async (d) => {
      const b = await cosGet(d.key, 20_000);
      if (!b) return;
      const text = b.toString("utf8");
      if (d.key.startsWith("canvas-share-")) {
        try {
          const exp = Number(JSON.parse(text)?.expiresAt);
          if (exp && Date.now() >= exp) return;
        } catch {}
      }
      note(text);
    }
  );
  for (const it of history) if (!it.deleted) note(JSON.stringify(it));
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  const orphans = uploads.filter((u) => {
    const id = u.key.slice("ref-".length);
    return u.mtime > 0 && u.mtime < cutoff && !used.has(id);
  });
  let deleted = 0;
  let failed = 0;
  // Their small copies (rthumb-<w>-<id>) go with them.
  const gone = new Set(orphans.map((u) => u.key.slice("ref-".length)));
  const extra = smalls.filter((t) => gone.has(t.key.replace(/^rthumb-\d+-/, "")));
  if (apply) {
    await mapLimit([...orphans, ...extra], 6, async (u) => {
      try {
        await cosDelete(u.key);
        deleted++;
      } catch {
        failed++;
      }
    });
  }
  return {
    ok: true,
    uploads: uploads.length,
    uploadBytes: uploads.reduce((a, u) => a + u.size, 0),
    orphans: orphans.length,
    orphanBytes: [...orphans, ...extra].reduce((a, u) => a + u.size, 0),
    deleted,
    failed,
  };
}
