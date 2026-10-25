import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { diyCommunityAuthorFixture } from './helpers/diyCommunityAuthorFixture';
import { canonicalizePublishedAttachmentReference as canonical } from '@/services/content/ArticleContentPolicy';
import { sortedDiyState,type DiyStateRow as Row } from './helpers/diyStateFixture';
import defaults from './fixtures/diy-community-author-defaults.json';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{if(!wiring.container)throw Error('missing owned community DB');return wiring.container;},createAdminDatabaseSession:()=>{if(!wiring.container)throw Error('missing owned community Admin DB');return{container:wiring.container,close:async()=>{}};}}));
const sha=(raw:unknown)=>createHash('sha256').update(JSON.stringify(raw)).digest('hex');
function canonicalBlocks(raw:Row[]){const value=structuredClone(raw);for(const block of value)if(block.name==='community'&&typeof block.imgConfig?.url==='string')block.imgConfig.url=canonical(block.imgConfig.url);return value;}
describe.runIf(!!process.env.TEST_FINANCE_POSTGRES_URL)('community author on real owned PostgreSQL16',()=>{
 for(const namespace of ['isolated','public'] as const)describe(namespace,()=>{
  let f:Awaited<ReturnType<typeof diyCommunityAuthorFixture>>,directory='';const app=createApp(),evidence:Row[]=[];
  beforeAll(async()=>{f=await diyCommunityAuthorFixture(new Date(),namespace==='public'?{namespace:'public'}:{});wiring.container=f.container;directory=await mkdtemp(join(tmpdir(),'cinashop-community-author-native-'));},90000);
  afterAll(async()=>{try{if(f&&directory)await writeFile(join(directory,'execution.json'),JSON.stringify({namespace,tables:f.tables,sequences:f.sequences,evidence,final:await f.snapshot()},null,2)+'\n');process.stdout.write('COMMUNITY_AUTHOR_NATIVE '+JSON.stringify({directory,namespace,checks:evidence.length})+'\n');}finally{wiring.container=undefined;await f?.close();}},30000);
  async function request(path:string,method='GET',body?:unknown,actor:'admin'|'minimal'|'reader'|'guest'='guest'){
   const token=actor==='admin'?f.adminToken:actor==='minimal'?f.minimalToken:actor==='reader'?f.readerToken:'',waits:Promise<unknown>[]=[],before=await f.snapshot(),resources=f.resources();
   const response=await app.fetch(new Request('https://owned-community.local'+path,{method,headers:{...(token?{'Authori-zation':'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),f.env,{waitUntil:(p:Promise<unknown>)=>waits.push(p),passThroughOnException(){}} as unknown as ExecutionContext);
   await Promise.all(waits);const bytes=new Uint8Array(await response.arrayBuffer()),payload=response.headers.get('Content-Type')?.includes('application/json')?JSON.parse(new TextDecoder().decode(bytes)) as Row:null,after=await f.snapshot();
   expect(f.resources()).toEqual(resources);if(method==='GET'||payload?.status!==200)expect(after).toEqual(before);evidence.push({path,method,actor,status:payload?.status??response.status,before:sha(before),after:sha(after),resources_unchanged:true,body_sha256:sha([...bytes])});return{response,bytes,payload,before,after};
  }
  it('retains all36 default keys and independent content through save, public output and exact raster reads',async()=>{
   expect(Object.keys(defaults.community)).toHaveLength(36);
   const value=structuredClone(f.blocks),block=value.find(row=>row.name==='community')!;
   block.imgConfig.url=f.platformImage.url+'?expires=1&amp;signature=old';block.numberConfig.val=7;block.selectConfig.activeValue='999';
   const saved=await request('/adminapi/dise/save','POST',{id:2,value:JSON.stringify(value)},'minimal');expect(saved.payload?.status).toBe(200);
   const expected=structuredClone(saved.before),row=expected.system_dise.find(r=>r.id===2)!,actual=saved.after.system_dise.find(r=>r.id===2)!;Object.assign(row,{value:JSON.stringify(canonicalBlocks(value)),version:actual.version,update_time:actual.update_time});expect(saved.after).toEqual(sortedDiyState(expected));expect(actual.content).toBe('independent-community-content-2');
   const published=await request('/api/diy/get_diy/2');expect(published.payload?.status).toBe(200);expect(canonicalBlocks(published.payload!.data.value)).toEqual(canonicalBlocks(value));
   const output=published.payload!.data.value.find((row:Row)=>row.name==='community');expect(output.selectConfig.activeValue).toBe('999');
   const image=await request(output.imgConfig.url);expect(image.response.status).toBe(200);expect([...image.bytes]).toEqual([...f.png]);
  });
  it('uses only real public config/list and Admin active-topic reads without counter or resource writes',async()=>{
   expect((await request('/api/community/config')).payload?.data.community_status).toBe(1);
   const posts=await request('/api/community/list?page=1&limit=3&is_follow=0');expect(posts.payload?.status).toBe(200);expect(posts.payload?.data.map((row:Row)=>row.id).sort()).toEqual([1,2,3]);expect(posts.payload?.data.every((row:Row)=>row.status===1&&row.is_verify===1)).toBe(true);
   const topics=await request('/adminapi/community/all_topic','GET',undefined,'admin');expect(topics.payload?.status).toBe(200);expect(topics.payload?.data.map((row:Row)=>row.id)).toContain(19);expect(topics.payload?.data.map((row:Row)=>row.id)).not.toContain(29);expect((await request('/adminapi/community/all_topic','GET',undefined,'minimal')).payload?.status).toBe(400011);
  });
  it('requires dise.manage and preserves storage on rejected writes and anonymous schema reads',async()=>{
   const result=await request('/adminapi/dise/save','POST',{id:2,value:JSON.stringify(f.blocks)},'reader');expect(result.payload?.status).toBe(400011);
   for(const path of ['/api/diy/get_diy/0','/api/diy/get_diy/2','/api/diy/diy_version/2'])expect((await request(path)).payload?.status).toBe(200);
  });
 });
});
