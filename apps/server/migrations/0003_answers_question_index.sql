-- A pushed answer looks for a newer live answer to the same question in its repository; this keeps that a lookup.
CREATE INDEX answers_live_question ON answers (repo_id, lower(trim(question))) WHERE deleted = 0;
