import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createApp } from "@/app";
import type { Container } from "@/lib/di";
import { systemConfig } from "@/models/schema";
import { diyCommunityFixture } from "./helpers/diyCommunityFixture";
const wiring = vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock("@/lib/di",async original=>({...await original<typeof import("@/lib/di")>(),createContainer:()=>{
  if(!wiring.container)throw Error("Missing owned DIY community SQL");return wiring.container;
}}));
type Row=Record<string,any>;type Snapshot=Record<string,Row[]>;
const stable=(value:unknown):string=>JSON.stringify(value,(_key,p)=>p&&typeof p==='object'&&!Array.isArray(p)?Object.fromEntries(Object.entries(p).sort(([a],[b])=>a.localeCompare(b))):p);
const sorted=(state:Snapshot):Snapshot=>Object.fromEntries(Object.entries(state).map(([key,rows])=>[key,rows.slice().sort((a,b)=>stable(a).localeCompare(stable(b)))]));
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("native DIY community data-domain separation",()=>{
  let f:Awaited<ReturnType<typeof diyCommunityFixture>>,tables:string[];const app=createApp();
  beforeAll(async()=>{f=await diyCommunityFixture();wiring.container=f.container;
    tables=(await f.db.execute<{name:string}>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(r=>r.name);expect(tables).toHaveLength(16);
  },30_000);
  afterAll(async()=>{wiring.container=undefined;await f?.close();});
  beforeEach(()=>{vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Owned DIY fixtures forbid provider I/O'));});
  afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.restoreAllMocks();});
  async function snapshot():Promise<Snapshot>{const state:Snapshot={};for(const name of tables)state[name]=(await f.db.execute<{row:Row}>(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(name)} t`)).map(r=>r.row);
    state.__sequences=await f.db.execute(sql`SELECT sequencename AS name,last_value::text AS last FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`);expect(state.__sequences).toHaveLength(16);return sorted(state);}
  async function request(path:string,viewer:0|11|22=11){const waits:Promise<unknown>[]=[];const response=await app.fetch(new Request('http://localhost'+path,{headers:viewer?{Authorization:`Bearer ${viewer===11?f.token:f.otherToken}`}:{}}),f.env,{waitUntil:work=>{waits.push(work);},passThroughOnException(){}}as ExecutionContext);await Promise.all(waits);return response;}
  async function read(path:string,viewer:0|11|22=11,status=200){const before=await snapshot(),storage={puts:f.bucket.put.mock.calls.length,deletes:f.bucket.delete.mock.calls.length,objects:[...f.objects.keys()]};const res=await request(path,viewer);expect(res.status).toBe(200);const body=await res.json()as Row;expect(body.status).toBe(status);expect(await snapshot()).toEqual(before);expect({puts:f.bucket.put.mock.calls.length,deletes:f.bucket.delete.mock.calls.length,objects:[...f.objects.keys()]}).toEqual(storage);return body.data;}
  it('reads actual home and micro schemas as two independent authored community blocks without changing counters',async()=>{
    for(const id of[0,2]){expect(await read(`/api/diy/diy_version/${id}`,0)).toEqual({version:'diy-community-1'});const page=await read(`/api/diy/get_diy/${id}`,0);
      expect(page.value).toEqual(f.blocks);expect(page.is_show).toBe(1);expect(page.value.filter((r:Row)=>r.name==='community').map((r:Row)=>r.numberConfig.val)).toEqual([3,7]);}
  });
  it('reads the original three community config fields without author materialization or short-video analytics',async()=>{
    expect(await read('/api/community/config',0)).toEqual({community_status:1,community_comment_status:1,community_comment_add:1});
  });
  it('fetches the first3 and first7 mixed community posts despite colliding short-video IDs and an inert editor topic',async()=>{
    for(const count of[3,7]){const rows=await read(`/api/community/list?page=1&limit=${count}&is_follow=0`,11);expect(rows.map((r:Row)=>r.id)).toEqual(f.publicIds.slice(0,count));
      expect(rows.map((r:Row)=>r.title)).toEqual(f.publicIds.slice(0,count).map(id=>id===2?'社区视频02':`社区图文${String(id).padStart(2,'0')}`));
      expect(rows[0].author).toBe('视频作者11');expect(rows[0].image).toMatch(/^\/api\/assets\/\d+\?expires=\d+&signature=/u);expect(rows[1].content_type).toBe(2);expect(rows[1].video_url).toMatch(/^\/api\/assets\/\d+\?expires=/u);}
  });
  it('keeps default public scope for guest and both accounts without exposing pending, deleted or unavailable posts',async()=>{
    for(const viewer of[0,11,22]as const){const rows=await read('/api/community/list?page=1&limit=100&is_follow=0',viewer);expect(rows.map((r:Row)=>r.id)).toEqual(f.publicIds);expect(rows.every((r:Row)=>typeof r.content==='string')).toBe(true);expect(rows.find((r:Row)=>r.id===8)).toMatchObject({type:1,relation_id:11,author:'商户同号资料'});}
  });
  it('signs only the owned community cover, leaves dirty cross-author and non-user private references unusable and serves actual image bytes',async()=>{
    const rows=await read('/api/community/list?page=1&limit=100&is_follow=0');expect(rows.find((r:Row)=>r.id===8).image).toBe(f.image.url);expect(rows.find((r:Row)=>r.id===8).image).not.toContain('signature=');expect(rows.find((r:Row)=>r.id===9).image).toBe('');const deniedBefore=await snapshot(),denied=await request(f.image.url,0);expect(denied.status).toBe(404);expect(await denied.text()).toBe('');expect(await snapshot()).toEqual(deniedBefore);
    const before=await snapshot(),res=await request(rows[0].image,0);expect(res.status).toBe(200);expect(res.headers.get('Content-Type')).toBe('image/png');expect(new Uint8Array(await res.arrayBuffer())).toEqual(f.png);expect(await snapshot()).toEqual(before);
  });
  it('uses the fresh raw community master over an opposite stale cache and preserves all records on closed reads',async()=>{
    try{await f.db.update(systemConfig).set({value:'0'}).where(eq(systemConfig.menuName,'community_status'));f.cache.set('cfg_community_status','1');expect((await read('/api/community/config',0)).community_status).toBe(0);await read('/api/community/list?page=1&limit=3',0,410010);}
    finally{await f.db.update(systemConfig).set({value:'1'}).where(eq(systemConfig.menuName,'community_status'));f.cache.clear();}
  });
  it('retains station-first list admission while public config stays a read-only original-shape endpoint',async()=>{
    try{await f.db.update(systemConfig).set({value:'0'}).where(eq(systemConfig.menuName,'station_open'));f.cache.set('cfg_station_open','1');await read('/api/community/list?page=1&limit=7',0,410010);expect((await read('/api/community/config',0)).community_status).toBe(1);}
    finally{await f.db.update(systemConfig).set({value:'1'}).where(eq(systemConfig.menuName,'station_open'));f.cache.clear();}
  });
  it('preserves the independently invoked real DIY short-video endpoint and its exact bounded play receipt',async()=>{
    const before=await snapshot(),res=await request('/api/diy/video_list?page=1&limit=2',11);expect(res.status).toBe(200);const payload=await res.json()as Row;expect(payload.status).toBe(200);expect(payload.data.map((r:Row)=>({id:r.id,desc:r.desc}))).toEqual([{id:1,desc:'错误短视频域1'},{id:2,desc:'错误短视频域2'}]);
    const after=await snapshot(),want=structuredClone(before);want.video=want.video.map(r=>r.id===1||r.id===2?{...r,play_num:r.play_num+1}:r);const inserted=after.user_relation.filter(r=>!before.user_relation.some(old=>old.id===r.id));expect(inserted).toHaveLength(2);
    for(const [index,row]of inserted.entries()){expect(row).toEqual({id:row.id,uid:11,relation_id:index+1,type:'play',category:'video',add_time:row.add_time});expect(Number.isSafeInteger(row.add_time)).toBe(true);}
    const seq=want.__sequences.find(r=>r.name==='user_relation_id_seq')!;const start=seq.last===null?0:Number(seq.last);expect(inserted.map(r=>r.id)).toEqual([start+1,start+2]);seq.last=String(start+2);want.user_relation.push(...inserted);expect(after).toEqual(sorted(want));
  });
});
