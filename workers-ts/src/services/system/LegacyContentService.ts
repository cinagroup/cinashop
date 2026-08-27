import { and, asc, desc, eq } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { systemGroup, systemGroupData } from "@/models/schema";
import { ValidateException } from "@/utils/errors";
import { DatabaseCacheService } from "./DatabaseCacheService";

export const KF_ADV_CACHE_KEY = "kf_adv";
export const OPEN_ADV_CACHE_KEY = "open_adv";
export const UNI_APP_URL_CACHE_KEY = "uni_app_url";
export const PRODUCT_DRAFT_TTL_SECONDS = 68_400;
export const AGREEMENT_CACHE_KEYS = ["privacy", "user", "cancel", "supplier", "agent"] as const;
export type AgreementCacheKey = typeof AGREEMENT_CACHE_KEYS[number] | "newcomer_agreement";

const MAX_KF_CONTENT_LENGTH = 200_000;
const MAX_URL_LENGTH = 2_048;
const MAX_DRAFT_STRING_LENGTH = 200_000;

export interface OpenAdvItem {
  id: number;
  gid: number;
  img: string;
  link: string;
  sort: number;
  status: number;
  comment: string;
  add_time: string | number;
}

export interface OpenAdvConfig {
  status: number;
  time: number;
  interval_time: number;
  type: "pic" | "video";
  value: OpenAdvItem[];
  video_link: string;
}

export interface LegacyRuntimeContent {
  kf_adv: string;
  open_adv: OpenAdvConfig;
  uni_app_url: Array<Record<string, unknown>>;
  agreements: Record<typeof AGREEMENT_CACHE_KEYS[number], string>;
}

export const PRODUCT_DRAFT_FIELDS = [
  "product_type", "supplier_id", "cate_id", "store_name", "store_info", "keyword",
  "unit_name", "image", "recommend_image", "slider_image", "price", "ot_price", "stock",
  "is_sub", "sort", "sales", "ficti", "give_integral", "is_show", "is_hot", "is_benefit",
  "is_best", "is_new", "is_vip", "vip_price", "mer_use", "is_postage", "is_good",
  "description", "spec_type", "video_open", "video_link", "items", "attrs", "activity",
  "coupon_ids", "label_id", "command_word", "tao_words", "type", "delivery_type", "freight",
  "postage", "temp_id", "recommend_list", "brand_id", "soure_link", "bar_code", "code",
  "is_support_refund", "is_presale_product", "presale_time", "presale_day", "is_vip_product",
  "auto_on_time", "auto_off_time", "custom_form", "custom_form_info", "system_form_id",
  "store_label_id", "ensure_id", "specs", "specs_id", "coupons",
] as const;

const productDraftFieldSet = new Set<string>(PRODUCT_DRAFT_FIELDS);
const agreementKeySet = new Set<string>([...AGREEMENT_CACHE_KEYS, "newcomer_agreement"]);

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numberValue(value: unknown, fallback: number, min: number, max: number, strict: boolean, label: string) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    if (strict) throw new ValidateException(`${label}参数错误`);
    return fallback;
  }
  return parsed;
}

function flag(value: unknown): number {
  return value === true || value === 1 || value === "1" ? 1 : 0;
}

function safeUrl(value: unknown, strict: boolean, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  const safe = text.length <= MAX_URL_LENGTH
    && (/^https:\/\//i.test(text) || text.startsWith("/") || text.startsWith("pages/"));
  if (!safe) {
    if (strict) throw new ValidateException(`${label}只支持 HTTPS 或站内路径`);
    return "";
  }
  return text;
}

function limitedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function normalizeKfAdv(value: unknown, strict = false): string {
  if (typeof value !== "string") {
    if (strict) throw new ValidateException("客服广告内容格式错误");
    return "";
  }
  if (value.length > MAX_KF_CONTENT_LENGTH) {
    if (strict) throw new ValidateException("客服广告内容不能超过200000字符");
    return value.slice(0, MAX_KF_CONTENT_LENGTH);
  }
  return value;
}

export function normalizeOpenAdv(value: unknown, strict = false): OpenAdvConfig {
  const record = objectValue(value) ?? {};
  const type = record.type === "video" ? "video" : "pic";
  const items = Array.isArray(record.value) ? record.value.slice(0, 5) : [];
  const normalizedItems = items.flatMap((item, index): OpenAdvItem[] => {
    const current = objectValue(item);
    if (!current) {
      if (strict) throw new ValidateException(`第${index + 1}条开屏广告格式错误`);
      return [];
    }
    return [{
      id: Math.max(0, Math.trunc(numberValue(current.id, 0, 0, 2_147_483_647, false, "广告ID"))),
      gid: Math.max(0, Math.trunc(numberValue(current.gid, 0, 0, 2_147_483_647, false, "广告分组"))),
      img: safeUrl(current.img, strict, `第${index + 1}条广告图片`),
      link: safeUrl(current.link, strict, `第${index + 1}条广告链接`),
      sort: Math.trunc(numberValue(current.sort, 0, -1_000_000, 1_000_000, false, "广告排序")),
      status: flag(current.status ?? 1),
      comment: limitedString(current.comment, 500),
      add_time: typeof current.add_time === "number"
        ? current.add_time
        : limitedString(current.add_time, 64),
    }];
  });
  const result: OpenAdvConfig = {
    status: flag(record.status),
    time: numberValue(record.time, 3, 1, 60, strict, "展示时长"),
    interval_time: numberValue(record.interval_time, 24, 0, 720, strict, "展示间隔"),
    type,
    value: normalizedItems,
    video_link: safeUrl(record.video_link, strict, "视频地址"),
  };
  if (strict && result.status === 1) {
    if (result.type === "pic" && !result.value.some((item) => item.status === 1 && item.img)) {
      throw new ValidateException("启用图片开屏广告前请配置至少一张有效图片");
    }
    if (result.type === "video" && !result.video_link) {
      throw new ValidateException("启用视频开屏广告前请配置视频地址");
    }
  }
  return result;
}

function legacyField(value: unknown): unknown {
  const record = objectValue(value);
  return record && "value" in record ? record.value : value;
}

function parseLinkRow(id: number, value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = objectValue(JSON.parse(value));
    if (!parsed) return null;
    const flattened: Record<string, unknown> = { id };
    for (const [key, field] of Object.entries(parsed).slice(0, 64)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) continue;
      flattened[key] = legacyField(field);
    }
    const link = safeUrl(flattened.link ?? flattened.url, false, "页面路径");
    flattened.url = link;
    flattened.parameter = limitedString(flattened.param ?? flattened.parameter, 2_048).trim();
    return flattened;
  } catch {
    return null;
  }
}

function normalizeCachedLinks(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 2_000).flatMap((item, index) => {
    const record = objectValue(item);
    if (!record) return [];
    const link = safeUrl(record.link ?? record.url, false, "页面路径");
    return [{
      ...record,
      id: Number.isSafeInteger(record.id) ? record.id : index + 1,
      url: link,
      parameter: limitedString(record.param ?? record.parameter, 2_048).trim(),
    }];
  });
}

function sanitizeJson(value: unknown, depth = 0): unknown {
  if (depth > 8) throw new ValidateException("商品草稿嵌套层级过深");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValidateException("商品草稿包含非法数值");
    return value;
  }
  if (typeof value === "string") return value.slice(0, MAX_DRAFT_STRING_LENGTH);
  if (Array.isArray(value)) return value.slice(0, 2_000).map((item) => sanitizeJson(item, depth + 1));
  const record = objectValue(value);
  if (!record) return null;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record).slice(0, 256)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    result[key] = sanitizeJson(item, depth + 1);
  }
  return result;
}

export function normalizeProductDraft(value: unknown): Record<string, unknown> {
  const record = objectValue(value);
  if (!record) throw new ValidateException("商品草稿格式错误");
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (!productDraftFieldSet.has(key)) continue;
    result[key] = sanitizeJson(item);
  }
  return result;
}

function productDraftKey(adminId: number): string {
  if (!Number.isSafeInteger(adminId) || adminId <= 0) throw new ValidateException("管理员参数错误");
  const key = `${adminId}_product_data`;
  if (key.length > 32) throw new ValidateException("管理员商品草稿键过长");
  return key;
}

export function normalizeAgreementKey(value: unknown): AgreementCacheKey {
  const key = value === "1" || value === 1
    ? "user"
    : value === "2" || value === 2
      ? "privacy"
      : String(value ?? "").trim();
  if (!agreementKeySet.has(key)) throw new ValidateException("协议类型不支持");
  return key as AgreementCacheKey;
}

export class LegacyContentService {
  private readonly cache: DatabaseCacheService;

  constructor(private readonly container: Container) {
    this.cache = new DatabaseCacheService(container);
  }

  async kfAdv(): Promise<string> {
    return normalizeKfAdv(await this.cache.get<unknown>(KF_ADV_CACHE_KEY, ""));
  }

  async openAdv(): Promise<OpenAdvConfig> {
    return normalizeOpenAdv(await this.cache.get<unknown>(OPEN_ADV_CACHE_KEY, null));
  }

  async uniAppUrls(): Promise<Array<Record<string, unknown>>> {
    const rows = await this.container.db
      .select({ id: systemGroupData.id, value: systemGroupData.value })
      .from(systemGroupData)
      .innerJoin(systemGroup, eq(systemGroupData.gid, systemGroup.id))
      .where(and(eq(systemGroup.configName, "uni_app_link"), eq(systemGroupData.status, 1)))
      .orderBy(desc(systemGroupData.sort), asc(systemGroupData.id));
    const current = rows
      .map((row) => parseLinkRow(row.id, row.value))
      .filter((row): row is Record<string, unknown> => row !== null);
    if (current.length) return current;
    return normalizeCachedLinks(await this.cache.get<unknown>(UNI_APP_URL_CACHE_KEY, null));
  }

  async agreement(type: unknown): Promise<string> {
    return normalizeKfAdv(await this.cache.get<unknown>(normalizeAgreementKey(type), ""));
  }

  async agreements(): Promise<Record<typeof AGREEMENT_CACHE_KEYS[number], string>> {
    const values = await Promise.all(AGREEMENT_CACHE_KEYS.map((key) => this.agreement(key)));
    return Object.fromEntries(
      AGREEMENT_CACHE_KEYS.map((key, index) => [key, values[index]]),
    ) as Record<typeof AGREEMENT_CACHE_KEYS[number], string>;
  }

  async runtimeContent(): Promise<LegacyRuntimeContent> {
    const [kfAdv, openAdv, uniAppUrl, agreements] = await Promise.all([
      this.kfAdv(),
      this.openAdv(),
      this.uniAppUrls(),
      this.agreements(),
    ]);
    return { kf_adv: kfAdv, open_adv: openAdv, uni_app_url: uniAppUrl, agreements };
  }

  async saveKfAdv(value: unknown): Promise<string> {
    const content = normalizeKfAdv(value, true);
    await this.cache.set(KF_ADV_CACHE_KEY, content);
    return content;
  }

  async saveOpenAdv(value: unknown): Promise<OpenAdvConfig> {
    const config = normalizeOpenAdv(value, true);
    await this.cache.set(OPEN_ADV_CACHE_KEY, config);
    return config;
  }

  async saveAgreement(type: unknown, value: unknown): Promise<string> {
    const key = normalizeAgreementKey(type);
    const content = normalizeKfAdv(value, true);
    await this.cache.set(key, content);
    return content;
  }

  async saveRuntimeContent(value: Record<string, unknown>): Promise<LegacyRuntimeContent> {
    const content = normalizeKfAdv(value.kf_adv, true);
    const openAdv = normalizeOpenAdv(value.open_adv, true);
    const agreementInput = objectValue(value.agreements);
    if (!agreementInput) throw new ValidateException("协议内容格式错误");
    const agreements = Object.fromEntries(AGREEMENT_CACHE_KEYS.map((key) => [
      key,
      normalizeKfAdv(agreementInput[key], true),
    ])) as Record<typeof AGREEMENT_CACHE_KEYS[number], string>;
    await this.cache.setMany([
      { key: KF_ADV_CACHE_KEY, value: content },
      { key: OPEN_ADV_CACHE_KEY, value: openAdv },
      ...AGREEMENT_CACHE_KEYS.map((key) => ({ key, value: agreements[key] })),
    ]);
    return this.runtimeContent();
  }

  async productDraft(adminId: number): Promise<Record<string, unknown> | []> {
    const value = await this.cache.get<unknown>(productDraftKey(adminId), []);
    return objectValue(value) ?? [];
  }

  async saveProductDraft(adminId: number, value: unknown): Promise<Record<string, unknown>> {
    const draft = normalizeProductDraft(value);
    await this.cache.set(productDraftKey(adminId), draft, PRODUCT_DRAFT_TTL_SECONDS);
    return draft;
  }

  async deleteProductDraft(adminId: number): Promise<void> {
    await this.cache.remove(productDraftKey(adminId));
  }
}
