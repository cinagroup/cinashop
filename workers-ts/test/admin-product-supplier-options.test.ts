import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { systemAdmin, systemMenus, systemRole, systemSupplier } from '@/models/schema';
import { AdminPermissionService, canRetainOpaqueLegacyMenu, requiredAdminPermission } from '@/services/admin/AdminPermissionService';
import { seedSupplierOptions, supplierOptionsActor, supplierOptionsExpected, supplierOptionsFixture,
  supplierOptionsSnapshot } from './helpers/adminProductSupplierOptions';

describe('actual legacy Admin supplier selector SQL and permission contract', () => {
  let f: Awaited<ReturnType<typeof supplierOptionsFixture>>;
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Supplier selector forbids provider I/O'));
    f = await supplierOptionsFixture();
  }, 30000);
  beforeEach(async () => { await f.reset(); await seedSupplierOptions(f.db); });
  afterAll(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });
  const read = (query = '', id = 101) => f.service.supplierOptions(new URLSearchParams(query), supplierOptionsActor(id));

  it('returns exactly id/name, includes disabled suppliers, excludes deleted suppliers and orders by ID rather than sort', async () => {
    const before = await supplierOptionsSnapshot(f.db);
    expect(await read()).toEqual(supplierOptionsExpected);
    expect(await supplierOptionsSnapshot(f.db)).toEqual(before);
    await f.db.delete(systemSupplier);
    expect(await read()).toEqual([]);
  });

  it('ignores bounded old query values including duplicate pagination/status/keyword and never narrows or pages the array', async () => {
    const before = await supplierOptionsSnapshot(f.db);
    expect(await read('page=2&limit=1&is_show=1&keywords=missing&is_del=1&page=999&unknown[]=x')).toEqual(supplierOptionsExpected);
    expect(await supplierOptionsSnapshot(f.db)).toEqual(before);
    for (const query of ['x='.concat('x'.repeat(257)), 'x'.repeat(257).concat('=a'),
      new URLSearchParams(Array.from({ length: 321 }, () => ['x', ''])).toString(),
      new URLSearchParams(Array.from({ length: 100 }, (_, i) => [String(i), '中'.repeat(30)])).toString()])
      await expect(read(query)).rejects.toThrow('容量');
  });

  it('returns all 10000 options and fails closed instead of silently truncating the 10001st', async () => {
    await f.exec("INSERT INTO system_supplier(id,admin_id,supplier_name) SELECT n,n+100000,'容量候选' FROM generate_series(100,10097) n");
    expect(await read()).toHaveLength(10000);
    await f.db.insert(systemSupplier).values({ id: 20000, adminId: 200000, supplierName: '不得截断' });
    await expect(read()).rejects.toMatchObject({ httpStatus: 503 });
  });

  it('admits actual catalog readers and managers while rejecting unrelated, owner realms and invented numeric selector grants', async () => {
    for (const id of [100, 101, 102, 103, 108, 109]) expect(await read('', id)).toEqual(supplierOptionsExpected);
    for (const id of [104, 105, 106, 107, 110, 111]) await expect(read('', id)).rejects.toThrow(/权限|身份/);
    await f.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 1));
    await expect(read()).rejects.toThrow('权限');
  });

  it('rechecks live password/status/session expiry and fails without altering any fixture rows', async () => {
    const before = await supplierOptionsSnapshot(f.db);
    await expect(f.service.supplierOptions(new URLSearchParams(), { ...supplierOptionsActor(), expiresAt: Math.floor(Date.now() / 1000) - 1 })).rejects.toThrow('过期');
    expect(await supplierOptionsSnapshot(f.db)).toEqual(before);
    await f.db.update(systemAdmin).set({ pwd: 'changed-password' }).where(eq(systemAdmin.id, 101));
    await expect(read()).rejects.toThrow('凭据');
    await f.db.update(systemAdmin).set({ status: 0 }).where(eq(systemAdmin.id, 101));
    await expect(read()).rejects.toThrow('身份');
  });

  it('requires the catalog read grant only for the exact GET/HEAD selector route and protects fake API/path/menu fallbacks', async () => {
    expect(requiredAdminPermission('GET', '/adminapi/supplier/list')).toBe('product.view');
    expect(requiredAdminPermission('HEAD', '/adminapi/supplier/list')).toBe('product.view');
    for (const method of ['POST', 'PUT', 'DELETE']) expect(requiredAdminPermission(method, '/adminapi/supplier/list')).toBeNull();
    expect(requiredAdminPermission('GET', '/adminapi/supplier/list/1')).toBeNull();
    const permissions = new AdminPermissionService(f.container);
    const claimed = [
      { id: 9998, authType: 2, apiUrl: 'supplier/list', methods: 'GET', menuPath: '', uniqueAuth: '' },
      { id: 9999, authType: 2, apiUrl: 'supplier/list', methods: 'GET', menuPath: '/product', uniqueAuth: 'product.manage' },
      { id: 9997, authType: 2, apiUrl: '', methods: 'GET', menuPath: '/admin/supplier/list', uniqueAuth: 'product.manage' },
      { id: 9996, authType: 2, apiUrl: 'supplier/list/1', methods: 'POST', menuPath: '/product', uniqueAuth: 'product.view' },
    ];
    await f.db.insert(systemMenus).values(claimed.slice(2).map(row => ({ ...row, type: 1 })));
    for (const menu of claimed) {
      expect(canRetainOpaqueLegacyMenu(menu)).toBe(false);
      expect(await permissions.resolveRulePermissionKeys(String(menu.id))).toEqual([]);
    }
    expect(await permissions.resolveManyRulePermissionKeys(claimed.map(menu => String(menu.id)))).toEqual(claimed.map(() => []));
  });
});
