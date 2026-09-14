import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const generationHistory = sqliteTable("generation_history", {
  id: text("id").primaryKey(),
  mode: text("mode", { enum: ["t2i", "i2i"] }).notNull(),
  prompt: text("prompt").notNull(),
  url: text("url").notNull(),
  cost: text("cost"),
  seed: integer("seed"),
  taskId: text("task_id"),
  createdAt: integer("created_at").notNull(),
});
