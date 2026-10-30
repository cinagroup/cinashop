import { http } from '@/utils/request';
import { apiCategoryProducts } from './product';
import { parseSearchHotwords, searchQuery } from '../../../common/searchHotwords';

export async function apiSearchHotwords() {
  return parseSearchHotwords(await http.get<unknown>('/search/hot_keyword', {}, { noAuth: true }));
}

export async function apiSearchProducts(word: string) {
  // Preserve optional shopper identity and the Worker's existing search-history write.
  const page = await apiCategoryProducts({ keyword: searchQuery(word), page: 1, limit: 20 });
  if (page.list.length > 20 || Array.from(page.list).some(row => !row)) throw Error('搜索商品列表响应无效');
  return page;
}
