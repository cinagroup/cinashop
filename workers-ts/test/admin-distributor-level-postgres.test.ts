import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDbFromConnectionString } from '../src/lib/di';
import { agentLevel, agentLevelTask, agentLevelTaskRecord, systemAttachment, systemConfig } from '../src/models/schema';
import { DistributorLevelRejected, DistributorLevelStaleVersion, DISTRIBUTOR_CATALOG_LOCK_NAMESPACE, distributorCanonical, distributorHash } from '../src/services/admin/AdminDistributorLevelInput';
import { distributorActor, distributorLevelFixture, distributorLevelValues, distributorTaskValues } from './helpers/distributorLevelFixture';
import { observeCityDeliveryRecordDb } from './helpers/cityDeliveryRecordFixture';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof distributorLevelFixture>>;
type Peer = Parameters<Parameters<Fixture['withRuntimeRole']>[0]>[0];
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const input = (revision: string, values: unknown) => ({ request_id: crypto.randomUUID(), revision, values });
const reduced = (revision: string, status?: number) => ({ request_id: crypto.randomUUID(), revision, ...(status === undefined ? {} : { status }) });
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native full distributor catalogue on the production ACL intersection', () => {
  let f: Fixture;
  beforeEach(async () => { f = await distributorLevelFixture(); }, 30000);
  afterEach(async () => { await f?.close(); }, 30000);
  const profiles = (run: (admin: Peer, app: Peer) => Promise<void>) => f.withRuntimeRole(app => f.withRuntimeRole(async admin => {
    expect((await f.installSlice(app, admin)).ready).toBe(true);
    expect((await admin.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: admin.role, session_user: admin.role });
    expect((await app.exec('SELECT current_user,session_user'))[0]).toEqual({ current_user: app.role, session_user: app.role });
    expect(admin.pid).not.toBe(app.pid); await run(admin, app);
  }));
  it('reads full level/task fields, literal filters and minimal paged parents without writes or implicit seeding', async () => profiles(async (admin, app) => {
    const before = await f.snapshot(), service = f.serviceFor(admin.db), levels = await service.levelsList(new URLSearchParams());
    expect(levels).toMatchObject({ count: 3, config: { one_ratio: '10.01', two_ratio: '5.00', enabled: true } });
    expect(levels.list.map(row => row.id)).toEqual([1, 2, 3]); expect(levels.list[0]).toMatchObject({ grade: 1, one_brokerage: 2, two_brokerage: 1, task_count: 2, one_brokerage_ratio: '10.21', two_brokerage_ratio: '5.05' });
    expect((await service.levelsList(new URLSearchParams('keyword=%25_&limit=1'))).list.map(row => row.id)).toEqual([3]);
    const tasks = await service.tasksList(new URLSearchParams('level_id=1&limit=1'));
    expect(tasks).toMatchObject({ count: 2, parent: { id: 1, revision: levels.revision } });
    expect(tasks.list[0]).toMatchObject({ id: 21, is_must: 1, completed: true, type_name: '自身消费金额', revision: levels.revision });
    expect(tasks.task_types.map(row => row.type)).toEqual([1, 2, 3, 4, 5]);
    const parents = await service.tasksParents(new URLSearchParams('page=2&limit=1'));
    expect(parents.list[0]).toEqual({ id: 2, name: '等级二', grade: 2, status: 1, revision: levels.revision });
    expect((await f.serviceFor(app.db).levelsList(new URLSearchParams('status=1'))).count).toBe(2);
    expect(await f.snapshot()).toEqual(before);
    await f.db.delete(agentLevelTaskRecord); await f.db.delete(agentLevelTask); await f.db.delete(agentLevel);
    const empty = await f.snapshot(); expect((await service.levelsList(new URLSearchParams())).count).toBe(0); expect(await f.snapshot()).toEqual(empty);
  }));
  it('performs full level/task CRUD, preserves historical is_must and users/evidence during soft cascade deletion', async () => profiles(async admin => {
    const service = f.serviceFor(admin.db), users = (await f.snapshot()).users, evidence = (await f.snapshot()).records;
    const levelBody = input((await service.levelsList(new URLSearchParams())).revision, { ...distributorLevelValues(), image: '/api/assets/41' });
    const created = await service.mutate('level:create', undefined, levelBody, distributorActor); expect(created.id).toBeGreaterThan(3);
    expect((await service.levelsDetail(created.id)).info.image_preview).toMatch(/^\/api\/assets\/41\?expires=/);
    const changed = { ...distributorLevelValues(), name: ' 修改后 ', one_brokerage: 1000, two_brokerage: 999, image: '/api/assets/41' };
    await service.mutate('level:update', created.id, input((await service.levelsDetail(created.id)).info.revision, changed), distributorActor);
    expect((await service.levelsDetail(created.id)).info).toMatchObject({ name: '修改后', one_brokerage_ratio: '110.11', two_brokerage_ratio: '54.95' });
    const taskBody = input((await service.levelsDetail(created.id)).info.revision, distributorTaskValues(created.id, 3));
    const task = await service.mutate('task:create', undefined, taskBody, distributorActor);
    expect((await service.tasksDetail(task.id)).info.is_must).toBe(0);
    await service.mutate('task:update', 21, input((await service.tasksDetail(21)).info.revision, { ...distributorTaskValues(1, 2), number: 10, name: '仅改文案' }), distributorActor);
    expect((await service.tasksDetail(21)).info).toMatchObject({ is_must: 1, name: '仅改文案', completed: true });
    await service.mutate('task:status', task.id, reduced((await service.tasksDetail(task.id)).info.revision, 0), distributorActor);
    await service.mutate('task:delete', task.id, reduced((await service.tasksDetail(task.id)).info.revision), distributorActor);
    await expect(service.tasksDetail(task.id)).rejects.toThrow(/不存在/);
    const deleting = reduced((await service.levelsDetail(1)).info.revision);
    const removed = await service.mutate('level:delete', 1, deleting, distributorActor);
    expect(await service.mutate('level:delete', 1, deleting, distributorActor)).toEqual(removed);
    const after = await f.snapshot(); expect(after.levels.find(row => row.id === 1)?.isDel).toBe(1);
    expect(after.tasks.filter(row => row.levelId === 1).every(row => row.isDel === 1)).toBe(true);
    expect(after.users).toEqual(users); expect(after.records).toEqual(evidence);
  }));
  it('protects completed task type/number but allows metadata repair without inventing is_must semantics', async () => profiles(async admin => {
    const service = f.serviceFor(admin.db), body = input((await service.tasksDetail(21)).info.revision, { ...distributorTaskValues(1, 2), number: 11 }), before = await f.snapshot();
    await expect(service.mutate('task:update', 21, body, distributorActor)).rejects.toThrow(/已有用户完成/);
    await expect(service.mutate('task:update', 21, { ...body, request_id: crypto.randomUUID(), values: { ...distributorTaskValues(1, 3), number: 10 } }, distributorActor)).rejects.toThrow(/已有用户完成/);
    await expect(service.mutate('task:update', 21, { ...body, request_id: crypto.randomUUID(), values: { ...distributorTaskValues(2, 2), number: 10 } }, distributorActor)).rejects.toThrow(/不能移动/);
    expect(await f.snapshot()).toEqual(before);
  }));
  it('proves only matching pre-DML domain rejection and explicitly retires orphan tasks while retaining user/completion history', async () => profiles(async admin => {
    const service = f.serviceFor(admin.db), revision = (await service.levelsList(new URLSearchParams())).revision;
    for (const [operation, id, body] of [
      ['level:create', undefined, input(revision, distributorLevelValues(1))],
      ['task:update', 21, input(revision, { ...distributorTaskValues(1, 2), number: 11 })],
      ['level:create', undefined, input(revision, { ...distributorLevelValues(), image: '/api/assets/42' })],
      ['level:status', 3, reduced(revision, 1)],
    ] as const) {
      const before = await f.snapshot(), result = await outcome(service.mutate(operation, id, body, distributorActor));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(DistributorLevelRejected);
        expect(result.error).toMatchObject({ operation, request_id: body.request_id, payload_hash: await distributorHash(distributorCanonical(operation, id, body).canonical) });
      }
      expect(await f.snapshot()).toEqual(before);
      await expect(service.receipt(operation.startsWith('level:') ? 'level' : 'task', body.request_id, distributorActor)).rejects.toThrow(/不存在/);
    }
    await f.db.insert(agentLevelTask).values({ id: 101, levelId: 999, name: '导入孤儿任务', type: 3, number: 1, status: 1 });
    await f.db.insert(agentLevelTaskRecord).values({ uid: 91, levelId: 999, taskId: 101, status: 0 });
    await f.db.update(agentLevel).set({ isDel: 1 }).where(eq(agentLevel.id, 3));
    const parents = await service.tasksParents(new URLSearchParams());
    expect(parents.issues).toEqual(expect.arrayContaining(['orphan_task:101', 'orphan_task:13']));
    const preserved = await f.snapshot();
    for (const [operation, body] of [['task:update', input(parents.revision, distributorTaskValues(999, 3))], ['task:status', reduced(parents.revision, 0)]] as const) {
      const result = await outcome(service.mutate(operation, 101, body, distributorActor)); expect(result.ok).toBe(false);
      if (!result.ok) { expect(result.error).not.toBeInstanceOf(DistributorLevelRejected); expect(result.error.message).toMatch(/等级不存在/); }
      expect(await f.snapshot()).toEqual(preserved);
    }
    for (const id of [101, 13]) {
      const body = reduced((await service.tasksParents(new URLSearchParams())).revision);
      const receipt = await service.mutate('task:delete', id, body, distributorActor);
      expect(receipt).toEqual({ operation: 'task:delete', id, request_id: body.request_id, payload_hash: await distributorHash(distributorCanonical('task:delete', id, body).canonical) });
      expect(await service.receipt('task', body.request_id, distributorActor)).toEqual(receipt);
      const after = await f.snapshot(); expect(await service.mutate('task:delete', id, body, distributorActor)).toEqual(receipt); expect(await f.snapshot()).toEqual(after);
    }
    const after = await f.snapshot();
    expect(after.users).toEqual(preserved.users); expect(after.records).toEqual(preserved.records); expect(after.levels).toEqual(preserved.levels);
    expect(after.tasks).toEqual(preserved.tasks.map(row => [101, 13].includes(row.id) ? { ...row, isDel: 1 } : row));
    expect(after.logs).toHaveLength(2); expect((await service.tasksParents(new URLSearchParams())).issues).not.toContain('orphan_task:101');
  }));
  it('revalidates the complete active monotonic graph on parent enable, grade edit and task enable/create', async () => profiles(async admin => {
    const service = f.serviceFor(admin.db), before = await f.snapshot(), revision = (await service.levelsList(new URLSearchParams())).revision;
    await expect(service.mutate('level:status', 3, reduced(revision, 1), distributorActor)).rejects.toThrow(/非递增/);
    await expect(service.mutate('level:update', 1, input(revision, { ...distributorLevelValues(4), name: '等级一' }), distributorActor)).rejects.toThrow(/非递增/);
    await expect(service.mutate('task:create', undefined, input(revision, { ...distributorTaskValues(2, 2), number: 10 }), distributorActor)).rejects.toThrow(/非递增/);
    await expect(service.mutate('level:create', undefined, input(revision, distributorLevelValues(1)), distributorActor)).rejects.toThrow(/已存在/);
    await expect(service.mutate('task:create', undefined, input(revision, distributorTaskValues(1, 1)), distributorActor)).rejects.toThrow(/已存在/);
    expect(await f.snapshot()).toEqual(before);
    await f.db.update(agentLevelTask).set({ status: 0, number: 9 }).where(eq(agentLevelTask.id, 12));
    const changed = await f.snapshot();
    await expect(service.mutate('task:status', 12, reduced((await service.tasksDetail(12)).info.revision, 1), distributorActor)).rejects.toThrow(/非递增/);
    expect(await f.snapshot()).toEqual(changed);
  }));
  it('diagnoses duplicate grades/types, invalid legacy fields and missing configuration; still allows explicit hide/delete', async () => {
    await f.db.update(agentLevel).set({ grade: 1, color: 'url(bad)' }).where(eq(agentLevel.id, 3));
    await f.db.insert(agentLevelTask).values({ levelId: 1, name: '重复历史任务', type: 1, number: 1, status: 0 });
    await f.db.delete(systemConfig).where(eq(systemConfig.menuName, 'store_brokerage_two'));
    await profiles(async admin => {
      const service = f.serviceFor(admin.db), page = await service.levelsList(new URLSearchParams());
      expect(page.issues).toContain('duplicate_grade:1'); expect(page.config.two_ratio).toBeNull();
      expect(page.list.find(row => row.id === 3)?.issues).toContain('invalid_legacy_level');
      expect((await service.tasksList(new URLSearchParams('level_id=1'))).issues).toContain('duplicate_type:1:1');
      await service.mutate('level:status', 3, reduced(page.revision, 0), distributorActor);
      await service.mutate('level:delete', 3, reduced((await service.levelsDetail(3)).info.revision), distributorActor);
      expect((await service.levelsList(new URLSearchParams())).count).toBe(2);
    });
  });
  it('captures hidden/offpage, xmin-only and parent graph/config winner changes in every resource revision', async () => profiles(async admin => {
    const service = f.serviceFor(admin.db);
    for (const change of [() => f.db.update(agentLevel).set({ status: 0 }).where(eq(agentLevel.id, 3)),
      () => f.db.update(agentLevelTask).set({ sort: 31 }).where(eq(agentLevelTask.id, 13)),
      () => f.db.insert(systemConfig).values([{ menuName: 'store_brokerage_ratio', value: '11', sort: 10 },
        { menuName: 'store_brokerage_ratio', value: '99', sort: 1 }, { menuName: 'store_brokerage_ratio', value: '88', isStore: 1, sort: 100 }]),
      () => f.db.insert(systemConfig).values({ menuName: 'store_brokerage_ratio', value: '12', sort: 10 })]) {
      const revision = (await service.levelsList(new URLSearchParams('status=1&limit=1'))).revision; await change();
      const before = await f.snapshot(), body = reduced(revision, 0);
      const stale = await outcome(service.mutate('task:status', 11, body, distributorActor));
      expect(stale.ok).toBe(false); if (!stale.ok) expect(stale.error).toMatchObject({ name: 'DistributorLevelStaleVersion', operation: 'task:status', request_id: body.request_id, payload_hash: await distributorHash(distributorCanonical('task:status', 11, body).canonical) });
      expect(await f.snapshot()).toEqual(before);
    }
    const page = await service.levelsList(new URLSearchParams());
    expect(page.config.one_ratio).toBe('12.00');
    expect(page.list.find(row => row.id === 1)?.one_brokerage_ratio).toBe('12.24');
    // Removing only the equal-sort newer winner exposes the higher-sort older
    // 11% value, rather than the later 99% low-sort or 88% store-only row.
    const [winner] = await f.db.select({ id: systemConfig.id }).from(systemConfig).where(eq(systemConfig.value, '12'));
    await f.db.delete(systemConfig).where(eq(systemConfig.id, winner.id));
    expect((await service.levelsList(new URLSearchParams())).config.one_ratio).toBe('11.00');
  }));
  it('replays successful global UUID before CAS, and binds actor/resource/full intent across deletion and later edits', async () => profiles(async admin => {
    const service = f.serviceFor(admin.db), body = input((await service.levelsList(new URLSearchParams())).revision, distributorLevelValues());
    const receipt = await service.mutate('level:create', undefined, body, distributorActor);
    await service.mutate('level:delete', receipt.id, reduced((await service.levelsDetail(receipt.id)).info.revision), distributorActor);
    const before = await f.snapshot(); expect(await service.mutate('level:create', undefined, body, distributorActor)).toEqual(receipt);
    expect(await service.receipt('level', body.request_id, distributorActor)).toEqual(receipt);
    await expect(service.receipt('task', body.request_id, distributorActor)).rejects.toThrow(/不存在/);
    await expect(service.receipt('level', body.request_id, { id: 8 })).rejects.toThrow(/不存在/);
    await expect(service.mutate('level:create', undefined, body, { id: 8 })).rejects.toThrow(/请求标识/);
    await expect(service.mutate('level:create', undefined, { ...body, values: { ...distributorLevelValues(), name: '不同意图' } }, distributorActor)).rejects.toThrow(/请求标识/);
    await expect(service.mutate('task:create', undefined, { ...body, values: distributorTaskValues() }, distributorActor)).rejects.toThrow(/请求标识/);
    expect(await f.snapshot()).toEqual(before);
  }));
  it('keeps narrow Admin column grants, immutable identity/time and real app semantic denial without DDL or hard-delete authority', async () => profiles(async (admin, app) => {
    expect((await admin.exec("SELECT has_table_privilege(current_user,'agent_level','UPDATE') AS broad,has_column_privilege(current_user,'agent_level','name','UPDATE') AS narrow"))[0]).toEqual({ broad: false, narrow: true });
    const before = await f.snapshot();
    for (const statement of ['UPDATE agent_level SET id=9 WHERE id=1', 'UPDATE agent_level SET add_time=9 WHERE id=1', 'DELETE FROM agent_level WHERE id=1', 'CREATE TABLE public.forbidden_agent(id int)']) {
      const result = await outcome(admin.exec(statement)); expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toMatchObject({ code: '42501' });
    }
    for (const statement of ["INSERT INTO agent_level(name) VALUES('forbidden')", "UPDATE agent_level SET name='forbidden' WHERE id=1", 'UPDATE agent_level SET id=9 WHERE id=1', 'UPDATE agent_level_task SET status=0 WHERE id=11']) {
      const result = await outcome(app.exec(statement)); expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toMatchObject({ code: '42501' });
    }
    await app.exec('UPDATE agent_level SET id=id WHERE id=1'); expect(await f.snapshot()).toEqual(before);
  }));
  it('atomically rolls back soft cascade and final receipt when journal insertion fails under the actual Admin LOGIN', async () => profiles(async admin => {
    const service = f.serviceFor(admin.db), body = reduced((await service.levelsDetail(1)).info.revision), before = await f.snapshot();
    await f.exec("CREATE FUNCTION reject_distributor_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='distributor_catalog' THEN RAISE EXCEPTION 'owned late distributor receipt failure'; END IF; RETURN NEW; END $$");
    await f.exec('CREATE TRIGGER reject_distributor_receipt BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION reject_distributor_receipt()');
    const result = await outcome(service.mutate('level:delete', 1, body, distributorActor)); expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).not.toBeInstanceOf(DistributorLevelRejected); expect(result.error.cause ?? result.error).toMatchObject({ code: 'P0001', message: 'owned late distributor receipt failure' }); }
    expect(await f.snapshot()).toEqual(before);
  }));
  it('serializes same UUID on two real sessions and rejects a different actor without a second row/journal', async () => profiles(async admin => {
    const second = createDbFromConnectionString(admin.connectionString, 1), [identity] = await second.execute(sql`SELECT pg_backend_pid() AS pid,current_user AS role`);
    expect(identity.role).toBe(admin.role); expect(Number(identity.pid)).not.toBe(admin.pid);
    try { await f.withPeer(async sentinel => {
      async function race(actor: { id: number }, grade: number) {
        const locked = gate(), release = gate(), body = input((await f.serviceFor().levelsList(new URLSearchParams())).revision, distributorLevelValues(grade));
        const hold = sentinel.db.transaction(async tx => { await tx.execute(sql`SELECT pg_advisory_xact_lock(${DISTRIBUTOR_CATALOG_LOCK_NAMESPACE},0)`); locked.resolve(); await release.promise; });
        await locked.promise; const a = outcome(f.serviceFor(admin.db).mutate('level:create', undefined, body, distributorActor)), b = outcome(f.serviceFor(second).mutate('level:create', undefined, body, actor));
        try { await Promise.all([waitForFinanceBlock(f.db, admin.pid, sentinel.pid), waitForFinanceBlock(f.db, Number(identity.pid), sentinel.pid)]); } finally { release.resolve(); }
        await hold; return Promise.all([a, b]);
      }
      const same = await race(distributorActor, 4); expect(same[0].ok).toBe(true); expect(same[1]).toEqual(same[0]);
      const cross = await race({ id: 8 }, 5); expect(cross.map(row => row.ok).sort()).toEqual([false, true]);
      expect((await f.snapshot()).levels).toHaveLength(5); expect((await f.snapshot()).logs).toHaveLength(2);
    }); } finally { await second.$client.end({ timeout: 5 }); }
  }));
  it('waits on raw runtime task DML statement fence then sees the committed phantom despite session-default RR', async () => profiles(async admin => {
    const writer = createDbFromConnectionString(admin.connectionString, 1), [identity] = await writer.execute(sql`SELECT pg_backend_pid() AS pid`);
    try {
      await admin.exec('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const body = input((await f.serviceFor(admin.db).levelsList(new URLSearchParams())).revision, distributorLevelValues()), locked = gate(), release = gate();
      const hold = writer.transaction(async tx => { await tx.insert(agentLevelTask).values({ levelId: 2, name: '隐藏外部插入', type: 4, number: 40, status: 0 }); locked.resolve(); await release.promise; });
      await locked.promise; const pending = outcome(f.serviceFor(admin.db).mutate('level:create', undefined, body, distributorActor));
      try { await waitForFinanceBlock(f.db, admin.pid, Number(identity.pid)); const [lock] = await f.exec(`SELECT locktype,mode,granted FROM pg_locks WHERE pid=${admin.pid} AND locktype='advisory' AND NOT granted`); expect(lock).toEqual({ locktype: 'advisory', mode: 'ExclusiveLock', granted: false }); } finally { release.resolve(); }
      await hold; const result = await pending; expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(DistributorLevelStaleVersion);
      expect((await f.snapshot()).tasks).toHaveLength(5); expect((await f.snapshot()).logs).toEqual([]);
    } finally { await writer.$client.end({ timeout: 5 }); }
  }));
  it('waits on raw app completion-record shared fence and rechecks immutable thresholds after commit', async () => profiles(async (admin, app) => {
    const service = f.serviceFor(admin.db), body = input((await service.tasksDetail(11)).info.revision, { ...distributorTaskValues(1, 1), number: 15 }), locked = gate(), release = gate();
    const hold = app.db.transaction(async tx => { await tx.insert(agentLevelTaskRecord).values({ uid: 92, levelId: 1, taskId: 11, status: 1 }); locked.resolve(); await release.promise; });
    await locked.promise; const pending = outcome(service.mutate('task:update', 11, body, distributorActor));
    try { await waitForFinanceBlock(f.db, admin.pid, app.pid); } finally { release.resolve(); }
    await hold; const before = await f.snapshot(), result = await pending; expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/已有用户完成/); expect(await f.snapshot()).toEqual(before);
  }));
  it('holds the runtime catalog fence against raw level/task and completion writes until its final commit', async () => profiles(async (admin, app) => {
    const writer = createDbFromConnectionString(admin.connectionString, 1), [identity] = await writer.execute(sql`SELECT pg_backend_pid() AS pid`), reached = gate(), release = gate(); let observed = false;
    try {
      const observing = observeCityDeliveryRecordDb(admin.db, async (_tx, command) => { if (!observed && command.includes('"agent_level"') && /for update/i.test(command)) { observed = true; reached.resolve(); await release.promise; } });
      const body = reduced((await f.serviceFor().levelsDetail(2)).info.revision, 0), pending = outcome(f.serviceFor(observing).mutate('level:status', 2, body, distributorActor)); await reached.promise;
      const raw = outcome(writer.update(agentLevelTask).set({ name: '保存后原始任务写入' }).where(eq(agentLevelTask.id, 12)));
      const evidence = outcome(app.db.insert(agentLevelTaskRecord).values({ uid: 92, levelId: 1, taskId: 11, status: 1 }));
      try { await Promise.all([waitForFinanceBlock(f.db, Number(identity.pid), admin.pid), waitForFinanceBlock(f.db, app.pid, admin.pid)]); } finally { release.resolve(); }
      expect((await pending).ok).toBe(true); expect((await raw).ok).toBe(true); expect((await evidence).ok).toBe(true);
      expect((await f.snapshot()).logs).toHaveLength(1);
    } finally { release.resolve(); await writer.$client.end({ timeout: 5 }); }
  }));
  it('revalidates attachment availability after a shared-row wait and rejects foreign/nonimage assets without changes', async () => profiles(async admin => f.withPeer(async writer => {
    const body = input((await f.serviceFor().levelsList(new URLSearchParams())).revision, { ...distributorLevelValues(), image: '/api/assets/41' }), locked = gate(), release = gate();
    const hold = writer.db.transaction(async tx => { await tx.update(systemAttachment).set({ fileType: 2 }).where(eq(systemAttachment.attId, 41)); locked.resolve(); await release.promise; });
    await locked.promise; const pending = outcome(f.serviceFor(admin.db).mutate('level:create', undefined, body, distributorActor));
    try { await waitForFinanceBlock(f.db, admin.pid, writer.pid); } finally { release.resolve(); }
    await hold; expect((await pending).ok).toBe(false);
    for (const image of ['/api/assets/41', '/api/assets/42', '/api/assets/43', '/api/assets/999']) {
      const before = await f.snapshot(); await expect(f.serviceFor(admin.db).mutate('level:create', undefined, input((await f.serviceFor().levelsList(new URLSearchParams())).revision, { ...distributorLevelValues(), image }), distributorActor)).rejects.toThrow(/背景图不可用/); expect(await f.snapshot()).toEqual(before);
    }
  })));
  it('preserves stricter session timeouts and observes actual transaction-local RC/400/2000/5000 settings', async () => profiles(async admin => {
    await admin.exec("SET lock_timeout='400ms'; SET statement_timeout='2s'; SET idle_in_transaction_session_timeout='5s'"); let calls = 0, settings: unknown;
    const observing = observeCityDeliveryRecordDb(admin.db, async (tx, command) => {
      if (command === 'execute' && ++calls === 2) [settings] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
        current_setting('lock_timeout') AS lock,current_setting('statement_timeout') AS statement,current_setting('idle_in_transaction_session_timeout') AS idle`);
    });
    await f.serviceFor(observing).mutate('level:status', 2, reduced((await f.serviceFor().levelsDetail(2)).info.revision, 0), distributorActor);
    expect(settings).toEqual({ isolation: 'read committed', lock: '400ms', statement: '2s', idle: '5s' });
  }));
});
