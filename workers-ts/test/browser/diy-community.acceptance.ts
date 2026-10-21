import { expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createApp } from "@/app";
import type { Container } from "@/lib/di";
import { systemConfig, systemDise } from "@/models/schema";
import { diyCommunityFixture } from "../helpers/diyCommunityFixture";
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock("@/lib/di",async original=>({...await original<typeof import("@/lib/di")>(),createContainer:()=>{
  if(!wiring.container)throw Error("Missing owned DIY community SQL");return wiring.container;
}}));
type Row=Record<string,any>;type Snapshot=Record<string,Row[]>;
const stable=(value:unknown):string=>JSON.stringify(value,(_key,p)=>p&&typeof p==='object'&&!Array.isArray(p)?Object.fromEntries(Object.entries(p).sort(([a],[b])=>a.localeCompare(b))):p);
const sorted=(state:Snapshot):Snapshot=>Object.fromEntries(Object.entries(state).map(([key,rows])=>[key,rows.slice().sort((a,b)=>stable(a).localeCompare(stable(b)))]));
const digest=(value:unknown)=>createHash('sha256').update(stable(value)).digest('hex');
async function bytes(req:IncomingMessage){const parts:Buffer[]=[];let size=0;for await(const part of req){const b=Buffer.from(part);size+=b.length;expect(size).toBeLessThan(100_000);parts.push(b);}return Buffer.concat(parts);}
it('actual background home and micro community widgets use per-block community reads and safe destinations',async()=>{
  const f=await diyCommunityFixture(),app=createApp();wiring.container=f.container;
  const root=resolve(import.meta.dirname,'../../../view/uniapp-ts/dist/build/h5'),origin='http://127.0.0.1:40767',control='/__diy_community/'+randomUUID(),prefix='/tmp/cinashop-diy-community-browser-';
  const stages=['homeFirst','homeRetry','readonlyRefresh','microInitial','changedSchema','moreMain','returnHome','imageOpen','returnAfterImage','videoOpen','returnAfterVideo','communityClosed','closedRetry','communityReopened','guestHome','account22','micro22','finished'];
  const routes={home:{uid:11,route:'/pages/index/index',label:'账号11实际首页'},micro:{uid:11,route:'/pages/diy/detail?id=2',label:'账号11实际微页面'},guest:{uid:0,route:'/pages/index/index',label:'游客实际首页'},other:{uid:22,route:'/pages/index/index',label:'账号22实际首页'},otherMicro:{uid:22,route:'/pages/diy/detail?id=2',label:'账号22实际微页面'}};
  const visitPlans=[1,2],traces:Row[]=[],evidence:Row[]=[],configs:Row[]=[],staticPaths=new Set<string>();let failedSeven=false;
  let done!:()=>void,fail!:(error:Error)=>void;const completion=new Promise<void>((yes,no)=>{done=yes;fail=no;});completion.catch(()=>{});
  const external=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Owned DIY acceptance forbids providers'));
  const send=(res:ServerResponse,body:string|Buffer,status=200,type='text/html')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(body);};
  const json=(res:ServerResponse,data:unknown,status=200)=>send(res,JSON.stringify(data),status,'application/json');
  let pending=Promise.resolve();function serial<T>(work:()=>Promise<T>):Promise<T>{const next=pending.then(work);pending=next.then(()=>{},()=>{});return next;}
  try{
    const tables=(await f.db.execute<{name:string}>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(r=>r.name);expect(tables).toHaveLength(16);
    async function snapshot():Promise<Snapshot>{const state:Snapshot={};for(const name of tables)state[name]=(await f.db.execute<{row:Row}>(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(name)} t`)).map(r=>r.row);
      state.__sequences=await f.db.execute(sql`SELECT sequencename AS name,last_value::text AS last FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`);expect(state.__sequences).toHaveLength(16);return sorted(state);}
    const initial=await snapshot();let expected=initial;
    const storage=()=>({objects:digest([...f.objects].map(([key,v])=>({key,type:v.type,bytes:[...v.bytes]}))),puts:f.bucket.put.mock.calls.length,deletes:f.bucket.delete.mock.calls.length});const initialStorage=storage();
    async function api(req:IncomingMessage,res:ServerResponse,url:URL){return serial(async()=>{
      expect(req.method??'GET').toBe('GET');expect(await bytes(req)).toHaveLength(0);expect(url.pathname).not.toBe('/api/diy/video_list');expect(url.pathname).not.toMatch(/\/community\/(?:share|browse)\//u);
      const headers=new Headers();for(let i=0;i<req.rawHeaders.length;i+=2)headers.append(req.rawHeaders[i],req.rawHeaders[i+1]);
      const viewer=headers.get('Authori-zation')===`Bearer ${f.token}`?11:headers.get('Authori-zation')===`Bearer ${f.otherToken}`?22:0;
      const detail=/^\/api\/community\/detail\//u.test(url.pathname),visitCount=traces.filter(t=>t.detail).length;
      if(detail){expect(viewer).toBe(11);expect(Number(url.pathname.split('/').at(-1))).toBe(visitPlans[visitCount]);}
      if(url.pathname==='/api/community/list'&&evidence.length<=3){expect(url.searchParams.get('page')).toBe('1');expect(['3','7']).toContain(url.searchParams.get('limit'));expect(url.searchParams.get('is_follow')).toBe('0');for(const key of['topic_id','author_type','relation_id','content_type'])expect(url.searchParams.has(key)).toBe(false);}
      const before=await snapshot();expect(before).toEqual(expected);const waits:Promise<unknown>[]=[];
      const response=await app.fetch(new Request(url.href,{headers}),f.env,{waitUntil:work=>{waits.push(work);},passThroughOnException(){}}as ExecutionContext);await Promise.all(waits);
      const unsignedAsset=url.pathname.startsWith('/api/assets/')&&!url.searchParams.has('signature');expect(unsignedAsset?[404]:[200,206]).toContain(response.status);const raw=Buffer.from(await response.arrayBuffer()),payload=response.headers.get('Content-Type')?.includes('application/json')?JSON.parse(raw.toString()):undefined;
      const after=await snapshot();let receipt:Row|undefined;
      if(detail){expect(payload.status).toBe(200);const id=visitPlans[visitCount],want=structuredClone(before),post=before.community.find(r=>r.id===id)!;
        expect(payload.data).toMatchObject({id,playNum:post.play_num+1});want.community=want.community.map(r=>r.id===id?{...r,play_num:r.play_num+1}:r);
        const inserted=after.community_relevance.filter(r=>!before.community_relevance.some(old=>old.id===r.id));expect(inserted).toHaveLength(1);const edge=inserted[0],seq=want.__sequences.find(r=>r.name==='community_relevance_id_seq')!;
        expect(edge).toEqual({id:seq.last===null?1:Number(seq.last)+1,left_id:11,right_id:id,type:'community_browse'});seq.last=String(edge.id);want.community_relevance.push(edge);expect(after).toEqual(sorted(want));receipt={id,kind:'browse',sequence_delta:1};
      }else{expect(after).toEqual(before);if(payload)expect([200,410010]).toContain(payload.status);}
      const readFailure=!failedSeven&&url.pathname==='/api/community/list'&&url.searchParams.get('limit')==='7';if(readFailure)failedSeven=true;
      expected=after;expect(storage()).toEqual(initialStorage);traces.push({path:url.pathname,query:url.search,viewer,detail,status:payload?.status??response.status,browser_status:readFailure?503:response.status,injected_read_failure:readFailure,expected_unsigned_asset_denial:unsignedAsset,receipt,snapshot:{before:digest(before),after:digest(after),unchanged:!detail,tables:16,sequences:16}});
      if(readFailure)return json(res,{status:503,msg:'本地验收：七条组件读取失败，请单独重试'},503);
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(raw);
    });}
    async function configure(req:IncomingMessage,res:ServerResponse){return serial(async()=>{
      const input=JSON.parse((await bytes(req)).toString()),before=await snapshot();expect(before).toEqual(expected);const want=structuredClone(before);
      if(configs.length===0){expect(evidence.at(-1)?.stage).toBe('microInitial');expect(input).toEqual({action:'schema'});
        const blocks=structuredClone(f.blocks)as Row[];const a=blocks.find(r=>r.timestamp===101)!,b=blocks.find(r=>r.timestamp===102)!;a.numberConfig.val=5;a.styleConfig.tabVal=1;a.titleTxtConfig.value='更新社区五条';b.timestamp=100;b.numberConfig.val=2;b.styleConfig.tabVal=0;
        const value=JSON.stringify(blocks);for(const id of[1,2])await f.db.update(systemDise).set({value,version:'diy-community-2'}).where(eq(systemDise.id,id));want.system_dise=want.system_dise.map(r=>r.id===1||r.id===2?{...r,value,version:'diy-community-2'}:r);
      }else{const closed=configs.length===1;expect(input).toEqual({action:closed?'close':'open'});expect(evidence.at(-1)?.stage).toBe(closed?'returnAfterVideo':'closedRetry');const value=closed?'0':'1';await f.db.update(systemConfig).set({value}).where(eq(systemConfig.menuName,'community_status'));want.system_config=want.system_config.map(r=>r.menu_name==='community_status'?{...r,value}:r);f.cache.set('cfg_community_status',closed?'1':'0');}
      const after=await snapshot();expect(after).toEqual(sorted(want));expected=after;configs.push({...input,before:digest(before),after:digest(after),sequence_delta:0});json(res,{configurations:configs.length,action:input.action});
    });}
    async function checkpoint(req:IncomingMessage,res:ServerResponse,stage:string){return serial(async()=>{
      const index=evidence.length;expect(stage).toBe(stages[index]);const data=JSON.parse((await bytes(req)).toString()),current=await snapshot();expect(current).toEqual(expected);
      expect(data.width).toBe(375);expect(data.scrollWidth).toBeLessThanOrEqual(375);expect(data.text).not.toMatch(/Internal Server Error|Failed to resolve|Cannot read properties/u);
      const titles=(count:number)=>Array.from({length:count},(_,i)=>i===1?'社区视频02':`社区图文${String(i+1).padStart(2,'0')}`);
      if(!['moreMain','imageOpen','videoOpen'].includes(stage)){expect(data.text).toContain('保留商城内容');expect(data.widgets).toHaveLength(2);
        const closed=['communityClosed','closedRetry'].includes(stage),changed=index>=4;
        const expectedWidgets=changed?[{key:'100',layout:'horizontal',count:2},{key:'101',layout:'columns',count:5}]:[{key:'101',layout:'horizontal',count:3},{key:'102',layout:'columns',count:stage==='homeFirst'?0:7}];
        expect(data.widgets.map((r:Row)=>({key:r.key,layout:r.layout,count:r.titles.length}))).toEqual(expectedWidgets.map(r=>({...r,count:closed?0:r.count})));
        for(const widget of data.widgets){const count=expectedWidgets.find(r=>r.key===widget.key)!.count;expect(widget.titles).toEqual(closed?[]:titles(count));}
        if(!closed){expect(data.widgets.find((r:Row)=>r.key==='101').heading).toContain(changed?'更新社区五条':'社区横向三条');if(stage!=='homeFirst')expect(data.widgets.find((r:Row)=>r.key=== (changed?'100':'102')).titleImage).toContain('/static/logo.png');}
        if(closed){expect(data.text).toContain('社区暂未开放');expect(traces.slice(evidence.at(-1)?.traces??0).some(t=>t.path==='/api/community/list')).toBe(false);}
      }
      if(stage==='homeFirst')expect(data.text).toContain('七条组件读取失败');
      if(stage==='homeRetry'||stage==='readonlyRefresh'){const counts=(limit:string)=>traces.filter(t=>t.path==='/api/community/list'&&new URLSearchParams(t.query).get('limit')===limit).length;expect(counts('3')).toBe(stage==='homeRetry'?1:2);expect(counts('7')).toBe(2);}
      if(stage==='moreMain'){expect(data.href).toContain('#/pages/discover/index');expect(data.text).toContain('商户公共帖子');expect(data.text).toContain('跨作者污染封面');expect(data.text).not.toContain('帖子响应格式错误');}
      if(stage==='imageOpen'){expect(data.detail).toContain('社区图文01');expect(data.href).toContain('/pages/discover/workspace?id=1');}
      if(stage==='videoOpen'){expect(data.videoTitle).toBe('社区视频02');expect(data.href).toContain('/pages/discover/discoverVideo/index?id=2');expect(data.video?.readyState).toBeGreaterThanOrEqual(1);expect(data.video?.width).toBeGreaterThan(0);}
      const visits=index<7?0:index<9?1:2;expect(traces.filter(t=>t.detail)).toHaveLength(visits);expect(storage()).toEqual(initialStorage);expect(external).not.toHaveBeenCalled();
      evidence.push({stage,...data,traces:traces.length,visits,database_sha:digest(current)});
      if(stage==='finished'){expect(configs).toHaveLength(3);await writeFile(prefix+'evidence.json',JSON.stringify({evidence,traces,configs,tables,sequences:16,initial_sha:digest(initial),final_sha:digest(current),initial_video:initial.video,final_video:current.video,initial_relations:initial.user_relation,final_relations:current.user_relation,storage:{initial:initialStorage,final:storage()},providerCalls:0,static_paths:[...staticPaths].sort(),authority:'Actual H5 DOM/createApp/JWT/owned PG16. Synthetic controls only route/session/viewport/schema-and-master settings/checkpoints; list7 read fails once after real read. Only two explicit destination detail visits may write.',limitations:'No real login, production schema/ACL/index/KV/R2 or MP/App device claim; in-place reconfiguration races verified separately by actual runtime tests. Config schema reload is actual navigation with version refresh.'},null,2)+'\n');done();}
      json(res,{checked:evidence.map(r=>r.stage),finished:stage==='finished'});
    });}
    const shell=()=>`<!doctype html><html lang="zh"><meta charset="utf-8"><title>DIY社区组件后台验收</title><style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:375px;height:830px;border:1px solid #ddd}pre{max-height:50px;overflow:auto}</style><h1>实际首页与微页面社区组件</h1>${Object.entries(routes).map(([key,r])=>`<button data-route="${key}">${r.label}</button>`).join('')}<button data-size>375像素内容区</button><button data-action="schema">更新两组件配置（仅fixture）</button><button data-action="close">社区关闭（仅fixture）</button><button data-action="open">社区开启（仅fixture）</button>${stages.map(stage=>`<button data-stage="${stage}">${stage}</button>`).join('')}<pre id="result"></pre><iframe title="实际DIY页面"></iframe><script>
const frame=document.querySelector('iframe'),routes=${JSON.stringify(routes)},actor=${JSON.stringify(f.token)},other=${JSON.stringify(f.otherToken)};
for(const b of document.querySelectorAll('[data-route]'))b.onclick=()=>{const r=routes[b.dataset.route];localStorage.setItem('uni_token',JSON.stringify({type:'string',data:r.uid===11?actor:r.uid===22?other:''}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:r.uid}));frame.src='/?diy_community_session='+r.uid+'-'+Date.now()+'#'+r.route;};
document.querySelector('[data-size]').onclick=()=>{const d=frame.contentDocument;frame.style.width=(375+frame.contentWindow.innerWidth-d.documentElement.clientWidth)+'px';};
for(const b of document.querySelectorAll('[data-action]'))b.onclick=async()=>{const r=await fetch('${control}/configure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:b.dataset.action})});document.getElementById('result').textContent=JSON.stringify(await r.json());};
const visible=e=>{if(!e)return false;for(let p=e;p;p=p.parentElement)if(getComputedStyle(p).display==='none'||getComputedStyle(p).visibility==='hidden')return false;return true;},txt=e=>visible(e)?e.textContent.trim().replace(/\\s+/g,' '):'';
for(const b of document.querySelectorAll('[data-stage]'))b.onclick=async()=>{const d=frame.contentDocument,all=(s,p=d)=>[...p.querySelectorAll(s)].filter(visible),one=s=>all(s)[0],v=one('.video-player video'),data={href:frame.contentWindow.location.href,width:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,text:txt(d.body),detail:all('.detail-sheet').map(txt).join(' '),videoTitle:txt(one('.video-feature .video-title')),video:v?{readyState:v.readyState,width:v.videoWidth,src:v.currentSrc}:null,widgets:all('.diy-community-widget').map(e=>({key:e.dataset.componentKey,layout:e.dataset.layout,heading:txt(e),titles:all('.diy-community-post-title',e).map(txt),authors:all('.diy-community-author',e).map(txt),titleImage:all('.diy-community-title-image img',e)[0]?.src||all('.diy-community-title-image',e)[0]?.getAttribute('src')||''}))};const r=await fetch('${control}/'+b.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.getElementById('result').textContent=JSON.stringify(await r.json());};</script></html>`;
    const server=createServer((req,res)=>{void(async()=>{if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==new URL(origin).host)return send(res,'Owned loopback only',403);const url=new URL(req.url??'/',origin),path=url.pathname;
      if(path===control&&req.method==='GET')return send(res,shell());if(path===control+'/configure'&&req.method==='POST')return configure(req,res);if(path.startsWith(control+'/')&&req.method==='POST')return checkpoint(req,res,path.slice(control.length+1));
      const chrome:Row={'/api/site_config':{site_name:'DIY社区验收',site_logo:'',record_No:'',ico_path:''},'/api/share':{title:'DIY社区',synopsis:'',img:''},'/api/products':{list:[],count:0},'/api/category':[], '/api/get_open_adv':{status:0,time:3,interval_time:24,type:'pic',value:[],video_link:''},'/api/diy/get_suspended':{is_show:0,button:[]},'/api/v2/diy/color_change/color_change':{},'/api/v2/diy/product_detail':{}};
      if(req.method==='GET'&&Object.hasOwn(chrome,path))return json(res,{status:200,data:chrome[path],msg:'Synthetic unrelated navigation/commerce chrome only'});
      if(path.startsWith('/api/'))return api(req,res,url);if(path==='/favicon.ico')return send(res,'',204);const target=resolve(root,'.'+decodeURIComponent(path));if(target!==root&&!target.startsWith(root+sep))return send(res,'Owned build only',403);
      try{if(target!==root&&(await stat(target)).isFile()){staticPaths.add(path);return send(res,await readFile(target),200,({'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.svg':'image/svg+xml'}as Row)[extname(target)]??'application/octet-stream');}}catch{/*Actual SPA.*/}send(res,await readFile(resolve(root,'index.html')));
    })().catch(reason=>{fail(reason instanceof Error?reason:Error(String(reason)));if(!res.headersSent)send(res,String(reason),500);else res.destroy();});});
    let deadline:ReturnType<typeof setTimeout>|undefined;
    try{await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(40767,'127.0.0.1',yes);});const ready={url:origin+control,stages,routes,width:375,business_writes:0,deliberate_visits:2,configuration_changes:3};await writeFile(prefix+'ready.json',JSON.stringify(ready,null,2)+'\n');process.stdout.write('DIY_COMMUNITY_BROWSER_READY '+JSON.stringify(ready)+'\n');deadline=setTimeout(()=>fail(Error('Browser completion absent within owned eight-minute window')),8*60_000);await completion;}
    finally{if(deadline)clearTimeout(deadline);server.closeAllConnections();if(server.listening)await new Promise<void>(yes=>server.close(()=>yes()));}
  }finally{external.mockRestore();wiring.container=undefined;await f.close();}
},9*60_000);
