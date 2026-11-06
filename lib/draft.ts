/**
 * 2026-11-05 (用户: 刷新后上传的图片没了): the reference pictures and the description being written are kept in
 * this browser (IndexedDB), so a reload or a closed tab brings them back.
 */
export type Draft = { prompt: string; images: { blob: Blob; name: string }[] };

const DB = "ai-studio";
const STORE = "draft";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadDraft(user: string): Promise<Draft | null> {
  try {
    const db = await open();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(user);
      req.onsuccess = () => resolve((req.result as Draft) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function saveDraft(user: string, draft: Draft): Promise<void> {
  try {
    const db = await open();
    const tx = db.transaction(STORE, "readwrite");
    if (!draft.prompt && !draft.images.length) tx.objectStore(STORE).delete(user);
    else tx.objectStore(STORE).put(draft, user);
  } catch {}
}
