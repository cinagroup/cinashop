export interface SupplierProductIntegralSelection { version: 1; give_integral: string }
export interface ProductIntegralEditor { ready: boolean; changed: boolean; value: string }

function integral(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,10}(?:\.\d{1,2})?$/.test(value.trim())) throw Error('赠送积分须为最多两位小数的非负数，整数部分最多十位');
  const [whole, fraction = ''] = value.trim().split('.');
  return `${BigInt(whole)}.${fraction.padEnd(2, '0')}`;
}
export function productIntegralEditor(selection?: unknown, creating = false): ProductIntegralEditor {
  if (selection === undefined) return { ready: creating, changed: false, value: '0.00' };
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw Error('商品赠送积分响应无效');
  const row = selection as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || row.version !== 1 || !Object.hasOwn(row, 'give_integral')) throw Error('商品赠送积分响应无效');
  return { ready: true, changed: false, value: integral(row.give_integral) };
}
export function productIntegralPayload(editor: ProductIntegralEditor): { give_integral?: string } {
  return editor.ready && editor.changed ? { give_integral: integral(editor.value) } : {};
}
