import { productScheduleSeconds, productScheduleText } from './productSchedule';

export interface SupplierProductPurchaseSelection {
  version: 1; is_vip_product: 0 | 1; is_presale_product: 0 | 1;
  presale_start_time: number; presale_end_time: number; presale_day: number;
}
export interface ProductPurchaseEditor {
  ready: boolean; memberOnly: boolean; presale: boolean; startsAt: string; endsAt: string; days: number;
  memberChanged: boolean; presaleChanged: boolean; periodChanged: boolean; daysChanged: boolean;
}
export function productPurchaseEditor(value?: unknown, creating = false): ProductPurchaseEditor {
  const empty = { ready: creating, memberOnly: false, presale: false, startsAt: '', endsAt: '', days: 0,
    memberChanged: false, presaleChanged: false, periodChanged: false, daysChanged: false };
  if (value === undefined) return empty;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('商品购买资格与预售响应无效，请重新读取');
  const row = value as Record<string, unknown>;
  const keys = ['version', 'is_vip_product', 'is_presale_product', 'presale_start_time', 'presale_end_time', 'presale_day'];
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)) || row.version !== 1
    || (row.is_vip_product !== 0 && row.is_vip_product !== 1) || (row.is_presale_product !== 0 && row.is_presale_product !== 1)
    || keys.slice(3).some(key => typeof row[key] !== 'number' || !Number.isSafeInteger(row[key]) || Number(row[key]) < 0 || Number(row[key]) > 2_147_483_647)
    || row.is_presale_product === 1 && (!row.presale_start_time || !row.presale_end_time || Number(row.presale_end_time) < Number(row.presale_start_time)))
    throw Error('商品购买资格与预售响应无效，请重新读取');
  return { ...empty, ready: true, memberOnly: row.is_vip_product === 1, presale: row.is_presale_product === 1,
    startsAt: productScheduleText(Number(row.presale_start_time)), endsAt: productScheduleText(Number(row.presale_end_time)), days: Number(row.presale_day) };
}
export function productPurchasePayload(editor: ProductPurchaseEditor): {
  is_vip_product?: number; is_presale_product?: number; presale_time?: [number, number]; presale_day?: number;
} {
  if (!editor.ready) return {};
  if (editor.presale && editor.presaleChanged && (!editor.startsAt || !editor.endsAt)) throw Error('启用预售时请填写完整的起止时间');
  const payload = { ...(editor.memberChanged ? { is_vip_product: Number(editor.memberOnly) } : {}),
    ...(editor.presaleChanged ? { is_presale_product: Number(editor.presale) } : {}) };
  if (editor.daysChanged && (!Number.isSafeInteger(editor.days) || editor.days < 0 || editor.days > 2_147_483_647)) throw Error('预售发货天数须为有效非负整数');
  if (editor.presale && editor.periodChanged) {
    const start = productScheduleSeconds(editor.startsAt), end = productScheduleSeconds(editor.endsAt);
    if (end < start) throw Error('预售结束时间不能早于开始时间');
    return { ...payload, presale_time: [start, end], ...(editor.daysChanged ? { presale_day: editor.days } : {}) };
  }
  return { ...payload, ...(editor.daysChanged ? { presale_day: editor.days } : {}) };
}
