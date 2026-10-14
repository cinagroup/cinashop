import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeProductUnit, storeProduct, systemAdmin, systemRole, systemLog, systemMenus } from '@/models/schema';
import { AdminPermissionService } from '@/services/admin/AdminPermissionService';
import { unitId } from '@/services/admin/AdminProductUnitService';
import { ProductMetadataService } from '@/services/product/ProductMetadataService';
import { productUnitFixture, unitActor } from './helpers/adminProductUnits';
const query = () => new URLSearchParams();
describe('PHP platform unit contracts and current Admin authority', () => {
  let f: Awaited<ReturnType<typeof productUnitFixture>>;
  beforeEach(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden')); f = await productUnitFixture(); }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  it('returns owner-scoped enabled selectors, deterministic list and exact snake-case details', async () => {
    expect(await f.service.all(query(), unitActor())).toEqual([{ id: 2, name: '箱' }, { id: 1, name: '件' }, { id: 3, name: '套餐' }]);
    expect(await f.service.list(new URLSearchParams('page=2&limit=1'), unitActor())).toMatchObject({ list: [{ id: 1, type: 0, relation_id: 0, name: '件', add_time: 1, is_del: 0 }], count: 3, page: 2, limit: 1 });
    expect(await f.service.detail(4, query(), unitActor())).toMatchObject({ id: 4, status: 0 });
    for (const id of [5, 6, 7, 99]) await expect(f.service.detail(id, query(), unitActor())).rejects.toThrow('不存在');
    expect(await f.db.select().from(systemLog)).toEqual([]);
  });
  it('reconstructs create and populated edit forms with correct methods, targets and 15-character controls', async () => {
    expect(await f.service.form(0, query(), unitActor())).toMatchObject({ title: '添加商品单位', action: 'product/unit', method: 'POST', rules: [{ field: 'name', value: '', props: { maxlength: 15 } }, { field: 'sort', value: 0, props: { min: 0 } }] });
    expect(await f.service.form(1, query(), unitActor())).toMatchObject({ title: '编辑商品单位', action: 'product/unit/1', method: 'PUT', rules: [{ field: 'name', value: '件' }, { field: 'sort', value: 9 }] });
    await expect(f.service.form(6, query(), unitActor())).rejects.toThrow('不存在');
  });
  it('recognizes the exact PHP 1349 page seed in both resolvers without writer or forged-page grants', async () => {
    const permissions = new AdminPermissionService(f.container);
    expect(await permissions.resolveRulePermissionKeys('1349')).toEqual(['product.view']);
    expect(await permissions.resolveManyRulePermissionKeys(['1349'])).toEqual([['product.view']]);
    expect((await f.service.list(query(), unitActor(105))).count).toBe(3);
    await expect(f.service.save(0, { name: '旧只读不能写' }, unitActor(105))).rejects.toThrow('权限');
    const original = { authType: 1, menuPath: '/admin/product/unitList', uniqueAuth: 'admin-storeProduct-unit', apiUrl: '', methods: '' };
    const variants: Array<Partial<typeof systemMenus.$inferInsert>> = [
      { authType: 2, apiUrl: 'product/unit', methods: 'POST' }, { menuPath: '/admin/product/unitlist' },
      { uniqueAuth: 'admin-storeproduct-unit' }, { apiUrl: 'product/unit' }, { methods: 'GET' }, { type: 2 },
    ];
    for (const change of variants) {
      await f.db.update(systemMenus).set({ ...original, type: 1, ...change }).where(eq(systemMenus.id, 1349));
      expect(await permissions.resolveRulePermissionKeys('1349')).toEqual([]);
      expect(await permissions.resolveManyRulePermissionKeys(['1349'])).toEqual([[]]);
    }
  });
  it('preserves real 15-character Unicode names, scopes duplicates, sorts and returns complete committed effects', async () => {
    const name = '😀'.repeat(15), result = await f.service.save(0, { name, sort: 32767 }, unitActor());
    expect(await f.service.detail(result.id, query(), unitActor())).toMatchObject({ name, sort: 32767, type: 0, relation_id: 0, status: 1 });
    await expect(f.service.save(0, { name }, unitActor())).rejects.toThrow('已经存在');
    await expect(f.service.save(1, { name }, unitActor())).rejects.toThrow('已经存在');
    await expect(f.service.save(0, { name: '😀'.repeat(16) }, unitActor())).rejects.toThrow('15');
    for (const name of ['', ' ', 'a\n', '\ud800']) await expect(f.service.save(0, { name }, unitActor())).rejects.toThrow();
    await f.service.save(1, { name: '件', sort: 1 }, unitActor());
    await f.service.remove(result.id, query(), unitActor());
    expect((await f.db.select().from(storeProductUnit).where(eq(storeProductUnit.id, result.id)))[0]).toMatchObject({ name, isDel: 1 });
    expect((await f.db.select().from(systemLog)).map(row => row.method)).toEqual(['POST', 'PUT', 'DELETE']);
  });
  it('blocks deletion and renaming of names used by any live owner and permits sorting without rewriting products', async () => {
    await f.db.insert(storeProduct).values({ id: 80, type: 2, relationId: 20, unitName: '件' });
    const before = await f.db.select().from(storeProduct);
    await expect(f.service.remove(1, query(), unitActor())).rejects.toThrow('正在使用');
    await expect(f.service.save(1, { name: '新件' }, unitActor())).rejects.toThrow('不能修改名称');
    await f.service.save(1, { name: '件', sort: 5 }, unitActor());
    expect(await f.db.select().from(storeProduct)).toEqual(before);
    await f.db.update(storeProduct).set({ isDel: 1 }).where(eq(storeProduct.id, 80));
    await f.service.remove(1, query(), unitActor());
  });
  it('uses the same Unicode bound and global reference checks in existing metadata callers', async () => {
    const metadata = new ProductMetadataService(f.container), owner = { type: 0, relationId: 0 } as const;
    await expect(metadata.saveUnit(owner, 0, { name: 'x'.repeat(16) })).rejects.toThrow('15');
    await f.db.insert(storeProduct).values({ id: 80, type: 2, relationId: 20, unitName: '箱' });
    await expect(metadata.deleteUnit(owner, 2)).rejects.toThrow('正在使用');
  });
  it('revalidates read/write permission, credentials, account type and expiration at the actual SQL boundary', async () => {
    await expect(f.service.list(query(), unitActor(102))).resolves.toMatchObject({ count: 3 });
    await expect(f.service.save(0, { name: '禁止' }, unitActor(102))).rejects.toThrow('权限');
    await expect(f.service.list(query(), unitActor(103))).rejects.toThrow('权限');
    await f.db.update(systemRole).set({ rules: 'user.view' }).where(eq(systemRole.id, 1));
    await expect(f.service.save(0, { name: '撤权' }, unitActor())).rejects.toThrow('权限');
    await f.db.update(systemAdmin).set({ pwd: 'changed' }).where(eq(systemAdmin.id, 102));
    await expect(f.service.list(query(), unitActor(102))).rejects.toThrow('凭据');
    await f.db.update(systemAdmin).set({ adminType: 4, relationId: 20 }).where(eq(systemAdmin.id, 100));
    await expect(f.service.list(query(), unitActor(100))).rejects.toThrow('身份');
    await expect(f.service.list(query(), { ...unitActor(), expiresAt: 1 })).rejects.toThrow('过期');
    expect(await f.db.select().from(systemLog)).toEqual([]);
  });
  it('rejects repeated, unknown and malformed read parameters before generating SQL', async () => {
    for (const value of [0, -1, '01', '1e2', 2147483648, NaN, true]) expect(() => unitId(value)).toThrow();
    for (const value of ['page=0', 'limit=-1', 'page=1&page=2', 'unknown=1', 'name='+encodeURIComponent('\n')]) await expect(f.service.list(new URLSearchParams(value), unitActor())).rejects.toThrow();
    await expect(f.service.all(new URLSearchParams('page=1'), unitActor())).rejects.toThrow('查询');
  });
  it('rolls back malformed unit write receipts and skipped audit inserts', async () => {
    await f.exec("CREATE FUNCTION rewrite_unit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.type=2; RETURN NEW; END $$; CREATE TRIGGER rewrite_unit_fixture BEFORE INSERT ON store_product_unit FOR EACH ROW EXECUTE FUNCTION rewrite_unit_fixture()");
    await expect(f.service.save(0, { name: '改写' }, unitActor())).rejects.toThrow('回执');
    expect(await f.db.select().from(storeProductUnit).where(eq(storeProductUnit.name, '改写'))).toEqual([]);
    await f.exec('DROP TRIGGER rewrite_unit_fixture ON store_product_unit');
    await f.exec("CREATE FUNCTION skip_unit_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER skip_unit_audit_fixture BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION skip_unit_audit_fixture()");
    await expect(f.service.save(0, { name: '回滚' }, unitActor())).rejects.toThrow('审计');
    expect(await f.db.select().from(storeProductUnit).where(eq(storeProductUnit.name, '回滚'))).toEqual([]);
  });
});
