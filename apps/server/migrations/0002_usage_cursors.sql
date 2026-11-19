-- How far each member's machine has pushed its usage, so a batch sent again (a lost answer, two syncs at once) is
-- refused instead of counted twice. A machine is named by its own random device id.
CREATE TABLE usage_cursors (
  member_id TEXT NOT NULL,
  device TEXT NOT NULL,
  through INTEGER NOT NULL,
  PRIMARY KEY (member_id, device)
) STRICT;
