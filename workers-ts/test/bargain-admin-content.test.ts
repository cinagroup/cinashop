import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { saveBargain } from '../src/services/activity/BargainAdminService';
import { readBargainSkuOptions } from '../src/services/activity/BargainAdminSkuService';
import { BargainSkuCatalogService } from '../src/services/activity/BargainSkuCatalogService';
import { storeBargain, storeProduct, storeProductDescription } from '../src/models/schema';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { adminActivitySave } from '../src/controllers/api/v1/AdminCrudController';
import { contentForm, withBargainContent } from '../../view/admin-ts/src/api/bargainContentEdit';
import { parseBargainSelection } from '../../view/common/bargainPurchase';
import { sanitizeArticleRichText } from '../../view/common/articleRichText';

describe('bargain content admin-to-consumer contract',()=>{
 let f:Awaited<ReturnType<typeof createBargainSelectionFixture>>;
 beforeEach(async()=>{f=await createBargainSelectionFixture();f.app.post('/admin/save',adminActivitySave);},30_000);
 afterEach(async()=>{await f?.close();});
 const snapshot=async()=>({...await f.snapshot(),sequences:undefined,descriptions:await f.db.select().from(storeProductDescription).orderBy(storeProductDescription.productId,storeProductDescription.type)});
 const fields=()=>({title:'展示标题',info:'活动简介',unitName:'盒',images:['/api/qa/cover.svg','https://example.com/gallery.png'],description:'<h2>内容标题</h2><p><b>活动正文</b></p>'});
 const create=()=>({type:'bargain',productId:70,storeName:'内容活动',price:'10.00',minPrice:'2.00',people:2,stock:6,quota:5,sku:{baseUnique:'qared001'},startTime:f.startTime.toISOString(),stopTime:f.stopTime.toISOString(),...fields()});
 it('creates content and real SKU atomically and exposes it through the actual public selector and shared client parser',async()=>{
  const r=await f.app.request('/admin/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(create())},f.env);
  const result=await r.json() as {status:number;data:{id:number}};expect(result.status).toBe(200);
  const id=result.data.id,edit=await readBargainSkuOptions(f.container,'70',String(id));expect(edit.content).toMatchObject(fields());
  const response=await f.app.request(`/api/bargain/detail/${id}?view=skus`,{},f.env);expect(response.headers.get('cache-control')).toBe('private, no-store');
  const data=(await response.json() as {data:unknown}).data,selection=parseBargainSelection(data,id,0,false);
  expect(selection).toMatchObject({title:'展示标题',image:'/api/qa/cover.svg',content:{info:'活动简介',unit_name:'盒',images:fields().images,description:fields().description}});
  expect((await snapshot()).skus.filter(row=>row.type===2&&row.productId===id)).toHaveLength(1);
 });
 it('preserves unrelated state and base-product descriptions across content-only edits and explicit clearing',async()=>{
  await f.db.insert(storeProductDescription).values({productId:40,type:0,description:'原商品不可覆盖'});
  const before=await snapshot();await saveBargain(f.container,{id:40,...fields()});
  const contentSaved=await snapshot();expect(contentSaved.skus).toEqual(before.skus);expect(contentSaved.participations).toEqual(before.participations);
  await saveBargain(f.container,{id:40,storeName:'只改名称'});expect((await snapshot()).descriptions).toEqual(contentSaved.descriptions);
  await saveBargain(f.container,{id:40,title:'',info:'',unitName:'',images:[],description:''});
  expect((await readBargainSkuOptions(f.container,'70','40')).content).toEqual({title:'',info:'',unitName:'',images:[],description:''});
  expect((await snapshot()).descriptions).toContainEqual({productId:40,type:0,description:'原商品不可覆盖'});
 });
 it('canonicalizes signed attachment URLs and signs public gallery/description references at response time',async()=>{
  await saveBargain(f.container,{id:40,images:['/api/assets/123?expires=1&signature=old'],description:'<p><img src="/api/assets/123?expires=1&amp;signature=old"></p>'});
  const edit=await readBargainSkuOptions(f.container,'70','40');expect(edit.content?.images).toEqual(['/api/assets/123']);expect(edit.content?.description).not.toContain('old');
  const publicView=await new BargainSkuCatalogService(f.container,'isolated-content-signing-key-not-production').read(0,'40');
  expect(publicView.content.images[0]).toMatch(/^\/api\/assets\/123\?/);expect(publicView.image).toBe(publicView.content.images[0]);expect(publicView.content.description).toContain('signature=');
  expect((await readBargainSkuOptions(f.container,'70','40')).content).toEqual(edit.content);
 });
 it('replaces only the first gallery image for image-only legacy edits',async()=>{
  await saveBargain(f.container,{id:40,...fields()});await saveBargain(f.container,{id:40,image:'/api/qa/new.svg'});
  expect((await readBargainSkuOptions(f.container,'70','40')).content?.images).toEqual(['/api/qa/new.svg','https://example.com/gallery.png']);
 });
 it.each([{title:null},{title:'x'.repeat(256)},{info:'bad\ntext'},{unitName:'x'.repeat(17)},
  {images:'[]'},{images:Array(9).fill('/one.png')},{images:['/one.png','/one.png']},{images:['javascript:alert(1)']},
  {images:['https://user:pass@example.com/a.png']},{images:['//example.com/a.png']},{images:['/\\example.com/a.png']},
  {images:['relative.png']},{image:'/a.png',images:['/b.png']},{description:null},{description:'x'.repeat(16001)},{description:'bad\0text'}])('rejects invalid content case %# without changing business state',async patch=>{
  const before=await snapshot();await expect(saveBargain(f.container,{id:40,...patch})).rejects.toThrow();expect(await snapshot()).toEqual(before);
 });
 it('sanitizes newly submitted and historical HTML without changing the stored historical row during reads',async()=>{
  const unsafe='<script>window.bad=1</script><img src="javascript:alert(1)" onerror="alert(1)"><p onclick="bad()">正常正文</p><iframe src="https://example.com"></iframe>';
  await saveBargain(f.container,{id:40,description:unsafe});const saved=(await readBargainSkuOptions(f.container,'70','40')).content!.description;
  expect(saved).not.toMatch(/<script|<iframe|onerror|onclick|javascript:/);expect(saved).toContain('正常正文');
  await f.db.update(storeProductDescription).set({description:unsafe});const before=await snapshot();
  const view=await new BargainSkuCatalogService(f.container).read(0,'40');expect(view.content.description).not.toMatch(/<script|onerror|javascript:/);
  expect(sanitizeArticleRichText(view.content.description)).toContain('正常正文');expect(await snapshot()).toEqual(before);
 });
 it('does not expose content for a disabled activity or hidden source product',async()=>{
  await saveBargain(f.container,{id:40,...fields()});await f.db.update(storeBargain).set({status:0});
  await expect(new BargainSkuCatalogService(f.container).read(0,'40')).rejects.toThrow('不可见');
  await f.db.update(storeBargain).set({status:1});await f.db.update(storeProduct).set({isShow:0}).where(eq(storeProduct.id,70));
  await expect(new BargainSkuCatalogService(f.container).read(0,'40')).rejects.toThrow('不可见');
 });
 it('rolls back main/SKU/description writes on an actual description insert failure',async()=>{
  await f.exec(`CREATE FUNCTION qa_content_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'content failed'; END $$;
   CREATE TRIGGER qa_content_fail AFTER INSERT ON store_product_description FOR EACH ROW EXECUTE FUNCTION qa_content_fail()`);
  const before=await snapshot();await expect(saveBargain(f.container,create())).rejects.toThrow();expect(await snapshot()).toEqual(before);
 });
});

describe('actual admin content payload',()=>{
 it('never clears unread existing content and sends only deliberate differences',()=>{
  const form=contentForm({title:'原题',info:'简介',unitName:'盒',images:['/a.png'],description:'<p>原文</p>'});
  expect(withBargainContent({id:40,storeName:'改名'},form,null,false)).toEqual({id:40,storeName:'改名'});
  expect(withBargainContent({id:40},form,{...form},true)).toEqual({id:40});
  expect(withBargainContent({id:40},{...form,description:''},form,true)).toEqual({id:40,description:''});
  expect(withBargainContent({image:'/old.png'},{...form,imageLines:'/a.png\n/b.png'},null,true)).toMatchObject({images:['/a.png','/b.png']});
 });
});
