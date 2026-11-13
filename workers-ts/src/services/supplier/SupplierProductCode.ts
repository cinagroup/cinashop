import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct, storeProductAttrValue } from '@/models/schema';
import { HttpApiException, ValidateException } from '@/utils/errors';
import { checkedProductCode as checkedCode, productCodeInput, productErpCodePresent } from '@/services/product/ProductCodeInput';
import { assertProductErpCodePolicy, lockProductErpCodePolicy, readProductErpCodeFlag, type ProductErpCodePolicy } from '@/services/product/ProductErpCodePolicy';

const conflict = () => new HttpApiException('商品编码或ERP配置已变化，请刷新后重试', 409, 409);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const supplierProductCodeInput = productCodeInput;
export async function readSupplierProductCode(tx: DbClient, code: string) {
  return { version: 1 as const, code, erp_open: await readProductErpCodeFlag(tx) };
}
export const lockSupplierProductCodePolicy = lockProductErpCodePolicy;
type Policy = ProductErpCodePolicy;
type Product = typeof storeProduct.$inferSelect;
export function supplierProductCodePlan(type: number, code: string | undefined, existing: Product | undefined,
  skus: readonly { suk: string; code: string }[], policy?: Policy) {
  const expectedCode = code ?? existing?.code ?? '';
  if (type === 0 && policy?.enabled) {
    if (!productErpCodePresent(checkedCode(expectedCode))) throw new ValidateException('开启ERP时须填写商品编码');
    if (skus.some(sku => !productErpCodePresent(checkedCode(sku.code)))) throw new ValidateException('开启ERP时每个SKU均须填写编码');
  }
  let captured: typeof storeProductAttrValue.$inferSelect[] | undefined;
  const rows = (tx: DbClient, id: number) => tx.select().from(storeProductAttrValue)
    .where(and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 0)))
    .orderBy(asc(storeProductAttrValue.id)).limit(1001);
  return {
    async capture(tx: DbClient, id: number) {
      captured = await rows(tx, id);
      const active = captured.filter(row => row.isRetired === 0), expected = new Map(skus.map(sku => [sku.suk, sku.code]));
      if (captured.length > 1000 || active.length !== skus.length
        || active.some(row => row.productType !== type || row.code !== expected.get(row.suk))) throw conflict();
    },
    async assert(tx: DbClient, supplierId: number, id: number, expectedMain?: Product) {
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      if (policy) await assertProductErpCodePolicy(tx, policy);
      if (!expectedMain) return;
      const [actual] = await tx.select().from(storeProduct).where(eq(storeProduct.id, id));
      if (!actual || actual.type !== 2 || actual.relationId !== supplierId || ![0, 1, 3].includes(actual.productType)
        || actual.isDel !== 0 || actual.isShow !== 0 || actual.isVerify !== 0 || actual.code !== expectedCode
        || !same(actual, expectedMain) || !captured || !same(await rows(tx, id), captured)) throw conflict();
    },
  };
}
