import { and, asc, eq } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { storeProduct, storeProductAttrValue } from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { presaleSchedule } from "./PresaleScheduleService";
import { presalePurchaseLimits } from "./PresalePurchaseLimits";
import { presaleProductVisibility, readPresaleCatalogAccount, withPresaleCatalogSnapshot } from './PresaleCatalogSnapshot';

const MAX_SKUS = 500;
function productId(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2_147_483_647) {
    throw new ValidateException("预售商品ID无效");
  }
  return Number(value);
}
function integer(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) throw new ValidateException("预售库存或销量配置无效");
  return value;
}
function money(value: string): string {
  if (!/^\d{1,10}\.\d{2}$/.test(value)) throw new ValidateException("预售规格价格配置无效");
  return value;
}
function imageUrl(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2_048 || /[\u0000-\u0020\u007f\\]/u.test(value)) return "";
  if (/^\/(?!\/)/u.test(value)) return value;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? value : ""; }
  catch { return ""; }
}
function images(raw: string, primary: string): string[] {
  let parsed: unknown = [];
  // Optional media never enlarges the core response or invalidates usable SKUs.
  if (raw.length <= 65_536) { try { parsed = JSON.parse(raw); } catch { /* use the primary image */ } }
  const values = Array.isArray(parsed) ? parsed.slice(0, 20).map(imageUrl).filter(Boolean) : [];
  return [...new Set([imageUrl(primary), ...values].filter(Boolean))].slice(0, 20);
}

/** Opt-in, bounded read contract. Base product ID + type=0 SKU, never a type=6 SKU.
 * Does not quote a member price, reserve stock, create a cart, or enable checkout.
 * A single read-only snapshot prevents mixing product timing with later SKU edits.
 */
export class PresaleSkuCatalogService {
  constructor(private readonly container: Container) {}

  async read(uid: number, rawId: unknown, now = new Date()) {
    const id = productId(rawId);
    if (!Number.isSafeInteger(uid) || uid < 0 || uid > 2_147_483_647 || !Number.isFinite(now.getTime())) {
      throw new ValidateException("预售规格查询参数无效");
    }
    return withPresaleCatalogSnapshot(this.container, snapshot => new PresaleSkuCatalogService(snapshot).snapshot(uid, id, now));
  }

  private async snapshot(uid: number, id: number, now: Date) {
    const account = await readPresaleCatalogAccount(this.container.db, uid);
    const [product] = await this.container.db.select({
      id: storeProduct.id, title: storeProduct.storeName, subtitle: storeProduct.storeInfo,
      image: storeProduct.image, sliderImage: storeProduct.sliderImage, stock: storeProduct.stock,
      sales: storeProduct.sales, unitName: storeProduct.unitName, productType: storeProduct.productType,
      systemFormId: storeProduct.systemFormId, isPresaleProduct: storeProduct.isPresaleProduct,
      presaleStartTime: storeProduct.presaleStartTime, presaleEndTime: storeProduct.presaleEndTime,
      presaleDay: storeProduct.presaleDay, isLimit: storeProduct.isLimit,
      limitType: storeProduct.limitType, limitNum: storeProduct.limitNum,
    }).from(storeProduct).where(and(eq(storeProduct.id, id), eq(storeProduct.isShow, 1), eq(storeProduct.isDel, 0),
      eq(storeProduct.isVerify, 1), eq(storeProduct.isPresaleProduct, 1),
      presaleProductVisibility(account, now.getTime()))).limit(1);
    if (!product) throw new NotFoundException("预售商品不存在或不可见");
    const schedule = presaleSchedule(product, now), productStock = integer(product.stock);
    const purchaseLimits = presalePurchaseLimits(product);
    const rows = await this.container.db.select({ unique: storeProductAttrValue.unique, suk: storeProductAttrValue.suk,
      stock: storeProductAttrValue.stock, price: storeProductAttrValue.price, otPrice: storeProductAttrValue.otPrice,
      image: storeProductAttrValue.image }).from(storeProductAttrValue)
      .where(and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0)))
      .orderBy(asc(storeProductAttrValue.id)).limit(MAX_SKUS + 1);
    if (rows.length > MAX_SKUS) throw new ValidateException("预售规格超过500项，请先整理规格配置");
    const seen = new Set<string>();
    const skus = rows.map(row => {
      if (!row.unique || row.unique.length > 8 || /[\s\u0000-\u001f\u007f]/u.test(row.unique) || seen.has(row.unique)) {
        throw new ValidateException("预售规格标识不唯一或无效");
      }
      seen.add(row.unique);
      const available = Math.min(productStock, integer(row.stock));
      return { unique: row.unique, base_unique: row.unique, suk: row.suk,
        catalog_price: money(row.price), ot_price: money(row.otPrice), stock: available,
        // A selection bound, not a user allowance/reservation. Unimplemented
        // cumulative accounting must not advertise a purchasable quantity.
        max_quantity: purchaseLimits.mode === "cumulative" ? 0 : Math.min(available, 32_767,
          purchaseLimits.mode === "per_order" ? purchaseLimits.quantity : 32_767),
        image: imageUrl(row.image) || imageUrl(product.image) };
    });
    return { version: 1 as const, selection_only: true as const, type: 6 as const, product_id: id,
      payment_mode: "full" as const, title: product.title, subtitle: product.subtitle,
      image: imageUrl(product.image), images: images(product.sliderImage, product.image),
      sales: integer(product.sales), unit_name: product.unitName, product_type: product.productType,
      system_form_id: product.systemFormId, purchase_limits: purchaseLimits, schedule, skus };
  }
}
