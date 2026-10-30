import { checkedDiyStateData, emptyDiyStateData, type DiyStateData, type DiyStateKind } from '@/utils/diyStateProjection';

/** Author previews use public guest data only. Member identity/level are read
 * by the real logged-in H5 account, never borrowed from the Admin session. */
export async function apiDiyStatePreview(kind:DiyStateKind,signal:AbortSignal):Promise<DiyStateData> {
  if(kind==='userInfor')return emptyDiyStateData();
  const path=kind==='newVip'?'/api/diy/newcomer_list?page=1&limit=10':kind==='ranking'?'/api/diy/product_rank?limit=3':kind==='signIn'?'/api/diy/sign':null;
  if(!path)throw Error('会员权益预览类型无效');
  const response=await fetch(path,{method:'GET',credentials:'omit',cache:'no-store',headers:{Accept:'application/json'},signal});
  const body:unknown=await response.json();
  if(!response.ok||!body||typeof body!=='object'||Array.isArray(body)||!('status'in body)||body.status!==200)throw Error('当前公开内容读取失败，请重试');
  return checkedDiyStateData(kind,'data'in body?body.data:undefined,0);
}
