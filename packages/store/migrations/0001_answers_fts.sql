-- Full-text index on answers, kept in step by triggers. Drizzle's schema cannot express virtual tables or triggers.
CREATE VIRTUAL TABLE `answers_fts` USING fts5 (`question`, `answer`, content = 'answers', content_rowid = 'seq');
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
