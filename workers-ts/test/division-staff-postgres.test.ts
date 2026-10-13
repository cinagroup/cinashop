import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withTx, type DbClient } from '@/lib/di';
import { user } from '@/models/schema';
import { md5 } from '@/utils/jwt';
import { DivisionStaffService } from '@/services/division/DivisionStaffService';
import { DivisionManagementService } from '@/services/division/DivisionManagementService';
import { parseDivisionStaffList } from '@/services/division/DivisionStaffInput';
import { assertCheckoutBrokerageAuthority, type CheckoutBrokerageAuthority } from '@/services/order/CheckoutBrokerageAuthority';
import { divisionStaffFixture } from './helpers/divisionStaffFixture';

const ROLE = 1147879249, GATE = 932341;
describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('genuine native PostgreSQL employee role/cascade/checkout authority handshake', () => {
  let f: Awaited<ReturnType<typeof divisionStaffFixture>>, service: DivisionStaffService;
  beforeAll(async () => { f = await divisionStaffFixture(); if (!f.isNative()) throw Error('Native employee proof requires owned loopback PG16'); service = new DivisionStaffService(f.container); }, 30000);
  beforeEach(async () => { await f.seed(); });
  afterEach(async () => { vi.restoreAllMocks(); await f.exec('DROP TRIGGER IF EXISTS division_staff_native_gate ON "user"'); await f.exec('DROP FUNCTION IF EXISTS division_staff_native_gate()'); });
  afterAll(async () => { await f?.close(); }, 30000);
  const parentDelete = () => new DivisionManagementService(f.container).deleteRole(22, { level: 0, divisionId: 0,
    actor: { id: 1, authVersion: md5(f.password), expiresAt: Math.floor(Date.now() / 1000) + 3600 } });
  const expected: CheckoutBrokerageAuthority = { accounts: [{ uid: 44, divisionType: 3, agentId: 22, staffId: 44 },
    { uid: 55, divisionType: 0, agentId: 22, staffId: 44 }], levels: [], missingReference: false, divisionClocks: [], paidOrders: [] };
  async function hold(operation: (tx: DbClient) => Promise<unknown>) {
    let ready!: () => void, release!: () => void;
    const entered = new Promise<void>(yes => { ready = yes; }), blocked = new Promise<void>(yes => { release = yes; });
    const done = withTx(f.container, async tx => { await operation(tx); ready(); await blocked; });
    await Promise.race([entered, done.then(() => { throw Error('Native holder finished before entering'); })]);
    return { release, done };
  }
  async function gate(uid: number, id: number) {
    await f.exec(`CREATE FUNCTION division_staff_native_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.uid=${uid} AND NEW.division_type=0 THEN PERFORM pg_advisory_xact_lock(${GATE},${id}); END IF; RETURN NEW; END $$`);
    await f.exec('CREATE TRIGGER division_staff_native_gate BEFORE UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION division_staff_native_gate()');
    return hold(tx => tx.execute(sql`SELECT pg_advisory_xact_lock(${GATE}, ${id})`));
  }
  async function waiting(namespace: number, id: number) {
    const deadline = Date.now() + 1400;
    while (Date.now() < deadline) {
      const rows = await f.db.execute(sql`SELECT pid FROM pg_locks WHERE locktype='advisory'
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND classid=${namespace}::oid AND objid=${id}::oid AND NOT granted`);
      if (rows.length) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error('Actual owned PostgreSQL lock handshake was not observed within the existing business timeout');
  }
  it('proves current list transaction is native REPEATABLE READ READ ONLY and remains side-effect free', async () => {
    const original = f.db.transaction.bind(f.db), settings: unknown[] = [];
    vi.spyOn(f.db, 'transaction').mockImplementation((callback, ...options) => original(async tx => {
      const result = await callback(tx);
      settings.push(...await tx.execute(sql`SELECT current_setting('transaction_read_only') AS mode,current_setting('transaction_isolation') AS level`));
      return result;
    }, ...options));
    const before = await f.snapshot(); await service.list(f.actor(), parseDivisionStaffList({}));
    expect(settings).toEqual([{ mode: 'on', level: 'repeatable read' }]); expect(await f.snapshot()).toEqual(before);
  }, 20000);
  it('fails the employee write atomically while actual Admin parent cascade already owns its role key/user row', async () => {
    const before = await f.snapshot(), holder = await gate(22, 1), deleting = parentDelete();
    try { await waiting(GATE, 1); await expect(service.remove(f.actor(), 44)).rejects.toThrow('正在更新'); }
    finally { holder.release(); await holder.done; }
    await deleting;
    const after = await f.snapshot(); expect(after.users.filter(row => row.agentId === 22)).toEqual([]);
    expect(after.orders).toEqual(before.orders); expect(after.brokerage).toEqual(before.brokerage);
    await expect(service.bind(f.actor(77), { agentId: 22, agentCode: 0 })).rejects.toThrow('有效代理商');
  }, 20000);
  it('serializes actual Admin parent cascade after a protected employee unlink, observing its genuine wait and no reverse deadlock', async () => {
    const before = await f.snapshot(), holder = await gate(44, 2), removing = service.remove(f.actor(), 44);
    let deleting: Promise<void> | undefined;
    try { await waiting(GATE, 2); deleting = parentDelete(); await waiting(ROLE, 22); }
    finally { holder.release(); await holder.done; }
    await removing; await deleting;
    const after = await f.snapshot(); expect(after.users.find(row => row.uid === 44)).toMatchObject({ divisionType: 0, staffId: 0 });
    expect(after.users.find(row => row.uid === 22)).toMatchObject({ divisionType: 0 });
    expect(after.orders).toEqual(before.orders); expect(after.brokerage).toEqual(before.brokerage);
  }, 20000);
  it('fails unlink without mutation when mature actual checkout sorted SHARE protects the real beneficiary rows', async () => {
    const before = await f.snapshot(), holder = await hold(tx => assertCheckoutBrokerageAuthority(tx, expected));
    try { await expect(service.remove(f.actor(), 44)).rejects.toThrow('正在更新'); expect(await f.snapshot()).toEqual(before); }
    finally { holder.release(); await holder.done; }
    await service.remove(f.actor(), 44);
  }, 20000);
  it('makes mature actual checkout SHARE NOWAIT fail closed while unlink owns the recipient rows, then preserves all existing order/ledger snapshots', async () => {
    const before = await f.snapshot(), holder = await gate(44, 3), removing = service.remove(f.actor(), 44);
    try { await waiting(GATE, 3); await expect(withTx(f.container, tx => assertCheckoutBrokerageAuthority(tx, expected))).rejects.toThrow('分佣权益正在更新'); }
    finally { holder.release(); await holder.done; }
    await removing;
    const after = await f.snapshot(); expect(after.orders).toEqual(before.orders); expect(after.brokerage).toEqual(before.brokerage);
    await expect(withTx(f.container, tx => assertCheckoutBrokerageAuthority(tx, expected))).rejects.toThrow('关系已变化');
  }, 20000);
  it('permits only one actual concurrent bind to distinct agents and preserves one coherent role/parent tuple', async () => {
    const result = await Promise.allSettled([service.bind(f.actor(77), { agentId: 0, agentCode: 901 }), service.bind(f.actor(77), { agentId: 0, agentCode: 902 })]);
    expect(result.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    const [self] = await f.db.select().from(user).where(eq(user.uid, 77));
    expect([22, 30]).toContain(self.agentId); expect(self).toMatchObject({ divisionType: 3, staffId: 77, divisionId: 10, spreadUid: self.agentId });
  }, 20000);
  it('never leaves a cleared employee carrying a concurrently changed percentage', async () => {
    const before = await f.snapshot();
    await Promise.allSettled([service.percent(f.actor(), 44, 11), service.remove(f.actor(), 44)]);
    const after = await f.snapshot(), staff = after.users.find(row => row.uid === 44)!;
    if (staff.divisionType === 0) expect(staff.divisionPercent).toBe(0);
    else { expect(staff.divisionType).toBe(3); expect(staff.divisionPercent).toBe(11); }
    expect(after.orders).toEqual(before.orders); expect(after.brokerage).toEqual(before.brokerage);
  }, 20000);
  it('rolls back genuine identity reset after expiry during a later native SQL wait; business SQL deadlines remain unchanged', async () => {
    await f.exec("CREATE FUNCTION division_staff_native_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.uid=44 THEN PERFORM pg_sleep(2.15); END IF; RETURN NEW; END $$");
    await f.exec('CREATE TRIGGER division_staff_native_gate BEFORE UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION division_staff_native_gate()');
    const before = await f.snapshot();
    const started = Date.now();
    await expect(service.remove({ ...f.actor(), expiresAt: Math.floor(Date.now() / 1000) + 2 }, 44)).rejects.toThrow('登录');
    expect(Date.now() - started).toBeGreaterThanOrEqual(2100);
    expect(await f.snapshot()).toEqual(before);
  }, 20000);
});
