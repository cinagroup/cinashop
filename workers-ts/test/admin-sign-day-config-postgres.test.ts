import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { systemGroup, systemGroupData, systemLog } from '../src/models/schema';
import { AdminSignDayConfigService } from '../src/services/admin/AdminSignDayConfigService';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { signDayConfigActor, signDayConfigFixture } from './helpers/signDayConfigFixture';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native sign-day configuration transaction contract', () => {
  let f: Awaited<ReturnType<typeof signDayConfigFixture>>;
  beforeEach(async () => { f = await signDayConfigFixture(); }, 30_000);
  afterEach(async () => { await f?.close(); }, 30_000);
  const input = (revision: string) => ({ revision, request_id: crypto.randomUUID(),
    day: ' 第三天 🌿 ', sign_num: 30, sort: 80, status: 1 });

  it('rolls back fixed group initialization and first row when its late receipt insert fails', async () => {
    await f.db.delete(systemGroupData);
    await f.db.delete(systemGroup);
    const body = input((await f.serviceFor().list()).revision);
    await f.exec(`CREATE FUNCTION reject_sign_day_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.type='sign_day_config' THEN RAISE EXCEPTION 'owned late receipt failure'; END IF; RETURN NEW; END $$`);
    await f.exec('CREATE TRIGGER reject_sign_day_receipt BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION reject_sign_day_receipt()');
    const failed = await outcome(f.serviceFor().mutate('create', undefined, body, signDayConfigActor));
    expect(failed.ok).toBe(false);
    expect(await f.db.select().from(systemGroup).where(eq(systemGroup.configName, 'sign_day_num'))).toEqual([]);
    expect(await f.db.select().from(systemGroupData)).toEqual([]);
    expect(await f.db.select().from(systemLog)).toEqual([]);
    await f.exec('DROP TRIGGER reject_sign_day_receipt ON system_log');
    await f.exec('DROP FUNCTION reject_sign_day_receipt()');
    expect((await f.serviceFor().mutate('create', undefined, body, signDayConfigActor)).operation).toBe('create');
  });

  it('uses fresh READ COMMITTED state after catalog lock even when the session defaults to REPEATABLE READ', async () => {
    const original = (await f.db.select().from(systemGroupData).where(eq(systemGroupData.id, 147)))[0];
    await f.db.insert(systemGroupData).values(Array.from({ length: 4 }, (_, n) => ({ gid: 55,
      value: original.value, sort: 90 - n, status: 1 })));
    const prior = await f.serviceFor().list();
    expect(prior.count).toBe(6);
    await withFinancePeers(f.db, async ([blocker, waiter]) => {
      await waiter.exec('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const [defaultLevel] = await waiter.db.select({ level: sql<string>`current_setting('default_transaction_isolation')` })
        .from(sql`(values (1)) as probe(n)`);
      expect(defaultLevel.level).toBe('repeatable read');
      let entered!: () => void, release!: () => void;
      const locked = new Promise<void>(resolve => { entered = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      const writer = blocker.db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(731698, 1)`);
        await tx.insert(systemGroupData).values({ gid: 55, value: original.value, sort: 50, status: 1 });
        entered();
        await hold;
      });
      await locked;
      const waiterService = new AdminSignDayConfigService(createContainerFromDb(waiter.db));
      const pending = outcome(waiterService.mutate('create', undefined, input(prior.revision), signDayConfigActor));
      try {
        await waitForFinanceBlock(f.db, waiter.pid, blocker.pid);
      } finally { release(); }
      await writer;
      const result = await pending;
      expect(result.ok).toBe(false);
      expect((await f.serviceFor().list()).count).toBe(7);
      expect(await f.db.select().from(systemLog)).toEqual([]);
    });
  });

  it('waits for an external legacy insert on the data table and then refuses a phantom eighth row', async () => {
    const original = (await f.db.select().from(systemGroupData).where(eq(systemGroupData.id, 147)))[0];
    await f.db.insert(systemGroupData).values(Array.from({ length: 4 }, (_, n) => ({ gid: 55,
      value: original.value, sort: 90 - n, status: 1 })));
    const prior = await f.serviceFor().list();
    expect(prior.count).toBe(6);
    await withFinancePeers(f.db, async ([external, admin]) => {
      let entered!: () => void, release!: () => void;
      const locked = new Promise<void>(resolve => { entered = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      // This writer deliberately never takes the service advisory lock. Its
      // ordinary ROW EXCLUSIVE table lock must still serialize Admin create.
      const legacy = external.db.transaction(async tx => {
        await tx.insert(systemGroupData).values({ gid: 55, value: original.value, sort: 50, status: 1 });
        entered();
        await hold;
      });
      await locked;
      const service = new AdminSignDayConfigService(createContainerFromDb(admin.db));
      const pending = outcome(service.mutate('create', undefined, input(prior.revision), signDayConfigActor));
      try { await waitForFinanceBlock(f.db, admin.pid, external.pid); }
      finally { release(); }
      await legacy;
      expect((await pending).ok).toBe(false);
      expect((await f.serviceFor().list()).count).toBe(7);
      expect(await f.db.select().from(systemLog)).toEqual([]);
    });
  });

  it('linearizes same-UUID submissions across independent sessions and rejects a competing actor', async () => {
    await withFinancePeers(f.db, async ([gate, first, second]) => {
      const serviceA = new AdminSignDayConfigService(createContainerFromDb(first.db));
      const serviceB = new AdminSignDayConfigService(createContainerFromDb(second.db));
      async function race(body: ReturnType<typeof input>, secondActor: { id: number }) {
        let entered!: () => void, release!: () => void;
        const locked = new Promise<void>(resolve => { entered = resolve; });
        const hold = new Promise<void>(resolve => { release = resolve; });
        const sentinel = gate.db.transaction(async tx => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(731698, 1)`);
          entered();
          await hold;
        });
        await locked;
        const a = outcome(serviceA.mutate('create', undefined, body, signDayConfigActor));
        const b = outcome(serviceB.mutate('create', undefined, body, secondActor));
        try {
          await Promise.all([waitForFinanceBlock(f.db, first.pid, gate.pid),
            waitForFinanceBlock(f.db, second.pid, gate.pid)]);
        } finally { release(); }
        await sentinel;
        return Promise.all([a, b]);
      }
      const same = input((await f.serviceFor().list()).revision);
      const [firstResult, secondResult] = await race(same, signDayConfigActor);
      expect(firstResult.ok).toBe(true);
      expect(secondResult).toEqual(firstResult);
      expect((await f.serviceFor().list()).count).toBe(3);
      expect(await f.db.select().from(systemLog)).toHaveLength(1);
      const cross = input((await f.serviceFor().list()).revision);
      const [actorA, actorB] = await race(cross, { id: 8 });
      expect([actorA.ok, actorB.ok].sort()).toEqual([false, true]);
      const winner = actorA.ok ? signDayConfigActor : { id: 8 };
      const loser = actorA.ok ? { id: 8 } : signDayConfigActor;
      expect((await f.serviceFor().receipt(cross.request_id, winner)).operation).toBe('create');
      await expect(f.serviceFor().receipt(cross.request_id, loser)).rejects.toThrow(/不存在/);
      expect((await f.serviceFor().list()).count).toBe(4);
      expect(await f.db.select().from(systemLog)).toHaveLength(2);
    });
  });

  it('waits for an external metadata update before locking the fixed group row and rejects stale row CAS', async () => {
    const prior = (await f.serviceFor().detail(147)).info;
    await withFinancePeers(f.db, async ([external, admin]) => {
      let entered!: () => void, release!: () => void;
      const locked = new Promise<void>(resolve => { entered = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      const writer = external.db.transaction(async tx => {
        await tx.update(systemGroup).set({ info: '外部元数据修订' }).where(eq(systemGroup.id, 55));
        entered();
        await hold;
      });
      await locked;
      const service = new AdminSignDayConfigService(createContainerFromDb(admin.db));
      const pending = outcome(service.mutate('status', 147,
        { revision: prior.revision, request_id: crypto.randomUUID(), status: 0 }, signDayConfigActor));
      try { await waitForFinanceBlock(f.db, admin.pid, external.pid); }
      finally { release(); }
      await writer;
      expect((await pending).ok).toBe(false);
      expect((await f.serviceFor().detail(147)).info.status).toBe(1);
      expect(await f.db.select().from(systemLog)).toEqual([]);
    });
  });

  it('uses fixed-name uniqueness to reject a concurrent missing-group insert without adopting its metadata', async () => {
    await f.db.delete(systemGroupData);
    await f.db.delete(systemGroup);
    const prior = await f.serviceFor().list();
    expect(prior.group_present).toBe(false);
    await withFinancePeers(f.db, async ([external, admin]) => {
      let entered!: () => void, release!: () => void;
      const locked = new Promise<void>(resolve => { entered = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      const writer = external.db.transaction(async tx => {
        await tx.insert(systemGroup).values({ id: 56, cateId: 1, configName: 'sign_day_num',
          name: '外部组', info: '外部竞争写入', fields: '[]' });
        entered();
        await hold;
      });
      await locked;
      const service = new AdminSignDayConfigService(createContainerFromDb(admin.db));
      const pending = outcome(service.mutate('create', undefined, input(prior.revision), signDayConfigActor));
      try { await waitForFinanceBlock(f.db, admin.pid, external.pid); }
      finally { release(); }
      await writer;
      expect((await pending).ok).toBe(false);
      expect(await f.db.select().from(systemGroup)).toMatchObject([{ id: 56, name: '外部组' }]);
      expect(await f.db.select().from(systemGroupData)).toEqual([]);
      expect(await f.db.select().from(systemLog)).toEqual([]);
    });
  });
});
