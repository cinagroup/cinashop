/** Real public App/JWT and independent SELECT-only PG16 LOGIN. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {createApp} from '@/app';
import {withTx,type Container} from '@/lib/di';
import {storeProduct,storeProductAttr,storeProductAttrValue,storeProductDescription,systemAdmin,systemAttachment,systemRole} from '@/models/schema';
import {assertSupplierProductDetailReadReady,readSupplierProductDetailSnapshot,SupplierProductDetailReadService} from '@/services/supplier/SupplierProductDetailReadService';
import {supplierProductDetailActor as actor,supplierProductDetailFixture} from './helpers/supplierProductDetail';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{
 if(!wiring.container)throw Error('Missing owned detail reader');return wiring.container;
}}));
const app=createApp(),url=(id:unknown)=>'/supplierapi/product/product/'+String(id)+'/view';
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier product detail actual App JWT and restricted PG16',()=>{
 let f:Awaited<ReturnType<typeof supplierProductDetailFixture>>;
 beforeEach(async()=>{vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No product detail provider I/O'));f=await supplierProductDetailFixture();},30000);
 afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{try{await f?.close();}finally{wiring.container=undefined;vi.restoreAllMocks();}}});
 async function request(id:unknown=80,identity:'reader'|'viewer'|'denied'|'other'|'anonymous'='reader',query=''){
  const response=await app.request(url(id)+query,{headers:identity==='anonymous'?{}:{Authorization:'Bearer '+f.tokens[identity]}},f.env);
  expect(response.headers.get('cache-control')).toContain('no-store');return response.json<{status:number;data:any}>();
 }
 async function unchanged<T>(work:()=>Promise<T>){const before=await f.snapshot(),seq=await f.sequences(),result=await work();
  expect(await f.snapshot()).toEqual(before);expect(await f.sequences()).toEqual(seq);return result;
 }
 it('returns closed9 product30 SKU10 and one complete tenant-scoped safe catalogue snapshot',async()=>f.withReader(async runtime=>{
  wiring.container=runtime.container;const result=await unchanged(()=>request());expect(result.status).toBe(200);const d=result.data;
  expect(Object.keys(d).sort()).toEqual(['actor_id','attributes','bounded','media','product','product_id','skus','supplier_id','version']);
  expect(d).toMatchObject({version:'supplier-product-detail-v1',actor_id:21,supplier_id:7,product_id:80,bounded:true});
  expect(Object.keys(d.product)).toHaveLength(30);expect(d.product).toMatchObject({store_name:'本机商品甲',price:'19.99',ot_price:'29.99',vip_price:'18.00',stock:12,sales:5,is_verify:-1,refusal:'合成审核驳回原因',postage:'3.50'});
  expect(d.attributes).toEqual([{name:'颜色',values:['蓝','红']}]);expect(d.skus.map((x:any)=>x.id)).toEqual([180,181]);
  expect(d.skus.every((x:any)=>Object.keys(x).length===10&&x.is_retired===0)).toBe(true);
  expect(JSON.stringify(d)).not.toMatch(/OWNED_|disk_info|retired_attrs|settle_price|brokerage|write_times|"unique"|"cost"|"code"/);
 }));
 it('allows product.view-only actor22 without manage or attachment library permissions',async()=>f.withReader(async runtime=>{
  wiring.container=runtime.container;const x=await unchanged(()=>request(80,'viewer'));expect(x.status).toBe(200);expect(x.data.actor_id).toBe(22);
  expect(x.data.media.previews['/api/assets/31'].status).toBe('ready');
 }));
 it('never reads or exposes fixed virtual content activity or retired SKU secrets',async()=>f.withReader(async runtime=>{
  wiring.container=runtime.container;const result=await unchanged(()=>request(81));expect(result.status).toBe(200);
  expect(result.data.product.product_type).toBe(1);expect(result.data.skus.map((x:any)=>x.id)).toEqual([183]);expect(JSON.stringify(result.data)).not.toContain('OWNED_');
 }));
 it('projects canonical sanitized HTML once and delegates only authorized private image and video',async()=>f.withReader(async runtime=>{
  wiring.container=runtime.container;const result=await unchanged(()=>request());expect(result.status).toBe(200);const d=result.data;
  expect(d.media.description_html).toContain('/api/assets/31');expect(d.media.description_html).not.toMatch(/signature=|expires=|<script|<iframe|onerror=/i);
  const own=d.media.previews['/api/assets/31'];expect(own.status).toBe('ready');expect(own.src).toMatch(/^\/api\/assets\/31\?expires=\d+&signature=/);
  expect(d.media.previews['/api/assets/32']).toEqual({status:'unavailable',expires_at:null});expect(d.product.video_link).toBe('/api/assets/41');
  expect(d.product.video_preview_url).toMatch(/^\/api\/assets\/41\?expires=\d+&signature=/);
  const response=await app.request(own.src,{},f.env);expect(response.status).toBe(200);expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.png);
 }));
 it.each([90,91,92,999])('rejects foreign wrong-owner-type recycled or absent product %i without writes',async id=>f.withReader(async runtime=>{
  wiring.container=runtime.container;expect((await unchanged(()=>request(id))).status).toBe(404);
 }));
 it('rejects foreign denied anonymous malformed duplicate and query-selected identities',async()=>f.withReader(async runtime=>{
  wiring.container=runtime.container;await unchanged(async()=>{
   expect((await request(80,'other')).status).toBe(404);expect((await request(80,'denied')).status).toBe(400011);
   expect((await request(80,'anonymous')).status).toBe(410000);expect((await request('01')).status).toBe(400);
   expect((await request(80,'reader','?supplier_id=8')).status).toBe(400);expect((await request(80,'reader','?id=80&id=81')).status).toBe(400);
  });
 }));
 it('proves the actual independent reader has nine SELECT tables no business DML and no sequence rights',async()=>f.withReader(async runtime=>{
  const[selected]=await runtime.db.execute(sql`SELECT count(*)::int AS n FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND has_table_privilege(current_user,c.oid,'SELECT')`);expect(selected.n).toBe(9);
  const[privileges]=await runtime.db.execute(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
   AND(has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES')))
   AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='S'AND has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE'))AS pure`);expect(privileges.pure).toBe(true);
 }));
 it('preflights missing SELECT before any failing SQL and preserves same-transaction SELECT1',async()=>f.withReader(async runtime=>{
  await f.exec(`REVOKE SELECT ON public.store_product_description FROM "${runtime.role}"`);
  await withTx(runtime.container,async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ,READ ONLY`);
   await expect(assertSupplierProductDetailReadReady(tx)).rejects.toMatchObject({httpStatus:503});expect((await tx.execute(sql`SELECT 1 AS alive`))[0]?.alive).toBe(1);
  });wiring.container=runtime.container;expect((await unchanged(()=>request())).status).toBe(503);
 }));
 it('requires a real read-only repeatable snapshot and rejects a maintenance owner connection',async()=>f.withReader(async runtime=>{
  await withTx(runtime.container,async tx=>{await expect(assertSupplierProductDetailReadReady(tx)).rejects.toMatchObject({httpStatus:503});});
  await expect(new SupplierProductDetailReadService(f.container,f.env.APP_KEY).read(actor,80)).rejects.toMatchObject({httpStatus:503});
 }));
 it('preserves one RR snapshot during committed product SKU description and carousel changes',async()=>f.withReader(async runtime=>{
  const before=await f.snapshot();
  await withTx(runtime.container,async tx=>{
   await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ,READ ONLY`);await tx.select({id:storeProduct.id}).from(storeProduct).where(eq(storeProduct.id,80));
   await f.db.transaction(async owner=>{
    await owner.update(storeProduct).set({storeName:'独立提交的新商品名',price:'25.00',sliderImage:'["/owned-media/new.png"]'}).where(eq(storeProduct.id,80));
    await owner.update(storeProductAttrValue).set({stock:8}).where(eq(storeProductAttrValue.id,180));
    await owner.update(storeProductDescription).set({description:'<p>新详情</p>'}).where(and(eq(storeProductDescription.productId,80),eq(storeProductDescription.type,0)));
   });
   const old=await readSupplierProductDetailSnapshot(tx,actor,80,f.env.APP_KEY);expect(old.product.store_name).toBe('本机商品甲');expect(old.skus[0].stock).toBe(9);expect(old.media.description_html).toContain('本机商品甲详情');
  });
  const after=await f.snapshot();expect(after).not.toEqual(before);wiring.container=runtime.container;
  const next=await unchanged(()=>request());expect(next.data.product).toMatchObject({store_name:'独立提交的新商品名',price:'25.00',slider_image:['/owned-media/new.png']});expect(next.data.skus[0].stock).toBe(8);expect(next.data.media.description_html).toBe('<p>新详情</p>');
 }));
 it('rechecks current password role and expiry instead of accepting only middleware identity',async()=>f.withReader(async runtime=>{
  const service=new SupplierProductDetailReadService(runtime.container,f.env.APP_KEY);
  await expect(service.read({...actor,expiresAt:1},80)).rejects.toMatchObject({code:410001});
  await f.db.update(systemRole).set({rules:'supplier.order.view'}).where(eq(systemRole.id,21));wiring.container=runtime.container;
  expect((await unchanged(()=>request())).status).toBe(400011);
  await f.db.update(systemRole).set({rules:'supplier.product.view'}).where(eq(systemRole.id,21));
  await f.db.update(systemAdmin).set({pwd:'changed-password'}).where(eq(systemAdmin.id,21));expect((await unchanged(()=>request())).status).toBe(410001);
 }));
 it('does not borrow an image ID as a video or a video ID as an image after metadata changes',async()=>f.withReader(async runtime=>{
  await f.db.update(systemAttachment).set({fileType:2,attType:'video/mp4'}).where(eq(systemAttachment.attId,31));
  await f.db.update(storeProduct).set({videoLink:'/api/assets/31',image:'/api/assets/41',sliderImage:'[]'}).where(eq(storeProduct.id,80));
  wiring.container=runtime.container;const d=(await unchanged(()=>request())).data;expect(d.media.previews['/api/assets/41'].status).toBe('unavailable');expect(d.product.video_preview_url).toBe('');
 }));
 it('rejects a 501st active SKU without silently truncating or reading secret columns',async()=>f.withReader(async runtime=>{
  await f.db.insert(storeProductAttrValue).values(Array.from({length:499},(_,i)=>({id:1000+i,productId:80,type:0,suk:'附加'+i,unique:'b'+String(i).padStart(7,'0'),price:'1.00'})));
  wiring.container=runtime.container;expect((await unchanged(()=>request())).status).toBe(503);
 }));
 it('rejects a seventeenth dimension and an eleventh carousel image without partial success',async()=>f.withReader(async runtime=>{
  await f.db.insert(storeProductAttr).values(Array.from({length:16},(_,i)=>({id:100+i,productId:80,type:0,attrName:'附加'+i,attrValues:'值'})));
  wiring.container=runtime.container;expect((await unchanged(()=>request())).status).toBe(503);
  await f.exec('DELETE FROM public.store_product_attr WHERE id>=100');await f.db.update(storeProduct).set({sliderImage:JSON.stringify(Array(11).fill('/image.png'))}).where(eq(storeProduct.id,80));
  expect((await unchanged(()=>request())).status).toBe(503);
 }));
 it('rejects excessive HTML references and ambiguous descriptions without returning a shortened document',async()=>f.withReader(async runtime=>{
  await f.db.update(storeProductDescription).set({description:Array.from({length:101},(_,i)=>`<img src="/owned-media/${i}.png">`).join('')}).where(and(eq(storeProductDescription.productId,80),eq(storeProductDescription.type,0)));
  wiring.container=runtime.container;expect((await unchanged(()=>request())).status).toBe(503);
  await f.db.update(storeProductDescription).set({description:'<p>恢复</p>'}).where(and(eq(storeProductDescription.productId,80),eq(storeProductDescription.type,0)));
  // The deliberately column-only fixture does not commission the mature
  // spd_product_type_unique index. Prove ambiguity fails closed on those actual
  // composite rows; do not claim that installed production uniqueness permits it.
  await f.db.insert(storeProductDescription).values({productId:80,type:0,description:'另一原始详情'});expect((await unchanged(()=>request())).status).toBe(503);
 }));
});
