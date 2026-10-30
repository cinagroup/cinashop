import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHmac} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import type {Env,OrderMessage} from '@/env';
import {createContainerFromDb} from '@/lib/di';
import {systemAdmin,systemRole,systemConfig,userLabel,legacyCategory} from '@/models/schema';
import {AdminUserLabelAuthorService,labelActorStamp,labelDigest} from '@/services/admin/AdminUserLabelAuthorService';
import {dispatchQueuedUserLabelSync,enqueueUserLabelSync,isUserLabelSyncMessage,type UserLabelSyncMessage} from '@/services/admin/AdminUserLabelSyncQueue';
import {md5} from '@/utils/jwt';
import {labelCanonical,type LabelAction} from '../../view/common/labelAuthor';
import {createAdminLabelFixture} from './helpers/adminLabelFixture';

const wiring=vi.hoisted(()=>({open:vi.fn(),application:vi.fn(),close:vi.fn(async()=>{})}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createAdminDatabaseSession:wiring.open,createContainer:wiring.application}));
// These classes are platform-only ports used when importing the real Worker
// queue entry. No SQL/service, dispatcher, provider client or ACK branch is mocked.
vi.mock('@/do/TokenBucketDO',()=>({TokenBucketDO:class{}}));
vi.mock('@/do/OrderLockDO',()=>({OrderLockDO:class{}}));
vi.mock('@/do/SequenceDO',()=>({SequenceDO:class{}}));
vi.mock('@/do/ChatRoomDO',()=>({ChatRoomDO:class{}}));
vi.mock('@/do/StaffNotificationDO',()=>({StaffNotificationDO:class{}}));

const START=Date.parse('2026-10-26T18:00:00Z'),pwd='owned-label-queue-password',CORP='corp-queue-owned';
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const clone=<T>(value:T):T=>structuredClone(value);
interface RemoteTag{id:string;name:string;order:number;create_time:number}
interface RemoteGroup{group_id:string;group_name:string;order:number;create_time:number;tag:RemoteTag[]}
interface Call{url:URL;init?:RequestInit}
const queueResponse:QueueSendResponse={metadata:{metrics:{backlogCount:0,backlogBytes:0}}};

describe('label Queue signed commands, actual provider stages and restricted immutable SQL',()=>{
 let f:Awaited<ReturnType<typeof createAdminLabelFixture>>,s:AdminUserLabelAuthorService,env:Env;
 let clock:number,remote:RemoteGroup[],calls:Call[],queued:UserLabelSyncMessage[],kv:Map<string,string>;
 let createMode:'success'|'accepted-lost-ack'|'not-applied-lost-ack'|'partial-ack';
 let beforeDirectory:(()=>Promise<void>)|undefined,afterCreate:(()=>Promise<void>)|undefined;
 const actor=()=>({id:3,authVersion:md5(pwd),expiresAt:Math.floor(START/1000)+3600});
 beforeEach(async()=>{
  clock=START;vi.spyOn(Date,'now').mockImplementation(()=>clock);
  f=await createAdminLabelFixture();remote=[];calls=[];queued=[];kv=new Map();createMode='success';beforeDirectory=undefined;afterCreate=undefined;
  const binding={async get(key:string,type?:string){const value=kv.get(key)??null;return value&&type==='json'?JSON.parse(value):value;},
   async put(key:string,value:string){kv.set(key,value);},async delete(key:string){kv.delete(key);}} as unknown as KVNamespace;
  env={APP_KEY:'owned-label-queue-hmac-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',CONFIG_KV:binding,
   WECHAT_WORK_EXTERNAL_CONTACT_SECRET:'controlled-label-queue-secret',ORDER_DLQ_NAME:'owned-label-dlq',
   ORDER_QUEUE:{send:vi.fn(async(value:OrderMessage):Promise<QueueSendResponse>=>{if(!isUserLabelSyncMessage(value))throw Error('Unexpected Queue message');queued.push(clone(value));return queueResponse;})}} as unknown as Env;
  await f.db.insert(systemRole).values([{id:1,rules:'label.manage'},{id:2,rules:'label.view'}]);
  await f.db.insert(systemAdmin).values([{id:1,account:'root',pwd,level:0},{id:3,account:'writer',pwd,level:1,roles:'1'},{id:4,account:'reader',pwd,level:1,roles:'2'}]);
  await f.db.insert(systemConfig).values({menuName:'wechat_work_corpid',value:CORP});
  await f.db.insert(legacyCategory).values({id:10,name:'Customers',sort:5,integralMin:7});
  await f.db.insert(userLabel).values({id:20,labelCate:10,name:'VIP',sort:9,status:0,color:'historical-color',addTime:7});
  await f.exec("SELECT setval('public.category_id_seq',100,false);SELECT setval('public.user_label_id_seq',200,false)");
  s=new AdminUserLabelAuthorService(f.container,env);
  wiring.open.mockReset().mockImplementation(()=>({container:createContainerFromDb(f.db),close:wiring.close}));
  wiring.application.mockReset().mockReturnValue(f.container);wiring.close.mockClear();
  vi.spyOn(globalThis,'fetch').mockImplementation(async(input:RequestInfo|URL,init?:RequestInit)=>{
   const url=new URL(String(input));calls.push({url,init});
   if(url.origin!=='https://qyapi.weixin.qq.com')throw Error('Unexpected provider origin');
   if(url.pathname==='/cgi-bin/gettoken')return json({errcode:0,access_token:'controlled-label-access-token',expires_in:7200});
   if(url.pathname==='/cgi-bin/externalcontact/get_corp_tag_list'){
    expect(init?.method).toBe('POST');expect(JSON.parse(String(init?.body))).toEqual({tag_id:[],group_id:[]});
    await beforeDirectory?.();return json({errcode:0,errmsg:'ok',tag_group:clone(remote)});
   }
   if(url.pathname==='/cgi-bin/externalcontact/add_corp_tag'){
    const body=JSON.parse(String(init?.body)) as {group_id?:string;group_name?:string;order?:number;tag:{name:string;order?:number}[]};
    const events=await f.db.execute(sql`SELECT state FROM public.admin_label_operation ORDER BY (result->>'step')::integer`);
    expect(events.at(-1)?.state).toBe('dispatch'); // The non-idempotent I/O follows its committed intent.
    let group=remote.find(r=>r.group_id===body.group_id||r.group_name===body.group_name);
    if(createMode!=='not-applied-lost-ack'&&createMode!=='partial-ack'){
     if(!group){group={group_id:'et-owned-group',group_name:body.group_name!,order:body.order??0,create_time:1788000000,tag:[]};remote.push(group);}
     for(const [index,t]of body.tag.entries())group.tag.push({id:`et-owned-tag-${index}`,name:t.name,order:t.order??0,create_time:1788000000});
    }
    await afterCreate?.();
    if(createMode==='accepted-lost-ack'||createMode==='not-applied-lost-ack')throw Error('Controlled transport lost the create ACK');
    if(createMode==='partial-ack')return json({errcode:0,tag_group:{group_id:'et-owned-group'}});
    return json({errcode:0,errmsg:'ok',tag_group:clone(group)});
   }
   throw Error('Unexpected controlled provider endpoint');
  });
 },30000);
 afterEach(async()=>{vi.restoreAllMocks();await f?.close();},30000);
 const creates=()=>calls.filter(c=>c.url.pathname.endsWith('/add_corp_tag'));
 const reads=()=>calls.filter(c=>c.url.pathname.endsWith('/get_corp_tag_list'));
 async function action():Promise<LabelAction>{const a:LabelAction={operation_id:crypto.randomUUID(),actor_id:3,operation:'sync',target_id:0,
  revision:(await f.asAdmin(()=>s.catalog(new URLSearchParams(),actor()))).revision,payload:{},payload_hash:''};a.payload_hash=labelDigest(labelCanonical(a));return a;}
 async function queuedCommand(){const a=await action();await f.asAdmin(()=>s.mutate(a,actor()));expect(await enqueueUserLabelSync(env,a,actor())).toBe(true);expect(queued).toHaveLength(1);return queued[0]!;}
 const dispatch=(value:unknown)=>f.asAdmin(()=>dispatchQueuedUserLabelSync(value,env));
 const signed=(base:Omit<UserLabelSyncMessage,'seal'>):UserLabelSyncMessage=>({...base,seal:createHmac('sha256',env.APP_KEY).update('user-label-sync-queue-v1:'+JSON.stringify(base)).digest('hex')});
 function resign(value:UserLabelSyncMessage,patch:Partial<Omit<UserLabelSyncMessage,'seal'>>){return signed({action:value.action,command:value.command,actor_stamp:value.actor_stamp,expires_at:value.expires_at,...patch});}
 async function business(){return{categories:await f.db.select().from(legacyCategory).orderBy(legacyCategory.id),labels:await f.db.select().from(userLabel).orderBy(userLabel.id)};}
 async function snapshot(){return{...await business(),events:Array.from(await f.db.execute(sql`SELECT * FROM public.admin_label_operation ORDER BY operation_id`)),
  sequences:Array.from(await f.db.execute(sql`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`))};}
 async function unchanged(run:()=>Promise<unknown>){const before=await snapshot();try{return await run();}finally{expect(await snapshot()).toEqual(before);}}
 async function chain(a:LabelAction){return f.asAdmin(()=>s.transaction(actor(),false,true,tx=>s.events(tx,a)));}
 async function workerMessage(body:UserLabelSyncMessage,attempts=1){
  const entry=await import('@/index'),ack=vi.fn(),retry=vi.fn();
  const batch:MessageBatch<OrderMessage>={queue:'owned-label-queue',metadata:{metrics:{backlogCount:1,backlogBytes:0}},messages:[{id:crypto.randomUUID(),timestamp:new Date(clock),body,attempts,ack,retry}],ackAll:vi.fn(),retryAll:vi.fn()};
  await f.asAdmin(()=>entry.default.queue(batch,env));return{ack,retry};
 }

 it('enqueues only the exact server-signed command, with an HMAC actor stamp and original session deadline',async()=>{
  const m=await queuedCommand();expect(m).toMatchObject({action:'dispatchUserLabelSync',command:{operation:'sync',payload:{},actor_id:3},expires_at:actor().expiresAt});
  expect(m.actor_stamp).toBe(labelActorStamp(env.APP_KEY,md5(pwd)));expect(m.actor_stamp).not.toBe(md5(pwd));
  expect(m).not.toHaveProperty('authVersion');expect(m).not.toHaveProperty('pwd');expect(m.seal).toMatch(/^[a-f0-9]{64}$/);
  expect(m).toEqual(resign(m,{}));expect(calls).toEqual([]);expect(wiring.open).not.toHaveBeenCalled();
 });
 it('does not claim delivery when Queue binding is unavailable',async()=>{
  const a=await action();expect(await enqueueUserLabelSync({...env,ORDER_QUEUE:undefined} as unknown as Env,a,actor())).toBe(false);
  expect(queued).toEqual([]);expect(wiring.open).not.toHaveBeenCalled();expect(calls).toEqual([]);
 });
 for(const [name,forge]of [
  ['wrong seal',(m:UserLabelSyncMessage)=>({...m,seal:(m.seal[0]==='0'?'1':'0')+m.seal.slice(1)})],
  ['actor stamp',(m:UserLabelSyncMessage)=>({...m,actor_stamp:'0'.repeat(64)})],
  ['deadline',(m:UserLabelSyncMessage)=>({...m,expires_at:m.expires_at+1})],
  ['actor',(m:UserLabelSyncMessage)=>({...m,command:{...m.command,actor_id:1}})],
  ['action payload',(m:UserLabelSyncMessage)=>({...m,command:{...m.command,payload:{name:'forged'}}})],
  ['unknown field',(m:UserLabelSyncMessage)=>({...m,db:'application fallback'})],
  ['missing command',(m:UserLabelSyncMessage)=>({...m,command:null})],
 ] as const)it('rejects forged '+name+' before opening any Admin connection or touching SQL/provider',async()=>{
  const m=await queuedCommand();await unchanged(()=>expect(dispatch(forge(m))).rejects.toThrow());
  expect(wiring.open).not.toHaveBeenCalled();expect(wiring.close).not.toHaveBeenCalled();expect(calls).toEqual([]);
 });
 it('acknowledges an originally valid but now expired command before opening the DB',async()=>{
  const m=await queuedCommand();clock=(m.expires_at+1)*1000;
  await unchanged(()=>expect(dispatch(m)).resolves.toEqual({done:true,reason:'expired'}));expect(wiring.open).not.toHaveBeenCalled();expect(calls).toEqual([]);
 });
 it('rejects a changed password without touching provider or the immutable queued intent and closes the session',async()=>{
  const m=await queuedCommand();await f.db.update(systemAdmin).set({pwd:'changed-storage-hash'}).where(eq(systemAdmin.id,3));
  await unchanged(()=>expect(dispatch(m)).resolves.toEqual({done:true,reason:'credential_changed'}));
  expect(calls).toEqual([]);expect(wiring.open).toHaveBeenCalledTimes(1);expect(wiring.close).toHaveBeenCalledTimes(1);
 });
 for(const change of [{status:0},{isDel:1},{adminType:4},{relationId:7}])it('revalidates the live Admin realm/status '+JSON.stringify(change)+' before provider I/O',async()=>{
  const m=await queuedCommand();await f.db.update(systemAdmin).set(change).where(eq(systemAdmin.id,3));
  await unchanged(()=>expect(dispatch(m)).rejects.toThrow());expect(calls).toEqual([]);expect(wiring.close).toHaveBeenCalledTimes(1);
 });
 it('revalidates revoked role authority even when queue seal and credential version are valid',async()=>{
  const m=await queuedCommand();await f.db.update(systemRole).set({rules:'label.view'}).where(eq(systemRole.id,1));
  await unchanged(()=>expect(dispatch(m)).rejects.toThrow());expect(calls).toEqual([]);expect(wiring.close).toHaveBeenCalledTimes(1);
 });
 it('a signed but unqueued command cannot authorize provider work',async()=>{
  const a=await action(),m=signed({action:'dispatchUserLabelSync',command:a,actor_stamp:labelActorStamp(env.APP_KEY,actor().authVersion),expires_at:actor().expiresAt});
  await unchanged(()=>expect(dispatch(m)).rejects.toThrow(/durable command/));expect(calls).toEqual([]);expect(wiring.close).toHaveBeenCalledTimes(1);
 });
 it('rejects a newly signed deadline which differs from the original durable session binding',async()=>{
  const m=await queuedCommand();await unchanged(()=>expect(dispatch(resign(m,{expires_at:m.expires_at+1}))).rejects.toThrow(/durable command/));
  expect(calls).toEqual([]);expect(wiring.close).toHaveBeenCalledTimes(1);
 });
 it('does not revive the durable command after password replacement even with a newly valid server stamp and signature',async()=>{
  const m=await queuedCommand();await f.db.update(systemAdmin).set({pwd:'new-credential'}).where(eq(systemAdmin.id,3));
  const changed=resign(m,{actor_stamp:labelActorStamp(env.APP_KEY,md5('new-credential'))});
  await unchanged(()=>expect(dispatch(changed)).rejects.toThrow(/durable command/));expect(calls).toEqual([]);expect(wiring.close).toHaveBeenCalledTimes(1);
 });
 it('exports then freshly confirms remote IDs and atomically maps local rows while preserving inactive metadata',async()=>{
  const m=await queuedCommand(),before=await business();expect(await dispatch(m)).toEqual({done:true,reason:'committed'});
  const after=await business();expect(after.categories).toEqual(before.categories.map(r=>({...r,other:'et-owned-group'})));
  expect(after.labels).toEqual(before.labels.map(r=>({...r,tagId:'et-owned-tag-0'})));
  const events=[...await chain(m.command)].reverse();expect(events.map(e=>e.state)).toEqual(['queued','planned','dispatch','confirmed','committed']);
  expect(events.map(e=>e.result.step)).toEqual([0,1,2,3,4]);expect(new Set(events.map(e=>e.operation_id)).size).toBe(5);
  expect(creates()).toHaveLength(1);expect(reads()).toHaveLength(3);expect(wiring.close).toHaveBeenCalledTimes(1);
  expect(calls[0]!.url.searchParams.get('corpsecret')).toBe('controlled-label-queue-secret');
  expect(JSON.parse(String(creates()[0]!.init?.body))).toEqual({group_name:'Customers',order:5,tag:[{name:'VIP',order:9}]});
 });
 it('imports missing remote category/tag records only after complete GET validation, without issuing any create',async()=>{
  await f.db.delete(userLabel);await f.db.delete(legacyCategory);
  remote=[{group_id:'et-remote-group',group_name:'Remote',order:5,create_time:1788000000,tag:[{id:'et-remote-tag',name:'Imported',order:9,create_time:1788000000}]}];
  const m=await queuedCommand();expect(await dispatch(m)).toEqual({done:true,reason:'committed'});
  expect((await business()).categories).toMatchObject([{id:100,other:'et-remote-group',name:'Remote',sort:5,addTime:1788000000}]);
  expect((await business()).labels).toMatchObject([{id:200,labelCate:100,tagId:'et-remote-tag',name:'Imported',sort:9,status:1}]);
  expect(creates()).toEqual([]);expect(reads()).toHaveLength(1);
 });
 it('lost successful provider ACK is recovered by fresh directory evidence and never by a second create',async()=>{
  createMode='accepted-lost-ack';const m=await queuedCommand();expect(await dispatch(m)).toEqual({done:true,reason:'committed'});
  expect(creates()).toHaveLength(1);expect(reads()).toHaveLength(3);
  const frozen=await snapshot(),count=calls.length;expect(await dispatch(m)).toEqual({done:true,reason:'committed'});
  expect(await snapshot()).toEqual(frozen);expect(calls).toHaveLength(count);expect(creates()).toHaveLength(1);expect(wiring.close).toHaveBeenCalledTimes(2);
 });
 for(const mode of ['not-applied-lost-ack','partial-ack'] as const)it(mode+' remains unknown and Queue redelivery only performs directory GETs',async()=>{
  createMode=mode;const m=await queuedCommand(),before=await business();expect(await dispatch(m)).toEqual({done:false,reason:'unknown'});
  const events=await chain(m.command);expect(events[0]!.state).toBe('dispatch');const frozen=await snapshot();
  expect(await dispatch(m)).toEqual({done:false,reason:'unknown'});expect(await snapshot()).toEqual(frozen);expect(await business()).toEqual(before);
  expect(creates()).toHaveLength(1);expect(reads().length).toBeGreaterThan(2);
  // A later authoritative observation can resolve the same dispatch, with no POST retry.
  remote=[{group_id:'et-owned-group',group_name:'Customers',order:5,create_time:1788000000,tag:[{id:'et-owned-tag-0',name:'VIP',order:9,create_time:1788000000}]}];
  expect(await dispatch(m)).toEqual({done:true,reason:'committed'});expect(creates()).toHaveLength(1);
 });
 it('does not claim confirmation when unrelated directory changes make a lost ACK ambiguous',async()=>{
  createMode='accepted-lost-ack';afterCreate=async()=>{remote.push({group_id:'et-unrelated',group_name:'Unrelated',order:0,create_time:1788000000,tag:[]});};
  const m=await queuedCommand(),before=await business();expect(await dispatch(m)).toEqual({done:false,reason:'unknown'});
  expect(await business()).toEqual(before);expect((await chain(m.command))[0]!.state).toBe('dispatch');expect(creates()).toHaveLength(1);
  expect(await dispatch(m)).toEqual({done:false,reason:'unknown'});expect(creates()).toHaveLength(1);
 });
 it('stops before creation if local source changed while an initial provider read was pending',async()=>{
  const m=await queuedCommand();beforeDirectory=async()=>{beforeDirectory=undefined;await f.db.update(userLabel).set({color:'#ffffff'}).where(eq(userLabel.id,20));};
  expect(await dispatch(m)).toEqual({done:true,reason:'stopped'});expect(creates()).toEqual([]);
  expect((await f.db.select().from(userLabel))[0]).toMatchObject({color:'#ffffff',tagId:''});
 });
 it('a credential deadline reached during provider I/O cannot append a plan or import rows',async()=>{
  const m=await queuedCommand(),before=await snapshot();beforeDirectory=async()=>{clock=(m.expires_at+1)*1000;};
  await expect(dispatch(m)).rejects.toThrow(/过期/);expect(await snapshot()).toEqual(before);expect(creates()).toEqual([]);expect(wiring.close).toHaveBeenCalledTimes(1);
 });
 it('credential/config replacement during an external GET prevents applying that late response',async()=>{
  const m=await queuedCommand(),before=await business(),identities:Array<{role:unknown;session:unknown}>=[];
  beforeDirectory=async()=>{
   // This provider gap is outside the author's SQL transaction. Configuration
   // maintenance is not an Admin runtime capability: switch the owned fixture
   // port explicitly, then restore the original restricted LOGIN even on error.
   const identity=async()=>{const[row]=await f.db.execute(sql`SELECT current_user AS role,session_user AS session`);identities.push({role:row.role,session:row.session});};
   await identity();
   const quote=(value:string)=>'"'+value.replace(/"/gu,'""')+'"';
   try{
    await f.exec(`SET SESSION AUTHORIZATION ${quote(f.names.maintenance)}`);await identity();
    await f.db.update(systemConfig).set({value:'corp-replaced'}).where(eq(systemConfig.menuName,'wechat_work_corpid'));
   }finally{await f.exec(`SET SESSION AUTHORIZATION ${quote(f.names.admin)}`);await identity();}
  };
  await expect(dispatch(m)).rejects.toThrow(/身份|凭据|改变/);expect(await business()).toEqual(before);
  expect(identities).toEqual([{role:f.names.admin,session:f.names.admin},{role:f.names.maintenance,session:f.names.maintenance},{role:f.names.admin,session:f.names.admin}]);
  expect((await chain(m.command))[0]!.state).toBe('queued');expect(creates()).toEqual([]);expect(wiring.close).toHaveBeenCalledTimes(1);
 });
 it('revocation after dispatch leaves remote effects explicit and drops subsequent stages; regrant only reconciles by GET',async()=>{
  const m=await queuedCommand(),before=await business();afterCreate=async()=>{await f.db.update(systemRole).set({rules:'label.view'}).where(eq(systemRole.id,1));};
  await expect(dispatch(m)).rejects.toThrow();expect(await business()).toEqual(before);expect(creates()).toHaveLength(1);expect(reads()).toHaveLength(1);
  // Owner recovery can inspect the durable dispatch without restoring manage.
  expect((await f.asAdmin(()=>s.receipt(m.command.operation_id,new URLSearchParams(),actor()))).state).toBe('dispatch');
  await f.db.update(systemRole).set({rules:'label.manage'}).where(eq(systemRole.id,1));afterCreate=undefined;
  expect(await dispatch(m)).toEqual({done:true,reason:'committed'});expect(creates()).toHaveLength(1);expect(wiring.close).toHaveBeenCalledTimes(2);
 });
 it('the actual Worker queue branch ACKs a complete sync and repeat delivery does not mutate or contact provider',async()=>{
  const m=await queuedCommand(),first=await workerMessage(m);expect(first.ack).toHaveBeenCalledTimes(1);expect(first.retry).not.toHaveBeenCalled();
  const frozen=await snapshot(),count=calls.length,again=await workerMessage(m,2);expect(again.ack).toHaveBeenCalledTimes(1);expect(again.retry).not.toHaveBeenCalled();
  expect(await snapshot()).toEqual(frozen);expect(calls).toHaveLength(count);expect(creates()).toHaveLength(1);
 },30000);
 it('the actual Worker queue branch retries unknown once per delivery and ACKs exhausted delivery without resending creates',async()=>{
  createMode='not-applied-lost-ack';const m=await queuedCommand(),first=await workerMessage(m);
  expect(first.ack).not.toHaveBeenCalled();expect(first.retry).toHaveBeenCalledWith({delaySeconds:30});
  const frozen=await snapshot(),last=await workerMessage(m,4);expect(last.ack).toHaveBeenCalledTimes(1);expect(last.retry).not.toHaveBeenCalled();
  expect(await snapshot()).toEqual(frozen);expect(creates()).toHaveLength(1);
 },30000);
 it('the actual Worker queue branch rejects forged seals before Admin DB and retries only bounded metadata errors',async()=>{
  const m=await queuedCommand(),bad={...m,seal:'0'.repeat(64)};if(bad.seal===m.seal)bad.seal='1'.repeat(64);
  await unchanged(async()=>{const first=await workerMessage(bad);expect(first.ack).not.toHaveBeenCalled();expect(first.retry).toHaveBeenCalledWith({delaySeconds:60});
   const final=await workerMessage(bad,4);expect(final.ack).toHaveBeenCalledTimes(1);expect(final.retry).not.toHaveBeenCalled();});
  expect(wiring.open).not.toHaveBeenCalled();expect(wiring.close).not.toHaveBeenCalled();expect(calls).toEqual([]);
 },30000);
});
