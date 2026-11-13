import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { installSupplierOrderEditOperation } from '@/migrations/supplierOrderEditOperation';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeOrder, storeOrderCartInfo, storeOrderStatus, storeOrderOutbox, systemNotification, systemMessage, orderNotificationDelivery } from '@/models/schema';
import { withPriceScenario } from './helpers/adminOrderPrice';
import { createContainerFromDb, withTx } from '@/lib/di';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { supplierOrderPriceRevisionIsActive } from '@/services/supplier/SupplierUnpaidOrderEditEffects';
import { withRemarkScenario } from './helpers/adminOrderRemark';

const path = '/api/admin/order/price';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Admin unpaid price through actual JWT and native LOGINs', () => {
  it.each(['order', 'deferred'] as const)('rolls back the complete price operation after %s tampering', async target => withPriceScenario(async s => {
    await s.seed();
    await s.f.db.update(storeOrder).set({ payPrice: '10.00', totalPrice: '10.00' }).where(eq(storeOrder.id, 820001));
    const before = await s.snapshot();
    await s.f.exec(target === 'order' ? `
      CREATE FUNCTION price_acceptance_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
        UPDATE store_order SET pay_price=9.00 WHERE id=NEW.oid; RETURN NEW; END$$;
      CREATE TRIGGER price_acceptance_tamper AFTER INSERT ON store_order_status
        FOR EACH ROW EXECUTE FUNCTION price_acceptance_tamper();
    ` : `
      CREATE FUNCTION price_acceptance_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
        DELETE FROM store_order_status WHERE id=NEW.id; RETURN NEW; END$$;
      CREATE CONSTRAINT TRIGGER price_acceptance_tamper AFTER INSERT ON store_order_status
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION price_acceptance_tamper();
    `);
    const result = await s.request('POST', '/api/admin/order/price', { order_id: 'owned-remark-order', price: '7.00' });
    expect(result.status, result.msg).toBe(409);
    expect(await s.snapshot()).toEqual(before);
  }), 120000);

  it('keeps both complete runtime profiles ready and rejects an extra App append grant without repair',async()=>withPriceScenario(async s=>{
    const names={...s.roles,maintenance:'finance_test'};
    for(const kind of ['app','admin'] as const)expect(await auditRuntimeBusinessPrivileges(s.databases[kind],kind,names)).toMatchObject({ready:true,failures:[]});
    await s.f.exec(`GRANT INSERT ON public.admin_order_price_operation_v1 TO "${s.roles.app}"`);
    expect((await auditRuntimeBusinessPrivileges(s.databases.app,'app',names)).ready).toBe(false);
    expect(await s.f.exec(`SELECT has_table_privilege('${s.roles.app}','public.admin_order_price_operation_v1','INSERT') AS writable`)).toEqual([{writable:true}]);
    await s.f.exec(`REVOKE INSERT ON public.admin_order_price_operation_v1 FROM "${s.roles.app}"`);
    expect(await auditRuntimeBusinessPrivileges(s.databases.app,'app',names)).toMatchObject({ready:true,failures:[]});
  }),120000);

  it('reports missing Supplier ancestry SELECT in the complete read-only audit without aborting or repairing it',async()=>withPriceScenario(async s=>{
    await withTx(createContainerFromDb(s.f.db),tx=>installSupplierOrderEditOperation(tx));
    const names={...s.roles,maintenance:'finance_test'};
    for(const kind of ['app','admin'] as const){
      const missing=await auditRuntimeBusinessPrivileges(s.databases[kind],kind,names);
      expect(missing.ready).toBe(false);expect(missing.failures).toContain('admin_order_price_operation_catalog');
    }
    expect(await s.f.exec(`SELECT has_table_privilege('${s.roles.app}','public.supplier_order_edit_operation_v1','SELECT') AS readable`)).toEqual([{readable:false}]);
    await s.f.exec(`GRANT SELECT ON public.supplier_order_edit_operation_v1 TO "${s.roles.app}","${s.roles.admin}"`);
    for(const kind of ['app','admin'] as const)expect(await auditRuntimeBusinessPrivileges(s.databases[kind],kind,names)).toMatchObject({ready:true,failures:[]});
  }),120000);

  it('preserves every other field and large historical cart bytes through repeated absolute prices and exact no-op retries', async () => withPriceScenario(async s => {
    await s.seed();
    const large = '历'.repeat(90000);
    await s.f.db.update(storeOrder).set({ payPrice: '10.00', totalPrice: '12.00', payPostage: '2.00', gainIntegral: '-0.50',
      cartId: large, customForm: large, expressDump: large, virtualInfo: large, promotionsGive: large, giveCoupon: large, refundReasonWapImg: large }).where(eq(storeOrder.id, 820001));
    await s.f.db.insert(storeOrderCartInfo).values({ oid: 820001, uid: 11, productId: 70, cartId: 'historical-cart', cartNum: 1, cartInfo: large });
    const original = (await s.f.db.select().from(storeOrder).where(eq(storeOrder.id, 820001)))[0];
    const carts = await s.f.db.select().from(storeOrderCartInfo);
    for (const [price, change] of [['7.00', '3.00'], ['12.00', '-2.00'], ['0.00', '10.00']]) {
      const result = await s.request('POST', path, { order_id: original.orderId, price, paid: 1, gain_integral: '999', admin_id: 999 }, s.token('manager'));
      expect(result.status, result.msg).toBe(200); expect(result.data).toBeNull(); expect(result.headers.get('cache-control')).toContain('no-store');
      expect((await s.f.db.select().from(storeOrder).where(eq(storeOrder.id, original.id)))[0]).toEqual({ ...original, payPrice: price, changePrice: change });
      expect(await s.f.db.select().from(storeOrderCartInfo)).toEqual(carts);
      const before = await s.snapshot(), sequence = await s.f.exec('SELECT last_value,is_called FROM store_order_status_id_seq');
      expect((await s.request('POST', path, { order_id: original.orderId, price }, s.token('manager'))).status).toBe(200);
      expect(await s.snapshot()).toEqual(before); expect(await s.f.exec('SELECT last_value,is_called FROM store_order_status_id_seq')).toEqual(sequence);
    }
    const receipts = await s.f.exec('SELECT actor_id,supplier_id,state FROM public.admin_order_price_operation_v1 ORDER BY created_at,operation_id');
    expect(receipts).toEqual(Array.from({ length: 3 }, () => ({ actor_id: 102, supplier_id: 0, state: 'committed' })));
    expect(await s.f.db.select().from(storeOrderStatus)).toHaveLength(3);
    expect(await s.f.exec("SELECT count(*)::integer AS n FROM store_order_outbox WHERE event_type='order.price.revision'")).toEqual([{ n: 3 }]);
  }), 120000);

  it('keeps numeric order numbers separate from primary IDs', async () => withPriceScenario(async s => {
    await s.seed(820001, '820002'); await s.seed(820002, 'other-number');
    expect((await s.request('POST', path, { order_id: '820002', price: '1.00', id: 820002 })).status).toBe(200);
    const rows = await s.f.db.select().from(storeOrder).orderBy(storeOrder.id);
    expect(rows.find(row => row.id === 820001)?.payPrice).toBe('1.00'); expect(rows.find(row => row.id === 820002)?.payPrice).toBe('0.00');
  }), 120000);

  it('denies anonymous read-only disabled and Supplier identities on the private endpoint without writes', async () => withPriceScenario(async s => {
    await s.seed(); const before = await s.snapshot();
    for (const token of [null, s.token('viewer'), s.token('disabled'), s.token('supplier')]) {
      const result = await s.request('POST', path, { order_id: 'owned-remark-order', price: '1.00', admin_id: 101 }, token);
      expect(result.status).not.toBe(200); expect(result.status).not.toBe(500); expect(result.headers.get('cache-control')).toContain('private');
      expect(await s.snapshot()).toEqual(before);
    }
  }), 120000);

  it('rejects malformed prices and oversized JSON before business and audit sequence writes', async () => withPriceScenario(async s => {
    await s.seed(); const before = await s.snapshot(), sequence = await s.f.exec('SELECT last_value,is_called FROM store_order_status_id_seq');
    for (const price of [undefined, null, false, [], {}, '', '-1', '1e3', '1.001', 1.005, '10000000000.00']) {
      const result = await s.request('POST', path, { order_id: 'owned-remark-order', price }); expect(result.status, result.msg).toBe(400);
    }
    for (const body of ['{broken', '[]', JSON.stringify({ order_id: 'owned-remark-order', price: '1.00', extra: 'x'.repeat(9000) })])
      expect((await s.request('POST', path, body)).status).toBe(400);
    expect(await s.snapshot()).toEqual(before); expect(await s.f.exec('SELECT last_value,is_called FROM store_order_status_id_seq')).toEqual(sequence);
  }), 120000);

  it.each(['paid', 'deleted', 'system-deleted'] as const)('refuses %s orders without writes', async kind => withPriceScenario(async s => {
    await s.seed(); await s.f.db.update(storeOrder).set(kind === 'paid' ? { paid: 1 } : kind === 'deleted' ? { isDel: 1 } : { isSystemDel: 1 }).where(eq(storeOrder.id, 820001));
    const before = await s.snapshot(), result = await s.request('POST', path, { order_id: 'owned-remark-order', price: '1.00' });
    expect(result.status).toBe(kind === 'paid' ? 400 : 404); expect(await s.snapshot()).toEqual(before);
  }), 120000);

  it.each(['role', 'password', 'cart', 'audit'] as const)('rolls back a late %s change after writing the audit', async kind => withPriceScenario(async s => {
    await s.seed();
    await s.f.db.insert(storeOrderCartInfo).values({ oid: 820001, uid: 11, productId: 70, cartId: 'late-cart', cartNum: 1, cartInfo: 'preserved history' });
    const code = kind === 'role' ? "UPDATE system_role SET rules='order.view' WHERE id=820001;"
      : kind === 'password' ? "UPDATE system_admin SET pwd='changed-price-password' WHERE id=102;"
      : kind === 'cart' ? "UPDATE store_order_cart_info SET cart_info='changed history' WHERE oid=NEW.oid;"
      : "NEW.change_message:='rewritten audit';";
    await s.f.exec(`CREATE FUNCTION owned_price_late() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN ${code} RETURN NEW; END$$;
      CREATE TRIGGER owned_price_late ${kind === 'audit' ? 'BEFORE' : 'AFTER'} INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION owned_price_late()`);
    const before = await s.snapshot(), result = await s.request('POST', path, { order_id: 'owned-remark-order', price: '1.00' }, s.token('manager'));
    expect(result.status).not.toBe(200); expect(result.status).not.toBe(500); expect(await s.snapshot()).toEqual(before);
    await s.f.exec('DROP TRIGGER owned_price_late ON store_order_status');
    expect((await s.request('POST', path, { order_id: 'owned-remark-order', price: '1.00' }, s.token('manager'))).status).toBe(200);
  }), 120000);

  it('returns a bounded conflict for an independently locked order and commits the identical retry after release', async () => withPriceScenario(async s => {
    await s.seed(); const before = await s.snapshot();
    if (!s.f.withPeer) throw Error('Native peer required');
    await s.f.withPeer(async peer => {
      await peer.exec('BEGIN');
      try {
        await peer.exec('SELECT id FROM store_order WHERE id=820001 FOR UPDATE');
        expect((await s.request('POST', path, { order_id: 'owned-remark-order', price: '1.00' })).status).toBe(409);
        expect(await s.snapshot()).toEqual(before);
      } finally { await peer.exec('ROLLBACK'); }
    });
    expect((await s.request('POST', path, { order_id: 'owned-remark-order', price: '1.00' })).status).toBe(200);
  }), 120000);

  it('fails closed when required receipt INSERT is removed and never repairs runtime grants', async () => withPriceScenario(async s => {
    await s.seed(); await s.f.exec(`REVOKE INSERT ON public.admin_order_price_operation_v1 FROM "${s.roles.admin}"`);
    const before = await s.snapshot(), result = await s.request('POST', path, { order_id: 'owned-remark-order', price: '1.00' });
    expect(result.status, result.msg).toBe(503); expect(await s.snapshot()).toEqual(before);
    expect(await s.f.exec(`SELECT has_table_privilege('${s.roles.admin}','public.admin_order_price_operation_v1','INSERT') AS writable`)).toEqual([{ writable: false }]);
  }), 120000);

  it('keeps an exact no-op available without installing a price addon and refuses a changed price without DDL', async () => withRemarkScenario(async s => {
    await s.seed(); const before = await s.snapshot();
    expect((await s.request('POST', path, { order_id: 'owned-remark-order', price: '0.00' })).status).toBe(200);
    expect((await s.request('POST', path, { order_id: 'owned-remark-order', price: '1.00' })).status).toBe(503);
    expect(await s.snapshot()).toEqual(before);
    expect(await s.f.exec("SELECT to_regclass('public.admin_order_price_operation_v1') IS NULL AS absent")).toEqual([{ absent: true }]);
  }), 120000);
  it('stages PHP SMS and inbox once from the actual Admin receipt and keeps an obsolete equal-price request inactive', async () => withPriceScenario(async s => {
    await s.seed();
    await s.f.db.update(storeOrder).set({payPrice:'10.00',totalPrice:'10.00',userPhone:'00000000000'}).where(eq(storeOrder.id,820001));
    await s.f.db.delete(systemNotification).where(eq(systemNotification.mark,'price_revision'));
    await s.f.db.insert(systemNotification).values({mark:'price_revision',isSms:1,isSystem:1,isWechat:1,isRoutine:1,
      smsId:'OWNED_PRICE_REVISION',systemTitle:'订单{order_id}改价',systemText:'请支付{pay_price}元'});
    const consumer=new OrderOutboxService(createContainerFromDb(s.databases.app),{...s.f.env,ORDER_QUEUE:{send:async()=>{throw Error('Unexpected queue send in price notification fixture');},sendBatch:async()=>{throw Error('Unexpected queue batch in price notification fixture');},metrics:async()=>{throw Error('Unexpected queue metrics in price notification fixture');}}} as typeof s.f.env);
    const save=async(price:string)=>{
      const result=await s.request('POST',path,{order_id:'owned-remark-order',price});expect(result.status,result.msg).toBe(200);
      return (await s.f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.aggregateId,820001)).orderBy(storeOrderOutbox.id)).at(-1)!;
    };
    const message=(event:typeof storeOrderOutbox.$inferSelect)=>({action:'processOrderNotificationOutbox' as const,outboxId:event.id,eventKey:event.eventKey});
    const a=await save('7.00');expect(await consumer.processMessage(message(a))).toBe('completed');
    expect(await consumer.processMessage(message(a))).toBe('already-completed');
    expect(await s.f.db.select().from(orderNotificationDelivery)).toMatchObject([{channel:'sms',noticeMark:'price_revision',payload:{kind:'sms',params:{order_id:'owned-remark-order',pay_price:'7.00'}}}]);
    expect(await s.f.db.select().from(systemMessage)).toMatchObject([{userId:11,content:'请支付7.00元'}]);
    const b=await save('8.00'),c=await save('7.00');
    expect(await supplierOrderPriceRevisionIsActive(s.databases.app,a.eventKey)).toBe(false);
    expect(await supplierOrderPriceRevisionIsActive(s.databases.app,b.eventKey)).toBe(false);
    expect(await supplierOrderPriceRevisionIsActive(s.databases.app,c.eventKey)).toBe(true);
    expect(await consumer.processMessage(message(b))).toBe('completed');expect(await consumer.processMessage(message(c))).toBe('completed');
    expect(await s.f.db.select().from(orderNotificationDelivery)).toHaveLength(2);expect(await s.f.db.select().from(systemMessage)).toHaveLength(2);
  }),120000);

});
