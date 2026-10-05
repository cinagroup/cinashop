import { http } from '@/utils/request';
import { parseProductMarketingData,parseProductCommunityData,productShareCode } from '../utils/productDetailDesign';
export * from '../utils/productDetailDesign';
export type {DetailDesignData,DetailCard,DetailCommunity,ActivityDetailProjection} from '../types/productDetailDesign';

export async function apiProductMarketing(id:number){return parseProductMarketingData(await http.get<unknown>(`/product/detail/activity/${id}`));}
export async function apiProductCommunity(id:number,page=1,limit=10){return parseProductCommunityData(await http.get<unknown>(`/product/${id}/community`,{page,limit}),limit);}
export async function apiProductShareCode(id:number,kind:'wechat'|'routine'):Promise<string>{
  if(!Number.isSafeInteger(id)||id<1||id>2147483647)throw Error('商品分享码目标无效');
  const value=await http.get<unknown>(`/product/code/${id}`,{user_type:kind});
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('商品分享码格式错误');
  return productShareCode((value as Record<string,unknown>).code,kind);
}
