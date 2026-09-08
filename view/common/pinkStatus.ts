import { combinationId } from './combinationPurchase';
import { seckillImage } from './seckillPurchase';

export const PINK_STATUS_PATH = '/pages/activity/goods_combination_status/index';
const invalid = (): never => { throw new Error('拼团状态数据无效，请刷新重试'); };
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
}
function int(value: unknown, min = 0, max = 2_147_483_647): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid();
}
function text(value: unknown, max = 1000): string { return typeof value === 'string' && value.length <= max ? value : invalid(); }
function list(value: unknown, max: number): unknown[] { return Array.isArray(value) && value.length <= max ? value : invalid(); }
export function pinkRouteId(query: Record<string, unknown> = {}): number {
  let id = query.id ?? query.pinkRecordId;
  if (query.id !== undefined && query.pinkRecordId !== undefined && query.id !== query.pinkRecordId) return invalid();
  if (query.scene !== undefined) {
    try {
      const scene = decodeURIComponent(text(query.scene, 512));
      const values = scene.split('&').filter(part => part.startsWith('id=')).map(part => part.slice(3));
      if (values.length !== 1 || id !== undefined && id !== values[0]) return invalid();
      id = values[0];
    } catch { return invalid(); }
  }
  return combinationId(id);
}
export function pinkQueryFromHash(hash: string): Record<string, unknown> | null {
  const [path, raw = ''] = hash.replace(/^#/, '').split('?');
  if (path !== PINK_STATUS_PATH) return null;
  const result: Record<string, unknown> = {};
  for (const part of raw.split('&').filter(Boolean)) {
    const at = part.indexOf('=');
    try {
      const key = decodeURIComponent(at < 0 ? part : part.slice(0, at));
      if (!['id', 'pinkRecordId', 'scene'].includes(key)) continue;
      if (Object.prototype.hasOwnProperty.call(result, key)) return { id: '' };
      result[key] = decodeURIComponent(at < 0 ? '' : part.slice(at + 1));
    } catch { return { id: '' }; }
  }
  return result;
}
function product(value: unknown) {
  const row = object(value), price = text(row.price, 24);
  if (!/^\d{1,10}\.\d{2}$/.test(price)) return invalid();
  return { id: int(row.id, 1), productId: int(row.product_id, 1), title: text(row.title),
    image: seckillImage(row.image), price, people: int(row.people, 1, 500) };
}
function member(value: unknown) {
  const row = object(value);
  return { id: int(row.id, 1), uid: int(row.uid), nickname: text(row.nickname, 255), avatar: seckillImage(row.avatar),
    activityId: int(row.cid, 1), productId: int(row.pid, 1), leaderId: int(row.k_id), people: int(row.people, 1, 500),
    status: int(row.status, 1, 3), deadline: int(row.stop_time, 0, 8_640_000_000_000), refunded: int(row.is_refund) };
}
export function parsePinkStatus(value: unknown, viewerUid: number) {
  const row = object(value), viewer = object(row.userInfo), leader = member(row.pinkT), activity = product(row.store_combination);
  if (int(viewer.uid, 1) !== viewerUid || leader.leaderId !== 0 || leader.refunded !== 0 ||
    leader.activityId !== activity.id || leader.productId !== activity.productId) return invalid();
  const members = list(row.pinkAll, 499).map(member), ids = new Set([leader.id]);
  for (const item of members) {
    if (ids.has(item.id) || item.leaderId !== leader.id || item.activityId !== activity.id || item.productId !== activity.productId || item.refunded !== 0) return invalid();
    ids.add(item.id);
  }
  const count = int(row.count, 0, 499), joined = leader.uid === viewerUid || members.some(item => item.uid === viewerUid);
  if (count !== Math.max(0, leader.people - members.length - 1) || row.userBool !== (joined ? 1 : 0)) return invalid();
  const state = text(row.state), pending = row.settlement_pending;
  const cancellationPending = row.cancellation_pending === undefined ? false : row.cancellation_pending;
  if (typeof cancellationPending !== 'boolean' || cancellationPending && (leader.status !== 1 || pending !== true)) return invalid();
  if (typeof pending !== 'boolean' || row.pinkBool !== (leader.status === 2 ? 1 : leader.status === 3 ? -1 : 0) ||
    row.is_ok !== (leader.status === 2 ? 1 : 0) || state !== (leader.status === 2 ? 'success' : leader.status === 3 ? 'failed' : pending ? 'settlement_pending' : 'active') ||
    leader.status !== 1 && pending || leader.status === 1 && (count === 0 || leader.deadline === 0) && !pending) return invalid();
  const orderId = row.current_pink_order === null ? null : text(row.current_pink_order, 128);
  if (orderId !== null && (!joined || !orderId || /[\s\u0000-\u001f\u007f]/u.test(orderId))) return invalid();
  const hosts = list(row.store_combination_host, 20).map(product);
  if (new Set(hosts.map(item => item.id)).size !== hosts.length || typeof row.store_combination_host_truncated !== 'boolean') return invalid();
  return { leader, members, activity, count, joined, state, pending, cancellationPending, orderId,
    resolvedId: int(row.resolved_pink_id, 1), hosts, hostsTruncated: row.store_combination_host_truncated };
}
export type PinkStatus = ReturnType<typeof parsePinkStatus>;
export function pinkAwaitingSettlement(detail: PinkStatus, now = Date.now()) {
  return detail.leader.status === 1 && (detail.pending || detail.leader.deadline * 1000 <= now);
}
export function pinkCanJoin(detail: PinkStatus, now = Date.now()) {
  return detail.leader.status === 1 && !detail.joined && detail.count > 0 && !pinkAwaitingSettlement(detail, now);
}
