import { and, asc, desc, eq, inArray, like } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { cityArea, systemDise } from "@/models/schema";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { parseConfigInteger } from "@/utils/config";
import { ValidateException } from "@/utils/errors";

const MAX_DIY_BYTES = 2_000_000;
const MAX_ADDRESS_SEGMENTS = 8;
const UTF8_ENCODER = new TextEncoder();

export const LEGACY_PRODUCT_DETAIL_DEFAULT = {
  navList: [0, 1, 2, 3, 4],
  openShare: 1,
  pictureConfig: 0,
  swiperDot: 1,
  showPrice: [0, 1],
  isOpen: [0, 1, 2],
  showSvip: 1,
  showRank: 1,
  showService: [0, 1, 2, 3],
  showReply: 1,
  replyNum: 3,
  showMatch: 1,
  matchNum: 3,
  showRecommend: 1,
  recommendNum: 12,
  menuList: [0, 1, 2],
  showCart: 1,
  showCommunity: 1,
  communityNum: 3,
} as const;

export const LEGACY_PRODUCT_CATEGORY_DEFAULT = {
  level: 2,
  index: 1,
} as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** PHP json_decode(..., true), bounded so a corrupt DIY row cannot exhaust a Worker isolate. */
export function parseLegacyDiyJson(value: string | null | undefined): unknown {
  if (
    value === null
    || value === undefined
    || value.length > MAX_DIY_BYTES
    || UTF8_ENCODER.encode(value).byteLength > MAX_DIY_BYTES
  ) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function cloneProductDetailDefault(): Record<string, unknown> {
  return Object.fromEntries(Object.entries(LEGACY_PRODUCT_DETAIL_DEFAULT).map(([key, value]) => [
    key,
    Array.isArray(value) ? [...value] : value,
  ]));
}

/** Mirrors array_merge($default, array_intersect_key($saved, $default)). */
export function mergeLegacyProductDetail(value: string | null | undefined): Record<string, unknown> {
  const defaults = cloneProductDetailDefault();
  const saved = record(parseLegacyDiyJson(value));
  if (!saved) return defaults;
  for (const key of Object.keys(defaults)) {
    if (Object.hasOwn(saved, key)) defaults[key] = saved[key];
  }
  return defaults;
}

/** Mirrors array_merge($default, $saved); category DIY historically retains extension keys. */
export function mergeLegacyProductCategory(value: string | null | undefined): Record<string, unknown> {
  return {
    ...LEGACY_PRODUCT_CATEGORY_DEFAULT,
    ...(record(parseLegacyDiyJson(value)) ?? {}),
  };
}

export function normalizeLegacyAddress(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const address = value.trim().replace(/^\/+|\/+$/g, "");
  if (!address || address.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(address)) return [];
  const segments = address.split("/").map((item) => item.trim()).filter(Boolean);
  if (segments.length > MAX_ADDRESS_SEGMENTS || segments.some((item) => item.length > 100)) return [];
  // PHP removes one repeated municipality segment: 北京市/北京市/朝阳区.
  if (segments[0] && segments[0] === segments[1]) segments.shift();
  return segments;
}

function diyTemplateName(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > 255 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ValidateException("页面模板参数错误");
  }
  return value;
}

function phpConfigBool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return value !== "0";
}

export class V2PublicCompatibilityService {
  private readonly config: SystemConfigService;

  constructor(
    private readonly container: Container,
    env: Env,
  ) {
    this.config = new SystemConfigService(container, env);
  }

  async diy(nameValue: unknown): Promise<unknown> {
    const name = diyTemplateName(nameValue);
    const rows = await this.container.db
      .select({ value: systemDise.value })
      .from(systemDise)
      .where(name
        ? eq(systemDise.templateName, name)
        : and(eq(systemDise.status, 1), eq(systemDise.type, 1)))
      .orderBy(asc(systemDise.id))
      .limit(1);
    if (!rows[0]) return [];
    return parseLegacyDiyJson(rows[0].value);
  }

  async bindPhoneStatus(): Promise<{ status: boolean }> {
    return { status: phpConfigBool(await this.config.get("store_user_mobile")) };
  }

  async storeStatus(): Promise<{ store_status: number }> {
    const configs = await this.config.getMany(["store_func_status", "store_self_mention"]);
    return {
      store_status: phpConfigBool(configs.store_func_status, true)
        ? parseConfigInteger(configs.store_self_mention, 0)
        : 0,
    };
  }

  async colorChange(nameValue: unknown): Promise<{
    status: number;
    navigation: number;
    product_category_level: number;
  }> {
    const name = diyTemplateName(nameValue);
    if (!name) throw new ValidateException("页面模板参数错误");
    const [rows, configs] = await Promise.all([
      this.container.db
        .select({ value: systemDise.value })
        .from(systemDise)
        .where(and(eq(systemDise.templateName, name), eq(systemDise.type, 3)))
        .orderBy(asc(systemDise.id))
        .limit(1),
      this.config.getMany(["navigation_open", "product_category_level"]),
    ]);
    return {
      status: parseConfigInteger(rows[0]?.value ?? "", 0),
      navigation: parseConfigInteger(configs.navigation_open, 0),
      product_category_level: parseConfigInteger(configs.product_category_level, 0),
    };
  }

  async productDetail(): Promise<{
    product_detail: Record<string, unknown>;
    product_video_status: boolean;
    product_category: Record<string, unknown>;
  }> {
    const [rows, productVideoStatus] = await Promise.all([
      this.container.db
        .select({ templateName: systemDise.templateName, value: systemDise.value })
        .from(systemDise)
        .where(and(
          inArray(systemDise.templateName, ["product_detail", "category"]),
          eq(systemDise.type, 3),
        ))
        .orderBy(asc(systemDise.id)),
      this.config.get("product_video_status"),
    ]);
    const firstValue = (templateName: string) => rows.find((row) => row.templateName === templateName)?.value;
    return {
      product_detail: mergeLegacyProductDetail(firstValue("product_detail")),
      product_video_status: phpConfigBool(productVideoStatus),
      product_category: mergeLegacyProductCategory(firstValue("category")),
    };
  }

  /** Reproduces CityAreaDao::searchCity and its ancestor rows plus one-level children. */
  async cityList(addressValue: unknown): Promise<Record<string, unknown>[] | null> {
    const segments = normalizeLegacyAddress(addressValue);
    if (!segments.length) throw new ValidateException("地址不存在");

    const first = await this.container.db
      .select({ id: cityArea.id, path: cityArea.path })
      .from(cityArea)
      .where(eq(cityArea.name, segments[0]))
      .orderBy(desc(cityArea.id))
      .limit(1);
    if (!first[0]) return null;

    let selected = first[0];
    const pathIds = [selected.id];
    for (const segment of segments.slice(1)) {
      const rows = await this.container.db
        .select({ id: cityArea.id, path: cityArea.path })
        .from(cityArea)
        .where(and(
          like(cityArea.path, `/${pathIds.join("/")}/%`),
          eq(cityArea.name, segment),
        ))
        .orderBy(desc(cityArea.id))
        .limit(1);
      if (!rows[0]) break;
      selected = rows[0];
      pathIds.push(selected.id);
    }

    const ancestorIds = [...new Set([
      selected.id,
      ...selected.path.split("/").map(Number).filter((id) => Number.isSafeInteger(id) && id > 0),
    ])];
    const [parents, children] = await Promise.all([
      this.container.db
        .select({ id: cityArea.id, name: cityArea.name, parentId: cityArea.parentId })
        .from(cityArea)
        .where(inArray(cityArea.id, ancestorIds))
        .orderBy(asc(cityArea.id)),
      this.container.db
        .select()
        .from(cityArea)
        .where(inArray(cityArea.parentId, ancestorIds))
        .orderBy(asc(cityArea.id)),
    ]);
    return parents.map((parent) => ({
      value: parent.id,
      id: parent.id,
      label: parent.name,
      pid: parent.parentId,
      children: children
        .filter((child) => child.parentId === parent.id)
        .map((child) => ({
          id: child.id,
          path: child.path,
          parent_id: child.parentId,
          type: child.type,
          name: child.name,
          level: child.level,
          code: child.code,
          snum: child.snum,
          create_time: child.createTime,
        })),
    }));
  }
}
