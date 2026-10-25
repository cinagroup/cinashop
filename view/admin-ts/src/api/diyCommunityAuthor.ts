import { presentationPreviewUrl } from '@/utils/diyPresentationEditor';
export interface CommunityAuthorPost { id:number;contentType:1|2;title:string;image:string;sliderImage:string[];author:string;author_image:string;likeNum:number }
export interface CommunityPreview { closed:boolean;rows:CommunityAuthorPost[] }
const record=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const integer=(value:unknown,min=0):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=2147483647;
/** Validate the complete public receipt before adopting any row. Never fetch a detail/counter endpoint. */
export function checkedCommunityAuthorRows(value:unknown,limit:number):CommunityAuthorPost[]{
 if(!Array.isArray(value)||value.length>limit)throw Error('公开社区内容格式错误');
 const seen=new Set<number>();return value.map(raw=>{
  const row=record(raw);if(!row||!integer(row.id,1)||seen.has(row.id)||!integer(row.type)||!integer(row.relationId)||![1,2].includes(Number(row.contentType))||typeof row.contentType!=='number'||row.status!==1||row.is_verify!==1||![0,1].includes(Number(row.isLike))||typeof row.isLike!=='number'||[row.likeNum,row.commentNum,row.playNum,row.shareNum??row.share_num??0].some(n=>!integer(n))||[row.title,row.content,row.image].some(text=>typeof text!=='string')||row.author!==undefined&&typeof row.author!=='string'||row.author_image!==undefined&&typeof row.author_image!=='string'||row.sliderImage!==null&&(!Array.isArray(row.sliderImage)||row.sliderImage.some(image=>typeof image!=='string')))throw Error('社区预览包含不可公开内容');
  seen.add(row.id);return{id:row.id,contentType:row.contentType as 1|2,title:row.title as string,image:presentationPreviewUrl(row.image),sliderImage:Array.isArray(row.sliderImage)?row.sliderImage.map(presentationPreviewUrl):[],author:typeof row.author==='string'?row.author:'社区内容',author_image:presentationPreviewUrl(row.author_image),likeNum:row.likeNum as number};
 });
}
async function publicRead(path:string,params:Record<string,string|number>,signal:AbortSignal):Promise<unknown>{
 const query=new URLSearchParams(Object.entries(params).map(([key,value])=>[key,String(value)]));
 const response=await fetch(path+(query.size?'?'+query:''),{method:'GET',credentials:'omit',cache:'no-store',headers:{Accept:'application/json'},signal});
 const body=record(await response.json());if(!response.ok||body?.status!==200)throw Error(typeof body?.msg==='string'?body.msg:'公开社区读取失败');return body.data;
}
export async function readCommunityPreview(limit:number,signal:AbortSignal):Promise<CommunityPreview>{
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('社区预览数量无效');
 const config=record(await publicRead('/api/community/config',{},signal));
 if(!config||[config.community_status,config.community_comment_status,config.community_comment_add].some(flag=>flag!==0&&flag!==1))throw Error('社区开关格式错误');
 if(signal.aborted)throw Error('社区预览已替换');if(config.community_status===0)return{closed:true,rows:[]};
 return{closed:false,rows:checkedCommunityAuthorRows(await publicRead('/api/community/list',{page:1,limit,is_follow:0},signal),limit)};
}

/** Only actual same-site signed media slots carry a platform expiry. Text is never a capability. */
export function communityPreviewDeadline(preview:CommunityPreview):number{
 let deadline=Infinity;
 for(const row of preview.rows)for(const image of [row.image,row.author_image,...row.sliderImage]){
  const query=/^\/api\/assets\/[1-9]\d*\?([^#]*)$/u.exec(image);if(!query)continue;
  const expires=new URLSearchParams(query[1]).get('expires');if(expires&&/^[1-9]\d{0,10}$/u.test(expires))deadline=Math.min(deadline,Number(expires)*1000);
 }
 return deadline;
}
