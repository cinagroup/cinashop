import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { diyCommerceAuthorFixture } from './helpers/diyCommerceAuthorFixture';
import { canonicalizePublishedAttachmentReference as canonical } from '@/services/content/ArticleContentPolicy';
import { sortedDiyState,type DiyStateRow as Row } from './helpers/diyStateFixture';
import defaults from './fixtures/diy-commerce-author-defaults.json';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{if(!wiring.container)throw Error('missing owned commerce DB');return wiring.container;},createAdminDatabaseSession:()=>{if(!wiring.container)throw Error('missing owned commerce Admin DB');return{container:wiring.container,close:async()=>{}};}}));
const sha=(raw:unknown)=>createHash('sha256').update(JSON.stringify(raw)).digest('hex');
function canonicalBlocks(raw:Row[],published=false){const value=structuredClone(raw);for(const block of value){if(['seckill','combination','bargain','presale','pointsMall'].includes(block.name))for(const key of block.name==='pointsMall'?['imgConfig','imgConfig2','imgBgConfig']:['imgConfig','imgColorConfig','imgBgConfig'])if(typeof block[key]?.url==='string')block[key].url=canonical(block[key].url);if(block.name==='promotionList'){for(const tab of block.tabConfig.list)if(typeof tab?.image==='string')tab.image=canonical(tab.image);if(published)for(const key of ['titleShow','opriceShow','priceShow','couponShow'])if(block[key])delete block[key].title;}}return value;}
describe.runIf(!!process.env.TEST_FINANCE_POSTGRES_URL)('eight commerce authors on real owned PostgreSQL16',()=>{
 for(const namespace of ['isolated','public'] as const)describe(namespace,()=>{
  let f:Awaited<ReturnType<typeof diyCommerceAuthorFixture>>,directory='';const app=createApp(),evidence:Row[]=[];
  beforeAll(async()=>{f=await diyCommerceAuthorFixture(new Date(),namespace==='public'?{namespace:'public'}:{});wiring.container=f.container;directory=await mkdtemp(join(tmpdir(),'cinashop-commerce-author-native-'));},90000);
  afterAll(async()=>{try{if(f&&directory)await writeFile(join(directory,'execution.json'),JSON.stringify({namespace,tables:f.tables,sequences:f.sequences,evidence,final:await f.snapshot()},null,2)+'\n');process.stdout.write('COMMERCE_AUTHOR_NATIVE '+JSON.stringify({directory,namespace,checks:evidence.length})+'\n');}finally{wiring.container=undefined;await f?.close();}},30000);
  async function request(path:string,method='GET',body?:unknown,actor:'admin'|'minimal'|'reader'|'guest'='guest'){
   const token=actor==='admin'?f.adminToken:actor==='minimal'?f.minimalToken:actor==='reader'?f.readerToken:'',waits:Promise<unknown>[]=[],before=await f.snapshot(),resources=f.resources();
   const response=await app.fetch(new Request('https://owned-commerce.local'+path,{method,headers:{...(token?{'Authori-zation':'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),f.env,{waitUntil:(p:Promise<unknown>)=>waits.push(p),passThroughOnException(){}} as unknown as ExecutionContext);
   await Promise.all(waits);const bytes=new Uint8Array(await response.arrayBuffer()),payload=response.headers.get('Content-Type')?.includes('application/json')?JSON.parse(new TextDecoder().decode(bytes)) as Row:null,after=await f.snapshot();
   expect(f.resources()).toEqual(resources);if(method==='GET'||payload?.status!==200)expect(after).toEqual(before);evidence.push({path,method,actor,status:payload?.status??response.status,before:sha(before),after:sha(after),resources_unchanged:true,body_sha256:sha([...bytes])});return{response,bytes,payload,before,after};
  }
  it('retains all319 default keys and complete15 tabs through real save, public policy and raster reads',async()=>{
   expect(Object.values(defaults).reduce((sum,b)=>sum+Object.keys(b).length,0)).toBe(319);
   const value=structuredClone(f.blocks),promotion=value.find(row=>row.name==='promotionList')!,seckill=value.find(row=>row.name==='seckill')!;
   promotion.titleShow={title:'removed only from output',keep:true};promotion.tabConfig.list[14].image=f.platformImage.url+'?expires=1&amp;signature=old';seckill.numberConfig.val=7;
   const saved=await request('/adminapi/dise/save','POST',{id:2,value:JSON.stringify(value)},'minimal');expect(saved.payload?.status).toBe(200);
   const expected=structuredClone(saved.before),row=expected.system_dise.find(r=>r.id===2)!,actual=saved.after.system_dise.find(r=>r.id===2)!;Object.assign(row,{value:JSON.stringify(canonicalBlocks(value)),version:actual.version,update_time:actual.update_time});expect(saved.after).toEqual(sortedDiyState(expected));expect(actual.content).toBe('independent-commerce-content-2');
   const published=await request('/api/diy/get_diy/2');expect(published.payload?.status).toBe(200);expect(canonicalBlocks(published.payload!.data.value,true)).toEqual(canonicalBlocks(value,true));
   const output=published.payload!.data.value.find((row:Row)=>row.name==='promotionList');expect(output.tabConfig.list).toHaveLength(15);expect(output.tabConfig.list[0].goodsList.list[0].image).toBe('/api/assets/999?never-authorized');
   const image=await request(output.tabConfig.list[14].image);expect(image.response.status).toBe(200);expect([...image.bytes]).toEqual([...f.png]);
  });
  it('uses all existing real commerce public list APIs without a business or resource write',async()=>{
   for(const path of ['/api/products?page=1&limit=2&ids=601,611','/api/seckill/index','/api/seckill/list/501?page=1&limit=3&type=index','/api/combination/list?page=1&limit=3','/api/pink','/api/bargain/list?page=1&limit=3','/api/presale/list?page=1&limit=3&time_type=0','/api/store_integral/list?page=1&limit=3','/api/v2/coupons?page=1&limit=5','/api/wechat/live?page=1&limit=3'])expect((await request(path)).payload?.status).toBe(200);
  });
  it('requires dise.manage and never mutates storage for rejected author writes or public reads',async()=>{
   const result=await request('/adminapi/dise/save','POST',{id:2,value:JSON.stringify(f.blocks)},'reader');expect(result.payload?.status).toBe(400011);
   for(const path of ['/api/diy/get_diy/0','/api/diy/get_diy/2','/api/diy/diy_version/2'])expect((await request(path)).payload?.status).toBe(200);
  });
 });
});
