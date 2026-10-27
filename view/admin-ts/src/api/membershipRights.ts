import request, { getData } from '@/utils/request';
export interface MembershipRightAuthorRow {
  id:number;right_type:string;title:string;show_title:string;image:string;explain:string;content:string;
  number:number;sort:number;status:number;add_time:number;version:string;image_preview:string;content_preview:string;
}
export interface MembershipRightAuthorPage {author:1;actor_id:number;page:number;limit:number;count:number;list:MembershipRightAuthorRow[]}
export interface MembershipRightMetadata {right_type:string;title:string;show_title:string;image:string;explain:string;number:number;sort:number}
export type MembershipRightDraft=MembershipRightMetadata&{id:number;status:0|1};
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('会员权益响应无效');return v as Record<string,unknown>;};
const integer=(v:unknown,min=-2147483648,max=2147483647):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
export function decodeMembershipRightPage(value:unknown,page:number,owner:number,limit=30):MembershipRightAuthorPage {
  const data=object(value);
  if(data.author!==1||data.actor_id!==owner||!integer(owner,1)||data.page!==page||data.limit!==limit||!integer(data.count,0,Number.MAX_SAFE_INTEGER)
    ||!Array.isArray(data.list)||data.list.length!==Math.max(0,Math.min(limit,data.count-(page-1)*limit)))throw Error('会员权益目录与当前账户或分页不一致');
  let previewBytes=0;const ids=new Set<number>();let prior:MembershipRightAuthorRow|undefined;
  const list=data.list.map(value=>{
    const r=object(value);
    if(!integer(r.id,1)||ids.has(r.id)||!hash(r.version)||!['right_type','title','show_title','image','explain','content','image_preview','content_preview'].every(k=>typeof r[k]==='string')
      ||!['number','sort','status','add_time'].every(k=>integer(r[k])))throw Error('会员权益数据不完整，请重新读取');
    previewBytes+=new TextEncoder().encode(r.content_preview as string).byteLength;
    if(new TextEncoder().encode(r.content as string).byteLength>4000000||previewBytes>10*1024*1024)throw Error('会员权益内容超过显示容量');
    const row={id:r.id,right_type:r.right_type,title:r.title,show_title:r.show_title,image:r.image,explain:r.explain,content:r.content,
      number:r.number,sort:r.sort,status:r.status,add_time:r.add_time,version:r.version,image_preview:r.image_preview,content_preview:r.content_preview} as MembershipRightAuthorRow;
    if(prior&&(prior.sort<row.sort||prior.sort===row.sort&&prior.id<=row.id))throw Error('会员权益排序错误');
    ids.add(row.id);prior=row;return row;
  });
  return{author:1,actor_id:owner,page,limit,count:data.count,list};
}
export function membershipRightMetadata(form:MembershipRightMetadata,base?:MembershipRightAuthorRow):MembershipRightMetadata {
  const text=(key:'right_type'|'title'|'show_title'|'image'|'explain',max:number,required=false)=>{
    const v=form[key];if(base&&v===base[key])return v;
    if(typeof v!=='string'||[...v].length>max||(key==='explain'?/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u:/[\u0000-\u001f\u007f]/u).test(v)||required&&!v.trim())throw Error('请核对权益名称、图标和说明');
    return v;
  };
  if(!integer(form.number)||!integer(form.sort)||(!base||form.number!==base.number||form.right_type!==base.right_type)&&form.number<0)throw Error('权益数值或排序无效');
  const number=form.number;
  if((!base||form.number!==base.number||form.right_type!==base.right_type)&&(['integral','sign','express'].includes(form.right_type)?number<1||number>10000:form.right_type==='offline'&& (number<1||number>100)))throw Error('权益数值超出允许范围');
  return{right_type:text('right_type',100,true),title:text('title',200,true),show_title:text('show_title',8,true),image:text('image',200),explain:text('explain',8,true),number,sort:form.sort};
}
function version(value:unknown,id:number):{id:number;version:string} {
  const r=object(value);if(!integer(r.id,1)||id>0&&r.id!==id||!hash(r.version))throw Error('权益保存回执无效，请重新读取核对');
  return{id:r.id,version:r.version};
}
function bounded(payload:Record<string,unknown>){if(new TextEncoder().encode(JSON.stringify(payload)).byteLength>256*1024)throw Error('权益内容超过256 KiB请求容量');return payload;}
export async function apiMembershipRightAuthorPage(page:number,owner:number,signal?:AbortSignal){
  return decodeMembershipRightPage(await getData<unknown>(request.get('/member/right',{params:{author:1,page,limit:30},signal})),page,owner);
}
export async function apiSaveMembershipRightMetadata(id:number,token:string,data:MembershipRightMetadata,status:0|1,signal?:AbortSignal){
  return version(await getData<unknown>(request.post(`/member_right/save/${id}`,bounded({author:1,version:token,...data,...(id?{}:{status})}),{signal})),id);
}
export async function apiSetMembershipRightStatus(id:number,token:string,status:0|1,signal?:AbortSignal){
  return version(await getData<unknown>(request.post(`/member_right/save/${id}`,{author:1,version:token,status},{signal})),id);
}
export async function apiSaveMembershipRightContent(id:number,token:string,content:string,signal?:AbortSignal){
  return version(await getData<unknown>(request.post(`/member/save/content/${id}`,bounded({author:1,version:token,content}),{signal})),id);
}
