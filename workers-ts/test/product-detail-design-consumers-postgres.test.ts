import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {createHmac} from 'node:crypto';
import {createContainerFromDb} from '../src/lib/di';
import {systemDise,storeProduct,storeProductDescription,community,storeProductReply,systemAttachment} from '../src/models/schema';
import {StoreProductService} from '../src/services/product/StoreProductService';
import {PublicCatalogService} from '../src/services/product/PublicCatalogService';
import {V2PublicCompatibilityService} from '../src/services/content/V2PublicCompatibilityService';
import {readActivityDetailDesign,readProductCommunity} from '../src/services/product/ProductDetailDesignData';
import {IntegralProductReadService} from '../src/services/activity/IntegralProductReadService';
import {ActivityService} from '../src/services/activity/ActivityService';
import {StoreNewcomerService} from '../src/services/activity/StoreNewcomerService';
import {productDetailDesignFixture} from './helpers/productDetailDesignFixture';
import {observeCategoryDb} from './helpers/productCategoryStyleFixture';
import {cloneProductDetailDesign} from '../../view/common/productDetailDesign';
import {Hono} from 'hono';
import type {AppVariables,Env} from '../src/env';
import {SeckillSkuCatalogService} from '../src/services/activity/SeckillSkuCatalogService';
import {CombinationSkuCatalogService} from '../src/services/activity/CombinationSkuCatalogService';
import {PresaleSkuCatalogService} from '../src/services/activity/PresaleSkuCatalogService';
import {seckillDetail,combinationDetail} from '../src/controllers/api/v1/UserActivityController';
import {detail as productDetail} from '../src/controllers/api/v1/ProductController';
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native full product detail design consumers',()=>{
  let f:Awaited<ReturnType<typeof productDetailDesignFixture>>,guard:ReturnType<typeof vi.spyOn>;
  beforeEach(async()=>{f=await productDetailDesignFixture();guard=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No public detail network'));},30000);
  afterEach(async()=>{try{expect(guard).not.toHaveBeenCalled();}finally{guard?.mockRestore();await f?.close();}},30000);
  const read=(db:any=f.db)=>new StoreProductService(createContainerFromDb(db),f.env);
  const design=async(change:Record<string,unknown>)=>f.db.update(systemDise).set({value:JSON.stringify({...cloneProductDetailDesign(),...change,opaque:{private:'PRIVATE EXTENSION'}})}).where(eq(systemDise.id,5));
  const app=(run:(peer:any)=>Promise<void>)=>f.withRuntimeRole(async peer=>{await f.installSelectSlice(peer,'app');await run(peer);});
  it('returns real bounded reply/community counts, safe body/assets/ensures/specs and rank with no private SKU/extension leakage',async()=>{await app(async peer=>{const before=await f.snapshot(),result=await read(peer.db).getProductDetail(70,11);expect(result.product_detail_design).toMatchObject({configured:true,value:{isOpen:[3,4,5,1,2,0]}});expect(result.reply).toHaveLength(2);expect(result).toMatchObject({replyCount:2,replyChance:50,elegant_count:2});expect(result.elegant_list).toHaveLength(2);expect(result.ensure).toHaveLength(1);expect(result.specs).toEqual([{name:'材质',value:'棉',sort:1}]);expect(result.rank).toBeGreaterThan(0);expect(result.description).toMatch(/\/api\/assets\/41\?/);expect(String(result.description)).not.toMatch(/assets\/43|onerror|<script/);expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|"cost"|settle_price|disk_info|bar_code|brokerage/);expect(await f.snapshot()).toEqual(before);
    for(const [reference,allowed] of[['/api/assets/111?expires=1&signature=old',true],['/api/assets/112',false],['/api/assets/113',false],['/a/../api/assets/111',false]] as const){await f.db.update(storeProduct).set({videoLink:reference}).where(eq(storeProduct.id,70));const detail=await read(peer.db).getProductDetail(70,11);if(allowed)expect(detail.videoLink).toMatch(/^\/api\/assets\/111\?expires=\d+&signature=/);else expect(detail.videoLink).toBe('');}
  });});
  it('applies every read switch and exact count while leaving safe publication and cart qualification unchanged',async()=>{await app(async peer=>{await design({showReply:1,replyNum:1,showCommunity:1,communityNum:1,showMatch:1,matchNum:1,showRecommend:1,recommendNum:1});let result=await read(peer.db).getProductDetail(70,11);expect(result.reply).toHaveLength(1);expect(result.elegant_list).toHaveLength(1);expect(result.discounts_products).toHaveLength(1);expect(result.recommend).toHaveLength(1);expect(result.cart_button).toBe(1);await design({showReply:0,showCommunity:0,showMatch:0,showRecommend:0,showRank:0,showService:[],showCart:0});result=await read(peer.db).getProductDetail(70,11);expect(result).toMatchObject({reply:[],replyCount:0,replyChance:0,elegant_list:[],elegant_count:0,ensure:[],specs:[],rank:0,recommend:[],discounts_products:[],cart_button:1});});});
  it('renders published UID0 platform review media in ordinary/activity detail while preserving genuine customer ownership and excluding foreign fake tuples',async()=>{
    await design({showReply:1,replyNum:10});
    await f.db.insert(systemAttachment).values({attId:250,type:3,relationId:11,moduleType:3,fileType:1,imageType:8,
      name:'attachments/user/11/2026/10/customer.png',attDir:'/api/assets/250',sattDir:'/api/assets/250',attType:'image/png'});
    await f.db.insert(storeProductReply).values([
      {id:201,productId:70,uid:0,type:0,relationId:0,nickname:'平台自评',comment:'已授权平台媒体',avatar:'/api/assets/41',pics:'["/api/assets/41"]',status:1,isDel:0,addTime:9},
      {id:202,productId:70,uid:0,type:2,relationId:88,nickname:'外属自评',comment:'外属tuple不能签平台素材',avatar:'/api/assets/41',pics:'["/api/assets/41","/api/assets/42"]',status:1,isDel:0,addTime:8},
      {id:203,productId:70,uid:0,type:0,relationId:0,nickname:'伪素材自评',comment:'UID0不能签顾客私有素材',avatar:'/api/assets/250',pics:'["/api/assets/250"]',status:1,isDel:0,addTime:7},
    ]);
    await f.db.update(storeProductReply).set({avatar:'/api/assets/250',pics:'["/api/assets/250","/api/assets/41"]'}).where(eq(storeProductReply.id,101));
    await app(async peer=>{
      const before=await f.snapshot();
      const ordinary=await read(peer.db).getProductDetail(70,11);
      const combination=await new ActivityService(createContainerFromDb(peer.db),f.env).combinationDetail(401);
      const seckill=await new SeckillSkuCatalogService(createContainerFromDb(peer.db),f.env).read(11,'601');
      for(const detail of[ordinary,combination,seckill]){
        const replies=detail.reply as Array<{id:number;avatar:string;pics:string[]}>;
        expect(replies).toHaveLength(5);
        const platform=replies.find(row=>row.id===201)!;
        expect(platform.avatar).toMatch(/^\/api\/assets\/41\?expires=\d+&signature=/);
        expect(platform.pics).toEqual([platform.avatar]);
        for(const id of[202,203])expect(replies.find(row=>row.id===id)).toMatchObject({avatar:'',pics:[]});
        const customer=replies.find(row=>row.id===101)!;
        expect(customer.avatar).toMatch(/^\/api\/assets\/250\?expires=\d+&signature=/);
        expect(customer.pics).toEqual([customer.avatar]);
      }
      expect(await f.snapshot()).toEqual(before);
    });
  });
  it('changes each selected SKU display offer without changing actual member price or authoritative purchase qualification',async()=>{await app(async peer=>{for(const [showPrice,expected] of [[[],'20.00'],[[0],'17.60'],[[1],'18.00'],[[0,1],'17.60']] as const){await design({showPrice:[...showPrice]});const result=await read(peer.db).getProductDetail(70,11),skus=result.attr_value as any[];expect(skus[0].display_price.price).toBe(expected);expect(skus[0]).toMatchObject({price:'20.00',member_price:'17.60',price_type:'level',stock:8,purchasable:true});expect(skus[1]).toMatchObject({price:'30.00',member_price:'26.40',stock:3});}});});
  it('uses one real RR snapshot across config, body and counts despite a committed peer edit, then exposes the new request',async()=>{await app(async peer=>{await f.withPeer(async writer=>{let switched=false;const db=observeCategoryDb(peer.db,async(_tx,command)=>{if(!switched&&command.includes('system_dise')){switched=true;await writer.db.update(systemDise).set({value:JSON.stringify({...cloneProductDetailDesign(),showReply:0,showCommunity:0})}).where(eq(systemDise.id,5));await writer.db.update(storeProductDescription).set({description:'NEW PEER BODY'}).where(eq(storeProductDescription.productId,70));}});const old=await read(db).getProductDetail(70,11);expect(switched).toBe(true);expect(old.replyCount).toBe(2);expect(old.elegant_count).toBe(2);expect(String(old.description)).toContain('公开正文');const fresh=await read(peer.db).getProductDetail(70,11);expect(fresh.replyCount).toBe(0);expect(fresh.elegant_count).toBe(0);expect(fresh.description).toBe('NEW PEER BODY');});});});
  it('shares the named nineteen-key public authority, protects opaque values, and keeps site origin out of SQL/API fallbacks',async()=>{await app(async peer=>{const publicService=new V2PublicCompatibilityService(createContainerFromDb(peer.db),f.env),raw=await publicService.diy(' product_detail '),page=await publicService.productDetail();expect(Object.keys(raw as object)).toHaveLength(19);expect(JSON.stringify(raw)).not.toContain('opaque');expect(page.product_detail).toEqual(raw);expect(page.product_detail_design_state).toMatchObject({configured:true,issues:[]});const detail=await read(peer.db).getProductDetail(70,0);expect(detail.site_url).toBe('https://shop.example.com');expect(JSON.stringify(detail)).not.toContain('wrong-api');});});
  it('keeps activity inverse specs and its actual reply/ensure subset, including real combination and integral entries',async()=>{await app(async peer=>{await design({showService:[2,3],showReply:0});const ordinary=await read(peer.db).getProductDetail(70,0),activity=await readActivityDetailDesign(peer.db,{id:9,productId:70,specs:'[{"name":"活动参数","value":"活动"}]'},1,0),integral=await new IntegralProductReadService(createContainerFromDb(peer.db),f.env).read(9),combination=await new ActivityService(createContainerFromDb(peer.db),f.env).combinationDetail(401);expect(ordinary.specs).toHaveLength(1);expect(activity.specs).toEqual([]);expect(activity.reply).toEqual([]);expect(combination.specs).toEqual([]);expect(combination.product_detail_design.value.showService).toEqual([2,3]);expect(integral.storeInfo.specs).toEqual([]);await design({showService:[2],showReply:1,replyNum:1});const projected=await new ActivityService(createContainerFromDb(peer.db),f.env).combinationDetail(401);expect(projected.specs).toHaveLength(1);expect(projected.reply).toHaveLength(1);expect(projected.ensure).toHaveLength(1);expect(projected.image).toMatch(/^\/api\/assets\/41\?/);
    const newcomer=await new StoreNewcomerService(createContainerFromDb(peer.db),f.env).detail(0,701);expect(newcomer.product_detail_design).toMatchObject({value:{showService:[2]}});expect((newcomer.storeInfo as any).specs).toHaveLength(1);expect((newcomer.storeInfo as any).attr_value[0]).toMatchObject({image:'',price:'9.00'});expect(JSON.stringify(newcomer)).not.toMatch(/PRIVATE|"cost"|disk_info|bar_code|brokerage/);
  });});
  it('pages only exact published product relations, deduplicates links, and rejects hidden parents or malformed pagination',async()=>{await app(async peer=>{expect(await readProductCommunity(peer.db,70,1,1)).toMatchObject({list:[{id:201}],count:2});expect(await readProductCommunity(peer.db,70,2,1)).toMatchObject({list:[{id:202}],count:2});for(const args of[[0,10],[1,101],[10002,1]])await expect(readProductCommunity(peer.db,70,args[0],args[1])).rejects.toThrow();await f.db.update(community).set({isDel:1}).where(eq(community.id,201));expect((await readProductCommunity(peer.db,70)).count).toBe(1);await f.db.update(storeProduct).set({isShow:0}).where(eq(storeProduct.id,70));await expect(readProductCommunity(peer.db,70)).rejects.toThrow();});});
  it('uses the same design counts for existing recommendation/body/marketing public entry points and never exports unsafe raw extensions',async()=>{await app(async peer=>{await design({showRecommend:0,showMatch:0,showService:[]});const service=new PublicCatalogService(createContainerFromDb(peer.db),f.env);expect(await service.detailRecommend(11,70)).toEqual([]);expect((await service.detailContent(70)).description).toContain('/api/assets/41?');expect((await service.productActivity(70)).discounts_products).toEqual([]);await design({showMatch:1,matchNum:1});expect((await service.productActivity(70)).discounts_products).toHaveLength(1);});});
  it('serves the actual three selection HTTP readers through SELECT-only LOGIN with signed media, exact display switches and unchanged financial SKU identity',async()=>{await app(async peer=>{
    const now=Math.floor(Date.now()/1000);await f.db.update(storeProduct).set({isPresaleProduct:1,presaleStartTime:now-60,presaleEndTime:now+3600,presaleDay:7}).where(eq(storeProduct.id,70));
    await design({showService:[2,3],showReply:1,replyNum:1});
    const http=new Hono<{Bindings:Env;Variables:AppVariables}>();http.use('*',async(c,next)=>{c.set('container',createContainerFromDb(peer.db));c.set('uid',11);await next();});
    http.get('/api/seckill/detail/:id',seckillDetail);http.get('/api/combination/detail/:id',combinationDetail);http.get('/api/product/detail/:id',productDetail);
    const before=await f.snapshot();
    for(const [url,type,price,unique] of[['/api/seckill/detail/601?view=skus',1,'8.25','seck0601'],['/api/combination/detail/401?view=skus',3,'15.00','comb0401'],['/api/product/detail/70?view=presale',6,'20.00','base0070']] as const){
      const response=await http.request(url,undefined,f.env),body=await response.json() as {status:number;data:any};expect(body.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');const value=body.data;
      expect(value).toMatchObject({type,product_id:70,product_detail_design:{value:{showService:[2,3]}},replyCount:2,replyChance:50});
      expect(value.reply).toHaveLength(1);expect(value.ensure).toHaveLength(1);expect(value.specs).toHaveLength(type===6?1:0);expect(value.image).toMatch(/^\/api\/assets\/41\?expires=\d+&signature=/);
      expect(value.skus[0]).toMatchObject({unique,catalog_price:price,base_unique:'base0070'});expect(value.skus[0].image).toMatch(/^\/api\/assets\/41\?/);
      expect(JSON.stringify(value)).not.toMatch(/PRIVATE|"cost"|brokerage|diskInfo|opaque|assets\/43/);expect(value.description).toContain('/api/assets/41?');
    }
    expect(await f.snapshot()).toEqual(before);
    await design({showService:[2],showReply:0});const selected=await new CombinationSkuCatalogService(createContainerFromDb(peer.db),f.env).read(11,'401');expect(selected.specs).toHaveLength(1);expect(selected).toMatchObject({reply:[],replyCount:0,replyChance:0});
    const presale=await new PresaleSkuCatalogService(createContainerFromDb(peer.db),f.env).read(11,'70');expect(presale.specs).toEqual([]);expect(presale.skus[0].catalog_price).toBe('20.00');
  });});
  it('keeps the selection design and activity body in the same RR snapshot across a committed peer edit without financial mutation',async()=>{await app(async peer=>{await f.withPeer(async writer=>{
    await design({showService:[2],showReply:1,replyNum:1});const before=await f.snapshot();let switched=false;
    const observed=observeCategoryDb(peer.db,async(_tx,command)=>{if(!switched&&command.includes('store_seckill')){switched=true;await writer.db.update(systemDise).set({value:JSON.stringify({...cloneProductDetailDesign(),showReply:0,showService:[3]})}).where(eq(systemDise.id,5));await writer.db.update(storeProductDescription).set({description:'NEW SECKILL PEER BODY'}).where(eq(storeProductDescription.productId,601));}});
    const old=await new SeckillSkuCatalogService(createContainerFromDb(observed),f.env).read(11,'601');expect(switched).toBe(true);expect(old.replyCount).toBe(2);expect(old.specs).toHaveLength(1);expect(old.description).toContain('秒杀公开正文');
    const fresh=await new SeckillSkuCatalogService(createContainerFromDb(peer.db),f.env).read(11,'601');expect(fresh).toMatchObject({replyCount:0,reply:[],specs:[],description:'NEW SECKILL PEER BODY'});
    // Each response signs the persisted asset again. Compare all SKU fields and
    // the same asset identity, while independently checking both real signatures.
    const financialSkus=<T extends {image:string}>(rows:readonly T[])=>rows.map(row=>{
      if(row.image==='')return row;
      const image=new URL(row.image,'https://fixture.invalid');
      expect(image.origin).toBe('https://fixture.invalid');expect(image.pathname).toMatch(/^\/api\/assets\/[1-9]\d*$/);
      expect([...image.searchParams.keys()].sort()).toEqual(['expires','signature']);
      const expires=Number(image.searchParams.get('expires'));expect(Number.isSafeInteger(expires)).toBe(true);
      expect(expires).toBeGreaterThanOrEqual(Math.floor(Date.now()/1000));
      expect(image.searchParams.get('signature')).toBe(createHmac('sha256',f.env.APP_KEY)
        .update(`GET\n${image.pathname}\n${expires}`).digest('base64url'));
      return {...row,image:image.pathname};
    });
    expect(financialSkus(fresh.skus)).toEqual(financialSkus(old.skus));
    const after=await f.snapshot();for(const key of Object.keys(before))if(!['system_dise','store_product_description'].includes(key))expect(after[key as keyof typeof after]).toEqual(before[key as keyof typeof before]);
  });});});
});

// Out authoring and both existing detail consumers share this real PG16 fixture.
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProductAttrValue, storeProductCategory, storeProductRelation, outProductWriteReplay, systemSupplier } from '@/models/schema';
import { productCreate, productInfo, productUpdate } from '@/controllers/out/OutApiController';
import { normalizeOutPhysicalProductInput } from '@/services/out/OutProductService';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { readDetailRecommendations } from '@/services/product/ProductDetailDesignData';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { completePurchaseOriginEvidenceOrm } from '@/migrations/runPurchaseOriginEvidence';
import { completePurchaseCancellationEvidenceOrm } from '@/migrations/runPurchaseCancellationEvidence';
import { runtimeBusinessPrivilegePlan } from '@/migrations/runtimeBusinessPrivilegePlan';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Out recommendations and ordinary detail consumer on owned PG16', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let owned: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let network: ReturnType<typeof vi.spyOn>;
  const body = { product_type: 0, supplier_id: 0, cate_id: [9], store_name: 'Out recommendation product',
    slider_image: ['/isolated.png'], delivery_type: [1], freight: 3, temp_id: 10, spec_type: 1, is_show: 1,
    items: [{ value: '颜色', detail: ['红色'] }, { value: '尺码', detail: ['大号'] }],
    attrs: [{ suk: '红色,大号', detail: { 颜色: '红色', 尺码: '大号' }, unique: 'qared001', price: '10.00', stock: 999, bar_code: 'OUT-A' }] };
  const app = (db: DbClient) => {
    const a = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    a.use('*', async (c, next) => { c.set('container', createContainerFromDb(db));
      c.set('outInfo', { id: 7, appid: 'isolated-out-recommendations', title: 'isolated', rules: [] }); await next(); });
    a.onError((e, c) => c.json({ status: 400, msg: e.message, data: null }));
    a.post('/outapi/product', productCreate); a.put('/outapi/product/:id', productUpdate); a.get('/outapi/product/:id', productInfo);
    return a;
  };
  beforeEach(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Out recommendation acceptance forbids external I/O'));
    f = await createPcCheckoutQuoteFixture([], async () => {
      owned = await sequenceRunnerDatabase();
      try { const api = await import('drizzle-kit/api'), schema = await import('@/models/schema');
        await owned.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
        await completePurchaseOriginEvidenceOrm(owned.db); await completePurchaseCancellationEvidenceOrm(owned.db); return owned;
      } catch (error) { await owned.close(); throw error; }
    });
    await f.db.insert(storeProductCategory).values({ id: 9, cateName: 'isolated', isShow: 1 });
    await f.db.update(storeProduct).set({ cateId: '9', specType: 1 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ barCode: 'OUT-A' }).where(eq(storeProductAttrValue.id, 1));
    await f.db.insert(storeProductRelation).values({ productId: 70, relationId: 9, type: 1, status: 1 });
    await f.db.insert(systemSupplier).values({ id: 88, adminId: 88, supplierName: 'public supplier' });
    await f.db.insert(storeProduct).values([
      { id: 71, storeName: 'public platform', image: '/71.png', isShow: 1, isVerify: 1, sort: 2 },
      { id: 72, storeName: 'member only', image: '/72.png', isShow: 1, isVerify: 1, isVipProduct: 1, sort: 6 },
      { id: 73, storeName: 'hidden platform', image: '/73.png', isShow: 0, isVerify: 1 },
      { id: 74, storeName: 'public supplier product', image: '/74.png', isShow: 1, isVerify: 1, type: 2, relationId: 88, sort: 4 },
      { id: 75, storeName: 'fallback recommendation', image: '/75.png', isShow: 1, isVerify: 1, isGood: 1 },
    ]);
  }, 120_000);
  afterEach(async () => { try { expect(network).not.toHaveBeenCalled(); } finally { network?.mockRestore(); await f?.close(); } }, 120_000);
  const request = async (db: DbClient, data?: object, key = crypto.randomUUID(), path = '/outapi/product/70', method = 'PUT') => {
    const response = await app(db).request(path, { method, headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
      ...(data ? { body: JSON.stringify(data) } : {}) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: any }>;
  };
  const state = async () => ({ ...await f.snapshot(), replays: await f.db.select().from(outProductWriteReplay), relations: await f.db.select().from(storeProductRelation) });
  const references = [71, 74, 999, 71, 72, 73];

  it('saves and replays the ordered legacy references while both real readers enforce their own visibility', async () => {
    const key = crypto.randomUUID(), data = { ...body, recommend: ['is_hot'], recommend_list: references };
    const result = await request(f.db, data, key); expect(result.status, result.msg).toBe(200);
    const [row] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70));
    expect(row.recommendList).toBe('71,74,999,71,72,73'); expect(row.isHot).toBe(0);
    const detail = await request(f.db, undefined, crypto.randomUUID(), '/outapi/product/70', 'GET');
    expect(detail.status, detail.msg).toBe(200);
    const rows = detail.data.productInfo.recommend_list as Array<{ product_id: string; image: string }>;
    expect(rows.map(row => row.product_id)).toEqual(references.map(String));
    expect(rows[0].image).toBe('/71.png'); expect(rows[1].image).toBe(''); expect(rows[2].image).toBe('');
    expect((await readDetailRecommendations(f.db, row, 100, false)).map(item => item.id)).toEqual([74, 71]);
    expect((await readDetailRecommendations(f.db, row, 100, true)).map(item => item.id)).toEqual([72, 74, 71]);
    const saved = await state(); expect((await request(f.db, data, key)).data.idempotent).toBe(true); expect(await state()).toEqual(saved);
    const omitted = await request(f.db, body); expect(omitted.status, omitted.msg).toBe(200);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0].recommendList).toBe(row.recommendList);
    const cleared = await request(f.db, { ...body, recommend_list: [] }); expect(cleared.status, cleared.msg).toBe(200);
    const [empty] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)); expect(empty.recommendList).toBe('');
    expect((await readDetailRecommendations(f.db, empty, 100, false)).map(item => item.id)).toEqual([75]);
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product','id'),75,true); SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),1,true)");
    const created = await request(f.db, { ...body, recommend_list: [999, 71, 999] }, crypto.randomUUID(), '/outapi/product', 'POST');
    expect(created.status, created.msg).toBe(200);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, created.data.id)))[0].recommendList).toBe('999,71,999');
  }, 30_000);

  it('rejects old ignored-empty receipts and rolls back receipt and product on deferred mutation', async () => {
    await f.db.update(storeProduct).set({ recommendList: '71,999' }).where(eq(storeProduct.id, 70));
    const key = crypto.randomUUID(), old = normalizeOutPhysicalProductInput(body);
    const hash = await outRequestHash({ operation: 'product_update', productId: 70, input: old });
    await f.db.insert(outProductWriteReplay).values({ outAccountId: 7, operation: 'product_update', requestKey: key, requestHash: hash, productId: 70 });
    const before = await state(), conflict = await request(f.db, { ...body, recommend_list: [] }, key);
    expect(conflict.status).not.toBe(200); expect(await state()).toEqual(before);
    for (const mutation of ["recommend_list='72'", 'recommend_list=recommend_list']) {
      await f.exec(`CREATE FUNCTION test_out_recommendation_damage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product SET ${mutation} WHERE id=70; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER test_out_recommendation_damage AFTER INSERT ON out_product_write_replay DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_out_recommendation_damage()`);
      const failed = await request(f.db, { ...body, recommend_list: [71, 74] });
      expect(failed.status).not.toBe(200); expect(await state()).toEqual(before);
      await f.exec('DROP TRIGGER test_out_recommendation_damage ON out_product_write_replay; DROP FUNCTION test_out_recommendation_damage()');
    }
  }, 30_000);

  it('writes and reads with existing restricted App privileges', async () => {
    if (!owned.withRuntimeRole) throw Error('Native restricted LOGIN required');
    await owned.withRuntimeRole(async runtime => {
      const plan = runtimeBusinessPrivilegePlan('app'), quote = (name: string) => {
        if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw Error('Invalid owned grant identifier'); return `"${name}"`;
      };
      const tables = await f.db.execute<{ name: string }>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname`);
      for (const { name } of tables) { const rights = plan.tables[name]; if (!rights) continue;
        await f.exec(`GRANT ${rights.join(',')} ON public.${quote(name)} TO ${quote(runtime.role)}`);
        const columns = plan.updateColumns[name]; if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(quote).join(',')}) ON public.${quote(name)} TO ${quote(runtime.role)}`);
      }
      const sequences = await f.db.execute<{ table_name: string; sequence_name: string | null }>(sql`SELECT c.relname AS table_name,
        pg_get_serial_sequence('public.'||quote_ident(c.relname),a.attname) AS sequence_name FROM pg_class c
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'`);
      for (const row of sequences) if (row.sequence_name && plan.tables[row.table_name]?.includes('INSERT')) {
        const parts = row.sequence_name.split('.'); if (parts.length !== 2 || parts[0] !== 'public') throw Error('Unexpected owned sequence');
        await f.exec(`GRANT USAGE ON SEQUENCE public.${quote(parts[1])} TO ${quote(runtime.role)}`);
      }
      const result = await request(runtime.db, { ...body, recommend_list: [71, 74, 999] }); expect(result.status, result.msg).toBe(200);
      const detail = await request(runtime.db, undefined, crypto.randomUUID(), '/outapi/product/70', 'GET');
      expect(detail.status, detail.msg).toBe(200); expect(detail.data.productInfo.recommend_list.map((row: {product_id: string}) => row.product_id)).toEqual(['71', '74', '999']);
      expect(detail.data.productInfo.recommend_list[1].image).toBe('');
    });
  }, 30_000);
});
