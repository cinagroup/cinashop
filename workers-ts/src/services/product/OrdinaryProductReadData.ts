import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeBrand, storeCart, storeProduct, storeProductAttr, storeProductAttrValue } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { integralDetailMoney, integralDetailText } from '@/services/activity/IntegralProductDetailData';
import { publicProductPictures } from '@/services/activity/ProductAssetPolicy';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';

/** Buyer-visible ownership, independent of SKU/activity type. No purchase
 * decision uses a card/list price; the cart and checkout re-read authority. */
export function publicOrdinaryProductIdentitySql(alias = 'store_product') {
  if (!/^[a-z_][a-z_0-9]*$/.test(alias)) throw new Error('Invalid product SQL alias'); const p = sql.raw(alias);
  return sql`${p}.id>0 AND ${p}.is_show=1 AND ${p}.is_del=0 AND ${p}.is_verify=1 AND ${p}.product_type BETWEEN 0 AND 4 AND ${p}.pid>=0 AND ${p}.pid<>${p}.id
    AND ((${p}.type=0 AND ${p}.relation_id=0 AND ${p}.pid=0)
      OR (${p}.type=1 AND ${p}.relation_id>0 AND EXISTS(SELECT 1 FROM system_store public_owner_store WHERE public_owner_store.id=${p}.relation_id AND public_owner_store.is_store=1 AND public_owner_store.is_show=1 AND public_owner_store.is_del=0))
      OR (${p}.type=2 AND ${p}.relation_id>0 AND EXISTS(SELECT 1 FROM system_supplier public_owner_supplier WHERE public_owner_supplier.id=${p}.relation_id AND public_owner_supplier.is_show=1 AND public_owner_supplier.is_del=0)))
    AND (${p}.pid=0 OR EXISTS(SELECT 1 FROM store_product public_parent WHERE public_parent.id=${p}.pid AND public_parent.pid=0 AND public_parent.type=0 AND public_parent.relation_id=0 AND public_parent.product_type=${p}.product_type
      AND public_parent.is_show=1 AND public_parent.is_del=0 AND public_parent.is_verify=1))`;
}
export const ORDINARY_PRODUCT_SKU_LIMIT = 500;
function money(value: string) { const result = integralDetailMoney(value); if (result === null) throw new ValidateException('商品报价无效，不能展示为零价'); return result; }
function counter(value: number) { if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw new ValidateException('商品库存数据无效'); return value; }
function dimensions(raw: string) {
  if (new TextEncoder().encode(raw).byteLength > 20000) throw new ValidateException('商品规格维度超过完整读取容量');
  let values: unknown;
  try { values = parseLevelActivationJson(raw); } catch {
    if (/^[\s]*[\[{"]/u.test(raw)) throw new ValidateException('商品规格JSON损坏');
    values = raw.split(',');
  }
  if (!Array.isArray(values) || !values.length || values.length > 100 || values.some(value => typeof value !== 'string' || !value.trim() || !integralDetailText(value, 255))) throw new ValidateException('商品规格维度无效');
  const result = (values as string[]).map(value => value.trim()); if (new Set(result).size !== result.length) throw new ValidateException('商品规格维度重复'); return result;
}
/** Safe SQL projection. No cost, settlement, codes, card stock or commissions
 * are selected, returned or used as a UI amount. Media is checked in the same
 * snapshot, and the caller signs it after that transaction ends. */
export async function readOrdinaryProductSnapshot(tx: DbClient, id: number, uid: number, type: number) {
  const [product] = await tx.select({ id: storeProduct.id, pid: storeProduct.pid, type: storeProduct.type, relationId: storeProduct.relationId,
    storeName: storeProduct.storeName, storeInfo: storeProduct.storeInfo, image: storeProduct.image, sliderImage: sql<string>`left(${storeProduct.sliderImage},20001)`,
    price: storeProduct.price, vipPrice: storeProduct.vipPrice, otPrice: storeProduct.otPrice, productType: storeProduct.productType,
    specType: storeProduct.specType, stock: storeProduct.stock, sales: storeProduct.sales, ficti: storeProduct.ficti, unitName: storeProduct.unitName,
    isShow: storeProduct.isShow, isDel: storeProduct.isDel, isVerify: storeProduct.isVerify, isVip: storeProduct.isVip, isVipProduct: storeProduct.isVipProduct,
    isPresaleProduct: storeProduct.isPresaleProduct, presaleStartTime: storeProduct.presaleStartTime, presaleEndTime: storeProduct.presaleEndTime,
    systemFormId: storeProduct.systemFormId, ensureId: sql<string>`left(${storeProduct.ensureId},2001)`, brandId: storeProduct.brandId,
    deliveryType: storeProduct.deliveryType, cateId: storeProduct.cateId, videoOpen: storeProduct.videoOpen, videoLink: storeProduct.videoLink,
    star: storeProduct.star, isLimit: storeProduct.isLimit, limitType: storeProduct.limitType, limitNum: storeProduct.limitNum,
    specs: sql<string|null>`left(${storeProduct.specs},100001)`, recommendList:storeProduct.recommendList,
    customFormPresent: sql<boolean>`COALESCE(btrim(${storeProduct.customForm}) NOT IN ('','[]','null','{}'),false)` })
    .from(storeProduct).where(and(eq(storeProduct.id, id), publicOrdinaryProductIdentitySql())).limit(1);
  if (!product) throw new NotFoundException('商品不存在或已下架');
  const rows = await tx.select({ id: storeProductAttrValue.id, unique: storeProductAttrValue.unique, suk: storeProductAttrValue.suk,
    price: storeProductAttrValue.price, vipPrice: storeProductAttrValue.vipPrice, otPrice: storeProductAttrValue.otPrice,
    stock: storeProductAttrValue.stock, sales: storeProductAttrValue.sales, image: storeProductAttrValue.image, productType: storeProductAttrValue.productType })
    .from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, type), eq(storeProductAttrValue.isRetired, 0)))
    .orderBy(asc(storeProductAttrValue.id)).limit(ORDINARY_PRODUCT_SKU_LIMIT + 1);
  if (rows.length > ORDINARY_PRODUCT_SKU_LIMIT) throw new ValidateException('商品规格超过完整读取容量');
  const unique = rows.map(row => row.unique.replace(/ +$/u, ''));
  if (unique.some(value => !value || value.length > 8 || /[\s\u0000-\u001f\u007f]/u.test(value)) || new Set(unique).size !== unique.length
    || new Set(rows.map(row => row.suk)).size !== rows.length || rows.some(row => !integralDetailText(row.suk, 512) || row.productType !== product.productType)) throw new ValidateException('商品规格身份冲突，不能自动选择');
  const attrs = await tx.select({ attrName: storeProductAttr.attrName, attrValues: sql<string>`left(${storeProductAttr.attrValues},20001)` })
    .from(storeProductAttr).where(and(eq(storeProductAttr.productId, id), eq(storeProductAttr.type, type))).orderBy(asc(storeProductAttr.id)).limit(11);
  if (attrs.length > 10 || attrs.some(row => !integralDetailText(row.attrName, 100)) || new Set(attrs.map(row => row.attrName)).size !== attrs.length) throw new ValidateException('商品规格维度无效或超过容量');
  const productAttr = attrs.map(row => ({ attr_name: row.attrName, attr_values: dimensions(row.attrValues) }));
  if (productAttr.length && rows.some(row => {
    const parts = row.suk.split(',');
    return parts.length !== productAttr.length || parts.some((value,index) => !productAttr[index].attr_values.includes(value));
  })) throw new ValidateException('商品SKU与规格维度不一致');
  const cart = uid > 0 && type === 0 && unique.length ? await tx.select({ unique: storeCart.productAttrUnique, quantity: sql<string>`SUM(${storeCart.cartNum})::text` })
    .from(storeCart).where(and(eq(storeCart.uid, uid), eq(storeCart.productId, id), eq(storeCart.type, 0), eq(storeCart.activityId, 0), eq(storeCart.isPay, 0),
      eq(storeCart.isDel, 0), eq(storeCart.isNew, 0), eq(storeCart.status, 1), inArray(storeCart.productAttrUnique, unique))).groupBy(storeCart.productAttrUnique) : [];
  const quantities = new Map(cart.map(row => [row.unique, counter(Number(row.quantity))]));
  const skus = rows.map((row, index) => ({ id: row.id, unique: unique[index], suk: row.suk, price: money(row.price), vip_price: money(row.vipPrice),
    ot_price: money(row.otPrice), stock: Math.min(counter(row.stock), counter(product.stock)), sales: counter(row.sales), image: row.image, cart_num: quantities.get(unique[index]) ?? 0 }));
  let gallery: unknown = [];
  if (product.sliderImage) { try { gallery = parseLevelActivationJson(product.sliderImage); } catch { gallery = []; } }
  if (!Array.isArray(gallery) || gallery.length > 20 || gallery.some(value => typeof value !== 'string')) throw new ValidateException('商品图片超过完整读取容量或格式无效');
  const owner = product.type === 1 ? { type: 0, relationId: 0 } : { type: product.type, relationId: product.relationId };
  const references = await publicProductPictures(tx, [product.image, ...gallery as string[], ...skus.map(row => row.image)].map(image => ({ ...owner, image })));
  const [brand] = product.brandId > 0 ? await tx.select({ name: storeBrand.brandName }).from(storeBrand).where(and(eq(storeBrand.id, product.brandId), eq(storeBrand.isShow, 1), eq(storeBrand.isDel, 0))).limit(1) : [];
  return { product: { ...product, price: money(product.price), vipPrice: money(product.vipPrice), otPrice: money(product.otPrice), stock: counter(product.stock) },
    skus, productAttr, galleryLength: gallery.length, references, brandName: integralDetailText(brand?.name, 100),
    cartButton: product.productType !== 0 || product.isPresaleProduct !== 0 || product.systemFormId > 0 || product.customFormPresent ? 0 : 1 };
}
