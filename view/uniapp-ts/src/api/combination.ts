import { http } from '@/utils/request';
import { parseCombinationList, parseCombinationSelection } from '../../../common/combinationPurchase';
import { parseActivityDetailProjection } from './productDetailDesign';

export async function apiCombinationSelection(id: number, pinkId = 0) {
  const raw=await http.get<unknown>(`/combination/detail/${id}`, {
    view: 'skus', ...(pinkId ? { pink_id: pinkId } : {}),
  }),selection=parseCombinationSelection(raw,id,pinkId);
  return {...selection,detailDisplay:parseActivityDetailProjection(raw,selection.product_id)};
}
export type CombinationDisplaySelection=Awaited<ReturnType<typeof apiCombinationSelection>>;
export async function apiCombinationCatalogPage(page = 1) {
  return parseCombinationList(await http.get<unknown>('/combination/list', { page, limit: 20 }));
}
