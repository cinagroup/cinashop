import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Env, AppVariables } from '../../src/env';
import {createContainerFromDb} from '../../src/lib/di';
import * as schema from '../../src/models/schema';
import { customerOriginalPaymentRuntimeFixture } from './customerOriginalPaymentRuntimeFixture';
import { requireStoreManagerScope, merchantOrderRevision } from '../../src/services/store/StoreManagerScope';
import { MANAGER_OPERATION_VERSION, type ManagerOperationInput } from '../../src/services/store/ManagerOrderOperationRequest';
import {authorizeCustomerWorkActor,type CustomerWorkActor} from '../../src/services/customer-work/CustomerWorkScope';
import {createCustomerCashierSecondCardWithRuntime,applyCustomerCashierCashPayment} from '../../src/services/customer-work/CustomerWorkCashierService';
import {OrderOutboxService} from '../../src/services/order/OrderOutboxService';
import { errorHandler } from '../../src/middleware/error';
import { v1Routes } from '../../src/routes/v1';
import { createToken, md5 } from '../../src/utils/jwt';

export type OfflineNativeProducer = 'manager' | 'admin';
/** Canonical owned PG16. Ordinary App authenticates and creates assisted roots;
 * independent full Admin/fixed Manager produce genuine offline payments. Fixed
 * Financial only reads their immutable sources and owns refund operations.
 * A distinct cashier producer retains its own published source privileges. */
export async function customerWorkOfflineOriginRefundFixture() {
  const f = await customerOriginalPaymentRuntimeFixture();
  const close=f.close,application=createContainerFromDb(f.appRuntime.db);
  let sequence=0;
  try {
    const managerRuntime = f.managerRuntime, adminRuntime = f.adminRuntime;
    const env: Env = { ...f.env, APP_KEY: 'original-payment-native-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
      ORDER_QUEUE: { send: async () => {}, sendBatch: async () => {} } as unknown as Env['ORDER_QUEUE'],
      HYPERDRIVE: { connectionString: f.appRuntime.connectionString } as Env['HYPERDRIVE'],
      HYPERDRIVE_CUSTOMER_FINANCIAL: { connectionString: f.connectionString } as Env['HYPERDRIVE_CUSTOMER_FINANCIAL'],
      HYPERDRIVE_MANAGER: { connectionString: managerRuntime.connectionString } as Env['HYPERDRIVE'],
      HYPERDRIVE_ADMIN: { connectionString: adminRuntime.connectionString } as Env['HYPERDRIVE_ADMIN'],
      SEQUENCE: {
      idFromName: () => ({}), get: () => ({ fetch: async () => new Response(`modern-offline-${++sequence}`) }),
    } as unknown as Env['SEQUENCE'] };
    const managerActor = () => ({ uid: 103, authVersion: md5('owned-financial-password'), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    const order = async (id: number) => (await f.db.select().from(schema.storeOrder).where(eq(schema.storeOrder.id, id)))[0];
    const managerInput = async (id: number): Promise<ManagerOperationInput> => {
      const current = await order(id), scope = await requireStoreManagerScope(managerRuntime.db, 103, 1);
      return { version: MANAGER_OPERATION_VERSION, store_id: 1, scope_key: scope.scope_key, order_id: id,
        expected_order_revision: await merchantOrderRevision(current), payload: {} };
    };
    const app = () => {
      const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
      app.use('*', async (c, next) => { c.set('container', application); await next(); });
      app.onError(errorHandler); app.route('/api', v1Routes); return app;
    };
    interface HttpBody { status: number; msg: string; data: unknown }
    const request = async (path: string, body: unknown, actor: number, realm: 'admin' | 'api', key?: string, bindings = env) => {
      const password = realm === 'admin' ? 'offline-native-admin-password' : 'owned-financial-password';
      const token = (await createToken(actor, realm, md5(password), env.APP_KEY)).token;
      const response = await app().request('/api' + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, bindings);
      return { response, body: await response.json() as HttpBody };
    };
    const adminOffline = async (id: number, actor = 1, realm: 'admin' | 'api' = 'admin') => {
      const current = await order(id);
      return request('/admin/order/offline', { order_id: current.orderId }, actor, realm);
    };
    const managerOffline = (input: ManagerOperationInput, key = crypto.randomUUID(), actor = 103, realm: 'api' | 'admin' = 'api', bindings = env) =>
      request('/store/manager/order/financial/offline', input, actor, realm, key, bindings);
    const reset = async () => {
      const tables = ['customer_financial_operation_request','customer_financial_manual_refund_v1','manager_order_operation_request',
        'cashier_second_card_cart_v1','cashier_second_card_origin_v1','cashier_second_card_payment_v1','cashier_second_card_abandon_v1',
        'customer_writeoff_operation_request','store_order_purchase_origin','store_order_purchase_physical_origin','store_order_purchase_cancellation',
        'store_order_invoice','store_order_invoice_evidence','store_order_invoice_allocation','store_order_refund_split','store_order_fulfillment_branch',
        'store_order_refund_payment','store_order_refund','store_order_status','store_order_outbox','store_order_cart_info','store_product_reply','store_order_writeoff',
        'offline_order_balance','offline_order_external_payment','store_order_economize','store_order_promotions','store_order','store_cart','user_bill','user_brokerage','supplier_flowing_water','supplier_transactions'];
      await f.maintenanceDb.transaction(async tx => {
        const [authority] = await tx.execute<{ready:boolean}>(sql`SELECT current_database()=${f.database} AND current_user='finance_test' AND current_user=session_user
          AND (SELECT count(*)=${tables.length} AND bool_and(relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
            FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN(${sql.join(tables.map(name=>sql`${name}`),sql`, `)})) AS ready`);
        if(authority?.ready!==true)throw Error('Original payment reset requires exact owned maintenance tables');
        const dependencies=await tx.execute(sql`SELECT conrelid::regclass::text AS child,confrelid::regclass::text AS parent
          FROM pg_constraint WHERE contype='f'
          AND confrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace
            AND relname IN(${sql.join(tables.map(name=>sql`${name}`),sql`, `)}))
          AND conrelid NOT IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace
            AND relname IN(${sql.join(tables.map(name=>sql`${name}`),sql`, `)}))`);
        if(dependencies.length)throw Error('Unlisted canonical reset dependencies: '+JSON.stringify(dependencies));
        for(const name of tables)await tx.execute(sql.raw(`ALTER TABLE public."${name}" DISABLE TRIGGER USER`));
        // All named tables are now locked in this same transaction. Keep each
        // real foreign-key component together, while avoiding one large reset
        // statement exhausting the unchanged per-statement maintenance budget.
        // PostgreSQL still checks FK closure; no CASCADE or partial cleanup.
        const links=await tx.execute<{child:string;parent:string}>(sql`SELECT child.relname AS child,parent.relname AS parent
          FROM pg_constraint fk JOIN pg_class child ON child.oid=fk.conrelid JOIN pg_class parent ON parent.oid=fk.confrelid
          WHERE fk.contype='f' AND child.relnamespace='public'::regnamespace AND parent.relnamespace='public'::regnamespace
          AND child.relname IN(${sql.join(tables.map(name=>sql`${name}`),sql`, `)})
          AND parent.relname IN(${sql.join(tables.map(name=>sql`${name}`),sql`, `)})`);
        const graph=new Map(tables.map(name=>[name,new Set<string>()]));
        for(const link of links){graph.get(link.child)!.add(link.parent);graph.get(link.parent)!.add(link.child);}
        const remaining=new Set(tables);
        for(const name of tables){
          if(!remaining.delete(name))continue;
          const pending=[name],component:string[]=[];
          while(pending.length){
            const next=pending.pop()!;component.push(next);
            for(const related of graph.get(next)!)if(remaining.delete(related))pending.push(related);
          }
          await tx.execute(sql.raw('TRUNCATE '+component.map(table=>`public."${table}"`).join(',')+' RESTART IDENTITY'));
        }
        for(const name of tables)await tx.execute(sql.raw(`ALTER TABLE public."${name}" ENABLE TRIGGER USER`));
      });
      await f.maintenanceDb.insert(schema.user).values([101,102,103,104,105].map(uid=>({uid,account:'original-actor-'+uid,pwd:'owned-financial-password',status:1}))).onConflictDoNothing();
      await f.maintenanceDb.update(schema.user).set({pwd:'owned-financial-password',status:1,isDel:0,deleteTime:null,nowMoney:'100.00',integral:100,payCount:0,exp:'0.00',brokeragePrice:'0.00'})
        .where(sql`${schema.user.uid} IN(11,101,102,103,104,105)`);
      await f.maintenanceDb.delete(schema.storeService);
      await f.maintenanceDb.insert(schema.storeService).values([{id:1,uid:101,customer:1,accountStatus:1,status:0},{id:2,uid:102,customer:1,accountStatus:1,status:1}]);
      await f.maintenanceDb.delete(schema.systemStoreStaff);
      await f.maintenanceDb.insert(schema.systemStoreStaff).values([{id:901,uid:103,storeId:1,status:1,isManager:1,orderStatus:1},{id:902,uid:104,storeId:1,status:1,verifyStatus:1}]);
      await f.maintenanceDb.delete(schema.systemAdmin);
      await f.maintenanceDb.insert(schema.systemAdmin).values({id:1,account:'offline-native-admin',pwd:'offline-native-admin-password',adminType:1,level:0,status:1,isDel:0,roles:''});
      await f.maintenanceDb.update(schema.systemStore).set({isStore:1,isShow:1,isDel:0}).where(eq(schema.systemStore.id,1));
      await f.maintenanceDb.update(schema.storeProduct).set({type:0,relationId:0,systemFormId:0,productType:0,isPresaleProduct:0,stock:100,sales:0,freight:2,tempId:0,postage:'0.00',giveIntegral:'0.00',isSub:0}).where(eq(schema.storeProduct.id,70));
      await f.maintenanceDb.update(schema.storeProductAttrValue).set({stock:100,sales:0,price:'7.00',vipPrice:'7.00',settlePrice:'0.00',cost:'0.00',brokerage:'0.00',writeTimes:3,writeValid:1,writeDays:0,writeStart:0,writeEnd:0}).where(eq(schema.storeProductAttrValue.id,1));
      const zero=['first_order_status','newcomer_status','member_func_status','member_card_status','svip_price_status','order_give_integral','order_give_exp','brokerage_func_status','store_brokerage_statu'];
      await f.setConfig({...Object.fromEntries(zero.map(key=>[key,'0'])),store_func_status:'1',store_self_mention:'1',offline_pay_status:'1',refund_time_available:'0'});
      for(const [key,value]of [...zero.map(key=>[key,'0']),['offline_pay_status','1'],['balance_func_status','1'],['yue_pay_status','1'],['refund_time_available','0']]){
        await f.maintenanceDb.delete(schema.systemConfig).where(eq(schema.systemConfig.menuName,key));await f.maintenanceDb.insert(schema.systemConfig).values({menuName:key,value});
      }
      await f.exec("SELECT setval(pg_get_serial_sequence('public.store_order','id'),100,true),setval(pg_get_serial_sequence('public.store_order_cart_info','id'),100,true)");
    };
    const unpaid = async (buyer = 11, price = '7.00', quantity = 3) => {
      await f.maintenanceDb.update(schema.storeProductAttrValue).set({ price }).where(eq(schema.storeProductAttrValue.id, 1));
      const tourist = buyer ? '' : 'modern_offline_guest';
      const added = await request('/admin/order/cart/add/' + buyer, { tourist_uid: tourist, productId: 70, uniqueId: 'qared001', cartNum: quantity, new: 1 }, 1, 'admin');
      if (added.body.status !== 200) throw Error('Actual assisted cart route rejected: ' + added.body.msg);
      const cart = added.body.data as { cartId: string };
      const selection = { cartId: [cart.cartId], tourist_uid: tourist, new: 1, shipping_type: 2, store_id: 1, real_name: '原生线下退款来源',
        // Assisted checkout accepts the published cash selection. This only
        // creates an unpaid root; the actual manager/Admin offline producer
        // below owns the paid transition and the root's final payment method.
        phone: '00000000000', payType: 'cash', useIntegral: false, couponId: 0, from: 'pc' };
      const confirmed = await request('/admin/order/confirm/' + buyer, selection, 1, 'admin');
      if (confirmed.body.status !== 200) throw Error('Actual assisted confirmation route rejected: ' + confirmed.body.msg);
      const quote = confirmed.body.data as { orderKey: string; quoteToken: string };
      const submitted = await request('/admin/order/create/' + quote.orderKey + '/' + buyer, { ...selection, quoteToken: quote.quoteToken }, 1, 'admin');
      if (submitted.body.status !== 200) throw Error('Actual assisted creation route rejected: ' + submitted.body.msg);
      const created = (submitted.body.data as { result: { order_id: string } }).result;
      const current = await f.container.storeOrderDao.findByOrderId(created.order_id);
      if (!current || current.paid !== 0 || current.uid !== buyer || current.staffId !== 1) throw Error('Actual assisted creation did not persist the unpaid scoped root');
      return { order: current, cart, quote, created };
    };
    const paid = async (producer: OfflineNativeProducer, buyer = 11, price = '7.00', quantity = 3, delayMs = 0) => {
      const source = await unpaid(buyer, price, quantity);
      const key = crypto.randomUUID(), input = producer === 'manager' ? await managerInput(source.order.id) : null;
      const result = producer === 'manager' ? await managerOffline(input!, key) : await adminOffline(source.order.id);
      if (result.body.status !== 200) throw Error('Actual offline producer did not complete its payment: ' + result.body.msg);
      const events = await f.db.select().from(schema.storeOrderOutbox).where(sql`${schema.storeOrderOutbox.aggregateId}=${source.order.id} AND ${schema.storeOrderOutbox.eventType}='order.paid'`);
      if (events.length !== 1) throw Error('Actual offline producer did not persist one original paid event');
      if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 5000) throw Error('Invalid owned consumer delay');
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      const consumed = await consume({ id: events[0].id, eventKey: events[0].eventKey });
      return { ...source, producer, key, input, result, order: await order(source.order.id), event: events[0], ...consumed };
    };
    const actor = (uid=101):CustomerWorkActor=>({uid,auth_version:md5('owned-financial-password'),expires_at:Math.floor(Date.now()/1000)+3600});
    const consume=async(outbox:{id:number;eventKey:string})=>{
      const consumer=new OrderOutboxService(application,env),message={action:'processOrderPaidOutbox' as const,outboxId:outbox.id,eventKey:outbox.eventKey};
      if(await consumer.processMessage(message)!=='completed')throw Error('Actual App paid consumer did not complete');return{consumer,message};
    };
    const cashier=async(buyer=11,price='7.00',quantity=2)=>{
      await f.maintenanceDb.update(schema.storeProduct).set({productType:4}).where(eq(schema.storeProduct.id,70));
      await f.maintenanceDb.update(schema.storeProductAttrValue).set({price,writeTimes:3}).where(eq(schema.storeProductAttrValue.id,1));
      const container=createContainerFromDb(f.cashierRuntime.db),scope=await authorizeCustomerWorkActor(f.cashierRuntime.db,actor());
      const created=await createCustomerCashierSecondCardWithRuntime(container,{...env,nextOrderId:async()=>`original-cashier-${++sequence}`},actor(),
        {request_key:crypto.randomUUID(),version:'customer-cashier-second-card-v1',scope_key:scope.scope_key,buyer_uid:buyer,tourist_key:buyer?'':'original-guest-cashier',product_id:70,sku_unique:'qared001',quantity,
          real_name:buyer?'原生现金用户':'原生游客',user_phone:'00000000000',mark:'',custom_form:[],coupon_id:0,use_integral:false});
      const current=await container.storeOrderDao.findByOrderId(created.orderId);if(!current)throw Error('Actual cashier source root absent');
      const payment=await applyCustomerCashierCashPayment(container,actor(),{request_key:crypto.randomUUID(),version:'customer-cashier-second-card-payment-v1',scope_key:scope.scope_key,order_id:current.id,order_no:current.orderId,expected_amount:current.payPrice});
      if(!payment.outbox)throw Error('Actual separate cashier payment outbox absent');
      return{order:await order(current.id),created,payment,...await consume(payment.outbox)};
    };
    await reset();
    return { ...f, env, close, reset, actor, cashier, consume, unpaid, paid, order, manager: managerRuntime, admin: adminRuntime, managerActor, managerInput, adminOffline, managerOffline, request };
  } catch (error) { await close(); throw error; }
}
