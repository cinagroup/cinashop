import { sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { AuthException } from '@/utils/errors';
import { themeDeadlines } from '@/services/content/ThemeReadService';
import { readDistributionLedger } from './DistributionLedgerRead';
import type { DistributionLedgerMode, DistributionLedgerQuery } from './DistributionLedgerInput';

/** Account, filtered sums, ledger rows and owned withdrawal state are captured
 * by one bounded readonly repeatable snapshot. It has no external resources. */
export class DistributionLedgerService {
  constructor(private readonly container: Container) {}
  async read(uid: number, mode: DistributionLedgerMode, query: DistributionLedgerQuery) {
    if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 2147483647) throw new AuthException();
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await themeDeadlines(tx);
      const report = await readDistributionLedger({ db: tx }, uid, mode, query);
      return { owner_uid: uid, mode, query, count: report.count, income: report.income, expend: report.expend, list: report.list };
    });
  }
}
