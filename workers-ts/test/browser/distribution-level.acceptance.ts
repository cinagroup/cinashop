/** Explicit hidden-CUA acceptance. Actual built H5, registered Worker, JWT and
 * independent App LOGIN on full PG16. Finite fixture/session/transport controls
 * are nonproof and journalled separately. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { distributionLevelFixture, DISTRIBUTOR as ids, distributorImageKey, assertDistributionEvaluation, assertDistributionVisit, type DistributionScenario } from '../helpers/distributionLevelFixture';
import { stableDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from '../helpers/diyStateFixture';
const wiring=vi.hoisted(()=>({context:undefined as AsyncLocalStorage<Container>|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{const c=wiring.context?.getStore();if(!c)throw Error('Owned distribution App LOGIN required');return c;}}));
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex'),digest=(v:unknown)=>hash(stableDiyState(v));
export const distributionBrowserPlans=[
 {name:'guest-finance',kind:'finance',owner:0,width:375},
 {name:'guest-direct',kind:'guest',owner:0,width:375},
 {name:'owner-finance',kind:'finance',owner:ids.a,width:375},
 {name:'natural-upgrade',kind:'level',owner:ids.a,width:375,products:10},
 {name:'repeated-get',kind:'level',owner:ids.a,width:375,products:10},
 {name:'all-five-granted',kind:'level',owner:ids.a,width:375,products:10},
 {name:'next-level-selected',kind:'level',owner:ids.a,width:375,products:10},
 {name:'page2-lost',kind:'recommendation-error',owner:ids.a,width:375,products:10},
 {name:'page2-retried',kind:'level',owner:ids.a,width:375,products:20},
 {name:'page3-final',kind:'level',owner:ids.a,width:375,products:23},
 {name:'terminal',kind:'level',owner:ids.a,width:375,products:23},
 {name:'ordinary-detail',kind:'product',owner:ids.a,width:375},
 {name:'ordinary-returned',kind:'level',owner:ids.a,width:375,products:10},
 {name:'activity-detail',kind:'activity',owner:ids.a,width:375},
 {name:'activity-returned',kind:'level',owner:ids.a,width:375,products:10},
 {name:'invite-target',kind:'invite',owner:ids.a,width:375},
 {name:'invite-returned',kind:'level',owner:ids.a,width:375,products:10},
 {name:'hidden-grant',kind:'hidden',owner:ids.b,width:375,scenario:'hidden',products:10},
 {name:'deleted-grant',kind:'deleted',owner:ids.b,width:375,scenario:'deleted',products:10},
 {name:'maximum-grant',kind:'max',owner:ids.b,width:375,scenario:'max',products:10},
 {name:'zero-tasks',kind:'zero',owner:ids.b,width:375,scenario:'zero',products:10},
 {name:'missing-image',kind:'media-error',owner:ids.a,width:375,scenario:'missing',products:10},
 {name:'corrupt-image',kind:'media-error',owner:ids.a,width:375,scenario:'restored',products:10},
 {name:'media-restored',kind:'level',owner:ids.a,width:375,products:10},
 {name:'late-held',kind:'held',owner:ids.a,width:375},
 {name:'new-owner',kind:'level',owner:ids.b,width:375,products:10},
 {name:'new-owner-released',kind:'level',owner:ids.b,width:375,products:10},
 {name:'empty-recommendations',kind:'empty',owner:ids.b,width:375,scenario:'empty-hot',products:0},
 {name:'restored-recommendations',kind:'level',owner:ids.b,width:375,scenario:'restore-hot',products:10},
 {name:'desktop',kind:'level',owner:ids.b,width:1000,products:10},
 {name:'finished',kind:'level',owner:ids.b,width:375,products:10},
] as const;
async function files(root:string):Promise<string[]>{return(await Promise.all((await readdir(root,{withFileTypes:true})).map(e=>e.isDirectory()?files(resolve(root,e.name)):[resolve(root,e.name)]))).flat().sort();}
async function requestBody(req:IncomingMessage){const parts:Buffer[]=[];let size=0;for await(const p of req){const bytes=Buffer.from(p);size+=bytes.length;expect(size).toBeLessThanOrEqual(524288);parts.push(bytes);}const bytes=Buffer.concat(parts);if(req.headers['content-length']!==undefined)expect(String(bytes.length)).toBe(req.headers['content-length']);expect(req.aborted).toBe(false);return bytes;}
it('actual PHP distribution layout preserves evaluation writes while hot/media remain full-schema reads',async()=>{
 const repository=resolve(import.meta.dirname,'../../..'),dist=resolve(repository,'view/uniapp-ts/dist/build/h5'),prefix='/tmp/cinashop-distribution-level-browser-',runId=randomUUID(),control='/__distribution_level/'+runId;
 for(const suffix of['ready.json','progress.json','evidence.json','failed.json','cleanup.json'])expect(await stat(prefix+suffix).then(()=>true,(e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return false;throw e;}),'Archive prior owned Browser prefix '+suffix).toBe(false);
 const f=await distributionLevelFixture(),app=createApp();let server:ReturnType<typeof createServer>|undefined,timer:ReturnType<typeof setTimeout>|undefined,origin='',failure:unknown,cleanupFailure:unknown,fixtureClosed=false;
 const traces:Row[]=[],controls:Row[]=[],evidence:Row[]=[],statics:Row[]=[],snapshots:Record<string,DiyStateSnapshot>={};
 let expected=await f.snapshot(),lastAck:string|null=null,actor=0,pending=0,queued=0,queue=Promise.resolve(),nextLost=false,nextHold=false,nextCorrupt=false;
 let held:{res:ServerResponse;bytes:Buffer;status:number;headers:Record<string,string>;index:number}|undefined;
 let done!:()=>void,fail!:(e:unknown)=>void;const complete=new Promise<void>((yes,no)=>{done=yes;fail=no;});complete.catch(()=>{});
 const stage=()=>distributionBrowserPlans[evidence.length],remember=(s:DiyStateSnapshot)=>{const d=digest(s);snapshots[d]??=structuredClone(s);return d;};
 const activity=()=>({pending,queued,held:!!held,next_lost:nextLost,next_hold:nextHold,next_corrupt:nextCorrupt});
 const serial=<T>(run:()=>Promise<T>):Promise<T>=>{queued++;const p=queue.then(run).finally(()=>{queued--;});queue=p.then(()=>{},error=>{failure??=error;fail(error);});return p;};
 const json=(res:ServerResponse,value:unknown)=>{res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
 const persist=()=>writeFile(prefix+'progress.json',JSON.stringify({status:'running',run_id:runId,control,stage:stage()?.name,last_ack:lastAck,activity:activity(),evidence,traces,controls,statics,snapshots_by_sha256:snapshots,resources:f.resources(),r2_reads:f.assetReads,kv_reads:f.kvReads},null,2)+'\n',{mode:0o600});
 async function sources(){const paths=[...(await files(resolve(repository,'workers-ts/src'))),...(await files(resolve(repository,'workers-ts/test/helpers'))),...(await files(resolve(repository,'view/uniapp-ts/src'))),...(await files(resolve(repository,'view/common'))),
  ...['workers-ts/test/browser/distribution-level.acceptance.ts','workers-ts/test/browser/distribution-level.shell.html','workers-ts/test/distribution-level-page-postgres.test.ts','workers-ts/vitest.distribution-level-browser.config.ts','workers-ts/scripts/run-local-finance-postgres.mjs','workers-ts/test/local-finance-postgres-runner.test.ts','workers-ts/package.json','workers-ts/package-lock.json','view/uniapp-ts/package.json','view/uniapp-ts/package-lock.json'].map(p=>resolve(repository,p))];
  return Promise.all([...new Set(paths)].sort().map(async path=>{const b=await readFile(path);return{path:path.slice(repository.length+1),bytes:b.length,sha256:hash(b)};}));}
 async function builds(){return Promise.all((await files(dist)).map(async path=>{const b=await readFile(path);return{path:path.slice(repository.length+1),bytes:b.length,sha256:hash(b)};}));}
 let sourceBefore:Row[]=[],buildBefore:Row[]=[];
 try{
  wiring.context=new AsyncLocalStorage<Container>();sourceBefore=await sources();buildBefore=await builds();expect(buildBefore.length).toBeGreaterThan(300);
  const outbound=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('Distributor Browser prohibits outbound network');});
  await f.withApplication(async runtime=>{
   const initialResources=f.resources();remember(f.setup.before);remember(expected);
   async function dispatch(req:IncomingMessage,res:ServerResponse,url:URL,raw:Buffer){
    pending++;try{
     expect(['GET','HEAD']).toContain(req.method);expect(raw.length).toBe(0);expect(url.pathname).not.toMatch(/level\/detection|member_level\/detection|user\/level_list/);
     const headers=new Headers();for(const[key,value]of Object.entries(req.headers))if(typeof value==='string'&&!['host','connection','content-length'].includes(key))headers.set(key,value);
     const authorization=String(req.headers['authori-zation']??req.headers.authorization??''),owner=[ids.a,ids.b].find(uid=>authorization==='Bearer '+f.tokens.get(uid))??0;
     if(authorization)expect(owner).toBeGreaterThan(0);
     const delivery=await serial(async()=>{
      const before=await f.snapshot(),resourceBefore=f.resources(),r2Before=f.assetReads.length,start=Date.now();expect(before).toEqual(expected);
      const jobs:Promise<unknown>[]=[];
      const response=await wiring.context!.run(runtime.container,()=>app.fetch(new Request(origin+url.pathname+url.search,{method:req.method,headers}),runtime.env,{waitUntil:(job:Promise<unknown>)=>jobs.push(job),passThroughOnException:()=>{}}as never));
      const bytes=Buffer.from(await response.arrayBuffer()),settled=await Promise.allSettled(jobs);expect(settled.every(r=>r.status==='fulfilled')).toBe(true);const end=Date.now(),after=await f.snapshot();let dto:Row|null=null;try{dto=JSON.parse(bytes.toString())as Row;}catch{}
      let classification:Row={kind:'actual-read'};
      const evaluation=/^\/api(?:\/v2)?\/agent\/level_(?:list|task_list)$/.test(url.pathname),hot=url.pathname==='/api/product/hot'&&url.searchParams.get('view')==='member_level',asset=url.pathname==='/api/assets/'+ids.media,detail=/^\/api\/product\/detail\/([1-9]\d*)(?:\/0)?$/.exec(url.pathname);
      if(evaluation&&owner&&req.method==='GET'){classification=assertDistributionEvaluation(before,after,owner,start,end);expect(dto?.status).toBe(classification.failure?400:200);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(jobs).toEqual([]);}
      else if(detail){expect(owner).toBe(ids.a);expect(Number(detail[1])).toBe(ids.product+22);expect(stage()?.name).toBe('ordinary-detail');classification=assertDistributionVisit(before,after,owner,Number(detail[1]),start,end);expect(jobs).toHaveLength(1);}
      else expect(after).toEqual(before);
      if(hot){expect(owner).toBe(actor);expect(owner).toBeGreaterThan(0);expect(dto?.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');const page=Number(url.searchParams.get('page'));expect([...url.searchParams.keys()].sort()).toEqual(['limit','page','view']);expect(url.searchParams.get('limit')).toBe('10');
       const expectedIds=before.store_product.filter(r=>r.is_hot===1&&r.is_show===1&&r.is_del===0&&r.is_verify===1).sort((a,b)=>b.sort-a.sort||b.id-a.id).slice((page-1)*10,page*10).map(r=>r.id);
       expect(Object.keys(dto!.data).sort()).toEqual(['limit','list','owner_uid','page']);expect(dto!.data).toMatchObject({owner_uid:owner,page,limit:10});expect(dto!.data.list.map((r:Row)=>r.id)).toEqual(expectedIds);
       for(const row of dto!.data.list){expect(row.price).toBe('12.30');expect(row.image_source).toBe('/api/assets/'+ids.media);expect(row.image).toMatch(/^\/api\/assets\/660201\?expires=\d+&signature=[A-Za-z0-9_-]+$/);expect(row.recommendation_target).toMatchObject({product_id:row.id,kind:row.id===ids.product+21?'bargain':'product',id:row.id===ids.product+21?ids.bargain:row.id});}
       expect(f.assetReads).toHaveLength(r2Before);expect(jobs).toEqual([]);
      }
      if(asset){expect(response.status).toBe(f.objects.has(distributorImageKey)?200:404);expect(f.assetReads).toHaveLength(r2Before+1);if(response.status===200)expect(bytes).toEqual(f.png);}
      else expect(f.assetReads).toHaveLength(r2Before);
      expect(f.resources()).toEqual(resourceBefore);expect(f.forbidden).not.toHaveBeenCalled();expected=after;
      const record:Row={index:traces.length,run_id:runId,phase:stage()?.name,method:req.method,path:url.pathname,query:url.search,owner,authorization,raw_headers:req.rawHeaders,request_body_base64:Buffer.from(raw).toString('base64'),request_body_sha256:hash(raw),request_body_bytes:raw.length,
       status:response.status,headers:Object.fromEntries(response.headers),body_base64:bytes.toString('base64'),sha256:hash(bytes),bytes:bytes.length,dto,started_at_ms:start,completed_at_ms:end,before_sha256:remember(before),after_sha256:remember(after),classification,wait_until_count:jobs.length,r2_reads:f.assetReads.length-r2Before,delivery:'complete-worker-response'};traces.push(record);
      const h=Object.fromEntries(response.headers);if(h['content-length']!==undefined)expect(Number(h['content-length'])).toBe(bytes.length);
      return{record,bytes,headers:h,status:response.status,evaluation,hot,asset};
     });
     const d=delivery;
     if(d.hot&&nextLost){expect(stage()?.name).toBe('page2-lost');expect(url.searchParams.get('page')).toBe('2');nextLost=false;d.record.delivery='truncated-real-json-first-byte';d.record.delivered_bytes=1;res.writeHead(d.status,{...d.headers,'Content-Length':String(d.bytes.length),'Connection':'close'});res.write(d.bytes.subarray(0,1));await new Promise<void>(yes=>setTimeout(()=>{res.destroy();yes();},100));}
     else if(d.evaluation&&nextHold&&url.pathname.endsWith('/level_list')){expect(stage()?.name).toBe('late-held');nextHold=false;d.record.delivery='held-real-response';held={res,bytes:d.bytes,status:d.status,headers:d.headers,index:d.record.index};}
     else if(d.asset&&nextCorrupt){expect(stage()?.name).toBe('corrupt-image');expect(d.status).toBe(200);nextCorrupt=false;d.record.delivery='truncated-real-png-first-byte';d.record.delivered_bytes=1;res.writeHead(d.status,{...d.headers,'Content-Length':String(d.bytes.length),'Connection':'close'});res.write(d.bytes.subarray(0,1));await new Promise<void>(yes=>setTimeout(()=>{res.destroy();yes();},100));}
     else{res.writeHead(d.status,d.headers);res.end(d.bytes);}await persist();
    }finally{pending--;}
   }
   async function capture(name:string,data:Row){
    const p=stage() as Row|undefined;expect(name).toBe(p?.name);expect(data.run_id).toBe(runId);expect(data.previous_ack??null).toBe(lastAck);expect(data.captured_at_ms).toBeGreaterThan(Number(evidence.at(-1)?.captured_at_ms??0));
    expect(data.errors).toEqual([]);expect(data.width).toBe(p!.width);expect(data.viewportWidth).toBe(p!.width);expect(data.scrollWidth).toBeLessThanOrEqual(data.clientWidth);expect(new URL(data.href).origin).toBe(origin);expect(actor).toBe(p!.owner);
    const current=traces.slice(Number(evidence.at(-1)?.trace_count??0)),hot=current.filter(t=>t.path==='/api/product/hot'&&t.method==='GET'),evaluations=current.filter(t=>/^\/api(?:\/v2)?\/agent\/level_(?:list|task_list)$/.test(t.path)&&t.method==='GET');
    if(p!.kind==='finance'){expect(data.href).toContain('/pages/user/finance');expect(data.text).toContain('分销等级');expect(evaluations).toEqual([]);}
    else if(p!.kind==='guest'){expect(data.text).toContain('请先登录');expect(data.product_ids).toEqual([]);expect(evaluations).toEqual([]);expect(hot).toEqual([]);}
    else if(p!.kind==='product'){expect(data.href).toContain('/pages/goods/detail?id='+(ids.product+22));expect(current.filter(t=>t.classification.kind==='ordinary-detail-visit')).toHaveLength(1);}
    else if(p!.kind==='activity'){expect(data.href).toContain('/pages/activity/bargainDetail?id='+ids.bargain);expect(current.some(t=>/bargain/.test(t.path))).toBe(true);}
    else if(p!.kind==='invite'){expect(data.href).toContain('/pages/user/spread');expect(evaluations).toEqual([]);}
    else if(p!.kind==='held'){expect(held).toBeDefined();expect(data.loading).toBe(true);expect(data.nickname).toBe('');expect(evaluations).toHaveLength(1);}
    else{
     expect(data.href).toContain('/pages/users/user_distribution_level/index');expect(data.owner).toBe(p!.owner);expect(data.nickname).toBe(p!.owner===ids.a?'PHP分销自然升级':'PHP历史赠予等级');
     expect(data.product_ids).toHaveLength('products'in p!?p!.products:0);expect(new Set(data.product_ids).size).toBe(data.product_ids.length);
     if(p!.kind==='recommendation-error'){expect(data.recommendation_error).not.toBe('');expect(hot).toHaveLength(1);expect(hot[0].delivery).toBe('truncated-real-json-first-byte');expect(evaluations).toEqual([]);}
     else expect(data.recommendation_error).toBe('');
     if(name==='natural-upgrade'){expect(evaluations.map(t=>t.path)).toEqual(['/api/v2/agent/level_list','/api/v2/agent/level_task_list']);expect(evaluations[0].classification.new_records).toHaveLength(9);expect(data.badge).toContain('V1');expect(data.selected_level).toBe(ids.next);expect(data.tasks).toHaveLength(2);expect(data.task_text).toContain('1.00元');}
     if(name==='repeated-get'){expect(evaluations).toHaveLength(2);expect(evaluations.every(t=>t.classification.attempted_record_allocations===0)).toBe(true);}
     if(name==='all-five-granted'){expect(data.selected_level).toBe(ids.first);expect(data.tasks).toHaveLength(5);expect(data.tasks.map((t:Row)=>t.id)).toEqual([660501,660502,660503,660504,660505]);expect(data.tasks.every((t:Row)=>t.text.includes('已完成'))).toBe(true);expect(hot).toEqual([]);expect(evaluations).toHaveLength(1);expect(evaluations[0].path).toBe('/api/v2/agent/level_task_list');expect(evaluations[0].classification.new_records).toEqual([]);}
     if(name==='next-level-selected'){expect(data.selected_level).toBe(ids.next);expect(data.tasks).toHaveLength(2);expect(data.task_text).toContain('1.00元');expect(hot).toEqual([]);expect(evaluations).toHaveLength(1);expect(evaluations[0].classification.new_records).toEqual([]);}
     if(name==='page2-retried'){expect(hot).toHaveLength(1);expect(hot[0].query).toContain('page=2');expect(evaluations).toEqual([]);}
     if(name==='page3-final'){expect(hot).toHaveLength(1);expect(hot[0].query).toContain('page=3');expect(data.text).toContain('没有更多推荐了');}
     if(name==='terminal'){expect(hot).toEqual([]);expect(evaluations).toEqual([]);}
     if(name==='hidden-grant')expect(data.text).toContain('目前已隐藏');
     if(name==='deleted-grant')expect(data.text).toContain('配置已删除');
     if(name==='maximum-grant'){expect(data.badge).toContain('V5');expect(evaluations.find(t=>t.path.endsWith('/level_list'))?.dto.data.next_level).toBe(null);}
     if(name==='zero-tasks'){expect(data.text).toContain('该等级没有开启任务');expect(data.tasks).toEqual([]);}
     if(p!.kind==='media-error'){expect(data.failed_placeholders).toBeGreaterThan(0);expect(current.some(t=>t.path==='/api/assets/'+ids.media&&(t.status===404||t.delivery==='truncated-real-png-first-byte'))).toBe(true);}
     if(name==='media-restored'){expect(data.images.some((r:Row)=>r.src.startsWith('/api/assets/'+ids.media+'?')&&r.complete&&r.naturalWidth>0)).toBe(true);}
     if(name==='new-owner-released'){expect(held).toBeUndefined();expect(evaluations).toEqual([]);expect(hot).toEqual([]);expect(data.text).not.toContain('PHP分销自然升级');}
     if(name==='empty-recommendations'){expect(hot).toHaveLength(1);expect(hot[0].dto.data.list).toEqual([]);}
     if(name==='desktop'){expect(data.grid_columns).toBe(2);expect(data.commission_columns).toBe(2);}
     if(!['recommendation-error','media-error','empty'].includes(p!.kind)){expect(data.loading).toBe(false);expect(data.images.filter((r:Row)=>r.src.startsWith('/api/assets/')).every((r:Row)=>r.complete&&r.naturalWidth>0)).toBe(true);}
    }
    expect(await f.snapshot()).toEqual(expected);expect(f.forbidden).not.toHaveBeenCalled();const ack=randomUUID();evidence.push({name,...data,ack,trace_count:traces.length,snapshot_sha256:remember(expected),resources:f.resources()});lastAck=ack;await persist();
    if(name==='finished'){expect(traces.some(t=>t.delivery==='truncated-real-json-first-byte')).toBe(true);expect(traces.some(t=>t.delivery==='truncated-real-png-first-byte')).toBe(true);expect(traces.some(t=>t.delivery==='held-real-response'&&t.release)).toBe(true);expect(nextLost||nextHold||nextCorrupt||!!held).toBe(false);expect(await sources()).toEqual(sourceBefore);expect(await builds()).toEqual(buildBefore);expect(outbound).not.toHaveBeenCalled();}
    return{accepted:true,name,run_id:runId,ack,next:stage()?.name??null,complete:evidence.length===distributionBrowserPlans.length};
   }
   const observer='<script>window.__distributionQa={errors:[],resourceErrors:[]};addEventListener("error",e=>{const q=window.__distributionQa;if(e.target&&["IMG","VIDEO","SOURCE"].includes(e.target.tagName))q.resourceErrors.push({src:e.target.getAttribute("src"),at:Date.now()});else q.errors.push({message:e.message||"unknown",at:Date.now()})},true);addEventListener("unhandledrejection",e=>window.__distributionQa.errors.push({message:String(e.reason),at:Date.now()}));</script>';
   const shell=(await readFile(resolve(import.meta.dirname,'distribution-level.shell.html'),'utf8')).replaceAll('__CONTROL__',JSON.stringify(control)).replaceAll('__RUN_ID__',JSON.stringify(runId)).replaceAll('__PLANS__',JSON.stringify(distributionBrowserPlans)).replaceAll('__OWNERS__',JSON.stringify({a:ids.a,b:ids.b}));
   server=createServer((req,res)=>{void(async()=>{
    expect(req.socket.remoteAddress).toBe('127.0.0.1');expect(req.headers.host).toBe(new URL(origin).host);req.on('error',(error:Error&{code?:string})=>{controls.push({kind:'incoming-transport-error',message:error.message,code:error.code??'',phase:stage()?.name,at_ms:Date.now()});if(error.message!=='aborted'||error.code!=='ECONNRESET'){failure??=error;fail(error);}});const url=new URL(req.url??'/',origin);const raw=await requestBody(req);
    if(url.pathname.startsWith(control)){
     expect(req.method).toBe('POST');controls.push({kind:'qa-control-request',run_id:runId,phase:stage()?.name,path:url.pathname,query:url.search,body_base64:raw.toString('base64'),body_sha256:hash(raw),at_ms:Date.now()});
     if(url.pathname===control+'/session'){const uid=Number(url.searchParams.get('owner'));expect([0,ids.a,ids.b]).toContain(uid);expect(uid).toBe(stage()?.owner);actor=uid;controls.push({kind:'qa-new-document-session',nonproof:true,owner:uid,at_ms:Date.now()});json(res,{token:uid?f.tokens.get(uid):'',uid});return;}
     if(url.pathname===control+'/fixture'){const scenario=url.searchParams.get('name')as DistributionScenario;expect((stage() as Row)?.scenario??null).toBe(scenario);expect(pending+queued).toBe(0);json(res,await serial(async()=>{expect(await f.snapshot()).toEqual(expected);const result=await f.control(scenario);expect(result.before).toEqual(expected);expected=result.after;controls.push({...result,before_sha256:remember(result.before),after_sha256:remember(result.after),at_ms:Date.now()});await persist();return{accepted:true,scenario};}));return;}
     if(url.pathname===control+'/lost'){expect(stage()?.name).toBe('page2-lost');nextLost=true;json(res,{accepted:true});return;}
     if(url.pathname===control+'/corrupt'){expect(stage()?.name).toBe('corrupt-image');nextCorrupt=true;json(res,{accepted:true});return;}
     if(url.pathname===control+'/hold'){expect(stage()?.name).toBe('late-held');nextHold=true;json(res,{accepted:true});return;}
     if(url.pathname===control+'/release'){expect(stage()?.name).toBe('new-owner-released');expect(held).toBeDefined();const h=held!;held=undefined;traces[h.index].release={at_ms:Date.now(),client_socket_destroyed:h.res.destroyed||h.res.socket?.destroyed,bytes:h.bytes.length,sha256:hash(h.bytes),kind:'writer-attempt-after-document-replacement'};h.res.writeHead(h.status,h.headers);h.res.end(h.bytes);await persist();json(res,{accepted:true});return;}
     if(url.pathname.startsWith(control+'/phase/')){if(pending+queued){json(res,{accepted:false,reason:'pending-business',activity:activity()});return;}const result=await serial(()=>capture(url.pathname.slice((control+'/phase/').length),JSON.parse(raw.toString())));if(result.complete)res.once('finish',done);json(res,result);return;}
     throw Error('Unknown distribution QA control');
    }
    if(url.pathname.startsWith('/api/')){await dispatch(req,res,url,raw);return;}
    expect(req.method).toBe('GET');if(url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end(shell);return;}if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
    const path=decodeURIComponent(url.pathname),target=path==='/__h5'?resolve(dist,'index.html'):resolve(dist,'.'+path);expect(target.startsWith(dist+sep)).toBe(true);
    const original=await readFile(target),index=target===resolve(dist,'index.html'),bytes=index?Buffer.from(original.toString().replace('<head>','<head><link rel="icon" href="data:,">'+observer)):original;
    statics.push({run_id:runId,phase:stage()?.name,path,file:target.slice(repository.length+1),source_sha256:hash(original),served_sha256:hash(bytes),source_bytes:original.length,bytes:bytes.length,index_observer:index});
    const mime:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.gif':'image/gif','.svg':'image/svg+xml','.ttf':'font/ttf','.woff2':'font/woff2','.ico':'image/x-icon'};
    res.writeHead(200,{'Content-Type':mime[extname(target)]??'application/octet-stream'});res.end(bytes);
   })().catch(error=>{failure??=error;controls.push({kind:'server-error',path:req.url,error:String(error),at_ms:Date.now()});void persist().then(()=>fail(error),fail);if(!res.headersSent)res.writeHead(500);res.end(String(error));});});
   server.on('upgrade',(_req,socket)=>{const error=Error('Unexpected distributor Browser websocket');failure??=error;fail(error);socket.destroy();});
   timer=setTimeout(()=>fail(Error('Distributor Browser deadline')),55*60000);await new Promise<void>((yes,no)=>{server!.once('error',no);server!.listen(0,'127.0.0.1',yes);});const address=server.address();if(!address||typeof address==='string')throw Error('Missing kernel port');origin='http://127.0.0.1:'+address.port;
   await writeFile(prefix+'ready.json',JSON.stringify({status:'ready',run_id:runId,control,origin,prefix,pid:process.pid,plans:distributionBrowserPlans,tables:f.tables,sequences:f.sequences,identities:runtime.identities,
    setup:f.setup,synthetic_authority:{app_key_base64:Buffer.from(runtime.env.APP_KEY).toString('base64'),tokens:[...f.tokens]},baseline_sha256:remember(expected),resources:initialResources,source_manifest:sourceBefore,build_manifest:buildBefore,
    boundary:'Actual built H5 and registered Worker/JWT/full PG16 independent LOGIN. EvaluatorGET permits independently derived real-account rank/task/serial deltas; hot/media reads conserve all283tables229sequences. Ordinary detail waitUntil has its own exact visit/log/serial delta. Finite fixture/session/transport controls are nonproof. Cross-document late-owner response only; no same-instanceABA,naturalexpiry,login/provider/award claim.'},null,2)+'\n',{mode:0o600});
   console.log('DISTRIBUTION_LEVEL_BROWSER_READY '+origin);await complete;await queue;
   if(server){server.closeAllConnections();await new Promise<void>((yes,no)=>server!.close(e=>e?no(e):yes()));}
   await writeFile(prefix+'evidence.json',JSON.stringify({status:'passed',run_id:runId,control,plans:distributionBrowserPlans,evidence,traces,controls,statics,snapshots_by_sha256:snapshots,
    setup:f.setup,final_sha256:remember(await f.snapshot()),resources:f.resources(),r2_reads:f.assetReads,kv_reads:f.kvReads,identities:runtime.identities,source_manifest:sourceBefore,build_manifest:buildBefore},null,2)+'\n',{mode:0o600});
  });
 }catch(error){failure??=error;await writeFile(prefix+'failed.json',JSON.stringify({status:'failed',run_id:runId,error:String(error),stack:error instanceof Error?error.stack:null,evidence,traces,controls,statics,snapshots_by_sha256:snapshots,expected,actual:await f.snapshot().catch(()=>null)},null,2)+'\n',{mode:0o600});throw error;}
 finally{clearTimeout(timer);try{if(server?.listening){server.closeAllConnections();await new Promise<void>((yes,no)=>server!.close(e=>e?no(e):yes()));}}catch(error){cleanupFailure??=error;}
  try{await f.close();fixtureClosed=true;}catch(error){cleanupFailure??=error;}wiring.context=undefined;vi.restoreAllMocks();
  await writeFile(prefix+'cleanup.json',JSON.stringify({run_id:runId,server_closed:!server?.listening,fixture_closed:fixtureClosed,pending,queued,failure:failure?String(failure):null,cleanup_failure:cleanupFailure?String(cleanupFailure):null})+'\n',{mode:0o600});if(cleanupFailure)throw cleanupFailure;}
},57*60000);

