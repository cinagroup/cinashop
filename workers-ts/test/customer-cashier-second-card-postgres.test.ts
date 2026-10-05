import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {customerCashierSecondCardFixture} from './helpers/customerCashierSecondCardFixture';
import {storeCart,storeOrderCartInfo,storeOrderStatus,storeProductAttrValue,storeService} from '../src/models/schema';
import {withTx} from '../src/lib/di';
import {readCashierSecondCardOrigin} from '../src/services/order/CashierSecondCardOrigin';
import {StoreOrderCreateService} from '../src/services/order/StoreOrderCreateService';
import {createCustomerCashierSecondCardWithRuntime,prepareCustomerCashierDraft,applyCustomerCashierCashPayment,
  quoteCustomerCashierSecondCard,createCustomerCashierSecondCard} from '../src/services/customer-work/CustomerWorkCashierService';
import {registerPaymentReconciliationTx} from '../src/services/payment/PaymentReconciliationRegistry';
import {authorizeCustomerWorkActor} from '../src/services/customer-work/CustomerWorkScope';

/** Complete native PG16 business file. There is no paid-bit seed in a
 * positive cashier scenario: the actual core, stock claims, payment and paid
 * event consumer must succeed before the origin can authorize redemption. */
describe('ordinary customer genuine cashier second-card PG16',()=>{
  let f:Awaited<ReturnType<typeof customerCashierSecondCardFixture>>;
  beforeAll(async()=>{f=await customerCashierSecondCardFixture();},180000);
  beforeEach(async()=>{await f.reset();});afterAll(async()=>{await f?.close();},30000);
  const origin=async(id:number)=>{const r=await f.actual(id);return readCashierSecondCardOrigin(f.db,r.order,r.carts);};
  const count=async(table:string)=>Number((await f.db.execute<{n:number}>(sql.raw(`SELECT count(*)::int AS n FROM public.${table}`)))[0].n);
  it('creates the actual counter order, stock claim, purchase origin and customer creation audit',async()=>{
    const{order}=await f.create();expect(order).toMatchObject({uid:11,shippingType:2,storeId:0,staffId:101,isChannel:2,paid:0,status:0,productType:4});
    const actual=await f.actual(order.id);expect(actual.carts).toHaveLength(1);expect(actual.carts[0]).toMatchObject({cartNum:2,writeTimes:6,writeSurplusTimes:6,writeStart:0,writeEnd:0});
    const[sku]=await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id,1));expect(sku.stock).toBe(8);
    expect(await count('cashier_second_card_origin_v1')).toBe(1);expect(await count('store_order_purchase_origin')).toBe(1);
    expect(await f.db.select().from(storeOrderStatus).where(and(eq(storeOrderStatus.oid,order.id),eq(storeOrderStatus.changeType,'customer_cashier_create')))).toHaveLength(1);
  });
  it('replays the original creation without another cart, stock deduction or audit',async()=>{
    const original=await f.create();const replay=await createCustomerCashierSecondCardWithRuntime(f.container,f.runtime,f.actor(),original.input);
    expect(replay).toEqual(original.result);expect(await count('store_order')).toBe(1);expect(await count('cashier_second_card_cart_v1')).toBe(1);
    expect(await count('cashier_second_card_origin_v1')).toBe(1);const[sku]=await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id,1));expect(sku.stock).toBe(8);
  });
  it('rejects reusing the creation UUID with a different actual purchase quantity',async()=>{
    const original=await f.create();await expect(createCustomerCashierSecondCardWithRuntime(f.container,f.runtime,f.actor(),{...original.input,quantity:1})).rejects.toThrow();expect(await count('store_order')).toBe(1);
  });
  it('requires the real cash payment event consumer to activate a relative validity window',async()=>{
    const{order}=await f.create();await expect(origin(order.id)).rejects.toThrow();const paid=await f.cash(order);expect(paid.replayed).toBe(false);expect(paid.outbox).not.toBeNull();
    await expect(origin(order.id)).rejects.toThrow('有效期');expect(await f.processPaid(paid.outbox!)).toBe('completed');
    const actual=await f.actual(order.id);expect(actual.carts[0].writeStart).toBe(actual.order.payTime);expect(actual.carts[0].writeEnd).toBe(actual.order.payTime+10*86400);
    expect(await origin(order.id)).toMatchObject({creator_kind:'customer',creator_id:101,root_order_id:order.id,root_order_no:order.orderId,payment_facts:{outbox_id:paid.outbox!.id,pay_type:'cash'}});
  });
  it('creates and pays a genuine UID0 guest without treating UID0 as the operator principal',async()=>{
    const{order}=await f.create(await f.input({buyer_uid:0,tourist_key:'guest-owned-001'}));expect(order.uid).toBe(0);expect(order.staffId).toBe(101);
    const paid=await f.cash(order);await f.processPaid(paid.outbox!);expect(await origin(order.id)).toMatchObject({creator_id:101,root_order_id:order.id});
    const actual=await f.actual(order.id);expect(actual.carts[0]).toMatchObject({uid:0,writeTimes:6,writeSurplusTimes:6});
  });
  it('uses the original real payment transition and receipt for a genuine zero-amount card',async()=>{
    await f.reset('0.00');const{order}=await f.create();expect(order.payPrice).toBe('0.00');const paid=await f.cash(order);await f.processPaid(paid.outbox!);
    const rows=await f.db.execute<{payment_kind:string;amount:string}>(sql`SELECT payment_kind,amount::text FROM public.cashier_second_card_payment_v1 WHERE order_id=${order.id}`);
    expect(rows).toEqual([{payment_kind:'zero',amount:'0.00'}]);expect(await origin(order.id)).not.toBeNull();expect(await count('store_order_outbox')).toBe(1);
  });
  it('replays the original cash UUID after current customer role revocation without dispatching payment',async()=>{
    const{order}=await f.create(),key=randomUUID(),scope=(await authorizeCustomerWorkActor(f.db,f.actor())).scope_key;
    const input={request_key:key,version:'customer-cashier-second-card-payment-v1' as const,scope_key:scope,order_id:order.id,order_no:order.orderId,expected_amount:order.payPrice};
    const first=await applyCustomerCashierCashPayment(f.container,f.actor(),input);await f.maintenanceDb.update(storeService).set({customer:0}).where(eq(storeService.uid,101));
    const replay=await applyCustomerCashierCashPayment(f.container,f.actor(),input);expect(replay).toMatchObject({evidence:first.evidence,replayed:true,outbox:null});
    expect(await count('cashier_second_card_payment_v1')).toBe(1);expect(await count('store_order_outbox')).toBe(1);
  });
  it('rejects a new payment UUID on the already-paid original order',async()=>{
    const{order}=await f.create();await f.cash(order);await expect(f.cash(order)).rejects.toThrow();expect(await count('cashier_second_card_payment_v1')).toBe(1);
  });
  it('binds payment to the exact physical order, business number and confirmed amount',async()=>{
    const{order}=await f.create();const scope=(await authorizeCustomerWorkActor(f.db,f.actor())).scope_key;
    await expect(applyCustomerCashierCashPayment(f.container,f.actor(),{request_key:randomUUID(),version:'customer-cashier-second-card-payment-v1',scope_key:scope,
      order_id:order.id,order_no:order.orderId,expected_amount:'1.00'})).rejects.toThrow();expect((await f.actual(order.id)).order.paid).toBe(0);expect(await count('cashier_second_card_payment_v1')).toBe(0);
  });
  it('does not admit a serialized fake cashier capability through the ordinary core',async()=>{
    await expect(StoreOrderCreateService.createWithRuntime(f.container,{...f.runtime,cashierSecondCardCreation:{} as never},{uid:11,key:'fake-capability-key',cartIds:[1],userIp:'',shippingType:2,storeId:0})).rejects.toThrow('实际客户');
    expect(await count('store_order')).toBe(0);
  });
  it('preserves ordinary pickup validation and cannot turn store0 into generic checkout',async()=>{
    await expect(StoreOrderCreateService.createWithRuntime(f.container,f.runtime,{uid:11,key:'ordinary-invalid-pickup',cartIds:[1],userIp:'',shippingType:2,storeId:0})).rejects.toThrow('自提门店');expect(await count('cashier_second_card_origin_v1')).toBe(0);
  });
  it('requires current customer capability even when a user is a chat-only customer service account',async()=>{
    const input=await f.input(),{request_key,...body}=input;await expect(prepareCustomerCashierDraft(f.container,f.actor(102),request_key,body)).rejects.toThrow();expect(await count('cashier_second_card_cart_v1')).toBe(0);
  });
  it('keeps a real previously initiated UNKNOWN provider claim and refuses cash payment',async()=>{
    const{order}=await f.create();await withTx(f.container,async tx=>{await registerPaymentReconciliationTx(tx,{provider:'wechat',profile:'wechat',orderDomain:'store_order',orderNo:order.orderId,
      expectedAmountCents:1400,providerStatus:'UNKNOWN',initiated:true});});
    await expect(f.cash(order)).rejects.toThrow('扫码支付已发起');expect((await f.actual(order.id)).order.paid).toBe(0);expect(await count('payment_reconciliation_case')).toBe(1);expect(await count('cashier_second_card_payment_v1')).toBe(0);
  });
  it('rejects an altered physical cart snapshot even after genuine payment and activation',async()=>{
    const{order}=await f.create(),paid=await f.cash(order);await f.processPaid(paid.outbox!);await f.maintenanceDb.update(storeOrderCartInfo).set({cartInfo:'{"sku":{"price":"0.01"}}'}).where(eq(storeOrderCartInfo.oid,order.id));
    await expect(origin(order.id)).rejects.toThrow('快照');
  });
  it('does not accept a changed activation window derived from a mutable live SKU',async()=>{
    const{order}=await f.create(),paid=await f.cash(order);await f.processPaid(paid.outbox!);await f.maintenanceDb.update(storeOrderCartInfo).set({writeStart:order.addTime+60,writeEnd:order.addTime+60+10*86400}).where(eq(storeOrderCartInfo.oid,order.id));
    await expect(origin(order.id)).rejects.toThrow('有效期');
  });
  it('rolls back actual payment and its event if immutable receipt insertion fails',async()=>{
    const{order}=await f.create();await f.exec(`REVOKE INSERT ON public.cashier_second_card_payment_v1 FROM "${f.role}"`);
    try{await expect(f.cash(order)).rejects.toThrow();expect((await f.actual(order.id)).order.paid).toBe(0);expect(await count('store_order_outbox')).toBe(0);expect(await count('cashier_second_card_payment_v1')).toBe(0);}
    finally{await f.exec(`GRANT INSERT ON public.cashier_second_card_payment_v1 TO "${f.role}"`);}
  });
  it('rechecks frozen product, SKU and quantity after a genuine independent LOGIN cart lock wait',async()=>{
    const selected=await f.input(),{request_key,quote_token:_token,...intent}=selected;
    const draft=await prepareCustomerCashierDraft(f.container,f.actor(),request_key,intent);
    const quote=await quoteCustomerCashierSecondCard(f.container,f.runtime,f.actor(),request_key,intent);
    let pending:Promise<{error?:unknown}>|undefined,blocked=false;
    await f.withPeer(async(peer,pid)=>peer.transaction(async tx=>{
      await tx.update(storeCart).set({cartNum:1}).where(eq(storeCart.id,draft.cart_id));
      pending=createCustomerCashierSecondCard(f.container,f.runtime,f.actor(),request_key,intent,quote.quote_token)
        .then(()=>({}),error=>({error}));
      const deadline=Date.now()+2000;
      while(Date.now()<deadline){const rows=await f.maintenanceDb.execute<{blocked:boolean}>(sql`SELECT EXISTS(
        SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE a.usename=${f.role} AND a.pid<>${pid}
          AND ${pid}=ANY(pg_catalog.pg_blocking_pids(a.pid))) AS blocked`);
        if(rows[0]?.blocked){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
    }));
    const result=await pending!;expect(blocked).toBe(true);expect(result.error).toBeInstanceOf(Error);expect((result.error as Error).message).toContain('购物行');
    expect(await count('store_order')).toBe(0);expect(await count('cashier_second_card_origin_v1')).toBe(0);expect(await count('store_order_status')).toBe(0);
    const[sku]=await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id,1));expect(sku.stock).toBe(10);
  });
});
