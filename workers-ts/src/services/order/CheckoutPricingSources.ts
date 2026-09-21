import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { memberRight, systemConfig } from '@/models/schema';
import { normalizeConfigScalar } from '@/utils/config';
import { ValidateException } from '@/utils/errors';
import { acquireCheckoutPricingLock } from '@/migrations/checkoutPricingLock';

const MEMBERSHIP_KEYS = [
  'member_func_status', 'member_card_status', 'svip_price_status',
] as const;
const PRICING_KEYS = [
  ...MEMBERSHIP_KEYS,
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
  return readPricingSources(db, PRICING_KEYS, true);
}

/** Same precedence and SQL snapshot for display/cart membership only: three
 * keys and the vip_price right, without unrelated shipping/integral reads. */
export async function readMembershipPricingSources(db: DbClient) {
  return readPricingSources(db, MEMBERSHIP_KEYS, false);
}

async function readPricingSources(db: DbClient, keys: readonly string[], includeExpress: boolean) {
  const configPairs = keys.flatMap(name => [sql`${name}::text`, sql`(
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
    vip: right('vip_price'), express: includeExpress ? right('express') : sql<null>`NULL`,
  }).from(sql`(VALUES (1)) checkout_pricing_source(n)`);
  if (!row) throw new ValidateException('订单计价配置读取失败');
  return {
    values: Object.fromEntries(keys.map(name => [name, normalizeConfigScalar(row.values[name] ?? '')])),
    rightRows: [row.vip, row.express].filter((value): value is PricingRight => value !== null),
  };
}

/** Late transaction fence, then caller re-reads the semantic pricing projection.
 * Row locks alone cannot guard absent keys, duplicate-winner INSERTs or renames.
 * SHARE intentionally blocks ALL writes/maintenance on both tables to commit;
 * concurrent checkout readers coexist. NOWAIT avoids reverse-order waits behind
 * editors. This broad lock's production contention still needs explicit validation.
 * The fixed capability must be installed in the schema actually resolving both
 * sources. Never lock public while reading a shadow/temp or isolated source.
 * Missing/drifted installation fails closed; no direct-LOCK or DML fallback.
 */
export async function protectCheckoutPricingSources(
  tx: DbClient, busyMessage = '订单计价配置正在更新，请稍后重新确认',
): Promise<void> {
  const [context] = await tx.execute(sql`SELECT
    pg_catalog.current_setting('transaction_isolation') AS isolation,
    pg_catalog.current_schema() AS namespace,
    pg_catalog.to_regclass('member_right') = pg_catalog.to_regclass(pg_catalog.format('%I.member_right',pg_catalog.current_schema()))
    AND pg_catalog.to_regclass('system_config') = pg_catalog.to_regclass(pg_catalog.format('%I.system_config',pg_catalog.current_schema()))
      AS "sameSources"`);
  if (context?.isolation !== 'read committed') {
    throw new ValidateException('订单计价重验必须使用READ COMMITTED事务，请重试');
  }
  if (typeof context.namespace !== 'string' || context.sameSources !== true) {
    throw new ValidateException('订单计价来源与锁保护范围不一致');
  }
  try {
    await acquireCheckoutPricingLock(tx, context.namespace);
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && cause.code === '55P03') throw new ValidateException(busyMessage);
      if (!('cause' in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    throw error;
  }
}
