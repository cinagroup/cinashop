import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, getTableName, sql } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import { createApp } from '../src/app';
import { createContainerFromDb, type Container } from '../src/lib/di';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { createToken, md5 } from '../src/utils/jwt';
import { ApiErrorCode } from '../src/utils/errors';
import { expressCompany, queueAuxiliary, queueList, storeOrder, storeOrderCartInfo, storeOrderRefund, storePink,
  supplierFlowingWater, systemAdmin, systemRole, systemSupplier, user } from '../src/models/schema';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async importOriginal => {
  const original = await importOriginal<typeof import('../src/lib/di')>();
  return { ...original, createContainer: () => { if (!wiring.container) throw Error('No isolated DB'); return wiring.container; } };
});
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected object'); return value as Record<string, unknown>;
}
function rows(value: unknown) { if (!Array.isArray(value)) throw Error('Expected array'); return value.map(object); }
function afterSelect(pattern: RegExp, callback: () => Promise<void>, delayCount = false) {
  let reached = false, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const original = PostgresJsSession.prototype.prepareQuery;
  const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function(this: InstanceType<typeof PostgresJsSession>, ...args) {
    const prepared = original.apply(this,args), execute = prepared.execute.bind(prepared);
    if (pattern.test(args[0].sql)) {
      const isCount = /^select COUNT\(/i.test(args[0].sql);
      prepared.execute = async values => {
        if (delayCount && isCount) await barrier;
        const result = await execute(values);
        if (!reached && !isCount) { reached = true; try { await callback(); } finally { release(); } }
        return result;
      };
    }
    return prepared;
  });
  return () => { release(); spy.mockRestore(); expect(reached).toBe(true); };
}
const snapshot = { product: {storeName:'Modern sample'}, sku: {suk:'Blue',price:'12.34'}, sum_price:'12.34', vip_truePrice:'0.29' };

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('supplier export/history native SQL and authenticated HTTP', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  const app = createApp(), tokens = new Map<number,string>(), key = crypto.randomUUID()+crypto.randomUUID();
  beforeEach(async () => {
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
    await f.db.insert(systemRole).values([
      {id:990,roleName:'export fixture',type:4,relationId:7,status:1,rules:'supplier.order.view,supplier.order.manage,supplier.finance.manage'},
      {id:991,roleName:'view fixture',type:4,relationId:7,status:1,rules:'supplier.order.view'},
    ]);
    await f.db.insert(systemSupplier).values({id:8,adminId:992,supplierName:'Other fixture'});
    await f.db.insert(systemAdmin).values([
      {id:990,account:'local-export',pwd:'fixture-digest',adminType:4,relationId:7,roles:'990'},
      {id:991,account:'local-view',pwd:'fixture-digest',adminType:4,relationId:7,roles:'991'},
      {id:992,account:'local-other',pwd:'fixture-digest',adminType:4,relationId:8},
    ]);
    for(const id of [990,991,992]) tokens.set(id,(await createToken(id,'supplier',md5('fixture-digest'),key)).token);
  },45_000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); }
    finally { wiring.container=undefined;tokens.clear();vi.restoreAllMocks();await f?.close(); } },45_000);
  async function readOnly<T>(callback: (container:Container) => Promise<T>) {
    return f.withRuntimeRole!(async peer => {
      const tables=[storeOrder,storeOrderCartInfo,storeOrderRefund,storePink,user,systemAdmin,systemRole,systemSupplier,expressCompany,queueList,queueAuxiliary,supplierFlowingWater];
      await f.exec(`GRANT SELECT ON ${tables.map(table=>'"'+getTableName(table)+'"').join(',')} TO "${peer.role}"`);
      const container=createContainerFromDb(peer.db);wiring.container=container;
      const [role]=await peer.db.execute(sql`SELECT current_user=session_user AS independent, has_table_privilege(current_user,'store_order','UPDATE') AS writes`);
      expect(role).toMatchObject({independent:true,writes:false});
      return callback(container);
    });
  }
  async function send(path:string, token=tokens.get(990)!) {
    const response=await app.request('/supplierapi'+path,{headers:token?{'Authori-zation':`Bearer ${token}`} : {}},{...f.env,NODE_ENV:'test',APP_KEY:key});
    expect(response.headers.get('Cache-Control')).toContain('no-store');return object(await response.json());
  }
  async function data(path:string) { const body=await send(path);expect(body.status).toBe(200);return object(body.data); }
  async function seed() {
    await f.db.insert(storeOrder).values({id:25,orderId:'LOCAL-25',unique:'local-25',uid:11,supplierId:7,pid:0,paid:1,status:0,
      shippingType:1,realName:'Local customer',payPrice:'24.68',totalPrice:'24.68',totalNum:2});
    await f.db.insert(storeOrderCartInfo).values({id:25,oid:25,uid:11,type:2,relationId:7,cartId:'25',productId:70,cartNum:2,splitSurplusNum:2,unique:'local-cart-25',cartInfo:JSON.stringify(snapshot)});
  }
  const selected=(ids='25',type=0)=>`/export/storeOrder?selection=exact&ids=${ids}&type=${type}&page=1`;

  it('exports an explicitly selected real refund remainder instead of silently omitting it',async()=>{
    await f.withRuntime(async writer=>{const root=await writer.createPaid();const refund=await writer.apply(root.id);await writer.finish(refund.refundId);
      const order=await writer.order((await writer.receipt(refund.refundId)).remainingOrderId!);expect(order.pid).toBeGreaterThan(0);
      await readOnly(async()=>{const result=await data(selected(String(order.id)));expect(rows(result.export).map(row=>row.id)).toEqual([order.id]);
        expect(String(rows(result.export)[0].goods_name)).toContain('Local runtime remainder');});
    });
  },45_000);
  it('renders modern snapshots and exact member savings rather than empty zero-price goods',async()=>{
    await seed();await readOnly(async()=>{const result=await data(selected());const row=rows(result.export)[0];
      expect(row.goods_name).toContain('Modern sample (Blue) [2 * 12.34]');expect(row.vip_sum_price).toBe('0.58');});
  });
  it('never treats a legacy sale price as a missing member discount',async()=>{
    await seed();await f.db.update(storeOrderCartInfo).set({cartInfo:JSON.stringify({productInfo:{store_name:'Legacy'},truePrice:'12.34'})}).where(eq(storeOrderCartInfo.id,25));
    await readOnly(async()=>expect(rows((await data(selected())).export)[0].vip_sum_price).toBe('0.00'));
  });
  it('rejects wrong-customer order carts rather than exporting their content',async()=>{
    await seed();await f.db.update(storeOrderCartInfo).set({uid:22}).where(eq(storeOrderCartInfo.id,25));
    await readOnly(async()=>expect(await send(selected())).toMatchObject({status:400,data:null}));
  });
  it('keeps headers and cart snapshot from one committed generation',async()=>{
    await seed();await readOnly(async()=>{
      const before=await data(selected());
      const restore=afterSelect(/from "store_order" left join "user"/s,async()=>{
        await f.db.transaction(async tx=>{await tx.update(storeOrder).set({payPrice:'1.00',totalNum:1}).where(eq(storeOrder.id,25));
          await tx.update(storeOrderCartInfo).set({cartNum:1,cartInfo:JSON.stringify({...snapshot,sum_price:'1.00'})}).where(eq(storeOrderCartInfo.id,25));});
      });
      try {const result=await data(selected());expect(result.export).toEqual(before.export);}finally{restore();}
      expect((await data(selected())).export).not.toEqual(before.export);
    });
  });
  it('empty manifests retain header/key alignment',async()=>{
    await readOnly(async()=>{const result=await data('/export/storeOrder');expect(result.export).toEqual([]);expect(result.header).toHaveLength(20);expect(result.filekey).toHaveLength(20);});
  });
  it('queue rows and count stay from the same snapshot during an independent tenant change',async()=>{
    await seed();await f.db.insert(queueList).values({id:10,type:7,status:2});
    await f.db.insert(queueAuxiliary).values({id:10,bindingId:10,relationId:25,type:3,status:1});
    await readOnly(async()=>{
      const before=await data('/queue/index');
      const restore=afterSelect(/from "queue_list" inner join /s,async()=>{await f.db.update(storeOrder).set({supplierId:8}).where(eq(storeOrder.id,25));},true);
      try{expect(await data('/queue/index')).toEqual(before);}finally{restore();}
      expect(await data('/queue/index')).toMatchObject({list:[],count:0});
    });
  });
  it('exact selections fail closed for missing, foreign, hidden or shipping-ineligible orders',async()=>{
    await seed();await f.db.insert(storeOrder).values({id:26,orderId:'OTHER-26',unique:'other-26',uid:22,supplierId:8});
    await readOnly(async()=>{
      for(const path of [selected('25,999'),selected('25,26'),selected('26'),selected('25',1)])
        expect(await send(path),path).toMatchObject({status:400,data:null});
      await f.db.update(storeOrder).set({isSystemDel:1}).where(eq(storeOrder.id,25));
      expect(await send(selected())).toMatchObject({status:400,data:null});
    });
  });
  it('shipping exports preserve logistics columns and reject active refunds',async()=>{
    await seed();await f.db.update(storeOrder).set({status:1}).where(eq(storeOrder.id,25));
    await readOnly(async()=>{
      const manifest=await data(selected('25',1));expect(manifest.header).toHaveLength(15);
      expect(rows(manifest.export)[0]).toMatchObject({a:'',b:'',c:'',cart_num:'2 * 12.34'});
      await f.db.insert(storeOrderRefund).values({storeOrderId:25,refundType:1,isCancel:0,isDel:0});
      expect(await send(selected('25',1))).toMatchObject({status:400,data:null});
    });
  });
  it('keeps legacy root filtering but includes modern store children only through exact selection',async()=>{
    await seed();await f.db.update(storeOrder).set({pid:123,storeId:5}).where(eq(storeOrder.id,25));
    await readOnly(async()=>{
      expect((await data('/export/storeOrder?ids=25')).export).toEqual([]);
      expect(rows((await data(selected())).export).map(row=>row.id)).toEqual([25]);
    });
  });
  it('rejects duplicate, malformed and oversized selections before returning any manifest',async()=>{
    await seed();await readOnly(async()=>{
      for(const path of [selected()+'&ids=26',selected()+'&page=2',selected()+'&page=1e0',
        '/export/storeOrder?selection=exact','/export/storeOrder?selection=other&ids=25',selected('25',2),selected()+'&status=foo',
        selected(Array.from({length:251},(_,i)=>String(i+1)).join(',')),
        '/queue/index?page=1&page=2','/queue/index?page=1e0','/queue/delivery/log/10/3?limit=1&limit=2'])
        expect(await send(path),path).toMatchObject({status:400,data:null});
    });
  });
  it('view-only users cannot export and anonymous requests cannot read history',async()=>{
    await seed();await readOnly(async()=>{
      expect(await send(selected(),tokens.get(991)!)).toMatchObject({status:ApiErrorCode.ERR_AUTH,data:null});
      expect((await send('/queue/index','')).status).not.toBe(200);
    });
  });
  it('rejects malformed snapshots, wrong supplier, invalid money and excessive per-order rows',async()=>{
    await seed();await readOnly(async()=>{
      for(const cartInfo of ['{','[]',JSON.stringify({...snapshot,sum_price:'NaN'}),JSON.stringify({...snapshot,sum_price:'1e2'}),
        JSON.stringify({...snapshot,extra:'x'.repeat(65536)})]) {
        await f.db.update(storeOrderCartInfo).set({cartInfo}).where(eq(storeOrderCartInfo.id,25));
        expect(await send(selected())).toMatchObject({status:400,data:null});
      }
      await f.db.update(storeOrderCartInfo).set({cartInfo:JSON.stringify(snapshot),relationId:8}).where(eq(storeOrderCartInfo.id,25));
      expect(await send(selected())).toMatchObject({status:400,data:null});
      await f.db.update(storeOrderCartInfo).set({relationId:7,cartNum:-1}).where(eq(storeOrderCartInfo.id,25));
      expect(await send(selected())).toMatchObject({status:400,data:null});
      await f.db.update(storeOrderCartInfo).set({cartNum:2}).where(eq(storeOrderCartInfo.id,25));
      await f.db.insert(storeOrderCartInfo).values(Array.from({length:200},(_,i)=>({id:100+i,oid:25,uid:11,type:2,relationId:7,
        cartId:String(100+i),unique:'extra-'+i,cartNum:1,cartInfo:JSON.stringify(snapshot)})));
      expect(await send(selected())).toMatchObject({status:400,data:null});
    });
  });
  it('queue details and batch files exclude another supplier in a shared legacy task',async()=>{
    await seed();await f.db.insert(storeOrder).values({id:26,orderId:'OTHER-PRIVATE',unique:'other-private',uid:22,supplierId:8});
    await f.db.insert(queueList).values({id:10,type:7,status:2,queueInValue:'OPAQUE-SECRET'});
    await f.db.insert(queueAuxiliary).values([{id:10,bindingId:10,relationId:25,type:3,status:1},
      {id:11,bindingId:10,relationId:26,type:3,status:2,other:'OTHER-SECRET'}]);
    await readOnly(async()=>{
      const list=await data('/queue/index'), detail=await data('/queue/delivery/log/10/3'), manifest=await data('/export/batchOrderDelivery/10/7/3');
      expect(list.count).toBe(1);expect(rows(list.list)[0]).toMatchObject({total_num:1,success_num:1});
      expect(detail.count).toBe(1);expect(rows(detail.list).map(row=>row.order_id)).toEqual(['LOCAL-25']);
      expect(rows(manifest.export).map(row=>row.order_id)).toEqual(['LOCAL-25']);
      expect(JSON.stringify([list,detail,manifest])).not.toMatch(/OTHER-PRIVATE|OPAQUE-SECRET|OTHER-SECRET/);
      expect(await data('/queue/delivery/log/999/3')).toMatchObject({list:[],count:0});
    });
  });
  it('queue detail rows and total retain one snapshot during tenant reassignment',async()=>{
    await seed();await f.db.insert(queueList).values({id:10,type:7,status:2});
    await f.db.insert(queueAuxiliary).values({id:10,bindingId:10,relationId:25,type:3,status:1});
    await readOnly(async()=>{
      const before=await data('/queue/delivery/log/10/3');
      const restore=afterSelect(/from "queue_auxiliary" inner join /s,async()=>{await f.db.update(storeOrder).set({supplierId:8}).where(eq(storeOrder.id,25));},true);
      try{expect(await data('/queue/delivery/log/10/3')).toEqual(before);}finally{restore();}
      expect(await data('/queue/delivery/log/10/3')).toMatchObject({list:[],count:0});
    });
  });
  it('bounds aggregate snapshot bytes before returning data',async()=>{
    await seed();
    await f.db.insert(storeOrderCartInfo).values(Array.from({length:140},(_,i)=>({id:100+i,oid:25,uid:11,type:2,relationId:7,
      cartId:String(100+i),unique:'large-'+i,cartNum:1,cartInfo:JSON.stringify({...snapshot,extra:'x'.repeat(62000)})})));
    await readOnly(async()=>expect(await send(selected())).toMatchObject({status:400,data:null}));
  });
  it('bounds combined cart rows while allowing several valid small orders',async()=>{
    await seed();const ids=Array.from({length:11},(_,i)=>100+i);
    await f.db.insert(storeOrder).values(ids.map(id=>({id,orderId:'MANY-'+id,unique:'many-'+id,uid:11,supplierId:7})));
    await f.db.insert(storeOrderCartInfo).values(ids.flatMap((oid,index)=>Array.from({length:182},(_,i)=>({id:1000+index*182+i,oid,uid:11,type:2,relationId:7,
      cartId:String(1000+index*182+i),unique:'many-cart-'+index+'-'+i,cartNum:1,cartInfo:JSON.stringify(snapshot)}))));
    await readOnly(async()=>{
      expect(rows((await data(selected('100,101'))).export)).toHaveLength(2);
      expect(await send(selected(ids.join(',')))).toMatchObject({status:400,data:null});
    });
  });
  it('retains empty directory, batch and finance column definitions',async()=>{
    await readOnly(async()=>{
      for(const [path,length] of [['/export/expressList',2],['/export/batchOrderDelivery/999/7/3',5],
        ['/export/batchOrderDelivery/999/10/6',4],['/export/financeRecord?ids=999',8]] as const){
        const manifest=await data(path);expect(manifest.export).toEqual([]);expect(manifest.header).toHaveLength(length);expect(manifest.filekey).toHaveLength(length);
      }
    });
  });
  it('uses legacy member-discount truncation and complete legacy ownership without price fallback',async()=>{
    await seed();await f.db.update(storeOrderCartInfo).set({type:0,relationId:0,cartNum:0,
      cartInfo:JSON.stringify({cart_num:3,truePrice:'10.20',vip_truePrice:'0.0099',productInfo:{store_name:'Legacy',attrInfo:{suk:'Red',price:'10.21'}}})}).where(eq(storeOrderCartInfo.id,25));
    await readOnly(async()=>{
      const row=rows((await data(selected())).export)[0];expect(row.goods_name).toBe('Legacy (Red) [3 * 10.20]');expect(row.vip_sum_price).toBe('0.02');
    });
  });
});
