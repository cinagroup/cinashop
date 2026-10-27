import {createUserCenterRequests} from '@/api/userCenter';
export interface MemberClause {id:number;type:1;title:string;content_preview:string}
const invalid=():never=>{throw Error('会员协议响应不完整，请重新读取');};
export function decodeMemberClause(value:unknown,owner:number):MemberClause|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
 const data=value as Record<string,unknown>;
 if(Object.keys(data).sort().join(',')!=='member_explain,owner_uid'||data.owner_uid!==owner||!Number.isSafeInteger(owner)||owner<1)return invalid();
 if(data.member_explain==='')return null;
 const value_=data.member_explain;if(!value_||typeof value_!=='object'||Array.isArray(value_))return invalid();const row=value_ as Record<string,unknown>;
 if(Object.keys(row).sort().join(',')!=='content_preview,id,title,type'||!Number.isSafeInteger(row.id)||Number(row.id)<1||Number(row.id)>2147483647||row.type!==1||typeof row.title!=='string'||[...row.title].length>200||typeof row.content_preview!=='string'||new TextEncoder().encode(row.content_preview).byteLength>4_000_000)return invalid();
 return{id:Number(row.id),type:1,title:row.title,content_preview:row.content_preview};
}
export function createMemberClauseRequests(current:()=>boolean){const scope=createUserCenterRequests(current);return{...scope,read:async()=>decodeMemberClause(await scope.request('user/member/card/index','GET',{clause:1},true),scope.owner.uid)};}
export type MemberClauseRequests=ReturnType<typeof createMemberClauseRequests>;
