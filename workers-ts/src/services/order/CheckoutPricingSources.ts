import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { memberRight, systemConfig } from '@/models/schema';
import { normalizeConfigScalar } from '@/utils/config';
import { ValidateException } from '@/utils/errors';

const PRICING_KEYS = [
  'member_func_status', 'member_card_status', 'svip_price_status',
  'integral_ratio_status', 'integral_ratio', 'integral_max_type', 'integral_max_num', 'integral_max_rate',
  'whole_free_shipping', 'store_free_postage', 'offline_postage',
] as const;
type PricingRight = Pick<typeof memberRight.$inferSelect, 'rightType' | 'number' | 'status'>;

/** One SQL/MVCC snapshot for the fixed 11 keys and two rights; no KV authority.
 * Config priority matches SystemConfigDao (global scope, sort DESC/id DESC).
 * Config status is field visibility, NOT a switch. Rights retain the legacy
 * lowest-id winner, even when disabled. Missing/empty normalization is unchanged.
 * Scalar LIMITs bound data returned to the Worker despite historical duplicates.
 */
export async function readCheckoutPricingSources(db: DbClient) {
  const configPairs = PRICING_KEYS.flatMap(name => [sql`${name}::text`, sql`(
    SELECT ${systemConfig.value} FROM ${systemConfig}
    WHERE ${systemConfig.isStore} = 0 AND ${systemConfig.menuName} = ${name}
    ORDER BY ${systemConfig.sort} DESC, ${systemConfig.id} DESC LIMIT 1
  )`]);
  const right = (name: string) => sql<PricingRight | null>`(
    SELECT json_build_object('rightType', ${memberRight.rightType}, 'number', ${memberRight.number}, 'status', ${memberRight.status})
    FROM ${memberRight} WHERE ${memberRight.rightType} = ${name}
    ORDER BY ${memberRight.id} LIMIT 1
  )`;
  const [row] = await db.select({
    values: sql<Record<string, string | null>>`json_build_object(${sql.join(configPairs, sql`, `)})`,
    vip: right('vip_price'), express: right('express'),
  }).from(sql`(VALUES (1)) checkout_pricing_source(n)`);
  if (!row) throw new ValidateException('订单计价配置读取失败');
  return {
    values: Object.fromEntries(PRICING_KEYS.map(name => [name, normalizeConfigScalar(row.values[name] ?? '')])),
    rightRows: [row.vip, row.express].filter((value): value is PricingRight => value !== null),
  };
}

/** Late transaction fence, then caller re-reads the semantic pricing projection.
 * Row locks alone cannot guard absent keys, duplicate-winner INSERTs or renames.
 * SHARE intentionally blocks ALL writes/maintenance on both tables to commit;
 * concurrent checkout readers coexist. NOWAIT avoids reverse-order waits behind
 * editors. This broad lock's production contention still needs explicit validation.
 */
export async function protectCheckoutPricingSources(tx: DbClient): Promise<void> {
  const [isolation] = await tx.select({ value: sql<string>`current_setting('transaction_isolation')` })
    .from(sql`(VALUES (1)) checkout_pricing_isolation(n)`);
  if (isolation?.value !== 'read committed') {
    throw new ValidateException('订单计价重验必须使用READ COMMITTED事务，请重试');
  }
  try {
    await tx.execute(sql`LOCK TABLE ${memberRight}, ${systemConfig} IN SHARE MODE NOWAIT`);
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && cause.code === '55P03') throw new ValidateException('订单计价配置正在更新，请稍后重新确认');
      if (!('cause' in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    throw error;
  }
}
