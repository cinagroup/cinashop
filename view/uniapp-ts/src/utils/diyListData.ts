import { apiArticleList, type ArticleListItem } from '@/api/article';
import { apiGoodsList, type GoodsListParams } from '@/api/product';
import { checkedPromotionProducts, commerceInteger, commerceRecord, commerceText, type PromotionProduct } from './diyCommerceData';
import { safeDiyImageUrl } from './diy';

export interface DiyListProduct extends PromotionProduct { frameImage: string }
function articleText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw Error('文章文字格式无效');
  return value;
}
export function checkedDiyListProducts(value: unknown, limit: number): DiyListProduct[] {
  const data = commerceRecord(value), products = checkedPromotionProducts(value, limit);
  return products.map((product, index) => {
    const raw = commerceRecord((data.list as unknown[])[index]);
    if (product.star !== '' && (!/^\d(?:\.\d{1,2})?$/u.test(product.star) || Number(product.star) > 5)) throw Error('商品评分格式无效');
    const frame = raw.activity_frame === undefined || raw.activity_frame === null || Array.isArray(raw.activity_frame) && raw.activity_frame.length === 0 ? {} : commerceRecord(raw.activity_frame);
    return { ...product, image: safeDiyImageUrl(product.image), frameImage: safeDiyImageUrl(frame.image) };
  });
}
export function checkedDiyArticles(value: unknown, limit: number): ArticleListItem[] {
  if (!Array.isArray(value) || value.length > limit) throw Error('文章列表格式无效');
  const seen = new Set<number>();
  return value.map(item => {
    const row = commerceRecord(item), id = commerceInteger(row.id, 1);
    if (seen.has(id)) throw Error('文章编号重复'); seen.add(id);
    if (!Array.isArray(row.image_input) || row.image_input.length > 20) throw Error('文章图片格式无效');
    const visit = commerceText(row.visit, 20); if (!/^\d{1,20}$/u.test(visit)) throw Error('文章浏览数无效');
    const time = commerceText(row.add_time, 16); if (!/^\d{4}-\d\d-\d\d \d\d:\d\d$/u.test(time)) throw Error('文章时间无效');
    return { id, title: articleText(row.title, 512), image_input: row.image_input.map(image => safeDiyImageUrl(commerceText(image, 8192))), visit,
      likes: commerceInteger(row.likes), add_time: time, synopsis: articleText(row.synopsis, 4096), url: commerceText(row.url, 8192) };
  });
}
export const readDiyListProducts = async (query: GoodsListParams) => checkedDiyListProducts(await apiGoodsList(query), query.limit ?? 100);
export const readDiyListArticles = async (cid: number, limit: number) => checkedDiyArticles(await apiArticleList(cid, { page: 1, limit }), limit);
/** Measured equal-width cards keep each column independent and select the shorter one. */
export function diyWaterfallColumns(rows: DiyListProduct[], heights: ReadonlyMap<number, number>): [DiyListProduct[], DiyListProduct[]] {
  const columns: [DiyListProduct[], DiyListProduct[]] = [[], []], totals = [0, 0];
  const measured=[...heights.values()].filter(height=>Number.isFinite(height)&&height>0&&height<=10000);
  const estimate=measured.length?measured.reduce((sum,height)=>sum+height,0)/measured.length:1;
  for (const row of rows) {
    const side = totals[0]! <= totals[1]! ? 0 : 1, height = heights.get(row.id);
    columns[side].push(row); totals[side]! += typeof height === 'number' && Number.isFinite(height) && height > 0 ? Math.min(height, 10000) : estimate;
  }
  return columns;
}
