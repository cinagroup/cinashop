/**
 * 迁移执行 Service (一次性, 部署后调用一次)
 *
 * 读取 migrations/*.sql, 逐个执行。
 * 通过内部 endpoint GET /api/_migrate 触发。
 * 生产环境用完即删或加 IP 白名单保护。
 */
import type { Container } from "@/lib/di";
import { sql } from "drizzle-orm";

export class MigrationService {
  constructor(private readonly container: Container) {}

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
    ];

    for (let i = 0; i < migrations.length; i++) {
      try {
        await this.container.db.execute(sql.raw(migrations[i]));
        executed.push(`000${i}`);
      } catch (e) {
        // 表已存在等错误忽略, 记录
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("already exists")) {
          executed.push(`000${i} (skipped)`);
        } else {
          errors.push(`000${i}: ${msg}`);
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
INSERT INTO "system_config" ("menu_name", "value", "info") VALUES
  ('record_No', '京ICP备12345678号', '网站备案号'),
  ('site_url', 'https://cinashop.example.com', '站点URL'),
  ('sign_give_point', '1', '签到基础积分'),
  ('sign_status', '1', '签到开关'),
  ('system_delivery_time', '7', '自动收货天数'),
  ('system_comment_time', '7', '自动评价天数')
ON CONFLICT DO NOTHING;
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
-- 默认管理员 admin / crmeb.com (bcrypt)
-- account 无唯一约束 → upsert 保持 id 稳定 (避免每次迁移后 admin 会话失效)
UPDATE "system_admin" SET pwd = '$2b$10$QZbQLAnjcmYKOzLI0fQP/.uqTIAiEuLUZWXvSY5XkX0jTsz37IbAW',
  real_name = '超级管理员', level = 0, status = 1 WHERE account = 'admin';
INSERT INTO "system_admin" ("account", "pwd", "real_name", "level", "status", "add_time")
SELECT 'admin', '$2b$10$QZbQLAnjcmYKOzLI0fQP/.uqTIAiEuLUZWXvSY5XkX0jTsz37IbAW', '超级管理员', 0, 1, EXTRACT(EPOCH FROM NOW())::int
WHERE NOT EXISTS (SELECT 1 FROM "system_admin" WHERE account = 'admin');
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
  "refund_phone" VARCHAR(20) DEFAULT '' NOT NULL,
  "refund_express" VARCHAR(50) DEFAULT '' NOT NULL,
  "refund_express_name" VARCHAR(50) DEFAULT '' NOT NULL,
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
  "type" SMALLINT DEFAULT 1 NOT NULL, "receive_time" INTEGER DEFAULT 0 NOT NULL
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
  "start_time" VARCHAR(8) DEFAULT '' NOT NULL,
  "end_time" VARCHAR(8) DEFAULT '' NOT NULL,
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
  "title" VARCHAR(255) DEFAULT '' NOT NULL,
  "content" TEXT,
  "user_id" INTEGER DEFAULT 0 NOT NULL,
  "type" SMALLINT DEFAULT 0 NOT NULL,
  "status" SMALLINT DEFAULT 1 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
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
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
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
  "reply_id" INTEGER DEFAULT 0 NOT NULL,
  "uid" INTEGER DEFAULT 0 NOT NULL,
  "nickname" VARCHAR(128) DEFAULT '' NOT NULL,
  "avatar" VARCHAR(256) DEFAULT '' NOT NULL,
  "content" VARCHAR(500) DEFAULT '' NOT NULL,
  "praise" INTEGER DEFAULT 0 NOT NULL,
  "is_del" SMALLINT DEFAULT 0 NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
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
  "name" VARCHAR(64) DEFAULT '' NOT NULL,
  "type" SMALLINT DEFAULT 1 NOT NULL,
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
  "name" VARCHAR(64) DEFAULT '' NOT NULL,
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
  "admin_id" INTEGER DEFAULT 0 NOT NULL,
  "admin_name" VARCHAR(64) DEFAULT '' NOT NULL,
  "action" VARCHAR(255) DEFAULT '' NOT NULL,
  "ip" VARCHAR(45) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL
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
}
