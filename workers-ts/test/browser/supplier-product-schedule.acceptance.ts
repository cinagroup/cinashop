/** Actual production Supplier plan author, App/JWT, independent PG16 writer
 * and the mature scheduler. All control state and data are owned local fixtures. */
import {expect,it,vi} from 'vitest';
import {createServer,type ServerResponse} from 'node:http';
import {readFile,stat,writeFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SQL,sql} from 'drizzle-orm';
import {getTableConfig,PgDialect} from 'drizzle-orm/pg-core';
import {createApp} from '@/app';
import {storeProductRule} from '@/models/schema';
import {ProductAutoShelfService} from '@/services/product/ProductAutoShelfService';
import type {Container} from '@/lib/di';
import type {Env,ProductAutoShelfMessage} from '@/env';
import {supplierProductScheduleFixture} from '../helpers/supplierProductSchedule';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{
 if(!wiring.container)throw Error('Missing owned schedule writer');return wiring.container;
}}));
it('authors, rereads, executes and cancels a Supplier shelf plan without approving the product and invalidates session ABA in IAB',async()=>{
 const root=resolve(import.meta.dirname,'../../../view/supplier-ts/dist');expect((await stat(resolve(root,'index.html'))).isFile()).toBe(true);
 const f=await supplierProductScheduleFixture(),app=createApp(),control='/__supplier_product_schedule_fixture/'+randomUUID();
 const dialect=new PgDialect(),definition=getTableConfig(storeProductRule),columns=definition.columns.map(column=>{
  const initial=column.default,defaultSql=initial===undefined?'':` default ${initial instanceof SQL?dialect.sqlToQuery(initial).sql:dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
  return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull?' not null':''}${column.primary?' primary key':''}`;
 });
 await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);
 const snapshot=async()=>({...await f.snapshot(),[definition.name]:await f.exec(`SELECT to_jsonb(t)AS row FROM public."${definition.name}" t ORDER BY to_jsonb(t)::text`)});
 const baseline=await snapshot(),initialSequences=await f.sequences(),paths:any[]=[],timerResults:any[]=[],held:Array<{deliver:()=>void;destroyed:()=>boolean}>=[],releaseAttempts:any[]=[];
 const env={...f.env,NODE_ENV:'test',CONFIG_KV:{get:async(key:string)=>key==='cfg_system_statistics'?'':null,put:async()=>{},delete:async()=>{}}}as unknown as Env;
 let origin='',chain=Promise.resolve(),armHold=false,heldCount=0,sessionChanges=0,finished=false,outbound=0,queueCalls=0,scheduler:ProductAutoShelfService|undefined,roles:any[]=[];
 let finish!:()=>void,fail!:(cause:Error)=>void,deadline:ReturnType<typeof setTimeout>|undefined;
 const completion=new Promise<void>((yes,no)=>{finish=yes;fail=no;});
 const product=(state:Record<string,any[]>)=>state.store_product.find(item=>item.row.id===80)!.row;
 const state=()=>({finished,outbound,queueCalls,heldCount,sessionChanges,releaseAttempts,paths,timerResults,roles});
 function send(res:ServerResponse,body:string|Buffer,status=200,type='text/html; charset=utf-8'){
  if(res.destroyed)return;res.writeHead(status,{'Content-Type':type,'Cache-Control':'private, no-store'});res.end(body);
 }
 const server=createServer((req,res)=>{void(async()=>{
  if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==new URL(origin).host)return send(res,'Owned loopback only',403);
  const url=new URL(req.url??'/',origin),path=url.pathname,method=req.method??'GET';
  if(path===control&&method==='GET')return send(res,`<!doctype html><html lang="zh"><meta charset="utf-8"><title>Supplier定时计划PG16本机验收</title><h1>定时计划作者与执行</h1><p>仅本机合成商品；真实Supplier写入及独立只改可见性的成熟执行器。</p><button id="enter">进入商品编辑</button><button id="run">执行已到期计划</button><button id="cancelled">执行取消后的计划</button><button id="hold">扣留下一编辑读取</button><button id="other">切换只读合成账号</button><button id="restore">恢复管理合成账号</button><button id="release">释放已扣留读取</button><button id="status">读取验收状态</button><button id="finish">完成并关闭夹具</button><pre></pre><script>
   const control=${JSON.stringify(control)},tokens=${JSON.stringify(f.tokens)};
   function session(manager=true){localStorage.setItem('supplier-token',manager?tokens.manager:tokens.viewer);localStorage.setItem('supplier-user',JSON.stringify({id:manager?21:22,supplier_id:7,supplier_name:'本机计划供应商'}));localStorage.setItem('supplier-permissions',JSON.stringify(manager?['supplier.product.view','supplier.product.manage']:['supplier.product.view']));}
   document.getElementById('enter').onclick=()=>{session();location.href='/products/80/edit';};
   for(const action of ['run','cancelled','hold','other','restore','release','status','finish'])document.getElementById(action).onclick=async()=>{const response=await fetch(control+'/'+action,{method:'POST'});document.querySelector('pre').textContent=await response.text();if(!response.ok)return;if(action==='other')session(false);if(action==='restore')session();};</script>`);
  if(path.startsWith(control+'/')){
   expect(method).toBe('POST');expect(req.headers.origin).toBe(origin);await chain;
   if(path.endsWith('/run')||path.endsWith('/cancelled')){
    const before=await snapshot(),sequences=await f.sequences(),cutoff=Math.floor(Date.now()/1000)-1;
    const message:ProductAutoShelfMessage={action:'processProductAutoShelf',job:'product_auto_shelf',scheduledAt:cutoff*1000,runId:`scheduled:${cutoff*1000}`,productId:80};
    const result=await scheduler!.process(message),after=await snapshot();
    if(path.endsWith('/run')){
     expect(timerResults).toHaveLength(0);expect(product(before)).toMatchObject({auto_on_time:1577836800,auto_off_time:0,is_show:0,is_verify:0});
     const expected=structuredClone(before);product(expected).is_show=1;expect(after).toEqual(expected);expect(result).toMatchObject({isShow:1,transitions:['on']});
    }else{
     expect(timerResults).toHaveLength(1);expect(product(before)).toMatchObject({auto_on_time:0,auto_off_time:0,is_show:0,is_verify:0});expect(after).toEqual(before);expect(result).toMatchObject({reason:'no_longer_eligible'});
    }
    expect(await f.sequences()).toEqual(sequences);timerResults.push({result,only_visibility_changed:path.endsWith('/run'),approval_unchanged:true});
   }
   if(path.endsWith('/hold')){expect(heldCount).toBe(0);armHold=true;}
   if(path.endsWith('/other')){expect(held).toHaveLength(1);expect(sessionChanges).toBe(0);sessionChanges++;}
   if(path.endsWith('/restore')){expect(sessionChanges).toBe(1);sessionChanges++;}
   if(path.endsWith('/release')){expect(sessionChanges).toBe(2);expect(held).toHaveLength(1);while(held.length){const item=held.shift()!;releaseAttempts.push({socket_destroyed:item.destroyed()});item.deliver();}}
   if(path.endsWith('/finish')){
    expect(timerResults).toHaveLength(2);expect(heldCount).toBe(1);expect(armHold).toBe(false);expect(held).toHaveLength(0);expect(sessionChanges).toBe(2);expect(releaseAttempts).toHaveLength(1);expect(outbound).toBe(0);expect(queueCalls).toBe(0);
    const writes=paths.filter(row=>row.method==='POST');expect(writes).toHaveLength(2);
    expect(writes[0].body).toMatchObject({auto_on_time:1577836800,auto_off_time:0});expect(writes[1].body.auto_on_time).toBe(0);expect(writes[1].body).not.toHaveProperty('auto_off_time');
    expect(paths.some(row=>row.path==='/api/get_script'&&row.status===200)).toBe(true);expect(paths.filter(row=>row.method==='GET'&&row.path==='/supplierapi/product/product/80').length).toBeGreaterThanOrEqual(4);
    const after=await snapshot(),sequences=await f.sequences();expect(product(after)).toMatchObject({auto_on_time:0,auto_off_time:0,is_show:0,is_verify:0});
    for(const name of Object.keys(baseline))if(!new Set(['store_product','store_product_attr','store_product_attr_result','store_product_attr_value','store_product_relation','store_product_description','store_product_stock_record','store_cart']).has(name))expect(after[name],name).toEqual(baseline[name]);
    for(const name of ['store_product','store_product_attr','store_product_attr_result','store_product_attr_value','store_product_relation','store_product_description','store_product_stock_record','store_cart'])expect(after[name].filter((item: { row: Record<string, unknown> })=>(name==='store_product'?item.row.id:item.row.product_id)!==80),name).toEqual(baseline[name].filter((item: { row: Record<string, unknown> })=>(name==='store_product'?item.row.id:item.row.product_id)!==80));
    const mutableSequences=new Set(['store_product_attr_id_seq','store_product_attr_result_id_seq','store_product_attr_value_id_seq','store_product_relation_id_seq','store_product_stock_record_id_seq']);
    expect(sequences.filter(item=>!mutableSequences.has(item.name))).toEqual(initialSequences.filter(item=>!mutableSequences.has(item.name)));
    finished=true;await writeFile('/tmp/cinashop-supplier-product-schedule-browser-result.json',JSON.stringify({...state(),baseline,final:after,initial_sequences:initialSequences,final_sequences:sequences},null,2)+'\n');
   }
   send(res,JSON.stringify(state()),200,'application/json');if(finished)finish();return;
  }
  if(path.startsWith('/supplierapi/')||path==='/api/get_script'){
   expect(method==='GET'||method==='POST'&&path==='/supplierapi/product/product/80').toBe(true);
   expect(['/api/get_script','/supplierapi/product/category/tree','/supplierapi/product/product/get_rule','/supplierapi/product/product_label','/supplierapi/product/product/list','/supplierapi/product/product/80'].includes(path),method+' '+path).toBe(true);
   let release!:()=>void;const previous=chain;chain=new Promise(done=>{release=done;});await previous;
   let bytes=Buffer.alloc(0),status=200,headers:Record<string,string>={},hold=false;
   try{
    const before=await snapshot(),sequences=await f.sequences();let input:Record<string,unknown>|undefined;
    if(method==='POST'){const chunks:Buffer[]=[];let total=0;for await(const part of req){const chunk=Buffer.from(part);total+=chunk.length;expect(total).toBeLessThan(1024*1024);chunks.push(chunk);}input=JSON.parse(Buffer.concat(chunks).toString());}
    const response=await app.request(path+url.search,{method,headers:{...(req.headers.authorization?{Authorization:req.headers.authorization}:{}),...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})},env);
    bytes=Buffer.from(await response.arrayBuffer());status=response.status;headers=Object.fromEntries(response.headers);
    const envelope=path.startsWith('/supplierapi/')?JSON.parse(bytes.toString()):undefined;
    paths.push({path,method,status,envelope:envelope?.status,...(input?{body:input}:{}),...(path.endsWith('/80')&&method==='GET'?{plans:{auto_on_time:envelope?.data.auto_on_time,auto_off_time:envelope?.data.auto_off_time}}:{})});expect(status,method+' '+path).toBe(200);if(envelope)expect(envelope.status,method+' '+path).toBe(200);
    if(method==='GET'){expect(await snapshot()).toEqual(before);expect(await f.sequences()).toEqual(sequences);if(path.endsWith('/80')&&armHold){armHold=false;heldCount++;hold=true;}}
    else{expect(envelope.data).toMatchObject({id:80,is_show:0,is_verify:0});const actual=product(await snapshot());if(Object.hasOwn(input!,'auto_on_time'))expect(actual.auto_on_time).toBe(input!.auto_on_time);expect(actual.is_verify).toBe(0);expect(actual.is_show).toBe(0);}
   }finally{release();}
   const deliver=()=>{if(!res.destroyed){res.writeHead(status,headers);res.end(bytes);}};
   if(hold)held.push({deliver,destroyed:()=>res.destroyed});else deliver();return;
  }
  if(path==='/favicon.ico')return send(res,'',204);
  if(path==='/owned-media/schedule.png')return send(res,'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#e4eef9"/><text x="20" y="84">OWNED SCHEDULE</text></svg>',200,'image/svg+xml');
  const target=resolve(root,'.'+path),candidate=target.startsWith(root+sep)?target:'';
  try{if(candidate&&(await stat(candidate)).isFile())return send(res,await readFile(candidate),200,({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}as Record<string,string>)[extname(candidate)]??'application/octet-stream');}catch{/* SPA */}
  send(res,await readFile(resolve(root,'index.html')));
 })().catch(cause=>{fail(cause instanceof Error?cause:Error(String(cause)));if(!res.headersSent)send(res,'Owned schedule acceptance assertion failed',500);else res.destroy();});});
 const external=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{outbound++;throw Error('Owned schedule forbids backend provider fetch');});
 try{await f.withWriter(async writer=>f.withScheduler(async timer=>{
  await f.exec(`GRANT SELECT ON public.store_product_rule,public.store_product_label,public.category TO "${writer.role}"`);
  wiring.container=writer.container;scheduler=new ProductAutoShelfService(timer.container,{ORDER_QUEUE:{sendBatch:async()=>{queueCalls++;throw Error('Process must not dispatch a queue batch');}}as unknown as Env['ORDER_QUEUE']});
  for(const[profile,runtime]of[['writer',writer],['scheduler',timer]]as const){const[row]=await runtime.db.execute(sql`SELECT current_user AS role,has_table_privilege(current_user,'public.store_product','SELECT')AS readable,has_column_privilege(current_user,'public.store_product','is_show','UPDATE')AS visibility_update,has_column_privilege(current_user,'public.store_product','is_verify','UPDATE')AS approval_update`);roles.push({profile,...row});}
  expect(roles[1]).toMatchObject({readable:true,visibility_update:true,approval_update:false});
  await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const address=server.address();if(!address||typeof address==='string')throw Error('Missing owned schedule origin');origin=`http://127.0.0.1:${address.port}`;
  process.stdout.write('SUPPLIER_SCHEDULE_BROWSER_READY '+JSON.stringify({control:origin+control,editor:origin+'/products/80/edit',products:origin+'/products'})+'\n');
  deadline=setTimeout(()=>fail(Error('Supplier schedule Browser finish not received')),15*60_000);await completion;process.stdout.write('SUPPLIER_SCHEDULE_BROWSER_RESULT '+JSON.stringify(state())+'\n');
 }));}finally{if(deadline)clearTimeout(deadline);external.mockRestore();wiring.container=undefined;held.length=0;server.closeAllConnections();if(server.listening)await new Promise<void>(yes=>server.close(()=>yes()));await f.close();}
},16*60_000);
