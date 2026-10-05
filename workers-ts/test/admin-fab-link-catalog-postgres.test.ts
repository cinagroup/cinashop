import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresJsPreparedQuery } from 'drizzle-orm/postgres-js';
import type { PreparedQueryConfig } from 'drizzle-orm/pg-core';
import { storeProduct, pageLink, pageCategory } from '../src/models/schema';
import { fabLinkCatalogFixture } from './helpers/fabLinkCatalogFixture';
import { waitForFinanceBlock } from './helpers/financePeers';
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('FAB read catalog actual PG16 runtime slice', () => {
  let f: Awaited<ReturnType<typeof fabLinkCatalogFixture>>;
  beforeEach(async()=>{f=await fabLinkCatalogFixture();},30000);
  afterEach(async()=>{vi.restoreAllMocks();await f?.close();},30000);
  const query=(kind:string,extra='')=>new URLSearchParams(`kind=${kind}${extra}`);
  async function runtime(run:(app:Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0],admin:Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0])=>Promise<void>) {
    await f.withRuntimeRole(app=>f.withRuntimeRole(async admin=>{
      await f.installSlice(app,admin);
      expect(new Set([app.pid,admin.pid]).size).toBe(2);
      for(const peer of [app,admin]) expect((await peer.exec('SELECT current_user,session_user'))[0]).toEqual({current_user:peer.role,session_user:peer.role});
      await run(app,admin);
    }));
  }
  it('reads static kinds from mutable category/type identities and masks unsafe history without initialization or writes',async()=>runtime(async(app,admin)=>{
    const before=await f.snapshot();
    for(const peer of [app,admin]) {
      const service=f.serviceFor(peer.db);
      expect((await service.categories()).list).toHaveLength(13);
      const basic=await service.targets(query('basic'));
      expect(basic.count).toBe(2);expect(basic.list.map(row=>row.id)).toEqual([1,6]);
      expect(basic.list[1]).toMatchObject({url:'',selectable:false});
      expect((await service.targets(query('personal'))).list.map(row=>row.id)).toEqual([2]);
      expect((await service.targets(query('distribution'))).list.map(row=>row.id)).toEqual([3]);
      const marketing=await service.targets(query('marketing'));expect(marketing.count).toBe(3);
      expect(marketing.list.find(row=>row.id===5)).toMatchObject({url:'/pages/goods/lottery/grids/index?type=1',selectable:true,partial:false});
      expect(marketing.list.find(row=>row.id===9)).toMatchObject({url:'',selectable:false,issues:[expect.any(String)]});
      expect((await service.targets(query('basic','&search=首页&limit=1')))).toMatchObject({count:1,page:1,limit:1,list:[{id:1}]});
    }
    expect(await f.snapshot()).toEqual(before);
    await f.db.delete(pageLink);await f.db.delete(pageCategory);
    const emptyBefore=await f.snapshot();expect((await f.serviceFor(admin.db).targets(query('basic'))).list).toEqual([]);
    expect(await f.snapshot()).toEqual(emptyBefore);
  }));
  it('reads published source-linked products/activities, hierarchy, articles and topics through exact current SELECT grants',async()=>runtime(async(app,admin)=>{
    for(const peer of [app,admin]) {
      const service=f.serviceFor(peer.db), products=await service.targets(query('product'));
      expect(products.list.map(row=>row.id)).toEqual([29,23,22,21]);expect(products.count).toBe(4);
      expect(products.list.find(row=>row.id===29)).toMatchObject({selectable:true,price:'40.00',issues:[expect.stringContaining('会员')]});
      expect(products.list.find(row=>row.id===21)?.image_preview).toMatch(/^\/api\/assets\/41\?expires=\d+&signature=/);
      expect(products.list.find(row=>row.id===23)?.image_preview).toMatch(/^\/api\/assets\/42\?expires=\d+&signature=/);
      for(const [kind,search,ids] of [
        ['product','2',[29,23,22,21]], ['product','普通商品',[21]],
        ['product','not-serialized',[21]], ['product','private-info-21',[21]],
        ['product','BASE-21',[21]], ['product','SKU-catalog-22',[22]],
        ['presale','SKU-catalog-22',[22]], ['product','foreign-activity-code',[]],
        ['product','retired-sku-code',[]], ['product','%_',[]],
      ] as const) {
        const found=await service.targets(query(kind,`&search=${encodeURIComponent(search)}`));
        expect(found.list.map(row=>row.id),`${kind}:${search}`).toEqual(ids);
        expect(found.count,`${kind}:${search}`).toBe(ids.length);
      }
      expect((await service.targets(query('product','&parent_id=11'))).list.map(row=>row.id)).toEqual([21]);
      expect((await service.targets(query('product_category'))).list).toMatchObject([{id:11,parent_id:0,has_children:true}]);
      expect((await service.targets(query('product_category','&parent_id=11'))).list).toMatchObject([{id:12,parent_id:11,has_children:false}]);
      await expect(service.targets(query('product_category','&parent_id=15'))).rejects.toThrow(/父分类/);
      for(const [kind,id] of [['seckill',31],['bargain',41],['combination',51],['news',81],['presale',22]] as const) {
        const result=await service.targets(query(kind));expect(result.count,kind).toBe(1);expect(result.list[0],kind).toMatchObject({id,selectable:true});
      }
      expect((await service.targets(query('integral'))).list[0]).toMatchObject({id:61,url:'/pages/activity/goods_details/index?id=61&type=4',selectable:true,issues:expect.arrayContaining([expect.stringContaining('为0')])});
      const topics=await service.targets(query('special'));expect(topics.count).toBe(2);
      expect(topics.list.find(row=>row.id===91)).toMatchObject({selectable:true}); // isShow=0 is an ad-popup flag, not draft authority.
      expect(topics.list.find(row=>row.id===93)).toMatchObject({selectable:false,url:expect.any(String)});
      const encoded=JSON.stringify([products,topics,await service.targets(query('news'))]);
      for(const secret of ['vip_price','secret body','keyword','settle_price','bank','raw_values','"value":',
        'not-serialized','private-info-21','BASE-21','SKU-catalog-22']) expect(encoded).not.toContain(secret);
    }
  }));
  it('keeps count and list in one actual repeatable-read snapshot across an independently committed published-product insert',async()=>runtime(async(_app,admin)=>{
    const execute=PostgresJsPreparedQuery.prototype.execute;let inserted=false;
    vi.spyOn(PostgresJsPreparedQuery.prototype,'execute').mockImplementation(async function(this:PostgresJsPreparedQuery<PreparedQueryConfig>,...args){
      const statement=this.getQuery().sql,result=await execute.apply(this,args);
      if(!inserted && statement.includes('SELECT count(*)::integer AS count FROM (') && statement.includes('public.store_product p')) {
        inserted=true;await f.db.insert(storeProduct).values({id:99,storeName:'并发发布',isVerify:1});
      }
      return result;
    });
    const before=await f.serviceFor(admin.db).targets(query('product'));expect(inserted).toBe(true);expect(before.count).toBe(4);expect(before.list.map(row=>row.id)).not.toContain(99);
    vi.restoreAllMocks();const fresh=await f.serviceFor(admin.db).targets(query('product'));expect(fresh.count).toBe(5);expect(fresh.list[0].id).toBe(99);
  }));
  it('uses the bounded actual catalog lock deadline rather than hanging behind a held table writer',async()=>runtime(async(_app,admin)=>{
    await f.withPeer(async writer=>{
      await writer.exec('BEGIN');await writer.exec('LOCK TABLE public.page_link IN ACCESS EXCLUSIVE MODE');
      const read=f.serviceFor(admin.db).targets(query('basic')).then(()=>({ok:true as const}),error=>({ok:false as const,error}));
      try {
        await waitForFinanceBlock(f.db,admin.pid,writer.pid);
        const result=await read;expect(result.ok).toBe(false);
        if(!result.ok) {let reason:unknown=result.error;const codes:string[]=[];for(let n=0;n<8 && reason && typeof reason==='object';n++){if('code' in reason)codes.push(String(reason.code));reason='cause' in reason?reason.cause:null;}expect(codes).toContain('55P03');}
      } finally {await writer.exec('ROLLBACK');}
      expect((await f.serviceFor(admin.db).targets(query('basic'))).count).toBe(2);
    });
  }));
});
