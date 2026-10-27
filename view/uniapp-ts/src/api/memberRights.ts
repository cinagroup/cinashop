import {createUserCenterRequests} from '@/api/userCenter';
export interface MemberRightDetail {id:number;right_type:string;title:string;pic:string;explain:string;content_preview:string;number:number}
export function decodeMemberRightDetails(value:unknown,owner:number):MemberRightDetail[] {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('会员权益响应无效');
  const data=value as Record<string,unknown>;
  if(data.rights_owner_uid!==owner||!Number.isSafeInteger(owner)||owner<1||!Array.isArray(data.member_rights))throw Error('会员权益与当前账户不一致');
  let previewBytes=0;const ids=new Set<number>();
  return data.member_rights.map(value=>{
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('会员权益数据不完整');
    const row=value as Record<string,unknown>;
    if(!Number.isSafeInteger(row.id)||Number(row.id)<1||ids.has(Number(row.id))||!['right_type','title','pic','explain','content_preview'].every(k=>typeof row[k]==='string')||!Number.isSafeInteger(row.number)
      )throw Error('会员权益数据不完整');
    previewBytes+=new TextEncoder().encode(row.content_preview as string).byteLength;if(previewBytes>10*1024*1024)throw Error('会员权益内容超过显示容量');
    ids.add(Number(row.id));return{id:Number(row.id),right_type:row.right_type as string,title:row.title as string,pic:row.pic as string,explain:row.explain as string,content_preview:row.content_preview as string,number:Number(row.number)};
  });
}
export function createMemberRightRequests(current:()=>boolean){
  const scope=createUserCenterRequests(current);
  return{...scope,info:async()=>decodeMemberRightDetails(await scope.request('user/member/card/index','GET',{rights:1},true),scope.owner.uid)};
}
export type MemberRightRequests=ReturnType<typeof createMemberRightRequests>;
