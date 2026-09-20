import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { adminRefundEvidenceFixture } from './helpers/adminRefundEvidenceFixture';
import { adminRefundOperation, storeOrder, storeOrderRefund, systemAttachment, systemRole } from '../src/models/schema';
import { StoreOrderRefundService } from '../src/services/order/StoreOrderRefundService';
import { WechatPayService } from '../src/services/wechat/WechatPayService';
import { ADMIN_REFUND_OPERATION_SQL } from '../src/migrations/adminRefundOperation';

describe('Admin refund actual auth/SQL read and reviewed decision contract', () => {
  let f: Awaited<ReturnType<typeof adminRefundEvidenceFixture>>;
  beforeAll(async () => { f = await adminRefundEvidenceFixture(); await f.exec(ADMIN_REFUND_OPERATION_SQL); });
  afterAll(async () => { await f?.close(); });
  afterEach(() => vi.restoreAllMocks());
  const request = (path: string, actor = 100, body?: Record<string,unknown>, key=crypto.randomUUID()) => f.adminApp.request('/adminapi/refund/' + path,
    { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${f.tokens.get(actor) ?? ''}`, 'content-type': 'application/json',
      'Idempotency-Key':key,'X-Refund-Operation-Scope':`v1:admin:${actor}` }, body: body === undefined ? undefined : JSON.stringify({version:'admin-refund-operation-v1',...body}) }, f.env);
  const read = async (id = 25, actor = 100) => await (await request('detail/' + id, actor)).json() as { status: number; data: Record<string, unknown> };
  const review = (id: number) => ({ uid: 11, storeId: 0, supplierId: 0, storeOrderId: id, orderId: 'history_refund_' + id, refundPrice: '5.00' });
  const decision = (refundType: number, received = false) => ({applyType:2,refundType,received});

  it('reads signed owned evidence, customer fields and contact without changing business state', async () => {
    const [image] = await f.db.insert(systemAttachment).values({ type:3,moduleType:3,relationId:11,fileType:1,imageType:8 }).returning();
    await f.db.update(storeOrderRefund).set({ refundExpress:'LOCAL-25',refundExpressName:'本地快递甲',refundPhone:'000000',refundGoodsExplain:'<b>纯文本备注</b>',refundGoodsImg:JSON.stringify(['/api/assets/' + image.attId]) }).where(eq(storeOrderRefund.id,25));
    const snapshot = await f.snapshot(), refunds = await f.applications(), statuses = await f.statuses();
    const response = await request('detail/25'), result = await response.json();
    expect(result).toMatchObject({status:200,data:{id:25,refundExpress:'LOCAL-25',refundGoodsExplain:'<b>纯文本备注</b>',returnImages:[{url:'/api/assets/'+image.attId,src:expect.stringContaining('?expires=')}],returnImagesError:'',returnContact:{name:'本地收件人'}}});
    expect(response.headers.get('cache-control')).toContain('private, no-store'); expect(JSON.stringify(result)).not.toContain('refundGoodsImg');
    expect(await f.snapshot()).toEqual(snapshot); expect(await f.applications()).toEqual(refunds); expect(await f.statuses()).toEqual(statuses);
  });
  it('reads all pages without duplicate IDs; supports exact literal single-order search', async () => {
    let cursor: string | null = null; const ids: number[] = [];
    do {
      const response = await request('list?view=admin&limit=7' + (cursor ? '&before='+cursor : ''));
      const body = await response.json() as {data:{list:Array<{id:number}>;nextCursor:string|null}};
      expect(response.headers.get('cache-control')).toContain('no-store'); ids.push(...body.data.list.map(row=>row.id)); cursor=body.data.nextCursor;
    } while(cursor);
    expect(ids).toHaveLength(27); expect(new Set(ids).size).toBe(27); expect(ids).toContain(21); expect(ids).not.toContain(47);
    expect(await (await request('list?view=admin&keyword=history_order_25')).json()).toMatchObject({data:{list:[{id:25}]}});
    expect(await (await request('list?view=admin&keyword=%25')).json()).toMatchObject({data:{list:[]}});
  });
  it('requires real platform read/manage roles and rejects revoked or non-platform identities', async () => {
    expect((await read(25,101)).status).toBe(200);
    for(const actor of [0,102,103]) expect((await read(25,actor)).status).not.toBe(200);
    for(const action of ['return','refuse']) expect(await (await request('operations/execute/25',101,{action,review:review(25),decision:decision(0),...(action==='refuse'?{reason:'denied'}:{})})).json()).toMatchObject({status:400011});
    await f.db.update(systemRole).set({status:0}).where(eq(systemRole.id,1));
    try { expect((await read(25,101)).status).not.toBe(200); } finally { await f.db.update(systemRole).set({status:1}).where(eq(systemRole.id,1)); }
  });
  it.each(['owner','supplier','store','refund-deleted','order-deleted','system-deleted'])('rejects inconsistent/deleted detail and list visibility: %s', async kind => {
    await f.db.update(storeOrderRefund).set({uid:kind==='owner'?22:11,supplierId:kind==='supplier'?9:0,storeId:kind==='store'?9:0,isDel:kind==='refund-deleted'?1:0}).where(eq(storeOrderRefund.id,32));
    await f.db.update(storeOrder).set({isDel:kind==='order-deleted'?1:0,isSystemDel:kind==='system-deleted'?1:0}).where(eq(storeOrder.id,32));
    try { expect((await read(32)).status).toBe(404); expect(await(await request('list?view=admin&keyword=history_refund_32')).json()).toMatchObject({data:{list:[]}}); }
    finally {await f.db.update(storeOrderRefund).set({uid:11,supplierId:0,storeId:0,isDel:0}).where(eq(storeOrderRefund.id,32));await f.db.update(storeOrder).set({isDel:0,isSystemDel:0}).where(eq(storeOrder.id,32));}
  });
  it('does not sign foreign, wrong-purpose, malformed or oversized evidence and bounds legacy cart JSON', async () => {
    const [other] = await f.db.insert(systemAttachment).values({type:3,moduleType:3,relationId:22,fileType:1,imageType:8}).returning();
    const [wrong] = await f.db.insert(systemAttachment).values({type:3,moduleType:3,relationId:11,fileType:1,imageType:1}).returning();
    for(const value of ['[','x'.repeat(9000),'["javascript:alert(1)"]',JSON.stringify(['/api/assets/'+other.attId]),JSON.stringify(['/api/assets/'+wrong.attId])]) {
      await f.db.update(storeOrderRefund).set({refundGoodsImg:value,cartInfo:'x'.repeat(70000)}).where(eq(storeOrderRefund.id,32));
      expect((await read(32)).data).toMatchObject({returnImages:[],returnImagesError:expect.any(String),cartInfo:null}); expect(JSON.stringify((await read(32)).data)).not.toContain('signature=');
    }
  });
  it.each(['0','-1','1e1','01','2147483648'])('rejects noncanonical identifiers: %s', async id => {
    expect(await(await request('detail/'+id)).json()).not.toMatchObject({status:200});
  });
  it('requires bounded explicit review and rejects amount drift under the real decision locks', async () => {
    const before = await f.snapshot(), refunds = await f.applications(), statuses = await f.statuses();
    for(const body of [{}, {action:'refund'}, {action:'invalid',review:review(25)}, {action:'refund',review:{...review(25),refundPrice:'6.00'},decision:decision(5,true)}, {action:'return',review:{...review(25),uid:22},decision:decision(0)}, {action:'refund',review:review(25),extra:'x'.repeat(5000)}]) {
      expect(await(await request('operations/execute/25',100,body)).json()).not.toMatchObject({status:200});
    }
    expect(await f.snapshot()).toEqual(before); expect(await f.applications()).toEqual(refunds); expect(await f.statuses()).toEqual(statuses);
  });
  it('approves a return only, rejects a stale reviewed-state replay and does not settle money', async () => {
    const before = await f.snapshot(), refunds = await f.applications();
    expect(await(await request('operations/execute/28',100,{action:'return',review:review(28),decision:decision(0)})).json()).toMatchObject({status:200,data:{receipt:{outcome:'return-approved'},execution:null}});
    // A new key with stale reviewed state is not a same-operation replay.
    expect(await(await request('operations/execute/28',100,{action:'return',review:review(28),decision:decision(0)})).json()).not.toMatchObject({status:200});
    expect((await read(28)).data.refundType).toBe(4); expect((await f.statuses()).filter(row=>row.oid===28)).toHaveLength(1);
    const after = await f.snapshot();
    after.orders.sort((a,b)=>a.id-b.id);
    expect(after).toEqual({...before, orders: before.orders.map(order => order.id === 28 ? {...order, refundStatus:1, refundType:4} : order).sort((a,b)=>a.id-b.id)});
    expect((await f.applications()).sort((a,b)=>a.id-b.id)).toEqual(refunds.map(row=>row.id===28?{...row,refundType:4}:row).sort((a,b)=>a.id-b.id));
    expect((await f.applications()).find(row=>row.id===28)?.refundedPrice).toBe('0.00');
  });
  it('persists provider admission and passes reviewed scope through the real core without real payment I/O', async () => {
    await f.db.update(storeOrder).set({payType:'weixin',status:0}).where(eq(storeOrder.id,25));
    await f.db.update(storeOrderRefund).set({refundType:5}).where(eq(storeOrderRefund.id,25));
    const core = vi.spyOn(StoreOrderRefundService.prototype,'agreeRefund');
    const gateway = vi.spyOn(WechatPayService.prototype,'requestRefund').mockResolvedValue({status:'PROCESSING'});
    const key=crypto.randomUUID(), body={action:'refund',review:review(25),decision:decision(5,true)};
    const result=await(await request('operations/execute/25',100,body,key)).json();
    expect(result,JSON.stringify(result)).toMatchObject({status:200,data:{receipt:{outcome:'provider-admitted',requestKey:key},execution:{completed:false,status:'PROCESSING'}}});
    expect(core).toHaveBeenCalledWith(25,expect.objectContaining({expectedUid:11,expectedRefundAmountCents:500,expectedStoreOrderId:25,requirePaid:true}));
    expect(gateway).toHaveBeenCalledTimes(1);
    const receipts=await f.db.select().from(adminRefundOperation);
    core.mockRejectedValueOnce(new Error('unknown outcome')); expect(await(await request('operations/execute/25',100,body,key)).json()).toMatchObject({status:500});
    expect(await f.db.select().from(adminRefundOperation)).toEqual(receipts);
  });
  it('commits the exact refusal reason and reviewed scope with a durable receipt', async () => {
    const core = vi.spyOn(StoreOrderRefundService.prototype,'refuseRefund');
    expect(await(await request('operations/execute/35',100,{action:'refuse',review:review(35),decision:decision(0),reason:'本地原因'})).json()).toMatchObject({status:200,data:{receipt:{outcome:'refused'},execution:null}});
    expect(core).toHaveBeenCalledWith(35,'本地原因',expect.objectContaining({expectedUid:11,expectedRefundAmountCents:500,expectedStoreOrderId:35}));
    expect((await f.applications()).find(row=>row.id===35)).toMatchObject({refuseReason:'本地原因',refundType:3,refundedPrice:'0.00'});
  });
});

describe('Admin signed evidence Pages proxy', () => {
  afterEach(()=>vi.unstubAllGlobals());
  it('streams only GET/HEAD, keeps signing query, strips cookies and does not forward admin credentials', async () => {
    const run=(await import(new URL('../../view/admin-ts/functions/api/assets/[id].ts',import.meta.url).href)).onRequest;
    const upstream=vi.fn(async()=>new Response('image',{headers:{'set-cookie':'private','cache-control':'public'}}));vi.stubGlobal('fetch',upstream);
    const response=await run({request:new Request('https://admin.invalid/api/assets/7?expires=123&signature=local',{headers:{authorization:'private',cookie:'private'}}),env:{}});
    expect(upstream).toHaveBeenCalledWith(new URL('https://cinashop-api.cinagroup.workers.dev/api/assets/7?expires=123&signature=local'),{method:'GET',redirect:'manual'});
    expect(response.headers.get('cache-control')).toContain('private, no-store');expect(response.headers.has('set-cookie')).toBe(false);expect(await response.text()).toBe('image');
    upstream.mockClear(); for(const [path,method,status] of [['/api/assets/7','POST',405],['/api/assets/7/more','GET',404]] as const) expect((await run({request:new Request('https://admin.invalid'+path,{method}),env:{}})).status).toBe(status);
    expect(upstream).not.toHaveBeenCalled();
  });
});
