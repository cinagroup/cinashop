import { http } from '@/utils/request';
import { apiReturnImage as uploadUserImage } from './refundReturn';
import { customerWorkRecord, customerWorkImage } from '@/utils/customerWork';
import { cashierId } from '@/utils/customerWorkCashier';

export interface OrdinaryStore { id: number; name: string; address: string }
export interface OrdinaryCity { id: number; name: string; parent: number; expandable: boolean }
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v);
function unique<T extends { id: number }>(rows: T[]): T[] {
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw Error('公共目录编号重复'); return rows;
}
export async function ordinaryPickupStores(): Promise<OrdinaryStore[]> {
  const value: unknown = await http.get('/store/list', undefined, { noAuth: true });
  if (!Array.isArray(value) || value.length > 200) throw Error('自提门店目录无效');
  return unique(value.map(row => {
    if (!customerWorkRecord(row) || !cashierId(row.id) || !text(row.name, 128) || !text(row.address, 512) || !text(row.detailed_address, 512)) throw Error('自提门店资料无效');
    return { id: row.id, name: row.name, address: `${row.address} ${row.detailed_address}`.trim() };
  }));
}
export async function ordinaryCities(parent: number): Promise<OrdinaryCity[]> {
  if (!cashierId(parent, true)) throw Error('地区父编号无效');
  const value: unknown = await http.get('/city', { pid: parent }, { noAuth: true });
  if (!Array.isArray(value) || value.length > 1000) throw Error('地区目录无效');
  return unique(value.map(row => {
    if (!customerWorkRecord(row) || !cashierId(row.id) || row.id !== row.value || row.pid !== parent || !text(row.label, 64) || !row.label) throw Error('地区归属无效');
    return { id: row.id, name: row.label, parent, expandable: Array.isArray(row.children) };
  }));
}
/** Reuses the registered-user upload endpoint: type=3, module=3, owner is the current operator. */
export async function ordinaryCreatorImage(path: string, current: () => boolean): Promise<{ url: string; src: string }> {
  if (!current()) throw Error('原经营账号或表单已变化');
  const value = await uploadUserImage(path);
  if (!current()) throw Error('原经营账号或表单已变化，图片未加入当前订单');
  if (!customerWorkRecord(value) || !cashierId(value.att_id) || value.url !== `/api/assets/${value.att_id}` || !customerWorkImage(value.src)) throw Error('图片回执未确认，请重新核对');
  return { url: value.url, src: value.src };
}
