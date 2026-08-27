-- 订单评价完整性：恢复 PHP oid=订单 ID 语义，并用商品快照主键承载稳定幂等。
ALTER TABLE "store_product_reply"
  ADD COLUMN IF NOT EXISTS "order_cart_info_id" INTEGER,
  ADD COLUMN IF NOT EXISTS "type" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "relation_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "sku_unique" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "reply_type" VARCHAR(32) DEFAULT 'product' NOT NULL,
  ADD COLUMN IF NOT EXISTS "reply_score" SMALLINT DEFAULT 3 NOT NULL,
  ADD COLUMN IF NOT EXISTS "delivery_score" SMALLINT,
  ADD COLUMN IF NOT EXISTS "views_num" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "merchant_reply_content" VARCHAR(500) DEFAULT '' NOT NULL;

-- 旧 TS 只保存 logistics_score；只填 NULL，确保重复执行不会覆盖后来写入的 PHP 兼容值。
UPDATE "store_product_reply"
SET "delivery_score" = "logistics_score"
WHERE "delivery_score" IS NULL;

ALTER TABLE "store_product_reply"
  ALTER COLUMN "delivery_score" SET DEFAULT 5,
  ALTER COLUMN "delivery_score" SET NOT NULL;

-- 兼容两种历史数据：PHP 的 oid=order.id 与旧 TS 的 oid=cart_info.id。
-- 只回填能唯一匹配的记录；同一快照已有多条历史评价时仅绑定最早的有效记录，不删除审计数据。
WITH matched AS (
  SELECT
    reply."id" AS reply_id,
    reply."is_del" AS is_del,
    min(cart."id") AS cart_id,
    min(cart."oid") AS order_id
  FROM "store_product_reply" AS reply
  JOIN "store_order_cart_info" AS cart
    ON cart."unique" = reply."unique"
   AND (reply."oid" = cart."oid" OR reply."oid" = cart."id")
  WHERE reply."order_cart_info_id" IS NULL
  GROUP BY reply."id", reply."is_del"
  HAVING count(*) = 1
), ranked AS (
  SELECT
    matched.*,
    row_number() OVER (
      PARTITION BY matched.cart_id
      ORDER BY matched.is_del ASC, matched.reply_id ASC
    ) AS cart_rank
  FROM matched
)
UPDATE "store_product_reply" AS reply
SET "order_cart_info_id" = ranked.cart_id,
    "oid" = ranked.order_id
FROM ranked
WHERE reply."id" = ranked.reply_id
  AND ranked.cart_rank = 1;

CREATE UNIQUE INDEX IF NOT EXISTS "spr_active_cart_uq"
  ON "store_product_reply" ("order_cart_info_id")
  WHERE "order_cart_info_id" IS NOT NULL AND "is_del" = 0;

CREATE INDEX IF NOT EXISTS "spr_order_unique"
  ON "store_product_reply" ("oid", "unique", "is_del");

CREATE INDEX IF NOT EXISTS "spr_product_active"
  ON "store_product_reply" ("product_id", "status", "is_del", "add_time");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'spr_order_cart_info_fk'
      AND conrelid = 'store_product_reply'::regclass
  ) THEN
    ALTER TABLE "store_product_reply"
      ADD CONSTRAINT "spr_order_cart_info_fk"
      FOREIGN KEY ("order_cart_info_id")
      REFERENCES "store_order_cart_info" ("id") NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'spr_scores_ck'
      AND conrelid = 'store_product_reply'::regclass
  ) THEN
    ALTER TABLE "store_product_reply"
      ADD CONSTRAINT "spr_scores_ck"
      CHECK (
        "product_score" BETWEEN 1 AND 5
        AND "service_score" BETWEEN 1 AND 5
        AND "logistics_score" BETWEEN 1 AND 5
        AND "delivery_score" BETWEEN 1 AND 5
        AND "reply_score" BETWEEN 1 AND 3
      ) NOT VALID;
  END IF;
END $$;
