import { classifyProductMediaReference } from '../../../common/productMediaReference';

/** Only an explicit author action writes this optional field. A read-only or
 * unchanged historical value must never become a new save intention. */
export function productRecommendImagePayload(value: unknown, changed: boolean): { recommend_image?: string } {
  if (!changed) return {};
  if (typeof value !== 'string' || value.length > 4096) throw Error('推荐图地址无效');
  const text = value.trim();
  if (!text) return { recommend_image: '' };
  const reference = classifyProductMediaReference(text);
  if (reference.kind === 'invalid' || reference.reference.length > 256) throw Error('推荐图须为有效图片引用或 HTTPS 地址，最多256个字符');
  return { recommend_image: reference.reference };
}
