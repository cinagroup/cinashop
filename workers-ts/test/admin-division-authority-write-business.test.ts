import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import { divisionApply, systemAdmin, systemMenus, systemRole, user } from '@/models/schema';
import { saveDivision, saveAgent, saveStaff, deleteDivisionRole } from '@/controllers/api/v1/AdminDivisionController';
import { adminAuthMiddleware } from '@/middleware/admin-auth';
import { DivisionManagementService, type DivisionAdminWriteScope, type SaveDivisionRoleInput } from '@/services/division/DivisionManagementService';
import { assertRemainingActivePlatformSuperAdmin, withAdminAuthorityWriteTx } from '@/services/admin/AdminAuthorityWriteService';
import { ApiException } from '@/utils/errors';
import { createToken, md5 } from '@/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const password = 'division-write-local-password';
const env = { APP_KEY: 'division-write-business-local-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const claims = (id = 2) => ({ id, authVersion: md5(password), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
const scope = (id = 2, extra: Partial<DivisionAdminWriteScope> = {}): DivisionAdminWriteScope =>
  ({ level: 0, divisionId: 0, actor: claims(id), ...extra });
const input = (extra: Partial<SaveDivisionRoleInput> = {}): SaveDivisionRoleInput =>
  ({ uid: 110, roleType: 1, divisionName: '新事业部', divisionPercent: 50, adminRoles: '1', ...extra });
type Reply = { status: number; msg: string; data: any };

describe('Division writes share the platform authority transaction', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>, container: Container;
  let service: DivisionManagementService, app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  let tokens: Record<number, string>;

  beforeAll(async () => {
    if (process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Division business tests require local memory only');
    fixture = await financePostgres([systemAdmin, systemRole, systemMenus, user, divisionApply], { namespace: 'public' });
    container = createContainerFromDb(fixture.db);
    service = new DivisionManagementService(container);
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', container); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    for (const prefix of ['/adminapi', '/api/admin']) {
      app.post(`${prefix}/agent/division/save`, adminAuthMiddleware(), saveDivision);
      app.post(`${prefix}/agent/division_agent/save`, adminAuthMiddleware(), saveAgent);
      app.post(`${prefix}/agent/division_staff/save`, adminAuthMiddleware(), saveStaff);
      app.delete(`${prefix}/agent/division/del/:uid`, adminAuthMiddleware(), deleteDivisionRole);
    }
    tokens = Object.fromEntries(await Promise.all([1, 2, 3, 10].map(async id =>
      [id, (await createToken(id, 'admin', md5(password), env.APP_KEY)).token])));
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });
  beforeEach(async () => {
    await fixture.exec('DROP TRIGGER IF EXISTS division_admin_write_test ON system_admin');
    await fixture.exec('DROP FUNCTION IF EXISTS division_admin_write_test()');
    await fixture.reset();
    await fixture.db.insert(systemRole).values([
      { id: 1, roleName: '事业部管理', rules: 'division.manage' },
      { id: 2, roleName: '商品管理', rules: 'product.manage' },
      { id: 3, roleName: '停用角色', rules: 'division.manage', status: 0 },
      { id: 4, roleName: '供应商角色', rules: 'division.manage', type: 4, relationId: 9 },
      { id: 5, roleName: '其他关系角色', rules: 'division.manage', relationId: 9 },
      { id: 6, roleName: '旧平台角色', rules: 'division.view', type: 1 },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 1, account: 'root-outside-division', pwd: password, level: 0 },
      { id: 2, account: 'division-manager', pwd: password, level: 1, roles: '1', divisionId: 110 },
      { id: 3, account: 'product-manager', pwd: password, level: 1, roles: '2' },
      { id: 10, account: 'division-110', pwd: password, level: 1, roles: '1', divisionId: 110 },
      { id: 11, account: 'supplier-foreign', pwd: password, level: 0, roles: '4', adminType: 4, relationId: 9, divisionId: 110 },
      { id: 12, account: 'relation-foreign', pwd: password, level: 0, roles: '5', relationId: 9, divisionId: 110 },
    ]);
    await fixture.exec("SELECT setval(pg_get_serial_sequence('system_admin', 'id'), 100, true)");
    // The manager is in the same division, but only the division's account is
    // selected for edits. Put the manager outside that account group initially.
    await fixture.db.update(systemAdmin).set({ divisionId: 0 }).where(eq(systemAdmin.id, 2));
    await fixture.db.insert(user).values([
      { uid: 110, account: 'division-user', divisionName: '原事业部', divisionType: 1,
        divisionStatus: 1, divisionId: 110, divisionPercent: 60, divisionInvite: 11111111 },
      { uid: 111, account: 'new-division-user', divisionInvite: 22222222 },
      { uid: 120, account: 'agent-user', divisionType: 2, divisionStatus: 1,
        divisionId: 110, agentId: 120, divisionPercent: 40 },
      { uid: 130, account: 'staff-user', divisionType: 3, divisionStatus: 1,
        divisionId: 110, agentId: 120, staffId: 130, divisionPercent: 20 },
    ]);
  });

  async function state() {
    return { admins: await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id),
      users: await fixture.db.select().from(user).orderBy(user.uid),
      applications: await fixture.db.select().from(divisionApply).orderBy(divisionApply.id) };
  }
  async function post(path: string, body: unknown, id = 1, prefix = '/adminapi') {
    const response = await app.request(`${prefix}${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authori-zation': `Bearer ${tokens[id]}` },
      body: JSON.stringify(body) }, env);
    return response.json<Reply>();
  }
  const body = (roles: unknown = [1]) => ({ uid: 110, division_name: 'HTTP事业部', division_percent: 50, roles });

  it('acquires the shared table barrier before every actor, role or division decision read', async () => {
    const events: string[] = [], dialect = new PgDialect();
    const observedDb = new Proxy(fixture.db, {
      get(target, key) {
        if (key === 'select') throw Error('Division decision read outside transaction');
        if (key === 'transaction') return (callback: (tx: DbClient) => Promise<unknown>) =>
          target.transaction(tx => callback(new Proxy(tx as unknown as DbClient, {
            get(inner, method) {
              const value = Reflect.get(inner, method);
              if (method === 'execute') return (query: SQL) => {
                events.push(dialect.sqlToQuery(query).sql);
                return Reflect.apply(value, inner, [query]);
              };
              if (method === 'select') return (...args: unknown[]) => {
                events.push('decision select');
                return Reflect.apply(value, inner, args);
              };
              return typeof value === 'function' ? value.bind(inner) : value;
            },
          })));
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const observed = new DivisionManagementService(createContainerFromDb(observedDb));
    await observed.saveRole(input(), scope(1));
    expect(events.slice(0, 5)).toEqual([
      'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', "SET LOCAL statement_timeout='5s'",
      "SET LOCAL lock_timeout='2s'", "SET LOCAL idle_in_transaction_session_timeout='5s'",
      'LOCK TABLE ONLY public.system_admin, ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE NOWAIT',
    ]);
    expect(events.indexOf('decision select')).toBe(5);
    expect(events.findIndex(event => event.includes('pg_advisory_xact_lock'))).toBeGreaterThan(5);
  });

  it('reads the current division scope instead of accepting a caller level override', async () => {
    const before = await state();
    await expect(service.saveRole(input(), scope(2, { level: 0, divisionId: 110 }))).rejects.toThrow('无权');
    expect(await state()).toEqual(before);
  });

  it('retains division.manage for agent and staff writes on both route prefixes', async () => {
    await fixture.db.update(systemAdmin).set({ divisionId: 110 }).where(eq(systemAdmin.id, 2));
    for (const prefix of ['/adminapi', '/api/admin']) {
      expect((await post('/agent/division_agent/save', { uid: 120, division_id: 110,
        division_name: '修改代理商', division_percent: 40 }, 2, prefix)).status).toBe(200);
      expect((await post('/agent/division_staff/save', { uid: 130, agent_id: 120,
        division_percent: 20 }, 2, prefix)).status).toBe(200);
    }
    await expect(service.saveRole(input({ roleType: 2, uid: 120, parentUid: 110 }), scope(3))).rejects.toThrow('权限');
  });

  it('rejects revoked, expired and password-stale claims atomically', async () => {
    const before = await state();
    await expect(service.saveRole(input(), scope(1, { actor: { ...claims(1), expiresAt: 1 } }))).rejects.toThrow('过期');
    await expect(service.saveRole(input(), scope(1, { actor: { ...claims(1), authVersion: md5('old-password') } }))).rejects.toThrow('凭据');
    await fixture.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 1));
    await expect(service.saveRole(input(), scope(10))).rejects.toThrow('权限');
    expect(await state()).toEqual(before);
  });

  it('rejects missing, inactive, foreign and broader requested roles before changing either row', async () => {
    for (const roles of ['999', '3', '4', '5', '2']) {
      const before = await state();
      await expect(service.saveRole(input({ adminRoles: roles }), scope(10))).rejects.toThrow();
      expect(await state()).toEqual(before);
    }
    await expect(service.saveRole(input({ adminRoles: '999' }), scope(1))).rejects.toThrow('不存在');
  });

  it('rechecks existing roles even when the request replaces them with an empty assignment', async () => {
    for (const roles of ['3', '4', '5', '999']) {
      await fixture.db.update(systemAdmin).set({ roles }).where(eq(systemAdmin.id, 10));
      const before = await state();
      await expect(service.saveRole(input({ adminRoles: '' }), scope(1))).rejects.toThrow('不存在');
      expect(await state()).toEqual(before);
    }
  });

  it('validates the complete CSV and the original JSON array without lossy coercion', async () => {
    for (const roles of ['1,bad', '1,2147483648', '1,-1', '1,1.5', '1,'.repeat(65),
      [true], ['1'], [1.5], [2147483648]]) {
      const before = await state();
      expect((await post('/agent/division/save', body(roles))).status).toBe(400);
      expect(await state()).toEqual(before);
    }
    expect((await post('/agent/division/save', body([1, 1, 6]))).status).toBe(200);
    expect((await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, 10)))[0].roles).toBe('1,6');
  });

  it('creates a platform division account with validated deduplicated roles', async () => {
    await service.saveRole(input({ uid: 111, adminAccount: 'new-division-admin',
      adminPassword: 'new-division-password', adminRoles: [1, 1, 6] }), scope(1));
    const [created] = await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.account, 'new-division-admin'));
    expect(created).toMatchObject({ adminType: 1, relationId: 0, level: 1, status: 1, isDel: 0,
      divisionId: 111, roles: '1,6' });
  });

  it('permits own contact changes and rejects own credentials or role changes', async () => {
    await service.saveRole(input({ adminPhone: '13800138000' }), scope(10));
    for (const extra of [{ adminRoles: '' }, { adminAccount: 'renamed-own-login' },
      { adminPassword: 'replacement-password' }]) {
      const before = await state();
      await expect(service.saveRole(input(extra), scope(10))).rejects.toThrow('当前登录');
      expect(await state()).toEqual(before);
    }
  });

  it('rejects a non-super edit of a division account promoted to level zero', async () => {
    await fixture.db.insert(systemAdmin).values({ id: 20, account: 'additional-division-manager',
      pwd: password, level: 1, roles: '1', divisionId: 110 });
    await fixture.db.update(systemAdmin).set({ level: 0 }).where(eq(systemAdmin.id, 10));
    const before = await state();
    await expect(service.saveRole(input(), scope(20))).rejects.toThrow('超级管理员');
    expect(await state()).toEqual(before);
  });

  it('edits the first platform account deterministically when a division has several accounts', async () => {
    await fixture.db.insert(systemAdmin).values({ id: 13, account: 'division-second-admin',
      pwd: password, divisionId: 110, roles: '6' });
    const [secondBefore] = await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, 13));
    await service.saveRole(input({ adminPhone: '13800138000' }), scope(1));
    const [firstAfter] = await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, 10));
    const [secondAfter] = await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id, 13));
    expect(firstAfter).toMatchObject({ phone: '13800138000', realName: '新事业部' });
    expect(secondAfter).toEqual(secondBefore);
  });

  it('protects the actor when bulk division deletion contains their account', async () => {
    await fixture.db.update(systemAdmin).set({ divisionId: 110 }).where(eq(systemAdmin.id, 1));
    const before = await state();
    await expect(service.deleteRole(110, scope(1))).rejects.toThrow('当前登录');
    expect(await state()).toEqual(before);
  });

  it('rejects a non-super actor deleting a same-division super account with empty roles', async () => {
    await fixture.db.insert(systemAdmin).values({ id: 20, account: 'additional-division-manager',
      pwd: password, level: 1, roles: '1', divisionId: 110 });
    await fixture.db.update(systemAdmin).set({ level: 0, roles: '' }).where(eq(systemAdmin.id, 10));
    const before = await state();
    await expect(service.deleteRole(110, scope(20))).rejects.toThrow('只有超级管理员');
    expect(await state()).toEqual(before);
    await fixture.db.update(systemAdmin).set({ level: 1 }).where(eq(systemAdmin.id, 10));
    const ordinaryBefore = await state();
    await expect(service.deleteRole(110, scope(20))).rejects.toThrow('无权');
    expect(await state()).toEqual(ordinaryBefore);
  });

  it('rejects an oversized platform deletion group with 503 without updating a truncated subset', async () => {
    await fixture.db.insert(systemAdmin).values(Array.from({ length: 1000 }, (_, index) => ({
      id: 200 + index, account: `division-bounded-${index}`, pwd: password, divisionId: 110, roles: '1',
    })));
    await fixture.db.insert(divisionApply).values({ uid: 120, divisionId: 110 });
    const before = await state();
    const response = await app.request('/adminapi/agent/division/del/110', { method: 'DELETE',
      headers: { 'Authori-zation': `Bearer ${tokens[1]}` } }, env);
    expect((await response.json<Reply>()).status).toBe(503);
    expect(await state()).toEqual(before);
  });

  it('deletes all platform division accounts while preserving supplier and foreign relations', async () => {
    await fixture.db.insert(systemAdmin).values({ id: 13, account: 'division-promoted-super',
      pwd: password, divisionId: 110, level: 0, roles: '1' });
    const foreignBefore = (await state()).admins.filter(row => row.id === 11 || row.id === 12);
    await service.deleteRole(110, scope(1));
    const after = await state();
    expect(after.admins.filter(row => row.id === 10 || row.id === 13).map(row => [row.isDel, row.status])).toEqual([[1, 0], [1, 0]]);
    expect(after.admins.filter(row => row.id === 11 || row.id === 12)).toEqual(foreignBefore);
    expect(after.users.filter(row => [110, 120, 130].includes(row.uid)).every(row => row.divisionType === 0)).toBe(true);
    expect(after.admins.find(row => row.id === 1)).toMatchObject({ level: 0, status: 1, isDel: 0 });
  });

  it('excludes the entire deletion group when checking the last active platform super administrator', async () => {
    await fixture.db.insert(systemAdmin).values({ id: 13, account: 'second-platform-super', pwd: password, level: 0 });
    await expect(withAdminAuthorityWriteTx(container, claims(1), 'division.manage', async tx =>
      assertRemainingActivePlatformSuperAdmin(tx, [1, 13]))).rejects.toThrow('至少一个');
  });

  it('rolls back all affected users and administrators when one real UPDATE is suppressed', async () => {
    await fixture.db.insert(systemAdmin).values({ id: 13, account: 'division-second-admin',
      pwd: password, divisionId: 110, roles: '1' });
    await fixture.exec(`CREATE FUNCTION division_admin_write_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.id = 13 THEN RETURN NULL; END IF; RETURN NEW; END $$`);
    await fixture.exec('CREATE TRIGGER division_admin_write_test BEFORE UPDATE ON system_admin FOR EACH ROW EXECUTE FUNCTION division_admin_write_test()');
    const before = await state();
    await expect(service.deleteRole(110, scope(1))).rejects.toThrow('删除失败');
    expect(await state()).toEqual(before);
  });

  it('checks the real stored administrator after RETURNING and rolls back an AFTER-trigger mismatch', async () => {
    await fixture.exec(`CREATE FUNCTION division_admin_write_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF pg_trigger_depth() = 1 THEN UPDATE system_admin SET roles = '2' WHERE id = NEW.id; END IF;
      RETURN NEW; END $$`);
    await fixture.exec('CREATE TRIGGER division_admin_write_test AFTER UPDATE ON system_admin FOR EACH ROW EXECUTE FUNCTION division_admin_write_test()');
    const before = await state();
    await expect(service.saveRole(input(), scope(1))).rejects.toThrow('结果不一致');
    expect(await state()).toEqual(before);
  });
});
