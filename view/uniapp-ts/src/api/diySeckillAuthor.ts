import { http } from '@/utils/request';
import { safeDiyImageUrl } from '@/utils/diy';
import { checkedDiySeckillLimit, checkedDiySeckillRows, checkedDiySeckillSchedule } from '../../../common/diySeckillData';
export const apiDiySeckillIndex=async()=>checkedDiySeckillSchedule(await http.get<unknown>('/seckill/index',{}, {noAuth:true}));
export async function apiDiySeckillProducts(slot:number,limit:number){
 checkedDiySeckillLimit(limit);if(!Number.isSafeInteger(slot)||slot<1||slot>2147483647)throw Error('秒杀时段无效');
 return checkedDiySeckillRows(await http.get<unknown>(`/seckill/list/${slot}`,{page:1,limit,type:'index'}, {noAuth:true}),limit,safeDiyImageUrl);
}
