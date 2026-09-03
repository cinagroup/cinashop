import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "@/env";
import { withTx, type Container, type DbClient } from "@/lib/di";
import { systemConfig, systemLog } from "@/models/schema";
import {
  getPaymentReadiness,
  type PaymentReadiness,
} from "@/services/payment/PaymentReadinessService";
import { normalizeConfigScalar } from "@/utils/config";
import { ValidateException } from "@/utils/errors";
import { ADMIN_LOGIN_POLICY } from "@/middleware/admin-login-security";
import { signAttachmentReferences } from "@/services/system/AttachmentService";

export const BASIC_COMMERCE_CONFIG_KEYS = [
  "station_open",
  "site_name",
  "site_url",
  "site_phone",
  "site_logo",
  "site_logo_square",
  "login_logo",
  "wap_login_logo",
  "admin_login_slide",
  "ico_path",
  "wechat_share_img",
  "wechat_share_title",
  "wechat_share_synopsis",
  "navigation_open",
  "video_func_status",
  "product_video_status",
  "product_poster_title",
  "record_No",
] as const;

export const PRODUCT_COMMERCE_CONFIG_KEYS = ["store_stock"] as const;

export const TRADE_COMMERCE_CONFIG_KEYS = [
  "order_cancel_time",
  "order_activity_time",
  "order_bargain_time",
  "order_seckill_time",
  "order_pink_time",
  "rebate_points_orders_time",
  "reminder_deadline_second_card_time",
  "system_delivery_time",
  "system_comment_time",
  "refund_name",
  "refund_phone",
  "refund_address",
  "stor_reason",
  "refund_time_available",
] as const;

export const PAYMENT_COMMERCE_CONFIG_KEYS = [
  "balance_func_status",
  "yue_pay_status",
  "offline_pay_status",
  "pay_weixin_open",
  "ali_pay_status",
] as const;

export const DIVISION_COMMERCE_CONFIG_KEYS = [
  "division_open",
  "division_apply_open",
] as const;

export const COMMERCE_CONFIG_KEYS = [
  ...BASIC_COMMERCE_CONFIG_KEYS,
  ...PRODUCT_COMMERCE_CONFIG_KEYS,
  ...TRADE_COMMERCE_CONFIG_KEYS,
  ...PAYMENT_COMMERCE_CONFIG_KEYS,
  ...DIVISION_COMMERCE_CONFIG_KEYS,
] as const;

type CommerceConfigKey = (typeof COMMERCE_CONFIG_KEYS)[number];
type CommerceConfigValues = Record<CommerceConfigKey, string | number>;

export interface CommerceSettingsActor {
  adminId: number;
  adminName: string;
  ip: string;
}

export interface CommerceSettingsSnapshot {
  basic: Omit<Pick<CommerceConfigValues, (typeof BASIC_COMMERCE_CONFIG_KEYS)[number]>, "admin_login_slide"> & {
    admin_login_slide: string[];
  };
  product: Pick<CommerceConfigValues, (typeof PRODUCT_COMMERCE_CONFIG_KEYS)[number]>;
  trade: Pick<CommerceConfigValues, (typeof TRADE_COMMERCE_CONFIG_KEYS)[number]>;
  payment: Pick<CommerceConfigValues, (typeof PAYMENT_COMMERCE_CONFIG_KEYS)[number]>;
  division: Pick<CommerceConfigValues, (typeof DIVISION_COMMERCE_CONFIG_KEYS)[number]>;
  payment_readiness: PaymentReadiness;
  missing_config_keys: CommerceConfigKey[];
  asset_previews: Record<string, string>;
  security_policy: {
    admin_login_source_limit: string;
    admin_login_account_limit: string;
    new_admin_password: string;
    commerce_request_body_limit: string;
    request_validation: string;
    legacy_editable_filters: false;
  };
}

const DEFAULTS: CommerceConfigValues = {
  station_open: 1,
  site_name: "CRMEB_PRO",
  site_url: "",
  site_phone: "",
  site_logo: "",
  site_logo_square: "",
  login_logo: "",
  wap_login_logo: "",
  admin_login_slide: "[]",
  ico_path: "",
  wechat_share_img: "",
  wechat_share_title: "",
  wechat_share_synopsis: "",
  navigation_open: 1,
  video_func_status: 1,
  product_video_status: 1,
  product_poster_title: "品牌官方 · 交易保障 · 优质口碑 · 售后无忧",
  record_No: "",
  store_stock: 20,
  order_cancel_time: 1,
  order_activity_time: 1,
  order_bargain_time: 1,
  order_seckill_time: 1,
  order_pink_time: 1,
  rebate_points_orders_time: 1,
  reminder_deadline_second_card_time: 1,
  system_delivery_time: 1,
  system_comment_time: 0,
  refund_name: "",
  refund_phone: "",
  refund_address: "",
  stor_reason: "",
  refund_time_available: 0,
  balance_func_status: 1,
  yue_pay_status: 1,
  offline_pay_status: 1,
  pay_weixin_open: 1,
  ali_pay_status: 1,
  division_open: 1,
  division_apply_open: 1,
};

const INFO: Record<CommerceConfigKey, string> = {
  station_open: "站点开启",
  site_name: "网站名称",
  site_url: "网站地址",
  site_phone: "联系电话",
  site_logo: "后台大 LOGO",
  site_logo_square: "后台小 LOGO",
  login_logo: "后台登录页 LOGO",
  wap_login_logo: "移动端登录 LOGO",
  admin_login_slide: "后台登录轮播图",
  ico_path: "浏览器图标",
  wechat_share_img: "微信分享图片",
  wechat_share_title: "微信分享标题",
  wechat_share_synopsis: "微信分享简介",
  navigation_open: "悬浮菜单",
  video_func_status: "短视频启用",
  product_video_status: "商品列表视频",
  product_poster_title: "商品分享海报头部",
  record_No: "备案号",
  store_stock: "警戒库存",
  order_cancel_time: "普通商品未支付",
  order_activity_time: "活动商品未支付",
  order_bargain_time: "砍价商品未支付",
  order_seckill_time: "秒杀商品未支付",
  order_pink_time: "拼团商品未支付",
  rebate_points_orders_time: "积分商品未支付",
  reminder_deadline_second_card_time: "次卡临期提醒",
  system_delivery_time: "自动收货时间",
  system_comment_time: "自动默认好评时间",
  refund_name: "退货收货人姓名",
  refund_phone: "退货收货人电话",
  refund_address: "退货收货人地址",
  stor_reason: "退货理由",
  refund_time_available: "售后期限",
  balance_func_status: "余额功能启用",
  yue_pay_status: "余额支付状态",
  offline_pay_status: "线下支付状态",
  pay_weixin_open: "微信支付状态",
  ali_pay_status: "支付宝支付状态",
  division_open: "团队开关",
  division_apply_open: "代理商申请开关",
};

const INTEGER_KEYS = new Set<CommerceConfigKey>([
  "store_stock",
  "order_cancel_time",
  "order_activity_time",
  "order_bargain_time",
  "order_seckill_time",
  "order_pink_time",
  "rebate_points_orders_time",
  "reminder_deadline_second_card_time",
  "system_delivery_time",
  "system_comment_time",
  "refund_time_available",
]);

const FLAG_KEYS = new Set<CommerceConfigKey>([
  "station_open",
  "navigation_open",
  "video_func_status",
  "product_video_status",
  "balance_func_status",
  "pay_weixin_open",
  "ali_pay_status",
  "division_open",
  "division_apply_open",
]);

const LEGACY_ONE_TWO_FLAG_KEYS = new Set<CommerceConfigKey>([
  "yue_pay_status",
  "offline_pay_status",
]);

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException(`${label}格式错误`);
  }
  return value as Record<string, unknown>;
}

function flag(value: unknown, label: string): number {
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  throw new ValidateException(`${label}格式错误`);
}

function legacyOneTwoFlag(value: unknown, label: string): number {
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0" || value === 2 || value === "2") return 2;
  throw new ValidateException(`${label}格式错误`);
}

function integer(value: unknown, label: string, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new ValidateException(`${label}必须是0到${max}之间的整数`);
  }
  return parsed;
}

function textValue(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== "string") throw new ValidateException(`${label}格式错误`);
  const text = value.trim();
  if (required && !text) throw new ValidateException(`${label}不能为空`);
  if (text.length > max) throw new ValidateException(`${label}不能超过${max}个字符`);
  return text;
}

function assetUrl(value: unknown, label: string): string {
  const text = textValue(value, label, 2_048);
  if (!text) return "";
  if (/^\/(?!\/)/.test(text)) return text;
  try {
    const parsed = new URL(text);
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password) return text;
  } catch {
    // Normalized below.
  }
  throw new ValidateException(`${label}只支持 HTTPS 或 / 开头的站内地址`);
}

function assetList(value: unknown, label: string): string {
  if (!Array.isArray(value)) throw new ValidateException(`${label}格式错误`);
  if (value.length > 5) throw new ValidateException(`${label}最多5张`);
  const normalized = value.map((item) => assetUrl(item, label)).filter(Boolean);
  if (new Set(normalized).size !== normalized.length) {
    throw new ValidateException(`${label}不能包含重复图片`);
  }
  return JSON.stringify(normalized);
}

function decodeAssetList(value: string | number): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0 && item.length <= 2_048)
      .slice(0, 5);
  } catch {
    return [];
  }
}

function siteUrl(value: unknown, required: boolean): string {
  const text = textValue(value, "网站地址", 2_048, required);
  if (!text) return "";
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      throw new Error("unsafe site URL");
    }
    return text.replace(/\/+$/, "");
  } catch {
    throw new ValidateException("网站地址必须是无账号和片段的 HTTPS 地址");
  }
}

function phone(value: unknown): string {
  const text = textValue(value, "退货联系电话", 32);
  if (text && !/^[+\d()\s-]{5,32}$/.test(text)) {
    throw new ValidateException("退货联系电话格式错误");
  }
  return text;
}

function refundReasons(value: unknown): string {
  if (typeof value !== "string") throw new ValidateException("退货理由格式错误");
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length > 5_000) throw new ValidateException("退货理由不能超过5000个字符");
  const reasons = normalized ? normalized.split("\n") : [];
  if (reasons.length > 100 || reasons.some((reason) => reason.trim().length > 200)) {
    throw new ValidateException("退货理由最多100条且每条不超过200个字符");
  }
  return reasons.map((reason) => reason.trim()).filter(Boolean).join("\n");
}

export function normalizeCommerceSettings(input: Record<string, unknown>): CommerceConfigValues {
  const basic = recordValue(input.basic, "基础设置");
  const product = recordValue(input.product, "商品设置");
  const trade = recordValue(input.trade, "交易设置");
  const payment = recordValue(input.payment, "支付设置");
  const division = recordValue(input.division, "事业部设置");
  const stationOpen = flag(basic.station_open, INFO.station_open);
  const values: CommerceConfigValues = {
    station_open: stationOpen,
    site_name: textValue(basic.site_name, INFO.site_name, 100, stationOpen === 1),
    site_url: siteUrl(basic.site_url, stationOpen === 1),
    site_phone: textValue(basic.site_phone, INFO.site_phone, 32),
    site_logo: assetUrl(basic.site_logo, INFO.site_logo),
    site_logo_square: assetUrl(basic.site_logo_square, INFO.site_logo_square),
    login_logo: assetUrl(basic.login_logo, INFO.login_logo),
    wap_login_logo: assetUrl(basic.wap_login_logo, INFO.wap_login_logo),
    admin_login_slide: assetList(basic.admin_login_slide, INFO.admin_login_slide),
    ico_path: assetUrl(basic.ico_path, INFO.ico_path),
    wechat_share_img: assetUrl(basic.wechat_share_img, INFO.wechat_share_img),
    wechat_share_title: textValue(basic.wechat_share_title, INFO.wechat_share_title, 100),
    wechat_share_synopsis: textValue(
      basic.wechat_share_synopsis,
      INFO.wechat_share_synopsis,
      200,
    ),
    navigation_open: flag(basic.navigation_open, INFO.navigation_open),
    video_func_status: flag(basic.video_func_status, INFO.video_func_status),
    product_video_status: flag(basic.product_video_status, INFO.product_video_status),
    product_poster_title: textValue(basic.product_poster_title, INFO.product_poster_title, 25),
    record_No: textValue(basic.record_No, INFO.record_No, 100),
    store_stock: integer(product.store_stock, INFO.store_stock, 2_147_483_647),
    order_cancel_time: integer(trade.order_cancel_time, INFO.order_cancel_time, 8_760),
    order_activity_time: integer(trade.order_activity_time, INFO.order_activity_time, 8_760),
    order_bargain_time: integer(trade.order_bargain_time, INFO.order_bargain_time, 8_760),
    order_seckill_time: integer(trade.order_seckill_time, INFO.order_seckill_time, 8_760),
    order_pink_time: integer(trade.order_pink_time, INFO.order_pink_time, 8_760),
    rebate_points_orders_time: integer(trade.rebate_points_orders_time, INFO.rebate_points_orders_time, 8_760),
    reminder_deadline_second_card_time: integer(
      trade.reminder_deadline_second_card_time,
      INFO.reminder_deadline_second_card_time,
      8_760,
    ),
    system_delivery_time: integer(trade.system_delivery_time, INFO.system_delivery_time, 3_650),
    system_comment_time: integer(trade.system_comment_time, INFO.system_comment_time, 3_650),
    refund_name: textValue(trade.refund_name, INFO.refund_name, 100),
    refund_phone: phone(trade.refund_phone),
    refund_address: textValue(trade.refund_address, INFO.refund_address, 500),
    stor_reason: refundReasons(trade.stor_reason),
    refund_time_available: integer(trade.refund_time_available, INFO.refund_time_available, 3_650),
    balance_func_status: flag(payment.balance_func_status, INFO.balance_func_status),
    yue_pay_status: legacyOneTwoFlag(payment.yue_pay_status, INFO.yue_pay_status),
    offline_pay_status: legacyOneTwoFlag(payment.offline_pay_status, INFO.offline_pay_status),
    pay_weixin_open: flag(payment.pay_weixin_open, INFO.pay_weixin_open),
    ali_pay_status: flag(payment.ali_pay_status, INFO.ali_pay_status),
    division_open: flag(division.division_open, INFO.division_open),
    division_apply_open: flag(division.division_apply_open, INFO.division_apply_open),
  };
  if (values.division_open === 0 && values.division_apply_open === 1) {
    throw new ValidateException("开启代理商申请前必须先开启事业部团队功能");
  }
  return values;
}

function decodeValue(key: CommerceConfigKey, value: string | undefined): string | number {
  if (value === undefined) return DEFAULTS[key];
  const normalized = normalizeConfigScalar(value);
  if (FLAG_KEYS.has(key)) return normalized === "1" ? 1 : 0;
  if (LEGACY_ONE_TWO_FLAG_KEYS.has(key)) return normalized === "1" ? 1 : 2;
  if (INTEGER_KEYS.has(key)) {
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULTS[key];
  }
  return normalized;
}

function pickValues<K extends readonly CommerceConfigKey[]>(values: CommerceConfigValues, keys: K) {
  return Object.fromEntries(keys.map((key) => [key, values[key]])) as Pick<CommerceConfigValues, K[number]>;
}

async function configureWriteTx(tx: DbClient): Promise<void> {
  await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
  await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
}

function assertActor(actor: CommerceSettingsActor): void {
  if (!Number.isSafeInteger(actor.adminId) || actor.adminId <= 0) {
    throw new ValidateException("商城设置操作身份无效");
  }
}

async function writeAudit(tx: DbClient, actor: CommerceSettingsActor): Promise<void> {
  await tx.insert(systemLog).values({
    adminId: actor.adminId,
    adminName: actor.adminName.slice(0, 64),
    path: "/adminapi/config/commerce",
    page: "/config/commerce",
    method: "POST",
    action: `commerce_config.save;groups=basic,product,trade,payment,division;keys=${COMMERCE_CONFIG_KEYS.length}`,
    ip: actor.ip.slice(0, 45),
    type: "admin_config",
    addTime: Math.floor(Date.now() / 1_000),
  });
}

export class AdminCommerceSettingsService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  private async configSnapshot(db: DbClient = this.container.db) {
    const rows = await db
      .select({
        menuName: systemConfig.menuName,
        value: systemConfig.value,
        sort: systemConfig.sort,
        id: systemConfig.id,
      })
      .from(systemConfig)
      .where(and(
        eq(systemConfig.isStore, 0),
        inArray(systemConfig.menuName, [...COMMERCE_CONFIG_KEYS]),
      ))
      .orderBy(asc(systemConfig.sort), asc(systemConfig.id));
    const raw = new Map<string, string>();
    for (const row of rows) raw.set(row.menuName, row.value);
    const values = Object.fromEntries(
      COMMERCE_CONFIG_KEYS.map((key) => [key, decodeValue(key, raw.get(key))]),
    ) as CommerceConfigValues;
    return {
      values,
      missing: COMMERCE_CONFIG_KEYS.filter((key) => !raw.has(key)),
    };
  }

  async settings(): Promise<CommerceSettingsSnapshot> {
    const [{ values, missing }, paymentReadiness] = await Promise.all([
      this.configSnapshot(),
      getPaymentReadiness(this.container, this.env),
    ]);
    const slides = decodeAssetList(values.admin_login_slide);
    const basic = {
        ...pickValues(values, BASIC_COMMERCE_CONFIG_KEYS),
        admin_login_slide: slides,
      };
    const references = [
      values.site_logo,
      values.site_logo_square,
      values.login_logo,
      values.wap_login_logo,
      values.ico_path,
      values.wechat_share_img,
      ...slides,
    ].filter((item): item is string => typeof item === "string" && item.length > 0);
    const signed = await signAttachmentReferences(this.env.APP_KEY, references);
    return {
      basic,
      product: pickValues(values, PRODUCT_COMMERCE_CONFIG_KEYS),
      trade: pickValues(values, TRADE_COMMERCE_CONFIG_KEYS),
      payment: pickValues(values, PAYMENT_COMMERCE_CONFIG_KEYS),
      division: pickValues(values, DIVISION_COMMERCE_CONFIG_KEYS),
      payment_readiness: paymentReadiness,
      missing_config_keys: missing,
      asset_previews: Object.fromEntries(references.map((reference, index) => [reference, signed[index]])),
      security_policy: {
        admin_login_source_limit: `${ADMIN_LOGIN_POLICY.sourceAttempts}次/${ADMIN_LOGIN_POLICY.sourceWindowSeconds}秒`,
        admin_login_account_limit: `${ADMIN_LOGIN_POLICY.accountAttempts}次/${ADMIN_LOGIN_POLICY.accountWindowSeconds / 60}分钟`,
        new_admin_password: `至少${ADMIN_LOGIN_POLICY.newPasswordMinLength}位；bcrypt cost ${ADMIN_LOGIN_POLICY.bcryptCost}`,
        commerce_request_body_limit: "32 KiB",
        request_validation: "固定字段白名单、长度/类型校验、参数化数据库操作",
        legacy_editable_filters: false,
      },
    };
  }

  async save(actor: CommerceSettingsActor, input: Record<string, unknown>): Promise<CommerceSettingsSnapshot> {
    assertActor(actor);
    const normalized = normalizeCommerceSettings(input);
    await withTx(this.container, async (tx) => {
      await configureWriteTx(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('admin-commerce-settings'))`);
      const rows = await tx
        .select({
          id: systemConfig.id,
          menuName: systemConfig.menuName,
          value: systemConfig.value,
          sort: systemConfig.sort,
        })
        .from(systemConfig)
        .where(and(
          eq(systemConfig.isStore, 0),
          inArray(systemConfig.menuName, [...COMMERCE_CONFIG_KEYS]),
        ))
        .orderBy(asc(systemConfig.sort), asc(systemConfig.id))
        .for("update");
      const existing = new Map<string, number[]>();
      for (const row of rows) {
        existing.set(row.menuName, [...(existing.get(row.menuName) ?? []), row.id]);
      }
      const previousStoreStock = rows
        .filter((row) => row.menuName === "store_stock")
        .at(-1);
      const storeStockChanged = previousStoreStock
        ? Number(decodeValue("store_stock", previousStoreStock.value)) !== normalized.store_stock
        : true;
      for (const key of COMMERCE_CONFIG_KEYS) {
        const value = String(normalized[key]);
        const ids = existing.get(key) ?? [];
        if (ids.length) {
          await tx.update(systemConfig).set({ value }).where(inArray(systemConfig.id, ids));
        } else {
          const text = !INTEGER_KEYS.has(key) && !FLAG_KEYS.has(key) && !LEGACY_ONE_TWO_FLAG_KEYS.has(key);
          await tx.insert(systemConfig).values({
            isStore: 0,
            menuName: key,
            type: text ? "text" : "radio",
            inputType: text ? (key === "stor_reason" ? "textarea" : "input") : "number",
            configTabId: 0,
            parameter: FLAG_KEYS.has(key) ? "1=>开启\n0=>关闭" : LEGACY_ONE_TWO_FLAG_KEYS.has(key) ? "1=>开启\n2=>关闭" : "",
            uploadType: 1,
            required: "",
            width: 0,
            high: key === "stor_reason" ? 8 : 0,
            value,
            info: INFO[key],
            desc: INFO[key],
            sort: 0,
            status: 1,
          });
        }
      }
      if (storeStockChanged) {
        await tx.execute(sql`
          UPDATE store_product AS product
          SET
            is_police = CASE WHEN
              product.stock <= ${normalized.store_stock}
              OR EXISTS (
                SELECT 1
                FROM store_product_attr_value AS sku
                WHERE sku.product_id = product.id
                  AND sku.type = 0
                  AND sku.is_retired = 0
                  AND sku.stock <= ${normalized.store_stock}
              )
            THEN 1 ELSE 0 END,
            is_sold = CASE WHEN EXISTS (
              SELECT 1
              FROM store_product_attr_value AS sku
              WHERE sku.product_id = product.id
                AND sku.type = 0
                AND sku.is_retired = 0
                AND sku.stock = 0
            ) THEN 1 ELSE 0 END
          WHERE product.is_del = 0
        `);
      }
      const readback = await this.configSnapshot(tx);
      for (const key of COMMERCE_CONFIG_KEYS) {
        if (String(readback.values[key]) !== String(normalized[key])) {
          throw new Error(`商城设置回读不一致: ${key}`);
        }
      }
      await writeAudit(tx, actor);
    });
    await Promise.all(COMMERCE_CONFIG_KEYS.map((key) => this.env.CONFIG_KV.delete(`cfg_${key}`)));
    return this.settings();
  }
}
