import { http } from '@/utils/request';
import type { AdminSessionValue } from '@/stores/adminSession';
import { adminRequest } from './adminRequest';

export const ASSISTED_PAGE_SIZE = 20;
export interface AssistedRecord {
  id: number; orderNo: string; uid: number; paid: boolean; amount: string;
  quantity: number; statusTitle: string; createdAt: number; root: boolean;
}
export interface AssistedRecordPage { items: AssistedRecord[]; nextCursor: string | null; hasMore: boolean }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('管理员响应格式错误');
  return value as Record<string, unknown>;
};
function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw Error('管理员响应数值无效');
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw Error('管理员响应文字无效');
  return value;
}
export async function apiAssistedLogin(account: string, password: string): Promise<AdminSessionValue> {
  if (!account.trim() || account.trim().length > 64 || !password || password.length > 256) throw Error('请输入有效的管理员账号和密码');
  const data = object(await http.post<unknown>('admin/login', { account: account.trim(), pwd: password }, { noAuth: true }));
  const info = object(data.user_info), token = text(data.token, 4096), id = integer(info.id, 1);
  const expiresAt = integer(data.expires_time, 1) * 1000;
  if (!token || /\s/.test(token) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw Error('管理员登录响应已失效');
  if (!Array.isArray(data.unique_auth) || data.unique_auth.length > 1000) throw Error('管理员权限响应无效');
  return { token, id, expiresAt, label: text(info.real_name || info.account, 128),
    permissions: data.unique_auth.map(key => text(key, 100)) };
}

async function adminGet(path: string, query: Record<string, unknown>): Promise<unknown> {
  return adminRequest('GET', path, query, 'order.assisted');
}

function cursorPosition(value: string): { createdAt: number; id: number } {
  if (value.length > 32 || !/^(?:0|-[1-9]\d{0,9}|[1-9]\d{0,9}):[1-9]\d{0,9}$/.test(value)) throw Error('订单游标无效');
  const [createdAt, id] = value.split(':').map(Number);
  if (!Number.isSafeInteger(createdAt) || createdAt < -2147483648 || createdAt > 2147483647
    || !Number.isSafeInteger(id) || id > 2147483647) throw Error('订单游标无效');
  return { createdAt, id };
}
export async function apiAssistedRecords(cursor: string, keyword: string, status: string): Promise<AssistedRecordPage> {
  if (typeof cursor !== 'string' || keyword.length > 100
    || !['', '0', '1', '2', '3', '4'].includes(status)) throw Error('订单查询条件无效');
  if (cursor) cursorPosition(cursor);
  const result = object(await adminGet('admin/order/place/list', {
    paging: 'cursor', cursor, limit: ASSISTED_PAGE_SIZE, keyword, ...(status ? { status: Number(status) } : {}),
  }));
  if (!Array.isArray(result.list) || result.list.length > ASSISTED_PAGE_SIZE) throw Error('订单列表响应格式错误');
  const rows = result.list.map(value => {
    const row = object(value), orderNo = text(row.order_id, 32), amount = text(row.pay_price, 16);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(orderNo) || !/^\d{1,10}\.\d{2}$/.test(amount) || ![0, 1].includes(row.paid as number)) throw Error('订单数据无效');
    return { id: integer(row.id, 1), orderNo, uid: integer(row.uid), paid: row.paid === 1, amount,
      quantity: integer(row.total_num, 1), statusTitle: text(object(row._status)._title, 100),
      createdAt: integer(row.add_time, -2147483648),
      root: row.pid === 0 || row.pid === -1 };
  });
  if (new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.orderNo)).size !== rows.length) throw Error('订单列表存在重复项，请刷新');
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].createdAt > rows[i - 1].createdAt
      || (rows[i].createdAt === rows[i - 1].createdAt && rows[i].id >= rows[i - 1].id)) {
      throw Error('订单列表顺序无效，请刷新');
    }
  }
  if (cursor && rows.length) {
    const before = cursorPosition(cursor), first = rows[0];
    if (first.createdAt > before.createdAt || (first.createdAt === before.createdAt && first.id >= before.id)) {
      throw Error('订单列表游标已变化，请刷新');
    }
  }
  if (typeof result.has_more !== 'boolean') throw Error('订单分页响应无效');
  const nextCursor = result.next_cursor;
  if (result.has_more) {
    const last = rows.at(-1);
    if (rows.length !== ASSISTED_PAGE_SIZE || typeof nextCursor !== 'string' || !last
      || nextCursor !== `${last.createdAt}:${last.id}`) throw Error('订单分页响应无效');
    cursorPosition(nextCursor);
  } else if (nextCursor !== null) throw Error('订单分页响应无效');
  return { items: rows, nextCursor: result.has_more ? nextCursor as string : null, hasMore: result.has_more };
}

export async function apiAssistedPaidStatus(orderNo: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(orderNo)) throw Error('订单号无效');
  const result = object(await adminGet('admin/order/pay/status', { order_id: orderNo }));
  if (result.order_id !== orderNo) throw Error('订单状态已变化，请刷新列表');
  if (typeof result.status !== 'boolean') throw Error('付款状态响应无效');
  return result.status;
}
