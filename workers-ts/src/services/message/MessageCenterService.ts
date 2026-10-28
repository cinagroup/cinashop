import { and, count, desc, eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { systemMessage, user, storeServiceRecord } from '@/models/schema';
import { AuthException, HttpApiException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { themeDeadlines } from '@/services/content/ThemeReadService';
import { KefuRealtimeService } from '@/services/kefu/KefuRealtimeService';
import { resolvePublicUserAvatars } from '@/services/user/UserAvatarPolicy';
import { renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { visibleSystemMessageWhere, userUnreadMessageCount } from './UserMessageVisibility';
import { MESSAGE_READ_LOCK_NAMESPACE, inspectUserMessageReadCapability, consumeUserMessages } from '@/migrations/userMessageReadCapability';
import { assertMessageBytes, messageInteger, messageText, phpMessageTime, type MessageActor, type MessageQuery } from './MessageCenterInput';

export interface MessageRow {id:number;title:string;content:string;add_time:number}
function row(value:Pick<typeof systemMessage.$inferSelect,'id'|'title'|'content'|'addTime'>):MessageRow {
 return {id:messageInteger(value.id,'消息ID',1),title:messageText(value.title,'消息标题',256),content:messageText(value.content,'消息正文',65536),add_time:messageInteger(value.addTime,'消息时间')};
}
function number(value:unknown,name:string){const n=typeof value==='string'&&/^(?:0|[1-9]\d*)$/u.test(value)?Number(value):value;return messageInteger(n,name,0,Number.MAX_SAFE_INTEGER);}
function pageCount(total:number,limit:number){return Math.ceil(total/limit);}

/** The shared App SQL role is trusted application authority, not per-JWT RLS.
 * Only the authenticated controller creates MessageActor; query/body UID is never accepted.
 * Every consuming transaction rechecks and locks that exact persisted credential version. */
export class MessageCenterService {
 constructor(private readonly container:Container,private readonly env:Env){}
 private async account(tx:DbClient,actor:MessageActor,consume:boolean){
  const rows=await tx.execute<{uid:number;pwd:string}>(sql`SELECT uid,pwd FROM public.user WHERE uid=${actor.uid}
   AND status=1 AND is_del=0 AND delete_time IS NULL ${consume?sql`FOR SHARE`:sql``}`);
  if(rows.length!==1||rows[0].uid!==actor.uid||rows[0].pwd!==actor.pwd)throw new AuthException('请重新登录');
 }
 private async unread(tx:DbClient,uid:number){const[r]=await tx.select({total:userUnreadMessageCount(uid)}).from(user).where(eq(user.uid,uid));return number(r?.total,'未读消息数');}
 private async consume(tx:DbClient,actor:MessageActor,ids:number[]){
  const state=await inspectUserMessageReadCapability(tx);
  if(!state.ready)throw new HttpApiException('消息阅读能力未安装或需要审阅',503,503);
  await tx.execute(sql`SELECT set_config('cinashop.message_uid',${String(actor.uid)},true),set_config('cinashop.message_auth',${md5(actor.pwd)},true)`);
  const result=await consumeUserMessages(tx,actor.uid,ids);
  if(JSON.stringify(result.read_ids)!==JSON.stringify([...ids].sort((a,b)=>a-b)))throw Error('Message read capability returned unbound IDs');
 }
 private async transaction<T>(actor:MessageActor,consume:boolean,run:(tx:DbClient)=>Promise<T>){
  messageInteger(actor.uid,'消息用户',1);
  return withTx(this.container,async tx=>{
   await tx.execute(consume?sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE`:sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
   await themeDeadlines(tx);
   await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true)`);
   if(consume)await tx.execute(sql`SELECT pg_advisory_xact_lock(${MESSAGE_READ_LOCK_NAMESPACE},${actor.uid})`);
   await this.account(tx,actor,consume);return run(tx);
  });
 }
 async center(actor:MessageActor,q:MessageQuery,now=Math.floor(Date.now()/1000)){
  const result=await this.transaction(actor,false,async tx=>{
   const [latest]=await tx.select().from(systemMessage).where(visibleSystemMessageWhere(actor.uid)).orderBy(desc(systemMessage.addTime),desc(systemMessage.id)).limit(1);
   const unread=await this.unread(tx,actor.uid);
   const [total]=await tx.select({value:count()}).from(storeServiceRecord).where(and(eq(storeServiceRecord.userId,actor.uid),eq(storeServiceRecord.isTourist,0)));
   const serviceCount=number(total?.value,'客服会话数');
   const raw=await new KefuRealtimeService(createContainerFromDb(tx),this.env).userConversationList(actor.uid,{page:String(q.page),limit:String(q.limit)});
   const refs=await resolvePublicUserAvatars(tx,raw.map(r=>({uid:r.to_uid,image:r.avatar})));
   const previews=await renderProductPictures(this.env.APP_KEY,refs);
   const services=raw.map((r,i)=>({id:messageInteger(r.id,'会话ID',1),to_uid:messageInteger(r.to_uid,'客服ID',1),nickname:messageText(r.nickname,'客服昵称',256),
    avatar_source:refs[i]!,avatar:previews[i]!,update_time:messageInteger(r.update_time,'会话时间'),message_type:messageInteger(r.message_type,'消息类型',1,7),
    message:messageText(r.message,'会话摘要',65536),mssage_num:messageInteger(r.mssage_num,'客服未读数'),online:messageInteger(r.online,'客服在线状态',0,1)}));
   const system=latest?{...row(latest),message_num:unread}:null;
   return {system,services,raw,serviceCount};
  });
  const modern={owner_uid:actor.uid,query:{page:q.page,limit:q.limit},system:result.system,service:result.services,service_count:result.serviceCount,page_count:pageCount(result.serviceCount,q.limit)};
  const legacy={system:result.system?{...result.system,add_time:phpMessageTime(result.system.add_time,now)}:[],service:result.raw.map((r,i)=>({...r,avatar:result.services[i]!.avatar}))};
  const output=q.modern?modern:legacy;assertMessageBytes(output);return output;
 }
 async list(actor:MessageActor,q:MessageQuery,now=Math.floor(Date.now()/1000)){
  return this.transaction(actor,true,async tx=>{
   // All DTO fields and pre-consumption receipt evidence use ONE statement
   // snapshot. RC remains essential: after the UID lock a concurrent reader
   // must see its predecessor's committed receipts, without allocating again.
   // This statement is the observation point; the capability rechecks current
   // visibility before consuming, without requiring UPDATE on system_message.
   const [snapshot]=await tx.execute<{total:number;unread:number;rows:{id:number;title:string;content:string|null;add_time:number;look:number;seen:boolean}[]}>(sql`
    WITH visible AS MATERIALIZED (
     SELECT m.id,m.title,m.content,m.add_time,m.look,
      (m.look=1 OR EXISTS(SELECT 1 FROM public.user_message r WHERE r.uid=${actor.uid} AND r.message_id=m.id AND r.is_read=1)) AS seen
     FROM public.system_message m WHERE m.status=1 AND m.is_del=0 AND m.type IN(0,1) AND m.user_id IN(0,${actor.uid})
    ), page AS MATERIALIZED (
     SELECT * FROM visible ORDER BY add_time DESC,id DESC LIMIT ${q.limit} OFFSET ${(q.page-1)*q.limit}
    )
    SELECT (SELECT count(*)::integer FROM visible) AS total,
     (SELECT count(*)::integer FROM visible WHERE NOT seen) AS unread,
     COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.add_time DESC,p.id DESC) FROM page p),'[]'::jsonb) AS rows`);
   if(!snapshot||!Array.isArray(snapshot.rows))throw new HttpApiException('消息列表已变化，请重新读取',503,503);
   const countValue=number(snapshot.total,'站内信数量'),unread=number(snapshot.unread,'未读消息数');
   const rows=snapshot.rows;
   const list=rows.map(r=>row({id:r.id,title:r.title,content:r.content,addTime:r.add_time})),ids=rows.map(r=>r.id);
   const modern={owner_uid:actor.uid,query:{page:q.page,limit:q.limit},list,count:countValue,page_count:pageCount(countValue,q.limit),service_num:unread};
   const legacy=rows.length?{list:rows.map((r,i)=>({...list[i],look:r.seen?1:0,add_time:phpMessageTime(r.add_time,now)})),count:countValue,service_num:unread}:{list:[],count:0};
   const output=q.modern?modern:legacy;assertMessageBytes(output);await this.consume(tx,actor,ids);return output;
  });
 }
 async detail(actor:MessageActor,id:number,q:MessageQuery,now=Math.floor(Date.now()/1000)){
  messageInteger(id,'消息ID',1);
  return this.transaction(actor,true,async tx=>{
   const [found]=await tx.select().from(systemMessage).where(and(eq(systemMessage.id,id),visibleSystemMessageWhere(actor.uid))).limit(1);
   const message=found?row(found):null;assertMessageBytes(message);
   if(found)await this.consume(tx,actor,[id]);
   const unread=await this.unread(tx,actor.uid);
   const modern={owner_uid:actor.uid,id,message,service_num:unread};
   return q.modern?modern:message?{...message,add_time:phpMessageTime(message.add_time,now)}:null;
  });
 }
}
