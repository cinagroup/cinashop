import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, type Container } from '@/lib/di';
import { systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { adminAuthMiddleware } from '@/middleware/admin-auth';
import { adminLegacyRoleCreateForm, adminLegacyRoleEditForm, adminLegacyRoleSave } from '@/controllers/api/v1/AdminLegacyRoleController';
import { AdminLegacyRoleWorkflowService, MAX_LEGACY_ROLE_MENU_ROWS, MAX_LEGACY_ROLE_SELECTED_MENUS,
  parseLegacyRoleSave, type AdminLegacyRoleActor } from '@/services/admin/AdminLegacyRoleWorkflowService';
import { ApiException, HttpApiException } from '@/utils/errors';
import { createToken, md5 } from '@/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const env = { APP_KEY: 'legacy-role-workflow-local-only', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
type Reply = { status: number; msg: string; data: any };
const claims = (id = 102): AdminLegacyRoleActor => ({ id, authVersion: md5('role-fixture-password'), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
const payload = (checked_menus = [2], extra: Record<string, unknown> = {}) => ({ role_name: '保存角色', status: 1, checked_menus, ...extra });

describe('legacy platform role forms and numeric-menu writes', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>, container: Container;
  const tokens = new Map<number, string>();
  function application(afterAuth?: () => Promise<void>) {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', container); await next(); });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null },
      error instanceof HttpApiException ? error.httpStatus : 200));
    for (const prefix of ['/adminapi', '/api/admin']) {
      const auth = adminAuthMiddleware();
      const barrier = async (_c: unknown, next: () => Promise<void>) => { await afterAuth?.(); await next(); };
      app.get(`${prefix}/setting/role/create`, auth, barrier, adminLegacyRoleCreateForm);
      app.get(`${prefix}/setting/role/:id/edit`, auth, barrier, adminLegacyRoleEditForm);
      app.post(`${prefix}/setting/role/:id`, auth, barrier, adminLegacyRoleSave);
    }
    return app;
  }
  async function request(path: string, options: { id?: number; body?: unknown; method?: string; prefix?: string; app?: ReturnType<typeof application>; noToken?: boolean } = {}) {
    const response = await (options.app ?? application()).request(`${options.prefix ?? '/adminapi'}/setting/role/${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: { ...(options.noToken ? {} : { 'Authori-zation': `Bearer ${tokens.get(options.id ?? 102)}` }), 'Content-Type': 'application/json' },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }, env);
    return { response, body: await response.json<Reply>() };
  }
  async function allRoles() { return fixture.db.select().from(systemRole).orderBy(systemRole.id); }
  beforeAll(async () => {
    if (process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Role business tests require local memory only');
    fixture = await financePostgres([systemAdmin, systemRole, systemMenus]); container = createContainerFromDb(fixture.db);
    for (const id of [100,101,102,103,104,105,106,107,108,109]) {
      tokens.set(id, (await createToken(id, 'admin', md5('role-fixture-password'), env.APP_KEY)).token);
    }
  }, 30_000);
  beforeEach(async () => {
    await fixture.db.delete(systemAdmin); await fixture.db.delete(systemRole); await fixture.db.delete(systemMenus);
    await fixture.db.insert(systemMenus).values([
      { id: 1, menuName: '平台', authType: 0 },
      { id: 2, pid: 1, menuName: '商品父权限', authType: 2, apiUrl: 'product/list', methods: 'GET', sort: 4 },
      { id: 4, pid: 2, menuName: '商品子权限', authType: 2, apiUrl: 'product/list', methods: 'GET', sort: 3, isShow: 0 },
      { id: 5, pid: 1, menuName: '尚未迁移的旧权限', authType: 2, apiUrl: 'legacy/unmigrated-operation', methods: 'POST', sort: 2 },
      { id: 6, pid: 1, menuName: '无权限孤叶', authType: 0 },
      { id: 7, pid: 1, menuName: '用户权限', authType: 2, apiUrl: 'user/list', methods: 'GET' },
      { id: 8, menuName: '供应商节点', type: 4, authType: 2, apiUrl: 'product/list', methods: 'GET' },
      { id: 9, menuName: '已删节点', isDel: 1, authType: 2, apiUrl: 'product/list', methods: 'GET' },
      { id: 10, menuName: '禁用节点', access: 0, authType: 2, apiUrl: 'product/list', methods: 'GET' },
      { id: 11, menuName: '根叶权限', authType: 2, apiUrl: 'product/list', methods: 'GET', sort: 1 },
      { id: 220, menuName: '数字旧角色写', authType: 2, apiUrl: 'setting/role/:id', methods: 'POST' },
      { id: 21, menuName: '数字旧角色表单', authType: 2, apiUrl: 'setting/role/create', methods: 'GET' },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 900, roleName: '列表只读', level: 1, rules: 'system.legacy_role_view' },
      { id: 901, roleName: '表单只读', level: 1, rules: 'system.legacy_role_form_view,product.view,5' },
      { id: 902, roleName: '精确写权限', level: 1, rules: 'system.legacy_role_manage,product.view,5' },
      { id: 903, roleName: '现代管理', level: 1, rules: 'system.manage,product.view,5' },
      { id: 904, roleName: '其他业务', level: 1, rules: 'product.view' },
      { id: 905, roleName: '不持旧opaque权限', level: 1, rules: 'system.legacy_role_form_view,product.view' },
      { id: 906, roleName: '数字角色写权限', level: 1, rules: '220,2,5' },
      { id: 50, roleName: '平台子角色', level: 2, rules: '2' },
      { id: 51, type: 1, roleName: '平台旧子角色', level: 2, rules: '4', status: 0 },
      { id: 52, roleName: '现代规则', level: 2, rules: 'product.view' },
      { id: 53, roleName: '供应商角色', level: 2, type: 4, rules: '2' },
      { id: 54, roleName: '外关系角色', level: 2, relationId: 9, rules: '2' },
      { id: 55, roleName: '非下一层', level: 3, rules: '2' },
      { id: 56, roleName: '删除角色', level: 2, status: -1, rules: '2' },
      { id: 57, roleName: '不存在的规则', level: 2, rules: '99999' },
      { id: 58, roleName: '旧opaque角色', level: 2, rules: '5' },
      { id: 59, roleName: '旧结构祖先', level: 2, rules: '1,2' },
      { id: 60, roleName: '自己没有的权限', level: 2, rules: '7' },
      { id: 99, roleName: '超管下一层', level: 1, rules: '2' },
    ]);
    await fixture.db.insert(systemAdmin).values([
      { id: 100, account: 'role-super', pwd: 'role-fixture-password', level: 0 },
      ...[[101,901],[102,902],[103,903],[104,900],[105,904],[106,905],[107,906],[108,902],[109,902]].map(([id, role]) => ({
        id, account: `role-actor-${id}`, pwd: 'role-fixture-password', level: id === 108 ? 9 : 1, roles: String(role), relationId: id === 109 ? 7 : 0,
      })),
    ]);
  });
  afterAll(async () => { await fixture?.close(); });

  it('registers the two read forms and POST on both real router aliases', () => {
    const canonical = readFileSync(new NodeURL('../src/routes/adminapi.ts', import.meta.url), 'utf8');
    const modern = readFileSync(new NodeURL('../src/routes/v1/index.ts', import.meta.url), 'utf8');
    for (const [method, path, handler] of [['get','/setting/role/create','adminLegacyRoleCreateForm'], ['get','/setting/role/:id/edit','adminLegacyRoleEditForm'], ['post','/setting/role/:id','adminLegacyRoleSave']]) {
      expect(canonical).toContain(`adminapiRoutes.${method}("${path}", adminAuth, AdminLegacyRole.${handler})`);
      expect(modern).toContain(`v1Routes.${method}("/admin${path}", adminAuth, AdminLegacyRole.${handler})`);
    }
  });
  it('serves bounded lossless leaves and exact seven-field role DTOs on both aliases', async () => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      const created = await request('create', { prefix, id: 101 });
      expect(created.body.status).toBe(200); expect(Object.keys(created.body.data)).toEqual(['menus']);
      const menus = created.body.data.menus;
      expect(menus.map((node: any) => node.id)).toEqual([2,4,5,21,11]);
      expect(menus.every((node: any) => node.children.length === 0 && !('checked' in node) && !('disabled' in node))).toBe(true);
      expect(menus.find((node: any) => node.id === 4).title).toBe('平台 / 商品父权限 / 商品子权限');
      const edited = await request('51/edit', { prefix, id: 101 }); expect(edited.body.status).toBe(200);
      expect(Object.keys(edited.body.data.role).sort()).toEqual(['id','type','relation_id','role_name','rules','level','status'].sort());
      expect(edited.body.data.role).toMatchObject({ id: 51, type: 1, relation_id: 0, rules: '4', status: 0 });
      expect(created.response.headers.get('cache-control')).toBe('private, no-store');
      expect(edited.response.headers.get('pragma')).toBe('no-cache');
      expect(JSON.stringify(edited.body)).not.toMatch(/pwd|role-fixture-password|供应商节点|已删节点|禁用节点/);
    }
  });
  it.each([[2],[4],[2,4],[11],[5]].map(ids => ({ ids })))('round-trips actual legacy leaf-only initMenu and submit IDs $ids without changing grants', async ({ ids }) => {
    await fixture.db.update(systemRole).set({ rules: ids.join(',') }).where(eq(systemRole.id, 50));
    const read = await request('50/edit'); expect(read.body.status).toBe(200);
    // The real old initMenu marks only leaves by CSV membership. A flat grant
    // has no indeterminate permission ancestor, so submit has these exact IDs.
    const raw = `,${read.body.data.role.rules},`;
    const checked = read.body.data.menus.filter((node: any) => !node.children.length && raw.includes(`,${node.id},`)).map((node: any) => node.id);
    expect(new Set(checked)).toEqual(new Set(ids));
    const saved = await request('50', { body: { ...read.body.data.role, role_name: '只改名称', checked_menus: checked } });
    expect(saved.body.status).toBe(200);
    const [after] = await fixture.db.select().from(systemRole).where(eq(systemRole.id, 50));
    expect(after.rules).toBe([...ids].sort((a,b) => a-b).join(',')); expect(after.roleName).toBe('只改名称');
  });
  it('accepts actual old add-after-edit echoes but forces create scope and default disabled status', async () => {
    const old = (await request('51/edit')).body.data.role;
    const saved = await request('0', { body: { ...old, id: 0, type: 4, relation_id: 77, level: 8, rules: 'ignored.echo', role_name: ' 新建 ', checked_menus: [2,2], status: undefined } });
    expect(saved.body.status).toBe(200); expect(saved.body.msg).toBe('添加身份成功!');
    const [row] = await fixture.db.select().from(systemRole).where(eq(systemRole.id, saved.body.data.id));
    expect(row).toMatchObject({ roleName: '新建', type: 0, relationId: 0, level: 2, status: 0, rules: '2' });
  });
  it('submits the existing relative API path through both bases and updates only fixed fields', async () => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      const uri = new NodeURL('setting/role/51', `http://local${prefix}/`);
      expect(uri.pathname).toBe(`${prefix}/setting/role/51`);
      const before = (await fixture.db.select().from(systemRole).where(eq(systemRole.id, 51)))[0];
      const saved = await request('51', { prefix, body: payload([2], { id: 51, type: 4, relation_id: 8, level: 99 }) });
      expect(saved.body.status).toBe(200); expect(saved.body.msg).toBe('修改成功!');
      const [after] = await fixture.db.select().from(systemRole).where(eq(systemRole.id, 51));
      expect(after).toEqual({ ...before, roleName: '保存角色', status: 1, rules: '2' });
    }
  });
  it('blocks referenced status/grant changes through both old POST aliases without changing any authority table', async () => {
    await fixture.db.insert(systemAdmin).values({ id: 200, account: 'role-reference', roles: ' 50 ',
      pwd: 'role-fixture-password', level: 2, status: 0, isDel: 1 });
    const before = { admins: await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id),
      roles: await allRoles(), menus: await fixture.db.select().from(systemMenus).orderBy(systemMenus.id) };
    for (const prefix of ['/adminapi', '/api/admin']) {
      for (const body of [payload([2], { status: 0 }), payload([4])]) {
        const result = await request('50', { prefix, body });
        expect(result.response.status).toBe(409);
        expect(result.body).toMatchObject({ status: 409, msg: '角色已被管理员引用，修改权限或状态需要先确认影响范围' });
      }
    }
    expect({ admins: await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id),
      roles: await allRoles(), menus: await fixture.db.select().from(systemMenus).orderBy(systemMenus.id) }).toEqual(before);
  });
  it('preserves referenced name-only and structural-ancestor normalization saves without requiring impact confirmation', async () => {
    await fixture.db.insert(systemAdmin).values({ id: 200, account: 'role-reference', roles: '50,59',
      pwd: 'role-fixture-password', level: 2 });
    const beforeAdmin = await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id);
    for (const prefix of ['/adminapi', '/api/admin']) {
      expect((await request('50', { prefix, body: payload([2], { role_name: '仅改名称' }) })).body.status).toBe(200);
      expect((await request('59', { prefix, body: payload([1,2], { role_name: '结构规范化' }) })).body.status).toBe(200);
    }
    expect(await fixture.db.select().from(systemAdmin).orderBy(systemAdmin.id)).toEqual(beforeAdmin);
    expect((await allRoles()).find(row => row.id === 59)).toMatchObject({ rules: '2', roleName: '结构规范化', status: 1 });
  });
  it('keeps list-only and form-only privileges separated from writes', async () => {
    for (const id of [104,105]) expect((await request('create', { id })).body.status).toBe(400011);
    expect((await request('create', { id: 101 })).body.status).toBe(200);
    expect((await request('0', { id: 101, body: payload() })).body.status).toBe(400011);
    for (const id of [102,103,107]) expect((await request('0', { id, body: payload() })).body.status).toBe(200);
    expect((await request('create', { noToken: true })).body.status).toBe(410000);
  });
  it('enforces next-level platform target scope and refuses actor-assigned roles', async () => {
    for (const id of [53,54,55,56,9999]) {
      expect((await request(`${id}/edit`)).body.status).toBe(404);
      expect((await request(String(id), { body: payload() })).body.status).toBe(404);
    }
    expect((await request('902', { body: payload() })).body.status).toBe(409);
    expect((await request('50/edit', { id: 100 })).body.status).toBe(404);
    expect((await request('99/edit', { id: 100 })).body.status).toBe(200);
    expect((await request('create', { id: 109 })).body.status).toBe(410002);
  });
  it('derives legacy next-level 10 from live actor 9 while modern constraints stay separate', async () => {
    const saved = await request('0', { id: 108, body: payload() }); expect(saved.body.status).toBe(200);
    const [row] = await fixture.db.select().from(systemRole).where(eq(systemRole.id, saved.body.data.id)); expect(row.level).toBe(10);
    expect((await request(`${row.id}/edit`, { id: 108 })).body.status).toBe(200);
  });
  it('retains only actor-owned valid opaque IDs and never bypasses mapped-key delegation', async () => {
    expect((await request('58/edit', { id: 101 })).body.status).toBe(200);
    expect((await request('58/edit', { id: 106 })).body.status).toBe(400011);
    expect((await request('60/edit')).body.status).toBe(400011);
    const before = await allRoles();
    expect((await request('50', { body: payload([7]) })).body.status).toBe(400011);
    expect(await allRoles()).toEqual(before);
    await fixture.db.update(systemMenus).set({ apiUrl: 'user/list', methods: 'GET' }).where(eq(systemMenus.id, 5));
    // A held numeric ID acquires its current mapped meaning; we must not freeze
    // historical key meanings or claim that the actor lacks its live authority.
    expect((await request('58/edit')).body.status).toBe(200);
    await fixture.db.update(systemRole).set({ rules: 'system.legacy_role_manage,product.view' }).where(eq(systemRole.id, 902));
    expect((await request('58/edit')).body.status).toBe(400011);
    expect((await request('0', { body: payload([5]) })).body.status).toBe(400011);
    const superSaved = await request('0', { id: 100, body: payload([5]) }); expect(superSaved.body.status).toBe(200);
  });
  it('normalizes proved pure ancestors but rejects inert leaves and unselected structures', async () => {
    const read = await request('59/edit'); expect(read.body.status).toBe(200); expect(read.body.data.role.rules).toBe('1,2');
    expect(read.body.data.menus.map((node: any) => node.id)).not.toContain(1);
    expect((await request('59', { body: payload([1,2]) })).body.status).toBe(200);
    const [row] = await fixture.db.select().from(systemRole).where(eq(systemRole.id, 59)); expect(row.rules).toBe('2');
    for (const checked of [[1],[6],[6,2]]) expect((await request('0', { body: payload(checked) })).body.status).not.toBe(200);
  });
  it('never reclassifies explicitly rejected known-policy metadata as opaque, even for super or raw-ID members', async () => {
    const claims = [
      { id: 1592, authType: 2, apiUrl: 'product/list', methods: 'GET' },
      { id: 1593, authType: 2, apiUrl: 'product/list', methods: 'GET' },
      { id: 1594, authType: 2, apiUrl: 'product/list', methods: 'GET' },
      { id: 1490, authType: 2, apiUrl: 'product/list', methods: 'GET' },
      { id: 1035, authType: 2, apiUrl: 'product/list', methods: 'GET' },
      { id: 1075, authType: 2, apiUrl: 'product/list', methods: 'GET' },
      { id: 200001, authType: 1, menuPath: '/admin/setting/pages/home', uniqueAuth: 'forged' },
      { id: 200002, authType: 2, apiUrl: 'legacy/unmigrated-operation', methods: 'POST', uniqueAuth: 'theme_settings.manage' },
      { id: 200003, authType: 2, apiUrl: 'marketing/integral/batch', methods: 'GET' },
      { id: 200004, authType: 1, menuPath: '/admin/setting/system_role/index', uniqueAuth: 'forged' },
    ];
    for (const claim of claims) {
      await fixture.db.insert(systemMenus).values({ ...claim, menuName: '错误已知规则元数据' });
      await fixture.db.update(systemRole).set({ rules: `system.legacy_role_manage,product.view,5,${claim.id}` }).where(eq(systemRole.id, 902));
      await fixture.db.update(systemRole).set({ rules: String(claim.id) }).where(eq(systemRole.id, 50));
      await fixture.db.update(systemRole).set({ rules: String(claim.id) }).where(eq(systemRole.id, 99));
      for (const id of [102,100]) {
        const tree = await request('create', { id }); expect(tree.body.status).toBe(200);
        expect(tree.body.data.menus.map((node: any) => node.id)).not.toContain(claim.id);
        const target = id === 100 ? 99 : 50;
        expect((await request(`${target}/edit`, { id })).body.status).toBe(409);
        expect((await request('0', { id, body: payload([claim.id]) })).body.status).toBe(409);
      }
    }
  });
  it('requires genuine page/API metadata even when the global resolver produces a positive footprint', async () => {
    const malformed = [
      { id: 200101, authType: 2, apiUrl: 'product/list', methods: '' },
      { id: 200102, authType: 2, apiUrl: 'product/list', methods: 'BOGUS' },
      { id: 200103, authType: 2, apiUrl: 'product/list', methods: 'GET,BOGUS' },
      { id: 200104, authType: 2, apiUrl: '', methods: 'GET', uniqueAuth: 'product.view' },
      { id: 200105, authType: 2, apiUrl: '', methods: '', uniqueAuth: 'product.view' },
      { id: 200106, authType: 1, menuPath: '', uniqueAuth: 'product.view' },
    ];
    await fixture.db.insert(systemMenus).values(malformed.map(row => ({ ...row, menuName: '非法权限元数据' })));
    const before = await allRoles();
    for (const id of [102,100]) {
      const read = await request('create', { id }); expect(read.body.status).toBe(200);
      for (const row of malformed) {
        expect(read.body.data.menus.map((node: any) => node.id)).not.toContain(row.id);
        expect((await request('0', { id, body: payload([row.id]) })).body.status).toBe(409);
        expect((await request('0', { id, body: payload([2,row.id]) })).body.status).toBe(409);
      }
    }
    expect(await allRoles()).toEqual(before);
  });
  it('does not overwrite modern, missing, foreign, deleted or access-denied target rules', async () => {
    const before = await allRoles();
    for (const id of [52,57]) {
      expect((await request(`${id}/edit`)).body.status).toBe(409);
      expect((await request(String(id), { body: payload() })).body.status).toBe(409);
    }
    for (const rules of ['8','9','10','6','']) {
      await fixture.db.update(systemRole).set({ rules }).where(eq(systemRole.id, 50));
      const beforeTarget = (await fixture.db.select().from(systemRole).where(eq(systemRole.id, 50)))[0];
      expect((await request('50/edit')).body.status).not.toBe(200);
      expect((await request('50', { body: payload() })).body.status).not.toBe(200);
      expect((await fixture.db.select().from(systemRole).where(eq(systemRole.id, 50)))[0]).toEqual(beforeTarget);
    }
    expect((await allRoles()).filter(row => row.id !== 50)).toEqual(before.filter(row => row.id !== 50));
  });
  it('revalidates live actor, password, role and menu authority after ordinary middleware auth', async () => {
    for (const change of ['status','password','role','menu'] as const) {
      // Each variation resets only the changed authority rows, not a fabricated auth context.
      await fixture.db.update(systemAdmin).set({ status: 1, pwd: 'role-fixture-password' }).where(eq(systemAdmin.id, 102));
      await fixture.db.update(systemRole).set({ status: 1, rules: 'system.legacy_role_manage,product.view,5' }).where(eq(systemRole.id, 902));
      await fixture.db.update(systemMenus).set({ access: 1 }).where(eq(systemMenus.id, 2));
      const afterAuth = async () => {
        if (change === 'status') await fixture.db.update(systemAdmin).set({ status: 0 }).where(eq(systemAdmin.id, 102));
        if (change === 'password') await fixture.db.update(systemAdmin).set({ pwd: 'changed-password' }).where(eq(systemAdmin.id, 102));
        if (change === 'role') await fixture.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 902));
        if (change === 'menu') await fixture.db.update(systemMenus).set({ access: 0 }).where(eq(systemMenus.id, 2));
      };
      const before = (await fixture.db.select().from(systemRole).where(eq(systemRole.id, 50)))[0];
      expect((await request('50', { body: payload(), app: application(afterAuth) })).body.status).not.toBe(200);
      expect((await fixture.db.select().from(systemRole).where(eq(systemRole.id, 50)))[0]).toEqual(before);
    }
    const service = new AdminLegacyRoleWorkflowService(container);
    await expect(service.save('0', payload(), { ...claims(), expiresAt: 1 })).rejects.toMatchObject({ code: 410001 });
  });
  it('revalidates target and requested menus after GET without trusting old echo fields', async () => {
    expect((await request('50/edit')).body.status).toBe(200);
    await fixture.db.update(systemRole).set({ relationId: 7 }).where(eq(systemRole.id, 50));
    expect((await request('50', { body: payload() })).body.status).toBe(404);
    await fixture.db.update(systemRole).set({ relationId: 0 }).where(eq(systemRole.id, 50));
    await fixture.db.delete(systemMenus).where(eq(systemMenus.id, 4));
    expect((await request('50', { body: payload([4]) })).body.status).toBe(409);
    expect((await fixture.db.select().from(systemRole).where(eq(systemRole.id, 50)))[0]).toMatchObject({ rules: '2', roleName: '平台子角色' });
  });
  it('strictly rejects malformed paths, queries and bodies with no role writes', async () => {
    const before = await allRoles();
    for (const path of ['0/edit','01/edit','-1/edit','1e2/edit','2147483648/edit','50/edit?id=50','create?id=0','create?x=1&x=1']) {
      expect((await request(path)).body.status).toBe(400);
    }
    const invalid = [null, [], {}, payload([], {}), payload([0]), payload([-1]), payload([2147483648]), payload([1.5]), payload(['2'] as unknown as number[]),
      payload([2], { id: 51 }), payload([2], { status: '1' }), payload([2], { status: 2 }), payload([2], { status: null }), payload([2], { role_name: '' }),
      payload([2], { role_name: 'a'.repeat(33) }), payload([2], { role_name: 'a\n' }), payload([2], { unknown: true }),
      payload(Array(MAX_LEGACY_ROLE_SELECTED_MENUS + 1).fill(2)), payload([2], { rules: [] }), payload([2], { type: '0' })];
    for (const body of invalid) expect((await request('50', { body })).body.status).toBe(400);
    expect((await request('0?status=1', { body: payload() })).body.status).toBe(400);
    expect(await allRoles()).toEqual(before);
    expect(() => parseLegacyRoleSave('0', payload([2], { role_name: '😀'.repeat(32) }))).not.toThrow();
    expect(() => parseLegacyRoleSave('0', payload([2], { role_name: '😀'.repeat(33) }))).toThrow();
  });
  it('detects orphan and cyclic grant paths instead of returning partial selected permissions', async () => {
    await fixture.db.update(systemMenus).set({ pid: 9999 }).where(eq(systemMenus.id, 2));
    expect((await request('50/edit')).body.status).toBe(409);
    await fixture.db.update(systemMenus).set({ pid: 4 }).where(eq(systemMenus.id, 2));
    expect((await request('50/edit')).body.status).toBe(409);
    expect((await request('0', { body: payload([2]) })).body.status).toBe(409);
  });
  it('rejects explicitly over-deep breadcrumbs without silently discarding grants', async () => {
    await fixture.db.execute(sql`INSERT INTO ${systemMenus} (id,pid,menu_name,type,auth_type) SELECT n,CASE WHEN n=1000 THEN 0 ELSE n-1 END,'层',1,0 FROM generate_series(1000,1064) AS n`);
    await fixture.db.insert(systemMenus).values({ id: 1065, pid: 1064, menuName: '末级', authType: 2, apiUrl: 'product/list', methods: 'GET' });
    expect((await request('create')).body.status).toBe(503);
  });
  it('returns all 10000 scoped menu rows and rejects 10001 rather than truncating', async () => {
    await fixture.db.delete(systemMenus);
    await fixture.db.execute(sql`INSERT INTO ${systemMenus} (id,pid,menu_name,type,auth_type,api_url,methods)
      SELECT n,0,'完整菜单',1,2,'product/list','GET' FROM generate_series(100000,${100000 + MAX_LEGACY_ROLE_MENU_ROWS - 1}) AS n`);
    const read = await request('create'); expect(read.body.status).toBe(200); expect(read.body.data.menus).toHaveLength(MAX_LEGACY_ROLE_MENU_ROWS);
    expect(read.body.data.menus[0].id).toBe(109999); expect(read.body.data.menus.at(-1).id).toBe(100000);
    await fixture.db.insert(systemMenus).values({ id: 100000 + MAX_LEGACY_ROLE_MENU_ROWS, menuName: '超界', authType: 2, apiUrl: 'product/list', methods: 'GET' });
    const before = await allRoles(); expect((await request('create')).body.status).toBe(503);
    expect((await request('0', { body: payload([100000]) })).body.status).toBe(503); expect(await allRoles()).toEqual(before);
  }, 30_000);
});
