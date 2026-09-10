import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { user, systemUserLevel } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { activityRuleQuoteGuard } from '@/services/activity/ActivityRuleQuoteGuard';

export interface CheckoutMembershipSnapshot {
  uid: number;
  /** null means this pricing feature is disabled, not an inactive membership. */
  paidActive: boolean | null;
  levelId: number | null;
  level: Pick<typeof systemUserLevel.$inferSelect, 'id' | 'discount' | 'isShow' | 'isDel'> | null;
}

/** Called after business writes. Never wait in reverse order behind a user/level
 * editor: NOWAIT aborts the whole checkout instead of adding a deadlock edge.
 * Rows remain protected through commit. Only explicit pricing facts are compared;
 * user balances, names and renewal dates are not receipt versions.
 * The returned constant-bound predicate must be evaluated on the database clock
 * after all remaining potentially blocking SQL, not when these rows were read.
 */
export async function assertCheckoutMembershipSnapshot(
  tx: DbClient, expected: CheckoutMembershipSnapshot,
): Promise<SQL | undefined> {
  try {
    const [account] = await tx.select({ isEverLevel: user.isEverLevel, isMoneyLevel: user.isMoneyLevel, overdueTime: user.overdueTime })
      .from(user).where(and(eq(user.uid, expected.uid), eq(user.isDel, 0),
        expected.levelId !== null ? eq(user.level, expected.levelId) : undefined))
      .limit(1).for('share', { noWait: true });
    if (!account) throw new ValidateException('会员资格或等级已变化，请重新确认');
    if (expected.levelId !== null && expected.levelId > 0) {
      // An absent referenced row has no row lock. Do not authorize checkout with
      // a dangling level reference that a concurrent INSERT could turn into rights.
      if (!expected.level) throw new ValidateException('会员等级引用缺失，请修复后重新确认');
      const [level] = await tx.select({ id: systemUserLevel.id }).from(systemUserLevel).where(and(
        eq(systemUserLevel.id, expected.levelId), activityRuleQuoteGuard(expected.level, systemUserLevel),
      )).limit(1).for('share', { noWait: true });
      if (!level) throw new ValidateException('会员等级权益已变化，请重新确认');
    }
    return expected.paidActive === null ? undefined : sql`(
      ${account.isEverLevel} = 1 OR (${account.isMoneyLevel} > 0 AND clock_timestamp() < to_timestamp(${account.overdueTime}))
    ) = ${expected.paidActive}`;
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && cause.code === '55P03') throw new ValidateException('会员权益正在更新，请稍后重新确认');
      if (!('cause' in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    throw error;
  }
}
