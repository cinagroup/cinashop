import {createUserCenterRequests} from '@/api/userCenter';
import {memberLevelImage} from '@/api/memberLevels';
import {memberRightImage,memberRightMediaDeadline} from '../../../common/memberRightMedia';

export const MESSAGE_PAGE_SIZE=20,MAX_MESSAGE_PAGE=1000;
export interface MessageQuery {page:number;limit:20}
export interface SystemMessageRow {id:number;title:string;content:string;add_time:number}
export interface SystemMessageSummary extends SystemMessageRow {message_num:number}
export interface MessageConversation {id:number;to_uid:number;nickname:string;avatar_source:string;avatar:string;update_time:number;message_type:number;message:string;mssage_num:number;online:0|1}
export interface MessageCenter {owner_uid:number;query:MessageQuery;system:SystemMessageSummary|null;service:MessageConversation[];service_count:number;page_count:number}
export interface SystemMessages {owner_uid:number;query:MessageQuery;list:SystemMessageRow[];count:number;page_count:number;service_num:number}
export interface SystemMessageDetail {owner_uid:number;id:number;message:SystemMessageRow|null;service_num:number}
const invalid=():never=>{throw Error('消息数据不完整，请重新读取');};
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:invalid();
function keys(v:Record<string,unknown>,expected:string[]){if(Object.keys(v).sort().join(',')!==expected.sort().join(','))invalid();}
const integer=(v:unknown,min=0,max=2147483647):number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max?v:invalid();
const text=(v:unknown,max=65536):string=>typeof v==='string'&&v.length<=max?v:invalid();
function owner(v:Record<string,unknown>,uid:number){if(v.owner_uid!==uid)invalid();}
function query(v:unknown,expected:MessageQuery){const q=object(v);keys(q,['page','limit']);if(q.page!==expected.page||q.limit!==expected.limit)invalid();}
function row(v:unknown):SystemMessageRow {const r=object(v);keys(r,['id','title','content','add_time']);return{id:integer(r.id,1),title:text(r.title,256),content:text(r.content),add_time:integer(r.add_time)};}
export function messageBefore(a:SystemMessageRow,b:SystemMessageRow){return a.add_time>b.add_time||a.add_time===b.add_time&&a.id>b.id;}
export function conversationBefore(a:MessageConversation,b:MessageConversation){return a.update_time>b.update_time||a.update_time===b.update_time&&a.id>b.id;}
function pageRows(list:unknown,query:MessageQuery,count:number,pages:unknown){if(!Array.isArray(list)||integer(pages)!==Math.ceil(count/query.limit)||list.length!==Math.min(query.limit,Math.max(0,count-(query.page-1)*query.limit)))invalid();return list as unknown[];}
export function decodeMessageCenter(value:unknown,uid:number,q:MessageQuery):MessageCenter {
 const v=object(value);keys(v,['owner_uid','query','system','service','service_count','page_count']);owner(v,uid);query(v.query,q);
 let system:SystemMessageSummary|null=null;
 if(v.system!==null){const s=object(v.system);keys(s,['id','title','content','add_time','message_num']);const {message_num,...item}=s;system={...row(item),message_num:integer(message_num)};}
 const service_count=integer(v.service_count),service=pageRows(v.service,q,service_count,v.page_count).map(value=>{const r=object(value);keys(r,['id','to_uid','nickname','avatar_source','avatar','update_time','message_type','message','mssage_num','online']);const source=text(r.avatar_source,4096),preview=text(r.avatar,8192),safe=memberRightImage(source,preview)&&memberLevelImage(preview);return{id:integer(r.id,1),to_uid:integer(r.to_uid,1),nickname:text(r.nickname,256),avatar_source:safe?source:'',avatar:safe?preview:'',update_time:integer(r.update_time),message_type:integer(r.message_type,1,7),message:text(r.message),mssage_num:integer(r.mssage_num),online:integer(r.online,0,1) as 0|1};});
 if(new Set(service.map(r=>r.id)).size!==service.length||service.some((r,i)=>i>0&&!conversationBefore(service[i-1]!,r)))invalid();
 return{owner_uid:uid,query:{...q},system,service,service_count,page_count:integer(v.page_count)};
}
export function decodeSystemMessages(value:unknown,uid:number,q:MessageQuery):SystemMessages {
 const v=object(value);keys(v,['owner_uid','query','list','count','page_count','service_num']);owner(v,uid);query(v.query,q);const count=integer(v.count),list=pageRows(v.list,q,count,v.page_count).map(row);
 if(new Set(list.map(r=>r.id)).size!==list.length||list.some((r,i)=>i>0&&!messageBefore(list[i-1]!,r)))invalid();
 return{owner_uid:uid,query:{...q},list,count,page_count:integer(v.page_count),service_num:integer(v.service_num)};
}
export function decodeSystemMessageDetail(value:unknown,uid:number,id:number):SystemMessageDetail {
 const v=object(value);keys(v,['owner_uid','id','message','service_num']);owner(v,uid);if(v.id!==id)invalid();const message=v.message===null?null:row(v.message);if(message&&message.id!==id)invalid();return{owner_uid:uid,id,message,service_num:integer(v.service_num)};
}
export function createUserMessageRequests(current:()=>boolean){const s=createUserCenterRequests(current);return{...s,center:async(q:MessageQuery)=>decodeMessageCenter(await s.request('user/message?view=message_center','GET',{...q},true),s.owner.uid,q),messages:async(q:MessageQuery)=>decodeSystemMessages(await s.request('user/message_system/list?view=system_messages','GET',{...q},true),s.owner.uid,q),detail:async(id:number)=>decodeSystemMessageDetail(await s.request('user/message_system/detail/'+id+'?view=system_message_detail','GET',{},true),s.owner.uid,id)};}
export type UserMessageRequests=ReturnType<typeof createUserMessageRequests>;
export function conversationImage(row:MessageConversation){return memberLevelImage(memberRightImage(row.avatar_source,row.avatar));}
export function conversationMediaDeadline(rows:MessageConversation[]){return memberRightMediaDeadline(rows.map(row=>row.avatar),[]);}
export function messageTime(seconds:number):string {return new Date((seconds+28800)*1000).toISOString().slice(0,16).replace('T',' ');}
export function conversationPreview(row:MessageConversation):string {return row.message_type===1||row.message_type===2?row.message:({3:'[图片]',4:'[语音]',5:'[商品]',6:'[订单]',7:'[退款]'} as Record<number,string>)[row.message_type]||'[消息]';}

/** Literal PHP time_tran units/floor; system messages use relative display. */
export function systemMessageTime(seconds:number,now=Math.floor(Date.now()/1000)):string {for(const [duration,unit]of [[31536000,'年'],[2592000,'个月'],[604800,'星期'],[86400,'天'],[3600,'小时'],[60,'分钟'],[1,'秒']]as const){const amount=Math.floor((now-seconds)/duration);if(amount!==0)return amount+unit+'前';}return '';}
