import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContainerFromDb } from '@/lib/di';
import { systemMenus, systemRole } from '@/models/schema';
import { AdminPermissionService, canRetainOpaqueLegacyMenu, hasAdminPermission, normalizeRoleRules,
  PRODUCT_SKU_GENERATION_PERMISSION, requiredAdminPermission } from '@/services/admin/AdminPermissionService';
import { financePostgres } from './helpers/financePostgres';
const seed = { id: 191, authType: 2, apiUrl: 'product/generate_attr/<id>/<type>', methods: 'POST',
  menuPath: '/adminproduct/generate_attr/<id>', uniqueAuth: '' };
describe('exact191 generation capability is independent from product write and detail grants', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, service: AdminPermissionService;
  beforeAll(async () => { f = await financePostgres([systemMenus, systemRole]); service = new AdminPermissionService(createContainerFromDb(f.db)); }, 30000);
  beforeEach(async () => { await f.reset(); });
  afterAll(async () => { await f?.close(); });
  it('maps only POST and the canonical old path shapes to read-only generation admission', () => {
    for (const path of ['product/generate_attr/0/0', '/adminapi/product/generate_attr/9/1', 'product/generate_attr/<id>/<type>', 'product/generate_attr/:id/:type', 'product/generate_attr/3/2'])
      expect(requiredAdminPermission('POST', path)).toBe(PRODUCT_SKU_GENERATION_PERMISSION);
    for (const [method, path] of [['GET', 'product/generate_attr/1/1'], ['PUT', 'product/generate_attr/1/1'], ['POST', 'product/generate_attr/01/1'],
      ['POST', 'product/generate_attr/1/3'], ['POST', 'product/generate_attr/1'], ['POST', 'product/generate_attr/1/1/extra']])
      expect(requiredAdminPermission(method, path)).toBeNull();
  });
  it('admits managers and exact generation grants without adding product.view/manage or a selectable synthetic role token', () => {
    expect(hasAdminPermission(new Set(['product.manage']), PRODUCT_SKU_GENERATION_PERMISSION)).toBe(true);
    expect(hasAdminPermission(new Set([PRODUCT_SKU_GENERATION_PERMISSION]), PRODUCT_SKU_GENERATION_PERMISSION)).toBe(true);
    for (const key of ['product.view', 'category.manage', 'order.view']) expect(hasAdminPermission(new Set([key]), PRODUCT_SKU_GENERATION_PERMISSION)).toBe(false);
    for (const required of ['product.manage', 'product.view']) expect(hasAdminPermission(new Set([PRODUCT_SKU_GENERATION_PERMISSION]), required)).toBe(false);
    expect(() => normalizeRoleRules(PRODUCT_SKU_GENERATION_PERMISSION)).toThrow();
  });
  it('resolves the real191 tuple through both live SQL menu resolvers as only the narrow read capability', async () => {
    await f.db.insert(systemMenus).values(seed);
    expect(await service.resolveRulePermissionKeys('191')).toEqual([PRODUCT_SKU_GENERATION_PERMISSION]);
    expect(await service.resolveManyRulePermissionKeys(['191'])).toEqual([[PRODUCT_SKU_GENERATION_PERMISSION]]);
    expect(canRetainOpaqueLegacyMenu(seed)).toBe(false);
  });
  it('refuses copied API/path tuples and canonical-token forgery instead of falling back to generic namespace writes', async () => {
    const rows = [{ ...seed, id: 9001 }, { ...seed, id: 9002, uniqueAuth: 'product.manage' },
      { id: 9003, authType: 2, apiUrl: 'product/generate_attr/1/1', methods: 'POST', menuPath: '', uniqueAuth: 'product.manage' }];
    await f.db.insert(systemMenus).values(rows);
    for (const row of rows) {
      expect(await service.resolveRulePermissionKeys(String(row.id))).toEqual([]); expect(canRetainOpaqueLegacyMenu(row)).toBe(false);
    }
    expect(await service.resolveManyRulePermissionKeys(rows.map(row => String(row.id)))).toEqual([[], [], []]);
  });
  it('protects191 even if every claim is rewritten to a real product save tuple', async () => {
    const row = { ...seed, apiUrl: 'product/product/<id>', menuPath: '/admin/product/save', uniqueAuth: 'product-save' };
    await f.db.insert(systemMenus).values(row);
    expect(await service.resolveRulePermissionKeys('191')).toEqual([]); expect(await service.resolveManyRulePermissionKeys(['191'])).toEqual([[]]);
    expect(canRetainOpaqueLegacyMenu(row)).toBe(false);
  });
  it('requires every exact191 metadata field and existing type/access/deletion filters', async () => {
    const variants = [{ methods: 'GET' }, { menuPath: '' }, { apiUrl: 'product/generate_attr/:id/:type' },
      { uniqueAuth: 'product.manage' }, { authType: 1 }, { type: 2 }, { access: 0 }, { isDel: 1 }];
    for (const variant of variants) {
      await f.reset(); await f.db.insert(systemMenus).values({ ...seed, ...variant });
      expect(await service.resolveRulePermissionKeys('191')).toEqual([]); expect(await service.resolveManyRulePermissionKeys(['191'])).toEqual([[]]);
    }
  });
});
