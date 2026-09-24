import { http } from '@/utils/request';
import { safeDiyImageUrl } from '@/utils/diy';

export type ProductRankType = 1 | 2 | 3;

export interface RankedProduct {
  id: number;
  title: string;
  image: string;
  price: string;
  sales: number;
  star: string;
  brand: string;
  presale: boolean;
  destination: string | null;
  navigationHint: string;
  navigationExpiresAt: number | null;
}

export const PRODUCT_RANK_TABS: ReadonlyArray<{ type: ProductRankType; label: string }> = [
  { type: 1, label: '销量榜' },
  { type: 2, label: '好评榜' },
  { type: 3, label: '收藏榜' },
];
export const PRODUCT_RANK_PAGE_SIZE = 10;

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

type RankNavigation = Pick<RankedProduct, 'destination' | 'navigationHint' | 'navigationExpiresAt'>;
const unavailable = (): RankNavigation => ({
  destination: null, navigationHint: '活动链接待确认，请刷新榜单', navigationExpiresAt: null,
});

/** Activity IDs come only from the Worker projection, never from a product ID or raw activity flag. */
export function rankNavigation(row: Record<string, unknown>, productId: number): RankNavigation {
  const target = object(row.recommendation_target);
  if (!target || target.version !== 1 || target.product_id !== productId ||
    !Number.isSafeInteger(target.id) || Number(target.id) < 1 || Number(target.id) > 2_147_483_647) return unavailable();
  let expiresAt: number | null = null;
  if (target.ends_at !== null) {
    if (typeof target.ends_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(target.ends_at)) return unavailable();
    expiresAt = Date.parse(target.ends_at);
    if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== target.ends_at) return unavailable();
  }
  const id = Number(target.id);
  if (row.is_presale_product === 1) return target.kind === 'presale' && id === productId && expiresAt === null
    ? { destination: `/pages/activity/presaleDetail?id=${productId}`, navigationHint: '预售 · 查看规则 ›', navigationExpiresAt: null }
    : unavailable();
  if (row.is_presale_product !== 0 || typeof row.activity !== 'string' || row.activity.length > 255) return unavailable();
  const priority = row.activity.trim() || '0,1,2,3';
  const types = priority.split(',');
  if (!/^[0-3](?:,[0-3]){0,3}$/.test(priority) || new Set(types).size !== types.length) return unavailable();
  if (target.kind === 'product') return id === productId && expiresAt === null
    ? { destination: `/pages/goods/detail?id=${productId}`, navigationHint: '查看详情 ›', navigationExpiresAt: null }
    : unavailable();
  if (types[0] === '0') return unavailable();
  const routes = { seckill: ['1', 'seckillDetail', '秒杀'], bargain: ['2', 'bargainDetail', '砍价'],
    combination: ['3', 'detail', '拼团'] } as const;
  if (typeof target.kind !== 'string' || !Object.hasOwn(routes, target.kind)) return unavailable();
  const [activityType, page, label] = routes[target.kind as keyof typeof routes];
  if (!types.includes(activityType) || target.kind === 'seckill' && expiresAt === null) return unavailable();
  return { destination: `/pages/activity/${page}?id=${id}`, navigationHint: `${label} · 查看详情 ›`, navigationExpiresAt: expiresAt };
}

export function parseProductRankType(value: unknown): ProductRankType {
  return value === 2 || value === '2' ? 2 : value === 3 || value === '3' ? 3 : 1;
}

export function parseProductRankRows(value: unknown): RankedProduct[] {
  if (!Array.isArray(value) || value.length > PRODUCT_RANK_PAGE_SIZE) throw new Error('商品排行榜响应无效');
  const seen = new Set<number>();
  return value.map((entry) => {
    const row = object(entry);
    const id = row?.id;
    const price = row?.price;
    const priceText = typeof price === 'string' || typeof price === 'number' ? String(price) : '';
    const star = row?.star;
    const starText = typeof star === 'string' || typeof star === 'number' ? String(star) : '';
    if (!row || !Number.isSafeInteger(id) || Number(id) <= 0 || seen.has(Number(id))
      || typeof row.store_name !== 'string' || !row.store_name.trim()
      || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(priceText)
      || !Number.isSafeInteger(row.sales) || Number(row.sales) < 0
      || !/^\d{1,2}(?:\.\d)?$/.test(starText)
      || !Number.isSafeInteger(row.is_presale_product) || ![0, 1].includes(Number(row.is_presale_product))) {
      throw new Error('商品排行榜响应无效');
    }
    seen.add(Number(id));
    return {
      id: Number(id), title: row.store_name.trim().slice(0, 200), image: safeDiyImageUrl(row.image),
      price: priceText.includes('.') ? priceText.padEnd(priceText.indexOf('.') + 3, '0') : `${priceText}.00`,
      sales: Number(row.sales), star: starText,
      brand: typeof row.brand_name === 'string' ? row.brand_name.slice(0, 80) : '',
      presale: row.is_presale_product === 1,
      ...rankNavigation(row, Number(id)),
    };
  });
}

export async function apiProductRank(type: ProductRankType, page: number): Promise<RankedProduct[]> {
  if (![1, 2, 3].includes(type) || !Number.isSafeInteger(page) || page < 1 || page > 10_000) {
    throw new Error('排行榜分页参数无效');
  }
  return parseProductRankRows(await http.get<unknown>(`/product/rank/${type}`,
    { page, limit: PRODUCT_RANK_PAGE_SIZE, selectId: 0 }));
}
