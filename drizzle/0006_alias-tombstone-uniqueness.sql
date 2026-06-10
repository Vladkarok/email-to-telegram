-- Free names held by soft-deleted aliases: rename tombstones with a
-- ~del~<id> suffix (the marker is outside the alias name alphabet, so it
-- cannot collide with user input). Must run BEFORE the unique index below:
-- the known prod duplicate (inbox@…) is a pair of deleted rows.
WITH renamed AS (
	SELECT id, substr(md5(random()::text || id::text), 1, 8) AS sfx
	FROM email_addresses
	WHERE status = 'deleted' AND position('~del~' in local_part) = 0
)
UPDATE email_addresses e
SET local_part = left(e.local_part, 46) || '~del~' || r.sfx,
	full_address = left(e.local_part, 46) || '~del~' || r.sfx || '@' || split_part(e.full_address, '@', 2),
	updated_at = now()
FROM renamed r
WHERE e.id = r.id;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_alias_full_address" ON "email_addresses" USING btree (lower("full_address"));
