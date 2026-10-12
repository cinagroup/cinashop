import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb, withTx } from '@/lib/di';
import { systemMenus, systemRole } from '@/models/schema';
import { AdminPermissionService, assertDelegablePermissions, canRetainOpaqueLegacyMenu,
  hasAdminPermission, isAdminAuthorityRecoveryRoute, normalizeRoleRules, requiredAdminPermission } from '@/services/admin/AdminPermissionService';
import { financeMemoryPostgres } from './helpers/financePostgres';

const list = 'system.legacy_admin_view', form = 'system.legacy_admin_form_view', manage = 'system.legacy_admin_manage';
const writer = [manage,list,form];
const actor = (roles: string) => ({ id: 500, account: 'staff-operator', realName: '', divisionId: 0, level: 1, roles });
// Actual crmeb.sql 20,331..337,610,635 tuples, including its malformed edit page.
const seed = [
  { id:20,authType:1,menuPath:'/admin/setting/system_admin/index',uniqueAuth:'setting-system-list' },
  { id:331,authType:1,menuPath:'/admin/setting/system_admin/add',uniqueAuth:'setting-system_admin-add' },
  { id:332,authType:2,apiUrl:'setting/admin/create',methods:'GET' },
  { id:333,authType:2,apiUrl:'setting/admin',methods:'POST' },
  { id:334,authType:1,menuPath:'/admin /setting/system_admin/edit',uniqueAuth:' setting-system_admin-edit' },
  { id:335,authType:2,apiUrl:'setting/admin/<id>/edit',methods:'GET' },
  { id:336,authType:2,apiUrl:'setting/admin/<id>',methods:'PUT' },
  { id:337,authType:2,apiUrl:'setting/admin/<id>',methods:'DELETE' },
  { id:610,authType:2,apiUrl:'setting/admin',methods:'GET' },
  { id:635,authType:2,apiUrl:'setting/set_status/<id>/<status>',methods:'PUT' },
];

describe('legacy administrator exact route and numeric-menu authority', () => {
  let fixture: Awaited<ReturnType<typeof financeMemoryPostgres>>, permissions: AdminPermissionService;
  beforeAll(async () => {
    fixture = await financeMemoryPostgres([systemMenus,systemRole]);
    if (!fixture.isMemory) throw Error('Staff permission tests require local memory only');
    permissions = new AdminPermissionService(createContainerFromDb(fixture.db));
  });
  beforeEach(async () => {
    await fixture.db.delete(systemRole); await fixture.db.delete(systemMenus);
    await fixture.db.insert(systemMenus).values(seed.map(row => ({ ...row,type:1,menuName:'真实旧管理员权限' })));
    await fixture.db.insert(systemRole).values([
      { id:5000,roleName:'名单',rules:'20,610' }, { id:5001,roleName:'表单',rules:'332,335' },
      { id:5002,roleName:'写入',rules:'333,336,337,635' }, { id:5003,roleName:'现代读',rules:'system.view' },
      { id:5004,roleName:'现代管理',rules:'system.manage' }, { id:5005,roleName:'细管理',rules:manage },
      { id:5006,roleName:'其他域',rules:'config.manage,system.legacy_role_manage' },
      { id:5007,roleName:'供应商',type:4,rules:manage }, { id:5008,roleName:'停用',status:0,rules:manage },
      { id:5009,roleName:'错误关系',relationId:8,rules:manage },
    ]);
  });
  afterAll(async () => { await fixture?.close(); });

  it('requires only the exact six old methods with actual and both placeholder spellings', () => {
    for (const prefix of ['/adminapi','/api/admin']) {
      for (const method of ['GET','HEAD']) {
        expect(requiredAdminPermission(method,`${prefix}/setting/admin`)).toBe(list);
        expect(requiredAdminPermission(method,`${prefix}/setting/admin/create`)).toBe(form);
        for (const id of ['7',':id','<id>','2147483647']) expect(requiredAdminPermission(method,`${prefix}/setting/admin/${id}/edit`)).toBe(form);
      }
      expect(requiredAdminPermission('POST',`${prefix}/setting/admin`)).toBe(manage);
      for (const id of ['7',':id','<id>']) {
        for (const method of ['PUT','DELETE']) expect(requiredAdminPermission(method,`${prefix}/setting/admin/${id}`)).toBe(manage);
        for (const status of ['0','1',':status','<status>']) expect(requiredAdminPermission('PUT',`${prefix}/setting/set_status/${id}/${status}`)).toBe(manage);
      }
      for (const [method,path] of [['GET','setting/admin/7'],['POST','setting/admin/7'],['PUT','setting/admin'],
        ['POST','setting/admin/create'],['DELETE','setting/admin/create'],['PUT','setting/admin/0'],
        ['PUT','setting/admin/07'],['PUT','setting/admin/2147483648'],['GET','setting/admin/0/edit'],
        ['GET','setting/admin/7/edit/extra'],['GET','setting/set_status/7/1'],['POST','setting/set_status/7/1'],
        ['PUT','setting/set_status/7/2'],['PUT','setting/set_status/7/01'],['PUT','setting/set_status/7/1/extra'],
        ['PATCH','setting/admin/7']]) expect(requiredAdminPermission(method,`${prefix}/${path}`)).toBeNull();
      expect(requiredAdminPermission('GET',`${prefix}/setting/administrator`)).toBe('config.view');
      expect(requiredAdminPermission('POST',`${prefix}/system_admin/save`)).toBe('system.manage');
    }
  });

  it('registers preview and only the owner receipt/resolve recovery verbs independently of write grants', () => {
    for (const prefix of ['/adminapi','/api/admin']) {
      expect(requiredAdminPermission('POST',`${prefix}/setting/admin-authority/preview`)).toBe(manage);
      expect(requiredAdminPermission('GET',`${prefix}/setting/admin-authority/preview`)).toBeNull();
      expect(requiredAdminPermission('POST',`${prefix}/setting/admin-authority/commit`)).toBeNull();
      for (const root of ['system/authority','setting/admin-authority']) {
        for (const method of ['GET','HEAD']) {
          expect(isAdminAuthorityRecoveryRoute(method,`${prefix}/${root}/receipt/:operationId`)).toBe(true);
          expect(requiredAdminPermission(method,`${prefix}/${root}/receipt/:operationId`)).toBeNull();
        }
        expect(isAdminAuthorityRecoveryRoute('POST',`${prefix}/${root}/resolve`)).toBe(true);
        for (const [method,path] of [['POST','receipt/uuid'],['GET','resolve'],['DELETE','receipt/uuid'],['POST','resolve/extra']]) {
          expect(isAdminAuthorityRecoveryRoute(method,`${prefix}/${root}/${path}`)).toBe(false);
        }
      }
    }
  });

  it('maps real seed methods without folding PUT or DELETE into POST in single/batch/locked SQL reads', async () => {
    const expected = [[list],[form],[form],writer,[],[form],writer,writer,[list],writer];
    expect(await permissions.resolveManyRulePermissionKeys(seed.map(row => String(row.id)))).toEqual(expected);
    for (let index=0;index<seed.length;index++) expect(await permissions.resolveRulePermissionKeys(String(seed[index].id))).toEqual(expected[index]);
    const locked = await withTx(createContainerFromDb(fixture.db), tx => new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment('5002',true));
    expect([...locked.keys]).toEqual(writer); expect(locked.missingRoleIds).toEqual([]);
    const batch = await permissions.resolveManyAdminPermissionKeys([actor('5000'),actor('5001'),actor('5002')]);
    expect(batch.map(keys => [...keys])).toEqual([[list],[form],writer]);
  });

  it('keeps list/form/fine writers out of sibling and all modern authority routes', async () => {
    for (const prefix of ['/adminapi','/api/admin']) {
      await expect(permissions.assertAuthorized(actor('5000'),'GET',`${prefix}/setting/admin`)).resolves.toBeUndefined();
      await expect(permissions.assertAuthorized(actor('5001'),'GET',`${prefix}/setting/admin/create`)).resolves.toBeUndefined();
      for (const roles of ['5000','5001','5006','5007','5008','5009']) {
        for (const [method,path] of [['POST','setting/admin'],['PUT','setting/admin/7'],['DELETE','setting/admin/7'],
          ['PUT','setting/set_status/7/1'],['POST','setting/admin-authority/preview']]) {
          await expect(permissions.assertAuthorized(actor(roles),method,`${prefix}/${path}`)).rejects.toThrow();
        }
      }
      for (const roles of ['5002','5005']) {
        for (const [method,path] of [['GET','setting/admin'],['GET','setting/admin/create'],['GET','setting/admin/7/edit'],
          ['POST','setting/admin'],['PUT','setting/admin/7'],['DELETE','setting/admin/7'],['PUT','setting/set_status/7/1'],
          ['POST','setting/admin-authority/preview']]) await expect(permissions.assertAuthorized(actor(roles),method,`${prefix}/${path}`)).resolves.toBeUndefined();
        for (const [method,path] of [['GET','setting/role'],['GET','system_admin/list'],['GET','system_menus/tree'],
          ['POST','system_admin/save'],['POST','system/authority/preview'],['POST','system/authority/commit']]) {
          await expect(permissions.assertAuthorized(actor(roles),method,`${prefix}/${path}`)).rejects.toThrow();
        }
      }
      await expect(permissions.assertAuthorized(actor('5000'),'GET',`${prefix}/setting/admin/create`)).rejects.toThrow();
    }
  });

  it('allows canonical grants in one direction and exposes a usable narrow menu without modern system access', async () => {
    const viewer = await permissions.resolveAdminPermissionKeys(actor('5003'));
    const manager = await permissions.resolveAdminPermissionKeys(actor('5004'));
    expect(hasAdminPermission(viewer,list)).toBe(true); expect(hasAdminPermission(viewer,form)).toBe(true); expect(hasAdminPermission(viewer,manage)).toBe(false);
    expect(hasAdminPermission(manager,manage)).toBe(true); expect(hasAdminPermission(new Set(['system.manage']),form)).toBe(true);
    for (const capability of [list,form,manage]) expect(() => assertDelegablePermissions(manager,[capability])).not.toThrow();
    for (const roles of ['5000','5001','5002','5005']) {
      const granted = await permissions.resolveAdminPermissionKeys(actor(roles));
      for (const key of ['system.view','system.manage','system.legacy_role_view','config.view']) {
        expect(hasAdminPermission(granted,key)).toBe(false); expect(() => assertDelegablePermissions(granted,[key])).toThrow();
      }
    }
    for (const keys of [new Set([list]),new Set([manage]),manager,viewer]) {
      expect(permissions.buildMenus(keys)).toContainEqual(expect.objectContaining({path:'/system/legacy-staff'}));
    }
    expect(permissions.buildMenus(new Set([list])).map(menu => menu.path)).toEqual(['/system/legacy-staff']);
    expect(permissions.buildMenus(new Set([form]))).toEqual([]);
    expect(requiredAdminPermission('GET','/api/admin/system/legacy-staff')).toBe(list);
    expect(requiredAdminPermission('POST','/api/admin/system/legacy-staff')).toBeNull();
    expect(normalizeRoleRules(manage)).toBe(`${list},${form},${manage}`);
    expect(normalizeRoleRules(form)).toBe(form);
    const children = permissions.permissionTree().find(group => group.key === 'system')!.children;
    for (const key of [list,form,manage]) expect(children).toContainEqual(expect.objectContaining({key}));
  });

  it('rejects the malformed seeded edit pair and accepts only its explicitly corrected exact pair', async () => {
    const [old] = await fixture.db.select().from(systemMenus).where(eq(systemMenus.id,334));
    expect(canRetainOpaqueLegacyMenu(old)).toBe(false); expect(await permissions.resolveRulePermissionKeys('334')).toEqual([]);
    await fixture.db.update(systemMenus).set({menuPath:'/admin/setting/system_admin/edit',uniqueAuth:'setting-system_admin-edit'}).where(eq(systemMenus.id,334));
    expect(await permissions.resolveRulePermissionKeys('334')).toEqual([form]);
    for (const patch of [{menuPath:'/admin /setting/system_admin/edit'}, {uniqueAuth:' setting-system_admin-edit'},
      {uniqueAuth:'setting-system_admin-add'}, {apiUrl:'setting/admin/7',methods:'PUT'}]) {
      await fixture.db.update(systemMenus).set({menuPath:'/admin/setting/system_admin/edit',uniqueAuth:'setting-system_admin-edit',apiUrl:'',methods:'',...patch}).where(eq(systemMenus.id,334));
      const [row] = await fixture.db.select().from(systemMenus).where(eq(systemMenus.id,334));
      expect(await permissions.resolveRulePermissionKeys('334')).toEqual([]); expect(canRetainOpaqueLegacyMenu(row)).toBe(false);
    }
  });

  it('protects every claimed identity/API/page/auth/capability before generic or opaque fallback', async () => {
    const claims = [
      {id:20,authType:2,apiUrl:'setting/admin',methods:'POST'},
      {id:332,authType:2,apiUrl:'product/list',methods:'GET'},
      {id:333,authType:2,apiUrl:'setting/admin/7',methods:'PUT'},
      {id:335,authType:2,apiUrl:'setting/admin/create',methods:'GET'},
      {id:336,authType:2,apiUrl:'setting/admin/7',methods:'DELETE'},
      {id:337,authType:2,apiUrl:'setting/admin/7',methods:'PUT'},
      {id:635,authType:2,apiUrl:'setting/admin/7',methods:'PUT'},
      {id:610,authType:2,apiUrl:'setting/admin',methods:'POST'},
      {id:6001,authType:1,menuPath:'/admin/setting/system_admin/index',uniqueAuth:'forged'},
      {id:6002,authType:1,menuPath:'/admin/product',uniqueAuth:'setting-system_admin-add'},
      {id:6003,authType:2,apiUrl:'unmigrated/writer',methods:'POST',uniqueAuth:manage},
      {id:6004,authType:2,apiUrl:'setting/admin/7',methods:'POST'},
      {id:6005,authType:2,apiUrl:'setting/admin/7',methods:'GET,PUT'},
      {id:6006,authType:2,apiUrl:'setting/set_status/7/2',methods:'PUT'},
      {id:6007,authType:2,apiUrl:'setting/admin/7',methods:'PUT',menuPath:'/admin/product'},
      {id:6008,authType:2,apiUrl:'setting/admin/7',methods:'PUT',uniqueAuth:'system.manage'},
      {id:6009,authType:2,apiUrl:'setting/admin-authority/preview',methods:'POST'},
      {id:6010,authType:1,menuPath:'/system/legacy-staff',uniqueAuth:'system.manage'},
      {id:6011,authType:2,apiUrl:'setting/admin/7',methods:'GET'},
      {id:6012,authType:2,apiUrl:'setting/admin/ 7',methods:'PUT'},
    ];
    for (const claim of claims) {
      await fixture.db.delete(systemMenus).where(eq(systemMenus.id,claim.id));
      await fixture.db.insert(systemMenus).values({...claim,type:1,menuName:'伪造已知权限'});
      const [row] = await fixture.db.select().from(systemMenus).where(eq(systemMenus.id,claim.id));
      expect(canRetainOpaqueLegacyMenu(row)).toBe(false);
      expect(await permissions.resolveRulePermissionKeys(String(claim.id))).toEqual([]);
      expect(await permissions.resolveManyRulePermissionKeys([String(claim.id)])).toEqual([[]]);
    }
    await fixture.db.insert(systemMenus).values({id:7000,authType:2,type:1,apiUrl:'legacy/unmigrated-operation',methods:'POST'});
    const [opaque] = await fixture.db.select().from(systemMenus).where(eq(systemMenus.id,7000));
    expect(canRetainOpaqueLegacyMenu(opaque)).toBe(true); expect(await permissions.resolveRulePermissionKeys('7000')).toEqual([]);
  });

  it('rejects disabled/deleted/foreign metadata and follows live revocation rather than retained numeric membership', async () => {
    for (const patch of [{access:0},{isDel:1},{type:4},{methods:'PATCH'},{authType:1}]) {
      await fixture.db.update(systemMenus).set({access:1,isDel:0,type:1,authType:2,methods:'POST',...patch}).where(eq(systemMenus.id,333));
      expect(await permissions.resolveRulePermissionKeys('333')).toEqual([]);
    }
    await fixture.db.update(systemRole).set({rules:'333'}).where(eq(systemRole.id,5002));
    expect([...await permissions.resolveAdminPermissionKeys(actor('5002'))]).toEqual([]);
    await fixture.db.update(systemMenus).set({access:1,isDel:0,type:1,authType:2,methods:'POST'}).where(eq(systemMenus.id,333));
    expect([...await permissions.resolveAdminPermissionKeys(actor('5002'))]).toEqual(writer);
    await fixture.db.update(systemMenus).set({methods:'GET'}).where(eq(systemMenus.id,333));
    expect([...await permissions.resolveAdminPermissionKeys(actor('5002'))]).toEqual([]);
  });
});
