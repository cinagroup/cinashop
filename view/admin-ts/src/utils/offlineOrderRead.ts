/** Versioned, readonly staff projection. Never infer collection from recorded_paid. */
export const OFFLINE_READ_VERSION = 'admin-offline-read-v1';
export type OfflineState = 'UNPAID' | 'PENDING' | 'UNAVAILABLE' | 'PAID' | 'REVIEW_REQUIRED' | 'UNVERIFIED';
export type OfflineReason = 'MISSING_ADMISSION' | 'ACCOUNT_MISSING' | 'EVIDENCE_MISMATCH';
export interface OfflineRecord {
  id: number; order_id: string; uid: number; nickname: string; phone: string; account_available: boolean;
  money: string | null; pay_price: string | null; true_price: string | null; add_time: number;
  hidden: boolean; recorded_paid: number; channel: string; paid: boolean | null;
  pay_type: '' | 'yue' | 'weixin' | 'alipay' | null; paid_at: number | null; state: OfflineState; reason: OfflineReason | null;
}
export interface OfflineQuery {
  limit: number; before?: string; order_id?: string; name?: string; uid?: string; from?: string; to?: string; recorded_paid?: string;
}
export interface OfflineFilters { order_id: string; name: string; uid: string; from: string; to: string; recorded_paid: string }
export const emptyOfflineFilters = (): OfflineFilters => ({ order_id: '', name: '', uid: '', from: '', to: '', recorded_paid: '' });
const invalid = () => Error('消费记录响应不完整或不一致，请刷新后核对；不能据此判断是否付款');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function exact(row: Record<string, unknown>, keys: string[]) {
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) throw invalid();
}
function int(value: unknown, min = 0, max = 2147483647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw invalid();
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw invalid();
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') throw invalid(); return value; }
function money(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,7})\.\d{2}$/.test(value)) throw invalid();
  return value;
}
const cents = (value: string) => BigInt(value.replace('.', ''));
export function offlineId(value: string): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) throw Error('请输入有效的正整数标识');
  return value;
}
function orderNumber(value: string) {
  if (typeof value !== 'string' || !value || value.length > 32 || /[\s\u0000-\u001f\u007f]/.test(value)) throw Error('请输入完整消费订单号（最多32字符）');
  return value;
}
function localSeconds(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw Error('请选择有效的本地日期和时间');
  const parts = value.split(/[-T:]/).map(Number);
  const date = new Date(parts[0], parts[1]-1, parts[2], parts[3], parts[4]);
  if ([date.getFullYear(),date.getMonth()+1,date.getDate(),date.getHours(),date.getMinutes()].some((part,i) => part !== parts[i])) {
    throw Error('日期时间无效或处于本地夏令时跳过的时段');
  }
  return offlineId(String(date.getTime()/1000));
}
/** Copies only allowlisted query fields; invalid input never reaches HTTP. */
export function validateOfflineQuery(input: OfflineQuery): OfflineQuery {
  if (Object.keys(input).some(key => !['limit','before','order_id','name','uid','from','to','recorded_paid'].includes(key))) throw Error('消费查询参数无效');
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20) throw Error('每页最多20条');
  const query: OfflineQuery = { limit: input.limit };
  for (const key of ['before','uid','from','to'] as const) if (input[key] !== undefined) query[key] = offlineId(input[key]);
  if (input.order_id !== undefined) query.order_id = orderNumber(input.order_id);
  if (input.name !== undefined) {
    if (!input.name.trim() || input.name.length > 64 || /[\u0000-\u001f\u007f]/.test(input.name)) throw Error('用户搜索词无效');
    query.name = input.name.trim();
  }
  if ((query.from === undefined) !== (query.to === undefined) || (query.from && query.to && Number(query.from) >= Number(query.to))) throw Error('请选择起始早于截止的完整时间范围');
  if (input.recorded_paid !== undefined) {
    if (!['0','1'].includes(input.recorded_paid)) throw Error('原支付标记无效');
    query.recorded_paid = input.recorded_paid;
  }
  const encoded = new URLSearchParams(Object.entries(query).map(([key,value]) => [key,String(value)])).toString();
  if (encoded.length + 1 > 1200) throw Error('筛选条件过长');
  return query;
}
export function offlineQueryFromFilters(form: OfflineFilters, before = ''): OfflineQuery {
  const query: OfflineQuery = { limit: 20 };
  for (const key of ['order_id','name','uid','recorded_paid'] as const) if (form[key].trim()) query[key] = form[key].trim();
  if (form.from) query.from = localSeconds(form.from);
  if (form.to) query.to = localSeconds(form.to);
  if (before) query.before = before;
  return validateOfflineQuery(query);
}
function parseRecord(value: unknown): OfflineRecord {
  const row = object(value);
  exact(row, ['id','order_id','uid','nickname','phone','account_available','money','pay_price','true_price','add_time',
    'hidden','recorded_paid','channel','paid','pay_type','paid_at','state','reason']);
  const state = row.state;
  if (state !== 'UNPAID' && state !== 'PENDING' && state !== 'UNAVAILABLE' && state !== 'PAID' && state !== 'REVIEW_REQUIRED' && state !== 'UNVERIFIED') throw invalid();
  const paid = row.paid === null ? null : boolean(row.paid);
  const payType = row.pay_type;
  if (payType !== null && payType !== '' && payType !== 'yue' && payType !== 'weixin' && payType !== 'alipay') throw invalid();
  const reason = row.reason;
  if (reason !== null && reason !== 'MISSING_ADMISSION' && reason !== 'ACCOUNT_MISSING' && reason !== 'EVIDENCE_MISMATCH') throw invalid();
  const result: OfflineRecord = { id: int(row.id,1), order_id: text(row.order_id,32), uid: int(row.uid,-2147483648),
    nickname: text(row.nickname,256), phone: text(row.phone,64), account_available: boolean(row.account_available),
    money: money(row.money), pay_price: money(row.pay_price), true_price: money(row.true_price),
    add_time: int(row.add_time,-2147483648), hidden: boolean(row.hidden), recorded_paid: int(row.recorded_paid,-32768,32767),
    channel: text(row.channel,10), paid, pay_type: payType, paid_at: row.paid_at === null ? null : int(row.paid_at,1), state, reason };
  const difference = result.money !== null && result.pay_price !== null && cents(result.money) >= cents(result.pay_price)
    ? cents(result.money) - cents(result.pay_price) : null;
  if ((difference === null) !== (result.true_price === null) || (difference !== null && cents(result.true_price!) !== difference)) throw invalid();
  if (state === 'UNVERIFIED') {
    if (paid !== null || reason === null || payType !== null || result.paid_at !== null) throw invalid();
  } else {
    if (reason !== null || paid === null || result.uid <= 0 || !/^xx[0-9a-f]{30}$/.test(result.order_id)
      || result.money === null || result.pay_price === null || result.true_price === null
      || result.add_time <= 0 || !['h5','wechat','weixinh5','routine'].includes(result.channel)) throw invalid();
    if (paid) {
      if (!['PAID','REVIEW_REQUIRED'].includes(state) || result.recorded_paid !== 1 || !payType || result.paid_at === null
        || result.paid_at < result.add_time || cents(result.pay_price) < 1n) throw invalid();
    } else if (state === 'PAID' || result.recorded_paid !== 0 || result.paid_at !== null || payType === null || payType === 'yue'
      || ((result.hidden || result.pay_price === '0.00') && state !== 'UNAVAILABLE')
      || (state === 'UNPAID' && payType !== '')) throw invalid();
  }
  return result;
}
export function parseOfflineList(value: unknown, input: OfflineQuery) {
  const query = validateOfflineQuery(input), body = object(value);
  exact(body, ['version','list','limit','next_cursor']);
  if (body.version !== OFFLINE_READ_VERSION || body.limit !== query.limit || !Array.isArray(body.list) || body.list.length > query.limit) throw invalid();
  const list = body.list.map(parseRecord), nextCursor = text(body.next_cursor,10);
  if (nextCursor && (offlineId(nextCursor) !== String(list.at(-1)?.id) || list.length !== query.limit)) throw invalid();
  for (let i=0; i<list.length; i++) {
    const row = list[i];
    if ((i > 0 && row.id >= list[i-1].id) || (query.before !== undefined && row.id >= Number(query.before))
      || (query.uid !== undefined && row.uid !== Number(query.uid)) || (query.order_id !== undefined && row.order_id !== query.order_id)
      || (query.from !== undefined && row.add_time < Number(query.from)) || (query.to !== undefined && row.add_time >= Number(query.to))
      || (query.recorded_paid !== undefined && row.recorded_paid !== Number(query.recorded_paid))) throw invalid();
  }
  return { list, nextCursor };
}
export function parseOfflineDetail(value: unknown, id: string): OfflineRecord {
  offlineId(id); const body = object(value);
  exact(body, ['version','record']);
  if (body.version !== OFFLINE_READ_VERSION) throw invalid();
  const record = parseRecord(body.record);
  if (String(record.id) !== id) throw invalid();
  return record;
}
export function offlineStateLabel(record: OfflineRecord): string {
  return { UNPAID: '未收款', PENDING: '待核对', UNAVAILABLE: '不可付款', PAID: '已核验到账',
    REVIEW_REQUIRED: record.paid ? '已核验到账 · 需复核' : '需复核', UNVERIFIED: '凭据未核验' }[record.state];
}
export function offlineReasonLabel(record: OfflineRecord): string {
  return record.reason === 'MISSING_ADMISSION' ? '缺少准入凭据，原支付标记不能证明到账'
    : record.reason === 'ACCOUNT_MISSING' ? '客户记录缺失，无法完整核验'
    : record.reason === 'EVIDENCE_MISMATCH' ? '订单或收款凭据不一致，请核对原账本'
    : record.state === 'UNAVAILABLE' ? '历史零元或隐藏记录；不代表支付平台已关闭'
    : record.state === 'PENDING' ? '原支付流程尚待核对，不应据此重复付款'
    : record.state === 'REVIEW_REQUIRED' ? '存在恢复冲突等异常状态，需要进一步核对' : '';
}
export const offlinePayLabel = (value: OfflineRecord['pay_type']) => value === null ? '未核验' : value === '' ? '未选择' : { yue: '余额', weixin: '微信', alipay: '支付宝' }[value];
export const offlineTime = (value: number | null) => value === null || value <= 0 ? '—' : new Date(value*1000).toLocaleString('zh-CN', { hour12: false });
