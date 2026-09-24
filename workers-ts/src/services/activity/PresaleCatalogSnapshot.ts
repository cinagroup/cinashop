import { and, eq, inArray, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { storeProduct, user } from '@/models/schema';
import { ValidateException } from '@/utils/errors';

export function validatePresaleCatalogUid(uid: number): void {
  if (!Number.isSafeInteger(uid) || uid < 0 || uid > 2_147_483_647) throw new ValidateException('预售查询用户无效');
}
/** Narrow principal projection; never serialize account credentials or balances. */
export async function readPresaleCatalogAccount(db: DbClient, uid: number) {
  validatePresaleCatalogUid(uid);
  if (!uid) return null;
  const [account] = await db.select({ isEverLevel: user.isEverLevel, isMoneyLevel: user.isMoneyLevel, overdueTime: user.overdueTime })
    .from(user).where(and(eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0))).limit(1);
  if (!account) throw new ValidateException('请重新登录');
  return account;
}
/** Match purchase eligibility (lifetime OR unexpired paid member), not a cached flag.
 * This is read visibility only; cart/create retain their final DB-clock checks.
 */
export function presaleProductVisibility(account: Awaited<ReturnType<typeof readPresaleCatalogAccount>>, now: number) {
  const member = !!account && (account.isEverLevel === 1 || account.isMoneyLevel > 0 && now < account.overdueTime * 1000);
  return member ? inArray(storeProduct.isVipProduct, [0, 1]) : eq(storeProduct.isVipProduct, 0);
}
export async function withPresaleCatalogSnapshot<T>(container: Container, read: (snapshot: Container) => Promise<T>): Promise<T> {
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql.raw(`SELECT
      pg_catalog.set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
    return read(createContainerFromDb(tx));
  });
}
