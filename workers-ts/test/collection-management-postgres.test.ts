/** Real registered API/JWT, independently authenticated formal App LOGIN and
 * all 283 tables/229 sequences. No production/provider/Browser claim. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {createApp} from '@/app';
import {createContainerFromDb,type Container} from '@/lib/di';
import type {Env} from '@/env';
import {storeProduct,systemAttachment,user,userRelation,video} from '@/models/schema';
import {runRuntimeBusinessCommissioning} from '@/migrations/runRuntimeBusinessCommissioning';
import {auditRuntimeBusinessPrivileges} from '@/migrations/auditRuntimeBusinessPrivileges';
import {createToken,md5} from '@/utils/jwt';
import {refundRuntimeFixture} from './helpers/refundRuntimeFixture';
import {sortedDiyState,stableDiyState,type DiyStateSnapshot,type DiyStateRow as Row} from './helpers/diyStateFixture';

const wiring=vi.hoisted(()=>({context:undefined as AsyncLocalStorage<Container>|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{
 const value=wiring.context?.getStore();if(!value)throw Error('Owned collection App LOGIN required');return value;
}}));
const base=295000,foreign=base+110,missing=base+111,asset=base+200,password=md5('synthetic-collection-management');
const digest=(value:unknown)=>createHash('sha256').update(stableDiyState(value)).digest('hex');
type Fixture=Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer=Parameters<NonNullable<Fixture['withRuntimeRole']>>[0] extends (peer:infer T)=>unknown?T:never;
type RequestOptions={method?:'GET'|'POST';body?:unknown;raw?:string;uid?:number|null;token?:string;contentType?:string};

/** Raw-row oracle is independent of production delete/counter helpers. */
function expectedDeletion(before:DiyStateSnapshot,uid:number,ids:readonly number[],category:'product'|'video'){
 const expected=structuredClone(before),wanted=new Set(ids);
 expected.user_relation=expected.user_relation.filter(row=>!(row.uid===uid&&row.type==='collect'&&row.category===category&&wanted.has(row.relation_id)));
 const table=category==='product'?'store_product':'video',counter=category==='product'?'collect':'collect_num';
 for(const row of expected[table])if(wanted.has(row.id))row[counter]=expected.user_relation.filter(r=>r.type==='collect'&&r.category===category&&r.relation_id===row.id).length;
 return sortedDiyState(expected);
}
async function prepare(f:Fixture,application:Peer,admin:Peer,journal:Row){
 const tables=(await f.exec("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map(r=>String(r.name));
 const sequences=(await f.exec("SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).map(r=>String(r.name));
 expect(tables).toHaveLength(283);expect(sequences).toHaveLength(229);
 for(const name of[...tables,...sequences])expect(name).toMatch(/^[a-z_][a-z0-9_]*$/u);
 async function snapshot():Promise<DiyStateSnapshot>{
  const state:DiyStateSnapshot={};for(const row of await f.db.execute<{name:string;rows:Row[]}>(sql.join(tables.map(name=>sql`SELECT ${name}::text AS name,COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`),sql` UNION ALL `)))state[row.name]=row.rows;
  state.__sequences=await f.db.execute(sql.join(sequences.map(name=>sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`),sql` UNION ALL `));return sortedDiyState(state);
 }
 const [database]=await f.exec('SELECT current_database() AS name'),names={app:application.role,admin:admin.role,maintenance:'finance_test',database:String(database.name),pricingOwner:f.pricingOwner};
 const beforeCommission=await snapshot();await runRuntimeBusinessCommissioning(f.db,names);
 const appAudit=await auditRuntimeBusinessPrivileges(application.db,'app',names),adminAudit=await auditRuntimeBusinessPrivileges(admin.db,'admin',names);
 expect(appAudit).toMatchObject({ready:true,failures:[]});expect(adminAudit).toMatchObject({ready:true,failures:[]});expect(await snapshot()).toEqual(beforeCommission);
 const identities=[];
 for(const peer of[application,admin]){const[identity]=await peer.db.execute(sql`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version,rolcanlogin,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
  expect(identity).toMatchObject({role:peer.role,session:peer.role,pid:peer.pid,rolcanlogin:true,rolsuper:false,rolinherit:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false});expect(Math.floor(Number(identity.version)/10000)).toBe(16);identities.push(identity);}
 expect(application.pid).not.toBe(admin.pid);journal.identities={names,connections:identities,app_audit:appAudit,admin_audit:adminAudit};journal.table_count=tables.length;journal.sequence_count=sequences.length;
 const forbidden=vi.fn(async()=>{throw Error('Collection API must not access providers/storage/queues');});
 const env={...f.env,NODE_ENV:'test',APP_KEY:'synthetic-collection-management-'+randomUUID(),UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',HYPERDRIVE:{connectionString:application.connectionString},HYPERDRIVE_ADMIN:{connectionString:admin.connectionString},ASSETS_BUCKET:{get:forbidden,put:forbidden,delete:forbidden,head:forbidden,list:forbidden},CONFIG_KV:{get:forbidden,put:forbidden,delete:forbidden,list:forbidden},ORDER_QUEUE:{send:forbidden,sendBatch:forbidden},SEQUENCE:{idFromName:forbidden,get:forbidden},TOKEN_BUCKET:undefined} as unknown as Env;
 const tokens=new Map<number,string>();for(const uid of[11,22])tokens.set(uid,(await createToken(uid,'api',md5(password),env.APP_KEY)).token);
 journal.synthetic_authority={app_key_base64:Buffer.from(env.APP_KEY).toString('base64'),tokens:[...tokens]};
 const app=createApp(),remember=(state:DiyStateSnapshot)=>{const key=digest(state);journal.snapshots[key]??=state;return key;};
 async function request(path:string,options:RequestOptions={}){
  const uid=options.uid===undefined?11:options.uid,headers=new Headers({'Form-type':'h5'});if(uid!==null)headers.set('Authori-zation','Bearer '+(options.token??tokens.get(uid)));
  const raw=options.raw??(options.body===undefined?undefined:JSON.stringify(options.body)),method=options.method??(raw===undefined?'GET':'POST');if(raw!==undefined)headers.set('Content-Type',options.contentType??'application/json');
  const before=await snapshot(),started=Date.now();
  const response=await wiring.context!.run(createContainerFromDb(application.db),()=>app.fetch(new Request('https://owned.local'+path,{method,headers,body:raw}),env,{waitUntil:()=>{throw Error('Collection API may not queue work');},passThroughOnException:()=>{}} as never));
  const bytes=await response.text(),body=JSON.parse(bytes) as Row,ended=Date.now(),after=await snapshot();
  journal.exchanges.push({path,method,owner_uid:uid,request_headers:Object.fromEntries(headers),request_body:raw??null,response_http_status:response.status,response_headers:Object.fromEntries(response.headers),response_bytes:bytes,started_ms:started,ended_ms:ended,before_sha256:remember(before),after_sha256:remember(after)});
  expect(forbidden).not.toHaveBeenCalled();return{response,body,before,after,started,ended};
 }
 async function remove(ids:number[],category:'product'|'video',body:Row={id:ids,category},options:RequestOptions={}){
  const r=await request('/api/collect/del',{...options,body});expect(r.response.status).toBe(200);expect(r.response.headers.get('Cache-Control')).toBe('private, no-store');expect(r.body).toEqual({status:200,msg:'取消收藏',data:null});
  expect(r.after).toEqual(expectedDeletion(r.before,options.uid??11,ids,category));expect(r.after.__sequences).toEqual(r.before.__sequences);return r;
 }
 async function readonly(path:string,options:RequestOptions={}){const r=await request(path,options);expect(r.after).toEqual(r.before);return r;}
 return{f,env,application,admin,names,tokens,snapshot,request,remove,readonly,forbidden};
}
type Scope=Awaited<ReturnType<typeof prepare>>;
async function scenario(run:(scope:Scope)=>Promise<void>){
 const runId=randomUUID(),directory='/tmp/cinashop-collection-management-native-'+runId;await mkdir(directory,{mode:0o700});
 const journal:Row={run_id:runId,status:'running',exchanges:[],snapshots:{},boundary:'Synthetic local registered API/JWT/formal App PG16 only. No Browser/provider/production/native-device claim.'};
 let f:Fixture|undefined;wiring.context=new AsyncLocalStorage<Container>();const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('External network forbidden'));
 try{
  f=await refundRuntimeFixture();await f.db.update(user).set({pwd:password,status:1,isDel:0,deleteTime:null}).where(sql`${user.uid} IN(11,22)`);
  await f.db.insert(storeProduct).values(Array.from({length:101},(_,i)=>({id:base+i,storeName:'收藏原生商品'+i,stock:5,price:'12.30',isHot:i===100?1:0,isShow:i===3?0:1,isDel:i===4?1:0,isVerify:1,sort:9000,image:i===100?'/api/assets/'+asset:''})));
  await f.db.insert(storeProduct).values({id:foreign,storeName:'仅B收藏',stock:5,isShow:1,isVerify:1});
  await f.db.insert(video).values([base,base+1,base+2,foreign].map((id,i)=>({id,desc:'收藏视频'+id,isShow:i===1?0:1,isDel:i===2?1:0})));
  await f.db.insert(systemAttachment).values({attId:asset,type:1,relationId:0,moduleType:1,fileType:1,imageType:8,attDir:'/api/assets/'+asset,name:'attachments/admin/1/collection-hot.png',attType:'image/png'});
  await f.db.insert(userRelation).values([
   ...Array.from({length:101},(_,i)=>({uid:11,relationId:base+i,type:'collect',category:'product',addTime:i+1})),
   ...[base,base+1,base+2,missing].map(relationId=>({uid:11,relationId,type:'collect',category:'video',addTime:1})),
   ...[base,foreign].flatMap(relationId=>['product','video'].map(category=>({uid:22,relationId,type:'collect',category,addTime:1}))),
   {uid:11,relationId:missing,type:'collect',category:'product',addTime:999},
   {uid:11,relationId:base,type:'like',category:'product',addTime:1},{uid:22,relationId:base,type:'like',category:'video',addTime:1},
   {uid:11,relationId:base,type:'collect',category:'article',addTime:1},{uid:11,relationId:base,type:'play',category:'video',addTime:1},
  ]);
  // Finite setup establishes exact initial derived counters; business oracle
  // recomputes expected values independently from the raw remaining relations.
  await f.exec("UPDATE store_product p SET collect=(SELECT count(*) FROM user_relation r WHERE r.relation_id=p.id AND r.type='collect' AND r.category='product') WHERE p.id BETWEEN 295000 AND 295110");
  await f.exec("UPDATE video v SET collect_num=(SELECT count(*) FROM user_relation r WHERE r.relation_id=v.id AND r.type='collect' AND r.category='video') WHERE v.id BETWEEN 295000 AND 295110");
  await f.withRuntimeRole!(application=>f!.withRuntimeRole!(async admin=>run(await prepare(f!,application,admin,journal))));journal.status='passed';
 }catch(error){journal.status='failed';journal.error=error instanceof Error?{message:error.message,stack:error.stack}:String(error);throw error;}
 finally{
  try{expect(network).not.toHaveBeenCalled();}finally{wiring.context=undefined;vi.restoreAllMocks();if(f){await f.close();journal.fixture_closed=true;}await writeFile(directory+'/evidence.json',JSON.stringify(journal,null,2)+'\n',{mode:0o600});console.log('COLLECTION_MANAGEMENT_NATIVE '+JSON.stringify({run_id:runId,status:journal.status,exchanges:journal.exchanges.length,evidence:directory+'/evidence.json',fixture_closed:journal.fixture_closed===true}));}
 }
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('collection management registered API, formal App and complete-schema conservation',()=>{
 it('deletes only JWT-owned collect/category relations, preserves unavailable removal, duplicate/replay and 100-ID counters, and reuses readonly hot data',async()=>scenario(async s=>{
  const initial=await s.readonly('/api/collect/user?page=1&limit=100&category=product');expect(initial.body.status).toBe(200);expect(initial.body.data.count).toBe(102);expect(initial.body.data.list).toHaveLength(99);expect(initial.body.data.list.some((r:Row)=>r.product_id===missing)).toBe(false);expect(initial.body.data.list.some((r:Row)=>r.is_fail===1)).toBe(true);
  const videos=await s.readonly('/api/collect/user?page=1&limit=100&category=video');expect(videos.body.data).toMatchObject({actor_uid:11,count:4});expect(videos.body.data.list.map((r:Row)=>r.video_id).sort()).toEqual([base,base+1,base+2,missing].sort());
  const other=await s.readonly('/api/collect/user?page=1&limit=100&category=product',{uid:22});expect(other.body.data.count).toBe(2);
  const untouched=await s.remove([foreign],'product');expect(untouched.after).toEqual(untouched.before);
  await s.remove([base],'video',{id:[base],category:'video',uid:22,owner_uid:22,type:'like'});
  await s.remove([base],'product',{id:[base,String(base),base],category:' PRODUCT ',uid:22,type:'like'});
  const replay=await s.remove([base],'product');expect(replay.after).toEqual(replay.before);
  await s.remove([base+1],'product',{id:[base+1]});
  await s.remove([base+1,base+2],'product',{id:`${base+1},${base+2}`,category:''});
  await s.remove([base+3,base+4],'product');
  await s.remove(Array.from({length:100},(_,i)=>base+i),'product');
  const last=await s.readonly('/api/collect/user?page=1&limit=100&category=product');expect(last.body.data.count).toBe(2);expect(last.body.data.list.map((r:Row)=>r.product_id)).toEqual([base+100]);
  await s.remove([base+100,missing],'product');const empty=await s.readonly('/api/collect/user?page=1&limit=100&category=product');expect(empty.body.data).toEqual({list:[],count:0});
  await s.remove([base+1,base+2,missing],'video');const emptyVideo=await s.readonly('/api/collect/user?page=1&limit=100&category=video');expect(emptyVideo.body.data).toMatchObject({actor_uid:11,list:[],count:0});
  for(const uid of[11,22]){const hot=await s.readonly('/api/product/hot?view=member_level&page=1&limit=10',{uid});expect(hot.body.status).toBe(200);expect(hot.body.data).toMatchObject({owner_uid:uid,page:1,limit:10});const row=hot.body.data.list.find((r:Row)=>r.id===base+100);expect(row).toBeDefined();expect(row.image_source).toBe('/api/assets/'+asset);const signed=new URL(row.image,'https://owned.local'),expires=Number(signed.searchParams.get('expires'));expect(expires).toBeGreaterThanOrEqual(Math.floor(hot.started/1000)+900);expect(expires).toBeLessThanOrEqual(Math.floor(hot.ended/1000)+900);expect(signed.searchParams.get('signature')).toBe(createHmac('sha256',s.env.APP_KEY).update(`GET\n/api/assets/${asset}\n${expires}`).digest('base64url'));}
  const ownAfter=await s.snapshot();expect(ownAfter.user_relation.filter(r=>r.uid===11&&r.type==='collect'&&['product','video'].includes(r.category))).toEqual([]);expect(ownAfter.user_relation.filter(r=>r.uid===22&&r.type==='collect')).toHaveLength(4);expect(ownAfter.user_relation.some(r=>r.uid===11&&r.type==='like')).toBe(true);expect(ownAfter.user_relation.some(r=>r.category==='article')).toBe(true);
 }),180000);
 it('rejects malformed bounds and actual JWT/account revocation without changing any table, sequence or external resource',async()=>scenario(async s=>{
  for(const body of[{id:[],category:'product'},{id:['01'],category:'product'},{id:['1e2'],category:'product'},{id:[1.5],category:'product'},{id:[true],category:'product'},{id:[{}],category:'product'},{id:[-1],category:'product'},{id:[0],category:'product'},{id:Array.from({length:101},(_,i)=>base+i),category:'product'},{id:[base],category:'article'}]){const r=await s.readonly('/api/collect/del',{body});expect(r.body.status).toBe(400);expect(r.body.data).toBeNull();}
  const malformed=await s.readonly('/api/collect/del',{raw:'{invalid'});expect(malformed.body.status).toBe(400);
  const oversized=await s.readonly('/api/collect/del',{body:{id:[base],category:'product',padding:'x'.repeat(17000)}});expect(oversized.body.status).toBe(400);
  const wrongType=(await createToken(11,'admin',md5(password),s.env.APP_KEY)).token;
  for(const options of[{uid:null},{token:'invalid'},{token:wrongType}]){const r=await s.readonly('/api/collect/del',{...options,body:{id:[base],category:'product'}});expect([410000,410001,410002]).toContain(r.body.status);expect(r.body.data).toBeNull();}
  for(const change of[{status:0},{isDel:1},{deleteTime:new Date('2026-10-01T00:00:00Z')},{pwd:'synthetic-revoked-collection'}]){await s.f.db.update(user).set(change).where(eq(user.uid,11));try{const r=await s.readonly('/api/collect/del',{body:{id:[base],category:'product'}});expect([410001,410002]).toContain(r.body.status);}finally{await s.f.db.update(user).set({status:1,isDel:0,deleteTime:null,pwd:password}).where(eq(user.uid,11));}}
 }),180000);
 it('fails closed before mutation on int4 overflow and ambiguous duplicate/nonstring categories',async()=>scenario(async s=>{
  const cases:RequestOptions[]=[{body:{id:[2147483648],category:'product'}},{body:{id:[base],category:['video','video']}},{body:{id:[base],category:7}},{body:{id:[base],category:null}},{body:{id:[base],category:false}},{raw:`id[]=${base}&category=video&category=video`,contentType:'application/x-www-form-urlencoded'}];
  const failures:Row[]=[];for(const options of cases){const r=await s.request('/api/collect/del',options);if(r.body.status!==400)failures.push({input:options,expected_status:400,actual_status:r.body.status});if(stableDiyState(r.after)!==stableDiyState(r.before))failures.push({input:options,error:'invalid input changed complete database state',before:digest(r.before),after:digest(r.after)});}expect(failures,'ambiguous input must fail validation before changing any table/sequence').toEqual([]);
 }),180000);
});
