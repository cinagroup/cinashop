import { ValidateException } from '@/utils/errors';

export interface SupplierProductLabelInput {
  labelCate: number;
  labelName: string;
  expectedRevision?: string;
}

export function supplierLabelId(value: unknown, allowZero = false): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) {
    throw new ValidateException('商品标签ID错误');
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id > 2_147_483_647 || id < (allowZero ? 0 : 1)) {
    throw new ValidateException('商品标签ID错误');
  }
  return id;
}

export function supplierLabelRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('商品标签数据格式错误');
  return value as Record<string, unknown>;
}

export function supplierLabelRevision(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ValidateException('商品标签版本错误');
  return value;
}

export function parseSupplierProductLabelInput(value: unknown): SupplierProductLabelInput {
  const row = supplierLabelRecord(value);
  if (Object.keys(row).some(key => !['label_cate', 'label_name', 'expected_revision'].includes(key))) {
    throw new ValidateException('商品标签字段错误');
  }
  const labelCate = supplierLabelId(row.label_cate);
  if (typeof row.label_name !== 'string') throw new ValidateException('请输入标签名称');
  const labelName = row.label_name.trim();
  if (!labelName || [...labelName].length > 20 || /[\u0000-\u001f\u007f]/u.test(labelName)) {
    throw new ValidateException('请输入1至20个字的标签名称');
  }
  return { labelCate, labelName, expectedRevision: supplierLabelRevision(row.expected_revision) };
}

export function parseSupplierProductLabelDelete(value: unknown): { expectedRevision?: string } {
  if (value === undefined) return {};
  const row = supplierLabelRecord(value);
  if (Object.keys(row).some(key => key !== 'expected_revision')) throw new ValidateException('商品标签删除字段错误');
  return { expectedRevision: supplierLabelRevision(row.expected_revision) };
}

export function supplierLabelNoQuery(query: URLSearchParams): void {
  if (query.size) throw new ValidateException('此商品标签操作不接受查询参数');
}
