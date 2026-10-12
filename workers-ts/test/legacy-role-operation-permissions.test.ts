import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb, withTx } from '@/lib/di';
import { systemMenus, systemRole } from '@/models/schema';
import { AdminPermissionService, assertDelegablePermissions, canRetainOpaqueLegacyMenu,
  hasAdminPermission, isAdminAuthorityRecoveryRoute, normalizeRoleRules, requiredAdminPermission } from '@/services/admin/AdminPermissionService';
import { financeMemoryPostgres } from './helpers/financePostgres';

const list = 'system.legacy_role_view', form = 'system.legacy_role_form_view', save = 'system.legacy_role_manage';
const status = 'system.legacy_role_status', remove = 'system.legacy_role_delete', preview = 'system.legacy_role_operation_preview';
const actor = (roles: string) => ({ id: 500, account: 'role-operator', realName: '', divisionId: 0, level: 1, roles });
// Complete actual crmeb.sql 19,325..330,611 tuples. Save is not status or delete.
const seed = [
  { id:19,authType:1,menuPath:'/admin/setting/system_role/index',uniqueAuth:'setting-system-role' },
  { id:325,authType:1,menuPath:'/admin/setting/system_role/add',uniqueAuth:'setting-system_role-add' },
  { id:326,authType:2,apiUrl:'setting/role/create',methods:'GET' },
  { id:327,authType:2,apiUrl:'setting/role/<id>',methods:'POST' },
  { id:328,authType:2,apiUrl:'setting/role/<id>/edit',methods:'GET' },
  { id:329,authType:2,apiUrl:'setting/role/set_status/<id>/<status>',methods:'PUT' },
  { id:330,authType:2,apiUrl:'setting/role/<id>',methods:'DELETE' },
  { id:611,authType:2,apiUrl:'setting/role',methods:'GET' },
];

describe('legacy role independent operation permissions', () => {
  let fixture: Awaited<ReturnType<typeof financeMemoryPostgres>>, permissions: AdminPermissionService;
  beforeAll(async () => {
    fixture = await financeMemoryPostgres([systemMenus,systemRole]);
    if (!fixture.isMemory) throw Error('Role permission tests require local memory only');
    permissions = new AdminPermissionService(createContainerFromDb(fixture.db));
  });
  beforeEach(async () => {
    await fixture.db.delete(systemRole); await fixture.db.delete(systemMenus);
    await fixture.db.insert(systemMenus).values(seed.map(row => ({ ...row,type:1,menuName:'真实旧角色权限' })));
    await fixture.db.insert(systemRole).values([
      { id:5000,roleName:'名单',rules:'19,611' }, { id:5001,roleName:'表单',rules:'325,326,328' },
      { id:5002,roleName:'保存',rules:'327' }, { id:5003,roleName:'启停',rules:'329' },
      { id:5004,roleName:'删除',rules:'330' }, { id:5005,roleName:'独立动作',rules:`${status},${remove}` },
      { id:5006,roleName:'现代读',rules:'system.view' }, { id:5007,roleName:'现代管理',rules:'system.manage' },
      { id:5008,roleName:'其他域',rules:'config.manage,system.legacy_admin_manage' },
      { id:5009,roleName:'供应商',type:4,rules:`${status},${remove}` },
      { id:5010,roleName:'停用',status:0,rules:`${status},${remove}` },
      { id:5011,roleName:'其他关系',relationId:8,rules:`${status},${remove}` },
      { id:5012,roleName:'已删除',status:-1,rules:`${status},${remove}` },
    ]);
  });
  afterAll(async () => { await fixture?.close(); });

  it('maps exact old methods and positive int32 targets on both bases without falling into config', () => {
    for (const prefix of ['/adminapi','/api/admin']) {
      for (const id of ['7',':id','<id>','2147483647']) {
        expect(requiredAdminPermission('DELETE',`${prefix}/setting/role/${id}`)).toBe(remove);
        expect(requiredAdminPermission('POST',`${prefix}/setting/role/${id}`)).toBe(save);
        for (const method of ['GET','HEAD']) expect(requiredAdminPermission(method,`${prefix}/setting/role/${id}/edit`)).toBe(form);
        for (const value of ['0','1',':status','<status>']) expect(requiredAdminPermission('PUT',`${prefix}/setting/role/set_status/${id}/${value}`)).toBe(status);
      }
      expect(requiredAdminPermission('POST',`${prefix}/setting/role/0`)).toBe(save);
      for (const method of ['GET','HEAD']) {
        expect(requiredAdminPermission(method,`${prefix}/setting/role`)).toBe(list);
        expect(requiredAdminPermission(method,`${prefix}/setting/role/create`)).toBe(form);
      }
      for (const [method,path] of [['PUT','7'],['POST','set_status/7/1'],['DELETE','set_status/7/1'],
        ['GET','set_status/7/1'],['PUT','set_status/0/1'],['PUT','set_status/07/1'],['PUT','set_status/2147483648/1'],
        ['PUT','set_status/7/2'],['PUT','set_status/7/01'],['PUT','set_status/7/1/extra'],
        ['DELETE','0'],['DELETE','07'],['DELETE','2147483648'],['DELETE','7/extra'],['DELETE','create'],
        ['POST','create'],['POST','2147483648'],['GET','0/edit'],['GET','7/edit/extra'],['PATCH','7']]) {
        expect(requiredAdminPermission(method,`${prefix}/setting/role/${path}`)).toBeNull();
      }
      expect(requiredAdminPermission('PUT',`${prefix}/setting/set_status/7/1`)).toBe('system.legacy_admin_manage');
      expect(requiredAdminPermission('POST',`${prefix}/system_role/save`)).toBe('system.manage');
    }
  });

  it('admits only an actual operation writer to preview while reserving exact action checks for the service', async () => {
    for (const prefix of ['/adminapi','/api/admin']) {
      expect(requiredAdminPermission('POST',`${prefix}/setting/role-authority/preview`)).toBe(preview);
      for (const roles of ['5000','5001','5002','5006','5008','5009','5010','5011','5012']) {
        await expect(permissions.assertAuthorized(actor(roles),'POST',`${prefix}/setting/role-authority/preview`)).rejects.toThrow();
      }
      for (const roles of ['5003','5004','5005','5007']) {
        await expect(permissions.assertAuthorized(actor(roles),'POST',`${prefix}/setting/role-authority/preview`)).resolves.toBeUndefined();
      }
      for (const [method,path] of [['GET','preview'],['DELETE','preview'],['POST','preview/extra'],['POST','commit'],['GET','']]) {
        expect(requiredAdminPermission(method,`${prefix}/setting/role-authority/${path}`)).toBeNull();
      }
    }
    expect(hasAdminPermission(new Set([status]),remove)).toBe(false);
    expect(hasAdminPermission(new Set([remove]),status)).toBe(false);
  });

  it('does not let a persisted, opaque or delegated preview predicate manufacture authority', async () => {
    expect(hasAdminPermission(new Set([preview]),preview)).toBe(false);
    expect(hasAdminPermission(new Set(['system.view',save]),preview)).toBe(false);
    for (const keys of [new Set([status]),new Set([remove]),new Set(['system.manage'])]) {
      expect(hasAdminPermission(keys,preview)).toBe(true);
      expect(() => assertDelegablePermissions(keys,[preview])).toThrow();
    }
    expect(() => normalizeRoleRules(preview)).toThrow();
    expect(await permissions.resolveRulePermissionKeys(preview)).toEqual([]);
    expect(permissions.permissionTree().flatMap(group => group.children).map(node => node.key)).not.toContain(preview);
    await fixture.db.insert(systemMenus).values({id:6001,type:1,authType:2,apiUrl:'legacy/unmigrated',methods:'POST',uniqueAuth:preview});
    const [row] = await fixture.db.select().from(systemMenus).where(eq(systemMenus.id,6001));
    expect(canRetainOpaqueLegacyMenu(row)).toBe(false);
    expect(await permissions.resolveRulePermissionKeys('6001')).toEqual([]);
  });

  it('maps all actual numeric tuples identically in single, batch and locked decisions', async () => {
    const expected = [[list],[form],[form],[save,list,form],[form],[status,list],[remove,list],[list]];
    expect(await permissions.resolveManyRulePermissionKeys(seed.map(row => String(row.id)))).toEqual(expected);
    for (let index=0;index<seed.length;index++) {
      expect(await permissions.resolveRulePermissionKeys(String(seed[index].id))).toEqual(expected[index]);
      const [row] = await fixture.db.select().from(systemMenus).where(eq(systemMenus.id,seed[index].id));
      expect(canRetainOpaqueLegacyMenu(row)).toBe(false);
    }
    const locked = await withTx(createContainerFromDb(fixture.db),tx => new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment('5003,5004',true));
    expect([...locked.keys]).toEqual([status,remove,list]); expect(locked.missingRoleIds).toEqual([]);
    const batch = await permissions.resolveManyAdminPermissionKeys([actor('5000'),actor('5001'),actor('5002'),actor('5003'),actor('5004')]);
    expect(batch.map(keys => [...keys])).toEqual([[list],[form],[save,list,form],[status,list],[remove,list]]);
  });

  it('keeps list, forms, POST save, PUT status and DELETE mutually scoped', async () => {
    for (const prefix of ['/adminapi','/api/admin']) {
      for (const roles of ['5000','5001','5002']) {
        await expect(permissions.assertAuthorized(actor(roles),'PUT',`${prefix}/setting/role/set_status/7/0`)).rejects.toThrow();
        await expect(permissions.assertAuthorized(actor(roles),'DELETE',`${prefix}/setting/role/7`)).rejects.toThrow();
      }
      await expect(permissions.assertAuthorized(actor('5003'),'PUT',`${prefix}/setting/role/set_status/7/0`)).resolves.toBeUndefined();
      await expect(permissions.assertAuthorized(actor('5003'),'DELETE',`${prefix}/setting/role/7`)).rejects.toThrow();
      await expect(permissions.assertAuthorized(actor('5004'),'DELETE',`${prefix}/setting/role/7`)).resolves.toBeUndefined();
      await expect(permissions.assertAuthorized(actor('5004'),'PUT',`${prefix}/setting/role/set_status/7/1`)).rejects.toThrow();
      for (const roles of ['5003','5004','5005']) {
        await expect(permissions.assertAuthorized(actor(roles),'GET',`${prefix}/setting/role`)).resolves.toBeUndefined();
        for (const [method,path] of [['GET','setting/role/create'],['GET','setting/role/7/edit'],['POST','setting/role/7'],
          ['GET','setting/admin'],['PUT','setting/set_status/7/1'],['GET','system_role/list'],
          ['POST','system_role/save'],['POST','system/authority/preview'],['POST','system/authority/commit']]) {
          await expect(permissions.assertAuthorized(actor(roles),method,`${prefix}/${path}`)).rejects.toThrow();
        }
      }
    }
  });

  it('allows canonical coverage and delegation only in one direction', async () => {
    const manager = await permissions.resolveAdminPermissionKeys(actor('5007'));
    const viewer = await permissions.resolveAdminPermissionKeys(actor('5006'));
    for (const key of [list,form,save,status,remove]) {
      expect(hasAdminPermission(manager,key)).toBe(true);
      expect(() => assertDelegablePermissions(manager,[key])).not.toThrow();
    }
    for (const key of [save,status,remove]) expect(hasAdminPermission(viewer,key)).toBe(false);
    for (const key of [list,form]) expect(hasAdminPermission(viewer,key)).toBe(true);
    for (const [granted,other] of [[status,remove],[remove,status]]) {
      const narrow = new Set([granted]);
      expect(() => assertDelegablePermissions(narrow,[granted,list])).not.toThrow();
      for (const key of [other,form,save,'system.view','system.manage','system.legacy_admin_view']) {
        expect(hasAdminPermission(narrow,key)).toBe(false);
        expect(() => assertDelegablePermissions(narrow,[key])).toThrow();
      }
    }
    expect(normalizeRoleRules(status)).toBe(`${list},${status}`);
    expect(normalizeRoleRules(remove)).toBe(`${list},${remove}`);
    expect(normalizeRoleRules(save)).toBe(`${list},${form},${save}`);
  });

  it('builds a usable narrow role page without providing modern or sibling administration', () => {
    for (const keys of [new Set([list]),new Set([status]),new Set([remove])]) {
      expect(permissions.buildMenus(keys)).toEqual([expect.objectContaining({path:'/system/legacy-roles'})]);
    }
    expect(permissions.buildMenus(new Set([form]))).toEqual([]);
    const children = permissions.permissionTree().find(group => group.key === 'system')!.children;
    for (const key of [list,form,save,status,remove]) expect(children).toContainEqual(expect.objectContaining({key}));
    for (const prefix of ['/adminapi','/api/admin']) {
      expect(requiredAdminPermission('GET',`${prefix}/system/legacy-roles`)).toBe(list);
      expect(requiredAdminPermission('POST',`${prefix}/system/legacy-roles`)).toBeNull();
    }
  });

  it('protects each real menu identity from a different valid action or page tuple', async () => {
    const claims = [
      {id:19,authType:2,apiUrl:'setting/role',methods:'GET'},
      {id:325,authType:1,menuPath:'/admin/setting/system_role/index',uniqueAuth:'setting-system-role'},
      {id:326,authType:2,apiUrl:'setting/role/7/edit',methods:'GET'},
      {id:327,authType:2,apiUrl:'setting/role/7',methods:'DELETE'},
      {id:328,authType:2,apiUrl:'setting/role/create',methods:'GET'},
      {id:329,authType:2,apiUrl:'setting/role/7',methods:'DELETE'},
      {id:330,authType:2,apiUrl:'setting/role/7',methods:'POST'},
      {id:611,authType:2,apiUrl:'setting/role/7',methods:'POST'},
    ];
    for (const claim of claims) {
      await fixture.db.delete(systemMenus).where(eq(systemMenus.id,claim.id));
      await fixture.db.insert(systemMenus).values({...claim,type:1,menuName:'错误旧角色动作'});
      const [row] = await fixture.db.select().from(systemMenus).where(eq(systemMenus.id,claim.id));
      expect(canRetainOpaqueLegacyMenu(row)).toBe(false);
      expect(await permissions.resolveRulePermissionKeys(String(claim.id))).toEqual([]);
      expect(await permissions.resolveManyRulePermissionKeys([String(claim.id)])).toEqual([[]]);
    }
  });

  it('rejects forged API, page, auth and capability claims before generic or opaque fallback', async () => {
    const claims = [
      {id:6001,authType:2,apiUrl:'setting/role/7',methods:'PUT'},
      {id:6002,authType:2,apiUrl:'setting/role/set_status/7/1',methods:'POST'},
      {id:6003,authType:2,apiUrl:'setting/role/set_status/7/1',methods:'GET,PUT'},
      {id:6004,authType:2,apiUrl:'setting/role/7',methods:'DELETE|POST'},
      {id:6005,authType:2,apiUrl:'setting/role/7',methods:'DELETE',menuPath:'/admin/product'},
      {id:6006,authType:2,apiUrl:'setting/role/7',methods:'DELETE',uniqueAuth:'system.manage'},
      {id:6007,authType:2,apiUrl:'setting/role/ 7',methods:'DELETE'},
      {id:6008,authType:2,apiUrl:'setting/role/7?force=true',methods:'DELETE'},
      {id:6009,authType:2,apiUrl:'setting/role-authority/preview',methods:'POST'},
      {id:6010,authType:1,menuPath:'/admin/setting/system_role/index',uniqueAuth:'forged'},
      {id:6011,authType:1,menuPath:'/admin/product',uniqueAuth:'setting-system_role-add'},
      {id:6012,authType:1,menuPath:'/admin /setting/system_role/add',uniqueAuth:'setting-system_role-add'},
      {id:6013,authType:1,menuPath:'/system/legacy-roles',uniqueAuth:'system.manage'},
      {id:6014,authType:2,apiUrl:'legacy/unmigrated',methods:'POST',uniqueAuth:status},
      {id:6015,authType:2,apiUrl:'legacy/unmigrated',methods:'POST',uniqueAuth:remove},
      {id:6016,authType:2,apiUrl:'SETTING/ROLE/7',methods:'DELETE'},
    ];
    for (const claim of claims) {
      await fixture.db.insert(systemMenus).values({...claim,type:1,menuName:'伪造旧角色权限'});
      const [row] = await fixture.db.select().from(systemMenus).where(eq(systemMenus.id,claim.id));
      expect(canRetainOpaqueLegacyMenu(row)).toBe(false);
      expect(await permissions.resolveRulePermissionKeys(String(claim.id))).toEqual([]);
      expect(await permissions.resolveManyRulePermissionKeys([String(claim.id)])).toEqual([[]]);
    }
    await fixture.db.insert(systemMenus).values({id:7000,type:1,authType:2,apiUrl:'legacy/unmigrated',methods:'POST'});
    const [opaque] = await fixture.db.select().from(systemMenus).where(eq(systemMenus.id,7000));
    expect(canRetainOpaqueLegacyMenu(opaque)).toBe(true);
  });

  it('honors live menu and role revocation instead of retained numeric IDs', async () => {
    for (const patch of [{access:0},{isDel:1},{type:4},{methods:'POST'},{authType:1}]) {
      await fixture.db.update(systemMenus).set({access:1,isDel:0,type:1,authType:2,methods:'PUT',...patch}).where(eq(systemMenus.id,329));
      expect([...await permissions.resolveAdminPermissionKeys(actor('5003'))]).toEqual([]);
    }
    await fixture.db.update(systemMenus).set({access:1,isDel:0,type:1,authType:2,methods:'PUT'}).where(eq(systemMenus.id,329));
    expect([...await permissions.resolveAdminPermissionKeys(actor('5003'))]).toEqual([status,list]);
    for (const patch of [{status:0},{status:-1},{type:4},{relationId:8}]) {
      await fixture.db.update(systemRole).set({status:1,type:0,relationId:0,...patch}).where(eq(systemRole.id,5003));
      expect([...await permissions.resolveAdminPermissionKeys(actor('5003'))]).toEqual([]);
    }
    expect((await permissions.resolveRoleAssignment('5012')).missingRoleIds).toEqual([5012]);
  });

  it('registers only owner receipt and resolve recovery verbs independently of current writer grants', async () => {
    for (const prefix of ['/adminapi','/api/admin']) {
      for (const root of ['system/authority','setting/admin-authority','setting/role-authority']) {
        for (const method of ['GET','HEAD']) {
          const path = `${prefix}/${root}/receipt/operation-id`;
          expect(isAdminAuthorityRecoveryRoute(method,path)).toBe(true);
          expect(requiredAdminPermission(method,path)).toBeNull();
          // This layer assumes authentication middleware and the service's live
          // owner checks; it proves only that lost writer grants do not gate recovery.
          await expect(permissions.assertAuthorized(actor('5012'),method,path)).resolves.toBeUndefined();
        }
        const resolve = `${prefix}/${root}/resolve`;
        expect(isAdminAuthorityRecoveryRoute('POST',resolve)).toBe(true);
        await expect(permissions.assertAuthorized(actor('5012'),'POST',resolve)).resolves.toBeUndefined();
        for (const [method,path] of [['POST','receipt/id'],['DELETE','receipt/id'],['GET','resolve'],['POST','resolve/extra']]) {
          expect(isAdminAuthorityRecoveryRoute(method,`${prefix}/${root}/${path}`)).toBe(false);
        }
      }
    }
  });
});
