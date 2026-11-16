-- Full-text index on personal items (title, body, people), kept in step by triggers, with the Porter stemmer.
CREATE VIRTUAL TABLE `items_fts` USING fts5 (`title`, `body`, `people`, content = 'items', content_rowid = 'seq', tokenize = 'porter unicode61');
--> statement-breakpoint
CREATE TRIGGER `items_fts_insert` AFTER INSERT ON `items` BEGIN
  INSERT INTO `items_fts` (rowid, `title`, `body`, `people`) VALUES (new.`seq`, new.`title`, new.`body`, new.`people`);
END;
--> statement-breakpoint
CREATE TRIGGER `items_fts_delete` AFTER DELETE ON `items` BEGIN
  INSERT INTO `items_fts` (`items_fts`, rowid, `title`, `body`, `people`) VALUES ('delete', old.`seq`, old.`title`, old.`body`, old.`people`);
END;
--> statement-breakpoint
CREATE TRIGGER `items_fts_update` AFTER UPDATE OF `title`, `body`, `people` ON `items` BEGIN
  INSERT INTO `items_fts` (`items_fts`, rowid, `title`, `body`, `people`) VALUES ('delete', old.`seq`, old.`title`, old.`body`, old.`people`);
  INSERT INTO `items_fts` (rowid, `title`, `body`, `people`) VALUES (new.`seq`, new.`title`, new.`body`, new.`people`);
END;
--> statement-breakpoint
-- The approved memories live in a source of their own, so a client's scope can include them or not.
INSERT INTO `sources` (`id`, `name`, `kind`, `config`, `state`) VALUES ('memory', 'memory', 'memory', '{}', '{}');
