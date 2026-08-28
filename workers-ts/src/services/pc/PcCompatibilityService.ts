import {
  and,
  asc,
  desc,
  eq,
  inArray,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import {
  cityArea,
  storeOrder,
  storeOrderRefund,
  storeProductCategory,
  userRelation,
} from "@/models/schema";
import { StoreCartService } from "@/services/order/StoreCartService";
import { StoreOrderCreateService } from "@/services/order/StoreOrderCreateService";
import {
  normalizeCatalogPage,
  PublicCatalogService,
} from "@/services/product/PublicCatalogService";
import { StoreProductService, type GoodsListParams } from "@/services/product/StoreProductService";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { createQrSvgDataUrl } from "@/services/user/MembershipScanService";
import { V2UserCompatibilityService } from "@/services/user/V2UserCompatibilityService";
import { WechatMiniProgramCodeService } from "@/services/wechat/WechatMiniProgramCodeService";

const PC_PRODUCT_TYPES = [0, 1, 2, 3];

function safeJsonArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object" && !Array.isArray(item));
  }
  const source = String(value ?? "").trim();
  if (!source || source.length > 1_000_000) return [];
  try {
    return safeJsonArray(JSON.parse(source));
  } catch {
    return [];
  }
}

function sortedLinks(value: unknown): Record<string, unknown>[] {
  return safeJsonArray(value).sort((left, right) => {
    const bySort = Number(right.sort ?? 0) - Number(left.sort ?? 0);
    return bySort || String(left.url ?? "").localeCompare(String(right.url ?? ""));
  });
}

function truthyConfig(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function toSnakeKey(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

function toLegacyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toLegacyValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(
    ([key, child]) => [toSnakeKey(key), toLegacyValue(child)],
  ));
}

function parseSnapshot(value: string | null): unknown {
  if (!value || value.length > 1_000_000) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export class PcCompatibilityService {
  private readonly config: SystemConfigService;
  private readonly catalog: PublicCatalogService;
  private readonly products: StoreProductService;

  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {
    this.config = new SystemConfigService(container, env);
    this.catalog = new PublicCatalogService(container, env);
    this.products = new StoreProductService(container, env);
  }

  async appId() {
    return {
      appid: await this.config.get("wechat_open_app_id"),
      version: "CinaShop Workers 0.1.0",
    };
  }

  async payVipCode(): Promise<{ url: string }> {
    const values = await this.config.getMany(["product_phone_buy_url", "site_url"]);
    if (Number(values.product_phone_buy_url || 1) === 2) {
      try {
        return {
          url: await new WechatMiniProgramCodeService(this.container, this.env)
            .createPaidMembershipDataUrl() ?? "",
        };
      } catch {
        return { url: "" };
      }
    }
    try {
      const url = new URL("/pages/annex/vip_paid/index", values.site_url).toString();
      return { url: createQrSvgDataUrl(url) };
    } catch {
      return { url: "" };
    }
  }

  async productPhoneBuy() {
    const values = await this.config.getMany(["product_phone_buy_url", "site_url"]);
    return {
      phone_buy: values.product_phone_buy_url || "1",
      sit_url: values.site_url ?? "",
    };
  }

  async banner() {
    const groups = await this.catalog.groupDataMany(["pc_home_banner"]);
    return { list: groups.pc_home_banner ?? [] };
  }

  async categoryProducts(uid: number, pageValue: unknown, limitValue: unknown) {
    const { page, limit } = normalizeCatalogPage(pageValue, limitValue);
    const condition = and(
      eq(storeProductCategory.isShow, 1),
      eq(storeProductCategory.pid, 0),
      inArray(
        storeProductCategory.id,
        sql`(SELECT relation_pid FROM store_product_relation
          WHERE type = 1 AND status = 1 GROUP BY relation_pid)` as never,
      ),
    );
    const [categories, countRows] = await Promise.all([
      this.container.db.select().from(storeProductCategory).where(condition)
        .orderBy(desc(storeProductCategory.sort), asc(storeProductCategory.id))
        .limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` })
        .from(storeProductCategory).where(condition),
    ]);
    const list = await Promise.all(categories.map(async (category) => ({
      id: category.id,
      pid: category.pid,
      cate_name: category.cateName,
      pic: category.pic,
      big_pic: category.bigPic,
      sort: category.sort,
      productList: (await this.products.getGoodsList({
        cid: category.id,
        product_types: PC_PRODUCT_TYPES,
        page: 1,
        limit: 8,
      }, uid)).list,
    })));
    return { list, count: Number(countRows[0]?.count ?? 0) };
  }

  async productList(uid: number, params: GoodsListParams) {
    return this.products.getGoodsList({ ...params, product_types: PC_PRODUCT_TYPES }, uid);
  }

  async productCode(productId: number) {
    const values = await this.config.getMany(["product_phone_buy_url", "site_url"]);
    let routineCode = "";
    if (Number(values.product_phone_buy_url) === 2 && productId > 0) {
      try {
        routineCode = await new WechatMiniProgramCodeService(this.container, this.env)
          .createProductDetailDataUrl(productId) ?? "";
      } catch {
        routineCode = "";
      }
    }
    return { site_url: values.site_url ?? "", routineCode };
  }

  async city(pid: number) {
    const rows = await this.container.db.select().from(cityArea)
      .where(eq(cityArea.parentId, pid)).orderBy(asc(cityArea.snum), asc(cityArea.id)).limit(5_000);
    if (!rows.length) return [];
    const [parents, childParents] = await Promise.all([
      pid > 0
        ? this.container.db.select({ name: cityArea.name }).from(cityArea)
          .where(eq(cityArea.id, pid)).limit(1)
        : Promise.resolve([]),
      this.container.db.selectDistinct({ parentId: cityArea.parentId }).from(cityArea)
        .where(inArray(cityArea.parentId, rows.map((row) => row.id))),
    ]);
    const expandable = new Set(childParents.map((row) => row.parentId));
    return rows.map((row) => ({
      value: row.id,
      id: row.id,
      label: row.name,
      pid: row.parentId,
      level: row.level,
      parent_name: parents[0]?.name ?? "",
      ...(expandable.has(row.id) ? { children: [], loading: false, _loading: false } : {}),
    }));
  }

  async orderStatus(orderId: string, endTime: number) {
    const rows = orderId
      ? await this.container.db.select({ id: storeOrder.id }).from(storeOrder)
        .where(and(eq(storeOrder.orderId, orderId), eq(storeOrder.paid, 1))).limit(1)
      : [];
    return {
      status: rows.length > 0,
      time: Math.max(0, Math.trunc(endTime) - Math.floor(Date.now() / 1_000)),
    };
  }

  async companyInfo() {
    const names = [
      "contact_number", "links_open", "links_list", "company_address", "copyright",
      "record_No", "site_name", "site_keywords", "site_description", "pc_logo",
      "filing_list", "site_url",
    ];
    const values = await this.config.getMany(names);
    let logoUrl = values.pc_logo ?? "";
    if (logoUrl && !/^https?:\/\//i.test(logoUrl)) logoUrl = `${values.site_url ?? ""}${logoUrl}`;
    return {
      contact_number: values.contact_number ?? "",
      links_open: values.links_open ?? "",
      links_list: truthyConfig(values.links_open) ? sortedLinks(values.links_list) : [],
      company_address: values.company_address ?? "",
      copyright: values.copyright ?? "",
      record_No: values.record_No ?? "",
      site_name: values.site_name ?? "",
      site_keywords: values.site_keywords ?? "",
      site_description: values.site_description ?? "",
      pc_logo: values.pc_logo ?? "",
      filing_list: sortedLinks(values.filing_list),
      logoUrl: logoUrl.replaceAll("\\", "/"),
    };
  }

  async recommend(uid: number, type: number, pageValue: unknown, limitValue: unknown) {
    const mapping = { 1: "best", 2: "hot", 3: "new", 4: "benefit" } as const;
    const flag = mapping[type as keyof typeof mapping];
    if (!flag) return { list: [], count: 0 };
    const { page, limit } = normalizeCatalogPage(pageValue, limitValue, 10);
    const list = await this.catalog.recommend(uid, { flag, page, limit });
    const key = `is${flag[0]!.toUpperCase()}${flag.slice(1)}`;
    const visibility = uid && (await this.container.userDao.findForAuth(uid))?.isMoneyLevel ? -1 : 0;
    const count = await this.container.storeProductDao.countSearch({
      status: 1,
      isShow: 1,
      isDel: 0,
      isVerify: 1,
      pid: 0,
      isVipProduct: visibility,
      [key]: 1,
    });
    return { list, count };
  }

  async goodProducts(uid: number) {
    return { list: await this.catalog.recommend(uid, { flag: "good", limit: 100 }) };
  }

  async wechatQrcode() {
    return { wechat_qrcode: await this.config.get("wechat_qrcode") };
  }

  async cartList(uid: number) {
    return new StoreCartService(this.container, this.env).listLegacyPc(uid);
  }

  async balanceRecord(uid: number, type: number, query: Record<string, unknown>) {
    const service = new V2UserCompatibilityService(this.container);
    if (type === 0 || type === 1 || type === 2) return service.moneyList(uid, type, query);
    if (type === 3) return service.brokerageList(uid, query);
    if (type === 4) return service.extractList(uid, query);
    return [];
  }

  async orderList(uid: number, query: Record<string, string | undefined>) {
    const status = query.type !== undefined && query.type !== "" ? Number(query.type) : undefined;
    const { page, limit } = normalizeCatalogPage(query.page, query.limit);
    const result = await new StoreOrderCreateService(this.container, this.env).listLegacyPc(uid, {
      status,
      search: query.search,
      page,
      limit,
    });
    return toLegacyValue(result);
  }

  async collectList(uid: number, pageValue: unknown, limitValue: unknown) {
    const { page, limit } = normalizeCatalogPage(pageValue, limitValue);
    const condition = and(
      eq(userRelation.uid, uid),
      eq(userRelation.type, "collect"),
      eq(userRelation.category, "product"),
    );
    const [relations, countRows] = await Promise.all([
      this.container.db.select({ relationId: userRelation.relationId }).from(userRelation)
        .where(condition).orderBy(desc(userRelation.addTime), desc(userRelation.id))
        .limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` }).from(userRelation).where(condition),
    ]);
    const ids = relations.map((row) => row.relationId);
    const list = ids.length ? await this.catalog.recommend(uid, { ids, limit: ids.length }) : [];
    return { list, count: Number(countRows[0]?.count ?? 0) };
  }

  async refundList(uid: number, refundType: unknown, pageValue: unknown, limitValue: unknown) {
    const { page, limit } = normalizeCatalogPage(pageValue, limitValue);
    const conditions: SQL[] = [eq(storeOrderRefund.uid, uid), eq(storeOrderRefund.isDel, 0)];
    if (refundType !== undefined && refundType !== "") {
      const filters: Record<number, number[]> = {
        0: [0], 1: [1, 2], 2: [4, 5], 3: [5], 4: [6],
        5: [0, 1, 2, 4, 5], 6: [3, 6],
      };
      const selected = filters[Number(refundType)];
      if (selected?.length) conditions.push(inArray(storeOrderRefund.refundType, selected));
    }
    const where = and(...conditions);
    const [rows, countRows] = await Promise.all([
      this.container.db.select().from(storeOrderRefund).where(where)
        .orderBy(desc(storeOrderRefund.addTime), desc(storeOrderRefund.id))
        .limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` })
        .from(storeOrderRefund).where(where),
    ]);
    return {
      list: rows.map((row) => toLegacyValue({ ...row, cartInfo: parseSnapshot(row.cartInfo) })),
      count: Number(countRows[0]?.count ?? 0),
    };
  }
}
