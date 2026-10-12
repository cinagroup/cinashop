import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createBargainSelectionFixture } from "./helpers/bargainSelectionFixture";
import { outcome, waitForFinanceBlock, withFinancePeers, type FinancePeer } from "./helpers/financePeers";
import { createContainerFromDb, withTx } from "../src/lib/di";
import { reserveRefundQuantities } from "../src/services/order/RefundQuantityReservation";
import { StoreOrderCreateService, cancelStoreOrder, type CreateOrderParams } from "../src/services/order/StoreOrderCreateService";
import { finalizeStoreOrderRefund } from "../src/services/order/StoreOrderRefundService";
import { ActivityJoinService } from "../src/services/activity/ActivityJoinService";
import { retirePlatformSourceProduct } from "../src/services/activity/BargainSourceProductLifecycle";
import { SupplierProductManagementService } from "../src/services/supplier/SupplierProductManagementService";
import { storeCart, storeBargain, storeBargainUser, systemStore, storeOrderCartInfo, storeOrderStatus, printDocument,
  storeOrder, storeOrderRefund, storeOrderRefundPayment, storeOrderInvoice, userBrokerage, storeProduct,
  storeProductAttrValue, storeProductCategory, storeProductRelation, storeProductStockRecord } from "../src/models/schema";

// Only independent PG16 backends can prove these row-wait/conditional-update races.
// Never replace with PGlite concurrency or inherit production credentials.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("bargain order identity across independent PG16 backends", () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  const params: CreateOrderParams = { uid: 11, key: "bargain_race", cartIds: [10], type: 2, bargainUserId: 80,
    shippingType: 2, storeId: 1, realName: "隔离砍价并发", userPhone: "00000000000", userIp: "127.0.0.1" };
  beforeEach(async () => {
    f = await createBargainSelectionFixture([storeOrderCartInfo, storeOrderStatus, printDocument,
      storeOrderRefund, storeOrderRefundPayment, storeOrderInvoice, userBrokerage,
      storeProductCategory, storeProductRelation, storeProductStockRecord]);
    await f.db.update(systemStore).set({ isStore: 1 }).where(eq(systemStore.id, 1));
    await f.db.insert(storeCart).values([10, 11].map(id => ({ id, uid: 11, productId: 70,
      productAttrUnique: "qared001", cartNum: 1, type: 2, activityId: 40, isNew: 1, status: 1 })));
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  const create = (peer?: FinancePeer, input = params) => StoreOrderCreateService.createWithRuntime(
    peer ? createContainerFromDb(peer.db) : f.container,
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => `isolated_${input.key}` }, input);
  const cancel = (peer: FinancePeer, key = params.key) => cancelStoreOrder(createContainerFromDb(peer.db), { uid: 11, orderId: `isolated_${key}` });
  const snapshot = async () => {
    const value = await f.snapshot();
    return { ...value, sequences: undefined, carts: value.carts.sort((a, b) => a.id - b.id),
      skus: value.skus.sort((a, b) => a.id - b.id), users: value.users.sort((a, b) => a.uid - b.uid),
      orders: value.orders.sort((a, b) => a.id - b.id),
      details: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
      refunds: await f.db.select().from(storeOrderRefund).orderBy(storeOrderRefund.id),
      statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
      prints: await f.db.select().from(printDocument) };
  };
  const nextParams = { ...params, key: "next_bargain", cartIds: [11], bargainUserId: 90 };
  it("real checkout commits before supplier recycling without a cart/product lock inversion", async () => {
    await f.db.update(storeProduct).set({ type: 2, relationId: 7 }).where(eq(storeProduct.id, 70));
    await f.exec(`CREATE FUNCTION qa_supplier_checkout_cart_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id=10 AND NEW.is_pay=1 THEN PERFORM pg_advisory_xact_lock(731635,70); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_supplier_checkout_cart_gate AFTER UPDATE OF is_pay ON store_cart
      FOR EACH ROW EXECUTE FUNCTION qa_supplier_checkout_cart_gate()`);
    await withFinancePeers(f.db, async ([gate, buyer, retiring]) => {
      await gate.exec("BEGIN; SELECT pg_advisory_xact_lock(731635,70)");
      const purchase = outcome(create(buyer, { ...params, key: "supplier_checkout_first" }));
      await waitForFinanceBlock(f.db, buyer.pid, gate.pid);
      const retirement = outcome(new SupplierProductManagementService(createContainerFromDb(retiring.db)).recycleProduct(7, 70));
      await waitForFinanceBlock(f.db, retiring.pid, buyer.pid);
      await gate.exec("COMMIT");
      expect(await purchase).toMatchObject({ ok: true });
      expect(await retirement).toMatchObject({ ok: true });
    });
    const after = await snapshot();
    expect(after.orders).toHaveLength(1);
    expect(after.details).toHaveLength(1);
    expect(after.carts.find(row => row.id === 10)).toMatchObject({ isPay: 1, status: 0 });
    expect(after.carts.find(row => row.id === 11)).toMatchObject({ isPay: 0, status: 0 });
    expect(after.products.find(row => row.id === 70)).toMatchObject({ stock: 7, isDel: 1 });
    expect(after.skus.find(row => row.id === 1)).toMatchObject({ stock: 7, sales: 1 });
    expect(after.skus.find(row => row.id === 3)).toMatchObject({ stock: 6, quota: 5, sales: 1 });
    expect(after.bargains.find(row => row.id === 40)).toMatchObject({ stock: 7, quota: 7, sales: 1 });
    expect(after.participations.find(row => row.id === 80)?.status).toBe(4);
  }, 25_000);

  it("supplier recycling commits before a waiting real checkout and leaves no order writes", async () => {
    await f.db.update(storeProduct).set({ type: 2, relationId: 7 }).where(eq(storeProduct.id, 70));
    await f.exec(`CREATE FUNCTION qa_supplier_retire_product_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id=70 THEN PERFORM pg_advisory_xact_lock(731635,70); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_supplier_retire_product_gate AFTER UPDATE OF is_del ON store_product
      FOR EACH ROW EXECUTE FUNCTION qa_supplier_retire_product_gate()`);
    const before = await snapshot();
    await withFinancePeers(f.db, async ([gate, retiring, buyer]) => {
      await gate.exec("BEGIN; SELECT pg_advisory_xact_lock(731635,70)");
      const retirement = outcome(new SupplierProductManagementService(createContainerFromDb(retiring.db)).recycleProduct(7, 70));
      await waitForFinanceBlock(f.db, retiring.pid, gate.pid);
      const purchase = outcome(create(buyer, { ...params, key: "supplier_retire_first" }));
      await waitForFinanceBlock(f.db, buyer.pid, retiring.pid);
      await gate.exec("COMMIT");
      expect(await retirement).toMatchObject({ ok: true });
      expect(await purchase).toMatchObject({ ok: false, error: { message: expect.stringContaining("砍价购物车已变化或被占用") } });
    });
    const after = await snapshot();
    expect(after).toEqual({ ...before,
      carts: before.carts.map(row => row.productId === 70 ? { ...row, status: 0 } : row),
      products: before.products.map(row => row.id === 70 ? { ...row, isDel: 1, isShow: 0 } : row),
    });
    expect(after.products.find(row => row.id === 70)).toMatchObject({ stock: 8, isDel: 1 });
    expect(after.carts.find(row => row.id === 10)).toMatchObject({ isPay: 0, status: 0 });
  }, 25_000);

  it("rejects virtual bargain checkout when its source retires after the quote but before final inventory write", async () => {
    await f.db.update(storeProduct).set({ productType: 3 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeCart).set({ productType: 3, bargainUserId: 80 }).where(eq(storeCart.id, 10));
    await f.db.update(storeBargain).set({ deliveryType: "1" }).where(eq(storeBargain.id, 40));
    await f.exec(`CREATE FUNCTION qa_virtual_bargain_inventory_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id=1 THEN PERFORM pg_advisory_xact_lock(731635,70); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_virtual_bargain_inventory_wait AFTER UPDATE OF stock ON store_product_attr_value
      FOR EACH ROW EXECUTE FUNCTION qa_virtual_bargain_inventory_wait()`);
    const before = await snapshot();
    await withFinancePeers(f.db, async ([gate, buyer, retiring]) => {
      await gate.exec("BEGIN; SELECT pg_advisory_xact_lock(731635,70)");
      const buying = outcome(create(buyer, { ...params, key: "virtual_retired", shippingType: 1,
        storeId: 0, realName: undefined, userPhone: undefined }));
      await waitForFinanceBlock(f.db, buyer.pid, gate.pid);
      await expect(retirePlatformSourceProduct(createContainerFromDb(retiring.db), 70)).resolves.toBeUndefined();
      await gate.exec("COMMIT");
      expect(await buying).toMatchObject({ ok: false, error: { message: expect.stringContaining("砍价商品归属、上架状态已变化") } });
    });
    const after = await snapshot();
    expect(after.orders).toHaveLength(0);
    expect(after.carts).toEqual(before.carts);
    expect(after.skus).toEqual(before.skus);
    expect(after.bargains).toEqual(before.bargains);
    expect(after.products.find(product => product.id === 70)?.isDel).toBe(1);
  }, 25_000);

  it("rejects a shown but unreviewed bargain source before changing any order or inventory", async () => {
    await f.db.update(storeProduct).set({ isVerify: 0 }).where(eq(storeProduct.id, 70));
    const before = await snapshot();
    await expect(create()).rejects.toThrow("砍价基础商品未审核通过");
    expect(await snapshot()).toEqual(before);
  }, 15_000);

  it("rolls back checkout when source approval is removed after its quote but before the final product write", async () => {
    await f.exec(`CREATE FUNCTION qa_bargain_approval_final_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id=1 THEN PERFORM pg_advisory_xact_lock(731635,70); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_bargain_approval_final_wait AFTER UPDATE OF stock ON store_product_attr_value
      FOR EACH ROW EXECUTE FUNCTION qa_bargain_approval_final_wait()`);
    const before = await snapshot();
    await withFinancePeers(f.db, async ([gate, buyer, editor]) => {
      await gate.exec("BEGIN; SELECT pg_advisory_xact_lock(731635,70)");
      const buying = outcome(create(buyer, { ...params, key: "unreviewed_after_quote" }));
      await waitForFinanceBlock(f.db, buyer.pid, gate.pid);
      await editor.db.update(storeProduct).set({ isVerify: 0 }).where(eq(storeProduct.id, 70));
      await gate.exec("COMMIT");
      expect(await buying).toMatchObject({ ok: false,
        error: { message: expect.stringContaining("商品归属、上架状态已变化") } });
    });
    const after = await snapshot();
    expect(after.orders).toHaveLength(0);
    expect(after.carts).toEqual(before.carts);
    expect(after.skus).toEqual(before.skus);
    expect(after.bargains).toEqual(before.bargains);
    expect(after.products.find(product => product.id === 70)).toMatchObject({ isShow: 1, isVerify: 0, stock: 8 });
  }, 25_000);

  it("supplier hide owns the cart first, then a waiting checkout rejects without an order or stock change", async () => {
    await f.db.update(storeProduct).set({ type: 2, relationId: 7 }).where(eq(storeProduct.id, 70));
    await f.exec(`CREATE FUNCTION qa_supplier_hide_cart_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id=10 THEN PERFORM pg_advisory_xact_lock(731635,70); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_supplier_hide_cart_wait AFTER UPDATE OF status ON store_cart
      FOR EACH ROW EXECUTE FUNCTION qa_supplier_hide_cart_wait()`);
    const before = await snapshot();
    await withFinancePeers(f.db, async ([gate, hiding, buyer]) => {
      await gate.exec("BEGIN; SELECT pg_advisory_xact_lock(731635,70)");
      const hide = outcome(new SupplierProductManagementService(createContainerFromDb(hiding.db))
        .setProductShow(7, 70, 0));
      await waitForFinanceBlock(f.db, hiding.pid, gate.pid);
      const buying = outcome(create(buyer, { ...params, key: "supplier_hidden_cart" }));
      await waitForFinanceBlock(f.db, buyer.pid, hiding.pid);
      await gate.exec("COMMIT");
      const hidden = await hide;
      expect(hidden, hidden.ok ? '' : String(hidden.error)).toMatchObject({ ok: true });
      expect(await buying).toMatchObject({ ok: false });
    });
    const after = await snapshot();
    expect(after.orders).toHaveLength(0);
    expect(after.skus).toEqual(before.skus);
    expect(after.bargains).toEqual(before.bargains);
    expect(after.products.find(product => product.id === 70)).toMatchObject({ isShow: 0, stock: 8 });
    expect(after.carts.find(cart => cart.id === 10)).toMatchObject({ status: 0, isPay: 0 });
  }, 25_000);

  const supplierSaveBody = { product_type: 0, store_name: '成交后重新送审', cate_id: [12],
    slider_image: ['/api/qa/image.svg'], spec_type: 1,
    items: [{ value: '颜色', detail: ['红色', '蓝色'] },
      { value: '尺码', detail: ['大号', '小号'] }],
    attrs: [
      { suk: '红色,大号', detail: { 颜色: '红色', 尺码: '大号' }, unique: 'qared001',
        price: '10.00', settle_price: '5.00', stock: 7 },
      { suk: '红色,小号', detail: { 颜色: '红色', 尺码: '小号' }, unique: 'qaextra1',
        price: '10.00', settle_price: '5.00', stock: 1 },
      { suk: '蓝色,大号', detail: { 颜色: '蓝色', 尺码: '大号' }, unique: 'qaextra2',
        price: '20.00', settle_price: '10.00', stock: 1 },
      { suk: '蓝色,小号', detail: { 颜色: '蓝色', 尺码: '小号' }, unique: 'qablue01',
        price: '20.00', settle_price: '10.00', stock: 2 },
    ], freight: 1, is_postage: 1 };
  const prepareSupplierSave = async () => {
    await f.exec('CREATE UNIQUE INDEX qa_checkout_supplier_description ON store_product_description(product_id,type)');
    await f.db.insert(storeProductCategory).values({ id: 12, pid: 0, type: 2,
      relationId: 7, cateName: '隔离供应商分类', isShow: 1 });
    await f.db.insert(storeProductAttrValue).values([
      { id: 5, productId: 70, type: 0, unique: 'qaextra1', suk: '红色,小号', stock: 1, price: '10.00' },
      { id: 6, productId: 70, type: 0, unique: 'qaextra2', suk: '蓝色,大号', stock: 1, price: '20.00' },
    ]);
    await f.db.update(storeProduct).set({ stock: 12 }).where(eq(storeProduct.id, 70));
  };

  it('supplier save owns the cart first: a real checkout waits and rolls back', async () => {
    await f.db.update(storeProduct).set({ type: 2, relationId: 7, specType: 1 }).where(eq(storeProduct.id, 70));
    await prepareSupplierSave();
    await f.exec(`CREATE FUNCTION qa_supplier_save_checkout_hold() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id=10 THEN PERFORM pg_advisory_xact_lock(731635,70); END IF; RETURN NEW; END $$;
      CREATE TRIGGER qa_supplier_save_checkout_hold AFTER UPDATE OF status ON store_cart
      FOR EACH ROW EXECUTE FUNCTION qa_supplier_save_checkout_hold()`);
    await withFinancePeers(f.db, async ([gate, editor, buyer]) => {
      await gate.exec('BEGIN; SELECT pg_advisory_xact_lock(731635,70)');
      const editing = outcome(new SupplierProductManagementService(createContainerFromDb(editor.db))
        .saveProduct(7, 70, supplierSaveBody));
      await waitForFinanceBlock(f.db, editor.pid, gate.pid);
      const buying = outcome(create(buyer));
      await waitForFinanceBlock(f.db, buyer.pid, editor.pid);
      await gate.exec('COMMIT');
      const edited = await editing;
      expect(edited, edited.ok ? '' : String(edited.error)).toMatchObject({ ok: true });
      expect(await buying).toMatchObject({ ok: false });
    });
    const after = await snapshot();
    expect(after.orders).toHaveLength(0);
    expect(after.carts.find(cart => cart.id === 10)).toMatchObject({ isPay: 0, status: 0 });
    expect(after.skus.find(sku => sku.id === 1)).toMatchObject({ stock: 7, sales: 0 });
    expect(after.products.find(product => product.id === 70)).toMatchObject({
      isShow: 0, isVerify: 0, storeName: '成交后重新送审' });
  }, 25_000);

  it.each(['show', 'save'] as const)("checkout owns the cart first: supplier %s waits for its real order before hiding", async operation => {
    await f.db.update(storeProduct).set({ type: 2, relationId: 7, specType: 1 }).where(eq(storeProduct.id, 70));
    if (operation === 'save') await prepareSupplierSave();
    await withFinancePeers(f.db, async ([gate, buyer, editor]) => {
      await gate.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      const buying = outcome(create(buyer));
      await waitForFinanceBlock(f.db, buyer.pid, gate.pid);
      const supplier = new SupplierProductManagementService(createContainerFromDb(editor.db));
      const editing = outcome((async () => {
        if (operation === 'show') await supplier.setProductShow(7, 70, 0);
        else await supplier.saveProduct(7, 70, supplierSaveBody);
      })());
      await waitForFinanceBlock(f.db, editor.pid, buyer.pid);
      await gate.exec('COMMIT');
      const bought = await buying, edited = await editing;
      expect(bought, bought.ok ? '' : String(bought.error)).toMatchObject({ ok: true });
      expect(edited, edited.ok ? '' : String(edited.error)).toMatchObject({ ok: true });
    });
    const after = await snapshot();
    expect(after.orders).toHaveLength(1);
    expect(after.carts.find(cart => cart.id === 10)).toMatchObject({ isPay: 1, status: 0 });
    expect(after.skus.find(sku => sku.id === 1)).toMatchObject({ stock: 7, sales: 1 });
    expect(after.products.find(product => product.id === 70)).toMatchObject(operation === 'show'
      ? { isShow: 0, isVerify: 1 }
      : { isShow: 0, isVerify: 0, storeName: '成交后重新送审' });
  }, 25_000);
  const prepareSecond = async (paid: boolean) => {
    await create();
    if (paid) {
      // Synthetic payment, but a current checkout needs the actual durable
      // quantity claim and matching fulfillment identity before completion.
      await withTx(f.container, async tx => {
        const [order] = await tx.update(storeOrder).set({ paid: 1, payType: "yue" }).returning();
        const cartInfo = await reserveRefundQuantities(tx, order, [{ cartId: 10, cartNum: 1 }]);
        await tx.insert(storeOrderRefund).values({ id: 1, storeOrderId: order.id, uid: 11, orderId: "isolated_bargain_refund",
          storeId: order.storeId, supplierId: order.supplierId,
          applyType: 1, refundType: 0, refundPrice: "2.00", refundNum: 1, cartInfo });
      });
    }
    await f.db.insert(storeBargainUser).values({ id: 90, bargainId: 40, uid: 11,
      bargainPrice: "10.00", bargainPriceMin: "2.00", price: "8.00", status: 3 });
  };

  const cartEdits: Array<{ label: string; values: Partial<typeof storeCart.$inferInsert> }> = [
    { label: "quantity", values: { cartNum: 2 } },
    { label: "zero quantity", values: { cartNum: 0 } },
    { label: "negative quantity", values: { cartNum: -1 } },
    { label: "SKU", values: { productAttrUnique: "qablue01" } },
    { label: "product", values: { productId: 71 } },
    { label: "product type", values: { productType: 1 } },
    { label: "activity", values: { activityId: 41 } },
    { label: "cart type", values: { type: 0 } },
    { label: "cart mode", values: { isNew: 0 } },
    { label: "participation binding", values: { bargainUserId: 90 } },
  ];
  it.each(cartEdits)("re-evaluates $label after an observed cart row wait and refuses the stale quote", async ({ values }) => {
    const before = await snapshot();
    await withFinancePeers(f.db, async ([editor, buyer]) => {
      await editor.exec("BEGIN");
      await editor.db.update(storeCart).set(values).where(eq(storeCart.id, 10));
      // The buyer quotes the committed old version, then waits in UPDATE is_pay.
      const pending = outcome(create(buyer)); await waitForFinanceBlock(f.db, buyer.pid, editor.pid);
      await editor.exec("COMMIT");
      expect(await pending).toMatchObject({ ok: false, error: { message: expect.stringContaining("砍价购物车已变化或被占用") } });
    });
    expect(await snapshot()).toEqual({ ...before, carts: before.carts.map(row => row.id === 10 ? { ...row, ...values } : row) });
  }, 15_000);

  it.each(["rollback", "metadata"])("allows an unchanged quote after a verified %s cart edit wait", async mode => {
    await withFinancePeers(f.db, async ([editor, buyer]) => {
      await editor.exec("BEGIN");
      await editor.db.update(storeCart).set(mode === "rollback" ? { cartNum: 2 } : { addTime: 123 }).where(eq(storeCart.id, 10));
      const pending = outcome(create(buyer)); await waitForFinanceBlock(f.db, buyer.pid, editor.pid);
      await editor.exec(mode === "rollback" ? "ROLLBACK" : "COMMIT");
      expect(await pending).toMatchObject({ ok: true });
    });
    const state = await snapshot();
    expect(state.orders).toHaveLength(1);
    expect(state.orders[0]).toMatchObject({ totalNum: 1, payPrice: "2.00", activityId: 40 });
    expect(state.carts[0]).toMatchObject({ cartNum: 1, isPay: 1 });
    if (mode === "metadata") expect(state.carts[0].addTime).toBe(123);
    expect(state.participations.find(row => row.id === 80)?.status).toBe(4);
    expect(state.skus.find(row => row.id === 3)).toMatchObject({ stock: 6, quota: 5, sales: 1 });
  }, 15_000);

  it("two carts cannot consume one exact participation twice after an observed row wait", async () => {
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_bargain_user WHERE id=80 FOR UPDATE");
      const a = outcome(create(first)); await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      const b = outcome(create(second, { ...params, key: "bargain_other", cartIds: [11] }));
      await waitForFinanceBlock(f.db, second.pid, first.pid);
      await blocker.exec("COMMIT");
      expect(await a).toMatchObject({ ok: true }); expect(await b).toMatchObject({ ok: false });
    });
    const state = await snapshot(); expect(state.orders).toHaveLength(1); expect(state.details).toHaveLength(1);
    expect(JSON.parse(state.details[0].cartInfo!).bargainParticipation).toEqual({ version: 1, participantId: 80, activityId: 40, uid: 11 });
    expect(state.bargains[0]).toMatchObject({ stock: 7, quota: 7, sales: 1 });
    expect(state.carts.map(row => row.isPay)).toEqual([1, 0]);
    expect(state.participations.find(row => row.id === 80)?.status).toBe(4);
  }, 15_000);

  it("duplicate cancellation waits on the same order and restores the snapshot participation once", async () => {
    await create();
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_bargain_user WHERE id=80 FOR UPDATE");
      const a = outcome(cancel(first)); await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      const b = outcome(cancel(second)); await waitForFinanceBlock(f.db, second.pid, first.pid);
      await blocker.exec("COMMIT");
      expect(await a).toMatchObject({ ok: true }); expect(await b).toMatchObject({ ok: false });
    });
    const state = await snapshot(); expect(state.bargains[0]).toMatchObject({ stock: 8, quota: 8, sales: 0 });
    expect(state.participations.find(row => row.id === 80)?.status).toBe(3);
    expect(state.participations.find(row => row.id === 83)?.status).toBe(4);
    expect(state.statuses.filter(row => row.changeType === "cancel")).toHaveLength(1);
  }, 15_000);

  it("participant ownership changed during cancellation wait causes a full compensation rollback", async () => {
    await create(); const before = await snapshot();
    await withFinancePeers(f.db, async ([blocker, canceller]) => {
      await blocker.exec("BEGIN; UPDATE store_bargain_user SET uid=22 WHERE id=80");
      const pending = outcome(cancel(canceller)); await waitForFinanceBlock(f.db, canceller.pid, blocker.pid);
      await blocker.exec("COMMIT");
      expect(await pending).toMatchObject({ ok: false, error: { message: expect.stringContaining("状态无法恢复") } });
    });
    const after = await snapshot();
    expect(after).toEqual({ ...before, participations: before.participations.map(row => row.id === 80 ? { ...row, uid: 22 } : row) });
    expect((await f.db.select().from(storeBargainUser).where(eq(storeBargainUser.id, 80)))[0].status).toBe(4);
  }, 15_000);

  it.each(["cancel", "refund"])("%s waits before SKU writes while same-activity creation holds a cart barrier", async operation => {
    await prepareSecond(operation === "refund");
    await withFinancePeers(f.db, async ([blocker, buyer, restorer]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_cart WHERE id=11 FOR UPDATE");
      const pending = outcome(create(buyer, nextParams)); await waitForFinanceBlock(f.db, buyer.pid, blocker.pid);
      const restoration = operation === "cancel" ? outcome(cancel(restorer))
        : outcome(finalizeStoreOrderRefund(createContainerFromDb(restorer.db), 1));
      await waitForFinanceBlock(f.db, restorer.pid, buyer.pid);
      await blocker.exec("COMMIT");
      expect(await pending).toMatchObject({ ok: true }); expect(await restoration).toMatchObject({ ok: true });
    });
    const state = await snapshot(); expect(state.orders).toHaveLength(2);
    expect(state.bargains[0]).toMatchObject({ stock: 7, quota: 7, sales: 1 });
    expect(state.products[0]).toMatchObject({ stock: 7, sales: 1 });
    expect(state.skus.find(row => row.id === 3)).toMatchObject({ stock: 6, quota: 5, sales: 1 });
    expect(state.participations.find(row => row.id === 80)?.status).toBe(operation === "cancel" ? 3 : 4);
    expect(state.participations.find(row => row.id === 90)?.status).toBe(4);
  }, 15_000);

  it("refund does not lock settlement users while waiting behind a cancellation's activity lock", async () => {
    await prepareSecond(true); await create(undefined, nextParams);
    await withFinancePeers(f.db, async ([blocker, canceller, refunder]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE");
      const pending = outcome(cancel(canceller, nextParams.key)); await waitForFinanceBlock(f.db, canceller.pid, blocker.pid);
      const restoration = outcome(finalizeStoreOrderRefund(createContainerFromDb(refunder.db), 1));
      await waitForFinanceBlock(f.db, refunder.pid, canceller.pid);
      await f.exec('SELECT uid FROM "user" WHERE uid=11 FOR UPDATE NOWAIT');
      await blocker.exec("COMMIT");
      expect(await pending).toMatchObject({ ok: true }); expect(await restoration).toEqual({ ok: true, value: "completed" });
    });
    const state = await snapshot();
    expect(state.bargains[0]).toMatchObject({ stock: 8, quota: 8, sales: 0 });
    expect(state.products[0]).toMatchObject({ stock: 8, sales: 0 });
    expect(state.skus.find(row => row.id === 3)).toMatchObject({ stock: 7, quota: 6, sales: 0 });
    expect(state.users.find(row => row.uid === 11)?.nowMoney).toBe("2.00");
  }, 15_000);

  it.each(["participant", "activity SKU", "base SKU"])("expiry during %s lock wait rolls back the entire actual create transaction", async target => {
    const before = await snapshot();
    let deadline: Date | undefined;
    await withFinancePeers(f.db, async ([blocker, buyer]) => {
      await blocker.exec(target === "participant" ? "BEGIN; SELECT id FROM store_bargain_user WHERE id=80 FOR UPDATE"
        : target === "activity SKU" ? "BEGIN; SELECT id FROM store_product_attr_value WHERE id=3 FOR UPDATE"
        : "BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE");
      // Arm the deadline only after snapshots, peer connections and the row
      // barrier are ready. Use the actual server clock, not a mocked clock or
      // the runner's wall clock. Leave headroom below the unchanged 2s lock cap.
      const [armed] = await f.db.update(storeBargain).set({ stopTime:
        sql`date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') + interval '1 second'`,
      }).where(eq(storeBargain.id, 40)).returning({ stopTime: storeBargain.stopTime });
      expect(armed.stopTime).toBeInstanceOf(Date);
      deadline = armed.stopTime!;
      const deadlineMs = deadline.getTime();
      expect(Number.isSafeInteger(deadlineMs)).toBe(true);
      const pending = outcome(create(buyer)); await waitForFinanceBlock(f.db, buyer.pid, blocker.pid);
      const [wait] = await f.db.select({ beforeExpiry: sql<boolean>`query_start < to_timestamp(${deadlineMs}::double precision / 1000)`,
        waiting: sql<boolean>`wait_event_type = 'Lock'`,
      }).from(sql`pg_catalog.pg_stat_activity`).where(sql`pid = ${buyer.pid}`);
      expect(wait).toEqual({ beforeExpiry: true, waiting: true });
      // Sleep and commit in one server request: JS scheduling after observing
      // expiry must not extend the held row lock into the application's cap.
      await blocker.exec(`SELECT pg_sleep(GREATEST(0,
        (${deadlineMs}::double precision / 1000 - extract(epoch FROM clock_timestamp())) + 0.01)); COMMIT`);
      expect(await pending).toMatchObject({ ok: false, error: { message: expect.stringContaining("砍价活动已结束") } });
    });
    expect(await snapshot()).toEqual({ ...before,
      bargains: before.bargains.map(row => row.id === 40 ? { ...row, stopTime: deadline } : row),
    });
  }, 15_000);

  it("actual help can acquire KEY SHARE while checkout owns NO KEY UPDATE", async () => {
    await withFinancePeers(f.db, async ([blocker, buyer, helper]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_cart WHERE id=10 FOR UPDATE");
      const pending = outcome(create(buyer)); await waitForFinanceBlock(f.db, buyer.pid, blocker.pid);
      // A FOR UPDATE activity lock would block this real help transaction until
      // the buyer released its cart barrier. KEY SHARE compatibility must work.
      const helped = await new ActivityJoinService(createContainerFromDb(helper.db)).helpBargain(22, 81);
      expect(Number(helped.price)).toBeGreaterThan(0);
      await blocker.exec("COMMIT"); expect(await pending).toMatchObject({ ok: true });
    });
    expect((await snapshot()).helps).toHaveLength(1);
  }, 15_000);

  it("start waits for consumed participation and then permits the next legitimate participation", async () => {
    await withFinancePeers(f.db, async ([blocker, buyer, starter]) => {
      await blocker.exec("BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE");
      const pending = outcome(create(buyer)); await waitForFinanceBlock(f.db, buyer.pid, blocker.pid);
      const started = outcome(new ActivityJoinService(createContainerFromDb(starter.db)).startBargain(11, 40));
      await waitForFinanceBlock(f.db, starter.pid, buyer.pid); await blocker.exec("COMMIT");
      expect(await pending).toMatchObject({ ok: true }); const result = await started;
      expect(result).toMatchObject({ ok: true }); if (!result.ok) throw result.error;
      expect(result.value.id).not.toBe(80);
      expect((await snapshot()).participations.find(row => row.id === result.value.id)).toMatchObject({ uid: 11, bargainId: 40, status: 1 });
    });
  }, 15_000);
});
