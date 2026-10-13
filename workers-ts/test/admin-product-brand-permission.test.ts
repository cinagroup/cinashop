import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContainerFromDb } from '@/lib/di';
import { systemMenus, systemRole } from '@/models/schema';
import { AdminPermissionService, canRetainOpaqueLegacyMenu, hasAdminPermission,
  normalizeRoleRules, PRODUCT_BRAND_SELECTION_PERMISSION, requiredAdminPermission } from '@/services/admin/AdminPermissionService';
import { financePostgres } from './helpers/financePostgres';

describe('platform brand workflow permission boundaries', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let service: AdminPermissionService;
  beforeAll(async () => {
    fixture = await financePostgres([systemMenus, systemRole]);
    service = new AdminPermissionService(createContainerFromDb(fixture.db));
    await fixture.db.insert(systemMenus).values([
      { id: 1338, authType: 1, type: 1, menuPath: '/admin/product/product_brand', uniqueAuth: 'admin-store-storeBrand-index' },
      { id: 1339, authType: 2, type: 1, apiUrl: 'product/brand', methods: 'GET' },
      { id: 1340, authType: 2, type: 1, apiUrl: 'product/brand/cascader_list/<type?>', methods: 'GET' },
      { id: 1341, authType: 2, type: 1, apiUrl: 'product/brand', methods: 'POST' },
      { id: 1342, authType: 2, type: 1, apiUrl: 'product/brand/<id>', methods: 'PUT' },
      { id: 1343, authType: 2, type: 1, apiUrl: 'product/brand/<id>', methods: 'DELETE' },
      { id: 1344, authType: 2, type: 1, apiUrl: 'product/brand/set_show/<id>/<is_show>', methods: 'PUT' },
      { id: 1401, authType: 1, type: 1, menuPath: '/admin/product/product_brand', uniqueAuth: 'admin-store-storeBrand-index' },
      { id: 1402, authType: 1, type: 1, menuPath: '/admin/product/product_brand', uniqueAuth: 'product.manage' },
      { id: 1403, authType: 2, type: 1, apiUrl: 'product/brand/set_show/12/1', methods: 'GET' },
      { id: 1404, authType: 2, type: 1, apiUrl: 'product/brand', methods: 'POST,GET' },
      { id: 1405, authType: 2, type: 4, apiUrl: 'product/brand', methods: 'POST' },
      { id: 1406, authType: 2, type: 1, apiUrl: 'product/brand', methods: 'POST', uniqueAuth: 'product.manage' },
    ]);
    await fixture.db.insert(systemRole).values([
      { id: 1, roleName: 'brand-page-reader', type: 1, rules: '1338' },
      { id: 2, roleName: 'product-reader', type: 1, rules: 'product.view' },
      { id: 3, roleName: 'brand-writer', type: 1, rules: '1341,1342,1343,1344' },
    ]);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); }, 30_000);

  it('separates complete management routes from product selection on both prefixes', () => {
    for (const prefix of ['/adminapi/', '/api/admin/']) {
      for (const route of ['product/brand', 'brand/list']) {
        for (const method of ['GET', 'HEAD']) expect(requiredAdminPermission(method, prefix + route)).toBe('brand.view');
      }
      for (const route of ['product/brand/cascader_list', 'product/brand/cascader_list/1', 'product/brand/cascader_list/2']) {
        expect(requiredAdminPermission('GET', prefix + route)).toBe(PRODUCT_BRAND_SELECTION_PERMISSION);
      }
      for (const [method, route] of [['POST', 'product/brand'], ['PUT', 'product/brand/12'], ['DELETE', 'product/brand/12'],
        ['PUT', 'product/brand/set_show/12/0'], ['POST', 'brand/save'], ['DELETE', 'brand/del/12']]) {
        expect(requiredAdminPermission(method, prefix + route)).toBe('brand.manage');
      }
    }
  });

  it('rejects unknown children, unsupported types, malformed ids and wrong verbs', () => {
    for (const [method, route] of [['GET', 'product/brand/12'], ['GET', 'brand/cleanup'], ['GET', 'product/brand/cascader_list/0'],
      ['GET', 'product/brand/cascader_list/3'], ['POST', 'product/brand/cascader_list'], ['POST', 'product/brand/12'],
      ['PATCH', 'product/brand/12'], ['DELETE', 'product/brand/0'], ['PUT', 'product/brand/2147483648'],
      ['GET', 'product/brand/set_show/12/1'], ['PUT', 'product/brand/set_show/12/2'], ['POST', 'brand/save/extra']]) {
      expect(requiredAdminPermission(method, route), `${method} ${route}`).toBeNull();
    }
  });

  it('allows selection grants while keeping the route-only key nondelegable as a stored rule', () => {
    for (const key of ['product.view', 'product.manage', 'brand.view', 'brand.manage']) {
      expect(hasAdminPermission(new Set([key]), PRODUCT_BRAND_SELECTION_PERMISSION)).toBe(true);
    }
    expect(hasAdminPermission(new Set(['label.view']), PRODUCT_BRAND_SELECTION_PERMISSION)).toBe(false);
    expect(hasAdminPermission(new Set(['product.manage']), 'brand.manage')).toBe(false);
    expect(() => normalizeRoleRules(PRODUCT_BRAND_SELECTION_PERMISSION)).toThrow();
  });

  it('uses the audited page and exact API tuples in both real SQL readers', async () => {
    const rules = ['1338', '1339', '1340', '1341,1342,1343,1344', '1401,1402,1403,1404,1405,1406'];
    const expected = [['brand.view'], ['brand.view'], [PRODUCT_BRAND_SELECTION_PERMISSION], ['brand.manage', 'brand.view'], []];
    const batch = await service.resolveManyRulePermissionKeys(rules);
    for (let i = 0; i < rules.length; i++) {
      expect(batch[i].sort()).toEqual(expected[i].sort());
      expect((await service.resolveRulePermissionKeys(rules[i])).sort()).toEqual(expected[i].sort());
    }
  });

  it('never retains forged brand metadata as an opaque grant', () => {
    const source = { id: 1401, authType: 1, menuPath: '/admin/product/product_brand', uniqueAuth: 'admin-store-storeBrand-index', apiUrl: '', methods: '' };
    expect(canRetainOpaqueLegacyMenu(source)).toBe(false);
    expect(canRetainOpaqueLegacyMenu({ ...source, id: 1404, authType: 2, menuPath: '', uniqueAuth: '', apiUrl: 'product/brand', methods: 'GET,POST' })).toBe(false);
    expect(canRetainOpaqueLegacyMenu({ ...source, id: 1338, menuPath: '/unknown', uniqueAuth: '' })).toBe(false);
  });

  it('keeps page readers, product selectors and real brand action roles independent', async () => {
    const actor = { id: 200, account: 'scoped', realName: '', divisionId: 0, level: 1, roles: '1' };
    await expect(service.assertAuthorized(actor, 'GET', '/adminapi/product/brand')).resolves.toBeUndefined();
    await expect(service.assertAuthorized(actor, 'POST', '/adminapi/product/brand')).rejects.toThrow();
    await expect(service.assertAuthorized({ ...actor, roles: '2' }, 'GET', '/adminapi/product/brand/cascader_list/2')).resolves.toBeUndefined();
    await expect(service.assertAuthorized({ ...actor, roles: '2' }, 'GET', '/adminapi/product/brand')).rejects.toThrow();
    await expect(service.assertAuthorized({ ...actor, roles: '3' }, 'PUT', '/adminapi/product/brand/12')).resolves.toBeUndefined();
    expect(service.buildMenus(new Set(['brand.view']))).toEqual([expect.objectContaining({ path: '/brand' })]);
  });
});
