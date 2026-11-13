import { ValidateException } from '@/utils/errors';

type UnknownRecord = Record<string, unknown>;

export function productRecommendationInput(input: UnknownRecord): string | undefined {
  if (!Object.hasOwn(input, 'recommend_list') || input.recommend_list === undefined) return undefined;
  if (!Array.isArray(input.recommend_list) || input.recommend_list.length > 100) {
    throw new ValidateException('推荐商品列表格式错误');
  }
  const ids = input.recommend_list.map(value => {
    if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value).trim())) {
      throw new ValidateException('推荐商品ID格式错误');
    }
    const id = Number(String(value).trim());
    if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) throw new ValidateException('推荐商品ID超出允许范围');
    return id;
  });
  const encoded = ids.join(',');
  if (encoded.length > 256) throw new ValidateException('推荐商品列表超过存储长度');
  return encoded;
}
