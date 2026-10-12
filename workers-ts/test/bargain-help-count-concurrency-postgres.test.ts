import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { storeBargain, storeBargainUser } from '../src/models/schema';
import { ActivityJoinService } from '../src/services/activity/ActivityJoinService';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

// A fixture-owned PostgreSQL 16 database is mandatory. RLS below only
// installs a read gate for a temporary role in that disposable database;
// application tables and production policies are untouched. Backend PIDs prove the
// helper can commit while the count read is inside its first SQL statement.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('bargain help count uses one committed PostgreSQL snapshot', () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  let readerRoleCreated = false;

  beforeEach(async () => {
    readerRoleCreated = false;
    f = await createBargainSelectionFixture();
    await f.db.update(storeBargain).set({ people: 1, bargainNum: 1 }).where(eq(storeBargain.id, 40));
    await f.db.update(storeBargainUser).set({ price: '0.00', status: 1 }).where(eq(storeBargainUser.id, 81));
  }, 30_000);

  afterEach(async () => {
    try {
      if (readerRoleCreated) await f.exec('DROP OWNED BY qa_help_count_reader; DROP ROLE qa_help_count_reader');
    } finally { await f?.close(); }
  });

  const count = (peer: Parameters<Parameters<typeof withFinancePeers>[1]>[0][number]) =>
    new ActivityJoinService(createContainerFromDb(peer.db)).bargainHelpCount(11, 81);
  const help = (peer: Parameters<Parameters<typeof withFinancePeers>[1]>[0][number]) =>
    new ActivityJoinService(createContainerFromDb(peer.db)).helpBargain(11, 81);
  const before = { userBargainStatus: true, count: 0, price: '8.00', status: 1,
    alreadyPrice: '0.00', pricePercent: 10 };
  const after = { userBargainStatus: false, count: 1, price: '0.00', status: 3,
    alreadyPrice: '8.00', pricePercent: 100 };

  it('read wins: a final cut committing during the first SELECT cannot mix old participation with new help count', async () => {
    // Only the dedicated reader backend invokes the gate function. The helper
    // stays on real SQL and never waits on this artificial test barrier.
    await f.db.execute(sql.raw(`CREATE FUNCTION qa_help_count_reader_gate(owner_uid integer) RETURNS boolean
      LANGUAGE plpgsql VOLATILE AS $$ BEGIN
        IF current_setting('qa.help_count_reader', true) = 'on' AND owner_uid = 22 THEN
          PERFORM pg_advisory_xact_lock(731650, 81);
        END IF;
        RETURN true;
      END $$;
      ALTER TABLE store_bargain_user ENABLE ROW LEVEL SECURITY;
      CREATE POLICY qa_help_count_read ON store_bargain_user FOR SELECT
        USING (qa_help_count_reader_gate(uid));
      CREATE POLICY qa_help_count_write ON store_bargain_user FOR UPDATE
        USING (true) WITH CHECK (true)`));
    await f.exec('CREATE ROLE qa_help_count_reader NOLOGIN');
    readerRoleCreated = true;
    await f.exec('GRANT USAGE ON SCHEMA public TO qa_help_count_reader; GRANT SELECT ON store_bargain_user, store_bargain_user_help TO qa_help_count_reader');

    await withFinancePeers(f.db, async ([gate, reader, helper]) => {
      await gate.exec('BEGIN; SELECT pg_advisory_xact_lock(731650, 81)');
      await reader.exec('SET ROLE qa_help_count_reader');
      await reader.exec("SET qa.help_count_reader = 'on'");
      try {
        const reading = outcome(count(reader));
        await waitForFinanceBlock(f.db, reader.pid, gate.pid);
        expect(await help(helper)).toEqual({ price: '8.00' });
        // The helper has committed, while the reader's first SELECT is still
        // blocked. A later SELECT would use a newer READ COMMITTED snapshot.
        await waitForFinanceBlock(f.db, reader.pid, gate.pid);
        await gate.exec('COMMIT');
        expect(await reading).toEqual({ ok: true, value: before });
        expect(await count(helper)).toEqual(after);
      } finally { await reader.exec('RESET ROLE'); }
    });
    expect((await f.snapshot()).helps).toHaveLength(1);
  }, 15_000);

  it('help starts first: a count during its uncommitted cut sees the old state, then a new read sees its commit', async () => {
    await f.exec(`CREATE FUNCTION qa_help_count_helper_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(731651, 81); RETURN NEW; END $$;
      CREATE TRIGGER qa_help_count_helper_gate AFTER INSERT ON store_bargain_user_help
      FOR EACH ROW EXECUTE FUNCTION qa_help_count_helper_gate()`);
    await withFinancePeers(f.db, async ([gate, reader, helper]) => {
      await gate.exec('BEGIN; SELECT pg_advisory_xact_lock(731651, 81)');
      const helping = outcome(help(helper));
      await waitForFinanceBlock(f.db, helper.pid, gate.pid);
      expect(await count(reader)).toEqual(before);
      await waitForFinanceBlock(f.db, helper.pid, gate.pid);
      await gate.exec('COMMIT');
      expect(await helping).toEqual({ ok: true, value: { price: '8.00' } });
      expect(await count(reader)).toEqual(after);
    });
    expect((await f.snapshot()).helps).toHaveLength(1);
  }, 15_000);
});
