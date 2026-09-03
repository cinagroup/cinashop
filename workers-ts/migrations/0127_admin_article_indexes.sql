-- Bounded CMS admin listings and article-to-category/product integrity checks.
CREATE INDEX IF NOT EXISTS "sa_admin_active_sort"
  ON "system_article" ("is_del", "sort" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "sa_admin_category_active"
  ON "system_article" ("cid", "is_del", "id" DESC);

CREATE INDEX IF NOT EXISTS "ac_admin_active_sort"
  ON "article_category" ("is_del", "sort" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "sp_platform_article_options"
  ON "store_product" ("type", "relation_id", "is_del", "id" DESC);
