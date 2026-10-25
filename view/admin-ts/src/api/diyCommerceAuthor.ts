import { checkedCommerceCards,checkedCommerceCoupons,checkedCommercePink,checkedCommerceRooms,checkedCommerceSlots } from '@/utils/diyCommerceData';
import type { DiyCommerceConfig } from '@/utils/diyCommerceProjection';
import { apiDiyListProductPreview } from './diyListAuthor';
/** Only anonymous public reads. Admin credentials, mutations, detail counters and provider calls are never used. */
export async function commercePublicRead(path:string,params:Record<string,string|number>,signal:AbortSignal):Promise<unknown>{
 const query=new URLSearchParams(Object.entries(params).map(([key,value])=>[key,String(value)]));
 const response=await fetch(path+'?'+query,{method:'GET',credentials:'omit',cache:'no-store',headers:{Accept:'application/json'},signal});
 if(!response.ok)throw Error('公开商城内容读取失败');const body=await response.json() as {status?:unknown;data?:unknown};if(!body||body.status!==200)throw Error('公开商城内容读取失败');return body.data;
}
export async function readCommercePreview(config:DiyCommerceConfig,tab:number,slot:number,signal:AbortSignal){
 const query={page:1,limit:config.limit},empty={cards:[] as ReturnType<typeof checkedCommerceCards>,coupons:[] as ReturnType<typeof checkedCommerceCoupons>,rooms:[] as ReturnType<typeof checkedCommerceRooms>,products:[] as Awaited<ReturnType<typeof apiDiyListProductPreview>>,slots:[] as ReturnType<typeof checkedCommerceSlots>['slots'],selectedSlot:0,pink:null as ReturnType<typeof checkedCommercePink>|null};
 if(config.kind==='promotionList'){const scope=config.tabs[tab]?.query;return{...empty,products:scope?await apiDiyListProductPreview(scope,signal):[]};}
 if(config.limit<1&&!['seckill','combination'].includes(config.kind??''))return empty;
 if(config.kind==='coupon')return{...empty,coupons:checkedCommerceCoupons(await commercePublicRead('/api/v2/coupons',query,signal),config.limit,0)};
 if(config.kind==='liveBroadcast')return{...empty,rooms:checkedCommerceRooms(await commercePublicRead('/api/wechat/live',query,signal),config.limit)};
 if(config.kind==='seckill'){
  const index=checkedCommerceSlots(await commercePublicRead('/api/seckill/index',{},signal)),slots=index.slots,selected=slot?slots.find(row=>row.id===slot&&row.start_time&&row.end_time):index.index<0?undefined:slots[index.index];
  return{...empty,slots,selectedSlot:selected?.id??0,cards:selected&&config.limit>0?checkedCommerceCards('seckill',await commercePublicRead(`/api/seckill/list/${selected.id}`,{...query,type:'index'},signal),config.limit):[]};
 }
 const kind=config.kind,path=kind==='combination'?'/api/combination/list':kind==='bargain'?'/api/bargain/list':kind==='pointsMall'?'/api/store_integral/list':kind==='presale'?'/api/presale/list':null;
 if(!kind||!path)throw Error('商城组件类型无效');
 const cards=config.limit>0?checkedCommerceCards(kind,await commercePublicRead(path,kind==='presale'?{...query,time_type:0}:query,signal),config.limit):[];
 return{...empty,cards,pink:kind==='combination'?checkedCommercePink(await commercePublicRead('/api/pink',{},signal)):null};
}
export type CommercePreview=Awaited<ReturnType<typeof readCommercePreview>>;
