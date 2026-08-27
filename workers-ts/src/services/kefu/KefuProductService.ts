import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Container } from "@/lib/di";
import {
  storeOrder,
  storeOrderCartInfo,
  storeProduct,
  storeProductDescription,
  storeProductRelation,
  storeVisit,
} from "@/models/schema";
import { assertKefuConversation, parseKefuPageLimit } from "@/services/kefu/KefuCoreService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const CATEGORY_RELATION_TYPE = 1;
const MAX_PAGE = 1_000_000;

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new ValidateException(`${field}错误`);
  }
  return parsed;
}

export function parseKefuProductPage(value: unknown): number {
  if (value === undefined || value === null || value === "") return 1;
  const parsed = positiveInteger(value, "页码");
  if (parsed > MAX_PAGE) throw new ValidateException("页码错误");
  return parsed;
}

export function parseKefuProductId(value: unknown): number {
  return positiveInteger(value, "商品ID");
}

function searchName(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new ValidateException("商品名称错误");
  const result = value.trim();
  if (result.length > 100) throw new ValidateException("商品名称不能超过100个字符");
  return result;
}

function parseSliderImages(value: string): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

const productSummary = {
  id: storeProduct.id,
  sales: sql<number>`COALESCE(${storeProduct.sales}, 0) + COALESCE(${storeProduct.ficti}, 0)`,
  store_name: storeProduct.storeName,
  image: storeProduct.image,
  stock: storeProduct.stock,
  price: storeProduct.price,
};

export class KefuProductService {
  constructor(private readonly container: Container) {}

  private async customerScope(kefuUid: number, uidValue: unknown): Promise<number> {
    const uid = positiveInteger(uidValue, "用户ID");
    await assertKefuConversation(this.container, kefuUid, uid, 0);
    return uid;
  }

  private page(query: Record<string, string>) {
    return {
      page: parseKefuProductPage(query.page),
      limit: parseKefuPageLimit(query.limit),
      storeName: searchName(query.store_name),
    };
  }

  async purchasedProducts(
    kefuUid: number,
    uidValue: unknown,
    query: Record<string, string>,
  ) {
    const uid = await this.customerScope(kefuUid, uidValue);
    const { page, limit, storeName } = this.page(query);
    const conditions: SQL[] = [eq(storeProduct.isShow, 1), eq(storeProduct.isDel, 0)];
    if (storeName) {
      // PHP deliberately widens an explicit search to the complete platform
      // catalog instead of restricting it to the customer's purchase history.
      conditions.push(eq(storeProduct.pid, 0), ilike(storeProduct.storeName, `%${storeName}%`));
    } else {
      const purchasedProductIds = this.container.db
        .select({ productId: storeOrderCartInfo.productId })
        .from(storeOrderCartInfo)
        .innerJoin(storeOrder, eq(storeOrder.id, storeOrderCartInfo.oid))
        .where(eq(storeOrder.uid, uid));
      conditions.push(inArray(storeProduct.id, purchasedProductIds));
    }
    return this.container.db
      .select(productSummary)
      .from(storeProduct)
      .where(and(...conditions))
      .orderBy(desc(storeProduct.sort), desc(storeProduct.id))
      .limit(limit)
      .offset((page - 1) * limit);
  }

  async visitedProducts(
    kefuUid: number,
    uidValue: unknown,
    query: Record<string, string>,
  ) {
    const uid = await this.customerScope(kefuUid, uidValue);
    const { page, limit, storeName } = this.page(query);
    const conditions: SQL[] = [eq(storeVisit.uid, uid)];
    if (storeName) conditions.push(ilike(storeProduct.storeName, `%${storeName}%`));
    return this.container.db
      .select(productSummary)
      .from(storeProduct)
      .innerJoin(storeVisit, eq(storeVisit.productId, storeProduct.id))
      .where(and(...conditions))
      .orderBy(desc(storeVisit.addTime), desc(storeProduct.sort), desc(storeProduct.id))
      .limit(limit)
      .offset((page - 1) * limit);
  }

  async hotProducts(
    kefuUid: number,
    uidValue: unknown,
    query: Record<string, string>,
  ) {
    const uid = await this.customerScope(kefuUid, uidValue);
    const storeName = searchName(query.store_name);
    const purchasedProductIds = this.container.db
      .select({ productId: storeOrderCartInfo.productId })
      .from(storeOrderCartInfo)
      .innerJoin(storeOrder, eq(storeOrder.id, storeOrderCartInfo.oid))
      .where(eq(storeOrder.uid, uid));
    const categoryIds = this.container.db
      .select({ relationId: storeProductRelation.relationId })
      .from(storeProductRelation)
      .where(and(
        eq(storeProductRelation.type, CATEGORY_RELATION_TYPE),
        inArray(storeProductRelation.productId, purchasedProductIds),
      ));
    const candidateIds = this.container.db
      .select({ productId: storeProductRelation.productId })
      .from(storeProductRelation)
      .where(and(
        eq(storeProductRelation.type, CATEGORY_RELATION_TYPE),
        inArray(storeProductRelation.relationId, categoryIds),
      ));
    const conditions: SQL[] = [inArray(storeProduct.id, candidateIds)];
    if (storeName) conditions.push(ilike(storeProduct.storeName, `%${storeName}%`));
    return this.container.db
      .select({
        ...productSummary,
        ot_price: storeProduct.otPrice,
      })
      .from(storeProduct)
      .where(and(...conditions))
      .orderBy(desc(sql`COALESCE(${storeProduct.sales}, 0) + COALESCE(${storeProduct.ficti}, 0)`), desc(storeProduct.id))
      .limit(20);
  }

  async productInfo(idValue: unknown) {
    const id = parseKefuProductId(idValue);
    const row = (
      await this.container.db
        .select({
          id: storeProduct.id,
          sales: sql<number>`COALESCE(${storeProduct.sales}, 0) + COALESCE(${storeProduct.ficti}, 0)`,
          store_name: storeProduct.storeName,
          image: storeProduct.image,
          slider_image: storeProduct.sliderImage,
          price: storeProduct.price,
          vip_price: storeProduct.vipPrice,
          ot_price: storeProduct.otPrice,
          stock: storeProduct.stock,
          description: storeProductDescription.description,
        })
        .from(storeProduct)
        .leftJoin(
          storeProductDescription,
          and(
            eq(storeProductDescription.productId, storeProduct.id),
            eq(storeProductDescription.type, 0),
          ),
        )
        .where(eq(storeProduct.id, id))
        .limit(1)
    )[0];
    if (!row) throw new NotFoundException("商品未查到");
    return {
      ...row,
      slider_image: parseSliderImages(row.slider_image),
      description: row.description ?? "",
    };
  }
}
