/** Production application UI, real JWT/App and one independent minimal PG16
 * LOGIN. Every balance and account is owned synthetic fixture data. */
import {expect,it,vi} from 'vitest';
import {createServer,type ServerResponse} from 'node:http';
import {readFile,stat,writeFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {createApp} from '@/app';
import type {Container} from '@/lib/di';
import type {Env} from '@/env';
import {systemRole} from '@/models/schema';
import {supplierExtractApplicationFixture} from '../helpers/supplierExtractApplication';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{
 if(!wiring.container)throw Error('Missing owned application LOGIN');return wiring.container;
}}));
it('reserves one withdrawal per original key and recovers discarded results, cross-tab pending claims and fenced in-flight submissions through IAB',async()=>{
 const root=resolve(import.meta.dirname,'../../../view/supplier-ts/dist');expect((await stat(resolve(root,'index.html'))).isFile()).toBe(true);
 const f=await supplierExtractApplicationFixture(),app=createApp(),control='/__supplier_extract_application_fixture/'+randomUUID();
 const statisticsScript='globalThis.__ownedSupplierExtractApplicationStatistics = 1;';
 const env={...f.env,NODE_ENV:'test',CONFIG_KV:{get:async(key:string)=>key==='cfg_system_statistics'?statisticsScript:null,put:async()=>{},delete:async()=>{}}}as unknown as Env;
 const baseline=await f.snapshot(),paths:any[]=[],commits:any[]=[],closed:string[]=[],held:Array<()=>Promise<void>>=[];
 let armBefore=false,armAfter=false,armDrop=false,heldBefore=0,heldAfter=0,released=0,dropped=0,readonlyGets=0,unknownReads=0,delayedRejected=0;
 let recoveredAfterRevoke=false,withdrawn=false,restored=false,scriptSeen=false,imageSeen=false,finished=false,outbound=0,origin='';
 let chain=Promise.resolve(),finish!:()=>void,fail!:(cause:Error)=>void,deadline:ReturnType<typeof setTimeout>|undefined;
 const completion=new Promise<void>((yes,no)=>{finish=yes;fail=no;});
 const canonical=(s:Record<string,any[]>)=>Object.fromEntries(Object.entries(s).map(([table,rows])=>[table,rows.map(row=>JSON.stringify(row)).sort()]));
 const state=()=>({finished,outbound,readonlyGets,unknownReads,heldBefore,heldAfter,released,dropped,delayedRejected,recoveredAfterRevoke,withdrawn,restored,scriptSeen,imageSeen,commits,closed,paths});
 const money=(n:bigint)=>`${n/100n}.${String(n%100n).padStart(2,'0')}`;
 const available=()=>money(73500n-commits.reduce((sum,row)=>sum+BigInt(row.extract_price.replace('.','')),0n));
 function send(res:ServerResponse,body:string|Buffer,status=200,type='text/html; charset=utf-8'){
  if(res.destroyed)return;res.writeHead(status,{'Content-Type':type,'Cache-Control':'private, no-store'});res.end(body);
 }
 function onlyAppend(before:Record<string,any[]>,after:Record<string,any[]>,extractId:number|null,operationId:string){
  const normalized=structuredClone(after),operations=normalized.supplier_extract_application_operation_v1;
  const op=operations.filter(row=>row.row.operation_id===operationId);expect(op).toHaveLength(1);expect(op[0].row).toMatchObject({actor_id:21,supplier_id:7,extract_id:extractId,state:extractId===null?'not_applied':'committed'});
  normalized.supplier_extract_application_operation_v1=operations.filter(row=>row.row.operation_id!==operationId);
  if(extractId!==null){const rows=normalized.supplier_extract.filter(row=>row.row.id===extractId);expect(rows).toHaveLength(1);expect(rows[0].row.supplier_id).toBe(7);normalized.supplier_extract=normalized.supplier_extract.filter(row=>row.row.id!==extractId);}
  expect(canonical(normalized)).toEqual(canonical(before));
 }
 async function business(path:string,search:string,method:string,authorization:string|undefined,raw:string,res:ServerResponse,delayed=false){
  let release!:()=>void;const previous=chain;chain=new Promise(done=>{release=done;});await previous;
  let body='',status=200,headers:Record<string,string>={},drop=false,hold=false;
  try{
   const before=await f.snapshot(),sequence=await f.sequence();
   const response=await app.request(path+search,{method,headers:{...(authorization?{Authorization:authorization}:{}),...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:raw}:{})},env);
   body=await response.text();status=response.status;headers=Object.fromEntries(response.headers);const after=await f.snapshot(),nextSequence=await f.sequence();
   if(path==='/api/get_script'){expect(method).toBe('GET');expect(status).toBe(200);expect(headers['content-type']).toBe('application/javascript; charset=utf-8');expect(body).toBe(statisticsScript);scriptSeen=true;expect(after).toEqual(before);expect(nextSequence).toEqual(sequence);readonlyGets++;}
   else{
    expect(headers['cache-control']).toContain('private, no-store');const value=JSON.parse(body);paths.push({path,method,query:search,app_status:status,envelope:value.status,delayed});
    if(method==='GET'){
     expect(after).toEqual(before);expect(nextSequence).toEqual(sequence);readonlyGets++;expect(value.status).toBe(200);
     if(path.endsWith('/cash')){expect(Object.keys(value.data)).toHaveLength(9);expect(value.data).toMatchObject({version:'supplier-extract-application-seed-v1',actor_id:21,supplier_id:7,available:available(),min_price:'5.50',max_price:'200.00',can_apply:true});}
     else{expect(path).toMatch(/^\/supplierapi\/finance\/supplier_extract\/application_operations\/[a-f0-9-]+$/);expect(Object.keys(value.data)).toHaveLength(7);expect(value.data).toMatchObject({version:'supplier-extract-application-receipt-v1',actor_id:21,supplier_id:7});if(value.data.state==='unknown')unknownReads++;if(value.data.state==='committed'&&withdrawn)recoveredAfterRevoke=true;}
    }else if(path.endsWith('/cash')){
     const input=JSON.parse(raw);expect(Object.keys(input).sort()).toEqual(['extract_type','mark','money','operation_id','revision']);
     if(delayed){expect(value.status).toBe(409);expect(after).toEqual(before);expect(nextSequence).toEqual(sequence);expect(closed).toContain(input.operation_id);delayedRejected++;}
     else{
      expect(value.status).toBe(200);expect(Object.keys(value.data)).toHaveLength(7);expect(value.data).toMatchObject({version:'supplier-extract-application-receipt-v1',operation_id:input.operation_id,actor_id:21,supplier_id:7,state:'committed'});
      const result=value.data.result;expect(Object.keys(result)).toHaveLength(13);expect(result.id).toBe(205+commits.length);expect(nextSequence).toEqual([{last_value:String(result.id),is_called:true}]);expect(result).toMatchObject({extract_type:input.extract_type,extract_price:input.money,supplier_mark:input.mark,status:0,pay_status:0});
      expect(commits.some(row=>row.operation_id===input.operation_id||row.id===result.id)).toBe(false);onlyAppend(before,after,result.id,input.operation_id);
      commits.push({...result,operation_id:input.operation_id,request_hash:value.data.request_hash,actual_app_status:status,actual_app_body_sha256:createHash('sha256').update(body).digest('hex')});expect(result.balance).toBe(available());
      drop=armDrop;hold=armAfter;if(drop){armDrop=false;dropped++;}if(hold){armAfter=false;heldAfter++;}
     }
    }else{
     expect(path).toMatch(/^\/supplierapi\/finance\/supplier_extract\/application_operations\/[a-f0-9-]+\/resolve$/);expect(JSON.parse(raw)).toEqual({});expect(value.status).toBe(200);
     expect(value.data).toMatchObject({state:'not_applied',request_hash:'',result:null});onlyAppend(before,after,null,value.data.operation_id);expect(nextSequence).toEqual(sequence);closed.push(value.data.operation_id);
    }
   }
  }finally{release();}
  if(drop)return send(res,JSON.stringify({status:503,msg:'Owned committed application acknowledgement discarded',data:null}),503,'application/json');
  const deliver=async()=>{if(!res.destroyed){res.writeHead(status,headers);res.end(body);}};if(hold)held.push(deliver);else await deliver();
 }
 const server=createServer((req,res)=>{void(async()=>{
  if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==new URL(origin).host)return send(res,'Owned loopback only',403);
  const url=new URL(req.url??'/',origin),path=url.pathname,method=req.method??'GET';
  if(path===control&&method==='GET')return send(res,`<!doctype html><html lang="zh"><meta charset="utf-8"><title>原提现申请 PG16 本机验收</title><h1>原提现申请与丢回执恢复联合验收</h1><p>合成账目735元；独立LOGIN只插入申请与不可变回执。不得真实银行支付。银行25.50元实际提交后丢失HTTP回执；撤销两项财务权后仍核对原结果；5.50元业务前扣留、封存后释放应409；支付宝10元成功回执再扣留，跨窗口不得重发。最终仅两次申请，余额699.50。</p>
   <button id="login">进入申请</button><button id="before">扣留下一申请进入业务前</button><button id="after">扣留下一成功回执</button><button id="drop">丢失下一申请回执</button><button id="release">释放已扣留回复</button><button id="withdraw">撤销夹具财务权限</button><button id="restore">恢复夹具财务权限</button><button id="status">读取验收状态</button><button id="finish">完成并关闭夹具</button><pre></pre><script>
   const control=${JSON.stringify(control)},tokens=${JSON.stringify(f.tokens)};function session(){localStorage.setItem('supplier-token',tokens.reader);localStorage.setItem('supplier-user',JSON.stringify({id:21,supplier_id:7,supplier_name:'本机提现申请供应商'}));localStorage.setItem('supplier-permissions',JSON.stringify(['supplier.finance.view','supplier.finance.manage']));}document.getElementById('login').onclick=()=>{session();location.href='/finance/apply';};for(const action of ['before','after','drop','release','withdraw','restore','status','finish'])document.getElementById(action).onclick=async()=>{const response=await fetch(control+'/'+action,{method:'POST'});document.querySelector('pre').textContent=await response.text();if(response.ok&&action==='withdraw')localStorage.setItem('supplier-permissions','[]');if(response.ok&&action==='restore')localStorage.setItem('supplier-permissions',JSON.stringify(['supplier.finance.view','supplier.finance.manage']));};</script>`);
  if(path.startsWith(control+'/')){
   expect(method).toBe('POST');expect(req.headers.origin).toBe(origin);await chain;
   if(path.endsWith('/before')){expect(armBefore).toBe(false);armBefore=true;}
   if(path.endsWith('/after')){expect(armAfter).toBe(false);armAfter=true;}
   if(path.endsWith('/drop')){expect(armDrop).toBe(false);armDrop=true;}
   if(path.endsWith('/release')){expect(held.length).toBeGreaterThan(0);while(held.length){released++;await held.shift()!();}}
   if(path.endsWith('/withdraw')){await f.db.update(systemRole).set({rules:''}).where(eq(systemRole.id,21));withdrawn=true;}
   if(path.endsWith('/restore')){expect(recoveredAfterRevoke).toBe(true);await f.db.update(systemRole).set({rules:'supplier.finance.view,supplier.finance.manage'}).where(eq(systemRole.id,21));withdrawn=false;restored=true;}
   if(path.endsWith('/finish')){
    expect(armBefore||armAfter||armDrop||withdrawn).toBe(false);expect(held).toHaveLength(0);expect(heldBefore).toBe(1);expect(heldAfter).toBe(1);expect(released).toBe(2);expect(dropped).toBe(1);expect(delayedRejected).toBe(1);
    expect(recoveredAfterRevoke&&restored&&scriptSeen&&imageSeen).toBe(true);expect(unknownReads).toBeGreaterThanOrEqual(1);expect(commits).toHaveLength(2);expect(closed).toHaveLength(1);expect(commits.map(row=>row.extract_price)).toEqual(['25.50','10.00']);expect(commits.map(row=>row.extract_type)).toEqual(['bank','alipay']);expect(available()).toBe('699.50');expect(outbound).toBe(0);
    const final=await f.snapshot(),normalized=structuredClone(final);normalized.supplier_extract=normalized.supplier_extract.filter((row:{row:{id:number}})=>!commits.some(item=>item.id===row.row.id));normalized.supplier_extract_application_operation_v1=[];expect(canonical(normalized)).toEqual(canonical(baseline));expect(final.supplier_extract_application_operation_v1).toHaveLength(3);expect(await f.sequence()).toEqual([{last_value:'206',is_called:true}]);
    expect(paths.filter(row=>row.method==='POST'&&row.path.endsWith('/cash'))).toHaveLength(3);expect(paths.filter(row=>row.method==='POST'&&row.path.endsWith('/resolve'))).toHaveLength(1);finished=true;
    await writeFile('/tmp/cinashop-supplier-extract-application-browser-result.json',JSON.stringify(state(),null,2)+'\n');
   }
   send(res,JSON.stringify(state()),200,'application/json');if(finished)finish();return;
  }
  if(path==='/owned-media/application-alipay.png'||path==='/owned-media/application-weixin.png'){
   expect(method).toBe('GET');imageSeen=true;return send(res,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8l8AAAAASUVORK5CYII=','base64'),200,'image/png');
  }
  if(path.startsWith('/supplierapi/')||path==='/api/get_script'){
   expect(['GET','POST']).toContain(method);let raw='';if(method==='POST'){for await(const part of req)raw+=part.toString();expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(4096);}
   if(path==='/supplierapi/finance/supplier_extract/cash'&&method==='POST'&&armBefore){armBefore=false;heldBefore++;held.push(()=>business(path,url.search,method,req.headers.authorization,raw,res,true));return;}
   return business(path,url.search,method,req.headers.authorization,raw,res);
  }
  if(path==='/favicon.ico')return send(res,'',204);
  const filename=resolve(root,'.'+path),candidate=filename.startsWith(root+sep)?filename:'';
  try{if(candidate&&(await stat(candidate)).isFile())return send(res,await readFile(candidate),200,({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}as Record<string,string>)[extname(candidate)]??'application/octet-stream');}catch{/* SPA */}
  return send(res,await readFile(resolve(root,'index.html')));
 })().catch(error=>{fail(error instanceof Error?error:Error(String(error)));if(!res.headersSent)send(res,'Owned application acceptance assertion failed',500);else res.destroy();});});
 const external=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{outbound++;throw Error('Withdrawal application Browser forbids backend outbound fetch');});
 try{await f.withWriter(async runtime=>{
  wiring.container=runtime.container;await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const address=server.address();if(!address||typeof address==='string')throw Error('Missing owned application origin');origin=`http://127.0.0.1:${address.port}`;
  process.stdout.write('SUPPLIER_EXTRACT_APPLICATION_BROWSER_READY '+JSON.stringify({control:origin+control,application:origin+'/finance/apply',recovery:origin+'/finance/application-result'})+'\n');deadline=setTimeout(()=>fail(Error('Supplier application Browser finish not received')),18*60_000);await completion;process.stdout.write('SUPPLIER_EXTRACT_APPLICATION_BROWSER_RESULT '+JSON.stringify(state())+'\n');
 });}finally{if(deadline)clearTimeout(deadline);external.mockRestore();wiring.container=undefined;held.length=0;server.closeAllConnections();if(server.listening)await new Promise<void>(yes=>server.close(()=>yes()));await f.close();}
},19*60_000);
