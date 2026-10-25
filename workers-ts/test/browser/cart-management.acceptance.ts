import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { storeCart, storeProduct, storeProductAttrValue, storePromotions, systemConfig } from '@/models/schema';
import { diyFooterBrowserFixture } from '../helpers/diyFooterBrowserFixture';
import { sortedDiyState, stableDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from '../helpers/diyStateFixture';

// Real registered routes, JWT, services and owned native PG. Only DI/env wiring changes.
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned cart SQL'); return wiring.container;
} }));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(stableDiyState(value));
function moneyCents(value: unknown): bigint {
  expect(typeof value === 'number' || typeof value === 'string').toBe(true);
  const text = String(value); expect(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)).toBe(true);
  const [integer, decimal = ''] = text.split('.'); return BigInt(integer) * 100n + BigInt(decimal.padEnd(2, '0'));
}
const moneyText = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
async function files(dir: string): Promise<string[]> {
  return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(item => item.isDirectory() ? files(resolve(dir, item.name)) : [resolve(dir, item.name)]))).flat().sort();
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const value = Buffer.from(chunk); size += value.length; expect(size).toBeLessThanOrEqual(65_536); chunks.push(value); }
  return Buffer.concat(chunks);
}
it('built mobile cart management performs canonical collections and exact ordinary deletions on owned PG16', async () => {
  const f = await diyFooterBrowserFixture();
  const prefix = '/tmp/cinashop-cart-management-browser-';
  let ownedServer: ReturnType<typeof createServer> | undefined, timer: ReturnType<typeof setTimeout> | undefined, failure: unknown;
  try {
  // The inherited read fixture creates columns/PK only. Install the exact
  // production collect conflict arbiter (migration0106) in this owned schema.
  await f.exec(`CREATE UNIQUE INDEX "ur_uid_rel_type_cat_idx" ON "user_relation" ("uid", "relation_id", "type", "category") WHERE "type" <> 'play'`);
  wiring.container = f.container;
  const app = createApp(), repository = resolve(import.meta.dirname, '../../..'), h5 = resolve(repository, 'view/uniapp-ts/dist/build/h5');
  const origin = 'http://127.0.0.1:40829', control = '/__cart/' + randomUUID();
  const plans = ['initial','selected','manage','managementSelected','collected','singleDeleted','batchDeleted','invalidCleared','other','guest','desktop','finished'];
  const evidence: Row[] = [], traces: Row[] = [], staticPaths: Row[] = [], snapshots: Record<string, DiyStateSnapshot> = {};
  const remember = (value: DiyStateSnapshot) => { const id = digest(value); snapshots[id] ??= structuredClone(value); return id; };
  const stage = () => plans[evidence.length];
  let queue = Promise.resolve(), pending = 0, writes = 0;
  let failedDispatch: Row | undefined;
  const serial = <T>(fn: () => Promise<T>) => { const next = queue.then(fn); queue = next.then(() => {}, () => {}); return next; };
  let done!: () => void, fail!: (reason: Error) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; }); completion.catch(() => {});
  const send = (res: ServerResponse, value: string | Buffer, status = 200, type = 'text/html') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(value); };
  const json = (res: ServerResponse, value: unknown) => send(res, JSON.stringify(value), 200, 'application/json');
  const resources = () => ({ puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length,
    objects: digest([...f.objects].map(([key, value]) => ({ key, type: value.type, bytes: [...value.bytes] }))), queue: vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length });
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Cart acceptance forbids external provider I/O'));
  const sources = async () => {
    const paths = [...await files(resolve(repository,'workers-ts/src')), ...await files(resolve(repository,'view/uniapp-ts/src')), ...await files(resolve(repository,'view/common')), ...await files(resolve(repository,'workers-ts/test/helpers')),
      'workers-ts/test/browser/cart-management.acceptance.ts','workers-ts/vitest.cart-management-browser.config.ts','workers-ts/scripts/run-local-finance-postgres.mjs','workers-ts/package.json','workers-ts/package-lock.json','view/uniapp-ts/package.json','view/uniapp-ts/package-lock.json'].map(path => resolve(repository,path));
    return Promise.all([...new Set(paths)].sort().map(async path => ({ path: path.slice(repository.length+1), sha256: hash(await readFile(path)) })));
  };
  const artifacts = async () => Promise.all((await files(h5)).map(async path => ({path:path.slice(h5.length+1),sha256:hash(await readFile(path))})));
  const preparedBefore = await f.snapshot();
  await f.db.update(storeCart).set({ status: 0 }).where(eq(storeCart.id,9102)); // Outsider remains present but never owns an ordinary row or badge.
  await f.db.update(storeCart).set({ productId: 999999, status: 0 }).where(eq(storeCart.id,9103));
  await f.db.update(storeProduct).set({ storeName:'舒适纯棉短袖 T 恤', stock:100, price:'6.50' }).where(eq(storeProduct.id,601));
  await f.db.update(storeProduct).set({ storeName:'日常轻便帆布包', stock:100, price:'12.00' }).where(eq(storeProduct.id,611));
  await f.db.update(storePromotions).set({ status:0 });
  await f.db.insert(storeProductAttrValue).values({ id:9802,productId:611,unique:'foot611',suk:'米白色',type:0,stock:100,price:'12.00',otPrice:'20.00',image:'/static/logo.png' });
  await f.db.insert(storeCart).values([
    {id:9111,uid:11,productId:611,productAttrUnique:'foot611',cartNum:1,isNew:0,status:1},
    {id:9112,uid:11,productId:601,productAttrUnique:'foot601',cartNum:2,isNew:0,status:1},
  ]);
  for (const key of ['first_order_status','newcomer_status','member_func_status']) {
    const changed = await f.db.update(systemConfig).set({value:'0'}).where(eq(systemConfig.menuName,key)).returning({id:systemConfig.id});
    if (!changed.length) await f.db.insert(systemConfig).values({menuName:key,value:'0',isStore:0,status:1});
  }
  f.cache.clear();
  let expected = await f.snapshot(); const prepared = structuredClone(expected), initialResources = resources(); remember(preparedBefore); remember(prepared);
  const sourceBefore = await sources(), buildBefore = await artifacts(); expect(buildBefore.length).toBeGreaterThan(100);
  async function dispatch(path: string, method: string, bytes: Buffer, req?: IncomingMessage) {
    const headers = new Headers(); if (req) for(let i=0;i<req.rawHeaders.length;i+=2) headers.append(req.rawHeaders[i],req.rawHeaders[i+1]);
    const waits: Promise<unknown>[] = [];
    const response = await app.fetch(new Request('https://127.0.0.1:40829'+path,{method,headers,...(bytes.length?{body:bytes}:{})}),f.env,
      {waitUntil:(work:Promise<unknown>)=>{waits.push(work);},passThroughOnException(){}} as unknown as ExecutionContext);
    await Promise.all(waits); const raw=Buffer.from(await response.arrayBuffer());
    return {response,raw,payload:response.headers.get('Content-Type')?.includes('application/json')?JSON.parse(raw.toString()) as Row:undefined};
  }
  const chrome: Row = {'/api/site_config':{site_name:'购物车迁移验收',site_logo:'',record_No:'',ico_path:''},'/api/share':{title:'购物车',synopsis:'',img:''},
    '/api/get_open_adv':{status:0,time:3,interval_time:24,type:'pic',value:[],video_link:''},'/api/v2/diy/color_change/color_change':{}};
  async function api(req:IncomingMessage,res:ServerResponse,url:URL) {
    pending++;
    try { await serial(async()=>{
      const startedAt=Date.now(),bytes=await body(req),method=req.method??'GET',before=await f.snapshot(),startResources=resources(); expect(before).toEqual(expected);
      if(Object.hasOwn(chrome,url.pathname)){
        expect(method).toBe('GET');const dto={status:200,msg:'Unrelated synthetic chrome only',data:chrome[url.pathname]},raw=Buffer.from(JSON.stringify(dto));
        const after=await f.snapshot();expect(after).toEqual(before);expect(resources()).toEqual(startResources);
        traces.push({path:url.pathname,query:url.search,method,synthetic:true,stage:stage(),started_at_ms:startedAt,completed_at_ms:Date.now(),
          before:remember(before),after:remember(after),resources_before:startResources,resources_after:resources(),
          response:{http_status:200,content_type:'application/json',bytes:raw.length,sha256:hash(raw),body:raw.toString(),dto}});
        send(res,raw,200,'application/json');return;
      }
      const token=String(req.headers['authori-zation']??'').replace(/^Bearer\s+/,''); const actor=token===f.token?11:token===f.otherToken?22:0;
      if(method!=='GET')expect(['/api/cart/compute','/api/cart/del','/api/collect/add']).toContain(url.pathname);
      const result=await dispatch(url.pathname+url.search,method,bytes,req),after=await f.snapshot();
      failedDispatch={path:url.pathname,method,actor,stage:stage(),input:bytes.toString(),response:{http_status:result.response.status,body:result.raw.toString(),sha256:hash(result.raw)},before:remember(before),after:remember(after),resources_before:startResources,resources_after:resources()};
      expect(result.response.status).toBe(200); expect(result.payload?.status??200).toBe(200);
      const want=structuredClone(before), input=bytes.length?JSON.parse(bytes.toString()):null;
      if(url.pathname==='/api/cart/del') {
        expect(method).toBe('POST');expect(actor).toBe(11);expect(input.scope).toBe('cart');
        const ids=stage()==='singleDeleted'?[9112]:stage()==='batchDeleted'?[9101,9111]:stage()==='invalidCleared'?[9103]:[];
        expect(ids.length).toBeGreaterThan(0);expect([...input.ids].sort((a:number,b:number)=>a-b)).toEqual(ids);expect(Object.keys(input).sort()).toEqual(['ids','scope']);
        want.store_cart=want.store_cart.map(row=>ids.includes(row.id)?{...row,is_del:1}:row);expect(after).toEqual(sortedDiyState(want)); writes++;
      } else if(url.pathname==='/api/collect/add') {
        expect(stage()).toBe('collected');expect(method).toBe('POST');expect(actor).toBe(11);expect(input).toEqual({id:[601,611],category:'product'});expect(result.payload?.data).toEqual({count:2});
        const added=after.user_relation.filter(row=>!before.user_relation.some(old=>old.id===row.id));expect(added.map(row=>row.relation_id).sort()).toEqual([601,611]);
        for(const row of added)expect(row).toMatchObject({uid:11,type:'collect',category:'product'});
        expect(after.user_relation.filter(row=>!added.includes(row))).toEqual(before.user_relation);
        const logs=after.store_product_log.filter(row=>!before.store_product_log.some(old=>old.id===row.id));expect(logs.map(row=>row.product_id).sort()).toEqual([601,611]);
        for(const row of logs)expect(row).toMatchObject({uid:11,type:'collect',collect_num:1});
        expect(after.store_product_log.filter(row=>!logs.includes(row))).toEqual(before.store_product_log);
        want.user_relation=after.user_relation;want.store_product_log=after.store_product_log;
        want.store_product=want.store_product.map(row=>[601,611].includes(row.id)?{...row,collect:after.store_product.find(item=>item.id===row.id)!.collect}:row);
        for(const id of [601,611])expect(after.store_product.find(row=>row.id===id)!.collect).toBe(after.user_relation.filter(row=>row.relation_id===id&&row.category==='product'&&row.type==='collect').length);
        const changed=after.__sequences.filter(row=>stableDiyState(row)!==stableDiyState(before.__sequences.find(old=>old.name===row.name)));
        expect(changed.map(row=>row.name).sort()).toEqual(['store_product_log_id_seq','user_relation_id_seq']);
        for(const [name,inserted] of [['user_relation_id_seq',added],['store_product_log_id_seq',logs]] as const){
          const prior=before.__sequences.find(row=>row.name===name),next=after.__sequences.find(row=>row.name===name);
          expect(prior).toBeDefined();expect(next).toBeDefined();expect(typeof prior!.called).toBe('boolean');
          expect(inserted).toHaveLength(2);const first=BigInt(prior!.last)+(prior!.called?1n:0n);
          expect(inserted.map(row=>BigInt(row.id)).sort((a,b)=>a<b?-1:a>b?1:0)).toEqual([first,first+1n]);
          expect(next!.last).toBe(String(first+1n));expect(next!.called).toBe(true);
        }
        want.__sequences=after.__sequences;
        expect(after).toEqual(sortedDiyState(want));writes++;
      } else expect(after).toEqual(before);
      expect(resources()).toEqual(startResources);expected=after;traces.push({path:url.pathname,query:url.search,method,actor,stage:stage(),status:result.payload?.status??200,input,
        started_at_ms:startedAt,completed_at_ms:Date.now(),request:{bytes:bytes.length,sha256:hash(bytes),body:bytes.toString()},
        response:{http_status:result.response.status,content_type:result.response.headers.get('Content-Type'),bytes:result.raw.length,sha256:hash(result.raw),
          ...(result.payload?{body:result.raw.toString(),dto:result.payload}:{})},
        count:result.payload?.data?.count,before:remember(before),after:remember(after),resources_before:startResources,resources_after:resources(),synthetic:false});
      failedDispatch=undefined;res.writeHead(result.response.status,Object.fromEntries(result.response.headers));res.end(result.raw);
    });}finally{pending--;}
  }
  const shell = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>购物车真实数据库验收</title><style>body{font:14px sans-serif;margin:12px;background:#f6f7f8}h1{font-size:18px}button{margin:4px;padding:6px}iframe{display:block;width:375px;height:880px;border:1px solid #ddd;background:white}pre{white-space:pre-wrap;max-width:1000px}</style></head><body><h1>购物车管理 · 真实 Worker / PostgreSQL 16</h1><p>只操作本批可销毁的本地数据，无支付、下单或外部请求。</p>
<button data-owner="11">购物车11</button><button data-owner="22">购物车22</button><button data-owner="0">访客购物车</button><button id="wide">桌面宽度</button>
${plans.map(name=>'<button data-stage="'+name+'">验收 '+name+'</button>').join('')}<pre id="result"></pre><iframe title="实际购物车应用"></iframe><script>
const frame=document.querySelector('iframe'),tokens=${JSON.stringify({11:f.token,22:f.otherToken})};let errors=[];
frame.onload=()=>{const w=frame.contentWindow;w.addEventListener('error',e=>errors.push({kind:'error',message:e.message}));w.addEventListener('unhandledrejection',e=>errors.push({kind:'unhandledrejection',message:String(e.reason)}));};
for(const button of document.querySelectorAll('[data-owner]'))button.onclick=()=>{errors=[];const uid=Number(button.dataset.owner);if(uid){localStorage.setItem('uni_token',JSON.stringify({type:'string',data:tokens[uid]}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:uid}));}else{localStorage.removeItem('uni_token');localStorage.removeItem('uni_uid');}const target='/__h5#/pages/cart/index';if(frame.contentWindow.location.href===new URL(target,location.href).href)frame.contentWindow.location.reload();else frame.src=target;};
document.getElementById('wide').onclick=()=>{frame.style.width='1000px';};
for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{button.disabled=true;try{const d=frame.contentDocument,w=frame.contentWindow,visible=n=>!!n&&w.getComputedStyle(n).display!=='none'&&n.getBoundingClientRect().height>0;
const rows=[...d.querySelectorAll('[data-cart-id]')].map(n=>({id:Number(n.getAttribute('data-cart-id')),checked:n.querySelector('.check')?.getAttribute('aria-pressed')}));
const data={href:w.location.href,title:d.title,bodyText:d.body.innerText,viewportWidth:w.innerWidth,frameClientWidth:frame.clientWidth,clientWidth:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,rows,errors,management:visible(d.querySelector('.management-summary')),budget:visible(d.querySelector('.budget-panel')),budgetText:d.querySelector('.budget-panel')?.innerText??'',empty:visible(d.querySelector('.cart-empty')),footer:visible(d.querySelector('.diy-page-foot')),badge:Number(d.querySelector('.diy-foot-badge')?.textContent||0),bar:d.querySelector('.checkout-bar')?.getBoundingClientRect().toJSON(),footerBox:d.querySelector('.diy-page-foot')?.getBoundingClientRect().toJSON()};
document.getElementById('result').textContent=await(await fetch(${JSON.stringify(control)}+'/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})).text();}finally{button.disabled=false;}};
</script></body></html>`;
  const server=createServer((req,res)=>{void(async()=>{
    const url=new URL(req.url??'/',origin);
    if(url.pathname.startsWith(control+'/')){const data=JSON.parse((await body(req)).toString()),name=url.pathname.slice(control.length+1);await serial(async()=>{
      expect(name).toBe(stage());expect(pending).toBe(0);expect(data.errors).toEqual([]);expect(data.href).toBe(origin+'/__h5#/pages/cart/index');expect(data.scrollWidth).toBeLessThanOrEqual(data.clientWidth);const viewport=name==='desktop'||name==='finished'?1000:375;expect(data.frameClientWidth).toBe(viewport);expect(data.viewportWidth).toBe(viewport);expect(data.clientWidth).toBeLessThanOrEqual(viewport);expect(viewport-data.clientWidth).toBeLessThanOrEqual(20);
      const ids=data.rows.map((row:Row)=>row.id).sort((a:number,b:number)=>a-b);
      if(['initial','selected','manage','managementSelected','collected'].includes(name))expect(ids).toEqual([9101,9103,9111,9112]);
      if(name==='singleDeleted')expect(ids).toEqual([9101,9103,9111]);if(name==='batchDeleted')expect(ids).toEqual([9103]);
      if(['invalidCleared','desktop','finished'].includes(name)){expect(ids).toEqual([]);expect(data.empty).toBe(true);expect(data.bodyText).toContain('暂无商品，去加点别的吧～');}
      if(['initial','selected','manage','managementSelected','collected'].includes(name))expect(data.badge).toBe(6);
      if(name==='singleDeleted')expect(data.badge).toBe(4);if(['batchDeleted','invalidCleared','guest','desktop','finished'].includes(name))expect(data.badge).toBe(0);if(name==='other')expect(data.badge).toBe(4);
      if(data.bar&&data.footerBox)expect(Math.abs(data.bar.bottom-data.footerBox.top)).toBeLessThanOrEqual(1);
      if(name==='initial')expect(data.bodyText).toContain('失效商品（1）');
      if(name==='selected'){
        expect(data.budget).toBe(true);expect(data.rows.filter((row:Row)=>row.checked==='true').map((row:Row)=>row.id)).toEqual([9101]);
        const computes=traces.filter(trace=>!trace.synthetic&&trace.path==='/api/cart/compute'&&trace.actor===11&&trace.stage==='selected');
        expect(computes.length).toBeGreaterThan(0);const compute=computes.at(-1)!;expect(compute.method).toBe('POST');expect(compute.input).toEqual({cartId:'9101'});
        const list=traces.filter(trace=>!trace.synthetic&&trace.path==='/api/cart/list'&&trace.actor===11).at(-1)!;
        expect(list).toBeDefined();const rows=list.response.dto.data;expect(Array.isArray(rows)).toBe(true);const selected=rows.find((row:Row)=>row.id===9101);
        expect(selected).toBeDefined();expect(selected.isValid).toBe(true);const dto=compute.response.dto.data,deduction=dto.deduction;
        expect(dto.budget.selection).toEqual([{id:9101,productId:selected.productId,cartNum:selected.cartNum,unique:selected.unique,type:selected.type,activityId:selected.activityId??0}]);
        const raw=moneyCents(selected.sumPrice),pay=moneyCents(deduction.pay_price);
        expect(moneyCents(deduction.sum_price)).toBe(raw);
        expect(raw-moneyCents(deduction.vip_price)-moneyCents(deduction.promotions_price)-moneyCents(deduction.coupon_price)-moneyCents(deduction.first_order_price)).toBe(pay);
        expect(data.budgetText).toContain('选中商品预算 ¥'+moneyText(pay));
        data.budget_binding={cart_ids:[9101],list_trace:traces.indexOf(list),compute_trace:traces.indexOf(compute),list_body_sha256:list.response.sha256,
          compute_body_sha256:compute.response.sha256,raw_cents:String(raw),pay_cents:String(pay),display_pay:moneyText(pay)};
      }
      if(['manage','managementSelected','collected','singleDeleted','batchDeleted'].includes(name)){expect(data.management).toBe(true);expect(data.budget).toBe(false);}
      if(['managementSelected','collected'].includes(name))expect(data.rows.filter((row:Row)=>row.checked==='true').map((row:Row)=>row.id).sort()).toEqual([9101,9111]);
      if(name==='collected')expect(data.bodyText).toContain('收藏成功');
      if(name==='other')expect(ids).toEqual([9107]);if(name==='guest'){expect(ids).toEqual([]);expect(data.bodyText).toContain('请先登录');}
      if(name!=='guest')expect(data.footer).toBe(true);
      evidence.push({name,...data,traceCount:traces.length,snapshot:remember(expected)});json(res,{status:'accepted',name,next:stage()});
      if(name==='finished'){expect(writes).toBe(4);expect(external).not.toHaveBeenCalled();expect(await sources()).toEqual(sourceBefore);expect(await artifacts()).toEqual(buildBefore);done();}
    });return;}
    if(url.pathname.startsWith('/api/')){await api(req,res,url);return;}
    if(url.pathname==='/'){send(res,shell);return;}if(url.pathname==='/favicon.ico'){send(res,'',204);return;}
    const pathname=decodeURIComponent(url.pathname),path=pathname==='/__h5'?resolve(h5,'index.html'):resolve(h5,'.'+pathname);expect(path===resolve(h5,'index.html')||path.startsWith(h5+sep)).toBe(true);
    let raw=await readFile(path);const mime:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.gif':'image/gif','.woff2':'font/woff2'};
    if(pathname==='/__h5')raw=Buffer.from(raw.toString().replace('<head>','<head><link rel="icon" href="data:,">'));
    staticPaths.push({path:pathname,sha256:hash(raw),status:200});send(res,raw,200,mime[extname(path)]??'application/octet-stream');
  })().catch(error=>{failure??=error;fail(error);if(!res.headersSent)send(res,String(error),500,'text/plain');else res.end();});});
  ownedServer=server;timer=setTimeout(()=>fail(Error('Cart Browser acceptance timed out')),32*60_000);
  try {
    await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(40829,'127.0.0.1',yes);});
    await writeFile(prefix+'ready.json',JSON.stringify({origin,plans,prefix,source_count:sourceBefore.length,build_count:buildBefore.length})+'\n');
    console.log('CART_MANAGEMENT_BROWSER_READY '+origin);await completion;await queue;
    await writeFile(prefix+'evidence.json',JSON.stringify({status:'passed',evidence,traces,staticPaths,snapshots_by_sha256:snapshots,setup:{before:preparedBefore,after:prepared},final:expected,resources_before:initialResources,resources_after:resources(),sourceBefore,sourceAfter:await sources(),buildBefore,buildAfter:await artifacts()},null,2)+'\n');
  } catch(error){failure??=error;await writeFile(prefix+'failed.json',JSON.stringify({error:String(error),failedDispatch,evidence,traces,staticPaths,snapshots_by_sha256:snapshots},null,2)+'\n');throw error;}
  } catch(error){failure??=error;throw error;}
  finally{
    clearTimeout(timer);let cleanupFailure:unknown,fixtureClosed=false;
    try{if(ownedServer){ownedServer.closeAllConnections();if(ownedServer.listening)await new Promise<void>((yes,no)=>ownedServer!.close(error=>error?no(error):yes()));}}
    catch(error){cleanupFailure=error;}
    try{await f.close();fixtureClosed=true;}catch(error){cleanupFailure??=error;}
    wiring.container=undefined;vi.restoreAllMocks();
    await writeFile(prefix+'cleanup.json',JSON.stringify({server_created:!!ownedServer,server_closed:!ownedServer?.listening,fixture_closed:fixtureClosed,
      failure:failure?String(failure):null,cleanup_failure:cleanupFailure?String(cleanupFailure):null})+'\n');
    if(cleanupFailure)throw cleanupFailure;
  }
},34*60_000);
