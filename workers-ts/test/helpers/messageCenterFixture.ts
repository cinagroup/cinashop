/** Owned native PG16 fixture. Maintenance observes all 283 tables/229 sequences;
 * independently authenticated App/Admin connections use the existing formal
 * business profile, with ONLY the versioned receipt capability added to App. */
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { createToken, md5 } from '@/utils/jwt';
import { systemAttachment, systemMessage, userMessage, user, storeService, storeServiceRecord, storeServiceLog } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { installUserMessageReadCapability, inspectUserMessageReadCapability } from '@/migrations/userMessageReadCapability';
import { refundRuntimeFixture } from './refundRuntimeFixture';
import { sortedDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from './diyStateFixture';
import type { SequenceRunnerPeer } from './checkoutPricingMigrationDatabase';

export const IDS = { a:11,b:22,empty:66,firstService:33,offlineService:34,disabledService:56,
 ownMessage:710001,broadcast:710002,legacyRead:710003,duplicateUnread:710004,mixedRead:710005,
 foreignMessage:710101,staffMessage:710102,hiddenMessage:710103,deletedMessage:710104,
 firstConversation:730001,media:740201 } as const;
export const messageImageKey='attachments/admin/1/2026/10/74000000-0000-4000-8000-000000000001.png';
export const messageFixturePassword='synthetic-message-password';
export type MessageControl='missing-image'|'corrupt-image'|'restored-image'|'passwd-revoke'|'passwd-restore'|'status-revoke'|'status-restore'|'hide-broadcast'|'restore-broadcast';
type Peer=SequenceRunnerPeer&{role:string;connectionString:string};
const identifier=(value:string)=>{if(!/^[a-z_][a-z_0-9]*$/u.test(value))throw Error('Unsafe owned message identifier');return '"'+value+'"';};
const one=(rows:Row[],key:string,value:unknown)=>{const matches=rows.filter(r=>r[key]===value);expect(matches).toHaveLength(1);return matches[0]!;};

/** Independent raw-state oracle: never imports/calls the production visibility,
 * unread, paging or capability code to decide expected business changes. */
export function messageVisibleRows(before:DiyStateSnapshot,uid:number){
 return before.system_message.filter(m=>m.status===1&&m.is_del===0&&[0,1].includes(m.type)&&[0,uid].includes(m.user_id))
  .slice().sort((a,b)=>b.add_time-a.add_time||b.id-a.id);
}
export function messageUnreadCount(before:DiyStateSnapshot,uid:number){
 return messageVisibleRows(before,uid).filter(m=>m.look===0&&!before.user_message.some(r=>r.uid===uid&&r.message_id===m.id&&r.is_read===1)).length;
}
export function assertMessageReadConsumption(before:DiyStateSnapshot,after:DiyStateSnapshot,uid:number,ids:readonly number[],started:number,ended:number){
 expect(Object.keys(before).sort()).toEqual(Object.keys(after).sort());expect(Object.keys(before).filter(k=>k!=='__sequences')).toHaveLength(283);expect(before.__sequences).toHaveLength(229);
 expect(Number.isSafeInteger(uid)&&uid>0).toBe(true);expect(Number.isSafeInteger(started)&&Number.isSafeInteger(ended)&&started<=ended).toBe(true);
 const account=one(before.user,'uid',uid);expect(account).toMatchObject({status:1,is_del:0,delete_time:null});
 expect(new Set(ids).size).toBe(ids.length);expect(ids.length).toBeLessThanOrEqual(100);
 const visible=new Map(messageVisibleRows(before,uid).map(m=>[m.id,m])),expected=structuredClone(before),inserted:Row[]=[],updated:number[]=[];
 for(const id of [...ids].sort((a,b)=>a-b)){
  const m=visible.get(id);expect(m,'only visible owner/broadcast IDs can be consumed').toBeDefined();expect([0,1]).toContain(m!.look);
  const receipts=expected.user_message.filter(r=>r.uid===uid&&r.message_id===id);expect(receipts.every(r=>[0,1].includes(r.is_read))).toBe(true);
  if(m!.look===1||receipts.some(r=>r.is_read===1))continue;
  if(receipts.length){for(const r of receipts){expect(r.is_read).toBe(0);r.is_read=1;updated.push(r.id);}continue;}
  const seq=one(expected.__sequences,'name','user_message_id_seq'),next=BigInt(seq.last)+(seq.called?1n:0n);expect(next).toBeLessThanOrEqual(2147483647n);
  seq.last=String(next);seq.called=true;
  const actual=one(after.user_message,'id',Number(next));expect(Object.keys(actual).sort()).toEqual(['add_time','id','is_read','message_id','uid']);
  expect(Number.isSafeInteger(actual.add_time)).toBe(true);expect(actual.add_time).toBeGreaterThanOrEqual(started);expect(actual.add_time).toBeLessThanOrEqual(ended);
  const receipt={id:Number(next),uid,message_id:id,is_read:1,add_time:actual.add_time};expect(actual).toEqual(receipt);expected.user_message.push(receipt);inserted.push(receipt);
 }
 expect(after).toEqual(sortedDiyState(expected));
 return {kind:'independent-message-read-consumption',owner_uid:uid,message_ids:[...ids].sort((a,b)=>a-b),inserted_receipts:inserted,updated_receipt_ids:updated.sort((a,b)=>a-b),serial_allocations:inserted.length,
  observed_seconds:{started,ended},global_look_unchanged:true,all_other_283_tables_229_sequences_unchanged:true};
}

export async function messageCenterFixture(){
 const f=await refundRuntimeFixture(),owner='message_owner_'+randomUUID().replaceAll('-','').slice(0,16);let ownerCreated=false,applicationUsed=false,closed=false;
 async function close(){if(closed)return;closed=true;try{if(ownerCreated){await f.exec('DROP OWNED BY '+identifier(owner)+' CASCADE');await f.exec('DROP ROLE '+identifier(owner));expect(await f.db.execute(sql`SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${owner}`)).toHaveLength(0);ownerCreated=false;}}finally{await f.close();}}
 try{
  const tables=(await f.exec("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map(r=>String(r.name));
  const sequences=(await f.exec("SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).map(r=>String(r.name));
  expect(tables).toHaveLength(283);expect(sequences).toHaveLength(229);
  async function snapshot():Promise<DiyStateSnapshot>{const state:DiyStateSnapshot={};for(const r of await f.db.execute<{name:string;rows:Row[]}>(sql.join(tables.map(name=>sql`SELECT ${name}::text AS name,COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`),sql` UNION ALL `)))state[r.name]=r.rows;
   state.__sequences=await f.db.execute(sql.join(sequences.map(name=>sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`),sql` UNION ALL `));return sortedDiyState(state);}
  const before=await snapshot(),now=Math.floor(Date.now()/1000),appKey='synthetic-local-message-center-key-not-production';
  await f.db.delete(storeServiceLog);await f.db.delete(storeServiceRecord);await f.db.delete(storeService);await f.db.delete(userMessage);await f.db.delete(systemMessage);
  for(const uid of[IDS.a,IDS.b])await f.db.update(user).set({pwd:messageFixturePassword,status:1,isDel:0,deleteTime:null,nickname:uid===IDS.a?'消息会员A':'消息会员B'}).where(eq(user.uid,uid));
  const staff=Array.from({length:23},(_,i)=>IDS.firstService+i);
  await f.db.insert(user).values([...staff,IDS.disabledService,IDS.empty].map(uid=>({uid,pwd:messageFixturePassword,status:1,nickname:uid===IDS.empty?'空态会员C':'客服'+uid})));
  const avatar='/api/assets/'+IDS.media;
  await f.db.insert(storeService).values([...staff.map((uid,i)=>({id:720001+i,uid,nickname:i===0?'在线客服33':i===1?'离线客服34':'客服'+uid,avatar,online:i===0?1:0})),{id:720024,uid:IDS.disabledService,nickname:'已停用客服56',avatar,status:0}]);
  const messageIds=Array.from({length:23},(_,i)=>IDS.ownMessage+i);
  await f.db.insert(systemMessage).values(messageIds.map((id,i)=>({id,userId:id===IDS.broadcast?0:IDS.a,type:id===IDS.broadcast?0:1,look:id===IDS.legacyRead?1:0,
   title:id===IDS.ownMessage?'本人最新通知':id===IDS.broadcast?'所有用户广播':id===IDS.legacyRead?'已读旧快照':id===IDS.duplicateUnread?'旧未读重复':id===IDS.mixedRead?'混合历史收据':'站内通知'+(i+1),
   content:id===IDS.ownMessage?'本人原始正文 <img src=x onerror="globalThis.__messageUnsafe=1">':'站内消息正文'+(i+1),addTime:now-60-i})));
  await f.db.insert(systemMessage).values([
   {id:IDS.foreignMessage,userId:IDS.b,type:1,title:'B本人消息',content:'仅B可见',addTime:now},
   {id:IDS.staffMessage,userId:IDS.a,type:2,title:'员工私密提醒',content:'普通会员不得读取',addTime:now+1},
   {id:IDS.hiddenMessage,userId:IDS.a,type:1,status:0,title:'停用消息',addTime:now+2},
   {id:IDS.deletedMessage,userId:IDS.a,type:1,isDel:1,title:'已删消息',addTime:now+3},
  ]);
  await f.db.insert(userMessage).values([{id:9001,uid:IDS.a,messageId:IDS.duplicateUnread,isRead:0,addTime:1},{id:9002,uid:IDS.a,messageId:IDS.duplicateUnread,isRead:0,addTime:2},
   {id:9003,uid:IDS.a,messageId:IDS.mixedRead,isRead:1,addTime:3},{id:9004,uid:IDS.a,messageId:IDS.mixedRead,isRead:0,addTime:4}]);
  await f.exec("SELECT setval('public.user_message_id_seq',10000,true)");
  await f.db.insert(storeServiceRecord).values(staff.map((uid,i)=>({id:IDS.firstConversation+i,userId:IDS.a,toUid:uid,nickname:'旧客服摘要'+uid,avatar,
   addTime:now-3600-i,updateTime:now-i,messageNum:i===0?101:i===1?2:0,messageType:i===0?2:i%7+1,message:i===0?'[em-smile] 客服表情摘要 <b>纯文字</b>':i%7===2?avatar:'客服摘要'+(i+1)+'含较长文字并保留Unicode😀'})));
  await f.db.insert(storeServiceRecord).values({id:730101,userId:IDS.b,toUid:IDS.offlineService,nickname:'B独立客服',avatar,addTime:now-10,updateTime:now,messageNum:1,messageType:1,message:'B独立会话正文'});
  // Read-only history: merely selecting explicit offline staff must not reset
  // these unread rows or mutate either conversation summary.
  await f.db.insert(storeServiceLog).values([{id:750001,uid:IDS.offlineService,toUid:IDS.a,msn:'离线客服给A的历史',addTime:now-20,type:0,msnType:1},
   {id:750002,uid:IDS.a,toUid:IDS.offlineService,msn:'A回复离线客服',addTime:now-19,type:0,msnType:7},
   {id:750003,uid:IDS.offlineService,toUid:IDS.b,msn:'B独立历史不得给A',addTime:now-18,type:0,msnType:1}]);
  const png=new Uint8Array(await readFile(resolve(import.meta.dirname,'../../../view/uniapp-ts/src/static/logo.png')));
  await f.db.insert(systemAttachment).values({attId:IDS.media,type:1,relationId:0,moduleType:1,fileType:1,imageType:8,attDir:avatar,name:messageImageKey,attSize:String(png.length),attType:'image/png',time:now});
  await f.exec('CREATE ROLE '+identifier(owner)+' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS');ownerCreated=true;
  const objects=new Map<string,{bytes:Uint8Array;type:string}>([[messageImageKey,{bytes:png,type:'image/png'}]]),assetReads:Row[]=[];
  const forbidden=vi.fn(async()=>{throw Error('Forbidden message fixture provider/storage/queue effect');});
  const env={...f.env,APP_KEY:appKey,NODE_ENV:'test',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',
   ASSETS_BUCKET:{get:async(key:string)=>{const value=objects.get(key);assetReads.push({key,found:!!value,at_ms:Date.now(),bytes:value?.bytes.length??0});if(!value)return null;const bytes=Uint8Array.from(value.bytes),etag=createHash('sha256').update(bytes).digest('hex');return {size:bytes.length,etag,httpEtag:'"'+etag+'"',body:new Response(bytes).body,httpMetadata:{contentType:value.type},writeHttpMetadata:(h:Headers)=>h.set('Content-Type',value.type)};},put:forbidden,delete:forbidden,head:forbidden,list:forbidden},
   ORDER_QUEUE:{send:forbidden,sendBatch:forbidden},TOKEN_BUCKET:undefined,SEQUENCE:{idFromName:forbidden,get:forbidden},IMAGES:{input:forbidden},KEFU_SOCKET:undefined} as unknown as Env;
  const tokens=new Map<number,string>();for(const uid of[IDS.a,IDS.b,IDS.empty])tokens.set(uid,(await createToken(uid,'api',md5(messageFixturePassword),appKey)).token);
  const resources=()=>({forbidden:forbidden.mock.calls.length,objects:[...objects].map(([key,v])=>({key,bytes:v.bytes.length,type:v.type,sha256:createHash('sha256').update(v.bytes).digest('hex')})).sort((a,b)=>a.key.localeCompare(b.key))});
  async function control(name:MessageControl){const before=await snapshot(),expected=structuredClone(before),resourceBefore=resources();
   if(name==='missing-image')objects.delete(messageImageKey);
   else if(name==='corrupt-image')objects.set(messageImageKey,{bytes:new Uint8Array([137,80,78,71,0,1,2]),type:'image/png'});
   else if(name==='restored-image')objects.set(messageImageKey,{bytes:png,type:'image/png'});
   else if(name==='passwd-revoke'||name==='passwd-restore'){const pwd=name==='passwd-revoke'?'synthetic-message-revoked':messageFixturePassword;await f.db.update(user).set({pwd}).where(eq(user.uid,IDS.a));one(expected.user,'uid',IDS.a).pwd=pwd;}
   else if(name==='status-revoke'||name==='status-restore'){const status=name==='status-revoke'?0:1;await f.db.update(user).set({status}).where(eq(user.uid,IDS.a));one(expected.user,'uid',IDS.a).status=status;}
   else if(name==='hide-broadcast'||name==='restore-broadcast'){const status=name==='hide-broadcast'?0:1;await f.db.update(systemMessage).set({status}).where(eq(systemMessage.id,IDS.broadcast));one(expected.system_message,'id',IDS.broadcast).status=status;}
   else throw Error('Unknown finite message fixture control');
   const after=await snapshot();expect(after).toEqual(sortedDiyState(expected));return {kind:'qa-finite-message-fixture',nonproof:true,name,before,after,resources_before:resourceBefore,resources_after:resources()};
  }
  async function withApplication<T>(run:(runtime:{env:Env;container:ReturnType<typeof createContainerFromDb>;app:Peer;admin:Peer;role:string;pid:number;owner:string;names:{app:string;admin:string;maintenance:string;owner:string;database:string;pricingOwner:string};identities:Row[]})=>Promise<T>,options:{installCapability?:boolean}={}){
   if(applicationUsed)throw Error('Owned message fixture App may only be commissioned once');applicationUsed=true;
   return f.withRuntimeRole!(app=>f.withRuntimeRole!(async admin=>{
    const [database]=await f.exec('SELECT current_database() AS name'),names={app:app.role,admin:admin.role,maintenance:'finance_test',owner,database:String(database.name),pricingOwner:f.pricingOwner};
    const stateBefore=await snapshot();await runRuntimeBusinessCommissioning(f.db,names);
    const beforeAppAudit=await auditRuntimeBusinessPrivileges(app.db,'app',names);expect(beforeAppAudit).toMatchObject({ready:true,failures:[]});
    if(options.installCapability!==false){expect(await installUserMessageReadCapability(f.db,names)).toEqual({applied:true,ready:true});expect(await installUserMessageReadCapability(f.db,names)).toEqual({applied:false,ready:true});}
    const capability=await inspectUserMessageReadCapability(app.db),appAudit=await auditRuntimeBusinessPrivileges(app.db,'app',names),adminAudit=await auditRuntimeBusinessPrivileges(admin.db,'admin',names);
    expect(appAudit).toMatchObject({ready:true,failures:[]});expect(adminAudit).toMatchObject({ready:true,failures:[]});expect(await snapshot()).toEqual(stateBefore);
    const [identity]=await app.exec("SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=current_user");
    expect(identity.role).toBe(app.role);expect(identity.session).toBe(app.role);expect(identity.pid).toBe(app.pid);expect(identity.rolcanlogin).toBe(true);expect(Math.floor(Number(identity.version)/10000)).toBe(16);
    for(const key of['rolsuper','rolinherit','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'])expect(identity[key]).toBe(false);
    const [receiptRights]=await app.db.execute(sql`SELECT has_table_privilege(current_user,'public.user_message','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,'public.user_message','INSERT,UPDATE,REFERENCES') OR has_sequence_privilege(current_user,'public.user_message_id_seq','USAGE,SELECT,UPDATE') AS direct_write`);
    expect(receiptRights.direct_write).toBe(false);
    return run({env:{...env,HYPERDRIVE:{connectionString:app.connectionString}} as Env,container:createContainerFromDb(app.db),app,admin,role:app.role,pid:app.pid,owner,names,
     identities:[{...identity,formal_profile_app:appAudit,formal_profile_admin:adminAudit,user_message_direct_write:false,capability,capability_owner:owner}]});
   }));
  }
  return {...f,ids:IDS,env,tokens,png,objects,assetReads,forbidden,resources,tables,sequences,snapshot,control,withApplication,close,
   setup:{before,after:await snapshot(),seconds:now,message_ids:messageIds,staff_uids:staff,expected_message_page_sizes:[20,3],expected_conversation_page_sizes:[20,3],initial_unread_a:21,initial_unread_b:2,initial_unread_c:1,empty_requires_hidden_broadcast:true,image_key:messageImageKey}};
 }catch(error){await close();throw error;}
}
