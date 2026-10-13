import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContainerFromDb } from '@/lib/di';
import { systemMenus, systemRole } from '@/models/schema';
import { AdminPermissionService, hasAdminPermission, normalizeRoleRules,
  PRODUCT_LABEL_SELECTION_PERMISSION, requiredAdminPermission } from '@/services/admin/AdminPermissionService';
import { financePostgres } from './helpers/financePostgres';

describe('product label workflow permissions', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let permissions: AdminPermissionService;
  beforeAll(async () => {
    fixture = await financePostgres([systemMenus, systemRole]);
    permissions = new AdminPermissionService(createContainerFromDb(fixture.db));
    await fixture.db.insert(systemMenus).values([
      { id: 1380, authType: 1, type: 1, menuPath: '/admin/product/label', uniqueAuth: 'admin-storeProduct-label' },
      { id: 1381, authType: 1, type: 1, menuPath: '/admin/product/label', uniqueAuth: 'admin-storeProduct-label' },
      { id: 1382, authType: 1, type: 1, menuPath: '/admin/product/list', uniqueAuth: 'admin-storeProduct-label' },
      { id: 1383, authType: 1, type: 1, menuPath: '/admin/product/label', uniqueAuth: 'product.manage' },
      { id: 1384, authType: 2, type: 1, apiUrl: 'product/label/dels', methods: 'GET', uniqueAuth: 'label.manage' },
      { id: 1385, authType: 2, type: 1, apiUrl: 'product/label/dels', methods: 'PUT' },
      { id: 1386, authType: 2, type: 1, apiUrl: 'product/label', methods: 'GET' },
      { id: 1387, authType: 2, type: 1, apiUrl: 'product/product_label', methods: 'GET' },
      { id: 1388, authType: 2, type: 1, apiUrl: 'product/label_cate/:id', methods: 'GET' },
      { id: 1389, authType: 2, type: 1, apiUrl: 'product/label/dels', methods: 'PUT,GET' },
      { id: 1390, authType: 2, type: 4, apiUrl: 'product/label/dels', methods: 'PUT' },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 1, roleName: 'page-reader', type: 1, rules: '1380' },
      { id: 2, roleName: 'product-reader', type: 1, rules: 'product.view' },
      { id: 3, roleName: 'product-manager', type: 1, rules: 'product.manage' },
      { id: 4, roleName: 'label-manager', type: 1, rules: 'label.manage' },
    ]);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); }, 30_000);

  it('maps all management reads and exact writes on both admin prefixes', () => {
    const reads = ['product/label', 'product/label/form', 'product/label_cate', 'product/label_cate/create', 'product/label_cate/12/edit', 'product_label/list'];
    const writes: [string, string][] = [
      ['POST', 'product/label_cate'], ['PUT', 'product/label_cate/12'], ['DELETE', 'product/label_cate/12'],
      ['POST', 'product/label/0'], ['POST', 'product/label/12'], ['DELETE', 'product/label/12'],
      ['PUT', 'product/label/dels'], ['PUT', 'product/label/set_status/12/0'], ['PUT', 'product/label/set_show/12/1'],
      ['POST', 'product_label/save'], ['DELETE', 'product_label/del/12'],
    ];
    for (const base of ['/adminapi', '/api/admin']) {
      for (const path of reads) for (const method of ['GET', 'HEAD']) expect(requiredAdminPermission(method, `${base}/${path}`)).toBe('label.view');
      for (const [method, path] of writes) expect(requiredAdminPermission(method, `${base}/${path}`)).toBe('label.manage');
    }
  });

  it('admits product selection reads without granting label or user-label management', () => {
    for (const path of ['product/product_label', 'product/all_label']) {
      expect(requiredAdminPermission('GET', path)).toBe(PRODUCT_LABEL_SELECTION_PERMISSION);
      for (const grant of ['product.view', 'product.manage', 'label.view', 'label.manage']) {
        expect(hasAdminPermission(new Set([grant]), PRODUCT_LABEL_SELECTION_PERMISSION)).toBe(true);
      }
      expect(hasAdminPermission(new Set(['config.view']), PRODUCT_LABEL_SELECTION_PERMISSION)).toBe(false);
    }
    expect(hasAdminPermission(new Set(['product.manage']), 'label.view')).toBe(false);
    expect(hasAdminPermission(new Set(['product.manage']), 'label.manage')).toBe(false);
    expect(requiredAdminPermission('GET', 'user_label/list')).toBe('label.view');
    expect(() => normalizeRoleRules(PRODUCT_LABEL_SELECTION_PERMISSION)).toThrow();
  });

  it('rejects wrong verbs, malformed IDs and the unproved encrypted resource read', () => {
    const invalid: [string, string][] = [
      ['GET', 'product/label/dels'], ['GET', 'product/label/set_show/12/1'], ['POST', 'product/label/set_show/12/1'],
      ['PATCH', 'product/label/12'], ['PUT', 'product/label/12'], ['POST', 'product/label/-1'],
      ['DELETE', 'product/label/0'], ['POST', 'product/label/2147483648'], ['PUT', 'product/label/set_status/12/2'],
      ['GET', 'product/label_cate/12'], ['GET', 'product/label/cleanup'], ['POST', 'product/all_label'],
      ['GET', 'product/product_label/extra'], ['POST', 'product_label/save/extra'],
    ];
    for (const [method, route] of invalid) expect(requiredAdminPermission(method, route), `${method} ${route}`).toBeNull();
  });

  it('retains exact route-pattern permission metadata for numeric action menus', () => {
    expect(requiredAdminPermission('PUT', 'product/label/set_status/:id/:status')).toBe('label.manage');
    expect(requiredAdminPermission('PUT', 'product/label/set_show/:id/:show')).toBe('label.manage');
    expect(requiredAdminPermission('GET', 'product/label_cate/:id/edit')).toBe('label.view');
  });

  it('resolves only the proved seed page and exact action tuples in single and batch readers', async () => {
    const rules = ['1380', '1381,1382,1383,1384,1388,1389,1390', '1385', '1386', '1387'];
    const expected = [['label.view'], [], ['label.manage', 'label.view'], ['label.view'], [PRODUCT_LABEL_SELECTION_PERMISSION]];
    expect(await permissions.resolveManyRulePermissionKeys(rules)).toEqual(expected);
    for (let index = 0; index < rules.length; index++) expect(await permissions.resolveRulePermissionKeys(rules[index])).toEqual(expected[index]);
  });

  it('keeps page reads, product reads and label writes independent through actual role SQL', async () => {
    const identity = { id: 200, account: 'scoped', realName: '', divisionId: 0, level: 1, roles: '1' };
    await expect(permissions.assertAuthorized(identity, 'GET', '/adminapi/product/label')).resolves.toBeUndefined();
    await expect(permissions.assertAuthorized(identity, 'PUT', '/adminapi/product/label/dels')).rejects.toThrow();
    for (const roles of ['2', '3']) {
      await expect(permissions.assertAuthorized({ ...identity, roles }, 'GET', '/adminapi/product/product_label')).resolves.toBeUndefined();
      await expect(permissions.assertAuthorized({ ...identity, roles }, 'POST', '/adminapi/product_label/save')).rejects.toThrow();
      await expect(permissions.assertAuthorized({ ...identity, roles }, 'GET', '/adminapi/product/label')).rejects.toThrow();
    }
    await expect(permissions.assertAuthorized({ ...identity, roles: '4' }, 'PUT', '/adminapi/product/label/dels')).resolves.toBeUndefined();
    expect(permissions.buildMenus(new Set(['label.view']))).toEqual([expect.objectContaining({ path: '/label' })]);
  });
});
