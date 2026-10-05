/** The nineteen public PHP product_detail keys, in their original order. */
export interface ProductDetailDesignValue {
  navList: number[];
  openShare: 0 | 1;
  pictureConfig: 0 | 1;
  swiperDot: 0 | 1;
  showPrice: number[];
  isOpen: number[];
  showSvip: 0 | 1;
  showRank: 0 | 1;
  showService: number[];
  showReply: 0 | 1;
  replyNum: number;
  showMatch: 0 | 1;
  matchNum: number;
  showRecommend: 0 | 1;
  recommendNum: number;
  menuList: number[];
  showCart: 0 | 1;
  showCommunity: 0 | 1;
  communityNum: number;
}

const defaults: ProductDetailDesignValue = {
  navList: [0, 1, 2, 3, 4], openShare: 1, pictureConfig: 0, swiperDot: 1,
  showPrice: [0, 1], isOpen: [0, 1, 2], showSvip: 1, showRank: 1,
  showService: [0, 1, 2, 3], showReply: 1, replyNum: 3, showMatch: 1, matchNum: 3,
  showRecommend: 1, recommendNum: 12, menuList: [0, 1, 2], showCart: 1,
  showCommunity: 1, communityNum: 3,
};
for (const value of Object.values(defaults)) if (Array.isArray(value)) Object.freeze(value);
export const PRODUCT_DETAIL_DESIGN_DEFAULT: Readonly<ProductDetailDesignValue> = Object.freeze(defaults);

export const PRODUCT_DETAIL_DESIGN_KEYS = Object.freeze(Object.keys(PRODUCT_DETAIL_DESIGN_DEFAULT) as Array<keyof ProductDetailDesignValue>);

/** Copy arrays too: a form draft must never modify a shared/default snapshot. */
export function cloneProductDetailDesign(value: ProductDetailDesignValue = PRODUCT_DETAIL_DESIGN_DEFAULT): ProductDetailDesignValue {
  return Object.fromEntries(PRODUCT_DETAIL_DESIGN_KEYS.map(key => [key, Array.isArray(value[key]) ? [...value[key] as number[]] : value[key]])) as unknown as ProductDetailDesignValue;
}

function selection(value: unknown, last: number, maximum = last + 1): value is number[] {
  return Array.isArray(value) && value.length <= maximum && new Set(value).size === value.length
    && value.every(item => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item <= last);
}

/** Known editor ranges. Historical isOpen ordinals3/4/5 remain opaque selections. */
export function isProductDetailDesignValue(value: unknown): value is ProductDetailDesignValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== PRODUCT_DETAIL_DESIGN_KEYS.length || !PRODUCT_DETAIL_DESIGN_KEYS.every(key => Object.hasOwn(record, key))) return false;
  if (!selection(record.navList, 4) || !selection(record.showPrice, 1) || !selection(record.isOpen, 5)
    || !selection(record.showService, 3) || !selection(record.menuList, 4, 3)) return false;
  for (const key of ['openShare', 'pictureConfig', 'swiperDot', 'showSvip', 'showRank', 'showReply', 'showMatch', 'showRecommend', 'showCart', 'showCommunity']) {
    if (record[key] !== 0 && record[key] !== 1) return false;
  }
  for (const [key, maximum] of [['replyNum', 10], ['matchNum', 10], ['recommendNum', 24], ['communityNum', 10]] as const) {
    const number = record[key];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || number > maximum) return false;
  }
  return true;
}

export interface ProductDetailDesignSnapshot {
  revision: string;
  value: ProductDetailDesignValue | null;
  configured: boolean;
  editable: boolean;
  issues: string[];
}

export interface ProductDetailDesignReceipt {
  operation: 'update';
  id: number;
  operationId: string;
  payloadHash: string;
}

/** Fixed key order; operationId deliberately stays outside the payload digest. */
export function productDetailDesignPayload(revision: string, value: ProductDetailDesignValue) {
  return { operation: 'update' as const, revision, value: cloneProductDetailDesign(value) };
}
