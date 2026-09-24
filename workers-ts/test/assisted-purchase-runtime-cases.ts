import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono, type MiddlewareHandler } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainer, createContainerFromDb, withTx } from '../src/lib/di';
import { adminRuntimeAuthMiddleware } from '../src/middleware/admin-runtime-auth';
import { adminAssistedCartAdd, adminAssistedCartList, adminAssistedCartDel, adminAssistedCartNum,
  adminAssistedPlaceList, adminAssistedCoupons, adminAssistedPay, adminAssistedPayStatus,
  adminAssistedConfirm, adminAssistedComputed, adminAssistedCreate, adminAssistedFormImage } from '../src/controllers/api/v1/AdminController';
import { createToken, md5 } from '../src/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { runPurchaseOriginEvidence } from '../src/migrations/runPurchaseOriginEvidence';
import { runPurchaseCancellationEvidence } from '../src/migrations/runPurchaseCancellationEvidence';
import { ScheduledMaintenanceService } from '../src/services/order/ScheduledMaintenanceService';
import { OrderOutboxService } from '../src/services/order/OrderOutboxService';
import { adminUserList } from '../src/controllers/api/v1/AdminCrudController';
import { cancelStoreOrder, StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { StoreOrderPayService } from '../src/services/order/StoreOrderPayService';
import { AdminMobileOrderOperationService } from '../src/services/admin/AdminMobileOrderOperationService';
import { WechatPayService } from '../src/services/wechat/WechatPayService';
import { hasInitiatedAssistedProviderPayment, claimAssistedProviderPayment } from '../src/services/payment/AssistedProviderPaymentClaim';
import { persistVerifiedPaymentCallbackTx, type VerifiedPaymentCallback } from '../src/services/payment/PaymentCallbackPersistence';
import { PaymentCallbackEventService } from '../src/services/payment/PaymentCallbackEventService';
import { PaymentReconciliationService } from '../src/services/payment/PaymentReconciliationService';
import type { SystemConfigEnv } from '../src/services/system/SystemConfigService';
import { systemForm, systemAttachment, storeOrder } from '../src/models/schema';
import { AttachmentService, R2_IMAGE_TYPE, adminAttachmentScope, userAttachmentScope } from '../src/services/system/AttachmentService';
import { assistedFormAttachmentScope, belongsToAssistedFormScope } from '../src/services/system/AssistedFormAttachmentScope';
import * as orderForms from '../src/services/order/OrderSystemFormService';
import * as di from '../src/lib/di';

type Reply<T> = { status: number; msg: string; data: T };
type Quote = { orderKey: string; quoteToken: string; priceGroup: { usedIntegral: number } };
type CompleteQuote = Quote & {
  cartInfo: Array<{ id: number; cart_num: number; truePrice: number }>;
  addressInfo: { id: number; detail: string; city_id: number; real_name: string } | null;
  checkout: { version: number; adminId: number; uid: number; touristUid: string; cartIds: number[];
    isNew: number; shippingType: number; storeId: number; addressSource: string; addressRequired: boolean;
    useIntegral: boolean; couponId: number; payType: string; systemFormId: number };
  integralRatio: string; integral_ratio_status: number;
  priceGroup: Quote['priceGroup'] & { totalPrice: string; deduction_price: string };
};
type Created = { result: { order_id: string; extended: boolean } };

export function registerAssistedPurchaseTests(phase: 'form' | 'flow' | 'race') {
describe('assisted member/guest purchase with actual Admin authentication and two independent PG16 LOGINs',()=>{
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async()=>{
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f=await refundRuntimeFixture();
    await f.exec(`INSERT INTO system_role(id,role_name,rules,status) VALUES(1,'Local assisted','order.assisted',1),(2,'Local read','order.view',1),
        (3,'Local user reader','user.view',1);
      INSERT INTO system_admin(id,account,pwd,admin_type,level,roles) VALUES
        (1,'local-actor-a','local-hash',1,1,'1'),(2,'local-actor-b','local-hash',1,1,'1'),(3,'local-read-only','local-hash',1,1,'2'),
        (4,'local-user-reader','local-hash',1,1,'3');
      SELECT setval('public.store_cart_id_seq',(SELECT max(id) FROM public.store_cart));`);
  },60_000);
  afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();await f?.close();}},30_000);
  type Role=Parameters<NonNullable<typeof f.withRuntimeRole>>[0] extends (r:infer R)=>unknown?R:never;
  async function profiles(run:(app:Role,admin:Role)=>Promise<void>){
    await f.withRuntimeRole!(app=>f.withRuntimeRole!(async admin=>{
      const [identity]=await f.exec('SELECT current_database() AS database');
      const names={app:app.role,admin:admin.role,maintenance:'finance_test'};
      await runRuntimeBusinessCommissioning(f.db,{...names,database:String(identity.database),pricingOwner:f.pricingOwner});
      for(const [kind,peer] of [['app',app],['admin',admin]] as const)
        expect(await auditRuntimeBusinessPrivileges(peer.db,kind,names)).toMatchObject({ready:true,failures:[]});
      await run(app,admin);
      const [sessions]=await f.exec(`SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database()
        AND application_name IN ('cinashop_admin','cinashop_api')`);
      expect(sessions.n).toBe(0);
    }));
  }
  async function http(appRole:Role,adminRole:Role){
    let serial=0;
    const sequence=vi.fn(async()=>new Response('local_assisted_'+(++serial)));
    const sendBatch=vi.fn(async(_messages:unknown)=>undefined);
    const send=vi.fn(async(_message:unknown)=>undefined);
    const objects = new Map<string, { bytes: ArrayBuffer; options?: R2PutOptions }>();
    let beforePut: (() => Promise<void>) | undefined;
    const put = vi.fn(async (key: string, value: ReadableStream, options?: R2PutOptions) => {
      const [active] = await f.exec(`SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database()
        AND application_name IN ('cinashop_api','cinashop_admin') AND xact_start IS NOT NULL`);
      expect(active.n).toBe(0); // Actual PostgreSQL sessions, not a transaction spy.
      const bytes = await new Response(value).arrayBuffer(); objects.set(key, { bytes, options });
      await beforePut?.(); return { key, size: bytes.byteLength };
    });
    const remove = vi.fn(async (keys: string | string[]) => { for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key); });
    const getObject = vi.fn(async (key: string) => { const object = objects.get(key); if (!object) return null;
      return { key, body: new Response(object.bytes).body!, size: object.bytes.byteLength, httpEtag: 'local-fixture-etag',
        writeHttpMetadata: (headers: Headers) => { headers.set('content-type','image/png'); headers.set('cache-control','private, no-store'); } }; });
    // Local JWTs and real SQL authentication/authorization; only KV/Sequence
    // and Hyperdrive transport are fixtures. Redis revocation is not simulated.
    const env=Object.assign(f.env,{APP_KEY:'local-assisted-runtime-only',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',
      HYPERDRIVE:{connectionString:appRole.connectionString},HYPERDRIVE_ADMIN:{connectionString:adminRole.connectionString},
      SEQUENCE:{idFromName:()=> 'local',get:()=>({fetch:sequence})},ORDER_QUEUE:{sendBatch,send},
      ASSETS_BUCKET:{put,delete:remove,get:getObject}}) as Env;
    const tokens=await Promise.all([1,2,3,4].map(async id=>(await createToken(id,'admin',md5('local-hash'),env.APP_KEY)).token));
    const customerToken=(await createToken(11,'api',md5('local-hash'),env.APP_KEY)).token;
    const app=new Hono<{Bindings:Env;Variables:AppVariables}>();
    const identities:Array<{app:unknown;admin:unknown}>=[];
    app.use('*',async(c,next)=>{const container=createContainer(c.env);c.set('container',container);
      try{await next();}finally{await container.db.$client.end({timeout:5});}});
    app.onError((error,c)=>c.json({status:400,msg:error.message,data:null}));
    const auth=adminRuntimeAuthMiddleware();
    const observe:MiddlewareHandler<{Bindings:Env;Variables:AppVariables}>=async(c,next)=>{
      const application=c.get('applicationContainer');if(!application)throw Error('Missing application container');
      const [a]=await application.db.execute(sql`SELECT current_user AS role`);
      const [b]=await c.get('container').db.execute(sql`SELECT current_user AS role`);
      identities.push({app:a.role,admin:b.role});await next();
    };
    // Match production's per-route auth attachment: a wildcard use() changes
    // c.req.routePath and tests a different permission decision.
    app.post('/api/admin/order/cart/add/:uid',auth,observe,adminAssistedCartAdd);
    app.post('/api/admin/order/confirm/:uid',auth,observe,adminAssistedConfirm);
    app.post('/api/admin/order/computed/:key/:uid',auth,observe,adminAssistedComputed);
    app.post('/api/admin/order/form_image/:key/:uid',auth,observe,adminAssistedFormImage);
    app.post('/api/admin/order/create/:key/:uid',auth,observe,adminAssistedCreate);
    app.get('/api/admin/order/cart/:uid',auth,observe,adminAssistedCartList);
    app.delete('/api/admin/order/cart/del/:uid',auth,observe,adminAssistedCartDel);
    app.post('/api/admin/order/cart/num/:uid',auth,observe,adminAssistedCartNum);
    app.get('/api/admin/order/place/list',auth,observe,adminAssistedPlaceList);
    app.get('/api/admin/order/coupons/:uid',auth,observe,adminAssistedCoupons);
    app.post('/api/admin/order/pay/:uid',auth,observe,adminAssistedPay);
    app.get('/api/admin/order/pay/status',auth,observe,adminAssistedPayStatus);
    app.get('/api/admin/user/list',auth,observe,adminUserList);
    app.get('/adminapi/user/list',auth,observe,adminUserList);
    const users=async(prefix:string,query='',actor=4)=>{
      const response=await app.request(prefix+'/user/list'+query,{headers:{
        ...(actor?{Authorization:'Bearer '+(actor===-1?customerToken:tokens[actor-1])}:{})}},env);
      return {response,body:await response.json<Reply<{list:Array<Record<string,unknown>>}>>()};
    };
    const request=async<T>(method:string,path:string,body:object|undefined,actor=1)=>{
      const response=await app.request('/api/admin/order/'+path,{method,headers:{'content-type':'application/json',
        ...(actor?{Authorization:'Bearer '+tokens[actor-1]}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})},env);
      return response.json<Reply<T>>();
    };
    const post=<T>(path:string,body:object,actor=1)=>request<T>('POST',path,body,actor);
    const get=<T>(path:string,actor=1)=>request<T>('GET',path,undefined,actor);
    const del=<T>(path:string,body:object,actor=1)=>request<T>('DELETE',path,body,actor);
    const upload = async (key:string,uid:number,actor=1,fields:Record<string,string>={}) => {
      const form=new FormData(); form.append('file',new File([new Uint8Array([137,80,78,71,13,10,26,10])],'local-test.png',{type:'image/png'}));
      for(const [name,value] of Object.entries(fields)) form.append(name,value);
      const encoded=new Response(form),bytes=await encoded.arrayBuffer();
      const response=await app.request(`/api/admin/order/form_image/${key}/${uid}`,{method:'POST',body:bytes,headers:{
        'content-type':encoded.headers.get('content-type')!,'content-length':String(bytes.byteLength),
        ...(actor?{Authorization:'Bearer '+(actor===-1?customerToken:tokens[actor-1])}:{})}},env);
      return {response,body:await response.json<Reply<{att_id:number;url:string;src:string}>>()};
    };
    return {post,get,del,users,identities,sequence,sendBatch,send,upload,put,remove,getObject,objects,
      onPut:(callback:()=>Promise<void>)=>{beforePut=callback;}};
  }
  async function confirm(client:Awaited<ReturnType<typeof http>>,uid:number,delivery:'saved'|'manual'|'pickup'|'virtual'=uid?'saved':'manual'){
    if(delivery==='virtual')await f.exec('UPDATE store_product SET product_type=2 WHERE id=70; UPDATE user_address SET is_del=1 WHERE uid=11');
    if(delivery==='pickup')await f.exec('UPDATE system_store SET is_store=1 WHERE id=1');
    const added=await client.post<{cartId:number}>('cart/add/'+uid,{productId:70,uniqueId:'qared001',cartNum:2,new:1,tourist_uid:'local_guest_a'});
    expect(added.status,added.msg).toBe(200);
    const body={cartId:[added.data.cartId],new:1,tourist_uid:'local_guest_a',useIntegral:true,payType:'weixin',
      ...(delivery==='saved'?{addressId:11}:{}),
      ...(delivery==='manual'?{manualAddress:{realName:'本地游客',phone:'00000000000',province:'本地省',city:'测试甲市',district:'测试甲区',cityId:101,detail:'隔离游客样本'}}:{}),
      ...(delivery==='pickup'?{shipping_type:2,store_id:1,real_name:'本地自提',phone:'00000000000'}:{})};
    const before=await f.state(),quote=await client.post<Quote>('confirm/'+uid,body);
    expect(quote.status,quote.msg).toBe(200);expect(await f.state()).toEqual(before);expect(client.sequence).not.toHaveBeenCalled();
    expect(quote.data.priceGroup.usedIntegral).toBe(uid?100:0);
    return {body,quote:quote.data,before,cartId:added.data.cartId};
  }
  async function closeOrder(app:Role,root:Record<string,unknown>){
    return new ScheduledMaintenanceService(createContainerFromDb(app.db),f.env).processOrder({action:'processScheduledOrder',
      job:'unpaid_order_cancel',runId:'assisted-local-close',scheduledAt:(Number(root.add_time)+7200)*1000,
      threshold:Number(root.add_time)+3600,orderId:Number(root.id)});
  }
  async function accountEffects(app:Role){
    const tables=['store_coupon_user','store_order_product_coupon_reward','luck_lottery_entitlement'];
    return Promise.all(tables.map(table=>app.exec(`SELECT * FROM ${table} ORDER BY id`)));
  }
  async function unpaid(client:Awaited<ReturnType<typeof http>>,uid:number){
    const {body,quote}=await confirm(client,uid);
    const made=await client.post<Created>(`create/${quote.orderKey}/${uid}`,{...body,quoteToken:quote.quoteToken});
    expect(made.status,made.msg).toBe(200);return made.data.result.order_id;
  }
  async function payBody(orderNo:string,paytype='cash'){
    const rows=await f.exec('SELECT pay_price FROM store_order');
    if(rows.length!==1)throw Error('Expected exactly one local assisted order');
    return {uni:orderNo,paytype,expected_pay_price:String(rows[0].pay_price)};
  }
  async function pgHasBlockedSession(){
    for(let attempt=0;attempt<50;attempt++){
      const [waiter]=await f.exec(`SELECT count(*)::integer AS n FROM pg_stat_activity
        WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0`);
      if(Number(waiter.n)>0)return true;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    return false;
  }
  function verifiedCallback(provider:'wechat'|'alipay',orderNo:string,amountCents:number):VerifiedPaymentCallback{
    return {provider,profile:provider,providerEventId:`local_${provider}_verified_event`,
      orderNo,transactionId:`local_${provider}_verified_trade`,
      tradeState:provider==='wechat'?'SUCCESS':'TRADE_SUCCESS',amountCents,currency:'CNY',providerEventTime:1234};
  }
  function enableLocalWechatReadiness(){
    const original=f.env.CONFIG_KV;
    const settings:Record<string,string>={
      cfg_pay_weixin_open:'1',cfg_pay_weixin_mchid:'1900000109',
      cfg_pay_weixin_serial_no:'5157F09EFDC096DE15EBE81A47057A7232F1B8E1',
      cfg_site_url:'https://shop.example.test',cfg_wechat_appid:'wx_local_assisted',
    };
    f.env.CONFIG_KV=({ ...original,
      get:(key:string)=>Object.hasOwn(settings,key)?Promise.resolve(settings[key]):original.get(key),
    } as unknown as Env['CONFIG_KV']);
    Object.assign(f.env,{WECHAT_MCH_PRIVATE_KEY:'-----BEGIN PRIVATE KEY-----\nlocal\n-----END PRIVATE KEY-----',
      WECHAT_API_V3_KEY:'x'.repeat(32),WECHAT_PLATFORM_PUBLIC_KEY:'-----BEGIN PUBLIC KEY-----\nlocal\n-----END PUBLIC KEY-----'});
  }

  const formTemplate = () => [
    {id:'email',name:'texts',titleConfig:{value:'联系邮箱'},titleShow:{val:true},valConfig:{tabVal:3},value:''},
    {id:'color',name:'radios',titleConfig:{value:'颜色'},titleShow:{val:true},wordsConfig:{list:[{val:'蓝色'},{val:'红色'}]},value:''},
    {id:'extras',name:'checkboxs',wordsConfig:{list:[{val:'A'},{val:'B'}]},value:''},
    {id:'select',name:'selects',wordsConfig:{list:['S','M']},value:''},
    {id:'city',name:'citys',value:''}, {id:'date',name:'dates',value:''},
    {id:'range',name:'dateranges',value:[]}, {id:'time',name:'times',value:''},
    {id:'times',name:'timeranges',value:''}, {id:'image',name:'uploadPicture',numConfig:{val:2},value:[]},
  ];
  const formAnswers = () => ['local@example.test','蓝色',['A','B'],'M','本地市','2026-10-01',
    ['2026-10-01','2026-10-02'],'10:30','10:30 - 12:00',[]];
  const submission = () => formTemplate().map((component,index)=>({id:component.id,name:component.name,value:formAnswers()[index]}));
  async function seedForm(value:unknown=formTemplate()){
    await f.db.insert(systemForm).values({id:77,name:'代客商品表单',value:JSON.stringify(value),status:1});
    await f.exec('UPDATE store_product SET system_form_id=77 WHERE id=70');
  }
  const collectedForms = () => f.exec('SELECT uid,system_form_id,type,relation_id,value FROM system_form_data ORDER BY id');
  const formState = async()=>({business:await f.state(),forms:await collectedForms()});

  if (phase === 'form') {
  it.each([11,0])('uploads private form images under actor/buyer/checkout/form scope, uid=%i',async uid=>{
    await seedForm();
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),{quote}=await confirm(client,uid),before=await formState();
      const result=await client.upload(quote.orderKey,uid,1,{adminId:'2',uid:'12',tourist_uid:'forged',systemFormId:'99'});
      expect(result.body.status,result.body.msg).toBe(200);
      expect(result.response.headers.get('cache-control')).toContain('no-store');
      const [row]=await f.exec(`SELECT * FROM system_attachment WHERE att_id=${result.body.data.att_id}`);
      const scope=await assistedFormAttachmentScope({adminId:1,uid,touristUid:uid?'':'local_guest_a',key:quote.orderKey,systemFormId:77});
      expect(row).toMatchObject({type:1,relation_id:1,module_type:5,file_type:1,image_type:8,pid:0});
      expect(belongsToAssistedFormScope(String(row.name),scope)).toBe(true);
      expect(String(row.name).length).toBeLessThanOrEqual(100);
      expect(await formState()).toEqual(before); expect(client.objects.size).toBe(1);
      const assets=new AttachmentService(createContainerFromDb(app.db),f.env);
      expect((await assets.list(adminAttachmentScope(),{})).list).toEqual([]);
      if(uid)expect((await assets.list(userAttachmentScope(uid),{})).list).toEqual([]);
      await expect(assets.delete(adminAttachmentScope(),[row.att_id])).rejects.toThrow('不存在');
      const signed=new URL(result.body.data.src,'https://fixture.invalid');
      const asset=await assets.getSignedAsset(row.att_id,signed.searchParams.get('expires'),signed.searchParams.get('signature'));
      expect(new Uint8Array(await asset.response.arrayBuffer())).toEqual(new Uint8Array([137,80,78,71,13,10,26,10]));
      expect(client.getObject).toHaveBeenCalledWith(row.name,undefined);
    });
  });

  it('rejects missing/customer/other-actor/read-only/user-reader credentials before R2 or metadata writes',async()=>{
    await seedForm(); await profiles(async(app,admin)=>{
      const client=await http(app,admin),{quote}=await confirm(client,11);
      for(const actor of [0,-1,2,3,4])expect((await client.upload(quote.orderKey,11,actor)).body.status).not.toBe(200);
      expect(client.put).not.toHaveBeenCalled(); expect(await f.exec('SELECT att_id FROM system_attachment')).toEqual([]);
    });
  });

  it('does not delete a committed object when the metadata COMMIT acknowledgement is lost',async()=>{
    await seedForm(); await profiles(async(app,admin)=>{
      const client=await http(app,admin),{quote}=await confirm(client,11);
      const original=di.withTx;
      let injectedCode: string | undefined;
      const spy=vi.spyOn(di,'withTx').mockImplementation(async(...args)=>{
        const result=await original(...args);
        if(typeof result==='number')throw Object.assign(Error('Synthetic lost COMMIT acknowledgement'),{code:injectedCode});
        return result;
      });
      try {
        for(const code of [undefined,'40003','08006']) { injectedCode=code;
          const result=await client.upload(quote.orderKey,11);
          expect(result.body.status).not.toBe(200); expect(result.body.data).toBeNull(); }
        const rows=await f.exec('SELECT att_id,name FROM system_attachment'); expect(rows).toHaveLength(3);
        for(const row of rows)expect(client.objects.has(String(row.name))).toBe(true);
        expect(client.remove).not.toHaveBeenCalled(); expect(client.send).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); }
    });
  });

  it('queues compensation for a definitively rejected upload if direct object cleanup fails',async()=>{
    await seedForm(); await profiles(async(app,admin)=>{
      const client=await http(app,admin),{quote}=await confirm(client,0);
      client.onPut(async()=>{await f.exec('UPDATE system_form SET status=0 WHERE id=77');});
      client.remove.mockRejectedValueOnce(Error('Synthetic R2 deletion failure'));
      expect((await client.upload(quote.orderKey,0)).body.status).not.toBe(200);
      expect(await f.exec('SELECT att_id FROM system_attachment')).toEqual([]);
      expect(client.send).toHaveBeenCalledWith({action:'deleteAttachmentObjects',keys:[...client.objects.keys()]});
      // Execute the actual cleanup consumer against the synthetic bucket.
      await new AttachmentService(createContainerFromDb(app.db),f.env).processObjectCleanup({action:'deleteAttachmentObjects',keys:[...client.objects.keys()]});
      expect(client.objects.size).toBe(0);
    });
  });

  it.each(['expired','buyer','cart-owner','no-form','disabled','no-image','category','created'] as const)(
    'rejects stale/invalid upload context: %s',async reason=>{
      await seedForm(); await profiles(async(app,admin)=>{
        const client=await http(app,admin),{quote,body}=await confirm(client,11);
        if(reason==='expired') { const key=`admin:assisted:checkout:1:11:${quote.orderKey}`;
          const saved=JSON.parse((await f.env.CONFIG_KV.get(key))!); saved.createdAt-=1801; await f.env.CONFIG_KV.put(key,JSON.stringify(saved)); }
        if(reason==='cart-owner')await f.exec('UPDATE store_cart SET staff_id=2 WHERE staff_id=1');
        if(reason==='no-form')await f.exec('UPDATE store_product SET system_form_id=0 WHERE id=70');
        if(reason==='disabled')await f.exec('UPDATE system_form SET status=0 WHERE id=77');
        if(reason==='no-image')await f.exec(`UPDATE system_form SET value='[{"id":"text","name":"texts"}]' WHERE id=77`);
        if(reason==='created')expect((await client.post<Created>(`create/${quote.orderKey}/11`,{...body,quoteToken:quote.quoteToken,customForm:submission()})).status).toBe(200);
        const before=await formState();
        expect((await client.upload(quote.orderKey,reason==='buyer'?0:11,1,reason==='category'?{pid:'1'}:{})).body.status).not.toBe(200);
        expect(client.put).not.toHaveBeenCalled(); expect(await formState()).toEqual(before);
      });
    });

  it.each(['form-disabled','form-changed','cart-paid','metadata-denied'] as const)(
    'compensates the completed R2 write if final metadata authorization fails: %s',async reason=>{
      await seedForm(); await profiles(async(app,admin)=>{
        const client=await http(app,admin),{quote}=await confirm(client,11);
        client.onPut(async()=>{
          if(reason==='form-disabled')await f.exec('UPDATE system_form SET status=0 WHERE id=77');
          if(reason==='form-changed'){await f.db.insert(systemForm).values({id:78,name:'Other form',status:1,value:JSON.stringify(formTemplate())});
            await f.exec('UPDATE store_product SET system_form_id=78 WHERE id=70');}
          if(reason==='cart-paid')await f.exec('UPDATE store_cart SET is_pay=1 WHERE staff_id=1');
          if(reason==='metadata-denied')await f.exec(`REVOKE INSERT ON system_attachment FROM "${app.role}"`);
        });
        try { expect((await client.upload(quote.orderKey,11)).body.status).not.toBe(200);
          expect(client.put).toHaveBeenCalledTimes(1); expect(client.remove).toHaveBeenCalledTimes(1);
          expect(client.objects.size).toBe(0); expect(await f.exec('SELECT att_id FROM system_attachment')).toEqual([]);
        } finally { if(reason==='metadata-denied')await f.exec(`GRANT INSERT ON system_attachment TO "${app.role}"`); }
      });
    });

  it.each([[11,false],[11,true],[0,false],[0,true]] as const)(
    'reads and atomically collects all ten form components for uid=%i legacy=%s, then replays without another collection',async(uid,legacy)=>{
      const template=formTemplate();
      await seedForm(legacy?Object.fromEntries(template.map((field,index)=>[String(100+index),{...field,timestamp:100+index}]).reverse()):template);
      await profiles(async(app,admin)=>{
        const client=await http(app,admin),{body,quote}=await confirm(client,uid),before=await formState();
        const preview=await client.post<{result:{systemForm:{version:number;id:number;name:string;value:Array<{id:string}>};custom_form:unknown[]}}>(
          `computed/${quote.orderKey}/${uid}`,body);
        expect(preview.status,preview.msg).toBe(200);
        expect(preview.data.result.systemForm).toMatchObject({version:1,id:77,name:'代客商品表单'});
        expect(preview.data.result.systemForm.value.map(field=>field.id)).toEqual(template.map(field=>field.id));
        expect(preview.data.result.custom_form).toEqual(preview.data.result.systemForm.value);
        expect(await formState()).toEqual(before);
        const answers=submission().map(field=>({...field,titleConfig:{value:'伪造标题'},titleShow:{val:false},wordsConfig:{list:['伪造选项']}}));
        const made=await client.post<Created>(`create/${quote.orderKey}/${uid}`,{...body,quoteToken:quote.quoteToken,
          [legacy?'custom_form':'customForm']:answers});
        expect(made.status,made.msg).toBe(200);
        const [order]=await f.exec('SELECT id,uid,custom_form,paid FROM store_order WHERE is_channel=2');
        expect(order.uid).toBe(uid);expect(order.paid).toBe(0);
        const snapshot=JSON.parse(String(order.custom_form));
        expect(snapshot.map((field:{value:unknown})=>field.value)).toEqual(formAnswers());
        expect(snapshot[0].titleConfig).toEqual({value:'联系邮箱'});expect(snapshot[0].titleShow).toEqual({val:true});
        const forms=await collectedForms();expect(forms).toHaveLength(1);
        expect(forms[0]).toMatchObject({uid,system_form_id:'77',type:1,relation_id:order.id});
        expect(JSON.parse(String(forms[0].value))[0]).toMatchObject({title:'联系邮箱',require:true,value:'local@example.test'});
        await f.exec('UPDATE system_form SET status=0 WHERE id=77');
        const committed=await formState();
        const replay=await client.post<Created>(`create/${quote.orderKey}/${uid}`,{...body,customForm:[],custom_form:[]});
        expect(replay).toMatchObject({status:200,data:{result:{order_id:made.data.result.order_id,extended:true}}});
        expect(await formState()).toEqual(committed);
      });
    },60_000);

  it('rejects missing, forged, duplicate and unknown answers before commit and corrects on the same key',async()=>{
    await seedForm();
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),{body,quote}=await confirm(client,11),before=await formState();
      const answers=submission();
      for(const invalid of [undefined,[],answers.slice(1),[...answers,answers[0]],
        answers.map((field,index)=>index===0?{...field,value:'',titleShow:{val:false}}:field),
        answers.map((field,index)=>index===1?{...field,value:'伪造选项',wordsConfig:{list:['伪造选项']}}:field)]){
        expect(await client.post(`create/${quote.orderKey}/11`,{...body,quoteToken:quote.quoteToken,customForm:invalid}))
          .toMatchObject({status:400,data:{errorCode:'ORDER_FORM_REJECTED',orderKey:quote.orderKey}});
        expect(await formState()).toEqual(before);
      }
      expect(await client.post(`create/${quote.orderKey}/11`,{...body,quoteToken:quote.quoteToken,customForm:answers,custom_form:answers}))
        .toMatchObject({status:400,data:{errorCode:'ORDER_FORM_REJECTED'}});
      expect(await formState()).toEqual(before);
      expect((await client.post(`create/${quote.orderKey}/11`,{...body,quoteToken:quote.quoteToken,customForm:answers})).status).toBe(200);
      expect(await collectedForms()).toHaveLength(1);
    });
  },60_000);

  it.each(['disabled','deleted','required-added','choices-changed','malformed','oversized'] as const)(
    'requires a fresh quote after the authoritative form changes: %s',async change=>{
      await seedForm();
      await profiles(async(app,admin)=>{
        const client=await http(app,admin),{body,quote}=await confirm(client,11);
        if(change==='disabled')await f.exec('UPDATE system_form SET status=0 WHERE id=77');
        else if(change==='deleted')await f.exec('UPDATE system_form SET is_del=1 WHERE id=77');
        else if(change==='malformed')await f.exec("UPDATE system_form SET value='broken' WHERE id=77");
        else if(change==='oversized')await f.exec("UPDATE system_form SET value=repeat('x',1000001) WHERE id=77");
        else await f.db.update(systemForm).set({value:JSON.stringify(change==='required-added'
          ?[...formTemplate(),{id:'extra',name:'texts',titleShow:{val:true},value:''}]
          :formTemplate().map(field=>field.id==='color'?{...field,wordsConfig:{list:['绿色']}}:field))});
        const before=await formState();
        expect(await client.post(`create/${quote.orderKey}/11`,{...body,quoteToken:quote.quoteToken,customForm:submission()}))
          .toMatchObject({status:400,data:{errorCode:'ORDER_QUOTE_RECONFIRM_REQUIRED',orderKey:quote.orderKey}});
        expect(await formState()).toEqual(before);
        const refreshed=await client.post(`computed/${quote.orderKey}/11`,body);
        expect(refreshed.status).toBe(['required-added','choices-changed'].includes(change)?200:400);
      });
    },60_000);

  it.each([[11,11,3,3,R2_IMAGE_TYPE,false],[11,12,3,3,R2_IMAGE_TYPE,false],[11,11,3,4,R2_IMAGE_TYPE,false],
    [11,11,1,1,R2_IMAGE_TYPE,false],[11,11,3,3,1,false],[0,0,3,3,R2_IMAGE_TYPE,false],[0,11,3,3,R2_IMAGE_TYPE,false]] as const)(
    'checks image principal and namespace uid=%i owner=%i type=%i module=%i storage=%i allowed=%s',async(uid,owner,type,module,storage,allowed)=>{
      await seedForm([{id:'proof',name:'uploadPicture',titleShow:{val:true},value:[]}]);
      await f.db.insert(systemAttachment).values({attId:901,type,relationId:owner,moduleType:module,imageType:storage,fileType:1});
      await profiles(async(app,admin)=>{
        const client=await http(app,admin),{body,quote}=await confirm(client,uid),before=await formState();
        const result=await client.post(`create/${quote.orderKey}/${uid}`,{...body,quoteToken:quote.quoteToken,
          customForm:[{id:'proof',name:'uploadPicture',value:['/api/assets/901']}]});
        expect(result.status,result.msg).toBe(allowed?200:400);
        if(!allowed){expect(result.data).toMatchObject({errorCode:'ORDER_FORM_REJECTED'});expect(await formState()).toEqual(before);}
        else expect(await collectedForms()).toHaveLength(1);
      });
    },60_000);

  it('rolls back order, points and inventory if collection INSERT is denied without granting a correction for SQL failure',async()=>{
    await seedForm();
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),{body,quote}=await confirm(client,11),before=await formState();
      await f.exec(`REVOKE INSERT ON public.system_form_data FROM "${app.role}"`);
      expect(await client.post(`create/${quote.orderKey}/11`,{...body,quoteToken:quote.quoteToken,customForm:submission()}))
        .toMatchObject({status:400,data:null});
      expect(await formState()).toEqual(before);
      await f.exec(`GRANT INSERT ON public.system_form_data TO "${app.role}"`);
      expect((await client.post(`create/${quote.orderKey}/11`,{...body,quoteToken:quote.quoteToken,customForm:submission()})).status).toBe(200);
      expect(await collectedForms()).toHaveLength(1);
    });
  },60_000);

  it('preserves unknown outcome after committed create/readback failure and resolves it by replay without duplicate form data',async()=>{
    await seedForm();
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),{body,quote}=await confirm(client,11);
      const original=StoreOrderCreateService.prototype.createOrder;
      const createSpy=vi.spyOn(StoreOrderCreateService.prototype,'createOrder').mockImplementationOnce(async function(this:StoreOrderCreateService,...args){
        const result=await original.apply(this,args);
        await f.exec(`REVOKE SELECT ON public.store_order FROM "${app.role}"`);
        return result;
      });
      const input={...body,quoteToken:quote.quoteToken,customForm:submission()};
      expect(await client.post(`create/${quote.orderKey}/11`,input)).toMatchObject({status:400,data:null});
      createSpy.mockRestore();expect(await collectedForms()).toHaveLength(1);
      await f.exec(`GRANT SELECT ON public.store_order TO "${app.role}"`);
      const before=await formState();
      expect(await client.post(`create/${quote.orderKey}/11`,input)).toMatchObject({status:200,data:{result:{extended:true}}});
      expect(await formState()).toEqual(before);
    });
  },60_000);

  it('accepts valid form JSON above the old 32KiB limit but rejects oversized request bodies before creation',async()=>{
    const template=Array.from({length:5},(_,id)=>({id:String(id),name:'texts',value:''}));
    await seedForm(template);
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),{body,quote}=await confirm(client,11),before=await formState();
      expect((await client.post(`create/${quote.orderKey}/11`,{...body,quoteToken:quote.quoteToken,customForm:'x'.repeat(1_100_001)})).status).toBe(400);
      expect(client.sequence).not.toHaveBeenCalled();expect(await formState()).toEqual(before);
      expect((await client.post(`create/${quote.orderKey}/11`,{...body,quoteToken:quote.quoteToken,
        customForm:template.map(field=>({...field,value:'本'.repeat(8000)}))})).status).toBe(200);
      expect(await collectedForms()).toHaveLength(1);
    });
  },60_000);

  it('pins the validated form until collection commits and fails fast against an in-progress template edit',async()=>{
    await seedForm();
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),{body,quote}=await confirm(client,11),before=await formState();
      const input={...body,quoteToken:quote.quoteToken,customForm:submission()};
      if (!f.withPeer) throw Error('Independent owned sequence-fixture peer is required');
      await f.withPeer(async editor=>{
        await editor.exec('BEGIN; UPDATE system_form SET name=name WHERE id=77');
        expect(await client.post(`create/${quote.orderKey}/11`,input)).toMatchObject({status:400,data:null});
        expect(await formState()).toEqual(before);await editor.exec('ROLLBACK');
        await editor.exec("SET lock_timeout='100ms'");
        const collect=orderForms.collectOrderSystemForm;
        let attempted=false;
        const collecting=vi.spyOn(orderForms,'collectOrderSystemForm').mockImplementationOnce(async(...args)=>{
          attempted=true;
          await expect(editor.exec('UPDATE system_form SET status=0 WHERE id=77')).rejects.toMatchObject({code:'55P03'});
          return collect(...args);
        });
        expect((await client.post(`create/${quote.orderKey}/11`,input)).status).toBe(200);
        expect(attempted).toBe(true);collecting.mockRestore();
        // Once checkout commits, the same management connection can write.
        await editor.exec('UPDATE system_form SET status=0 WHERE id=77');
      });
      expect(await collectedForms()).toHaveLength(1);
    });
  },60_000);

  it('includes the selected form in the quote MVCC snapshot and rejects a later edit before answer validation',async()=>{
    await seedForm();
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),{body,quote}=await confirm(client,11);
      const original=StoreOrderCreateService.prototype.quoteOrder;
      const pricing=vi.spyOn(StoreOrderCreateService.prototype,'quoteOrder').mockImplementationOnce(async function(this:StoreOrderCreateService,...args){
        const result=await original.apply(this,args);
        await f.db.update(systemForm).set({value:JSON.stringify([...formTemplate(),{id:'new-field',name:'texts',titleShow:{val:true},value:''}])});
        return result;
      });
      const preview=await client.post<{result:{systemForm:{value:unknown[]}}}>(`computed/${quote.orderKey}/11`,body);
      expect(preview.status,preview.msg).toBe(200);expect(preview.data.result.systemForm.value).toHaveLength(10);
      pricing.mockRestore();const before=await formState();
      expect(await client.post(`create/${quote.orderKey}/11`,{...body,quoteToken:quote.quoteToken,customForm:submission()}))
        .toMatchObject({status:400,data:{errorCode:'ORDER_QUOTE_RECONFIRM_REQUIRED'}});
      expect(await formState()).toEqual(before);
      const refreshed=await client.post<{result:{systemForm:{value:unknown[]}}}>(`computed/${quote.orderKey}/11`,body);
      expect(refreshed.status,refreshed.msg).toBe(200);expect(refreshed.data.result.systemForm.value).toHaveLength(11);
    });
  },60_000);

  } else if (phase === 'flow') {
  it.each([[11,'saved'],[11,'manual'],[0,'manual'],[11,'pickup'],[11,'virtual'],[0,'virtual']] as const)(
    'returns complete confirm/recomputed projections for uid=%i %s without business writes',async(uid,delivery)=>{
      await profiles(async(app,admin)=>{
        const client=await http(app,admin),{body,quote,cartId}=await confirm(client,uid,delivery),before=await f.state();
        const confirmed=await client.post<CompleteQuote>('confirm/'+uid,body);
        expect(confirmed.status,confirmed.msg).toBe(200);
        const recalculated=await client.post<{result:CompleteQuote & {usedIntegral:number}}>(`computed/${quote.orderKey}/${uid}`,body);
        expect(recalculated.status,recalculated.msg).toBe(200);
        const result=recalculated.data.result;
        expect(result.orderKey).toBe(quote.orderKey);expect(result.quoteToken).not.toBe(quote.quoteToken);
        for(const data of [confirmed.data,result]){
          expect(data.cartInfo).toMatchObject([{id:cartId,cart_num:2}]);
          expect(data.checkout).toEqual({version:1,adminId:1,uid,touristUid:uid?'':'local_guest_a',cartIds:[cartId],
            isNew:1,shippingType:delivery==='pickup'?2:1,storeId:delivery==='pickup'?1:0,
            addressSource:['manual','saved'].includes(delivery)?delivery:'none',
            addressRequired:['manual','saved'].includes(delivery),useIntegral:true,couponId:0,payType:'weixin',systemFormId:0});
          expect(data.integral_ratio_status).toBe(uid?1:0);expect(Number(data.integralRatio)).toBeGreaterThan(0);
          if(delivery==='manual')expect(data.addressInfo).toMatchObject({id:0,city_id:101,real_name:'本地游客',detail:'隔离游客样本'});
          else if(delivery==='saved')expect(data.addressInfo?.id).toBe(11);
          else expect(data.addressInfo).toBeNull();
        }
        expect(result.usedIntegral).toBe(result.priceGroup.usedIntegral);
        expect(await f.state()).toEqual(before);expect(client.sequence).not.toHaveBeenCalled();expect(client.sendBatch).not.toHaveBeenCalled();
      });
    },60_000);

  it('keeps cart/address/pricing/points in one read-only MVCC snapshot and rejects its stale receipt',async()=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),{body,quote,cartId}=await confirm(client,11);
      const old=await client.post<CompleteQuote>('confirm/11',body);expect(old.status,old.msg).toBe(200);
      const original=StoreOrderCreateService.prototype.quoteOrder;
      let observed=false;
      const quoteSpy=vi.spyOn(StoreOrderCreateService.prototype,'quoteOrder').mockImplementationOnce(async function(this:StoreOrderCreateService,...args){
        const [context]=await this['container'].db.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,
          current_setting('transaction_read_only') AS readonly, current_setting('statement_timeout') AS timeout,
          current_setting('idle_in_transaction_session_timeout') AS idle`);
        expect(context).toMatchObject({isolation:'repeatable read',readonly:'on',timeout:'5s',idle:'5s'});
        // A different actual connection commits after display/cart reads, before
        // the real pricing core. No fake quote result or artificial SQL engine.
        await f.exec(`UPDATE store_cart SET cart_num=1 WHERE id=${cartId};
          UPDATE store_product_attr_value SET price=price+11 WHERE product_id=70 AND type=0;
          UPDATE user_address SET detail='另一个快照地址' WHERE id=11;
          UPDATE system_config SET value='0' WHERE menu_name='integral_ratio_status'`);
        observed=true;return original.apply(this,args);
      });
      const current=await client.post<{result:CompleteQuote}>(`computed/${quote.orderKey}/11`,body);
      expect(observed).toBe(true);expect(current.status,current.msg).toBe(200);
      const snapshot=current.data.result;
      expect(snapshot.cartInfo).toEqual(old.data.cartInfo);expect(snapshot.addressInfo).toEqual(old.data.addressInfo);
      expect(snapshot.priceGroup).toEqual(old.data.priceGroup);expect(snapshot.integral_ratio_status).toBe(1);
      quoteSpy.mockRestore();
      const changed=await f.state();
      expect((await client.post(`create/${quote.orderKey}/11`,{...body,quoteToken:snapshot.quoteToken})).status).toBe(400);
      expect(await f.state()).toEqual(changed);expect(client.sequence).not.toHaveBeenCalled();
      const fresh=await client.post<{result:CompleteQuote}>(`computed/${quote.orderKey}/11`,body);
      expect(fresh.status,fresh.msg).toBe(200);expect(fresh.data.result.cartInfo[0].cart_num).toBe(1);
      expect(fresh.data.result.addressInfo?.detail).toBe('另一个快照地址');
      expect(fresh.data.result.integral_ratio_status).toBe(0);expect(fresh.data.result.priceGroup.usedIntegral).toBe(0);
      expect(fresh.data.result.priceGroup.totalPrice).not.toBe(snapshot.priceGroup.totalPrice);
      expect((await client.post(`create/${quote.orderKey}/11`,{...body,quoteToken:fresh.data.result.quoteToken})).status).toBe(200);
    });
  },60_000);

  it('does not hold a business transaction during KV reads/writes, including cache misses and receipt failure',async()=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),{body,quote}=await confirm(client,11),before=await f.state();
      let insideCore=false;
      const original=StoreOrderCreateService.prototype.quoteOrder;
      vi.spyOn(StoreOrderCreateService.prototype,'quoteOrder').mockImplementation(async function(this:StoreOrderCreateService,...args){
        insideCore=true;
        try{return await original.apply(this,args);}finally{insideCore=false;}
      });
      const assertOutside=async()=>{
        expect(insideCore).toBe(false);
        // Independent preflight config cache misses can execute ordinary SQL in
        // parallel. An active autocommit statement is not a held quote transaction.
        // Core instrumentation above rejects KV anywhere inside actual pricing;
        // this check also covers the interval before issuing receipts after it.
        const [row]=await f.exec(`SELECT count(*)::integer AS n FROM pg_stat_activity
          WHERE datname=current_database() AND usename='${app.role}' AND state LIKE 'idle in transaction%'`);
        expect(row.n).toBe(0);
      };
      const kv:SystemConfigEnv['CONFIG_KV']=f.env.CONFIG_KV;
      const get=kv.get.bind(kv),put=kv.put.bind(kv);
      const getSpy=vi.spyOn(kv,'get').mockImplementation(async(key:string)=>{
        await assertOutside();return key.startsWith('cfg_')?null:get(key);
      });
      const putSpy=vi.spyOn(kv,'put').mockImplementation(async(key:string,value:string)=>{
        await assertOutside();return put(key,value);
      });
      const computed=await client.post<{result:CompleteQuote}>(`computed/${quote.orderKey}/11`,body);
      expect(computed.status,computed.msg).toBe(200);expect(getSpy).toHaveBeenCalled();expect(putSpy).toHaveBeenCalled();
      getSpy.mockImplementation(async(key:string)=>{await assertOutside();return get(key);});
      putSpy.mockImplementation(async(key:string)=>{
        await assertOutside();expect(key).toMatch(/^order:quote:v1:/);throw Error('Local KV receipt unavailable');
      });
      const failed=await client.post(`computed/${quote.orderKey}/11`,body);
      expect(failed.status).toBe(400);expect(failed.msg).toBe('Local KV receipt unavailable');
      expect(await f.state()).toEqual(before);expect(client.sequence).not.toHaveBeenCalled();
    });
  },60_000);

  it('rejects unsupported assisted payment pricing and inactive pickup stores before issuing a quote',async()=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),{body,quote}=await confirm(client,11),before=await f.state();
      for(const options of [{payType:'offline'},{payType:'yue'},{shipping_type:2,store_id:999},{shipping_type:2,store_id:1}]){
        const result=await client.post(`computed/${quote.orderKey}/11`,{...body,...options});
        expect(result.status,result.msg).toBe(400);expect(await f.state()).toEqual(before);
      }
      expect(client.sequence).not.toHaveBeenCalled();
    });
  },60_000);

  it.each(['/api/admin','/adminapi'])('keeps %s user lookup behind user.view on the independent Admin LOGIN',async prefix=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),before=await f.state();
      for(const actor of [0,-1,1,2,3]){
        const denied=await client.users(prefix,'?uid=11',actor);
        expect(denied.body.status).toBe(400);expect(denied.body.data).toBeNull();
      }
      expect(client.identities).toEqual([]);
      const listed=await client.users(prefix,'?uid=11');
      expect(listed.body.status,listed.body.msg).toBe(200);expect(listed.body.data.list).toHaveLength(1);
      expect(listed.body.data.list[0]).toHaveProperty('uid',11);
      expect(listed.body.data.list[0]).not.toHaveProperty('pwd');
      expect(listed.response.headers.get('cache-control')).toContain('no-store');
      expect(client.identities).toEqual([{app:app.role,admin:admin.role}]);
      // A list reader still cannot create assisted orders.
      expect((await client.post('cart/add/11',{productId:70,uniqueId:'qared001',cartNum:1,new:1},4)).status).toBe(400);
      expect(client.identities).toHaveLength(1);
      // Negative privilege proof: deliberately narrow ONLY this disposable
      // reader to the exact list/filter columns. select(*) would now fail.
      await f.exec(`REVOKE SELECT ON public."user" FROM "${admin.role}";
        GRANT SELECT(uid,account,nickname,phone,avatar,integral,level,status,now_money,add_time,spread_uid,group_id,is_del,delete_time)
          ON public."user" TO "${admin.role}"`);
      expect((await client.users(prefix,'?nickname=11&status=1')).body).toEqual(listed.body);
      expect(await f.state()).toEqual(before);expect(client.sequence).not.toHaveBeenCalled();expect(client.sendBatch).not.toHaveBeenCalled();
    });
  },60_000);

  it.each([11,0])('finishes uid=%i assisted cash payment and durable effects exactly once',async uid=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),{body,quote}=await confirm(client,uid);
      await f.exec(`INSERT INTO store_coupon_issue(id,coupon_type,type,coupon_price) VALUES(700,0,1,1);
        INSERT INTO store_product_coupon(product_id,issue_coupon_id) VALUES(70,700);
        INSERT INTO luck_lottery(factor,factor_num,start_time,end_time,status) VALUES(3,2,0,2147483647,1)`);
      const created=await client.post<Created>(`create/${quote.orderKey}/${uid}`,{...body,quoteToken:quote.quoteToken});
      expect(created.status,created.msg).toBe(200);
      const orderNo=created.data.result.order_id,path='pay/'+uid,input=await payBody(orderNo);
      const before=await f.state();
      expect((await client.get<{status:boolean}>('pay/status?order_id='+orderNo)).data.status).toBe(false);
      expect((await client.get<{list:Array<{order_id:string}>}>('place/list?paging=cursor')).data.list.map(row=>row.order_id)).toEqual([orderNo]);
      expect((await client.get<{list:unknown[]}>('place/list?paging=cursor',2)).data.list).toEqual([]);
      for(const [url,actor] of [[path,2],['pay/'+(uid?22:11),1]] as const){
        expect((await client.post(url,input,actor)).status).toBe(400);expect(await f.state()).toEqual(before);
      }
      expect((await client.get('pay/status?order_id='+orderNo,2)).status).toBe(400);
      for(const paytype of ['weixin','alipay']){
        expect((await client.post(path,{...input,paytype})).status).toBe(400);expect(await f.state()).toEqual(before);
      }
      const paid=await client.post<{status:string}>(path,input);expect(paid.status,paid.msg).toBe(200);expect(paid.data.status).toBe('SUCCESS');
      expect((await client.get<{status:boolean}>('pay/status?order_id='+orderNo)).data.status).toBe(true);
      const [order]=await app.exec('SELECT id,uid,paid,pay_type FROM store_order');
      expect(order).toMatchObject({uid,paid:1,pay_type:'cash'});
      const [event]=await app.exec("SELECT id,event_key,status FROM store_order_outbox WHERE event_type='order.paid'");
      expect(event.status).toBe('ENQUEUED');expect(client.sendBatch).toHaveBeenCalledTimes(1);
      expect(await app.exec("SELECT count(*)::integer AS n FROM store_order_status WHERE change_type='admin_assisted_pay'"))
        .toEqual([{n:1}]);
      const committed=await f.state();expect((await client.post(path,input)).status).toBe(200);expect(await f.state()).toEqual(committed);
      const service=new OrderOutboxService(createContainerFromDb(app.db),f.env);
      const message={action:'processOrderPaidOutbox' as const,outboxId:Number(event.id),eventKey:String(event.event_key)};
      expect(await service.processMessage(message)).toBe('completed');
      expect(await app.exec("SELECT status FROM store_order_outbox WHERE event_type='order.paid'" )).toEqual([{status:'COMPLETED'}]);
      expect(await app.exec("SELECT count(*)::integer AS n FROM store_order_status WHERE change_type='pay_success'"))
        .toEqual([{n:1}]);
      expect(await app.exec('SELECT pay_count FROM "user" WHERE uid=11')).toEqual([{pay_count:uid?1:0}]);
      expect(await app.exec('SELECT count(*)::integer AS n FROM "user" WHERE uid=0')).toEqual([{n:0}]);
      expect(await app.exec('SELECT count(*)::integer AS n FROM supplier_transactions')).toEqual([{n:1}]);
      const rewards=await accountEffects(app);
      for(const rows of rewards){expect(rows).toHaveLength(uid?1:0);if(uid)expect(rows[0].uid).toBe(uid);}
      const done=await f.state();expect(await service.processMessage(message)).toBe('already-completed');
      expect((await client.post(path,input)).status).toBe(200);expect(await f.state()).toEqual(done);
      expect(await accountEffects(app)).toEqual(rewards);
      expect(client.sendBatch).toHaveBeenCalledTimes(1);
    });
  },60_000);

  it.each([
    {paytype:'cash',zero:false},
    {paytype:'weixin',zero:true},
  ] as const)('locks the $paytype assisted amount after a concurrent price change (zero=$zero)',async({paytype,zero})=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),orderNo=await unpaid(client,11);
      if(zero)await f.exec("UPDATE store_order SET pay_price='0.00'");
      const input=await payBody(orderNo,paytype),path='pay/11';
      const missing={uni:orderNo,paytype};
      expect((await client.post(path,missing)).status).toBe(400);
      expect((await client.post(path,{...input,expected_pay_price:'1.001'})).status).toBe(400);
      expect((await client.post(path,{...input,expected_pay_price:1.00})).status).toBe(400);
      const oldCents=Number(input.expected_pay_price.replace('.',''));
      const newCents=oldCents+1;
      const changed=`${Math.floor(newCents/100)}.${String(newCents%100).padStart(2,'0')}`;
      let blocked=false;
      await f.withPeer!(async peer=>{
        await peer.exec('BEGIN');
        let transactionOpen=true;
        let pending:Promise<Reply<{status:string}>>|undefined;
        try{
          await peer.exec(`UPDATE store_order SET pay_price='${changed}'`);
          let enteredResolve:()=>void=()=>undefined;
          const entered=new Promise<void>(resolve=>{enteredResolve=resolve;});
          const original=StoreOrderPayService.prototype.applyPayment;
          vi.spyOn(StoreOrderPayService.prototype,'applyPayment').mockImplementation(function(this:StoreOrderPayService,params){
            enteredResolve();
            return original.call(this,params);
          });
          pending=client.post<{status:string}>(path,input);
          let timer:ReturnType<typeof setTimeout>|undefined;
          try{
            await Promise.race([entered,new Promise<never>((_resolve,reject)=>{
              timer=setTimeout(()=>reject(Error('Payment did not enter locked settlement')),5000);
            })]);
          }finally{if(timer)clearTimeout(timer);}
          for(let attempt=0;attempt<60;attempt++){
            const [waiter]=await f.exec(`SELECT count(*)::integer AS n FROM pg_stat_activity
              WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0`);
            if(Number(waiter.n)>0){blocked=true;break;}
            await new Promise(resolve=>setTimeout(resolve,20));
          }
          await peer.exec('COMMIT');
          transactionOpen=false;
          const rejected=await pending;
          expect(blocked).toBe(true);
          expect(rejected).toMatchObject({status:400,msg:'订单应付金额已变化，请刷新后重新确认支付'});
        }finally{
          if(transactionOpen)await peer.exec('ROLLBACK');
          if(pending)await pending;
        }
      });
      expect(await app.exec('SELECT paid,pay_price FROM store_order')).toEqual([{paid:0,pay_price:changed}]);
      expect(await app.exec("SELECT count(*)::integer AS n FROM store_order_outbox WHERE event_type='order.paid'")).toEqual([{n:0}]);
      expect(await app.exec("SELECT count(*)::integer AS n FROM store_order_status WHERE change_type='admin_assisted_pay'")).toEqual([{n:0}]);
      expect(client.sendBatch).not.toHaveBeenCalled();
      if(zero)await f.exec("UPDATE store_order SET pay_price='0.00'");
      const current=await payBody(orderNo,paytype);
      const paid=await client.post(path,current);
      expect(paid).toMatchObject({status:200,data:{status:'SUCCESS'}});
      const committed=await f.state();
      expect((await client.post(path,missing)).status).toBe(400);
      expect((await client.post(path,{...current,expected_pay_price:zero?'0.01':input.expected_pay_price})).status).toBe(400);
      expect((await client.post(path,current)).status).toBe(200);
      expect(await f.state()).toEqual(committed);
      expect(await app.exec("SELECT count(*)::integer AS n FROM store_order_outbox WHERE event_type='order.paid'")).toEqual([{n:1}]);
      expect(await app.exec("SELECT count(*)::integer AS n FROM store_order_status WHERE change_type='admin_assisted_pay'")).toEqual([{n:1}]);
      expect(client.sendBatch).toHaveBeenCalledTimes(1);
    });
  },60_000);

  it('does not call a provider when a concurrent repricing commits after the first assisted read',async()=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),orderNo=await unpaid(client,11),input=await payBody(orderNo,'weixin');
      enableLocalWechatReadiness();
      let externalCalls=0;
      vi.spyOn(WechatPayService.prototype,'createOrder').mockImplementation(async params=>{
        await params.beforeProviderRequest?.();externalCalls++;return {code_url:'weixin://local'};
      });
      await f.withPeer!(async peer=>{
        await peer.exec('BEGIN');
        let transactionOpen=true;
        let pending:Promise<Reply<{status:string}>>|undefined;
        try{
          await peer.exec("UPDATE store_order SET pay_price=pay_price+0.01");
          pending=client.post('pay/11',input);
          let blocked=false;
          for(let attempt=0;attempt<80;attempt++){
            const [waiter]=await f.exec(`SELECT count(*)::integer AS n FROM pg_stat_activity
              WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0`);
            if(Number(waiter.n)>0){blocked=true;break;}
            await new Promise(resolve=>setTimeout(resolve,20));
          }
          expect(blocked).toBe(true);
          await peer.exec('COMMIT');transactionOpen=false;
          expect(await pending).toMatchObject({status:400,msg:'订单应付金额已变化，请刷新后重新确认支付'});
        }finally{if(transactionOpen)await peer.exec('ROLLBACK');if(pending)await pending;}
      });
      expect(externalCalls).toBe(0);
      expect(await app.exec('SELECT count(*)::integer AS n FROM payment_reconciliation_case')).toEqual([{n:0}]);
    });
  },60_000);

  it('claims one assisted provider initiation before external I/O and rejects an identical retry',async()=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),orderNo=await unpaid(client,11),input=await payBody(orderNo,'weixin');
      enableLocalWechatReadiness();
      let enteredResolve:()=>void=()=>undefined,releaseResolve:()=>void=()=>undefined;
      const entered=new Promise<void>(resolve=>{enteredResolve=resolve;});
      const release=new Promise<void>(resolve=>{releaseResolve=resolve;});
      let externalCalls=0;
      vi.spyOn(WechatPayService.prototype,'createOrder').mockImplementation(async params=>{
        await params.beforeProviderRequest?.();externalCalls++;enteredResolve();await release;
        return {code_url:'weixin://local'};
      });
      const first=client.post<{status:string}>('pay/11',input);
      try{
        await Promise.race([entered,new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(Error('Provider entry timed out')),5000))]);
        const [active]=await app.exec(`SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database()
          AND application_name IN ('cinashop_api','cinashop_admin') AND xact_start IS NOT NULL`);
        expect(active.n).toBe(0);
        expect((await client.post('pay/11',input)).status).toBe(400);
        expect(externalCalls).toBe(1);
      }finally{releaseResolve();await first;}
      expect(await app.exec('SELECT provider,expected_amount_cents,order_domain,initiated_time FROM payment_reconciliation_case'))
        .toMatchObject([{provider:'wechat',expected_amount_cents:Number(input.expected_pay_price.replace('.','')),
          order_domain:'store_order',initiated_time:expect.any(Number)}]);
      await expect(new AdminMobileOrderOperationService(createContainerFromDb(admin.db)).changePrice(1,{
        order_id:orderNo,price:'1.00',
      })).rejects.toThrow('扫码支付已发起，改价前请先人工对账');
      await expect(cancelStoreOrder(createContainerFromDb(app.db),{uid:11,orderId:orderNo}))
        .rejects.toThrow('扫码支付已发起，请先人工对账后处理取消');
      expect((await client.post('pay/11',{...input,paytype:'cash'})).status).toBe(400);
      expect((await client.post('pay/11',input)).status).toBe(400);
      await expect(new StoreOrderPayService(createContainerFromDb(app.db),f.env)
        .pay(11,orderNo,'weixin','pc')).rejects.toThrow('扫码支付已发起');
      expect(externalCalls).toBe(1);
    });
  },60_000);

  it('rejects malformed merchant signing keys before persisting an assisted provider claim',async()=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),orderNo=await unpaid(client,11),input=await payBody(orderNo,'weixin');
      enableLocalWechatReadiness();
      const failed=await client.post('pay/11',input);
      expect(failed.status).toBe(400);
      expect(await app.exec('SELECT count(*)::integer AS n FROM payment_reconciliation_case')).toEqual([{n:0}]);
      expect((await new AdminMobileOrderOperationService(createContainerFromDb(admin.db)).changePrice(1,{
        order_id:orderNo,price:'1.00',
      })).changed).toBe(true);
    });
  },60_000);

  it('keeps callback-first transaction evidence safe from local settlement, repricing and scheduled cancellation',async()=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),orderNo=await unpaid(client,11),input=await payBody(orderNo);
      const [root]=await app.exec('SELECT id,add_time,pay_price FROM store_order');
      const callback=verifiedCallback('wechat',orderNo,Number(input.expected_pay_price.replace('.','')));
      await f.withPeer!(async peer=>{
        expect(await new PaymentCallbackEventService(createContainerFromDb(peer.db),f.env).receive(callback))
          .toMatchObject({duplicate:false,terminalConflict:false});
      });
      expect(await app.exec('SELECT initiated_time,provider_transaction_id FROM payment_reconciliation_case'))
        .toEqual([{initiated_time:0,provider_transaction_id:callback.transactionId}]);
      await expect(new StoreOrderPayService(createContainerFromDb(app.db),f.env).applyPayment({
        orderId:Number(root.id),payType:'offline',
      })).rejects.toThrow('扫码支付已发起');
      await expect(new AdminMobileOrderOperationService(createContainerFromDb(admin.db)).changePrice(1,{
        order_id:orderNo,price:'1.00',
      })).rejects.toThrow('扫码支付已发起');
      await expect(cancelStoreOrder(createContainerFromDb(app.db),{uid:11,orderId:orderNo}))
        .rejects.toThrow('扫码支付已发起');
      const maintenance=new ScheduledMaintenanceService(createContainerFromDb(app.db),f.env);
      const scheduledAt=(Number(root.add_time)+7200)*1000;
      expect(await maintenance.processOrder({action:'processScheduledOrder',job:'unpaid_order_cancel',
        runId:'local-provider-pending',scheduledAt,threshold:Number(root.add_time)+3600,orderId:Number(root.id)}))
        .toMatchObject({event:'scheduled_order_skipped',reason:'provider_payment_pending'});
      expect(await maintenance.processMaintenance({action:'runScheduledMaintenance',job:'unpaid_order_cancel',
        runId:'local-provider-pending',scheduledAt,cursor:0,threshold:null}))
        .toMatchObject({event:'scheduled_unpaid_order_scan',enqueued:0});
      expect(await app.exec('SELECT paid,status,is_del,pay_price FROM store_order'))
        .toEqual([{paid:0,status:0,is_del:0,pay_price:String(root.pay_price)}]);
    });
  },60_000);

  it.each(['wechat','alipay'] as const)(
    'waits for uncommitted %s callback evidence before repricing or another provider claim',async provider=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),orderNo=await unpaid(client,11),input=await payBody(orderNo);
      const [order]=await app.exec('SELECT id,pay_price FROM store_order');
      const callback=verifiedCallback(provider,orderNo,Number(input.expected_pay_price.replace('.','')));
      await f.withPeer!(async peer=>{
        let enteredResolve:()=>void=()=>undefined,releaseResolve:()=>void=()=>undefined;
        const entered=new Promise<void>(resolve=>{enteredResolve=resolve;});
        const release=new Promise<void>(resolve=>{releaseResolve=resolve;});
        const insertion=withTx(createContainerFromDb(peer.db),async tx=>{
          const received=await persistVerifiedPaymentCallbackTx(tx,callback);
          enteredResolve();await release;return received;
        });
        let repricing:ReturnType<AdminMobileOrderOperationService['changePrice']>|undefined;
        try{
          await Promise.race([entered,new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(Error('Callback insert timed out')),5000))]);
          expect(await app.exec('SELECT count(*)::integer AS n FROM payment_reconciliation_case')).toEqual([{n:0}]);
          repricing=new AdminMobileOrderOperationService(createContainerFromDb(admin.db))
            .changePrice(1,{order_id:orderNo,price:'1.00'});
          expect(await pgHasBlockedSession()).toBe(true);
          releaseResolve();
          expect(await insertion).toMatchObject({duplicate:false,terminalConflict:false});
          await expect(repricing).rejects.toThrow('扫码支付已发起');
        }finally{releaseResolve();await insertion;await repricing?.catch(()=>undefined);}
        const duplicate=await new PaymentCallbackEventService(createContainerFromDb(peer.db),f.env).receive(callback);
        expect(duplicate).toMatchObject({duplicate:true,terminalConflict:false});
      });
      await expect(claimAssistedProviderPayment(createContainerFromDb(app.db),{
        adminId:1,uid:11,orderId:Number(order.id),orderNo,
        provider:provider==='wechat'?'alipay':'wechat',
        profile:provider==='wechat'?'alipay':'wechat',
        expectedPayCents:callback.amountCents,
      })).rejects.toThrow('扫码支付已发起');
      expect(await app.exec('SELECT provider,provider_transaction_id,callback_event_id::integer AS callback_event_id FROM payment_reconciliation_case'))
        .toMatchObject([{provider,provider_transaction_id:callback.transactionId,callback_event_id:expect.any(Number)}]);
      expect(await app.exec('SELECT paid,pay_price FROM store_order'))
        .toEqual([{paid:0,pay_price:String(order.pay_price)}]);
      expect(await app.exec('SELECT count(*)::integer AS n FROM payment_callback_event')).toEqual([{n:1}]);
    });
  },60_000);

  it('waits for a local order writer before recording verified callback evidence',async()=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),orderNo=await unpaid(client,11),input=await payBody(orderNo);
      const callback=verifiedCallback('wechat',orderNo,Number(input.expected_pay_price.replace('.','')));
      let enteredResolve:()=>void=()=>undefined,releaseResolve:()=>void=()=>undefined;
      const entered=new Promise<void>(resolve=>{enteredResolve=resolve;});
      const release=new Promise<void>(resolve=>{releaseResolve=resolve;});
      const local=withTx(createContainerFromDb(admin.db),async tx=>{
        const [order]=await tx.select().from(storeOrder).where(eq(storeOrder.orderId,orderNo)).limit(1).for('update');
        expect(order).toBeTruthy();
        expect(await hasInitiatedAssistedProviderPayment(tx,orderNo)).toBe(false);
        enteredResolve();await release;
        await tx.update(storeOrder).set({payPrice:'1.00'}).where(eq(storeOrder.id,order.id));
      });
      let received:ReturnType<PaymentCallbackEventService['receive']>|undefined;
      try{
        await Promise.race([entered,new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(Error('Local boundary timed out')),5000))]);
        await f.withPeer!(async peer=>{
          received=new PaymentCallbackEventService(createContainerFromDb(peer.db),f.env).receive(callback);
          expect(await pgHasBlockedSession()).toBe(true);
          releaseResolve();await local;
          expect(await received).toMatchObject({duplicate:false,terminalConflict:false});
        });
      }finally{releaseResolve();await local;await received?.catch(()=>undefined);}
      expect(await app.exec('SELECT paid,pay_price FROM store_order')).toEqual([{paid:0,pay_price:'1.00'}]);
      expect(await app.exec('SELECT provider_transaction_id FROM payment_reconciliation_case'))
        .toEqual([{provider_transaction_id:callback.transactionId}]);
      await expect(new AdminMobileOrderOperationService(createContainerFromDb(admin.db)).changePrice(1,{
        order_id:orderNo,price:'2.00',
      })).rejects.toThrow('扫码支付已发起');
    });
  },60_000);

  it('releases an uncommitted callback boundary on rollback without leaving payment evidence',async()=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),orderNo=await unpaid(client,11),input=await payBody(orderNo);
      const callback=verifiedCallback('alipay',orderNo,Number(input.expected_pay_price.replace('.','')));
      await f.withPeer!(async peer=>{
        let enteredResolve:()=>void=()=>undefined,releaseResolve:()=>void=()=>undefined;
        const entered=new Promise<void>(resolve=>{enteredResolve=resolve;});
        const release=new Promise<void>(resolve=>{releaseResolve=resolve;});
        const insertion=withTx(createContainerFromDb(peer.db),async tx=>{
          await persistVerifiedPaymentCallbackTx(tx,callback);
          enteredResolve();await release;throw Error('test_callback_rollback');
        });
        const rolledBack=expect(insertion).rejects.toThrow('test_callback_rollback');
        let repricing:ReturnType<AdminMobileOrderOperationService['changePrice']>|undefined;
        try{
          await Promise.race([entered,new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(Error('Callback insert timed out')),5000))]);
          repricing=new AdminMobileOrderOperationService(createContainerFromDb(admin.db))
            .changePrice(1,{order_id:orderNo,price:'1.00'});
          expect(await pgHasBlockedSession()).toBe(true);
          releaseResolve();await rolledBack;
          expect(await repricing).toMatchObject({changed:true});
        }finally{releaseResolve();await rolledBack;await repricing?.catch(()=>undefined);}
      });
      expect(await app.exec('SELECT count(*)::integer AS n FROM payment_reconciliation_case')).toEqual([{n:0}]);
      expect(await app.exec('SELECT count(*)::integer AS n FROM payment_callback_event')).toEqual([{n:0}]);
      expect(await app.exec('SELECT pay_price FROM store_order')).toEqual([{pay_price:'1.00'}]);
    });
  },60_000);

  it.each(['missing','ordinary'] as const)(
    'persists and deduplicates a verified callback for a %s store-order branch',async branch=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),made=await unpaid(client,11),input=await payBody(made);
      if(branch==='ordinary')await f.exec('UPDATE store_order SET is_channel=0');
      const orderNo=branch==='missing'?'missing_callback_order':made;
      const callback=verifiedCallback('wechat',orderNo,Number(input.expected_pay_price.replace('.','')));
      await f.withPeer!(async peer=>{
        const receiver=new PaymentCallbackEventService(createContainerFromDb(peer.db),f.env);
        expect(await receiver.receive(callback)).toMatchObject({duplicate:false,terminalConflict:false});
        expect(await receiver.receive(callback)).toMatchObject({duplicate:true,terminalConflict:false});
      });
      expect(await app.exec('SELECT count(*)::integer AS n FROM payment_callback_event')).toEqual([{n:1}]);
      expect(await app.exec('SELECT count(*)::integer AS n FROM payment_callback_outbox')).toEqual([{n:1}]);
    });
  },60_000);

  it.each([11,0])('isolates uid=%i cart list, quantity and exact-set deletion; invalidates changed quote',async uid=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),{body,quote,cartId}=await confirm(client,uid);
      const query='?new=1&tourist_uid=local_guest_a',before=await f.state();
      expect((await client.get<Array<{id:number}>>('cart/'+uid+query)).data.map(row=>row.id)).toEqual([cartId]);
      expect((await client.get('cart/'+uid+query,2)).data).toEqual([]);
      if(!uid)expect((await client.get('cart/0?new=1&tourist_uid=local_guest_b')).data).toEqual([]);
      for(const [target,actor] of [[uid,2],[uid?22:11,1]] as const){
        expect((await client.post('cart/num/'+target,{id:cartId,number:1},actor)).status).toBe(400);
        expect((await client.del('cart/del/'+target,{ids:[cartId]},actor)).status).toBe(400);
        expect(await f.state()).toEqual(before);
      }
      expect((await client.del('cart/del/'+uid,{ids:[cartId,1]})).status).toBe(400);
      expect((await client.post('cart/num/'+uid,{id:cartId,number:99})).status).toBe(400);
      expect(await f.state()).toEqual(before);
      const changed=await client.post('cart/num/'+uid,{id:cartId,number:1});expect(changed.status,changed.msg).toBe(200);
      const modified=await f.state();
      expect((await client.post(`create/${quote.orderKey}/${uid}`,{...body,quoteToken:quote.quoteToken})).status).toBe(400);
      expect(await f.state()).toEqual(modified);expect(client.sequence).not.toHaveBeenCalled();
      const deleted=await client.del('cart/del/'+uid,{ids:[cartId]});expect(deleted.status,deleted.msg).toBe(200);
      expect((await client.get('cart/'+uid+query)).data).toEqual([]);
      expect(await app.exec(`SELECT is_del,cart_num FROM store_cart WHERE id=${cartId}`)).toEqual([{is_del:1,cart_num:1}]);
      expect((await f.state()).store_product).toEqual(before.store_product);
    });
  },60_000);

  it.each(['cancel','pay'] as const)('keeps member coupon quote/reservation/%s consistent and excludes guest/foreign coupons',async outcome=>{
    await profiles(async(app,admin)=>{
      await f.exec(`INSERT INTO store_coupon_issue(id,coupon_type,type,coupon_price) VALUES(700,0,1,1);
        INSERT INTO store_coupon_user(id,uid,issue_coupon_id,coupon_price) VALUES(701,11,700,1),(702,22,700,1)`);
      const client=await http(app,admin),{body,quote,cartId}=await confirm(client,11);
      const query='?cartId='+cartId+'&new=1';
      const listed=await client.get<Array<{id:number;true_coupon_price:string}>>('coupons/11'+query);
      expect(listed.status,listed.msg).toBe(200);expect(listed.data).toMatchObject([{id:701,true_coupon_price:'1.00'}]);
      expect((await client.get('coupons/0'+query)).data).toEqual([]);
      expect((await client.get('coupons/11'+query,2)).status).toBe(400);
      const before=await f.state(),wallet=await accountEffects(app);
      expect((await client.post(`computed/${quote.orderKey}/11`,{...body,couponId:702})).status).toBe(400);
      expect(await f.state()).toEqual(before);expect(await accountEffects(app)).toEqual(wallet);
      const computed=await client.post<{result:{quoteToken:string}}>(`computed/${quote.orderKey}/11`,{...body,couponId:701});
      expect(computed.status,computed.msg).toBe(200);
      const made=await client.post<Created>(`create/${quote.orderKey}/11`,{...body,couponId:701,quoteToken:computed.data.result.quoteToken});
      expect(made.status,made.msg).toBe(200);
      const [root]=await app.exec('SELECT id,add_time,coupon_id,coupon_price,use_integral FROM store_order');
      expect(root).toMatchObject({coupon_id:701,coupon_price:'1.00',use_integral:'100.00'});
      expect(await app.exec('SELECT id,status FROM store_coupon_user ORDER BY id')).toEqual([{id:701,status:3},{id:702,status:0}]);
      if(outcome==='cancel'){
        expect(await closeOrder(app,root)).toMatchObject({completed:true});
        expect(await accountEffects(app)).toEqual(wallet);
        const done=await f.state();await closeOrder(app,root);expect(await f.state()).toEqual(done);
      }else{
        expect((await client.post('pay/11',await payBody(made.data.result.order_id))).status).toBe(200);
        const [event]=await app.exec("SELECT id,event_key FROM store_order_outbox WHERE event_type='order.paid'");
        const service=new OrderOutboxService(createContainerFromDb(app.db),f.env);
        const message={action:'processOrderPaidOutbox' as const,outboxId:Number(event.id),eventKey:String(event.event_key)};
        expect(await service.processMessage(message)).toBe('completed');
        expect(await app.exec('SELECT id,status FROM store_coupon_user ORDER BY id')).toEqual([{id:701,status:1},{id:702,status:0}]);
        const done=await accountEffects(app);expect(await service.processMessage(message)).toBe('already-completed');
        expect(await accountEffects(app)).toEqual(done);
      }
    });
  },60_000);

  it.each(['store_order_outbox','store_order_status'])('rolls back cash payment if %s INSERT is missing, with no queue send',async table=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),orderNo=await unpaid(client,11),input=await payBody(orderNo),before=await f.state();
      await f.exec(`REVOKE INSERT ON ${table} FROM "${app.role}"`);
      expect((await client.post('pay/11',input)).status).toBe(400);
      expect(await f.state()).toEqual(before);expect(client.sendBatch).not.toHaveBeenCalled();
      // Restore only this fixture's explicitly commissioned baseline privilege.
      await f.exec(`GRANT INSERT ON ${table} TO "${app.role}"`);
      expect((await client.post('pay/11',input)).status).toBe(200);
      expect(client.sendBatch).toHaveBeenCalledTimes(1);
    });
  },60_000);

  it('retains committed payment and a recoverable durable event when queue transport fails',async()=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),orderNo=await unpaid(client,0),input=await payBody(orderNo);
      client.sendBatch.mockRejectedValueOnce(Error('local queue unavailable'));
      const logged=vi.spyOn(console,'error').mockImplementation(()=>undefined);
      expect((await client.post('pay/0',input)).status).toBe(200);
      expect(logged).toHaveBeenCalled();
      expect(await app.exec('SELECT paid FROM store_order')).toEqual([{paid:1}]);
      const [event]=await app.exec("SELECT id,event_key,status FROM store_order_outbox WHERE event_type='order.paid'");
      expect(event.status).toBe('FAILED');
      const before=await f.state();expect((await client.post('pay/0',input)).status).toBe(200);
      expect(await f.state()).toEqual(before);expect(client.sendBatch).toHaveBeenCalledTimes(1);
      // A retained message reaches the real consumer service; no provider or
      // live Queue transport is used, and no payment is repeated.
      expect(await new OrderOutboxService(createContainerFromDb(app.db),f.env).processMessage({
        action:'processOrderPaidOutbox',outboxId:Number(event.id),eventKey:String(event.event_key),
      })).toBe('completed');
      expect(await app.exec('SELECT count(*)::integer AS n FROM supplier_transactions')).toEqual([{n:1}]);
    });
  },60_000);

  it.each(['staff_id=0','is_channel=0'])('does not treat an unproven UID=0 payment as a supported guest: %s',async change=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),orderNo=await unpaid(client,0),input=await payBody(orderNo);
      expect((await client.post('pay/0',input)).status).toBe(200);
      await f.exec(`UPDATE store_order SET ${change}`);
      const before=await f.state(),[event]=await app.exec("SELECT id,event_key FROM store_order_outbox WHERE event_type='order.paid'");
      await expect(new OrderOutboxService(createContainerFromDb(app.db),f.env).processMessage({
        action:'processOrderPaidOutbox',outboxId:Number(event.id),eventKey:String(event.event_key),
      })).rejects.toThrow('游客付款订单来源无效');
      const after=await f.state();
      for(const table of Object.keys(before))if(table!=='store_order_outbox')expect(after[table],table).toEqual(before[table]);
      expect(await app.exec("SELECT status FROM store_order_outbox WHERE event_type='order.paid'")).toEqual([{status:'FAILED'}]);
    });
  },60_000);

  it.each([[11,'saved'],[0,'manual'],[11,'manual'],[11,'pickup'],[11,'virtual'],[0,'virtual']] as const)
    ('captures uid=%i %s checkout and restores once via scheduled close using only the app profile',async(uid,delivery)=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),{body,quote,before}=await confirm(client,uid,delivery);
      const computed=await client.post<{result:{quoteToken:string;usedIntegral:number}}>(`computed/${quote.orderKey}/${uid}`,body);
      expect(computed.status,computed.msg).toBe(200);expect(computed.data.result.usedIntegral).toBe(uid?100:0);
      const input={...body,quoteToken:computed.data.result.quoteToken},path=`create/${quote.orderKey}/${uid}`;
      const created=await client.post<Created>(path,input);expect(created.status,created.msg).toBe(200);
      const [root]=await app.exec('SELECT id,order_id,uid,staff_id,is_channel,add_time,use_integral FROM store_order');
      expect(root).toMatchObject({uid,staff_id:1,is_channel:2});
      expect(await app.exec('SELECT buyer_id,used_points FROM store_order_purchase_origin')).toEqual([{buyer_id:uid,used_points:uid?'100':'0'}]);
      const made=await f.state();expect((await client.post<Created>(path,input)).data.result.extended).toBe(true);expect(await f.state()).toEqual(made);
      expect(await closeOrder(app,root)).toMatchObject({completed:true});
      expect(await app.exec('SELECT buyer_id,restored_points FROM store_order_purchase_cancellation')).toEqual([{buyer_id:uid,restored_points:uid?'100':'0'}]);
      const done=await f.state();for(const table of ['store_product','store_product_attr_value','store_cart','user'])expect(done[table],table).toEqual(before[table]);
      await closeOrder(app,root);expect(await f.state()).toEqual(done);
      expect(client.identities.length).toBeGreaterThanOrEqual(5);
      expect(client.identities.every(pair=>pair.app===app.role&&pair.admin===admin.role)).toBe(true);
      await expect(admin.exec('SELECT * FROM store_order_purchase_origin')).rejects.toMatchObject({code:'42501'});
      await expect(app.exec("UPDATE system_config SET value='0'")).rejects.toMatchObject({code:'42501'});
    });
  },60_000);
  it.each([11,0])('rejects cross-actor and cross-target uid=%i carts/quotes without business writes',async uid=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),{body,quote,before}=await confirm(client,uid);
      for(const [path,input,actor] of [
        ['confirm/'+uid,body,2],['confirm/'+(uid?22:11),body,1],
        [`create/${quote.orderKey}/${uid}`,{...body,quoteToken:quote.quoteToken},2],
        [`create/${quote.orderKey}/${uid?22:11}`,{...body,quoteToken:quote.quoteToken},1],
      ] as const){expect((await client.post(path,input,actor)).status).toBe(400);expect(await f.state()).toEqual(before);}
      if(!uid){expect((await client.post('confirm/0',{...body,tourist_uid:'local_guest_b'})).status).toBe(400);expect(await f.state()).toEqual(before);}
      expect(client.sequence).not.toHaveBeenCalled();
      expect((await client.post(`create/${quote.orderKey}/${uid}`,{...body,quoteToken:quote.quoteToken})).status).toBe(200);
    });
  },60_000);
  it('checks live Admin auth/permission before any management session or assisted cart writes',async()=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),before=await f.state(),body={productId:70,uniqueId:'qared001',cartNum:1,new:1};
      for(const actor of [0,3]){expect((await client.post('cart/add/11',body,actor)).status).toBe(400);expect(await f.state()).toEqual(before);}
      await f.exec('UPDATE system_admin SET status=0 WHERE id=1');
      expect((await client.post('cart/add/11',body)).status).toBe(400);
      await f.exec("UPDATE system_admin SET status=1,pwd='changed' WHERE id=1");
      expect((await client.post('cart/add/11',body)).status).toBe(400);
      expect(client.identities).toEqual([]);expect(await f.state()).toEqual(before);
    });
  },60_000);
  it.each([11,0])('rolls back uid=%i assisted creation on missing origin authority without falling back to admin',async uid=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),{body,quote,before}=await confirm(client,uid),path=`create/${quote.orderKey}/${uid}`,input={...body,quoteToken:quote.quoteToken};
      await f.exec(`REVOKE INSERT ON store_order_purchase_origin FROM "${app.role}"`);
      expect((await client.post(path,input)).status).toBe(400);expect(await f.state()).toEqual(before);
      await runPurchaseOriginEvidence(f.db,app.role);
      expect((await client.post(path,input)).status).toBe(200);
    });
  },60_000);
  it.each([
    ['UPDATE system_admin SET status=0 WHERE id=1','UPDATE system_admin SET status=1 WHERE id=1'],
    ["UPDATE system_admin SET pwd='changed' WHERE id=1","UPDATE system_admin SET pwd='local-hash' WHERE id=1"],
    ["UPDATE system_role SET rules='order.view' WHERE id=1","UPDATE system_role SET rules='order.assisted' WHERE id=1"],
  ])('does not let a saved quote bypass changed live authorization: %s',async(mutate,restore)=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),{body,quote,before}=await confirm(client,11);
      const observed=client.identities.length,path=`create/${quote.orderKey}/11`,input={...body,quoteToken:quote.quoteToken};
      await f.exec(mutate);
      expect((await client.post(path,input)).status).toBe(400);expect(await f.state()).toEqual(before);
      expect(client.identities).toHaveLength(observed);expect(client.sequence).not.toHaveBeenCalled();
      await f.exec(restore);expect((await client.post(path,input)).status).toBe(200);
    });
  },60_000);
  it('rolls back guest scheduled compensation on missing cancellation INSERT and retries once',async()=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),{body,quote}=await confirm(client,0);
      expect((await client.post(`create/${quote.orderKey}/0`,{...body,quoteToken:quote.quoteToken})).status).toBe(200);
      const [root]=await app.exec('SELECT id,add_time FROM store_order'),before=await f.state();
      await f.exec(`REVOKE INSERT ON store_order_purchase_cancellation FROM "${app.role}"`);
      await expect(closeOrder(app,root)).rejects.toThrow();expect(await f.state()).toEqual(before);
      await runPurchaseCancellationEvidence(f.db,app.role);
      expect(await closeOrder(app,root)).toMatchObject({completed:true});
      const done=await f.state();await closeOrder(app,root);expect(await f.state()).toEqual(done);
    });
  },60_000);
  } else {
  async function reconciliationCase(app:Role,orderNo:string,amountCents:number){
    const service=new PaymentReconciliationService(createContainerFromDb(app.db),f.env);
    const row=await service.registerIntent({provider:'wechat',profile:'wechat',orderDomain:'store_order',
      orderNo,expectedAmountCents:amountCents,currency:'CNY',initiatedAt:Math.floor(Date.now()/1000)-3600});
    await f.exec(`UPDATE payment_reconciliation_case SET next_check_time=0 WHERE id=${row.id}`);
    return row;
  }
  function querySuccess(orderNo:string,amountCents:number){
    return {status:'SUCCESS' as const,providerTradeState:'SUCCESS',orderNo,
      transactionId:'local_wechat_query_T2',amountCents,currency:'CNY' as const,
      providerEventTime:1235,errorCode:''};
  }
  async function paymentState(app:Role){
    return {order:await app.exec('SELECT paid,pay_type,trade_no FROM store_order'),
      outbox:await app.exec('SELECT count(*)::integer AS n FROM store_order_outbox'),
      bills:await app.exec('SELECT count(*)::integer AS n FROM user_bill')};
  }

  it('settles one matching provider query and replays the terminal case without another payment',async()=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),orderNo=await unpaid(client,11),input=await payBody(orderNo);
      const amount=Number(input.expected_pay_price.replace('.',''));
      const row=await reconciliationCase(app,orderNo,amount);
      const service=new PaymentReconciliationService(createContainerFromDb(app.db),f.env,
        async()=>querySuccess(orderNo,amount));
      const message={action:'processPaymentReconciliation' as const,caseId:row.id,replayKey:row.replayKey};
      expect(await service.processMessage(message)).toBe('settled');
      expect(await service.processMessage(message)).toBe('already-terminal');
      expect(await app.exec('SELECT paid,pay_type,trade_no FROM store_order'))
        .toEqual([{paid:1,pay_type:'weixin',trade_no:'local_wechat_query_T2'}]);
      expect(await app.exec('SELECT status,provider_transaction_id,callback_event_id FROM payment_reconciliation_case'))
        .toEqual([{status:'SETTLED',provider_transaction_id:'local_wechat_query_T2',callback_event_id:null}]);
      expect(await app.exec('SELECT count(*)::integer AS n FROM store_order_outbox')).toEqual([{n:1}]);
    });
  },60_000);

  it('fails ACCEPT_LOCAL immediately on a locked assisted order without case-to-order waiting',async()=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),orderNo=await unpaid(client,11),input=await payBody(orderNo);
      const row=await reconciliationCase(app,orderNo,Number(input.expected_pay_price.replace('.','')));
      await f.exec(`UPDATE payment_reconciliation_case SET status='UNKNOWN' WHERE id=${row.id}`);
      await f.withPeer!(async peer=>{
        let enteredResolve:()=>void=()=>undefined,releaseResolve:()=>void=()=>undefined;
        const entered=new Promise<void>(resolve=>{enteredResolve=resolve;});
        const release=new Promise<void>(resolve=>{releaseResolve=resolve;});
        const holder=withTx(createContainerFromDb(peer.db),async tx=>{
          await tx.select().from(storeOrder).where(eq(storeOrder.orderId,orderNo)).limit(1).for('update');
          enteredResolve();await release;
        });
        try{
          await entered;
          const service=new PaymentReconciliationService(createContainerFromDb(admin.db),f.env);
          await expect(Promise.race([service.decide({caseId:row.id,adminId:1,actionKey:crypto.randomUUID(),
            action:'accept_local',reasonCode:'reviewed_local_payment'}),
            new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(Error('ACCEPT_LOCAL waited on order row')),4000))]))
            .rejects.toThrow('订单正在更新');
        }finally{releaseResolve();await holder;}
      });
      expect(await f.exec('SELECT count(*)::integer AS n FROM payment_reconciliation_action')).toEqual([{n:0}]);
      expect(await paymentState(app)).toMatchObject({order:[{paid:0}]});
    });
  },60_000);

  it('fences a callback T1 before query T2 can settle or erase its evidence',async()=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),orderNo=await unpaid(client,11),input=await payBody(orderNo);
      const amount=Number(input.expected_pay_price.replace('.',''));
      const row=await reconciliationCase(app,orderNo,amount),before=await paymentState(app);
      const callback=verifiedCallback('wechat',orderNo,amount);
      const settler=vi.fn(async()=>({status:'completed' as const,domain:'store_order' as const,
        errorCode:'',outcome:'paid' as const}));
      const service=new PaymentReconciliationService(createContainerFromDb(app.db),f.env,async()=>{
        await f.withPeer!(async peer=>{
          expect(await new PaymentCallbackEventService(createContainerFromDb(peer.db),f.env).receive(callback))
            .toMatchObject({duplicate:false,terminalConflict:false});
        });
        return querySuccess(orderNo,amount);
      },settler);
      expect(await service.processMessage({action:'processPaymentReconciliation',caseId:row.id,replayKey:row.replayKey}))
        .toBe('conflict');
      expect(settler).not.toHaveBeenCalled();
      expect(await paymentState(app)).toEqual(before);
      expect(await app.exec('SELECT status,provider_transaction_id,callback_event_id IS NOT NULL AS has_callback FROM payment_reconciliation_case'))
        .toEqual([{status:'CONFLICT',provider_transaction_id:callback.transactionId,has_callback:true}]);
      expect(await app.exec('SELECT transaction_id FROM payment_callback_event'))
        .toEqual([{transaction_id:callback.transactionId}]);
    });
  },60_000);

  it('fences query T2 registered first when callback T1 commits before the locked order settles',async()=>{
    await profiles(async(app,admin)=>{
      const client=await http(app,admin),orderNo=await unpaid(client,11),input=await payBody(orderNo);
      const amount=Number(input.expected_pay_price.replace('.',''));
      const row=await reconciliationCase(app,orderNo,amount),before=await paymentState(app);
      const callback=verifiedCallback('wechat',orderNo,amount);
      const service=new PaymentReconciliationService(createContainerFromDb(app.db),f.env,
        async()=>querySuccess(orderNo,amount));
      await f.withPeer!(async holderPeer=>{
        let enteredResolve:()=>void=()=>undefined,releaseResolve:()=>void=()=>undefined;
        const entered=new Promise<void>(resolve=>{enteredResolve=resolve;});
        const release=new Promise<void>(resolve=>{releaseResolve=resolve;});
        const holder=withTx(createContainerFromDb(holderPeer.db),async tx=>{
          await tx.select().from(storeOrder).where(eq(storeOrder.orderId,orderNo)).limit(1).for('update');
          enteredResolve();await release;
        });
        let processing:ReturnType<PaymentReconciliationService['processMessage']>|undefined;
        try{
          await entered;
          processing=service.processMessage({action:'processPaymentReconciliation',caseId:row.id,replayKey:row.replayKey});
          let registered=false;
          for(let attempt=0;attempt<100;attempt++){
            const [current]=await f.exec('SELECT provider_transaction_id FROM payment_reconciliation_case');
            if(current.provider_transaction_id==='local_wechat_query_T2'){registered=true;break;}
            await new Promise(resolve=>setTimeout(resolve,50));
          }
          expect(registered).toBe(true);
          expect(await pgHasBlockedSession()).toBe(true);
          await f.withPeer!(async callbackPeer=>{
            let callbackEnteredResolve:()=>void=()=>undefined,callbackReleaseResolve:()=>void=()=>undefined;
            const callbackEntered=new Promise<void>(resolve=>{callbackEnteredResolve=resolve;});
            const callbackRelease=new Promise<void>(resolve=>{callbackReleaseResolve=resolve;});
            const callbackTx=withTx(createContainerFromDb(callbackPeer.db),async tx=>{
              expect(await persistVerifiedPaymentCallbackTx(tx,callback))
                .toMatchObject({duplicate:false,terminalConflict:true});
              callbackEnteredResolve();await callbackRelease;
            });
            try{
              await callbackEntered;
              releaseResolve();await holder;
              expect(await pgHasBlockedSession()).toBe(true);
              const waits=await f.exec(`SELECT wait_event FROM pg_stat_activity WHERE datname=current_database()
                AND cardinality(pg_blocking_pids(pid))>0`);
              expect(waits.some(wait=>wait.wait_event==='advisory')).toBe(true);
              callbackReleaseResolve();await callbackTx;
            }finally{callbackReleaseResolve();await callbackTx.catch(()=>undefined);}
          });
          expect(await processing).toBe('conflict');
        }finally{releaseResolve();await holder;await processing?.catch(()=>undefined);}
      });
      expect(await paymentState(app)).toEqual(before);
      expect(await app.exec('SELECT status,provider_transaction_id,callback_event_id IS NOT NULL AS has_callback FROM payment_reconciliation_case'))
        .toEqual([{status:'CONFLICT',provider_transaction_id:'local_wechat_query_T2',has_callback:true}]);
      expect(await app.exec('SELECT transaction_id FROM payment_callback_event'))
        .toEqual([{transaction_id:callback.transactionId}]);
    });
  },60_000);
  }
});
}
