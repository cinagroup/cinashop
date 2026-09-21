import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createApp } from '../src/app';
import { createContainerFromDb, withTx, type Container } from '../src/lib/di';
import { adminRefundEvidenceFixture } from './helpers/adminRefundEvidenceFixture';
import { systemAdmin, systemRole, systemConfig, storeOrderCartInfo, storeOrderStatus } from '../src/models/schema';
import { quoteAdminRefundCreation } from '../src/services/admin/AdminRefundCreationQuoteService';
import { createAdminRefundApplication, lookupAdminRefundCreation } from '../src/services/admin/AdminRefundCreationService';
import { ADMIN_REFUND_CREATION_SQL } from '../src/migrations/adminRefundCreation';
import { WechatPayService } from '../src/services/wechat/WechatPayService';
import { AlipayRefundService } from '../src/services/payment/AlipayRefundService';
import { md5 } from '../src/utils/jwt';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { lockOrderSettlement } from '../src/services/order/OrderBrokerageService';

const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('../src/lib/di',async importOriginal=>{
  const original=await importOriginal<typeof import('../src/lib/di')>();
  return {...original,createAdminDatabaseSession:()=>{
    if(!wiring.container)throw Error('Quote SQL fixture unavailable');
    return {container:wiring.container,close:async()=>{}};
  },createContainer:()=>{if(!wiring.container)throw Error('Quote SQL fixture unavailable');return wiring.container;}};
});
const aliases=['/adminapi/refund/creation/quote','/api/admin/refund/creation/quote'];
const input=()=>({version:'admin-refund-creation-quote-v1',orderId:1,mode:'items',items:[{cartId:501,cartNum:1}]});
const actor=()=>({id:100,authVersion:md5('synthetic-digest'),expiresAt:Math.floor(Date.now()/1000)+3600});
let f:Awaited<ReturnType<typeof adminRefundEvidenceFixture>>;
const app=createApp();
const policy=and(eq(systemConfig.menuName,'refund_time_available'),eq(systemConfig.isStore,0));
const setWindow=async(value:string)=>{
  const rows=await f.db.update(systemConfig).set({value}).where(policy).returning({id:systemConfig.id});
  if(!rows.length)await f.db.insert(systemConfig).values({menuName:'refund_time_available',value});
};
beforeEach(async()=>{
  f=await adminRefundEvidenceFixture();wiring.container=f.container;
  await setWindow('0');
  await f.db.update(systemAdmin).set({level:1,roles:'1'}).where(eq(systemAdmin.id,100));
  await f.db.update(systemRole).set({rules:'refund.manage'}).where(eq(systemRole.id,1));
  await f.db.insert(systemRole).values({id:2,type:1,roleName:'Quote read-only test',rules:'refund.view'});
  await f.db.update(systemAdmin).set({roles:'2'}).where(eq(systemAdmin.id,101));
  const forbidden=async()=>{throw Error('Unexpected quote external I/O');};
  for(const gateway of [WechatPayService,AlipayRefundService])for(const method of ['requestRefund','queryRefund'] as const)vi.spyOn(gateway.prototype,method).mockImplementation(forbidden);
  vi.spyOn(globalThis,'fetch').mockImplementation(forbidden);
  for(const method of ['log','warn','error'] as const)vi.spyOn(console,method).mockImplementation(()=>{});
},30000);
afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();expect(WechatPayService.prototype.requestRefund).not.toHaveBeenCalled();expect(AlipayRefundService.prototype.requestRefund).not.toHaveBeenCalled();}
  finally{wiring.container=undefined;vi.restoreAllMocks();await f?.close();}},45000);
const headers=(id=100)=>new Headers({'Authori-zation':`Bearer ${f.tokens.get(id)??''}`,'Content-Type':'application/json','X-Refund-Operation-Scope':`v1:admin:${id}`});
const send=(value:unknown=input(),path=aliases[0],h=headers())=>app.request(path,{method:'POST',headers:h,body:JSON.stringify(value)},f.env);
const quote=(value:unknown=input())=>quoteAdminRefundCreation(f.container,actor(),value);
const snapshot=async()=>({business:await f.snapshot(),applications:await f.applications(),audit:await f.statuses(),
  sequences:await f.db.select().from(sql`pg_sequences`).where(sql`schemaname=current_schema()`).orderBy(sql`sequencename`)});
const creationInput=(q:Awaited<ReturnType<typeof quote>>)=>({version:'admin-refund-creation-v1',review:q.review,
  mode:q.mode,items:q.mode==='items'?q.items:[],quotedPrice:q.quotedPrice,refundPrice:'3.00',reason:'合成确认',quoteFingerprint:q.quoteFingerprint});
const noStore=(r:Response)=>{expect(r.headers.get('Cache-Control')).toContain('no-store');expect(r.headers.get('Pragma')).toBe('no-cache');};

it.each(aliases)('serves %s through real app/auth/SQL without a creation ledger or a business/sequence write',async path=>{
  const before=await snapshot(),r=await send(input(),path);noStore(r);expect(r.status).toBe(200);
  const body=await r.json();expect(body).toMatchObject({status:200,data:{version:input().version,review:{id:1,uid:11,storeId:0,supplierId:0,payPrice:'10.00'},
    mode:'items',items:[{cartId:501,cartNum:1}],quotedPrice:'5.00',refundNum:1,refundTimeDays:0,receivedAt:null,quoteFingerprint:expect.stringMatching(/^[a-f0-9]{64}$/)}});
  expect(JSON.stringify(body)).not.toMatch(/userAddress|cartInfo|virtualInfo|authVersion|receipt|refundId/);
  expect(await snapshot()).toEqual(before);
});
it('uses the same whole/partial allocation and stable source fingerprint, not a creation reservation',async()=>{
  const before=await snapshot(),partial=await quote(),remaining=await quote({...input(),mode:'remaining',items:[]});
  expect(remaining).toMatchObject({quotedPrice:'10.00',refundNum:2,items:[{cartId:501,cartNum:2}]});
  expect(remaining.quoteFingerprint).toBe(partial.quoteFingerprint);expect(await quote()).toEqual(partial);
  expect(await snapshot()).toEqual(before);
  await f.exec(ADMIN_REFUND_CREATION_SQL);
  expect(await createAdminRefundApplication(f.container,actor(),crypto.randomUUID(),creationInput(partial))).toMatchObject({replayed:false,receipt:{outcome:'created'}});
  await expect(quote()).rejects.toThrow('进行中');
});
it('enforces manage permission and current actor scope, including no-store errors',async()=>{
  const before=await snapshot();
  for(const id of [0,101,102,103]){const r=await send(input(),aliases[0],headers(id));noStore(r);expect(await r.json()).not.toMatchObject({status:200});}
  for(const scope of ['', 'v1:admin:101']){const h=headers();h.set('X-Refund-Operation-Scope',scope);const r=await send(input(),aliases[0],h);noStore(r);expect(r.status).toBe(412);}
  await f.db.update(systemAdmin).set({pwd:'revoked'}).where(eq(systemAdmin.id,100));
  const r=await send();noStore(r);expect(await r.json()).not.toMatchObject({status:200});expect(await snapshot()).toEqual(before);
});
it('rejects malformed selectors, extra data, old versions and noncanonical row IDs without writes',async()=>{
  const before=await snapshot();
  for(const value of [null,{}, {...input(),version:'old'}, {...input(),uid:22}, {...input(),orderId:'1'}, {...input(),mode:'remaining'},
    {...input(),items:[]}, {...input(),items:[{cartId:1,cartNum:1}]}, {...input(),items:[{cartId:501,cartNum:3}]},
    {...input(),items:[{cartId:501,cartNum:1},{cartId:501,cartNum:1}]}, {...input(),items:Array(101).fill({cartId:501,cartNum:1})}]){
    const r=await send(value);noStore(r);expect(await r.json()).not.toMatchObject({status:200});
  }
  expect(await snapshot()).toEqual(before);
});
it('rejects query/key confusion, non-JSON encodings, oversized bytes and invalid UTF-8',async()=>{
  const before=await snapshot();
  const key=headers();key.set('Idempotency-Key',crypto.randomUUID());
  for(const [path,h] of [[aliases[0]+'?uid=22',headers()],[aliases[0],key]] as const){const r=await send(input(),path,h);noStore(r);expect(await r.json()).not.toMatchObject({status:200});}
  for(const [name,value] of [['Content-Type','text/plain'],['Content-Type','application/json; charset=gbk'],['Content-Encoding','gzip']]){
    const h=headers();h.set(name,value);const r=await send(input(),aliases[0],h);noStore(r);expect(await r.json()).not.toMatchObject({status:200});
  }
  for(const body of [' '.repeat(8193),new Uint8Array([0xc3,0x28])]){
    const r=await app.request(aliases[0],{method:'POST',headers:headers(),body},f.env);noStore(r);expect(await r.json()).not.toMatchObject({status:200});
  }
  expect(await snapshot()).toEqual(before);
});
it('reads live SQL policy with PHP missing/blank defaults and configured sort/id precedence, never stale KV',async()=>{
  f.config.refund_time_available='999';
  const kv=vi.spyOn(f.env.CONFIG_KV,'get'),put=vi.spyOn(f.env.CONFIG_KV,'put');
  for(const [value,days] of [['7',7],['"7"',7],['0007',7],['',0]] as const){await setWindow(value);expect((await quote()).refundTimeDays).toBe(days);}
  await f.db.delete(systemConfig).where(policy);expect((await quote()).refundTimeDays).toBe(0);
  await f.db.insert(systemConfig).values([{menuName:'refund_time_available',value:'6',sort:1},{menuName:'refund_time_available',value:'7',sort:1},
    {menuName:'refund_time_available',value:'9',sort:2},{menuName:'refund_time_available',value:'99',sort:9,isStore:1}]);
  expect((await quote()).refundTimeDays).toBe(9);expect(kv).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();
});
it('accepts the exact deadline and refuses one second later in both quote and creation',async()=>{
  const now=Math.floor(Date.now()/1000);vi.spyOn(Date,'now').mockReturnValue(now*1000);
  await setWindow('7');await f.db.insert(storeOrderStatus).values({oid:1,changeType:'user_take_delivery',changeTime:now-7*86400});
  const reviewed=await quote();expect(reviewed.refundTimeDays).toBe(7);await f.exec(ADMIN_REFUND_CREATION_SQL);
  const before=await snapshot();vi.mocked(Date.now).mockReturnValue((now+1)*1000);
  await expect(quote()).rejects.toThrow('超过售后期限');
  await expect(createAdminRefundApplication(f.container,actor(),crypto.randomUUID(),creationInput(reviewed))).rejects.toThrow('超过售后期限');
  expect(await snapshot()).toEqual(before);
});
it.each(['cart','policy','receipt'])('invalidates an old quote when %s facts change even with the same cash maximum',async kind=>{
  const reviewed=await quote();await f.exec(ADMIN_REFUND_CREATION_SQL);
  if(kind==='cart')await f.db.update(storeOrderCartInfo).set({cartInfo:JSON.stringify({product:{storeName:'changed same-price item'},sku:{price:'5.00'}})}).where(eq(storeOrderCartInfo.id,1));
  if(kind==='policy')await setWindow('7');
  if(kind==='receipt')await f.db.insert(storeOrderStatus).values({oid:1,changeType:'take_delivery',changeTime:Math.floor(Date.now()/1000)});
  const updated=await quote();expect(updated.quotedPrice).toBe(reviewed.quotedPrice);expect(updated.quoteFingerprint).not.toBe(reviewed.quoteFingerprint);
  const before=await snapshot();await expect(createAdminRefundApplication(f.container,actor(),crypto.randomUUID(),creationInput(reviewed))).rejects.toThrow('报价依据已变化');
  expect(await snapshot()).toEqual(before);
  expect(await createAdminRefundApplication(f.container,actor(),crypto.randomUUID(),creationInput(updated))).toMatchObject({receipt:{outcome:'created'}});
});
it('preserves committed creation recovery when current policy is invalid, while rejecting new admission',async()=>{
  const body=creationInput(await quote()),key=crypto.randomUUID();await f.exec(ADMIN_REFUND_CREATION_SQL);
  const created=await createAdminRefundApplication(f.container,actor(),key,body);
  await setWindow('not-a-number');const before=await snapshot();
  await expect(quote()).rejects.toMatchObject({code:503});
  await expect(createAdminRefundApplication(f.container,actor(),crypto.randomUUID(),body)).rejects.toMatchObject({code:503});
  expect(await createAdminRefundApplication(f.container,actor(),key,body)).toEqual({receipt:created.receipt,replayed:true});
  expect(await lookupAdminRefundCreation(f.container,actor(),key)).toEqual(created.receipt);expect(await snapshot()).toEqual(before);
});
it('bounds the source cart snapshot and rejects outer-transaction quotation',async()=>{
  await expect(withTx(f.container,tx=>quoteAdminRefundCreation(createContainerFromDb(tx),actor(),input()))).rejects.toThrow('root database');
  await f.db.update(storeOrderCartInfo).set({cartInfo:'x'.repeat(1024*1024+1)}).where(eq(storeOrderCartInfo.id,1));
  const before=await snapshot();await expect(quote()).rejects.toThrow('快照过大');expect(await snapshot()).toEqual(before);
});
it('copies actor and nested selection before asynchronous quote admission',async()=>{
  const owner=actor(),body=input(),before=await snapshot();
  const pending=quoteAdminRefundCreation(f.container,owner,body);
  owner.id=101;body.orderId=4;body.items[0].cartNum=2;
  expect(await pending).toMatchObject({review:{id:1,uid:11},refundNum:1,quotedPrice:'5.00'});
  expect(await snapshot()).toEqual(before);
});
it('rejects malformed SQL policy and never interprets a keyless quote as a creation, execution or abandonment',async()=>{
  for(const value of ['-1','1.5','true','36501']){await setWindow(value);await expect(quote()).rejects.toMatchObject({code:503});}
  await setWindow('0');const before=await snapshot();
  for(const suffix of ['create','execute','abandon']){
    const r=await send(input(),`/adminapi/refund/creation/${suffix}`);expect(await r.json()).not.toMatchObject({status:200});
  }
  expect(await snapshot()).toEqual(before);
});

describe.runIf(!!process.env.TEST_FINANCE_POSTGRES_URL)('independent native quote backends',()=>{
  it('reads changed policy after a proven order-lock wait, not before it',async()=>{
    await setWindow('7');await f.db.insert(storeOrderStatus).values({oid:1,changeType:'take_delivery',changeTime:Math.floor(Date.now()/1000)-2*86400});
    await withFinancePeers(f.db,async([blocker,waiter])=>{
      let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
      const held=outcome(withTx(createContainerFromDb(blocker.db),async tx=>{await lockOrderSettlement(tx,1);entered();await gate;}));
      let pending:ReturnType<typeof outcome<Awaited<ReturnType<typeof quote>>>>|undefined;
      try{await ready;pending=outcome(quoteAdminRefundCreation(createContainerFromDb(waiter.db),actor(),input()));
        await waitForFinanceBlock(f.db,waiter.pid,blocker.pid);await setWindow('1');release();
        expect((await held).ok).toBe(true);const result=await pending;expect(result.ok).toBe(false);if(!result.ok)expect(result.error.message).toContain('超过售后期限');
      }finally{release();await held;await pending;}
    });
  });
});
