import { http } from '@/utils/request';
import { parseSeckillIndex, parseSeckillList, parseSeckillSelection } from '../../../common/seckillPurchase';

export async function apiSeckillSelection(id: number) {
  return parseSeckillSelection(await http.get<unknown>(`/seckill/detail/${id}`, { view: 'skus' }), id);
}
export async function apiSeckillCatalogIndex() {
  return parseSeckillIndex(await http.get<unknown>('/seckill/index'));
}
export async function apiSeckillCatalogPage(id: number, page: number) {
  return parseSeckillList(await http.get<unknown>(`/seckill/list/${id}`, { page, limit: 20 }));
}
