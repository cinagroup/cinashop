/** Real registered routes/JWT, distinct app/Admin LOGINs, actual production ACL
 * slice + real catalog triggers. No provider, asset or financial network calls. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import type { Env } from '../src/env';
import { agentLevelTask, agentLevelTaskRecord, systemAdmin, systemLog, systemMenus, systemRole } from '../src/models/schema';
import { distributorCanonical, distributorHash } from '../src/services/admin/AdminDistributorLevelInput';
import { createToken, md5 } from '../src/utils/jwt';
import { distributorLevelFixture, distributorLevelValues, distributorTaskValues, distributorTestBindings } from './helpers/distributorLevelFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({ ...await original<typeof import('../src/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Owned distributor HTTP fixture unavailable'); return wiring.container;
} }));
type HttpBindings = Pick<Env, 'APP_KEY' | 'UPSTASH_REDIS_URL' | 'UPSTASH_REDIS_TOKEN'> & { NODE_ENV: 'test' };
// These bindings retain exact Env value types; other bindings are unused by
// this request contract and every external fetch is forbidden below.
const env = { ...distributorTestBindings, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', NODE_ENV: 'test' } satisfies HttpBindings;
const httpEnv = env as unknown as Env;
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('registered distributor catalogue HTTP with real Admin authentication', () => {
  let f: Awaited<ReturnType<typeof distributorLevelFixture>>;
  const app = createApp(), tokens = new Map<number, string>();
  const actors = { manager: 1, reader: 2, legacy: 3, wrongPath: 4, wrongAuth: 5, broad: 6, taskOnly: 7, levelOnly: 8, second: 9, taskAction: 10 };
  let fetchGuard: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    f = await distributorLevelFixture();
    await f.db.insert(systemMenus).values([
      { id: 972, type: 1, authType: 1, access: 1, uniqueAuth: '/admin/setting/membership_level/index', menuPath: '/admin/setting/membership_level/index' },
      { id: 1972, type: 1, authType: 1, access: 1, uniqueAuth: '/admin/setting/membership_level/index', menuPath: '/admin/setting/user_level/index' },
      { id: 2972, type: 1, authType: 1, access: 1, uniqueAuth: 'wrong-auth', menuPath: '/admin/setting/membership_level/index' },
      { id: 995, type: 1, authType: 2, access: 1, apiUrl: 'agent/level_task', methods: 'POST' },
    ]);
    const rules: Record<string, string> = { manager: 'agent_level.manage,agent_level_task.manage', reader: 'agent_level.view,agent_level_task.view',
      legacy: '972', wrongPath: '1972', wrongAuth: '2972', broad: 'config.manage,agent.manage,user_level.manage', taskOnly: 'agent_level_task.manage',
      levelOnly: 'agent_level.manage', second: 'agent_level.manage,agent_level_task.manage', taskAction: '995' };
    await f.db.insert(systemRole).values(Object.entries(actors).map(([name, id]) => ({ id, type: 1, roleName: name, rules: rules[name] })));
    await f.db.insert(systemAdmin).values(Object.entries(actors).map(([name, id]) => ({ id, account: `distributor-${name}`, pwd: 'owned-distributor-password', level: 1, roles: String(id), adminType: 1, status: 1, isDel: 0 })));
    for (const id of Object.values(actors)) tokens.set(id, (await createToken(id, 'admin', md5('owned-distributor-password'), env.APP_KEY)).token);
    fetchGuard = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Distributor administration must not fetch external providers/media'); });
  }, 30000);
  afterEach(async () => { if (fetchGuard) expect(fetchGuard).not.toHaveBeenCalled(); fetchGuard?.mockRestore(); wiring.container = undefined; tokens.clear(); await f?.close(); }, 30000);
  async function profiles(run: () => Promise<void>) {
    await f.withRuntimeRole(appPeer => f.withRuntimeRole(async adminPeer => {
      expect((await f.installSlice(appPeer, adminPeer)).ready).toBe(true);
      wiring.container = createContainerFromDb(appPeer.db);
      Object.assign(httpEnv, { HYPERDRIVE: { connectionString: appPeer.connectionString } as Env['HYPERDRIVE'], HYPERDRIVE_ADMIN: { connectionString: adminPeer.connectionString } as Env['HYPERDRIVE_ADMIN'] });
      try { await run(); } finally { wiring.container = undefined; }
    }));
  }
  async function request(prefix: string, resource: 'levels' | 'level-tasks' | 'level' | 'level_task', actor: number | null, suffix = '', method = 'GET', body?: unknown, raw?: string) {
    const response = await app.request(`${prefix}/agent/${resource}${suffix}`, { method,
      headers: { ...(actor === null ? {} : { Authorization: `Bearer ${tokens.get(actor)}` }), ...(body === undefined && raw === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
    }, httpEnv);
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  const revision = async (prefix = '/adminapi') => (await request(prefix, 'levels', actors.manager)).body.data.revision as string;
  const input = (revision: string, values: unknown) => ({ request_id: crypto.randomUUID(), revision, values });
  const reduced = (revision: string, status?: number) => ({ request_id: crypto.randomUUID(), revision, ...(status === undefined ? {} : { status }) });

  it.each(['/adminapi', '/api/admin'])('executes all 15 canonical endpoints with full snake_case DTOs and successful receipt replay on %s', async prefix => profiles(async () => {
    const before = await request(prefix, 'levels', actors.reader); expect(before.body.status).toBe(200); expect(before.body.data.config).toEqual({ one_ratio: '10.01', two_ratio: '5.00', enabled: true });
    expect(before.response.headers.get('Cache-Control')).toContain('no-store');
    const levelBody = input(before.body.data.revision, distributorLevelValues()), level = await request(prefix, 'levels', actors.manager, '', 'POST', levelBody);
    expect(level.body.status, level.body.msg).toBe(200); const id = level.body.data.id; expect(level.body.data).toMatchObject({ operation: 'level:create', request_id: levelBody.request_id });
    expect((await request(prefix, 'levels', actors.manager, `/request/${levelBody.request_id}`)).body.data).toEqual(level.body.data);
    const detail = await request(prefix, 'levels', actors.reader, `/${id}`); expect(detail.body.data.info).toMatchObject({ id, one_brokerage: 19, two_brokerage: 12, is_del: 0 });
    expect((await request(prefix, 'levels', actors.manager, `/${id}`, 'PUT', input(detail.body.data.info.revision, { ...distributorLevelValues(), name: '新名称' }))).body.status).toBe(200);
    const parents = await request(prefix, 'level-tasks', actors.taskOnly, '/parents?limit=100'); expect(parents.body.status).toBe(200); expect(parents.body.data.list.some((row: { id: number }) => row.id === id)).toBe(true);
    const taskBody = input(parents.body.data.revision, distributorTaskValues(id)), task = await request(prefix, 'level-tasks', actors.manager, '', 'POST', taskBody);
    expect(task.body.status, task.body.msg).toBe(200); const taskId = task.body.data.id; expect(task.body.data.operation).toBe('task:create');
    const tasks = await request(prefix, 'level-tasks', actors.reader, `?level_id=${id}`); expect(tasks.body.data.parent.id).toBe(id); expect(tasks.body.data.list[0]).toMatchObject({ level_id: id, type: 3, is_must: 0, completed: false });
    expect((await request(prefix, 'level-tasks', actors.manager, `/request/${taskBody.request_id}`)).body.data).toEqual(task.body.data);
    const taskDetail = await request(prefix, 'level-tasks', actors.reader, `/${taskId}`); expect(taskDetail.body.status).toBe(200);
    expect((await request(prefix, 'level-tasks', actors.manager, `/${taskId}`, 'PUT', input(taskDetail.body.data.info.revision, { ...distributorTaskValues(id), desc: '修改说明' }))).body.status).toBe(200);
    expect((await request(prefix, 'level-tasks', actors.manager, `/${taskId}/status`, 'PATCH', reduced(await revision(prefix), 0))).body.status).toBe(200);
    const removedTask = await request(prefix, 'level-tasks', actors.manager, `/${taskId}`, 'DELETE', reduced(await revision(prefix))); expect(removedTask.body.status).toBe(200);
    expect((await request(prefix, 'level-tasks', actors.reader, `/${taskId}`)).response.status).toBe(404);
    expect((await request(prefix, 'levels', actors.manager, `/${id}/status`, 'PATCH', reduced(await revision(prefix), 0))).body.status).toBe(200);
    const deletion = reduced(await revision(prefix)), removed = await request(prefix, 'levels', actors.manager, `/${id}`, 'DELETE', deletion); expect(removed.body.status).toBe(200);
    const snapshot = await f.snapshot(); expect((await request(prefix, 'levels', actors.manager, `/${id}`, 'DELETE', deletion)).body.data).toEqual(removed.body.data);
    expect((await request(prefix, 'levels', actors.manager, '', 'POST', levelBody)).body.data).toEqual(level.body.data);
    expect((await request(prefix, 'levels', actors.reader, `/${id}`)).response.status).toBe(404); expect(await f.snapshot()).toEqual(snapshot);
  }));
  it('enforces exact legacy page pairs, independent task-only parent access, action-grant separation and view-only mutation denial on both prefixes', async () => profiles(async () => {
    const body = input(await revision(), distributorLevelValues()), before = await f.snapshot();
    for (const prefix of ['/adminapi', '/api/admin']) {
      for (const actor of [actors.reader, actors.legacy]) {
        expect((await request(prefix, 'levels', actor)).body.status).toBe(200); expect((await request(prefix, 'level-tasks', actor, '?level_id=1')).body.status).toBe(200);
        for (const resource of ['levels', 'level-tasks'] as const) for (const [suffix, method, value] of [['', 'POST', resource === 'levels' ? body : { ...body, values: distributorTaskValues() }],
          [`/${resource === 'levels' ? 2 : 12}`, 'PUT', resource === 'levels' ? body : { ...body, values: distributorTaskValues() }],
          [`/${resource === 'levels' ? 2 : 12}/status`, 'PATCH', reduced(body.revision, 0)], [`/${resource === 'levels' ? 2 : 12}`, 'DELETE', reduced(body.revision)]] as const) expect((await request(prefix, resource, actor, suffix, method, value)).body.status).toBe(400011);
      }
      for (const actor of [actors.wrongPath, actors.wrongAuth, actors.broad]) for (const resource of ['levels', 'level-tasks'] as const) expect((await request(prefix, resource, actor, resource === 'levels' ? '' : '?level_id=1')).body.status).toBe(400011);
      for (const actor of [actors.taskOnly, actors.taskAction]) {
        expect((await request(prefix, 'levels', actor)).body.status).toBe(400011); expect((await request(prefix, 'levels', actor, '', 'POST', body)).body.status).toBe(400011);
        expect((await request(prefix, 'level-tasks', actor, '/parents')).body.status).toBe(200);
      }
      expect((await request(prefix, 'level-tasks', actors.levelOnly, '?level_id=1')).body.status).toBe(400011);
      expect((await request(prefix, 'levels', null)).body.status).toBe(410000);
    }
    expect(await f.snapshot()).toEqual(before);
  }));
  it.each(['/adminapi', '/api/admin'])('keeps all seven legacy aliases per resource versioned with no save/status bypass on %s', async prefix => profiles(async () => {
    expect((await request(prefix, 'level', actors.legacy)).body.status).toBe(200);
    expect((await request(prefix, 'level', actors.manager, '/create')).body.data.revision).toMatch(/^[a-f0-9]{64}$/);
    expect((await request(prefix, 'level', actors.manager, '/2/edit')).body.data.info.id).toBe(2);
    expect((await request(prefix, 'level_task', actors.manager, '?id=1')).body.data.parent.id).toBe(1);
    expect((await request(prefix, 'level_task', actors.manager, '/create?level_id=1')).body.data.parent.id).toBe(1);
    expect((await request(prefix, 'level_task', actors.manager, '/12/edit')).body.data.info.id).toBe(12);
    const before = await f.snapshot();
    for (const resource of ['level', 'level_task'] as const) {
      const id = resource === 'level' ? 2 : 12;
      for (const [suffix, method, body] of [['', 'POST', resource === 'level' ? distributorLevelValues() : distributorTaskValues()],
        [`/${id}`, 'PUT', resource === 'level' ? distributorLevelValues() : distributorTaskValues()], [`/set_status/${id}/0`, 'PUT', {}], [`/${id}`, 'DELETE', {}]] as const) expect((await request(prefix, resource, actors.manager, suffix, method, body)).body.status).not.toBe(200);
      expect((await request(prefix, resource, actors.manager, `/set_status/${id}/0`, 'PUT', reduced(await revision(prefix), 1))).body.status).not.toBe(200);
    }
    expect(await f.snapshot()).toEqual(before);
    for (const resource of ['level', 'level_task'] as const) {
      const canonicalResource = resource === 'level' ? 'levels' : 'level-tasks';
      const body = input(await revision(prefix), resource === 'level' ? distributorLevelValues() : distributorTaskValues());
      const created = await request(prefix, resource, actors.manager, '', 'POST', body); expect(created.body.status, created.body.msg).toBe(200); const id = created.body.data.id;
      expect((await request(prefix, resource, actors.manager, `/${id}`, 'PUT', input(await revision(prefix), body.values))).body.status).toBe(200);
      expect((await request(prefix, resource, actors.manager, `/set_status/${id}/0`, 'PUT', reduced(await revision(prefix), 0))).body.status).toBe(200);
      const removal = reduced(await revision(prefix)); expect((await request(prefix, resource, actors.manager, `/${id}`, 'DELETE', removal)).body.status).toBe(200);
      expect((await request(prefix, canonicalResource, actors.manager, `/request/${removal.request_id}`)).body.data.operation).toBe(resource === 'level' ? 'level:delete' : 'task:delete');
    }
  }));
  it.each(['/adminapi', '/api/admin'])('returns actual HTTP409 only after proven pre-DML rollback with matching nonce/operation/hash on %s', async prefix => profiles(async () => {
    const old = await revision(prefix); await f.db.update(agentLevelTask).set({ sort: 31 }).where(eq(agentLevelTask.id, 13));
    for (const [resource, operation, values] of [['levels', 'level:create', distributorLevelValues()], ['level-tasks', 'task:create', distributorTaskValues()]] as const) {
      const body = input(old, values), before = await f.snapshot(), result = await request(prefix, resource, actors.manager, '', 'POST', body);
      expect(result.response.status).toBe(409); expect(result.body).toMatchObject({ status: 409, data: { code: 'DISTRIBUTOR_LEVEL_STALE_VERSION', operation,
        request_id: body.request_id, payload_hash: await distributorHash(distributorCanonical(operation, undefined, body).canonical) } });
      expect(await f.snapshot()).toEqual(before); expect((await request(prefix, resource, actors.manager, `/request/${body.request_id}`)).response.status).toBe(404);
    }
  }));
  it('binds global request UUID to actor/resource/complete intent and never treats conflicts as deterministic stale proofs', async () => profiles(async () => {
    const body = input(await revision(), distributorLevelValues()), saved = await request('/adminapi', 'levels', actors.manager, '', 'POST', body); expect(saved.body.status).toBe(200);
    const before = await f.snapshot();
    for (const prefix of ['/adminapi', '/api/admin']) {
      expect((await request(prefix, 'levels', actors.second, `/request/${body.request_id}`)).response.status).toBe(404);
      expect((await request(prefix, 'level-tasks', actors.manager, `/request/${body.request_id}`)).response.status).toBe(404);
      for (const [resource, actor, value] of [['levels', actors.second, body], ['levels', actors.manager, { ...body, values: { ...distributorLevelValues(), name: '异意图' } }],
        ['level-tasks', actors.manager, { ...body, values: distributorTaskValues() }]] as const) {
        const failed = await request(prefix, resource, actor, '', 'POST', value); expect(failed.response.status).toBe(200); expect(failed.body.status).toBe(400); expect(failed.body.data).toBeNull();
      }
      expect((await request(prefix, 'levels', actors.manager, '', 'POST', body)).body.data).toEqual(saved.body.data);
    }
    expect(await f.snapshot()).toEqual(before);
  }));
  it('returns actual matching HTTP400 only for pre-DML domain rejection and allows task-only orphan retirement on both prefixes', async () => profiles(async () => {
    for (const [index, prefix] of ['/adminapi', '/api/admin'].entries()) {
      const current = await revision(prefix);
      for (const [resource, operation, id, suffix, method, body] of [
        ['levels', 'level:create', undefined, '', 'POST', input(current, distributorLevelValues(1))],
        ['levels', 'level:create', undefined, '', 'POST', input(current, { ...distributorLevelValues(), image: '/api/assets/42' })],
        ['level-tasks', 'task:update', 21, '/21', 'PUT', input(current, { ...distributorTaskValues(1, 2), number: 11 })],
        ['levels', 'level:status', 3, '/3/status', 'PATCH', reduced(current, 1)],
      ] as const) {
        const before = await f.snapshot(), result = await request(prefix, resource, actors.manager, suffix, method, body);
        expect(result.response.status).toBe(400); expect(result.body).toMatchObject({ status: 400, data: { code: 'DISTRIBUTOR_LEVEL_REJECTED', operation,
          request_id: body.request_id, payload_hash: await distributorHash(distributorCanonical(operation, id, body).canonical) } });
        expect(await f.snapshot()).toEqual(before); expect((await request(prefix, resource, actors.manager, `/request/${body.request_id}`)).response.status).toBe(404);
      }
      // Parse failures and a missing target never receive the domain proof.
      const invalid = input(current, { ...distributorLevelValues(), grade: 0 }), beforeInvalid = await f.snapshot();
      const parsed = await request(prefix, 'levels', actors.manager, '', 'POST', invalid);
      expect(parsed.response.status).toBe(200); expect(parsed.body).toMatchObject({ status: 400, data: null });
      const absent = await request(prefix, 'levels', actors.manager, '/2147483647', 'PUT', input(current, distributorLevelValues()));
      expect(absent.response.status).toBe(404); expect(absent.body).toMatchObject({ status: 404, data: null }); expect(await f.snapshot()).toEqual(beforeInvalid);
      const corrupt = input(current, distributorLevelValues());
      await f.db.insert(systemLog).values({ adminId: actors.manager, type: 'distributor_catalog', path: `/agent/distributor-catalog/request/${corrupt.request_id}`, action: 'owned-corrupt-journal' });
      const beforeCorrupt = await f.snapshot(), corrupted = await request(prefix, 'levels', actors.manager, '', 'POST', corrupt);
      expect(corrupted.response.status).toBe(200); expect(corrupted.body).toMatchObject({ status: 400, data: null }); expect(await f.snapshot()).toEqual(beforeCorrupt);
      // The final journal fails after a real business INSERT; this stays the
      // ordinary SQL error even though the transaction rolls back completely.
      await f.exec("CREATE FUNCTION reject_http_distributor_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='distributor_catalog' THEN RAISE EXCEPTION 'owned late HTTP receipt failure'; END IF; RETURN NEW; END $$");
      await f.exec('CREATE TRIGGER reject_http_distributor_receipt BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION reject_http_distributor_receipt()');
      try {
        const beforeSql = await f.snapshot(), failed = await request(prefix, 'levels', actors.manager, '', 'POST', input(current, distributorLevelValues()));
        expect(failed.response.status).toBe(200); expect(failed.body).toEqual({ status: 500, msg: '系统繁忙,请稍后再试', data: null }); expect(await f.snapshot()).toEqual(beforeSql);
      } finally {
        await f.exec('DROP TRIGGER reject_http_distributor_receipt ON system_log'); await f.exec('DROP FUNCTION reject_http_distributor_receipt()');
      }
      const id = 101 + index;
      await f.db.insert(agentLevelTask).values({ id, levelId: 999, name: '历史孤儿待退役', type: 3, number: 1, status: 1 });
      await f.db.insert(agentLevelTaskRecord).values({ uid: 91, levelId: 999, taskId: id, status: 0 });
      const parents = await request(prefix, 'level-tasks', actors.taskOnly, '/parents'), preserved = await f.snapshot();
      expect(parents.body.status).toBe(200); expect(parents.body.data.issues).toContain(`orphan_task:${id}`);
      expect((await request(prefix, 'levels', actors.taskOnly)).body.status).toBe(400011);
      const denied = await request(prefix, 'level-tasks', actors.taskOnly, `/${id}/status`, 'PATCH', reduced(parents.body.data.revision, 0));
      expect(denied.response.status).toBe(404); expect(denied.body.data).toBeNull(); expect(await f.snapshot()).toEqual(preserved);
      const body = reduced(parents.body.data.revision), deleted = await request(prefix, 'level-tasks', actors.taskOnly, `/${id}`, 'DELETE', body);
      expect(deleted.response.status).toBe(200); expect(deleted.body.status).toBe(200);
      expect(deleted.body.data).toEqual({ operation: 'task:delete', id, request_id: body.request_id, payload_hash: await distributorHash(distributorCanonical('task:delete', id, body).canonical) });
      const after = await f.snapshot();
      expect(after.tasks).toEqual(preserved.tasks.map(row => row.id === id ? { ...row, isDel: 1 } : row));
      expect(after.levels).toEqual(preserved.levels); expect(after.users).toEqual(preserved.users); expect(after.records).toEqual(preserved.records); expect(after.logs).toHaveLength(preserved.logs.length + 1);
      expect((await request(prefix, 'level-tasks', actors.taskOnly, `/request/${body.request_id}`)).body.data).toEqual(deleted.body.data);
      expect((await request(prefix, 'level-tasks', actors.taskOnly, `/${id}`, 'DELETE', body)).body.data).toEqual(deleted.body.data); expect(await f.snapshot()).toEqual(after);
    }
  }));
  it('rejects malformed/duplicate query/body, completed-task rewrites and forged assets while preserving every business row and journal', async () => profiles(async () => {
    const body = input(await revision(), distributorLevelValues()), before = await f.snapshot();
    for (const values of [{ ...distributorLevelValues(), image: '/api/assets/42' }, { ...distributorLevelValues(), image: '/api/assets/43' },
      { ...distributorLevelValues(), one_brokerage: 1, two_brokerage: 2 }, { ...distributorLevelValues(), grade: 0 }, { ...distributorLevelValues(), color: 'url(evil)' }]) {
      const response = await request('/adminapi', 'levels', actors.manager, '', 'POST', { ...body, values }); expect(response.body.status).not.toBe(200); expect(response.response.status).not.toBe(409);
    }
    const raw = JSON.stringify(body).replace('"grade":4', '"grade":4,"gr\\u0061de":5'); expect((await request('/api/admin', 'levels', actors.manager, '', 'POST', undefined, raw)).body.status).not.toBe(200);
    for (const suffix of ['?status=1&status=0', '?page=01', '?is_del=1', '/1?keyword=x', '/request/not-a-uuid']) expect((await request('/adminapi', 'levels', actors.manager, suffix)).body.status).not.toBe(200);
    for (const suffix of ['', '?level_id=0', '?level_id=1&level_id=2', '?id=1', '/parents?level_id=1']) expect((await request('/api/admin', 'level-tasks', actors.manager, suffix)).body.status).not.toBe(200);
    for (const values of [{ ...distributorTaskValues(1, 2), number: 11 }, { ...distributorTaskValues(1, 2), number: 10, is_must: 0 }]) expect((await request('/adminapi', 'level-tasks', actors.manager, '/21', 'PUT', { ...body, values })).body.status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before);
  }));
});
