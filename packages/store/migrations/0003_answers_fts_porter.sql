-- The full-text index again, with the Porter stemmer, so "streaming" finds "streamed" and "streams".
DROP TRIGGER `answers_fts_insert`;
--> statement-breakpoint
DROP TRIGGER `answers_fts_delete`;
--> statement-breakpoint
DROP TRIGGER `answers_fts_update`;
--> statement-breakpoint
DROP TABLE `answers_fts`;
--> statement-breakpoint
CREATE VIRTUAL TABLE `answers_fts` USING fts5 (`question`, `answer`, content = 'answers', content_rowid = 'seq', tokenize = 'porter unicode61');
--> statement-breakpoint
CREATE TRIGGER `answers_fts_insert` AFTER INSERT ON `answers` BEGIN
  INSERT INTO `answers_fts` (rowid, `question`, `answer`) VALUES (new.`seq`, new.`question`, new.`answer`);
END;
--> statement-breakpoint
CREATE TRIGGER `answers_fts_delete` AFTER DELETE ON `answers` BEGIN
  INSERT INTO `answers_fts` (`answers_fts`, rowid, `question`, `answer`) VALUES ('delete', old.`seq`, old.`question`, old.`answer`);
END;
--> statement-breakpoint
CREATE TRIGGER `answers_fts_update` AFTER UPDATE OF `question`, `answer` ON `answers` BEGIN
  INSERT INTO `answers_fts` (`answers_fts`, rowid, `question`, `answer`) VALUES ('delete', old.`seq`, old.`question`, old.`answer`);
  INSERT INTO `answers_fts` (rowid, `question`, `answer`) VALUES (new.`seq`, new.`question`, new.`answer`);
END;
--> statement-breakpoint
INSERT INTO `answers_fts` (`answers_fts`) VALUES ('rebuild');
