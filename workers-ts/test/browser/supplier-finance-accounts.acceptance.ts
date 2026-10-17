/** Real production UI/App/JWT and independent owned PG16 LOGINs. R2 bytes are
 * an explicit local boundary; no live provider, real payee or bank call. */
import {expect,it,vi} from 'vitest';
import {createServer,type ServerResponse} from 'node:http';
import {readFile,stat,writeFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createApp} from '@/app';
import type {Container} from '@/lib/di';
import type {Env} from '@/env';
import {supplierFinanceAccountsFixture} from '../helpers/supplierFinanceAccounts';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{
 if(!wiring.container)throw Error('Missing owned accounts LOGIN');return wiring.container;
}}));
it('reads owned settings, selects and uploads scoped QR bytes, reconciles one discarded CAS acknowledgement and quotes the saved bank through IAB',async()=>{
 const root=resolve(import.meta.dirname,'../../../view/supplier-ts/dist');expect((await stat(resolve(root,'index.html'))).isFile()).toBe(true);
 const f=await supplierFinanceAccountsFixture(),app=createApp(),control='/__supplier_finance_accounts_fixture/'+randomUUID();
 const statisticsScript='globalThis.__ownedSupplierFinanceAccountsStatistics = 1;';
 const env={...f.env,NODE_ENV:'test',CONFIG_KV:{get:async(key:string)=>key==='cfg_system_statistics'?statisticsScript:null,put:async()=>{},delete:async()=>{}}}as unknown as Env;
 const baseline=await f.snapshot(),paths:any[]=[],contexts:any[]=[],uploads:any[]=[],assets:any[]=[];
 let origin='',finished=false,outbound=0,dropped=0,armDrop=false,reconciled=false,seedSeen=false,scriptSeen=false,publicSeen=false;
 let saved:any,chain=Promise.resolve(),finish!:()=>void,fail!:(cause:Error)=>void,deadline:ReturnType<typeof setTimeout>|undefined;
 const completion=new Promise<void>((yes,no)=>{finish=yes;fail=no;});
 const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
 const canonical=(s:Record<string,any[]>)=>Object.fromEntries(Object.entries(s).map(([table,rows])=>[table,rows.map(row=>JSON.stringify(row)).sort()]));
 const state=()=>({finished,outbound,dropped,reconciled,seedSeen,scriptSeen,publicSeen,paths,contexts,uploads,assets,saved,objectCalls:f.objectCalls});
 function send(res:ServerResponse,body:string|Buffer,status=200,type='text/html; charset=utf-8'){
  if(res.destroyed)return;res.writeHead(status,{'Content-Type':type,'Cache-Control':'private, no-store'});res.end(body);
 }
 async function noFinancialChange(){expect(await f.sequence()).toEqual([{last_value:'205',is_called:false}]);}
 function settingsOnly(before:Record<string,any[]>,after:Record<string,any[]>,accounts:Record<string,string>){
  const normalized=structuredClone(after),row=normalized.system_supplier.find(item=>item.row.id===7);
  const prior=before.system_supplier.find(item=>item.row.id===7);expect(row&&prior).toBeTruthy();
  for(const key of f.accountColumns){expect(row.row[key]).toBe(accounts[key]);row.row[key]=prior.row[key];}
  expect(canonical(normalized)).toEqual(canonical(before));
 }
 const server=createServer((req,res)=>{void(async()=>{
  if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==new URL(origin).host)return send(res,'Owned loopback only',403);
  const url=new URL(req.url??'/',origin),path=url.pathname,method=req.method??'GET';
  if(path===control&&method==='GET')return send(res,`<!doctype html><html lang="zh"><meta charset="utf-8"><title>收款设置 PG16 本机验收</title><h1>收款设置、限域二维码与丢回执核对</h1><p>所有账号、图片和735元账目均为本机合成数据。仅一次保存、一次PNG上传；不提交提现。保存确认丢失后只读取当前值，再核对新提现页面的银行快照。</p>
   <button id="viewer">只读财务角色进入</button><button id="material">素材只读角色进入</button><button id="writer">可管理角色进入</button><button id="drop">丢失下一设置保存回执</button><button id="status">读取验收状态</button><button id="finish">完成并关闭夹具</button><pre></pre><script>
   const control=${JSON.stringify(control)},tokens=${JSON.stringify(f.tokens)};function session(kind){const id=kind==='viewer'?22:kind==='materialViewer'?24:21;const permissions=kind==='viewer'?['supplier.finance.view']:['supplier.finance.view','supplier.finance.manage','supplier.attachment.view',...(kind==='reader'?['supplier.attachment.manage']:[])];localStorage.setItem('supplier-token',tokens[kind]);localStorage.setItem('supplier-user',JSON.stringify({id,supplier_id:7,supplier_name:'本机收款设置供应商'}));localStorage.setItem('supplier-permissions',JSON.stringify(permissions));location.href='/finance/accounts';}document.getElementById('viewer').onclick=()=>session('viewer');document.getElementById('material').onclick=()=>session('materialViewer');document.getElementById('writer').onclick=()=>session('reader');for(const action of ['drop','status','finish'])document.getElementById(action).onclick=async()=>{const response=await fetch(control+'/'+action,{method:'POST'});document.querySelector('pre').textContent=await response.text();};</script>`);
  if(path.startsWith(control+'/')){
   expect(method).toBe('POST');expect(req.headers.origin).toBe(origin);await chain;
   if(path.endsWith('/drop')){expect(armDrop||!!saved).toBe(false);armDrop=true;}
   if(path.endsWith('/finish')){
    expect(armDrop).toBe(false);expect(dropped).toBe(1);expect(reconciled&&seedSeen&&scriptSeen&&publicSeen).toBe(true);expect(outbound).toBe(0);
    expect(new Set(contexts.map(row=>row.actor_id))).toEqual(new Set([21,22,24]));expect(uploads).toHaveLength(1);expect(uploads[0]).toMatchObject({id:45,bytes:f.png.byteLength,sha256:sha(f.png)});
    expect(paths.filter(row=>row.method==='POST'&&row.path==='/supplierapi/finance/info')).toHaveLength(1);expect(paths.filter(row=>row.method==='POST'&&row.path!=='/supplierapi/finance/info'&&row.path!=='/supplierapi/file/upload')).toHaveLength(0);
    expect(assets.some(row=>row.id===31)).toBe(true);expect(assets.some(row=>row.id===45)).toBe(true);expect(f.objectCalls.filter(row=>row.method==='put')).toHaveLength(1);
    const final=await f.snapshot(),normalized=structuredClone(final),added=normalized.system_attachment.filter((row:{row:{att_id:number}})=>row.row.att_id===45);expect(added).toHaveLength(1);expect(added[0].row).toMatchObject({type:4,relation_id:7,module_type:1,file_type:1,image_type:8,att_dir:'/api/assets/45',satt_dir:'/api/assets/45',real_name:'owned-new-finance-qr.png'});
    normalized.system_attachment=normalized.system_attachment.filter((row:{row:{att_id:number}})=>row.row.att_id!==45);settingsOnly(baseline,normalized,saved.accounts);await noFinancialChange();expect(await f.imageSequence()).toEqual([{last_value:'45',is_called:true}]);finished=true;
    await writeFile('/tmp/cinashop-supplier-finance-accounts-browser-result.json',JSON.stringify({...state(),final_sequence:await f.sequence(),final_image_sequence:await f.imageSequence(),snapshot_tables:Object.keys(final),final_snapshot_sha256:sha(JSON.stringify(final))},null,2)+'\n');
   }
   send(res,JSON.stringify(state()),200,'application/json');if(finished)finish();return;
  }
  if(path==='/owned-media/application-alipay.png'||path==='/owned-media/application-weixin.png'){expect(method).toBe('GET');publicSeen=true;return send(res,Buffer.from(f.png),200,'image/png');}
  if(path.startsWith('/supplierapi/')||path==='/api/get_script'||path.startsWith('/api/assets/')){
   expect(['GET','POST']).toContain(method);const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));const raw=Buffer.concat(parts);expect(raw.byteLength).toBeLessThanOrEqual(128*1024);
   let release!:()=>void;const previous=chain;chain=new Promise(done=>{release=done;});await previous;
   let bytes=Buffer.alloc(0),status=200,headers:Record<string,string>={},drop=false;
   try{
    const before=await f.snapshot(),seq=await f.sequence(),images=await f.imageSequence();
    const role=path.startsWith('/supplierapi/file/')?'media':path==='/supplierapi/finance/info'&&method==='POST'?'writer':path.endsWith('/cash')?'application':'reader';
    wiring.container=runtimeContainers[role];
    const response=await app.request(path+url.search,{method,headers:{...(req.headers.authorization?{Authorization:req.headers.authorization}:{}),...(req.headers['content-type']?{'Content-Type':req.headers['content-type']}:{}),...(req.headers['content-length']?{'Content-Length':req.headers['content-length']}: {})},...(method==='POST'?{body:new Uint8Array(raw)}:{})},env);
    bytes=Buffer.from(await response.arrayBuffer());status=response.status;headers=Object.fromEntries(response.headers);const after=await f.snapshot();
    paths.push({path,method,query:url.search,app_status:status,runtime_profile:role,body_sha256:sha(bytes)});
    if(method==='GET'){
     expect(after).toEqual(before);expect(await f.sequence()).toEqual(seq);expect(await f.imageSequence()).toEqual(images);expect(status).toBe(200);
     if(path==='/api/get_script'){expect(bytes.toString()).toBe(statisticsScript);scriptSeen=true;}
     else if(path.startsWith('/api/assets/')){const id=Number(path.split('/').at(-1));expect([31,32,45]).toContain(id);expect(bytes).toEqual(Buffer.from(f.png));expect(headers['content-type']).toBe('image/png');assets.push({id,bytes:bytes.length,sha256:sha(bytes),status});}
     else{
      expect(headers['cache-control']).toContain('private, no-store');const value=JSON.parse(bytes.toString());expect(value.status).toBe(200);
      if(path==='/supplierapi/finance/info'){
       expect(url.search).toBe('?selection=accounts');expect(Object.keys(value.data)).toHaveLength(8);expect(value.data.supplier_id).toBe(7);contexts.push({actor_id:value.data.actor_id,revision:value.data.revision,accounts:value.data.accounts});
       if(saved){expect(value.data.accounts).toEqual(saved.accounts);expect(value.data.revision).toMatch(/^[a-f0-9]{64}$/);if(value.data.actor_id===saved.actor_id){expect(value.data.revision).toBe(saved.revision);reconciled=true;}}
      }else if(path.endsWith('/cash')){
       expect(saved).toBeTruthy();expect(value.data).toMatchObject({actor_id:21,supplier_id:7,available:'735.00',accounts:{bank:{bank_code:'0000999988887777',bank_address:'本机新的收款开户行'}}});seedSeen=true;
      }else{expect(path).toMatch(/^\/supplierapi\/file\/(file|category)$/);if(path.endsWith('/file'))for(const row of value.data.list)expect(row).toMatchObject({type:4,relation_id:7,file_type:1,module_type:1});}
     }
    }else if(path==='/supplierapi/finance/info'){
     const input=JSON.parse(raw.toString()),value=JSON.parse(bytes.toString());expect(Object.keys(input).sort()).toEqual([...f.accountColumns,'revision'].sort());expect(value.status).toBe(200);expect(status).toBe(200);expect(saved).toBeUndefined();saved=value.data;
     expect(saved.accounts).toMatchObject({bank_code:'0000999988887777',bank_address:'本机新的收款开户行',alipay_account:'new-alipay-owned',alipay_qrcode_url:'/api/assets/31',wechat_qrcode_url:'/api/assets/45'});expect(saved.revision).not.toBe(input.revision);settingsOnly(before,after,saved.accounts);expect(await f.sequence()).toEqual(seq);expect(await f.imageSequence()).toEqual(images);expect(armDrop).toBe(true);armDrop=false;dropped++;drop=true;
    }else{
     expect(path).toBe('/supplierapi/file/upload');const value=JSON.parse(bytes.toString());expect(value.status).toBe(200);expect(status).toBe(200);expect(value.data).toMatchObject({att_id:45,url:'/api/assets/45',size:f.png.byteLength,type:'image/png'});
     const normalized=structuredClone(after);expect(normalized.system_attachment.filter((row:{row:{att_id:number}})=>row.row.att_id===45)).toHaveLength(1);normalized.system_attachment=normalized.system_attachment.filter((row:{row:{att_id:number}})=>row.row.att_id!==45);expect(canonical(normalized)).toEqual(canonical(before));expect(await f.sequence()).toEqual(seq);expect(await f.imageSequence()).toEqual([{last_value:'45',is_called:true}]);const put=f.objectCalls.filter(row=>row.method==='put');expect(put).toHaveLength(1);const stored=f.objects.get(put[0].key);expect(stored?.bytes).toEqual(f.png);uploads.push({id:45,bytes:stored!.bytes.length,sha256:sha(stored!.bytes),actual_app_body_sha256:sha(bytes)});
    }
   }finally{release();}
   if(drop)return send(res,JSON.stringify({status:503,msg:'Owned settings acknowledgement discarded after commit',data:null}),503,'application/json');
   if(!res.destroyed){res.writeHead(status,headers);res.end(bytes);}return;
  }
  if(path==='/favicon.ico')return send(res,'',204);
  const filename=resolve(root,'.'+path),candidate=filename.startsWith(root+sep)?filename:'';
  try{if(candidate&&(await stat(candidate)).isFile())return send(res,await readFile(candidate),200,({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}as Record<string,string>)[extname(candidate)]??'application/octet-stream');}catch{/* SPA */}
  return send(res,await readFile(resolve(root,'index.html')));
 })().catch(error=>{fail(error instanceof Error?error:Error(String(error)));if(!res.headersSent)send(res,'Owned accounts acceptance assertion failed',500);else res.destroy();});});
 const runtimeContainers:Record<string,Container>={};
 const external=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{outbound++;throw Error('Accounts Browser forbids backend outbound fetch');});
 try{await f.withReader(async reader=>f.withWriter(async writer=>f.withMaterialWriter(async media=>f.withApplicant(async application=>{
  Object.assign(runtimeContainers,{reader:reader.container,writer:writer.container,media:media.container,application:application.container});
  await writeFile('/tmp/owned-new-finance-qr.png',f.png);await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const address=server.address();if(!address||typeof address==='string')throw Error('Missing owned accounts origin');origin=`http://127.0.0.1:${address.port}`;
  process.stdout.write('SUPPLIER_FINANCE_ACCOUNTS_BROWSER_READY '+JSON.stringify({control:origin+control,accounts:origin+'/finance/accounts',application:origin+'/finance/apply',upload:'/tmp/owned-new-finance-qr.png'})+'\n');deadline=setTimeout(()=>fail(Error('Supplier accounts Browser finish not received')),18*60_000);await completion;process.stdout.write('SUPPLIER_FINANCE_ACCOUNTS_BROWSER_RESULT '+JSON.stringify(state())+'\n');
 }))));}finally{if(deadline)clearTimeout(deadline);external.mockRestore();wiring.container=undefined;server.closeAllConnections();if(server.listening)await new Promise<void>(yes=>server.close(()=>yes()));await f.close();}
},19*60_000);
