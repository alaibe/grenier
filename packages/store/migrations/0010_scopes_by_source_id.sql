-- A client's scope named sources by name, so a source added later under a removed one's name widened it.
-- Scopes now hold source ids: each name of an existing source becomes its id, kinds stay kinds, and a name that
-- matches no source (a source removed since) is dropped, so it can never match one added later.
UPDATE `clients` SET `scopes` = (
  SELECT coalesce(json_group_array(coalesce(`sources`.`id`, `scope`.`value`)), json('[]'))
  FROM json_each(`clients`.`scopes`) AS `scope`
  LEFT JOIN `sources` ON `sources`.`name` = `scope`.`value`
  WHERE `sources`.`id` IS NOT NULL OR `scope`.`value` IN ('notes', 'mail', 'calendar', 'memory')
);
