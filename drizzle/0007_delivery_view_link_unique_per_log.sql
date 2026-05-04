WITH ranked AS (
  SELECT
    id,
    row_number() OVER (PARTITION BY "delivery_log_id" ORDER BY "created_at" DESC, "id" DESC) AS rn
  FROM "delivery_view_links"
)
DELETE FROM "delivery_view_links"
USING ranked
WHERE "delivery_view_links"."id" = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX "idx_delivery_view_link_delivery_log" ON "delivery_view_links" USING btree ("delivery_log_id");
