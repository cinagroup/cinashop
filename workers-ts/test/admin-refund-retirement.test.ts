import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import type { Container } from '../src/lib/di';
import { adminRefundEvidenceFixture } from './helpers/adminRefundEvidenceFixture';
import { ADMIN_REFUND_OPERATION_SQL } from '../src/migrations/adminRefundOperation';
import { adminRefundOperation, storeOrderOutbox, storeOrderRefundPayment, systemAdmin } from '../src/models/schema';
import { retiredAdminRefundMutation } from '../src/controllers/api/v1/AdminRefundOperationController';
import { StoreOrderRefundService } from '../src/services/order/StoreOrderRefundService';
import { AdminMobileRefundOperationService } from '../src/services/admin/AdminMobileRefundOperationService';
import { WechatPayService } from '../src/services/wechat/WechatPayService';
import { AlipayRefundService } from '../src/services/payment/AlipayRefundService';

// Real app/router/entry auth/SQL. Only the owned test database binding and
// forbidden external I/O are substituted. Never connect to production.
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async original => ({ ...await original<typeof import('../src/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Retirement fixture unavailable'); return wiring.container; } }));

const paths = ['/adminapi/refund/refund/28', '/adminapi/refund/refuse/28',
  '/api/admin/refund/agree/28', '/api/admin/refund/refuse/28',
  '/api/admin/order/refund', '/api/admin/order/refund_agree/28', '/api/admin/order/open/refund/28'];
const protocol = 'admin-refund-operation-v1';
const input = { version:protocol, action:'return',
  review:{uid:11,storeOrderId:28,storeId:0,supplierId:0,orderId:'history_refund_28',refundPrice:'5.00'},
  decision:{applyType:2,refundType:0,received:false} };

describe('retired unkeyed Admin refund HTTP entry points', () => {
  const app=createApp();
  let f:Awaited<ReturnType<typeof adminRefundEvidenceFixture>>;
  beforeEach(async()=>{
    f=await adminRefundEvidenceFixture(); await f.exec(ADMIN_REFUND_OPERATION_SQL); wiring.container=f.container;
    const forbidden=async()=>{throw Error('Retired URL must never call a financial service');};
    vi.spyOn(StoreOrderRefundService.prototype,'agreeRefund').mockImplementation(forbidden);
    vi.spyOn(StoreOrderRefundService.prototype,'refuseRefund').mockImplementation(forbidden);
    for(const method of ['refund','agreeReturn','openRefund'] as const) vi.spyOn(AdminMobileRefundOperationService.prototype,method).mockImplementation(forbidden);
    for(const gateway of [WechatPayService,AlipayRefundService]) {
      vi.spyOn(gateway.prototype,'requestRefund').mockImplementation(forbidden);
      vi.spyOn(gateway.prototype,'queryRefund').mockImplementation(forbidden);
    }
    vi.spyOn(globalThis,'fetch').mockImplementation(forbidden);
    for(const method of ['log','warn','error'] as const) vi.spyOn(console,method).mockImplementation(()=>{});
  },30000);
  afterEach(async()=>{
    try {
      expect(fetch).not.toHaveBeenCalled();
      for(const method of ['agreeRefund','refuseRefund'] as const) expect(StoreOrderRefundService.prototype[method]).not.toHaveBeenCalled();
      for(const method of ['refund','agreeReturn','openRefund'] as const) expect(AdminMobileRefundOperationService.prototype[method]).not.toHaveBeenCalled();
      for(const gateway of [WechatPayService,AlipayRefundService]) for(const method of ['requestRefund','queryRefund'] as const) expect(gateway.prototype[method]).not.toHaveBeenCalled();
    } finally { wiring.container=undefined; vi.restoreAllMocks(); await f?.close(); }
  },45000);
  const headers=(actor=100,key?:string)=>({ Authorization:f.tokens.has(actor)?'Bearer '+f.tokens.get(actor):'', 'Content-Type':'application/json',
    ...(key?{'Idempotency-Key':key,'X-Refund-Operation-Scope':`v1:admin:${actor}`}:{}) });
  const send=(path:string,body:unknown=input,actor=100,key?:string)=>app.request(path,{method:'POST',headers:headers(actor,key),body:JSON.stringify(body)},f.env);
  const snapshot=async()=>({business:await f.snapshot(),refunds:await f.applications(),statuses:await f.statuses(),
    receipts:await f.db.select().from(adminRefundOperation), payments:await f.db.select().from(storeOrderRefundPayment), outbox:await f.db.select().from(storeOrderOutbox)});
  const noStore=(response:Response)=>{
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
  };

  it('registers exactly seven retirement handlers after auth, with no accidental versioned alias',()=>{
    expect(app.routes.filter(route=>route.handler===retiredAdminRefundMutation).map(route=>`${route.method} ${route.path}`).sort())
      .toEqual(paths.map(path=>'POST '+path.replace(/\/28$/, '/:id')).sort());
  });
  it.each(paths)('returns real HTTP410 and no receipt or business write for %s',async path=>{
    const before=await snapshot();
    for(const body of [{action:'return',review:input.review,decision:input.decision},
      {refuse_reason:'合成拒绝原因',review:input.review,decision:input.decision},
      {order_id:'history_refund_28',price:'5.00',type:1,is_split_order:1,cart_ids:[{cart_id:28,cart_num:1}]},
      input,null]) {
      const response=await send(path,body); noStore(response); expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({status:410,data:null,msg:expect.stringContaining('不可自动重发')});
      expect(response.headers.has('Location')).toBe(false);
    }
    const keyed=await send(path,input,100,crypto.randomUUID()); expect(keyed.status).toBe(410);
    expect(await snapshot()).toEqual(before);
  });
  it('keeps entry authentication and refund.manage before retirement for all seven URLs',async()=>{
    const before=await snapshot();
    for(const path of paths) for(const [actor,status] of [[0,410000],[101,400011],[102,400011],[103,410002]]) {
      const response=await send(path,input,actor); noStore(response);
      expect(await response.json()).toMatchObject({status,data:null});
    }
    await f.db.update(systemAdmin).set({status:0}).where(eq(systemAdmin.id,100));
    for(const path of paths) expect(await(await send(path)).json()).toMatchObject({status:410002,data:null});
    expect(await snapshot()).toEqual(before);
  });
  it('does not read even a stalled malformed body or require an installed receipt table',async()=>{
    await f.exec('DROP TABLE admin_refund_operation');
    for(const path of paths) {
      const pull=vi.fn();
      const stream=new ReadableStream<Uint8Array>({pull},{highWaterMark:0});
      const init={method:'POST',headers:{...headers(),'Content-Type':'not/json'},body:stream,duplex:'half'};
      const request=new Request('http://localhost'+path,init);
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        const response=await Promise.race([app.request(request,undefined,f.env),
          new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('Retirement waited for the old body')),1500);})]);
        expect(response.status).toBe(410); noStore(response); expect(request.bodyUsed).toBe(false); expect(pull).not.toHaveBeenCalled();
      } finally {clearTimeout(timer);await stream.cancel();}
    }
    expect(await f.statuses()).toEqual([]);
  });
  it('rejects alternate methods/path spellings without falling back to financial execution',async()=>{
    const before=await snapshot();
    for(const path of paths) {
      for(const candidate of [path+'/',path.replace('/28','/%32%38'),path+'?_method=POST',path.replace('/admin/refund/','/admin/%72efund/')]) {
        const response=await send(candidate); expect(response.headers.get('Cache-Control')).toContain('no-store');
        expect(await response.json()).not.toMatchObject({status:200});
      }
      for(const method of ['GET','HEAD','PUT','PATCH','DELETE']) {
        const response=await app.request(path,{method,headers:{...headers(),'X-HTTP-Method-Override':'POST'}},f.env);
        expect(response.headers.get('Cache-Control')).toContain('no-store');
        if(method!=='HEAD')expect(await response.json()).not.toMatchObject({status:200});
      }
    }
    expect(await snapshot()).toEqual(before);
  });
  it('preserves read-only list/detail routes on both Admin prefixes',async()=>{
    const before=await snapshot();
    for(const base of ['/adminapi/refund','/api/admin/refund']) for(const path of ['/detail/28','/list?view=admin&limit=7']) {
      const response=await app.request(base+path,{headers:headers(101)},f.env);
      noStore(response); expect(await response.json()).toMatchObject({status:200});
    }
    expect(await snapshot()).toEqual(before);
  });
  it('leaves the versioned fence intact when a late legacy packet reaches this new deployment',async()=>{
    const key=crypto.randomUUID(), before=await snapshot();
    const fence=await send('/adminapi/refund/operations/abandon/28',input,100,key);
    expect(await fence.json()).toMatchObject({status:200,data:{receipt:{outcome:'abandoned',requestKey:key}}});
    const after=await snapshot();
    for(const path of paths)expect((await send(path,input,100,key)).status).toBe(410);
    const replay=await send('/api/admin/refund/operations/execute/28',input,100,key);
    expect(await replay.json()).toMatchObject({status:200,data:{replayed:true,receipt:{outcome:'abandoned'},execution:null}});
    expect(await snapshot()).toEqual(after);expect(after.business).toEqual(before.business);expect(after.statuses).toEqual([]);
    // This tests new deployment admission, NOT an old Worker invocation which
    // already passed its old handler. Rollout must handle those separately.
  });
});
