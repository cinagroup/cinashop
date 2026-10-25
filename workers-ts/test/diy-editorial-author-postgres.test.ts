import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { diyEditorialAuthorFixture } from './helpers/diyEditorialAuthorFixture';
import { canonicalizePublishedAttachmentReference as canonical } from '@/services/content/ArticleContentPolicy';
import { sortedDiyState,type DiyStateRow as Row } from './helpers/diyStateFixture';
import defaults from './fixtures/diy-editorial-author-defaults.json';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{if(!wiring.container)throw Error('missing owned editorial DB');return wiring.container;},createAdminDatabaseSession:()=>{if(!wiring.container)throw Error('missing owned editorial Admin DB');return{container:wiring.container,close:async()=>{}};}}));
const sha=(raw:unknown)=>createHash('sha256').update(JSON.stringify(raw)).digest('hex');
function canonicalBlocks(raw:Row[],published=false){const value=structuredClone(raw);for(const block of value){if(block.name==='news')block.imgConfig.url=canonical(block.imgConfig.url);if(block.name==='hotspot')block.picStyle.url=canonical(block.picStyle.url);if(block.name==='activeParty'){for(const item of block.menuConfig.list.slice(0,4))item.img=canonical(item.img);if(published)for(const key of['titleConfig','desConfig']){delete block[key].place;delete block[key].max;}}}return value;}
describe.runIf(!!process.env.TEST_FINANCE_POSTGRES_URL)('three editorial authors on real owned PostgreSQL16',()=>{
 for(const namespace of ['isolated','public'] as const)describe(namespace,()=>{
  let f:Awaited<ReturnType<typeof diyEditorialAuthorFixture>>,directory='';const app=createApp(),evidence:Row[]=[];
  beforeAll(async()=>{f=await diyEditorialAuthorFixture(new Date(),namespace==='public'?{namespace:'public'}:{});wiring.container=f.container;directory=await mkdtemp(join(tmpdir(),'cinashop-editorial-author-native-'));},90000);
  afterAll(async()=>{try{if(f&&directory)await writeFile(join(directory,'execution.json'),JSON.stringify({namespace,tables:f.tables,sequences:f.sequences,evidence,final:await f.snapshot()},null,2)+'\n');process.stdout.write('EDITORIAL_AUTHOR_NATIVE '+JSON.stringify({directory,namespace,checks:evidence.length})+'\n');}finally{wiring.container=undefined;await f?.close();}},30000);
  async function request(path:string,method='GET',body?:unknown,actor:'admin'|'minimal'|'reader'|'guest'='guest'){
   const token=actor==='admin'?f.adminToken:actor==='minimal'?f.minimalToken:actor==='reader'?f.readerToken:'',waits:Promise<unknown>[]=[],before=await f.snapshot(),resources=f.resources();
   const response=await app.fetch(new Request('https://owned-editorial.local'+path,{method,headers:{...(token?{'Authori-zation':'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),f.env,{waitUntil:(p:Promise<unknown>)=>waits.push(p),passThroughOnException(){}} as unknown as ExecutionContext);
   await Promise.all(waits);const bytes=new Uint8Array(await response.arrayBuffer()),payload=response.headers.get('Content-Type')?.includes('application/json')?JSON.parse(new TextDecoder().decode(bytes)) as Row:null,after=await f.snapshot();
   expect(f.resources()).toEqual(resources);if(method==='GET'||payload?.status!==200)expect(after).toEqual(before);evidence.push({path,method,actor,status:payload?.status??response.status,before:sha(before),after:sha(after),resources_unchanged:true,body_sha256:sha([...bytes])});return{response,bytes,payload,before,after};
  }
  it('retains all56 literal defaults and opaque imports through real Admin POST and public metadata/media projection',async()=>{
   expect(Object.values(defaults).map(block=>Object.keys(block).length)).toEqual([32,14,10]);
   const value=structuredClone(f.blocks);const news=value[0]!,hotspot=value[1]!,party=value[2]!;
   news.imgConfig.url=f.platformImage.url+'?expires=1&amp;signature=legacy';news.listConfig.list=Array.from({length:12},(_,i)=>({...structuredClone(news.listConfig.list[0]),show:i>0,unknown:i}));
   hotspot.picStyle.url=f.platformImage.url+'?expires=1&signature=legacy';hotspot.picStyle.list=Array.from({length:31},(_,i)=>({...structuredClone(hotspot.picStyle.list[0]),number:i+1,unknown:i}));
   party.menuConfig.list.push({...structuredClone(party.menuConfig.list[0]),img:' /api/assets/9?expires=1&signature=fifth-opaque ',unknown:'fifth'});
   value.push({...structuredClone(news),timestamp:40,isHide:true,topConfig:{val:'1e30',unknown:0}});
   const saved=await request('/adminapi/dise/save','POST',{id:2,value:JSON.stringify(value)},'minimal');expect(saved.payload?.status).toBe(200);
   const expected=structuredClone(saved.before),row=expected.system_dise.find(r=>r.id===2)!,actual=saved.after.system_dise.find(r=>r.id===2)!;Object.assign(row,{value:JSON.stringify(canonicalBlocks(value)),version:actual.version,update_time:actual.update_time});expect(saved.after).toEqual(sortedDiyState(expected));expect(actual.content).toBe('independent-editorial-content-2');
   const publicPage=await request('/api/diy/get_diy/2');expect(publicPage.payload?.status).toBe(200);expect(canonicalBlocks(publicPage.payload!.data.value,true)).toEqual(canonicalBlocks(value,true));
   const publicValue=publicPage.payload!.data.value;expect(publicValue[0].listConfig.list).toHaveLength(12);expect(publicValue[1].picStyle.list).toHaveLength(31);expect(publicValue[2].menuConfig.list[4].img).toBe(party.menuConfig.list[4].img);expect(publicValue[2].menuConfig.list[0].info[0].tips).toBe(party.menuConfig.list[0].info[0].tips);
   const asset=await request(publicValue[1].picStyle.url);expect(asset.response.status).toBe(200);expect([...asset.bytes]).toEqual([...f.png]);
  });
  it('requires dise.manage and never mutates storage for rejected author writes or public reads',async()=>{
   const result=await request('/adminapi/dise/save','POST',{id:2,value:JSON.stringify(f.blocks)},'reader');expect(result.payload?.status).toBe(400011);
   for(const path of ['/api/diy/get_diy/0','/api/diy/get_diy/2','/api/diy/diy_version/2'])expect((await request(path)).payload?.status).toBe(200);
  });
 });
});
