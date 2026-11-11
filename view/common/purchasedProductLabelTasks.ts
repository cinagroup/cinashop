/** Public task-operations contract. No payment sources or processing tokens. */
export const purchasedLabelTaskStatuses = ['PENDING','ENQUEUING','ENQUEUED','PROCESSING','FAILED','DEAD','COMPLETED'] as const;
export type PurchasedLabelTaskStatus = typeof purchasedLabelTaskStatuses[number];
export type PurchasedLabelRecovery = 'eligible'|'receipt'|'automatic'|'active'|'limit'|'maintenance';
export interface PurchasedLabelTaskItem {
  taskId: string; eventKey: string; orderId: number; userId: number; createdAt: number;
  status: PurchasedLabelTaskStatus; attemptCount: number; dispatchCount: number; replayCount: number;
  availableAt: number; leaseUntil: number; processedAt: number; lastError: string;
  receiptCompletedAt: number|null; recovery: PurchasedLabelRecovery;
}
export interface PurchasedLabelTaskList { items: PurchasedLabelTaskItem[]; nextAfterId: string|null; observedAt: number }
export interface PurchasedLabelReplayResult { taskId: string; eventKey: string; replayed: boolean; completed: boolean }
const integer = (v: unknown, zero = true): v is number => typeof v==='number' && Number.isSafeInteger(v) && v>=(zero?0:1) && v<=2147483647;
export const purchasedLabelTaskUuid = (v: unknown): v is string => typeof v==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
export function purchasedLabelRecovery(row: Pick<PurchasedLabelTaskItem,'status'|'leaseUntil'|'replayCount'|'receiptCompletedAt'>, now: number): PurchasedLabelRecovery {
  if (row.receiptCompletedAt!==null) return 'receipt';
  if (row.status==='COMPLETED') return 'maintenance';
  if (row.status==='PENDING') return 'automatic';
  if (row.leaseUntil>=now) return 'active';
  if (row.replayCount>=20) return 'limit';
  return ['FAILED','DEAD','PROCESSING','ENQUEUING','ENQUEUED'].includes(row.status) ? 'eligible' : 'maintenance';
}
function data(value: unknown, keys: readonly string[]) {
  if (!value || ![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length!==keys.length) throw Error('购买标签任务响应无效');
  const result: Record<string,unknown> = {};
  for (const key of keys) { const d=Object.getOwnPropertyDescriptor(value,key); if (!d?.enumerable || !('value' in d)) throw Error('购买标签任务响应无效'); result[key]=d.value; }
  return result;
}
function event(value: unknown, orderId?: number): value is string {
  if (typeof value!=='string') return false;
  const m=/^order\.product\.labels:([1-9]\d{0,9}):([1-9]\d{0,9})$/u.exec(value);
  return !!m && integer(Number(m[1]),false) && integer(Number(m[2]),false) && (orderId===undefined || Number(m[2])===orderId);
}
export function capturePurchasedLabelTaskList(value: unknown): PurchasedLabelTaskList {
  const r=data(value,['items','nextAfterId','observedAt']);
  if (!integer(r.observedAt,false) || r.nextAfterId!==null && !purchasedLabelTaskUuid(r.nextAfterId)
    || !Array.isArray(r.items) || r.items.length>100 || Object.getPrototypeOf(r.items)!==Array.prototype || Reflect.ownKeys(r.items).length!==r.items.length+1) throw Error('购买标签任务分页无效');
  const seen=new Set<string>(); let last='';
  const items=Array.from({length:r.items.length},(_,i) => {
    const d=Object.getOwnPropertyDescriptor(r.items,String(i)); if (!d?.enumerable || !('value' in d)) throw Error('购买标签任务行无效');
    const row=data(d.value,['taskId','eventKey','orderId','userId','createdAt','status','attemptCount','dispatchCount','replayCount','availableAt','leaseUntil','processedAt','lastError','receiptCompletedAt','recovery']);
    if (!purchasedLabelTaskUuid(row.taskId) || seen.has(row.taskId) || row.taskId<=last || !integer(row.orderId,false) || !integer(row.userId,false)
      || !event(row.eventKey,row.orderId) || !purchasedLabelTaskStatuses.includes(row.status as PurchasedLabelTaskStatus)
      || ['createdAt','attemptCount','dispatchCount','replayCount','availableAt','leaseUntil','processedAt'].some(key=>!integer(row[key]))
      || row.receiptCompletedAt!==null && !integer(row.receiptCompletedAt,false) || typeof row.lastError!=='string' || row.lastError.length>1000) throw Error('购买标签任务行无效');
    const item=row as unknown as PurchasedLabelTaskItem;
    if (item.recovery!==purchasedLabelRecovery(item,r.observedAt as number)) throw Error('购买标签任务恢复状态不一致');
    seen.add(item.taskId); last=item.taskId; return {...item};
  });
  if (r.nextAfterId!==null && r.nextAfterId!==items.at(-1)?.taskId) throw Error('购买标签任务游标不一致');
  return { items, nextAfterId:r.nextAfterId as string|null, observedAt:r.observedAt };
}
export function capturePurchasedLabelReplayResult(value: unknown, taskId: string, eventKey: string): PurchasedLabelReplayResult {
  const r=data(value,['taskId','eventKey','replayed','completed']);
  if (!purchasedLabelTaskUuid(taskId) || !event(eventKey) || r.taskId!==taskId || r.eventKey!==eventKey
    || typeof r.replayed!=='boolean' || typeof r.completed!=='boolean' || r.replayed && r.completed) throw Error('购买标签重放回执不一致');
  return r as unknown as PurchasedLabelReplayResult;
}
export function purchasedLabelReplayReason(value: unknown): string {
  if (typeof value!=='string') throw Error('请填写维护原因');
  const reason=value.trim();
  if (!reason || Array.from(reason).length>100 || /[\u0000-\u001f\u007f]/u.test(reason)) throw Error('维护原因须为1至100个字符，不含换行或控制字符');
  for (const ch of reason) if (ch.codePointAt(0)!>=0xd800 && ch.codePointAt(0)!<=0xdfff) throw Error('维护原因包含无效字符');
  return reason;
}
