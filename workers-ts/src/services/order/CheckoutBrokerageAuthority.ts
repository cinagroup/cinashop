import { and, asc, inArray, sql, type SQL } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { user, agentLevel } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { assertCheckoutPaidOrderQualifications, type PaidOrderQualification } from './CheckoutPaidOrderAuthority';

const accountColumns = {
  uid: user.uid, spreadUid: user.spreadUid, agentLevel: user.agentLevel,
  status: user.status, spreadOpen: user.spreadOpen, isPromoter: user.isPromoter,
  divisionType: user.divisionType, divisionId: user.divisionId, agentId: user.agentId, staffId: user.staffId,
  divisionStatus: user.divisionStatus, divisionPercent: user.divisionPercent, divisionEndTime: user.divisionEndTime,
};
const levelColumns = { id: agentLevel.id, status: agentLevel.status, isDel: agentLevel.isDel,
  oneBrokerage: agentLevel.oneBrokerage, twoBrokerage: agentLevel.twoBrokerage };

export type BrokerageAccountFacts = Pick<typeof user.$inferSelect, 'uid'> &
  Partial<Pick<typeof user.$inferSelect, keyof typeof accountColumns>>;
export type BrokerageLevelFacts = Pick<typeof agentLevel.$inferSelect, 'id'> &
  Partial<Pick<typeof agentLevel.$inferSelect, keyof typeof levelColumns>>;

/** Internal create-time dependencies, never customer quote terms or stored ledger.
 * Multiple roles for one row remain separate: contradictory observations fail closed.
 * Mode=3 additionally requires the installed paid-order write protocol; not SQL/KV config.
 */
export interface CheckoutBrokerageAuthority {
  accounts: BrokerageAccountFacts[];
  levels: BrokerageLevelFacts[];
  missingReference: boolean;
  divisionClocks: { uid: number; active: boolean }[];
  paidOrders: PaidOrderQualification[];
}

/** Last-stage row protection. Sorted SHARE NOWAIT locks add no reverse row wait;
 * keep all locks until the transaction commits. At most two bounded row-lock SELECTs,
 * plus mode=3 protocol validation and up to two locked aggregate reads when used.
 * Return a constant-bound clock predicate for evaluation AFTER all later SQL waits.
 */
export async function assertCheckoutBrokerageAuthority(
  tx: DbClient, expected: CheckoutBrokerageAuthority,
): Promise<SQL | undefined> {
  try {
    if (expected.missingReference) throw new ValidateException('分佣用户或等级引用缺失，请修复后重新确认');
    const ids = [...new Set([...expected.accounts.map(row => row.uid), ...expected.paidOrders.map(row => row.uid)])];
    const accounts = ids.length ? await tx.select(accountColumns).from(user).where(inArray(user.uid, ids))
      .orderBy(asc(user.uid)).for('share', { noWait: true }) : [];
    const byId = new Map(accounts.map(row => [row.uid, row]));
    for (const facts of expected.accounts) {
      const row = byId.get(facts.uid);
      if (!row || (Object.keys(facts) as (keyof BrokerageAccountFacts)[]).some(key => row[key] !== facts[key])) {
        throw new ValidateException('分佣接收人或推广关系已变化，请重新确认');
      }
    }
    const levelIds = [...new Set(expected.levels.map(row => row.id))];
    const levels = levelIds.length ? await tx.select(levelColumns).from(agentLevel).where(inArray(agentLevel.id, levelIds))
      .orderBy(asc(agentLevel.id)).for('share', { noWait: true }) : [];
    const levelsById = new Map(levels.map(row => [row.id, row]));
    for (const facts of expected.levels) {
      const row = levelsById.get(facts.id);
      if (!row || (Object.keys(facts) as (keyof BrokerageLevelFacts)[]).some(key => row[key] !== facts[key])) {
        throw new ValidateException('分佣等级权益已变化，请重新确认');
      }
    }
    await assertCheckoutPaidOrderQualifications(tx, expected.paidOrders);
    return and(...expected.divisionClocks.map(clock => {
      const row = byId.get(clock.uid);
      if (!row) throw new ValidateException('事业部分佣用户已变化，请重新确认');
      // Renewal is equivalent while eligibility stays the same. No early wall clock.
      return sql`(${row.divisionStatus} = 1 AND clock_timestamp() < to_timestamp(${row.divisionEndTime})) = ${clock.active}`;
    }));
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && cause.code === '55P03') throw new ValidateException('分佣权益正在更新，请稍后重新确认');
      if (!('cause' in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    throw error;
  }
}
