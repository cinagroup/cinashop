import { http } from '@/utils/request';
import { parsePresaleSelection } from '../../../common/presalePurchase';
import { parsePresaleCatalog, presaleCatalogQuery, type PresaleTimeType } from '../../../common/presaleCatalog';
import { parseActivityDetailProjection } from './productDetailDesign';

export async function apiPresaleCatalog(type: PresaleTimeType, page: number) {
  return parsePresaleCatalog(await http.get<unknown>('/presale/list', presaleCatalogQuery(type, page)), type, page);
}

export async function apiPresaleSelection(id: number) {
  const raw=await http.get<unknown>(`/product/detail/${id}`, { view: 'presale' }),selection=parsePresaleSelection(raw,id);
  return {...selection,detailDisplay:parseActivityDetailProjection(raw,selection.product_id)};
}
export type PresaleDisplaySelection=Awaited<ReturnType<typeof apiPresaleSelection>>;
