import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The FTS5 table the custom migration makes, outside schema.ts so drizzle-kit leaves it to that migration. */
export const recordsFts = sqliteTable("records_fts", {
  id: text("id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
});
