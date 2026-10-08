import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContainerFromDb, withTx } from '@/lib/di';
import { systemMenus, systemRole } from '@/models/schema';
import { AdminPermissionService, assertDelegablePermissions, hasAdminPermission, normalizeRoleRules, requiredAdminPermission } from '@/services/admin/AdminPermissionService';
import { financePostgres } from './helpers/financePostgres';

describe('legacy numeric role workflow authority', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let permissions: AdminPermissionService;
  const form = 'system.legacy_role_form_view', manage = 'system.legacy_role_manage', list = 'system.legacy_role_view';
  const actor = (roles: string) => ({ id: 100, account: 'operator', realName: '', divisionId: 0, level: 1, roles });

  beforeAll(async () => {
    fixture = await financePostgres([systemMenus, systemRole]);
    permissions = new AdminPermissionService(createContainerFromDb(fixture.db));
    await fixture.db.insert(systemMenus).values([
      { id: 1, authType: 2, type: 1, apiUrl: 'setting/role/create', methods: 'GET' },
      { id: 2, authType: 2, type: 1, apiUrl: '/api/admin/setting/role/:id/edit', methods: 'HEAD' },
      { id: 3, authType: 2, type: 1, apiUrl: '/adminapi/setting/role/0', methods: 'POST' },
      { id: 4, authType: 2, type: 1, apiUrl: 'setting/role/:id', methods: 'POST' },
      { id: 5, authType: 2, type: 1, apiUrl: 'setting/role/set_status/4/0', methods: 'PUT' },
      { id: 6, authType: 2, type: 1, apiUrl: 'setting/role/create', methods: 'POST' },
      { id: 7, authType: 2, type: 4, apiUrl: 'setting/role/4', methods: 'POST' },
      { id: 8, authType: 2, type: 1, access: 0, apiUrl: 'setting/role/4', methods: 'POST' },
      { id: 9, authType: 2, type: 1, isDel: 1, apiUrl: 'setting/role/4', methods: 'POST' },
      { id: 10, authType: 1, type: 1, menuPath: '/admin/setting/system_role/index', uniqueAuth: 'setting-system-role' },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 20, roleName: 'form-only', rules: '1,2' },
      { id: 21, roleName: 'numeric-writer', rules: '3,4' },
      { id: 22, roleName: 'page-only', rules: '10' },
      { id: 23, roleName: 'canonical-view', rules: 'system.view' },
      { id: 24, roleName: 'canonical-manage', rules: 'system.manage' },
      { id: 25, roleName: 'invalid-writes', rules: '5,6,7,8,9' },
    ]);
  });
  afterAll(async () => { await fixture?.close(); });

  it('registers only the exact form and save methods on both route surfaces', () => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      for (const method of ['GET', 'HEAD']) for (const path of ['create', '4/edit', ':id/edit']) {
        expect(requiredAdminPermission(method, `${prefix}/setting/role/${path}`)).toBe(form);
      }
      for (const id of ['0', '4', ':id']) expect(requiredAdminPermission('POST', `${prefix}/setting/role/${id}`)).toBe(manage);
      for (const [method, path] of [['POST', 'create'], ['PUT', '4'], ['DELETE', '4'], ['GET', '0/edit'],
        ['GET', '4'], ['PUT', 'set_status/4/0'], ['POST', '4/extra'], ['POST', '04']]) {
        expect(requiredAdminPermission(method, `${prefix}/setting/role/${path}`)).toBeNull();
      }
    }
  });

  it('resolves numeric contracts identically in single, batched and locked decisions', async () => {
    const writer = [manage, list, form];
    const expected = [[form], [form], writer, writer, [], [], [], [], [], [list]];
    expect(await permissions.resolveManyRulePermissionKeys(Array.from({ length: 10 }, (_, i) => String(i + 1)))).toEqual(expected);
    for (let index = 0; index < expected.length; index++) {
      expect(await permissions.resolveRulePermissionKeys(String(index + 1))).toEqual(expected[index]);
    }
    const locked = await withTx(createContainerFromDb(fixture.db), tx => new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment('21', true));
    expect([...locked.keys]).toEqual(writer);
    expect(locked.missingRoleIds).toEqual([]);
    expect([...await permissions.resolveAdminPermissionKeys(actor('25'))]).toEqual([]);
  });

  it('keeps page, form and numeric writer authority separate from sibling and modern contracts', async () => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      await expect(permissions.assertAuthorized(actor('20'), 'GET', `${prefix}/setting/role/create`)).resolves.toBeUndefined();
      await expect(permissions.assertAuthorized(actor('20'), 'POST', `${prefix}/setting/role/4`)).rejects.toThrow();
      await expect(permissions.assertAuthorized(actor('22'), 'GET', `${prefix}/setting/role/create`)).rejects.toThrow();
      await expect(permissions.assertAuthorized(actor('22'), 'POST', `${prefix}/setting/role/4`)).rejects.toThrow();
      for (const [method, path] of [['GET', 'setting/role'], ['GET', 'setting/role/create'], ['GET', 'setting/role/4/edit'], ['POST', 'setting/role/4']]) {
        await expect(permissions.assertAuthorized(actor('21'), method, `${prefix}/${path}`)).resolves.toBeUndefined();
      }
      for (const [method, path] of [['GET', 'setting/admin'], ['GET', 'system_role/list'], ['GET', 'system_menus/tree'], ['POST', 'system_role/save'], ['POST', 'system_admin/save']]) {
        await expect(permissions.assertAuthorized(actor('21'), method, `${prefix}/${path}`)).rejects.toThrow();
      }
    }
  });

  it('allows canonical fallback and delegation in one direction without broadening legacy grants', async () => {
    const viewer = await permissions.resolveAdminPermissionKeys(actor('23'));
    const manager = await permissions.resolveAdminPermissionKeys(actor('24'));
    expect(hasAdminPermission(viewer, form)).toBe(true);
    expect(hasAdminPermission(viewer, manage)).toBe(false);
    expect(hasAdminPermission(manager, manage)).toBe(true);
    expect(() => assertDelegablePermissions(manager, [manage, form, list])).not.toThrow();
    expect(() => assertDelegablePermissions(viewer, [manage])).toThrow();
    const narrow = await permissions.resolveAdminPermissionKeys(actor('21'));
    expect(() => assertDelegablePermissions(narrow, [form, list])).not.toThrow();
    for (const key of ['system.view', 'system.manage', 'system.legacy_admin_view']) {
      expect(hasAdminPermission(narrow, key)).toBe(false);
      expect(() => assertDelegablePermissions(narrow, [key])).toThrow();
    }
    expect(normalizeRoleRules(manage)).toBe(`${list},${form},${manage}`);
    expect(normalizeRoleRules(form)).toBe(form);
  });
});
