/** Hidden actual-browser acceptance. Built H5 -> real registered Worker ->
 * formal independent App LOGIN on PG16. QA sessions/fixtures/transport are
 * explicitly separate nonproof controls; no provider or message sending. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {readFile,readdir,writeFile,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {expect,it,vi} from 'vitest';
import {createApp} from '@/app';
import type {Container} from '@/lib/di';
import {messageCenterFixture,IDS as ids,messageImageKey,messageVisibleRows,messageUnreadCount,assertMessageReadConsumption,type MessageControl} from '../helpers/messageCenterFixture';
import {stableDiyState,type DiyStateSnapshot,type DiyStateRow as Row} from '../helpers/diyStateFixture';
const wiring=vi.hoisted(()=>({context:undefined as AsyncLocalStorage<Container>|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{const value=wiring.context?.getStore();if(!value)throw Error('Owned message App LOGIN required');return value;}}));
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex'),digest=(v:unknown)=>hash(stableDiyState(v));
export const messageBrowserPlans=[
 {name:'guest-center',kind:'guest',owner:0,width:375},
 {name:'owner-center',kind:'center',owner:ids.a,width:375,rows:20},
 {name:'system-first',kind:'messages',owner:ids.a,width:375,rows:20},
 {name:'system-lost',kind:'messages-error',owner:ids.a,width:375,rows:20},
 {name:'system-retried',kind:'messages',owner:ids.a,width:375,rows:23},
 {name:'system-terminal',kind:'messages',owner:ids.a,width:375,rows:23},
 {name:'center-returned',kind:'center',owner:ids.a,width:375,rows:20},
 {name:'conversations-next',kind:'center',owner:ids.a,width:375,rows:23},
 {name:'offline-chat',kind:'chat',owner:ids.a,width:375},
 {name:'chat-returned',kind:'center',owner:ids.a,width:375,rows:20},
 {name:'disabled-chat',kind:'disabled-chat',owner:ids.a,width:375},
 {name:'detail-owned',kind:'detail',owner:ids.a,width:375,id:ids.ownMessage},
 {name:'detail-foreign',kind:'missing',owner:ids.a,width:375,id:ids.foreignMessage},
 {name:'detail-invalid',kind:'invalid',owner:ids.a,width:375,id:0},
 {name:'empty-center',kind:'center',owner:ids.empty,width:375,rows:0,scenario:'hide-broadcast'},
 {name:'empty-messages',kind:'messages',owner:ids.empty,width:375,rows:0},
 {name:'broadcast-restored',kind:'center',owner:ids.empty,width:375,rows:0,scenario:'restore-broadcast'},
 {name:'missing-image',kind:'media-error',owner:ids.a,width:375,rows:20,scenario:'missing-image'},
 {name:'corrupt-image',kind:'media-error',owner:ids.a,width:375,rows:20,scenario:'corrupt-image'},
 {name:'media-restored',kind:'center',owner:ids.a,width:375,rows:20,scenario:'restored-image'},
 {name:'passwd-revoked',kind:'revoked',owner:ids.a,width:375,scenario:'passwd-revoke'},
 {name:'passwd-restored',kind:'center',owner:ids.a,width:375,rows:20,scenario:'passwd-restore'},
 {name:'status-revoked',kind:'revoked',owner:ids.a,width:375,scenario:'status-revoke'},
 {name:'status-restored',kind:'center',owner:ids.a,width:375,rows:20,scenario:'status-restore'},
 {name:'late-held',kind:'held',owner:ids.a,width:375},
 {name:'new-owner',kind:'center',owner:ids.b,width:375,rows:1},
 {name:'new-owner-released',kind:'center',owner:ids.b,width:375,rows:1},
 {name:'desktop',kind:'center',owner:ids.a,width:1000,rows:20},
 {name:'mobile-final',kind:'center',owner:ids.a,width:375,rows:20},
 {name:'finished',kind:'guest',owner:0,width:375},
] as const;
async function files(root:string):Promise<string[]>{return(await Promise.all((await readdir(root,{withFileTypes:true})).map(e=>e.isDirectory()?files(resolve(root,e.name)):[resolve(root,e.name)]))).flat().sort();}
async function requestBody(req:IncomingMessage){const parts:Buffer[]=[];let size=0;for await(const part of req){const b=Buffer.from(part);size+=b.length;expect(size).toBeLessThanOrEqual(524288);parts.push(b);}const bytes=Buffer.concat(parts);if(req.headers['content-length']!==undefined)expect(String(bytes.length)).toBe(req.headers['content-length']);expect(req.aborted).toBe(false);return bytes;}
it('restores PHP message center, private page read receipts and selected customer-service history',async()=>{
 const repository=resolve(import.meta.dirname,'../../..'),dist=resolve(repository,'view/uniapp-ts/dist/build/h5'),prefix='/tmp/cinashop-message-center-browser-',runId=randomUUID(),control='/__message_center/'+runId;
 for(const name of['ready','progress','evidence','failed','cleanup'])expect(await stat(prefix+name+'.json').then(()=>true,(e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return false;throw e;}),'Archive previous owned message Browser attempt').toBe(false);
 const f=await messageCenterFixture(),app=createApp();let server:ReturnType<typeof createServer>|undefined,timer:ReturnType<typeof setTimeout>|undefined,origin='',failure:unknown,cleanupFailure:unknown,fixtureClosed=false;
 const traces:Row[]=[],controls:Row[]=[],evidence:Row[]=[],statics:Row[]=[],snapshots:Record<string,DiyStateSnapshot>={};
 let expected=await f.snapshot(),lastAck:string|null=null,actor=0,pending=0,queued=0,queue=Promise.resolve(),nextLost=false,nextHold=false;
 let held:{res:ServerResponse;bytes:Buffer;status:number;headers:Record<string,string>;index:number}|undefined;
 let done!:()=>void,fail!:(error:unknown)=>void;const complete=new Promise<void>((yes,no)=>{done=yes;fail=no;});complete.catch(()=>{});
 const stage=()=>messageBrowserPlans[evidence.length] as Row|undefined,remember=(s:DiyStateSnapshot)=>{const key=digest(s);snapshots[key]??=structuredClone(s);return key;};
 const activity=()=>({pending,queued,held:!!held,next_lost:nextLost,next_hold:nextHold});
 const serial=<T>(run:()=>Promise<T>):Promise<T>=>{queued++;const value=queue.then(run).finally(()=>{queued--;});queue=value.then(()=>{},error=>{failure??=error;fail(error);});return value;};
 const json=(res:ServerResponse,value:unknown)=>{res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
 const persist=()=>writeFile(prefix+'progress.json',JSON.stringify({status:'running',run_id:runId,control,stage:stage()?.name,last_ack:lastAck,activity:activity(),evidence,traces,controls,statics,snapshots_by_sha256:snapshots,resources:f.resources(),r2_reads:f.assetReads},null,2)+'\n',{mode:0o600});
 async function sources(){const paths=[...(await files(resolve(repository,'workers-ts/src'))),...(await files(resolve(repository,'workers-ts/test/helpers'))),...(await files(resolve(repository,'view/uniapp-ts/src'))),...(await files(resolve(repository,'view/common'))),
 ...['workers-ts/test/browser/message-center.acceptance.ts','workers-ts/test/browser/message-center.shell.html','workers-ts/test/message-center-postgres.test.ts','workers-ts/vitest.message-center-browser.config.ts','workers-ts/scripts/run-local-finance-postgres.mjs','workers-ts/test/local-finance-postgres-runner.test.ts','workers-ts/package.json','workers-ts/package-lock.json','view/uniapp-ts/package.json','view/uniapp-ts/package-lock.json','view/uniapp-ts/scripts/user-messages-runtime.test.cjs','view/uniapp-ts/scripts/kefu-conversation-runtime.test.cjs'].map(p=>resolve(repository,p))];return Promise.all([...new Set(paths)].sort().map(async path=>{const b=await readFile(path);return{path:path.slice(repository.length+1),bytes:b.length,sha256:hash(b)};}));}
 async function builds(){return Promise.all((await files(dist)).map(async path=>{const b=await readFile(path);return{path:path.slice(repository.length+1),bytes:b.length,sha256:hash(b)};}));}
 let sourceBefore:Row[]=[],buildBefore:Row[]=[];
 try{
  wiring.context=new AsyncLocalStorage<Container>();sourceBefore=await sources();buildBefore=await builds();expect(buildBefore.length).toBeGreaterThan(300);
  const outbound=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('Message Browser prohibits outbound network');});
  await f.withApplication(async runtime=>{
   const initialResources=f.resources();remember(f.setup.before);remember(expected);
   async function dispatch(req:IncomingMessage,res:ServerResponse,url:URL,raw:Buffer){pending++;try{
    expect(['GET','HEAD']).toContain(req.method);expect(raw.length).toBe(0);
    const headers=new Headers();for(const[key,value]of Object.entries(req.headers))if(typeof value==='string'&&!['host','connection','content-length'].includes(key))headers.set(key,value);
    const authorization=String(req.headers['authori-zation']??req.headers.authorization??''),owner=[ids.a,ids.b,ids.empty].find(uid=>authorization==='Bearer '+f.tokens.get(uid))??0;if(authorization)expect(owner).toBeGreaterThan(0);
    const delivery=await serial(async()=>{
     const before=await f.snapshot(),resourceBefore=f.resources(),r2Before=f.assetReads.length,start=Date.now();expect(before).toEqual(expected);const jobs:Promise<unknown>[]=[];
     const response=await wiring.context!.run(runtime.container,()=>app.fetch(new Request(origin+url.pathname+url.search,{method:req.method,headers}),runtime.env,{waitUntil:(job:Promise<unknown>)=>jobs.push(job),passThroughOnException:()=>{}}as never));
     const bytes=Buffer.from(await response.arrayBuffer()),settled=await Promise.allSettled(jobs);expect(settled.every(r=>r.status==='fulfilled')).toBe(true);const end=Date.now(),after=await f.snapshot();let dto:Row|null=null;try{dto=JSON.parse(bytes.toString())as Row;}catch{}
     const center=url.pathname==='/api/user/message',list=url.pathname==='/api/user/message_system/list',detail=/^\/api\/user\/message_system\/detail\/([1-9]\d*)$/.exec(url.pathname),history=url.pathname==='/api/user/service/record',asset=url.pathname==='/api/assets/'+ids.media;
     let classification:Row={kind:'actual-read'};
     if((list||detail)&&owner&&dto?.status===200){const visible=messageVisibleRows(before,owner),limit=Number(url.searchParams.get('limit')??20),page=Number(url.searchParams.get('page')??1),selected=detail?visible.filter(r=>r.id===Number(detail[1])):visible.slice((page-1)*limit,page*limit);
      classification=assertMessageReadConsumption(before,after,owner,selected.map(r=>r.id),Math.floor(start/1000),Math.floor(end/1000));
      expect(response.headers.get('cache-control')).toBe('private, no-store');expect(jobs).toEqual([]);
      if(list){expect(dto.data.owner_uid).toBe(owner);expect(dto.data.list.map((r:Row)=>r.id)).toEqual(selected.map(r=>r.id));expect(dto.data.count).toBe(visible.length);expect(dto.data.service_num).toBe(messageUnreadCount(before,owner));}
      else{expect(dto.data.owner_uid).toBe(owner);expect(dto.data.id).toBe(Number(detail![1]));expect(dto.data.message?.id??null).toBe(selected[0]?.id??null);expect(dto.data.service_num).toBe(messageUnreadCount(after,owner));}
     }else expect(after).toEqual(before);
     if(center&&owner&&dto?.status===200){expect(response.headers.get('cache-control')).toBe('private, no-store');expect(dto.data.owner_uid).toBe(owner);const visible=messageVisibleRows(before,owner);expect(dto.data.system?.id??null).toBe(visible[0]?.id??null);if(visible.length)expect(dto.data.system.message_num).toBe(messageUnreadCount(before,owner));
      const rows=before.store_service_record.filter(r=>r.user_id===owner&&r.is_tourist===0).sort((a,b)=>b.update_time-a.update_time||b.id-a.id),page=Number(url.searchParams.get('page')??1);expect(dto.data.service_count).toBe(rows.length);expect(dto.data.service.map((r:Row)=>r.id)).toEqual(rows.slice((page-1)*20,page*20).map(r=>r.id));expect(jobs).toEqual([]);
     }
     if(history){expect(owner).toBe(ids.a);if(stage()?.name==='disabled-chat'){expect(url.searchParams.get('to_uid')).toBe(String(ids.disabledService));expect(dto?.status).toBe(404);expect(dto?.data).toBeNull();}else{expect(url.searchParams.get('to_uid')).toBe(String(ids.offlineService));expect(dto?.status).toBe(200);expect(dto!.data.uid).toBe(ids.offlineService);expect(dto!.data.serviceList.map((r:Row)=>r.id)).toEqual([750001,750002]);expect(dto!.data.serviceList.map((r:Row)=>r.msn_type)).toEqual([1,7]);}expect(jobs).toEqual([]);}
     if(asset){expect(f.assetReads.length-r2Before).toBe(1);if(response.status===200)expect(bytes).toEqual(Buffer.from(f.objects.get(messageImageKey)!.bytes));else expect(response.status).toBe(404);}else expect(f.assetReads.length).toBe(r2Before);
     expect(f.resources()).toEqual(resourceBefore);expect(f.forbidden).not.toHaveBeenCalled();expected=after;
     const record:Row={index:traces.length,run_id:runId,phase:stage()?.name,method:req.method,path:url.pathname,query:url.search,owner,authorization,raw_headers:req.rawHeaders,request_body_base64:Buffer.from(raw).toString('base64'),request_body_sha256:hash(raw),request_body_bytes:raw.length,status:response.status,headers:Object.fromEntries(response.headers),body_base64:bytes.toString('base64'),sha256:hash(bytes),bytes:bytes.length,dto,started_at_ms:start,completed_at_ms:end,before_sha256:remember(before),after_sha256:remember(after),classification,wait_until_count:jobs.length,r2_reads:f.assetReads.length-r2Before,delivery:'complete-worker-response'};traces.push(record);return{record,bytes,headers:Object.fromEntries(response.headers),status:response.status,center,list};
    });
    if(delivery.list&&nextLost){expect(stage()?.name).toBe('system-lost');expect(url.searchParams.get('page')).toBe('2');nextLost=false;delivery.record.delivery='truncated-real-json-first-byte';delivery.record.delivered_bytes=1;res.writeHead(delivery.status,{...delivery.headers,'Content-Length':String(delivery.bytes.length),'Connection':'close'});res.write(delivery.bytes.subarray(0,1));await new Promise<void>(yes=>setTimeout(()=>{res.destroy();yes();},100));}
    else if(delivery.center&&nextHold){expect(stage()?.name).toBe('late-held');nextHold=false;delivery.record.delivery='held-real-response';held={res,bytes:delivery.bytes,status:delivery.status,headers:delivery.headers,index:delivery.record.index};}
    else{res.writeHead(delivery.status,delivery.headers);res.end(delivery.bytes);}await persist();
   }finally{pending--;}}
   async function capture(name:string,data:Row){const plan=stage();expect(name).toBe(plan?.name);expect(data.run_id).toBe(runId);expect(data.previous_ack??null).toBe(lastAck);expect(data.captured_at_ms).toBeGreaterThan(Number(evidence.at(-1)?.captured_at_ms??0));expect(data.errors).toEqual([]);expect(data.width).toBe(plan!.width);expect(data.viewportWidth).toBe(plan!.width);expect(data.clientWidth).toBeLessThanOrEqual(plan!.width);expect(data.clientWidth).toBeGreaterThanOrEqual(plan!.width-20);expect(data.scrollWidth).toBeLessThanOrEqual(data.clientWidth);expect(new URL(data.href).origin).toBe(origin);expect(actor).toBe(plan!.owner);
    const current=traces.slice(Number(evidence.at(-1)?.trace_count??0)),text=String(data.text);
    expect(text).not.toMatch(/员工私密提醒|普通会员不得读取|停用消息|已删消息/);
    if(plan!.kind==='guest'||plan!.kind==='revoked'){expect(data.conversation_ids).toEqual([]);expect(data.message_ids).toEqual([]);expect(data.system_id).toBe(0);expect(text).toContain('登录后查看消息中心');if(plan!.kind==='guest')expect(current.filter(t=>t.path.startsWith('/api/user/'))).toEqual([]);else expect(current.some(t=>t.owner===ids.a&&t.dto?.status!==200)).toBe(true);}
    else if(plan!.kind==='held'){expect(held).toBeDefined();expect(data.loading).toBe(true);expect(data.conversation_ids).toEqual([]);expect(data.system_id).toBe(0);expect(text).not.toMatch(/消息会员|本人最新通知/);}
    else if(plan!.kind==='center'||plan!.kind==='media-error'){const visible=messageVisibleRows(expected,plan!.owner),records=expected.store_service_record.filter(r=>r.user_id===plan!.owner&&r.is_tourist===0).sort((a,b)=>b.update_time-a.update_time||b.id-a.id).slice(0,plan!.rows);
     expect(data.conversation_ids).toEqual(records.map(r=>r.id));expect(data.service_uids).toEqual(records.map(r=>r.to_uid));expect(data.system_id).toBe(visible[0]?.id??0);expect(data.system_unread).toBe(Boolean(visible.length&&messageUnreadCount(expected,plan!.owner)>0));expect(data.loading).toBe(false);expect(data.alerts).toEqual([]);
     if(plan!.owner===ids.a){expect(text).not.toContain('B独立会话正文');expect(text).not.toContain('B本人消息');}
     if(plan!.owner===ids.b){expect(text).toContain('B本人消息');expect(text).not.toContain('本人最新通知');expect(data.conversation_ids).toEqual([730101]);}
     if(plan!.kind==='media-error'){
      // UniApp H5 loads a detached Image and appends it only after onload.
      // Its component @error reaches the real fallback without a window DOM
      // resource-error event. Bind the visible fallbacks to real asset delivery.
      expect(data.avatar_images).toHaveLength(0);expect(data.avatar_fallbacks).toBe(plan!.rows);
      const media=current.filter(t=>t.path==='/api/assets/'+ids.media);
      expect(media.length).toBeGreaterThan(0);
      const summaries=current.filter(t=>t.path==='/api/user/message'&&t.owner===plan!.owner&&t.dto?.status===200);
      expect(summaries).toHaveLength(1);
      const previews=new Set(summaries[0]!.dto.data.service.map((r:Row)=>r.avatar));
      for(const request of media){
       expect(request.owner).toBe(0);expect(request.r2_reads).toBe(1);
       expect(previews.has(request.path+request.query)).toBe(true);
       const bytes=Buffer.from(request.body_base64,'base64');
       if(plan!.name==='missing-image'){expect(request.status).toBe(404);expect(bytes).toHaveLength(0);}
       else{expect(plan!.name).toBe('corrupt-image');expect(request.status).toBe(200);expect(bytes).toEqual(Buffer.from([137,80,78,71,0,1,2]));}
      }
     }else if(plan!.rows>0){expect(data.avatar_images).toHaveLength(plan!.rows);expect(data.avatar_images.every((r:Row)=>r.complete&&r.naturalWidth>0)).toBe(true);}
     if(plan!.name==='owner-center'){
      // Frozen H5 compiles 24/32/88rpx to .75/1/2.75rem. UniApp may
      // size rem from either document client width or viewport width as
      // scrollbars settle; bind exact geometry to the observed root size.
      expect(plan!.width).toBe(375);expect(Number.isFinite(data.root_font_px)).toBe(true);expect(data.root_font_px).toBeGreaterThan(0);
      expect(data.root_font_px).toBeGreaterThanOrEqual(data.clientWidth*16/375);expect(data.root_font_px).toBeLessThanOrEqual(data.viewportWidth*16/375);
      expect(data.cards[0].radius).toBeCloseTo(data.root_font_px*.75,1);expect(data.cards[0].padding).toBeCloseTo(data.root_font_px,1);expect(data.cards[0].avatar_width).toBeCloseTo(data.root_font_px*2.75,1);expect(data.cards.every((r:Row)=>r.right<=plan!.width&&r.left>=0)).toBe(true);expect(data.badges).toContain('99+');expect(data.badges).toContain('2');expect(data.emojis.some((r:Row)=>r.name==='smile'&&r.position==='65% 60%'&&r.background.includes('/static/php-messages/sheet_apple_64_indexed_256colors.png')&&r.width===22&&r.height===22)).toBe(true);expect(data.system_time).toMatch(/前$/);expect(data.unsafe_markup).toBe(false);}
    }else if(plan!.kind==='messages'||plan!.kind==='messages-error'){const rows=messageVisibleRows(expected,plan!.owner).slice(0,plan!.rows);expect(data.message_ids).toEqual(rows.map(r=>r.id));if(plan!.kind==='messages-error'){expect(data.alerts.length).toBe(1);expect(text).toContain('重试当前页');}else{expect(data.alerts).toEqual([]);expect(data.loading).toBe(false);}if(plan!.rows){expect(text).toContain('<img src=x onerror="globalThis.__messageUnsafe=1">');expect(data.unsafe_markup).toBe(false);}if(plan!.name==='system-terminal')expect(current.filter(t=>t.path==='/api/user/message_system/list')).toEqual([]);}
    else if(plan!.kind==='chat'){expect(text).toContain('离线客服34');expect(data.chat_messages).toEqual(['离线客服给A的历史','A回复离线客服']);expect(text).not.toContain('B独立历史不得给A');expect(current.some(t=>t.path==='/api/user/service/record'&&t.query.includes('to_uid=34'))).toBe(true);expect(controls.some(c=>c.kind==='qa-websocket-unavailable'&&c.path.includes('to_uid=34'))).toBe(true);}
    else if(plan!.kind==='disabled-chat'){expect(data.chat_messages).toEqual([]);expect(data.chat_service).toBe('');expect(data.alerts.join(' ')).toContain('指定客服');expect(current.filter(t=>t.path==='/api/user/service/record')).toHaveLength(1);expect(current.find(t=>t.path==='/api/user/service/record')?.query).toContain('to_uid=56');expect(controls.some(c=>c.kind==='qa-websocket-unavailable'&&c.phase==='disabled-chat')).toBe(false);}
    else if(plan!.kind==='detail'){expect(data.message_ids).toEqual([plan!.id]);expect(text).toContain('本人最新通知');}
    else if(plan!.kind==='missing'){expect(data.message_ids).toEqual([]);expect(text).toContain('消息不存在或已不可见');}
    else if(plan!.kind==='invalid'){expect(data.message_ids).toEqual([]);expect(text).toContain('消息链接无效');expect(current.filter(t=>t.path.startsWith('/api/user/'))).toEqual([]);}
    else throw Error('Unknown message phase kind');
    expect(await f.snapshot()).toEqual(expected);expect(f.forbidden).not.toHaveBeenCalled();const ack=randomUUID();evidence.push({name,...data,ack,trace_count:traces.length,snapshot_sha256:remember(expected),resources:f.resources()});lastAck=ack;await persist();
    if(name==='finished'){expect(traces.some(t=>t.delivery==='truncated-real-json-first-byte')).toBe(true);expect(traces.some(t=>t.delivery==='held-real-response'&&t.release)).toBe(true);expect(nextLost||nextHold||!!held).toBe(false);expect(await sources()).toEqual(sourceBefore);expect(await builds()).toEqual(buildBefore);expect(outbound).not.toHaveBeenCalled();}
    return{accepted:true,name,run_id:runId,ack,next:stage()?.name??null,complete:evidence.length===messageBrowserPlans.length};
   }
   const observer='<script>window.__messageQa={errors:[],resourceErrors:[]};addEventListener("error",e=>{const q=window.__messageQa;if(e.target&&["IMG","VIDEO","SOURCE"].includes(e.target.tagName))q.resourceErrors.push({src:e.target.getAttribute("src"),at:Date.now()});else q.errors.push({message:e.message||"unknown",at:Date.now()})},true);addEventListener("unhandledrejection",e=>window.__messageQa.errors.push({message:String(e.reason),at:Date.now()}));</script>';
   const shell=(await readFile(resolve(import.meta.dirname,'message-center.shell.html'),'utf8')).replaceAll('__CONTROL__',JSON.stringify(control)).replaceAll('__RUN_ID__',JSON.stringify(runId)).replaceAll('__PLANS__',JSON.stringify(messageBrowserPlans));
   server=createServer((req,res)=>{void(async()=>{
    expect(req.socket.remoteAddress).toBe('127.0.0.1');expect(req.headers.host).toBe(new URL(origin).host);req.on('error',(error:Error&{code?:string})=>{controls.push({kind:'incoming-transport-error',message:error.message,code:error.code??'',phase:stage()?.name,at_ms:Date.now()});if(error.message!=='aborted'||error.code!=='ECONNRESET'){failure??=error;fail(error);}});const url=new URL(req.url??'/',origin),raw=await requestBody(req);
    if(url.pathname.startsWith(control)){expect(req.method).toBe('POST');controls.push({kind:'qa-control-request',run_id:runId,phase:stage()?.name,path:url.pathname,query:url.search,body_base64:raw.toString('base64'),body_sha256:hash(raw),at_ms:Date.now()});
     if(url.pathname===control+'/session'){const uid=Number(url.searchParams.get('owner'));expect([0,ids.a,ids.b,ids.empty]).toContain(uid);expect(uid).toBe(stage()?.owner);actor=uid;controls.push({kind:'qa-new-document-session',nonproof:true,owner:uid,at_ms:Date.now()});json(res,{token:uid?f.tokens.get(uid):'',uid});return;}
     if(url.pathname===control+'/fixture'){const name=url.searchParams.get('name')as MessageControl;expect(stage()?.scenario??null).toBe(name);expect(pending+queued).toBe(0);json(res,await serial(async()=>{expect(await f.snapshot()).toEqual(expected);const value=await f.control(name);expect(value.before).toEqual(expected);expected=value.after;controls.push({...value,before_sha256:remember(value.before),after_sha256:remember(value.after),at_ms:Date.now()});await persist();return{accepted:true,scenario:name};}));return;}
     if(url.pathname===control+'/lost'){expect(stage()?.name).toBe('system-lost');nextLost=true;json(res,{accepted:true});return;}
     if(url.pathname===control+'/hold'){expect(stage()?.name).toBe('late-held');nextHold=true;json(res,{accepted:true});return;}
     if(url.pathname===control+'/release'){expect(stage()?.name).toBe('new-owner-released');expect(held).toBeDefined();const h=held!;held=undefined;traces[h.index].release={at_ms:Date.now(),client_socket_destroyed:h.res.destroyed||h.res.socket?.destroyed,bytes:h.bytes.length,sha256:hash(h.bytes),kind:'writer-attempt-after-document-replacement'};h.res.writeHead(h.status,h.headers);h.res.end(h.bytes);await persist();json(res,{accepted:true});return;}
     if(url.pathname.startsWith(control+'/phase/')){if(pending+queued){json(res,{accepted:false,reason:'pending-business',activity:activity()});return;}const value=await serial(()=>capture(url.pathname.slice((control+'/phase/').length),JSON.parse(raw.toString())));if(value.complete)res.once('finish',done);json(res,value);return;}
     throw Error('Unknown message QA control');
    }
    if(url.pathname.startsWith('/api/')){await dispatch(req,res,url,raw);return;}
    expect(req.method).toBe('GET');if(url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end(shell);return;}if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
    const path=decodeURIComponent(url.pathname),target=path==='/__h5'?resolve(dist,'index.html'):resolve(dist,'.'+path);expect(target.startsWith(dist+sep)).toBe(true);const original=await readFile(target),index=target===resolve(dist,'index.html'),bytes=index?Buffer.from(original.toString().replace('<head>','<head><link rel="icon" href="data:,">'+observer)):original;
    statics.push({run_id:runId,phase:stage()?.name,path,file:target.slice(repository.length+1),source_sha256:hash(original),served_sha256:hash(bytes),source_bytes:original.length,bytes:bytes.length,index_observer:index});
    const mime:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.gif':'image/gif','.svg':'image/svg+xml','.ttf':'font/ttf','.woff2':'font/woff2','.ico':'image/x-icon'};res.writeHead(200,{'Content-Type':mime[extname(target)]??'application/octet-stream'});res.end(bytes);
   })().catch(error=>{failure??=error;controls.push({kind:'server-error',path:req.url,error:String(error),at_ms:Date.now()});void persist().then(()=>fail(error),fail);if(!res.headersSent)res.writeHead(500);res.end(String(error));});});
   server.on('upgrade',(req,socket)=>{const path=new URL(req.url??'/',origin);expect(stage()?.name).toBe('offline-chat');expect(path.pathname).toBe('/api/ws/kefu');expect(path.searchParams.get('to_uid')).toBe(String(ids.offlineService));controls.push({kind:'qa-websocket-unavailable',nonproof:true,path:path.pathname+path.search,phase:stage()?.name,at_ms:Date.now(),status:503,boundary:'No Cloudflare Durable Object bridge in this Node acceptance; actual socket protocol and sends not claimed.'});socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});
   timer=setTimeout(()=>fail(Error('Message Browser deadline')),55*60000);await new Promise<void>((yes,no)=>{server!.once('error',no);server!.listen(0,'127.0.0.1',yes);});const address=server.address();if(!address||typeof address==='string')throw Error('Missing kernel port');origin='http://127.0.0.1:'+address.port;
   await writeFile(prefix+'ready.json',JSON.stringify({status:'ready',run_id:runId,control,origin,prefix,pid:process.pid,plans:messageBrowserPlans,tables:f.tables,sequences:f.sequences,identities:runtime.identities,setup:f.setup,synthetic_authority:{app_key_base64:Buffer.from(runtime.env.APP_KEY).toString('base64'),tokens:[...f.tokens]},baseline_sha256:remember(expected),resources:initialResources,source_manifest:sourceBefore,build_manifest:buildBefore,boundary:'Actual built H5/registered Worker/API JWT/formal App LOGIN/full PG16. System list/detail GETs consume only exact current owner receipts. Center/history/theme/media conserve all tables/sequences. QA sessions/finite fixture/transport/503 WebSocket controls are nonproof. Cross-document held response only; same-instance races are separate runtime tests. No native device/provider/send/login/natural-expiry claim.'},null,2)+'\n',{mode:0o600});
   console.log('MESSAGE_CENTER_BROWSER_READY '+origin);await complete;await queue;
   server.closeAllConnections();await new Promise<void>((yes,no)=>server!.close(e=>e?no(e):yes()));
   await writeFile(prefix+'evidence.json',JSON.stringify({status:'passed',run_id:runId,control,plans:messageBrowserPlans,evidence,traces,controls,statics,snapshots_by_sha256:snapshots,setup:f.setup,final_sha256:remember(await f.snapshot()),resources:f.resources(),r2_reads:f.assetReads,identities:runtime.identities,source_manifest:sourceBefore,build_manifest:buildBefore},null,2)+'\n',{mode:0o600});
  });
 }catch(error){failure??=error;await writeFile(prefix+'failed.json',JSON.stringify({status:'failed',run_id:runId,error:String(error),stack:error instanceof Error?error.stack:null,evidence,traces,controls,statics,snapshots_by_sha256:snapshots,expected,actual:await f.snapshot().catch(()=>null)},null,2)+'\n',{mode:0o600});throw error;}
 finally{clearTimeout(timer);try{if(server?.listening){server.closeAllConnections();await new Promise<void>((yes,no)=>server!.close(e=>e?no(e):yes()));}}catch(error){cleanupFailure??=error;}try{await f.close();fixtureClosed=true;}catch(error){cleanupFailure??=error;}wiring.context=undefined;vi.restoreAllMocks();await writeFile(prefix+'cleanup.json',JSON.stringify({run_id:runId,server_closed:!server?.listening,fixture_closed:fixtureClosed,pending,queued,failure:failure?String(failure):null,cleanup_failure:cleanupFailure?String(cleanupFailure):null})+'\n',{mode:0o600});if(cleanupFailure)throw cleanupFailure;}
},57*60000);
