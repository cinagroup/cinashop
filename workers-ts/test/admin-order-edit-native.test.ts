import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import { supplierOrderPriceRevisionIsActive } from '@/services/supplier/SupplierUnpaidOrderEditEffects';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb, withTx } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, systemRole, user, storeOrderOutbox, systemNotification, systemMessage, orderNotificationDelivery } from '@/models/schema';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { installAdminOrderEditRuntime } from '@/migrations/adminOrderEditRuntime';
import { applyStoreOrderBalancePayment } from '@/services/order/StoreOrderPayService';
import { allocatePaidOrderBySupplier } from '@/services/order/OrderSupplierAllocationService';
import { withEditScenario } from './helpers/adminOrderEdit';
import { withRemarkScenario } from './helpers/adminOrderRemark';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Admin desktop six-field form through actual JWT and restricted LOGINs', () => {
  it('returns the original six-field PHP form and keeps primary IDs separate from numeric order numbers across aliases', async () => withEditScenario(async s => {
    await s.seed(820001, '820002'); await s.seed(820002, 'DifferentOrder');
    await s.f.db.update(storeOrder).set({totalPrice:'1234567890.12'}).where(eq(storeOrder.id,820001));
    const form = await s.request('GET', '/adminapi/order/edit/820001', undefined, s.token('manager'));
    expect(form.status, form.msg).toBe(200); expect(form.headers.get('cache-control')).toContain('no-store');
    expect(form.data).toMatchObject({ title: '修改订单', action: '/order/update/820001', method: 'PUT', values: { order_id: '820002' } });
    expect(form.data.rules.map((rule: { field: string }) => rule.field)).toEqual(['order_id','total_price','total_postage','pay_postage','pay_price','gain_integral']);
    expect(form.data.rules.slice(0,4).every((rule: { props: { disabled: boolean } }) => rule.props.disabled)).toBe(true);
    expect(form.data.rules[5].props.precision).toBe(0);
    expect(form.data.rules.slice(1).every((rule: { value: unknown; props: { max: number } }) => typeof rule.value === 'number' && rule.props.max === 9_999_999_999)).toBe(true);
    const sixFields=Object.fromEntries(form.data.rules.map((rule:{field:string;value:string|number})=>[rule.field,rule.value]));
    const update = await s.request('PUT', '/api/admin/order/update/820001', { ...sixFields, pay_price:1.25 }, s.token('manager'));
    expect(update.status, update.msg).toBe(200); expect(update.data).toBeNull();
    expect((await s.f.db.select().from(storeOrder).where(eq(storeOrder.id,820001)))[0]).toMatchObject({ payPrice:'1.25',changePrice:'-1.25' });
    expect((await s.f.db.select().from(storeOrder).where(eq(storeOrder.id,820002)))[0].payPrice).toBe('0.00');
  }),120000);

  it('preserves large historical facts and unchanged fractional gain through repeated prices and exact no-op retries', async () => withEditScenario(async s => {
    await s.seed(); const id=820001, large='历'.repeat(90000);
    await s.f.db.update(storeOrder).set({ payPrice:'10.00',totalPrice:'12.00',totalPostage:'-0.50',payPostage:'-0.25',gainIntegral:'-0.50',
      cartId:large,customForm:large,expressDump:large,virtualInfo:large,promotionsGive:large,giveCoupon:large,refundReasonWapImg:large }).where(eq(storeOrder.id,id));
    await s.f.db.insert(storeOrderCartInfo).values({oid:id,uid:11,productId:70,cartId:'large-legacy',cartInfo:large,cartNum:1});
    const original=(await s.f.db.select().from(storeOrder).where(eq(storeOrder.id,id)))[0], carts=await s.f.db.select().from(storeOrderCartInfo);
    for(const [price,change] of [['7.00','3.00'],['12.00','-2.00'],['0.00','10.00']]){
      const form=await s.request('GET',`/adminapi/order/edit/${id}`);
      const body={...form.data.values,pay_price:price,revision:form.data.revision,gain_integral:'-0.50',paid:1,admin_id:999};
      const changed=await s.request('PUT',`/adminapi/order/update/${id}`,body); expect(changed.status,changed.msg).toBe(200);
      expect((await s.f.db.select().from(storeOrder).where(eq(storeOrder.id,id)))[0]).toEqual({...original,payPrice:price,changePrice:change});
      expect(await s.f.db.select().from(storeOrderCartInfo)).toEqual(carts);
      const before=await s.snapshot(),sequence=await s.f.exec('SELECT last_value,is_called FROM store_order_status_id_seq');
      expect((await s.request('PUT',`/adminapi/order/update/${id}`,body)).status).toBe(200);
      expect(await s.snapshot()).toEqual(before);expect(await s.f.exec('SELECT last_value,is_called FROM store_order_status_id_seq')).toEqual(sequence);
    }
    expect(await s.f.exec('SELECT actor_id,supplier_id,state FROM admin_order_edit_operation_v1')).toEqual(Array.from({length:3},()=>({actor_id:101,supplier_id:0,state:'committed'})));
  }),120000);

  it('allows an exact six-field no-op without commissioning the optional editor tables',async()=>withRemarkScenario(async s=>{
    await s.seed(); const before=await s.snapshot();
    const reply=await s.request('PUT','/adminapi/order/update/820001',{order_id:'owned-remark-order',total_price:'0',total_postage:0,pay_postage:0,pay_price:0,gain_integral:0});
    expect(reply.status,reply.msg).toBe(200);expect(await s.snapshot()).toEqual(before);
    expect(await s.f.exec("SELECT to_regclass('public.admin_order_edit_operation_v1') IS NULL AS absent")).toEqual([{absent:true}]);
  }),120000);

  it('commits real checkout line grants and money together, leaves the buyer unchanged, then accepts actual balance payment',async()=>withEditScenario(async s=>{
    await s.f.db.update(user).set({nowMoney:'1000.00',integral:100}).where(eq(user.uid,11));
    const order=await s.checkout(), original=(await s.f.db.select().from(storeOrder).where(eq(storeOrder.id,order.id)))[0];
    const buyer=await s.f.db.select().from(user).where(eq(user.uid,11)), carts=await s.f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id));
    const form=await s.request('GET',`/adminapi/order/edit/${order.id}`,undefined,s.token('manager'));
    const result=await s.request('PUT',`/adminapi/order/update/${order.id}`,{...form.data.values,pay_price:'18.75',gain_integral:17,revision:form.data.revision},s.token('manager'));
    expect(result.status,result.msg).toBe(200);expect(await s.f.db.select().from(user).where(eq(user.uid,11))).toEqual(buyer);
    const after=await s.f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id));
    expect(after.reduce((sum,row)=>sum+Number(JSON.parse(row.cartInfo!).gain_integral),0)).toBe(17);
    for(const row of after){const old=carts.find(value=>value.id===row.id)!;expect({...row,cartInfo:old.cartInfo}).toEqual(old);
      const beforeJson=JSON.parse(old.cartInfo!),afterJson=JSON.parse(row.cartInfo!);delete beforeJson.gain_integral;delete afterJson.gain_integral;expect(afterJson).toEqual(beforeJson);}
    const container=createContainerFromDb(s.databases.app);
    expect((await applyStoreOrderBalancePayment(container,{uid:11,orderId:order.orderId})).outcome).toBe('paid');
    const allocated=await withTx(container,tx=>allocatePaidOrderBySupplier(tx,order.id,order.orderId));
    expect(allocated.fulfillmentOrders).toHaveLength(1);expect(allocated.fulfillmentOrders[0]).toMatchObject({paid:1,payPrice:'18.75',gainIntegral:'17.00'});
    expect((await s.f.db.select().from(storeOrder).where(eq(storeOrder.id,order.id)))[0].changePrice).toBe((Number(original.payPrice)+Number(original.changePrice)-18.75).toFixed(2));
  }),120000);

  it.each(['order_id','total_price','total_postage','pay_postage'] as const)('refuses forged disabled %s without a write',async field=>withEditScenario(async s=>{
    await s.seed();const form=await s.request('GET','/adminapi/order/edit/820001'),before=await s.snapshot();
    const reply=await s.request('PUT','/adminapi/order/update/820001',{...form.data.values,[field]:field==='order_id'?'OtherOrder':'9.00',pay_price:'1.00'});
    expect(reply.status).toBe(409);expect(await s.snapshot()).toEqual(before);
  }),120000);

  it.each(['order','cart','deferred'] as const)('rolls back the full operation after %s tampering',async target=>withEditScenario(async s=>{
    await s.seed();const form=await s.request('GET','/adminapi/order/edit/820001'),before=await s.snapshot();
    const mutation=target==='order'?'UPDATE store_order SET gain_integral=999 WHERE id=NEW.oid;':target==='cart'
      ?"INSERT INTO store_order_cart_info(oid,uid,cart_id,product_id) VALUES(NEW.oid,11,'phantom',70);":"DELETE FROM store_order_status WHERE id=NEW.id;";
    await s.f.exec(`CREATE FUNCTION edit_acceptance_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN ${mutation} RETURN NEW; END$$;
      ${target==='deferred'?'CREATE CONSTRAINT TRIGGER edit_acceptance_tamper AFTER INSERT ON store_order_status DEFERRABLE INITIALLY DEFERRED':'CREATE TRIGGER edit_acceptance_tamper AFTER INSERT ON store_order_status'} FOR EACH ROW EXECUTE FUNCTION edit_acceptance_tamper();`);
    const reply=await s.request('PUT','/adminapi/order/update/820001',{...form.data.values,pay_price:'1.00'});
    expect(reply.status,reply.msg).toBe(409);expect(await s.snapshot()).toEqual(before);
  }),120000);

  it.each(['immediate','deferred'] as const)('rolls back every edited grant after %s line mutation',async timing=>withEditScenario(async s=>{
    const order=await s.checkout(),form=await s.request('GET',`/adminapi/order/edit/${order.id}`),before=await s.snapshot();
    await s.f.exec(`CREATE FUNCTION gain_acceptance_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN
      UPDATE store_order_cart_info SET cart_info=jsonb_set(cart_info::jsonb,'{gain_integral}','"999"'::jsonb)::text WHERE oid=NEW.oid;RETURN NEW;END$$;
      ${timing==='deferred'?'CREATE CONSTRAINT TRIGGER gain_acceptance_tamper AFTER INSERT ON store_order_status DEFERRABLE INITIALLY DEFERRED':'CREATE TRIGGER gain_acceptance_tamper AFTER INSERT ON store_order_status'} FOR EACH ROW EXECUTE FUNCTION gain_acceptance_tamper();`);
    const result=await s.request('PUT',`/adminapi/order/update/${order.id}`,{...form.data.values,pay_price:'18.75',gain_integral:17,revision:form.data.revision});
    expect(result.status,result.msg).toBe(409);expect(await s.snapshot()).toEqual(before);
  }),120000);

  it('rejects a stale form after independent purchase changes and a withdrawn manager',async()=>withEditScenario(async s=>{
    await s.seed();const form=await s.request('GET','/adminapi/order/edit/820001',undefined,s.token('manager'));
    await s.f.db.update(storeOrder).set({remark:'changed independently'}).where(eq(storeOrder.id,820001));
    const before=await s.snapshot(),body={...form.data.values,pay_price:'1.00',revision:form.data.revision};
    expect((await s.request('PUT','/adminapi/order/update/820001',body,s.token('manager'))).status).toBe(409);expect(await s.snapshot()).toEqual(before);
    await s.f.db.update(systemRole).set({rules:'order.view'}).where(eq(systemRole.id,820001));const withdrawn=await s.snapshot();
    for(const token of [s.token('manager'),s.token('viewer'),s.token('disabled'),s.token('supplier'),null]){
      for(const method of ['GET','PUT']){const reply=await s.request(method,`/adminapi/order/${method==='GET'?'edit':'update'}/820001`,method==='PUT'?body:undefined,token);
        expect(reply.status).not.toBe(200);expect(reply.headers.get('cache-control')).toContain('no-store');}
    }
    expect(await s.snapshot()).toEqual(withdrawn);
  }),120000);

  it('rejects invalid edited grants, paid orders and missing fields without partial writes',async()=>withEditScenario(async s=>{
    await s.seed();const form=await s.request('GET','/adminapi/order/edit/820001'),before=await s.snapshot();
    for(const patch of [{gain_integral:'-1'},{gain_integral:'0.50'},{pay_price:'1.001'},{pay_price:'1e2'},{gain_integral:undefined}]){
      expect((await s.request('PUT','/adminapi/order/update/820001',{...form.data.values,...patch})).status).not.toBe(200);expect(await s.snapshot()).toEqual(before);
    }
    await s.f.db.update(storeOrder).set({paid:1}).where(eq(storeOrder.id,820001));const paid=await s.snapshot();
    expect((await s.request('PUT','/adminapi/order/update/820001',{...form.data.values,pay_price:'1'})).status).not.toBe(200);expect(await s.snapshot()).toEqual(paid);
  }),120000);

  it('audits both complete profiles and refuses extra App root-append authority or missing financial grants without repair',async()=>withEditScenario(async s=>{
    const names={...s.roles,maintenance:'finance_test'};
    for(const kind of ['app','admin'] as const)expect(await auditRuntimeBusinessPrivileges(s.databases[kind],kind,names)).toMatchObject({ready:true,failures:[]});
    await s.f.exec(`GRANT INSERT ON admin_order_edit_operation_v1 TO "${s.roles.app}"`);
    expect((await auditRuntimeBusinessPrivileges(s.databases.app,'app',names)).ready).toBe(false);
    await s.f.exec(`REVOKE INSERT ON admin_order_edit_operation_v1 FROM "${s.roles.app}"; REVOKE INSERT ON admin_order_gain_partition_v1 FROM "${s.roles.app}"`);
    expect((await auditRuntimeBusinessPrivileges(s.databases.admin,'admin',names)).ready).toBe(false);
    await expect(withTx(createContainerFromDb(s.f.db),tx=>installAdminOrderEditRuntime(tx,{admin:s.roles.admin,financial:[s.roles.app]}))).rejects.toThrow('grants require review');
    expect(await s.f.exec(`SELECT has_table_privilege('${s.roles.app}','admin_order_gain_partition_v1','INSERT') AS writable`)).toEqual([{writable:false}]);
  }),120000);
  it('stages PHP SMS and inbox once from the actual Admin receipt and keeps an obsolete equal-price request inactive', async () => withEditScenario(async s => {
    await s.seed();
    await s.f.db.update(storeOrder).set({payPrice:'10.00',totalPrice:'10.00',userPhone:'00000000000'}).where(eq(storeOrder.id,820001));
    await s.f.db.delete(systemNotification).where(eq(systemNotification.mark,'price_revision'));
    await s.f.db.insert(systemNotification).values({mark:'price_revision',isSms:1,isSystem:1,isWechat:1,isRoutine:1,
      smsId:'OWNED_PRICE_REVISION',systemTitle:'订单{order_id}改价',systemText:'请支付{pay_price}元'});
    const consumer=new OrderOutboxService(createContainerFromDb(s.databases.app),{...s.f.env,ORDER_QUEUE:{send:async()=>{throw Error('Unexpected queue send in price notification fixture');},sendBatch:async()=>{throw Error('Unexpected queue batch in price notification fixture');},metrics:async()=>{throw Error('Unexpected queue metrics in price notification fixture');}}} as typeof s.f.env);
    const save=async(price:string)=>{
      const form=await s.request('GET','/adminapi/order/edit/820001');
      const result=await s.request('PUT','/adminapi/order/update/820001',{...form.data.values,pay_price:price});expect(result.status,result.msg).toBe(200);
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
