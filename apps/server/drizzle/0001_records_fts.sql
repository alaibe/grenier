-- Full-text index on records (title, body), with the Porter stemmer: the store writes it beside each record.
CREATE VIRTUAL TABLE `records_fts` USING fts5 (`id` UNINDEXED, `title`, `body`, tokenize = 'porter unicode61');
