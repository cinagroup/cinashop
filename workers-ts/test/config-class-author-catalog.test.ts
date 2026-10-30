import { createHash } from 'node:crypto';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { createToken, md5 } from '@/utils/jwt';
import { systemAdmin, systemRole, systemMenus, systemLog, systemConfigTab, systemConfig } from '@/models/schema';
import { adminAuthorityOperation } from '@/models/schema/adminAuthorityOperation';
import { AdminConfigClassService, CONFIG_CLASS_LOG_TYPE } from '@/services/admin/AdminConfigClassService';
import type { ConfigClassOperation, ConfigClassReceipt, ConfigClassRow } from '@/services/admin/AdminConfigClassInput';
import { financeMemoryPostgres } from './helpers/financePostgres';

// Only connection construction is replaced. Registered routes, JWT, live Admin
// capability resolution, controller, transactions and every SQL statement are
// real. PGlite is business/rollback evidence; it is not independent-session or
// native PostgreSQL privilege/lock verification.
const wiring = vi.hoisted(() => ({ application: vi.fn(), open: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: wiring.application, createAdminDatabaseSession: wiring.open }));
const env = { APP_KEY: 'local-config-class-author-fixture', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const PASSWORD = 'config-class-local-password';
const tables = [systemAdmin, systemRole, systemMenus, systemLog, systemConfigTab, systemConfig, adminAuthorityOperation];
const actor = (id = 101) => ({ id, authVersion: md5(PASSWORD), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
const UUID = (n = 1) => `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fields = (patch: Partial<Omit<ConfigClassRow, 'id'>> = {}) => ({ is_store: 0, pid: 0, title: '配置分类', eng_title: 'local_class', status: 1, info: 0, icon: 'ios-ionic', type: 3, sort: 0, ...patch });
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function canonical(operation: ConfigClassOperation, id: number, input: Record<string, unknown>) {
  return { operation, id, expected_revision: input.expected_revision ?? null,
    values: operation === 'create' || operation === 'update' ? { is_store: input.is_store, pid: input.pid, title: input.title, eng_title: input.eng_title, status: input.status, info: input.info, icon: input.icon, type: input.type, sort: input.sort } : null,
    status: operation === 'status' ? input.status : null };
}

describe('configuration-class author real SQL, registered Hono/JWT and durable metadata receipts', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>, container: ReturnType<typeof createContainerFromDb>, service: AdminConfigClassService, tokens: Record<number, string>;
  const app = createApp();
  beforeAll(async () => {
    f = await financeMemoryPostgres(tables, { namespace: 'public' }); container = createContainerFromDb(f.db); service = new AdminConfigClassService(container);
    wiring.application.mockImplementation(() => container); wiring.open.mockImplementation(() => ({ container, close: wiring.close }));
    tokens = {}; for (const id of [100, 101, 102, 103, 104]) tokens[id] = (await createToken(id, 'admin', md5(PASSWORD), env.APP_KEY)).token;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Metadata author must not contact provider or external accounts'));
  }, 30000);
  beforeEach(async () => {
    await f.reset();
    await f.db.insert(systemRole).values([{ id: 1, rules: 'config.manage' }, { id: 2, rules: 'config.view' }, { id: 3, rules: 'product.manage' }]);
    await f.db.insert(systemAdmin).values([
      { id: 100, account: 'root', pwd: PASSWORD, level: 0, roles: '' },
      { id: 101, account: 'manager', pwd: PASSWORD, level: 1, roles: '1' },
      { id: 102, account: 'reader', pwd: PASSWORD, level: 1, roles: '2' },
      { id: 103, account: 'unrelated', pwd: PASSWORD, level: 1, roles: '3' },
      { id: 104, account: 'foreign', pwd: PASSWORD, level: 1, roles: '1', adminType: 2, relationId: 9 },
    ]);
    await f.db.insert(systemConfigTab).values([
      { id: 1, isStore: 0, pid: 0, title: '总后台根', engTitle: 'platform_root', status: 2, info: 17, icon: 'ios-ionic', type: 3, sort: 9 },
      { id: 2, isStore: 0, pid: 1, title: '历史子类', engTitle: 'platform_child', status: 255, info: 255, type: 42, sort: 8 },
      { id: 3, isStore: 1, pid: 0, title: '门店根', engTitle: 'store_root', status: 1, info: 7, type: 3, sort: 9 },
      { id: 4, isStore: 0, pid: 0, title: '可编辑叶', engTitle: 'platform_leaf', status: 0, info: 23, type: 9, sort: 1 },
    ]);
    await f.exec("SELECT setval(pg_get_serial_sequence('system_config_tab','id'),100,false)");
    await f.db.insert(systemConfig).values({ id: 50, menuName: 'private_fixture_value', value: 'must-never-enter-metadata-response', configTabId: 2 });
  });
  afterEach(async () => {
    for (const trigger of ['config_class_rewrite', 'config_class_revoke', 'config_class_expire', 'config_class_audit_reject']) {
      await f.exec(`DROP TRIGGER IF EXISTS ${trigger} ON ${trigger === 'config_class_audit_reject' ? 'system_log' : 'system_config_tab'}`);
      await f.exec(`DROP FUNCTION IF EXISTS ${trigger}()`);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  afterAll(async () => { vi.restoreAllMocks(); await f?.close(); }, 30000);
  async function snapshot() {
    const rows = Object.fromEntries(await Promise.all(tables.map(async t => [getTableConfig(t).name, Array.from(await f.db.execute(sql.raw(`SELECT * FROM "${getTableConfig(t).name}" ORDER BY 1`)), row => ({ ...row }))])));
    const sequences = Array.from(await f.db.execute(sql`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`), row => ({ ...row }));
    return { rows, sequences };
  }
  async function unchanged<T>(work: () => Promise<T>): Promise<T> { const before = await snapshot(); try { return await work(); } finally { expect(await snapshot()).toEqual(before); } }
  async function request(method: string, path: string, input?: unknown, id = 101) {
    const result = await app.request(path, { method, headers: { ...(id ? { 'Authori-zation': `Bearer ${tokens[id]}` } : {}), 'Content-Type': 'application/json' }, body: input === undefined ? undefined : JSON.stringify(input) }, env);
    expect(result.headers.get('cache-control')).toContain('private'); expect(result.headers.get('cache-control')).toContain('no-store');
    return { result, body: await result.json<{ status: number; msg: string; data: any }>() };
  }
  const catalog = () => service.catalog(new URLSearchParams(), actor());
  async function intent(patch: Partial<Omit<ConfigClassRow, 'id'>> = {}, n = 1) { return { ...fields(patch), request_id: UUID(n), expected_revision: (await catalog()).revision }; }
  async function rowBody(id = 4, n = 1) { const s = await catalog(), row = s.list.find(r => r.id === id)!; const { id: _id, ...values } = row; return { ...values, request_id: UUID(n), expected_revision: s.revision }; }
  const logs = () => f.db.select().from(systemLog).orderBy(systemLog.id);

  it('returns the complete exact ten-field flat catalogue, status2/255,type3/42 and hidden scope without reading configuration values', async () => {
    expect(f.isMemory).toBe(true);
    const response = await unchanged(() => request('GET', '/adminapi/config_class/catalog'));
    expect(response.body.status).toBe(200); expect(Object.keys(response.body.data).sort()).toEqual(['count', 'list', 'revision']);
    expect(response.body.data.count).toBe(4); expect(response.body.data.list.map((r: ConfigClassRow) => r.id)).toEqual([1, 3, 2, 4]);
    for (const r of response.body.data.list) expect(Object.keys(r).sort()).toEqual(['eng_title', 'icon', 'id', 'info', 'is_store', 'pid', 'sort', 'status', 'title', 'type']);
    expect(response.body.data.list[0]).toMatchObject({ status: 2, info: 17, type: 3 }); expect(response.body.data.list[2]).toMatchObject({ status: 255, info: 255, type: 42 });
    expect(JSON.stringify(response.body)).not.toContain('must-never-enter-metadata-response'); expect(response.body.data.revision).toMatch(/^[a-f0-9]{64}$/u);
  });
  it('retains current SQL ILIKE/sort/paging and post-page tree semantics rather than taking a page as a complete parent tree', async () => {
    const first = await unchanged(() => request('GET', '/adminapi/config_class?limit=1&page=1'));
    expect(first.body.data).toMatchObject({ count: 4, page: 1, limit: 1, list: [{ id: 1 }] });
    const child = await unchanged(() => request('GET', '/adminapi/config_class/list?limit=1&page=3'));
    expect(child.body.data.list).toMatchObject([{ id: 2, pid: 1 }]);
    expect((await request('GET', '/adminapi/config_class?is_store=0&status=255&title=%')).body.data.list).toMatchObject([{ id: 2 }]);
  });
  it('preserves orphan and cyclic raw parent IDs in the complete flat source instead of silently dropping them', async () => {
    await f.db.update(systemConfigTab).set({ pid: 2 }).where(eq(systemConfigTab.id, 1));
    await f.db.update(systemConfigTab).set({ pid: 999 }).where(eq(systemConfigTab.id, 4));
    const s = await unchanged(catalog); expect(s.count).toBe(4); expect(s.list.find(r => r.id === 1)?.pid).toBe(2); expect(s.list.find(r => r.id === 2)?.pid).toBe(1); expect(s.list.find(r => r.id === 4)?.pid).toBe(999);
  });
  for (const prefix of ['/adminapi', '/api/admin']) it(`serves current and precise original metadata/form routes under${prefix}`, async () => {
    for (const path of ['/config_class/catalog', '/config_class', '/config_class/list', '/config_class/1/detail', '/setting/config_class', '/setting/config_class/create', '/setting/config_class/1/edit']) expect((await unchanged(() => request('GET', prefix + path))).body.status).toBe(200);
    const create = (await request('GET', prefix + '/setting/config_class/create')).body.data;
    expect(create).toMatchObject({ method: 'POST', action: 'setting/config_class' }); expect(create.rules.map((r: { field: string }) => r.field)).toEqual(['is_store', 'pid', 'title', 'eng_title', 'icon', 'type', 'status', 'sort']);
    expect(create.rules[1].data.map((r: { value: number }) => r.value)).toEqual([0, 1, 4]);
    const edit = (await request('GET', prefix + '/setting/config_class/1/edit')).body.data;
    expect(edit).toMatchObject({ method: 'PUT', action: 'setting/config_class/1' }); expect(edit.rules[5].options.map((r: { value: number }) => r.value)).toEqual([0, 3]); expect(edit.rules[6].options.map((r: { value: number }) => r.value)).toEqual([1, 2]);
    expect(edit.rules[1].data.map((r: { value: number }) => r.value)).toEqual([0, 4]);
  });
  it('returns exact detail without values and rejects missing or malformed identifiers', async () => {
    const s = await catalog(), detail = await unchanged(() => request('GET', '/adminapi/config_class/2/detail'));
    expect(detail.body.data).toEqual({ info: s.list.find(r => r.id === 2), revision: s.revision });
    for (const id of ['0', '01', '-1', 'abc', '999']) expect((await unchanged(() => request('GET', `/adminapi/config_class/${id}/detail`))).body.status).not.toBe(200);
  });
  for (const id of [0, 103, 104]) it(`rejects guest/unrelated/foreign actor${id} before catalogue or writer admission`, async () => {
    expect((await unchanged(() => request('GET', '/adminapi/config_class/catalog', undefined, id))).body.status).not.toBe(200);
    expect((await unchanged(() => request('POST', '/adminapi/config_class', fields(), id))).body.status).not.toBe(200);
  });
  it('admits view-only reads and forms but refuses all three legacy/current writer families', async () => {
    expect((await request('GET', '/adminapi/config_class/catalog', undefined, 102)).body.status).toBe(200);
    expect((await request('GET', '/adminapi/setting/config_class/create', undefined, 102)).body.status).toBe(200);
    for (const path of ['/adminapi/config_class', '/adminapi/setting/config_class', '/api/admin/config_class']) expect((await unchanged(() => request('POST', path, fields(), 102))).body.status).toBe(400011);
  });
  it('classifies every persisted role reference before resolving an otherwise valid config.view grant', async () => {
    await f.db.insert(systemRole).values({ id: 9, roleName: '被其它realm复用的ID', rules: 'product.view', type: 2, relationId: 9 });
    await f.db.update(systemAdmin).set({ roles: '2,9' }).where(eq(systemAdmin.id, 102));
    await expect(unchanged(() => service.catalog(new URLSearchParams(), actor(102)))).rejects.toThrow(/角色/u);
  });
  it('commits one exact nine-field author intent and complete row+receipt; retry/recovery after losing the response never recreates it', async () => {
    const input = await intent(), expectedHash = hash(canonical('create', 0, input));
    const first = await request('POST', '/adminapi/config_class', input); expect(first.body.status, first.body.msg).toBe(200);
    const committed = first.body.data as ConfigClassReceipt;
    expect(committed).toEqual({ operation: 'create', request_id: input.request_id, actor_id: 101, id: 100, payload_hash: expectedHash, revision: (await catalog()).revision, verified: true });
    expect((await service.detail(100, new URLSearchParams(), actor())).info).toEqual({ id: 100, ...fields() });
    const after = await snapshot(); expect((await request('GET', `/adminapi/config_class/receipt/${input.request_id}`)).body.data).toEqual(committed); expect(await snapshot()).toEqual(after);
    expect((await request('POST', '/api/admin/config_class', input)).body.data).toEqual(committed); expect(await snapshot()).toEqual(after); expect((await logs()).length).toBe(1);
  });
  it('preserves unknown metadata/status/type and entire untouched rows through a narrow explicit update', async () => {
    const input = { ...await rowBody(2), title: '只改名字' }, before = await catalog();
    const result = await request('PUT', '/adminapi/config_class/2', input); expect(result.body.status).toBe(200);
    const after = await catalog(); expect(after.list.find(r => r.id === 2)).toEqual({ ...before.list.find(r => r.id === 2), title: '只改名字' });
    expect(after.list.filter(r => r.id !== 2)).toEqual(before.list.filter(r => r.id !== 2)); expect(result.body.data.payload_hash).toBe(hash(canonical('update', 2, input)));
  });
  for (const patch of [{ status: 0 }, { status: 3 }, { type: 1 }, { type: 42 }]) it(`modern creation enforces original PHP enum choices${JSON.stringify(patch)} without narrowing legacy imported metadata`, async () => {
    const input = await intent(patch), result = await unchanged(() => request('POST', '/adminapi/config_class', input));
    expect(result.result.status).toBe(400); expect(result.body.data).toMatchObject({ code: 'CONFIG_CLASS_NOT_APPLIED', payload_hash: hash(canonical('create', 0, input)) });
  });
  for (const patch of [{ status: 254 }, { type: 41 }]) it(`modern update preserves historical enum values or chooses PHP options, but rejects another arbitrary value${JSON.stringify(patch)}`, async () => {
    const input = { ...await rowBody(2), ...patch }; expect((await unchanged(() => request('PUT', '/adminapi/config_class/2', input))).body.status).toBe(400);
  });
  it('retains the existing unversioned REST status/type numeric contract for legacy creation', async () => {
    const result = await request('POST', '/adminapi/config_class', fields({ status: 200, type: 777 })); expect(result.body.status).toBe(200);
    expect((await catalog()).list.find(r => r.id === 100)).toMatchObject({ status: 200, type: 777 });
  });
  it('retains old no-intent create/update trimming and audits the normalized text rather than its whitespace spelling', async () => {
    const created = await request('POST', '/adminapi/setting/config_class', fields({ title: '  legacy title  ', eng_title: '  legacy_key  ', icon: '  ios-star  ' }));
    expect(created.body).toMatchObject({ status: 200, data: { id: 100 } });
    expect((await catalog()).list.find(r => r.id === 100)).toEqual({ id: 100, ...fields({ title: 'legacy title', eng_title: 'legacy_key', icon: 'ios-star' }) });
    const changed = { ...fields({ title: '  changed title  ', eng_title: '  changed_key  ', icon: '  ios-gear  ' }), info: 23 };
    expect((await request('PUT', '/api/admin/config_class/4', changed)).body.status).toBe(200);
    expect((await catalog()).list.find(r => r.id === 4)).toEqual({ id: 4, ...fields({ title: 'changed title', eng_title: 'changed_key', icon: 'ios-gear', info: 23 }) });
    const entries = await logs();
    expect(JSON.parse(entries[0].action)[2]).toBe(hash(canonical('create', 0, fields({ title: 'legacy title', eng_title: 'legacy_key', icon: 'ios-star' }))));
    expect(JSON.parse(entries[1].action)[2]).toBe(hash(canonical('update', 4, fields({ title: 'changed title', eng_title: 'changed_key', icon: 'ios-gear', info: 23 }))));
  });
  it('checks legacy eng_title duplicates after trimming for both create and update without any SQL or audit changes', async () => {
    for (const method of ['POST', 'PUT']) {
      const input = fields({ eng_title: '  platform_root  ', ...(method === 'PUT' ? { info: 23 } : {}) });
      const result = await unchanged(() => request(method, method === 'POST' ? '/adminapi/config_class' : '/adminapi/setting/config_class/4', input));
      expect(result.body.status).toBe(400); expect(result.body.msg).toMatch(/分类字段已经存在/u); expect(result.body.data).toBeNull();
    }
  });
  for (const icon of [null, 7, true, {}, []]) it(`retains the old legacy non-string symbolic-icon fallback for${JSON.stringify(icon)}`, async () => {
    const result = await request('POST', '/adminapi/config_class', { ...fields(), icon });
    expect(result.body.status).toBe(200); expect((await catalog()).list.find(r => r.id === 100)?.icon).toBe('');
    expect((await logs()).length).toBe(1);
  });
  for (const [field, limit] of [['title', 255], ['eng_title', 255], ['icon', 30]] as const) it(`retains legacy ${field}'s trimmed UTF-16 ${limit}-unit limit while modern intents use complete Unicode characters`, async () => {
    const accepted = '🙂'.repeat(Math.floor(limit / 2)) + (limit % 2 ? 'x' : ''), tooLong = accepted + 'x';
    const result = await request('POST', '/adminapi/setting/config_class', { ...fields(), [field]: `  ${accepted}  ` });
    expect(result.body.status).toBe(200); expect((await catalog()).list.find(r => r.id === 100)?.[field]).toBe(accepted);
    expect((await unchanged(() => request('POST', '/adminapi/config_class', { ...fields({ eng_title: 'other_class' }), [field]: tooLong }))).body.status).toBe(400);
  });
  it('keeps modern raw text and its canonical fingerprint unchanged by legacy-only trimming', async () => {
    const input = await intent({ title: '  Modern 名称  ', eng_title: '  modern_key  ', icon: '  ios-modern  ' });
    const result = await request('POST', '/adminapi/config_class', input); expect(result.body.status).toBe(200);
    expect(result.body.data.payload_hash).toBe(hash(canonical('create', 0, input)));
    expect((await catalog()).list.find(r => r.id === 100)).toMatchObject({ title: input.title, eng_title: input.eng_title, icon: input.icon });
    expect((await unchanged(() => request('POST', '/adminapi/config_class', input))).body.data).toEqual(result.body.data);
  });
  for (const field of ['title', 'icon']) it(`legacy text compatibility does not remove the new ${field} control-character safety boundary`, async () => {
    const result = await unchanged(() => request('POST', '/adminapi/config_class', { ...fields(), [field]: '\tunsafe\t' }));
    expect(result.body.status).toBe(400); expect(result.body.data).toBeNull();
  });
  it('legacy string compatibility cannot modify readonly info on an existing metadata record', async () => {
    const result = await unchanged(() => request('PUT', '/adminapi/config_class/4', fields({ info: 24, title: '  unchanged metadata  ' })));
    expect(result.body.status).toBe(400); expect(result.body.msg).toMatch(/历史显示元数据不可修改/u);
  });
  it('retains legacy null, empty and missing numeric fallbacks without accepting an info change', async () => {
    const create = await request('POST', '/adminapi/config_class', { title: 'empty numeric values', eng_title: 'empty_numeric', is_store: '', pid: null, status: '', type: null, sort: '', info: '' });
    expect(create.body.status).toBe(200);
    expect((await catalog()).list.find(r => r.id === 100)).toEqual({ id: 100, ...fields({ title: 'empty numeric values', eng_title: 'empty_numeric', icon: '', type: 0 }) });
    const update = { title: 'missing numeric values', eng_title: 'missing_numeric', info: 23 };
    expect((await request('PUT', '/adminapi/config_class/4', update)).body.status).toBe(200);
    expect((await catalog()).list.find(r => r.id === 4)).toEqual({ id: 4, ...fields({ title: 'missing numeric values', eng_title: 'missing_numeric', icon: '', type: 0, info: 23 }) });
    expect((await unchanged(() => request('PUT', '/adminapi/config_class/4', { ...update, info: '' }))).body.status).toBe(400);
  });
  it('retains decimal and scientific legacy numeric spellings including every cascader element while preserving readonly info', async () => {
    const input = { ...fields({ title: 'legacy number spellings', eng_title: 'legacy_numbers' }), is_store: '0e0', pid: ['', '0.0', '1e0'], status: '2.00', type: '7e2', sort: ' 1e2 ', info: '23.0' };
    expect((await request('PUT', '/adminapi/setting/config_class/4', input)).body.status).toBe(200);
    expect((await catalog()).list.find(r => r.id === 4)).toEqual({ id: 4, ...fields({ title: 'legacy number spellings', eng_title: 'legacy_numbers', pid: 1, status: 2, type: 700, sort: 100, info: 23 }) });
    expect((await unchanged(() => request('POST', '/adminapi/config_class', { ...fields(), pid: ['bad', '1.0'] }))).body.status).toBe(400);
  });
  it('legacy Number compatibility rejects fractional, negative and overflowing values before any metadata or audit SQL changes', async () => {
    for (const patch of [{ is_store: '2.0' }, { pid: ['1.1', 0] }, { status: '2.56e2' }, { type: '-1e0' }, { sort: '2147483648.0' }, { info: '256' }, { sort: '1e309' }]) {
      const result = await unchanged(() => request('POST', '/adminapi/config_class', { ...fields(), ...patch }));
      expect(result.body.status).toBe(400); expect(result.body.data).toBeNull();
    }
  });
  it('modern intents and URL identifiers do not inherit the legacy Number parser', async () => {
    const input = await intent();
    for (const patch of [{ status: '1.0' }, { pid: ['0', '1e0'] }, { type: '3e0' }, { sort: '' }]) {
      const result = await unchanged(() => request('POST', '/adminapi/config_class', { ...input, ...patch }));
      expect(result.body.status).toBe(400); expect(result.body.data).toBeNull();
    }
    for (const path of ['/adminapi/config_class/4.0', '/adminapi/config_class/set_status/4/1.0']) expect((await unchanged(() => request('PUT', path, fields({ info: 23 })))).body.status).toBe(400);
  });
  it('reads a prior update receipt and replays it after later row deletion without redirecting the original result', async () => {
    const input = { ...await rowBody(), title: '已确认更新' }, saved = await request('PUT', '/adminapi/config_class/4', input); expect(saved.body.status).toBe(200);
    await request('DELETE', '/adminapi/config_class/4'); const before = await snapshot();
    expect((await request('PUT', '/adminapi/config_class/4', input)).body.data).toEqual(saved.body.data); expect(await snapshot()).toEqual(before);
  });
  it('uses0/1 for explicit list visibility while retaining imported2 before an explicit action', async () => {
    expect((await catalog()).list.find(r => r.id === 1)?.status).toBe(2);
    for (const status of [0, 1]) {
      const input = { request_id: UUID(status + 10), expected_revision: (await catalog()).revision, status };
      const result = await request('PUT', `/adminapi/config_class/set_status/1/${status}`, input); expect(result.body.status).toBe(200); expect(result.body.data.payload_hash).toBe(hash(canonical('status', 1, input)));
      expect((await catalog()).list.find(r => r.id === 1)).toMatchObject({ status, info: 17, type: 3 });
    }
  });
  it('deletes an unreferenced leaf once and returns the same committed receipt after it is gone', async () => {
    const input = { request_id: UUID(), expected_revision: (await catalog()).revision }, result = await request('DELETE', '/adminapi/config_class/4', input); expect(result.body.status).toBe(200);
    const after = await snapshot(); expect((await request('DELETE', '/adminapi/config_class/4', input)).body.data).toEqual(result.body.data); expect(await snapshot()).toEqual(after);
  });
  for (const variation of ['other-payload', 'other-operation', 'other-actor']) it(`refuses UUID reuse for${variation} without another write`, async () => {
    const input = await intent(); expect((await request('POST', '/adminapi/config_class', input)).body.status).toBe(200);
    const body = variation === 'other-payload' ? { ...input, title: '变更原请求' } : variation === 'other-operation' ? { request_id: input.request_id, expected_revision: input.expected_revision } : input;
    const path = variation === 'other-operation' ? '/adminapi/config_class/4' : '/adminapi/config_class';
    expect((await unchanged(() => request(variation === 'other-operation' ? 'DELETE' : 'POST', path, body, variation === 'other-actor' ? 100 : 101))).body.status).toBe(409);
  });
  it('never reveals another actor receipt and never fabricates a successful receipt for an unknown UUID', async () => {
    const input = await intent(); await request('POST', '/adminapi/config_class', input);
    expect((await unchanged(() => request('GET', `/adminapi/config_class/receipt/${input.request_id}`, undefined, 100))).body.status).toBe(404);
    expect((await unchanged(() => request('GET', `/adminapi/config_class/receipt/${UUID(999)}`))).body.status).toBe(404);
  });
  it('keeps the old no-intent POST/PUT/status/DELETE data shapes, final cascader ID and audited actual SQL behavior', async () => {
    const created = await request('POST', '/adminapi/setting/config_class', fields({ pid: 0 })); expect(created.body).toMatchObject({ status: 200, data: { id: 100 } });
    expect((await request('PUT', '/adminapi/setting/config_class/100', { ...fields({ pid: 1, title: '原路径编辑' }), pid: [0, 1] })).body).toMatchObject({ status: 200, data: { id: 100 } });
    expect((await catalog()).list.find(r => r.id === 100)?.pid).toBe(1);
    expect((await request('PUT', '/adminapi/setting/config_class/set_status/100/0')).body).toMatchObject({ status: 200, data: null });
    expect((await request('DELETE', '/adminapi/setting/config_class/100')).body).toMatchObject({ status: 200, data: null });
    expect((await logs()).map(r => [r.type, r.method])).toEqual([[CONFIG_CLASS_LOG_TYPE, 'POST'], [CONFIG_CLASS_LOG_TYPE, 'PUT'], [CONFIG_CLASS_LOG_TYPE, 'PUT'], [CONFIG_CLASS_LOG_TYPE, 'DELETE']]);
  });
  for (const patch of [{ pid: 4 }, { pid: 2 }, { pid: 3 }, { pid: 999 }, { eng_title: 'platform_root' }, { info: 24 }]) it(`rejects self/cycle/cross-scope/missing/duplicate/readonly mutation${JSON.stringify(patch)}`, async () => {
    const target = patch.pid === 2 ? 1 : 4, input = { ...await rowBody(target), ...patch };
    expect((await unchanged(() => request('PUT', `/adminapi/config_class/${target}`, input))).body.status).not.toBe(200);
  });
  for (const id of [1, 2]) it(`refuses deletion and scope migration for child/config-referenced row${id}`, async () => {
    const remove = { request_id: UUID(), expected_revision: (await catalog()).revision };
    expect((await unchanged(() => request('DELETE', `/adminapi/config_class/${id}`, remove))).body.status).not.toBe(200);
    const input = { ...await rowBody(id), is_store: 1, pid: 0 };
    expect((await unchanged(() => request('PUT', `/adminapi/config_class/${id}`, input))).body.status).not.toBe(200);
  });
  it('allows an explicit unreferenced leaf scope change with a valid same-scope parent and preserves info', async () => {
    const result = await request('PUT', '/adminapi/config_class/4', { ...await rowBody(), is_store: 1, pid: 3 }); expect(result.body.status).toBe(200);
    expect((await catalog()).list.find(r => r.id === 4)).toMatchObject({ is_store: 1, pid: 3, info: 23 });
  });
  it('rejects a formerly valid request after real xmin ABA, even when every displayed value has returned to its old value', async () => {
    const input = await rowBody(), before = await catalog();
    await f.db.update(systemConfigTab).set({ title: '中间状态' }).where(eq(systemConfigTab.id, 4)); await f.db.update(systemConfigTab).set({ title: '可编辑叶' }).where(eq(systemConfigTab.id, 4));
    const after = await catalog(); expect(after.list).toEqual(before.list); expect(after.revision).not.toBe(before.revision);
    const refused = await unchanged(() => request('PUT', '/adminapi/config_class/4', input));
    expect(refused.result.status).toBe(409); expect(refused.body).toMatchObject({ status: 409, data: {
      code: 'CONFIG_CLASS_NOT_APPLIED', operation: 'update', id: 4, request_id: input.request_id, payload_hash: hash(canonical('update', 4, input)),
    } });
  });
  it('returns a strictly bound real HTTP400 negative proof only after the exact authorized child-reference refusal rolled back', async () => {
    const input = { request_id: UUID(), expected_revision: (await catalog()).revision }, refused = await unchanged(() => request('DELETE', '/adminapi/config_class/1', input));
    expect(refused.result.status).toBe(400); expect(refused.body.data).toEqual({ code: 'CONFIG_CLASS_NOT_APPLIED', operation: 'delete', id: 1, request_id: input.request_id, payload_hash: hash(canonical('delete', 1, input)) });
    expect((await request('GET', `/adminapi/config_class/receipt/${input.request_id}`)).body.status).toBe(404);
  });
  it('does not manufacture a negative receipt for a malformed envelope, authority failure or unknown UUID', async () => {
    const malformed = await request('POST', '/adminapi/config_class', { request_id: UUID() }); expect(malformed.body.data).toBeNull();
    const denied = await request('POST', '/adminapi/config_class', await intent(), 102); expect(denied.body.data).toBeNull();
    const absent = await request('GET', `/adminapi/config_class/receipt/${UUID()}`); expect(absent.body.data).toBeNull();
  });
  for (const bad of [null, [], { extra: 1 }, { request_id: UUID() }, { expected_revision: '0'.repeat(64) }, { ...fields(), request_id: 'not-a-uuid', expected_revision: '0'.repeat(64) }, { ...fields(), pid: [0, 'bad'] }, { ...fields(), is_store: 2 }, { ...fields(), status: 256 }, { ...fields(), type: -1 }, { ...fields(), icon: 'x'.repeat(31) }, { ...fields(), title: 'x'.repeat(256) }]) it(`rejects malformed whole input${JSON.stringify(bad).slice(0, 70)} atomically`, async () => {
    expect((await unchanged(() => request('POST', '/adminapi/config_class', bad))).body.status).not.toBe(200);
  });
  it('retains255 Unicode characters in titles and30 in symbolic icons without inventing image/attachment authority', async () => {
    const input = await intent({ title: '中'.repeat(255), eng_title: '🙂'.repeat(255), icon: '中'.repeat(30) });
    expect((await request('POST', '/adminapi/config_class', input)).body.status).toBe(200);
    expect((await catalog()).list.find(r => r.id === 100)).toMatchObject({ title: input.title, eng_title: input.eng_title, icon: input.icon });
  });
  for (const path of ['/config_class/catalog?is_store=0', '/config_class?status=1&status=0', '/config_class/1/detail?secret=1', `/config_class/receipt/${UUID()}?other=1`]) it(`rejects unsupported/repeated query${path} without writes`, async () => {
    expect((await unchanged(() => request('GET', '/adminapi' + path))).body.status).not.toBe(200);
  });
  it('rejects mismatched body/path status and unsupported status2 list-toggle without rewriting imported2', async () => {
    for (const [status, body] of [[0, { status: 1 }], [2, {}]] as const) expect((await unchanged(() => request('PUT', `/adminapi/config_class/set_status/1/${status}`, body))).body.status).not.toBe(200);
    expect((await catalog()).list.find(r => r.id === 1)?.status).toBe(2);
  });
  it('returns5000 complete records, proves a new full-capacity intent was not applied and still replays an already successful UUID', async () => {
    await f.db.insert(systemConfigTab).values(Array.from({ length: 4995 }, (_, i) => ({ id: i + 5, title: `目录${i}`, engTitle: `bulk_${i}` })));
    expect((await catalog()).count).toBe(4999);
    await f.exec("SELECT setval(pg_get_serial_sequence('system_config_tab','id'),5000,false)");
    const successfulInput = await intent({ eng_title: 'last_available_class' }), successful = await request('POST', '/adminapi/config_class', successfulInput);
    expect(successful.body.status).toBe(200); expect(successful.body.data).toMatchObject({ id: 5000, request_id: successfulInput.request_id, verified: true });
    expect((await catalog()).count).toBe(5000);
    const input = await intent({ eng_title: 'capacity_refusal_class' }, 2);
    const refused = await unchanged(() => request('POST', '/adminapi/config_class', input));
    expect(refused.result.status).toBe(409); expect(refused.body.status).toBe(409); expect(refused.body.msg).toMatch(/5000项容量/u); expect(refused.body.data).toEqual({
      code: 'CONFIG_CLASS_NOT_APPLIED', operation: 'create', id: 0, request_id: input.request_id, payload_hash: hash(canonical('create', 0, input)),
    });
    const unknown = await unchanged(() => request('GET', `/adminapi/config_class/receipt/${input.request_id}`));
    expect(unknown.result.status).toBe(200); expect(unknown.body.status).toBe(404); expect(unknown.body.data).toBeNull();
    const replay = await unchanged(() => request('POST', '/api/admin/config_class', successfulInput));
    expect(replay.body.status).toBe(200); expect(replay.body.data).toEqual(successful.body.data);
    await f.db.insert(systemConfigTab).values({ id: 5001, title: '不能悄悄遗漏', engTitle: 'overflow' });
    expect((await unchanged(() => request('GET', '/adminapi/config_class/catalog'))).body.status).toBe(503);
  });
  it('keeps a5000-node deep chain complete in the flat catalogue and explicitly refuses oversized-depth legacy form serialization', async () => {
    await f.db.delete(systemConfig); await f.db.delete(systemConfigTab);
    await f.db.insert(systemConfigTab).values(Array.from({ length: 5000 }, (_, i) => ({ id: i + 1, pid: i, title: `深层${i}`, engTitle: `deep_${i}` })));
    const all = await unchanged(catalog); expect(all.count).toBe(5000); expect(all.list.at(-1)).toMatchObject({ id: 5000, pid: 4999 });
    const result = await unchanged(() => request('GET', '/adminapi/setting/config_class/create')); expect(result.body.status).toBe(503); expect(result.body.msg).toMatch(/128层.*不能截断/u); expect(result.body.data).toBeNull();
  });
  it('keeps an empty catalogue genuinely empty until an explicit create and does not seed defaults during reads', async () => {
    await f.db.delete(systemConfig); await f.db.delete(systemConfigTab);
    const empty = await unchanged(catalog); expect(empty.list).toEqual([]); expect(empty.count).toBe(0);
    const input = { ...fields(), request_id: UUID(), expected_revision: empty.revision };
    expect((await request('POST', '/adminapi/config_class', input)).body.status).toBe(200); expect((await catalog()).count).toBe(1);
  });
  for (const bytes of [new TextEncoder().encode('{'), new Uint8Array([0xff]), new Uint8Array(64 * 1024 + 1)]) it(`rejects malformed/invalid UTF8/oversized streamed JSON${bytes.length} without metadata writes or false negative proof`, async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(bytes); if (bytes.length <= 1) controller.close(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const raw = new Request('http://localhost/adminapi/config_class', { method: 'POST', headers: { 'Authori-zation': `Bearer ${tokens[101]}`, 'Content-Type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    const result = await unchanged(async () => { const response = await app.request(raw, undefined, env); return response.json<{ status: number; data: unknown }>(); });
    expect(result.status).toBe(400); expect(result.data).toBeNull(); if (bytes.length > 1) expect(cancelled).toBe(true);
  });
  it('rejects malformed or duplicate durable receipts instead of resolving an uncertain operation from a partial record', async () => {
    const input = await intent(); await request('POST', '/adminapi/config_class', input); const [row] = await logs();
    await f.db.update(systemLog).set({ action: 'not-json' }).where(eq(systemLog.id, row.id));
    expect((await unchanged(() => request('GET', `/adminapi/config_class/receipt/${input.request_id}`))).body.status).toBe(503);
    await f.db.update(systemLog).set({ action: row.action }).where(eq(systemLog.id, row.id));
    const { id: _id, ...duplicate } = row; await f.db.insert(systemLog).values(duplicate);
    expect((await unchanged(() => request('GET', `/adminapi/config_class/receipt/${input.request_id}`))).body.status).toBe(503);
  });
  it('rolls back a trigger rewriting readonly metadata, including every other fixture table and untouched sequence', async () => {
    await f.exec('CREATE FUNCTION config_class_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.info:=NEW.info+1; RETURN NEW; END $$');
    await f.exec('CREATE TRIGGER config_class_rewrite BEFORE UPDATE ON system_config_tab FOR EACH ROW EXECUTE FUNCTION config_class_rewrite()');
    const input = await rowBody(); expect((await unchanged(() => request('PUT', '/adminapi/config_class/4', input))).body.status).not.toBe(200);
  });
  it('rechecks the live config.manage capability after real in-transaction SQL changed its role and rolls back all rows', async () => {
    await f.exec("CREATE FUNCTION config_class_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE system_role SET rules='config.view' WHERE id=1; RETURN NEW; END $$");
    await f.exec('CREATE TRIGGER config_class_revoke BEFORE UPDATE ON system_config_tab FOR EACH ROW EXECUTE FUNCTION config_class_revoke()');
    const before = await snapshot(), result = await request('PUT', '/adminapi/config_class/4', await rowBody());
    expect(result.body.status).toBe(400011); expect((await snapshot()).rows).toEqual(before.rows);
    // Sequence increments after rolled-back INSERTs are not promised reversible
    // by PostgreSQL. This test asserts all business/audit/authority rows instead.
  });
  it('rolls back classification creation if the actual audit INSERT fails, never returning a verified success', async () => {
    await f.exec("CREATE FUNCTION config_class_audit_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$");
    await f.exec('CREATE TRIGGER config_class_audit_reject BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION config_class_audit_reject()');
    const before = await snapshot(), result = await request('POST', '/adminapi/config_class', await intent());
    expect(result.body.status).not.toBe(200); expect((await snapshot()).rows).toEqual(before.rows);
  });
  it('checks the database wall clock after real SQL wait and rolls back a now-expired actor', async () => {
    await f.exec('CREATE FUNCTION config_class_expire() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2.2); RETURN NEW; END $$');
    await f.exec('CREATE TRIGGER config_class_expire BEFORE UPDATE ON system_config_tab FOR EACH ROW EXECUTE FUNCTION config_class_expire()');
    const input = await rowBody(), before = await snapshot();
    await expect(service.mutate('update', 4, input, { ...actor(), expiresAt: Math.floor(Date.now() / 1000) + 2 })).rejects.toThrow(/过期/u);
    expect((await snapshot()).rows).toEqual(before.rows);
  }, 15000);
});
