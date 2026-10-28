/** Explicit conversation links must never fall through to random assignment. */
export function kefuConversationTarget(value:unknown):number {
 if(value===undefined)return 0;
 if(typeof value!=='string'||! /^[1-9]\d{0,9}$/.test(value)||Number(value)>2147483647)throw Error('客服会话链接无效，请从消息中心重新进入');
 return Number(value);
}
export interface KefuHistoryMessage {id:number;uid:number;to_uid:number;msn:string;add_time:number;msn_type:number}
export interface KefuHistory {serviceList:KefuHistoryMessage[];uid:number;nickname:string;avatar:string;online:0|1}
export function decodeKefuConversation(value:unknown,owner:number,requested:number):KefuHistory {
 const invalid=():never=>{throw Error('客服会话数据不完整，请重新读取');};
 const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:invalid();
 const int=(v:unknown,min=0,max=2147483647)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max?v:invalid();
 const text=(v:unknown,max=65536)=>typeof v==='string'&&v.length<=max?v:invalid();
 const v=object(value),uid=int(v.uid,1);if(requested&&uid!==requested||!Array.isArray(v.serviceList)||v.serviceList.length>50)invalid();
 const list=(v.serviceList as unknown[]).map(value=>{const r=object(value),from=int(r.uid,1),to=int(r.to_uid,1);if(!(from===owner&&to===uid||from===uid&&to===owner))invalid();return{id:int(r.id,1),uid:from,to_uid:to,msn:text(r.msn),add_time:int(r.add_time??r.addTime),msn_type:int(r.msn_type??r.msnType??1,1,7)};});
 if(new Set(list.map(r=>r.id)).size!==list.length||list.some((r,i)=>i>0&&r.id<=list[i-1]!.id))invalid();
 return{uid,nickname:text(v.nickname,255),avatar:text(v.avatar,8192),online:int(v.online,0,1) as 0|1,serviceList:list};
}
