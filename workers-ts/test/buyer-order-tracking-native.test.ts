import { describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import { createContainerFromDb } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, user } from '@/models/schema';
import { createToken } from '@/utils/jwt';
import { parseBuyerTrackingResult } from '../../view/common/buyerOrderTracking';
import { withBuyerOrderTracking } from './helpers/buyerOrderTracking';

const outgoing = '/api/order/express/tracking_order_A?view=buyer';
const returning = '/api/order/express/840101/refund?view=buyer';
const parse = (data: unknown, kind: 'order'|'refund' = 'order', reference = kind === 'order' ? 'tracking_order_A' : '840101') => parseBuyerTrackingResult(data, { kind, reference }, 11);
const gate = () => { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; };
const carrier = { status: '0', result: { deliverystatus: 1, issign: 0, list: [{ time: 'local-provider-time', status: '隔离承运商揽收样本' }] } };

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('buyer outgoing and return logistics through actual App/JWT/native LOGIN', () => {
  it('projects owned physical goods/contact with no business/sequence writes and preserves the minimal legacy contract', async () => withBuyerOrderTracking(async s => {
    await s.seedOrder(); await s.seedRefund(); const before = await s.state();
    const result = await s.request(outgoing); expect(result.status, result.msg).toBe(200);
    const data = parse(result.data); expect(data.expressNo).toBe('OUTGOING-A'); expect(data.traces).toEqual([]);
    expect(data.contexts[0]).toMatchObject({ uid: 11, recipientName: '隔离样本收货人', items: [{ quantity: 2, unitPrice: '10.00' }] });
    expect(result.headers.get('cache-control')).toContain('no-store'); expect(result.headers.get('pragma')).toBe('no-cache');
    expect(result.headers.get('referrer-policy')).toBe('no-referrer');
    const legacy = await s.request('/api/order/express/tracking_order_A'); expect(legacy.status, legacy.msg).toBe(200);
    expect(legacy.data.version).toBeUndefined(); expect(legacy.data.contexts).toBeUndefined();
    expect(Object.keys(legacy.data.order).sort()).toEqual(['delivery_code','delivery_id','delivery_name','delivery_type','order_id']);
    expect(s.providerCalls).toEqual([]); expect(await s.state()).toEqual(before);
  }), 120000);

  it.each([4,5,6])('reads return PK, selected quantity and return waybill without treating refund state %s as receipt', async refundType => withBuyerOrderTracking(async s => {
    await s.seedOrder(); await s.seedRefund(840101, 'tracking_refund_A', { refundType }); const before = await s.state();
    const result = await s.request(returning); expect(result.status, result.msg).toBe(200);
    const data = parse(result.data, 'refund'); expect(data.expressNo).toBe('RETURN-A'); expect(data.deliveryStatus).not.toBe('已签收');
    expect(data.contexts[0].items[0]).toMatchObject({ quantity: 1, unitPrice: '10.00' });
    const legacy = await s.request('/api/order/express/tracking_refund_A/refund'); expect(legacy.status, legacy.msg).toBe(200);
    expect(legacy.data.expressNo).toBe('RETURN-A'); expect(legacy.data.version).toBeUndefined(); expect(await s.state()).toEqual(before);
  }), 120000);

  it('rejects ambiguous legacy numeric aliases but binds the versioned view to the exact refund PK', async () => withBuyerOrderTracking(async s => {
    await s.seedOrder(); await s.seedRefund(); await s.seedRefund(840102, '840101', { refundExpress: 'OTHER-RETURN' });
    const denied = await s.request('/api/order/express/840101/refund'); expect(denied.status).not.toBe(200); expect(denied.data).toBeNull();
    const exact = await s.request(returning); expect(exact.status, exact.msg).toBe(200); expect(parse(exact.data, 'refund').expressNo).toBe('RETURN-A');
    const invalid = await s.request('/api/order/express/tracking_refund_A/refund?view=buyer');
    expect(invalid.status).toBe(400); expect(invalid.msg).toContain('物流查询参数无效');
  }), 120000);

  it('enforces anonymous/foreign/staff JWT and deleted scope before provider I/O, including malformed query views', async () => withBuyerOrderTracking(async s => {
    await s.seedOrder(); await s.seedRefund(); await s.enableProvider(); const foreign = await s.token(22), staff = (await createToken(11, 'admin', 'local-only', s.env.APP_KEY)).token;
    for (const bearer of [null, foreign, staff]) for (const path of [outgoing, returning]) {
      const result = await s.request(path, bearer); expect(result.status).not.toBe(200); expect(result.data).toBeNull(); expect(result.headers.get('cache-control')).toContain('no-store');
    }
    for (const suffix of ['?view=staff','?view=buyer&view=buyer','?view=buyer&extra=1']) expect((await s.request('/api/order/express/tracking_order_A'+suffix)).status).not.toBe(200);
    await s.f.db.update(storeOrder).set({ isSystemDel: 1 }).where(eq(storeOrder.id, 840001)); expect((await s.request(outgoing)).status).not.toBe(200);
    await s.f.db.update(storeOrderRefund).set({ isDel: 1 }).where(eq(storeOrderRefund.id, 840101)); expect((await s.request(returning)).status).not.toBe(200);
    expect(s.providerCalls).toEqual([]);
  }), 120000);

  it.each(['outgoing-waybill','return-waybill','refund-owner','password','disabled'] as const)('rechecks %s after carrier I/O without keeping a database transaction open', async change => withBuyerOrderTracking(async s => {
    await s.seedOrder(); await s.seedRefund(); await s.enableProvider(); const reached = gate(), release = gate(), bearer = await s.token();
    s.provider(async () => { reached.resolve(); await release.promise; return carrier; });
    const pending = s.request(change.startsWith('return') || change === 'refund-owner' ? returning : outgoing, bearer);
    try {
      await reached.promise; const [activity] = await s.f.db.execute(sql`SELECT state,xact_start FROM pg_stat_activity WHERE pid=${s.appPid}`);
      expect(activity).toMatchObject({ state: 'idle', xact_start: null });
      if (change === 'outgoing-waybill') await s.f.db.update(storeOrder).set({ deliveryId: 'OUTGOING-B' }).where(eq(storeOrder.id, 840001));
      if (change === 'return-waybill') await s.f.db.update(storeOrderRefund).set({ refundExpress: 'RETURN-B' }).where(eq(storeOrderRefund.id, 840101));
      if (change === 'refund-owner') await s.f.db.update(storeOrderRefund).set({ uid: 22 }).where(eq(storeOrderRefund.id, 840101));
      if (change === 'password') await s.f.db.update(user).set({ pwd: 'changed-owned-password' }).where(eq(user.uid, 11));
      if (change === 'disabled') await s.f.db.update(user).set({ status: 0 }).where(eq(user.uid, 11));
      const before = await s.state(); release.resolve(); const denied = await pending;
      expect(denied.status, denied.msg).not.toBe(200); expect(denied.data).toBeNull(); expect(await s.state()).toEqual(before);
      if (change === 'outgoing-waybill' || change === 'return-waybill') {
        const fresh = await s.request(change === 'outgoing-waybill' ? outgoing : returning);
        expect(fresh.status, fresh.msg).toBe(200); expect(fresh.data.expressNo).toBe(change === 'outgoing-waybill' ? 'OUTGOING-B' : 'RETURN-B');
      }
    } finally { release.resolve(); await pending; }
  }), 120000);

  it('takes short read-only repeatable-read snapshots and rejects a peer cart change instead of mixing generations', async () => withBuyerOrderTracking(async s => {
    await s.seedOrder(); let reached = false; const actual = PostgresJsSession.prototype.prepareQuery;
    const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function(this: InstanceType<typeof PostgresJsSession>, ...args) {
      const prepared = actual.apply(this,args); if (/from "store_order" where/i.test(args[0].sql)) {
        const execute = prepared.execute.bind(prepared); prepared.execute = async values => {
          const result = await execute(values); if (!reached) { reached = true;
            const [settings] = await this.client.unsafe("SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation,current_setting('statement_timeout') AS timeout");
            expect(settings).toEqual({ readonly:'on',isolation:'repeatable read',timeout:'5s' });
            await s.f.db.update(storeOrderCartInfo).set({ cartNum: 1 }).where(eq(storeOrderCartInfo.oid,840001));
          } return result;
        };
      } return prepared;
    });
    try { const result = await s.request(outgoing); expect(result.status).not.toBe(200); expect(result.data).toBeNull(); } finally { spy.mockRestore(); }
    expect(reached).toBe(true); const fresh = await s.request(outgoing); expect(fresh.status, fresh.msg).toBe(200); expect(parse(fresh.data).contexts[0].items[0].quantity).toBe(1);
  }), 120000);

  it('returns all 50 physical split packages with matching goods and rejects a 51st or foreign child', async () => withBuyerOrderTracking(async s => {
    await s.seedOrder(840001,'tracking_order_A',{ pid:-1,deliveryType:'split' });
    for (let n=1;n<=50;n++) await s.seedOrder(841000+n,'tracking_child_'+n,{pid:840001,deliveryId:'PARCEL-'+n});
    const before=await s.state(), result=await s.request(outgoing); expect(result.status,result.msg).toBe(200);
    const data=parse(result.data); expect(data.packages).toHaveLength(50); expect(data.contexts).toHaveLength(50); expect(data.packages[49].expressNo).toBe('PARCEL-50'); expect(await s.state()).toEqual(before);
    await s.seedOrder(841051,'tracking_child_51',{pid:840001}); expect((await s.request(outgoing)).status).not.toBe(200);
    await s.f.db.delete(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,841051)); await s.f.db.delete(storeOrder).where(eq(storeOrder.id,841051));
    await s.f.db.update(storeOrder).set({uid:22}).where(eq(storeOrder.id,841050)); expect((await s.request(outgoing)).status).not.toBe(200);
  }),120000);

  it('keeps malformed/oversized historical goods explicit and never echoes private snapshot fields or unsafe images', async () => withBuyerOrderTracking(async s => {
    await s.seedOrder();
    await s.f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify({ truePrice:'10.00', product:{storeName:'local',image:'javascript:forbidden',admin_secret:'do-not-return'},sku:{suk:'local'} }) }).where(eq(storeOrderCartInfo.oid,840001));
    const safe=await s.request(outgoing);expect(safe.status,safe.msg).toBe(200);expect(parse(safe.data).contexts[0].items[0].image).toBe('');expect(JSON.stringify(safe.data)).not.toContain('do-not-return');
    for (const cartInfo of ['{broken',JSON.stringify({product:{storeName:'x'.repeat(65536)}})]) {
      await s.f.db.update(storeOrderCartInfo).set({cartInfo}).where(eq(storeOrderCartInfo.oid,840001));
      const result=await s.request(outgoing);expect(result.status,result.msg).toBe(200);const data=parse(result.data);expect(data.contexts[0].items).toEqual([]);expect(data.contexts[0].itemsError).not.toBe('');
    }
  }),120000);

  it('uses SELECT-only LOGINs and fails on revoked SELECT without repairing grants or mutating connection settings',async()=>withBuyerOrderTracking(async s=>{
    await s.seedOrder();await s.f.withRuntimeRole!(async role=>{
      await s.f.db.execute(sql.raw(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${role.role}"`)); s.useContainer(createContainerFromDb(role.db));
      const settings=()=>role.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`),before=await settings();
      const result=await s.request(outgoing);expect(result.status,result.msg).toBe(200);parse(result.data);expect(await settings()).toEqual(before);
      const [rights]=await role.db.execute(sql`SELECT has_table_privilege(current_user,'store_order','INSERT,UPDATE,DELETE') AS writes`);expect(rights.writes).toBe(false);
      await s.f.db.execute(sql.raw(`REVOKE SELECT ON store_order_cart_info FROM "${role.role}"`));const denied=await s.request(outgoing);expect(denied.status).not.toBe(200);expect(denied.data).toBeNull();
      const [after]=await s.f.db.execute(sql`SELECT has_table_privilege(${role.role},'store_order_cart_info','SELECT') AS reads`);expect(after.reads).toBe(false);expect(await settings()).toEqual(before);
    });
  }),120000);

  it('reads a genuine pending materialization claim using its numeric source cart key',async()=>withBuyerOrderTracking(async s=>{
    // Synthetic paid admission; actual application reserves quantities, no settlement.
    const source=await s.operations.createPaid(),application=await s.operations.apply(source.id);
    await s.f.db.update(storeOrderRefund).set({refundExpress:'PENDING-RETURN'}).where(eq(storeOrderRefund.id,application.refundId));
    const before=await s.state(),result=await s.request('/api/order/express/'+application.refundId+'/refund?view=buyer');expect(result.status,result.msg).toBe(200);
    const data=parse(result.data,'refund',String(application.refundId));expect(data.contexts[0].items.map(item=>item.quantity)).toEqual([1]);expect(data.contexts[0].itemsError).toBe('');expect(await s.state()).toEqual(before);
  }),120000);

  it('projects a declared historical row-namespace reservation with its exact opaque source key',async()=>withBuyerOrderTracking(async s=>{
    await s.seedOrder();const key='opaque:catalogue:owned';await s.f.db.update(storeOrderCartInfo).set({cartId:key}).where(eq(storeOrderCartInfo.id,840101));
    const selection={cartId:840101,cartNum:1,sourceCartId:key},claim={...selection,rowId:840101,beforeRefundNum:0,totalNum:2};
    await s.seedRefund(840101,'tracking_refund_A',{cartInfo:JSON.stringify({cartIds:[selection],quantityReservation:{version:'refund-quantity-customer-row-v3',orderId:840001,uid:11,items:[claim]}})});
    const before=await s.state(),result=await s.request(returning);expect(result.status,result.msg).toBe(200);expect(parse(result.data,'refund').contexts[0]).toMatchObject({items:[{quantity:1,unitPrice:'10.00'}],itemsError:''});expect(await s.state()).toEqual(before);
  }),120000);

  it('reads archived selected goods after actual refund materialization rather than the remaining order',async()=>withBuyerOrderTracking(async s=>{
    // Synthetic paid admission only; actual refund application/materialization follows.
    const source=await s.operations.createPaid(),application=await s.operations.apply(source.id);await s.operations.finish(application.refundId);
    const receipt=await s.operations.receipt(application.refundId);expect(receipt.selectedOrderId).not.toBe(receipt.remainingOrderId);
    await s.f.db.update(storeOrderRefund).set({refundExpress:'ARCHIVED-RETURN',refundExpressName:'本地历史退件'}).where(eq(storeOrderRefund.id,application.refundId));
    const before=await s.state(),result=await s.request('/api/order/express/'+application.refundId+'/refund?view=buyer');expect(result.status,result.msg).toBe(200);
    const data=parse(result.data,'refund',String(application.refundId));expect(data.expressNo).toBe('ARCHIVED-RETURN');expect(data.contexts[0].items.map(item=>item.quantity)).toEqual([1]);expect(data.contexts[0].itemsError).toBe('');expect(await s.state()).toEqual(before);
  }),120000);
});
