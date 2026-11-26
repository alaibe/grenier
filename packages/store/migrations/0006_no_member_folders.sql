-- Folders for some members are gone: their pages go too, with what hangs on them. --
DELETE FROM `history` WHERE `record_id` IN (SELECT `id` FROM `records` WHERE `top` IN (SELECT `id` FROM `tops` WHERE `kind` = 'custom'));--> statement-breakpoint
DELETE FROM `outbox` WHERE `record_id` IN (SELECT `id` FROM `records` WHERE `top` IN (SELECT `id` FROM `tops` WHERE `kind` = 'custom'));--> statement-breakpoint
DELETE FROM `records` WHERE `top` IN (SELECT `id` FROM `tops` WHERE `kind` = 'custom');--> statement-breakpoint
DELETE FROM `tops` WHERE `kind` = 'custom';
