import { dailyLimit, isOwner } from "./auth";
import { readUserHistory } from "./history";

/** Start of today in Beijing time (ms). */
export function beijingDayStart(now = Date.now()): number {
  return new Date(new Date(now).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }) + "T00:00:00+08:00").getTime();
}

/**
 * 2026-11-06 (用户: 加上限): how many pictures this account started today. Deleted ones still count (deleting must not
 * give pictures back); failed and expired ones do not (they cost nothing).
 */
export async function usedToday(user: string): Promise<number> {
  const items = await readUserHistory(user);
  const start = beijingDayStart();
  return items.filter((x) => x.createdAt >= start && x.status !== "failed" && x.status !== "expired").length;
}

/** null when `count` more pictures are allowed today; otherwise the message to show. */
export async function overLimit(user: string, count: number): Promise<string | null> {
  if (await isOwner(user)) return null;
  const limit = await dailyLimit();
  if (!limit) return null;
  const used = await usedToday(user);
  if (used + count <= limit) return null;
  const left = Math.max(0, limit - used);
  return left ? `今天还能出 ${left} 张（每天上限 ${limit} 张），请少选几张` : `今天的 ${limit} 张已经用完了，明天再来吧`;
}
