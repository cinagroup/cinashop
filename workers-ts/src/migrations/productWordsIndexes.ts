export const PRODUCT_WORDS_INDEX_SQL = `-- Owner-scoped Admin and public search-word reads. The table is a small
-- operator-curated catalog; these indexes avoid scanning Supplier/deleted rows.
CREATE INDEX IF NOT EXISTS "spw_owner_active_sort"
  ON "store_product_words" ("type", "relation_id", "is_del", "sort" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "spw_public_visible_sort"
  ON "store_product_words" ("sort" DESC, "id" DESC)
  WHERE "type" = 0 AND "relation_id" = 0 AND "is_del" = 0 AND "is_show" = 1;
`;
