import { http } from '@/utils/request';
import { parseCombinationList, parseCombinationSelection } from '../../../common/combinationPurchase';

export async function apiCombinationSelection(id: number, pinkId = 0) {
  return parseCombinationSelection(await http.get<unknown>(`/combination/detail/${id}`, {
    view: 'skus', ...(pinkId ? { pink_id: pinkId } : {}),
  }), id, pinkId);
}
export async function apiCombinationCatalogPage(page = 1) {
  return parseCombinationList(await http.get<unknown>('/combination/list', { page, limit: 20 }));
}
