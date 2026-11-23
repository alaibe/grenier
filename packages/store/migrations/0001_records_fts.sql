-- Full-text index on records (title, body), kept in step by triggers, with the Porter stemmer.
CREATE VIRTUAL TABLE `records_fts` USING fts5 (`title`, `body`, content = 'records', content_rowid = 'seq', tokenize = 'porter unicode61');
--> statement-breakpoint
CREATE TRIGGER `records_fts_insert` AFTER INSERT ON `records` BEGIN
  INSERT INTO `records_fts` (rowid, `title`, `body`) VALUES (new.`seq`, new.`title`, new.`body`);
END;
--> statement-breakpoint
CREATE TRIGGER `records_fts_delete` AFTER DELETE ON `records` BEGIN
  INSERT INTO `records_fts` (`records_fts`, rowid, `title`, `body`) VALUES ('delete', old.`seq`, old.`title`, old.`body`);
END;
--> statement-breakpoint
CREATE TRIGGER `records_fts_update` AFTER UPDATE OF `title`, `body` ON `records` BEGIN
  INSERT INTO `records_fts` (`records_fts`, rowid, `title`, `body`) VALUES ('delete', old.`seq`, old.`title`, old.`body`);
  INSERT INTO `records_fts` (rowid, `title`, `body`) VALUES (new.`seq`, new.`title`, new.`body`);
END;
