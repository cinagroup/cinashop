import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import {
  storeBrand,
  storeCouponIssue,
  storeCouponProduct,
  storeDiscounts,
  storeDiscountsProducts,
  storeOrder,
  storeOrderCartInfo,
  storeProduct,
  storeProductCategory,
  storeProductDescription,
  storeProductLabel,
  storePromotions,
  storePromotionsAuxiliary,
  storeService,
  systemDise,
  systemGroup,
  systemGroupData,
  user,
  wechatUser,
} from "@/models/schema";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { getOrderInvalidTime } from "@/services/payment/OrderPaymentPolicy";
import { StoreProductService, type GoodsListParams } from "./StoreProductService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const MAX_LIMIT = 100;
const GROUP_KEYS = [
  "routine_home_banner",
  "routine_home_menus",
  "routine_home_roll_news",
  "routine_home_activity",
  "index_categy_images",
  "routine_index_page",
  "routine_home_bast_banner",
  "routine_home_new_banner",
  "routine_home_hot_banner",
  "routine_home_benefit_banner",
  "routine_my_menus",
  "routine_my_banner",
] as const;

export function normalizeCatalogPage(page: unknown, limit: unknown, defaultLimit = 10) {
  const parsedPage = Number(page);
  const parsedLimit = Number(limit);
  return {
    page: Number.isFinite(parsedPage) ? Math.max(1, Math.trunc(parsedPage)) : 1,
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(MAX_LIMIT, Math.trunc(parsedLimit))
      : defaultLimit,
  };
}

export function legacyHomeLimit(value: unknown): number {
  const match = String(value ?? "").trim().match(/^[+-]?\d+/);
  if (!match) return 0;
  const parsed = Number(match[0]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_LIMIT) : 0;
}

export function legacyPresalePayStatus(
  isPresale: unknown,
  startTime: unknown,
  endTime: unknown,
  now = Math.floor(Date.now() / 1_000),
): number {
  if (Number(isPresale) !== 1) return 0;
  const start = int(startTime);
  const end = int(endTime);
  if (start > now) return 1;
  if (start <= now && end >= now) return 2;
  if (end < now) return 3;
  return 0;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unwrapLegacyField(value: unknown): unknown {
  const record = plainObject(value);
  return record && Object.hasOwn(record, "value") ? record.value : value;
}

export function parseLegacyGroupValue(value: string | null): Record<string, unknown> | null {
  if (!value || value.length > 500_000) return null;
  try {
    const parsed = plainObject(JSON.parse(value));
    if (!parsed) return null;
    const result: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(parsed).slice(0, 128)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) continue;
      result[key] = unwrapLegacyField(field);
    }
    return result;
  } catch {
    return null;
  }
}

function csvIds(value: unknown): number[] {
  return [...new Set(String(value ?? "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isSafeInteger(item) && item > 0))];
}

function int(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value || value.length > 1_000_000) return {};
  try {
    return plainObject(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string | null): unknown[] {
  if (!value || value.length > 1_000_000) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.slice(0, 2_000) : [];
  } catch {
    return [];
  }
}

function productListRow(item: typeof storeProduct.$inferSelect): Record<string, unknown> {
  return {
    id: item.id,
    relation_id: item.relationId,
    type: item.type,
    pid: item.pid,
    product_type: item.productType,
    store_name: item.storeName,
    store_info: item.storeInfo,
    cate_id: item.cateId,
    image: item.image,
    sales: item.sales + item.ficti,
    price: item.price,
    stock: item.stock,
    activity: item.activity,
    ot_price: item.otPrice,
    spec_type: item.specType,
    recommend_image: item.recommendImage,
    unit_name: item.unitName,
    is_vip: item.isVip,
    vip_price: item.vipPrice,
    is_presale_product: item.isPresaleProduct,
    is_vip_product: item.isVipProduct,
    system_form_id: item.systemFormId,
    presale_start_time: item.presaleStartTime,
    presale_end_time: item.presaleEndTime,
    presale_day: item.presaleDay,
    video_open: item.videoOpen,
    video_link: item.videoOpen ? item.videoLink : "",
    freight: item.freight,
    star: item.star,
    store_label_id: item.storeLabelId,
    brand_id: item.brandId,
    cart_button: item.productType > 0 || item.isPresaleProduct > 0 || item.systemFormId > 0 ? 0 : 1,
  };
}

export class PublicCatalogService {
  private readonly products: StoreProductService;
  private readonly config: SystemConfigService;

  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {
    this.products = new StoreProductService(container, env);
    this.config = new SystemConfigService(container, env);
  }

  async groupDataMany(names: readonly string[]): Promise<Record<string, Record<string, unknown>[]>> {
    const unique = [...new Set(names)].filter(Boolean).slice(0, 100);
    const result = Object.fromEntries(unique.map((name) => [name, []])) as Record<string, Record<string, unknown>[]>;
    if (!unique.length) return result;
    const rows = await this.container.db
      .select({
        configName: systemGroup.configName,
        id: systemGroupData.id,
        gid: systemGroupData.gid,
        value: systemGroupData.value,
        addTime: systemGroupData.addTime,
        sort: systemGroupData.sort,
        status: systemGroupData.status,
      })
      .from(systemGroupData)
      .innerJoin(systemGroup, eq(systemGroupData.gid, systemGroup.id))
      .where(and(inArray(systemGroup.configName, unique), eq(systemGroupData.status, 1)))
      .orderBy(desc(systemGroupData.sort), asc(systemGroupData.id));
    for (const row of rows) {
      const parsed = parseLegacyGroupValue(row.value);
      if (!parsed) continue;
      result[row.configName]?.push({
        ...parsed,
        id: row.id,
        gid: row.gid,
        sort: row.sort,
        status: row.status,
        add_time: row.addTime,
      });
    }
    return result;
  }

  async navigation(templateName = ""): Promise<Record<string, unknown>> {
    const name = templateName.trim();
    if (name && !/^[A-Za-z0-9_-]{1,100}$/.test(name)) {
      throw new ValidateException("页面模板参数错误");
    }
    const selectValue = async (template: string) => {
      const rows = await this.container.db
        .select({ value: systemDise.value })
        .from(systemDise)
        .where(template
          ? and(eq(systemDise.templateName, template), eq(systemDise.isDel, 0))
          : and(eq(systemDise.status, 1), eq(systemDise.type, 1), eq(systemDise.isDel, 0)))
        .orderBy(desc(systemDise.id))
        .limit(1);
      return rows[0]?.value ?? "";
    };
    const value = await selectValue(name) || await selectValue("default");
    return (parseJsonArray(value).find((item) => {
      const record = plainObject(item);
      return String(record?.name ?? "").toLowerCase() === "pagefoot";
    }) as Record<string, unknown> | undefined) ?? {};
  }

  async home(uid: number): Promise<Record<string, unknown>> {
    const [groups, configs, categories, bastList, firstList, benefit, likeInfo, subscribeRows] = await Promise.all([
      this.groupDataMany(GROUP_KEYS),
      this.config.getMany([
        "site_name", "routine_index_logo", "site_url", "fast_number", "bast_number",
        "first_number", "promotion_number", "new_goods_bananr", "tengxun_map_key",
      ]),
      this.container.db.select({
        id: storeProductCategory.id,
        cate_name: storeProductCategory.cateName,
        pid: storeProductCategory.pid,
        pic: storeProductCategory.pic,
      }).from(storeProductCategory).where(and(
        eq(storeProductCategory.isShow, 1),
        gt(storeProductCategory.pid, 0),
      )).orderBy(desc(storeProductCategory.sort), desc(storeProductCategory.id)).limit(100),
      this.products.getRecommendProducts(uid, { isBest: true, productTypes: [0, 1, 2, 3], limit: 100 }),
      this.products.getRecommendProducts(uid, { isNew: true, productTypes: [0, 1, 2, 3], limit: 100 }),
      this.products.getRecommendProducts(uid, { isBenefit: true, productTypes: [0, 1, 2, 3], limit: 100 }),
      this.products.getRecommendProducts(uid, { isHot: true, productTypes: [0, 1, 2, 3], limit: 3 }),
      uid
        ? this.container.db.select({ subscribe: wechatUser.subscribe }).from(wechatUser).where(eq(wechatUser.uid, uid)).limit(1)
        : Promise.resolve([]),
    ]);
    const indexPage = groups.routine_index_page[0] ?? {};
    const fastNumber = Math.max(0, int(configs.fast_number));
    const bastNumber = Math.max(0, int(configs.bast_number));
    const firstNumber = Math.max(0, int(configs.first_number));
    const promotionNumber = Math.max(0, int(configs.promotion_number));
    let logoUrl = configs.routine_index_logo ?? "";
    if (logoUrl && !/^https?:\/\//i.test(logoUrl)) logoUrl = `${configs.site_url ?? ""}${logoUrl}`;
    return {
      banner: groups.routine_home_banner,
      menus: groups.routine_home_menus,
      roll: groups.routine_home_roll_news,
      info: {
        fastInfo: indexPage.fast_info ?? "",
        bastInfo: indexPage.bast_info ?? "",
        firstInfo: indexPage.first_info ?? "",
        salesInfo: indexPage.sales_info ?? "",
        fastList: fastNumber ? categories.slice(0, fastNumber) : [],
        bastList: bastNumber ? await this.decorateProducts(bastList.slice(0, bastNumber)) : [],
        firstList: firstNumber ? await this.decorateProducts(firstList.slice(0, firstNumber)) : [],
        bastBanner: groups.routine_home_bast_banner,
      },
      activity: groups.routine_home_activity.slice(0, 3),
      lovely: groups.routine_home_new_banner,
      benefit: promotionNumber ? await this.decorateProducts(benefit.slice(0, promotionNumber)) : [],
      likeInfo: await this.decorateProducts(likeInfo),
      logoUrl: logoUrl.replaceAll("\\", "/"),
      site_name: configs.site_name ?? "",
      subscribe: uid ? Boolean(subscribeRows[0]?.subscribe) : true,
      newGoodsBananr: configs.new_goods_bananr ?? "",
      tengxun_map_key: configs.tengxun_map_key ?? "",
      explosive_money: groups.index_categy_images,
    };
  }

  /** PHP v2 homepage: deliberately narrower than the v1 homepage payload. */
  async homeV2(uid: number): Promise<Record<string, unknown>> {
    const [configs, subscribe] = await Promise.all([
      this.config.getMany([
        "fast_number",
        "bast_number",
        "first_number",
        "promotion_number",
        "tengxun_map_key",
        "site_name",
      ]),
      this.subscribe(uid, { anonymousDefault: true, userType: "wechat" }),
    ]);
    const fastNumber = legacyHomeLimit(configs.fast_number);
    const bastNumber = legacyHomeLimit(configs.bast_number);
    const firstNumber = legacyHomeLimit(configs.first_number);
    const promotionNumber = legacyHomeLimit(configs.promotion_number);
    const [fastList, bastList, firstList, benefit, likeInfo] = await Promise.all([
      fastNumber
        ? this.container.db.select({
          id: storeProductCategory.id,
          cate_name: storeProductCategory.cateName,
          pid: storeProductCategory.pid,
          pic: storeProductCategory.pic,
        }).from(storeProductCategory).where(and(
          gt(storeProductCategory.pid, 0),
          eq(storeProductCategory.isShow, 1),
        )).orderBy(desc(storeProductCategory.sort), desc(storeProductCategory.id)).limit(fastNumber)
        : Promise.resolve([]),
      bastNumber
        ? this.products.getRecommendProducts(uid, { isBest: true, limit: bastNumber })
        : Promise.resolve([]),
      firstNumber
        ? this.products.getRecommendProducts(uid, { isNew: true, limit: firstNumber })
        : Promise.resolve([]),
      promotionNumber
        ? this.products.getRecommendProducts(uid, { isBenefit: true, limit: promotionNumber })
        : Promise.resolve([]),
      this.products.getRecommendProducts(uid, { isHot: true, limit: 3 }),
    ]);
    return {
      info: {
        fastList,
        bastList: await this.decorateProducts(bastList),
        firstList: await this.decorateProducts(firstList),
      },
      benefit: await this.decorateProducts(benefit),
      likeInfo: await this.decorateProducts(likeInfo),
      subscribe,
      tengxun_map_key: configs.tengxun_map_key ?? "",
      site_name: configs.site_name ?? "",
    };
  }

  /** v1 defaults anonymous users to followed; v2 /subscribe defaults them to false. */
  async subscribe(
    uid: number,
    options: { anonymousDefault: boolean; userType?: string },
  ): Promise<boolean> {
    if (!Number.isSafeInteger(uid) || uid <= 0) return options.anonymousDefault;
    const rows = await this.container.db.select({ subscribe: wechatUser.subscribe })
      .from(wechatUser)
      .where(and(
        eq(wechatUser.uid, uid),
        eq(wechatUser.isDel, 0),
        options.userType ? eq(wechatUser.userType, options.userType) : undefined,
      ))
      .orderBy(desc(wechatUser.id))
      .limit(1);
    return Boolean(rows[0]?.subscribe);
  }

  async menuUser(uid: number): Promise<Record<string, unknown>> {
    const [groups, configs, users, memberRows] = await Promise.all([
      this.groupDataMany(["routine_my_menus", "routine_my_banner"]),
      this.config.getMany([
        "member_func_status", "brokerage_func_status", "store_brokerage_apply",
        "balance_func_status", "member_card_status", "division_open", "division_apply_open",
        "routine_contact_type", "level_activate_status", "site_url", "routine_spread_banner",
      ]),
      uid ? this.container.db.select().from(user).where(eq(user.uid, uid)).limit(1) : Promise.resolve([]),
      this.container.db.select({ value: systemDise.value, status: systemDise.status })
        .from(systemDise)
        .where(and(eq(systemDise.templateName, "member"), eq(systemDise.type, 3), eq(systemDise.isDel, 0)))
        .orderBy(desc(systemDise.id)).limit(1),
    ]);
    const current = users[0];
    const enabled = (name: string, fallback = false) => {
      const value = configs[name];
      return value === "" ? fallback : value === "1" || value === "true";
    };
    const divisionValid = !current || current.divisionType === 0
      || (current.divisionStatus === 1 && current.divisionEndTime > Math.floor(Date.now() / 1_000));
    const hidden: Record<string, boolean> = {
      "/pages/users/user_vip/index": !enabled("member_func_status"),
      "/pages/users/user_spread_user/index": !uid || !enabled("brokerage_func_status") || !current?.isPromoter || !divisionValid,
      "/pages/users/agent/apply": !uid || !enabled("brokerage_func_status") || !enabled("division_open") || !enabled("division_apply_open") || current?.divisionType !== 0,
      "/pages/users/distributor/apply": !uid || !enabled("brokerage_func_status") || Boolean(current?.isPromoter) || !enabled("store_brokerage_apply"),
      "/pages/users/user_money/index": !enabled("balance_func_status"),
      "/pages/annex/vip_paid/index": !enabled("member_card_status"),
    };
    const filterMenu = (items: Record<string, unknown>[]) => items.flatMap((item) => {
      const url = String(item.url ?? "");
      if (hidden[url]) return [];
      const next = { ...item };
      if (url === "/pages/users/user_vip/index" && enabled("level_activate_status") && current?.levelStatus === 0) {
        next.url = "/pages/annex/vip_grade_active/index";
      }
      return [next];
    });
    const diyData = parseJsonObject(memberRows[0]?.value ?? null);
    for (const key of ["menu", "merMenu"]) {
      const block = plainObject(diyData[key]);
      if (block && Array.isArray(block.list)) {
        block.list = filterMenu(
          block.list.flatMap((item): Record<string, unknown>[] => {
            const record = plainObject(item);
            return record ? [record] : [];
          }),
        );
      }
    }
    let spreadBanner: unknown = [];
    try { spreadBanner = JSON.parse(configs.routine_spread_banner || "[]"); } catch { /* empty */ }
    return {
      routine_my_menus: filterMenu(groups.routine_my_menus),
      routine_my_banner: groups.routine_my_banner,
      routine_spread_banner: Array.isArray(spreadBanner) ? spreadBanner : [],
      routine_contact_type: int(configs.routine_contact_type),
      diy_data: diyData,
    };
  }

  async menuUserData(uid: number): Promise<Record<string, unknown>> {
    if (!uid) return { commission: [], order: [], not_pay_order: [] };
    const users = await this.container.db.select().from(user).where(eq(user.uid, uid)).limit(1);
    const current = users[0];
    if (!current) return { commission: [], order: [], not_pay_order: [] };
    const [downlineRows, serviceRows, unpaidRows] = await Promise.all([
      current.isPromoter
        ? this.container.db.select({
          number: sql<number>`COUNT(DISTINCT ${user.uid})::int`,
          orderNum: sql<number>`COUNT(${storeOrder.id}) FILTER (WHERE ${storeOrder.paid} = 1 AND ${storeOrder.isDel} = 0 AND ${storeOrder.pid} = 0)::int`,
        }).from(user).leftJoin(storeOrder, eq(storeOrder.uid, user.uid)).where(eq(user.spreadUid, uid))
        : Promise.resolve([]),
      this.container.db.select({ id: storeService.id }).from(storeService).where(and(
        eq(storeService.uid, uid), eq(storeService.accountStatus, 1), eq(storeService.status, 1),
        eq(storeService.customer, 1), eq(storeService.isDel, 0),
      )).limit(1),
      this.container.db.select().from(storeOrder).where(and(
        eq(storeOrder.uid, uid), eq(storeOrder.pid, 0), eq(storeOrder.paid, 0),
        eq(storeOrder.status, 0), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0),
      )).orderBy(desc(storeOrder.addTime)).limit(1),
    ]);
    const commission = current.isPromoter ? {
      brokerage_price: current.brokeragePrice,
      number: Number(downlineRows[0]?.number ?? 0),
      order_num: Number(downlineRows[0]?.orderNum ?? 0),
    } : [];
    let orderData: Record<string, unknown> | [] = [];
    if (serviceRows.length) {
      const rows = await this.container.db.select({
        price: sql<string>`COALESCE(SUM(${storeOrder.payPrice}), 0)::numeric(14,2)`,
        num: sql<number>`COUNT(*)::int`,
        consignment: sql<number>`COUNT(*) FILTER (WHERE ${storeOrder.status} = 1)::int`,
      }).from(storeOrder).where(and(
        inArray(storeOrder.pid, [0, -1]), eq(storeOrder.paid, 1), eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0), inArray(storeOrder.refundStatus, [0, 3]),
      ));
      orderData = { user_order: true, ...rows[0] };
    } else {
      orderData = { user_order: false };
    }
    let notPay: Record<string, unknown> | [] | null = [];
    if (unpaidRows[0]) {
      const order = unpaidRows[0];
      const carts = await this.container.db.select({ cartInfo: storeOrderCartInfo.cartInfo })
        .from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id)).limit(1);
      const cart = parseJsonObject(carts[0]?.cartInfo ?? null);
      const productInfo = plainObject(cart.productInfo) ?? {};
      const stopTime = await getOrderInvalidTime(this.container, this.env, order.type, order.addTime);
      notPay = stopTime > Math.floor(Date.now() / 1_000) ? {
        id: order.id, order_id: order.orderId, pay_price: order.payPrice, pay_type: order.payType,
        type: order.type, add_time: order.addTime, img: productInfo.image ?? "",
        store_name: productInfo.store_name ?? "", stop_time: stopTime,
      } : null;
    }
    return { commission, order: orderData, not_pay_order: notPay };
  }

  private async categoryIds(selectId: number): Promise<number[]> {
    if (!selectId) return [];
    const rows = await this.container.db.select({ id: storeProductCategory.id })
      .from(storeProductCategory)
      .where(or(
        eq(storeProductCategory.id, selectId),
        sql`${storeProductCategory.path} = ${String(selectId)} OR ${storeProductCategory.path} LIKE ${`${selectId},%`} OR ${storeProductCategory.path} LIKE ${`%,${selectId},%`} OR ${storeProductCategory.path} LIKE ${`%,${selectId}`}`,
      ));
    return rows.map((row) => row.id);
  }

  private productWhere(params: GoodsListParams & { productId?: string }) {
    const where: Record<string, unknown> = { status: 1, isVipProduct: 0 };
    if (params.store_name || params.keyword) where.store_name = params.store_name || params.keyword;
    if (params.news) where.isNew = 1;
    if (params.ids || params.productId) where.ids = csvIds(params.ids || params.productId);
    if (params.brand_id) where.brandId = csvIds(params.brand_id);
    if (params.cate_id) where.cateId = csvIds(params.cate_id);
    if (params.cid) where.cid = params.cid;
    if (params.sid) where.cid = params.sid;
    if (params.tid) where.cateId = [params.tid];
    return where;
  }

  async brand(params: GoodsListParams & { productId?: string }): Promise<Array<{ id: number; brand_name: string }>> {
    const where = this.productWhere(params);
    where.type = [0, 2];
    if (params.selectId) where.cateId = await this.categoryIds(params.selectId);
    const productIds = await this.container.storeProductDao.getIdsByWhere(where);
    if (!productIds.length) return [];
    const brandRows = await this.container.db.selectDistinct({ id: storeProduct.brandId })
      .from(storeProduct).where(and(inArray(storeProduct.id, productIds), gt(storeProduct.brandId, 0)));
    const brandIds = brandRows.map((row) => row.id);
    if (!brandIds.length) return [];
    return this.container.db.select({ id: storeBrand.id, brand_name: storeBrand.brandName })
      .from(storeBrand).where(and(inArray(storeBrand.id, brandIds), eq(storeBrand.isShow, 1), eq(storeBrand.isDel, 0)))
      .orderBy(desc(storeBrand.sort), asc(storeBrand.id));
  }

  async searchFilter(params: GoodsListParams & { productId?: string }): Promise<Record<string, unknown>> {
    const where = this.productWhere(params);
    if (params.selectId) where.cateId = await this.categoryIds(params.selectId);
    const ids = await this.container.storeProductDao.getIdsByWhere(where);
    if (!ids.length) return { promotions: [], brand: [], store_label: [] };
    const products = await this.container.db.select({
      id: storeProduct.id, brandId: storeProduct.brandId, storeLabelId: storeProduct.storeLabelId,
    }).from(storeProduct).where(inArray(storeProduct.id, ids));
    const brandIds = [...new Set(products.map((item) => item.brandId).filter(Boolean))];
    const labelIds = [...new Set(products.flatMap((item) => csvIds(item.storeLabelId)))];
    const now = Math.floor(Date.now() / 1_000);
    const [brands, labels, promotions] = await Promise.all([
      brandIds.length ? this.container.db.select({ id: storeBrand.id, brand_name: storeBrand.brandName })
        .from(storeBrand).where(and(inArray(storeBrand.id, brandIds), eq(storeBrand.isShow, 1), eq(storeBrand.isDel, 0))) : [],
      labelIds.length ? this.container.db.select({
        id: storeProductLabel.id, label_name: storeProductLabel.labelName,
        style_type: storeProductLabel.styleType, color: storeProductLabel.color,
        bg_color: storeProductLabel.bgColor, border_color: storeProductLabel.borderColor,
        icon: storeProductLabel.icon,
      }).from(storeProductLabel).where(and(inArray(storeProductLabel.id, labelIds), eq(storeProductLabel.status, 1), eq(storeProductLabel.isShow, 1))) : [],
      this.container.db.selectDistinct({
        id: storePromotions.id, promotions_type: storePromotions.promotionsType,
        name: storePromotions.name, title: storePromotions.title, image: storePromotions.image,
        desc: storePromotions.description,
      }).from(storePromotions).innerJoin(
        storePromotionsAuxiliary,
        eq(storePromotionsAuxiliary.promotionsId, storePromotions.id),
      ).where(and(
        inArray(storePromotionsAuxiliary.productId, ids), eq(storePromotions.status, 1),
        eq(storePromotions.isDel, 0), lte(storePromotions.startTime, now), gte(storePromotions.stopTime, now),
      )),
    ]);
    return { promotions, brand: brands, store_label: labels };
  }

  async rankCategory() {
    return this.container.db.select({
      id: storeProductCategory.id, pid: storeProductCategory.pid,
      cate_name: storeProductCategory.cateName, pic: storeProductCategory.pic,
      big_pic: storeProductCategory.bigPic,
    }).from(storeProductCategory).where(and(
      eq(storeProductCategory.isShow, 1), eq(storeProductCategory.level, 0), eq(storeProductCategory.type, 0),
    )).orderBy(desc(storeProductCategory.sort), desc(storeProductCategory.id));
  }

  async recommend(uid: number, options: {
    ids?: number[]; selectId?: number; flag?: "hot" | "benefit" | "best" | "new" | "good" | "vip";
    rank?: "sales" | "star" | "collect"; page?: number; limit?: number;
  } = {}) {
    const cateIds = options.selectId ? await this.categoryIds(options.selectId) : undefined;
    const flags = {
      isHot: options.flag === "hot", isBenefit: options.flag === "benefit",
      isBest: options.flag === "best", isNew: options.flag === "new",
      isGood: options.flag === "good", isVip: options.flag === "vip",
    };
    const list = await this.products.getRecommendProducts(uid, {
      ids: options.ids, cateIds, rankOrder: options.rank, page: options.page,
      limit: options.limit, ...flags,
    });
    return this.decorateProducts(list);
  }

  async detailRecommend(uid: number, productId: number, limit = 12) {
    const product = await this.container.storeProductDao.getById(productId);
    if (!product) return [];
    const ids = csvIds(product.recommendList);
    return ids.length
      ? this.recommend(uid, { ids, limit })
      : this.recommend(uid, { flag: "good", limit });
  }

  async detailContent(productId: number): Promise<{ description: string }> {
    const product = await this.container.storeProductDao.getById(productId);
    if (!product || product.isDel || !product.isShow || product.isVerify !== 1) {
      throw new NotFoundException("商品不存在或已下架");
    }
    const rows = await this.container.db.select({ description: storeProductDescription.description })
      .from(storeProductDescription).where(and(
        eq(storeProductDescription.productId, productId), eq(storeProductDescription.type, 0),
      )).limit(1);
    return { description: rows[0]?.description ?? "" };
  }

  async productActivity(productId: number): Promise<Record<string, unknown>> {
    const empty = {
      activity: [], coupons: [], discounts_products: [], promotions: [],
      activity_background: [], computed: { deduction: [] },
    };
    const product = await this.container.storeProductDao.getById(productId);
    if (!product || product.isPresaleProduct) return empty;
    const nowDate = new Date();
    const now = Math.floor(nowDate.getTime() / 1_000);
    const [coupons, discounts, promotions] = await Promise.all([
      this.container.db.selectDistinct({
        id: storeCouponIssue.id, type: storeCouponIssue.type, coupon_type: storeCouponIssue.couponType,
        coupon_title: storeCouponIssue.couponTitle, coupon_price: storeCouponIssue.couponPrice,
        use_min_price: storeCouponIssue.useMinPrice, start_time: storeCouponIssue.startTime,
        end_time: storeCouponIssue.endTime, rule: storeCouponIssue.rule,
      }).from(storeCouponIssue).leftJoin(storeCouponProduct, eq(storeCouponProduct.couponId, storeCouponIssue.id))
        .where(and(
          eq(storeCouponIssue.status, 1), eq(storeCouponIssue.isDel, 0),
          or(eq(storeCouponIssue.couponType, 0), eq(storeCouponProduct.productId, productId)),
          or(isNull(storeCouponIssue.startTime), lte(storeCouponIssue.startTime, nowDate)),
          or(isNull(storeCouponIssue.endTime), gte(storeCouponIssue.endTime, nowDate)),
        )).orderBy(desc(storeCouponIssue.couponPrice)).limit(3),
      this.container.db.selectDistinct({
        id: storeDiscounts.id, type: storeDiscounts.type, title: storeDiscounts.title,
        image: storeDiscounts.image, is_limit: storeDiscounts.isLimit,
        limit_num: storeDiscounts.limitNum, product_ids: storeDiscounts.productIds,
        sort: storeDiscounts.sort,
      }).from(storeDiscounts).innerJoin(storeDiscountsProducts, eq(storeDiscountsProducts.discountId, storeDiscounts.id))
        .where(and(
          eq(storeDiscountsProducts.productId, productId), eq(storeDiscounts.status, 1),
          eq(storeDiscounts.isDel, 0), or(eq(storeDiscounts.isTime, 0), and(lte(storeDiscounts.startTime, now), gte(storeDiscounts.stopTime, now))),
        )).orderBy(desc(storeDiscounts.sort)).limit(2),
      this.container.db.selectDistinct({
        id: storePromotions.id, type: storePromotions.type, title: storePromotions.title,
        name: storePromotions.name, promotions_type: storePromotions.promotionsType,
        threshold_type: storePromotions.thresholdType, threshold: storePromotions.threshold,
        discount_type: storePromotions.discountType, discount: storePromotions.discount,
        desc: storePromotions.description, image: storePromotions.image,
        start_time: storePromotions.startTime, stop_time: storePromotions.stopTime,
        sort: storePromotions.sort,
      }).from(storePromotions).innerJoin(storePromotionsAuxiliary, eq(storePromotionsAuxiliary.promotionsId, storePromotions.id))
        .where(and(
          eq(storePromotionsAuxiliary.productId, productId), eq(storePromotions.status, 1),
          eq(storePromotions.isDel, 0), lte(storePromotions.startTime, now), gte(storePromotions.stopTime, now),
        )).orderBy(desc(storePromotions.sort), desc(storePromotions.id)),
    ]);
    const background = promotions.find((item) => item.promotions_type === 6);
    return {
      ...empty,
      coupons,
      discounts_products: discounts.map((item) => ({ ...item, products: [] })),
      promotions: promotions.filter((item) => item.promotions_type !== 6),
      activity_background: background ? { id: background.id, name: background.name, image: background.image } : [],
    };
  }

  async presale(uid: number, timeType: number, pageValue: unknown, limitValue: unknown) {
    const { page, limit } = normalizeCatalogPage(pageValue, limitValue);
    const now = Math.floor(Date.now() / 1_000);
    const timeCondition = timeType === 1
      ? gt(storeProduct.presaleStartTime, now)
      : timeType === 2
        ? and(lte(storeProduct.presaleStartTime, now), gte(storeProduct.presaleEndTime, now))
        : timeType === 3
          ? lt(storeProduct.presaleEndTime, now)
          : undefined;
    const condition = and(
      eq(storeProduct.isPresaleProduct, 1), eq(storeProduct.isDel, 0),
      eq(storeProduct.isShow, 1), eq(storeProduct.isVerify, 1), timeCondition,
    );
    const [rows, countRows] = await Promise.all([
      this.container.db.select().from(storeProduct).where(condition)
        .orderBy(desc(storeProduct.addTime)).limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` }).from(storeProduct).where(condition),
    ]);
    void uid;
    return { list: await this.decorateProducts(rows.map(productListRow)), count: Number(countRows[0]?.count ?? 0) };
  }

  private async decorateProducts(list: Record<string, unknown>[]) {
    if (!list.length) return list;
    const brandIds = [...new Set(list.map((item) => int(item.brand_id)).filter(Boolean))];
    const labelIds = [...new Set(list.flatMap((item) => csvIds(item.store_label_id)))];
    const [brands, labels] = await Promise.all([
      brandIds.length ? this.container.db.select({ id: storeBrand.id, name: storeBrand.brandName })
        .from(storeBrand).where(and(inArray(storeBrand.id, brandIds), eq(storeBrand.isDel, 0), eq(storeBrand.isShow, 1))) : [],
      labelIds.length ? this.container.db.select({
        id: storeProductLabel.id, label_name: storeProductLabel.labelName,
        style_type: storeProductLabel.styleType, color: storeProductLabel.color,
        bg_color: storeProductLabel.bgColor, border_color: storeProductLabel.borderColor,
        icon: storeProductLabel.icon,
      }).from(storeProductLabel).where(and(
        inArray(storeProductLabel.id, labelIds), eq(storeProductLabel.status, 1), eq(storeProductLabel.isShow, 1),
      )) : [],
    ]);
    const brandMap = new Map(brands.map((item) => [item.id, item.name]));
    const labelMap = new Map(labels.map((item) => [item.id, item]));
    return list.map((item) => ({
      ...item,
      brand_name: brandMap.get(int(item.brand_id)) ?? "",
      store_label: csvIds(item.store_label_id).flatMap((id) => labelMap.get(id) ?? []),
      presale_pay_status: legacyPresalePayStatus(
        item.is_presale_product,
        item.presale_start_time,
        item.presale_end_time,
      ),
    }));
  }
}
