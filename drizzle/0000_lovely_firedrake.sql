CREATE TABLE `generation_history` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`prompt` text NOT NULL,
	`url` text NOT NULL,
	`cost` text,
	`seed` integer,
	`task_id` text,
	`created_at` integer NOT NULL
);
