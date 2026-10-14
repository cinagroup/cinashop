import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeProductEnsure, storeProduct, storeProductRelation, systemAdmin, systemRole,
  systemMenus, systemLog } from '@/models/schema';
import { ProductExperienceService } from '@/services/product/ProductExperienceService';
import { ProductAssociationService } from '@/services/product/ProductAssociationService';
import { AdminPermissionService } from '@/services/admin/AdminPermissionService';
import { productEnsureFixture, ensureActor, ensureBody } from './helpers/adminProductEnsures';

const query = () => new URLSearchParams();
describe('PHP assurance forms and mutable catalog contracts with current SQL authority', () => {
  let f: Awaited<ReturnType<typeof productEnsureFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Ensure fixture forbids external I/O'));
    f = await productEnsureFixture();
  }, 30000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30000);
  async function snapshot() {
    return { ensures: await f.db.select().from(storeProductEnsure).orderBy(storeProductEnsure.id),
      products: await f.db.select().from(storeProduct).orderBy(storeProduct.id),
      relations: await f.db.select().from(storeProductRelation).orderBy(storeProductRelation.id),
      logs: await f.db.select().from(systemLog).orderBy(systemLog.id) };
  }

  it('projects PHP dates and counts without changing numeric modern lists or the existing detail extension', async () => {
    const legacy = await f.service.list(query(), ensureActor());
    expect(Object.keys(legacy).sort()).toEqual(['count', 'list']);
    expect(legacy.list.map(row => row.id)).toEqual([11, 10, 12]);
    expect(legacy.list.map(row => row.add_time)).toEqual(['1970-01-01 08:00:00', '1970-01-01 08:00:01', '2023-11-15 06:13:20']);
    expect(legacy.list[1]).toEqual({ id: 10, type: 0, relation_id: 0, name: '无忧退',
      image: 'https://shop.example/ten.png', desc: '已启用条款', sort: 9, status: 1,
      add_time: '1970-01-01 08:00:01', product_count: 0 });
    const modern = await f.service.list(new URLSearchParams('page=2&limit=1'), ensureActor(), false);
    expect(modern).toMatchObject({ count: 3, page: 2, limit: 1, list: [{ id: 10, add_time: 1 }] });
    expect(modern.list[0]).not.toHaveProperty('product_count');
    // PHP resource has no read action. Its already registered TS detail extension stays numeric.
    expect(await f.service.detail(11, query(), ensureActor())).toMatchObject({ id: 11, status: 0, add_time: 0 });
    expect(await f.db.select().from(systemLog)).toEqual([]);
  });

  it('keeps selector DTOs distinct and searches exact owned IDs or names rather than foreign catalogs', async () => {
    expect(await f.service.all(query(), ensureActor())).toEqual([{ id: 10, name: '无忧退' }, { id: 12, name: '破损保障' }]);
    expect(await f.service.all(query(), ensureActor(), false)).toMatchObject([
      { id: 10, type: 0, relation_id: 0, add_time: 1 }, { id: 12, add_time: 1700000000 },
    ]);
    expect((await f.service.list(new URLSearchParams('name=10'), ensureActor())).list.map(row => row.id)).toEqual([10]);
    expect((await f.service.list(new URLSearchParams('name=保障'), ensureActor())).count).toBe(2);
    expect((await f.service.list(new URLSearchParams('name=供应商'), ensureActor())).count).toBe(0);
    for (const id of [20, 21, 22, 30, 999]) {
      await expect(f.service.detail(id, query(), ensureActor())).rejects.toThrow('不存在');
      await expect(f.service.editForm(id, query(), ensureActor())).rejects.toThrow('不存在');
      await expect(f.service.update(id, ensureBody(), ensureActor())).rejects.toThrow('不存在');
      await expect(f.service.setStatus(id, 0, query(), ensureActor())).rejects.toThrow('不存在');
      await expect(f.service.remove(id, query(), ensureActor())).rejects.toThrow('不存在');
    }
  });

  it('matches PHP FIND_IN_SET product_count exactly across owners, deleted rows and repeated tokens', async () => {
    await f.db.insert(storeProduct).values([
      { id: 80, ensureId: '10' }, { id: 81, type: 2, relationId: 20, ensureId: '10,12' },
      { id: 82, ensureId: '10,10', isDel: 1 }, { id: 83, ensureId: '110' },
      { id: 84, ensureId: ' 10,12' }, { id: 85, ensureId: '010,10x,10.0' },
      { id: 86, ensureId: '0,10,0' },
    ]);
    await f.db.insert(storeProductRelation).values({ productId: 80, relationId: 11, type: 5 });
    const before = await snapshot();
    expect((await f.service.list(query(), ensureActor())).list).toMatchObject([
      { id: 11, product_count: 0 }, { id: 10, product_count: 4 }, { id: 12, product_count: 2 },
    ]);
    expect(await snapshot()).toEqual(before);
  });

  it('restores create and populated edit forms with PHP actions, four rules and 100-character name controls', async () => {
    const form = await f.service.createForm(query(), ensureActor(105));
    expect(form).toMatchObject({ title: '添加保障服务', action: 'product/ensure', method: 'POST', rules: [
      { type: 'input', field: 'name', value: '', props: { maxlength: 100 } },
      { type: 'input', field: 'desc', value: '', props: { type: 'textarea' }, validate: [{ required: true }] },
      { type: 'frame', field: 'image', value: '', props: { type: 'image', maxLength: 1,
        src: '/admin/widget.images/index?fodder=image', width: '960px', height: '505px', modal: { 'footer-hide': true } } },
      { type: 'inputNumber', field: 'sort', value: 0, props: { min: 0 } },
    ] });
    expect(form.rules).toHaveLength(4);
    expect(await f.service.editForm(11, query(), ensureActor(105))).toMatchObject({
      title: '编辑保障服务', action: 'product/ensure/11', method: 'PUT', rules: [
        { field: 'name', value: '隐藏保障' }, { field: 'desc', value: '已停用条款' },
        { field: 'image', value: 'https://shop.example/eleven.png' }, { field: 'sort', value: 9 },
      ],
    });
  });

  it('preserves disabled status on omitted or echoed legacy updates while modern writers can change it explicitly', async () => {
    await f.service.update(11, ensureBody({ name: '停用编辑' }), ensureActor());
    expect((await f.service.detail(11, query(), ensureActor())).status).toBe(0);
    const echo = await f.service.detail(11, query(), ensureActor());
    await f.service.update(11, { ...echo, desc: '完整回显' }, ensureActor());
    await expect(f.service.update(11, { ...echo, status: 1 }, ensureActor())).rejects.toThrow();
    await f.service.update(11, { ...echo, status: 1 }, ensureActor(), false);
    expect((await f.service.detail(11, query(), ensureActor())).status).toBe(1);
    await f.service.setStatus(11, 0, query(), ensureActor());
    await f.service.update(11, ensureBody({ name: '现代省略状态' }), ensureActor(), false);
    expect((await f.service.detail(11, query(), ensureActor())).status).toBe(0);
    expect((await f.service.all(query(), ensureActor())).map(row => row.id)).not.toContain(11);
    const created = await f.service.create(ensureBody({ name: '默认启用' }), ensureActor());
    expect((await f.service.detail(created.id, query(), ensureActor())).status).toBe(1);
    const disabled = await f.service.create(ensureBody({ name: '现代新停用', status: 0 }), ensureActor(), false);
    expect((await f.service.detail(disabled.id, query(), ensureActor())).status).toBe(0);
  });

  it('accepts API names beyond the form bound and all 255 Unicode codepoints while retaining optional HTTP descriptions', async () => {
    const name = '😀'.repeat(255), created = await f.service.create(ensureBody({ name, desc: '😀'.repeat(255) }), ensureActor());
    expect(await f.service.detail(created.id, query(), ensureActor())).toMatchObject({ name, desc: '😀'.repeat(255) });
    const noDescription = await f.service.create({ name: '空描述条款', image: 'https://shop.example/empty.png', sort: 0 }, ensureActor());
    expect((await f.service.detail(noDescription.id, query(), ensureActor())).desc).toBe('');
    await f.service.update(noDescription.id, ensureBody({ name: '空描述条款', desc: '' }), ensureActor());
    for (const change of [{ name: '😀'.repeat(256) }, { desc: '😀'.repeat(256) }, { image: 'x'.repeat(256) }]) {
      await expect(f.service.create(ensureBody(change), ensureActor())).rejects.toThrow();
    }
  });

  it('validates full list echo metadata and refuses stale counts, identity changes and unknown fields atomically', async () => {
    const legacy = (await f.service.list(new URLSearchParams('name=10'), ensureActor())).list[0];
    await f.service.update(10, { ...legacy, desc: '合法列表回显' }, ensureActor());
    const before = await snapshot();
    for (const change of [{ id: 11 }, { type: 2 }, { relation_id: 20 }, { add_time: 2 },
      { product_count: 1 }, { owner_id: 0 }, { unknown: true }]) {
      await expect(f.service.update(10, { ...legacy, ...change }, ensureActor())).rejects.toThrow();
    }
    expect(await snapshot()).toEqual(before);
    await f.db.insert(storeProduct).values({ id: 80, ensureId: '10' });
    const withProduct = await snapshot();
    await expect(f.service.update(10, legacy, ensureActor())).rejects.toThrow();
    expect(await snapshot()).toEqual(withProduct);
  });

  it('keeps core owners isolated and scopes duplicate names without exposing foreign supplier or store assurances', async () => {
    const core = new ProductExperienceService(f.container), supplier = { type: 2, relationId: 20 } as const;
    expect((await core.allEnsures(supplier)).map(row => row.id)).toEqual([10, 12, 20]);
    expect((await core.ensureList(supplier, {})).list.map(row => row.id)).toEqual([20]);
    for (const id of [10, 21, 22, 30]) await expect(core.ensureDetail(supplier, id)).rejects.toThrow('不存在');
    await expect(f.service.create(ensureBody({ name: '无忧退' }), ensureActor())).rejects.toThrow('已存在');
    expect(await core.saveEnsure(supplier, 0, ensureBody({ name: '无忧退' }))).toMatchObject({ id: 1000 });
    expect((await f.service.all(query(), ensureActor())).map(row => row.id)).toEqual([10, 12]);
  });

  it('rejects malformed scalars and repeated, unsupported or invalid queries before producing catalog effects', async () => {
    const before = await snapshot();
    for (const body of [null, [], ensureBody({ name: '' }), ensureBody({ image: '' }),
      ensureBody({ name: 'bad\u0000name' }), ensureBody({ name: '\ud800' }),
      ensureBody({ sort: true }), ensureBody({ sort: -1 }), ensureBody({ sort: '01' }),
      ensureBody({ sort: 2147483648 }), ensureBody({ status: 2 }), ensureBody({ unknown: 1 })]) {
      await expect(f.service.create(body, ensureActor())).rejects.toThrow();
    }
    for (const input of ['page=0', 'limit=101', 'page=01', 'page=1&page=2', 'name=a&name=b',
      'type=0', 'name='+encodeURIComponent('\n')]) {
      await expect(f.service.list(new URLSearchParams(input), ensureActor())).rejects.toThrow();
    }
    await expect(f.service.all(query(), { ...ensureActor(), expiresAt: 1 })).rejects.toThrow('过期');
    await expect(f.service.all(new URLSearchParams('page=1'), ensureActor())).rejects.toThrow();
    await expect(f.service.createForm(new URLSearchParams('id=0'), ensureActor())).rejects.toThrow();
    await expect(f.service.detail(10, new URLSearchParams('id=10'), ensureActor())).rejects.toThrow();
    await expect(f.service.setStatus(10, 0, new URLSearchParams('status=0'), ensureActor())).rejects.toThrow();
    await expect(f.service.remove(11, new URLSearchParams('id=11'), ensureActor())).rejects.toThrow();
    for (const id of [0, -1, NaN, 2147483648]) await expect(f.service.detail(id, query(), ensureActor())).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it('grants only the exact 1382 page reader and refuses forged 1383 tuples in both permission resolvers', async () => {
    const permissions = new AdminPermissionService(f.container);
    expect(await permissions.resolveRulePermissionKeys('1382')).toEqual(['product.view']);
    expect(await permissions.resolveManyRulePermissionKeys(['1382', '1383'])).toEqual([['product.view'], []]);
    expect((await f.service.list(query(), ensureActor(105))).count).toBe(3);
    await expect(f.service.create(ensureBody(), ensureActor(105))).rejects.toThrow('权限');
    await expect(f.service.remove(11, query(), ensureActor(105))).rejects.toThrow('权限');
    const original = { type: 1, authType: 1, menuPath: '/admin/product/ensure', uniqueAuth: 'admin-storeProduct-ensure', apiUrl: '', methods: '' };
    for (const change of [{ type: 2 }, { authType: 2 }, { menuPath: '/admin/product/Ensure' },
      { uniqueAuth: 'admin-storeproduct-ensure' }, { apiUrl: 'product/ensure' }, { methods: 'GET' }]) {
      await f.db.update(systemMenus).set({ ...original, ...change }).where(eq(systemMenus.id, 1382));
      expect(await permissions.resolveRulePermissionKeys('1382')).toEqual([]);
      expect(await permissions.resolveManyRulePermissionKeys(['1382'])).toEqual([[]]);
    }
    for (const change of [original, { ...original, authType: 2, apiUrl: 'product/ensure', methods: 'POST' },
      { ...original, authType: 2, apiUrl: 'product/ensure/<id>', methods: 'DELETE' }]) {
      await f.db.update(systemMenus).set(change).where(eq(systemMenus.id, 1383));
      expect(await permissions.resolveRulePermissionKeys('1383')).toEqual([]);
      expect(await permissions.resolveManyRulePermissionKeys(['1383'])).toEqual([[]]);
      await expect(f.service.list(query(), ensureActor(106))).rejects.toThrow('权限');
    }
    expect(await f.db.select().from(systemLog)).toEqual([]);
  });

  it('revalidates current authority, password, account owner and expiry at the actual SQL boundary', async () => {
    const before = await snapshot();
    await expect(f.service.create(ensureBody(), ensureActor(102))).rejects.toThrow('权限');
    await expect(f.service.list(query(), ensureActor(103))).rejects.toThrow('权限');
    await f.db.update(systemRole).set({ rules: 'user.view' }).where(eq(systemRole.id, 1));
    await expect(f.service.create(ensureBody(), ensureActor())).rejects.toThrow('权限');
    await f.db.update(systemAdmin).set({ pwd: 'changed' }).where(eq(systemAdmin.id, 102));
    await expect(f.service.list(query(), ensureActor(102))).rejects.toThrow('凭据');
    await f.db.update(systemAdmin).set({ adminType: 4, relationId: 20 }).where(eq(systemAdmin.id, 100));
    await expect(f.service.list(query(), ensureActor(100))).rejects.toThrow('身份');
    await expect(f.service.update(11, ensureBody(), { ...ensureActor(), expiresAt: 1 })).rejects.toThrow('过期');
    expect(await snapshot()).toEqual(before);
  });

  it('protects exact CSV and type-5 references and filters the actual product editor options on status changes', async () => {
    const product = new ProductAssociationService(f.container);
    expect((await product.editorOptions()).ensures.map(row => row.id)).toEqual([10, 12]);
    await f.db.insert(storeProduct).values({ id: 80, type: 2, relationId: 20, ensureId: '10', isDel: 1 });
    const before = await f.db.select().from(storeProduct);
    await f.service.update(10, ensureBody({ name: '引用保障编辑' }), ensureActor());
    await f.service.setStatus(10, 0, query(), ensureActor());
    expect((await product.editorOptions()).ensures.map(row => row.id)).toEqual([12]);
    expect(await f.db.select().from(storeProduct)).toEqual(before);
    await expect(f.service.remove(10, query(), ensureActor())).rejects.toThrow('商品使用');
    await f.db.update(storeProduct).set({ ensureId: '110' }).where(eq(storeProduct.id, 80));
    await f.service.remove(10, query(), ensureActor());
    await f.db.insert(storeProductRelation).values({ productId: 80, relationId: 11, type: 5 });
    await expect(f.service.remove(11, query(), ensureActor())).rejects.toThrow('商品使用');
  });

  it('rejects incomplete SQL write receipts and skipped audits for all four mutations with full rollback', async () => {
    const before = await snapshot();
    await f.exec("CREATE FUNCTION skip_ensure_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER skip_ensure_write BEFORE UPDATE ON store_product_ensure FOR EACH ROW EXECUTE FUNCTION skip_ensure_write()");
    await expect(f.service.update(11, ensureBody(), ensureActor())).rejects.toThrow();
    await expect(f.service.setStatus(11, 1, query(), ensureActor())).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    await f.exec('DROP TRIGGER skip_ensure_write ON store_product_ensure');
    await f.exec("CREATE FUNCTION skip_ensure_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER skip_ensure_audit BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION skip_ensure_audit()");
    await expect(f.service.create(ensureBody(), ensureActor())).rejects.toThrow('审计');
    await expect(f.service.update(11, ensureBody(), ensureActor())).rejects.toThrow('审计');
    await expect(f.service.setStatus(11, 1, query(), ensureActor())).rejects.toThrow('审计');
    await expect(f.service.remove(11, query(), ensureActor())).rejects.toThrow('审计');
    expect(await snapshot()).toEqual(before);
  });

  it('checks business rows again after audits and rolls back audit rewrites or deleted-row resurrection', async () => {
    const before = await snapshot();
    await f.exec("CREATE FUNCTION rewrite_ensure_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product_ensure SET \"desc\"='审计改写' WHERE id=(NEW.action::jsonb->>'id')::integer; RETURN NEW; END $$; CREATE TRIGGER rewrite_ensure_audit AFTER INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION rewrite_ensure_audit()");
    await expect(f.service.create(ensureBody(), ensureActor())).rejects.toThrow('审计');
    await expect(f.service.update(11, ensureBody(), ensureActor())).rejects.toThrow('审计');
    await expect(f.service.setStatus(11, 1, query(), ensureActor())).rejects.toThrow('审计');
    expect(await snapshot()).toEqual(before);
    await f.exec('DROP TRIGGER rewrite_ensure_audit ON system_log');
    await f.exec("CREATE FUNCTION resurrect_ensure_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO store_product_ensure(id,name,image) VALUES ((NEW.action::jsonb->>'id')::integer,'审计重建','https://shop.example/resurrect.png'); RETURN NEW; END $$; CREATE TRIGGER resurrect_ensure_audit AFTER INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION resurrect_ensure_audit()");
    await expect(f.service.remove(11, query(), ensureActor())).rejects.toThrow('审计');
    expect(await snapshot()).toEqual(before);
  });

  it('returns every enabled selector at 2000 rows and refuses overflow without truncating paginated parent lists', async () => {
    await f.exec("INSERT INTO store_product_ensure (id,name,image,status) SELECT 2000+n,'历史保障'||n,'https://shop.example/cap.png',1 FROM generate_series(1,1998) AS n");
    const all = await f.service.all(query(), ensureActor());
    expect(all).toHaveLength(2000); expect(all.map(row => row.id)).toContain(3998);
    await f.db.insert(storeProductEnsure).values({ id: 5000, name: '溢出保障', image: 'https://shop.example/overflow.png' });
    await expect(f.service.all(query(), ensureActor())).rejects.toThrow('2000');
    await expect(f.service.all(query(), ensureActor(), false)).rejects.toThrow('2000');
    const page = await f.service.list(new URLSearchParams('page=21&limit=100'), ensureActor());
    expect(page.count).toBe(2002); expect(page.list).toHaveLength(2);
    expect(await f.db.select().from(systemLog)).toEqual([]);
  });
});
