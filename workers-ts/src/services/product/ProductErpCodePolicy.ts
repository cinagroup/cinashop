import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct, storeProductAttrValue, systemConfig } from '@/models/schema';
import { ERP_CONFIG_LOCK } from '@/services/erp/ErpConnectionPolicy';
import { normalizeConfigScalar } from '@/utils/config';
import { HttpApiException, ValidateException } from '@/utils/errors';
import { checkedProductCode, productErpCodePresent } from './ProductCodeInput';

const conflict = () => new HttpApiException('商品编码或ERP配置已变化，请刷新后重试', 409, 409);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
async function policyRows(tx: DbClient) {
  return tx.select({ id: systemConfig.id, name: systemConfig.menuName, isStore: systemConfig.isStore,
    value: sql<string>`left(${systemConfig.value},2049)` }).from(systemConfig)
    .where(and(eq(systemConfig.isStore, 0), eq(systemConfig.menuName, 'erp_open'))).orderBy(asc(systemConfig.id)).limit(2);
}
function flag(rows: Awaited<ReturnType<typeof policyRows>>): boolean | null {
  if (rows.length > 1 || rows.some(row => (row.value?.length ?? 0) > 2048)) return null;
  const value = normalizeConfigScalar(rows[0]?.value).toLowerCase();
  return ['', '0', 'false'].includes(value) ? false : ['1', 'true'].includes(value) ? true : null;
}
export async function readProductErpCodeFlag(tx: DbClient) { return flag(await policyRows(tx)); }

/** Shares the existing ERP writer handshake, without reading credentials or
 * activating a connection. A changing configuration fails before writes. */
export async function lockProductErpCodePolicy(tx: DbClient) {
  const [lock] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock_shared(${ERP_CONFIG_LOCK},0) AS locked`);
  if (!lock?.locked) throw conflict();
  const rows = await policyRows(tx), enabled = flag(rows);
  if (enabled === null) throw new ValidateException('ERP开关配置重复或无效，请先核对配置');
  return { rows, enabled };
}
export type ProductErpCodePolicy = Awaited<ReturnType<typeof lockProductErpCodePolicy>>;
export async function assertProductErpCodePolicy(tx: DbClient, policy: ProductErpCodePolicy) {
  if (!same(await policyRows(tx), policy.rows)) throw conflict();
}
const skuRows = (tx: DbClient, id: number) => tx.select().from(storeProductAttrValue)
  .where(and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 0)))
  .orderBy(asc(storeProductAttrValue.id)).limit(1001);

/** For the primitive Admin and full-form Out writers. The mature Admin and
 * Supplier coordinators keep their existing, broader main-row proofs. */
export async function productErpCodePlan(tx: DbClient, options: {
  productId: number; code: string; owner: { type: number; relationId: number };
  skus: readonly { suk: string; code: string }[] | undefined;
  policy: ProductErpCodePolicy | undefined;
}) {
  const { policy } = options;
  let expected = new Map<string, string>();
  if (policy?.enabled) {
    const persisted = options.skus === undefined ? await skuRows(tx, options.productId) : undefined;
    if (persisted && persisted.length > 1000) throw conflict();
    const skus = options.skus ?? persisted!.filter(row => row.isRetired === 0);
    if (!productErpCodePresent(checkedProductCode(options.code))) throw new ValidateException('开启ERP时须填写商品编码');
    if (!skus.length || skus.length > 1000 || skus.some(sku => !productErpCodePresent(checkedProductCode(sku.code))))
      throw new ValidateException('开启ERP时每个SKU均须填写编码');
    expected = new Map(skus.map(sku => [sku.suk, sku.code]));
    if (expected.size !== skus.length || persisted?.some(row => row.isRetired === 0 && row.productType !== 0)) throw conflict();
  }
  let captured: Awaited<ReturnType<typeof skuRows>> | undefined;
  return {
    async capture(tx: DbClient, id: number) {
      if (!policy?.enabled) return;
      captured = await skuRows(tx, id);
      const active = captured.filter(row => row.isRetired === 0);
      if (captured.length > 1000 || active.length !== expected.size
        || active.some(row => row.productType !== 0 || row.code !== expected.get(row.suk))) throw conflict();
    },
    async assert(tx: DbClient, id: number) {
      if (!policy) return;
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      await assertProductErpCodePolicy(tx, policy);
      if (!policy.enabled) return;
      const [main] = await tx.select({ code: storeProduct.code, type: storeProduct.type, relationId: storeProduct.relationId,
        productType: storeProduct.productType, isDel: storeProduct.isDel }).from(storeProduct).where(eq(storeProduct.id, id));
      if (!main || main.code !== options.code || main.type !== options.owner.type || main.relationId !== options.owner.relationId
        || main.productType !== 0 || main.isDel !== 0 || !captured || !same(await skuRows(tx, id), captured)) throw conflict();
    },
  };
}
