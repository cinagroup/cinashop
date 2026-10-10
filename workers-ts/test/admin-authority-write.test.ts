import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import bcrypt from 'bcryptjs';
import type { Env, AppVariables } from '@/env';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { adminSystemAdminSave, adminSystemRoleSave, adminSystemRoleDel } from '@/controllers/api/v1/AdminCrudController';
import { adminAuthMiddleware } from '@/middleware/admin-auth';
import { AdminAuthorityWriteService, assertRemainingActivePlatformSuperAdmin, inspectAdminRoleMutationImpact,
  normalizeAdminAuthorityRules, parseAdminAuthorityRoleIds, withAdminAuthorityWriteTx,
  type AdminAuthorityActor, type AdminRoleMutationImpact } from '@/services/admin/AdminAuthorityWriteService';
import { ApiException, HttpApiException } from '@/utils/errors';
import { createToken, md5 } from '@/utils/jwt';
import { financeMemoryPostgres } from './helpers/financePostgres';

const password = 'owned-memory-authority-password';
const actor = (id = 102): AdminAuthorityActor => ({ id, authVersion: md5(password), expiresAt: Math.floor(Date.now()/1000) + 3600 });
const dialect = new PgDialect();

/** Observe real statements on the original transaction, never substitute SQL,
 * results or privileges. PGlite is business evidence only, not native locking. */
function observeStatements(db: DbClient, statements: string[]): DbClient {
  return new Proxy(db, {
    get(database, property) {
      const method: unknown = Reflect.get(database, property);
      if (typeof method !== 'function') return method;
      if (property !== 'transaction') return method.bind(database);
      return (callback: (tx: DbClient) => Promise<unknown>, ...options: unknown[]) => Reflect.apply(method, database,
        [(tx: DbClient) => callback(new Proxy(tx, {
          get(transaction, key) {
            const operation: unknown = Reflect.get(transaction, key);
            if (typeof operation !== 'function') return operation;
            if (key !== 'execute') return operation.bind(transaction);
            return async (query: SQL, ...args: unknown[]) => {
              const result: unknown = await Reflect.apply(operation, transaction, [query, ...args]);
              statements.push(dialect.sqlToQuery(query).sql);
              return result;
            };
          },
        })), ...options]);
    },
  });
}

describe('atomic modern Admin authority writes in owned local memory', () => {
  let fixture: Awaited<ReturnType<typeof financeMemoryPostgres>>, container: Container, service: AdminAuthorityWriteService;
  const snapshot = async () => ({ admins: await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id),
    roles: await fixture.db.select().from(systemRole).orderBy(systemRole.id) });
  beforeAll(async () => {
    fixture = await financeMemoryPostgres([systemAdmin, systemRole, systemMenus], { namespace: 'public' });
    if (!fixture.isMemory) throw Error('Authority business tests require local memory only');
    container = createContainerFromDb(fixture.db); service = new AdminAuthorityWriteService(container);
  }, 30_000);
  beforeEach(async () => {
    await fixture.db.delete(systemAdmin); await fixture.db.delete(systemRole); await fixture.db.delete(systemMenus);
    await fixture.db.insert(systemMenus).values({ id: 2, menuName: '商品读取', authType: 2, apiUrl: 'product/list', methods: 'GET' });
    await fixture.db.insert(systemRole).values([
      { id: 900, roleName: '管理者', rules: 'system.manage,product.view', level: 1 },
      { id: 901, roleName: '只有只读', rules: 'system.view', level: 1 },
      { id: 902, roleName: '数字管理者', rules: 'system.manage,2', level: 1 },
      { id: 50, roleName: '商品角色', rules: 'product.view', level: 2 },
      { id: 51, roleName: '超出范围', rules: 'user.manage,user.view', level: 2 },
      { id: 52, roleName: '数字旧角色', rules: '2', level: 2 },
      { id: 53, type: 4, relationId: 0, roleName: '供应商角色', rules: 'product.view' },
      { id: 54, type: 1, relationId: 9, roleName: '其他关系', rules: 'product.view' },
      { id: 55, roleName: '已删除', status: -1, rules: 'product.view' },
      { id: 56, roleName: '停用角色', status: 0, rules: 'product.view' },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 100, account: 'super-one', pwd: password, level: 0 },
      { id: 101, account: 'super-two', pwd: password, level: 0 },
      { id: 102, account: 'manager', pwd: password, level: 1, roles: '900' },
      { id: 103, account: 'reader', pwd: password, level: 1, roles: '901' },
      { id: 104, account: 'numeric-manager', pwd: password, level: 1, roles: '902' },
      { id: 110, account: 'staff', pwd: password, level: 2, roles: '50' },
      { id: 111, account: 'numeric-staff', pwd: password, level: 2, roles: '52' },
      { id: 112, adminType: 4, account: 'supplier', pwd: password, roles: '50' },
      { id: 113, relationId: 9, account: 'other-realm', pwd: password, roles: '50' },
      { id: 114, isDel: 1, account: 'deleted', pwd: password, roles: '50' },
      { id: 115, account: 'unprivileged-target', pwd: password, roles: '51' },
    ]);
  });
  afterAll(async () => { await fixture?.close(); });

  it('validates complete CSV, safe IDs, columns and rule input before legacy normalization can truncate', async () => {
    expect(parseAdminAuthorityRoleIds('50, 50,56')).toEqual([50,56]);
    expect(() => parseAdminAuthorityRoleIds('1,'.repeat(65))).toThrow('128');
    expect(() => parseAdminAuthorityRoleIds('2147483648')).toThrow('格式');
    expect(() => normalizeAdminAuthorityRules(Array.from({ length: 2049 }, (_,index) => String(index + 1)))).toThrow('2048');
    expect(() => normalizeAdminAuthorityRules('product.manage')).not.toThrow();
    expect(normalizeAdminAuthorityRules('product.manage')).toBe('product.view,product.manage');
    const before = await snapshot();
    for (const body of [{ id:110, real_name:'中'.repeat(17) }, { id:110, status:'1' }, { id:110, level:'0' },
      { id:110, roles:['50'] }, { id:110, phone:'中'.repeat(33) }, { id:-1, real_name:'wrong' }]) {
      await expect(service.saveAdmin(body, actor())).rejects.toBeInstanceOf(ApiException);
    }
    await expect(service.saveRole({ id:50, role_name:'😀'.repeat(33) }, actor())).rejects.toThrow('32');
    await expect(service.saveRole({ id:50, status:'0' }, actor())).rejects.toThrow('状态');
    expect(await snapshot()).toEqual(before);
  });

  it('revalidates the current DB actor, password version and expiration before each mutation', async () => {
    const before = await snapshot();
    for (const claims of [{ ...actor(), authVersion:md5('changed') }, { ...actor(), expiresAt:1 }, actor(112), actor(113), actor(114), actor(103)]) {
      await expect(service.saveAdmin({ id:110, real_name:'拒绝写入' }, claims)).rejects.toBeInstanceOf(ApiException);
    }
    expect(await snapshot()).toEqual(before);
    await fixture.db.update(systemAdmin).set({ pwd:'new-password-version' }).where(eq(systemAdmin.id, 102));
    await expect(service.saveAdmin({ id:110, real_name:'过期写入' }, actor())).rejects.toThrow('凭据');
    expect((await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id,110)))[0].realName).toBe('');
  });

  it('reads actor permissions again after middleware-era role rules or assignment were reduced', async () => {
    await fixture.db.update(systemRole).set({ rules:'system.view' }).where(eq(systemRole.id,900));
    const reduced = await snapshot();
    await expect(service.saveRole({ role_name:'不可创建', rules:'product.view' }, actor())).rejects.toThrow('权限已变化');
    expect(await snapshot()).toEqual(reduced);
    await fixture.db.update(systemRole).set({ rules:'system.manage,product.view' }).where(eq(systemRole.id,900));
    await fixture.db.update(systemAdmin).set({ roles:'901' }).where(eq(systemAdmin.id,102));
    await expect(service.deleteRole(56, actor())).rejects.toThrow('权限已变化');
  });

  it('takes the common barrier before invoking any decision callback and rolls back callback writes', async () => {
    const statements: string[] = [];
    const observed = createContainerFromDb(observeStatements(fixture.db, statements));
    const before = await snapshot();
    await expect(withAdminAuthorityWriteTx(observed, actor(), 'system.manage', async (tx, live) => {
      expect(statements).toEqual(expect.arrayContaining([
        'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
        'LOCK TABLE ONLY public.system_admin, ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE NOWAIT',
      ]));
      expect(live.id).toBe(102);
      await tx.update(systemAdmin).set({ realName:'应回滚' }).where(eq(systemAdmin.id,110));
      throw Error('forced owned business rollback');
    })).rejects.toThrow('forced owned business rollback');
    expect(await snapshot()).toEqual(before);
  });

  it('bounds live role authority before resolution and fails a transaction which expires after DML', async () => {
    await fixture.db.update(systemRole).set({ rules:Array.from({ length:2049 }, (_,index) => String(index+1)).join(',') }).where(eq(systemRole.id,900));
    await expect(service.saveRole({ role_name:'截断不得创建' }, actor())).rejects.toThrow('2048');
    await fixture.db.update(systemRole).set({ rules:'system.manage,product.view' }).where(eq(systemRole.id,900));
    const before = await snapshot();
    const claims = actor();
    await expect(withAdminAuthorityWriteTx(container, claims, 'system.manage', async tx => {
      await tx.update(systemAdmin).set({ realName:'过期应回滚' }).where(eq(systemAdmin.id,110));
      claims.expiresAt = 1;
    })).rejects.toThrow('过期');
    expect(await snapshot()).toEqual(before);
  });

  it('authorizes both the current and requested target roles and enforces platform target scope', async () => {
    const before = await snapshot();
    for (const id of [112,113,114,115]) await expect(service.saveAdmin({ id, real_name:'拒绝' }, actor())).rejects.toBeInstanceOf(ApiException);
    for (const roles of ['51','52','53','54','55','56','999']) {
      await expect(service.saveAdmin({ id:110, roles }, actor())).rejects.toBeInstanceOf(ApiException);
    }
    await expect(service.saveAdmin({ id:111, real_name:'数字旧规则' }, actor())).rejects.toThrow('旧版数字');
    expect(await snapshot()).toEqual(before);
    expect(await service.saveAdmin({ id:110, real_name:'正常姓名', phone:'123', roles:'50' }, actor())).toEqual({ id:110, created:false });
    expect((await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id,110)))[0].realName).toBe('正常姓名');
  });

  it('allows own harmless profile with modern or numeric actor roles but rejects changes to own authority', async () => {
    await expect(service.saveAdmin({ id:102, real_name:'本人姓名', roles:'900', level:1, status:1 }, actor())).resolves.toEqual({ id:102, created:false });
    await expect(service.saveAdmin({ id:104, real_name:'旧角色本人' }, actor(104))).resolves.toEqual({ id:104, created:false });
    const before = await snapshot();
    for (const body of [{ id:102, roles:'' }, { id:102, status:0 }, { id:102, level:2 }]) {
      await expect(service.saveAdmin(body, actor())).rejects.toThrow('本人账号');
    }
    expect(await snapshot()).toEqual(before);
  });

  it('preserves the existing own password reset and invalidates the previous JWT after commit', async () => {
    const env = { APP_KEY:'owned-memory-authority-self-password-key', UPSTASH_REDIS_URL:'', UPSTASH_REDIS_TOKEN:'' } as Env;
    const oldToken = (await createToken(102, 'admin', md5(password), env.APP_KEY)).token;
    const app = new Hono<{ Bindings:Env; Variables:AppVariables }>();
    app.use('*',async (c,next) => { c.set('container',container); await next(); });
    app.onError((error,c) => c.json({ status:error instanceof ApiException ? error.code : 500,msg:error.message,data:null },
      error instanceof HttpApiException ? error.httpStatus : 200));
    app.post('/adminapi/system_admin/save',adminAuthMiddleware(),adminSystemAdminSave);
    const request = (token:string,body:unknown) => app.request('/adminapi/system_admin/save',{ method:'POST',
      headers:{ 'Authori-zation':`Bearer ${token}`,'content-type':'application/json' },body:JSON.stringify(body) },env);
    const ownPassword = 'new-owned-self-password';
    expect(await (await request(oldToken,{ id:102,pwd:ownPassword })).json()).toMatchObject({ status:200,msg:'更新成功' });
    const [saved] = await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id,102));
    expect(await bcrypt.compare(ownPassword,saved.pwd)).toBe(true);
    expect(await (await request(oldToken,{ id:110,real_name:'旧JWT拒绝' })).json()).toMatchObject({ status:410001 });
    const newToken = (await createToken(102,'admin',md5(saved.pwd),env.APP_KEY)).token;
    expect(await (await request(newToken,{ id:102,real_name:'新JWT本人' })).json()).toMatchObject({ status:200,msg:'更新成功' });
    expect((await fixture.db.select().from(systemAdmin).where(eq(systemAdmin.id,110)))[0].realName).toBe('');
  });

  it('protects superadmin accounts and counts remaining supervisors outside the entire bulk target set', async () => {
    await expect(service.saveAdmin({ id:100, real_name:'不可管理' }, actor())).rejects.toThrow('超级管理员');
    await expect(service.saveAdmin({ id:110, level:0 }, actor())).rejects.toThrow('超级管理员');
    await expect(service.saveAdmin({ id:101, status:0 }, actor(100))).resolves.toEqual({ id:101, created:false });
    await expect(service.saveAdmin({ id:100, status:0 }, actor(100))).rejects.toThrow('本人账号');
    await fixture.db.update(systemAdmin).set({ status:1 }).where(eq(systemAdmin.id,101));
    await expect(withAdminAuthorityWriteTx(container, actor(100), 'system.manage', tx =>
      assertRemainingActivePlatformSuperAdmin(tx, [100,101]))).rejects.toThrow('至少一个');
    await expect(withAdminAuthorityWriteTx(container, actor(100), 'system.manage', tx =>
      assertRemainingActivePlatformSuperAdmin(tx, [101]))).resolves.toBeUndefined();
  });

  it('preserves modern rolelevel zero creation and scopes role writes/delete to live platform roles', async () => {
    const saved = await service.saveRole({ role_name:'现代等级零', rules:'product.view', level:0, status:1 }, actor());
    expect((await fixture.db.select().from(systemRole).where(eq(systemRole.id,saved.id)))[0]).toMatchObject({ level:0, type:0, relationId:0 });
    const before = await snapshot();
    for (const id of [53,54,55,900]) {
      await expect(service.saveRole({ id, role_name:'拒绝修改' }, actor())).rejects.toBeInstanceOf(ApiException);
      await expect(service.deleteRole(id, actor())).rejects.toBeInstanceOf(ApiException);
    }
    await expect(service.saveRole({ id:51, role_name:'范围外' }, actor())).rejects.toThrow('超出当前');
    expect(await snapshot()).toEqual(before);
    await service.deleteRole(56, actor());
    expect((await fixture.db.select().from(systemRole).where(eq(systemRole.id,56)))[0].status).toBe(-1);
  });

  it('reports referenced authority changes for a locked impact policy and preserves harmless role name edits', async () => {
    const before = await snapshot();
    await expect(service.saveRole({ id:50, rules:'' }, actor())).rejects.toThrow('确认影响范围');
    await expect(service.saveRole({ id:50, status:0 }, actor())).rejects.toThrow('确认影响范围');
    await expect(service.deleteRole(50, actor())).rejects.toThrow('确认影响范围');
    expect(await snapshot()).toEqual(before);
    await service.saveRole({ id:50, role_name:'只改名称' }, actor());
    let observed: AdminRoleMutationImpact | undefined;
    const policyService = new AdminAuthorityWriteService(container, async (_tx, live, impact) => {
      expect(live.id).toBe(100); observed = impact;
      throw new HttpApiException('owned policy wants review', 409, 409);
    });
    await expect(policyService.saveRole({ id:50, status:0 }, actor(100))).rejects.toThrow('owned policy wants review');
    expect(observed?.references.map(row => row.id)).toEqual([110,112,113,114]);
    expect(observed?.authorityChanged).toBe(true);
    expect(observed?.revision).toMatch(/^[a-f0-9]{64}$/);
    const [current] = await fixture.db.select().from(systemRole).where(eq(systemRole.id,50));
    const first = await withAdminAuthorityWriteTx(container, actor(100), 'system.manage', tx => inspectAdminRoleMutationImpact(tx,current,{ rules:current.rules, status:0 }));
    await fixture.db.update(systemAdmin).set({ roles:'50' }).where(eq(systemAdmin.id,115));
    const second = await withAdminAuthorityWriteTx(container, actor(100), 'system.manage', tx => inspectAdminRoleMutationImpact(tx,current,{ rules:current.rules, status:0 }));
    expect(first.revision).not.toBe(second.revision);
  });

  it('leaves numeric/modern rules byte-for-byte intact on harmless metadata updates without impact fanout', async () => {
    let policyCalls = 0;
    const metadataService = new AdminAuthorityWriteService(container, async () => { policyCalls++; throw Error('Unexpected impact scan'); });
    await metadataService.saveRole({ id:50, role_name:'普通名称', level:0, rules:'product.view', status:1 },actor());
    await metadataService.saveRole({ id:52, role_name:'数字旧名称', level:3 },actor(100));
    expect(policyCalls).toBe(0);
    expect((await fixture.db.select().from(systemRole).where(eq(systemRole.id,50)))[0]).toMatchObject({ rules:'product.view',level:0 });
    expect((await fixture.db.select().from(systemRole).where(eq(systemRole.id,52)))[0]).toMatchObject({ rules:'2',level:3 });
  });

  it('accepts referenced manage implicit-view form echoes but blocks real reductions or unrecognized current rules', async () => {
    await fixture.db.insert(systemRole).values({ id:57,roleName:'旧现代管理角色',rules:'system.manage',level:2 });
    await fixture.db.update(systemAdmin).set({ roles:'57' }).where(eq(systemAdmin.id,110));
    await expect(service.saveRole({ id:57,role_name:'改名保留管理',rules:'system.view,system.manage',status:1 },actor()))
      .resolves.toEqual({ id:57,created:false });
    const [expanded] = await fixture.db.select().from(systemRole).where(eq(systemRole.id,57));
    expect(expanded).toMatchObject({ roleName:'改名保留管理',rules:'system.view,system.manage' });
    const same = await withAdminAuthorityWriteTx(container,actor(),'system.manage',tx =>
      inspectAdminRoleMutationImpact(tx,{ ...expanded,rules:'system.manage' },{ rules:expanded.rules,status:1 }));
    expect(same.authorityChanged).toBe(false);
    const before = await snapshot();
    await expect(service.saveRole({ id:57,role_name:'减权不能当改名',rules:'system.view' },actor())).rejects.toThrow('确认影响范围');
    expect(await snapshot()).toEqual(before);
    await fixture.db.update(systemRole).set({ rules:'system.manage,unmapped.old' }).where(eq(systemRole.id,57));
    const unknown = await snapshot();
    await expect(service.saveRole({ id:57,role_name:'不能丢未知规则',rules:'system.view,system.manage' },actor(100)))
      .rejects.toThrow('确认影响范围');
    expect(await snapshot()).toEqual(unknown);
  });

  it('checks full RETURNING and same-transaction readback after inserts, updates and tombstones', async () => {
    await fixture.exec(`CREATE FUNCTION authority_admin_after_write_drift() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.real_name='trigger-admin' THEN
        UPDATE system_admin SET real_name='after-admin' WHERE id=NEW.id;
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER authority_admin_after_write_drift AFTER INSERT OR UPDATE ON system_admin
        FOR EACH ROW EXECUTE FUNCTION authority_admin_after_write_drift();
      CREATE FUNCTION authority_role_after_write_drift() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.role_name='triggered-role-write' THEN
        UPDATE system_role SET role_name='after-role-drift' WHERE id=NEW.id;
      ELSIF NEW.status=-1 AND NEW.role_name<>'after-delete-drift' THEN
        UPDATE system_role SET role_name='after-delete-drift' WHERE id=NEW.id;
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER authority_role_after_write_drift AFTER INSERT OR UPDATE ON system_role
        FOR EACH ROW EXECUTE FUNCTION authority_role_after_write_drift();`);
    try {
      const before = await snapshot();
      await expect(service.saveAdmin({ id:110,real_name:'trigger-admin' },actor())).rejects.toThrow('回读不一致');
      await expect(service.saveAdmin({ account:'after-create-proof',pwd:'new-created-password',real_name:'trigger-admin',roles:'50' },actor())).rejects.toThrow('回读不一致');
      await expect(service.saveRole({ id:50,role_name:'triggered-role-write' },actor())).rejects.toThrow('回读不一致');
      await expect(service.saveRole({ role_name:'triggered-role-write',rules:'product.view' },actor())).rejects.toThrow('回读不一致');
      await expect(service.deleteRole(56,actor())).rejects.toThrow('回读不一致');
      expect(await snapshot()).toEqual(before);
    } finally {
      await fixture.exec(`DROP TRIGGER authority_admin_after_write_drift ON system_admin;
        DROP FUNCTION authority_admin_after_write_drift();
        DROP TRIGGER authority_role_after_write_drift ON system_role;
        DROP FUNCTION authority_role_after_write_drift();`);
    }
  });

  it('keeps controller field names and success messages while using claims rather than cached adminInfo', async () => {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c,next) => { c.set('container',container); c.set('adminId',102);
      c.set('socketAuthVersion',actor().authVersion); c.set('socketTokenExp',actor().expiresAt);
      c.set('adminInfo',{ id:102, account:'stale-super', level:0, roles:'', realName:'', divisionId:0 }); await next(); });
    app.onError((error,c) => c.json({ status:error instanceof ApiException ? error.code : 500, msg:error.message, data:null },
      error instanceof HttpApiException ? error.httpStatus : 200));
    app.post('/system_admin/save',adminSystemAdminSave); app.post('/system_role/save',adminSystemRoleSave);
    app.delete('/system_role/del/:id',adminSystemRoleDel);
    const request = (path:string,body:unknown) => app.request(path,{ method:'POST',headers:{ 'content-type':'application/json' },body:JSON.stringify(body) });
    const success = await request('/system_admin/save',{ id:110, real_name:'HTTP姓名' });
    expect(await success.json()).toEqual({ status:200,msg:'更新成功',data:{ id:110 } });
    expect(success.headers.get('cache-control')).toBe('private, no-store');
    const denied = await request('/system_admin/save',{ id:110, level:0 });
    expect(await denied.json()).toMatchObject({ status:400,msg:'只有超级管理员可以管理超级管理员账号' });
    const created = await request('/system_role/save',{ role_name:'HTTP角色', rules:'product.view' });
    expect(await created.json()).toMatchObject({ status:200,msg:'创建成功' });
    const removed = await app.request('/system_role/del/56',{ method:'DELETE' });
    expect(await removed.json()).toEqual({ status:200,msg:'删除成功',data:null });
    const invalid = await app.request('/system_role/del/5e1',{ method:'DELETE' });
    expect(await invalid.json()).toMatchObject({ status:400,msg:'ID错误' });
  });
});
