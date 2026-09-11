import { promises as fs } from "fs";
import path from "path";

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

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "history.json");
const MAX_ITEMS = 200;

async function ensure() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readHistory(): Promise<HistoryItem[]> {
  try {
    const raw = await fs.readFile(FILE, "utf-8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function appendHistory(item: HistoryItem): Promise<HistoryItem[]> {
  await ensure();
  const list = await readHistory();
  // de-dupe by id
  const next = [item, ...list.filter((x) => x.id !== item.id)].slice(0, MAX_ITEMS);
  await fs.writeFile(FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}
