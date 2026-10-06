import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { parseLevelActivationJson } from './AdminLevelActivationInput';
import { pcBannerRequestId } from './AdminPcBannerInput';
import { isProductCategoryStyleValue, productCategoryStyleCanonical } from '../../../../view/common/productCategoryStyle';
export const categoryStyleOperationId = pcBannerRequestId;
export function categoryStyleInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidateException('分类样式请求须为JSON对象');
  const raw = input as Record<string, unknown>, keys = ['operationId', 'revision', 'level', 'index'];
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key))) throw new ValidateException('须完整提交分类样式字段');
  const operationId = categoryStyleOperationId(raw.operationId);
  if (typeof raw.revision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.revision) || !isProductCategoryStyleValue(raw)) throw new ValidateException('分类样式或版本无效');
  return { operationId, canonical: productCategoryStyleCanonical({ revision: raw.revision, level: raw.level, index: raw.index }) };
}
export class ProductCategoryStyleStaleVersion extends ValidateException {
  readonly operation = 'update';
  constructor(public readonly operationId: string, public readonly payloadHash: string) { super('分类样式已变化，请重新读取并确认'); }
}
export class ProductCategoryStyleRejected extends ValidateException {
  readonly operation = 'update';
  constructor(public readonly operationId: string, public readonly payloadHash: string) { super('分类样式模板异常，不能自动覆盖导入数据'); }
}
export async function readProductCategoryStyleBody(request: Request) { return parseLevelActivationJson(await readBoundedUtf8Text(request, 4096)); }
