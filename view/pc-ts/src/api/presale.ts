import request, { getData } from '@/utils/request';
import { parsePresaleSelection, presaleProductId } from '../../../common/presalePurchase';
import { parsePresaleCatalog, presaleCatalogQuery, type PresaleTimeType } from '../../../common/presaleCatalog';

export async function apiPresaleCatalog(type: PresaleTimeType, page: number) {
  return parsePresaleCatalog(await getData(request.get('/presale/list', { params: presaleCatalogQuery(type, page) })), type, page);
}

export async function apiPresaleSelection(id: number) {
  presaleProductId(String(id));
  return parsePresaleSelection(await getData(request.get(`/product/detail/${id}`, { params: { view: 'presale' } })), id);
}
