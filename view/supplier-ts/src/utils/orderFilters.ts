export const orderSearchFields = [
  { value: 'all', label: '全部', placeholder: '订单号、客户、商品或活动' },
  { value: 'order_id', label: '订单号', placeholder: '完整订单号或原订单号' },
  { value: 'uid', label: '用户 UID', placeholder: '用户 UID' },
  { value: 'real_name', label: '收货人姓名', placeholder: '完整收货人姓名' },
  { value: 'user_phone', label: '收货人电话', placeholder: '完整收货人电话' },
  { value: 'title', label: '商品名称', placeholder: '当前商品名称或关键词' },
  { value: 'total_num', label: '商品件数', placeholder: '准确商品件数' },
] as const;
export const supplierOrderTypes = ['普通订单', '秒杀订单', '砍价订单', '拼团订单', '积分订单', '套餐订单', '预售订单', '新人订单', '抽奖订单'];
export const supplierOrderStatuses = [
  { value: '0', label: '未支付' }, { value: '1', label: '未发货' },
  { value: '2', label: '待收货 / 待核销' }, { value: '3', label: '待评价' },
  { value: '4', label: '交易完成' }, { value: '-4', label: '用户已删除' },
];
export function emptyOrderFilters() {
  return { page: 1, limit: 20, order: '', paid: '', status: '', business_status: '',
    type: '', pay_type: '', field_key: 'all', start_time: '', end_time: '' };
}
export type SupplierOrderFilterDraft = ReturnType<typeof emptyOrderFilters>;

// datetime-local is interpreted in the viewer's local time, then sent as an
// unambiguous epoch second. Never silently roll an invalid date into next month.
function localTimestamp(value: string, label: string): string {
  if (!value) return '';
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!parts) throw Error(`${label}无效`);
  const [year, month, day, hour, minute, second] = parts.slice(1).map(n => Number(n ?? 0));
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) throw Error(`${label}无效`);
  const epoch = date.getTime() / 1000;
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > 2147483647) throw Error(`${label}超出支持范围`);
  return String(epoch);
}
export function supplierOrderFilterQuery(draft: SupplierOrderFilterDraft): Record<string, string | number> {
  const keyword = draft.order.trim();
  if (keyword.length > 256 || /[\u0000-\u001f\u007f]/.test(keyword)) throw Error('订单搜索内容无效');
  if (!orderSearchFields.some(field => field.value === draft.field_key)) throw Error('订单搜索字段无效');
  if (keyword && ['uid', 'total_num'].includes(draft.field_key)
    && (!/^(0|[1-9]\d{0,9})$/.test(keyword) || Number(keyword) > 2147483647 || draft.field_key === 'uid' && Number(keyword) === 0)) throw Error('请输入有效的整数搜索值');
  const start = localTimestamp(draft.start_time, '开始时间'), end = localTimestamp(draft.end_time, '结束时间');
  if (start !== '' && end !== '' && Number(start) > Number(end)) throw Error('开始时间不能晚于结束时间');
  return { page: draft.page, limit: draft.limit, order: keyword, paid: draft.paid, status: draft.status,
    business_status: draft.business_status, type: draft.type, pay_type: draft.pay_type, field_key: draft.field_key,
    start_time: start, end_time: end };
}
