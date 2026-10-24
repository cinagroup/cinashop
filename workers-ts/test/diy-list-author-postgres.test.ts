import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { systemAttachment, systemDise, systemRole, storeProduct, systemArticle } from '@/models/schema';
import { canonicalizePublishedAttachmentReference } from '@/services/content/ArticleContentPolicy';
import { diyListAuthorFixture, listAuthorBlock, expectedListRootEdit, expectedListAlternateEdit, expectedListMicroEdit, DIY_LIST_AUTHOR_IDS } from './helpers/diyListAuthorFixture';
import { sortedDiyState, stableDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from './helpers/diyStateFixture';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned list author SQL'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Missing owned list author Admin SQL'); return { container: wiring.container, close: async () => {} }; } }));
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => sha(stableDiyState(value));
const oldTicket = (reference: string) => reference + '?expires=1&signature=imported-author';
// Only footer media are authoritative here. Product/article stored material is
// opaque import data and is not a public signing or ordinary-media authority.
function images(value: Row[], transform: (reference: string) => string): Row[] {
  const result=structuredClone(value);for(const block of result)if(String(block.name).toLowerCase()==='pagefoot'&&Array.isArray(block.menuList))for(const item of block.menuList)if(Array.isArray(item.imgList))for(const i of[0,1])if(typeof item.imgList[i]==='string')item.imgList[i]=transform(item.imgList[i]);return result;
}
const canonical = (value: Row[]) => images(value, canonicalizePublishedAttachmentReference);
function mediaValues(value: Row[]): string[] { const result: string[] = []; images(value, reference => { result.push(reference); return reference; }); return result; }
type Actor = 0 | 11 | 22 | 'admin' | 'minimal' | 'reader';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('complete list author persistence on two real owned PG16 schema configurations', () => {
  describe.each(['isolated-search-path', 'public'] as const)('%s', namespace => {
    const app = createApp(), reads: Row[] = [], writes: Row[] = [], snapshots: Record<string, DiyStateSnapshot> = {};
    let f: Awaited<ReturnType<typeof diyListAuthorFixture>>, directory = '', now: Date;
    let rows: Array<typeof systemDise.$inferSelect>=[], attachments: Array<typeof systemAttachment.$inferSelect>=[], roles: Array<typeof systemRole.$inferSelect>=[], products: Array<typeof storeProduct.$inferSelect>=[], articles: Array<typeof systemArticle.$inferSelect>=[];
    const remember = (snapshot: DiyStateSnapshot) => { const hash = digest(snapshot); snapshots[hash] ??= structuredClone(snapshot); return hash; };
    beforeAll(async () => {
      now = new Date(); vi.setSystemTime(now); f = await diyListAuthorFixture(now, namespace === 'public' ? { namespace: 'public' } : {}); wiring.container = f.container;
      rows = await f.db.select().from(systemDise); attachments = await f.db.select().from(systemAttachment); roles = await f.db.select().from(systemRole); products=await f.db.select().from(storeProduct);articles=await f.db.select().from(systemArticle);
      directory = await mkdtemp(join(tmpdir(), 'cinashop-diy-list-author-native-'));
      const actualSchema = (await f.db.execute<{ schema: string }>(sql`SELECT current_schema() AS schema`))[0]!.schema;
      expect(actualSchema === 'public').toBe(namespace === 'public');
      const text = JSON.stringify({ namespace, actual_schema: actualSchema, inventory: { tables: f.tables, sequences: f.sequences }, setup: f.listAuthorSetup,
        boundary: 'Owned maintenance SQL DI, actual createApp/middleware/JWT/transactions/public projection/PNG bytes. Distinct production LOGIN grants are covered separately by admin-diy-author-options native tests. Dynamic inventory is not the old73/68 claim.' }, null, 2) + '\n';
      const path = join(directory, 'setup.json'); await writeFile(path, text); process.stdout.write('DIY_CAROUSEL_AUTHOR_NATIVE_SETUP ' + JSON.stringify({ path, sha256: sha(text), namespace, tables: f.tables.length, sequences: f.sequences.length }) + '\n');
    }, 90_000);
    afterAll(async () => {
      try { if (f && directory) {
        const text = JSON.stringify({ namespace, tables: f.tables, sequences: f.sequences, reads, writes, snapshots_by_sha256: snapshots, final: await f.snapshot(), resources: f.resources(),
          boundary: 'Every completed GET consumes real JSON/asset bytes before all-table/all-sequence/KV/R2/queue/IMAGES equality. Explicit fixture imports/cleanup and actual POST changes are recorded separately.' }, null, 2) + '\n';
        const path = join(directory, 'execution.json'); await writeFile(path, text); process.stdout.write('DIY_CAROUSEL_AUTHOR_NATIVE_EXECUTION ' + JSON.stringify({ path, sha256: sha(text), namespace, reads: reads.length, writes: writes.length, all_reads_unchanged: reads.every(read => read.unchanged) }) + '\n');
      } } finally { wiring.container = undefined; vi.useRealTimers(); await f?.close(); }
    }, 30_000);
    beforeEach(() => { vi.setSystemTime(now); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned list author native forbids external I/O')); });
    afterEach(async () => {
      try { if(vi.isMockFunction(fetch))expect(fetch).not.toHaveBeenCalled(); }
      finally {
        vi.restoreAllMocks();
        for (const row of rows) await f.db.update(systemDise).set(row).where(eq(systemDise.id, row.id));
        for (const row of attachments) await f.db.update(systemAttachment).set(row).where(eq(systemAttachment.attId, row.attId));
        for (const row of roles) await f.db.update(systemRole).set(row).where(eq(systemRole.id, row.id));
        for(const row of products)await f.db.update(storeProduct).set(row).where(eq(storeProduct.id,row.id));for(const row of articles)await f.db.update(systemArticle).set(row).where(eq(systemArticle.id,row.id));
      }
    });
    const token = (actor: Actor) => actor === 'admin' ? f.adminToken : actor === 'minimal' ? f.minimalToken : actor === 'reader' ? f.readerToken : actor === 11 ? f.token : actor === 22 ? f.otherToken : undefined;
    async function request(path: string, method: 'GET' | 'POST', actor: Actor, body?: unknown) {
      const waits: Promise<unknown>[] = [], auth = token(actor), headers: Record<string, string> = { ...(auth ? { 'Authori-zation': 'Bearer ' + auth } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) };
      const response = await app.fetch(new Request('https://owned-list-author.local' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), f.env,
        { waitUntil: (work: Promise<unknown>) => { waits.push(work); }, passThroughOnException() {} } as unknown as ExecutionContext);
      await Promise.all(waits); const bytes = new Uint8Array(await response.arrayBuffer());
      return { response, bytes, body: response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(new TextDecoder().decode(bytes)) as Row : undefined };
    }
    async function get(path: string, actor: Actor = 0) {
      const before = await f.snapshot(), resources = f.resources(), initialReads = f.bucket.get.mock.calls.length, result = await request(path, 'GET', actor), after = await f.snapshot();
      expect(after).toEqual(before); expect(f.resources()).toEqual(resources);
      reads.push({ path, actor, status: result.body?.status ?? result.response.status, before: remember(before), after: remember(after), unchanged: true,
        body_sha256: sha(result.bytes), r2_reads: f.bucket.get.mock.calls.length - initialReads, resources_before: resources, resources_after: f.resources() }); return result;
    }
    async function page(id = 2, actor: Actor = 0) { const result = await get('/api/diy/get_diy/' + id, actor); expect(result.body?.status).toBe(200); expect(result.response.headers.get('Cache-Control')).toBe('no-store'); return result.body!.data as Row; }
    async function save(body: Row, actor: Actor = 'admin') {
      const before = await f.snapshot(), resources = f.resources(), result = await request('/adminapi/dise/save', 'POST', actor, body), after = await f.snapshot();
      expect(f.resources()).toEqual(resources); writes.push({ actor, request: body, status: result.body?.status, before: remember(before), after: remember(after), resources_before: resources, resources_after: f.resources() }); return { ...result, before, after };
    }
    function saved(result: Awaited<ReturnType<typeof save>>, value: Row[], id = 2) {
      expect(result.body?.status).toBe(200); const old = result.before.system_dise.find(row => row.id === id)!, actual = result.after.system_dise.find(row => row.id === id)!, wanted = structuredClone(result.before);
      expect(actual.version).not.toBe(old.version); expect(actual.update_time).toBeGreaterThan(old.update_time);
      Object.assign(wanted.system_dise.find(row => row.id === id)!, { value: JSON.stringify(value), version: actual.version, update_time: actual.update_time }); expect(result.after).toEqual(sortedDiyState(wanted));
      expect(actual.content).toBe(old.content); return actual;
    }
    async function imported(value: Row[]) {
      const before = await f.snapshot(), resources = f.resources(); await f.db.update(systemDise).set({ value: JSON.stringify(value) }).where(eq(systemDise.id, 2));
      const after = await f.snapshot(), wanted = structuredClone(before); wanted.system_dise.find(row => row.id === 2)!.value = JSON.stringify(value); expect(after).toEqual(sortedDiyState(wanted)); expect(f.resources()).toEqual(resources);
      writes.push({ phase: 'explicit owned imported-fixture setup, not author POST or GET', before: remember(before), after: remember(after), resources_before: resources, resources_after: f.resources() });
    }

    it('inventories every actual table and sequence with complete immutable PHP defaults and separate real catalog setup',async()=>{
      const tables=(await f.db.execute<{name:string}>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(r=>r.name),sequences=(await f.db.execute<{name:string}>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(r=>r.name);
      expect(f.tables).toEqual(tables);expect(f.sequences).toEqual(sequences);const all=await f.snapshot();expect(Object.keys(all).sort()).toEqual([...tables,'__sequences'].sort());expect(all.__sequences.map(r=>r.name).sort()).toEqual(sequences);
      expect(Object.keys(listAuthorBlock('goodList',0))).toHaveLength(40);expect(Object.keys(listAuthorBlock('articleList',0))).toHaveLength(32);expect(listAuthorBlock('goodList',0).goodsList).toEqual({max:20,list:[]});
      expect(f.listAuthorSetup.ids).toEqual(DIY_LIST_AUTHOR_IDS);expect(tables).toContain('store_brand');expect(tables).toContain('store_product_label');
    });
    it('serves complete root and imported micro independently to anonymous and both users without trusting stored product or article material',async()=>{
      for(const id of[0,2])for(const actor of[0,11,22]as const){const expected=id===0?f.rootBlocks.filter(r=>r.name!=='pageFoot'):f.microBlocks,actual=await page(id,actor);expect(canonical(actual.value)).toEqual(expected);expect(actual.title).toBe(id===0?'列表作者首页':'列表作者导入微页');expect(actual.content).toBeUndefined();expect((await get('/api/diy/diy_version/'+id,actor)).body?.data.version).toBe('list-author-initial');}
    });
    it('publishes the actual category child level and path with no hidden or supplier tree entries and no GET mutation',async()=>{
      const result=await get('/api/category');expect(result.body?.status).toBe(200);expect(result.body!.data.find((r:Row)=>r.id===85021)).toEqual({id:85021,pid:0,cate_name:'列表作者分类',pic:'',big_pic:'',children:[{id:85022,pid:85021,cate_name:'列表作者子分类',pic:'',big_pic:'',children:[]}]});
      const data=await get('/api/products?cid=85021&sid=85022&page=1&limit=8');expect(data.body?.status).toBe(200);expect(data.body!.data.list.map((r:Row)=>r.id)).toEqual([85034]);
    });
    it.each([['fixed','ids=85032,85031',[85032,85031]],['brand','brand_id=85002',[85033]],['category','cate_id=85022',[85034]],['label','store_label_id=85011',[85035]]]as const)('reads the real%s source through current public visibility rather than stored snapshots',async(_kind,query,ids)=>{
      const result=await get('/api/products?'+query+'&page=1&limit=8');expect(result.body?.status).toBe(200);const data=result.body!.data;expect(data.count).toBe(ids.length);expect(data.list.map((r:Row)=>r.id)).toEqual(ids);
      expect(JSON.stringify(data)).not.toMatch(/never-author-private|不能替代真实商品|导入旧商品快照|attachments\/admin|attachments\/supplier|cost|bar_code|keyword/u);
      for(const product of data.list){expect(product.image).toMatch(/^\/api\/assets\/\d+\?expires=\d+&signature=/u);const asset=await get(product.image);expect(asset.response.status).toBe(200);expect(asset.bytes).toEqual(f.png);}
    });
    it('reads current article category and explicit hot aggregation with owner-projected images and zero visits, likes or writes',async()=>{
      const result=await get('/api/article/list/85081?page=1&limit=2');expect(result.body?.status).toBe(200);expect(result.body!.data.map((r:Row)=>r.id)).toEqual([85091,85092]);
      expect(result.body!.data[0]).toMatchObject({title:'作者列表文章一',visit:'0',likes:0,synopsis:'真实作者摘要一'});expect(JSON.stringify(result.body!.data)).not.toMatch(/never-author-private-body|隐藏文章|隐藏分类里的文章/u);
      for(const item of result.body!.data){expect(item.image_input).toHaveLength(1);const asset=await get(item.image_input[0]);expect(asset.bytes).toEqual(f.png);}
      const hot=await get('/api/article/list/0?page=1&limit=100');expect(hot.body?.status).toBe(200);expect(hot.body!.data.some((r:Row)=>r.id===85091)).toBe(true);
    });
    it.each([['goodList',0],['goodList',1],['goodList',2],['goodList',3],['goodList',4],['goodList',5],['articleList',0],['articleList',1],['articleList',2]]as const)('roundtrips complete%s layout%s including every field family and dormant metadata',async(kind,style)=>{
      const value=structuredClone(f.rootBlocks),block=value.find(r=>r.name===kind)!;block.styleConfig.tabVal=style;block.toneConfig.tabVal=1;block.filletImg.type=1;block.fillet.type=1;
      for(const key of['filletImg','fillet']){block[key].val=12;block[key].valList=[{val:' 1.25 '},{val:'2e0'},{val:3.5},{val:4.75}];}
      for(const key of['topConfig','bottomConfig','prConfig','mbConfig'])block[key].val=7.5;
      if(kind==='goodList'){
        block.typeConfig.activeValue=1;block.goodsList.ids=[85032,85031];block.numberConfig.val=2;block.goodsSort.tabVal=2;block.goodsSort.type='dormant-legacy-type';block.checkboxInfo.type=[0,1,2,3,4,5];
        for(const key of['goodsName','cartConfig','bntConfig','bntStyleConfig','toneCartConfig'])block[key].tabVal=1;
        for(const key of['goodsNameColor','goodsPriceColor','soldNumColor','scoreColor'])block[key].color[0].item='#123456';for(const key of['moduleColor','bntBgColor']){block[key].color[0].item='#123456';block[key].color[1].item='#abcdef';}
      }else{
        block.selectConfig.activeValue=85081;block.numConfig.val=2;block.checkboxList.type=[0,1,2];block.nameConfig.tabVal=0;
        for(const key of['nameColor','timeColor','browseColor','likeColor','statisticColor','likeSuccessColor'])block[key].color[0].item='#123456';block.bgColor.color[0].item='#123456';block.bgColor.color[1].item='#abcdef';
      }
      block.bottomBgColor.color[0].item='#fedcba';saved(await save({id:2,value:JSON.stringify(value)}),value);expect(canonical((await page()).value)).toEqual(value);
    });
    it.each([1,2,3,4])('saves goods scope%s without deleting any dormant scope IDs or imported material',async(scope)=>{
      const value=expectedListRootEdit(f),goods=value.find(r=>r.name==='goodList')!;goods.typeConfig.activeValue=scope;goods.brandList.brandVal=[85002];goods.classList.classVal=[85022];goods.goodsLabel.activeValue=[85011];
      saved(await save({id:2,value:JSON.stringify(value)},'minimal'),value);expect(canonical((await page()).value)).toEqual(value);expect(goods.productList.list[0].id).toBe(999999);
    });
    it('roundtrips all three concrete GUI save expectations with other rows, content, metadata and all sequences unchanged',async()=>{
      for(const[id,value]of[[1,expectedListRootEdit(f)],[1,expectedListAlternateEdit(f)],[2,expectedListMicroEdit(f)]]as const){saved(await save({id,value:JSON.stringify(value)}),value,id);expect(canonical((await page(id)).value)).toEqual(value);}
    });
    it('preserves imported tiny fractions, Number strings, zero101 counts, hidden articles and dormant invalid selectors after one unrelated edit',async()=>{
      const value=expectedListMicroEdit(f);saved(await save({id:2,value:JSON.stringify(value)},'minimal'),value);expect(canonical((await page()).value)).toEqual(value);
      expect(value.filter(r=>r.name==='goodList').map(r=>r.numberConfig.val)).toEqual([101,0,'0003',3]);expect(value.find(r=>r.name==='articleList'&&r.isHide)?.numConfig.val).toBe(0);
    });
    it('keeps more than100 imported selectors,2501 opaque product material rows and more than200 components without clipping',async()=>{
      const value=structuredClone(f.microBlocks);while(value.length<201)value.push({name:'unsupported-list-import',timestamp:1000+value.length,opaque:{zero:0,list:[]}});
      saved(await save({id:2,value:JSON.stringify(value)}),value);expect(canonical((await page()).value)).toEqual(value);expect(value.filter(r=>r.name==='goodList')[2].productList.list).toHaveLength(2501);expect(value.find(r=>r.name==='articleList')!.selectConfig.list).toHaveLength(107);
    });
    it('never derives fixed IDs from stale material at mount or save and never upgrades private snapshot references into public signatures',async()=>{
      const value=structuredClone(f.microBlocks),goods=value.find(r=>r.name==='goodList')!;delete goods.goodsList.ids;goods.goodsList.list=[{id:85031,image:oldTicket(f.image.url),nested:{unknown:true}}];goods.productList.list=[{id:85032,image:oldTicket(f.supplierImage.url)}];
      const article=value.find(r=>r.name==='articleList')!;article.selectList.list=[{id:85091,image_input:[oldTicket(f.image.url)]}];saved(await save({id:2,value:JSON.stringify(value)}),value);
      const actual=(await page()).value;expect(canonical(actual)).toEqual(value);expect(actual.find((r:Row)=>r.name==='goodList').goodsList.ids).toBeUndefined();expect(actual.find((r:Row)=>r.name==='goodList').goodsList.list[0].image).toBe(oldTicket(f.image.url));
    });
    it('treats arbitrary stored lists as opaque import data outside the ordinary2500 public-media budget',async()=>{
      const value=structuredClone(f.microBlocks),goods=value.find(r=>r.name==='goodList')!;goods.productList.list=Array.from({length:2501},(_,i)=>({id:i+1,image:f.image.url,privateImport:true}));
      saved(await save({id:2,value:JSON.stringify(value)}),value);const actual=await page();expect(canonical(actual.value)).toEqual(value);expect(actual.value.find((r:Row)=>r.name==='goodList').productList.list.every((r:Row)=>r.image===f.image.url)).toBe(true);expect(mediaValues(actual.value)).toHaveLength(10);
    });
    it.each([['private-user',{type:3,relationId:11,moduleType:3}],['foreign-platform',{type:1,relationId:11}],['active-MIME',{attType:'text/html'}],['foreign-key',{name:'attachments/admin/2/foreign.png'}]]as Array<[string,Partial<typeof systemAttachment.$inferInsert>]>)('rechecks%s media policy in actual public product and article lists without signing opaque DIY snapshots',async(_kind,patch)=>{
      await f.db.update(systemAttachment).set(patch).where(eq(systemAttachment.attId,f.platformImage.att_id));const products=await get('/api/products?ids=85031&page=1&limit=8');expect(products.body?.status).toBe(200);expect(products.body!.data.list[0].image).toBe('');const articles=await get('/api/article/list/85081?page=1&limit=2');expect(articles.body?.status).toBe(200);expect(articles.body!.data[0].image_input).toEqual(['']);
      const actual=await page();expect(actual.value.find((r:Row)=>r.name==='goodList').goodsList.list[0].image).toBe(f.image.url);expect(JSON.stringify(products.body)).not.toContain('signature=');
    });
    it('withdraws a product hidden after catalog selection while retaining the authored fixed identity and raw stale snapshot',async()=>{
      await f.db.update(storeProduct).set({isShow:0}).where(eq(storeProduct.id,85031));const result=await get('/api/products?ids=85031&page=1&limit=8');expect(result.body?.status).toBe(200);expect(result.body!.data).toMatchObject({count:0,list:[]});expect((await page()).value.find((r:Row)=>r.name==='goodList').goodsList.ids).toEqual([85031]);
    });
    it('withdraws an article hidden after category selection without incrementing visits or likes and without editing the stored category',async()=>{
      await f.db.update(systemArticle).set({hide:1}).where(eq(systemArticle.id,85091));const result=await get('/api/article/list/85081?page=1&limit=2');expect(result.body?.status).toBe(200);expect(result.body!.data.map((r:Row)=>r.id)).toEqual([85092]);expect((await page()).value.find((r:Row)=>r.name==='articleList').selectConfig.activeValue).toBe('85081');
    });
    it('keeps the real footer authority independent from opaque list material and atomically rejects2501 actual ordinary-media slots',async()=>{
      const value=structuredClone(f.microBlocks);value.push({name:'swipers',swiperConfig:{list:Array.from({length:2501},()=>({img:f.platformImage.url}))}});const result=await save({id:2,value:JSON.stringify(value)});expect(result.body?.status).toBe(400);expect(result.after).toEqual(result.before);
      await imported(value);const read=await get('/api/diy/get_diy/2');expect(read.body?.status).toBe(400);expect(JSON.stringify(read.body)).not.toContain('signature=');
    },45_000);
    it('retains exact2MB UTF8 payload and rejects excessive bytes, depth and nodes atomically rather than truncating authored lists',async()=>{
      const value=structuredClone(f.microBlocks);value.push({name:'unsupported-list-payload',note:'界'});const block=value.at(-1)!;block.note+='a'.repeat(2_000_000-Buffer.byteLength(JSON.stringify(value)));saved(await save({id:2,value:JSON.stringify(value)}),value);
      for(const bad of[JSON.stringify([...value.slice(0,-1),{...block,note:block.note+'a'}]),JSON.stringify([{name:'goodList',payload:Array(100001).fill(0)}]),JSON.stringify([{name:'articleList',nested:Array.from({length:65}).reduce<unknown>(next=>({next}),'')}])]){const result=await save({id:2,value:bad});expect(result.body?.status).toBe(400);expect(result.after).toEqual(result.before);}
    },45_000);
    it.each([0,11,22,'reader']as const)('denies actual list author save byactor%s without SQL, sequence or resource changes',async actor=>{
      const result=await save({id:2,value:JSON.stringify(expectedListRootEdit(f))},actor);expect(result.body?.status).not.toBe(200);expect(result.after).toEqual(result.before);
    });
    it('rechecks persisted minimal permission and refuses metadata, identity and generic writer escalation atomically',async()=>{
      await f.db.update(systemRole).set({rules:'dise.view'}).where(eq(systemRole.id,903));const denied=await save({id:2,value:JSON.stringify(f.microBlocks)},'minimal');expect(denied.body?.status).toBe(400011);expect(denied.after).toEqual(denied.before);
      for(const patch of[{type:1},{is_diy:0},{template_name:'default'},{version:'forged'},{is_bg_color:true},{bg_tab_val:3}]){const result=await save({id:2,value:JSON.stringify(f.microBlocks),...patch});expect(result.body?.status).toBe(400);expect(result.after).toEqual(result.before);}
    });
  });
});
