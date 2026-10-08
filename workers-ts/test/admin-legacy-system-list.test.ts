import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono, type Handler } from 'hono';
import { eq, inArray, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { adminLegacySystemAdminList, adminLegacySystemRoleList,
  adminSystemAdminList, adminSystemRoleList, adminSystemAdminDirectory, adminSystemRoleDirectory,
  adminSystemPermissionTree, adminSystemAdminSave, adminSystemRoleSave, adminSystemRoleDel } from '@/controllers/api/v1/AdminCrudController';
import { adminAuthMiddleware } from '@/middleware/admin-auth';
import { AdminLegacySystemListService, type AdminLegacySystemListActor } from '@/services/admin/AdminLegacySystemListService';
import { ApiException } from '@/utils/errors';
import { createToken, md5 } from '@/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

type Kind = 'admin' | 'role';
type Reply = { status: number; msg: string; data: any };
const handlers: Record<Kind, Handler<{ Bindings: Env; Variables: AppVariables }>> = {
  admin: adminLegacySystemAdminList, role: adminLegacySystemRoleList,
};
const env = { APP_KEY: 'legacy-system-list-local-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const actor = (id = 101): AdminLegacySystemListActor => ({ id, authVersion: md5('fixture-password'), expiresAt: Math.floor(Date.now() / 1000) + 3600 });

describe('legacy platform staff and role read contracts', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>, container: Container;
  let tokens: Record<'reader' | 'super' | 'unrelated', string>;
  function application(target = container, afterAuth?: () => Promise<void>) {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', target); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    for (const prefix of ['/adminapi', '/api/admin']) {
      for (const kind of Object.keys(handlers) as Kind[]) {
        app.get(`${prefix}/setting/${kind}`, adminAuthMiddleware(), async (_c, next) => { await afterAuth?.(); await next(); }, handlers[kind]);
      }
      app.get(`${prefix}/system_admin/list`, adminAuthMiddleware(), adminSystemAdminList);
      app.get(`${prefix}/system_role/list`, adminAuthMiddleware(), adminSystemRoleList);
      app.get(`${prefix}/system_admin/directory`, adminAuthMiddleware(), adminSystemAdminDirectory);
      app.get(`${prefix}/system_role/directory`, adminAuthMiddleware(), adminSystemRoleDirectory);
      app.get(`${prefix}/system_menus/tree`, adminAuthMiddleware(), adminSystemPermissionTree);
      app.post(`${prefix}/system_admin/save`, adminAuthMiddleware(), adminSystemAdminSave);
      app.post(`${prefix}/system_role/save`, adminAuthMiddleware(), adminSystemRoleSave);
      app.delete(`${prefix}/system_role/del/:id`, adminAuthMiddleware(), adminSystemRoleDel);
    }
    return app;
  }
  async function get(kind: Kind, query = '', token = tokens.reader, prefix = '/adminapi', app = application()) {
    const response = await app.request(`${prefix}/setting/${kind}${query}`, {
      headers: token ? { 'Authori-zation': `Bearer ${token}` } : {},
    }, env);
    return { response, body: await response.json<Reply>() };
  }

  beforeAll(async () => {
    if (process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Legacy list business tests require local memory only');
    fixture = await financePostgres([systemAdmin, systemRole, systemMenus]);
    container = createContainerFromDb(fixture.db);
    await fixture.db.insert(systemRole).values([
      { id: 1, roleName: '目录只读', level: 1, rules: 'system.view' },
      { id: 2, roleName: '商品权限', level: 1, rules: 'product.view' },
      { id: 11, roleName: '历史平台', type: 1, level: 2, rules: '900,product.view' },
      { id: 12, roleName: 'percent%role', level: 2, rules: '900,901,902,777,unknown.key' },
      { id: 13, roleName: 'under_score', level: 2, status: 0 },
      { id: 14, roleName: 'slash\\role', level: 2 },
      { id: 15, roleName: '高级目录', level: 1 },
      { id: 16, roleName: '供应商秘密', level: 2, type: 4 },
      { id: 17, roleName: '其他关系秘密', level: 2, relationId: 9 },
      { id: 18, roleName: '门店秘密', level: 2, type: 2 },
      { id: 19, roleName: '已删除角色', level: 2, status: -1 },
    ]);
    await fixture.db.insert(systemMenus).values([
      { id: 900, type: 1, menuName: '旧平台菜单', authType: 2, apiUrl: 'setting/admin', methods: 'GET' },
      { id: 901, type: 1, menuName: '已删除菜单秘密', isDel: 1 },
      { id: 902, type: 4, menuName: '供应商菜单秘密' },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 100, account: 'fixture-super', pwd: 'fixture-password', level: 0 },
      { id: 101, account: 'fixture-reader', pwd: 'fixture-password', level: 1, roles: '1' },
      { id: 102, account: 'fixture-other', pwd: 'fixture-password', level: 1, roles: '2' },
      { id: 1, account: 'Percent%Account', realName: '阿甲', phone: '13800123000', level: 2, roles: '11,12,16,17,19', pwd: 'secret-target-1' },
      { id: 2, account: 'under_score', realName: '王乙', level: 2, roles: '1', lastTime: 1, addTime: 1 },
      { id: 3, account: 'slash\\name', level: 2, roles: '1,11' },
      { id: 4, account: "quoted'o", level: 2, status: 0 },
      { id: 5, account: 'mixedCase', realName: '管理员甲', level: 2 },
      { id: 6, account: 'normal', level: 2, roles: '11' },
      { id: 7, account: 'one-level', level: 1 },
      { id: 8, account: 'hidden-level3', level: 3 },
      { id: 9, account: 'hidden-supplier', level: 2, adminType: 4 },
      { id: 10, account: 'hidden-deleted', level: 2, isDel: 1 },
      { id: 20, account: 'hidden-negative', level: 2, status: -1 },
      { id: 21, account: 'hidden-store', level: 2, adminType: 2 },
    ]);
    const signed = await Promise.all([101, 100, 102].map(async id => (await createToken(id, 'admin', md5('fixture-password'), env.APP_KEY)).token));
    tokens = { reader: signed[0], super: signed[1], unrelated: signed[2] };
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  it('serves real middleware-authenticated snake-case staff DTOs on both aliases', async () => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      const { body, response } = await get('admin', '', tokens.reader, prefix);
      expect(body.status).toBe(200); expect(Object.keys(body.data).sort()).toEqual(['count', 'list']);
      expect(body.data.count).toBe(6); expect(body.data.list.map((row: any) => row.id)).toEqual([6, 5, 4, 3, 2, 1]);
      const first = body.data.list.find((row: any) => row.id === 1);
      expect(Object.keys(first).sort()).toEqual(['id','account','real_name','phone','roles','level','status','last_ip','last_time','add_time','_add_time','_last_time'].sort());
      expect(first).toMatchObject({ real_name: '阿甲', roles: '历史平台,percent%role', _add_time: '1970-01-01 08:00:00', _last_time: '' });
      expect(body.data.list.find((row: any) => row.id === 2)).toMatchObject({ _add_time: '1970-01-01 08:00:01', _last_time: '1970-01-01 08:00:01' });
      expect(JSON.stringify(body)).not.toMatch(/pwd|secret-target|供应商秘密|其他关系秘密/);
      expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(response.headers.get('pragma')).toBe('no-cache');
    }
  });

  it('uses exact next-level scope for ordinary and super actors', async () => {
    expect((await get('admin', '', tokens.super)).body.data.list.map((row: any) => row.id)).toEqual([102,101,7]);
    expect((await get('role', '', tokens.super)).body.data.list.map((row: any) => row.id)).toEqual([15,2,1]);
    expect((await get('role')).body.data.list.map((row: any) => row.id)).toEqual([14,13,12,11]);
  });

  it('matches account or name literally, including SQL metacharacters, and excludes phone search', async () => {
    for (const [name, ids] of [['percent%account', [1]], ['_', [2]], ['\\', [3]], ["quoted'o", [4]], [' 管理员甲 ', [5]], ['13800123', []]] as const) {
      const { body } = await get('admin', `?${new URLSearchParams({ name })}`);
      expect(body.status, name).toBe(200); expect(body.data.list.map((row: any) => row.id), name).toEqual(ids); expect(body.data.count).toBe(ids.length);
    }
    expect((await get('admin', '?name=%20%20')).body.data.count).toBe(6);
  });

  it('keeps CSV role ID membership exact and forces nondeleted records for old is_del values', async () => {
    expect((await get('admin', '?roles=1')).body.data.list.map((row: any) => row.id)).toEqual([3,2]);
    expect((await get('admin', '?roles=11')).body.data.list.map((row: any) => row.id)).toEqual([6,3,1]);
    for (const value of ['','0','1']) expect((await get('admin', `?is_del=${value}&roles=0`)).body.data.count).toBe(6);
  });

  it('uses identical filtered count/list predicates and stable bounded pagination', async () => {
    expect((await get('admin', '?status=0')).body.data).toMatchObject({ count: 1, list: [{ id: 4 }] });
    expect((await get('admin', '?status=1')).body.data.count).toBe(5);
    expect((await get('admin', '?status=')).body.data.count).toBe(6);
    expect((await get('admin', '?page=2&limit=2')).body.data.list.map((row: any) => row.id)).toEqual([4,3]);
    expect((await get('admin', '?page=101&limit=100')).body.data).toEqual({ list: [], count: 6 });
    expect((await get('role', '?page=2&limit=2')).body.data.list.map((row: any) => row.id)).toEqual([12,11]);
    expect((await get('role', '?page=500&limit=20')).body.data).toEqual({ list: [], count: 4 });
  });

  it('renders safe platform role and menu labels, including modern keys and unmigrated rules', async () => {
    for (const prefix of ['/adminapi','/api/admin']) {
      const { body } = await get('role', '', tokens.reader, prefix);
      expect(body.status).toBe(200); expect(body.data.count).toBe(4);
      expect(Object.keys(body.data.list[0]).sort()).toEqual(['id','type','relation_id','role_name','rules','level','status'].sort());
      expect(body.data.list.find((row: any) => row.id === 11).rules).toBe('旧平台菜单,商品管理：查看');
      expect(body.data.list.find((row: any) => row.id === 12).rules).toBe('旧平台菜单,未迁移菜单 #901,未迁移菜单 #902,未迁移菜单 #777,未识别权限');
      expect(JSON.stringify(body)).not.toMatch(/供应商.*秘密|其他关系秘密|已删除菜单秘密/);
    }
  });

  it('searches role_name literally and combines status', async () => {
    for (const [role_name, ids] of [['PERCENT%', [12]], ['_', [13]], ['\\', [14]], ['平台', [11]], ['供应商', []]] as const) {
      const { body } = await get('role', `?${new URLSearchParams({ role_name })}`);
      expect(body.data.list.map((row: any) => row.id)).toEqual(ids); expect(body.data.count).toBe(ids.length);
    }
    expect((await get('role', '?status=0')).body.data.list.map((row: any) => row.id)).toEqual([13]);
    expect((await get('role', '?role_name=under&status=1')).body.data).toEqual({ list: [], count: 0 });
  });

  it.each(['admin','role'] as Kind[])('rejects malformed %s query before opening a transaction', async kind => {
    const transaction = vi.fn(() => { throw Error('Invalid query reached SQL'); });
    const service = new AdminLegacySystemListService({ ...container, db: { transaction } as unknown as DbClient });
    const key = kind === 'admin' ? 'name' : 'role_name';
    const invalid = ['page=', 'page=0', 'page=01', 'page=1e2', 'page=%201', 'page=501', 'page=102&limit=100',
      'limit=0','limit=101','limit=01','limit=','page=1&page=1','status=0&status=1','status=2','status=01','unknown=1',
      `${key}=x&${key}=x`,`${key}=%00`,`${key}=%0a`,`${key}=%7f`,`${key}=${'a'.repeat(65)}`,
      ...(kind === 'admin' ? ['roles=1,2','roles=-1','roles=01','roles=2147483648','is_del=2','is_del=0&is_del=1'] : ['name=a'])];
    for (const query of invalid) await expect(kind === 'admin' ? service.adminList(new URLSearchParams(query), actor())
      : service.roleList(new URLSearchParams(query), actor())).rejects.toMatchObject({ code: 400 });
    expect(transaction).not.toHaveBeenCalled();
    expect((await get(kind, `?${key}=${'字'.repeat(64)}`)).body.status).toBe(200);
  });

  it('rejects missing login and unrelated permissions using actual Hono auth', async () => {
    for (const kind of ['admin','role'] as Kind[]) {
      expect((await get(kind, '', '')).body.status).toBe(410000);
      expect((await get(kind, '', tokens.unrelated)).body.status).toBe(400011);
      expect((await get(kind, '?status=2')).body.status).toBe(400);
    }
  });

  it('revalidates live actor password/status/type/deletion and expiry instead of stale adminInfo', async () => {
    for (const change of [{ status: 0 }, { adminType: 4 }, { isDel: 1 }, { pwd: 'changed-password' }]) {
      const app = application(container, async () => { await fixture.db.update(systemAdmin).set(change).where(eq(systemAdmin.id,101)); });
      try { expect((await get('admin', '', tokens.reader, '/adminapi', app)).body.status).toBe('pwd' in change ? 410001 : 410002); }
      finally { await fixture.db.update(systemAdmin).set({ status:1,adminType:1,isDel:0,pwd:'fixture-password' }).where(eq(systemAdmin.id,101)); }
    }
    const service = new AdminLegacySystemListService(container);
    await expect(service.roleList(new URLSearchParams(), { ...actor(), expiresAt: 1 })).rejects.toMatchObject({ code:410001 });
    await expect(service.roleList(new URLSearchParams(), { ...actor(), authVersion:'' })).rejects.toMatchObject({ code:410000 });
    await expect(service.roleList(new URLSearchParams(), { ...actor(), id:999 })).rejects.toMatchObject({ code:410002 });
  });

  it('rechecks role permission and live scope after ordinary auth', async () => {
    const revoked = application(container, async () => { await fixture.db.update(systemRole).set({ status:0 }).where(eq(systemRole.id,1)); });
    try { expect((await get('role', '', tokens.reader, '/adminapi', revoked)).body.status).toBe(400011); }
    finally { await fixture.db.update(systemRole).set({ status:1 }).where(eq(systemRole.id,1)); }
    const changedLevel = application(container, async () => { await fixture.db.update(systemAdmin).set({ level:2 }).where(eq(systemAdmin.id,101)); });
    try { expect((await get('admin', '', tokens.reader, '/adminapi', changedLevel)).body.data.list.map((row:any) => row.id)).toEqual([8]); }
    finally { await fixture.db.update(systemAdmin).set({ level:1 }).where(eq(systemAdmin.id,101)); }
  });

  it('keeps numeric legacy administrator and role grants separate from each other and modern directory/write authority', async () => {
    await fixture.db.insert(systemMenus).values({ id:903,type:1,authType:2,menuName:'旧角色菜单',apiUrl:'setting/role',methods:'GET' });
    await fixture.db.insert(systemRole).values([
      { id:30,roleName:'旧管理员只读',level:3,rules:'900' },
      { id:31,roleName:'旧角色只读',level:3,rules:'903' },
      { id:32,roleName:'独立旧目录键',level:3,rules:'system.legacy_admin_view,system.legacy_role_view' },
      { id:33,roleName:'下一层角色',level:4 },
    ]);
    await fixture.db.insert(systemAdmin).values([
      ...[200,201,202].map((id,index) => ({ id,account:`legacy-grant-${id}`,pwd:'fixture-password',level:3,roles:String(30+index) })),
      { id:204,account:'next-level-legacy',pwd:'never-project',level:4 },
    ]);
    try {
      const signed = await Promise.all([200,201,202].map(async id => (await createToken(id,'admin',md5('fixture-password'),env.APP_KEY)).token));
      for (const prefix of ['/adminapi','/api/admin']) {
        expect((await get('admin','',signed[0],prefix)).body.data).toMatchObject({ count:1,list:[{ id:204 }] });
        expect((await get('role','',signed[0],prefix)).body.status).toBe(400011);
        expect((await get('role','',signed[1],prefix)).body.data).toMatchObject({ count:1,list:[{ id:33 }] });
        expect((await get('admin','',signed[1],prefix)).body.status).toBe(400011);
        for (const token of signed) {
          for (const [method,path] of [['GET','system_admin/list'],['GET','system_role/list'],['GET','system_admin/directory'],
            ['GET','system_role/directory'],['GET','system_menus/tree'],['POST','system_admin/save'],['POST','system_role/save'],['DELETE','system_role/del/33']] as const) {
            const response = await application().request(`${prefix}/${path}`,{ method,headers:{ 'Authori-zation':`Bearer ${token}` } },env);
            expect((await response.json<Reply>()).status, `${prefix}/${path}`).toBe(400011);
          }
        }
        expect((await get('admin','',signed[2],prefix)).body.status).toBe(200);
        expect((await get('role','',signed[2],prefix)).body.status).toBe(200);
        // Canonical system.view retains access in the permitted direction only.
        expect((await get('admin','',tokens.reader,prefix)).body.status).toBe(200);
        expect((await get('role','',tokens.reader,prefix)).body.status).toBe(200);
      }
      // A permission change after ordinary authentication must still be caught
      // inside the Admin connection's snapshot by the exact endpoint capability.
      const changed = application(container,async () => { await fixture.db.update(systemRole).set({ rules:'903' }).where(eq(systemRole.id,30)); });
      expect((await get('admin','',signed[0],'/adminapi',changed)).body.status).toBe(400011);
    } finally {
      await fixture.db.delete(systemAdmin).where(inArray(systemAdmin.id,[200,201,202,204]));
      await fixture.db.delete(systemRole).where(inArray(systemRole.id,[30,31,32,33]));
      await fixture.db.delete(systemMenus).where(eq(systemMenus.id,903));
    }
  });

  it.each(['admin','role'] as Kind[])('reads %s count/list/labels in one bounded read-only snapshot and changes no rows', async kind => {
    const before = await Promise.all([fixture.db.select().from(systemAdmin),fixture.db.select().from(systemRole),fixture.db.select().from(systemMenus)]);
    let transactions = 0; const commands: string[] = [];
    const observedDb = new Proxy(fixture.db, { get(target, property) {
      if (property === 'transaction') return async (callback: (tx:DbClient) => Promise<unknown>) => {
        transactions++;
        return target.transaction(async tx => {
          const observedTx = new Proxy(tx, { get(inner, method) {
            if (['insert','update','delete'].includes(String(method))) throw Error('Legacy list attempted a write');
            const value = Reflect.get(inner,method);
            if (method === 'execute') return async (query:any) => { commands.push(new PgDialect().sqlToQuery(query).sql); return value.call(inner,query); };
            return typeof value === 'function' ? value.bind(inner) : value;
          } }) as unknown as DbClient;
          const result = await callback(observedTx);
          const settings = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly,
            current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`);
          expect(settings[0]).toEqual({ isolation:'repeatable read',readonly:'on',statement:'5s',lock:'2s',idle:'5s' });
          return result;
        });
      };
      const value = Reflect.get(target,property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const service = new AdminLegacySystemListService({ ...container, db: observedDb });
    await (kind === 'admin' ? service.adminList(new URLSearchParams(),actor()) : service.roleList(new URLSearchParams(),actor()));
    expect(transactions).toBe(1); expect(commands[0]).toContain('REPEATABLE READ, READ ONLY');
    expect(commands.some(query => /FOR\s+(?:SHARE|UPDATE)|^(?:INSERT|UPDATE|DELETE)/i.test(query))).toBe(false);
    const countIndex = commands.findIndex(query => query.includes('count(*)')); expect(countIndex).toBeGreaterThan(4);
    expect(commands[countIndex + 1]).toContain('ORDER BY id DESC');
    expect(await Promise.all([fixture.db.select().from(systemAdmin),fixture.db.select().from(systemRole),fixture.db.select().from(systemMenus)])).toEqual(before);
    expect((await fixture.db.execute(sql`SELECT current_setting('statement_timeout') AS timeout`))[0].timeout).toBe('0');
  });

  it('propagates read failures and oversized rules instead of returning a false empty success', async () => {
    const broken = new Proxy(fixture.db, { get(target,property) {
      if (property === 'transaction') return async (callback:(tx:DbClient)=>Promise<unknown>) => target.transaction(tx => callback(new Proxy(tx,{ get(inner,key) {
        const value = Reflect.get(inner,key);
        if (key === 'execute') return async (query:any) => { if (new PgDialect().sqlToQuery(query).sql.includes('count(*)')) throw Error('Local read failure'); return value.call(inner,query); };
        return typeof value === 'function' ? value.bind(inner) : value;
      } }) as unknown as DbClient));
      const value = Reflect.get(target,property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect((await get('admin','',tokens.reader,'/adminapi',application({ ...container,db:broken }))).body).toMatchObject({ status:500,data:null,msg:'Local read failure' });
    await fixture.db.update(systemRole).set({ rules:'x'.repeat(16385) }).where(eq(systemRole.id,14));
    try { expect((await get('role')).body.status).toBe(503); }
    finally { await fixture.db.update(systemRole).set({ rules:'' }).where(eq(systemRole.id,14)); }
  });

  it('registers both protected aliases while preserving modern array responses', async () => {
    for (const [file,prefix] of [['../src/routes/adminapi.ts',''],['../src/routes/v1/index.ts','/admin']] as const) {
      const source = readFileSync(new NodeURL(file,import.meta.url),'utf8');
      expect(source).toContain(`.get("${prefix}/setting/admin", adminAuth, AdminCrud.adminLegacySystemAdminList)`);
      expect(source).toContain(`.get("${prefix}/setting/role", adminAuth, AdminCrud.adminLegacySystemRoleList)`);
    }
    for (const kind of ['system_admin','system_role']) {
      const response = await application().request(`/adminapi/${kind}/list`, { headers:{ 'Authori-zation':`Bearer ${tokens.reader}` } },env);
      const body = await response.json<Reply>(); expect(body.status).toBe(200); expect(Array.isArray(body.data)).toBe(true);
    }
  });
});
