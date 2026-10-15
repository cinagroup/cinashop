import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Container, DbClient } from '../src/lib/di';
import { storeProduct, storeProductCategory, storeProductRelation, systemLog } from '../src/models/schema';
import {
  ProductAssociationService,
  type ProductLegacyMainValues,
  type ProductSaveTransactionContext,
} from '../src/services/product/ProductAssociationService';
import type { ProductSkuEditorPayload } from '../src/services/product/ProductSkuEditorService';

const mocks = vi.hoisted(() => ({ inventory: vi.fn(), sku: vi.fn() }));
vi.mock('../src/services/product/VirtualProductInventoryService', async original => ({
  ...await original<typeof import('../src/services/product/VirtualProductInventoryService')>(),
  tryLockVirtualProductInventory: mocks.inventory,
}));
vi.mock('../src/services/product/ProductSkuEditorService', async original => ({
  ...await original<typeof import('../src/services/product/ProductSkuEditorService')>(),
  replaceProductSkuEditor: mocks.sku,
}));

const NOW = 1_792_022_400;
const actor = { id: 1, name: 'editor', ip: '127.0.0.1' };
const dialect = new PgDialect();
type Product = typeof storeProduct.$inferSelect;
type Relation = typeof storeProductRelation.$inferSelect;
const product = (changes: Partial<Product> = {}): Product => ({
  id: 10, pid: 0, type: 0, relationId: 0, productType: 0, storeName: 'old', storeInfo: '', image: '',
  price: '2.00', otPrice: '3.00', vipPrice: '0.00', stock: 2, keyword: '', unitName: '件', sort: 0,
  isShow: 0, isVip: 0, isSupportRefund: 1, isDel: 0, isVerify: 0, cateId: '', brandId: 0, brandCom: '',
  storeLabelId: '', ensureId: '', specsId: 0, specs: '', sales: 77, ficti: 15, labelId: 'old-user-label',
  ...changes,
} as Product);
const relation = (changes: Partial<Relation> = {}): Relation => ({
  id: 30, type: 2, productId: 10, relationId: 909, relationPid: 12, status: 0, addTime: 123, ...changes,
});
const legacy = (changes: Partial<NonNullable<ProductSaveTransactionContext['legacy']>> = {}): ProductSaveTransactionContext => ({
  now: NOW, locks: 'already-held', audit: 'outer', legacy: {
    owner: { type: 0, relationId: 0 }, mainValues: {}, deliveryPolicy: 'legacy',
    allowHiddenDeleted: true, relationPolicy: 'preserve-empty', ...changes,
  },
});
const fullAssociations = { cate_id: [], brand_id: [], store_label_id: [], ensure_id: [], specs_id: 0, specs: [] };
const skuBody = (changes: Record<string, unknown> = {}) => ({
  spec_type: 0, items: [], attrs: [{ image: '/sku.png', price: '12.00', stock: 0 }], ...changes,
});

/** Small transaction double for primitive control-flow and exact preserved-row
 * checks. Native save tests separately prove SQL, isolation and rollback. */
function fixture(initial: Product | null = product(), rows: Relation[] = []) {
  let saved = initial ? structuredClone(initial) : undefined;
  let relations = structuredClone(rows);
  const audits: unknown[] = [];
  const writes: Record<string, unknown>[] = [];
  const predicates: Array<{ table: unknown; params: unknown[] }> = [];
  let afterProductWrite: (() => void) | undefined;
  const query = (read: () => unknown[]) => {
    const result = {
      where(condition: SQL) { predicates.push({ table: currentTable, params: dialect.sqlToQuery(condition).params }); return result; },
      limit() { return result; }, orderBy() { return result; }, for() { return result; },
      then(resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) {
        return Promise.resolve().then(read).then(resolve, reject);
      },
    };
    let currentTable: unknown;
    return { result, table(value: unknown) { currentTable = value; return result; } };
  };
  const db = {
    transaction: vi.fn(async (work: (tx: DbClient) => Promise<unknown>) => work(db as unknown as DbClient)),
    execute: vi.fn(async (query: SQL) => dialect.sqlToQuery(query).sql.includes('AS occupied') ? [{ occupied: false }] : [{ locked: true }]),
    select() {
      return { from(table: unknown) {
        return query(() => {
          if (table === storeProduct) return saved ? [structuredClone(saved)] : [];
          if (table === storeProductRelation) return structuredClone(relations).sort((a, b) => a.id - b.id);
          if (table === storeProductCategory) return [{ id: 11, pid: 7 }];
          throw new Error('Unexpected primitive selection');
        }).table(table);
      } };
    },
    update(table: unknown) {
      return { set(values: Record<string, unknown>) { return { where() {
        return { returning: async () => {
          if (table !== storeProduct || !saved) throw new Error('Unexpected primitive update');
          writes.push(structuredClone(values)); saved = { ...saved, ...values };
          afterProductWrite?.();
          return [{ id: saved.id }];
        } };
      } }; } };
    },
    insert(table: unknown) {
      return { values(input: Record<string, unknown> | Record<string, unknown>[]) {
        let written = false;
        const write = () => {
          if (written) return saved ? [{ id: saved.id }] : [];
          written = true;
          if (table === storeProduct) {
            const values = input as Record<string, unknown>; writes.push(structuredClone(values));
            saved = product({ id: 101, sales: 0, labelId: '', ...values });
            return [{ id: saved.id }];
          }
          if (table === storeProductRelation) {
            for (const row of input as Record<string, unknown>[]) relations.push({ id: 100 + relations.length, ...row } as Relation);
          } else if (table === systemLog) audits.push(structuredClone(input));
          else throw new Error('Unexpected primitive insert');
          return [];
        };
        return { returning: async () => write(), then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(write()).then(resolve) };
      } };
    },
    delete(table: unknown) { return { where(condition: SQL) {
      if (table !== storeProductRelation) throw new Error('Unexpected primitive delete');
      const [, ...types] = dialect.sqlToQuery(condition).params;
      relations = relations.filter(row => !types.includes(row.type));
      return Promise.resolve([]);
    } }; },
  };
  const container = { db } as unknown as Container;
  return { db, tx: db as unknown as DbClient, service: new ProductAssociationService(container), writes, audits, predicates,
    get saved() { return saved; }, get relations() { return relations; },
    afterWrite(work: () => void) { afterProductWrite = work; },
    mutateRelation(work: (row: Relation) => void) { if (relations[0]) work(relations[0]); },
  };
}

describe('product save trusted transaction primitive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inventory.mockResolvedValue(true);
    mocks.sku.mockImplementation(async (_tx, _product, payload: ProductSkuEditorPayload) =>
      payload.skus.map(row => ({ ...row, unique: 'SKU00001', sales: 0, sumStock: row.stock })));
  });

  it('uses the caller transaction and DB time, retaining protected historical fields and the sole outer audit', async () => {
    const f = fixture(product({ type: 2, relationId: 9, isDel: 1, isVerify: -1 }));
    const result = await f.service.saveInTransaction(f.tx, 10, { store_name: 'edited', is_show: 0, sort: 2_147_483_647 }, actor,
      legacy({ owner: { type: 2, relationId: 9 }, mainValues: {
        sliderImage: '["/image.png"]', autoOffTime: NOW + 100, isLimit: 1, limitType: 2, limitNum: 4,
        id: 99, sales: 999, pid: 88, isVerify: 1, labelId: 'injected', type: 0, relationId: 0,
      } as ProductLegacyMainValues }));
    expect(result).toEqual({ id: 10, associations_verified: false, sku_verified: false, assignedSkuRows: [] });
    expect(f.db.transaction).not.toHaveBeenCalled();
    expect(f.db.execute).not.toHaveBeenCalled();
    expect(f.audits).toEqual([]);
    expect(f.saved).toMatchObject({ id: 10, sales: 77, pid: 0, type: 2, relationId: 9, isVerify: -1, isDel: 1,
      labelId: 'old-user-label', storeName: 'edited', sort: 2_147_483_647, autoOffTime: NOW + 100, isLimit: 1, limitNum: 4 });
    for (const key of ['id', 'sales', 'pid', 'labelId', 'isVerify']) expect(f.writes[0]).not.toHaveProperty(key);
  });

  it('keeps modern wrapper response, sort limit, deleted admission and its original audit', async () => {
    const f = fixture();
    await expect(f.service.save(10, { store_name: 'modern' }, actor)).resolves.toEqual({
      id: 10, associations_verified: false, sku_verified: false,
    });
    expect(f.db.transaction).toHaveBeenCalledTimes(1);
    expect(f.audits).toHaveLength(1);
    await expect(f.service.save(10, { store_name: 'modern', sort: 1000 }, actor)).rejects.toThrow('排序格式错误');
    const deleted = fixture(product({ isDel: 1 }));
    await expect(deleted.service.save(10, { is_show: 0 }, actor)).rejects.toThrow('商品不存在');
  });

  it('requires an explicit trusted context for deleted edits and refuses publishing or changing a nonplatform owner', async () => {
    const f = fixture(product({ isDel: 1, type: 2, relationId: 9 }));
    await expect(f.service.saveInTransaction(f.tx, 10, { is_show: 1 }, actor,
      legacy({ owner: { type: 2, relationId: 9 } }))).rejects.toThrow('回收站商品不能上架');
    await expect(f.service.saveInTransaction(f.tx, 10, { is_show: 2, auto_on_time: NOW + 100 }, actor,
      legacy({ owner: { type: 2, relationId: 9 } }))).rejects.toThrow('上架状态格式错误');
    await expect(f.service.saveInTransaction(f.tx, 10, { is_show: 0 }, actor,
      legacy({ owner: { type: 2, relationId: 8 } }))).rejects.toThrow('已有商品归属不能修改');
    expect(f.writes).toEqual([]);
  });

  it('creates a supplier product with trusted defaults and sends its actual owner to stable SKU/ledger writes', async () => {
    const f = fixture(null);
    const result = await f.service.saveInTransaction(f.tx, 0, { ...fullAssociations, ...skuBody(),
      store_name: 'supplier', is_show: 0, ficti: 8 }, actor,
    legacy({ owner: { type: 2, relationId: 9 }, creation: { star: '5.0', spu: '1234567890123' },
      mainValues: { image: '/image.png', sliderImage: '["/image.png"]' } }));
    expect(f.saved).toMatchObject({ id: 101, type: 2, relationId: 9, isVerify: 0, sales: 0,
      star: '5.0', spu: '1234567890123', codePath: '', addTime: NOW, ficti: 8, price: '12.00' });
    expect(mocks.sku).toHaveBeenCalledWith(f.tx, expect.objectContaining({ id: 101, type: 2, relationId: 9 }), expect.anything(), NOW);
    expect(result.assignedSkuRows).toMatchObject([{ suk: '默认', unique: 'SKU00001', sumStock: 0 }]);
    expect(f.db.transaction).not.toHaveBeenCalled();
    expect(f.audits).toEqual([]);
  });

  it('uses separate trusted verification state on edits and refuses to read it from the body', async () => {
    const f = fixture(product({ type: 2, relationId: 9, isVerify: -1 }));
    await f.service.saveInTransaction(f.tx, 10, { is_show: 0, is_verify: 0 }, actor,
      legacy({ owner: { type: 2, relationId: 9 }, verifiedState: 1 }));
    expect(f.saved?.isVerify).toBe(1);
  });

  it('retains legacy type4 freight/template values while modern type4 keeps its established defaults', async () => {
    const initial = product({ productType: 4 });
    const f = fixture(initial);
    await f.service.saveInTransaction(f.tx, 10, { is_show: 0 }, actor,
      legacy({ mainValues: { deliveryType: '1,2', freight: 3, tempId: 12, postage: '0.00', isPostage: 1 } }));
    expect(f.saved).toMatchObject({ deliveryType: '1,2', freight: 3, tempId: 12, isPostage: 1 });
    const modern = fixture(initial);
    await modern.service.save(10, { is_show: 0 }, actor);
    expect(modern.saved).toMatchObject({ deliveryType: '2', freight: 1, tempId: 0, postage: '0.00', isPostage: 0 });
  });

  it('preserves complete empty-selected relation rows without copying stale IDs back to cleared main columns', async () => {
    const historical = [relation(), relation({ id: 31 })];
    const f = fixture(product({ brandId: 909, brandCom: '909' }), historical);
    await f.service.saveInTransaction(f.tx, 10, { ...fullAssociations, is_show: 0 }, actor, legacy());
    expect(f.saved).toMatchObject({ brandId: 0, brandCom: '' });
    expect(f.relations).toEqual(historical);
    const modern = fixture(product({ brandId: 909, brandCom: '909' }), historical);
    await modern.service.save(10, { ...fullAssociations, is_show: 0 }, actor);
    expect(modern.relations).toEqual([]);
  });

  it('rejects mutations to the retained relation full rows, beyond only checking selected IDs', async () => {
    const f = fixture(product(), [relation()]);
    f.afterWrite(() => f.mutateRelation(row => { row.addTime++; }));
    await expect(f.service.saveInTransaction(f.tx, 10, { ...fullAssociations, is_show: 0 }, actor, legacy()))
      .rejects.toThrow('商品关联资料数据库回读校验失败');
  });

  it('replaces only selected groups and validates new associations using the supplied supplier owner', async () => {
    const oldBrand = relation();
    const f = fixture(product(), [oldBrand, relation({ id: 31, type: 1, relationId: 99 })]);
    await f.service.saveInTransaction(f.tx, 10, { ...fullAssociations, cate_id: [11], is_show: 0 }, actor,
      legacy({ owner: { type: 2, relationId: 9 } }));
    expect(f.relations.find(row => row.id === oldBrand.id)).toEqual(oldBrand);
    expect(f.relations.filter(row => row.type === 1)).toMatchObject([{ relationId: 11, relationPid: 7, status: 0, addTime: NOW }]);
    expect(f.predicates.find(row => row.table === storeProductCategory)?.params).toEqual([11, 0, 0, 2, 9]);
  });

  it('takes newly assigned product and card-inventory TRY fences before any child SKU write', async () => {
    const f = fixture(null);
    mocks.inventory.mockResolvedValue(false);
    await expect(f.service.saveInTransaction(f.tx, 0, { ...fullAssociations, ...skuBody(),
      product_type: 1, store_name: 'card', is_show: 0 }, actor, legacy()))
      .rejects.toMatchObject({ httpStatus: 409 });
    expect(mocks.inventory).toHaveBeenCalledWith(f.tx, 101);
    expect(mocks.sku).not.toHaveBeenCalled();
  });
});
