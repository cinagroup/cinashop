import { http } from '@/utils/request';
import { parseSeckillIndex, parseSeckillList, parseSeckillSelection } from '../../../common/seckillPurchase';
import { parseActivityDetailProjection } from './productDetailDesign';

export async function apiSeckillSelection(id: number) {
  const raw=await http.get<unknown>(`/seckill/detail/${id}`, { view: 'skus' }),selection=parseSeckillSelection(raw,id);
  return {...selection,detailDisplay:parseActivityDetailProjection(raw,selection.product_id)};
}
export type SeckillDisplaySelection=Awaited<ReturnType<typeof apiSeckillSelection>>;
export async function apiSeckillCatalogIndex() {
  return parseSeckillIndex(await http.get<unknown>('/seckill/index'));
}
export async function apiSeckillCatalogPage(id: number, page: number) {
  return parseSeckillList(await http.get<unknown>(`/seckill/list/${id}`, { page, limit: 20 }));
}
