import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct, storeProductAttrValue, systemConfig } from '@/models/schema';
import { ERP_CONFIG_LOCK } from '@/services/erp/ErpConnectionPolicy';
import { normalizeConfigScalar } from '@/utils/config';
import { HttpApiException, ValidateException } from '@/utils/errors';
import { productCodeValue } from '../../../../view/common/productCode';

const conflict = () => new HttpApiException('商品编码或ERP配置已变化，请刷新后重试', 409, 409);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function checkedCode(raw: unknown): string {
  try { return productCodeValue(raw); }
  catch (error) { throw new ValidateException((error as Error).message); }
}
export function supplierProductCodeInput(raw: Record<string, unknown>): string | undefined {
  return !Object.hasOwn(raw, 'code') || raw.code === undefined ? undefined : checkedCode(raw.code);
}

async function policyRows(tx: DbClient) {
  return tx.select({ id: systemConfig.id, name: systemConfig.menuName, isStore: systemConfig.isStore,
    value: sql<string>`left(${systemConfig.value},2049)` }).from(systemConfig)
    .where(and(eq(systemConfig.isStore, 0), eq(systemConfig.menuName, 'erp_open'))).orderBy(asc(systemConfig.id)).limit(2);
}
type PolicyRows = Awaited<ReturnType<typeof policyRows>>;
function flag(rows: PolicyRows): boolean | null {
  if (rows.length > 1 || rows.some(row => (row.value?.length ?? 0) > 2048)) return null;
  const value = normalizeConfigScalar(rows[0]?.value).toLowerCase();
  return ['', '0', 'false'].includes(value) ? false : ['1', 'true'].includes(value) ? true : null;
}
export async function readSupplierProductCode(tx: DbClient, code: string) {
  return { version: 1 as const, code, erp_open: flag(await policyRows(tx)) };
}
/** Use the existing ERP configuration handshake; this reads no credentials
 * and does not activate an ERP connection or make a provider request. */
export async function lockSupplierProductCodePolicy(tx: DbClient) {
  const [lock] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock_shared(${ERP_CONFIG_LOCK},0) AS locked`);
  if (!lock?.locked) throw conflict();
  const rows = await policyRows(tx), enabled = flag(rows);
  if (enabled === null) throw new ValidateException('ERP开关配置重复或无效，请先核对配置');
  return { rows, enabled };
}
type Policy = Awaited<ReturnType<typeof lockSupplierProductCodePolicy>>;
type Product = typeof storeProduct.$inferSelect;
export function supplierProductCodePlan(type: number, code: string | undefined, existing: Product | undefined,
  skus: readonly { suk: string; code: string }[], policy?: Policy) {
  const expectedCode = code ?? existing?.code ?? '';
  if (type === 0 && policy?.enabled) {
    if (!checkedCode(expectedCode)) throw new ValidateException('开启ERP时须填写商品编码');
    if (skus.some(sku => !checkedCode(sku.code))) throw new ValidateException('开启ERP时每个SKU均须填写编码');
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
      if (policy && !same(await policyRows(tx), policy.rows)) throw conflict();
      if (!expectedMain) return;
      const [actual] = await tx.select().from(storeProduct).where(eq(storeProduct.id, id));
      if (!actual || actual.type !== 2 || actual.relationId !== supplierId || ![0, 1, 3].includes(actual.productType)
        || actual.isDel !== 0 || actual.isShow !== 0 || actual.isVerify !== 0 || actual.code !== expectedCode
        || !same(actual, expectedMain) || !captured || !same(await rows(tx, id), captured)) throw conflict();
    },
  };
}
