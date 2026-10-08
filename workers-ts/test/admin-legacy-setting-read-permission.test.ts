import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContainerFromDb, withTx } from '@/lib/di';
import { systemMenus, systemRole } from '@/models/schema';
import { AdminPermissionService, assertDelegablePermissions, normalizeRoleRules, requiredAdminPermission } from '@/services/admin/AdminPermissionService';
import { financePostgres } from './helpers/financePostgres';

describe('legacy staff list permissions', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let permissions: AdminPermissionService;

  beforeAll(async () => {
    fixture = await financePostgres([systemMenus, systemRole]);
    permissions = new AdminPermissionService(createContainerFromDb(fixture.db));
    await fixture.db.insert(systemMenus).values([
      { id: 1, authType: 1, type: 1, menuPath: '/admin/setting/system_admin/index', uniqueAuth: 'setting-system-list' },
      { id: 2, authType: 1, type: 1, menuPath: '/admin/setting/system_role/index', uniqueAuth: 'setting-system-role' },
      { id: 3, authType: 2, type: 1, apiUrl: 'setting/admin', methods: 'GET' },
      { id: 4, authType: 2, type: 1, apiUrl: '/adminapi/setting/role', methods: 'HEAD' },
      { id: 5, authType: 2, type: 1, apiUrl: 'setting/role/22', methods: 'POST' },
      { id: 6, authType: 2, type: 1, apiUrl: 'setting/set_status/22/0', methods: 'PUT' },
      { id: 7, authType: 1, type: 1, menuPath: '/admin/product', uniqueAuth: 'setting-system-list' },
      { id: 8, authType: 1, type: 1, menuPath: '/admin/setting/system_role/index', uniqueAuth: 'wrong-role' },
      { id: 9, authType: 1, type: 4, menuPath: '/admin/setting/system_role/index', uniqueAuth: 'setting-system-role' },
      { id: 10, authType: 1, type: 1, menuPath: '/admin/setting/system_role/index', uniqueAuth: 'setting-system-role', access: 0 },
      { id: 11, authType: 1, type: 1, menuPath: '/admin/setting/system_admin/index', uniqueAuth: 'setting-system-list', isDel: 1 },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 21, roleName: 'platform-normalized', type: 0, rules: 'system.view' },
      { id: 22, roleName: 'platform-legacy', type: 1, rules: '1,2,3,4' },
      { id: 23, roleName: 'supplier', type: 4, relationId: 1, rules: 'system.manage,config.manage' },
      { id: 24, roleName: 'store', type: 2, rules: 'system.manage' },
      { id: 25, roleName: 'foreign-relation', type: 0, relationId: 9, rules: 'system.manage' },
      { id: 26, roleName: 'disabled', type: 1, status: 0, rules: 'system.manage' },
      { id: 27, roleName: 'deleted', type: 0, status: -1, rules: 'system.manage' },
      { id: 28, roleName: 'configuration-only', type: 1, rules: 'config.view' },
      { id: 29, roleName: 'unmigrated-writes', type: 1, rules: '5,6' },
      { id: 30, roleName: 'forged-pages', type: 1, rules: '7,8,9,10,11' },
      { id: 31, roleName: 'legacy-admin-only', type: 1, rules: '1,3' },
      { id: 32, roleName: 'legacy-role-only', type: 1, rules: '2,4' },
      { id: 33, roleName: 'platform-manager', type: 0, rules: 'system.manage' },
    ]);
  });
  afterAll(async () => { await fixture?.close(); });

  it('keeps staff reads independent of generic settings and grants only the restored role form/save contracts', () => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      for (const [path, capability] of [['setting/admin', 'system.legacy_admin_view'], ['setting/role', 'system.legacy_role_view']]) {
        for (const method of ['GET', 'HEAD']) expect(requiredAdminPermission(method, `${prefix}/${path}`)).toBe(capability);
      }
      for (const [method, path] of [['POST', 'setting/admin'], ['PUT', 'setting/admin/21'],
        ['DELETE', 'setting/admin/21'], ['PUT', 'setting/role/set_status/22/0']]) {
        expect(requiredAdminPermission(method, `${prefix}/${path}`)).toBeNull();
      }
      expect(requiredAdminPermission('GET', `${prefix}/setting/administrator`)).toBe('config.view');
      expect(requiredAdminPermission('GET', `${prefix}/setting/roles`)).toBe('config.view');
      expect(requiredAdminPermission('PUT', `${prefix}/setting/set_status_extra/22/0`)).toBe('config.manage');
      expect(requiredAdminPermission('POST', `${prefix}/system_role/save`)).toBe('system.manage');
      expect(requiredAdminPermission('POST', `${prefix}/setting/role/22`)).toBe('system.legacy_role_manage');
      expect(requiredAdminPermission('GET', `${prefix}/setting/role/22/edit`)).toBe('system.legacy_role_form_view');
      for (const path of ['setting/admin/create', 'setting/set_status/22/0', 'setting/role/set_status/22/0']) {
        expect(requiredAdminPermission('GET', `${prefix}/${path}`)).toBeNull();
      }
    }
  });

  it('resolves audited numeric page and API rules to read authority in single and batch paths', async () => {
    expect(await permissions.resolveManyRulePermissionKeys(['1', '2', '3', '4', '5', '6', '7,8,9,10,11']))
      .toEqual([['system.legacy_admin_view'], ['system.legacy_role_view'], ['system.legacy_admin_view'], ['system.legacy_role_view'],
        ['system.legacy_role_manage', 'system.legacy_role_view', 'system.legacy_role_form_view'], [], []]);
    for (const rules of ['1', '3']) expect(await permissions.resolveRulePermissionKeys(rules)).toEqual(['system.legacy_admin_view']);
    for (const rules of ['2', '4']) expect(await permissions.resolveRulePermissionKeys(rules)).toEqual(['system.legacy_role_view']);
    expect(await permissions.resolveRulePermissionKeys('5')).toEqual(['system.legacy_role_manage', 'system.legacy_role_view', 'system.legacy_role_form_view']);
    for (const rules of ['6', '7,8,9,10,11']) expect(await permissions.resolveRulePermissionKeys(rules)).toEqual([]);
    const locked = await withTx(createContainerFromDb(fixture.db), tx => new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment('22', true));
    expect([...locked.keys]).toEqual(['system.legacy_admin_view', 'system.legacy_role_view']);
    expect(locked.missingRoleIds).toEqual([]);
  });

  it('does not import supplier, store, foreign, disabled or deleted role authority into platform decisions', async () => {
    const result = await permissions.resolveRoleAssignment('21,22,23,24,25,26,27');
    expect([...result.keys]).toEqual(['system.view', 'system.legacy_admin_view', 'system.legacy_role_view']);
    expect(result.missingRoleIds).toEqual([23, 24, 25, 26, 27]);
    for (const roles of ['23', '24', '25', '26', '27', '30']) {
      expect([...await permissions.resolveAdminPermissionKeys({ level: 1, roles })]).toEqual([]);
    }
    const batch = await permissions.resolveManyAdminPermissionKeys([
      { level: 1, roles: '21,23' }, { level: 1, roles: '22,24' },
      { level: 1, roles: '23,24,25,26,27' },
    ]);
    expect(batch.map(keys => [...keys])).toEqual([['system.view'], ['system.legacy_admin_view', 'system.legacy_role_view'], []]);
  });

  it('admits staff viewers and keeps the restored role writer out of the sibling administrator list', async () => {
    const actor = (roles: string) => ({ id: 100, account: 'reader', realName: '', divisionId: 0, level: 1, roles });
    for (const prefix of ['/adminapi', '/api/admin']) for (const path of ['setting/admin', 'setting/role']) {
      await expect(permissions.assertAuthorized(actor('21'), 'GET', `${prefix}/${path}`)).resolves.toBeUndefined();
      await expect(permissions.assertAuthorized(actor('33'), 'GET', `${prefix}/${path}`)).resolves.toBeUndefined();
      await expect(permissions.assertAuthorized(actor('22'), 'GET', `${prefix}/${path}`)).resolves.toBeUndefined();
      for (const roles of ['23', '24', '25', '26', '27', '28', '30']) {
        await expect(permissions.assertAuthorized(actor(roles), 'GET', `${prefix}/${path}`)).rejects.toThrow();
      }
      if (path === 'setting/role') await expect(permissions.assertAuthorized(actor('29'), 'GET', `${prefix}/${path}`)).resolves.toBeUndefined();
      else await expect(permissions.assertAuthorized(actor('29'), 'GET', `${prefix}/${path}`)).rejects.toThrow();
      await expect(permissions.assertAuthorized(actor('22'), 'POST', `${prefix}/system_admin/save`)).rejects.toThrow();
    }
  });

  it('keeps each numeric legacy grant narrower than the sibling list and all modern system reads or writes', async () => {
    const actor = (roles: string) => ({ id: 100, account: 'reader', realName: '', divisionId: 0, level: 1, roles });
    for (const prefix of ['/adminapi', '/api/admin']) {
      await expect(permissions.assertAuthorized(actor('31'), 'GET', `${prefix}/setting/admin`)).resolves.toBeUndefined();
      await expect(permissions.assertAuthorized(actor('32'), 'GET', `${prefix}/setting/role`)).resolves.toBeUndefined();
      await expect(permissions.assertAuthorized(actor('31'), 'GET', `${prefix}/setting/role`)).rejects.toThrow();
      await expect(permissions.assertAuthorized(actor('32'), 'GET', `${prefix}/setting/admin`)).rejects.toThrow();
      for (const roles of ['22', '31', '32']) {
        for (const path of ['system_admin/list', 'system_admin/directory', 'system_role/list', 'system_role/directory', 'system_menus/tree']) {
          await expect(permissions.assertAuthorized(actor(roles), 'GET', `${prefix}/${path}`)).rejects.toThrow();
        }
        for (const path of ['system_admin/save', 'system_role/save', 'system_menus/save']) {
          await expect(permissions.assertAuthorized(actor(roles), 'POST', `${prefix}/${path}`)).rejects.toThrow();
        }
      }
      await expect(permissions.assertAuthorized(actor('21,31'), 'GET', `${prefix}/system_admin/directory`)).resolves.toBeUndefined();
    }
    expect(permissions.buildMenus(new Set(['system.legacy_admin_view', 'system.legacy_role_view']))).toEqual([]);
  });

  it('registers selectable narrow capabilities and permits only one-way delegation from canonical readers', () => {
    const narrow = ['system.legacy_admin_view', 'system.legacy_role_view'];
    const children = permissions.permissionTree().find(group => group.key === 'system')!.children;
    expect(children.map(node => node.key)).toEqual(['system.view', 'system.manage', ...narrow, 'system.legacy_role_form_view', 'system.legacy_role_manage']);
    expect(children.every(node => node.key.startsWith('system.'))).toBe(true);
    expect(normalizeRoleRules(narrow)).toBe(narrow.join(','));
    expect(normalizeRoleRules('system.manage')).toBe('system.view,system.manage');
    expect(() => assertDelegablePermissions(new Set(['system.view']), narrow)).not.toThrow();
    expect(() => assertDelegablePermissions(new Set(narrow), ['system.view'])).toThrow();
    expect(() => assertDelegablePermissions(new Set([narrow[0]]), [narrow[1]])).toThrow();
    expect(() => assertDelegablePermissions(new Set(narrow), ['system.manage'])).toThrow();
  });
});
