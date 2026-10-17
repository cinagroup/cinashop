/** Production Vue, real App/JWT and a strictly read-only owned PG16 LOGIN. */
import {expect,it,vi} from 'vitest';
import {createServer,type ServerResponse} from 'node:http';
import {readFile,stat,writeFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {createApp} from '@/app';
import type {Container} from '@/lib/di';
import type {Env} from '@/env';
import {supplierProductDetailFixture} from '../helpers/supplierProductDetail';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{
 if(!wiring.container)throw Error('Missing owned product-view reader');return wiring.container;
}}));
it('opens product details as a view-only account, reads delegated media and isolates product and session changes through IAB',async()=>{
 const root=resolve(import.meta.dirname,'../../../view/supplier-ts/dist');expect((await stat(resolve(root,'index.html'))).isFile()).toBe(true);
 const f=await supplierProductDetailFixture(),app=createApp(),control='/__supplier_product_detail_fixture/'+randomUUID();
 // Seed a valid historical long name before the immutable browser baseline.
 // Every business request below still runs through the SELECT-only reader.
 // The mature list consumes its cover directly; delegated private media is
 // exercised by the detail slider, active SKU and description, not that list.
 await f.exec("UPDATE public.store_product SET image='/owned-media/product80.png',store_name='本机商品甲 "+'PRODUCT'.repeat(16)+"' WHERE id=80");
 const env={...f.env,NODE_ENV:'test',CONFIG_KV:{get:async(key:string)=>key==='cfg_system_statistics'?'':null,put:async()=>{},delete:async()=>{}}}as unknown as Env;
 const baseline=await f.snapshot(),initialSequences=await f.sequences(),paths:any[]=[],held:Array<{deliver:()=>void;destroyed:()=>boolean}>=[],releaseAttempts:any[]=[];
 let origin='',chain=Promise.resolve(),armHold=false,heldCount=0,sessionChanges=0,finished=false,outbound=0,proof:any;
 let finish!:()=>void,fail!:(cause:Error)=>void,deadline:ReturnType<typeof setTimeout>|undefined;
 const completion=new Promise<void>((yes,no)=>{finish=yes;fail=no;});
 const state=()=>({finished,outbound,heldCount,sessionChanges,releaseAttempts,paths,reader:proof,objectCalls:f.objectCalls});
 function send(res:ServerResponse,body:string|Buffer,status=200,type='text/html; charset=utf-8'){
  if(res.destroyed)return;res.writeHead(status,{'Content-Type':type,'Cache-Control':'private, no-store'});res.end(body);
 }
 const server=createServer((req,res)=>{void(async()=>{
  if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==new URL(origin).host)return send(res,'Owned loopback only',403);
  const url=new URL(req.url??'/',origin),path=url.pathname,method=req.method??'GET';
  if(path===control&&method==='GET')return send(res,`<!doctype html><html lang="zh"><meta charset="utf-8"><title>商品只读详情 PG16 本机验收</title><h1>只读商品详情</h1><p>仅本机合成商品、受限纯SELECT角色与已登记的合成媒体。</p><button id="enter">进入只读商品列表</button><button id="hold">扣留下一详情读取</button><button id="other">切换管理合成账号</button><button id="restore">恢复只读合成账号</button><button id="release">释放已扣留详情</button><button id="status">读取验收状态</button><button id="finish">完成并关闭夹具</button><pre></pre><script>
   const control=${JSON.stringify(control)},tokens=${JSON.stringify(f.tokens)};
   function session(manage=false){localStorage.setItem('supplier-token',manage?tokens.reader:tokens.viewer);localStorage.setItem('supplier-user',JSON.stringify({id:manage?21:22,supplier_id:7,supplier_name:'本机只读商品供应商'}));localStorage.setItem('supplier-permissions',JSON.stringify(manage?['supplier.product.view','supplier.product.manage']:['supplier.product.view']));}
   document.getElementById('enter').onclick=()=>{session();location.href='/products';};
   for(const action of ['hold','other','restore','release','status','finish'])document.getElementById(action).onclick=async()=>{const response=await fetch(control+'/'+action,{method:'POST'});document.querySelector('pre').textContent=await response.text();if(!response.ok)return;if(action==='other')session(true);if(action==='restore')session();};</script>`);
  if(path.startsWith(control+'/')){
   expect(method).toBe('POST');expect(req.headers.origin).toBe(origin);await chain;
   if(path.endsWith('/hold')){expect(heldCount).toBe(0);armHold=true;}
   if(path.endsWith('/other')){expect(held).toHaveLength(1);expect(sessionChanges).toBe(0);sessionChanges++;}
   if(path.endsWith('/restore')){expect(sessionChanges).toBe(1);sessionChanges++;}
   if(path.endsWith('/release')){expect(sessionChanges).toBe(2);expect(held).toHaveLength(1);while(held.length){const item=held.shift()!;releaseAttempts.push({socket_destroyed:item.destroyed()});item.deliver();}}
   if(path.endsWith('/finish')){
    expect(heldCount).toBe(1);expect(armHold).toBe(false);expect(held).toHaveLength(0);expect(sessionChanges).toBe(2);expect(releaseAttempts).toHaveLength(1);expect(outbound).toBe(0);
    expect(paths.every(row=>row.method==='GET')).toBe(true);
    expect(paths.some(row=>row.path==='/supplierapi/product/product/list'&&row.envelope===200)).toBe(true);
    for(const id of [80,81])expect(paths.some(row=>row.path===`/supplierapi/product/product/${id}/view`&&row.actor===22&&row.envelope===200)).toBe(true);
    expect(paths.some(row=>row.path==='/api/assets/31'&&row.status===200&&row.mime==='image/png')).toBe(true);
    expect(paths.some(row=>row.path==='/api/get_script'&&row.status===200)).toBe(true);
    const after=await f.snapshot(),sequences=await f.sequences();expect(after).toEqual(baseline);expect(sequences).toEqual(initialSequences);
    expect(f.objectCalls.length).toBeGreaterThan(0);expect(f.objectCalls.every(row=>row.method==='get'&&!row.key.includes('supplier/8/'))).toBe(true);
    finished=true;await writeFile('/tmp/cinashop-supplier-product-detail-browser-result.json',JSON.stringify({...state(),baseline,final:after,initial_sequences:initialSequences,final_sequences:sequences,final_snapshot_sha256:createHash('sha256').update(JSON.stringify(after)).digest('hex')},null,2)+'\n');
   }
   send(res,JSON.stringify(state()),200,'application/json');if(finished)finish();return;
  }
  if(path.startsWith('/supplierapi/')||path==='/api/get_script'||/^\/api\/assets\//.test(path)){
   expect(method).toBe('GET');expect(path==='/api/get_script'||path==='/supplierapi/product/product/list'||/^\/supplierapi\/product\/product\/(80|81)\/view$/.test(path)||/^\/api\/assets\/(31|41)$/.test(path)).toBe(true);
   let release!:()=>void;const previous=chain;chain=new Promise(done=>{release=done;});await previous;
   let bytes=Buffer.alloc(0),status=200,headers:Record<string,string>={},hold=false;
   try{
    const before=await f.snapshot(),sequences=await f.sequences(),actor=req.headers.authorization==='Bearer '+f.tokens.reader?21:22;
    const response=await app.request(path+url.search,{method,headers:{...(req.headers.authorization?{Authorization:req.headers.authorization}:{}),...(req.headers.range?{Range:req.headers.range}:{})}},env);
    bytes=Buffer.from(await response.arrayBuffer());status=response.status;headers=Object.fromEntries(response.headers);
    const envelope=path.startsWith('/supplierapi/')?JSON.parse(bytes.toString()):undefined;
    paths.push({path,query:url.search,method,actor,status,mime:response.headers.get('Content-Type'),envelope:envelope?.status,response:envelope?.data});
    if(path==='/api/assets/41'&&req.headers.range)expect([200,206]).toContain(status);else expect(status,method+' '+path).toBe(200);
    if(envelope)expect(envelope.status).toBe(200);
    expect(await f.snapshot()).toEqual(before);expect(await f.sequences()).toEqual(sequences);
    if(path.endsWith('/view')){
     const data=envelope.data;expect(Object.keys(data)).toHaveLength(9);expect(data.actor_id).toBe(actor);expect(data.supplier_id).toBe(7);expect(data.product_id).toBe(Number(path.split('/').at(-2)));
     expect(bytes.toString()).not.toMatch(/OWNED_.*SECRET|disk_info|card_pwd|original_disk_info|brokerage|settle_price|retired_attrs|<script|<iframe/);
     if(data.product_id===80){expect(data.skus.map((row:any)=>row.id)).toEqual([180,181]);expect(data.media.previews['/api/assets/31'].status).toBe('ready');expect(data.media.previews['/api/assets/32'].status).toBe('unavailable');expect(data.product.video_preview_url).toMatch(/^\/api\/assets\/41\?expires=/);}
     if(armHold){armHold=false;heldCount++;hold=true;}
    }
   }finally{release();}
   const deliver=()=>{if(!res.destroyed){res.writeHead(status,headers);res.end(bytes);}};
   if(hold)held.push({deliver,destroyed:()=>res.destroyed});else deliver();return;
  }
  if(path==='/favicon.ico')return send(res,'',204);
  if(/^\/owned-media\/product(?:80|81)\.png$/.test(path))return send(res,'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#e4eef9"/><text x="18" y="85" font-size="18">OWNED PRODUCT</text></svg>',200,'image/svg+xml');
  const target=resolve(root,'.'+path),candidate=target.startsWith(root+sep)?target:'';
  try{if(candidate&&(await stat(candidate)).isFile())return send(res,await readFile(candidate),200,({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}as Record<string,string>)[extname(candidate)]??'application/octet-stream');}catch{/* SPA */}
  send(res,await readFile(resolve(root,'index.html')));
 })().catch(cause=>{fail(cause instanceof Error?cause:Error(String(cause)));if(!res.headersSent)send(res,'Owned detail acceptance assertion failed',500);else res.destroy();});});
 const external=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{outbound++;throw Error('Owned product detail forbids backend provider fetch');});
 try{await f.withReader(async reader=>{
  wiring.container=reader.container;
  const[row]=await reader.db.execute(sql`SELECT current_user AS role,(SELECT count(*)::int FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p') AND has_table_privilege(current_user,c.oid,'SELECT'))AS readable,(SELECT count(*)::int FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p') AND(has_table_privilege(current_user,c.oid,'INSERT')OR has_table_privilege(current_user,c.oid,'UPDATE')OR has_table_privilege(current_user,c.oid,'DELETE')))AS writable,(SELECT count(*)::int FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='S' AND has_sequence_privilege(current_user,c.oid,'USAGE'))AS sequences`);
  expect(row.readable).toBe(9);expect(row.writable).toBe(0);expect(row.sequences).toBe(0);proof=row;
  await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const address=server.address();if(!address||typeof address==='string')throw Error('Missing owned product view origin');origin=`http://127.0.0.1:${address.port}`;
  process.stdout.write('SUPPLIER_DETAIL_BROWSER_READY '+JSON.stringify({control:origin+control,products:origin+'/products',detail:origin+'/products/80/view'})+'\n');
  deadline=setTimeout(()=>fail(Error('Supplier detail Browser finish not received')),15*60_000);await completion;
  process.stdout.write('SUPPLIER_DETAIL_BROWSER_RESULT '+JSON.stringify(state())+'\n');
 });}finally{if(deadline)clearTimeout(deadline);external.mockRestore();wiring.container=undefined;held.length=0;server.closeAllConnections();if(server.listening)await new Promise<void>(yes=>server.close(()=>yes()));await f.close();}
},16*60_000);
