import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import type {Env} from '@/env';
import {systemAdmin,systemRole,systemAttachment,systemAttachmentCategory,storeProductLabel,storeProduct} from '@/models/schema';
import {AdminProductLabelSupportService} from '@/services/admin/AdminProductLabelSupportService';
import {publicProductLabelAuthorImages,renderProductLabelAuthorImages,assertProductLabelAuthorIconChange} from '@/services/product/ProductLabelAuthorAssetPolicy';
import {createAdminProductLabelAuthorFixture,seedProductLabelAuthors,productLabelActor} from './helpers/adminProductLabelAuthorFixture';
import {readPublicProductLabelMap,publicProductLabelIds} from '@/services/product/PublicProductLabelData';
const key='owned-product-label-key',password='product-label-fixture-password';
const raster=(id:number,patch:Partial<typeof systemAttachment.$inferInsert>={})=>({attId:id,pid:0,type:1,relationId:0,moduleType:1,fileType:1,imageType:8,attDir:`/api/assets/${id}`,sattDir:`/api/assets/${id}`,name:`attachments/admin/1/2026/10/product-label-${id}.png`,attType:'image/png',realName:`图标${id}`,...patch});

describe('product label support real restricted gallery SQL and mature public product projection',()=>{
 let f:Awaited<ReturnType<typeof createAdminProductLabelAuthorFixture>>,service:AdminProductLabelSupportService,external:ReturnType<typeof vi.fn>,bindings:Env;
 beforeAll(async()=>{f=await createAdminProductLabelAuthorFixture();service=new AdminProductLabelSupportService(f.container,{APP_KEY:key});vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Product label gallery/public read forbids provider/image I/O'));},30000);
 beforeEach(async()=>{await f.reset();await seedProductLabelAuthors(f.db);await f.db.insert(systemAdmin).values([{id:109,account:'support-supplier',pwd:password,level:0,adminType:4},{id:110,account:'support-related',pwd:password,level:0,relationId:7}]);
  // A deliberate local fixture arrangement; all subsequent reads use the real
  // restricted actor and actual policy. No caller owns an attachment URL.
  await f.db.update(systemAttachment).set(raster(1)).where(eq(systemAttachment.attId,1));
  external=vi.fn(async()=>{throw Error('No KV/R2/queue/provider use is allowed');});
  bindings={APP_KEY:key,CONFIG_KV:{get:external,put:external,delete:external},ASSETS_BUCKET:{get:external,head:external,list:external,put:external,delete:external},ORDER_QUEUE:{send:external,sendBatch:external}} as unknown as Env;service=new AdminProductLabelSupportService(f.container,bindings);
 });
 afterEach(()=>{expect(fetch).not.toHaveBeenCalled();expect(external).not.toHaveBeenCalled();});
 afterAll(async()=>{expect(fetch).not.toHaveBeenCalled();expect(external).not.toHaveBeenCalled();vi.restoreAllMocks();await f?.close();},30000);
 const options=(query='',id=101)=>f.asAdmin(()=>service.options(new URLSearchParams(query),productLabelActor(id)));
 const categories=(query='',id=101)=>f.asAdmin(()=>service.categories(new URLSearchParams(query),productLabelActor(id)));
 async function snapshot(){const result:Record<string,unknown>={};for(const table of['category','store_product_label','store_product_label_auxiliary','store_product_relation','store_product','system_admin','system_role','system_menus','system_attachment','system_attachment_category','system_log','admin_product_label_operation'])result[table]=Array.from(await f.db.execute(sql.raw(`SELECT * FROM public.${table} ORDER BY 1`)));result.sequences=Array.from(await f.db.execute(sql`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`));return result;}
 async function unchanged<T>(run:()=>Promise<T>):Promise<T>{const before=await snapshot();try{return await run();}finally{expect(await snapshot()).toEqual(before);expect(external).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();}}
 it('returns the complete scoped image categories and rejects foreign/video category selection',async()=>{
  await f.db.insert(systemAttachmentCategory).values([{id:2,type:4,relationId:7,fileType:1,name:'供应商私有'},{id:3,type:1,relationId:0,fileType:2,name:'视频'},{id:4,type:1,relationId:9,fileType:1,name:'错误关联'}]);
  const result=await unchanged(()=>categories());expect(result.list.map(row=>row.id)).toEqual([1]);for(const pid of[2,3,4,999])await unchanged(async()=>expect(options('pid='+pid)).rejects.toThrow(/分类/));
 });
 it('authorizes every eligible source row before20+1 pagination and exposes only stable refs plus tickets',async()=>{
  await f.db.delete(systemAttachment);await f.db.insert(systemAttachment).values(Array.from({length:21},(_,i)=>raster(100+i,{realName:`完整图标${i+1}`})));
  const first=await unchanged(()=>options()),second=await unchanged(()=>options('page=2&limit=20'));
  expect(first).toMatchObject({count:21,page:1,limit:20});expect(first.list).toHaveLength(20);expect(first.list.map(row=>row.att_id)).toEqual(Array.from({length:20},(_,i)=>120-i));expect(second).toMatchObject({count:21,page:2,limit:20});expect(second.list.map(row=>row.att_id)).toEqual([100]);
  expect(Object.keys(second.list[0]!).sort()).toEqual(['att_id','pid','real_name','reference','preview'].sort());expect(second.list[0]!.reference).toBe('/api/assets/100');expect(second.list[0]!.preview).toMatch(/^\/api\/assets\/100\?expires=\d{10}&signature=[A-Za-z0-9_-]{43}$/u);expect(JSON.stringify(first)).not.toContain('attachments/');
 });
 it('performs literal full-category name filtering before pagination and retains complete Unicode filenames',async()=>{
  const full='🧭'.repeat(80);await f.db.insert(systemAttachment).values([raster(10,{realName:full}),raster(11,{realName:'literal%_icon'}),raster(12,{realName:'ordinary'}),raster(13,{pid:1,realName:'分类图标'})]);
  expect((await unchanged(()=>options('name='+encodeURIComponent(full)))).list.map(row=>row.att_id)).toEqual([10]);expect((await unchanged(()=>options('name='+encodeURIComponent('%_')))).list.map(row=>row.att_id)).toEqual([11]);expect((await unchanged(()=>options('pid=1'))).list.map(row=>row.att_id)).toEqual([13]);
 });
 it.each([0,102,103,109,110])('denies gallery reads for guest/view-only/wrong or foreign actor%d without writes',async id=>{await unchanged(async()=>{await expect(categories('',id)).rejects.toThrow();await expect(options('',id)).rejects.toThrow();});});
 it('rechecks current grants/password/deadline and does not accept a missing role as management',async()=>{
  await unchanged(async()=>{await expect(f.asAdmin(()=>service.options(new URLSearchParams(),{...productLabelActor(),authVersion:'a'.repeat(32)}))).rejects.toThrow();await expect(f.asAdmin(()=>service.categories(new URLSearchParams(),{...productLabelActor(),expiresAt:1}))).rejects.toThrow();});
  await f.db.update(systemRole).set({rules:'label.view'}).where(eq(systemRole.id,1));await unchanged(async()=>expect(options()).rejects.toThrow());
  await f.db.update(systemRole).set({rules:'label.manage'}).where(eq(systemRole.id,1));await f.db.update(systemAdmin).set({roles:'999'}).where(eq(systemAdmin.id,101));await unchanged(async()=>expect(options()).rejects.toThrow());
 });
 it.each(['page=0','page=5001','page=01','page=1&page=2','limit=0','limit=101','limit=1e1','pid=-1','pid=01','pid=1&pid=2','name=%00','scope=supplier','url=https://evil.example','key=attacker'])('refuses malformed or unauthorized option query%s without I/O or writes',async query=>{await unchanged(async()=>expect(options(query)).rejects.toThrow());});
 it('refuses over80Unicode or DEL names and all category query injection without truncation',async()=>{
  for(const query of['name='+encodeURIComponent('🧭'.repeat(81)),'name='+encodeURIComponent('a\u007fb')])await unchanged(async()=>expect(options(query)).rejects.toThrow());
  for(const query of['pid=0','url=https://evil.example','scope=user&scope=platform'])await unchanged(async()=>expect(categories(query)).rejects.toThrow());
 });
 const invalidMetadata:[string,Partial<typeof systemAttachment.$inferInsert>][]=[
  ['supplier realm',{type:4,relationId:7,name:'attachments/supplier/7/private.png'}],['user realm',{type:3,relationId:7,moduleType:3,name:'attachments/user/7/private.png'}],['foreign platform relation',{relationId:7}],['wrong module',{moduleType:3}],['video file',{fileType:2}],['non R2 image',{imageType:1}],['noncanonical exact path',{attDir:'/api/assets/2'}],['old ticket in persisted path',{attDir:'/api/assets/1?expires=1&signature=old'}],['wrong admin folder',{name:'attachments/admin/2/private.png'}],['parent traversal',{name:'attachments/admin/1/../private.png'}],['backslash key',{name:'attachments/admin/1/private\\bad.png'}],['executable MIME',{attType:'text/html'}],['MIME extension mismatch',{attType:'image/jpeg'}],['SVG object',{name:'attachments/admin/1/image.svg',attType:'image/svg+xml'}],
 ];
 it.each(invalidMetadata)('does not authorize %s canonical raster metadata in gallery or changed author input',async(_name,patch)=>{
  await f.db.update(systemAttachment).set(patch).where(eq(systemAttachment.attId,1));
  await unchanged(async()=>{expect((await options()).list.some(row=>row.att_id===1)).toBe(false);expect(await f.asAdmin(()=>publicProductLabelAuthorImages(f.db,['/api/assets/1']))).toEqual(['']);await expect(f.asAdmin(()=>assertProductLabelAuthorIconChange(f.db,null,'/api/assets/1'))).rejects.toThrow();});
 });
 it('retains the established empty MIME legacy raster allowance but never widens to nonraster files',async()=>{
  await f.db.update(systemAttachment).set({attType:''}).where(eq(systemAttachment.attId,1));const result=await unchanged(()=>options());expect(result.list.find(row=>row.att_id===1)!.preview).toMatch(/^\/api\/assets\/1\?expires=\d{10}&signature=[A-Za-z0-9_-]{43}$/u);
 });
 it('does not acquire attachment metadata write authority while reading a dedicated gallery',async()=>{
  await unchanged(()=>options());await expect(f.asAdmin(()=>f.exec("UPDATE public.system_attachment SET real_name='forbidden' WHERE att_id=1"))).rejects.toMatchObject({code:'42501'});await expect(f.asAdmin(()=>f.exec("UPDATE public.system_attachment_category SET name='forbidden' WHERE id=1"))).rejects.toMatchObject({code:'42501'});
 });
 it('accepts exactly5000 source images then refuses5001 before a no-match filter or one-row page',async()=>{
  await f.db.delete(systemAttachment);for(let start=100;start<5100;start+=250)await f.db.insert(systemAttachment).values(Array.from({length:Math.min(250,5100-start)},(_,i)=>raster(start+i)));
  expect((await unchanged(()=>options('limit=1&name=not-present'))).count).toBe(0);await f.db.insert(systemAttachment).values(raster(5100));await unchanged(async()=>expect(options('limit=1&name=not-present')).rejects.toThrow(/5000/));
 },30000);
 it('refuses an actual over5000 category directory without exposing a prefix as complete',async()=>{
  await f.db.delete(systemAttachmentCategory);for(let start=100;start<5101;start+=250)await f.db.insert(systemAttachmentCategory).values(Array.from({length:Math.min(250,5101-start)},(_,i)=>({id:start+i,type:1,relationId:0,fileType:1,name:`分类${start+i}`})));
  await unchanged(async()=>expect(categories()).rejects.toThrow(/5000/));
 },30000);
 it('preserves mature public label order and visibility and signs only current persisted owner metadata',async()=>{
  await f.db.update(storeProductLabel).set({labelName:'🧭'.repeat(255),styleType:2,icon:'/api/assets/1',status:1,isShow:1}).where(eq(storeProductLabel.id,10));
  await f.db.update(storeProductLabel).set({styleType:2,icon:'/api/assets/2',status:1,isShow:1}).where(eq(storeProductLabel.id,11));
  await f.db.update(storeProductLabel).set({status:0,isShow:1}).where(eq(storeProductLabel.id,12));
  await f.db.insert(storeProduct).values({id:800,storeName:'实际持久化标签引用',storeLabelId:'10,11,12,10'});
  await unchanged(()=>f.asApp(async()=>{const [product]=await f.db.select({csv:storeProduct.storeLabelId}).from(storeProduct).where(eq(storeProduct.id,800));const ids=publicProductLabelIds(product!.csv);expect(ids).toEqual([10,11,12]);const labels=await readPublicProductLabelMap(f.db,key,ids);expect([...labels.keys()].sort((a,b)=>a-b)).toEqual([10,11]);expect(labels.get(10)!.icon).toMatch(/^\/api\/assets\/1\?expires=\d{10}&signature=[A-Za-z0-9_-]{43}$/u);expect([...labels.get(10)!.label_name]).toHaveLength(255);expect(labels.get(11)!.icon).toBe('');for(const label of labels.values()){expect(Object.keys(label).sort()).toEqual(['id','label_name','style_type','color','bg_color','border_color','icon'].sort());}}));
  expect((await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.id,10)))[0]!.icon).toBe('/api/assets/1');
 });
 it('keeps both status switches authoritative for public cards without translating raw historical flags',async()=>{
  for(const[status,isShow,present]of[[1,1,true],[0,1,false],[1,0,false],[7,5,false]]as const){await f.db.update(storeProductLabel).set({status,isShow}).where(eq(storeProductLabel.id,10));await unchanged(()=>f.asApp(async()=>expect((await readPublicProductLabelMap(f.db,key,[10])).has(10)).toBe(present)));}
 });
 it.each([['/static/legacy.png','/static/legacy.png'],['https://cdn.example.test/legacy.png','https://cdn.example.test/legacy.png'],['http://legacy.example/icon.png','']] as const)('mature consumer keeps stable business icon%s projected as%s without fetching or rewriting raw',async(stored,safe)=>{
  await f.db.update(storeProductLabel).set({icon:stored,status:1,isShow:1}).where(eq(storeProductLabel.id,10));await unchanged(()=>f.asApp(async()=>expect((await readPublicProductLabelMap(f.db,key,[10])).get(10)!.icon).toBe(safe)));expect((await f.db.select().from(storeProductLabel).where(eq(storeProductLabel.id,10)))[0]!.icon).toBe(stored);
 });
 it('does not accept caller-selected image owners or a signed URL as changed author input',async()=>{
  await unchanged(()=>f.asAdmin(async()=>{expect(await publicProductLabelAuthorImages(f.db,['/api/assets/1','/api/assets/2','/static/ok.png','https://cdn.example.test/i.png','http://legacy/i.png'])).toEqual(['/api/assets/1','','/static/ok.png','https://cdn.example.test/i.png','']);await expect(assertProductLabelAuthorIconChange(f.db,null,'/api/assets/1?expires=1999999999&signature='+ 'a'.repeat(43))).rejects.toThrow();}));
  const signed=await renderProductLabelAuthorImages(key,['/api/assets/1','/static/ok.png']);expect(signed[0]).toMatch(/^\/api\/assets\/1\?expires=\d{10}&signature=[A-Za-z0-9_-]{43}$/u);expect(signed[1]).toBe('/static/ok.png');
 });
 it('keeps historical invalid raw icons outside the gallery while identical raw preservation grants no attachment authority',async()=>{
  await unchanged(()=>f.asAdmin(async()=>{expect(await publicProductLabelAuthorImages(f.db,['http://legacy/icon.png','javascript:old','/adminapi/private','/api/assets/2'])).toEqual(['','','','']);await expect(assertProductLabelAuthorIconChange(f.db,'http://legacy/icon.png','http://legacy/icon.png')).resolves.toBeUndefined();await expect(assertProductLabelAuthorIconChange(f.db,'/api/assets/2','/api/assets/2')).resolves.toBeUndefined();}));
 });
});
