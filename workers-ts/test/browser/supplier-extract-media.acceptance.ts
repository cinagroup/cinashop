/** Production UI, actual App/JWT and independent SELECT-only PG16 LOGINs.
 * One owned Admin transfer registration is metadata, never a bank payment. */
import {expect,it,vi} from 'vitest';
import {createServer,type ServerResponse} from 'node:http';
import {readFile,stat,writeFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {createApp} from '@/app';
import {createContainerFromDb,type Container} from '@/lib/di';
import type {Env} from '@/env';
import {AdminSupplierFinanceService} from '@/services/admin/AdminSupplierFinanceService';
import {supplierExtractMediaFixture} from '../helpers/supplierExtractMedia';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{
 if(!wiring.container)throw Error('Missing owned historical media LOGIN');return wiring.container;
}}));
it('authorizes historical own QR and Admin vouchers, rejects stale registration versions and clears delayed media after session ABA through IAB',async()=>{
 const root=resolve(import.meta.dirname,'../../../view/supplier-ts/dist');expect((await stat(resolve(root,'index.html'))).isFile()).toBe(true);
 const f=await supplierExtractMediaFixture(),app=createApp(),control='/__supplier_extract_media_fixture/'+randomUUID();
 const statisticsScript='globalThis.__ownedSupplierExtractMediaStatistics = 1;';
 const env={...f.env,NODE_ENV:'test',CONFIG_KV:{get:async(key:string)=>key==='cfg_system_statistics'?statisticsScript:null,put:async()=>{},delete:async()=>{}}}as unknown as Env;
 const baseline=await f.snapshot(),paths:any[]=[],issued:any[]=[],assets:any[]=[],roleProofs:any[]=[],held:Array<{deliver:()=>void;destroyed:()=>boolean}>=[],releaseAttempts:any[]=[];
 let origin='',finished=false,outbound=0,scriptSeen=false,registered=false,stale=0,armHold=false,heldCount=0,sessionChanges=0;
 let registeredRow:any,chain=Promise.resolve(),finish!:()=>void,fail!:(cause:Error)=>void,deadline:ReturnType<typeof setTimeout>|undefined;
 const completion=new Promise<void>((yes,no)=>{finish=yes;fail=no;}),runtimeContainers:Record<string,Container>={};
 const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
 const canonical=(s:Record<string,any[]>)=>Object.fromEntries(Object.entries(s).map(([table,rows])=>[table,rows.map(row=>JSON.stringify(row)).sort()]));
 const state=()=>({finished,outbound,scriptSeen,registered,stale,heldCount,sessionChanges,releaseAttempts,registeredRow,paths,issued,assets,roleProofs,objectCalls:f.objectCalls});
 function send(res:ServerResponse,body:string|Buffer,status=200,type='text/html; charset=utf-8'){
  if(res.destroyed)return;res.writeHead(status,{'Content-Type':type,'Cache-Control':'private, no-store'});res.end(body);
 }
 async function sequences(){expect(await f.sequence()).toEqual([{last_value:'205',is_called:false}]);expect(await f.imageSequence()).toEqual([{last_value:'45',is_called:false}]);}
 function onlyRegistration(before:Record<string,any[]>,after:Record<string,any[]>){
  const normalized=structuredClone(after),old=before.supplier_extract.find(row=>row.row.id===2),current=normalized.supplier_extract.find(row=>row.row.id===2);expect(old&&current).toBeTruthy();
  expect(current.row).toMatchObject({id:2,supplier_id:7,status:1,pay_status:1,admin_id:101,voucher_title:'本机新增转账登记',voucher_image:'/api/assets/42'});expect(current.row.pay_time).toBeGreaterThan(0);
  const allowed=['pay_status','admin_id','voucher_title','voucher_image','pay_time'];for(const [key,value]of Object.entries(old.row))if(!allowed.includes(key))expect(current.row[key]).toEqual(value);
  registeredRow=structuredClone(current.row);normalized.supplier_extract=normalized.supplier_extract.map(row=>row.row.id===2?old:row);expect(canonical(normalized)).toEqual(canonical(before));
 }
 const server=createServer((req,res)=>{void(async()=>{
  if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==new URL(origin).host)return send(res,'Owned loopback only',403);
  const url=new URL(req.url??'/',origin),path=url.pathname,method=req.method??'GET';
  if(path===control&&method==='GET')return send(res,`<!doctype html><html lang="zh"><meta charset="utf-8"><title>历史提现媒体 PG16 本机验收</title><h1>历史二维码、Admin凭证与迟到媒体隔离</h1><p>所有账户、图片和账目均为本机合成数据。只读角色无素材权限；现有Admin业务只登记一笔提现的凭证元数据，不执行银行付款，不提交新提现。</p>
   <button id="viewer">只读角色进入历史</button><button id="register">登记本机提现2凭证</button><button id="hold">扣留下一媒体回复</button><button id="other">切换另一合成账号</button><button id="restore">恢复原只读账号</button><button id="release">释放已扣留回复</button><button id="status">读取验收状态</button><button id="finish">完成并关闭夹具</button><pre></pre><script>
   const control=${JSON.stringify(control)},tokens=${JSON.stringify(f.tokens)};function session(other=false){localStorage.setItem('supplier-token',other?tokens.other:tokens.viewer);localStorage.setItem('supplier-user',JSON.stringify({id:other?31:22,supplier_id:other?8:7,supplier_name:'本机历史图片供应商'}));localStorage.setItem('supplier-permissions',JSON.stringify(['supplier.finance.view']));}document.getElementById('viewer').onclick=()=>{session();location.href='/finance/extracts?extract_type=weixin';};for(const action of ['register','hold','other','restore','release','status','finish'])document.getElementById(action).onclick=async()=>{const response=await fetch(control+'/'+action,{method:'POST'});document.querySelector('pre').textContent=await response.text();if(response.ok&&action==='other')session(true);if(response.ok&&action==='restore')session(false);};</script>`);
  if(path.startsWith(control+'/')){
   expect(method).toBe('POST');expect(req.headers.origin).toBe(origin);await chain;
   if(path.endsWith('/register')){expect(registered).toBe(false);const before=await f.snapshot();await new AdminSupplierFinanceService(createContainerFromDb(f.db)).transfer(2,101,{voucher_title:'本机新增转账登记',voucher_image:'/api/assets/42'});onlyRegistration(before,await f.snapshot());await sequences();registered=true;}
   if(path.endsWith('/hold')){expect(armHold).toBe(false);expect(heldCount).toBe(0);armHold=true;}
   if(path.endsWith('/other')){expect(held).toHaveLength(1);expect(sessionChanges).toBe(0);sessionChanges++;}
   if(path.endsWith('/restore')){expect(sessionChanges).toBe(1);sessionChanges++;}
   if(path.endsWith('/release')){expect(sessionChanges).toBe(2);expect(held).toHaveLength(1);while(held.length){const item=held.shift()!;releaseAttempts.push({socket_destroyed:item.destroyed()});item.deliver();}}
   if(path.endsWith('/finish')){
    expect(armHold).toBe(false);expect(held).toHaveLength(0);expect(heldCount).toBe(1);expect(releaseAttempts).toHaveLength(1);expect(sessionChanges).toBe(2);expect(registered&&scriptSeen).toBe(true);expect(stale).toBeGreaterThanOrEqual(1);expect(outbound).toBe(0);
    expect(issued.some(row=>row.id===3&&row.previews.qrcode.status==='ready'&&row.previews.voucher.status==='ready')).toBe(true);expect(issued.some(row=>row.id===2&&row.registered&&row.previews.voucher.status==='ready')).toBe(true);
    expect(new Set(assets.map(row=>row.id))).toEqual(new Set([31,32,42]));expect(f.objectCalls.some(row=>row.method==='put'||row.method==='delete')).toBe(false);
    const final=await f.snapshot();onlyRegistration(baseline,final);await sequences();expect(paths.every(row=>row.method==='GET')).toBe(true);expect(paths.some(row=>row.path.startsWith('/supplierapi/file/'))).toBe(false);finished=true;
    await writeFile('/tmp/cinashop-supplier-extract-media-browser-result.json',JSON.stringify({...state(),final_sequence:await f.sequence(),final_image_sequence:await f.imageSequence(),snapshot_tables:Object.keys(final),final_snapshot_sha256:sha(JSON.stringify(final))},null,2)+'\n');
   }
   send(res,JSON.stringify(state()),200,'application/json');if(finished)finish();return;
  }
  if(path.startsWith('/supplierapi/')||path==='/api/get_script'||path.startsWith('/api/assets/')){
   expect(method).toBe('GET');let release!:()=>void;const previous=chain;chain=new Promise(done=>{release=done;});await previous;
   let bytes=Buffer.alloc(0),status=200,headers:Record<string,string>={},hold=false;
   try{
    const before=await f.snapshot(),seq=await f.sequence(),images=await f.imageSequence(),mediaRequest=/^\/supplierapi\/finance\/supplier_extract\/[1-9]\d*\/media$/.test(path);
    const role=mediaRequest||path.startsWith('/api/assets/')?'media':'history';wiring.container=runtimeContainers[role];
    const response=await app.request(path+url.search,{headers:req.headers.authorization?{Authorization:req.headers.authorization}:{}},env);bytes=Buffer.from(await response.arrayBuffer());status=response.status;headers=Object.fromEntries(response.headers);
    expect(await f.snapshot()).toEqual(before);expect(await f.sequence()).toEqual(seq);expect(await f.imageSequence()).toEqual(images);paths.push({path,method,query:url.search,app_status:status,runtime_profile:role,body_sha256:sha(bytes)});
    if(path==='/api/get_script'){expect(status).toBe(200);expect(bytes.toString()).toBe(statisticsScript);scriptSeen=true;}
    else if(path.startsWith('/api/assets/')){const id=Number(path.split('/').at(-1));expect([31,32,42]).toContain(id);expect(status).toBe(200);expect(bytes).toEqual(Buffer.from(f.png));expect(headers['content-type']).toBe('image/png');assets.push({id,bytes:bytes.length,sha256:sha(bytes),status});}
    else{
     expect(headers['cache-control']).toContain('private, no-store');const value=JSON.parse(bytes.toString());
     if(mediaRequest){
      expect([...url.searchParams.keys()]).toEqual(['revision']);
      if(status===409){expect(value.status).toBe(409);expect(registered).toBe(true);expect(path).toBe('/supplierapi/finance/supplier_extract/2/media');stale++;}
      else{expect(status).toBe(200);expect(value.status).toBe(200);expect(Object.keys(value.data)).toHaveLength(7);expect(value.data).toMatchObject({version:'supplier-extract-media-v1',actor_id:22,supplier_id:7,bounded:true,revision:url.searchParams.get('revision')});expect([2,3]).toContain(value.data.id);
       if(value.data.id===3){expect(value.data.previews.qrcode.src).toMatch(/^\/api\/assets\/32\?/);expect(value.data.previews.voucher.src).toMatch(/^\/api\/assets\/42\?/);}
       if(value.data.id===2){expect(value.data.previews.qrcode.src).toMatch(/^\/api\/assets\/31\?/);expect(value.data.previews.voucher.status).toBe(registered?'ready':'unavailable');}
       issued.push({...value.data,registered});if(armHold){armHold=false;heldCount++;hold=true;}
      }
     }else{expect(path).toBe('/supplierapi/finance/supplier_extract/list');expect(status).toBe(200);expect(value.status).toBe(200);expect(value.data).toMatchObject({version:'supplier-extract-v1',supplier_id:7,selection:'history'});}
    }
   }finally{release();}
   const deliver=()=>{if(!res.destroyed){res.writeHead(status,headers);res.end(bytes);}};if(hold)held.push({deliver,destroyed:()=>res.destroyed});else deliver();return;
  }
  if(path==='/favicon.ico')return send(res,'',204);
  const filename=resolve(root,'.'+path),candidate=filename.startsWith(root+sep)?filename:'';
  try{if(candidate&&(await stat(candidate)).isFile())return send(res,await readFile(candidate),200,({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}as Record<string,string>)[extname(candidate)]??'application/octet-stream');}catch{/* SPA */}
  return send(res,await readFile(resolve(root,'index.html')));
 })().catch(error=>{fail(error instanceof Error?error:Error(String(error)));if(!res.headersSent)send(res,'Owned historical media acceptance assertion failed',500);else res.destroy();});});
 const external=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{outbound++;throw Error('Historical media Browser forbids backend outbound fetch');});
 try{await f.withMediaReader(async media=>f.withRuntimeRole!(async peer=>{
  await f.exec(`GRANT SELECT ON public.system_admin,public.system_supplier,public.system_role,public.system_menus,public.supplier_extract,public.supplier_flowing_water,public.system_config TO "${peer.role}"`);
  Object.assign(runtimeContainers,{media:media.container,history:createContainerFromDb(peer.db)});
  for(const [name,runtime]of [['media',media],['history',peer]]as const){const[proof]=await runtime.db.execute(sql`SELECT current_user AS role,EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p') AND(has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES')))AS dml,EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='S'AND has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE'))AS sequence`);expect(proof).toMatchObject({dml:false,sequence:false});roleProofs.push({profile:name,...proof});}
  await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const address=server.address();if(!address||typeof address==='string')throw Error('Missing owned historical media origin');origin=`http://127.0.0.1:${address.port}`;
  process.stdout.write('SUPPLIER_EXTRACT_MEDIA_BROWSER_READY '+JSON.stringify({control:origin+control,history:origin+'/finance/extracts?extract_type=weixin'})+'\n');deadline=setTimeout(()=>fail(Error('Historical media Browser finish not received')),18*60_000);await completion;process.stdout.write('SUPPLIER_EXTRACT_MEDIA_BROWSER_RESULT '+JSON.stringify(state())+'\n');
 }));}finally{if(deadline)clearTimeout(deadline);external.mockRestore();wiring.container=undefined;held.length=0;server.closeAllConnections();if(server.listening)await new Promise<void>(yes=>server.close(()=>yes()));await f.close();}
},19*60_000);
