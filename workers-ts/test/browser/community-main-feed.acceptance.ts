import { expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createApp } from "@/app";
import type { Container } from "@/lib/di";
import { systemConfig } from "@/models/schema";
import { communityMainFeedBrowserFixture } from "../helpers/communityMainFeedBrowserFixture";
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock("@/lib/di", async original => ({ ...await original<typeof import("@/lib/di")>(), createContainer: () => {
  if (!wiring.container) throw Error("Missing owned main feed SQL"); return wiring.container;
} }));
type Row = Record<string, any>; type Snapshot = Record<string, Row[]>;
const stable = (value: unknown): string => JSON.stringify(value, (_key, part) => part && typeof part === "object" && !Array.isArray(part)
  ? Object.fromEntries(Object.entries(part).sort(([a],[b])=>a.localeCompare(b))) : part);
const sorted = (state: Snapshot): Snapshot => Object.fromEntries(Object.entries(state).map(([key,rows])=>[key,rows.slice().sort((a,b)=>stable(a).localeCompare(stable(b)))]));
const digest = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
async function bytes(req: IncomingMessage) { const parts: Buffer[]=[]; let length=0; for await (const part of req) {
  const buffer=Buffer.from(part);length+=buffer.length;expect(length).toBeLessThan(160_000);parts.push(buffer); } return Buffer.concat(parts); }
it("actual background main feed paging, follow discovery, unknown receipts and mixed featured activations", async () => {
  const f=await communityMainFeedBrowserFixture(),app=createApp();wiring.container=f.container;
  const root=resolve(import.meta.dirname,"../../../view/uniapp-ts/dist/build/h5"),origin="http://127.0.0.1:40766";
  const control="/__community_main_feed/"+randomUUID(),prefix="/tmp/cinashop-community-main-feed-browser-";
  const stages=["discoverPage1","page2Error","discoverPage2","discoverPage3","topicPage1","topicPage2","refreshed","unknownLike",
    "followingEmpty","recommendedPreview","unknownFollow","discoverUnknown","communityClosed","communityReopened","likeReconciled",
    "followingUnknown","followReconciled","followingPage2","featuredFirst","featuredVideo","featuredPage2","featuredPage3","featuredLast",
    "featuredClosed","featuredRecovered","rawMain","appCanonical","appReadonly","guestFollowing","invalidFeatured","account22","finished"];
  const routes={main:{uid:11,route:"/pages/discover/workspace",label:"账号11主列表"},raw:{uid:11,route:"/pages/discoverIndex/index",label:"旧主原始入口"},
    app:{uid:11,route:"/pages/discover/workspace?feed=featured",label:"本地App精选入口"},guest:{uid:0,route:"/pages/discover/workspace",label:"游客主列表"},
    invalid:{uid:11,route:"/pages/discover/workspace?feed=featured&author_id=22",label:"冲突精选参数"},other:{uid:22,route:"/pages/discover/workspace",label:"账号22主列表"}};
  const visitPlans=[f.previewId,...f.orderedIds,f.mainId];
  const visitsAt=[0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,2,3,11,21,22,22,22,22,23,23,23,23,23,23];
  const configPlans=[["discoverUnknown","0"],["communityClosed","1"],["featuredLast","0"],["featuredClosed","1"]];
  const traces: Row[]=[],evidence: Row[]=[],configReceipts: Row[]=[],staticPaths=new Set<string>();let failedPage2=false;
  let done!:()=>void,fail!:(reason:Error)=>void;const completion=new Promise<void>((yes,no)=>{done=yes;fail=no;});completion.catch(()=>{});
  const external=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("Owned main feed acceptance forbids providers"));
  const send=(res:ServerResponse,value:string|Buffer,status=200,type="text/html")=>{res.writeHead(status,{"Content-Type":type,"Cache-Control":"no-store"});res.end(value);};
  const json=(res:ServerResponse,value:unknown,status=200)=>send(res,JSON.stringify(value),status,"application/json");
  let pending=Promise.resolve();function serial<T>(work:()=>Promise<T>):Promise<T>{const next=pending.then(work);pending=next.then(()=>{},()=>{});return next;}
  try {
    const tables=(await f.db.execute<{name:string}>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(r=>r.name);
    expect(tables).toHaveLength(14);
    async function snapshot():Promise<Snapshot>{const out:Snapshot={};for(const name of tables){expect(name).toMatch(/^[a-z_][a-z0-9_]*$/u);
      out[name]=(await f.db.execute<{row:Row}>(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(name)} t`)).map(r=>r.row);}
      out.__sequences=await f.db.execute(sql`SELECT sequencename AS name,last_value::text AS last FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`);return sorted(out);}
    const initial=await snapshot();expect(initial.__sequences).toHaveLength(14);let expected=initial;
    const storage=()=>({objects:digest([...f.objects].map(([key,item])=>({key,type:item.type,bytes:[...item.bytes]}))),puts:f.bucket.put.mock.calls.length,deletes:f.bucket.delete.mock.calls.length});
    const initialStorage=storage();
    function advance(want:Snapshot,row:Row){const sequence=want.__sequences.find(r=>r.name==="community_relevance_id_seq")!;
      expect(row.id).toBe(sequence.last===null?1:Number(sequence.last)+1);sequence.last=String(row.id);want.community_relevance.push(row);}
    function receipt(before:Snapshot,after:Snapshot,kind:"like"|"follow"|"browse",id:number,data:Row){
      const want=structuredClone(before);let inserted:Row|undefined;
      if(kind==="like"){
        const post=before.community.find(r=>r.id===id)!;expect(data).toEqual({likeNum:post.like_num+1,status:1});
        const rows=after.community_relevance.filter(r=>r.type==="community_like"&&r.left_id===11&&r.right_id===id);expect(rows).toHaveLength(1);inserted=rows[0];
        expect(before.community_relevance.some(r=>r.type==="community_like"&&r.left_id===11&&r.right_id===id)).toBe(false);
        want.community=want.community.map(r=>r.id===id?{...r,like_num:r.like_num+1}:r);
        const authors=want.community_user.filter(r=>r.type===post.type&&r.relation_id===post.relation_id&&!r.is_del);expect(authors).toHaveLength(1);
        want.community_user=want.community_user.map(r=>r.id===authors[0].id?{...r,like_num:r.like_num+1}:r);
      } else if(kind==="follow"){
        expect(data).toEqual({status:1,is_follow:1,is_fans:0});
        const rows=after.community_relevance.filter(r=>r.type==="community_interest"&&r.left_id===11&&r.right_id===22);expect(rows).toHaveLength(1);inserted=rows[0];
        expect(before.community_relevance.some(r=>r.type==="community_interest"&&r.left_id===11&&r.right_id===22)).toBe(false);
        want.community_user=want.community_user.map(r=>r.type===2&&r.relation_id===11?{...r,follow_num:r.follow_num+1}:r.type===2&&r.relation_id===22?{...r,fans_num:r.fans_num+1}:r);
      } else {
        const post=before.community.find(r=>r.id===id)!;expect(data.id).toBe(id);expect(data.playNum).toBe(post.play_num+1);
        want.community=want.community.map(r=>r.id===id?{...r,play_num:r.play_num+1}:r);
        const old=before.community_relevance.filter(r=>r.type==="community_browse"&&r.left_id===11&&r.right_id===id);
        if(!old.length){const rows=after.community_relevance.filter(r=>r.type==="community_browse"&&r.left_id===11&&r.right_id===id);expect(rows).toHaveLength(1);inserted=rows[0];}
      }
      if(inserted){expect(inserted).toEqual({id:inserted.id,left_id:11,right_id:id,type:kind==="like"?"community_like":kind==="follow"?"community_interest":"community_browse"});advance(want,inserted);}
      expect(after).toEqual(sorted(want));return {kind,id,sequence_delta:inserted?1:0};
    }
    async function api(req:IncomingMessage,res:ServerResponse,url:URL){return serial(async()=>{
      const body=await bytes(req),headers=new Headers();for(let i=0;i<req.rawHeaders.length;i+=2)headers.append(req.rawHeaders[i],req.rawHeaders[i+1]);
      const method=req.method??"GET",write=method!=="GET"||/^\/api\/community\/share\//u.test(url.pathname);
      const actor=headers.get("Authori-zation")===`Bearer ${f.token}`?11:headers.get("Authori-zation")===`Bearer ${f.otherToken}`?22:0;
      const detail=/^\/api\/community\/detail\//u.test(url.pathname),writes=traces.filter(t=>t.write);
      if(write){expect(actor).toBe(11);expect(JSON.parse(body.toString())).toEqual({status:1});expect(method).toBe("POST");
        expect(url.pathname).toBe(writes.length===0?`/api/community/like/${f.mainId}`:"/api/community/set_interest/22");expect(writes.length).toBeLessThan(2);}
      if(detail){expect(actor).toBe(11);expect(Number(url.pathname.split('/').at(-1))).toBe(visitPlans[traces.filter(t=>t.receipt?.kind==="browse").length]);}
      const before=await snapshot();expect(before).toEqual(expected);const waits:Promise<unknown>[]=[];
      const response=await app.fetch(new Request(url.href,{method,headers,...(body.length?{body}:{})}),f.env,{waitUntil:work=>{waits.push(work);},passThroughOnException(){}} as ExecutionContext);await Promise.all(waits);
      expect([200,206]).toContain(response.status);const raw=Buffer.from(await response.arrayBuffer());
      const payload=response.headers.get("Content-Type")?.includes("application/json")?JSON.parse(raw.toString()):undefined;
      const after=await snapshot();let delta:Row|undefined;
      if(write){expect(payload.status).toBe(200);delta=receipt(before,after,writes.length===0?"like":"follow",writes.length===0?f.mainId:22,payload.data);}
      else if(detail&&payload?.status===200)delta=receipt(before,after,"browse",Number(url.pathname.split('/').at(-1)),payload.data);
      else {expect(after).toEqual(before);if(payload)expect([200,410010]).toContain(payload.status);}
      const readFailure=!failedPage2&&url.pathname==="/api/community/list"&&url.searchParams.get("page")==="2"&&url.searchParams.get("is_follow")!=="1"&&!url.searchParams.get("topic_id");
      if(readFailure)failedPage2=true;
      expected=after;expect(storage()).toEqual(initialStorage);
      traces.push({path:url.pathname,query:url.search,method,viewer:actor,write,detail,status:payload?.status??response.status,browser_status:write||readFailure?503:response.status,
        injected_read_failure:readFailure,receipt:delta,snapshot:{before:digest(before),after:digest(after),unchanged:!delta,tables:14,sequences:14}});
      if(write||readFailure)return json(res,{status:503,msg:write?"本地验收：提交成功但回执丢失":"本地验收：第二页读取失败，请重试原页"},503);
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(raw);
    });}
    async function toggle(req:IncomingMessage,res:ServerResponse){return serial(async()=>{
      const plan=configPlans[configReceipts.length],input=JSON.parse((await bytes(req)).toString());expect(plan).toBeDefined();expect(evidence.at(-1)?.stage).toBe(plan[0]);expect(input).toEqual({value:plan[1]});
      const before=await snapshot();expect(before).toEqual(expected);const row=before.system_config.find(r=>r.menu_name==="community_status")!,want=structuredClone(before);
      want.system_config=want.system_config.map(r=>r.id===row.id?{...r,value:input.value}:r);await f.db.update(systemConfig).set({value:input.value}).where(eq(systemConfig.id,row.id));
      f.cache.set("cfg_community_status",input.value==="0"?"1":"0");const after=await snapshot();expect(after).toEqual(sorted(want));expected=after;
      configReceipts.push({before:row.value,after:input.value,stale_cache:f.cache.get("cfg_community_status"),sequence_delta:0});json(res,{configurations:configReceipts.length,value:input.value});
    });}
    async function checkpoint(req:IncomingMessage,res:ServerResponse,stage:string){return serial(async()=>{
      const index=evidence.length;expect(stage).toBe(stages[index]);const data=JSON.parse((await bytes(req)).toString()),current=await snapshot();expect(current).toEqual(expected);
      expect(data.width).toBe(375);expect(data.scrollWidth).toBeLessThanOrEqual(375);expect(data.text).not.toMatch(/Internal Server Error|Failed to resolve|Cannot read properties/u);
      const titles=(indexes:number[])=>indexes.map(i=>i===2?"分页视频02":`分页图文${String(i).padStart(2,"0")}`);
      const all=Array.from({length:21},(_,i)=>i+1),postCounts:Row={discoverPage1:10,page2Error:10,discoverPage2:20,discoverPage3:21,topicPage1:10,topicPage2:11,refreshed:10,
        unknownLike:10,followingEmpty:0,discoverUnknown:10,communityReopened:10,likeReconciled:10,followingUnknown:10,followReconciled:10,followingPage2:19,rawMain:10,account22:10,finished:10};
      if(postCounts[stage]!==undefined)expect(data.posts).toHaveLength(postCounts[stage]);
      if(["discoverPage1","page2Error","refreshed","unknownLike","discoverUnknown","communityReopened","likeReconciled","rawMain","account22","finished"].includes(stage))expect(data.posts).toEqual(titles(all.slice(0,10)));
      if(stage==="discoverPage2")expect(data.posts).toEqual(titles(all.slice(0,20)));
      if(stage==="discoverPage3")expect(data.posts).toEqual(titles(all));
      if(stage==="topicPage1"||stage==="topicPage2")expect(data.posts).toEqual(titles(all.filter(i=>i%2===1).slice(0,stage==="topicPage1"?10:11)));
      if(stage==="refreshed")expect(data.selectedTopic).toBe("全部");
      if(stage==="page2Error"){expect(data.text).toContain("第二页读取失败");expect(traces.filter(t=>t.injected_read_failure)).toHaveLength(1);}
      if(["followingUnknown","followReconciled","followingPage2"].includes(stage))expect(data.posts).toEqual(titles(all.slice(2,stage==="followingPage2"?21:12)));
      if(stage==="followingEmpty"){expect(data.recommendations).toEqual([{id:"22",previews:titles([3,4,5])}]);expect(data.tab).toBe("following");}
      if(stage==="recommendedPreview")expect(data.detail).toContain("分页图文03");
      if(["unknownLike","discoverUnknown","communityReopened"].includes(stage)){
        const action=data.actions.find((r:Row)=>r.id===String(f.mainId));expect(action?.unknown).toBe(true);expect(action?.disabled).toBe(true);
      }
      if(stage==="likeReconciled"){
        const action=data.actions.find((r:Row)=>r.id===String(f.mainId));expect(action?.unknown).toBe(false);expect(action?.disabled).toBe(false);expect(action?.like).toContain("取消点赞 8");
        const segment=traces.slice(evidence.at(-1)?.traces??0);expect(segment.some(t=>t.path===`/api/community/state/${f.mainId}`&&t.method==="GET"&&t.viewer===11)).toBe(true);
        expect(segment.some(t=>t.detail||t.write)).toBe(false);
      }
      if(["unknownFollow","discoverUnknown","communityReopened","likeReconciled","followingUnknown"].includes(stage))expect(data.followUnknown).toBe(true);
      if(stage==="followReconciled"){
        expect(data.followUnknown).toBe(false);const segment=traces.slice(evidence.at(-1)?.traces??0);
        expect(segment.some(t=>t.path==="/api/community/user_info/22"&&t.method==="GET"&&t.viewer===11)).toBe(true);expect(segment.some(t=>t.detail||t.write)).toBe(false);
      }
      if(stage==="communityClosed"||stage==="featuredClosed"){expect(data.banner).toContain("社区暂未开放");expect(data.posts).toEqual([]);expect(data.featuredId).toBe(0);expect(data.detail).toBe("");}
      const featured:Row={featuredFirst:1,featuredVideo:2,featuredPage2:10,featuredPage3:20,featuredLast:21,featuredRecovered:21,appCanonical:1,appReadonly:1};
      if(featured[stage]){expect(data.featuredId).toBe(f.orderedIds[featured[stage]-1]);expect(data.featuredTitle).toBe(titles([featured[stage]])[0]);}
      if(stage==="featuredVideo"){expect(data.video?.src).toContain("/api/assets/");expect(data.video?.readyState).toBeGreaterThanOrEqual(1);expect(data.video?.width).toBeGreaterThan(0);}
      if(stage==="featuredRecovered"||stage==="appReadonly"){const segment=traces.slice(evidence.at(-1)?.traces??0);expect(segment.some(t=>t.path===`/api/community/state/${data.featuredId}`)).toBe(true);expect(segment.some(t=>t.detail||t.write)).toBe(false);}
      if(stage==="rawMain")expect(data.href).toContain("#/pages/discover/index");
      if(stage==="guestFollowing"){expect(data.text).toContain("登录后");expect(data.posts).toEqual([]);expect(traces.slice(evidence.at(-1)?.traces??0).some(t=>/\/(?:follow|recommend_list)$/u.test(t.path))).toBe(false);}
      if(stage==="invalidFeatured"){expect(data.text).toMatch(/无效|冲突|不能/u);expect(traces.slice(evidence.at(-1)?.traces??0).every(t=>t.path==="/api/get_script")).toBe(true);}
      if(stage==="account22"){expect(data.actions.find((r:Row)=>r.id===String(f.mainId))?.like).toContain("点赞 8");expect(data.followUnknown).toBe(false);}
      expect(traces.filter(t=>t.write)).toHaveLength(index<7?0:index<10?1:2);expect(traces.filter(t=>t.receipt?.kind==="browse")).toHaveLength(visitsAt[index]);
      evidence.push({stage,...data,traces:traces.length,writes:traces.filter(t=>t.write).length,visits:visitsAt[index],database_sha:digest(current)});
      if(stage==="finished"){expect(configReceipts).toHaveLength(4);expect(external).not.toHaveBeenCalled();expect(storage()).toEqual(initialStorage);
        await writeFile(prefix+"evidence.json",JSON.stringify({evidence,traces,configReceipts,tables,sequences:14,initial_sha:digest(initial),final_sha:digest(current),
          initial_posts:initial.community,final_posts:current.community,initial_profiles:initial.community_user,final_profiles:current.community_user,
          storage:{initial:initialStorage,final:storage()},providerCalls:0,static_paths:[...staticPaths].sort(),ordered_ids:f.orderedIds,following_ids:f.followingIds,
          authority:"Actual DOM H5/createApp/JWT/owned PG16. Only route/session/viewport/configuration/checkpoint controls synthetic; first page2 read fails503 after a real read, like and follow each commit before one lost503 receipt.",
          limitations:"No real login, production role/schema/index/remote KV/R2/provider or MP/App device claim; App entry exercised as a local H5 canonical route."},null,2)+"\n");done();}
      json(res,{checked:evidence.map(r=>r.stage),finished:stage==="finished"});
    });}
    const shell=()=>`<!doctype html><html lang="zh"><meta charset="utf-8"><title>主社区信息流后台验收</title><style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:375px;height:830px;border:1px solid #ddd}pre{max-height:50px;overflow:auto}</style>
<h1>实际 H5 主社区、关注与混合精选</h1>${Object.entries(routes).map(([key,r])=>`<button data-route="${key}">${r.label}</button>`).join("")}<button data-size>375像素内容区</button>
<button data-value="0">社区关闭（仅fixture配置）</button><button data-value="1">社区开启（仅fixture配置）</button>${stages.map(stage=>`<button data-stage="${stage}">${stage}</button>`).join("")}<pre id="result"></pre><iframe title="实际主社区"></iframe><script>
const frame=document.querySelector('iframe'),routes=${JSON.stringify(routes)},actor=${JSON.stringify(f.token)},other=${JSON.stringify(f.otherToken)};
for(const b of document.querySelectorAll('[data-route]'))b.onclick=()=>{const r=routes[b.dataset.route];localStorage.setItem('uni_token',JSON.stringify({type:'string',data:r.uid===11?actor:r.uid===22?other:''}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:r.uid}));frame.src='/?main_feed_session='+r.uid+'-'+Date.now()+'#'+r.route;};
document.querySelector('[data-size]').onclick=()=>{const d=frame.contentDocument;frame.style.width=(375+frame.contentWindow.innerWidth-d.documentElement.clientWidth)+'px';};
for(const b of document.querySelectorAll('[data-value]'))b.onclick=async()=>{const response=await fetch('${control}/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({value:b.dataset.value})});document.getElementById('result').textContent=JSON.stringify(await response.json());};
const visible=e=>{if(!e)return false;for(let p=e;p;p=p.parentElement)if(getComputedStyle(p).display==='none'||getComputedStyle(p).visibility==='hidden')return false;return true;};
const txt=e=>visible(e)?e.textContent.trim().replace(/\\s+/g,' '):'',disabled=e=>!e||e.disabled===true||e.hasAttribute('disabled')||e.classList.contains('uni-button-disabled');
for(const b of document.querySelectorAll('[data-stage]'))b.onclick=async()=>{const d=frame.contentDocument,all=s=>[...d.querySelectorAll(s)].filter(visible),one=s=>all(s)[0],viewer=one('.community-featured-viewer'),video=one('.community-featured-viewer video'),data={href:frame.contentWindow.location.href,width:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,text:txt(d.body),banner:all('.community-availability').map(txt).join(' '),tab:one('[data-feed-tab].selected')?.dataset.feedTab||'',posts:all('.feed .post-title').map(txt),selectedTopic:txt(one('.topic-chip.selected')),detail:all('.detail-sheet').map(txt).join(' '),followUnknown:all('.feed-follow-unknown').length>0,featuredId:Number(viewer?.dataset.activePostId||0),featuredTitle:txt(one('.featured-current-title')),video:video?{src:video.currentSrc||video.src,readyState:video.readyState,width:video.videoWidth,time:video.currentTime,paused:video.paused}:null,recommendations:all('.feed-recommend-author').map(e=>({id:e.dataset.authorId,previews:[...e.querySelectorAll('.feed-recommend-preview')].filter(visible).map(txt)})),actions:all('.community-post-actions').map(e=>({id:e.dataset.postId,like:txt(e.querySelector('.post-like')),disabled:disabled(e.querySelector('.post-like')),unknown:txt(e).includes('互动结果未确认')}))};const response=await fetch('${control}/'+b.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.getElementById('result').textContent=JSON.stringify(await response.json());};</script></html>`;
    const server=createServer((req,res)=>{void(async()=>{
      if(req.socket.remoteAddress!=="127.0.0.1"||req.headers.host!==new URL(origin).host)return send(res,"Owned loopback only",403);
      const url=new URL(req.url??"/",origin),path=url.pathname;
      if(path===control&&req.method==="GET")return send(res,shell());if(path===control+"/toggle"&&req.method==="POST")return toggle(req,res);
      if(path.startsWith(control+"/")&&req.method==="POST")return checkpoint(req,res,path.slice(control.length+1));
      const chrome:Row={"/api/site_config":{site_name:"主社区验收",site_logo:"",record_No:"",ico_path:""},"/api/share":{title:"本地主社区",synopsis:"",img:""},
        "/api/diy/get_suspended":{is_show:0,button:[]},"/api/v2/diy/color_change/color_change":{},"/api/v2/diy/product_detail":{}};
      if(req.method==="GET"&&Object.hasOwn(chrome,path))return json(res,{status:200,data:chrome[path],msg:"Synthetic navigation chrome only"});
      if(path.startsWith("/api/"))return api(req,res,url);if(path==="/favicon.ico")return send(res,"",204);
      const target=resolve(root,"."+decodeURIComponent(path));if(target!==root&&!target.startsWith(root+sep))return send(res,"Owned build only",403);
      try{if(target!==root&&(await stat(target)).isFile()){staticPaths.add(path);return send(res,await readFile(target),200,({".js":"text/javascript",".css":"text/css",".html":"text/html",".png":"image/png",".svg":"image/svg+xml"}as Row)[extname(target)]??"application/octet-stream");}}catch{/*Actual SPA entry.*/}
      send(res,await readFile(resolve(root,"index.html")));
    })().catch(reason=>{fail(reason instanceof Error?reason:Error(String(reason)));if(!res.headersSent)send(res,String(reason),500);else res.destroy();});});
    let deadline:ReturnType<typeof setTimeout>|undefined;
    try{await new Promise<void>((yes,no)=>{server.once("error",no);server.listen(40766,"127.0.0.1",yes);});
      const ready={url:origin+control,stages,routes,main_id:f.mainId,video_id:f.videoId,preview_id:f.previewId,ordered_ids:f.orderedIds,following_ids:f.followingIds,width:375,business_writes:2,deliberate_visits:23,config_changes:4};
      await writeFile(prefix+"ready.json",JSON.stringify(ready,null,2)+"\n");process.stdout.write("COMMUNITY_MAIN_FEED_BROWSER_READY "+JSON.stringify(ready)+"\n");
      deadline=setTimeout(()=>fail(Error("Browser completion absent within owned eight-minute window")),8*60_000);await completion;
    }finally{if(deadline)clearTimeout(deadline);server.closeAllConnections();if(server.listening)await new Promise<void>(yes=>server.close(()=>yes()));}
  }finally{external.mockRestore();wiring.container=undefined;await f.close();}
},9*60_000);
