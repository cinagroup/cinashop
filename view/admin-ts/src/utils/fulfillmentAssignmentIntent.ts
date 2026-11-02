import { assignmentSnapshot, assignmentObject, assignmentId, assignmentDigest, captureAdminAssignment,
  adminAssignmentHash, parseAdminAssignmentReceipt, type AdminAssignmentInput, type AdminAssignmentReceipt,
} from '../../../common/fulfillmentAssignment';

export interface AssignmentIntent {
  version: 'admin-fulfillment-assignment-journal-v1'; actor_id: number; order_id: number;
  input: AdminAssignmentInput; payload_hash: string; created_at: number;
  phase: 'pending' | 'recorded'; receipt: AdminAssignmentReceipt | null;
}
const prefix = 'admin-fulfillment-assignment-journal-v1:';
export function assignmentIntentKey(actor: number, order: number): string { return prefix + assignmentId(actor) + ':' + assignmentId(order); }
export async function parseAssignmentIntent(value: unknown, actor: number, order: number): Promise<AssignmentIntent> {
  const r = assignmentObject(assignmentSnapshot(value, 16384), ['version','actor_id','order_id','input','payload_hash','created_at','phase','receipt']);
  const input = captureAdminAssignment(r.input), payload_hash = assignmentDigest(r.payload_hash);
  if (r.version !== 'admin-fulfillment-assignment-journal-v1' || r.actor_id !== assignmentId(actor) || r.order_id !== assignmentId(order)
    || input.order_id !== order || typeof r.created_at !== 'number' || !Number.isSafeInteger(r.created_at) || r.created_at <= 0
    || r.phase !== 'pending' && r.phase !== 'recorded' || r.phase === 'pending' && r.receipt !== null
    || r.phase === 'recorded' && r.receipt === null || await adminAssignmentHash(input, actor) !== payload_hash) throw Error('原分配请求记录不一致，请保留并人工核对');
  const receipt = r.receipt === null ? null : await parseAdminAssignmentReceipt(r.receipt, actor, input);
  return Object.freeze({ version: 'admin-fulfillment-assignment-journal-v1', actor_id: actor, order_id: order,
    input, payload_hash, created_at: r.created_at, phase: r.phase, receipt });
}
export async function makeAssignmentIntent(actor: number, value: AdminAssignmentInput): Promise<AssignmentIntent> {
  const input = captureAdminAssignment(value), uid = assignmentId(actor);
  return parseAssignmentIntent({ version: 'admin-fulfillment-assignment-journal-v1', actor_id: uid, order_id: input.order_id,
    input, payload_hash: await adminAssignmentHash(input, uid), created_at: Date.now(), phase: 'pending', receipt: null }, uid, input.order_id);
}
export async function readAssignmentIntent(actor: number, order: number): Promise<{ raw: string | null; intent: AssignmentIntent | null }> {
  const raw = localStorage.getItem(assignmentIntentKey(actor, order));
  if (raw === null) return { raw, intent: null }; if (raw.length > 16384) throw Error('原分配请求记录超出容量，请保留并人工核对');
  return { raw, intent: await parseAssignmentIntent(JSON.parse(raw), actor, order) };
}
/** Called under the entity Web Lock. Recorded tombstones fence older tabs. */
export async function writeAssignmentIntent(value: AssignmentIntent, expectedRaw: string | null, active: () => boolean = () => true): Promise<string> {
  const plain = assignmentSnapshot(value, 16384) as AssignmentIntent;
  const captured = await parseAssignmentIntent(plain, plain.actor_id, plain.order_id), key = assignmentIntentKey(captured.actor_id, captured.order_id);
  if (!active()) throw Error('登录或页面已变化，保留原请求后重新打开');
  if (localStorage.getItem(key) !== expectedRaw) throw Error('另一标签页更新了原分配请求，请重新读取');
  const raw = JSON.stringify(captured); localStorage.setItem(key, raw);
  if (localStorage.getItem(key) !== raw) throw Error('原分配请求未可靠保存，尚未提交'); return raw;
}
export async function assignmentIntentOrders(actor: number): Promise<number[]> {
  const start = prefix + assignmentId(actor) + ':', ids: number[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i); if (!key?.startsWith(start)) continue;
    const tail = key.slice(start.length); if (!/^[1-9][0-9]{0,9}$/u.test(tail)) throw Error('本机分配记录索引损坏，请人工核对');
    ids.push(assignmentId(Number(tail))); if (ids.length > 100) throw Error('本机分配记录较多，请从原订单地址恢复');
  }
  const pending: number[] = [];
  for (const order of ids.sort((a,b) => a-b)) if ((await readAssignmentIntent(actor, order)).intent?.phase === 'pending') pending.push(order);
  return pending;
}
export async function withAssignmentIntentLock<T>(order: number, work: () => Promise<T>): Promise<T> {
  const id = assignmentId(order), locks = typeof navigator === 'undefined' ? undefined : (navigator as unknown as { locks?: {
    request<R>(name: string, options: { mode: 'exclusive'; ifAvailable: true }, callback: (lock: object | null) => Promise<R>): Promise<R>;
  } }).locks;
  if (!locks?.request) throw Error('当前浏览器不支持安全的跨标签操作，请使用支持 Web Locks 的浏览器');
  return locks.request('admin-fulfillment-assignment:' + id, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw Error('另一标签页正在核对本订单，请稍后重新读取'); return work();
  });
}
