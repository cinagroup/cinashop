/**
 * 迁移执行 Service (一次性, 部署后调用一次)
 *
 * 读取 migrations/*.sql, 逐个执行。
 * 通过受 operationsAuthMiddleware 保护的 POST /api/_migrate 触发。
 * 仅允许显式调试环境和 X-Operations-Token 双重门禁下使用。
 */
import type { Container } from "@/lib/di";
import { sql } from "drizzle-orm";

export class MigrationService {
  constructor(private readonly container: Container) {}

  /** Exact embedded DDL used by isolated production-engine verification. */
  receiptPrintJobMigrationSqlForVerification(): string {
    return this.migration_0097();
  }

  /** Exact electronic-waybill DDL used by isolated production-engine verification. */
  waybillJobMigrationSqlForVerification(): string {
    return this.migration_0098();
  }

  /** Exact customer-service index DDL used by production-engine verification. */
  kefuCoreIndexMigrationSqlForVerification(): string {
    return this.migration_0099();
  }

  /** Exact realtime customer-service DDL used by production-engine verification. */
  kefuRealtimeIndexMigrationSqlForVerification(): string {
    return this.migration_0100();
  }

  /** Exact customer-service transfer audit DDL used by production-engine verification. */
  kefuTransferMigrationSqlForVerification(): string {
    return this.migration_0101();
  }

  /** Exact customer-service product-context DDL used by production-engine verification. */
  kefuProductContextMigrationSqlForVerification(): string {
    return this.migration_0102();
  }

  /** Exact customer-service order/refund-context DDL used by production-engine verification. */
  kefuOrderContextMigrationSqlForVerification(): string {
    return this.migration_0103();
  }

  /** Exact Out product replay DDL used by production-engine verification. */
  outProductWriteReplayMigrationSqlForVerification(): string {
    return this.migration_0104();
  }

  /** Exact Out coupon replay DDL used by production-engine verification. */
  outCouponWriteReplayMigrationSqlForVerification(): string {
    return this.migration_0105();
  }

  /** Exact Out user replay and ledger-guard DDL used by production verification. */
  outUserWriteReplayMigrationSqlForVerification(): string {
    return this.migration_0106();
  }

  /** Exact paid-order product-coupon reward DDL used by production verification. */
  orderProductCouponRewardMigrationSqlForVerification(): string {
    return this.migration_0107();
  }

  /** Exact legacy activity index DDL used by production-engine verification. */
  activityCompatibilityIndexMigrationSqlForVerification(): string {
    return this.migration_0108();
  }

  async runAll(): Promise<{ executed: string[]; errors: string[] }> {
    const executed: string[] = [];
    const errors: string[] = [];

    // 迁移 SQL 硬编码在代码里 (Workers 不能读文件系统)
    // 按 migration 顺序执行
    const migrations = [
      this.migration_0000(),
      this.migration_0001(),
      this.migration_0002(),
      this.migration_0003(),
      this.migration_0004(),
      this.migration_0005(),
      this.migration_0006(),
      this.migration_0007(),
      this.migration_0008(),
      this.migration_0009(),
      this.migration_0010(),
      this.migration_0011(),
      this.migration_0012(),
      this.migration_0013(),
      this.migration_0014(),
      this.migration_0015(),
      this.migration_0016(),
      this.migration_0017(),
      this.migration_0018(),
      this.migration_0019(),
      this.migration_0020(),
      this.migration_0021(),
      this.migration_0022(),
      this.migration_0023(),
      this.migration_0024(),
      this.migration_0025(),
      this.migration_0026(),
      this.migration_0027(),
      this.migration_0028(),
      this.migration_0029(),
      this.migration_0030(),
      this.migration_0031(),
      this.migration_0032(),
      this.migration_0033(),
      this.migration_0034(),
      this.migration_0035(),
      this.migration_0036(),
      this.migration_0037(),
      this.migration_0038(),
      this.migration_0039(),
      this.migration_0040(),
      this.migration_0041(),
      this.migration_0042(),
      this.migration_0043(),
      this.migration_0044(),
      this.migration_0045(),
      this.migration_0046(),
      this.migration_0047(),
      this.migration_0048(),
      this.migration_0049(),
      this.migration_0050(),
      this.migration_0051(),
      this.migration_0052(),
      this.migration_0053(),
      this.migration_0054(),
      this.migration_0055(),
      this.migration_0056(),
      this.migration_0057(),
      this.migration_0058(),
      this.migration_0059(),
      this.migration_0060(),
      this.migration_0061(),
      this.migration_0062(),
      this.migration_0063(),
      this.migration_0064(),
      this.migration_0065(),
      this.migration_0066(),
      this.migration_0067(),
      this.migration_0068(),
      this.migration_0069(),
      this.migration_0070(),
      this.migration_0071(),
      this.migration_0072(),
      this.migration_0073(),
      this.migration_0074(),
      this.migration_0075(),
      this.migration_0076(),
      this.migration_0077(),
      this.migration_0078(),
      this.migration_0079(),
      this.migration_0080(),
      this.migration_0081(),
      this.migration_0082(),
      this.migration_0083(),
      this.migration_0084(),
      this.migration_0085(),
      this.migration_0086(),
      this.migration_0087(),
      this.migration_0088(),
      this.migration_0089(),
      this.migration_0090(),
      this.migration_0091(),
      this.migration_0092(),
      this.migration_0093(),
      this.migration_0094(),
      this.migration_0095(),
      this.migration_0096(),
      this.migration_0097(),
      this.migration_0098(),
      this.migration_0099(),
      this.migration_0100(),
      this.migration_0101(),
      this.migration_0102(),
      this.migration_0103(),
      this.migration_0104(),
      this.migration_0105(),
      this.migration_0106(),
      this.migration_0107(),
      this.migration_0108(),
    ];

    for (let i = 0; i < migrations.length; i++) {
      try {
        await this.container.db.transaction(async (tx) => {
          // Hyperdrive may reuse a PostgreSQL connection whose session-level
          // search_path was changed by another client. Every migration is
          // therefore atomic and explicitly pinned to the production schema.
          await tx.execute(sql.raw("SET LOCAL search_path TO public"));
          await tx.execute(sql.raw(migrations[i]));
        });
        executed.push(String(i).padStart(4, "0"));
      } catch (e) {
        // 表已存在等错误忽略, 记录
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("already exists")) {
          executed.push(`${String(i).padStart(4, "0")} (skipped)`);
        } else {
          errors.push(`${String(i).padStart(4, "0")}: ${msg}`);
        }
      }
    }

    return { executed, errors };
  }

  // 迁移 SQL 内联 (Workers 无文件系统)
  // 只放最关键的表, 完整版读 migrations/ 目录

  private migration_0000(): string {
    return `
CREATE TABLE IF NOT EXISTS "user" (
  "uid" SERIAL PRIMARY KEY,
  "account" VARCHAR(32) DEFAULT '' NOT NULL,
  "pwd" VARCHAR(32) DEFAULT '' NOT NULL,
  "real_name" VARCHAR(25) DEFAULT '' NOT NULL,
  "birthday" INTEGER DEFAULT 0 NOT NULL,
  "card_id" VARCHAR(20) DEFAULT '' NOT NULL,
  "mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "partner_id" INTEGER DEFAULT 0 NOT NULL,
  "group_id" INTEGER DEFAULT 0 NOT NULL,
  "nickname" VARCHAR(60) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(256) DEFAULT '' NOT NULL,
  "phone" VARCHAR(15) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "add_ip" VARCHAR(16) DEFAULT '' NOT NULL,
  "last_time" INTEGER DEFAULT 0 NOT NULL,
  "last_ip" VARCHAR(16) DEFAULT '' NOT NULL,
  "now_money" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "brokerage_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "integral" INTEGER DEFAULT 0 NOT NULL,
  "exp" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "sign_num" INTEGER DEFAULT 0 NOT NULL,
  "sign_remind" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "level" INTEGER DEFAULT 0 NOT NULL,
  "agent_level" INTEGER DEFAULT 0 NOT NULL,
  "spread_open" SMALLINT DEFAULT 1 NOT NULL,
  "spread_uid" INTEGER DEFAULT 0 NOT NULL,
  "spread_time" INTEGER DEFAULT 0 NOT NULL,
  "spread_lottery" INTEGER DEFAULT 1 NOT NULL,
  "work_uid" INTEGER DEFAULT 0 NOT NULL,
  "work_userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "user_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "is_promoter" SMALLINT DEFAULT 0 NOT NULL,
  "pay_count" INTEGER DEFAULT 0 NOT NULL,
  "spread_count" INTEGER DEFAULT 0 NOT NULL,
  "clean_time" INTEGER DEFAULT 0 NOT NULL,
  "addres" VARCHAR(255) DEFAULT '' NOT NULL,
  "adminid" INTEGER DEFAULT 0 NOT NULL,
  "login_type" VARCHAR(36) DEFAULT '' NOT NULL,
  "login_city" VARCHAR(255) DEFAULT '' NOT NULL,
  "record_phone" VARCHAR(11) DEFAULT '' NOT NULL,
  "is_money_level" SMALLINT DEFAULT 0 NOT NULL,
  "is_ever_level" SMALLINT DEFAULT 0 NOT NULL,
  "overdue_time" INTEGER DEFAULT 0 NOT NULL,
  "uniqid" VARCHAR(32) DEFAULT '' NOT NULL,
  "bar_code" VARCHAR(32) DEFAULT '' NOT NULL,
  "rand_code" INTEGER DEFAULT 0 NOT NULL,
  "sex" SMALLINT DEFAULT 0 NOT NULL,
  "provincials" VARCHAR(255) DEFAULT '' NOT NULL,
  "province" INTEGER DEFAULT 0 NOT NULL,
  "city" INTEGER DEFAULT 0 NOT NULL,
  "area" INTEGER DEFAULT 0 NOT NULL,
  "street" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "delete_time" TIMESTAMP,
  "extend_info" TEXT,
  "level_status" SMALLINT DEFAULT 0 NOT NULL,
  "level_extend_info" TEXT,
  "is_first_order" SMALLINT DEFAULT 0 NOT NULL,
  "is_newcomer" SMALLINT DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "system_config" (
  "id" SERIAL PRIMARY KEY,
  "is_store" SMALLINT DEFAULT 0 NOT NULL,
  "menu_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "type" VARCHAR(255) DEFAULT '' NOT NULL,
  "input_type" VARCHAR(20) DEFAULT 'input' NOT NULL,
  "config_tab_id" INTEGER DEFAULT 0 NOT NULL,
  "parameter" VARCHAR(255) DEFAULT '' NOT NULL,
  "upload_type" SMALLINT DEFAULT 1 NOT NULL,
  "required" VARCHAR(255) DEFAULT '' NOT NULL,
  "width" INTEGER DEFAULT 0 NOT NULL,
  "high" INTEGER DEFAULT 0 NOT NULL,
  "value" VARCHAR(5000) DEFAULT '' NOT NULL,
  "info" VARCHAR(255) DEFAULT '' NOT NULL,
  "desc" VARCHAR(255) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL
);
-- system_config.menu_name 只有普通索引，没有唯一约束；ON CONFLICT 无法防止
-- 重复 seed。只在全局配置缺失时补默认值，已有生产配置始终优先。
INSERT INTO "system_config" ("menu_name", "value", "info")
SELECT seed.menu_name, seed.value, seed.info
FROM (VALUES
  ('record_No', '京ICP备12345678号', '网站备案号'),
  ('site_url', 'https://cinashop.example.com', '站点URL'),
  ('sign_give_point', '1', '签到基础积分'),
  ('sign_status', '1', '签到开关'),
  ('system_delivery_time', '7', '自动收货天数'),
  ('system_comment_time', '7', '自动评价天数')
) AS seed(menu_name, value, info)
WHERE NOT EXISTS (
  SELECT 1 FROM "system_config" existing
  WHERE existing."menu_name" = seed.menu_name AND existing."is_store" = 0
);
`;
  }

  private migration_0001(): string {
    return `
CREATE TABLE IF NOT EXISTS "store_product" (
  "id" SERIAL PRIMARY KEY,
  "pid" INTEGER DEFAULT 0 NOT NULL, "type" SMALLINT DEFAULT 0 NOT NULL,
  "product_type" SMALLINT DEFAULT 0 NOT NULL, "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "mer_id" INTEGER DEFAULT 0 NOT NULL, "image" VARCHAR(256) DEFAULT '' NOT NULL,
  "recommend_image" VARCHAR(256) DEFAULT '' NOT NULL,
  "slider_image" VARCHAR(5000) DEFAULT '' NOT NULL,
  "store_name" VARCHAR(256) DEFAULT '' NOT NULL,
  "store_info" VARCHAR(256) DEFAULT '' NOT NULL, "keyword" VARCHAR(256) DEFAULT '' NOT NULL,
  "bar_code" VARCHAR(15) DEFAULT '' NOT NULL, "cate_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "settle_price" NUMERIC(10,2) DEFAULT '0.00' NOT NULL,
  "vip_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "ot_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "delivery_type" VARCHAR(255) DEFAULT '' NOT NULL, "freight" SMALLINT DEFAULT 2 NOT NULL,
  "postage" NUMERIC(12,2) DEFAULT '0.00' NOT NULL, "temp_id" INTEGER DEFAULT 0 NOT NULL,
  "unit_name" VARCHAR(32) DEFAULT '' NOT NULL, "sort" INTEGER DEFAULT 0 NOT NULL,
  "star" NUMERIC(2,1) DEFAULT '3.0' NOT NULL, "collect" INTEGER DEFAULT 0 NOT NULL,
  "ficti" INTEGER DEFAULT 100 NOT NULL, "sales" INTEGER DEFAULT 0 NOT NULL,
  "stock" INTEGER DEFAULT 0 NOT NULL, "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "is_hot" SMALLINT DEFAULT 0 NOT NULL, "is_benefit" SMALLINT DEFAULT 0 NOT NULL,
  "is_best" SMALLINT DEFAULT 0 NOT NULL, "is_new" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL, "is_postage" SMALLINT DEFAULT 0 NOT NULL,
  "is_verify" SMALLINT DEFAULT 0 NOT NULL, "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "mer_use" SMALLINT DEFAULT 0 NOT NULL,
  "give_integral" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "cost" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "is_seckill" SMALLINT DEFAULT 0 NOT NULL, "is_bargain" SMALLINT DEFAULT 0 NOT NULL,
  "is_good" SMALLINT DEFAULT 0 NOT NULL, "is_sub" SMALLINT DEFAULT 0 NOT NULL,
  "is_vip" SMALLINT DEFAULT 0 NOT NULL, "browse" INTEGER DEFAULT 0 NOT NULL,
  "code_path" VARCHAR(64) DEFAULT '' NOT NULL,
  "soure_link" VARCHAR(2000) DEFAULT '' NOT NULL,
  "video_open" SMALLINT DEFAULT 0 NOT NULL, "video_link" VARCHAR(500) DEFAULT '' NOT NULL,
  "spec_type" SMALLINT DEFAULT 0 NOT NULL, "activity" VARCHAR(255) DEFAULT '' NOT NULL,
  "spu" VARCHAR(13) DEFAULT '' NOT NULL, "label_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "command_word" VARCHAR(255) DEFAULT '' NOT NULL,
  "recommend_list" VARCHAR(256) DEFAULT '' NOT NULL,
  "brand_id" INTEGER DEFAULT 0 NOT NULL, "brand_com" VARCHAR(64) DEFAULT '' NOT NULL,
  "code" VARCHAR(50) DEFAULT '' NOT NULL,
  "is_vip_product" SMALLINT DEFAULT 0 NOT NULL,
  "is_presale_product" SMALLINT DEFAULT 0 NOT NULL,
  "presale_start_time" INTEGER DEFAULT 0 NOT NULL,
  "presale_end_time" INTEGER DEFAULT 0 NOT NULL, "presale_day" INTEGER DEFAULT 0 NOT NULL,
  "auto_on_time" INTEGER DEFAULT 0 NOT NULL, "auto_off_time" INTEGER DEFAULT 0 NOT NULL,
  "custom_form" TEXT, "system_form_id" INTEGER DEFAULT 0 NOT NULL,
  "is_support_refund" SMALLINT DEFAULT 1 NOT NULL,
  "store_label_id" TEXT, "ensure_id" TEXT, "specs" TEXT,
  "specs_id" INTEGER DEFAULT 0 NOT NULL, "is_limit" SMALLINT DEFAULT 0 NOT NULL,
  "limit_type" SMALLINT DEFAULT 0 NOT NULL, "limit_num" INTEGER DEFAULT 0 NOT NULL,
  "refusal" VARCHAR(255) DEFAULT '' NOT NULL, "is_police" SMALLINT DEFAULT 0 NOT NULL,
  "is_sold" SMALLINT DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_product_category" (
  "id" SERIAL PRIMARY KEY, "pid" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL, "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "cate_name" VARCHAR(100) DEFAULT '' NOT NULL, "path" VARCHAR(255) DEFAULT '' NOT NULL,
  "level" SMALLINT DEFAULT 0 NOT NULL, "pic" VARCHAR(128) DEFAULT '' NOT NULL,
  "big_pic" VARCHAR(255) DEFAULT '' NOT NULL, "adv_pic" VARCHAR(255) DEFAULT '' NOT NULL,
  "adv_link" VARCHAR(255) DEFAULT '' NOT NULL, "sort" INTEGER DEFAULT 0 NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL, "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_product_relation" (
  "id" SERIAL PRIMARY KEY, "type" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL, "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "relation_pid" INTEGER DEFAULT 0 NOT NULL, "status" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_product_attr_value" (
  "id" SERIAL PRIMARY KEY, "product_id" INTEGER DEFAULT 0 NOT NULL,
  "product_type" SMALLINT DEFAULT 0 NOT NULL, "suk" VARCHAR(512) DEFAULT '' NOT NULL,
  "stock" INTEGER DEFAULT 0 NOT NULL, "sum_stock" INTEGER DEFAULT 0 NOT NULL,
  "sales" INTEGER DEFAULT 0 NOT NULL,
  "price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "settle_price" NUMERIC(10,2) DEFAULT '0.00' NOT NULL, "integral" INTEGER DEFAULT 0 NOT NULL,
  "image" VARCHAR(128) DEFAULT '' NOT NULL, "unique" CHAR(8) DEFAULT '' NOT NULL,
  "cost" NUMERIC(12,2) DEFAULT '0.00' NOT NULL, "bar_code" VARCHAR(50) DEFAULT '' NOT NULL,
  "ot_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "vip_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "weight" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "volume" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "brokerage" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "brokerage_two" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL, "quota" INTEGER DEFAULT 0 NOT NULL,
  "quota_show" INTEGER DEFAULT 0 NOT NULL, "code" VARCHAR(50) DEFAULT '' NOT NULL,
  "disk_info" TEXT, "write_times" INTEGER DEFAULT 1 NOT NULL,
  "write_valid" SMALLINT DEFAULT 1 NOT NULL, "write_days" INTEGER DEFAULT 0 NOT NULL,
  "write_start" INTEGER DEFAULT 0 NOT NULL, "write_end" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_product_attr" (
  "id" SERIAL PRIMARY KEY, "product_id" INTEGER DEFAULT 0 NOT NULL,
  "attr_name" VARCHAR(32) DEFAULT '' NOT NULL, "attr_values" TEXT DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_product_attr_result" (
  "id" SERIAL PRIMARY KEY, "product_id" INTEGER DEFAULT 0 NOT NULL,
  "result" TEXT DEFAULT '' NOT NULL, "change_time" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_brand" (
  "id" SERIAL PRIMARY KEY, "brand_name" VARCHAR(100) DEFAULT '' NOT NULL,
  "pid" INTEGER DEFAULT 0 NOT NULL, "fid" VARCHAR(64) DEFAULT '' NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL, "sort" INTEGER DEFAULT 0 NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL, "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_product_label" (
  "id" SERIAL PRIMARY KEY, "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL, "label_cate" INTEGER DEFAULT 0 NOT NULL,
  "label_name" VARCHAR(255) DEFAULT '' NOT NULL, "style_type" SMALLINT DEFAULT 1 NOT NULL,
  "color" VARCHAR(32) DEFAULT '' NOT NULL, "bg_color" VARCHAR(32) DEFAULT '' NOT NULL,
  "border_color" VARCHAR(32) DEFAULT '' NOT NULL, "icon" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL, "status" SMALLINT DEFAULT 1 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL, "add_time" INTEGER DEFAULT 0 NOT NULL
);
`;
  }

  private migration_0002(): string {
    return `
CREATE TABLE IF NOT EXISTS "store_cart" (
  "id" SERIAL PRIMARY KEY, "uid" INTEGER DEFAULT 0 NOT NULL,
  "tourist_uid" VARCHAR(50) DEFAULT '' NOT NULL, "type" SMALLINT DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL, "product_type" SMALLINT DEFAULT 0 NOT NULL,
  "activity_id" INTEGER DEFAULT 0 NOT NULL, "store_id" INTEGER DEFAULT 0 NOT NULL,
  "staff_id" INTEGER DEFAULT 0 NOT NULL,
  "product_attr_unique" VARCHAR(16) DEFAULT '' NOT NULL,
  "cart_num" SMALLINT DEFAULT 0 NOT NULL, "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_pay" SMALLINT DEFAULT 0 NOT NULL, "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "is_new" SMALLINT DEFAULT 0 NOT NULL, "status" SMALLINT DEFAULT 1 NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_order" (
  "id" SERIAL PRIMARY KEY, "type" SMALLINT DEFAULT 0 NOT NULL,
  "pid" INTEGER DEFAULT 0 NOT NULL, "order_id" VARCHAR(32) DEFAULT '0' NOT NULL,
  "trade_no" VARCHAR(100) DEFAULT '' NOT NULL,
  "supplier_id" INTEGER DEFAULT 0 NOT NULL, "store_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL, "real_name" VARCHAR(32) DEFAULT '' NOT NULL,
  "user_phone" VARCHAR(18) DEFAULT '' NOT NULL, "province" VARCHAR(255) DEFAULT '' NOT NULL,
  "user_address" VARCHAR(100) DEFAULT '' NOT NULL,
  "user_location" VARCHAR(30) DEFAULT '' NOT NULL, "cart_id" TEXT,
  "pink_id" INTEGER DEFAULT 0 NOT NULL, "activity_id" INTEGER DEFAULT 0 NOT NULL,
  "activity_append" VARCHAR(255) DEFAULT '' NOT NULL,
  "freight_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL, "total_num" INTEGER DEFAULT 0 NOT NULL,
  "total_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "total_postage" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "pay_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "pay_postage" NUMERIC(12,2) DEFAULT '0.00' NOT NULL, "pay_integral" INTEGER DEFAULT 0 NOT NULL,
  "deduction_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "coupon_id" INTEGER DEFAULT 0 NOT NULL,
  "coupon_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "promotions_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "first_order_price" NUMERIC(8,2) DEFAULT '0.00' NOT NULL,
  "change_price" NUMERIC(8,2) DEFAULT '0.00' NOT NULL,
  "gain_integral" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "use_integral" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "back_integral" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "shipping_type" SMALLINT DEFAULT 1 NOT NULL, "verify_code" VARCHAR(12) DEFAULT '' NOT NULL,
  "paid" SMALLINT DEFAULT 0 NOT NULL, "status" SMALLINT DEFAULT 0 NOT NULL,
  "mark" VARCHAR(512) DEFAULT '' NOT NULL, "remark" VARCHAR(512) DEFAULT '' NOT NULL,
  "is_channel" SMALLINT DEFAULT 0 NOT NULL, "channel_type" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_remind" SMALLINT DEFAULT 0 NOT NULL, "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "is_system_del" SMALLINT DEFAULT 0 NOT NULL, "pay_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "pay_time" INTEGER DEFAULT 0 NOT NULL, "add_time" INTEGER DEFAULT 0 NOT NULL,
  "unique" VARCHAR(50) DEFAULT '', "user_ip" VARCHAR(16) DEFAULT '' NOT NULL,
  "refund_status" SMALLINT DEFAULT 0 NOT NULL, "refund_type" SMALLINT DEFAULT 0 NOT NULL,
  "refund_reason" VARCHAR(255) DEFAULT '' NOT NULL,
  "refund_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "so_order_id_uq" ON "store_order" ("order_id");
CREATE UNIQUE INDEX IF NOT EXISTS "so_unique_uid_uq" ON "store_order" ("unique", "uid");
CREATE INDEX IF NOT EXISTS "so_verify_code" ON "store_order" ("verify_code");
CREATE TABLE IF NOT EXISTS "store_order_cart_info" (
  "id" SERIAL PRIMARY KEY, "uid" INTEGER DEFAULT 0 NOT NULL,
  "oid" INTEGER DEFAULT 0 NOT NULL, "cart_id" VARCHAR(50) DEFAULT '0' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL, "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "staff_id" INTEGER DEFAULT 0 NOT NULL, "delivery_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL, "product_type" SMALLINT DEFAULT 0 NOT NULL,
  "sku_unique" VARCHAR(255) DEFAULT '' NOT NULL, "is_gift" SMALLINT DEFAULT 0 NOT NULL,
  "is_support_refund" SMALLINT DEFAULT 1 NOT NULL, "cart_num" INTEGER DEFAULT 0 NOT NULL,
  "refund_num" INTEGER DEFAULT 0 NOT NULL, "surplus_num" INTEGER DEFAULT 0 NOT NULL,
  "cart_info" TEXT, "unique" VARCHAR(32) DEFAULT '' NOT NULL
);
CREATE TABLE IF NOT EXISTS "user_bill" (
  "id" SERIAL PRIMARY KEY, "uid" INTEGER DEFAULT 0 NOT NULL,
  "link_id" VARCHAR(32) DEFAULT '0' NOT NULL, "pm" SMALLINT DEFAULT 0 NOT NULL,
  "title" VARCHAR(64) DEFAULT '' NOT NULL, "category" VARCHAR(64) DEFAULT '' NOT NULL,
  "type" VARCHAR(64) DEFAULT '' NOT NULL,
  "number" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "balance" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "mark" VARCHAR(512) DEFAULT '' NOT NULL, "add_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL, "take" SMALLINT DEFAULT 0 NOT NULL,
  "frozen_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "system_user_level" (
  "id" SERIAL PRIMARY KEY, "mer_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "money" NUMERIC(12,2) DEFAULT '0.00' NOT NULL, "valid_date" INTEGER DEFAULT 0 NOT NULL,
  "is_forever" SMALLINT DEFAULT 0 NOT NULL, "is_pay" SMALLINT DEFAULT 0 NOT NULL,
  "is_show" SMALLINT DEFAULT 0 NOT NULL, "grade" INTEGER DEFAULT 0 NOT NULL,
  "discount" NUMERIC(12,2) DEFAULT '0.00' NOT NULL, "image" VARCHAR(255) DEFAULT '' NOT NULL,
  "color" VARCHAR(32) DEFAULT '' NOT NULL, "icon" VARCHAR(255) DEFAULT '' NOT NULL,
  "explain" TEXT, "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL, "exp_num" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "user_address" (
  "id" SERIAL PRIMARY KEY, "uid" INTEGER DEFAULT 0 NOT NULL,
  "real_name" VARCHAR(32) DEFAULT '' NOT NULL, "phone" VARCHAR(16) DEFAULT '' NOT NULL,
  "province" VARCHAR(64) DEFAULT '' NOT NULL, "city" VARCHAR(64) DEFAULT '' NOT NULL,
  "district" VARCHAR(64) DEFAULT '' NOT NULL, "street" VARCHAR(100) DEFAULT '' NOT NULL,
  "city_id" INTEGER DEFAULT 0 NOT NULL, "detail" VARCHAR(256) DEFAULT '' NOT NULL,
  "post_code" INTEGER DEFAULT 0 NOT NULL, "longitude" VARCHAR(16) DEFAULT '' NOT NULL,
  "latitude" VARCHAR(16) DEFAULT '' NOT NULL, "is_default" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL, "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "user_relation" (
  "id" SERIAL PRIMARY KEY, "uid" INTEGER DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL, "type" VARCHAR(32) DEFAULT '' NOT NULL,
  "category" VARCHAR(32) DEFAULT '' NOT NULL, "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "user_sign" (
  "id" SERIAL PRIMARY KEY, "uid" INTEGER DEFAULT 0 NOT NULL,
  "title" VARCHAR(255) DEFAULT '' NOT NULL, "number" INTEGER DEFAULT 0 NOT NULL,
  "balance" INTEGER DEFAULT 0 NOT NULL, "exp_num" INTEGER DEFAULT 0 NOT NULL,
  "exp_balance" INTEGER DEFAULT 0 NOT NULL, "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "wechat_user" (
  "id" SERIAL PRIMARY KEY, "uid" INTEGER DEFAULT 0 NOT NULL,
  "unionid" VARCHAR(30) DEFAULT '' NOT NULL, "openid" VARCHAR(100) DEFAULT '' NOT NULL,
  "nickname" VARCHAR(64) DEFAULT '' NOT NULL, "headimgurl" VARCHAR(256) DEFAULT '' NOT NULL,
  "sex" SMALLINT DEFAULT 0 NOT NULL, "subscribe" SMALLINT DEFAULT 1 NOT NULL,
  "subscribe_time" INTEGER DEFAULT 0 NOT NULL, "add_time" INTEGER DEFAULT 0 NOT NULL,
  "user_type" VARCHAR(32) DEFAULT 'wechat' NOT NULL, "is_complete" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "system_admin" (
  "id" SERIAL PRIMARY KEY, "account" VARCHAR(32) DEFAULT '' NOT NULL,
  "admin_type" SMALLINT DEFAULT 1 NOT NULL, "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "head_pic" VARCHAR(255) DEFAULT '' NOT NULL, "pwd" VARCHAR(100) DEFAULT '' NOT NULL,
  "real_name" VARCHAR(16) DEFAULT '' NOT NULL, "phone" VARCHAR(32) DEFAULT '' NOT NULL,
  "roles" VARCHAR(128) DEFAULT '' NOT NULL, "last_ip" VARCHAR(16) DEFAULT '' NOT NULL,
  "last_time" INTEGER DEFAULT 0 NOT NULL, "add_time" INTEGER DEFAULT 0 NOT NULL,
  "login_count" INTEGER DEFAULT 0 NOT NULL, "level" SMALLINT DEFAULT 1 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL, "division_id" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "system_role" (
  "id" SERIAL PRIMARY KEY, "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL, "role_name" VARCHAR(32) DEFAULT '' NOT NULL,
  "rules" TEXT DEFAULT '' NOT NULL, "level" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_service_log" (
  "id" SERIAL PRIMARY KEY, "mer_id" INTEGER DEFAULT 0 NOT NULL,
  "msn" TEXT DEFAULT '' NOT NULL, "uid" INTEGER DEFAULT 0 NOT NULL,
  "to_uid" INTEGER DEFAULT 0 NOT NULL, "is_tourist" SMALLINT DEFAULT 0 NOT NULL,
  "time_node" SMALLINT DEFAULT 0 NOT NULL, "add_time" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL, "remind" SMALLINT DEFAULT 0 NOT NULL,
  "msn_type" SMALLINT DEFAULT 1 NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_service" (
  "id" SERIAL PRIMARY KEY, "uid" INTEGER DEFAULT 0 NOT NULL,
  "online" SMALLINT DEFAULT 0 NOT NULL, "account" VARCHAR(64) DEFAULT '' NOT NULL,
  "password" VARCHAR(100) DEFAULT '' NOT NULL, "avatar" VARCHAR(255) DEFAULT '' NOT NULL,
  "nickname" VARCHAR(50) DEFAULT '' NOT NULL, "phone" VARCHAR(18) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL, "account_status" SMALLINT DEFAULT 1 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL, "customer" SMALLINT DEFAULT 0 NOT NULL,
  "uniqid" VARCHAR(50) DEFAULT '' NOT NULL, "is_del" SMALLINT DEFAULT 0 NOT NULL
);
`;
  }

  private migration_0003(): string {
    return `
CREATE TABLE IF NOT EXISTS "store_order_refund" (
  "id" SERIAL PRIMARY KEY,
  "store_order_id" INTEGER DEFAULT 0 NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "order_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "supplier_id" INTEGER DEFAULT 0 NOT NULL,
  "apply_type" SMALLINT DEFAULT 0 NOT NULL,
  "apply_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "refund_type" SMALLINT DEFAULT 0 NOT NULL,
  "refund_num" INTEGER DEFAULT 0 NOT NULL,
  "refund_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "refunded_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "refund_reason" VARCHAR(255) DEFAULT '' NOT NULL,
  "refund_phone" VARCHAR(32) DEFAULT '' NOT NULL,
  "refund_express" VARCHAR(100) DEFAULT '' NOT NULL,
  "refund_express_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "refund_explain" VARCHAR(255) DEFAULT '' NOT NULL,
  "refund_img" TEXT,
  "refund_goods_explain" VARCHAR(255) DEFAULT '' NOT NULL,
  "refund_goods_img" TEXT,
  "refuse_reason" VARCHAR(255) DEFAULT '' NOT NULL,
  "remark" VARCHAR(255) DEFAULT '' NOT NULL,
  "refunded_time" INTEGER DEFAULT 0 NOT NULL,
  "cart_info" TEXT,
  "is_cancel" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_order_status" (
  "id" SERIAL PRIMARY KEY,
  "oid" INTEGER DEFAULT 0 NOT NULL,
  "change_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "change_message" VARCHAR(256) DEFAULT '' NOT NULL,
  "change_time" INTEGER DEFAULT 0 NOT NULL
);
`;
  }
  private migration_0004(): string {
    return `
CREATE TABLE IF NOT EXISTS "store_coupon_issue" (
  "id" SERIAL PRIMARY KEY, "coupon_type" SMALLINT DEFAULT 1 NOT NULL,
  "coupon_title" VARCHAR(64) DEFAULT '' NOT NULL, "type" SMALLINT DEFAULT 1 NOT NULL,
  "coupon_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "use_min_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "product_id" VARCHAR(500) DEFAULT '0' NOT NULL,
  "category_id" VARCHAR(500) DEFAULT '0' NOT NULL,
  "brand_id" VARCHAR(500) DEFAULT '0' NOT NULL,
  "total_count" INTEGER DEFAULT 0 NOT NULL, "remain_count" INTEGER DEFAULT 0 NOT NULL,
  "receive_limit" SMALLINT DEFAULT 1 NOT NULL, "receive_type" SMALLINT DEFAULT 0 NOT NULL,
  "start_time" TIMESTAMP, "end_time" TIMESTAMP, "day" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL, "app_type" SMALLINT DEFAULT 0 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL, "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_coupon_user" (
  "id" SERIAL PRIMARY KEY, "uid" INTEGER DEFAULT 0 NOT NULL,
  "issue_coupon_id" INTEGER DEFAULT 0 NOT NULL,
  "coupon_title" VARCHAR(64) DEFAULT '' NOT NULL,
  "coupon_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "use_min_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "start_time" TIMESTAMP, "end_time" TIMESTAMP, "use_time" TIMESTAMP,
  "type" SMALLINT DEFAULT 1 NOT NULL, "receive_time" INTEGER DEFAULT 0 NOT NULL,
  "receive_source" VARCHAR(32) DEFAULT 'send' NOT NULL,
  "is_fail" SMALLINT DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_seckill" (
  "id" SERIAL PRIMARY KEY, "product_id" INTEGER DEFAULT 0 NOT NULL,
  "time_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "store_name" VARCHAR(256) DEFAULT '' NOT NULL, "image" VARCHAR(256) DEFAULT '' NOT NULL,
  "price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "ot_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "num" INTEGER DEFAULT 0 NOT NULL, "quota" INTEGER DEFAULT 0 NOT NULL,
  "quota_show" INTEGER DEFAULT 0 NOT NULL, "stock" INTEGER DEFAULT 0 NOT NULL,
  "sales" INTEGER DEFAULT 0 NOT NULL,
  "start_time" TIMESTAMP, "stop_time" TIMESTAMP,
  "status" SMALLINT DEFAULT 1 NOT NULL, "sort" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_seckill_time" (
  "id" SERIAL PRIMARY KEY,
  "title" VARCHAR(255),
  "pic" VARCHAR(255) DEFAULT '' NOT NULL,
  "describe" VARCHAR(255) DEFAULT '' NOT NULL,
  "start_time" VARCHAR(16) DEFAULT '' NOT NULL,
  "end_time" VARCHAR(16) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_combination" (
  "id" SERIAL PRIMARY KEY, "product_id" INTEGER DEFAULT 0 NOT NULL,
  "store_name" VARCHAR(256) DEFAULT '' NOT NULL, "image" VARCHAR(256) DEFAULT '' NOT NULL,
  "price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "ot_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "people" INTEGER DEFAULT 2 NOT NULL, "num" INTEGER DEFAULT 0 NOT NULL,
  "quota" INTEGER DEFAULT 0 NOT NULL, "quota_show" INTEGER DEFAULT 0 NOT NULL,
  "stock" INTEGER DEFAULT 0 NOT NULL, "sales" INTEGER DEFAULT 0 NOT NULL,
  "start_time" TIMESTAMP, "stop_time" TIMESTAMP,
  "status" SMALLINT DEFAULT 1 NOT NULL, "sort" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_bargain_user" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "bargain_id" INTEGER DEFAULT 0 NOT NULL,
  "bargain_price_min" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "bargain_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_pink" (
  "id" SERIAL PRIMARY KEY, "uid" INTEGER DEFAULT 0 NOT NULL,
  "order_id" VARCHAR(32) DEFAULT '' NOT NULL,
  "order_id_key" VARCHAR(32) DEFAULT '' NOT NULL,
  "combination_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "k_id" INTEGER DEFAULT 0 NOT NULL, "people" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL, "stop_time" TIMESTAMP,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_bargain" (
  "id" SERIAL PRIMARY KEY, "product_id" INTEGER DEFAULT 0 NOT NULL,
  "store_name" VARCHAR(256) DEFAULT '' NOT NULL, "image" VARCHAR(256) DEFAULT '' NOT NULL,
  "min_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "quota" INTEGER DEFAULT 0 NOT NULL, "quota_show" INTEGER DEFAULT 0 NOT NULL,
  "stock" INTEGER DEFAULT 0 NOT NULL, "sales" INTEGER DEFAULT 0 NOT NULL,
  "people" INTEGER DEFAULT 0 NOT NULL,
  "start_time" TIMESTAMP, "stop_time" TIMESTAMP,
  "status" SMALLINT DEFAULT 1 NOT NULL, "sort" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_integral" (
  "id" SERIAL PRIMARY KEY, "product_id" INTEGER DEFAULT 0 NOT NULL,
  "store_name" VARCHAR(256) DEFAULT '' NOT NULL, "image" VARCHAR(256) DEFAULT '' NOT NULL,
  "integral" INTEGER DEFAULT 0 NOT NULL,
  "price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "ot_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "quota" INTEGER DEFAULT 0 NOT NULL, "quota_show" INTEGER DEFAULT 0 NOT NULL,
  "stock" INTEGER DEFAULT 0 NOT NULL, "sales" INTEGER DEFAULT 0 NOT NULL,
  "num" INTEGER DEFAULT 0 NOT NULL, "status" SMALLINT DEFAULT 1 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL, "add_time" INTEGER DEFAULT 0 NOT NULL
);
`;
  }
  private migration_0005(): string {
    return `
CREATE TABLE IF NOT EXISTS "user_brokerage" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "link_id" VARCHAR(32) DEFAULT '0' NOT NULL,
  "pm" SMALLINT DEFAULT 0 NOT NULL,
  "title" VARCHAR(64) DEFAULT '' NOT NULL,
  "category" VARCHAR(64) DEFAULT '' NOT NULL,
  "type" VARCHAR(64) DEFAULT '' NOT NULL,
  "number" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "balance" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "mark" VARCHAR(512) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "user_extract" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "extract_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "bank_name" VARCHAR(64) DEFAULT '' NOT NULL,
  "bank_code" VARCHAR(64) DEFAULT '' NOT NULL,
  "bank_address" VARCHAR(255) DEFAULT '' NOT NULL,
  "real_name" VARCHAR(32) DEFAULT '' NOT NULL,
  "extract_number" VARCHAR(64) DEFAULT '' NOT NULL,
  "extract_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "fail_msg" VARCHAR(255) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
`;
  }
  private migration_0006(): string {
    return `
CREATE TABLE IF NOT EXISTS "user_money" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "link_id" VARCHAR(32) DEFAULT '0' NOT NULL,
  "type" VARCHAR(64) DEFAULT '' NOT NULL,
  "title" VARCHAR(64) DEFAULT '' NOT NULL,
  "number" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "balance" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "pm" SMALLINT DEFAULT 0 NOT NULL,
  "mark" VARCHAR(512) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "user_recharge" (
  "id" SERIAL PRIMARY KEY,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "staff_id" INTEGER DEFAULT 0 NOT NULL,
  "order_id" VARCHAR(32) DEFAULT '' NOT NULL,
  "trade_no" VARCHAR(100) DEFAULT '' NOT NULL,
  "price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "give_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "recharge_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "paid" SMALLINT DEFAULT 0 NOT NULL,
  "pay_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "refund_price" NUMERIC(10,2) DEFAULT '0.00' NOT NULL,
  "channel_type" VARCHAR(255) DEFAULT '' NOT NULL,
  "remarks" VARCHAR(255) DEFAULT '' NOT NULL
);
CREATE TABLE IF NOT EXISTS "store_product_words" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(128) DEFAULT '' NOT NULL,
  "color" VARCHAR(32) DEFAULT '' NOT NULL,
  "bg_color" VARCHAR(32) DEFAULT '' NOT NULL,
  "border_color" VARCHAR(32) DEFAULT '' NOT NULL,
  "icon" VARCHAR(128) DEFAULT '' NOT NULL,
  "is_show" SMALLINT DEFAULT 0 NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "is_search" SMALLINT DEFAULT 0 NOT NULL,
  "is_hot" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "system_message" (
  "id" SERIAL PRIMARY KEY,
  "mark" VARCHAR(50) DEFAULT '' NOT NULL,
  "title" VARCHAR(256) DEFAULT '' NOT NULL,
  "content" TEXT,
  "user_id" INTEGER DEFAULT 0 NOT NULL,
  "look" SMALLINT DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "user_message" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "message_id" INTEGER DEFAULT 0 NOT NULL,
  "is_read" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "community" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "content_type" SMALLINT DEFAULT 1 NOT NULL,
  "title" VARCHAR(255) DEFAULT '' NOT NULL,
  "image" VARCHAR(255) DEFAULT '' NOT NULL,
  "video_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "slider_image" TEXT,
  "content" TEXT,
  "topic_id" TEXT,
  "product_id" TEXT,
  "like_num" INTEGER DEFAULT 0 NOT NULL,
  "collect_num" INTEGER DEFAULT 0 NOT NULL,
  "play_num" INTEGER DEFAULT 0 NOT NULL,
  "comment_num" INTEGER DEFAULT 0 NOT NULL,
  "share_num" INTEGER DEFAULT 0 NOT NULL,
  "star" SMALLINT DEFAULT 1 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_recommend" SMALLINT DEFAULT 0 NOT NULL,
  "is_verify" SMALLINT DEFAULT 1 NOT NULL,
  "refusal" VARCHAR(255) DEFAULT '' NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "verify_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "community_comment" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "reply_id" INTEGER DEFAULT 0 NOT NULL,
  "reply_uid" INTEGER DEFAULT 0 NOT NULL,
  "comment_reply_id" INTEGER DEFAULT 0 NOT NULL,
  "comment_reply_uid" INTEGER DEFAULT 0 NOT NULL,
  "community_id" INTEGER DEFAULT 0 NOT NULL,
  "nickname" VARCHAR(64) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(255) DEFAULT '' NOT NULL,
  "comment_num" INTEGER DEFAULT 0 NOT NULL,
  "like_num" INTEGER DEFAULT 0 NOT NULL,
  "content" VARCHAR(1000) DEFAULT '' NOT NULL,
  "ip" VARCHAR(32) DEFAULT '' NOT NULL,
  "city" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_verify" SMALLINT DEFAULT 1 NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "is_reply" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "user_invoice" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "header_type" SMALLINT DEFAULT 1 NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "duty_number" VARCHAR(50) DEFAULT '' NOT NULL,
  "drawer_phone" VARCHAR(30) DEFAULT '' NOT NULL,
  "email" VARCHAR(100) DEFAULT '' NOT NULL,
  "tell" VARCHAR(30) DEFAULT '' NOT NULL,
  "address" VARCHAR(255) DEFAULT '' NOT NULL,
  "bank" VARCHAR(50) DEFAULT '' NOT NULL,
  "card_number" VARCHAR(50) DEFAULT '' NOT NULL,
  "is_default" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
`;
  }

  private migration_0007(): string {
    return `
CREATE TABLE IF NOT EXISTS "store_product_reply" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "oid" INTEGER DEFAULT 0 NOT NULL,
  "unique" VARCHAR(50) DEFAULT '' NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "nickname" VARCHAR(128) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(256) DEFAULT '' NOT NULL,
  "comment" VARCHAR(1024) DEFAULT '' NOT NULL,
  "sku" VARCHAR(255) DEFAULT '' NOT NULL,
  "product_score" SMALLINT DEFAULT 5 NOT NULL,
  "service_score" SMALLINT DEFAULT 5 NOT NULL,
  "logistics_score" SMALLINT DEFAULT 5 NOT NULL,
  "pics" TEXT DEFAULT '[]',
  "is_reply" SMALLINT DEFAULT 0 NOT NULL,
  "merchant_reply" VARCHAR(500) DEFAULT '' NOT NULL,
  "merchant_reply_time" INTEGER DEFAULT 0 NOT NULL,
  "praise" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "top" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "spr_product_id" ON "store_product_reply" ("product_id");
CREATE INDEX IF NOT EXISTS "spr_uid" ON "store_product_reply" ("uid");
CREATE INDEX IF NOT EXISTS "spr_unique" ON "store_product_reply" ("unique");
CREATE TABLE IF NOT EXISTS "store_product_reply_comment" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "reply_id" INTEGER DEFAULT 0 NOT NULL,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "nickname" VARCHAR(128) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(256) DEFAULT '' NOT NULL,
  "content" VARCHAR(1000) DEFAULT '' NOT NULL,
  "praise" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "sprc_reply_id" ON "store_product_reply_comment" ("reply_id");
`;
  }

  private migration_0008(): string {
    return `
-- 分类 pic 扩到 512 (支持内联 SVG data URI 图标)
ALTER TABLE "store_product_category" ALTER COLUMN "pic" TYPE VARCHAR(512);
`;
  }

  private migration_0009(): string {
    return `
-- IP 列扩到 45 (IPv6 最长 45 字符, 修复长 IP 导致的下单 500)
ALTER TABLE "store_order" ALTER COLUMN "user_ip" TYPE VARCHAR(45);
ALTER TABLE "user" ALTER COLUMN "add_ip" TYPE VARCHAR(45);
ALTER TABLE "user" ALTER COLUMN "last_ip" TYPE VARCHAR(45);
`;
  }

  private migration_0010(): string {
    return `
-- 运费模板 (M19)
CREATE TABLE IF NOT EXISTS "shipping_templates" (
  "id" SERIAL PRIMARY KEY,
  "owner_type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "appoint" SMALLINT DEFAULT 0 NOT NULL,
  "no_delivery" SMALLINT DEFAULT 0 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS "shipping_templates_region" (
  "id" SERIAL PRIMARY KEY,
  "template_id" INTEGER DEFAULT 0 NOT NULL,
  "region_id" INTEGER DEFAULT 0 NOT NULL,
  "region_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "first" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "first_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "continue" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "continue_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "str_template" ON "shipping_templates_region" ("template_id");
-- 快递公司 (M19)
CREATE TABLE IF NOT EXISTS "express_company" (
  "id" SERIAL PRIMARY KEY,
  "code" VARCHAR(32) DEFAULT '' NOT NULL,
  "name" VARCHAR(64) DEFAULT '' NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
`;
  }

  private migration_0011(): string {
    return `
-- 用户标签 (M21)
CREATE TABLE IF NOT EXISTS "user_label" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "label_cate" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "tag_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "color" VARCHAR(32) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
`;
  }

  private migration_0012(): string {
    return `
-- DIY 装修页面 (M22)
CREATE TABLE IF NOT EXISTS "system_dise" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(128) DEFAULT '' NOT NULL,
  "title" VARCHAR(255) DEFAULT '' NOT NULL,
  "content" TEXT DEFAULT '',
  "value" TEXT DEFAULT '',
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
-- CMS 文章 (M22)
CREATE TABLE IF NOT EXISTS "system_article" (
  "id" SERIAL PRIMARY KEY,
  "cid" INTEGER DEFAULT 0 NOT NULL,
  "title" VARCHAR(255) DEFAULT '' NOT NULL,
  "author" VARCHAR(64) DEFAULT '' NOT NULL,
  "content" TEXT DEFAULT '',
  "synopsis" VARCHAR(500) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
-- 操作日志 (M22)
CREATE TABLE IF NOT EXISTS "system_log" (
  "id" SERIAL PRIMARY KEY,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "admin_id" INTEGER DEFAULT 0 NOT NULL,
  "admin_name" VARCHAR(64) DEFAULT '' NOT NULL,
  "path" VARCHAR(128) DEFAULT '' NOT NULL,
  "page" VARCHAR(64) DEFAULT '' NOT NULL,
  "method" VARCHAR(12) DEFAULT '' NOT NULL,
  "action" VARCHAR(255) DEFAULT '' NOT NULL,
  "ip" VARCHAR(45) DEFAULT '' NOT NULL,
  "type" VARCHAR(32) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "merchant_id" INTEGER DEFAULT 0 NOT NULL
);
`;
  }

  private migration_0013(): string {
    return `
-- 通知模板 (M24)
CREATE TABLE IF NOT EXISTS "notification_template" (
  "id" SERIAL PRIMARY KEY,
  "title" VARCHAR(128) DEFAULT '' NOT NULL,
  "content" TEXT DEFAULT '',
  "type" VARCHAR(32) DEFAULT 'wechat' NOT NULL,
  "mark" VARCHAR(128) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
`;
  }

  private migration_0014(): string {
    return `
-- Supplier 独立后台核心表
CREATE TABLE IF NOT EXISTS "system_supplier" (
  "id" SERIAL PRIMARY KEY,
  "admin_id" INTEGER DEFAULT 0 NOT NULL,
  "supplier_name" VARCHAR(50) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(255) DEFAULT '' NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "phone" VARCHAR(15) DEFAULT '' NOT NULL,
  "email" VARCHAR(50) DEFAULT '' NOT NULL,
  "address" VARCHAR(255) DEFAULT '' NOT NULL,
  "province" INTEGER DEFAULT 0 NOT NULL,
  "city" INTEGER DEFAULT 0 NOT NULL,
  "area" INTEGER DEFAULT 0 NOT NULL,
  "street" INTEGER DEFAULT 0 NOT NULL,
  "detailed_address" VARCHAR(255) DEFAULT '' NOT NULL,
  "bank_code" VARCHAR(32) DEFAULT '0' NOT NULL,
  "bank_address" VARCHAR(256) DEFAULT '' NOT NULL,
  "alipay_account" VARCHAR(64) DEFAULT '' NOT NULL,
  "alipay_qrcode_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "wechat" VARCHAR(15) DEFAULT '' NOT NULL,
  "wechat_qrcode_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "business" INTEGER DEFAULT 0 NOT NULL,
  "city_shop_id" VARCHAR(255) DEFAULT '' NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_admin_id_uq" ON "system_supplier" ("admin_id");
CREATE INDEX IF NOT EXISTS "supplier_status_idx" ON "system_supplier" ("is_show", "is_del");
`;
  }

  private migration_0015(): string {
    return `
-- Supplier 第二批：履约、结算快照和财务
ALTER TABLE "store_order"
  ADD COLUMN IF NOT EXISTS "delivery_name" VARCHAR(64) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "delivery_code" VARCHAR(50) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "delivery_type" VARCHAR(32) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "delivery_id" VARCHAR(64) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "fictitious_content" VARCHAR(500) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "delivery_uid" INTEGER DEFAULT 0 NOT NULL;

ALTER TABLE "store_order_cart_info"
  ADD COLUMN IF NOT EXISTS "settle_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL;

UPDATE "store_order_cart_info" AS ci
SET "settle_price" = product."settle_price"
FROM "store_product" AS product
WHERE ci."product_id" = product."id"
  AND ci."settle_price" = 0;

CREATE TABLE IF NOT EXISTS "supplier_flowing_water" (
  "id" SERIAL PRIMARY KEY,
  "supplier_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "order_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "link_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "pm" SMALLINT DEFAULT 0 NOT NULL,
  "number" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "pay_type" VARCHAR(20) DEFAULT '' NOT NULL,
  "pay_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "total_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "pay_postage" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "remark" VARCHAR(512) DEFAULT '' NOT NULL,
  "finish_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "trade_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "sfw_order_id_uq" ON "supplier_flowing_water" ("order_id");
CREATE INDEX IF NOT EXISTS "sfw_supplier_time" ON "supplier_flowing_water" ("supplier_id", "add_time");
CREATE INDEX IF NOT EXISTS "sfw_supplier_status" ON "supplier_flowing_water" ("supplier_id", "status", "is_del");

CREATE TABLE IF NOT EXISTS "supplier_transactions" (
  "id" SERIAL PRIMARY KEY,
  "supplier_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "order_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "link_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "pm" SMALLINT DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "pay_type" VARCHAR(20) DEFAULT '' NOT NULL,
  "pay_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "total_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "pay_postage" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "remark" VARCHAR(512) DEFAULT '' NOT NULL,
  "mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "trade_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "stx_order_id_uq" ON "supplier_transactions" ("order_id");
CREATE INDEX IF NOT EXISTS "stx_supplier_time" ON "supplier_transactions" ("supplier_id", "add_time");

CREATE TABLE IF NOT EXISTS "supplier_extract" (
  "id" SERIAL PRIMARY KEY,
  "supplier_id" INTEGER DEFAULT 0 NOT NULL,
  "extract_type" VARCHAR(32) DEFAULT 'bank' NOT NULL,
  "bank_code" VARCHAR(32) DEFAULT '' NOT NULL,
  "bank_address" VARCHAR(256) DEFAULT '' NOT NULL,
  "alipay_account" VARCHAR(64) DEFAULT '' NOT NULL,
  "wechat" VARCHAR(32) DEFAULT '' NOT NULL,
  "qrcode_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "extract_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "mark" VARCHAR(512) DEFAULT '' NOT NULL,
  "balance" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "pay_status" SMALLINT DEFAULT 0 NOT NULL,
  "supplier_mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "admin_id" INTEGER DEFAULT 0 NOT NULL,
  "fail_msg" VARCHAR(128) DEFAULT '' NOT NULL,
  "fail_time" INTEGER DEFAULT 0 NOT NULL,
  "voucher_image" VARCHAR(256) DEFAULT '' NOT NULL,
  "voucher_title" VARCHAR(256) DEFAULT '' NOT NULL,
  "pay_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
ALTER TABLE "supplier_extract"
  ADD COLUMN IF NOT EXISTS "pay_time" INTEGER DEFAULT 0 NOT NULL;
CREATE INDEX IF NOT EXISTS "se_supplier_time" ON "supplier_extract" ("supplier_id", "add_time");
CREATE INDEX IF NOT EXISTS "se_supplier_status" ON "supplier_extract" ("supplier_id", "status", "pay_status");
`;
  }

  private migration_0016(): string {
    return `
-- 第三方原路退款状态机
CREATE TABLE IF NOT EXISTS "store_order_refund_payment" (
  "id" SERIAL PRIMARY KEY,
  "refund_id" INTEGER NOT NULL,
  "store_order_id" INTEGER NOT NULL,
  "provider" VARCHAR(16) NOT NULL,
  "out_refund_no" VARCHAR(64) NOT NULL,
  "provider_refund_id" VARCHAR(100) DEFAULT '' NOT NULL,
  "provider_status" VARCHAR(24) DEFAULT 'CREATED' NOT NULL,
  "request_amount" INTEGER DEFAULT 0 NOT NULL,
  "total_amount" INTEGER DEFAULT 0 NOT NULL,
  "attempt_count" INTEGER DEFAULT 0 NOT NULL,
  "request_time" INTEGER DEFAULT 0 NOT NULL,
  "query_time" INTEGER DEFAULT 0 NOT NULL,
  "notify_time" INTEGER DEFAULT 0 NOT NULL,
  "success_time" INTEGER DEFAULT 0 NOT NULL,
  "last_error" VARCHAR(512) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "sorp_provider_ck" CHECK ("provider" IN ('wechat', 'alipay')),
  CONSTRAINT "sorp_status_ck" CHECK (
    "provider_status" IN ('CREATED', 'REQUESTING', 'PROCESSING', 'SUCCESS', 'CLOSED', 'ABNORMAL', 'FAILED', 'UNKNOWN')
  ),
  CONSTRAINT "sorp_amount_ck" CHECK (
    "request_amount" >= 0 AND "total_amount" >= 0 AND "request_amount" <= "total_amount"
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "sorp_refund_id_uq"
  ON "store_order_refund_payment" ("refund_id");
CREATE UNIQUE INDEX IF NOT EXISTS "sorp_out_refund_no_uq"
  ON "store_order_refund_payment" ("out_refund_no");
CREATE INDEX IF NOT EXISTS "sorp_order_id"
  ON "store_order_refund_payment" ("store_order_id");
CREATE INDEX IF NOT EXISTS "sorp_provider_status"
  ON "store_order_refund_payment" ("provider", "provider_status");
`;
  }

  private migration_0017(): string {
    return `
-- 订单支付后置任务 transactional outbox
-- 不回填历史已支付订单，避免在历史对账前重复分佣或增加支付次数。
CREATE TABLE IF NOT EXISTS "store_order_outbox" (
  "id" SERIAL PRIMARY KEY,
  "event_key" VARCHAR(128) NOT NULL,
  "aggregate_type" VARCHAR(32) DEFAULT 'order' NOT NULL,
  "aggregate_id" INTEGER NOT NULL,
  "event_type" VARCHAR(64) NOT NULL,
  "payload" JSONB DEFAULT '{}'::jsonb NOT NULL,
  "status" VARCHAR(16) DEFAULT 'PENDING' NOT NULL,
  "dispatch_count" INTEGER DEFAULT 0 NOT NULL,
  "attempt_count" INTEGER DEFAULT 0 NOT NULL,
  "replay_count" INTEGER DEFAULT 0 NOT NULL,
  "available_time" INTEGER DEFAULT 0 NOT NULL,
  "lease_until" INTEGER DEFAULT 0 NOT NULL,
  "lease_token" VARCHAR(36) DEFAULT '' NOT NULL,
  "last_error" VARCHAR(1000) DEFAULT '' NOT NULL,
  "enqueued_time" INTEGER DEFAULT 0 NOT NULL,
  "processed_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "soob_event_type_ck" CHECK ("event_type" IN ('order.paid')),
  CONSTRAINT "soob_status_ck" CHECK (
    "status" IN ('PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD')
  ),
  CONSTRAINT "soob_count_ck" CHECK (
    "dispatch_count" >= 0 AND "attempt_count" >= 0 AND "replay_count" >= 0
  ),
  CONSTRAINT "soob_time_ck" CHECK ("available_time" >= 0 AND "lease_until" >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "soob_event_key_uq"
  ON "store_order_outbox" ("event_key");
CREATE INDEX IF NOT EXISTS "soob_aggregate"
  ON "store_order_outbox" ("aggregate_type", "aggregate_id");
CREATE INDEX IF NOT EXISTS "soob_dispatch_ready"
  ON "store_order_outbox" ("available_time", "id")
  WHERE "status" IN ('PENDING', 'FAILED');
CREATE INDEX IF NOT EXISTS "soob_expired_lease"
  ON "store_order_outbox" ("lease_until", "id")
  WHERE "status" IN ('ENQUEUING', 'ENQUEUED', 'PROCESSING');
`;
  }

  private migration_0018(): string {
    return `
-- 订单返佣按 PHP 语义迁移：下单快照，确认收货入账，提现时识别冻结期。
-- 不为历史订单计算或回填佣金，历史数据必须先单独对账。
CREATE TABLE IF NOT EXISTS "agent_level" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "image" VARCHAR(255) DEFAULT '' NOT NULL,
  "color" VARCHAR(32) DEFAULT '' NOT NULL,
  "one_brokerage" SMALLINT DEFAULT 0 NOT NULL,
  "two_brokerage" SMALLINT DEFAULT 0 NOT NULL,
  "grade" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "al_brokerage_ck" CHECK (
    "one_brokerage" BETWEEN 0 AND 1000 AND "two_brokerage" BETWEEN 0 AND 1000
  )
);

CREATE INDEX IF NOT EXISTS "al_status_del" ON "agent_level" ("status", "is_del");

INSERT INTO "agent_level"
  ("id", "name", "image", "color", "one_brokerage", "two_brokerage", "grade", "status", "is_del", "add_time")
VALUES
  (1, '等级一', '/uploads/system/agent_level_1.png', '#D97E1D', 2, 1, 1, 1, 0, 1700126550),
  (2, '等级二', '/uploads/system/agent_level_2.png', '#5D7DAC', 5, 3, 2, 1, 0, 1700126572),
  (3, '等级三', '/uploads/system/agent_level_3.png', '#5856D6', 10, 5, 3, 1, 0, 1700126595),
  (4, '等级四', '/uploads/system/agent_level_4.png', '#1DB0FC', 12, 7, 4, 1, 0, 1700126621),
  (5, '等级五', '/uploads/system/agent_level_5.png', '#AF52DE', 19, 12, 5, 1, 0, 1701764897)
ON CONFLICT ("id") DO NOTHING;

SELECT setval(
  pg_get_serial_sequence('agent_level', 'id'),
  GREATEST((SELECT COALESCE(MAX("id"), 1) FROM "agent_level"), 1),
  true
);

-- 仅补缺失配置；已从 PHP 迁移的商城配置始终优先。
INSERT INTO "system_config" ("menu_name", "value", "info")
SELECT seed.menu_name, seed.value, seed.info
FROM (VALUES
  ('store_brokerage_ratio', '10', '一级返佣比例（%）'),
  ('store_brokerage_two', '5', '二级返佣比例（%）'),
  ('store_brokerage_statu', '1', '分销模式'),
  ('store_brokerage_price', '600', '满额分销最低累计消费金额'),
  ('extract_time', '0', '佣金冻结时间（天）'),
  ('brokerage_func_status', '1', '分销启用'),
  ('is_self_brokerage', '0', '自购返佣'),
  ('brokerage_level', '2', '分销层级'),
  ('brokerage_compute_type', '1', '佣金计算方式')
) AS seed(menu_name, value, info)
WHERE NOT EXISTS (
  SELECT 1 FROM "system_config" existing
  WHERE existing."menu_name" = seed.menu_name AND existing."is_store" = 0
);

ALTER TABLE "store_order" ADD COLUMN IF NOT EXISTS "spread_uid" INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE "store_order" ADD COLUMN IF NOT EXISTS "spread_two_uid" INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE "store_order" ADD COLUMN IF NOT EXISTS "one_brokerage" NUMERIC(12,2) DEFAULT '0.00' NOT NULL;
ALTER TABLE "store_order" ADD COLUMN IF NOT EXISTS "two_brokerage" NUMERIC(12,2) DEFAULT '0.00' NOT NULL;
CREATE INDEX IF NOT EXISTS "so_spread_uid" ON "store_order" ("spread_uid");
CREATE INDEX IF NOT EXISTS "so_spread_two_uid" ON "store_order" ("spread_two_uid");

ALTER TABLE "user_brokerage" ADD COLUMN IF NOT EXISTS "take" SMALLINT DEFAULT 0 NOT NULL;
ALTER TABLE "user_brokerage" ADD COLUMN IF NOT EXISTS "frozen_time" INTEGER DEFAULT 0 NOT NULL;
CREATE INDEX IF NOT EXISTS "ub_frozen_ready"
  ON "user_brokerage" ("frozen_time", "uid")
  WHERE "pm" = 1 AND "status" = 1;
CREATE UNIQUE INDEX IF NOT EXISTS "ub_order_income_uq"
  ON "user_brokerage" ("uid", "link_id", "type")
  WHERE "pm" = 1 AND "type" IN ('self_brokerage', 'one_brokerage', 'two_brokerage');
`;
  }

  private migration_0019(): string {
    return `
-- 确认收货奖励：商品积分、实付返积分、经验与等级历史；退款按累计比例冲正积分。
-- 不为历史已收货订单补发奖励，历史数据必须先单独对账。
ALTER TABLE "user_bill" ADD COLUMN IF NOT EXISTS "event_key" VARCHAR(64) DEFAULT '' NOT NULL;
CREATE INDEX IF NOT EXISTS "ub_event_key" ON "user_bill" ("event_key");
CREATE UNIQUE INDEX IF NOT EXISTS "ub_order_reward_uq"
  ON "user_bill" ("uid", "link_id", "event_key")
  WHERE "event_key" IN ('pay_give_integral', 'order_give_integral', 'order_give_exp');

CREATE TABLE IF NOT EXISTS "member_right" (
  "id" SERIAL PRIMARY KEY,
  "right_type" VARCHAR(100) DEFAULT '' NOT NULL,
  "title" VARCHAR(200) DEFAULT '' NOT NULL,
  "show_title" VARCHAR(255) DEFAULT '' NOT NULL,
  "image" VARCHAR(200) DEFAULT '' NOT NULL,
  "explain" VARCHAR(1024) DEFAULT '' NOT NULL,
  "content" TEXT,
  "number" INTEGER DEFAULT 1 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "mr_number_ck" CHECK ("number" >= 0)
);
CREATE INDEX IF NOT EXISTS "mr_right_type" ON "member_right" ("right_type");
INSERT INTO "member_right"
  ("right_type", "title", "show_title", "image", "explain", "number", "sort", "status", "add_time")
SELECT
  'integral', '消费返利', '消费返利',
  '/uploads/system/1c0fb1ff89e1f6f347fb131544056910.png',
  '消费返多倍积分', 2, 0, 1, 0
WHERE NOT EXISTS (
  SELECT 1 FROM "member_right" existing WHERE existing."right_type" = 'integral'
);

CREATE TABLE IF NOT EXISTS "user_level" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "level_id" INTEGER DEFAULT 0 NOT NULL,
  "grade" INTEGER DEFAULT 0 NOT NULL,
  "valid_time" INTEGER DEFAULT 0 NOT NULL,
  "is_forever" SMALLINT DEFAULT 0 NOT NULL,
  "mer_id" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "remind" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "discount" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "ul_uid_status_del" ON "user_level" ("uid", "status", "is_del");
CREATE INDEX IF NOT EXISTS "ul_uid_level" ON "user_level" ("uid", "level_id");

-- 仅补缺失配置；PHP 迁移过来的实际商城配置始终优先。
INSERT INTO "system_config" ("menu_name", "value", "info")
SELECT seed.menu_name, seed.value, seed.info
FROM (VALUES
  ('order_give_integral', '1', '实际支付 1 元赠送积分数'),
  ('member_func_status', '1', '商城用户等级功能开关'),
  ('order_give_exp', '1', '实际支付 1 元赠送经验数'),
  ('member_card_status', '1', '付费会员功能开关')
) AS seed(menu_name, value, info)
WHERE NOT EXISTS (
  SELECT 1 FROM "system_config" existing
  WHERE existing."menu_name" = seed.menu_name AND existing."is_store" = 0
);
`;
  }

  private migration_0020(): string {
    return `
-- 事业部/代理商/员工差额分佣：下单快照，确认收货入账，退款累计冲正。
-- 不回填历史订单佣金；执行前必须检查历史 user_brokerage 是否存在重复角色流水。
ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS "division_name" VARCHAR(32) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_type" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_status" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "agent_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "staff_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_percent" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_end_time" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_change_time" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_invite" INTEGER DEFAULT 0 NOT NULL;
CREATE INDEX IF NOT EXISTS "user_division_parent" ON "user" ("division_id", "agent_id", "staff_id");
CREATE INDEX IF NOT EXISTS "user_division_role" ON "user" ("division_type", "division_status", "division_end_time");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_division_type_ck' AND conrelid = '"user"'::regclass) THEN
    ALTER TABLE "user" ADD CONSTRAINT "user_division_type_ck" CHECK ("division_type" BETWEEN 0 AND 3) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_division_status_ck' AND conrelid = '"user"'::regclass) THEN
    ALTER TABLE "user" ADD CONSTRAINT "user_division_status_ck" CHECK ("division_status" BETWEEN 0 AND 1) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_division_percent_ck' AND conrelid = '"user"'::regclass) THEN
    ALTER TABLE "user" ADD CONSTRAINT "user_division_percent_ck" CHECK ("division_percent" BETWEEN 0 AND 100) NOT VALID;
  END IF;
END $$;

ALTER TABLE "store_order"
  ADD COLUMN IF NOT EXISTS "division_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_brokerage" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_agent_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_agent_brokerage" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_staff_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "division_staff_brokerage" NUMERIC(12,2) DEFAULT '0.00' NOT NULL;
CREATE INDEX IF NOT EXISTS "so_division_id" ON "store_order" ("division_id");
CREATE INDEX IF NOT EXISTS "so_division_agent_id" ON "store_order" ("division_agent_id");
CREATE INDEX IF NOT EXISTS "so_division_staff_id" ON "store_order" ("division_staff_id");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'so_division_brokerage_ck' AND conrelid = 'store_order'::regclass) THEN
    ALTER TABLE "store_order" ADD CONSTRAINT "so_division_brokerage_ck"
      CHECK ("division_brokerage" >= 0 AND "division_agent_brokerage" >= 0 AND "division_staff_brokerage" >= 0) NOT VALID;
  END IF;
END $$;

ALTER TABLE "user_brokerage" ADD COLUMN IF NOT EXISTS "source_type" VARCHAR(64) DEFAULT '' NOT NULL;
CREATE INDEX IF NOT EXISTS "ub_refund_source"
  ON "user_brokerage" ("link_id", "pm", "type", "source_type");
CREATE UNIQUE INDEX IF NOT EXISTS "ub_order_division_income_uq"
  ON "user_brokerage" ("uid", "link_id", "type")
  WHERE "pm" = 1 AND "type" IN ('staff_brokerage', 'agent_brokerage', 'division_brokerage');

INSERT INTO "system_config" ("menu_name", "value", "info")
SELECT 'division_status', '1', '事业部/代理商分佣开关'
WHERE NOT EXISTS (
  SELECT 1 FROM "system_config" existing
  WHERE existing."menu_name" = 'division_status' AND existing."is_store" = 0
);
`;
  }

  private migration_0021(): string {
    return `
-- 事业部管理面：代理商申请工作流、管理员事业部作用域与查询索引。
CREATE TABLE IF NOT EXISTS "division_apply" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "division_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "phone" VARCHAR(32) DEFAULT '0' NOT NULL,
  "division_id" INTEGER DEFAULT 0 NOT NULL,
  "division_invite" INTEGER DEFAULT 0 NOT NULL,
  "images" VARCHAR(2000) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "status_time" INTEGER DEFAULT 0 NOT NULL,
  "refusal_reason" VARCHAR(1000) DEFAULT '' NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "da_division_status"
  ON "division_apply" ("division_id", "status", "is_del");
CREATE INDEX IF NOT EXISTS "da_status_time"
  ON "division_apply" ("status", "add_time");
WITH duplicate_applications AS (
  SELECT "id", row_number() OVER (PARTITION BY "uid" ORDER BY "id" DESC) AS duplicate_rank
  FROM "division_apply"
  WHERE "is_del" = 0
)
UPDATE "division_apply" target
SET "is_del" = 1
FROM duplicate_applications duplicate
WHERE target."id" = duplicate."id" AND duplicate."duplicate_rank" > 1;
CREATE UNIQUE INDEX IF NOT EXISTS "da_uid_active_uq"
  ON "division_apply" ("uid") WHERE "is_del" = 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'da_status_ck' AND conrelid = 'division_apply'::regclass) THEN
    ALTER TABLE "division_apply" ADD CONSTRAINT "da_status_ck"
      CHECK ("status" BETWEEN 0 AND 2) NOT VALID;
  END IF;
END $$;

ALTER TABLE "system_admin" ADD COLUMN IF NOT EXISTS "division_id" INTEGER DEFAULT 0 NOT NULL;
CREATE INDEX IF NOT EXISTS "sa_division" ON "system_admin" ("division_id", "is_del", "status");

-- 邀请码仅约束非零值；历史重复值先保留，待上线前审计后再加唯一约束。
CREATE INDEX IF NOT EXISTS "user_division_invite" ON "user" ("division_invite")
  WHERE "division_invite" <> 0;
`;
  }

  private migration_0022(): string {
    return `
-- 后台菜单级 ACL：保留 PHP system_menus 结构，并由 Worker 权限目录执行服务端鉴权。
CREATE TABLE IF NOT EXISTS "system_menus" (
  "id" SERIAL PRIMARY KEY,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "icon" VARCHAR(50) DEFAULT '' NOT NULL,
  "menu_name" VARCHAR(64) DEFAULT '' NOT NULL,
  "module" VARCHAR(32) DEFAULT '' NOT NULL,
  "controller" VARCHAR(64) DEFAULT '' NOT NULL,
  "action" VARCHAR(32) DEFAULT '' NOT NULL,
  "api_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "methods" VARCHAR(32) DEFAULT '' NOT NULL,
  "params" VARCHAR(512) DEFAULT '[]' NOT NULL,
  "sort" INTEGER DEFAULT 1 NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "is_show_path" SMALLINT DEFAULT 0 NOT NULL,
  "access" SMALLINT DEFAULT 1 NOT NULL,
  "menu_path" VARCHAR(255) DEFAULT '' NOT NULL,
  "path" VARCHAR(255) DEFAULT '' NOT NULL,
  "auth_type" SMALLINT DEFAULT 0 NOT NULL,
  "header" VARCHAR(50) DEFAULT '' NOT NULL,
  "is_header" SMALLINT DEFAULT 0 NOT NULL,
  "unique_auth" VARCHAR(150) DEFAULT '' NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sm_parent_sort"
  ON "system_menus" ("type", "pid", "sort");
CREATE INDEX IF NOT EXISTS "sm_unique_auth"
  ON "system_menus" ("unique_auth", "is_del");
CREATE INDEX IF NOT EXISTS "sm_api_method"
  ON "system_menus" ("type", "auth_type", "methods", "api_url", "is_del");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sm_type_ck' AND conrelid = 'system_menus'::regclass) THEN
    ALTER TABLE "system_menus" ADD CONSTRAINT "sm_type_ck"
      CHECK ("type" BETWEEN 1 AND 4) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sm_auth_type_ck' AND conrelid = 'system_menus'::regclass) THEN
    ALTER TABLE "system_menus" ADD CONSTRAINT "sm_auth_type_ck"
      CHECK ("auth_type" BETWEEN 0 AND 2) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sm_flags_ck' AND conrelid = 'system_menus'::regclass) THEN
    ALTER TABLE "system_menus" ADD CONSTRAINT "sm_flags_ck"
      CHECK (
        "is_show" BETWEEN 0 AND 1 AND
        "is_show_path" BETWEEN 0 AND 1 AND
        "access" BETWEEN 0 AND 1 AND
        "is_header" BETWEEN 0 AND 1 AND
        "is_del" BETWEEN 0 AND 1
      ) NOT VALID;
  END IF;
END $$;
`;
  }

  private migration_0023(): string {
    return `
-- 供应商实物商品全生命周期：详情、SKU/库存审计与租户查询索引。
CREATE TABLE IF NOT EXISTS "store_product_description" (
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "description" TEXT,
  "type" SMALLINT DEFAULT 0 NOT NULL
);

-- Preserve every existing row. If duplicates exist this statement fails
-- visibly; the read-only migration planner reports duplicate group/excess-row
-- counts so an operator can make an explicit archival or merge decision.
CREATE UNIQUE INDEX IF NOT EXISTS "spd_product_type_unique"
  ON "store_product_description" ("product_id", "type");
CREATE INDEX IF NOT EXISTS "spd_type_product"
  ON "store_product_description" ("type", "product_id");

CREATE TABLE IF NOT EXISTS "store_product_stock_record" (
  "id" SERIAL PRIMARY KEY,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "unique" VARCHAR(32) DEFAULT '' NOT NULL,
  "cost_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  "number" INTEGER DEFAULT 0 NOT NULL,
  "pm" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "spsr_product_time"
  ON "store_product_stock_record" ("product_id", "add_time");
CREATE INDEX IF NOT EXISTS "spsr_unique_time"
  ON "store_product_stock_record" ("unique", "add_time");

CREATE INDEX IF NOT EXISTS "sp_supplier_list"
  ON "store_product" ("type", "relation_id", "is_del", "is_show", "id" DESC);
CREATE INDEX IF NOT EXISTS "spc_supplier_tree"
  ON "store_product_category" ("type", "relation_id", "pid", "is_show", "sort" DESC);
CREATE INDEX IF NOT EXISTS "spav_product_type_suk"
  ON "store_product_attr_value" ("product_id", "type", "suk");
CREATE INDEX IF NOT EXISTS "spr_product_type_relation"
  ON "store_product_relation" ("product_id", "type", "relation_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spd_type_ck' AND conrelid = 'store_product_description'::regclass) THEN
    ALTER TABLE "store_product_description" ADD CONSTRAINT "spd_type_ck"
      CHECK ("type" BETWEEN 0 AND 7) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spsr_pm_ck' AND conrelid = 'store_product_stock_record'::regclass) THEN
    ALTER TABLE "store_product_stock_record" ADD CONSTRAINT "spsr_pm_ck"
      CHECK ("pm" BETWEEN 0 AND 1) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spsr_number_ck' AND conrelid = 'store_product_stock_record'::regclass) THEN
    ALTER TABLE "store_product_stock_record" ADD CONSTRAINT "spsr_number_ck"
      CHECK ("number" >= 0) NOT VALID;
  END IF;
END $$;
`;
  }

  private migration_0024(): string {
    return `
-- 供应商拆单/分包发货：补齐 PHP store_order_cart_info 拆分状态，并为待发货子单查询建索引。
ALTER TABLE "store_order_cart_info"
  ADD COLUMN IF NOT EXISTS "old_cart_id" VARCHAR(50) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "split_surplus_num" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "split_status" SMALLINT DEFAULT 0 NOT NULL;

-- 旧 TS 订单未维护 split_surplus_num；仅初始化从未拆分的行，退款数量不再进入可发货数量。
UPDATE "store_order_cart_info"
SET "split_surplus_num" = greatest("cart_num" - "refund_num", 0),
    "surplus_num" = greatest("cart_num" - "refund_num", 0)
WHERE "split_status" = 0
  AND "split_surplus_num" = 0
  AND "cart_num" > 0;

CREATE INDEX IF NOT EXISTS "soci_split_pending"
  ON "store_order_cart_info" ("oid", "split_status", "id");
CREATE INDEX IF NOT EXISTS "soci_old_cart_id"
  ON "store_order_cart_info" ("old_cart_id")
  WHERE "old_cart_id" <> '';
CREATE INDEX IF NOT EXISTS "so_split_pending"
  ON "store_order" ("pid", "supplier_id", "status", "is_system_del", "id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'soci_split_state_ck'
      AND conrelid = 'store_order_cart_info'::regclass
  ) THEN
    ALTER TABLE "store_order_cart_info"
      ADD CONSTRAINT "soci_split_state_ck"
      CHECK ("split_status" BETWEEN 0 AND 2 AND "split_surplus_num" >= 0) NOT VALID;
  END IF;
END $$;
`;
  }

  private migration_0025(): string {
    return `
-- 支付后按 Supplier 自动分配订单：显式记录待分配状态，避免混合订单在子单生成前被错误履约。
ALTER TABLE "store_order"
  ADD COLUMN IF NOT EXISTS "supplier_allocation_status" SMALLINT DEFAULT 0 NOT NULL;

-- 已存在的审计主单已经完成过拆分；历史普通/单 Supplier 订单保持 0，由后续处理按需确认。
UPDATE "store_order"
SET "supplier_allocation_status" = 2
WHERE "pid" = -1
  AND "supplier_allocation_status" = 0;

CREATE INDEX IF NOT EXISTS "so_supplier_allocation_pending"
  ON "store_order" ("paid", "supplier_allocation_status", "id")
  WHERE "supplier_allocation_status" = 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'so_supplier_allocation_status_ck'
      AND conrelid = 'store_order'::regclass
  ) THEN
    ALTER TABLE "store_order"
      ADD CONSTRAINT "so_supplier_allocation_status_ck"
      CHECK ("supplier_allocation_status" BETWEEN 0 AND 2) NOT VALID;
  END IF;
END $$;
`;
  }

  private migration_0026(): string {
    return `
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
`;
  }

  private migration_0027(): string {
    return `
-- Resumable MySQL -> PostgreSQL data migration ledger. It stores no credentials.
CREATE TABLE IF NOT EXISTS "data_migration_run" (
  "run_id" VARCHAR(64) PRIMARY KEY,
  "manifest_version" VARCHAR(32) NOT NULL,
  "source_fingerprint" CHAR(64) NOT NULL,
  "source_prefix" VARCHAR(32) DEFAULT 'eb_' NOT NULL,
  "status" VARCHAR(32) DEFAULT 'RUNNING' NOT NULL,
  "started_at" TIMESTAMPTZ DEFAULT now() NOT NULL,
  "completed_at" TIMESTAMPTZ,
  "last_error" TEXT DEFAULT '' NOT NULL,
  CONSTRAINT "dmr_status_ck"
    CHECK ("status" IN ('RUNNING', 'COMPLETED', 'NEEDS_REVIEW', 'FAILED'))
);

CREATE TABLE IF NOT EXISTS "data_migration_checkpoint" (
  "run_id" VARCHAR(64) NOT NULL REFERENCES "data_migration_run" ("run_id") ON DELETE CASCADE,
  "table_name" VARCHAR(64) NOT NULL,
  -- NULL means no source key has committed yet; this avoids skipping valid
  -- negative keys on the first keyset page.
  "last_key" NUMERIC(30,0),
  -- Composite integer keys use a JSON array of decimal strings so cursor
  -- precision is preserved across JavaScript and PostgreSQL.
  "last_key_json" JSONB,
  "source_count" BIGINT DEFAULT 0 NOT NULL,
  "inserted_count" BIGINT DEFAULT 0 NOT NULL,
  "conflict_count" BIGINT DEFAULT 0 NOT NULL,
  "status" VARCHAR(32) DEFAULT 'RUNNING' NOT NULL,
  "updated_at" TIMESTAMPTZ DEFAULT now() NOT NULL,
  PRIMARY KEY ("run_id", "table_name"),
  CONSTRAINT "dmc_counts_ck"
    CHECK ("source_count" >= 0 AND "inserted_count" >= 0 AND "conflict_count" >= 0),
  CONSTRAINT "dmc_status_ck"
    CHECK ("status" IN ('RUNNING', 'COMPLETED', 'CONFLICT', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS "dmc_table_status"
  ON "data_migration_checkpoint" ("table_name", "status", "updated_at");
`;
  }

  private migration_0028(): string {
    return `-- Reconcile the filesystem and Worker-embedded schema paths. All statements
-- are idempotent so this also repairs databases created by either older path.
ALTER TABLE "store_order"
  ADD COLUMN IF NOT EXISTS "refund_type" SMALLINT DEFAULT 0 NOT NULL;

ALTER TABLE "store_service"
  ADD COLUMN IF NOT EXISTS "mer_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "notify" SMALLINT DEFAULT 1 NOT NULL;

ALTER TABLE "wechat_user"
  ADD COLUMN IF NOT EXISTS "city" VARCHAR(64) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "language" VARCHAR(64) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "province" VARCHAR(64) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "country" VARCHAR(64) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "remark" VARCHAR(256) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "groupid" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "tagid_list" VARCHAR(256) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "second" INTEGER DEFAULT 0 NOT NULL;

CREATE TABLE IF NOT EXISTS "store_service_record" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER DEFAULT 0 NOT NULL,
  "to_uid" INTEGER DEFAULT 0 NOT NULL,
  "nickname" VARCHAR(50) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_tourist" SMALLINT DEFAULT 0 NOT NULL,
  "online" SMALLINT DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "mssage_num" INTEGER DEFAULT 0 NOT NULL,
  "message" TEXT DEFAULT '' NOT NULL,
  "message_type" SMALLINT DEFAULT 1 NOT NULL
);

CREATE INDEX IF NOT EXISTS "ssr_to_uid_idx" ON "store_service_record" ("to_uid");`;
  }

  private migration_0029(): string {
    return `-- Upgrade existing migration ledgers created before composite keyset support.
ALTER TABLE "data_migration_checkpoint"
  ADD COLUMN IF NOT EXISTS "last_key_json" JSONB;`;
  }

  private migration_0030(): string {
    return `-- Preserve low-cardinality legacy fields that were previously the only
-- source-only column on their shared table. Defaults keep new Worker writes
-- backward compatible while allowing the old values to migrate losslessly.
ALTER TABLE "store_order_refund"
  ADD COLUMN IF NOT EXISTS "refund_goods_type" SMALLINT DEFAULT 1 NOT NULL,
  ALTER COLUMN "refund_phone" TYPE VARCHAR(32),
  ALTER COLUMN "refund_express" TYPE VARCHAR(100),
  ALTER COLUMN "refund_express_name" TYPE VARCHAR(255);

ALTER TABLE "store_product_words"
  ADD COLUMN IF NOT EXISTS "is_del" SMALLINT DEFAULT 0 NOT NULL;

ALTER TABLE "system_admin"
  ADD COLUMN IF NOT EXISTS "is_way" SMALLINT DEFAULT 0 NOT NULL;

ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS "replace_order_num" VARCHAR(32) DEFAULT '' NOT NULL;

ALTER TABLE "user_recharge"
  ADD COLUMN IF NOT EXISTS "auth_code" VARCHAR(50) DEFAULT '' NOT NULL;`;
  }

  private migration_0031(): string {
    return `-- Preserve the remaining legacy columns on seckill time slots and community
-- records. Widening the time labels avoids truncating the old VARCHAR(16)
-- values; all operations are additive or widening-only.
ALTER TABLE "store_seckill_time"
  ADD COLUMN IF NOT EXISTS "title" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "pic" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "describe" VARCHAR(255) DEFAULT '' NOT NULL,
  ALTER COLUMN "start_time" TYPE VARCHAR(16),
  ALTER COLUMN "end_time" TYPE VARCHAR(16);

ALTER TABLE "community"
  ADD COLUMN IF NOT EXISTS "refusal" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "sort" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_del" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "verify_time" INTEGER DEFAULT 0 NOT NULL;

ALTER TABLE "community_comment"
  ADD COLUMN IF NOT EXISTS "is_verify" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_show" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_reply" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "update_time" INTEGER DEFAULT 0 NOT NULL;

CREATE INDEX IF NOT EXISTS "c_public_feed"
  ON "community" ("status", "is_verify", "is_del", "add_time" DESC);

CREATE INDEX IF NOT EXISTS "cc_public_thread"
  ON "community_comment" (
    "community_id", "is_del", "is_show", "is_verify", "add_time" DESC
  );`;
  }

  private migration_0032(): string {
    return `-- Preserve PHP coupon ownership semantics while keeping the Worker coupon-type
-- snapshot separate. The legacy type value is an acquisition source such as
-- get or send, not the numeric coupon type stored by the Worker.
ALTER TABLE "store_coupon_user"
  ADD COLUMN IF NOT EXISTS "receive_source" VARCHAR(32) DEFAULT 'send' NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_fail" SMALLINT DEFAULT 0 NOT NULL;

CREATE INDEX IF NOT EXISTS "scu_uid_issue"
  ON "store_coupon_user" ("uid", "issue_coupon_id");`;
  }

  private migration_0033(): string {
    return `-- Preserve the remaining PHP metadata on admin logs, per-user system
-- messages, and user labels. Widening-only changes avoid truncating legacy
-- titles and label names.
ALTER TABLE "system_log"
  ADD COLUMN IF NOT EXISTS "store_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "path" VARCHAR(128) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "page" VARCHAR(64) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "method" VARCHAR(12) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "type" VARCHAR(32) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "merchant_id" INTEGER DEFAULT 0 NOT NULL;

ALTER TABLE "system_message"
  ADD COLUMN IF NOT EXISTS "mark" VARCHAR(50) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "look" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_del" SMALLINT DEFAULT 0 NOT NULL,
  ALTER COLUMN "title" TYPE VARCHAR(256);

ALTER TABLE "user_label"
  ADD COLUMN IF NOT EXISTS "type" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "relation_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "label_cate" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "tag_id" VARCHAR(64) DEFAULT '' NOT NULL,
  ALTER COLUMN "name" TYPE VARCHAR(255);

CREATE INDEX IF NOT EXISTS "syslog_admin_time"
  ON "system_log" ("admin_id", "add_time" DESC);

CREATE INDEX IF NOT EXISTS "syslog_type_time"
  ON "system_log" ("type", "add_time" DESC);

CREATE INDEX IF NOT EXISTS "smsg_visible_user"
  ON "system_message" ("user_id", "status", "is_del", "add_time" DESC);

CREATE INDEX IF NOT EXISTS "ulabel_scope_cate"
  ON "user_label" ("type", "relation_id", "label_cate", "id");`;
  }

  private migration_0034(): string {
    return `-- Preserve PHP reply-thread metadata and shipping-template ownership without
-- conflating the legacy owner type with the billing mode.
ALTER TABLE "store_product_reply_comment"
  ADD COLUMN IF NOT EXISTS "type" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "relation_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "pid" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "update_time" INTEGER DEFAULT 0 NOT NULL,
  ALTER COLUMN "content" TYPE VARCHAR(1000);

ALTER TABLE "shipping_templates"
  ADD COLUMN IF NOT EXISTS "owner_type" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "relation_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "appoint" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "no_delivery" SMALLINT DEFAULT 0 NOT NULL,
  ALTER COLUMN "name" TYPE VARCHAR(255);

CREATE INDEX IF NOT EXISTS "sprc_reply_parent"
  ON "store_product_reply_comment" ("reply_id", "pid", "add_time");

CREATE INDEX IF NOT EXISTS "st_owner_active"
  ON "shipping_templates" ("owner_type", "relation_id", "is_del", "sort" DESC);`;
  }

  private migration_0035(): string {
    return `-- Preserve the PHP shipping-region hierarchy and grouping fields. Source
-- temp_id/city_id/group are copied to template_id/region_id/billing_group by
-- the explicit data-migration manifest.
ALTER TABLE "shipping_templates_region"
  ADD COLUMN IF NOT EXISTS "province_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "billing_group" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "value" VARCHAR(200) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "uniqid" VARCHAR(32) DEFAULT '' NOT NULL;

CREATE INDEX IF NOT EXISTS "str_template_region"
  ON "shipping_templates_region" ("template_id", "region_id");

CREATE INDEX IF NOT EXISTS "str_template_uniqid"
  ON "shipping_templates_region" ("template_id", "uniqid");`;
  }

  private migration_0036(): string {
    return `-- Preserve PHP withdrawal fees, pre-withdrawal balance, payment-account
-- details, rejection time, and receipt QR code without overloading the
-- Worker-only normalized extract_number field.
ALTER TABLE "user_extract"
  ADD COLUMN IF NOT EXISTS "alipay_code" VARCHAR(64) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "extract_fee" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "mark" VARCHAR(512) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "balance" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "fail_time" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "wechat" VARCHAR(15) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "qrcode_url" VARCHAR(255) DEFAULT '' NOT NULL,
  ALTER COLUMN "real_name" TYPE VARCHAR(64),
  ALTER COLUMN "bank_address" TYPE VARCHAR(256);

CREATE INDEX IF NOT EXISTS "ue_uid_time"
  ON "user_extract" ("uid", "add_time" DESC);

CREATE INDEX IF NOT EXISTS "ue_status_time"
  ON "user_extract" ("status", "add_time" DESC);`;
  }

  private migration_0037(): string {
    return `-- Preserve order-line promotion/write-off state and the complete PHP group-buy
-- participant snapshot. member_count separates Worker runtime occupancy from
-- PHP store_pink.people, which is the required group size.
ALTER TABLE "store_order_cart_info"
  ADD COLUMN IF NOT EXISTS "promotions_id" TEXT,
  ADD COLUMN IF NOT EXISTS "write_times" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "write_surplus_times" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "write_start" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "write_end" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_advent_sms" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_expire_sms" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_writeoff" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "writeoff_time" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "add_time" INTEGER DEFAULT 0 NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "soci_oid_unique_uq"
  ON "store_order_cart_info" ("oid", "unique");
CREATE INDEX IF NOT EXISTS "soci_cart_refund"
  ON "store_order_cart_info" ("cart_id", "refund_num");
CREATE INDEX IF NOT EXISTS "soci_product"
  ON "store_order_cart_info" ("product_id");

ALTER TABLE "store_pink"
  ADD COLUMN IF NOT EXISTS "nickname" VARCHAR(64) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "avatar" VARCHAR(256) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "total_num" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "total_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_tpl" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_refund" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_virtual" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "member_count" INTEGER DEFAULT 0 NOT NULL;

-- Rows created by the pre-parity Worker used people as the current count and
-- have none of the newly preserved PHP snapshots. Convert only that signature;
-- imported PHP participant rows retain people as the required group size.
UPDATE "store_pink" AS p
SET "member_count" = GREATEST(p."people", 1),
    "people" = CASE WHEN c."people" > 0 THEN c."people" ELSE p."people" END
FROM "store_combination" AS c
WHERE p."combination_id" = c."id"
  AND p."member_count" = 0
  AND p."nickname" = ''
  AND p."avatar" = ''
  AND p."total_num" = 0
  AND p."total_price" = 0
  AND p."price" = 0;

CREATE INDEX IF NOT EXISTS "sp_leader_active"
  ON "store_pink" ("combination_id", "k_id", "status", "add_time" DESC);
CREATE INDEX IF NOT EXISTS "sp_group_member"
  ON "store_pink" ("k_id", "is_refund", "status");`;
  }

  private migration_0038(): string {
    return `-- Preserve PHP coupon issuance semantics. The data manifest swaps PHP type
-- (applicable scope) with coupon_type (discount mode) into their Worker roles.
ALTER TABLE "store_coupon_issue"
  ADD COLUMN IF NOT EXISTS "cid" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "category" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_permanent" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_give_subscribe" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_full_give" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "full_reduction" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_del" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "title" VARCHAR(64) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "integral" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "use_start_time" TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "use_end_time" TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "rule" TEXT,
  ADD COLUMN IF NOT EXISTS "legacy_product_ids" TEXT,
  ADD COLUMN IF NOT EXISTS "legacy_category_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "legacy_brand_id" INTEGER DEFAULT 0 NOT NULL,
  ALTER COLUMN "coupon_title" TYPE VARCHAR(255),
  ALTER COLUMN "receive_limit" SET DEFAULT 0,
  ALTER COLUMN "status" SET DEFAULT 1;

CREATE INDEX IF NOT EXISTS "sci_claim_window"
  ON "store_coupon_issue" ("status", "is_del", "receive_type", "start_time", "end_time");
CREATE INDEX IF NOT EXISTS "sci_scope"
  ON "store_coupon_issue" ("coupon_type", "legacy_category_id", "legacy_brand_id");`;
  }

  private migration_0039(): string {
    return `-- Preserve the complete PHP activity-product snapshots used by fulfillment,
-- shipping, forms, labels, refund policy, and merchandising.
ALTER TABLE "store_bargain"
  ADD COLUMN IF NOT EXISTS "type" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "product_type" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "relation_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "title" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "unit_name" VARCHAR(16) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "images" VARCHAR(2000) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "num" INTEGER DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "bargain_max_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "bargain_min_price" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "bargain_num" INTEGER DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "give_integral" NUMERIC(10, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "info" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "cost" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_hot" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_del" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_postage" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "postage" NUMERIC(10, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "rule" TEXT,
  ADD COLUMN IF NOT EXISTS "look" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "share" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "temp_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "weight" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "volume" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_support_refund" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "delivery_type" VARCHAR(10) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "freight" SMALLINT DEFAULT 2 NOT NULL,
  ADD COLUMN IF NOT EXISTS "custom_form" TEXT,
  ADD COLUMN IF NOT EXISTS "system_form_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "store_label_id" TEXT,
  ADD COLUMN IF NOT EXISTS "ensure_id" TEXT,
  ADD COLUMN IF NOT EXISTS "specs" TEXT;

ALTER TABLE "store_combination"
  ADD COLUMN IF NOT EXISTS "type" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "product_type" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "relation_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "mer_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "images" VARCHAR(2000) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "attr" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "info" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_host" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_show" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_del" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "combination" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "mer_use" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_postage" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "postage" NUMERIC(10, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "effective_time" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "cost" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "browse" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "unit_name" VARCHAR(32) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "temp_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "weight" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "volume" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "once_num" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "virtual" INTEGER DEFAULT 100 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_support_refund" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "delivery_type" VARCHAR(10) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "freight" SMALLINT DEFAULT 2 NOT NULL,
  ADD COLUMN IF NOT EXISTS "custom_form" TEXT,
  ADD COLUMN IF NOT EXISTS "system_form_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "store_label_id" TEXT,
  ADD COLUMN IF NOT EXISTS "ensure_id" TEXT,
  ADD COLUMN IF NOT EXISTS "specs" TEXT;

ALTER TABLE "store_integral"
  ADD COLUMN IF NOT EXISTS "type" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "product_type" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "relation_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "images" VARCHAR(2000) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "unit_name" VARCHAR(16) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_host" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_show" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_del" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "once_num" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "delivery_type" VARCHAR(10) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "freight" SMALLINT DEFAULT 2 NOT NULL,
  ADD COLUMN IF NOT EXISTS "postage" NUMERIC(10, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "temp_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "custom_form" TEXT,
  ADD COLUMN IF NOT EXISTS "system_form_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "store_label_id" TEXT,
  ADD COLUMN IF NOT EXISTS "ensure_id" TEXT,
  ADD COLUMN IF NOT EXISTS "specs" TEXT;

ALTER TABLE "store_seckill"
  ADD COLUMN IF NOT EXISTS "activity_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "type" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "product_type" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "relation_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "images" VARCHAR(2000) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "info" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "cost" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "give_integral" NUMERIC(10, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "unit_name" VARCHAR(16) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "postage" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "description" TEXT,
  ADD COLUMN IF NOT EXISTS "is_postage" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_hot" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_del" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_show" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "temp_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "weight" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "volume" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "once_num" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_support_refund" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "delivery_type" VARCHAR(10) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "freight" SMALLINT DEFAULT 2 NOT NULL,
  ADD COLUMN IF NOT EXISTS "custom_form" TEXT,
  ADD COLUMN IF NOT EXISTS "system_form_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "store_label_id" TEXT,
  ADD COLUMN IF NOT EXISTS "ensure_id" TEXT,
  ADD COLUMN IF NOT EXISTS "specs" TEXT,
  ALTER COLUMN "time_id" TYPE TEXT;

CREATE INDEX IF NOT EXISTS "sbarg_visible"
  ON "store_bargain" ("status", "is_del", "stop_time", "sort" DESC);
CREATE INDEX IF NOT EXISTS "scomb_visible"
  ON "store_combination" ("status", "is_show", "is_del", "stop_time", "sort" DESC);
CREATE INDEX IF NOT EXISTS "sint_visible"
  ON "store_integral" ("status", "is_show", "is_del", "sort" DESC);
CREATE INDEX IF NOT EXISTS "sseckill_visible"
  ON "store_seckill" ("status", "is_show", "is_del", "stop_time", "sort" DESC);`;
  }

  private migration_0040(): string {
    return `-- Preserve the complete PHP order snapshot. Several of these columns are
-- redundant with newer normalized refund and fulfillment tables, but they are
-- still required for lossless import and legacy reporting/API compatibility.
ALTER TABLE "store_order"
  ADD COLUMN IF NOT EXISTS "refund_express" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "refund_reason_wap_img" TEXT,
  ADD COLUMN IF NOT EXISTS "refund_reason_wap_explain" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "refund_reason_time" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "refund_reason_wap" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "express_dump" TEXT,
  ADD COLUMN IF NOT EXISTS "kuaidi_label" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "mer_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "cost" NUMERIC(12, 2) DEFAULT '0.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "staff_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "clerk_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "product_type" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "virtual_info" TEXT,
  ADD COLUMN IF NOT EXISTS "custom_form" TEXT,
  ADD COLUMN IF NOT EXISTS "promotions_give" TEXT,
  ADD COLUMN IF NOT EXISTS "give_integral" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "give_coupon" TEXT,
  ADD COLUMN IF NOT EXISTS "erp_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "erp_order_id" VARCHAR(32) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "kuaidi_task_id" VARCHAR(128) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "kuaidi_order_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_stock_up" SMALLINT DEFAULT 0 NOT NULL;

CREATE INDEX IF NOT EXISTS "so_erp_order_id"
  ON "store_order" ("erp_order_id");`;
  }

  private migration_0041(): string {
    return `-- Preserve PHP designated-free-shipping and no-delivery region rules.
CREATE TABLE IF NOT EXISTS "shipping_templates_free" (
  "id" SERIAL PRIMARY KEY,
  "province_id" INTEGER DEFAULT 0 NOT NULL,
  "temp_id" INTEGER DEFAULT 0 NOT NULL,
  "city_id" INTEGER DEFAULT 0 NOT NULL,
  "number" NUMERIC(10, 2) DEFAULT '0.00' NOT NULL,
  "price" NUMERIC(10, 2) DEFAULT '0.00' NOT NULL,
  "group" SMALLINT DEFAULT 1 NOT NULL,
  "value" VARCHAR(200) DEFAULT '' NOT NULL,
  "uniqid" VARCHAR(32) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "stf_temp_city"
  ON "shipping_templates_free" ("temp_id", "city_id");
CREATE INDEX IF NOT EXISTS "stf_temp_uniqid"
  ON "shipping_templates_free" ("temp_id", "uniqid");

CREATE TABLE IF NOT EXISTS "shipping_templates_no_delivery" (
  "id" SERIAL PRIMARY KEY,
  "province_id" INTEGER DEFAULT 0 NOT NULL,
  "temp_id" INTEGER DEFAULT 0 NOT NULL,
  "city_id" INTEGER DEFAULT 0 NOT NULL,
  "value" VARCHAR(200) DEFAULT '' NOT NULL,
  "uniqid" VARCHAR(32) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "stnd_temp_city"
  ON "shipping_templates_no_delivery" ("temp_id", "city_id");
CREATE INDEX IF NOT EXISTS "stnd_temp_uniqid"
  ON "shipping_templates_no_delivery" ("temp_id", "uniqid");`;
  }

  private migration_0042(): string {
    return `-- Preserve every eb_express column before importing it into express_company.
ALTER TABLE "express_company"
  ALTER COLUMN "code" TYPE VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "partner_id" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "partner_key" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "net" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "check_man" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "partner_name" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_code" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "courier_name" VARCHAR(100) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "customer_name" VARCHAR(100) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "code_name" VARCHAR(100) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "account" VARCHAR(100) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "key" VARCHAR(100) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "net_name" VARCHAR(100) DEFAULT '' NOT NULL;

CREATE INDEX IF NOT EXISTS "ec_visible_sort"
  ON "express_company" ("is_show", "status", "sort" DESC);

-- eb_article stores numeric values in varchar columns and keeps article body
-- content in eb_article_content. Preserve its complete metadata here; content
-- remains the target-owned body column until the separate content table is joined.
ALTER TABLE "system_article"
  ALTER COLUMN "author" TYPE VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "image_input" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "share_title" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "share_synopsis" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "visit" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "likes" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "sort" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "url" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "hide" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "admin_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "mer_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "product_id" INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_hot" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_banner" SMALLINT DEFAULT 0 NOT NULL;

CREATE INDEX IF NOT EXISTS "sa_visible_sort"
  ON "system_article" ("status", "is_del", "hide", "sort" DESC);`;
  }

  private migration_0043(): string {
    return `-- PHP shipping administration uses system_city, while order calculation expands
-- a selected city_area row's path to match district, city, province, then nationwide.
CREATE TABLE IF NOT EXISTS "system_city" (
  "id" SERIAL PRIMARY KEY,
  "city_id" INTEGER DEFAULT 0 NOT NULL,
  "level" INTEGER DEFAULT 0 NOT NULL,
  "parent_id" INTEGER DEFAULT 0 NOT NULL,
  "area_code" VARCHAR(30) DEFAULT '' NOT NULL,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "merger_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "lng" VARCHAR(50) DEFAULT '' NOT NULL,
  "lat" VARCHAR(50) DEFAULT '' NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sc_city_id" ON "system_city" ("city_id");
CREATE INDEX IF NOT EXISTS "sc_parent_show" ON "system_city" ("parent_id", "is_show");

CREATE TABLE IF NOT EXISTS "city_area" (
  "id" SERIAL PRIMARY KEY,
  "path" VARCHAR(128) DEFAULT '/' NOT NULL,
  "parent_id" INTEGER DEFAULT 0 NOT NULL,
  "type" VARCHAR(32) DEFAULT '' NOT NULL,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "level" SMALLINT DEFAULT 0 NOT NULL,
  "code" VARCHAR(100) DEFAULT '' NOT NULL,
  "snum" INTEGER DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "ca_parent" ON "city_area" ("parent_id");
CREATE INDEX IF NOT EXISTS "ca_path" ON "city_area" ("path");`;
  }

  private migration_0044(): string {
    return `-- Preserve the PHP article taxonomy and one-to-one article body table.
CREATE TABLE IF NOT EXISTS "article_category" (
  "id" SERIAL PRIMARY KEY,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "title" VARCHAR(255) DEFAULT '' NOT NULL,
  "intr" VARCHAR(255) DEFAULT '' NOT NULL,
  "image" VARCHAR(255) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "hidden" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "ac_visible_sort"
  ON "article_category" ("status", "is_del", "hidden", "sort" DESC);

CREATE TABLE IF NOT EXISTS "article_content" (
  "nid" INTEGER PRIMARY KEY,
  "content" TEXT
);`;
  }

  private migration_0045(): string {
    return `-- Complete the legacy DIY page behind the TypeScript system_dise name.
ALTER TABLE "system_dise"
  ALTER COLUMN "name" TYPE VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "template_name" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "version" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "cover_image" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "default_value" TEXT,
  ADD COLUMN IF NOT EXISTS "is_diy" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_show" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_bg_color" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_bg_pic" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "color_picker" VARCHAR(50) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "bg_pic" VARCHAR(256) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "bg_tab_val" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "order_status" SMALLINT DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "my_banner_status" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "menu_status" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "service_status" SMALLINT DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "update_time" INTEGER DEFAULT 0 NOT NULL;

CREATE INDEX IF NOT EXISTS "sd_template_type"
  ON "system_dise" ("template_name", "type");
CREATE INDEX IF NOT EXISTS "sd_status_type"
  ON "system_dise" ("status", "type");

-- Preserve every template_message field while retaining the new textual channel.
ALTER TABLE "notification_template"
  ADD COLUMN IF NOT EXISTS "notification_id" VARCHAR(255) DEFAULT '0' NOT NULL,
  ADD COLUMN IF NOT EXISTS "legacy_type" SMALLINT DEFAULT -1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "kid" VARCHAR(255) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "example" VARCHAR(300) DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "tempid" VARCHAR(100) DEFAULT '' NOT NULL;

CREATE INDEX IF NOT EXISTS "nt_status_type"
  ON "notification_template" ("status", "type");
CREATE INDEX IF NOT EXISTS "nt_mark"
  ON "notification_template" ("mark");

CREATE TABLE IF NOT EXISTS "agreement" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "title" VARCHAR(200) DEFAULT '' NOT NULL,
  "content" TEXT,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "agreement_type" ON "agreement" ("type");
CREATE INDEX IF NOT EXISTS "agreement_visible" ON "agreement" ("status", "sort" DESC);

CREATE TABLE IF NOT EXISTS "system_notification" (
  "id" SERIAL PRIMARY KEY,
  "mark" VARCHAR(50) DEFAULT '' NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "title" VARCHAR(100) DEFAULT '' NOT NULL,
  "is_system" SMALLINT DEFAULT 0 NOT NULL,
  "is_app" SMALLINT DEFAULT 0 NOT NULL,
  "is_wechat" SMALLINT DEFAULT 0 NOT NULL,
  "is_routine" SMALLINT DEFAULT 0 NOT NULL,
  "is_sms" SMALLINT DEFAULT 0 NOT NULL,
  "is_ent_wechat" SMALLINT DEFAULT 0 NOT NULL,
  "system_title" VARCHAR(256) DEFAULT '' NOT NULL,
  "system_text" VARCHAR(512) DEFAULT '' NOT NULL,
  "app_id" INTEGER DEFAULT 0 NOT NULL,
  "wechat_id" VARCHAR(50) DEFAULT '0' NOT NULL,
  "routine_id" VARCHAR(50) DEFAULT '0' NOT NULL,
  "sms_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "sms_text" VARCHAR(255) DEFAULT '' NOT NULL,
  "ent_wechat_text" VARCHAR(512) DEFAULT '' NOT NULL,
  "variable" VARCHAR(256) DEFAULT '' NOT NULL,
  "url" VARCHAR(512) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sn_mark" ON "system_notification" ("mark");
CREATE INDEX IF NOT EXISTS "sn_type" ON "system_notification" ("type");

CREATE TABLE IF NOT EXISTS "system_notice" (
  "id" SERIAL PRIMARY KEY,
  "title" VARCHAR(64) DEFAULT '' NOT NULL,
  "type" VARCHAR(64) DEFAULT '' NOT NULL,
  "icon" VARCHAR(16) DEFAULT '' NOT NULL,
  "url" VARCHAR(64) DEFAULT '' NOT NULL,
  "table_title" VARCHAR(256) DEFAULT '' NOT NULL,
  "template" VARCHAR(64) DEFAULT '' NOT NULL,
  "push_admin" VARCHAR(128) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "snotice_type" ON "system_notice" ("type");
CREATE INDEX IF NOT EXISTS "snotice_status" ON "system_notice" ("status");

CREATE TABLE IF NOT EXISTS "system_notice_admin" (
  "id" SERIAL PRIMARY KEY,
  "notice_type" VARCHAR(64) DEFAULT '' NOT NULL,
  "admin_id" INTEGER DEFAULT 0 NOT NULL,
  "link_id" INTEGER DEFAULT 0 NOT NULL,
  "table_data" TEXT,
  "is_click" SMALLINT DEFAULT 0 NOT NULL,
  "is_visit" SMALLINT DEFAULT 0 NOT NULL,
  "visit_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sna_admin_type"
  ON "system_notice_admin" ("admin_id", "notice_type");
CREATE INDEX IF NOT EXISTS "sna_add_time" ON "system_notice_admin" ("add_time");
CREATE INDEX IF NOT EXISTS "sna_visit_click"
  ON "system_notice_admin" ("is_visit", "is_click");

CREATE TABLE IF NOT EXISTS "user_notice" (
  "id" SERIAL PRIMARY KEY,
  "uid" TEXT,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "user" VARCHAR(20) DEFAULT '' NOT NULL,
  "title" VARCHAR(20) DEFAULT '' NOT NULL,
  "content" VARCHAR(500) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_send" SMALLINT DEFAULT 0 NOT NULL,
  "send_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "un_send_time" ON "user_notice" ("is_send", "add_time");

CREATE TABLE IF NOT EXISTS "user_notice_see" (
  "id" SERIAL PRIMARY KEY,
  "nid" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "uns_uid_nid" ON "user_notice_see" ("uid", "nid");
CREATE INDEX IF NOT EXISTS "uns_nid" ON "user_notice_see" ("nid");`;
  }

  private migration_0046(): string {
    return `-- Preserve legacy community topics, polymorphic relations, and author counters.
CREATE TABLE IF NOT EXISTS "community_topic" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "icon" VARCHAR(128) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "is_recommend" SMALLINT DEFAULT 0 NOT NULL,
  "use_num" INTEGER DEFAULT 0 NOT NULL,
  "view_num" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "ct_visible_sort"
  ON "community_topic" ("status", "is_del", "sort", "id");
CREATE INDEX IF NOT EXISTS "ct_recommend_sort"
  ON "community_topic" ("status", "is_del", "is_recommend", "sort");

CREATE TABLE IF NOT EXISTS "community_relevance" (
  "id" SERIAL PRIMARY KEY,
  "left_id" INTEGER DEFAULT 0 NOT NULL,
  "right_id" INTEGER DEFAULT 0 NOT NULL,
  "type" VARCHAR(32) NOT NULL
);

CREATE INDEX IF NOT EXISTS "cr_left_type_right"
  ON "community_relevance" ("left_id", "type", "right_id");
CREATE INDEX IF NOT EXISTS "cr_right_type_left"
  ON "community_relevance" ("right_id", "type", "left_id");

CREATE TABLE IF NOT EXISTS "community_user" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 2 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "nickname" VARCHAR(255) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(255) DEFAULT '' NOT NULL,
  "desc" VARCHAR(255) DEFAULT '' NOT NULL,
  "community_num" INTEGER DEFAULT 0 NOT NULL,
  "follow_num" INTEGER DEFAULT 0 NOT NULL,
  "fans_num" INTEGER DEFAULT 0 NOT NULL,
  "friend_num" INTEGER DEFAULT 0 NOT NULL,
  "like_num" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "cu_relation_type"
  ON "community_user" ("relation_id", "type", "is_del");
CREATE INDEX IF NOT EXISTS "cu_public_activity"
  ON "community_user" ("status", "is_del", "community_num", "id");`;
  }

  private migration_0047(): string {
    return `-- Preserve order-level savings, invoice snapshots, promotion allocation, and write-off evidence.
CREATE TABLE IF NOT EXISTS "store_order_economize" (
  "id" SERIAL PRIMARY KEY,
  "order_id" VARCHAR(32) DEFAULT '' NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "order_type" SMALLINT DEFAULT 1 NOT NULL,
  "pay_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "postage_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "member_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "offline_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "coupon_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "soe_order_uid_uq"
  ON "store_order_economize" ("order_id", "uid");
CREATE INDEX IF NOT EXISTS "soe_uid_time"
  ON "store_order_economize" ("uid", "add_time");
CREATE INDEX IF NOT EXISTS "soe_status_time"
  ON "store_order_economize" ("status", "add_time");

CREATE TABLE IF NOT EXISTS "store_order_invoice" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "category" VARCHAR(10) DEFAULT 'order' NOT NULL,
  "order_id" INTEGER DEFAULT 0 NOT NULL,
  "invoice_id" INTEGER DEFAULT 0 NOT NULL,
  "header_type" SMALLINT DEFAULT 1 NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "duty_number" VARCHAR(50) DEFAULT '' NOT NULL,
  "drawer_phone" VARCHAR(30) DEFAULT '' NOT NULL,
  "email" VARCHAR(100) DEFAULT '' NOT NULL,
  "tell" VARCHAR(30) DEFAULT '' NOT NULL,
  "address" VARCHAR(255) DEFAULT '' NOT NULL,
  "bank" VARCHAR(50) DEFAULT '' NOT NULL,
  "card_number" VARCHAR(50) DEFAULT '' NOT NULL,
  "is_pay" SMALLINT DEFAULT 0 NOT NULL,
  "is_refund" SMALLINT DEFAULT 0 NOT NULL,
  "is_invoice" SMALLINT DEFAULT 0 NOT NULL,
  "invoice_number" VARCHAR(50) DEFAULT '' NOT NULL,
  "invoice_amount" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "remark" VARCHAR(255) DEFAULT '' NOT NULL,
  "invoice_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "soi_order" ON "store_order_invoice" ("order_id");
CREATE INDEX IF NOT EXISTS "soi_uid_state_time"
  ON "store_order_invoice" ("uid", "is_del", "is_refund", "add_time");
CREATE INDEX IF NOT EXISTS "soi_issue_state_time"
  ON "store_order_invoice" ("is_pay", "is_del", "is_invoice", "add_time");

CREATE TABLE IF NOT EXISTS "store_order_promotions" (
  "id" SERIAL PRIMARY KEY,
  "oid" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "promotions_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "promotions_price" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sop_order_promotion"
  ON "store_order_promotions" ("oid", "promotions_id");
CREATE INDEX IF NOT EXISTS "sop_order_product"
  ON "store_order_promotions" ("oid", "product_id");
CREATE INDEX IF NOT EXISTS "sop_uid_time"
  ON "store_order_promotions" ("uid", "add_time");

CREATE TABLE IF NOT EXISTS "store_order_writeoff" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "oid" INTEGER DEFAULT 0 NOT NULL,
  "order_cart_id" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "staff_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "product_type" SMALLINT DEFAULT 0 NOT NULL,
  "writeoff_num" INTEGER DEFAULT 1 NOT NULL,
  "writeoff_price" NUMERIC(10,2) DEFAULT '0.00' NOT NULL,
  "writeoff_code" VARCHAR(30) DEFAULT '' NOT NULL,
  "is_admin" SMALLINT DEFAULT 0 NOT NULL,
  "admin_id" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sow_order_time"
  ON "store_order_writeoff" ("oid", "add_time");
CREATE INDEX IF NOT EXISTS "sow_cart_time"
  ON "store_order_writeoff" ("order_cart_id", "add_time");
CREATE INDEX IF NOT EXISTS "sow_uid_time"
  ON "store_order_writeoff" ("uid", "add_time");
CREATE INDEX IF NOT EXISTS "sow_code" ON "store_order_writeoff" ("writeoff_code");
CREATE INDEX IF NOT EXISTS "sow_operator_time"
  ON "store_order_writeoff" ("type", "relation_id", "staff_id", "add_time");`;
  }

  private migration_0048(): string {
    return `-- Preserve promotion rules and their product/coupon/brand/label scope records.
CREATE TABLE IF NOT EXISTS "store_promotions" (
  "id" SERIAL PRIMARY KEY,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "promotions_type" SMALLINT DEFAULT 1 NOT NULL,
  "promotions_cate" SMALLINT DEFAULT 1 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "title" VARCHAR(255) DEFAULT '' NOT NULL,
  "image" VARCHAR(255) DEFAULT '' NOT NULL,
  "desc" TEXT,
  "threshold_type" SMALLINT DEFAULT 1 NOT NULL,
  "threshold" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "discount_type" SMALLINT DEFAULT 1 NOT NULL,
  "n_piece_n_discount" SMALLINT DEFAULT 1 NOT NULL,
  "discount" NUMERIC(12,2) DEFAULT '0.00' NOT NULL,
  "give_integral" INTEGER DEFAULT 0 NOT NULL,
  "give_coupon_id" TEXT,
  "give_product_id" TEXT,
  "give_product_unique" TEXT,
  "overlay" VARCHAR(255) DEFAULT '' NOT NULL,
  "label_id" TEXT,
  "product_partake_type" SMALLINT DEFAULT 0 NOT NULL,
  "product_id" TEXT,
  "is_limit" SMALLINT DEFAULT 0 NOT NULL,
  "limit_num" INTEGER DEFAULT 0 NOT NULL,
  "start_time" INTEGER DEFAULT 0 NOT NULL,
  "stop_time" INTEGER DEFAULT 0 NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sp_parent" ON "store_promotions" ("pid");
CREATE INDEX IF NOT EXISTS "sp_owner" ON "store_promotions" ("type", "store_id");
CREATE INDEX IF NOT EXISTS "sp_type" ON "store_promotions" ("promotions_type");
CREATE INDEX IF NOT EXISTS "sp_update_time" ON "store_promotions" ("update_time");
CREATE INDEX IF NOT EXISTS "sp_active_window"
  ON "store_promotions" ("pid", "status", "is_del", "start_time", "stop_time");

CREATE TABLE IF NOT EXISTS "store_promotions_auxiliary" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "promotions_id" INTEGER DEFAULT 0 NOT NULL,
  "product_partake_type" SMALLINT DEFAULT 1 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "coupon_id" INTEGER DEFAULT 0 NOT NULL,
  "brand_id" INTEGER DEFAULT 0 NOT NULL,
  "store_label_id" INTEGER DEFAULT 0 NOT NULL,
  "limit_num" INTEGER DEFAULT 0 NOT NULL,
  "surplus_num" INTEGER DEFAULT 0 NOT NULL,
  "is_all" SMALLINT DEFAULT 1 NOT NULL,
  "unique" TEXT
);

CREATE INDEX IF NOT EXISTS "spa_promotion_product"
  ON "store_promotions_auxiliary" ("promotions_id", "product_id");
CREATE INDEX IF NOT EXISTS "spa_promotion_type_product"
  ON "store_promotions_auxiliary" ("promotions_id", "type", "product_id");
CREATE INDEX IF NOT EXISTS "spa_promotion_type_brand"
  ON "store_promotions_auxiliary" ("promotions_id", "type", "brand_id");
CREATE INDEX IF NOT EXISTS "spa_promotion_type_label"
  ON "store_promotions_auxiliary" ("promotions_id", "type", "store_label_id");`;
  }

  private migration_0049(): string {
    return `-- Preserve parent activity schedules and product membership referenced by activity goods.
CREATE TABLE IF NOT EXISTS "store_activity" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "name" VARCHAR(128) DEFAULT '' NOT NULL,
  "image" VARCHAR(128) DEFAULT '',
  "start_day" INTEGER DEFAULT 0 NOT NULL,
  "end_day" INTEGER DEFAULT 0 NOT NULL,
  "start_time" INTEGER DEFAULT 0 NOT NULL,
  "end_time" INTEGER DEFAULT 0 NOT NULL,
  "time_id" TEXT,
  "once_num" INTEGER DEFAULT 0,
  "num" INTEGER DEFAULT 0,
  "discount" VARCHAR(128) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 0,
  "is_recommend" SMALLINT DEFAULT 0,
  "link_id" INTEGER DEFAULT 0,
  "applicable_type" SMALLINT DEFAULT 1 NOT NULL,
  "applicable_store_id" TEXT,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sa_day_window" ON "store_activity" ("start_day", "end_day");
CREATE INDEX IF NOT EXISTS "sa_time_window" ON "store_activity" ("start_time", "end_time");
CREATE INDEX IF NOT EXISTS "sa_type" ON "store_activity" ("type");
CREATE INDEX IF NOT EXISTS "sa_active_window"
  ON "store_activity" ("type", "status", "is_del", "start_day", "end_day");

CREATE TABLE IF NOT EXISTS "store_activity_relation" (
  "id" SERIAL PRIMARY KEY,
  "activity_id" INTEGER NOT NULL,
  "product_id" INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "sar_activity_product"
  ON "store_activity_relation" ("activity_id", "product_id");
CREATE INDEX IF NOT EXISTS "sar_product_activity"
  ON "store_activity_relation" ("product_id", "activity_id");`;
  }

  private migration_0050(): string {
    return `-- Preserve legacy fixed and mix-and-match discount packages with product snapshots.
CREATE TABLE IF NOT EXISTS "store_discounts" (
  "id" SERIAL PRIMARY KEY,
  "title" VARCHAR(255) DEFAULT '' NOT NULL,
  "image" VARCHAR(500) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "is_limit" SMALLINT DEFAULT 0 NOT NULL,
  "limit_num" INTEGER DEFAULT 0 NOT NULL,
  "link_ids" VARCHAR(255) DEFAULT '' NOT NULL,
  "product_ids" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_time" SMALLINT DEFAULT 0 NOT NULL,
  "start_time" INTEGER DEFAULT 0 NOT NULL,
  "stop_time" INTEGER DEFAULT 0 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "free_shipping" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "is_support_refund" SMALLINT DEFAULT 1 NOT NULL,
  "delivery_type" VARCHAR(10) DEFAULT '' NOT NULL,
  "freight" SMALLINT DEFAULT 2 NOT NULL,
  "custom_form" TEXT
);

CREATE INDEX IF NOT EXISTS "sd_active_window"
  ON "store_discounts" ("status", "is_del", "is_limit", "start_time", "stop_time");
CREATE INDEX IF NOT EXISTS "sd_sort_id" ON "store_discounts" ("sort", "id");

CREATE TABLE IF NOT EXISTS "store_discounts_products" (
  "id" SERIAL PRIMARY KEY,
  "discount_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "product_type" SMALLINT DEFAULT 0 NOT NULL,
  "title" VARCHAR(255) DEFAULT '0' NOT NULL,
  "image" VARCHAR(500) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "temp_id" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sdp_discount_product"
  ON "store_discounts_products" ("discount_id", "product_id");
CREATE INDEX IF NOT EXISTS "sdp_product_discount"
  ON "store_discounts_products" ("product_id", "discount_id");
CREATE INDEX IF NOT EXISTS "sdp_discount_order"
  ON "store_discounts_products" ("discount_id", "id");`;
  }

  private migration_0051(): string {
    return `-- Preserve third-party same-city delivery state, locations, fees, and completion codes.
CREATE TABLE IF NOT EXISTS "store_delivery_order" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "oid" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "station_type" INTEGER DEFAULT 0 NOT NULL,
  "order_id" VARCHAR(32) DEFAULT '' NOT NULL,
  "delivery_no" VARCHAR(255) DEFAULT '' NOT NULL,
  "city_code" VARCHAR(20) DEFAULT '' NOT NULL,
  "cargo_price" NUMERIC(8, 2) DEFAULT 0.00 NOT NULL,
  "finish_code" VARCHAR(255) DEFAULT '' NOT NULL,
  "user_name" VARCHAR(20) DEFAULT '' NOT NULL,
  "receiver_phone" VARCHAR(11) DEFAULT '' NOT NULL,
  "from_address" VARCHAR(255) DEFAULT '' NOT NULL,
  "to_address" VARCHAR(255) DEFAULT '' NOT NULL,
  "from_lat" VARCHAR(255) DEFAULT '' NOT NULL,
  "from_lng" VARCHAR(255) DEFAULT '' NOT NULL,
  "to_lat" VARCHAR(255) DEFAULT '' NOT NULL,
  "to_lng" VARCHAR(255) DEFAULT '' NOT NULL,
  "distance" REAL DEFAULT 0 NOT NULL,
  "fee" NUMERIC(8, 2) DEFAULT 0.00 NOT NULL,
  "deduct_fee" NUMERIC(8, 2) DEFAULT 0.00 NOT NULL,
  "mer_id" INTEGER DEFAULT 0 NOT NULL,
  "mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "status" INTEGER DEFAULT 0 NOT NULL,
  "reason" VARCHAR(255) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sdo_oid_id" ON "store_delivery_order" ("oid", "id");
CREATE INDEX IF NOT EXISTS "sdo_uid_id" ON "store_delivery_order" ("uid", "id");
CREATE INDEX IF NOT EXISTS "sdo_order_id" ON "store_delivery_order" ("order_id");
CREATE INDEX IF NOT EXISTS "sdo_delivery_no" ON "store_delivery_order" ("delivery_no");
CREATE INDEX IF NOT EXISTS "sdo_owner_status"
  ON "store_delivery_order" ("type", "relation_id", "status", "id");
CREATE INDEX IF NOT EXISTS "sdo_status_time"
  ON "store_delivery_order" ("status", "add_time", "id");
CREATE INDEX IF NOT EXISTS "sos_oid_change_time"
  ON "store_order_status" ("oid", "change_time");`;
  }

  private migration_0052(): string {
    return `-- Keep platform external cash movements distinct from user balance and supplier ledgers.
CREATE TABLE IF NOT EXISTS "capital_flow" (
  "id" SERIAL PRIMARY KEY,
  "flow_id" VARCHAR(32) DEFAULT '' NOT NULL,
  "order_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "nickname" VARCHAR(255) DEFAULT '' NOT NULL,
  "phone" VARCHAR(20) DEFAULT '' NOT NULL,
  "price" NUMERIC(12, 2) DEFAULT 0.00 NOT NULL,
  "trading_type" SMALLINT DEFAULT 0 NOT NULL,
  "pay_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "mark" VARCHAR(500) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "cf_flow_id" ON "capital_flow" ("flow_id");
CREATE INDEX IF NOT EXISTS "cf_order_id" ON "capital_flow" ("order_id");
CREATE INDEX IF NOT EXISTS "cf_uid_type_time"
  ON "capital_flow" ("uid", "trading_type", "add_time", "id");
CREATE INDEX IF NOT EXISTS "cf_type_time"
  ON "capital_flow" ("trading_type", "add_time", "id");
CREATE INDEX IF NOT EXISTS "cf_store_time"
  ON "capital_flow" ("store_id", "add_time", "id");

-- Dormant legacy store ledger: preserve independently; do not merge into active platform cash flow.
CREATE TABLE IF NOT EXISTS "store_finance_flow" (
  "id" SERIAL PRIMARY KEY,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "staff_id" INTEGER DEFAULT 0 NOT NULL,
  "order_id" VARCHAR(20) DEFAULT '' NOT NULL,
  "link_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "pm" SMALLINT DEFAULT 0 NOT NULL,
  "number" NUMERIC(12, 2) DEFAULT 0.00 NOT NULL,
  "type" VARCHAR(50) DEFAULT '' NOT NULL,
  "pay_type" VARCHAR(20) DEFAULT '' NOT NULL,
  "pay_price" NUMERIC(12, 2) DEFAULT 0.00 NOT NULL,
  "total_price" NUMERIC(12, 2) DEFAULT 0.00 NOT NULL,
  "rate" SMALLINT DEFAULT 0 NOT NULL,
  "trade_type" SMALLINT DEFAULT 1 NOT NULL,
  "remark" VARCHAR(512) DEFAULT '' NOT NULL,
  "mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "trade_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sff_store_type_time"
  ON "store_finance_flow" ("store_id", "type", "add_time", "id");
CREATE INDEX IF NOT EXISTS "sff_uid_time"
  ON "store_finance_flow" ("uid", "add_time", "id");
CREATE INDEX IF NOT EXISTS "sff_staff_time"
  ON "store_finance_flow" ("staff_id", "add_time", "id");
CREATE INDEX IF NOT EXISTS "sff_order_id" ON "store_finance_flow" ("order_id");
CREATE INDEX IF NOT EXISTS "sff_link_id" ON "store_finance_flow" ("link_id");`;
  }

  private migration_0053(): string {
    return `-- Preserve pre-unification integral orders for historical lookup and migration.
-- Current application writes remain in store_order with type = 4, matching the
-- active PHP flow; these tables are not a second live order system.
CREATE TABLE IF NOT EXISTS "store_integral_order" (
  "id" SERIAL PRIMARY KEY,
  "order_id" VARCHAR(32) DEFAULT '0' NOT NULL,
  "trade_no" VARCHAR(100) DEFAULT '' NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "real_name" VARCHAR(32) DEFAULT '' NOT NULL,
  "user_phone" VARCHAR(18) DEFAULT '' NOT NULL,
  "user_address" VARCHAR(100) DEFAULT '' NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "image" VARCHAR(256) DEFAULT '' NOT NULL,
  "store_name" VARCHAR(128) DEFAULT '' NOT NULL,
  "suk" VARCHAR(128) DEFAULT '' NOT NULL,
  "unique" CHAR(8) DEFAULT '' NOT NULL,
  "cart_info" TEXT,
  "total_num" INTEGER DEFAULT 0 NOT NULL,
  "price" NUMERIC(12, 2) DEFAULT 0.00 NOT NULL,
  "total_price" NUMERIC(12, 2) DEFAULT 0.00 NOT NULL,
  "integral" INTEGER DEFAULT 0 NOT NULL,
  "total_integral" INTEGER DEFAULT 0 NOT NULL,
  "paid" SMALLINT DEFAULT 0 NOT NULL,
  "pay_time" INTEGER DEFAULT 0 NOT NULL,
  "pay_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "delivery_name" VARCHAR(64) DEFAULT '' NOT NULL,
  "delivery_code" VARCHAR(50) DEFAULT '' NOT NULL,
  "delivery_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "delivery_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "fictitious_content" VARCHAR(500) DEFAULT '' NOT NULL,
  "delivery_uid" INTEGER DEFAULT 0 NOT NULL,
  "mark" VARCHAR(512) DEFAULT '' NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "remark" VARCHAR(512) DEFAULT '' NOT NULL,
  "mer_id" INTEGER DEFAULT 0 NOT NULL,
  "is_mer_check" SMALLINT DEFAULT 0 NOT NULL,
  "is_remind" SMALLINT DEFAULT 0 NOT NULL,
  "is_system_del" SMALLINT DEFAULT 0 NOT NULL,
  "channel_type" VARCHAR(255) DEFAULT '' NOT NULL,
  "province" VARCHAR(255) DEFAULT '' NOT NULL,
  "express_dump" TEXT,
  "kuaidi_label" VARCHAR(255) DEFAULT '' NOT NULL,
  "verify_code" VARCHAR(125) DEFAULT '' NOT NULL,
  "product_type" SMALLINT DEFAULT 0 NOT NULL,
  "virtual_info" VARCHAR(255) DEFAULT '' NOT NULL,
  "custom_form" TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS "sio_order_uid_uq"
  ON "store_integral_order" ("order_id", "uid");
CREATE INDEX IF NOT EXISTS "sio_uid" ON "store_integral_order" ("uid");
CREATE INDEX IF NOT EXISTS "sio_add_time" ON "store_integral_order" ("add_time");
CREATE INDEX IF NOT EXISTS "sio_status" ON "store_integral_order" ("status");
CREATE INDEX IF NOT EXISTS "sio_is_del" ON "store_integral_order" ("is_del");
CREATE INDEX IF NOT EXISTS "sio_user_list"
  ON "store_integral_order" ("uid", "paid", "is_del", "is_system_del", "add_time", "id");

-- The PHP source is append-only and has no primary key. Keep that shape so
-- historical duplicates are not silently collapsed during migration.
CREATE TABLE IF NOT EXISTS "store_integral_order_status" (
  "oid" INTEGER DEFAULT 0 NOT NULL,
  "change_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "change_message" VARCHAR(256) DEFAULT '' NOT NULL,
  "change_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sios_oid" ON "store_integral_order_status" ("oid");
CREATE INDEX IF NOT EXISTS "sios_change_type"
  ON "store_integral_order_status" ("change_type");
CREATE INDEX IF NOT EXISTS "sios_oid_time"
  ON "store_integral_order_status" ("oid", "change_time");`;
  }

  private migration_0054(): string {
    return `-- Preserve reusable product metadata and legacy composite configuration.
-- These tables are distinct from per-product store_product_attr* snapshots.
CREATE TABLE IF NOT EXISTS "category" (
  "id" SERIAL PRIMARY KEY,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "owner_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "group" SMALLINT DEFAULT 0 NOT NULL,
  "other" TEXT,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "integral_min" INTEGER DEFAULT 0 NOT NULL,
  "integral_max" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "legacy_category_pid" ON "category" ("pid");
CREATE INDEX IF NOT EXISTS "legacy_category_name" ON "category" ("name");
CREATE INDEX IF NOT EXISTS "legacy_category_owner_type_id"
  ON "category" ("owner_id", "type", "id");
CREATE INDEX IF NOT EXISTS "legacy_category_group" ON "category" ("group");
CREATE INDEX IF NOT EXISTS "legacy_category_scope_group"
  ON "category" ("type", "relation_id", "group", "is_show", "sort", "id");

CREATE TABLE IF NOT EXISTS "store_product_unit" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "spu_scope_active"
  ON "store_product_unit" ("type", "relation_id", "is_del", "status", "sort", "id");
CREATE INDEX IF NOT EXISTS "spu_name" ON "store_product_unit" ("name");

CREATE TABLE IF NOT EXISTS "store_product_rule" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "rule_name" VARCHAR(32) DEFAULT '' NOT NULL,
  "rule_value" TEXT
);

CREATE INDEX IF NOT EXISTS "spr_scope_id"
  ON "store_product_rule" ("type", "relation_id", "id");
CREATE INDEX IF NOT EXISTS "spr_scope_name"
  ON "store_product_rule" ("type", "relation_id", "rule_name");

CREATE TABLE IF NOT EXISTS "store_product_specs" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "temp_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "value" VARCHAR(255) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sps_type" ON "store_product_specs" ("type");
CREATE INDEX IF NOT EXISTS "sps_template_active"
  ON "store_product_specs" ("temp_id", "status", "sort", "id");
CREATE INDEX IF NOT EXISTS "sps_scope_template"
  ON "store_product_specs" ("type", "relation_id", "temp_id", "id");

-- Card numbers/passwords are sensitive fulfillment inventory. They remain a
-- separate table and are not returned by the metadata compatibility APIs.
CREATE TABLE IF NOT EXISTS "store_product_virtual" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "attr_unique" VARCHAR(20) DEFAULT '' NOT NULL,
  "card_no" VARCHAR(255) DEFAULT '' NOT NULL,
  "card_pwd" VARCHAR(255) DEFAULT '' NOT NULL,
  "card_unique" VARCHAR(32) DEFAULT '' NOT NULL,
  "order_id" VARCHAR(255) DEFAULT '' NOT NULL,
  "order_type" SMALLINT DEFAULT 1 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "spv_product_attr_available"
  ON "store_product_virtual" ("product_id", "attr_unique", "uid", "id");
CREATE INDEX IF NOT EXISTS "spv_store_product"
  ON "store_product_virtual" ("store_id", "product_id", "id");
CREATE INDEX IF NOT EXISTS "spv_order" ON "store_product_virtual" ("order_id");
CREATE INDEX IF NOT EXISTS "spv_uid" ON "store_product_virtual" ("uid");
CREATE INDEX IF NOT EXISTS "spv_card_unique" ON "store_product_virtual" ("card_unique");

CREATE TABLE IF NOT EXISTS "system_group" (
  "id" SERIAL PRIMARY KEY,
  "cate_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "info" VARCHAR(256) DEFAULT '' NOT NULL,
  "config_name" VARCHAR(50) DEFAULT '' NOT NULL,
  "fields" TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS "system_group_config_name_uq"
  ON "system_group" ("config_name");
CREATE INDEX IF NOT EXISTS "system_group_cate" ON "system_group" ("cate_id");

CREATE TABLE IF NOT EXISTS "system_group_data" (
  "id" SERIAL PRIMARY KEY,
  "gid" INTEGER DEFAULT 0 NOT NULL,
  "value" TEXT,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_group_data_gid"
  ON "system_group_data" ("gid", "status", "sort", "id");`;
  }

  private migration_0055(): string {
    return `-- Preserve user groups and the many-to-many user label assignments.
CREATE TABLE IF NOT EXISTS "user_group" (
  "id" SERIAL PRIMARY KEY,
  "group_name" VARCHAR(64) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "user_group_name" ON "user_group" ("group_name");

-- The source has no uniqueness constraint. Do not collapse historical duplicate
-- assignments during migration; runtime writes serialize on the user row.
CREATE TABLE IF NOT EXISTS "user_label_relation" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "label_id" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "ulr_scope_user"
  ON "user_label_relation" ("type", "relation_id", "uid", "id");
CREATE INDEX IF NOT EXISTS "ulr_scope_label_user"
  ON "user_label_relation" ("type", "relation_id", "label_id", "uid");`;
  }

  private migration_0056(): string {
    return `-- Preserve configuration navigation and dynamic form definitions separately
-- from system_config values and per-order custom_form snapshots.
CREATE TABLE IF NOT EXISTS "system_config_tab" (
  "id" SERIAL PRIMARY KEY,
  "is_store" SMALLINT DEFAULT 0 NOT NULL,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "title" VARCHAR(255) DEFAULT '' NOT NULL,
  "eng_title" VARCHAR(255) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "info" SMALLINT DEFAULT 0 NOT NULL,
  "icon" VARCHAR(30) DEFAULT '' NOT NULL,
  "type" INTEGER DEFAULT 0 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_config_tab_pid" ON "system_config_tab" ("pid");
CREATE INDEX IF NOT EXISTS "system_config_tab_is_store" ON "system_config_tab" ("is_store");
CREATE INDEX IF NOT EXISTS "system_config_tab_eng_title" ON "system_config_tab" ("eng_title");
CREATE INDEX IF NOT EXISTS "system_config_tab_scope_active"
  ON "system_config_tab" ("is_store", "status", "pid", "sort", "id");

CREATE TABLE IF NOT EXISTS "system_form" (
  "id" SERIAL PRIMARY KEY,
  "version" VARCHAR(255) DEFAULT '' NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "cover_image" VARCHAR(255) DEFAULT '' NOT NULL,
  "value" TEXT,
  "default_value" TEXT,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_form_active"
  ON "system_form" ("is_del", "status", "id");
CREATE INDEX IF NOT EXISTS "system_form_name" ON "system_form" ("name");

CREATE TABLE IF NOT EXISTS "system_form_data" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "system_form_id" VARCHAR(255) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "value" TEXT,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_form_data_form"
  ON "system_form_data" ("system_form_id", "is_del", "id");
CREATE INDEX IF NOT EXISTS "system_form_data_user"
  ON "system_form_data" ("uid", "type", "relation_id", "id");`;
  }

  private migration_0057(): string {
    return `-- Preserve configurable continuous and cumulative sign-in milestone rewards.
-- The source table has no composite uniqueness constraint, so historical
-- duplicate (type, days) rows must remain importable. Runtime admin writes
-- serialize and reject new duplicates instead.
CREATE TABLE IF NOT EXISTS "system_sign_reward" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "days" INTEGER DEFAULT 0 NOT NULL,
  "point" INTEGER DEFAULT 0 NOT NULL,
  "exp" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_sign_reward_lookup"
  ON "system_sign_reward" ("type", "days", "id");`;
  }

  private migration_0058(): string {
    return `-- Preserve distributor upgrade tasks and historical completion evidence.
CREATE TABLE IF NOT EXISTS "agent_level_task" (
  "id" SERIAL PRIMARY KEY,
  "level_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "number" INTEGER DEFAULT 0 NOT NULL,
  "desc" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_must" SMALLINT DEFAULT 0 NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "alt_level_active"
  ON "agent_level_task" ("level_id", "is_del", "status", "sort", "id");
CREATE INDEX IF NOT EXISTS "alt_type_level"
  ON "agent_level_task" ("type", "level_id", "is_del");

-- The source has no uniqueness constraint. Do not collapse duplicate legacy
-- records during import; runtime completion writes serialize on the user row.
CREATE TABLE IF NOT EXISTS "agent_level_task_record" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "level_id" INTEGER DEFAULT 0 NOT NULL,
  "task_id" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 10 NOT NULL
);

CREATE INDEX IF NOT EXISTS "altr_user_level_task"
  ON "agent_level_task_record" ("uid", "level_id", "task_id", "id");
CREATE INDEX IF NOT EXISTS "altr_task_user"
  ON "agent_level_task_record" ("task_id", "uid");`;
  }

  private migration_0059(): string {
    return `-- Preserve product-to-coupon links used to grant coupons after order payment.
CREATE TABLE IF NOT EXISTS "store_product_coupon" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "issue_coupon_id" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "title" VARCHAR(255) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "spc_product"
  ON "store_product_coupon" ("product_id", "id");
CREATE INDEX IF NOT EXISTS "spc_issue"
  ON "store_product_coupon" ("issue_coupon_id", "product_id");`;
  }

  private migration_0060(): string {
    return `-- Preserve every historical bargain-help event. The source has no composite
-- uniqueness constraint, so duplicate evidence remains importable; runtime
-- writes serialize on the participation row instead.
CREATE TABLE IF NOT EXISTS "store_bargain_user_help" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "bargain_id" INTEGER DEFAULT 0 NOT NULL,
  "bargain_user_id" INTEGER DEFAULT 0 NOT NULL,
  "price" DECIMAL(12,2) DEFAULT 0.00 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sbuh_participation"
  ON "store_bargain_user_help" ("bargain_user_id", "id");
CREATE INDEX IF NOT EXISTS "sbuh_helper_activity"
  ON "store_bargain_user_help" ("uid", "bargain_id", "type");`;
  }

  private migration_0061(): string {
    return `-- Preserve the assurance catalog and product visit evidence still used by the
-- PHP product-detail, user-history, supplier and statistics call chains.
CREATE TABLE IF NOT EXISTS "store_product_ensure" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "image" VARCHAR(255) DEFAULT '' NOT NULL,
  "desc" VARCHAR(255) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "spe_type" ON "store_product_ensure" ("type");
CREATE INDEX IF NOT EXISTS "spe_scope_active"
  ON "store_product_ensure" ("type", "relation_id", "status", "sort", "id");

CREATE TABLE IF NOT EXISTS "store_product_log" (
  "id" SERIAL PRIMARY KEY,
  "type" VARCHAR(16) DEFAULT 'visit' NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "visit_num" SMALLINT DEFAULT 0 NOT NULL,
  "cart_num" INTEGER DEFAULT 0 NOT NULL,
  "order_num" INTEGER DEFAULT 0 NOT NULL,
  "pay_num" INTEGER DEFAULT 0 NOT NULL,
  "pay_price" DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
  "cost_price" DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
  "pay_uid" INTEGER DEFAULT 0 NOT NULL,
  "refund_num" INTEGER DEFAULT 0 NOT NULL,
  "refund_price" DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
  "collect_num" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "delete_time" TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "spl_type" ON "store_product_log" ("type");
CREATE INDEX IF NOT EXISTS "spl_product_id" ON "store_product_log" ("product_id");
CREATE INDEX IF NOT EXISTS "spl_uid" ON "store_product_log" ("uid");
CREATE INDEX IF NOT EXISTS "spl_add_time" ON "store_product_log" ("add_time");
CREATE INDEX IF NOT EXISTS "spl_uid_type" ON "store_product_log" ("uid", "type");
CREATE INDEX IF NOT EXISTS "spl_visit_history"
  ON "store_product_log" ("uid", "type", "delete_time", "add_time", "id");

CREATE TABLE IF NOT EXISTS "store_visit" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "product_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "cate_id" INTEGER DEFAULT 0 NOT NULL,
  "type" CHAR(50) DEFAULT '' NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "count" INTEGER DEFAULT 0 NOT NULL,
  "content" VARCHAR(255) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sv_product_id" ON "store_visit" ("product_id");
CREATE INDEX IF NOT EXISTS "sv_user_product"
  ON "store_visit" ("uid", "product_id", "product_type", "id");`;
  }

  private migration_0062(): string {
    return `-- Preserve the feedback inbox and reusable customer-service replies used by
-- the PHP user, admin and dedicated customer-service call chains.
CREATE TABLE IF NOT EXISTS "store_service_feedback" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "rela_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "phone" VARCHAR(30) DEFAULT '' NOT NULL,
  "content" VARCHAR(500) DEFAULT '' NOT NULL,
  "make" VARCHAR(255) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "ssf_uid" ON "store_service_feedback" ("uid");
CREATE INDEX IF NOT EXISTS "ssf_status_time"
  ON "store_service_feedback" ("status", "add_time", "id");

-- The source permits duplicate messages and historical duplicates must remain
-- importable. Runtime writes serialize by owner and reject new duplicates.
CREATE TABLE IF NOT EXISTS "store_service_speechcraft" (
  "id" SERIAL PRIMARY KEY,
  "kefu_id" INTEGER DEFAULT 0 NOT NULL,
  "cate_id" INTEGER DEFAULT 0 NOT NULL,
  "title" VARCHAR(100) DEFAULT '' NOT NULL,
  "message" VARCHAR(255) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sss_kefu_id" ON "store_service_speechcraft" ("kefu_id");
CREATE INDEX IF NOT EXISTS "sss_cate_id" ON "store_service_speechcraft" ("cate_id");
CREATE INDEX IF NOT EXISTS "sss_scope_sort"
  ON "store_service_speechcraft" ("kefu_id", "cate_id", "sort", "id");`;
  }

  private migration_0063(): string {
    return `-- Preserve distributor applications and every historical relationship change.
-- The source has no uniqueness constraints on these tables, so importing old
-- duplicates must remain possible.
CREATE TABLE IF NOT EXISTS "promoter_apply" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "nickname" VARCHAR(255) DEFAULT '' NOT NULL,
  "real_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "phone" VARCHAR(32) DEFAULT '0' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "status_time" INTEGER DEFAULT 0 NOT NULL,
  "refusal_reason" VARCHAR(1000) DEFAULT '' NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "pa_uid_active"
  ON "promoter_apply" ("uid", "is_del", "id");
CREATE INDEX IF NOT EXISTS "pa_status_time"
  ON "promoter_apply" ("status", "is_del", "add_time", "id");

CREATE TABLE IF NOT EXISTS "user_spread" (
  "id" SERIAL PRIMARY KEY,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "staff_id" INTEGER DEFAULT 0 NOT NULL,
  "spread_uid" INTEGER DEFAULT 0 NOT NULL,
  "spread_time" INTEGER DEFAULT 0 NOT NULL,
  "admin_id" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "us_uid" ON "user_spread" ("uid");
CREATE INDEX IF NOT EXISTS "us_spread_uid" ON "user_spread" ("spread_uid");
CREATE INDEX IF NOT EXISTS "us_uid_time"
  ON "user_spread" ("uid", "spread_time", "id");
CREATE INDEX IF NOT EXISTS "us_parent_time"
  ON "user_spread" ("spread_uid", "spread_time", "id");
CREATE INDEX IF NOT EXISTS "us_store_staff_time"
  ON "user_spread" ("store_id", "staff_id", "spread_time", "id");

-- This is a legacy/deprecated freeze ledger. The active Worker derives frozen
-- commission from user_brokerage.frozen_time and must not double-count it.
CREATE TABLE IF NOT EXISTS "user_brokerage_frozen" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "price" DECIMAL(12,2) DEFAULT 0 NOT NULL,
  "uill_id" INTEGER DEFAULT 0 NOT NULL,
  "frozen_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "order_id" VARCHAR(50) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "ubf_uid_status"
  ON "user_brokerage_frozen" ("uid", "status");
CREATE INDEX IF NOT EXISTS "ubf_uid_frozen_time"
  ON "user_brokerage_frozen" ("uid", "frozen_time", "id");
CREATE INDEX IF NOT EXISTS "ubf_order_id" ON "user_brokerage_frozen" ("order_id");`;
  }

  private migration_0064(): string {
    return `-- Preserve the bidirectional friend graph derived from historical distributor
-- bindings. The source has no pair uniqueness constraint, so old duplicates
-- remain importable while new writes serialize in the relationship service.
CREATE TABLE IF NOT EXISTS "user_friends" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "friends_uid" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "uf_uid" ON "user_friends" ("uid");
CREATE INDEX IF NOT EXISTS "uf_friends_uid" ON "user_friends" ("friends_uid");
CREATE INDEX IF NOT EXISTS "uf_pair" ON "user_friends" ("uid", "friends_uid", "id");`;
  }

  private migration_0065(): string {
    return `-- Preserve user search history/result caches and page visit analytics.
-- Historical duplicate search rows remain importable; new per-user keyword
-- updates are serialized by the Worker service instead of inventing a source
-- uniqueness constraint.
CREATE TABLE IF NOT EXISTS "user_search" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "keyword" VARCHAR(255) DEFAULT '' NOT NULL,
  "vicword" VARCHAR(1000) DEFAULT '' NOT NULL,
  "num" INTEGER DEFAULT 1 NOT NULL,
  "result" TEXT,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "user_search_uid_active_time"
  ON "user_search" ("uid", "is_del", "add_time" DESC, "num" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "user_search_uid_keyword_active"
  ON "user_search" ("uid", "keyword", "is_del", "add_time" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "user_search_keyword_cache"
  ON "user_search" ("keyword", "add_time" DESC, "id" DESC);

CREATE TABLE IF NOT EXISTS "user_visit" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "url" VARCHAR(255) DEFAULT '' NOT NULL,
  "ip" VARCHAR(255) DEFAULT '' NOT NULL,
  "stay_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "channel_type" VARCHAR(255) DEFAULT '' NOT NULL,
  "province" VARCHAR(255) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "user_visit_channel_time"
  ON "user_visit" ("channel_type", "add_time", "id");
CREATE INDEX IF NOT EXISTS "user_visit_uid_time"
  ON "user_visit" ("uid", "add_time", "id");
CREATE INDEX IF NOT EXISTS "user_visit_province_time"
  ON "user_visit" ("province", "add_time", "id");`;
  }

  private migration_0066(): string {
    return `-- Preserve the PHP newcomer-exclusive product catalog. Activity SKU rows remain
-- in store_product_attr_value with type=7 and product_id=store_newcomer.id;
-- base product SKU rows (type=0) remain the stock authority.
CREATE TABLE IF NOT EXISTS "store_newcomer" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "product_type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "price" DECIMAL(12,2) DEFAULT 0.00 NOT NULL,
  "ot_price" DECIMAL(12,2) DEFAULT 0.00 NOT NULL,
  "sales" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "store_newcomer_product_id"
  ON "store_newcomer" ("product_id");
CREATE INDEX IF NOT EXISTS "store_newcomer_active_id"
  ON "store_newcomer" ("is_del", "id");
CREATE INDEX IF NOT EXISTS "store_newcomer_product_active"
  ON "store_newcomer" ("product_id", "is_del", "id");`;
  }

  private migration_0067(): string {
    return `-- Preserve source database-backed JSON documents. Expired rows remain
-- importable as historical data; Worker reads ignore them without deleting
-- rows during a storefront request.
CREATE TABLE IF NOT EXISTS "cache" (
  "key" VARCHAR(32) PRIMARY KEY,
  "result" TEXT,
  "expire_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "cache_expire_time"
  ON "cache" ("expire_time", "key");`;
  }

  private migration_0068(): string {
    return `-- Preserve paid-membership plans, activation-card inventory, membership orders,
-- and append-only status evidence. Card passwords remain migration-only secrets
-- and are never returned by storefront APIs.
CREATE TABLE IF NOT EXISTS "member_card_batch" (
  "id" SERIAL PRIMARY KEY,
  "title" VARCHAR(100) DEFAULT '0' NOT NULL,
  "total_num" INTEGER DEFAULT 0 NOT NULL,
  "use_start_time" INTEGER DEFAULT 7 NOT NULL,
  "use_end_time" INTEGER DEFAULT 0 NOT NULL,
  "use_day" INTEGER DEFAULT 0 NOT NULL,
  "use_num" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "qrcode" VARCHAR(255) DEFAULT '' NOT NULL,
  "remark" VARCHAR(512) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "member_card_batch_status_sort"
  ON "member_card_batch" ("status", "sort", "id");

CREATE TABLE IF NOT EXISTS "member_card" (
  "id" SERIAL NOT NULL,
  "card_batch_id" INTEGER DEFAULT 0 NOT NULL,
  "card_number" VARCHAR(20) DEFAULT '' NOT NULL,
  "card_password" CHAR(12) DEFAULT '' NOT NULL,
  "use_uid" INTEGER DEFAULT 0 NOT NULL,
  "use_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "member_card_pk" PRIMARY KEY ("id", "card_batch_id")
);

CREATE INDEX IF NOT EXISTS "member_card_number_lookup"
  ON "member_card" ("card_number");
CREATE INDEX IF NOT EXISTS "member_card_batch_status_use"
  ON "member_card" ("card_batch_id", "status", "use_time", "id");
CREATE INDEX IF NOT EXISTS "member_card_user_use"
  ON "member_card" ("use_uid", "use_time", "id");

CREATE TABLE IF NOT EXISTS "member_ship" (
  "id" SERIAL PRIMARY KEY,
  "type" VARCHAR(20) DEFAULT 'month' NOT NULL,
  "title" VARCHAR(200) DEFAULT '' NOT NULL,
  "vip_day" INTEGER DEFAULT 0 NOT NULL,
  "price" NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  "pre_price" NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  "is_label" SMALLINT DEFAULT 0 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "member_ship_active_sort"
  ON "member_ship" ("is_del", "sort", "id");
CREATE INDEX IF NOT EXISTS "member_ship_type"
  ON "member_ship" ("type", "is_del");

CREATE TABLE IF NOT EXISTS "other_order" (
  "id" SERIAL PRIMARY KEY,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "staff_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "order_id" VARCHAR(32) DEFAULT '' NOT NULL,
  "member_type" VARCHAR(10) DEFAULT '' NOT NULL,
  "code" VARCHAR(20) DEFAULT '' NOT NULL,
  "pay_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "paid" SMALLINT DEFAULT 0 NOT NULL,
  "pay_price" NUMERIC(10,2) DEFAULT 0.00 NOT NULL,
  "member_price" NUMERIC(10,2) DEFAULT 0.00 NOT NULL,
  "pay_time" INTEGER DEFAULT 0 NOT NULL,
  "trade_no" VARCHAR(50) DEFAULT '' NOT NULL,
  "channel_type" VARCHAR(10) DEFAULT '' NOT NULL,
  "is_free" SMALLINT DEFAULT 0 NOT NULL,
  "is_permanent" SMALLINT DEFAULT 0 NOT NULL,
  "overdue_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "vip_day" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "money" NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  "remarks" VARCHAR(255) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "other_order_order_id"
  ON "other_order" ("order_id");
CREATE INDEX IF NOT EXISTS "other_order_uid_time"
  ON "other_order" ("uid", "add_time", "id");
CREATE INDEX IF NOT EXISTS "other_order_paid_time"
  ON "other_order" ("paid", "pay_time", "id");
CREATE INDEX IF NOT EXISTS "other_order_type_paid"
  ON "other_order" ("type", "paid", "id");

CREATE TABLE IF NOT EXISTS "other_order_status" (
  "oid" INTEGER DEFAULT 0 NOT NULL,
  "change_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "change_message" VARCHAR(256) DEFAULT '' NOT NULL,
  "shop_type" SMALLINT DEFAULT 1 NOT NULL,
  "change_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "other_order_status_oid_time"
  ON "other_order_status" ("oid", "change_time");
CREATE INDEX IF NOT EXISTS "other_order_status_type_time"
  ON "other_order_status" ("change_type", "change_time");`;
  }

  private migration_0069(): string {
    return `-- Preserve coupon product scope and coupon-claim evidence exactly as the PHP
-- install schema defines them. Neither source table has a primary/unique key,
-- so duplicate historical rows remain valid and live copy stays blocked until
-- a deterministic multiset-preserving cursor is implemented.
CREATE TABLE IF NOT EXISTS "store_coupon_issue_user" (
  "uid" INTEGER DEFAULT 0,
  "issue_coupon_id" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "store_coupon_issue_user_issue_time"
  ON "store_coupon_issue_user" ("issue_coupon_id", "add_time", "uid");
CREATE INDEX IF NOT EXISTS "store_coupon_issue_user_uid_issue_time"
  ON "store_coupon_issue_user" ("uid", "issue_coupon_id", "add_time");

CREATE TABLE IF NOT EXISTS "store_coupon_product" (
  "coupon_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "store_coupon_product_coupon_product"
  ON "store_coupon_product" ("coupon_id", "product_id");
CREATE INDEX IF NOT EXISTS "store_coupon_product_product_coupon"
  ON "store_coupon_product" ("product_id", "coupon_id");`;
  }

  private migration_0070(): string {
    return `-- Preserve pickup stores, store staff identities, scoped delivery personnel,
-- and store-customer relationships. The PHP schema defines only ordinary
-- indexes for relationship lookups; historical duplicates therefore remain
-- importable and runtime writes serialize their own active-row checks.
CREATE TABLE IF NOT EXISTS "system_store" (
  "id" SERIAL PRIMARY KEY,
  "erp_shop_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "introduction" VARCHAR(1000) DEFAULT '' NOT NULL,
  "phone" CHAR(25) DEFAULT '' NOT NULL,
  "address" VARCHAR(255) DEFAULT '' NOT NULL,
  "province" INTEGER DEFAULT 0 NOT NULL,
  "city" INTEGER DEFAULT 0 NOT NULL,
  "area" INTEGER DEFAULT 0 NOT NULL,
  "street" INTEGER DEFAULT 0,
  "detailed_address" VARCHAR(255) DEFAULT '' NOT NULL,
  "image" VARCHAR(255) DEFAULT '' NOT NULL,
  "oblong_image" VARCHAR(255) DEFAULT '' NOT NULL,
  "latitude" CHAR(25) DEFAULT '' NOT NULL,
  "longitude" CHAR(25) DEFAULT '' NOT NULL,
  "bank_code" VARCHAR(32) DEFAULT '0' NOT NULL,
  "bank_address" VARCHAR(256) DEFAULT '' NOT NULL,
  "alipay_account" VARCHAR(64) DEFAULT '' NOT NULL,
  "alipay_qrcode_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "wechat" VARCHAR(15) DEFAULT '' NOT NULL,
  "wechat_qrcode_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "valid_time" VARCHAR(100) DEFAULT '' NOT NULL,
  "valid_range" INTEGER DEFAULT 0 NOT NULL,
  "day_time" VARCHAR(100) DEFAULT '' NOT NULL,
  "day_start" VARCHAR(20) DEFAULT '',
  "day_end" VARCHAR(20) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_show" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "is_store" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_store_phone"
  ON "system_store" ("phone");
CREATE INDEX IF NOT EXISTS "system_store_active_show"
  ON "system_store" ("is_del", "is_show", "id");

CREATE TABLE IF NOT EXISTS "system_store_staff" (
  "id" SERIAL PRIMARY KEY,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "account" VARCHAR(50) DEFAULT '' NOT NULL,
  "pwd" VARCHAR(100) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(255) DEFAULT '' NOT NULL,
  "staff_name" VARCHAR(64) DEFAULT '' NOT NULL,
  "phone" CHAR(15) DEFAULT '' NOT NULL,
  "roles" VARCHAR(255) DEFAULT '',
  "last_ip" VARCHAR(16) DEFAULT '' NOT NULL,
  "last_time" INTEGER DEFAULT 0 NOT NULL,
  "login_count" INTEGER DEFAULT 0 NOT NULL,
  "level" SMALLINT DEFAULT 1 NOT NULL,
  "verify_status" SMALLINT DEFAULT 0 NOT NULL,
  "order_status" SMALLINT DEFAULT 1 NOT NULL,
  "is_admin" SMALLINT DEFAULT 0 NOT NULL,
  "is_manager" SMALLINT DEFAULT 0 NOT NULL,
  "is_cashier" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "notify" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_store_staff_uid_status"
  ON "system_store_staff" ("uid", "status", "is_del", "verify_status");
CREATE INDEX IF NOT EXISTS "system_store_staff_store_active"
  ON "system_store_staff" ("store_id", "is_del", "status", "id");
CREATE INDEX IF NOT EXISTS "system_store_staff_store_uid"
  ON "system_store_staff" ("store_id", "uid", "is_del", "id");

CREATE TABLE IF NOT EXISTS "delivery_service" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "avatar" VARCHAR(250) DEFAULT '' NOT NULL,
  "nickname" VARCHAR(50) DEFAULT '' NOT NULL,
  "phone" VARCHAR(20) DEFAULT '0' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL
);

CREATE INDEX IF NOT EXISTS "delivery_service_uid_status"
  ON "delivery_service" ("uid", "is_del", "status");
CREATE INDEX IF NOT EXISTS "delivery_service_scope_active"
  ON "delivery_service" ("type", "relation_id", "is_del", "status", "id");
CREATE INDEX IF NOT EXISTS "delivery_service_scope_phone"
  ON "delivery_service" ("type", "relation_id", "phone", "is_del", "id");

CREATE TABLE IF NOT EXISTS "store_user" (
  "id" SERIAL PRIMARY KEY,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "label_id" TEXT,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "store_user_store_id"
  ON "store_user" ("store_id");
CREATE INDEX IF NOT EXISTS "store_user_uid"
  ON "store_user" ("uid");
CREATE INDEX IF NOT EXISTS "store_user_store_uid_status"
  ON "store_user" ("store_id", "uid", "status", "id");`;
  }

  private migration_0071(): string {
    return `-- Preserve the remaining store-scoped auxiliary tables from the PHP install
-- schema. The branch-product and store-extract tables are dormant historical
-- evidence in the checked-in PHP tree; store_config remains an active scoped
-- override store. No source uniqueness or foreign-key rule is invented here.
CREATE TABLE IF NOT EXISTS "store_config" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "key_name" VARCHAR(100) DEFAULT '' NOT NULL,
  "value" VARCHAR(2000) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "store_config_type_relation"
  ON "store_config" ("type", "relation_id");
CREATE INDEX IF NOT EXISTS "store_config_scope_key"
  ON "store_config" ("type", "relation_id", "key_name", "id");

CREATE TABLE IF NOT EXISTS "store_branch_product" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "image" VARCHAR(255) DEFAULT '' NOT NULL,
  "store_name" VARCHAR(128) DEFAULT '' NOT NULL,
  "store_info" VARCHAR(255) DEFAULT '' NOT NULL,
  "keyword" VARCHAR(255) DEFAULT '' NOT NULL,
  "bar_code" VARCHAR(15) DEFAULT '' NOT NULL,
  "cate_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "sales" INTEGER DEFAULT 0 NOT NULL,
  "stock" INTEGER DEFAULT 0 NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "label_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS "store_branch_product_attr_value" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "unique" CHAR(8) DEFAULT '' NOT NULL,
  "sales" INTEGER DEFAULT 0 NOT NULL,
  "stock" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "bar_code" VARCHAR(50) DEFAULT '' NOT NULL,
  "code" VARCHAR(50) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "store_branch_product_attr_value_code"
  ON "store_branch_product_attr_value" ("code");

CREATE TABLE IF NOT EXISTS "store_extract" (
  "id" SERIAL PRIMARY KEY,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "store_staff_id" INTEGER DEFAULT 0 NOT NULL,
  "extract_type" VARCHAR(32) DEFAULT 'bank' NOT NULL,
  "bank_code" VARCHAR(32) DEFAULT '0' NOT NULL,
  "bank_address" VARCHAR(256) DEFAULT '' NOT NULL,
  "alipay_account" VARCHAR(64) DEFAULT '' NOT NULL,
  "wechat" VARCHAR(15) DEFAULT '' NOT NULL,
  "qrcode_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "extract_price" NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  "mark" VARCHAR(512) DEFAULT '' NOT NULL,
  "balance" NUMERIC(12,2) DEFAULT 0.00 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "pay_status" SMALLINT DEFAULT 0 NOT NULL,
  "store_mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "admin_id" INTEGER DEFAULT 0 NOT NULL,
  "fail_msg" VARCHAR(128) DEFAULT '' NOT NULL,
  "fail_time" INTEGER DEFAULT 0 NOT NULL,
  "voucher_image" VARCHAR(255) DEFAULT '' NOT NULL,
  "voucher_title" VARCHAR(255) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "store_extract_store_id"
  ON "store_extract" ("store_id");
CREATE INDEX IF NOT EXISTS "store_extract_extract_type"
  ON "store_extract" ("extract_type");
CREATE INDEX IF NOT EXISTS "store_extract_status"
  ON "store_extract" ("status");
CREATE INDEX IF NOT EXISTS "store_extract_add_time"
  ON "store_extract" ("add_time");`;
  }

  private migration_0072(): string {
    return `-- Preserve both generations of receipt-printer configuration from the PHP
-- schema. supplier_ticket_print is superseded historical configuration;
-- print_document is the active printer-definition authority. Source rows are
-- retained without inventing uniqueness or foreign-key rules.
CREATE TABLE IF NOT EXISTS "supplier_ticket_print" (
  "id" SERIAL PRIMARY KEY,
  "supplier_id" INTEGER DEFAULT 0 NOT NULL,
  "develop_id" INTEGER DEFAULT 0 NOT NULL,
  "api_key" VARCHAR(100) DEFAULT '' NOT NULL,
  "client_id" VARCHAR(100) DEFAULT '' NOT NULL,
  "terminal_number" VARCHAR(100) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "supplier_ticket_print_supplier_id"
  ON "supplier_ticket_print" ("supplier_id");

CREATE TABLE IF NOT EXISTS "print_document" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "supplier_id" INTEGER DEFAULT 0 NOT NULL,
  "print_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "yly_user_id" VARCHAR(255) DEFAULT '' NOT NULL,
  "yly_app_id" VARCHAR(255) DEFAULT '' NOT NULL,
  "yly_app_secret" VARCHAR(255) DEFAULT '' NOT NULL,
  "yly_sn" VARCHAR(255) DEFAULT '' NOT NULL,
  "fey_user" VARCHAR(255) DEFAULT '' NOT NULL,
  "fey_ukey" VARCHAR(255) DEFAULT '' NOT NULL,
  "fey_sn" VARCHAR(255) DEFAULT '' NOT NULL,
  "times" INTEGER DEFAULT 0 NOT NULL,
  "print_type" SMALLINT DEFAULT 1 NOT NULL,
  "print_content" TEXT,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "print_document_supplier_id"
  ON "print_document" ("supplier_id", "id");
CREATE INDEX IF NOT EXISTS "print_document_active_lookup"
  ON "print_document" ("supplier_id", "is_del", "status", "print_type", "id");`;
  }

  private migration_0073(): string {
    return `-- Supplier onboarding applications and SMS delivery audit rows from the PHP
-- schema. Historical rows retain their source shape; indexes only support the
-- authenticated runtime access paths and do not add uniqueness or foreign keys.
CREATE TABLE IF NOT EXISTS "system_user_apply" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "phone" VARCHAR(20) DEFAULT '' NOT NULL,
  "system_name" VARCHAR(30) DEFAULT '' NOT NULL,
  "name" VARCHAR(30) DEFAULT '' NOT NULL,
  "images" VARCHAR(2000) DEFAULT '' NOT NULL,
  "mark" VARCHAR(255) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "fail_msg" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "status_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_user_apply_owner_lookup"
  ON "system_user_apply" ("uid", "type", "is_del", "id");
CREATE INDEX IF NOT EXISTS "system_user_apply_review_lookup"
  ON "system_user_apply" ("type", "is_del", "status", "id");
CREATE INDEX IF NOT EXISTS "system_user_apply_relation_lookup"
  ON "system_user_apply" ("relation_id", "type", "is_del");

CREATE TABLE IF NOT EXISTS "sms_record" (
  "id" SERIAL PRIMARY KEY,
  "uid" VARCHAR(255) DEFAULT '' NOT NULL,
  "phone" CHAR(11) DEFAULT '' NOT NULL,
  "content" TEXT,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "add_ip" VARCHAR(16) DEFAULT '' NOT NULL,
  "template" VARCHAR(255) DEFAULT '' NOT NULL,
  "resultcode" INTEGER DEFAULT 0 NOT NULL,
  "record_id" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "sms_record_phone_time"
  ON "sms_record" ("phone", "add_time", "id");
CREATE INDEX IF NOT EXISTS "sms_record_ip_time"
  ON "sms_record" ("add_ip", "add_time", "id");
CREATE INDEX IF NOT EXISTS "sms_record_result_time"
  ON "sms_record" ("resultcode", "add_time", "id");`;
  }

  private migration_0074(): string {
    return `-- Attachment metadata, scoped category trees, source file-integrity history,
-- and legacy cloud-storage rows from the PHP schema. The legacy storage table
-- is migration evidence only: live object access uses the ASSETS_BUCKET R2
-- binding and never reads provider credentials from PostgreSQL.
CREATE TABLE IF NOT EXISTS "system_attachment" (
  "att_id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 1,
  "file_type" SMALLINT DEFAULT 1 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "att_dir" VARCHAR(200) DEFAULT '' NOT NULL,
  "satt_dir" VARCHAR(200) DEFAULT '' NOT NULL,
  "att_size" CHAR(30) DEFAULT '' NOT NULL,
  "att_type" CHAR(30) DEFAULT '' NOT NULL,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "time" INTEGER DEFAULT 0 NOT NULL,
  "image_type" SMALLINT DEFAULT 1 NOT NULL,
  "module_type" SMALLINT DEFAULT 1 NOT NULL,
  "real_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "scan_token" VARCHAR(32) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_attachment_time_idx"
  ON "system_attachment" ("time");
CREATE INDEX IF NOT EXISTS "system_attachment_scope_lookup"
  ON "system_attachment" ("type", "relation_id", "module_type", "file_type", "pid", "att_id");

CREATE TABLE IF NOT EXISTS "system_attachment_category" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 1,
  "file_type" SMALLINT DEFAULT 1 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "enname" VARCHAR(50) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_attachment_category_scope_lookup"
  ON "system_attachment_category" ("type", "relation_id", "file_type", "pid", "id");

CREATE TABLE IF NOT EXISTS "system_file" (
  "id" SERIAL PRIMARY KEY,
  "cthash" CHAR(32) DEFAULT '' NOT NULL,
  "filename" VARCHAR(255) DEFAULT '' NOT NULL,
  "atime" CHAR(12) DEFAULT '' NOT NULL,
  "mtime" CHAR(12) DEFAULT '' NOT NULL,
  "ctime" CHAR(12) DEFAULT '' NOT NULL
);

CREATE TABLE IF NOT EXISTS "system_storage" (
  "id" SERIAL PRIMARY KEY,
  "access_key" VARCHAR(100) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "region" VARCHAR(100) DEFAULT '' NOT NULL,
  "acl" VARCHAR(17) DEFAULT 'public-read' NOT NULL,
  "domain" VARCHAR(100) DEFAULT '' NOT NULL,
  "cname" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_ssl" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "is_delete" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_storage_status_lookup"
  ON "system_storage" ("is_delete", "status", "type", "id");`;
  }

  private migration_0075(): string {
    return `-- Superseded product category/brand/label auxiliary rows from the PHP schema.
-- These tables remain importable as historical evidence only. Active product
-- category, brand and label writes use store_product_relation and must not
-- dual-write these obsolete authorities.
CREATE TABLE IF NOT EXISTS "store_product_category_brand" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "cate_id" INTEGER DEFAULT 0 NOT NULL,
  "brand_id" INTEGER DEFAULT 0 NOT NULL,
  "brand_name" VARCHAR(100) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "store_product_category_brand_cate_id"
  ON "store_product_category_brand" ("cate_id");

CREATE TABLE IF NOT EXISTS "store_product_cate" (
  "id" SERIAL PRIMARY KEY,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "cate_id" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "cate_pid" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS "store_product_label_auxiliary" (
  "id" SERIAL PRIMARY KEY,
  "label_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "store_product_label_auxiliary_label_product"
  ON "store_product_label_auxiliary" ("label_id", "product_id");`;
  }

  private migration_0076(): string {
    return `-- Source-shaped page-link catalogue used by the legacy DIY editor.
-- No foreign keys or uniqueness constraints are added because the PHP schema
-- permits historical orphans and duplicate links.
CREATE TABLE IF NOT EXISTS "page_category" (
  "id" SERIAL PRIMARY KEY,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "type" VARCHAR(50) DEFAULT 'link' NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "page_category_tree_lookup"
  ON "page_category" ("pid", "sort" DESC, "id" ASC);

CREATE TABLE IF NOT EXISTS "page_link" (
  "id" SERIAL PRIMARY KEY,
  "cate_id" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "url" VARCHAR(255) DEFAULT '' NOT NULL,
  "param" VARCHAR(255) DEFAULT '' NOT NULL,
  "example" VARCHAR(255) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "page_link_category_lookup"
  ON "page_link" ("cate_id", "sort" DESC, "id" ASC);`;
  }

  private migration_0077(): string {
    return `-- Preserve the three source lottery tables without adding foreign keys or
-- semantic uniqueness that could reject historical CRMEB rows.
CREATE TABLE IF NOT EXISTS "luck_lottery" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "desc" VARCHAR(255) DEFAULT '' NOT NULL,
  "image" VARCHAR(255) DEFAULT '' NOT NULL,
  "factor" SMALLINT DEFAULT 1 NOT NULL,
  "factor_num" SMALLINT DEFAULT 10 NOT NULL,
  "attends_user" SMALLINT DEFAULT 1 NOT NULL,
  "user_level" TEXT,
  "user_label" TEXT,
  "is_svip" SMALLINT DEFAULT 1 NOT NULL,
  "prize_num" SMALLINT DEFAULT 0 NOT NULL,
  "start_time" INTEGER DEFAULT 0 NOT NULL,
  "end_time" INTEGER DEFAULT 0 NOT NULL,
  "lottery_num_term" SMALLINT DEFAULT 1 NOT NULL,
  "lottery_num" SMALLINT DEFAULT 1 NOT NULL,
  "total_lottery_num" SMALLINT DEFAULT 1 NOT NULL,
  "spread_num" SMALLINT DEFAULT 1 NOT NULL,
  "is_all_record" SMALLINT DEFAULT 1 NOT NULL,
  "is_personal_record" SMALLINT DEFAULT 1 NOT NULL,
  "is_content" SMALLINT DEFAULT 1 NOT NULL,
  "content" TEXT,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "luck_lottery_type"
  ON "luck_lottery" ("type");
CREATE INDEX IF NOT EXISTS "luck_lottery_factor_active"
  ON "luck_lottery" ("factor", "status", "is_del", "start_time", "end_time", "id" DESC);

CREATE TABLE IF NOT EXISTS "luck_prize" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "lottery_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "prompt" VARCHAR(255) DEFAULT '' NOT NULL,
  "image" VARCHAR(255) DEFAULT '' NOT NULL,
  "chance" SMALLINT DEFAULT 10 NOT NULL,
  "total" SMALLINT DEFAULT 1 NOT NULL,
  "coupon_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "unique" VARCHAR(20) DEFAULT '' NOT NULL,
  "num" NUMERIC(12, 2) DEFAULT 0.00 NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "luck_prize_lottery"
  ON "luck_prize" ("lottery_id");
CREATE INDEX IF NOT EXISTS "luck_prize_draw"
  ON "luck_prize" ("lottery_id", "status", "is_del", "sort", "id");

CREATE TABLE IF NOT EXISTS "luck_lottery_record" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "oid" INTEGER DEFAULT 0,
  "lottery_id" INTEGER DEFAULT 0 NOT NULL,
  "prize_id" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "prize_info" TEXT,
  "is_receive" SMALLINT DEFAULT 0 NOT NULL,
  "receive_time" INTEGER DEFAULT 0 NOT NULL,
  "receive_info" TEXT,
  "is_deliver" SMALLINT DEFAULT 0 NOT NULL,
  "deliver_time" INTEGER DEFAULT 0 NOT NULL,
  "deliver_info" TEXT,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "luck_lottery_record_uid"
  ON "luck_lottery_record" ("uid");
CREATE INDEX IF NOT EXISTS "luck_lottery_record_prize"
  ON "luck_lottery_record" ("prize_id");
CREATE INDEX IF NOT EXISTS "luck_lottery_record_lottery"
  ON "luck_lottery_record" ("lottery_id");
CREATE INDEX IF NOT EXISTS "luck_lottery_record_user_activity_time"
  ON "luck_lottery_record" ("uid", "lottery_id", "add_time", "id");

-- Worker-only reliability table. PHP kept order/review tickets in a 120-second
-- Redis value that later events overwrote. Source events are instead retained
-- here with an idempotency key and atomically consumed by the draw transaction.
CREATE TABLE IF NOT EXISTS "luck_lottery_entitlement" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER NOT NULL,
  "factor" SMALLINT NOT NULL,
  "source_type" VARCHAR(16) NOT NULL,
  "source_id" VARCHAR(64) NOT NULL,
  "source_key" VARCHAR(128) NOT NULL,
  "amount" INTEGER NOT NULL,
  "remaining" INTEGER NOT NULL,
  "expires_at" INTEGER NOT NULL,
  "add_time" INTEGER NOT NULL,
  "update_time" INTEGER NOT NULL,
  CONSTRAINT "luck_lottery_entitlement_factor_ck" CHECK ("factor" IN (3, 4)),
  CONSTRAINT "luck_lottery_entitlement_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "luck_lottery_entitlement_remaining_ck" CHECK ("remaining" >= 0 AND "remaining" <= "amount")
);

CREATE UNIQUE INDEX IF NOT EXISTS "luck_lottery_entitlement_source_uq"
  ON "luck_lottery_entitlement" ("source_key");
CREATE INDEX IF NOT EXISTS "luck_lottery_entitlement_available"
  ON "luck_lottery_entitlement" ("uid", "factor", "expires_at", "id")
  WHERE "remaining" > 0;`;
  }

  private migration_0078(): string {
    return `-- Preserve the five official-account content tables without foreign keys or
-- semantic uniqueness that could reject historical CRMEB rows. Ordinary
-- indexes added to wechat_key/news_category only accelerate active Worker reads.
CREATE TABLE IF NOT EXISTS "wechat_key" (
  "id" SERIAL PRIMARY KEY,
  "reply_id" INTEGER DEFAULT 0 NOT NULL,
  "keys" VARCHAR(64) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "wechat_key_keys"
  ON "wechat_key" ("keys");
CREATE INDEX IF NOT EXISTS "wechat_key_reply_id"
  ON "wechat_key" ("reply_id");

CREATE TABLE IF NOT EXISTS "wechat_media" (
  "id" SERIAL PRIMARY KEY,
  "type" VARCHAR(16) DEFAULT '' NOT NULL,
  "path" VARCHAR(128) DEFAULT '' NOT NULL,
  "media_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "url" VARCHAR(256) DEFAULT '' NOT NULL,
  "temporary" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "wechat_media_type_media_id_uq"
  ON "wechat_media" ("type", "media_id");

CREATE TABLE IF NOT EXISTS "wechat_message" (
  "id" SERIAL PRIMARY KEY,
  "openid" VARCHAR(100) DEFAULT '' NOT NULL,
  "type" VARCHAR(100) DEFAULT '' NOT NULL,
  "result" VARCHAR(512) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "wechat_message_openid"
  ON "wechat_message" ("openid");
CREATE INDEX IF NOT EXISTS "wechat_message_type"
  ON "wechat_message" ("type");
CREATE INDEX IF NOT EXISTS "wechat_message_add_time"
  ON "wechat_message" ("add_time");

CREATE TABLE IF NOT EXISTS "wechat_news_category" (
  "id" SERIAL PRIMARY KEY,
  "cate_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "new_id" VARCHAR(255) DEFAULT '' NOT NULL,
  "add_time" VARCHAR(255) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "wechat_news_category_status_sort"
  ON "wechat_news_category" ("status", "sort", "id");

CREATE TABLE IF NOT EXISTS "wechat_reply" (
  "id" SERIAL PRIMARY KEY,
  "type" VARCHAR(32) DEFAULT '' NOT NULL,
  "data" TEXT,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "hide" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "wechat_reply_type"
  ON "wechat_reply" ("type");
CREATE INDEX IF NOT EXISTS "wechat_reply_status"
  ON "wechat_reply" ("status");
CREATE INDEX IF NOT EXISTS "wechat_reply_hide"
  ON "wechat_reply" ("hide");`;
  }

  private migration_0079(): string {
    return `-- Preserve the four source QR/channel-code tables without foreign keys or
-- invented business uniqueness. The only unique index is the source
-- qrcode(third_type, third_id) key used for idempotent provisioning.
CREATE TABLE IF NOT EXISTS "qrcode" (
  "id" SERIAL PRIMARY KEY,
  "third_type" VARCHAR(32) DEFAULT '' NOT NULL,
  "third_id" INTEGER DEFAULT 0 NOT NULL,
  "ticket" VARCHAR(255) DEFAULT '' NOT NULL,
  "expire_seconds" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" VARCHAR(255) DEFAULT '0' NOT NULL,
  "url" VARCHAR(255) DEFAULT '' NOT NULL,
  "qrcode_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "scan" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "qrcode_third_type_third_id_uq"
  ON "qrcode" ("third_type", "third_id");
CREATE INDEX IF NOT EXISTS "qrcode_status_type"
  ON "qrcode" ("status", "type", "id");

CREATE TABLE IF NOT EXISTS "wechat_qrcode" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "image" VARCHAR(500) DEFAULT '' NOT NULL,
  "cate_id" INTEGER DEFAULT 0 NOT NULL,
  "label_id" VARCHAR(32) DEFAULT '' NOT NULL,
  "type" VARCHAR(32) DEFAULT '' NOT NULL,
  "content" TEXT,
  "data" TEXT,
  "follow" INTEGER DEFAULT 0 NOT NULL,
  "scan" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "continue_time" INTEGER DEFAULT 0 NOT NULL,
  "end_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "wechat_qrcode_cate_active"
  ON "wechat_qrcode" ("cate_id", "is_del", "id");
CREATE INDEX IF NOT EXISTS "wechat_qrcode_status_end_time"
  ON "wechat_qrcode" ("status", "end_time", "id");
CREATE INDEX IF NOT EXISTS "wechat_qrcode_uid"
  ON "wechat_qrcode" ("uid", "id");

CREATE TABLE IF NOT EXISTS "wechat_qrcode_cate" (
  "id" SERIAL PRIMARY KEY,
  "cate_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "wechat_qrcode_cate_is_del"
  ON "wechat_qrcode_cate" ("is_del", "id");

CREATE TABLE IF NOT EXISTS "wechat_qrcode_record" (
  "id" SERIAL PRIMARY KEY,
  "qid" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "is_follow" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "wechat_qrcode_record_qid_time"
  ON "wechat_qrcode_record" ("qid", "add_time", "id");
CREATE INDEX IF NOT EXISTS "wechat_qrcode_record_qid_uid"
  ON "wechat_qrcode_record" ("qid", "uid", "id");
CREATE INDEX IF NOT EXISTS "wechat_qrcode_record_qid_follow_time"
  ON "wechat_qrcode_record" ("qid", "is_follow", "add_time", "id");`;
  }

  private migration_0080(): string {
    return `-- Preserve legacy batch-queue history and the dynamic timer catalog. These
-- rows are diagnostic/migration data only: importing them never dispatches a
-- Cloudflare Queue message or changes the Worker scheduled configuration.
CREATE TABLE IF NOT EXISTS "queue_list" (
  "id" SERIAL NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "source" VARCHAR(5) DEFAULT 'admin' NOT NULL,
  "execute_key" VARCHAR(512) DEFAULT '' NOT NULL,
  "title" VARCHAR(200) DEFAULT '' NOT NULL,
  "queue_in_value" TEXT,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "first_time" INTEGER DEFAULT 0 NOT NULL,
  "again_time" INTEGER DEFAULT 0 NOT NULL,
  "finish_time" INTEGER DEFAULT 0 NOT NULL,
  "surplus_num" INTEGER DEFAULT 0 NOT NULL,
  "total_num" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "queue_list_pk" PRIMARY KEY ("id", "type", "status")
);

CREATE INDEX IF NOT EXISTS "queue_list_status_type_time"
  ON "queue_list" ("status", "type", "add_time", "id");
CREATE INDEX IF NOT EXISTS "queue_list_source_time"
  ON "queue_list" ("source", "add_time", "id");

CREATE TABLE IF NOT EXISTS "queue_auxiliary" (
  "id" SERIAL PRIMARY KEY,
  "binding_id" INTEGER DEFAULT 0 NOT NULL,
  "relation_id" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "other" VARCHAR(2048) DEFAULT '' NOT NULL,
  "status" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "queue_auxiliary_binding_type_time"
  ON "queue_auxiliary" ("binding_id", "type", "add_time", "id");
CREATE INDEX IF NOT EXISTS "queue_auxiliary_status_type_time"
  ON "queue_auxiliary" ("status", "type", "add_time", "id");

CREATE TABLE IF NOT EXISTS "system_timer" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "mark" VARCHAR(50) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
  "title" VARCHAR(255) DEFAULT '' NOT NULL,
  "is_open" SMALLINT DEFAULT 0 NOT NULL,
  "cycle" VARCHAR(255) DEFAULT '' NOT NULL,
  "last_execution_time" INTEGER DEFAULT 0 NOT NULL,
  "update_execution_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "system_timer_active_open"
  ON "system_timer" ("is_del", "is_open", "id");
CREATE INDEX IF NOT EXISTS "system_timer_mark"
  ON "system_timer" ("mark", "id");`;
  }

  private migration_0081(): string {
    return `-- Preserve the legacy mini-program live catalog. Remote WeChat status reads
-- may refresh these rows, but importing them never creates rooms, submits
-- goods for audit, uploads media, or attaches goods to a remote room.
CREATE TABLE IF NOT EXISTS "live_anchor" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "cover_img" VARCHAR(255) DEFAULT '' NOT NULL,
  "wechat" VARCHAR(50) DEFAULT '' NOT NULL,
  "phone" VARCHAR(32) DEFAULT '' NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "live_anchor_visible_time"
  ON "live_anchor" ("is_del", "is_show", "add_time", "id");
CREATE INDEX IF NOT EXISTS "live_anchor_wechat"
  ON "live_anchor" ("wechat", "id");

CREATE TABLE IF NOT EXISTS "live_goods" (
  "id" SERIAL PRIMARY KEY,
  "goods_id" INTEGER DEFAULT 0 NOT NULL,
  "audit_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(30) DEFAULT '' NOT NULL,
  "cover_img" VARCHAR(255) DEFAULT '' NOT NULL,
  "url" VARCHAR(255) DEFAULT '' NOT NULL,
  "price_type" SMALLINT DEFAULT 1 NOT NULL,
  "cost_price" NUMERIC(10,2) DEFAULT '0.00' NOT NULL,
  "price" NUMERIC(10,2) DEFAULT '0.00' NOT NULL,
  "price2" NUMERIC(10,2) DEFAULT '0.00' NOT NULL,
  "audit_status" SMALLINT DEFAULT 0 NOT NULL,
  "third_part_tag" SMALLINT DEFAULT 1 NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "live_goods_visible_sort"
  ON "live_goods" ("is_del", "is_show", "sort", "add_time", "id");
CREATE INDEX IF NOT EXISTS "live_goods_audit_status"
  ON "live_goods" ("audit_status", "goods_id", "id");
CREATE INDEX IF NOT EXISTS "live_goods_product"
  ON "live_goods" ("product_id", "id");

CREATE TABLE IF NOT EXISTS "live_room" (
  "id" SERIAL NOT NULL,
  "room_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(32) DEFAULT '' NOT NULL,
  "cover_img" VARCHAR(255) DEFAULT '' NOT NULL,
  "share_img" VARCHAR(255) DEFAULT '' NOT NULL,
  "start_time" INTEGER DEFAULT 0 NOT NULL,
  "end_time" INTEGER DEFAULT 0 NOT NULL,
  "anchor_name" VARCHAR(50) DEFAULT '' NOT NULL,
  "anchor_wechat" VARCHAR(50) DEFAULT '' NOT NULL,
  "phone" VARCHAR(32) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "screen_type" SMALLINT DEFAULT 1 NOT NULL,
  "close_like" SMALLINT DEFAULT 0 NOT NULL,
  "close_goods" SMALLINT DEFAULT 0 NOT NULL,
  "close_comment" SMALLINT DEFAULT 0 NOT NULL,
  "error_msg" VARCHAR(255) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "live_status" SMALLINT DEFAULT 102 NOT NULL,
  "mark" VARCHAR(512) DEFAULT '' NOT NULL,
  "replay_status" SMALLINT DEFAULT 0 NOT NULL,
  "sort" SMALLINT DEFAULT 0 NOT NULL,
  "is_show" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "live_room_pk" PRIMARY KEY ("id", "phone")
);

CREATE INDEX IF NOT EXISTS "live_room_visible_sort"
  ON "live_room" ("is_del", "is_show", "sort", "id");
CREATE INDEX IF NOT EXISTS "live_room_remote_status"
  ON "live_room" ("room_id", "live_status", "id");
CREATE INDEX IF NOT EXISTS "live_room_anchor"
  ON "live_room" ("anchor_wechat", "id");

-- The PHP schema has only a non-unique pair index. Historical duplicate links
-- are therefore valid evidence and must not be collapsed by a unique key.
CREATE TABLE IF NOT EXISTS "live_room_goods" (
  "live_room_id" INTEGER DEFAULT 0 NOT NULL,
  "live_goods_id" INTEGER DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "live_room_goods_pair"
  ON "live_room_goods" ("live_room_id", "live_goods_id");
CREATE INDEX IF NOT EXISTS "live_room_goods_goods_room"
  ON "live_room_goods" ("live_goods_id", "live_room_id");`;
  }

  private migration_0082(): string {
    return `-- Preserve the PHP third-party API identity and documentation catalog without
-- promoting its plaintext credential copies or arbitrary outbound push URLs
-- into Worker runtime authorities.
CREATE TABLE IF NOT EXISTS "out_account" (
  "id" SERIAL PRIMARY KEY,
  "appid" VARCHAR(50) DEFAULT '' NOT NULL,
  "appsecret" VARCHAR(100) DEFAULT '' NOT NULL,
  "apppwd" VARCHAR(100) DEFAULT '' NOT NULL,
  "title" VARCHAR(200) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "rules" TEXT,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "last_time" INTEGER DEFAULT 0 NOT NULL,
  "ip" VARCHAR(30) DEFAULT '' NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "push_open" SMALLINT DEFAULT 0 NOT NULL,
  "push_account" VARCHAR(255) DEFAULT '' NOT NULL,
  "push_password" VARCHAR(255) DEFAULT '' NOT NULL,
  "push_token_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "user_update_push" VARCHAR(255) DEFAULT '' NOT NULL,
  "order_create_push" VARCHAR(255) DEFAULT '' NOT NULL,
  "order_pay_push" VARCHAR(255) DEFAULT '' NOT NULL,
  "refund_create_push" VARCHAR(255) DEFAULT '' NOT NULL,
  "refund_cancel_push" VARCHAR(255) DEFAULT '' NOT NULL
);

CREATE INDEX IF NOT EXISTS "out_account_active_appid"
  ON "out_account" ("appid", "id") WHERE "is_del" = 0;
CREATE INDEX IF NOT EXISTS "out_account_status_time"
  ON "out_account" ("is_del", "status", "add_time", "id");

CREATE TABLE IF NOT EXISTS "out_interface" (
  "id" SERIAL PRIMARY KEY,
  "pid" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "describe" TEXT,
  "method" VARCHAR(255) DEFAULT '' NOT NULL,
  "url" VARCHAR(255) DEFAULT '' NOT NULL,
  "request_params" TEXT,
  "return_params" TEXT,
  "request_example" TEXT,
  "return_example" TEXT,
  "error_code" TEXT,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);

CREATE INDEX IF NOT EXISTS "out_interface_active_tree"
  ON "out_interface" ("pid", "id") WHERE "is_del" = 0;
CREATE INDEX IF NOT EXISTS "out_interface_active_route"
  ON "out_interface" ("method", "url", "id") WHERE "is_del" = 0;`;
  }

  private migration_0083(): string {
    return `-- Preserve the PHP Enterprise WeChat catalog and delivery history for
-- lossless import. This migration does not enable remote sync or delivery.
CREATE TABLE IF NOT EXISTS "work_channel_code" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "cate_id" INTEGER DEFAULT 0 NOT NULL,
  "label_id" VARCHAR(1000) DEFAULT '' NOT NULL,
  "reserve_userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "userids" VARCHAR(1000) DEFAULT '' NOT NULL,
  "skip_verify" SMALLINT DEFAULT 0 NOT NULL,
  "add_upper_limit" SMALLINT DEFAULT 0 NOT NULL,
  "welcome_type" SMALLINT DEFAULT 0 NOT NULL,
  "welcome_words" VARCHAR(1000) DEFAULT '' NOT NULL,
  "qrcode_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "config_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "client_num" INTEGER DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "delete_time" INTEGER
);
CREATE INDEX IF NOT EXISTS "work_channel_code_cate_id" ON "work_channel_code" ("cate_id");
CREATE INDEX IF NOT EXISTS "work_channel_code_status" ON "work_channel_code" ("status");
CREATE INDEX IF NOT EXISTS "work_channel_code_catalog" ON "work_channel_code" ("delete_time", "status", "create_time", "id");

-- The next relation tables have no stable unique source key. Historical
-- duplicate rows are valid source evidence and must not be collapsed.
CREATE TABLE IF NOT EXISTS "work_channel_cycle" (
  "channel_id" INTEGER DEFAULT 0 NOT NULL,
  "userids" VARCHAR(1000) DEFAULT '' NOT NULL,
  "start_time" VARCHAR(5) DEFAULT '' NOT NULL,
  "end_time" VARCHAR(5) DEFAULT '' NOT NULL,
  "wokr_time" VARCHAR(50) DEFAULT '' NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_channel_cycle_channel_id" ON "work_channel_cycle" ("channel_id");

CREATE TABLE IF NOT EXISTS "work_channel_limit" (
  "channel_id" INTEGER DEFAULT 0 NOT NULL,
  "userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "max" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_channel_limit_channel_id" ON "work_channel_limit" ("channel_id");

CREATE TABLE IF NOT EXISTS "work_client" (
  "id" SERIAL PRIMARY KEY,
  "corp_id" VARCHAR(18) DEFAULT '' NOT NULL,
  "external_userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(255) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "gender" SMALLINT DEFAULT 0 NOT NULL,
  "unionid" VARCHAR(64) DEFAULT '' NOT NULL,
  "position" VARCHAR(50) DEFAULT '' NOT NULL,
  "corp_name" VARCHAR(50) DEFAULT '' NOT NULL,
  "corp_full_name" VARCHAR(100) DEFAULT '' NOT NULL,
  "external_profile" VARCHAR(1000) DEFAULT '' NOT NULL,
  "remark" VARCHAR(255) DEFAULT '' NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "delete_time" INTEGER
);
CREATE INDEX IF NOT EXISTS "work_client_external_userid" ON "work_client" ("external_userid");
CREATE INDEX IF NOT EXISTS "work_client_corp_external" ON "work_client" ("corp_id", "external_userid");
CREATE INDEX IF NOT EXISTS "work_client_uid" ON "work_client" ("uid");
CREATE INDEX IF NOT EXISTS "work_client_unionid" ON "work_client" ("unionid");
CREATE INDEX IF NOT EXISTS "work_client_catalog" ON "work_client" ("delete_time", "update_time", "id");

CREATE TABLE IF NOT EXISTS "work_client_follow" (
  "id" SERIAL PRIMARY KEY,
  "client_id" INTEGER DEFAULT 0 NOT NULL,
  "userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "remark" VARCHAR(50) DEFAULT '' NOT NULL,
  "description" VARCHAR(255) DEFAULT '' NOT NULL,
  "createtime" INTEGER DEFAULT 0 NOT NULL,
  "remark_corp_name" VARCHAR(50) DEFAULT '' NOT NULL,
  "remark_mobiles" VARCHAR(255) DEFAULT '' NOT NULL,
  "add_way" INTEGER DEFAULT 0 NOT NULL,
  "oper_userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "state" VARCHAR(30) DEFAULT '' NOT NULL,
  "is_del_user" SMALLINT DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_client_follow_state" ON "work_client_follow" ("state");
CREATE INDEX IF NOT EXISTS "work_client_follow_client_id" ON "work_client_follow" ("client_id");
CREATE INDEX IF NOT EXISTS "work_client_follow_user_client" ON "work_client_follow" ("userid", "client_id", "id");

CREATE TABLE IF NOT EXISTS "work_client_follow_tags" (
  "follow_id" INTEGER DEFAULT 0 NOT NULL,
  "group_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "tag_name" VARCHAR(255) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "tag_id" VARCHAR(32) DEFAULT '' NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_client_follow_tags_follow_id" ON "work_client_follow_tags" ("follow_id");

CREATE TABLE IF NOT EXISTS "work_department" (
  "id" SERIAL PRIMARY KEY,
  "corp_id" VARCHAR(18) DEFAULT '' NOT NULL,
  "department_id" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "name_en" VARCHAR(50) DEFAULT '' NOT NULL,
  "department_leader" VARCHAR(1000) DEFAULT '' NOT NULL,
  "parentid" INTEGER DEFAULT 0 NOT NULL,
  "srot" INTEGER DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_department_tree" ON "work_department" ("corp_id", "parentid", "srot", "id");

CREATE TABLE IF NOT EXISTS "work_group_chat" (
  "id" SERIAL PRIMARY KEY,
  "corp_id" VARCHAR(18) DEFAULT '' NOT NULL,
  "chat_id" VARCHAR(40) DEFAULT '' NOT NULL,
  "name" VARCHAR(255) DEFAULT '' NOT NULL,
  "owner" VARCHAR(64) DEFAULT '' NOT NULL,
  "group_create_time" INTEGER DEFAULT 0 NOT NULL,
  "notice" VARCHAR(255) DEFAULT '' NOT NULL,
  "admin_list" VARCHAR(1000) DEFAULT '' NOT NULL,
  "member_num" INTEGER DEFAULT 0 NOT NULL,
  "retreat_group_num" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_group_chat_corp_chat" ON "work_group_chat" ("corp_id", "chat_id");
CREATE INDEX IF NOT EXISTS "work_group_chat_catalog" ON "work_group_chat" ("status", "update_time", "id");

CREATE TABLE IF NOT EXISTS "work_group_chat_auth" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "auth_group_chat" SMALLINT DEFAULT 0 NOT NULL,
  "chat_id" VARCHAR(1000) DEFAULT '' NOT NULL,
  "group_name" VARCHAR(100) DEFAULT '' NOT NULL,
  "group_num" INTEGER DEFAULT 0 NOT NULL,
  "label" VARCHAR(255) DEFAULT '' NOT NULL,
  "config_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "qr_code" VARCHAR(255) DEFAULT '' NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "delete_time" INTEGER
);
CREATE INDEX IF NOT EXISTS "work_group_chat_auth_catalog" ON "work_group_chat_auth" ("delete_time", "create_time", "id");

CREATE TABLE IF NOT EXISTS "work_group_chat_member" (
  "id" SERIAL PRIMARY KEY,
  "group_id" INTEGER DEFAULT 0 NOT NULL,
  "userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "unionid" VARCHAR(64) DEFAULT '' NOT NULL,
  "join_time" INTEGER DEFAULT 0 NOT NULL,
  "join_scene" SMALLINT DEFAULT 0 NOT NULL,
  "invitor_userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "group_nickname" VARCHAR(100) DEFAULT '' NOT NULL,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "chat_sum" INTEGER DEFAULT 0 NOT NULL,
  "retreat_chat_num" INTEGER DEFAULT 0 NOT NULL,
  "state" VARCHAR(100) DEFAULT '' NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_group_chat_member_group_id" ON "work_group_chat_member" ("group_id");
CREATE INDEX IF NOT EXISTS "work_group_chat_member_group_user" ON "work_group_chat_member" ("group_id", "userid");
CREATE INDEX IF NOT EXISTS "work_group_chat_member_catalog" ON "work_group_chat_member" ("group_id", "status", "join_time", "id");

CREATE TABLE IF NOT EXISTS "work_group_chat_statistic" (
  "id" SERIAL PRIMARY KEY,
  "group_id" INTEGER DEFAULT 0 NOT NULL,
  "today_sum" INTEGER DEFAULT 0 NOT NULL,
  "today_return_sum" INTEGER DEFAULT 0 NOT NULL,
  "chat_sum" INTEGER DEFAULT 0 NOT NULL,
  "chat_return_sum" INTEGER DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_group_chat_statistic_group_id" ON "work_group_chat_statistic" ("group_id");

CREATE TABLE IF NOT EXISTS "work_group_msg_relation" (
  "template_id" INTEGER DEFAULT 0 NOT NULL,
  "msg_id" VARCHAR(64) DEFAULT '' NOT NULL
);

CREATE TABLE IF NOT EXISTS "work_group_msg_send_result" (
  "id" SERIAL PRIMARY KEY,
  "msg_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "external_userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "chat_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "send_time" INTEGER DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_group_msg_send_result_status" ON "work_group_msg_send_result" ("status");
CREATE INDEX IF NOT EXISTS "work_group_msg_send_result_msg_id" ON "work_group_msg_send_result" ("msg_id");

CREATE TABLE IF NOT EXISTS "work_group_msg_task" (
  "id" SERIAL PRIMARY KEY,
  "msg_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "send_time" INTEGER DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_group_msg_task_msg_id" ON "work_group_msg_task" ("msg_id");

CREATE TABLE IF NOT EXISTS "work_group_template" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "userids" TEXT,
  "client_type" SMALLINT DEFAULT 0 NOT NULL,
  "where_time" VARCHAR(100) DEFAULT '' NOT NULL,
  "where_label" TEXT,
  "where_not_label" TEXT,
  "template_type" SMALLINT DEFAULT 0 NOT NULL,
  "send_time" INTEGER DEFAULT 0 NOT NULL,
  "send_type" SMALLINT DEFAULT 0 NOT NULL,
  "welcome_words" TEXT,
  "fail_external_userid" TEXT,
  "fail_message" VARCHAR(255) DEFAULT '' NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_group_template_type" ON "work_group_template" ("type");
CREATE INDEX IF NOT EXISTS "work_group_template_schedule" ON "work_group_template" ("template_type", "send_time");

CREATE TABLE IF NOT EXISTS "work_label" (
  "id" SERIAL PRIMARY KEY,
  "corp_id" VARCHAR(18) DEFAULT '' NOT NULL,
  "group_id" INTEGER DEFAULT 0 NOT NULL,
  "group_name" VARCHAR(50) DEFAULT '' NOT NULL,
  "name" VARCHAR(50) DEFAULT '' NOT NULL,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_label_group_id" ON "work_label" ("group_id");

CREATE TABLE IF NOT EXISTS "work_media" (
  "id" SERIAL PRIMARY KEY,
  "md5_path" VARCHAR(32) DEFAULT '' NOT NULL,
  "type" VARCHAR(16) DEFAULT 'image' NOT NULL,
  "upload_type" SMALLINT DEFAULT 0 NOT NULL,
  "path" VARCHAR(255) DEFAULT '' NOT NULL,
  "media_id" VARCHAR(500) DEFAULT '' NOT NULL,
  "url" VARCHAR(255) DEFAULT '' NOT NULL,
  "temporary" SMALLINT DEFAULT 0 NOT NULL,
  "valid_time" INTEGER DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_media_type_md5" ON "work_media" ("type", "md5_path");

CREATE TABLE IF NOT EXISTS "work_member" (
  "id" SERIAL PRIMARY KEY,
  "corp_id" VARCHAR(18) DEFAULT '' NOT NULL,
  "userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "name" VARCHAR(64) DEFAULT '' NOT NULL,
  "position" VARCHAR(50) DEFAULT '' NOT NULL,
  "mobile" VARCHAR(11) DEFAULT '' NOT NULL,
  "gender" SMALLINT DEFAULT 0 NOT NULL,
  "email" VARCHAR(50) DEFAULT '' NOT NULL,
  "biz_mail" VARCHAR(50) DEFAULT '' NOT NULL,
  "direct_leader" VARCHAR(500) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(255) DEFAULT '' NOT NULL,
  "thumb_avatar" VARCHAR(255) DEFAULT '' NOT NULL,
  "telephone" VARCHAR(50) DEFAULT '' NOT NULL,
  "alias" VARCHAR(30) DEFAULT '' NOT NULL,
  "enable" SMALLINT DEFAULT 0 NOT NULL,
  "is_leader" SMALLINT DEFAULT 0 NOT NULL,
  "hide_mobile" SMALLINT DEFAULT 0 NOT NULL,
  "address" VARCHAR(255) DEFAULT '' NOT NULL,
  "open_userid" VARCHAR(64) DEFAULT '' NOT NULL,
  "main_department" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "qr_code" VARCHAR(255) DEFAULT '' NOT NULL,
  "external_position" VARCHAR(100) DEFAULT '' NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "work_member_userid_unique" ON "work_member" ("userid");
CREATE INDEX IF NOT EXISTS "work_member_corp_id" ON "work_member" ("corp_id");
CREATE INDEX IF NOT EXISTS "work_member_corp_userid" ON "work_member" ("corp_id", "userid");
CREATE INDEX IF NOT EXISTS "work_member_mobile" ON "work_member" ("mobile");
CREATE INDEX IF NOT EXISTS "work_member_catalog" ON "work_member" ("corp_id", "status", "name", "id");

CREATE TABLE IF NOT EXISTS "work_member_other" (
  "member_id" INTEGER DEFAULT 0 NOT NULL,
  "extattr" TEXT,
  "external_profile" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "work_member_other_member_id_unique" ON "work_member_other" ("member_id");

CREATE TABLE IF NOT EXISTS "work_member_relation" (
  "member_id" INTEGER DEFAULT 0 NOT NULL,
  "department" INTEGER DEFAULT 0 NOT NULL,
  "srot" INTEGER DEFAULT 0 NOT NULL,
  "is_leader_in_dept" SMALLINT DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_member_relation_member_id" ON "work_member_relation" ("member_id");
CREATE INDEX IF NOT EXISTS "work_member_relation_department_member" ON "work_member_relation" ("department", "member_id");

CREATE TABLE IF NOT EXISTS "work_moment" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(100) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "user_ids" TEXT,
  "client_type" SMALLINT DEFAULT 0 NOT NULL,
  "client_tag_list" TEXT,
  "welcome_words" TEXT,
  "send_type" SMALLINT DEFAULT 0 NOT NULL,
  "send_time" INTEGER DEFAULT 0 NOT NULL,
  "jobid" VARCHAR(64) DEFAULT '' NOT NULL,
  "invalid_sender_list" TEXT,
  "moment_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "invalid_external_contact_list" TEXT,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_moment_jobid" ON "work_moment" ("jobid");
CREATE INDEX IF NOT EXISTS "work_moment_moment_id" ON "work_moment" ("moment_id");
CREATE INDEX IF NOT EXISTS "work_moment_schedule" ON "work_moment" ("send_time", "send_type", "jobid");

CREATE TABLE IF NOT EXISTS "work_moment_send_result" (
  "id" SERIAL PRIMARY KEY,
  "moment_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "user_id" VARCHAR(64) DEFAULT '' NOT NULL,
  "external_userid" TEXT,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_moment_send_result_moment_id" ON "work_moment_send_result" ("moment_id");

CREATE TABLE IF NOT EXISTS "work_welcome" (
  "id" SERIAL PRIMARY KEY,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "content" TEXT,
  "attachments" TEXT,
  "sort" INTEGER DEFAULT 0 NOT NULL,
  "create_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  "delete_time" INTEGER
);
CREATE INDEX IF NOT EXISTS "work_welcome_catalog" ON "work_welcome" ("delete_time", "sort", "id");

CREATE TABLE IF NOT EXISTS "work_welcome_relation" (
  "welcome_id" INTEGER DEFAULT 0 NOT NULL,
  "userid" VARCHAR(64) DEFAULT '' NOT NULL
);
CREATE INDEX IF NOT EXISTS "work_welcome_relation_welcome_id" ON "work_welcome_relation" ("welcome_id");
`;
  }

  private migration_0084(): string {
    return `-- Preserve the superseded merchant application and official-account member
-- card history. This migration never creates/updates a remote WeChat card.
CREATE TABLE IF NOT EXISTS "user_enter" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "province" VARCHAR(32) DEFAULT '' NOT NULL,
  "city" VARCHAR(32) DEFAULT '' NOT NULL,
  "district" VARCHAR(32) DEFAULT '' NOT NULL,
  "address" VARCHAR(256) DEFAULT '' NOT NULL,
  "merchant_name" VARCHAR(256) DEFAULT '' NOT NULL,
  "link_user" VARCHAR(32) DEFAULT '' NOT NULL,
  "link_tel" VARCHAR(16) DEFAULT '' NOT NULL,
  "charter" VARCHAR(512) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "apply_time" INTEGER DEFAULT 0 NOT NULL,
  "success_time" INTEGER DEFAULT 0 NOT NULL,
  "fail_message" VARCHAR(256) DEFAULT '' NOT NULL,
  "fail_time" INTEGER DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 0 NOT NULL,
  "is_lock" SMALLINT DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_enter_uid_unique" ON "user_enter" ("uid");
CREATE INDEX IF NOT EXISTS "user_enter_region" ON "user_enter" ("province", "city", "district");
CREATE INDEX IF NOT EXISTS "user_enter_is_lock" ON "user_enter" ("is_lock");
CREATE INDEX IF NOT EXISTS "user_enter_is_del" ON "user_enter" ("is_del");
CREATE INDEX IF NOT EXISTS "user_enter_status" ON "user_enter" ("status");

CREATE TABLE IF NOT EXISTS "wechat_card" (
  "id" SERIAL PRIMARY KEY,
  "card_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "card_type" VARCHAR(20) DEFAULT 'member_card' NOT NULL,
  "code_type" VARCHAR(20) DEFAULT '' NOT NULL,
  "brand_name" VARCHAR(50) DEFAULT '' NOT NULL,
  "title" VARCHAR(50) DEFAULT '' NOT NULL,
  "color" VARCHAR(15) DEFAULT '' NOT NULL,
  "notice" VARCHAR(20) DEFAULT '' NOT NULL,
  "description" VARCHAR(255) DEFAULT '' NOT NULL,
  "center_title" VARCHAR(255) DEFAULT '' NOT NULL,
  "center_sub_title" VARCHAR(255) DEFAULT '' NOT NULL,
  "center_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "service_phone" VARCHAR(30) DEFAULT '' NOT NULL,
  "logo_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "background_pic_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "prerogative" TEXT,
  "especial" TEXT,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "wechat_card_catalog" ON "wechat_card" ("card_type", "is_del", "status", "id");
CREATE INDEX IF NOT EXISTS "wechat_card_remote_id" ON "wechat_card" ("card_id", "id");

CREATE TABLE IF NOT EXISTS "user_card" (
  "id" SERIAL PRIMARY KEY,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "spread_uid" INTEGER DEFAULT 0 NOT NULL,
  "wechat_card_id" INTEGER DEFAULT 0 NOT NULL,
  "card_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "code" VARCHAR(50) DEFAULT '' NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "staff_id" INTEGER DEFAULT 0 NOT NULL,
  "openid" VARCHAR(100) DEFAULT '' NOT NULL,
  "is_submit" SMALLINT DEFAULT 0 NOT NULL,
  "submit_time" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "del_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
);
CREATE INDEX IF NOT EXISTS "user_card_active_remote" ON "user_card" ("openid", "card_id", "is_del", "id");
CREATE INDEX IF NOT EXISTS "user_card_store_staff_submit" ON "user_card" ("store_id", "staff_id", "is_submit", "add_time", "id");
CREATE INDEX IF NOT EXISTS "user_card_uid" ON "user_card" ("uid", "id");
CREATE INDEX IF NOT EXISTS "user_card_wechat_card" ON "user_card" ("wechat_card_id", "id");
`;
  }

  private migration_0085(): string {
    return `-- Restore the fulfillment lookup index independently of the original bootstrap.
-- Some upgraded databases already had store_order before the bootstrap migration,
-- and production evidence showed the verify-code index was absent.
CREATE INDEX IF NOT EXISTS "so_verify_code"
  ON "store_order" ("verify_code");
`;
  }

  private migration_0086(): string {
    return `-- PHP stores a store_pink row id in is_refund when a leader or member exits.
-- SMALLINT rejects normal production ids above 32767, so widen the reference
-- without changing existing values or the active sentinel (0).
ALTER TABLE "store_pink"
  ALTER COLUMN "is_refund" TYPE INTEGER
  USING "is_refund"::INTEGER;
`;
  }

  private migration_0087(): string {
    return `-- Persist Cloudflare Queue dead letters beyond the Queue retention window and
-- keep every replay/resolve decision auditable. Sensitive or unknown bodies are
-- archived only after application-level redaction and are never replayable.
CREATE TABLE IF NOT EXISTS "system_queue_dead_letter" (
  "id" SERIAL PRIMARY KEY,
  "queue_name" VARCHAR(128) NOT NULL,
  "message_id" VARCHAR(128) NOT NULL,
  "message_timestamp_ms" BIGINT DEFAULT 0 NOT NULL,
  "dlq_attempts" INTEGER DEFAULT 1 NOT NULL,
  "message_type" VARCHAR(64) DEFAULT 'unknown' NOT NULL,
  "body" JSONB DEFAULT '{}'::jsonb NOT NULL,
  "body_sha256" VARCHAR(64) NOT NULL,
  "replay_policy" VARCHAR(24) DEFAULT 'BLOCK_UNSUPPORTED' NOT NULL,
  "status" VARCHAR(16) DEFAULT 'OPEN' NOT NULL,
  "occurrence_count" INTEGER DEFAULT 1 NOT NULL,
  "replay_count" INTEGER DEFAULT 0 NOT NULL,
  "first_seen_time" INTEGER DEFAULT 0 NOT NULL,
  "last_seen_time" INTEGER DEFAULT 0 NOT NULL,
  "replay_requested_time" INTEGER DEFAULT 0 NOT NULL,
  "replayed_time" INTEGER DEFAULT 0 NOT NULL,
  "resolved_time" INTEGER DEFAULT 0 NOT NULL,
  "replay_lease_until" INTEGER DEFAULT 0 NOT NULL,
  "replay_token" VARCHAR(36) DEFAULT '' NOT NULL,
  "replay_requested_by" INTEGER DEFAULT 0 NOT NULL,
  "resolved_by" INTEGER DEFAULT 0 NOT NULL,
  "replay_reason" VARCHAR(500) DEFAULT '' NOT NULL,
  "resolution_reason" VARCHAR(500) DEFAULT '' NOT NULL,
  "last_error" VARCHAR(1000) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "sqdl_queue_message_uq" UNIQUE ("queue_name", "message_id"),
  CONSTRAINT "sqdl_status_ck" CHECK (
    "status" IN ('OPEN', 'REPLAYING', 'REPLAYED', 'RESOLVED')
  ),
  CONSTRAINT "sqdl_replay_policy_ck" CHECK (
    "replay_policy" IN ('ALLOW', 'BLOCK_SENSITIVE', 'BLOCK_UNSUPPORTED')
  ),
  CONSTRAINT "sqdl_count_ck" CHECK (
    "dlq_attempts" > 0 AND "occurrence_count" > 0 AND "replay_count" >= 0
  ),
  CONSTRAINT "sqdl_time_ck" CHECK (
    "message_timestamp_ms" >= 0 AND "first_seen_time" >= 0
      AND "last_seen_time" >= 0 AND "replay_requested_time" >= 0
      AND "replayed_time" >= 0 AND "resolved_time" >= 0
      AND "replay_lease_until" >= 0
  )
);

CREATE INDEX IF NOT EXISTS "sqdl_open_alerts"
  ON "system_queue_dead_letter" ("status", "first_seen_time", "id");
CREATE INDEX IF NOT EXISTS "sqdl_type_status"
  ON "system_queue_dead_letter" ("message_type", "status", "id");
CREATE INDEX IF NOT EXISTS "sqdl_replay_lease"
  ON "system_queue_dead_letter" ("replay_lease_until", "id")
  WHERE "status" = 'REPLAYING';
`;
  }

  private migration_0088(): string {
    return `-- Replace the PHP editor's unrestricted plaintext virtual_list replay with a
-- short-lived, actor/tenant-bound and one-time export authorization. Only the
-- SHA-256 digest of the bearer ticket is persisted; card secrets stay in the
-- existing inventory table and the one successful response.
CREATE TABLE IF NOT EXISTS "system_virtual_inventory_export" (
  "id" SERIAL PRIMARY KEY,
  "token_hash" VARCHAR(64) NOT NULL,
  "actor_type" VARCHAR(16) NOT NULL,
  "actor_id" INTEGER NOT NULL,
  "supplier_id" INTEGER DEFAULT 0 NOT NULL,
  "product_id" INTEGER NOT NULL,
  "attr_unique" VARCHAR(20) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "requested_count" INTEGER NOT NULL,
  "exported_count" INTEGER DEFAULT 0 NOT NULL,
  "status" VARCHAR(16) DEFAULT 'READY' NOT NULL,
  "created_at" TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "consumed_at" TIMESTAMPTZ,
  CONSTRAINT "svie_actor_type_ck" CHECK ("actor_type" IN ('admin', 'supplier')),
  CONSTRAINT "svie_status_ck" CHECK ("status" IN ('READY', 'CONSUMED', 'EXPIRED')),
  CONSTRAINT "svie_identity_ck" CHECK (
    "actor_id" > 0 AND "supplier_id" >= 0 AND "product_id" > 0
  ),
  CONSTRAINT "svie_count_ck" CHECK (
    "requested_count" > 0 AND "requested_count" <= 1000
      AND "exported_count" >= 0 AND "exported_count" <= 1000
  ),
  CONSTRAINT "svie_expiry_ck" CHECK ("expires_at" > "created_at")
);

CREATE UNIQUE INDEX IF NOT EXISTS "svie_token_hash_uq"
  ON "system_virtual_inventory_export" ("token_hash");
CREATE INDEX IF NOT EXISTS "svie_actor_history"
  ON "system_virtual_inventory_export" ("actor_type", "actor_id", "id");
CREATE INDEX IF NOT EXISTS "svie_product_history"
  ON "system_virtual_inventory_export" ("product_id", "attr_unique", "id");
CREATE INDEX IF NOT EXISTS "svie_ready_expiry"
  ON "system_virtual_inventory_export" ("expires_at", "id")
  WHERE "status" = 'READY';
`;
  }

  private migration_0089(): string {
    return `-- Payment callbacks look up recharge orders by provider order number and the
-- cashier lists a user's current payment state. Preserve duplicate legacy rows
-- for audit; application code refuses ambiguous callbacks instead of choosing
-- one silently.
CREATE INDEX IF NOT EXISTS "ur_order_id_lookup"
  ON "user_recharge" ("order_id");
CREATE INDEX IF NOT EXISTS "ur_uid"
  ON "user_recharge" ("uid");
CREATE INDEX IF NOT EXISTS "ur_uid_paid_time"
  ON "user_recharge" ("uid", "paid", "add_time", "id");`;
  }

  private migration_0090(): string {
    return `-- Privacy-preserving, append-only application audit for sensitive third-party
-- reads and writes. Raw paths, resource IDs, query values, IP addresses,
-- user agents, request bodies and response bodies must never be stored here.
CREATE TABLE IF NOT EXISTS "out_api_audit" (
  "id" BIGSERIAL PRIMARY KEY,
  "out_account_id" INTEGER DEFAULT 0 NOT NULL,
  "appid_snapshot" VARCHAR(50) DEFAULT '' NOT NULL,
  "method" VARCHAR(12) DEFAULT '' NOT NULL,
  "route_template" VARCHAR(128) DEFAULT '' NOT NULL,
  "operation" VARCHAR(16) DEFAULT 'read' NOT NULL,
  "resource_hash" VARCHAR(64) DEFAULT '' NOT NULL,
  "query_fields" VARCHAR(255) DEFAULT '' NOT NULL,
  "ip_hash" VARCHAR(64) DEFAULT '' NOT NULL,
  "user_agent_hash" VARCHAR(64) DEFAULT '' NOT NULL,
  "outcome" VARCHAR(16) DEFAULT 'success' NOT NULL,
  "result_code" INTEGER DEFAULT 200 NOT NULL,
  "duration_ms" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "out_audit_operation_ck" CHECK ("operation" IN ('read', 'write')),
  CONSTRAINT "out_audit_outcome_ck" CHECK ("outcome" IN ('success', 'denied', 'rate_limited', 'error')),
  CONSTRAINT "out_audit_result_code_ck" CHECK ("result_code" BETWEEN 0 AND 999999),
  CONSTRAINT "out_audit_duration_ck" CHECK ("duration_ms" BETWEEN 0 AND 3600000),
  CONSTRAINT "out_audit_add_time_ck" CHECK ("add_time" >= 0),
  CONSTRAINT "out_audit_hashes_ck" CHECK (
    ("resource_hash" = '' OR "resource_hash" ~ '^[0-9a-f]{64}$')
    AND ("ip_hash" = '' OR "ip_hash" ~ '^[0-9a-f]{64}$')
    AND ("user_agent_hash" = '' OR "user_agent_hash" ~ '^[0-9a-f]{64}$')
  )
);

CREATE INDEX IF NOT EXISTS "out_audit_account_time"
  ON "out_api_audit" ("out_account_id", "add_time", "id");
CREATE INDEX IF NOT EXISTS "out_audit_route_time"
  ON "out_api_audit" ("route_template", "add_time", "id");
CREATE INDEX IF NOT EXISTS "out_audit_outcome_time"
  ON "out_api_audit" ("outcome", "add_time", "id");`;
  }

  private migration_0091(): string {
    return `-- Durable, idempotent in-app delivery/refund notices.
-- Legacy system_message rows remain NULL and are therefore unaffected by the
-- unique source-event key used by new Worker outbox consumers.
ALTER TABLE "system_message"
  ADD COLUMN IF NOT EXISTS "event_key" VARCHAR(128);

CREATE UNIQUE INDEX IF NOT EXISTS "smsg_event_key_uq"
  ON "system_message" ("event_key");

-- Expand the existing payment-only outbox without weakening its event whitelist.
ALTER TABLE "store_order_outbox"
  DROP CONSTRAINT IF EXISTS "soob_event_type_ck";

ALTER TABLE "store_order_outbox"
  ADD CONSTRAINT "soob_event_type_ck" CHECK (
    "event_type" IN (
      'order.paid',
      'order.delivery.notice',
      'order.refund.refused.notice'
    )
  );`;
  }

  private migration_0092(): string {
    return `-- Provider side effects are deliberately separated from the root order outbox.
CREATE TABLE IF NOT EXISTS "order_notification_delivery" (
  "id" SERIAL PRIMARY KEY,
  "outbox_id" INTEGER NOT NULL,
  "event_key" VARCHAR(128) NOT NULL,
  "order_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "notice_mark" VARCHAR(50) NOT NULL,
  "channel" VARCHAR(32) NOT NULL,
  "target" VARCHAR(255) DEFAULT '' NOT NULL,
  "template_code" VARCHAR(100) DEFAULT '' NOT NULL,
  "payload" JSONB NOT NULL,
  "status" VARCHAR(16) DEFAULT 'PENDING' NOT NULL,
  "dispatch_count" INTEGER DEFAULT 0 NOT NULL,
  "attempt_count" INTEGER DEFAULT 0 NOT NULL,
  "replay_count" INTEGER DEFAULT 0 NOT NULL,
  "available_time" INTEGER DEFAULT 0 NOT NULL,
  "lease_until" INTEGER DEFAULT 0 NOT NULL,
  "lease_token" VARCHAR(36) DEFAULT '' NOT NULL,
  "provider_reference" VARCHAR(255) DEFAULT '' NOT NULL,
  "provider_request_id" VARCHAR(255) DEFAULT '' NOT NULL,
  "response_code" VARCHAR(100) DEFAULT '' NOT NULL,
  "last_error" VARCHAR(1000) DEFAULT '' NOT NULL,
  "sent_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "ond_channel_ck" CHECK ("channel" IN (
    'sms', 'wechat_official', 'wechat_routine', 'wechat_shipping'
  )),
  CONSTRAINT "ond_status_ck" CHECK ("status" IN (
    'PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE',
    'SENT', 'SKIPPED', 'UNKNOWN', 'DEAD'
  )),
  CONSTRAINT "ond_time_ck" CHECK (
    "available_time" >= 0 AND "lease_until" >= 0 AND "sent_time" >= 0
    AND "add_time" >= 0 AND "update_time" >= 0
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "ond_event_channel_uq"
  ON "order_notification_delivery" ("event_key", "channel");
CREATE INDEX IF NOT EXISTS "ond_outbox"
  ON "order_notification_delivery" ("outbox_id", "id");
CREATE INDEX IF NOT EXISTS "ond_order"
  ON "order_notification_delivery" ("order_id", "id");
CREATE INDEX IF NOT EXISTS "ond_dispatch_ready"
  ON "order_notification_delivery" ("available_time", "id")
  WHERE "status" IN ('PENDING', 'RETRYABLE');
CREATE INDEX IF NOT EXISTS "ond_expired_queue_lease"
  ON "order_notification_delivery" ("lease_until", "id")
  WHERE "status" IN ('ENQUEUING', 'ENQUEUED');
CREATE INDEX IF NOT EXISTS "ond_expired_provider_lease"
  ON "order_notification_delivery" ("lease_until", "id")
  WHERE "status" = 'PROCESSING';
CREATE UNIQUE INDEX IF NOT EXISTS "wu_openid_uq" ON "wechat_user" ("openid");
CREATE INDEX IF NOT EXISTS "wu_unionid" ON "wechat_user" ("unionid");
CREATE INDEX IF NOT EXISTS "wu_uid" ON "wechat_user" ("uid");
CREATE INDEX IF NOT EXISTS "wu_uid_type_latest" ON "wechat_user" ("uid", "user_type", "id");
CREATE INDEX IF NOT EXISTS "nt_enabled_provider_lookup"
  ON "notification_template" ("legacy_type", "mark", "id") WHERE "status" = 1;`;
  }

  private migration_0093(): string {
    return `-- Keep every manual decision about ambiguous provider outcomes immutable.
-- No notification target or rendered payload is copied into this audit table.
CREATE TABLE IF NOT EXISTS "order_notification_delivery_action" (
  "id" SERIAL PRIMARY KEY,
  "delivery_id" INTEGER NOT NULL,
  "request_key" VARCHAR(36) NOT NULL,
  "action" VARCHAR(32) NOT NULL,
  "previous_status" VARCHAR(16) NOT NULL,
  "next_status" VARCHAR(16) NOT NULL,
  "admin_id" INTEGER NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "provider_reference" VARCHAR(255) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "onda_action_ck" CHECK (
    "action" IN ('CONFIRM_SENT', 'CONFIRM_RETRY', 'CLOSE_NO_RETRY')
  ),
  CONSTRAINT "onda_admin_time_ck" CHECK ("admin_id" > 0 AND "add_time" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "onda_request_key_uq"
  ON "order_notification_delivery_action" ("request_key");
CREATE INDEX IF NOT EXISTS "onda_delivery"
  ON "order_notification_delivery_action" ("delivery_id", "id");
CREATE INDEX IF NOT EXISTS "onda_admin_time"
  ON "order_notification_delivery_action" ("admin_id", "add_time", "id");`;
  }

  private migration_0094(): string {
    return `-- Community author feeds and recommendations are read on every social screen.
-- Match the full visibility predicate so deleted or unreviewed legacy rows do
-- not bloat the hot indexes.
CREATE INDEX IF NOT EXISTS "c_author_public_latest"
  ON "community" ("type", "relation_id", "add_time" DESC, "id" DESC)
  WHERE "status" = 1 AND "is_verify" = 1 AND "is_del" = 0;

CREATE INDEX IF NOT EXISTS "cu_recommend_rank"
  ON "community_user" ("fans_num" DESC, "id" DESC)
  WHERE "status" = 1 AND "is_del" = 0 AND "community_num" > 0;`;
  }

  private migration_0095(): string {
    return `-- Community moderation screens repeatedly filter non-deleted rows by review,
-- source/content type, thread level and visibility. Partial indexes keep legacy
-- soft-deleted history out of the operator hot path.
CREATE INDEX IF NOT EXISTS "c_admin_moderation"
  ON "community" ("is_verify", "type", "content_type", "add_time" DESC, "id" DESC)
  WHERE "is_del" = 0;

CREATE INDEX IF NOT EXISTS "cc_admin_moderation"
  ON "community_comment" ("is_reply", "is_verify", "is_show", "community_id", "add_time" DESC, "id" DESC)
  WHERE "is_del" = 0;

CREATE INDEX IF NOT EXISTS "ct_admin_catalog"
  ON "community_topic" ("status", "is_recommend", "sort" DESC, "id" DESC)
  WHERE "is_del" = 0;`;
  }

  private migration_0096(): string {
    return `-- Client community reads repeatedly scan one public reply thread, one user's
-- product source history, or one user's product collections. Match equality
-- predicates first and keep immutable non-matching relation rows out of the
-- collection index.
CREATE INDEX IF NOT EXISTS "cc_public_replies"
  ON "community_comment" ("reply_id", "add_time", "id")
  WHERE "is_reply" = 0 AND "is_del" = 0 AND "is_show" = 1 AND "is_verify" = 1;

CREATE INDEX IF NOT EXISTS "spl_user_source_latest"
  ON "store_product_log" ("uid", "type", "add_time" DESC, "product_id");

CREATE INDEX IF NOT EXISTS "ur_user_product_collect_latest"
  ON "user_relation" ("uid", "add_time" DESC, "id" DESC, "relation_id")
  WHERE "type" = 'collect' AND "category" = 'product';`;
  }

  private migration_0097(): string {
    return `-- Durable receipt-printer side effects. Queue messages contain only the job ID
-- and immutable event key; credentials and rendered order data stay in PostgreSQL.
CREATE TABLE IF NOT EXISTS "order_print_job" (
  "id" SERIAL PRIMARY KEY,
  "event_key" VARCHAR(128) NOT NULL,
  "request_key" VARCHAR(36) DEFAULT '' NOT NULL,
  "order_id" INTEGER NOT NULL,
  "order_no" VARCHAR(32) NOT NULL,
  "printer_id" INTEGER NOT NULL,
  "supplier_id" INTEGER NOT NULL,
  "trigger" VARCHAR(16) NOT NULL,
  "provider" VARCHAR(16) NOT NULL,
  "actor_type" VARCHAR(16) NOT NULL,
  "actor_id" INTEGER DEFAULT 0 NOT NULL,
  "status" VARCHAR(16) DEFAULT 'PENDING' NOT NULL,
  "dispatch_count" INTEGER DEFAULT 0 NOT NULL,
  "attempt_count" INTEGER DEFAULT 0 NOT NULL,
  "replay_count" INTEGER DEFAULT 0 NOT NULL,
  "available_time" INTEGER DEFAULT 0 NOT NULL,
  "lease_until" INTEGER DEFAULT 0 NOT NULL,
  "lease_token" VARCHAR(36) DEFAULT '' NOT NULL,
  "provider_reference" VARCHAR(255) DEFAULT '' NOT NULL,
  "provider_request_id" VARCHAR(255) DEFAULT '' NOT NULL,
  "response_code" VARCHAR(100) DEFAULT '' NOT NULL,
  "content_hash" VARCHAR(64) DEFAULT '' NOT NULL,
  "last_error" VARCHAR(1000) DEFAULT '' NOT NULL,
  "sent_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "opj_trigger_ck" CHECK ("trigger" IN ('created', 'paid', 'manual')),
  CONSTRAINT "opj_provider_ck" CHECK ("provider" IN ('yilianyun', 'feieyun')),
  CONSTRAINT "opj_actor_ck" CHECK (
    ("actor_type" = 'system' AND "actor_id" = 0)
    OR ("actor_type" IN ('admin', 'supplier') AND "actor_id" > 0)
  ),
  CONSTRAINT "opj_status_ck" CHECK ("status" IN (
    'PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE',
    'SENT', 'UNKNOWN', 'DEAD', 'CLOSED'
  )),
  CONSTRAINT "opj_identity_ck" CHECK (
    "order_id" > 0 AND "printer_id" > 0 AND "supplier_id" >= 0
  ),
  CONSTRAINT "opj_time_ck" CHECK (
    "available_time" >= 0 AND "lease_until" >= 0 AND "sent_time" >= 0
    AND "add_time" >= 0 AND "update_time" >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "opj_event_key_uq"
  ON "order_print_job" ("event_key");
CREATE UNIQUE INDEX IF NOT EXISTS "opj_manual_request_printer_uq"
  ON "order_print_job" ("request_key", "printer_id")
  WHERE "request_key" <> '';
CREATE INDEX IF NOT EXISTS "opj_manual_request"
  ON "order_print_job" ("request_key", "id")
  WHERE "request_key" <> '';
CREATE INDEX IF NOT EXISTS "opj_owner_history"
  ON "order_print_job" ("supplier_id", "id" DESC);
CREATE INDEX IF NOT EXISTS "opj_order_history"
  ON "order_print_job" ("order_id", "id" DESC);
CREATE INDEX IF NOT EXISTS "opj_dispatch_ready"
  ON "order_print_job" ("available_time", "id")
  WHERE "status" IN ('PENDING', 'RETRYABLE');
CREATE INDEX IF NOT EXISTS "opj_expired_queue_lease"
  ON "order_print_job" ("lease_until", "id")
  WHERE "status" IN ('ENQUEUING', 'ENQUEUED');
CREATE INDEX IF NOT EXISTS "opj_expired_provider_lease"
  ON "order_print_job" ("lease_until", "id")
  WHERE "status" = 'PROCESSING';

-- Immutable operator decisions for ambiguous or terminal provider outcomes.
-- No rendered receipt, delivery address, phone number, or provider secret is copied here.
CREATE TABLE IF NOT EXISTS "order_print_job_action" (
  "id" SERIAL PRIMARY KEY,
  "job_id" INTEGER NOT NULL,
  "request_key" VARCHAR(36) NOT NULL,
  "action" VARCHAR(32) NOT NULL,
  "previous_status" VARCHAR(16) NOT NULL,
  "next_status" VARCHAR(16) NOT NULL,
  "actor_type" VARCHAR(16) NOT NULL,
  "actor_id" INTEGER NOT NULL,
  "supplier_id" INTEGER NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "provider_reference" VARCHAR(255) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "opja_action_ck" CHECK (
    "action" IN ('CONFIRM_SENT', 'CONFIRM_RETRY', 'CLOSE_NO_RETRY')
  ),
  CONSTRAINT "opja_actor_ck" CHECK (
    "actor_type" IN ('admin', 'supplier') AND "actor_id" > 0 AND "supplier_id" >= 0
  ),
  CONSTRAINT "opja_time_ck" CHECK ("add_time" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "opja_request_key_uq"
  ON "order_print_job_action" ("request_key");
CREATE INDEX IF NOT EXISTS "opja_job"
  ON "order_print_job_action" ("job_id", "id");
CREATE INDEX IF NOT EXISTS "opja_actor_time"
  ON "order_print_job_action" ("actor_type", "actor_id", "add_time", "id");`;
  }

  private migration_0098(): string {
    return `-- One durable intent covers both the irreversible provider allocation and the
-- local fulfillment commit. Queue messages contain only the job ID/event key.
CREATE TABLE IF NOT EXISTS "order_waybill_job" (
  "id" SERIAL PRIMARY KEY,
  "event_key" VARCHAR(128) NOT NULL,
  "request_key" VARCHAR(36) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "root_order_id" INTEGER NOT NULL,
  "order_id" INTEGER NOT NULL,
  "order_no" VARCHAR(32) NOT NULL,
  "supplier_id" INTEGER NOT NULL,
  "store_id" INTEGER DEFAULT 0 NOT NULL,
  "actor_type" VARCHAR(16) NOT NULL,
  "actor_id" INTEGER NOT NULL,
  "fulfillment_mode" VARCHAR(16) NOT NULL,
  "cart_selection" VARCHAR(16000) DEFAULT '[]' NOT NULL,
  "carrier_id" INTEGER NOT NULL,
  "carrier_code" VARCHAR(50) NOT NULL,
  "carrier_name" VARCHAR(64) NOT NULL,
  "carrier_config" VARCHAR(2000) DEFAULT '{}' NOT NULL,
  "template_id" VARCHAR(255) NOT NULL,
  "cloud_printer_id" VARCHAR(50) DEFAULT '' NOT NULL,
  "sender_name" VARCHAR(128) NOT NULL,
  "sender_phone" VARCHAR(32) NOT NULL,
  "sender_address" VARCHAR(255) NOT NULL,
  "status" VARCHAR(16) DEFAULT 'PENDING' NOT NULL,
  "dispatch_count" INTEGER DEFAULT 0 NOT NULL,
  "attempt_count" INTEGER DEFAULT 0 NOT NULL,
  "replay_count" INTEGER DEFAULT 0 NOT NULL,
  "available_time" INTEGER DEFAULT 0 NOT NULL,
  "lease_until" INTEGER DEFAULT 0 NOT NULL,
  "lease_token" VARCHAR(36) DEFAULT '' NOT NULL,
  "provider_reference" VARCHAR(255) DEFAULT '' NOT NULL,
  "response_code" VARCHAR(100) DEFAULT '' NOT NULL,
  "tracking_number" VARCHAR(64) DEFAULT '' NOT NULL,
  "label_url" VARCHAR(255) DEFAULT '' NOT NULL,
  "payload_hash" VARCHAR(64) DEFAULT '' NOT NULL,
  "fulfilled_order_id" INTEGER DEFAULT 0 NOT NULL,
  "remaining_order_id" INTEGER DEFAULT 0 NOT NULL,
  "last_error" VARCHAR(1000) DEFAULT '' NOT NULL,
  "sent_time" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "owj_actor_ck" CHECK (
    "actor_type" IN ('admin', 'supplier') AND "actor_id" > 0 AND "supplier_id" >= 0
  ),
  CONSTRAINT "owj_mode_ck" CHECK ("fulfillment_mode" IN ('whole', 'split')),
  CONSTRAINT "owj_status_ck" CHECK ("status" IN (
    'PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE',
    'SENT', 'UNKNOWN', 'DEAD', 'CLOSED'
  )),
  CONSTRAINT "owj_identity_ck" CHECK (
    "root_order_id" > 0 AND "order_id" > 0 AND "carrier_id" > 0
    AND "store_id" >= 0 AND "fulfilled_order_id" >= 0 AND "remaining_order_id" >= 0
  ),
  CONSTRAINT "owj_time_ck" CHECK (
    "available_time" >= 0 AND "lease_until" >= 0 AND "sent_time" >= 0
    AND "add_time" >= 0 AND "update_time" >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "owj_event_key_uq"
  ON "order_waybill_job" ("event_key");
CREATE UNIQUE INDEX IF NOT EXISTS "owj_request_key_uq"
  ON "order_waybill_job" ("request_key");
CREATE UNIQUE INDEX IF NOT EXISTS "owj_active_root_uq"
  ON "order_waybill_job" ("root_order_id")
  WHERE "status" IN (
    'PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE', 'UNKNOWN', 'DEAD'
  );
CREATE INDEX IF NOT EXISTS "owj_owner_history"
  ON "order_waybill_job" ("supplier_id", "id" DESC);
CREATE INDEX IF NOT EXISTS "owj_order_history"
  ON "order_waybill_job" ("order_id", "id" DESC);
CREATE INDEX IF NOT EXISTS "owj_dispatch_ready"
  ON "order_waybill_job" ("available_time", "id")
  WHERE "status" IN ('PENDING', 'RETRYABLE');
CREATE INDEX IF NOT EXISTS "owj_expired_queue_lease"
  ON "order_waybill_job" ("lease_until", "id")
  WHERE "status" IN ('ENQUEUING', 'ENQUEUED');
CREATE INDEX IF NOT EXISTS "owj_expired_provider_lease"
  ON "order_waybill_job" ("lease_until", "id")
  WHERE "status" = 'PROCESSING';

-- Immutable human decisions. Recipient/sender data and carrier credentials
-- remain only on the job row and are never copied into this audit log.
CREATE TABLE IF NOT EXISTS "order_waybill_job_action" (
  "id" SERIAL PRIMARY KEY,
  "job_id" INTEGER NOT NULL,
  "request_key" VARCHAR(36) NOT NULL,
  "action" VARCHAR(32) NOT NULL,
  "previous_status" VARCHAR(16) NOT NULL,
  "next_status" VARCHAR(16) NOT NULL,
  "actor_type" VARCHAR(16) NOT NULL,
  "actor_id" INTEGER NOT NULL,
  "supplier_id" INTEGER NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "provider_reference" VARCHAR(255) DEFAULT '' NOT NULL,
  "tracking_number" VARCHAR(64) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "owja_action_ck" CHECK (
    "action" IN ('APPLY_EXISTING', 'CONFIRM_ISSUED', 'CONFIRM_RETRY', 'CLOSE_NO_RETRY')
  ),
  CONSTRAINT "owja_actor_ck" CHECK (
    "actor_type" IN ('admin', 'supplier') AND "actor_id" > 0 AND "supplier_id" >= 0
  ),
  CONSTRAINT "owja_time_ck" CHECK ("add_time" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "owja_request_key_uq"
  ON "order_waybill_job_action" ("request_key");
CREATE INDEX IF NOT EXISTS "owja_job"
  ON "order_waybill_job_action" ("job_id", "id");
CREATE INDEX IF NOT EXISTS "owja_actor_time"
  ON "order_waybill_job_action" ("actor_type", "actor_id", "add_time", "id");`;
  }

  private migration_0099(): string {
    return `-- Dedicated customer-service login, active-agent lookup, scoped chat history,
-- recent-session keyset pagination and private speechcraft categories.
CREATE INDEX IF NOT EXISTS "ss_active_online"
  ON "store_service" ("online", "id")
  WHERE "is_del" = 0 AND "status" = 1 AND "account_status" = 1;

CREATE INDEX IF NOT EXISTS "ssl_chat_history"
  ON "store_service_log" ("uid", "to_uid", "is_tourist", "id");

CREATE INDEX IF NOT EXISTS "ssr_kefu_recent"
  ON "store_service_record" ("to_uid", "is_tourist", "update_time" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "category_kefu_speechcraft"
  ON "category" ("owner_id", "type", "group", "sort" DESC, "id");`;
  }

  private migration_0100(): string {
    return `-- Per-principal realtime chat: active identity lookup, recipient inbox,
-- directional session updates and unread-message reconciliation.
CREATE INDEX IF NOT EXISTS "ss_active_uid"
  ON "store_service" ("uid", "id")
  WHERE "is_del" = 0 AND "status" = 1 AND "account_status" = 1;

CREATE INDEX IF NOT EXISTS "ssr_kefu_inbox"
  ON "store_service_record" ("user_id", "is_tourist", "update_time" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "ssr_direction"
  ON "store_service_record" ("user_id", "to_uid", "is_tourist", "id" DESC);

CREATE INDEX IF NOT EXISTS "ssl_unread_direction"
  ON "store_service_log" ("uid", "to_uid", "is_tourist", "id")
  WHERE "type" = 0;`;
  }

  private migration_0101(): string {
    return `-- Idempotent, auditable customer-service ownership transfer.
-- Message content remains exclusively in store_service_log.
CREATE TABLE IF NOT EXISTS "store_service_transfer" (
  "request_key" VARCHAR(36) PRIMARY KEY,
  "customer_uid" INTEGER NOT NULL,
  "from_kefu_uid" INTEGER NOT NULL,
  "to_kefu_uid" INTEGER NOT NULL,
  "from_service_id" INTEGER NOT NULL,
  "to_service_id" INTEGER NOT NULL,
  "source_record_id" INTEGER NOT NULL,
  "target_record_id" INTEGER NOT NULL,
  "copied_message_count" INTEGER DEFAULT 0 NOT NULL,
  "created_at" INTEGER NOT NULL,
  CONSTRAINT "sst_positive_ids_ck" CHECK (
    "customer_uid" > 0 AND "from_kefu_uid" > 0 AND "to_kefu_uid" > 0
    AND "from_service_id" > 0 AND "to_service_id" > 0
    AND "source_record_id" > 0 AND "target_record_id" > 0
  ),
  CONSTRAINT "sst_distinct_kefu_ck" CHECK ("from_kefu_uid" <> "to_kefu_uid"),
  CONSTRAINT "sst_count_time_ck" CHECK ("copied_message_count" >= 0 AND "created_at" >= 0)
);

CREATE INDEX IF NOT EXISTS "sst_customer_time"
  ON "store_service_transfer" ("customer_uid", "created_at", "request_key");
CREATE INDEX IF NOT EXISTS "sst_target_time"
  ON "store_service_transfer" ("to_kefu_uid", "created_at", "request_key");`;
  }

  private migration_0102(): string {
    return `-- Scoped customer product context: purchases, visit recency and category expansion.
CREATE INDEX IF NOT EXISTS "soci_kefu_order_product"
  ON "store_order_cart_info" ("oid", "product_id");

CREATE INDEX IF NOT EXISTS "sv_kefu_recent"
  ON "store_visit" ("uid", "add_time" DESC, "id" DESC, "product_id");

CREATE INDEX IF NOT EXISTS "spr_kefu_product_category"
  ON "store_product_relation" ("type", "product_id", "relation_id");

CREATE INDEX IF NOT EXISTS "spr_kefu_category_product"
  ON "store_product_relation" ("type", "relation_id", "product_id");`;
  }

  private migration_0103(): string {
    return `-- Assigned customer order/refund context. Partial predicates match the Kefu read contracts.
CREATE INDEX IF NOT EXISTS "so_kefu_customer_orders"
  ON "store_order" ("uid", "id" DESC)
  WHERE "is_system_del" = 0
    AND "is_del" = 0
    AND "store_id" = 0
    AND "pid" = 0
    AND "refund_type" IN (0, 1, 3, 6);

CREATE INDEX IF NOT EXISTS "sor_kefu_customer_refunds"
  ON "store_order_refund" ("uid", "add_time" DESC, "id" DESC)
  WHERE "is_cancel" = 0 AND "is_del" = 0;`;
  }

  private migration_0104(): string {
    return `-- Transactional replay ledger for third-party product writes. The ledger is
-- deliberately content-free: no product names, barcodes, stock values, request
-- bodies or response bodies are persisted, only a canonical request digest.
CREATE TABLE IF NOT EXISTS "out_product_write_replay" (
  "id" BIGSERIAL PRIMARY KEY,
  "out_account_id" INTEGER NOT NULL,
  "operation" VARCHAR(32) NOT NULL,
  "request_key" VARCHAR(36) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "product_id" INTEGER DEFAULT 0 NOT NULL,
  "result_count" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "opwr_operation_ck" CHECK (
    "operation" IN ('product_create', 'product_update', 'product_show', 'stock_upload')
  ),
  CONSTRAINT "opwr_identity_ck" CHECK (
    "out_account_id" > 0 AND "product_id" >= 0
      AND "result_count" >= 0 AND "add_time" >= 0
  ),
  CONSTRAINT "opwr_request_hash_ck" CHECK ("request_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "opwr_account_operation_key_uq"
  ON "out_product_write_replay" ("out_account_id", "operation", "request_key");
CREATE INDEX IF NOT EXISTS "opwr_product_history"
  ON "out_product_write_replay" ("product_id", "id");`;
  }

  private migration_0105(): string {
    return `-- Content-free replay ledger for externally-triggered coupon writes. Coupon
-- titles, values, scopes, dates and request/response bodies are never stored.
CREATE TABLE IF NOT EXISTS "out_coupon_write_replay" (
  "id" BIGSERIAL PRIMARY KEY,
  "out_account_id" INTEGER NOT NULL,
  "operation" VARCHAR(32) NOT NULL,
  "request_key" VARCHAR(36) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "coupon_id" INTEGER DEFAULT 0 NOT NULL,
  "result_status" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "ocwr_operation_ck" CHECK (
    "operation" IN ('coupon_create', 'coupon_status', 'coupon_delete')
  ),
  CONSTRAINT "ocwr_identity_ck" CHECK (
    "out_account_id" > 0 AND "coupon_id" > 0
      AND "result_status" BETWEEN -1 AND 1 AND "add_time" >= 0
  ),
  CONSTRAINT "ocwr_request_hash_ck" CHECK ("request_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "ocwr_account_operation_key_uq"
  ON "out_coupon_write_replay" ("out_account_id", "operation", "request_key");
CREATE INDEX IF NOT EXISTS "ocwr_coupon_history"
  ON "out_coupon_write_replay" ("coupon_id", "id");`;
  }

  private migration_0106(): string {
    return `-- Content-free replay ledger and database-enforced concurrency guards for
-- externally-triggered user/profile/balance/integral writes.
CREATE TABLE IF NOT EXISTS "out_user_write_replay" (
  "id" BIGSERIAL PRIMARY KEY,
  "out_account_id" INTEGER NOT NULL,
  "operation" VARCHAR(32) NOT NULL,
  "request_key" VARCHAR(36) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "user_id" INTEGER DEFAULT 0 NOT NULL,
  "money_ledger_id" INTEGER DEFAULT 0 NOT NULL,
  "integral_ledger_id" INTEGER DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "ouwr_operation_ck" CHECK (
    "operation" IN ('user_create', 'user_update', 'user_give')
  ),
  CONSTRAINT "ouwr_identity_ck" CHECK (
    "out_account_id" > 0 AND "user_id" > 0
      AND "money_ledger_id" >= 0 AND "integral_ledger_id" >= 0
      AND "add_time" >= 0
  ),
  CONSTRAINT "ouwr_request_hash_ck" CHECK ("request_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "ouwr_account_operation_key_uq"
  ON "out_user_write_replay" ("out_account_id", "operation", "request_key");
CREATE INDEX IF NOT EXISTS "ouwr_user_history"
  ON "out_user_write_replay" ("user_id", "id");

-- Legacy imports may contain empty or deleted duplicates; only live, usable
-- phone numbers participate in the uniqueness contract.
CREATE UNIQUE INDEX IF NOT EXISTS "user_active_phone_uq"
  ON "user" ("phone")
  WHERE "is_del" = 0 AND "delete_time" IS NULL AND "phone" <> '';

-- A replay row is the primary idempotency record. These partial unique indexes
-- independently prevent duplicate immutable financial evidence if application
-- locking is accidentally weakened in a future refactor.
CREATE UNIQUE INDEX IF NOT EXISTS "um_out_request_uq"
  ON "user_money" ("uid", "link_id", "type")
  WHERE "type" IN ('system_add', 'system_sub')
    AND "link_id" ~ '^[0-9a-f]{32}$';
CREATE UNIQUE INDEX IF NOT EXISTS "ub_out_request_uq"
  ON "user_bill" ("uid", "link_id", "event_key")
  WHERE "event_key" IN ('out_system_add_integral', 'out_system_sub_integral')
    AND "link_id" ~ '^[0-9a-f]{32}$';`;
  }

  private migration_0107(): string {
    return `-- Durable order attribution and idempotency evidence for coupons granted after payment.
-- PHP cached this response for two hours; PostgreSQL evidence survives retries and restarts.
CREATE TABLE IF NOT EXISTS "store_order_product_coupon_reward" (
  "id" SERIAL PRIMARY KEY,
  "order_id" INTEGER NOT NULL,
  "uid" INTEGER NOT NULL,
  "product_id" INTEGER NOT NULL,
  "issue_coupon_id" INTEGER NOT NULL,
  "coupon_user_id" INTEGER NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "sopcr_positive_ids_ck" CHECK (
    "order_id" > 0 AND "uid" > 0 AND "product_id" > 0
      AND "issue_coupon_id" > 0 AND "coupon_user_id" > 0 AND "add_time" >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "sopcr_order_issue_uq"
  ON "store_order_product_coupon_reward" ("order_id", "issue_coupon_id");
CREATE UNIQUE INDEX IF NOT EXISTS "sopcr_coupon_user_uq"
  ON "store_order_product_coupon_reward" ("coupon_user_id");
CREATE INDEX IF NOT EXISTS "sopcr_uid_order"
  ON "store_order_product_coupon_reward" ("uid", "order_id", "id");`;
  }

  private migration_0108(): string {
    return `-- API-006 legacy activity compatibility queries.
CREATE INDEX IF NOT EXISTS "sbu_uid_bargain_active"
  ON "store_bargain_user" ("uid", "bargain_id", "status", "id")
  WHERE "is_del" = 0;

CREATE INDEX IF NOT EXISTS "so_activity_type_visible"
  ON "store_order" ("activity_id", "type")
  WHERE "type" IN (1, 2, 3) AND "is_del" = 0 AND "is_system_del" = 0;`;
  }
}
