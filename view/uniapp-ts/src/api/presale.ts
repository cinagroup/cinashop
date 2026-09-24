import { http } from '@/utils/request';
import { parsePresaleSelection } from '../../../common/presalePurchase';
import { parsePresaleCatalog, presaleCatalogQuery, type PresaleTimeType } from '../../../common/presaleCatalog';

export async function apiPresaleCatalog(type: PresaleTimeType, page: number) {
  return parsePresaleCatalog(await http.get<unknown>('/presale/list', presaleCatalogQuery(type, page)), type, page);
}

export async function apiPresaleSelection(id: number) {
  return parsePresaleSelection(await http.get<unknown>(`/product/detail/${id}`, { view: 'presale' }), id);
}
