import { and, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemConfig, systemStore } from '@/models/schema';
import { normalizeConfigScalar } from '@/utils/config';
import { ValidateException } from '@/utils/errors';

const configValue = (name: string) => sql<string | null>`(SELECT ${systemConfig.value} FROM ${systemConfig}
  WHERE ${systemConfig.isStore}=0 AND ${systemConfig.menuName}=${name}
  ORDER BY ${systemConfig.sort} DESC, ${systemConfig.id} DESC LIMIT 1)`;
function enabled(value: string | null, fallback: string): boolean {
  const scalar = value === null ? fallback : normalizeConfigScalar(value);
  if (!['', '0', '1'].includes(scalar)) throw new ValidateException('到店自提开关配置无效');
  return scalar === '1';
}
const storeFields = {
  id: systemStore.id, name: systemStore.name, phone: systemStore.phone,
  address: systemStore.address, detailedAddress: systemStore.detailedAddress,
  province: systemStore.province, city: systemStore.city, area: systemStore.area, street: systemStore.street,
  dayTime: systemStore.dayTime, latitude: systemStore.latitude, longitude: systemStore.longitude,
};

/** Global SQL authority in one snapshot, including hidden historical winners.
 * Directory visibility remains a separate contract. Missing self-mention is off. */
export async function readCheckoutPickupEnabled(db: DbClient): Promise<boolean> {
  const [row] = await db.select({ func: configValue('store_func_status'), self: configValue('store_self_mention') })
    .from(sql`(VALUES (1)) pickup_policy(n)`);
  if (!row) throw new ValidateException('到店自提配置读取失败');
  const func = enabled(row.func, '1'), self = enabled(row.self, '0');
  return func && self;
}

/** Quote facts bind the actual pickup location. Coupon discovery may omit the
 * location but still cannot advertise pickup while the global switch is off. */
export async function readCheckoutPickupPolicy(db: DbClient, storeId: number, allowUnselected = false) {
  if (!Number.isSafeInteger(storeId) || storeId < (allowUnselected ? 0 : 1) || storeId > 2_147_483_647)
    throw new ValidateException('请选择有效的自提门店');
  const [row] = await db.select({ ...storeFields, func: configValue('store_func_status'), self: configValue('store_self_mention') })
    .from(sql`(VALUES (1)) pickup_policy(n)`)
    .leftJoin(systemStore, and(eq(systemStore.id, storeId), eq(systemStore.isStore, 1),
      eq(systemStore.isShow, 1), eq(systemStore.isDel, 0)));
  if (!row) throw new ValidateException('到店自提配置读取失败');
  const func = enabled(row.func, '1'), self = enabled(row.self, '0');
  if (!(func && self))
    throw new ValidateException('到店自提已关闭，请重新选择配送方式');
  const { func: _func, self: _self, ...store } = row;
  if (storeId > 0 && !store.id) throw new ValidateException('自提门店不存在或已暂停营业');
  return { enabled: true as const, store: storeId === 0 ? null : store };
}

/** FOR SHARE protects ordinary metadata UPDATE too; KEY SHARE only guards keys.
 * NOWAIT avoids waiting behind an editor holding config before store locks. */
export async function lockCheckoutPickupStore(tx: DbClient, storeId: number): Promise<void> {
  const [row] = await tx.select({ id: systemStore.id }).from(systemStore)
    .where(and(eq(systemStore.id, storeId), eq(systemStore.isStore, 1), eq(systemStore.isShow, 1), eq(systemStore.isDel, 0)))
    .limit(1).for('share', { noWait: true });
  if (!row) throw new ValidateException('自提门店不存在或已暂停营业');
}
