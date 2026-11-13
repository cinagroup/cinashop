export const adminOrderEditFields = ['order_id', 'total_price', 'total_postage', 'pay_postage', 'pay_price', 'gain_integral'] as const;
export type AdminOrderEditValues = Record<typeof adminOrderEditFields[number], string>;
export interface AdminOrderEditForm { values: AdminOrderEditValues; revision: string }
export function parseAdminOrderEditForm(value: unknown, id: number, orderNo: string): AdminOrderEditForm {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('订单编辑表单响应无效');
  const row = value as Record<string, unknown>;
  if (row.action !== `/order/update/${id}` || row.method !== 'PUT' || typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/.test(row.revision)
    || !row.values || typeof row.values !== 'object' || Array.isArray(row.values) || !Array.isArray(row.rules) || row.rules.length !== 6) throw Error('订单编辑表单不完整');
  const fields = row.values as Record<string, unknown>;
  if (Object.keys(fields).sort().join(',') !== [...adminOrderEditFields].sort().join(',') || fields.order_id !== orderNo
    || adminOrderEditFields.some((field, index) => typeof fields[field] !== 'string'
      || index > 0 && !([2,3,5].includes(index) ? /^-?(0|[1-9]\d{0,9})\.\d{2}$/ : /^(0|[1-9]\d{0,9})\.\d{2}$/).test(String(fields[field])))) throw Error('订单编辑表单与当前订单不一致');
  for (const [index, field] of adminOrderEditFields.entries()) {
    const rule = row.rules[index];
    if (!rule || typeof rule !== 'object' || rule.field !== field || rule.value !== (index === 0 ? fields[field] : Number(fields[field]))
      || (index > 0 && rule.props?.max !== 9_999_999_999)
      || (index < 4 && rule.props?.disabled !== true)) throw Error('订单编辑只读字段不完整');
  }
  return { values: Object.fromEntries(adminOrderEditFields.map(field => [field, fields[field]])) as AdminOrderEditValues, revision: row.revision };
}
