import { and, desc, eq, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeProduct, systemConfig, systemStore } from '@/models/schema';
import { normalizeConfigScalar } from '@/utils/config';
import { ValidateException } from '@/utils/errors';

type PickupProduct = Pick<typeof storeProduct.$inferSelect, 'id' | 'type' | 'relationId' | 'productType'>;
type PickupSource = PickupProduct & { isShow: number; isDel: number };

function pickupSwitch(value: string | null, fallback: string): boolean {
  const normalized = value === null ? fallback : normalizeConfigScalar(value);
  if (!['', '0', '1'].includes(normalized)) throw new ValidateException('砍价自提开关配置无效');
  return normalized === '1';
}

function assertPickupSource(source: PickupSource | undefined, quoted: PickupProduct, storeId: number): void {
  if (!Number.isSafeInteger(storeId) || storeId <= 0 || storeId > 2_147_483_647) throw new ValidateException('请选择有效的砍价自提门店');
  if (!source || source.isShow !== 1 || source.isDel !== 0 || source.type !== quoted.type ||
    source.relationId !== quoted.relationId || source.productType !== quoted.productType ||
    ![0, 1, 2].includes(source.type) || (source.type === 0 ? source.relationId !== 0 : source.relationId <= 0) ||
    (source.type === 1 && source.relationId !== storeId)) {
    throw new ValidateException('砍价自提商品归属或履约类型已变化，请重新选择');
  }
}

/** Same priority as SystemConfigDao; bypass eventually-consistent KV. Missing
 * store_func_status defaults on in PHP, but missing/empty self-mention is off.
 * status is the admin field's visibility, not the configured switch value.
 */
export async function readBargainPickupEnabled(db: DbClient): Promise<boolean> {
  const enabled: boolean[] = [];
  for (const name of ['store_func_status', 'store_self_mention']) {
    const [row] = await db.select({ value: systemConfig.value }).from(systemConfig)
      .where(and(eq(systemConfig.isStore, 0), eq(systemConfig.menuName, name)))
      .orderBy(desc(systemConfig.sort), desc(systemConfig.id)).limit(1);
    enabled.push(pickupSwitch(row?.value ?? null, name === 'store_func_status' ? '1' : '0'));
  }
  return enabled.every(Boolean);
}

export async function boundBargainPickupTransaction(tx: DbClient): Promise<void> {
  await tx.execute(sql.raw(`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
}

/** Create caller owns the activity boundary and has not claimed carts yet.
 * Do NOT lock the source here: other checkout paths take SKUs before products.
 * The eventual inventory UPDATE must atomically compare the quoted owner/type.
 * New config/store locks are NOWAIT. Config table SHARE is intentional: historical duplicate keys and
 * missing defaults mean row locks cannot protect a higher-priority INSERT.
 * It briefly blocks ALL configuration writes until commit, not config reads.
 */
export async function assertBargainPickup(tx: DbClient, quoted: PickupProduct, storeId: number, lock = false): Promise<void> {
  if (!Number.isSafeInteger(storeId) || storeId <= 0 || storeId > 2_147_483_647) throw new ValidateException('请选择有效的砍价自提门店');
  try {
    const sourceQuery = tx.select({ id: storeProduct.id, type: storeProduct.type, relationId: storeProduct.relationId,
      productType: storeProduct.productType, isShow: storeProduct.isShow, isDel: storeProduct.isDel })
      .from(storeProduct).where(eq(storeProduct.id, quoted.id)).limit(1);
    const [source] = await sourceQuery;
    assertPickupSource(source, quoted, storeId);
    if (lock) await tx.execute(sql`LOCK TABLE ${systemConfig} IN SHARE MODE NOWAIT`);
    if (!(await readBargainPickupEnabled(tx))) throw new ValidateException('砍价门店自提已关闭，请重新选择配送方式');
    const storeQuery = tx.select({ id: systemStore.id }).from(systemStore)
      .where(and(eq(systemStore.id, storeId), eq(systemStore.isStore, 1), eq(systemStore.isShow, 1), eq(systemStore.isDel, 0))).limit(1);
    const [store] = await (lock ? storeQuery.for('share', { noWait: true }) : storeQuery);
    if (!store) throw new ValidateException('砍价自提门店不存在或已暂停营业');
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && cause.code === '55P03') throw new ValidateException('砍价自提规则正在更新，请稍后重试');
      if (!('cause' in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    throw error;
  }
}

export async function assertBargainPickupQuote(container: Container, product: PickupProduct, storeId: number): Promise<void> {
  if (!Number.isSafeInteger(storeId) || storeId <= 0 || storeId > 2_147_483_647) throw new ValidateException('请选择有效的砍价自提门店');
  await withTx(container, async tx => {
    await boundBargainPickupTransaction(tx);
    // A single statement provides a coherent read snapshot without changing an
    // enclosing caller's isolation/read-only mode (Drizzle may use a savepoint).
    const configValue = (name: string) => sql<string | null>`(SELECT ${systemConfig.value} FROM ${systemConfig}
      WHERE ${systemConfig.isStore}=0 AND ${systemConfig.menuName}=${name}
      ORDER BY ${systemConfig.sort} DESC, ${systemConfig.id} DESC LIMIT 1)`;
    const [row] = await tx.select({ id: storeProduct.id, type: storeProduct.type, relationId: storeProduct.relationId,
      productType: storeProduct.productType, isShow: storeProduct.isShow, isDel: storeProduct.isDel,
      storeId: systemStore.id, func: configValue('store_func_status'), self: configValue('store_self_mention') })
      .from(storeProduct).leftJoin(systemStore, and(eq(systemStore.id, storeId), eq(systemStore.isStore, 1),
        eq(systemStore.isShow, 1), eq(systemStore.isDel, 0)))
      .where(eq(storeProduct.id, product.id)).limit(1);
    assertPickupSource(row, product, storeId);
    const enabled = [pickupSwitch(row!.func, '1'), pickupSwitch(row!.self, '0')].every(Boolean);
    if (!enabled) throw new ValidateException('砍价门店自提已关闭，请重新选择配送方式');
    if (!row!.storeId) throw new ValidateException('砍价自提门店不存在或已暂停营业');
  });
}
