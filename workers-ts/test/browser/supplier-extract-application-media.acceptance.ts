/** Production UI + actual App/JWT. One original application is created by the
 * existing local fixture before the browser starts; all business HTTP is GET. */
import {expect,it,vi} from 'vitest';
import {createServer,type ServerResponse} from 'node:http';
import {readFile,stat,writeFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {createApp} from '@/app';
import type {Container} from '@/lib/di';
import type {Env} from '@/env';
import {systemRole,systemSupplier} from '@/models/schema';
import {supplierExtractApplicationMediaFixture} from '../helpers/supplierExtractApplicationMedia';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{
 if(!wiring.container)throw Error('Missing owned original application media LOGIN');return wiring.container;
}}));
it('binds private source QR to six values and recovers the immutable original QR after settings change and finance revocation through IAB',async()=>{
 const root=resolve(import.meta.dirname,'../../../view/supplier-ts/dist');expect((await stat(resolve(root,'index.html'))).isFile()).toBe(true);
 const f=await supplierExtractApplicationMediaFixture(),app=createApp(),control='/__supplier_extract_application_media_fixture/'+randomUUID();
 const script='globalThis.__ownedSupplierApplicationMediaStatistics = 1;';
 const env={...f.env,NODE_ENV:'test',CONFIG_KV:{get:async(key:string)=>key==='cfg_system_statistics'?script:null,put:async()=>{},delete:async()=>{}}}as unknown as Env;
 const baseline:Record<string,any[]>=await f.snapshot(),initialSequence=await f.sequence(),initialImages=await f.imageSequence(),paths:any[]=[],issued:any[]=[],assets:any[]=[],roleProofs:any[]=[],releaseAttempts:any[]=[];
 const held:Array<{deliver:()=>void;destroyed:()=>boolean}>=[],containers:Record<string,Container>={};
 const pending={version:'supplier-extract-application-pending-v1',operation_id:f.original.operationId,actor_id:21,supplier_id:7,
  request_hash:f.original.requestHash,money:'25.50',extract_type:'alipay'};
 expect(f.original.extractId).toBe(205);expect(initialSequence).toEqual([{last_value:'205',is_called:true}]);expect(initialImages).toEqual([{last_value:'45',is_called:false}]);
 let origin='',finished=false,outbound=0,scriptSeen=false,seedSeen=false,accountsSeen=false,changed=false,recovered=0,again=0,armHold=false,heldCount=0,sessionChanges=0,chain=Promise.resolve();
 let finish!:()=>void,fail!:(cause:Error)=>void,deadline:ReturnType<typeof setTimeout>|undefined;
 const completion=new Promise<void>((yes,no)=>{finish=yes;fail=no;}),sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
 const state=()=>({finished,outbound,scriptSeen,seedSeen,accountsSeen,changed,recovered,again,heldCount,sessionChanges,releaseAttempts,
  original_operation_id:f.original.operationId,original_request_hash:f.original.requestHash,original_receipt:f.original.receipt,paths,issued,assets,roleProofs,objectCalls:f.objectCalls});
 function send(res:ServerResponse,body:string|Buffer,status=200,type='text/html; charset=utf-8'){
  if(res.destroyed)return;res.writeHead(status,{'Content-Type':type,'Cache-Control':'private, no-store'});res.end(body);
 }
 async function sequences(){expect(await f.sequence()).toEqual(initialSequence);expect(await f.imageSequence()).toEqual(initialImages);}
 function onlyFixtureChanges(after:Record<string,any[]>){
  const normalized=structuredClone(after),oldSupplier=baseline.system_supplier.find(row=>row.row.id===7)!,currentSupplier=normalized.system_supplier.find(row=>row.row.id===7)!;
  expect(currentSupplier.row).toEqual({...oldSupplier.row,alipay_account:'later-setting-not-original',alipay_qrcode_url:'/api/assets/32'});
  const oldRole=baseline.system_role.find(row=>row.row.id===21)!,currentRole=normalized.system_role.find(row=>row.row.id===21)!;
  expect(currentRole.row).toEqual({...oldRole.row,rules:'supplier.order.view'});
  normalized.system_supplier=normalized.system_supplier.map(row=>row.row.id===7?oldSupplier:row);normalized.system_role=normalized.system_role.map(row=>row.row.id===21?oldRole:row);
  expect(normalized).toEqual(baseline);
 }
 const server=createServer((req,res)=>{void(async()=>{
  if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==new URL(origin).host)return send(res,'Owned loopback only',403);
  const url=new URL(req.url??'/',origin),path=url.pathname,method=req.method??'GET';
  if(path===control&&method==='GET')return send(res,`<!doctype html><html lang="zh"><meta charset="utf-8"><title>原申请二维码 PG16 本机验收</title><h1>当前申请与原回执的私有二维码</h1><p>全为本机合成资料。夹具已通过真实申请服务创建原申请205；浏览器只读取，不提交申请或执行银行付款。后续仅修改本机当前收款设置与角色能力，原申请和回执不变。</p>
   <button id="applicant">进入本机申请资料</button><button id="recovery">修改当前设置并撤去财务能力</button><button id="hold">扣留下一原申请媒体回复</button><button id="other">切换另一合成账号</button><button id="restore">恢复原申请账号</button><button id="release">释放已扣留回复</button><button id="again">再次载入同一原申请</button><button id="status">读取验收状态</button><button id="finish">完成并关闭夹具</button><pre></pre><script>
   const control=${JSON.stringify(control)},tokens=${JSON.stringify(f.tokens)},pending=${JSON.stringify(pending)};
   function session(other=false,finance=false){localStorage.setItem('supplier-token',other?tokens.other:tokens.reader);localStorage.setItem('supplier-user',JSON.stringify({id:other?31:21,supplier_id:other?8:7,supplier_name:'本机原申请供应商'}));localStorage.setItem('supplier-permissions',JSON.stringify(finance?['supplier.finance.view','supplier.finance.manage']:[]));}
   function journal(){localStorage.setItem('supplier_extract_application_pending_v1:7:21',JSON.stringify(pending));}
   document.getElementById('applicant').onclick=()=>{session(false,true);location.href='/finance/apply';};
   for(const action of ['recovery','hold','other','restore','release','again','status','finish'])document.getElementById(action).onclick=async()=>{const response=await fetch(control+'/'+action,{method:'POST'});document.querySelector('pre').textContent=await response.text();if(!response.ok)return;if(action==='other')session(true);if(action==='restore')session();if(action==='recovery'||action==='again'){session();journal();}};</script>`);
  if(path.startsWith(control+'/')){
   expect(method).toBe('POST');expect(req.headers.origin).toBe(origin);await chain;
   if(path.endsWith('/recovery')){expect(changed).toBe(false);expect(seedSeen&&accountsSeen).toBe(true);expect(assets.length).toBeGreaterThan(0);
    await f.db.update(systemSupplier).set({alipayAccount:'later-setting-not-original',alipayQrcodeUrl:'/api/assets/32'}).where(eq(systemSupplier.id,7));
    await f.db.update(systemRole).set({rules:'supplier.order.view'}).where(eq(systemRole.id,21));changed=true;onlyFixtureChanges(await f.snapshot());await sequences();}
   if(path.endsWith('/hold')){expect(recovered).toBeGreaterThan(0);expect(armHold).toBe(false);expect(heldCount).toBe(0);armHold=true;}
   if(path.endsWith('/other')){expect(held).toHaveLength(1);expect(sessionChanges).toBe(0);sessionChanges++;}
   if(path.endsWith('/restore')){expect(sessionChanges).toBe(1);sessionChanges++;}
   if(path.endsWith('/release')){expect(sessionChanges).toBe(2);expect(held).toHaveLength(1);while(held.length){const item=held.shift()!;releaseAttempts.push({socket_destroyed:item.destroyed()});item.deliver();}}
   if(path.endsWith('/again')){expect(changed).toBe(true);expect(sessionChanges).toBe(2);expect(releaseAttempts).toHaveLength(1);expect(again).toBe(0);again++;}
   if(path.endsWith('/finish')){
    expect(changed&&scriptSeen&&seedSeen&&accountsSeen).toBe(true);expect(recovered).toBeGreaterThanOrEqual(2);expect(again).toBe(1);expect(armHold).toBe(false);expect(held).toHaveLength(0);expect(heldCount).toBe(1);expect(sessionChanges).toBe(2);expect(releaseAttempts).toHaveLength(1);expect(outbound).toBe(0);
    expect(issued.length).toBeGreaterThanOrEqual(3);expect(issued.every(row=>row.operation_id===f.original.operationId&&row.preview.reference==='/api/assets/31'&&row.preview.status==='ready')).toBe(true);
    expect(assets.length).toBeGreaterThanOrEqual(3);expect(assets.every(row=>row.id===31)).toBe(true);expect(f.objectCalls.every(row=>row.method==='get')).toBe(true);
    const final=await f.snapshot();onlyFixtureChanges(final);await sequences();expect(paths.every(row=>row.method==='GET')).toBe(true);expect(paths.some(row=>row.path.startsWith('/supplierapi/file/'))).toBe(false);finished=true;
    await writeFile('/tmp/cinashop-supplier-extract-application-media-browser-result.json',JSON.stringify({...state(),final_sequence:await f.sequence(),final_image_sequence:await f.imageSequence(),snapshot_tables:Object.keys(final),final_snapshot_sha256:sha(JSON.stringify(final))},null,2)+'\n');
   }
   send(res,JSON.stringify(state()),200,'application/json');if(finished)finish();return;
  }
  if(path.startsWith('/supplierapi/')||path==='/api/get_script'||path.startsWith('/api/assets/')){
   expect(method).toBe('GET');let release!:()=>void;const previous=chain;chain=new Promise(done=>{release=done;});await previous;
   let bytes=Buffer.alloc(0),status=200,headers:Record<string,string>={},hold=false;
   try{
    const before=await f.snapshot(),seq=await f.sequence(),images=await f.imageSequence(),mediaRequest=/^\/supplierapi\/finance\/supplier_extract\/application_operations\/[a-f0-9-]+\/media$/.test(path);
    const role=mediaRequest||path.startsWith('/api/assets/')?'media':path==='/supplierapi/finance/info'?'accounts':'application';wiring.container=containers[role];
    const response=await app.request(path+url.search,{headers:req.headers.authorization?{Authorization:req.headers.authorization}:{}},env);bytes=Buffer.from(await response.arrayBuffer());status=response.status;headers=Object.fromEntries(response.headers);
    expect(await f.snapshot()).toEqual(before);expect(await f.sequence()).toEqual(seq);expect(await f.imageSequence()).toEqual(images);paths.push({path,method,query:url.search,app_status:status,runtime_profile:role,body_sha256:sha(bytes)});
    expect(status).toBe(200);
    if(path==='/api/get_script'){expect(bytes.toString()).toBe(script);scriptSeen=true;}
    else if(path.startsWith('/api/assets/')){expect(path).toBe('/api/assets/31');expect(bytes).toEqual(Buffer.from(f.png));expect(headers['content-type']).toBe('image/png');assets.push({id:31,bytes:bytes.length,sha256:sha(bytes),status});}
    else{
     expect(headers['cache-control']).toContain('private, no-store');const value=JSON.parse(bytes.toString());expect(value.status).toBe(200);
     if(mediaRequest){expect([...url.searchParams.keys()]).toEqual(['request_hash']);expect(url.searchParams.get('request_hash')).toBe(f.original.requestHash);expect(Object.keys(value.data)).toHaveLength(8);
      expect(value.data).toMatchObject({version:'supplier-extract-application-media-v1',actor_id:21,supplier_id:7,operation_id:f.original.operationId,request_hash:f.original.requestHash,extract_id:205,bounded:true,preview:{reference:'/api/assets/31',status:'ready'}});expect(value.data.preview.src).toMatch(/^\/api\/assets\/31\?expires=/);expect(Object.keys(value.data.preview)).toHaveLength(4);issued.push(value.data);
      if(armHold){armHold=false;heldCount++;hold=true;}
     }else if(path.endsWith('/cash')){expect(changed).toBe(false);expect(value.data).toMatchObject({version:'supplier-extract-application-seed-v1',actor_id:21,supplier_id:7,available:'709.50'});expect(value.data.accounts.alipay.qrcode_url).toBe('/api/assets/31');seedSeen=true;}
     else if(path==='/supplierapi/finance/info'){expect(changed).toBe(false);expect(url.search).toBe('?selection=accounts');expect(value.data).toMatchObject({version:'supplier-finance-accounts-v1',actor_id:21,supplier_id:7,accounts:{alipay_qrcode_url:'/api/assets/31'}});expect(value.data.previews.alipay.src).toMatch(/^\/api\/assets\/31\?/);accountsSeen=true;}
     else{expect(path).toBe('/supplierapi/finance/supplier_extract/application_operations/'+f.original.operationId);expect(changed).toBe(true);expect(url.search).toBe('');expect(value.data).toEqual(f.original.receipt);recovered++;}
    }
   }finally{release();}
   const deliver=()=>{if(!res.destroyed){res.writeHead(status,headers);res.end(bytes);}};if(hold)held.push({deliver,destroyed:()=>res.destroyed});else deliver();return;
  }
  if(path==='/favicon.ico')return send(res,'',204);
  const filename=resolve(root,'.'+path),candidate=filename.startsWith(root+sep)?filename:'';
  try{if(candidate&&(await stat(candidate)).isFile())return send(res,await readFile(candidate),200,({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}as Record<string,string>)[extname(candidate)]??'application/octet-stream');}catch{/* SPA */}
  return send(res,await readFile(resolve(root,'index.html')));
 })().catch(error=>{fail(error instanceof Error?error:Error(String(error)));if(!res.headersSent)send(res,'Owned original application media acceptance assertion failed',500);else res.destroy();});});
 const external=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{outbound++;throw Error('Original application media Browser forbids backend outbound fetch');});
 try{await f.withApplicationMediaReader(async media=>f.withReader(async accounts=>f.withLookup(async application=>{
  Object.assign(containers,{media:media.container,accounts:accounts.container,application:application.container});
  for(const [name,runtime,count]of [['media',media,7],['accounts',accounts,5],['application',application,8]]as const){const[proof]=await runtime.db.execute(sql`SELECT current_user AS role,(SELECT count(*)::int FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p')AND has_table_privilege(current_user,c.oid,'SELECT'))AS readable,EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p')AND(has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES')))AS dml,EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='S'AND has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE'))AS sequence`);expect(proof).toMatchObject({readable:count,dml:false,sequence:false});roleProofs.push({profile:name,...proof});}
  await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const address=server.address();if(!address||typeof address==='string')throw Error('Missing owned original QR origin');origin=`http://127.0.0.1:${address.port}`;
  process.stdout.write('SUPPLIER_EXTRACT_APPLICATION_MEDIA_BROWSER_READY '+JSON.stringify({control:origin+control,source:origin+'/finance/apply',recovery:origin+'/finance/application-result'})+'\n');deadline=setTimeout(()=>fail(Error('Original application QR Browser finish not received')),18*60_000);await completion;process.stdout.write('SUPPLIER_EXTRACT_APPLICATION_MEDIA_BROWSER_RESULT '+JSON.stringify(state())+'\n');
 })));}finally{if(deadline)clearTimeout(deadline);external.mockRestore();wiring.container=undefined;held.length=0;server.closeAllConnections();if(server.listening)await new Promise<void>(yes=>server.close(()=>yes()));await f.close();}
},19*60_000);
