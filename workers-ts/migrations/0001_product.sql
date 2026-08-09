-- M2 商品域迁移
-- 对应 eb_store_product + 7 张关联表

-- 商品主表
CREATE TABLE IF NOT EXISTS "store_product" (
  "id" SERIAL PRIMARY KEY,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "product_type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "mer_id" INTEGER DEFAULT 0 NOT NULL,
  "image" VARCHAR(256) DEFAULT '' NOT NULL,
  "recommend_image" VARCHAR(256) DEFAULT '' NOT NULL,
  "slider_image" VARCHAR(5000) DEFAULT '' NOT NULL,
  "store_name" VARCHAR(256) DEFAULT '' NOT NULL,
  "store_info" VARCHAR(256) DEFAULT '' NOT NULL,
  "keyword" VARCHAR(256) DEFAULT '' NOT NULL,
  "bar_code" VARCHAR(15) DEFAULT '' NOT NULL,
  "cate_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "settle_price" NUMERIC(10, 2) DEFAULT '0.00' NOT NULL,
  "vip_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "ot_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "delivery_type" VARCHAR(255) DEFAULT '' NOT NULL,
  "freight" SMALLINT DEFAULT 2 NOT NULL,
  "postage" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "temp_id" INTEGER DEFAULT 0 NOT NULL,
  "unit_name" VARCHAR(32) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "star" NUMERIC(2, 1) DEFAULT '3.0' NOT NULL,
  "collect" INTEGER DEFAULT 0 NOT NULL,
  "ficti" INTEGER DEFAULT 100 NOT NULL,
  "sales" INTEGER DEFAULT 0 NOT NULL,
  "stock" INTEGER DEFAULT 0 NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "is_hot" SMALLINT DEFAULT 0 NOT NULL,
  "is_benefit" SMALLINT DEFAULT 0 NOT NULL,
  "is_best" SMALLINT DEFAULT 0 NOT NULL,
  "is_new" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_postage" SMALLINT DEFAULT 0 NOT NULL,
  "is_verify" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "mer_use" SMALLINT DEFAULT 0 NOT NULL,
  "give_integral" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "cost" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "is_seckill" SMALLINT DEFAULT 0 NOT NULL,
  "is_bargain" SMALLINT DEFAULT 0 NOT NULL,
  "is_good" SMALLINT DEFAULT 0 NOT NULL,
  "is_sub" SMALLINT DEFAULT 0 NOT NULL,
  "is_vip" SMALLINT DEFAULT 0 NOT NULL,
  "browse" INTEGER DEFAULT 0 NOT NULL,
  "code_path" VARCHAR(64) DEFAULT '' NOT NULL,
  "soure_link" VARCHAR(2000) DEFAULT '' NOT NULL,
  "video_open" SMALLINT DEFAULT 0 NOT NULL,
  "video_link" VARCHAR(500) DEFAULT '' NOT NULL,
  "spec_type" SMALLINT DEFAULT 0 NOT NULL,
  "activity" VARCHAR(255) DEFAULT '' NOT NULL,
  "spu" VARCHAR(13) DEFAULT '' NOT NULL,
  "label_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "command_word" VARCHAR(255) DEFAULT '' NOT NULL,
  "recommend_list" VARCHAR(256) DEFAULT '' NOT NULL,
  "brand_id" INTEGER DEFAULT 0 NOT NULL,
  "brand_com" VARCHAR(64) DEFAULT '' NOT NULL,
  "code" VARCHAR(50) DEFAULT '' NOT NULL,
  "is_vip_product" SMALLINT DEFAULT 0 NOT NULL,
  "is_presale_product" SMALLINT DEFAULT 0 NOT NULL,
  "presale_start_time" INTEGER DEFAULT 0 NOT NULL,
  "presale_end_time" INTEGER DEFAULT 0 NOT NULL,
  "presale_day" INTEGER DEFAULT 0 NOT NULL,
  "auto_on_time" INTEGER DEFAULT 0 NOT NULL,
  "auto_off_time" INTEGER DEFAULT 0 NOT NULL,
  "custom_form" TEXT,
  "system_form_id" INTEGER DEFAULT 0 NOT NULL,
  "is_support_refund" SMALLINT DEFAULT 1 NOT NULL,
  "store_label_id" TEXT,
  "ensure_id" TEXT,
  "specs" TEXT,
  "specs_id" INTEGER DEFAULT 0 NOT NULL,
  "is_limit" SMALLINT DEFAULT 0 NOT NULL,
  "limit_type" SMALLINT DEFAULT 0 NOT NULL,
  "limit_num" INTEGER DEFAULT 0 NOT NULL,
  "refusal" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_police" SMALLINT DEFAULT 0 NOT NULL,
  "is_sold" SMALLINT DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "sp_cate_id_idx" ON "store_product" ("cate_id");
CREATE INDEX IF NOT EXISTS "sp_is_del_idx" ON "store_product" ("is_del");
CREATE INDEX IF NOT EXISTS "sp_is_show_idx" ON "store_product" ("is_show");
CREATE INDEX IF NOT EXISTS "sp_sort_idx" ON "store_product" ("sort");
CREATE INDEX IF NOT EXISTS "sp_sales_idx" ON "store_product" ("sales");
CREATE INDEX IF NOT EXISTS "sp_add_time_idx" ON "store_product" ("add_time");
CREATE INDEX IF NOT EXISTS "sp_price_idx" ON "store_product" ("price");

-- 商品分类
CREATE TABLE IF NOT EXISTS "store_product_category" (
  "id" SERIAL PRIMARY KEY,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "cate_name" VARCHAR(100) DEFAULT '' NOT NULL,
  "path" VARCHAR(255) DEFAULT '' NOT NULL,
  "level" SMALLINT DEFAULT 0 NOT NULL,
  "pic" VARCHAR(128) DEFAULT '' NOT NULL,
  "big_pic" VARCHAR(255) DEFAULT '' NOT NULL,
  "adv_pic" VARCHAR(255) DEFAULT '' NOT NULL,
  "adv_link" VARCHAR(255) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "spc_pid_idx" ON "store_product_category" ("pid");
CREATE INDEX IF NOT EXISTS "spc_is_show_idx" ON "store_product_category" ("is_show");

-- 商品多态关联 (type: 1分类 2品牌 3标签)
CREATE TABLE IF NOT EXISTS "store_product_relation" (
  "id" SERIAL PRIMARY KEY,
  "type" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "relation_pid" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "spr_type_idx" ON "store_product_relation" ("type");
CREATE INDEX IF NOT EXISTS "spr_product_id_idx" ON "store_product_relation" ("product_id");
CREATE INDEX IF NOT EXISTS "spr_relation_id_idx" ON "store_product_relation" ("relation_id");

-- 品牌
CREATE TABLE IF NOT EXISTS "store_brand" (
  "id" SERIAL PRIMARY KEY,
  "brand_name" VARCHAR(100) DEFAULT '' NOT NULL,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "fid" VARCHAR(64) DEFAULT '' NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);

-- 属性组
CREATE TABLE IF NOT EXISTS "store_product_attr" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "attr_name" VARCHAR(32) DEFAULT '' NOT NULL,
  "attr_values" TEXT DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "spa_product_id_idx" ON "store_product_attr" ("product_id");

-- 属性快照
CREATE TABLE IF NOT EXISTS "store_product_attr_result" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "result" TEXT DEFAULT '' NOT NULL,
  "change_time" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "spar_product_id_idx" ON "store_product_attr_result" ("product_id");

-- SKU 行 (库存/价格权威)
CREATE TABLE IF NOT EXISTS "store_product_attr_value" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "product_type" SMALLINT DEFAULT 0 NOT NULL,
  "suk" VARCHAR(512) DEFAULT '' NOT NULL,
  "stock" INTEGER DEFAULT 0 NOT NULL,
  "sum_stock" INTEGER DEFAULT 0 NOT NULL,
  "sales" INTEGER DEFAULT 0 NOT NULL,
  "price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "settle_price" NUMERIC(10, 2) DEFAULT '0.00' NOT NULL,
  "integral" INTEGER DEFAULT 0 NOT NULL,
  "image" VARCHAR(128) DEFAULT '' NOT NULL,
  "unique" CHAR(8) DEFAULT '' NOT NULL,
  "cost" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "bar_code" VARCHAR(50) DEFAULT '' NOT NULL,
  "ot_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "vip_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "weight" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "volume" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "brokerage" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "brokerage_two" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "quota" INTEGER DEFAULT 0 NOT NULL,
  "quota_show" INTEGER DEFAULT 0 NOT NULL,
  "code" VARCHAR(50) DEFAULT '' NOT NULL,
  "disk_info" TEXT,
  "write_times" INTEGER DEFAULT 1 NOT NULL,
  "write_valid" SMALLINT DEFAULT 1 NOT NULL,
  "write_days" INTEGER DEFAULT 0 NOT NULL,
  "write_start" INTEGER DEFAULT 0 NOT NULL,
  "write_end" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "spav_unique_suk_idx" ON "store_product_attr_value" ("unique", "suk");
CREATE INDEX IF NOT EXISTS "spav_product_suk_idx" ON "store_product_attr_value" ("product_id", "suk");

-- 商品标签
CREATE TABLE IF NOT EXISTS "store_product_label" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "label_cate" INTEGER DEFAULT 0 NOT NULL,
  "label_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "style_type" SMALLINT DEFAULT 1 NOT NULL,
  "color" VARCHAR(32) DEFAULT '' NOT NULL,
  "bg_color" VARCHAR(32) DEFAULT '' NOT NULL,
  "border_color" VARCHAR(32) DEFAULT '' NOT NULL,
  "icon" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "spl_label_cate_idx" ON "store_product_label" ("label_cate");
