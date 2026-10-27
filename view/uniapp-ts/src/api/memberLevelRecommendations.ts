import {createUserCenterRequests} from '@/api/userCenter';
import {memberLevelColor,memberLevelImage} from '@/api/memberLevels';
import {rankNavigation} from '@/api/productRank';
import {classifyProductMediaReference} from '../../../common/productMediaReference';
import {memberRightImage,memberRightMediaDeadline} from '../../../common/memberRightMedia';

export const MEMBER_LEVEL_RECOMMENDATION_SIZE=10;
export interface LevelRecommendationMedia {source:string;preview:string}
export interface LevelRecommendationLabel {id:number;name:string;color:string;background:string;border:string;media:LevelRecommendationMedia}
export interface LevelRecommendation {
 id:number;title:string;brand:string;price:string;vipPrice:string;vipOffer:boolean;levelOffer:boolean;
 media:LevelRecommendationMedia;frame:LevelRecommendationMedia;labels:LevelRecommendationLabel[];
 destination:string|null;navigationHint:string;navigationExpiresAt:number|null;
}
export interface LevelRecommendationPage {owner:number;page:number;list:LevelRecommendation[]}
const invalid=():never=>{throw Error('商品推荐数据不完整，请刷新后重试');};
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:invalid();
const text=(v:unknown,max=8192):string=>typeof v==='string'&&[...v].length<=max?v:invalid();
const integer=(v:unknown,min=1,max=2147483647):number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max?v:invalid();
const money=(v:unknown):string=>typeof v==='string'&&/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/u.test(v)?v:invalid();
const emptyMedia=():LevelRecommendationMedia=>({source:'',preview:''});
function media(source:unknown,preview:unknown):LevelRecommendationMedia {
 const stable=text(source,4096),resolved=text(preview);
 if(!stable&&!resolved)return emptyMedia();
 const reference=classifyProductMediaReference(stable),ticket=classifyProductMediaReference(resolved);
 if(reference.kind==='invalid'||ticket.kind==='invalid')return emptyMedia();
 if(reference.kind==='asset'?(stable!==reference.reference||ticket.kind!=='asset'||ticket.id!==reference.id):stable!==resolved)return emptyMedia();
 // The persisted reference and its authorized preview remain separate. An
 // expired or malformed signed preview is never downgraded to a public URL.
 if(!memberRightImage(stable,resolved))return emptyMedia();
 return{source:stable,preview:resolved};
}
export function levelRecommendationImage(value:LevelRecommendationMedia,now=Date.now()):string {
 return memberLevelImage(memberRightImage(value.source,value.preview,now));
}
export function levelRecommendationMediaDeadline(rows:LevelRecommendation[]):number|null {
 return memberRightMediaDeadline(rows.flatMap(row=>[row.media.preview,row.frame.preview,...row.labels.map(label=>label.media.preview)]),[]);
}
export function decodeLevelRecommendations(value:unknown,owner:number,page:number):LevelRecommendationPage {
 const envelope=object(value);
 if(Object.keys(envelope).sort().join(',')!=='limit,list,owner_uid,page'||envelope.owner_uid!==owner||envelope.page!==page||envelope.limit!==10||!Array.isArray(envelope.list)||envelope.list.length>10)return invalid();
 const list=envelope.list.map(value=>{
  const row=object(value),id=integer(row.id),title=text(row.store_name,512),price=money(row.price),vipPrice=money(row.vip_price);
  if(!title.trim()||(row.is_vip!==0&&row.is_vip!==1)||(typeof row.price_type!=='string'||!['','level','member'].includes(row.price_type))||!Array.isArray(row.store_label)||row.store_label.length>256)return invalid();
  const labels=row.store_label.map(value=>{const label=object(value),icon=text(label.icon),classification=classifyProductMediaReference(icon);
   return{id:integer(label.id),name:text(label.label_name,64),color:memberLevelColor(text(label.color,32)),background:memberLevelColor(text(label.bg_color,32)),border:memberLevelColor(text(label.border_color,32)),
    media:classification.kind==='invalid'?emptyMedia():media(classification.reference,icon)};
  });
  if(new Set(labels.map(label=>label.id)).size!==labels.length)return invalid();
  let frame=emptyMedia();
  if(Array.isArray(row.activity_frame)){if(row.activity_frame.length)return invalid();}
  else{const v=object(row.activity_frame);integer(v.id);text(v.name,255);frame=media(v.image_source,v.image);}
  return{id,title,brand:text(row.brand_name,255),price,vipPrice,vipOffer:row.price_type==='member'&&row.is_vip===1&&Number(vipPrice)>0,levelOffer:row.price_type==='level'&&Number(vipPrice)>0,
   media:media(row.image_source,row.image),frame,labels,...rankNavigation(row,id)};
 });
 if(new Set(list.map(row=>row.id)).size!==list.length)return invalid();
 return{owner:integer(envelope.owner_uid),page:integer(envelope.page,1,10000),list};
}
export function createLevelRecommendationRequests(current:()=>boolean){const scope=createUserCenterRequests(current);return{...scope,
 page:async(page:number)=>{integer(page,1,10000);return decodeLevelRecommendations(await scope.request('product/hot','GET',{view:'member_level',page,limit:10},true),scope.owner.uid,page);},
};}
export type LevelRecommendationRequests=ReturnType<typeof createLevelRecommendationRequests>;
