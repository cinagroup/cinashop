import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { legacyCategory, storeProductSpecs, storeProduct, storeProductRelation, systemAdmin,
  systemRole, systemMenus, systemLog } from '@/models/schema';
import { ProductMetadataService, supplierMetadataOwner } from '@/services/product/ProductMetadataService';
import { normalizeProductParameterSnapshot } from '@/services/product/ProductAssociationService';
import { AdminPermissionService } from '@/services/admin/AdminPermissionService';
import { productSpecsFixture, specsActor, specsBody } from './helpers/adminProductSpecs';

const query = () => new URLSearchParams();
const platform = { type: 0, relationId: 0 } as const;
describe('PHP parameter-template contracts with actual catalog SQL and current authority', () => {
  let f: Awaited<ReturnType<typeof productSpecsFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Parameter fixture forbids external I/O'));
    f = await productSpecsFixture();
  }, 30000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30000);
  async function snapshot() {
    return { parents: await f.db.select().from(legacyCategory).orderBy(legacyCategory.id),
      children: await f.db.select().from(storeProductSpecs).orderBy(storeProductSpecs.id),
      products: await f.db.select().from(storeProduct).orderBy(storeProduct.id),
      relations: await f.db.select().from(storeProductRelation).orderBy(storeProductRelation.id),
      logs: await f.db.select().from(systemLog).orderBy(systemLog.id) };
  }

  it('projects exact legacy parents and Shanghai dates while modern lists retain specs and pagination', async () => {
    const legacy = await f.service.list(query(), specsActor());
    expect(Object.keys(legacy).sort()).toEqual(['count', 'list']);
    expect(legacy.count).toBe(3);
    expect(legacy.list.map(row => row.id)).toEqual([11, 10, 12]);
    expect(legacy.list.map(row => row.add_time)).toEqual(['', '1970-01-01 08:00:01', '2023-11-15 06:13:20']);
    expect(legacy.list.every(row => !('specs' in row))).toBe(true);
    expect(legacy.list[1]).toEqual({ id: 10, pid: 0, type: 0, relation_id: 0, owner_id: 0,
      name: '标准参数', sort: 9, group: 3, other: null, is_show: 1,
      add_time: '1970-01-01 08:00:01', integral_min: 0, integral_max: 0 });
    const modern = await f.service.list(new URLSearchParams('page=2&limit=1'), specsActor(), false);
    expect(modern).toMatchObject({ count: 3, page: 2, limit: 1,
      list: [{ id: 10, add_time: 1, specs: [{ id: 100 }, { id: 101 }] }] });
    expect(await f.db.select().from(systemLog)).toEqual([]);
  });

  it('preserves the PHP id OR name search within the complete owned template scope', async () => {
    expect((await f.service.list(new URLSearchParams('name=10'), specsActor())).list.map(row => row.id)).toEqual([10]);
    expect((await f.service.list(new URLSearchParams('name=参数'), specsActor())).count).toBe(3);
    expect((await f.service.list(new URLSearchParams('name=供应商'), specsActor())).count).toBe(0);
    expect((await f.service.list(new URLSearchParams('name=30'), specsActor())).count).toBe(0);
    expect((await f.service.list(new URLSearchParams('name=客服'), specsActor())).count).toBe(0);
    expect(await f.service.all(query(), specsActor())).toMatchObject([
      { id: 11, name: '易碎参数', specs: [{ id: 102 }] },
      { id: 10, name: '标准参数', specs: [{ id: 100 }] },
      { id: 12, name: '隐藏参数', specs: [] },
    ]);
    const detail = await f.service.detail(10, query(), specsActor());
    expect(detail).toMatchObject({ id: 10, add_time: 1, specs: [
      { id: 100, type: 0, relation_id: 0, temp_id: 10, status: 1, add_time: '1970-01-01 08:00:01' },
      { id: 101, status: 0, add_time: '1970-01-01 08:00:02' },
    ] });
    expect(detail.specs.map(row => row.id)).toEqual([100, 101]);
    for (const id of [20, 21, 22, 30, 40, 999]) {
      await expect(f.service.detail(id, query(), specsActor())).rejects.toThrow('不存在');
      await expect(f.service.save(id, specsBody(), specsActor())).rejects.toThrow('不存在');
      await expect(f.service.remove(id, query(), specsActor())).rejects.toThrow('不存在');
    }
  });

  it('isolates every metadata owner and child owner while allowing supplier reads of platform templates', async () => {
    const metadata = new ProductMetadataService(f.container), supplier = supplierMetadataOwner(20);
    await f.db.insert(storeProductSpecs).values([
      { id: 120, type: 2, relationId: 20, tempId: 10, name: '污染供应商', value: '不可泄露' },
      { id: 121, type: 0, relationId: 99, tempId: 10, name: '污染平台', value: '不可泄露' },
    ]);
    // PHP getAllSpecs and detail omit owner predicates. TS deliberately closes
    // those reads and rejects child rows whose owner differs from their parent.
    expect((await metadata.specTemplateList(supplier, {})).list.map(row => row.id)).toEqual([20]);
    expect((await metadata.specTemplateList(supplier, {}, true)).list.map(row => row.id)).toEqual([20, 11, 10, 12]);
    expect((await metadata.specTemplateDetail(supplier, 10)).specs.map(row => row.id)).toEqual([100, 101]);
    expect((await metadata.specTemplateDetail(supplier, 20)).specs.map(row => row.id)).toEqual([110]);
    expect((await metadata.allSpecTemplates(supplier)).map(row => row.id)).toEqual([20, 11, 10, 12]);
    expect((await metadata.allSpecTemplates(platform)).map(row => row.id)).toEqual([11, 10, 12]);
    const polluted = await snapshot();
    await expect(f.service.save(10, specsBody(), specsActor())).rejects.toThrow();
    await expect(f.service.remove(10, query(), specsActor())).rejects.toThrow();
    expect(await snapshot()).toEqual(polluted);
    for (const id of [21, 22, 30, 40]) await expect(metadata.specTemplateDetail(supplier, id)).rejects.toThrow('不存在');
    for (const id of [10, 11, 30]) await expect(metadata.saveSpecTemplate(supplier, id, specsBody())).rejects.toThrow('不存在');
    await expect(metadata.specTemplateDetail(supplierMetadataOwner(21), 20)).rejects.toThrow('不存在');
    await expect(metadata.saveSpecTemplate(platform, 0, specsBody({ name: '标准参数' }))).rejects.toThrow('已经存在');
    expect(await metadata.saveSpecTemplate(supplier, 0, specsBody({ name: '标准参数' }))).toMatchObject({ id: 1000 });
  });

  it('accepts complete displayed legacy edit DTOs and recreates owned children without altering immutable metadata', async () => {
    await f.db.insert(storeProductSpecs).values({ id: 103, tempId: 12, name: '零时间参数', value: '旧行', addTime: 0 });
    const epoch = await f.service.detail(12, query(), specsActor());
    expect(epoch.specs[0].add_time).toBe('1970-01-01 08:00:00');
    await f.service.save(12, epoch, specsActor());
    const original = await f.service.detail(11, query(), specsActor());
    const result = await f.service.save(11, { ...original, name: '易碎参数编辑', sort: 5,
      specs: original.specs.map(row => ({ ...row, value: '更新值', sort: 8 })) }, specsActor());
    expect(result).toEqual({ id: 11 });
    const updated = await f.service.detail(11, query(), specsActor());
    expect({ ...updated, name: original.name, sort: original.sort, specs: original.specs }).toEqual(original);
    expect(updated.specs).toHaveLength(1);
    expect(updated.specs[0]).toMatchObject({ name: '性能', value: '更新值', sort: 8,
      status: 1, type: 0, relation_id: 0, temp_id: 11 });
    expect(updated.specs[0].id).not.toBe(102);
    expect(await f.db.select().from(storeProductSpecs).where(eq(storeProductSpecs.id, 102))).toEqual([]);
    const empty = await f.service.save(0, specsBody({ name: '空模版', specs: [] }), specsActor());
    expect((await f.service.detail(empty.id, query(), specsActor())).specs).toEqual([]);
    await f.service.remove(empty.id, query(), specsActor());
    expect((await f.db.select().from(systemLog)).map(row => row.method)).toEqual(['POST', 'POST', 'POST', 'DELETE']);
  });

  it('rejects forged parent echo fields and foreign or stale child echo fields without catalog or audit effects', async () => {
    const detail = await f.service.detail(11, query(), specsActor()), before = await snapshot();
    for (const change of [{ id: 10 }, { type: 2 }, { relation_id: 20 }, { owner_id: 77 },
      { pid: 1 }, { group: 1 }, { is_show: 0 }, { other: 'changed' }, { add_time: 1 },
      { integral_min: 1 }, { integral_max: 1 }, { unexpected: true }]) {
      await expect(f.service.save(11, { ...detail, ...change }, specsActor())).rejects.toThrow();
    }
    for (const change of [{ id: 100 }, { id: 110 }, { id: 999 }, { temp_id: 10 },
      { type: 2 }, { relation_id: 20 }, { add_time: 4 }, { unexpected: true }]) {
      await expect(f.service.save(11, { ...detail, specs: [{ ...detail.specs[0], ...change }] }, specsActor())).rejects.toThrow();
    }
    await expect(f.service.save(11, { ...detail, specs: [detail.specs[0], detail.specs[0]] }, specsActor())).rejects.toThrow();
    await expect(f.service.save(0, specsBody({ specs: [{ ...detail.specs[0] }] }), specsActor())).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it('validates names, children, scalar bounds and read query multiplicity before writing SQL', async () => {
    const before = await snapshot();
    for (const body of [null, [], specsBody({ name: '' }), specsBody({ name: ' ' }),
      specsBody({ name: 'x'.repeat(256) }), specsBody({ name: 'bad\u0000name' }),
      specsBody({ name: '\ud800' }), specsBody({ sort: -1 }), specsBody({ sort: true }),
      specsBody({ sort: 2147483648 }), specsBody({ specs: {} }),
      specsBody({ specs: Array.from({ length: 101 }, () => ({ name: '项', value: '值' })) }),
      specsBody({ specs: [{ name: '', value: '值' }] }),
      specsBody({ specs: [{ name: '项', value: '' }] }),
      specsBody({ specs: [{ name: '项', value: 'x'.repeat(256) }] }),
      specsBody({ specs: [{ name: '项', value: '值', status: 2 }] }),
      specsBody({ specs: [{ name: '项', value: '值', sort: -1 }] }),
    ]) await expect(f.service.save(0, body, specsActor())).rejects.toThrow();
    for (const value of ['page=0', 'limit=101', 'page=1&page=2', 'name=a&name=b',
      'owner_id=0', 'type=0', 'page=01', 'name='+encodeURIComponent('\n')]) {
      await expect(f.service.list(new URLSearchParams(value), specsActor())).rejects.toThrow();
    }
    await expect(f.service.all(new URLSearchParams('page=1'), specsActor())).rejects.toThrow();
    await expect(f.service.detail(10, new URLSearchParams('id=10'), specsActor())).rejects.toThrow();
    await expect(f.service.remove(11, new URLSearchParams('id=11'), specsActor())).rejects.toThrow();
    for (const id of [0, -1, NaN, 2147483648]) await expect(f.service.detail(id, query(), specsActor())).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it('accepts the complete 100-row and 255-codepoint write boundaries through the real product snapshot consumer', async () => {
    const unicode = '😀'.repeat(255);
    const specs = Array.from({ length: 100 }, (_, index) => ({
      name: index === 0 ? unicode : `参数${index}`, value: unicode, sort: index, status: 1 as const,
    }));
    const created = await f.service.save(0, specsBody({ name: unicode, sort: 2147483647, specs }), specsActor());
    const modern = await f.service.detail(created.id, query(), specsActor(), false);
    expect(modern.name).toBe(unicode);
    expect(modern.sort).toBe(2147483647);
    expect(modern.specs).toHaveLength(100);
    expect(modern.specs.map(row => row.sort)).toEqual(Array.from({ length: 100 }, (_, index) => 99 - index));
    expect(normalizeProductParameterSnapshot(modern.specs)).toEqual([...specs].reverse());
    const legacy = await f.service.detail(created.id, query(), specsActor());
    await f.service.save(created.id, legacy, specsActor());
    expect(normalizeProductParameterSnapshot((await f.service.detail(created.id, query(), specsActor(), false)).specs))
      .toEqual([...specs].reverse());
    const before = await snapshot();
    for (const child of [{ name: '😀'.repeat(256), value: '值' }, { name: '项', value: '😀'.repeat(256) }]) {
      await expect(f.service.save(0, specsBody({ name: '超长Unicode参数', specs: [child] }), specsActor())).rejects.toThrow();
    }
    expect(await snapshot()).toEqual(before);
  });

  it('returns complete 2000-child reads, rejects overflow explicitly and keeps legacy parent lists independent of children', async () => {
    await f.exec("INSERT INTO store_product_specs (id,temp_id,name,value,status,add_time) SELECT 2000+n,11,'旧参数'||n,'值',1,0 FROM generate_series(1,1999) AS n");
    const metadata = new ProductMetadataService(f.container);
    const detail = await metadata.specTemplateDetail(platform, 11);
    expect(detail.specs).toHaveLength(2000);
    expect(detail.specs.map(row => row.id)).toContain(3999);
    expect((await f.service.detail(11, query(), specsActor())).specs).toHaveLength(2000);
    const parents = await f.service.list(new URLSearchParams('limit=100'), specsActor());
    expect(parents.count).toBe(3);
    expect(parents.list.map(row => row.id)).toEqual([11, 10, 12]);
    expect(parents.list.every(row => !('specs' in row))).toBe(true);
    await expect(f.service.list(new URLSearchParams('limit=100'), specsActor(), false)).rejects.toThrow('2000');
    await expect(f.service.all(query(), specsActor())).rejects.toThrow('2000');
    await f.db.insert(storeProductSpecs).values({ id: 4000, tempId: 11, name: '溢出参数', value: '值' });
    const before = await snapshot();
    await expect(metadata.specTemplateDetail(platform, 11)).rejects.toThrow('2000');
    await expect(f.service.detail(11, query(), specsActor())).rejects.toThrow('2000');
    await expect(f.service.save(11, specsBody(), specsActor())).rejects.toThrow('2000');
    await expect(f.service.remove(11, query(), specsActor())).rejects.toThrow('2000');
    expect((await f.service.list(query(), specsActor())).count).toBe(3);
    expect(await snapshot()).toEqual(before);
  });

  it('returns every template at the 2000-selector bound and refuses the 2001st without truncating paginated lists', async () => {
    await f.exec("INSERT INTO category (id,name,\"group\",sort) SELECT 2000+n,'旧模板'||n,3,0 FROM generate_series(1,1997) AS n");
    const all = await f.service.all(query(), specsActor());
    expect(all).toHaveLength(2000);
    expect(all.map(row => row.id)).toContain(3997);
    expect(all.map(row => row.id)).toContain(2001);
    await f.db.insert(legacyCategory).values({ id: 4000, name: '溢出模板', group: 3 });
    await expect(f.service.all(query(), specsActor())).rejects.toThrow('2000');
    const lastPage = await f.service.list(new URLSearchParams('page=21&limit=100'), specsActor());
    expect(lastPage).toMatchObject({ count: 2001, list: [{ id: 2001 }] });
    expect(lastPage.list).toHaveLength(1);
    expect(await f.db.select().from(systemLog)).toEqual([]);
  });

  it('grants the exact PHP 1381 page read access without writes or the unrelated 1383 create-page grant', async () => {
    const permissions = new AdminPermissionService(f.container);
    expect(await permissions.resolveRulePermissionKeys('1381')).toEqual(['product.view']);
    expect(await permissions.resolveManyRulePermissionKeys(['1381', '1383'])).toEqual([['product.view'], []]);
    expect((await f.service.list(query(), specsActor(105))).count).toBe(3);
    expect((await f.service.detail(11, query(), specsActor(105))).id).toBe(11);
    await expect(f.service.save(0, specsBody(), specsActor(105))).rejects.toThrow('权限');
    await expect(f.service.remove(11, query(), specsActor(105))).rejects.toThrow('权限');
    await expect(f.service.list(query(), specsActor(106))).rejects.toThrow('权限');
    const original = { type: 1, authType: 1, menuPath: '/admin/product/specs',
      uniqueAuth: 'admin-storeProduct-specs', apiUrl: '', methods: '' };
    for (const change of [{ authType: 2 }, { type: 2 }, { menuPath: '/admin/product/Specs' },
      { uniqueAuth: 'admin-storeproduct-specs' }, { apiUrl: 'product/specs' }, { methods: 'GET' }]) {
      await f.db.update(systemMenus).set({ ...original, ...change }).where(eq(systemMenus.id, 1381));
      expect(await permissions.resolveRulePermissionKeys('1381')).toEqual([]);
      expect(await permissions.resolveManyRulePermissionKeys(['1381'])).toEqual([[]]);
    }
    expect(await f.db.select().from(systemLog)).toEqual([]);
  });

  it('revalidates current roles, password, account scope and token expiry at the business SQL boundary', async () => {
    const before = await snapshot();
    expect((await f.service.list(query(), specsActor(102))).count).toBe(3);
    await expect(f.service.save(0, specsBody(), specsActor(102))).rejects.toThrow('权限');
    await expect(f.service.list(query(), specsActor(103))).rejects.toThrow('权限');
    await f.db.update(systemRole).set({ rules: 'user.view' }).where(eq(systemRole.id, 1));
    await expect(f.service.save(0, specsBody(), specsActor())).rejects.toThrow('权限');
    await f.db.update(systemAdmin).set({ pwd: 'changed' }).where(eq(systemAdmin.id, 102));
    await expect(f.service.list(query(), specsActor(102))).rejects.toThrow('凭据');
    await f.db.update(systemAdmin).set({ adminType: 4, relationId: 20 }).where(eq(systemAdmin.id, 100));
    await expect(f.service.list(query(), specsActor(100))).rejects.toThrow('身份');
    await expect(f.service.list(query(), { ...specsActor(), expiresAt: 1 })).rejects.toThrow('过期');
    expect(await snapshot()).toEqual(before);
  });

  it('preserves live product parameter snapshots during template edits and refuses direct or relation references on delete', async () => {
    const productSpecs = JSON.stringify([{ name: '性能', value: '已售快照', sort: 1, status: 1 }]);
    await f.db.insert(storeProduct).values({ id: 80, type: 2, relationId: 20, specsId: 11, specs: productSpecs });
    const before = await f.db.select().from(storeProduct);
    await f.service.save(11, specsBody({ name: '引用模板编辑' }), specsActor());
    expect(await f.db.select().from(storeProduct)).toEqual(before);
    await expect(f.service.remove(11, query(), specsActor())).rejects.toThrow('商品使用');
    await f.db.update(storeProduct).set({ specsId: 0 }).where(eq(storeProduct.id, 80));
    await f.db.insert(storeProductRelation).values({ productId: 80, relationId: 11, type: 6 });
    await expect(f.service.remove(11, query(), specsActor())).rejects.toThrow('商品使用');
    await f.db.delete(storeProductRelation).where(eq(storeProductRelation.productId, 80));
    await f.service.remove(11, query(), specsActor());
    expect(await f.db.select().from(legacyCategory).where(eq(legacyCategory.id, 11))).toEqual([]);
    expect(await f.db.select().from(storeProductSpecs).where(eq(storeProductSpecs.tempId, 11))).toEqual([]);
    expect((await f.db.select().from(storeProduct))[0].specs).toBe(productSpecs);
  });

  it('rolls back every parent, child and audit change when SQL skips a parent update or audit insert', async () => {
    const before = await snapshot();
    await f.exec("CREATE FUNCTION skip_specs_parent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER skip_specs_parent BEFORE UPDATE ON category FOR EACH ROW EXECUTE FUNCTION skip_specs_parent()");
    await expect(f.service.save(11, specsBody(), specsActor())).rejects.toThrow('回执');
    expect(await snapshot()).toEqual(before);
    await f.exec('DROP TRIGGER skip_specs_parent ON category');
    await f.exec("CREATE FUNCTION skip_specs_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER skip_specs_audit BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION skip_specs_audit()");
    await expect(f.service.save(11, specsBody(), specsActor())).rejects.toThrow('审计');
    await expect(f.service.save(0, specsBody(), specsActor())).rejects.toThrow('审计');
    await expect(f.service.remove(11, query(), specsActor())).rejects.toThrow('审计');
    expect(await snapshot()).toEqual(before);
  });

  it('checks complete child insert and deletion receipts so database triggers cannot commit incomplete replacement', async () => {
    const before = await snapshot();
    await f.exec("CREATE FUNCTION skip_specs_child() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER skip_specs_child BEFORE INSERT ON store_product_specs FOR EACH ROW EXECUTE FUNCTION skip_specs_child()");
    await expect(f.service.save(11, specsBody(), specsActor())).rejects.toThrow('回执');
    await expect(f.service.save(0, specsBody(), specsActor())).rejects.toThrow('回执');
    expect(await snapshot()).toEqual(before);
    await f.exec('DROP TRIGGER skip_specs_child ON store_product_specs');
    await f.exec("CREATE FUNCTION skip_specs_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER skip_specs_delete BEFORE DELETE ON store_product_specs FOR EACH ROW EXECUTE FUNCTION skip_specs_delete()");
    await expect(f.service.save(11, specsBody(), specsActor())).rejects.toThrow('回执');
    await expect(f.service.remove(11, query(), specsActor())).rejects.toThrow('回执');
    expect(await snapshot()).toEqual(before);
  });
});
