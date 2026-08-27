import { and, desc, eq, gt, gte, inArray, lte, or } from "drizzle-orm";
import {
  storeCart,
  storeDiscounts,
  storeDiscountsProducts,
  storeProduct,
  storeProductAttrValue,
} from "@/models/schema";
import { createContainerFromDb, withTx, type Container } from "@/lib/di";
import { ValidateException } from "@/utils/errors";

type DiscountProduct = typeof storeDiscountsProducts.$inferSelect;
type Product = typeof storeProduct.$inferSelect;
type AttrValue = typeof storeProductAttrValue.$inferSelect;
export type DiscountPackage = typeof storeDiscounts.$inferSelect;

export type DiscountProductRow = {
  entry: DiscountProduct;
  product: Pick<Product, "id" | "isDel" | "isShow" | "stock" | "price"> | null;
};

export type DiscountSku = Pick<AttrValue, "productId" | "suk" | "stock" | "price">;

export interface DiscountPackageSelectionInput {
  entryId?: number;
  productId: number;
  unique: string;
}

export interface ResolvedDiscountPackageItem {
  entry: DiscountProduct;
  product: Product;
  packageSku: AttrValue;
  baseSku: AttrValue;
  priceCents: number;
}

export interface ResolvedDiscountPackage {
  discount: DiscountPackage;
  items: ResolvedDiscountPackageItem[];
}

function parseAmountToCents(value: string | number): number | null {
  const normalized = String(value).trim();
  const match = normalized.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

function amountToCents(value: string | number): number {
  return parseAmountToCents(value) ?? 0;
}

function centsToAmount(value: number): string {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

export function isDiscountPackageAvailable(
  discount: DiscountPackage,
  now = Math.floor(Date.now() / 1000),
): boolean {
  if (discount.isDel !== 0 || discount.status !== 1) return false;
  if (discount.startTime > 0 && discount.startTime > now) return false;
  if (discount.stopTime > 0 && discount.stopTime < now) return false;
  return discount.isLimit === 0 || discount.limitNum > 0;
}

/**
 * Validate fixed/mix-and-match membership independently of database state.
 * The returned entries follow the client's selected order.
 */
export function validateDiscountPackageSelection(
  discount: DiscountPackage,
  entries: DiscountProduct[],
  selections: DiscountPackageSelectionInput[],
): Array<{ entry: DiscountProduct; selection: DiscountPackageSelectionInput }> {
  if (discount.type !== 0 && discount.type !== 1) {
    throw new ValidateException("套餐类型无效");
  }
  if (entries.length < 2) throw new ValidateException("套餐商品配置不完整");
  if (selections.length < 2 || selections.length > 100) {
    throw new ValidateException("套餐至少选择两件且不能超过100件商品");
  }

  const entriesById = new Map<number, DiscountProduct>();
  const entriesByProduct = new Map<number, DiscountProduct>();
  for (const entry of entries) {
    if (entriesById.has(entry.id) || entriesByProduct.has(entry.productId)) {
      throw new ValidateException("套餐配置包含重复商品");
    }
    entriesById.set(entry.id, entry);
    entriesByProduct.set(entry.productId, entry);
  }

  const selectedEntryIds = new Set<number>();
  const selectedProductIds = new Set<number>();
  const normalized = selections.map((selection) => {
    const entryId = Number(selection.entryId ?? 0);
    const productId = Number(selection.productId);
    const unique = String(selection.unique ?? "").trim();
    if (
      !Number.isSafeInteger(productId) || productId <= 0 ||
      (entryId !== 0 && (!Number.isSafeInteger(entryId) || entryId <= 0)) ||
      !unique || unique.length > 255
    ) {
      throw new ValidateException("套餐商品参数错误");
    }
    const entry = entryId > 0 ? entriesById.get(entryId) : entriesByProduct.get(productId);
    if (!entry || entry.productId !== productId) {
      throw new ValidateException("所选商品不属于当前套餐");
    }
    if (selectedEntryIds.has(entry.id) || selectedProductIds.has(entry.productId)) {
      throw new ValidateException("套餐商品不能重复选择");
    }
    selectedEntryIds.add(entry.id);
    selectedProductIds.add(entry.productId);
    return { entry, selection: { entryId: entry.id, productId, unique } };
  });

  if (discount.type === 0) {
    if (normalized.length !== entries.length) {
      throw new ValidateException("固定套餐必须购买全部商品");
    }
  } else {
    const missingRequired = entries.some(
      (entry) => entry.type === 1 && !selectedEntryIds.has(entry.id),
    );
    if (missingRequired) throw new ValidateException("请选择套餐必选商品");
  }
  return normalized;
}

function addUniqueRow<T>(map: Map<string, T>, key: string, row: T, message: string): void {
  if (map.has(key)) throw new ValidateException(message);
  map.set(key, row);
}

/**
 * Resolve a package selection to immutable base/product SKU pairs. Package SKU
 * stock is an eligibility flag; only base stock is consumed by an order.
 */
export async function resolveDiscountPackageSelection(
  container: Container,
  params: {
    discountId: number;
    selections: DiscountPackageSelectionInput[];
    uniqueKind: "package" | "base";
    lockRows?: boolean;
    now?: number;
  },
): Promise<ResolvedDiscountPackage> {
  if (!Number.isSafeInteger(params.discountId) || params.discountId <= 0) {
    throw new ValidateException("套餐参数错误");
  }
  const packageQuery = container.db
    .select()
    .from(storeDiscounts)
    .where(eq(storeDiscounts.id, params.discountId))
    .limit(1)
    .$dynamic();
  const packageRows = await (params.lockRows ? packageQuery.for("update") : packageQuery);
  const discount = packageRows[0];
  if (!discount || !isDiscountPackageAvailable(discount, params.now)) {
    throw new ValidateException("套餐不存在、未开始或已售罄");
  }

  const entryQuery = container.db
    .select()
    .from(storeDiscountsProducts)
    .where(eq(storeDiscountsProducts.discountId, discount.id))
    .orderBy(storeDiscountsProducts.id)
    .$dynamic();
  const entries = await (params.lockRows ? entryQuery.for("update") : entryQuery);
  const normalized = validateDiscountPackageSelection(discount, entries, params.selections);
  const productIds = normalized.map(({ entry }) => entry.productId);
  const entryIds = normalized.map(({ entry }) => entry.id);

  const productQuery = container.db
    .select()
    .from(storeProduct)
    .where(inArray(storeProduct.id, productIds))
    .$dynamic();
  const packageSkuQuery = container.db
    .select()
    .from(storeProductAttrValue)
    .where(
      and(
        inArray(storeProductAttrValue.productId, entryIds),
        eq(storeProductAttrValue.type, 5),
      ),
    )
    .$dynamic();
  const baseSkuQuery = container.db
    .select()
    .from(storeProductAttrValue)
    .where(
      and(
        inArray(storeProductAttrValue.productId, productIds),
        eq(storeProductAttrValue.type, 0),
      ),
    )
    .$dynamic();
  const [products, packageSkus, baseSkus] = await Promise.all([
    params.lockRows ? productQuery.for("update") : productQuery,
    params.lockRows ? packageSkuQuery.for("update") : packageSkuQuery,
    params.lockRows ? baseSkuQuery.for("update") : baseSkuQuery,
  ]);

  const productsById = new Map(products.map((row) => [row.id, row]));
  const packageByUnique = new Map<string, AttrValue>();
  const packageBySuk = new Map<string, AttrValue>();
  const baseByUnique = new Map<string, AttrValue>();
  const baseBySuk = new Map<string, AttrValue>();
  for (const sku of packageSkus) {
    addUniqueRow(packageByUnique, `${sku.productId}:${sku.unique}`, sku, "套餐规格配置重复");
    addUniqueRow(packageBySuk, `${sku.productId}:${sku.suk}`, sku, "套餐规格名称重复");
  }
  for (const sku of baseSkus) {
    addUniqueRow(baseByUnique, `${sku.productId}:${sku.unique}`, sku, "商品规格配置重复");
    addUniqueRow(baseBySuk, `${sku.productId}:${sku.suk}`, sku, "商品规格名称重复");
  }

  const items = normalized.map(({ entry, selection }) => {
    const product = productsById.get(entry.productId);
    if (
      !product || product.isDel !== 0 || product.isShow !== 1 || product.stock < 1 ||
      product.productType !== entry.productType
    ) {
      throw new ValidateException(`套餐商品「${entry.title}」已下架或库存不足`);
    }
    const packageSku = params.uniqueKind === "package"
      ? packageByUnique.get(`${entry.id}:${selection.unique}`)
      : (() => {
          const base = baseByUnique.get(`${entry.productId}:${selection.unique}`);
          return base ? packageBySuk.get(`${entry.id}:${base.suk}`) : undefined;
        })();
    const baseSku = params.uniqueKind === "package"
      ? (packageSku ? baseBySuk.get(`${entry.productId}:${packageSku.suk}`) : undefined)
      : baseByUnique.get(`${entry.productId}:${selection.unique}`);
    if (!packageSku || !baseSku || packageSku.suk !== baseSku.suk) {
      throw new ValidateException(`套餐商品「${entry.title}」规格已失效`);
    }
    if (packageSku.stock < 1 || baseSku.stock < 1) {
      throw new ValidateException(`套餐商品「${entry.title}」库存不足`);
    }
    const priceCents = parseAmountToCents(packageSku.price);
    if (priceCents === null) {
      throw new ValidateException(`套餐商品「${entry.title}」价格无效`);
    }
    return { entry, product, packageSku, baseSku, priceCents };
  });
  return { discount, items };
}

/**
 * Rebuild the legacy package response from already-batched database rows.
 * Keeping this pure makes fixed and mix-and-match eligibility independently testable.
 */
export function assembleDiscountPackages(
  discounts: DiscountPackage[],
  productRows: DiscountProductRow[],
  bundleSkus: DiscountSku[],
  productSkus: DiscountSku[],
): Record<string, unknown>[] {
  const productsByDiscount = new Map<number, DiscountProductRow[]>();
  for (const row of productRows) {
    const rows = productsByDiscount.get(row.entry.discountId) ?? [];
    rows.push(row);
    productsByDiscount.set(row.entry.discountId, rows);
  }
  const bundleSkusByEntry = new Map<number, DiscountSku[]>();
  for (const sku of bundleSkus) {
    const rows = bundleSkusByEntry.get(sku.productId) ?? [];
    rows.push(sku);
    bundleSkusByEntry.set(sku.productId, rows);
  }
  const productSkuBySuk = new Map<string, DiscountSku>();
  for (const sku of productSkus) {
    productSkuBySuk.set(`${sku.productId}:${sku.suk}`, sku);
  }

  const result: Record<string, unknown>[] = [];
  for (const discount of discounts) {
    const products = productsByDiscount.get(discount.id) ?? [];
    const validProducts: Record<string, unknown>[] = [];
    let requiredProductInvalid = false;
    let minPriceCents = 0;
    let maxSavingsCents = 0;

    for (const { entry, product } of products) {
      const skus = bundleSkusByEntry.get(entry.id) ?? [];
      const hasProductStock =
        product !== null && product.isDel === 0 && product.isShow === 1 && product.stock > 0;
      const hasBundleStock = skus.some((sku) => sku.stock > 0);
      const valid = hasProductStock && hasBundleStock;
      const required = discount.type === 0 || entry.type === 1;
      if (!valid) {
        if (required) requiredProductInvalid = true;
        continue;
      }

      let minSkuCents = Number.MAX_SAFE_INTEGER;
      let maxProductSavings = 0;
      const productValue = skus.map((sku) => {
        const sourceSku = productSkuBySuk.get(`${entry.productId}:${sku.suk}`);
        const packagePriceCents = amountToCents(sku.price);
        const sourcePriceCents = amountToCents(sourceSku?.price ?? product.price);
        minSkuCents = Math.min(minSkuCents, packagePriceCents);
        maxProductSavings = Math.max(maxProductSavings, sourcePriceCents - packagePriceCents, 0);
        return {
          ...sku,
          product_price: centsToAmount(sourcePriceCents),
          product_stock: sku.stock,
        };
      });
      minPriceCents += minSkuCents === Number.MAX_SAFE_INTEGER ? 0 : minSkuCents;
      maxSavingsCents += maxProductSavings;
      validProducts.push({
        ...entry,
        discount_id: entry.discountId,
        product_id: entry.productId,
        product_type: entry.productType,
        store_name: entry.title,
        temp_id: entry.tempId,
        product,
        productValue,
        product_value: productValue,
      });
    }

    if (
      requiredProductInvalid || !validProducts.length ||
      (discount.type === 1 && validProducts.length < 2)
    ) continue;
    result.push({
      ...discount,
      products: validProducts,
      min_price: centsToAmount(minPriceCents),
      max_discounts_price: centsToAmount(maxSavingsCents),
    });
  }
  return result;
}

export class StoreDiscountService {
  constructor(private readonly container: Container) {}

  /** Create one direct-buy cart row per selected package entry atomically. */
  async createDirectBuyCarts(
    uid: number,
    discountId: number,
    selections: DiscountPackageSelectionInput[],
  ): Promise<{ cartId: number[]; cartIds: number[]; cartNum: number; discountId: number }> {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("用户参数错误");
    return withTx(this.container, async (tx) => {
      const scoped = createContainerFromDb(tx);
      const resolved = await resolveDiscountPackageSelection(scoped, {
        discountId,
        selections,
        uniqueKind: "package",
      });
      await tx
        .update(storeCart)
        .set({ isDel: 1 })
        .where(
          and(
            eq(storeCart.uid, uid),
            eq(storeCart.type, 5),
            eq(storeCart.isNew, 1),
            eq(storeCart.isPay, 0),
            eq(storeCart.isDel, 0),
          ),
        );
      const now = Math.floor(Date.now() / 1000);
      const inserted = await tx
        .insert(storeCart)
        .values(
          resolved.items.map(({ product, baseSku }) => ({
            uid,
            type: 5,
            productId: product.id,
            productType: product.productType,
            activityId: resolved.discount.id,
            productAttrUnique: baseSku.unique,
            cartNum: 1,
            addTime: now,
            isNew: 1,
            status: 1,
          })),
        )
        .returning({ id: storeCart.id });
      if (inserted.length !== resolved.items.length) {
        throw new Error("套餐购物车写入不完整");
      }
      const cartIds = inserted.map(({ id }) => id);
      return {
        cartId: cartIds,
        cartIds,
        cartNum: cartIds.length,
        discountId: resolved.discount.id,
      };
    });
  }

  /** PHP GET store_discounts/list/:product_id. */
  async listForProduct(productId: number, page = 1, limit = 10) {
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      throw new ValidateException("商品参数错误");
    }
    const safePage = Number.isSafeInteger(page) && page > 0 ? page : 1;
    const safeLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 10;
    const now = Math.floor(Date.now() / 1000);

    const discountRows = await this.container.db
      .selectDistinct({ discount: storeDiscounts })
      .from(storeDiscounts)
      .innerJoin(
        storeDiscountsProducts,
        and(
          eq(storeDiscountsProducts.discountId, storeDiscounts.id),
          eq(storeDiscountsProducts.productId, productId),
        ),
      )
      .where(
        and(
          eq(storeDiscounts.isDel, 0),
          eq(storeDiscounts.status, 1),
          or(
            and(eq(storeDiscounts.startTime, 0), eq(storeDiscounts.stopTime, 0)),
            and(lte(storeDiscounts.startTime, now), gte(storeDiscounts.stopTime, now)),
          ),
          or(eq(storeDiscounts.isLimit, 0), gt(storeDiscounts.limitNum, 0)),
        ),
      )
      .orderBy(desc(storeDiscounts.sort), desc(storeDiscounts.id))
      .limit(safeLimit)
      .offset((safePage - 1) * safeLimit);
    if (!discountRows.length) return [];

    const discountIds = discountRows.map(({ discount }) => discount.id);
    const productRows = await this.container.db
      .select({ entry: storeDiscountsProducts, product: storeProduct })
      .from(storeDiscountsProducts)
      .leftJoin(storeProduct, eq(storeProduct.id, storeDiscountsProducts.productId))
      .where(inArray(storeDiscountsProducts.discountId, discountIds))
      .orderBy(storeDiscountsProducts.discountId, storeDiscountsProducts.id);
    const entryIds = productRows.map(({ entry }) => entry.id);
    const productIds = [
      ...new Set(productRows.map(({ entry }) => entry.productId).filter((id) => id > 0)),
    ];
    const [bundleSkus, productSkus] = await Promise.all([
      entryIds.length
        ? this.container.db
            .select()
            .from(storeProductAttrValue)
            .where(
              and(
                inArray(storeProductAttrValue.productId, entryIds),
                eq(storeProductAttrValue.type, 5),
              ),
            )
            .orderBy(storeProductAttrValue.productId, storeProductAttrValue.id)
        : Promise.resolve([] as AttrValue[]),
      productIds.length
        ? this.container.db
            .select()
            .from(storeProductAttrValue)
            .where(
              and(
                inArray(storeProductAttrValue.productId, productIds),
                eq(storeProductAttrValue.type, 0),
              ),
            )
            .orderBy(storeProductAttrValue.productId, storeProductAttrValue.id)
        : Promise.resolve([] as AttrValue[]),
    ]);

    return assembleDiscountPackages(
      discountRows.map(({ discount }) => discount),
      productRows,
      bundleSkus,
      productSkus,
    );
  }
}
