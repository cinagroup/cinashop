import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {asc,eq,sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {randomUUID} from 'node:crypto';
import {customerCashierOrdinaryFixture} from './helpers/customerCashierOrdinaryFixture';
import {storeCart,storeOrder,storeOrderCartInfo,storeOrderStatus,storeOrderOutbox,storeProduct,storeProductAttrValue,storeCouponIssue,storeCouponUser,storeService,systemAttachment,user,userBill,userBrokerage} from '../src/models/schema';
import {outRequestHash} from '../src/services/out/OutIdempotency';
import {cashierOrdinaryReadiness} from '../src/migrations/runCashierOrdinary';
import {readCashierOrdinaryOrigin,readCashierOrdinaryPaidOrigin} from '../src/services/order/CashierOrdinaryOrigin';
import {manualRefundPaymentFacts} from '../src/services/order/CustomerManualRefund';
import {createContainerFromDb,type DbClient} from '../src/lib/di';
import {CustomerWorkOrdinaryCashierService} from '../src/services/customer-work/CustomerWorkOrdinaryCashierService';
import {storePromotions,storePromotionsAuxiliary,storeOrderPromotionGiftCouponReward,userLabel,userLabelRelation,systemForm,systemFormData,memberRight,systemUserLevel,storeProductCategory} from '../src/models/schema';
import {readOrderSystemFormForOrder} from '../src/services/order/OrderSystemFormService';
import {AttachmentService} from '../src/services/system/AttachmentService';
import {Hono} from 'hono';
import type {Env,AppVariables} from '../src/env';
import {authMiddleware} from '../src/middleware/auth';
import {errorHandler} from '../src/middleware/error';
import {createToken,md5} from '../src/utils/jwt';
import * as ordinaryHttp from '../src/controllers/api/v1/CustomerWorkOrdinaryCashierController';
import {OrderOutboxService} from '../src/services/order/OrderOutboxService';
import {storeBrand,systemConfig} from '../src/models/schema';

/** Whole native PG16 file. Positive orders use genuine draft, quote, checkout
 * and stock claims; positive payment provenance requires the real paid consumer.
 * The maintenance connection only creates source fixtures and exercises drift. */
describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('ordinary type0 multi SKU cashier genuine PG16',{timeout:30000},()=>{
 let f:Awaited<ReturnType<typeof customerCashierOrdinaryFixture>>;
 beforeAll(async()=>{f=await customerCashierOrdinaryFixture();},180000);
 beforeEach(async()=>{await f.reset();});afterAll(async()=>{await f?.close();},30000);
 const count=async(table:string)=>Number((await f.db.execute<{n:number}>(sql.raw(`SELECT count(*)::int AS n FROM public.${table}`)))[0].n);
 const facts=async()=>({carts:await f.db.select().from(storeCart).orderBy(asc(storeCart.id)),orders:await f.db.select().from(storeOrder).orderBy(asc(storeOrder.id)),
  lines:await f.db.select().from(storeOrderCartInfo).orderBy(asc(storeOrderCartInfo.id)),skus:await f.db.select().from(storeProductAttrValue).orderBy(asc(storeProductAttrValue.id)),
  audits:await f.db.select().from(storeOrderStatus).orderBy(asc(storeOrderStatus.id)),events:await f.db.select().from(storeOrderOutbox).orderBy(asc(storeOrderOutbox.id)),
  ledger:await f.db.execute(sql`SELECT * FROM public.cashier_ordinary_operation_v1 ORDER BY actor_uid,request_key`)});
 const original=async(id:number)=>{const r=await f.actual(id);return readCashierOrdinaryPaidOrigin(f.db,r.order,r.carts);};
 const service=(db:DbClient)=>new CustomerWorkOrdinaryCashierService(createContainerFromDb(db),f.env,f.runtime);
 const base='/api/mobile/work/cashier/ordinary';
 function app(){const h=new Hono<{Bindings:Env;Variables:AppVariables}>();h.use('*',async(c,next)=>{c.set('container',f.container);await next();});h.use('*',authMiddleware({force:true}));h.onError(errorHandler);
  h.post(base+'/drafts',ordinaryHttp.draft);h.get(base+'/drafts/:key',ordinaryHttp.draftRead);h.post(base+'/drafts/:key/rows',ordinaryHttp.rows);h.post(base+'/drafts/:key/quantity',ordinaryHttp.quantity);h.post(base+'/drafts/:key/remove',ordinaryHttp.remove);
  h.post(base+'/quote',ordinaryHttp.quote);h.post(base+'/orders',ordinaryHttp.create);h.post(base+'/orders/:id/cash',ordinaryHttp.cash);h.get(base+'/operations/:key',ordinaryHttp.operation);h.post(base+'/operations/:key/abandon',ordinaryHttp.abandon);
  h.get(base+'/readiness',ordinaryHttp.readiness);h.get(base+'/catalog',ordinaryHttp.catalog);h.get(base+'/catalog/:id',ordinaryHttp.selection);h.get(base+'/users',ordinaryHttp.users);h.get(base+'/users/:uid/addresses',ordinaryHttp.addresses);h.get(base+'/quotes/:token/coupons',ordinaryHttp.coupons);return h;}
 async function http(path:string,body?:unknown,key?:string,realm:'api'|'admin'='api',headers:Record<string,string>={}){const token=(await createToken(101,realm,md5('owned-financial-password'),f.env.APP_KEY)).token;
  const response=await app().request(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'}),...(key?{'Idempotency-Key':key}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})},f.env);
  return{response,body:await response.json() as {status:number;msg:string;data:any}};}
 async function labels(){const now=Math.floor(Date.now()/1000);await f.maintenanceDb.insert(userLabel).values({id:31,name:'真实成交标签',type:0,relationId:0,status:1});
  await f.maintenanceDb.insert(storePromotions).values({id:61,type:1,storeId:0,promotionsType:4,promotionsCate:2,name:'真实成交积分标签',thresholdType:1,threshold:'10.00',giveIntegral:3,productPartakeType:1,labelId:'31',startTime:now-3600,stopTime:now+86400,status:1});}
 const observed=<T extends Promise<unknown>>(p:T):T=>{void p.catch(()=>undefined);return p;};
 function heldRequest(db:DbClient){let release!:()=>void,entered!:()=>void,paused=false;
  const gate=new Promise<void>(r=>release=r),arrived=new Promise<void>(r=>entered=r),dialect=new PgDialect();
  const wrap=(inner:DbClient):DbClient=>new Proxy(inner,{get(target,key,receiver){const method=Reflect.get(target,key,receiver);if(typeof method!=='function')return method;
   if(key==='transaction')return(callback:(tx:DbClient)=>Promise<unknown>,...args:unknown[])=>Reflect.apply(method,target,[(tx:DbClient)=>callback(wrap(tx)),...args]);
   if(key!=='execute')return method.bind(target);return async(query:SQL,...args:unknown[])=>{const result=await Reflect.apply(method,target,[query,...args]),q=dialect.sqlToQuery(query);
    if(!paused&&q.sql.includes('pg_advisory_xact_lock(731735,')){paused=true;entered();await gate;}return result;};}});
  return{db:wrap(db),release,arrive:async()=>{let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([arrived,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Actual original ordinary request lock was not acquired')),5000);})]);}
   finally{if(timer)clearTimeout(timer);}}};
 }
 async function actualWait(pid:number){const until=Date.now()+1000;while(Date.now()<until){const[row]=await f.maintenanceDb.execute<{waiting:boolean}>(sql`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid=${pid} AND datname=current_database() AND wait_event_type='Lock') AS waiting`);
   if(row.waiting)return;await new Promise(r=>setTimeout(r,10));}throw Error('Actual original request peer never entered its PG lock wait');}
  function heldCreationReceipt(db:DbClient,actorUid:number,keyValue:string){
   type Proof={order_id:number;orders:number;origins:number;receipts:number};
   let release!:()=>void,entered!:(proof:Proof)=>void,paused=false;
   const gate=new Promise<void>(r=>release=r),arrived=new Promise<Proof>(r=>entered=r),dialect=new PgDialect();
   const wrap=(inner:DbClient):DbClient=>new Proxy(inner,{get(target,key,receiver){const method=Reflect.get(target,key,receiver);if(typeof method!=='function')return method;
    if(key==='transaction')return(callback:(tx:DbClient)=>Promise<unknown>,...args:unknown[])=>Reflect.apply(method,target,[(tx:DbClient)=>callback(wrap(tx)),...args]);
    if(key!=='execute')return method.bind(target);return async(query:SQL,...args:unknown[])=>{const result=await Reflect.apply(method,target,[query,...args]),q=dialect.sqlToQuery(query);
     if(!paused&&q.sql.includes('INSERT INTO public.cashier_ordinary_operation_v1(')&&q.params[2]==='creation'){
      expect(q.params[0]).toBe(actorUid);expect(q.params[1]).toBe(keyValue);
      const orderId=Number(q.params[6]);expect(Number.isSafeInteger(orderId)&&orderId>0).toBe(true);
      const [proof]=await Reflect.apply(method,target,[sql`SELECT ${orderId}::int AS order_id,
       (SELECT count(*)::int FROM public.store_order WHERE id=${orderId}) AS orders,
       (SELECT count(*)::int FROM public.cashier_ordinary_origin_v1 WHERE order_id=${orderId} AND actor_uid=${actorUid} AND request_key=${keyValue}::uuid) AS origins,
       (SELECT count(*)::int FROM public.cashier_ordinary_operation_v1 WHERE order_id=${orderId} AND actor_uid=${actorUid} AND request_key=${keyValue}::uuid AND kind='creation') AS receipts`]) as Proof[];
      expect(proof).toEqual({order_id:orderId,orders:1,origins:1,receipts:1});paused=true;entered(proof);await gate;
     }return result;};}});
   return{db:wrap(db),release,arrive:async()=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([arrived,new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>reject(Error('Actual creation receipt INSERT was not completed before COMMIT')),5000);})]);}finally{if(timer)clearTimeout(timer);}}};
  }
 it('materializes all real type0 SKU rows and claims their distinct stock once',async()=>{
  const r=await f.create();expect(r.order).toMatchObject({uid:11,productType:0,type:0,isChannel:2,staffId:101,shippingType:2,storeId:0,paid:0,payPrice:'17.00',totalNum:3});
  expect(r.quote.data.quote_fingerprint).toBe(r.result.receipt.evidence.quote_fingerprint);
  expect(r.quote.data.pricing.quantity).toBe(r.order.totalNum);
  const actual=await f.actual(r.order.id);expect(actual.carts).toHaveLength(2);expect(actual.carts.map(c=>c.cartNum)).toEqual([2,1]);
  const skus=await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId,70)).orderBy(asc(storeProductAttrValue.id));
  expect(skus.map(s=>s.stock)).toEqual([98,99]);expect(await count('cashier_ordinary_origin_v1')).toBe(1);expect(await count('store_order_purchase_origin')).toBe(1);
 });
 it('appends/merges/restores real owner cart rows and rejects a stale hash with all side effects unchanged',async()=>{
  const d=await f.draft(),row=d.rows[1],removed=await f.service.remove(f.actor(),randomUUID(),{version:d.intent.version,scope_key:d.intent.scope_key,draft_key:d.key,draft_hash:d.intent.draft_hash,cart_ids:[row.cart_id]});
  const current=removed.receipt.evidence.draft as {draft_hash:string},appendKey=randomUUID(),input={version:d.intent.version,scope_key:d.intent.scope_key,draft_key:d.key,draft_hash:current.draft_hash,rows:[{product_id:70,sku_unique:'qablue02',quantity:4}]};
  const appended=await f.service.rows(f.actor(),appendKey,input);expect(appended.receipt.evidence.outcome).toBe('rows-appended');
  const restored=await f.db.select().from(storeCart).where(eq(storeCart.id,row.cart_id));expect(restored[0]).toMatchObject({cartNum:4,isDel:0,isPay:0,staffId:101,uid:11});
  const before=await facts();await expect(f.service.rows(f.actor(),randomUUID(),input)).rejects.toThrow('已变化');expect(await facts()).toEqual(before);
  expect((await f.service.rows(f.actor(),appendKey,input)).replayed).toBe(true);expect(await facts()).toEqual(before);
 });
 it('rolls back a multi SKU draft when one genuine selection is short of stock',async()=>{
  await f.maintenanceDb.update(storeProductAttrValue).set({stock:0}).where(eq(storeProductAttrValue.id,2));const before=await facts();
  await expect(f.draft()).rejects.toThrow('规格');expect(await facts()).toEqual(before);expect(await count('cashier_ordinary_draft_v1')).toBe(0);
 });
 it('does not let a foreign operator cart id inherit the current draft owner',async()=>{
  const d=await f.draft();const[foreign]=await f.maintenanceDb.insert(storeCart).values({uid:11,staffId:102,productId:70,productAttrUnique:'qared001',cartNum:1,isNew:1}).returning();
  const before=await facts();await expect(f.service.quantity(f.actor(),randomUUID(),{version:d.intent.version,scope_key:d.intent.scope_key,draft_key:d.key,draft_hash:d.intent.draft_hash,cart_id:foreign.id,quantity:3})).rejects.toThrow('原购物行');
  expect(await facts()).toEqual(before);
 });
 it('requires another actual quote after the SKU price changes and leaves the draft unconsumed',async()=>{
  const d=await f.draft(),key=randomUUID(),quote=await f.service.quote(f.actor(),key,d.intent);
  await f.maintenanceDb.update(storeProductAttrValue).set({price:'6.00'}).where(eq(storeProductAttrValue.id,1));const before=await facts();
  await expect(f.service.create(f.actor(),key,d.intent,quote.data.quote_token)).rejects.toThrow('重新');expect(await facts()).toEqual(before);
  expect((await f.service.operation(f.actor(),key)).receipt).toBeNull();
 });
 it('uses the mature member coupon and integral calculation, reserving the real owner coupon',async()=>{
  await f.maintenanceDb.insert(storeCouponIssue).values({id:50,couponTitle:'真实普通订单券',couponPrice:'3.00',useMinPrice:'0.00',type:1,couponType:0,isPermanent:1,isDel:0,status:1});
  await f.maintenanceDb.insert(storeCouponUser).values({id:50,uid:11,issueCouponId:50,couponTitle:'真实普通订单券',couponPrice:'3.00',useMinPrice:'0.00',type:1,status:0});
  const r=await f.create({coupon_id:50,use_integral:true});expect(r.quote.data.pricing).toMatchObject({coupon_discount:'3.00',integral_discount:'0.50',used_integral:50,amount:'13.50'});
  const[coupon]=await f.db.select().from(storeCouponUser).where(eq(storeCouponUser.id,50));expect(coupon.status).toBe(3);
  const paid=await f.cash(r.order);expect(paid.receipt.evidence.outcome).toBe('cash-paid');expect(await f.processPaid(r.order.id)).toBe('completed');
  const[account]=await f.db.select().from(user).where(eq(user.uid,11));expect(account.integral).toBe(50);
  const[used]=await f.db.select().from(storeCouponUser).where(eq(storeCouponUser.id,50));expect(used.status).toBe(1);
 });
 it('quotes genuine address-dependent postage and creates from the owned book address',async()=>{
  await f.maintenanceDb.update(storeProduct).set({freight:3,tempId:10}).where(eq(storeProduct.id,70));
  const r=await f.create({shipping_type:1,address_id:11,real_name:'',user_phone:''});expect(r.quote.data.pricing.postage).toBe('7.00');expect(r.order.payPrice).toBe('24.00');
  expect(r.order).toMatchObject({shippingType:1,realName:'本地地址甲',userPhone:'00000000000',userAddress:'本地省 测试甲市 测试甲区 隔离样本一号'});
 });
 it('creates a real manual delivery guest without creating UID0 or any UID0 money/points ledger',async()=>{
  await f.maintenanceDb.update(storeProduct).set({giveIntegral:'8.00'}).where(eq(storeProduct.id,70));
  const r=await f.create({shipping_type:1,manual_address:{realName:'实际游客',phone:'00000000000',province:'本地省',city:'测试甲市',district:'测试甲区',street:'',detail:'隔离游客门牌',cityId:101}},
   {buyer_uid:0,tourist_key:'actual-ordinary-guest'});expect(r.quote.data.pricing.gives_integral).toBe(0);expect(r.order).toMatchObject({uid:0,gainIntegral:'0.00',staffId:101});
  await f.cash(r.order);expect(await f.processPaid(r.order.id)).toBe('completed');expect((await original(r.order.id)).origin.buyer_uid).toBe(0);
  expect(await f.db.select().from(user).where(eq(user.uid,0))).toEqual([]);expect(await f.db.select().from(userBill).where(eq(userBill.uid,0))).toEqual([]);expect(await f.db.select().from(userBrokerage).where(eq(userBrokerage.uid,0))).toEqual([]);
  const actual=await f.actual(r.order.id);expect((await manualRefundPaymentFacts(f.db,actual.order)).origin_hash).toBe((await original(r.order.id)).origin_hash);
 });
 it('recovers the original creation UUID without another cart or stock claim and rejects a changed body',async()=>{
  const r=await f.create(),before=await facts(),replay=await f.service.create(f.actor(),r.key,r.intent,'expired-token');expect(replay.replayed).toBe(true);expect(replay.receipt).toEqual(r.result.receipt);expect(await facts()).toEqual(before);
  await expect(f.service.create(f.actor(),r.key,{...r.intent,mark:'不同内容'},r.quote.data.quote_token)).rejects.toThrow('绑定其他内容');expect(await facts()).toEqual(before);
 });
 it('requires the real paid consumer for manual financial provenance and preserves global payer authority',async()=>{
  const r=await f.create();await f.maintenanceDb.update(storeService).set({customer:1}).where(eq(storeService.uid,102));
  const paid=await f.cash(r.order,102);expect(paid.receipt.evidence.payment).toMatchObject({creator_uid:101,payer_uid:102,buyer_uid:11,amount:'17.00'});
  await expect(original(r.order.id)).rejects.toThrow('无法核对');expect(await f.processPaid(r.order.id)).toBe('completed');expect((await original(r.order.id)).origin.creator_uid).toBe(101);
  const actual=await f.actual(r.order.id);expect((await manualRefundPaymentFacts(f.db,actual.order)).origin_hash).toBe((await original(r.order.id)).origin_hash);
 });
 it('commits genuine zero payment through the original paid event exactly once',async()=>{
  await f.reset('0.00');const r=await f.create(),key=randomUUID(),paid=await f.cash(r.order,101,key);expect(paid.receipt.evidence.outcome).toBe('zero-paid');
  expect(await f.processPaid(r.order.id)).toBe('completed');const before=await facts();expect((await f.cash(r.order,101,key)).receipt).toEqual(paid.receipt);expect(await facts()).toEqual(before);
  expect(await count('store_order_outbox')).toBe(1);expect((await original(r.order.id)).origin.buyer_uid).toBe(11);
 });
 it('keeps owner receipt recovery after customer role revocation while rejecting a new write',async()=>{
  const r=await f.create(),paid=await f.cash(r.order),key=paid.request_key;await f.maintenanceDb.update(storeService).set({customer:0}).where(eq(storeService.uid,101));
  expect((await f.service.operation(f.actor(),key)).receipt).toEqual(paid.receipt);
  expect((await f.service.operation(f.actor(102),key)).receipt).toBeNull();const before=await facts();await expect(f.cash(r.order,101,randomUUID())).rejects.toThrow();expect(await facts()).toEqual(before);
 });
 it('hashes the final signed catalogue/selection URL rather than the unsigned attachment reference',async()=>{
  await f.maintenanceDb.insert(systemAttachment).values({attId:990,type:1,relationId:0,moduleType:1,fileType:1,imageType:8,attDir:'/api/assets/990',name:'attachments/admin/1/ordinary-990.png',attType:'image/png'});
  await f.maintenanceDb.update(storeProduct).set({image:'/api/assets/990'}).where(eq(storeProduct.id,70));
  await f.maintenanceDb.update(storeProductAttrValue).set({image:'/api/assets/990'}).where(eq(storeProductAttrValue.productId,70));
  const catalog=await f.reader.catalog(f.actor()),selection=await f.reader.selection(f.actor(),70);expect(catalog.data.list[0].image).not.toBe('/api/assets/990');expect(selection.data.product.image).not.toBe('/api/assets/990');
  expect(catalog.consistency_key).toBe(await outRequestHash({scope_key:catalog.scope_key,data:catalog.data}));
  expect(selection.consistency_key).toBe(await outRequestHash({scope_key:selection.scope_key,data:selection.data}));
 });
 it('closes readiness on actual sequence or source INSERT loss and restores only through explicit maintenance',async()=>{
  const[sequence]=await f.maintenanceDb.execute<{name:string}>(sql`SELECT pg_get_serial_sequence('public.store_cart','id') AS name`);
  await f.exec(`REVOKE USAGE ON SEQUENCE ${sequence.name} FROM "${f.role}"`);
  try{expect((await cashierOrdinaryReadiness(f.db)).ready).toBe(false);}finally{await f.exec(`GRANT USAGE ON SEQUENCE ${sequence.name} TO "${f.role}"`);}
  await f.exec(`REVOKE INSERT ON public.store_order_cart_info FROM "${f.role}"`);
  try{expect((await cashierOrdinaryReadiness(f.db)).ready).toBe(false);}finally{await f.exec(`GRANT INSERT ON public.store_order_cart_info TO "${f.role}"`);}
  expect((await cashierOrdinaryReadiness(f.db)).ready).toBe(true);
  const[taxonomy]=await f.db.execute<{mutable:boolean}>(sql`SELECT has_any_column_privilege(current_user,'public.user_label','UPDATE') OR has_any_column_privilege(current_user,'public.store_product_category','UPDATE') OR has_any_column_privilege(current_user,'public.system_user_level','UPDATE') AS mutable`);expect(taxonomy.mutable).toBe(false);
  for(const kind of ['product','user']){
   await f.exec(`REVOKE EXECUTE ON FUNCTION public.customer_${kind}_lock_catalog_v1(text,integer[]) FROM "${f.role}"`);
   try{expect((await cashierOrdinaryReadiness(f.db)).ready).toBe(false);}finally{await f.exec(`GRANT EXECUTE ON FUNCTION public.customer_${kind}_lock_catalog_v1(text,integer[]) TO "${f.role}"`);}
  }
  await f.exec(`REVOKE UPDATE(id) ON public.store_brand FROM "${f.role}"`);
  try{expect((await cashierOrdinaryReadiness(f.db)).ready).toBe(false);}finally{await f.exec(`GRANT UPDATE(id) ON public.store_brand TO "${f.role}"`);}
  await f.exec(`REVOKE EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() FROM "${f.role}"`);
  try{expect((await cashierOrdinaryReadiness(f.db)).ready).toBe(false);}finally{await f.exec(`GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO "${f.role}"`);}
  expect((await cashierOrdinaryReadiness(f.db)).ready).toBe(true);
 });
 it('projects real physical gifts, coupon gifts and points, then completes their original paid consumer and labels once',async()=>{
  const now=Math.floor(Date.now()/1000);
  await f.maintenanceDb.insert(storeProduct).values({id:71,storeName:'真实普通赠品',stock:20,image:'/gift.png',isShow:1,isVerify:1,deliveryType:'1,2'});
  await f.maintenanceDb.insert(storeProductAttrValue).values({id:71,productId:71,type:0,unique:'gift0071',suk:'实物赠品',stock:20});
  await f.maintenanceDb.insert(userLabel).values({id:31,name:'真实满送成交客户',type:0,relationId:0,status:1});
  await f.maintenanceDb.insert(storeCouponIssue).values({id:41,couponTitle:'真实满送优惠券',type:1,couponPrice:'2.00',useMinPrice:'5.00',receiveType:3,status:1,remainCount:20,totalCount:20,day:7});
  await f.maintenanceDb.insert(storePromotions).values({id:61,type:1,storeId:0,promotionsType:4,promotionsCate:2,name:'满十元赠实物券积分',thresholdType:1,threshold:'10.00',giveIntegral:3,productPartakeType:1,labelId:'31',startTime:now-3600,stopTime:now+86400,status:1});
  await f.maintenanceDb.insert(storePromotionsAuxiliary).values([{id:71,promotionsId:61,type:2,couponId:41,isAll:1,limitNum:10,surplusNum:10},{id:72,promotionsId:61,type:3,productId:71,unique:'gift0071',isAll:1,limitNum:10,surplusNum:10}]);
  const r=await f.create();expect(r.order).toMatchObject({payPrice:'17.00',totalNum:4,giveIntegral:3});
  expect(r.quote.data.promotion_gifts).toMatchObject({integral:3,coupons:[{issue_id:41}],products:[{product_id:71,quantity:1}],promotions:[{id:61,repetitions:1,threshold_type:1}]});
  expect(JSON.parse(r.order.promotionsGive!).promotions[0].label_id).toEqual([31]);
  const actual=await f.actual(r.order.id);expect(actual.carts).toHaveLength(3);expect(actual.carts.find(c=>c.productId===71)).toMatchObject({cartNum:1,isGift:1});
  await f.cash(r.order);expect(await f.processPaid(r.order.id)).toBe('completed');expect(await f.processPaid(r.order.id)).toBe('already-completed');
  expect(await f.db.select().from(storeOrderPromotionGiftCouponReward).where(eq(storeOrderPromotionGiftCouponReward.orderId,r.order.id))).toHaveLength(1);
  expect(await f.db.select().from(userLabelRelation).where(eq(userLabelRelation.uid,11))).toHaveLength(1);
  const[account]=await f.db.select().from(user).where(eq(user.uid,11));expect(account.integral).toBe(103);
  expect((await original(r.order.id)).origin.cart_facts).toHaveLength(3);
 });
 it('uses genuine paid membership prices in each SKU and records the actual savings',async()=>{
  await f.setConfig({...f.config,member_card_status:'1',svip_price_status:'1'});
  await f.maintenanceDb.insert(memberRight).values({rightType:'vip_price',status:1,number:100});
  await f.maintenanceDb.update(user).set({isEverLevel:1}).where(eq(user.uid,11));await f.maintenanceDb.update(storeProduct).set({isVip:1}).where(eq(storeProduct.id,70));
  await f.maintenanceDb.update(storeProductAttrValue).set({vipPrice:'4.00'}).where(eq(storeProductAttrValue.id,1));await f.maintenanceDb.update(storeProductAttrValue).set({vipPrice:'6.00'}).where(eq(storeProductAttrValue.id,2));
  const r=await f.create();expect(r.quote.data.pricing).toMatchObject({raw_total:'17.00',membership_discount:'3.00',amount:'14.00'});expect(r.order.payPrice).toBe('14.00');
  await f.cash(r.order);expect(await f.processPaid(r.order.id)).toBe('completed');expect((await original(r.order.id)).origin.creation_pay_price).toBe('14.00');
 });
 it('uses a genuine active level through the SELECT-only audited catalog and refuses changed level terms',async()=>{
  await f.setConfig({...f.config,member_func_status:'1'});await f.maintenanceDb.insert(systemUserLevel).values({id:81,name:'真实九折会员',discount:'90.00',isShow:1,isDel:0});
  await f.maintenanceDb.update(user).set({level:81,levelStatus:1}).where(eq(user.uid,11));
  const d=await f.draft(),key=randomUUID(),quote=await f.service.quote(f.actor(),key,d.intent);expect(quote.data.pricing).toMatchObject({membership_discount:'1.70',amount:'15.30'});
  await f.maintenanceDb.update(systemUserLevel).set({discount:'80.00'}).where(eq(systemUserLevel.id,81));const before=await facts();
  await expect(f.service.create(f.actor(),key,d.intent,quote.data.quote_token)).rejects.toThrow('重新');expect(await facts()).toEqual(before);
  const fresh=await f.service.quote(f.actor(),key,d.intent),created=await f.service.create(f.actor(),key,d.intent,fresh.data.quote_token);expect((created.receipt.evidence.order as {pay_price:string}).pay_price).toBe('13.60');
 });
 it('reserves a real category-scoped coupon through the SELECT-only product catalog lock',async()=>{
  await f.maintenanceDb.insert(storeProductCategory).values({id:81,pid:0,path:'',cateName:'真实分类'});await f.maintenanceDb.update(storeProduct).set({cateId:'81'}).where(eq(storeProduct.id,70));
  await f.maintenanceDb.insert(storeCouponIssue).values({id:50,couponTitle:'真实分类券',couponPrice:'3.00',useMinPrice:'0.00',type:1,couponType:1,category_id:'81',isPermanent:1,isDel:0,status:1});
  await f.maintenanceDb.insert(storeCouponUser).values({id:50,uid:11,issueCouponId:50,couponTitle:'真实分类券',couponPrice:'3.00',useMinPrice:'0.00',type:1,status:0});
  const r=await f.create({coupon_id:50});expect(r.order.payPrice).toBe('14.00');await f.cash(r.order);expect(await f.processPaid(r.order.id)).toBe('completed');expect((await original(r.order.id)).origin.creation_pay_price).toBe('14.00');
 });
 it('uses the original brand row lock for an actual brand-scoped coupon',async()=>{
  await f.maintenanceDb.insert(storeBrand).values({id:81,pid:0,fid:'',brandName:'真实品牌'});await f.maintenanceDb.update(storeProduct).set({brandId:81}).where(eq(storeProduct.id,70));
  await f.maintenanceDb.insert(storeCouponIssue).values({id:50,couponTitle:'真实品牌券',couponPrice:'3.00',useMinPrice:'0.00',type:1,couponType:3,brandId:'81',isPermanent:1,isDel:0,status:1});
  await f.maintenanceDb.insert(storeCouponUser).values({id:50,uid:11,issueCouponId:50,couponTitle:'真实品牌券',couponPrice:'3.00',useMinPrice:'0.00',type:1,status:0});
  const r=await f.create({coupon_id:50});expect(r.order.payPrice).toBe('14.00');await f.cash(r.order);expect(await f.processPaid(r.order.id)).toBe('completed');
 });
 it('keeps genuine referral commission in the mature checkout without premature commission payout',async()=>{
  const values={brokerage_func_status:'1',store_brokerage_statu:'1',store_brokerage_ratio:'10',store_brokerage_two:'0',brokerage_level:'1',brokerage_compute_type:'1',is_self_brokerage:'0',division_status:'0'};
  await f.setConfig({...f.config,...values});for(const[menuName,value]of Object.entries(values)){await f.maintenanceDb.delete(systemConfig).where(eq(systemConfig.menuName,menuName));await f.maintenanceDb.insert(systemConfig).values({menuName,value});}
  await f.maintenanceDb.insert(user).values({uid:201,account:'actual-ordinary-promoter',isPromoter:1,status:1});await f.maintenanceDb.update(user).set({spreadUid:201}).where(eq(user.uid,11));
  const r=await f.create();expect(r.order).toMatchObject({spreadUid:201,oneBrokerage:'1.70',twoBrokerage:'0.00',payPrice:'17.00'});await f.cash(r.order);expect(await f.processPaid(r.order.id)).toBe('completed');
  expect(await f.db.select().from(userBrokerage).where(eq(userBrokerage.uid,201))).toEqual([]);expect((await original(r.order.id)).origin.creation_pay_price).toBe('17.00');
 });
 it('retains old app LOGIN label consumption after new realms are installed without granting access to those realms',async()=>{
  await labels();const r=await f.create();expect(JSON.parse(r.order.promotionsGive!).promotions[0].label_id).toEqual([31]);await f.cash(r.order);
  const[event]=await f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.aggregateId,r.order.id));
  await f.withMatureApp(async db=>{const consumer=new OrderOutboxService(createContainerFromDb(db),f.env);expect(await consumer.processMessage({action:'processOrderPaidOutbox',outboxId:event.id,eventKey:event.eventKey})).toBe('completed');});
  expect(await f.db.select().from(userLabelRelation).where(eq(userLabelRelation.uid,11))).toHaveLength(1);expect((await original(r.order.id)).origin.creator_uid).toBe(101);
 });
 it('rolls back paid rewards when a genuine concurrent label editor conflicts with the audited catalog fence',async()=>{
  await labels();const r=await f.create();await f.cash(r.order);let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),arrived=new Promise<void>(resolve=>entered=resolve);
  const held=f.maintenanceDb.transaction(async tx=>{await tx.update(userLabel).set({name:'正在编辑的真实标签'}).where(eq(userLabel.id,31));entered();await gate;});await arrived;
  try{let caught:unknown;try{await f.processPaid(r.order.id);}catch(error){caught=error;}expect(caught).toBeDefined();let cause=caught,code:unknown;for(let n=0;n<8&&cause&&typeof cause==='object';n++){const e=cause as {code?:unknown;cause?:unknown};if(e.code){code=e.code;break;}cause=e.cause;}expect(code).toBe('55P03');
   expect(await f.db.select().from(userLabelRelation).where(eq(userLabelRelation.uid,11))).toEqual([]);const[buyer]=await f.db.select().from(user).where(eq(user.uid,11));expect(buyer.integral).toBe(100);expect(buyer.payCount).toBe(0);
   const[actual]=await f.db.select().from(storeOrder).where(eq(storeOrder.id,r.order.id));expect(actual.paid).toBe(1);const[event]=await f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.aggregateId,r.order.id));expect(event.status).toBe('FAILED');
  }finally{release();await held;}
 });
 it('uses real User JWT controllers, exact original UUID recovery and strict body/path/header boundaries',async()=>{
  const r=await f.create(),before=await facts(),read=await http('/operations/'+r.key);expect(read.body.status,read.body.msg).toBe(200);expect(read.body.data.receipt).toEqual(r.result.receipt);expect(read.response.headers.get('Cache-Control')).toBe('private, no-store');
  const replay=await http('/orders',{intent:r.intent,quote_token:'expired-token'},r.key);expect(replay.body.status,replay.body.msg).toBe(200);expect(replay.body.data.receipt).toEqual(r.result.receipt);expect(await facts()).toEqual(before);
  const wrong=await http('/orders',{intent:r.intent,quote_token:r.quote.data.quote_token},r.key,'admin');expect(wrong.body.status).not.toBe(200);expect(await facts()).toEqual(before);
  const duplicate=await http('/catalog?scope_key='+r.intent.scope_key+'&scope_key='+r.intent.scope_key);expect(duplicate.body.status).not.toBe(200);
  const bad=await http('/orders',{intent:r.intent,quote_token:r.quote.data.quote_token},r.key,'api',{'Content-Encoding':'gzip'});expect(bad.body.status).not.toBe(200);expect(await facts()).toEqual(before);
  const mismatch=await http('/operations/'+randomUUID()+'/abandon',{kind:'creation',intent:r.intent},r.key);expect(mismatch.body.status).not.toBe(200);expect(await facts()).toEqual(before);
  const input={version:'customer-cashier-ordinary-payment-v1',scope_key:r.intent.scope_key,order_id:r.order.id,order_no:r.order.orderId,expected_amount:r.order.payPrice},paymentKey=randomUUID(),paid=await http('/orders/'+r.order.id+'/cash',input,paymentKey);expect(paid.body.status,paid.body.msg).toBe(200);
  expect(paid.body.data.receipt.evidence.payment).toMatchObject({creator_uid:101,payer_uid:101,amount:'17.00'});expect(await f.processPaid(r.order.id)).toBe('completed');
  await f.maintenanceDb.update(storeService).set({customer:0}).where(eq(storeService.uid,101));expect((await http('/operations/'+paymentKey)).body.data.receipt).toEqual(paid.body.data.receipt);
 });
 it('pins the actual common form and creator-owned image, rejecting signed display URLs and template drift without effects',async()=>{
  const template=[{id:'name',name:'texts',titleConfig:{value:'购买人'},titleShow:{val:true},value:''},{id:'photo',name:'uploadPicture',titleConfig:{value:'核对图片'},titleShow:{val:true},value:[]}];
  await f.maintenanceDb.insert(systemForm).values({id:77,name:'真实普通收银表单',value:JSON.stringify(template),status:1,isDel:0});await f.maintenanceDb.update(storeProduct).set({systemFormId:77}).where(eq(storeProduct.id,70));
  await f.maintenanceDb.insert(systemAttachment).values({attId:990,type:3,relationId:101,moduleType:3,fileType:1,imageType:8,attDir:'/api/assets/990',name:'attachments/user/101/ordinary-990.png',attType:'image/png'});
  const custom_form=[{id:'name',name:'texts',value:'实际购买人'},{id:'photo',name:'uploadPicture',value:['/api/assets/990']}],d=await f.draft(),key=randomUUID(),intent={...d.intent,custom_form},q=await f.service.quote(f.actor(),key,intent);
  expect(q.data.system_form?.id).toBe(77);await f.maintenanceDb.update(systemForm).set({name:'已编辑的新模板'}).where(eq(systemForm.id,77));const before=await facts();
  await expect(f.service.create(f.actor(),key,intent,q.data.quote_token)).rejects.toThrow('重新');expect(await facts()).toEqual(before);
  const fresh=await f.service.quote(f.actor(),key,intent),created=await f.service.create(f.actor(),key,intent,fresh.data.quote_token),id=Number((created.receipt.evidence.order as {order_id:number}).order_id),actual=await f.actual(id);
  expect(actual.order.customForm).toContain('ordinaryCashierImageScope');expect(await f.db.select().from(systemFormData).where(eq(systemFormData.relationId,id))).toHaveLength(1);
  const components=await readOrderSystemFormForOrder(f.db,new AttachmentService(f.container,f.env),actual.order);expect(JSON.stringify(components)).toContain('/api/assets/990?expires=');expect(JSON.stringify(components)).not.toContain('ordinaryCashierImageScope');
  // A real legacy channel2 order may carry the copied marker and reference the
  // creator's actual upload, but the marker alone is never signing authority.
  const [legacy]=await f.maintenanceDb.insert(storeOrder).values({orderId:'ordinary-marker-without-origin',uid:actual.order.uid,staffId:actual.order.staffId,
    isChannel:2,productType:0,unique:'f'.repeat(32),customForm:actual.order.customForm}).returning();
  expect(await readCashierOrdinaryOrigin(f.db,legacy)).toBeNull();let signatureCalls=0;
  const realSigner=new AttachmentService(f.container,f.env),unproven=await readOrderSystemFormForOrder(f.db,
    {signReferences:async references=>{signatureCalls++;return realSigner.signReferences(references);}},legacy);
  expect(unproven.find(component=>component.name==='uploadPicture')?.value).toEqual([]);expect(signatureCalls).toBe(0);
  expect(JSON.stringify(unproven)).not.toContain('ordinaryCashierImageScope');
  const next=await f.draft(),bad={...next.intent,custom_form:[custom_form[0],{...custom_form[1],value:['/api/assets/990?expires=1&signature=forged']}]},badKey=randomUUID(),badQuote=await f.service.quote(f.actor(),badKey,bad),saved=await facts();
  await expect(f.service.create(f.actor(),badKey,bad,badQuote.data.quote_token)).rejects.toThrow('图片');expect(await facts()).toEqual(saved);
 });
 it('permanently fences an absent original creation after role revocation and never fabricates a business outcome',async()=>{
  const d=await f.draft(),key=randomUUID();expect((await f.service.operation(f.actor(),key)).receipt).toBeNull();
  await f.maintenanceDb.update(storeService).set({customer:0}).where(eq(storeService.uid,101));
  const terminated=await f.service.abandon(f.actor(),key,{kind:'creation',intent:d.intent});expect(terminated.receipt).toMatchObject({kind:'abandon',intent:d.intent,evidence:{outcome:'operation-abandoned',original_kind:'creation'}});
  expect((await f.service.operation(f.actor(),key)).receipt).toEqual(terminated.receipt);const before=await facts();
  await expect(f.service.abandon(f.actor(),key,{kind:'creation',intent:{...d.intent,scope_key:'f'.repeat(64)}})).rejects.toThrow('绑定其他内容');expect(await facts()).toEqual(before);
  await f.maintenanceDb.update(storeService).set({customer:1}).where(eq(storeService.uid,101));
  const late=await f.service.create(f.actor(),key,d.intent,'old-quote-already-expired');expect(late.receipt).toEqual(terminated.receipt);expect(await count('store_order')).toBe(0);
 });
 it('returns immutable actual creation and paid receipts instead of abandoning committed effects',async()=>{
  const r=await f.create(),created=await f.service.abandon(f.actor(),r.key,{kind:'creation',intent:r.intent});expect(created.receipt).toEqual(r.result.receipt);
  const paid=await f.cash(r.order),before=await facts(),terminated=await f.service.abandon(f.actor(),paid.request_key,{kind:'payment',intent:paid.receipt.intent});
  expect(terminated.receipt).toEqual(paid.receipt);expect(await facts()).toEqual(before);expect((await f.service.operation(f.actor(102),paid.request_key)).receipt).toBeNull();
  await expect(f.service.abandon(f.actor(),paid.request_key,{kind:'creation',intent:r.intent})).rejects.toThrow('绑定其他内容');expect(await facts()).toEqual(before);
 });
 it('serializes a genuine late creation POST behind abandonment and commits only the terminal receipt',async()=>{
  const d=await f.draft(),key=randomUUID(),quote=await f.service.quote(f.actor(),key,d.intent),[main]=await f.db.execute<{pid:number}>(sql`SELECT pg_backend_pid() AS pid`);
  await f.withPeer(async peer=>{const held=heldRequest(peer),first=observed(service(held.db).abandon(f.actor(),key,{kind:'creation',intent:d.intent}));await held.arrive();
   const late=observed(f.service.create(f.actor(),key,d.intent,quote.data.quote_token));try{await actualWait(main.pid);}finally{held.release();}
   const done=await first,replay=await late;expect(done.receipt.kind).toBe('abandon');expect(replay.receipt).toEqual(done.receipt);});
  expect(await count('store_order')).toBe(0);expect(await count('cashier_ordinary_origin_v1')).toBe(0);
  const skus=await f.db.select().from(storeProductAttrValue).orderBy(asc(storeProductAttrValue.id));expect(skus.map(s=>s.stock)).toEqual([100,100]);
 });
 it('serializes abandonment behind a genuine in-flight creation and returns the committed actual order',async()=>{
  const d=await f.draft(),key=randomUUID(),quote=await f.service.quote(f.actor(),key,d.intent),[main]=await f.db.execute<{pid:number}>(sql`SELECT pg_backend_pid() AS pid`);
   await f.withPeer(async peer=>{const held=heldCreationReceipt(peer,f.actor().uid,key),first=observed(service(held.db).create(f.actor(),key,d.intent,quote.data.quote_token));
    let closing:ReturnType<typeof f.service.abandon>|undefined;
    try{const inside=await held.arrive(),[outside]=await f.maintenanceDb.execute<{orders:number;origins:number;receipts:number}>(sql`SELECT
      (SELECT count(*)::int FROM public.store_order WHERE id=${inside.order_id}) AS orders,
      (SELECT count(*)::int FROM public.cashier_ordinary_origin_v1 WHERE order_id=${inside.order_id} AND actor_uid=${f.actor().uid} AND request_key=${key}::uuid) AS origins,
      (SELECT count(*)::int FROM public.cashier_ordinary_operation_v1 WHERE actor_uid=${f.actor().uid} AND request_key=${key}::uuid) AS receipts`);
     expect(outside).toEqual({orders:0,origins:0,receipts:0});
     closing=observed(f.service.abandon(f.actor(),key,{kind:'creation',intent:d.intent}));await actualWait(main.pid);held.release();
     const done=await first,closed=await closing;expect(done.receipt.kind).toBe('creation');expect(done.receipt.evidence.order).toMatchObject({order_id:inside.order_id});expect(closed.receipt).toEqual(done.receipt);
    }finally{held.release();await Promise.allSettled([first,...(closing?[closing]:[])]);}});
  expect(await count('store_order')).toBe(1);expect(await count('cashier_ordinary_origin_v1')).toBe(1);
 });
 it('fences late payment without a paid bit, audit or outbox and preserves the source order',async()=>{
  const r=await f.create(),key=randomUUID(),input={version:'customer-cashier-ordinary-payment-v1',scope_key:r.intent.scope_key,order_id:r.order.id,order_no:r.order.orderId,expected_amount:r.order.payPrice};
  const before=await facts(),stopped=await f.service.abandon(f.actor(),key,{kind:'payment',intent:input}),late=await f.service.cash(f.actor(),key,input);
  expect(stopped.receipt).toMatchObject({kind:'abandon',evidence:{outcome:'operation-abandoned',original_kind:'payment'}});expect(late.receipt).toEqual(stopped.receipt);
  const after=await facts();expect(after.orders).toEqual(before.orders);expect(after.lines).toEqual(before.lines);expect(after.skus).toEqual(before.skus);expect(after.audits).toEqual(before.audits);expect(after.events).toEqual(before.events);
 });
});
