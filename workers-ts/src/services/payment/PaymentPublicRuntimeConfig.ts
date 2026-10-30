import { createHash } from 'node:crypto';
import { and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { normalizeConfigScalar } from '@/utils/config';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';

const MERCHANT_KEYS = ['pay_weixin_mchid', 'pay_weixin_serial_no', 'site_url'] as const;
const SCOPES = {
  merchant: MERCHANT_KEYS,
  routine: [...MERCHANT_KEYS, 'routine_appId', 'pay_weixin_open'],
  official: [...MERCHANT_KEYS, 'wechat_appid', 'pay_weixin_open'],
  checkout: [...MERCHANT_KEYS, 'routine_appId', 'wechat_appid', 'pay_weixin_open', 'ali_pay_status',
    'balance_func_status', 'yue_pay_status', 'offline_pay_status'],
} as const;
export type PaymentPublicScope = keyof typeof SCOPES;
export interface PaymentPublicSnapshot {
  readonly scope: PaymentPublicScope;
  readonly stamp: string;
  readonly values: Readonly<Record<string, string>>;
}

/** Deterministic local configuration failure, separate from a SQL outage. */
export class PaymentPublicConfigurationError extends ServiceUnavailableException {}

/** Fixed public cohorts only. No OAuth Secret, merchant private key, cfg_* KV
 * or arbitrary caller-selected key enters this SQL snapshot. All platform
 * shadow metadata/xmin participates; store rows cannot select a public account.
 * This public digest proves source equality, not old UID/order ownership. */
export async function readPaymentPublicConfigInTx(tx: DbClient, scope: PaymentPublicScope): Promise<PaymentPublicSnapshot> {
  if (!Object.hasOwn(SCOPES, scope)) throw new ValidateException('支付公开配置读取范围无效');
  const rows = await tx.select({ ...getTableColumns(systemConfig), version: sql<string>`xmin::text` }).from(systemConfig)
    .where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, [...SCOPES[scope]])))
    .orderBy(desc(systemConfig.sort), desc(systemConfig.id)).limit(65);
  if (rows.length > 64 || new TextEncoder().encode(JSON.stringify(rows)).byteLength > 1024 * 1024)
    throw new PaymentPublicConfigurationError('支付公开配置超过完整读取容量，请维护后重试');
  const values = Object.freeze(Object.fromEntries(SCOPES[scope].map(key =>
    [key, normalizeConfigScalar(rows.find(row => row.menuName === key)?.value)])));
  const stamp = createHash('sha256').update('cinashop.payment.public-source.v1\0').update(scope)
    .update('\0').update(JSON.stringify(rows)).digest('hex');
  return Object.freeze({ scope, stamp, values });
}

export function readPaymentPublicConfig(container: Container, scope: PaymentPublicScope): Promise<PaymentPublicSnapshot> {
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SELECT set_config('statement_timeout','5s',true),set_config('lock_timeout','2s',true)`);
    return readPaymentPublicConfigInTx(tx, scope);
  });
}

/** Short SQL-only acceptance before a new Mini provider request. The Native
 * account gate already serializes shared merchant edits; Mini AppID edits use
 * their separate gate. Keep that order and never hold either across crypto,
 * HTTP, Redis or Queue. The future author/generic-writer closure remains a
 * prerequisite for enabling configuration saves, not a property of this helper. */
export async function withRoutinePaymentPublicSource<T>(container: Container, expected: PaymentPublicSnapshot,
  action: (bound: Container) => Promise<T>): Promise<T> {
  const scope = expected.scope, stamp = expected.stamp, values = { ...expected.values };
  if (scope !== 'routine' || !/^[a-f0-9]{64}$/u.test(stamp))
    throw new ValidateException('小程序支付配置来源无效');
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
    await tx.execute(sql`SELECT set_config('statement_timeout','5s',true),set_config('lock_timeout','2s',true),set_config('idle_in_transaction_session_timeout','5s',true)`);
    const [merchant] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock_shared(731664,0) AS locked`);
    if (merchant?.locked !== true) throw new ServiceUnavailableException('微信支付商户配置正在维护');
    const [routine] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock_shared(731666,0) AS locked`);
    if (routine?.locked !== true) throw new ServiceUnavailableException('小程序支付配置正在维护');
    const check = async () => {
      const current = await readPaymentPublicConfigInTx(tx, 'routine');
      if (current.stamp !== stamp || JSON.stringify(current.values) !== JSON.stringify(values))
        throw new ValidateException('小程序支付配置已变化，请重新发起');
    };
    await check(); const result = await action(createContainerFromDb(tx)); await check();
    const [deadline] = await tx.execute<{ valid: boolean }>(sql`SELECT clock_timestamp()<=transaction_timestamp()+interval '5 seconds' AS valid`);
    if (deadline?.valid !== true) throw new ServiceUnavailableException('小程序支付提交超过有效时限');
    return result;
  });
}
