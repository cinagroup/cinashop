import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { ActivityJoinService } from '../src/services/activity/ActivityJoinService';
import { SupplierProductManagementService } from '../src/services/supplier/SupplierProductManagementService';
import { storeBargain, storeBargainUser, storeCart, storeProduct, storeProductAttrResult,
  storeProductAttrValue, storeProductCategory, storeProductRelation, user } from '../src/models/schema';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

// Only the fixture-owned loopback PG16 service can prove these commit orders.
// Each barrier is an observed pg_blocking_pids edge between independent backends.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('supplier visibility and bargain admission on PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;

  beforeEach(async () => {
    f = await createBargainSelectionFixture([storeProductRelation, storeProductCategory, storeProductAttrResult]);
    await f.db.update(storeProduct).set({ type: 2, relationId: 7, isShow: 1, isVerify: 1 })
      .where(eq(storeProduct.id, 70));
    await f.db.update(storeBargain).set({ people: 1 }).where(eq(storeBargain.id, 40));
    await f.db.update(storeBargainUser).set({ price: '0.00', status: 1 }).where(eq(storeBargainUser.id, 81));
    await f.db.insert(user).values({ uid: 30, account: 'visibility-new-owner', nickname: '可见性新参与者' });
  }, 30_000);

  afterEach(async () => { await f?.close(); });

  const state = async () => {
    const snapshot = await f.snapshot();
    return { product: snapshot.products.find(row => row.id === 70),
      participations: snapshot.participations, helps: snapshot.helps };
  };
  const hide = (db = f.db) => new SupplierProductManagementService(createContainerFromDb(db)).setProductShow(7, 70, 0);
  const start = (db = f.db) => new ActivityJoinService(createContainerFromDb(db)).startBargain(30, 40);
  const help = (db = f.db) => new ActivityJoinService(createContainerFromDb(db)).helpBargain(11, 81);
  const supplierSaveBody = {
    product_type: 0, store_name: '供应商重新送审商品', cate_id: [12],
    slider_image: ['/api/qa/image.svg'], spec_type: 1,
    items: [{ value: '颜色', detail: ['红色', '蓝色'] }],
    attrs: [
      { suk: '红色', detail: { 颜色: '红色' }, unique: 'qared001', price: '10.00', settle_price: '5.00', stock: 8 },
      { suk: '蓝色', detail: { 颜色: '蓝色' }, unique: 'qablue01', price: '20.00', settle_price: '10.00', stock: 2 },
    ],
    freight: 1, is_postage: 1,
  };
  const prepareSave = async () => {
    // The lightweight column fixture omits indexes; saveProduct's upsert
    // needs this live uniqueness authority just like the real schema.
    await f.exec('CREATE UNIQUE INDEX qa_product_description_owner ON store_product_description(product_id,type)');
    await f.db.insert(storeProductCategory).values({ id: 12, pid: 0, type: 2,
      relationId: 7, cateName: '隔离供应商分类', isShow: 1 });
    await f.db.update(storeProduct).set({ specType: 1 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ suk: '红色' }).where(eq(storeProductAttrValue.id, 1));
    await f.db.update(storeProductAttrValue).set({ suk: '蓝色' }).where(eq(storeProductAttrValue.id, 2));
  };
  const save = (db = f.db) => new SupplierProductManagementService(createContainerFromDb(db))
    .saveProduct(7, 70, supplierSaveBody);
  const cart = async () => {
    await f.db.insert(storeCart).values({ id: 10, uid: 11, productId: 70,
      productAttrUnique: 'qared001', cartNum: 1, type: 2, activityId: 40,
      bargainUserId: 80, isNew: 1, status: 1 });
  };

  it('hide commits first: a real start waits and rejects the newly hidden source', async () => {
    const before = await f.snapshot();
    await f.exec(`CREATE FUNCTION qa_hide_before_start_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id=70 THEN PERFORM pg_advisory_xact_lock(731635,70); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_hide_before_start_wait AFTER UPDATE OF is_show ON store_product
      FOR EACH ROW EXECUTE FUNCTION qa_hide_before_start_wait()`);
    await withFinancePeers(f.db, async ([gate, hiding, starting]) => {
      await gate.exec('BEGIN; SELECT pg_advisory_xact_lock(731635,70)');
      const pendingHide = outcome(hide(hiding.db));
      await waitForFinanceBlock(f.db, hiding.pid, gate.pid);
      const pendingStart = outcome(start(starting.db));
      await waitForFinanceBlock(f.db, starting.pid, hiding.pid);
      await gate.exec('COMMIT');
      expect(await pendingHide).toMatchObject({ ok: true });
      expect(await pendingStart).toMatchObject({ ok: false, error: { message: '砍价关联商品不可见或未审核' } });
    });
    const after = await f.snapshot();
    expect(after).toEqual({ ...before, products: before.products.map(product =>
      product.id === 70 ? { ...product, isShow: 0 } : product),
    });
  }, 15_000);

  it('hide commits first: a real help waits and leaves the participation unchanged', async () => {
    await f.exec(`CREATE FUNCTION qa_hide_before_help_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id=70 THEN PERFORM pg_advisory_xact_lock(731635,70); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_hide_before_help_wait AFTER UPDATE OF is_show ON store_product
      FOR EACH ROW EXECUTE FUNCTION qa_hide_before_help_wait()`);
    const before = await f.snapshot();
    await withFinancePeers(f.db, async ([gate, hiding, helping]) => {
      await gate.exec('BEGIN; SELECT pg_advisory_xact_lock(731635,70)');
      const pendingHide = outcome(hide(hiding.db));
      await waitForFinanceBlock(f.db, hiding.pid, gate.pid);
      const pendingHelp = outcome(help(helping.db));
      await waitForFinanceBlock(f.db, helping.pid, hiding.pid);
      await gate.exec('COMMIT');
      expect(await pendingHide).toMatchObject({ ok: true });
      expect(await pendingHelp).toMatchObject({ ok: false, error: { message: '砍价关联商品不可见或未审核' } });
    });
    const after = await f.snapshot();
    expect(after).toEqual({ ...before, products: before.products.map(product =>
      product.id === 70 ? { ...product, isShow: 0 } : product),
    });
  }, 15_000);

  it('start commits first: supplier hide waits for the real start and then hides the product', async () => {
    await f.exec(`CREATE FUNCTION qa_start_before_hide_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.uid=30 THEN PERFORM pg_advisory_xact_lock(731635,70); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_start_before_hide_wait AFTER INSERT ON store_bargain_user
      FOR EACH ROW EXECUTE FUNCTION qa_start_before_hide_wait()`);
    await withFinancePeers(f.db, async ([gate, starting, hiding]) => {
      await gate.exec('BEGIN; SELECT pg_advisory_xact_lock(731635,70)');
      const pendingStart = outcome(start(starting.db));
      await waitForFinanceBlock(f.db, starting.pid, gate.pid);
      const pendingHide = outcome(hide(hiding.db));
      await waitForFinanceBlock(f.db, hiding.pid, starting.pid);
      await gate.exec('COMMIT');
      expect(await pendingStart).toMatchObject({ ok: true, value: { id: expect.any(Number) } });
      expect(await pendingHide).toMatchObject({ ok: true });
    });
    const after = await state();
    expect(after.product).toMatchObject({ isShow: 0, isVerify: 1 });
    expect(after.participations.filter(row => row.uid === 30)).toMatchObject([
      { uid: 30, bargainId: 40, status: 1 },
    ]);
    expect(after.helps).toHaveLength(0);
  }, 15_000);

  it('help commits first: supplier hide waits for the real help and retains its history', async () => {
    await f.exec(`CREATE FUNCTION qa_help_before_hide_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.bargain_user_id=81 THEN PERFORM pg_advisory_xact_lock(731635,70); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_help_before_hide_wait AFTER INSERT ON store_bargain_user_help
      FOR EACH ROW EXECUTE FUNCTION qa_help_before_hide_wait()`);
    await withFinancePeers(f.db, async ([gate, helping, hiding]) => {
      await gate.exec('BEGIN; SELECT pg_advisory_xact_lock(731635,70)');
      const pendingHelp = outcome(help(helping.db));
      await waitForFinanceBlock(f.db, helping.pid, gate.pid);
      const pendingHide = outcome(hide(hiding.db));
      await waitForFinanceBlock(f.db, hiding.pid, helping.pid);
      await gate.exec('COMMIT');
      expect(await pendingHelp).toMatchObject({ ok: true, value: { price: '8.00' } });
      expect(await pendingHide).toMatchObject({ ok: true });
    });
    const after = await state();
    expect(after.product).toMatchObject({ isShow: 0, isVerify: 1 });
    expect(after.helps.filter(row => row.bargainUserId === 81)).toMatchObject([
      { uid: 11, bargainId: 40, bargainUserId: 81, price: '8.00' },
    ]);
    expect(after.participations.find(row => row.id === 81)).toMatchObject({ price: '8.00', status: 3 });
    await expect(start()).rejects.toThrow('砍价关联商品不可见或未审核');
  }, 15_000);

  it.each(['show', 'save'] as const)('%s waits on a checkout-owned cart before taking the product row', async operation => {
    await cart();
    if (operation === 'save') await prepareSave();
    await withFinancePeers(f.db, async ([checkout, editing]) => {
      await checkout.exec('BEGIN');
      await checkout.db.update(storeCart).set({ isPay: 1 }).where(eq(storeCart.id, 10));
      const pending = outcome((async () => {
        if (operation === 'show') await hide(editing.db);
        else await save(editing.db);
      })());
      await waitForFinanceBlock(f.db, editing.pid, checkout.pid);
      // The checkout can write the source row while it owns the cart. A
      // product-before-cart editor would create the inverse wait here.
      const updated = await checkout.db.update(storeProduct).set({ stock: sql`stock - 1` })
        .where(and(eq(storeProduct.id, 70), eq(storeProduct.isShow, 1), eq(storeProduct.isVerify, 1)))
        .returning({ id: storeProduct.id });
      expect(updated).toEqual([{ id: 70 }]);
      await checkout.exec('COMMIT');
      const result = await pending;
      expect(result, result.ok ? '' : String(result.error)).toMatchObject({ ok: true });
    });
    const after = await f.snapshot();
    expect(after.products.find(row => row.id === 70)).toMatchObject(operation === 'show'
      ? { isShow: 0, isVerify: 1, stock: 7 }
      : { isShow: 0, isVerify: 0, storeName: '供应商重新送审商品' });
    expect(after.carts.find(row => row.id === 10)).toMatchObject({ isPay: 1, status: 0 });
  }, 20_000);

  it('supplier save commits first: a real start waits and rejects its newly unreviewed source', async () => {
    await prepareSave();
    await f.exec(`CREATE FUNCTION qa_save_before_start_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id=70 THEN PERFORM pg_advisory_xact_lock(731635,70); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_save_before_start_wait AFTER UPDATE OF is_verify ON store_product
      FOR EACH ROW EXECUTE FUNCTION qa_save_before_start_wait()`);
    const before = await state();
    await withFinancePeers(f.db, async ([gate, saving, starting]) => {
      await gate.exec('BEGIN; SELECT pg_advisory_xact_lock(731635,70)');
      const pendingSave = outcome(save(saving.db));
      await waitForFinanceBlock(f.db, saving.pid, gate.pid);
      const pendingStart = outcome(start(starting.db));
      await waitForFinanceBlock(f.db, starting.pid, saving.pid);
      await gate.exec('COMMIT');
      const saved = await pendingSave;
      expect(saved, saved.ok ? '' : String(saved.error)).toMatchObject({ ok: true });
      expect(await pendingStart).toMatchObject({ ok: false, error: { message: '砍价关联商品不可见或未审核' } });
    });
    const after = await state();
    expect(after.participations).toEqual(before.participations);
    expect(after.helps).toEqual(before.helps);
    expect(after.product).toMatchObject({ isShow: 0, isVerify: 0 });
  }, 20_000);

  it('help commits first: supplier save waits and retains its completed participation history', async () => {
    await prepareSave();
    await f.exec(`CREATE FUNCTION qa_help_before_save_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.bargain_user_id=81 THEN PERFORM pg_advisory_xact_lock(731635,70); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_help_before_save_wait AFTER INSERT ON store_bargain_user_help
      FOR EACH ROW EXECUTE FUNCTION qa_help_before_save_wait()`);
    await withFinancePeers(f.db, async ([gate, helping, saving]) => {
      await gate.exec('BEGIN; SELECT pg_advisory_xact_lock(731635,70)');
      const pendingHelp = outcome(help(helping.db));
      await waitForFinanceBlock(f.db, helping.pid, gate.pid);
      const pendingSave = outcome(save(saving.db));
      await waitForFinanceBlock(f.db, saving.pid, helping.pid);
      await gate.exec('COMMIT');
      expect(await pendingHelp).toMatchObject({ ok: true });
      const saved = await pendingSave;
      expect(saved, saved.ok ? '' : String(saved.error)).toMatchObject({ ok: true });
    });
    const after = await state();
    expect(after.product).toMatchObject({ isShow: 0, isVerify: 0 });
    expect(after.helps.filter(row => row.bargainUserId === 81)).toHaveLength(1);
    expect(after.participations.find(row => row.id === 81)).toMatchObject({ status: 3 });
  }, 20_000);
});
