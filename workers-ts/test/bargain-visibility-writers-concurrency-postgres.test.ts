import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { ActivityJoinService } from '../src/services/activity/ActivityJoinService';
import { AdminMobileProductService } from '../src/services/admin/AdminMobileProductService';
import { OutProductService } from '../src/services/out/OutProductService';
import { ProductAssociationService } from '../src/services/product/ProductAssociationService';
import { outProductWriteReplay, storeBargain, storeBargainUser, storeProduct,
  storeProductRelation, systemLog, user } from '../src/models/schema';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

type Writer = 'mobile' | 'association' | 'out';
type Admission = 'start' | 'help';
const actor = { id: 1, name: 'isolated-admin', ip: '127.0.0.1' };

// This suite runs only against a fixture-owned PG16 database. Trigger barriers
// hold a real writer or admission transaction after it has acquired the source
// advisory lock; pg_blocking_pids proves the other backend is waiting on it.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('all routed source visibility writers and bargain admission on PG16', () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;

  beforeEach(async () => {
    f = await createBargainSelectionFixture([storeProductRelation, systemLog, outProductWriteReplay]);
    await f.db.update(storeBargain).set({ people: 1 }).where(eq(storeBargain.id, 40));
    await f.db.update(storeBargainUser).set({ price: '0.00', status: 1 }).where(eq(storeBargainUser.id, 81));
    await f.db.insert(user).values({ uid: 30, account: 'visibility-writer-owner', nickname: '可见性参与者' });
    await f.db.insert(storeBargain).values({ id: 41, productId: 70, title: '同源第二活动',
      price: '10.00', minPrice: '2.00', people: 1, stock: 8, quota: 8,
      startTime: f.startTime, stopTime: f.stopTime });
    await f.db.insert(storeBargainUser).values({ id: 84, uid: 22, bargainId: 41,
      bargainPrice: '10.00', bargainPriceMin: '2.00', price: '0.00', status: 1 });
  }, 30_000);

  afterEach(async () => { await f?.close(); });

  const hide = async (writer: Writer, db: DbClient): Promise<void> => {
    const container = createContainerFromDb(db);
    switch (writer) {
      case 'mobile': await new AdminMobileProductService(container).setShow({ ids: [70], is_show: 0 }, actor); return;
      case 'association': await new ProductAssociationService(container).setShow(70, 0, actor); return;
      case 'out': await new OutProductService(container).setShow({ id: 7 }, 70, 0, crypto.randomUUID()); return;
    }
  };
  const admission = async (kind: Admission, db: DbClient): Promise<void> => {
    const join = new ActivityJoinService(createContainerFromDb(db));
    if (kind === 'start') await join.startBargain(30, 41);
    else await join.helpBargain(11, 84);
  };
  const history = async () => {
    const snapshot = await f.snapshot();
    return { participations: snapshot.participations, helps: snapshot.helps };
  };

  it.each(['mobile', 'association', 'out'] as const)('%s hide commits first: both activities reject new starts and help', async writer => {
    await f.exec(`CREATE FUNCTION qa_visibility_writer_hold() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id=70 THEN PERFORM pg_advisory_xact_lock(731635,70); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_visibility_writer_hold AFTER UPDATE OF is_show ON store_product
      FOR EACH ROW EXECUTE FUNCTION qa_visibility_writer_hold()`);
    const before = await history();
    await withFinancePeers(f.db, async ([gate, hiding, joining]) => {
      await gate.exec('BEGIN; SELECT pg_advisory_xact_lock(731635,70)');
      const pendingHide = outcome(hide(writer, hiding.db));
      await waitForFinanceBlock(f.db, hiding.pid, gate.pid);
      const pendingStart = outcome(admission('start', joining.db));
      await waitForFinanceBlock(f.db, joining.pid, hiding.pid);
      await gate.exec('COMMIT');
      expect(await pendingHide).toMatchObject({ ok: true });
      expect(await pendingStart).toMatchObject({ ok: false, error: { message: '砍价关联商品不可见或未审核' } });
      await expect(admission('help', joining.db)).rejects.toThrow('砍价关联商品不可见或未审核');
    });
    expect(await history()).toEqual(before);
    expect((await f.snapshot()).products.find(row => row.id === 70)).toMatchObject({ isShow: 0, isVerify: 1 });
  }, 20_000);

  it.each(['mobile', 'association', 'out'] as const)('%s hide commits first: an in-flight help waits and preserves history', async writer => {
    await f.exec(`CREATE FUNCTION qa_visibility_writer_hold() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id=70 THEN PERFORM pg_advisory_xact_lock(731635,70); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_visibility_writer_hold AFTER UPDATE OF is_show ON store_product
      FOR EACH ROW EXECUTE FUNCTION qa_visibility_writer_hold()`);
    const before = await history();
    await withFinancePeers(f.db, async ([gate, hiding, joining]) => {
      await gate.exec('BEGIN; SELECT pg_advisory_xact_lock(731635,70)');
      const pendingHide = outcome(hide(writer, hiding.db));
      await waitForFinanceBlock(f.db, hiding.pid, gate.pid);
      const pendingHelp = outcome(admission('help', joining.db));
      await waitForFinanceBlock(f.db, joining.pid, hiding.pid);
      await gate.exec('COMMIT');
      expect(await pendingHide).toMatchObject({ ok: true });
      expect(await pendingHelp).toMatchObject({ ok: false, error: { message: '砍价关联商品不可见或未审核' } });
    });
    expect(await history()).toEqual(before);
  }, 20_000);

  it.each([
    ['mobile', 'start'], ['mobile', 'help'],
    ['association', 'start'], ['association', 'help'],
    ['out', 'start'], ['out', 'help'],
  ] as const)('%s hide waits for an in-flight %s, then preserves its committed history', async (writer, kind) => {
    if (kind === 'start') {
      await f.exec(`CREATE FUNCTION qa_visibility_admission_hold() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.uid=30 AND NEW.bargain_id=41 THEN PERFORM pg_advisory_xact_lock(731635,70); END IF; RETURN NEW; END $$;
        CREATE TRIGGER qa_visibility_admission_hold AFTER INSERT ON store_bargain_user
        FOR EACH ROW EXECUTE FUNCTION qa_visibility_admission_hold()`);
    } else {
      await f.exec(`CREATE FUNCTION qa_visibility_admission_hold() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.bargain_user_id=84 THEN PERFORM pg_advisory_xact_lock(731635,70); END IF; RETURN NEW; END $$;
        CREATE TRIGGER qa_visibility_admission_hold AFTER INSERT ON store_bargain_user_help
        FOR EACH ROW EXECUTE FUNCTION qa_visibility_admission_hold()`);
    }
    await withFinancePeers(f.db, async ([gate, joining, hiding]) => {
      await gate.exec('BEGIN; SELECT pg_advisory_xact_lock(731635,70)');
      const pendingAdmission = outcome(admission(kind, joining.db));
      await waitForFinanceBlock(f.db, joining.pid, gate.pid);
      const pendingHide = outcome(hide(writer, hiding.db));
      await waitForFinanceBlock(f.db, hiding.pid, joining.pid);
      await gate.exec('COMMIT');
      expect(await pendingAdmission).toMatchObject({ ok: true });
      expect(await pendingHide).toMatchObject({ ok: true });
    });
    const after = await history();
    expect((await f.snapshot()).products.find(row => row.id === 70)?.isShow).toBe(0);
    if (kind === 'start') expect(after.participations.filter(row => row.uid === 30 && row.bargainId === 41)).toHaveLength(1);
    else expect(after.helps.filter(row => row.bargainUserId === 84)).toHaveLength(1);
    await expect(admission(kind === 'start' ? 'help' : 'start', f.db))
      .rejects.toThrow('砍价关联商品不可见或未审核');
  }, 20_000);

  it('mobile batch takes reversed input IDs in ascending source-lock order', async () => {
    await f.db.insert(storeProduct).values({ id: 71, storeName: 'second source', price: '10.00',
      stock: 8, isShow: 1, isVerify: 1, freight: 3, tempId: 10 });
    await withFinancePeers(f.db, async ([gate, hiding, probe]) => {
      await gate.exec('BEGIN; SELECT pg_advisory_xact_lock_shared(731634,70)');
      const pendingHide = outcome(new AdminMobileProductService(createContainerFromDb(hiding.db))
        .setShow({ ids: [71, 70], is_show: 0 }, actor));
      await waitForFinanceBlock(f.db, hiding.pid, gate.pid);
      await probe.exec('BEGIN');
      const [lock] = await probe.db.select({ acquired: sql<boolean>`pg_try_advisory_xact_lock(731634,71)` })
        .from(sql`(values (1)) as probe(n)`);
      expect(lock.acquired).toBe(true);
      await probe.exec('COMMIT');
      await gate.exec('COMMIT');
      expect(await pendingHide).toMatchObject({ ok: true, value: { changed: 2 } });
    });
    expect((await f.snapshot()).products.filter(row => row.id === 70 || row.id === 71)
      .map(row => row.isShow)).toEqual([0, 0]);
  }, 20_000);
});
