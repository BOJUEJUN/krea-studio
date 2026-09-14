import { env } from "cloudflare:workers";

export type HistoryItem = {
  id: string;
  mode: "t2i" | "i2i";
  prompt: string;
  url: string;
  cost?: string | null;
  seed?: number;
  taskId?: string;
  createdAt: number;
};

const MAX_ITEMS = 200;

function db(): D1Database {
  const database = env.DB;
  if (!database) throw new Error("历史记录暂时不可用");
  return database;
}

export async function readHistory(): Promise<HistoryItem[]> {
  const result = await db()
    .prepare(
      `SELECT id, mode, prompt, url, cost, seed, task_id AS taskId,
              created_at AS createdAt
         FROM generation_history
        ORDER BY created_at DESC
        LIMIT ?`
    )
    .bind(MAX_ITEMS)
    .all<HistoryItem>();
  return result.results ?? [];
}

export async function appendHistory(item: HistoryItem): Promise<HistoryItem[]> {
  const database = db();
  const statements = [
    database
      .prepare("DELETE FROM generation_history WHERE id = ? OR url = ? OR (? IS NOT NULL AND task_id = ?)")
      .bind(item.id, item.url, item.taskId ?? null, item.taskId ?? null),
    database
      .prepare(
        `INSERT INTO generation_history
          (id, mode, prompt, url, cost, seed, task_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        item.id,
        item.mode,
        item.prompt,
        item.url,
        item.cost ?? null,
        item.seed ?? null,
        item.taskId ?? null,
        item.createdAt
      ),
    database.prepare(
      `DELETE FROM generation_history
        WHERE id NOT IN (
          SELECT id FROM generation_history ORDER BY created_at DESC LIMIT 200
        )`
    ),
  ];
  await database.batch(statements);
  return readHistory();
}
