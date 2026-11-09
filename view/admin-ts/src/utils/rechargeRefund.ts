/** Recharge refunds have their own body/key namespace. Local state is a
 * recovery aid; only authenticated server receipts establish an outcome. */
export const rechargeRefundVersion = 'admin-recharge-refund-v1' as const;
export interface RechargeRefundBody { version: typeof rechargeRefundVersion; rechargeId: number; quoteFingerprint: string; recoverGift: boolean }
export interface RechargeRefundOption { recoverGift: boolean; sufficient: boolean; principal: string; gift: string; walletDebitCents: number; availableBalance: string; postBalance: string; quoteFingerprint: string }
export interface RechargeRefundQuote { version: typeof rechargeRefundVersion; rechargeId: number; orderNo: string; buyerUid: number; options: RechargeRefundOption[] }
export interface RechargeRefundReceipt {
  version: typeof rechargeRefundVersion; operationId: string; rechargeId: number; requestHash: string; recoverGift: boolean | null;
  admission: 'reserved' | 'rejected_insufficient' | 'abandoned'; principal: string | null; gift: string | null;
  walletDebitCents: number | null; balanceBefore: string | null; postBalance: string | null; createdAt: number;
}
export type RechargeRefundPhase = 'not_requested' | 'awaiting_provider' | 'awaiting_local' | 'succeeded' | 'released' | 'cancelled' | 'manual_review' | 'rejected_insufficient' | 'abandoned';
export interface RechargeRefundExecution { operationId: string; phase: RechargeRefundPhase; wallet: 'held' | 'captured' | 'released' | 'none'; attemptCount: number; nextQueryAt: number | null }
export interface RechargeRefundView { receipt: RechargeRefundReceipt; execution: RechargeRefundExecution }
export interface RechargeRefundIntent {
  format: 1; actorId: number; rechargeId: number; key: string; createdAt: number;
  body: RechargeRefundBody | null; requestHash: string | null; review: RechargeRefundOption | null;
  orderNo: string | null; buyerUid: number | null; view: RechargeRefundView | null;
}
const fail = (): never => { throw Error('原充值退款记录或回执无效，请保留原请求并人工核对'); };
const integer = (v: unknown, min = 1): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= 2147483647 && !Object.is(v, -0);
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
function object(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail();
  const ds = Object.getOwnPropertyDescriptors(v);
  if (Reflect.ownKeys(ds).length !== keys.length || keys.some(k => !ds[k]?.enumerable || !('value' in ds[k]))) return fail();
  return Object.fromEntries(keys.map(k => [k, ds[k].value]));
}
const cents = (v: unknown, signed = false): bigint => {
  if (typeof v !== 'string' || !(signed ? /^-?(?:0|[1-9]\d{0,9})\.\d{2}$/u : /^(?:0|[1-9]\d{0,9})\.\d{2}$/u).test(v) || v === '-0.00') return fail();
  return BigInt(v.replace('.', ''));
};
const text = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,100}$/u.test(v);
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}';
}
export function parseRechargeRefundBody(raw: unknown): RechargeRefundBody {
  const r = object(raw, ['version', 'rechargeId', 'quoteFingerprint', 'recoverGift']);
  if (r.version !== rechargeRefundVersion || !integer(r.rechargeId) || !hex(r.quoteFingerprint) || typeof r.recoverGift !== 'boolean') return fail();
  return { version: rechargeRefundVersion, rechargeId: r.rechargeId, quoteFingerprint: r.quoteFingerprint, recoverGift: r.recoverGift };
}
function option(raw: unknown): RechargeRefundOption {
  const r = object(raw, ['recoverGift', 'sufficient', 'principal', 'gift', 'walletDebitCents', 'availableBalance', 'postBalance', 'quoteFingerprint']);
  const principal = cents(r.principal), gift = cents(r.gift), available = cents(r.availableBalance, true), post = cents(r.postBalance, true);
  if (principal <= 0n || typeof r.recoverGift !== 'boolean' || typeof r.sufficient !== 'boolean' || !hex(r.quoteFingerprint)
    || typeof r.walletDebitCents !== 'number' || !Number.isSafeInteger(r.walletDebitCents) || r.walletDebitCents <= 0) return fail();
  const debit = principal + (r.recoverGift ? gift : 0n), enough = available >= debit;
  if (BigInt(r.walletDebitCents) !== debit || r.sufficient !== enough || post !== (enough ? available - debit : available)) return fail();
  return r as unknown as RechargeRefundOption;
}
export function parseRechargeRefundQuote(raw: unknown, rechargeId: number): RechargeRefundQuote {
  const r = object(raw, ['version', 'rechargeId', 'orderNo', 'buyerUid', 'options']);
  if (r.version !== rechargeRefundVersion || !integer(rechargeId) || r.rechargeId !== rechargeId || !text(r.orderNo) || !integer(r.buyerUid)
    || !Array.isArray(r.options) || r.options.length !== 2 || Reflect.ownKeys(r.options).length !== 3) return fail();
  const options = [0, 1].map(i => { const d = Object.getOwnPropertyDescriptor(r.options, String(i)); if (!d || !('value' in d)) return fail(); return option(d.value); });
  if (options[0].recoverGift !== false || options[1].recoverGift !== true || options[0].principal !== options[1].principal
    || options[0].gift !== options[1].gift || options[0].availableBalance !== options[1].availableBalance) return fail();
  return { version: rechargeRefundVersion, rechargeId, orderNo: r.orderNo, buyerUid: r.buyerUid, options };
}
export async function rechargeRefundHash(actorId: number, body: RechargeRefundBody): Promise<string> {
  if (!integer(actorId)) return fail();
  const data = { adminId: actorId, ...parseRechargeRefundBody(body) };
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(data)));
  return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
}
function receipt(raw: unknown, intent: RechargeRefundIntent): RechargeRefundReceipt {
  const r = object(raw, ['version', 'operationId', 'rechargeId', 'requestHash', 'recoverGift', 'admission', 'principal', 'gift', 'walletDebitCents', 'balanceBefore', 'postBalance', 'createdAt']);
  if (r.version !== rechargeRefundVersion || !uuid(r.operationId) || r.rechargeId !== intent.rechargeId || !hex(r.requestHash) || !integer(r.createdAt)
    || intent.requestHash !== null && r.requestHash !== intent.requestHash) return fail();
  if (r.admission === 'abandoned') {
    if (['recoverGift', 'principal', 'gift', 'walletDebitCents', 'balanceBefore', 'postBalance'].some(k => r[k] !== null)) return fail();
  } else {
    if (!['reserved', 'rejected_insufficient'].includes(String(r.admission)) || typeof r.recoverGift !== 'boolean'
      || typeof r.walletDebitCents !== 'number' || !Number.isSafeInteger(r.walletDebitCents) || r.walletDebitCents <= 0) return fail();
    const principal = cents(r.principal), gift = cents(r.gift), before = cents(r.balanceBefore, true), post = cents(r.postBalance, true);
    const debit = principal + (r.recoverGift ? gift : 0n);
    if (principal <= 0n || debit !== BigInt(r.walletDebitCents) || r.admission === 'reserved' && (before < debit || post !== before - debit)
      || r.admission === 'rejected_insufficient' && (before >= debit || post !== before)) return fail();
    if (intent.body && r.recoverGift !== intent.body.recoverGift) return fail();
    if (intent.review && (r.principal !== intent.review.principal || r.gift !== intent.review.gift || r.walletDebitCents !== intent.review.walletDebitCents
      || r.balanceBefore !== intent.review.availableBalance || r.postBalance !== intent.review.postBalance)) return fail();
  }
  return r as unknown as RechargeRefundReceipt;
}
function execution(raw: unknown, r: RechargeRefundReceipt): RechargeRefundExecution {
  const e = object(raw, ['operationId', 'phase', 'wallet', 'attemptCount', 'nextQueryAt']);
  if (e.operationId !== r.operationId || !integer(e.attemptCount, 0) || e.attemptCount > 64) return fail();
  if (r.admission !== 'reserved') {
    if (e.phase !== (r.admission === 'abandoned' ? 'abandoned' : 'rejected_insufficient') || e.wallet !== 'none' || e.attemptCount !== 0 || e.nextQueryAt !== null) return fail();
  } else {
    const p = e.phase;
    if (!['not_requested', 'awaiting_provider', 'awaiting_local', 'succeeded', 'released', 'cancelled', 'manual_review'].includes(String(p))) return fail();
    if (e.wallet !== (p === 'succeeded' ? 'captured' : p === 'released' || p === 'cancelled' ? 'released' : 'held')
      || (p === 'not_requested' || p === 'cancelled' ? e.attemptCount !== 0 : e.attemptCount < 1)
      || (p === 'awaiting_provider' ? !integer(e.nextQueryAt) : e.nextQueryAt !== null)) return fail();
  }
  return e as unknown as RechargeRefundExecution;
}
export function parseRechargeRefundView(raw: unknown, intent: RechargeRefundIntent): RechargeRefundView | null {
  if (raw === null) return null;
  // The optional recovery result is private orchestration detail, not a UI
  // authority or a replacement for the complete receipt/execution pair.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  const keys = Object.keys(raw); if (keys.some(k => !['receipt', 'execution', 'replayed', 'recovery'].includes(k))) return fail();
  const r = object(raw, keys); if (!Object.hasOwn(r, 'receipt') || !Object.hasOwn(r, 'execution') || Object.hasOwn(r, 'replayed') && typeof r.replayed !== 'boolean') return fail();
  const proof = receipt(r.receipt, intent), state = execution(r.execution, proof);
  return { receipt: proof, execution: state };
}
export function rechargeRefundTerminal(view: RechargeRefundView | null): boolean {
  return !!view && ['succeeded', 'released', 'cancelled', 'rejected_insufficient', 'abandoned'].includes(view.execution.phase);
}
export function rechargeRefundRetryable(view: RechargeRefundView | null): boolean {
  return !!view && ['released', 'cancelled', 'rejected_insufficient', 'abandoned'].includes(view.execution.phase);
}
export function parseRechargeRefundIntent(raw: unknown, actorId: number, rechargeId: number): RechargeRefundIntent {
  const r = object(raw, ['format', 'actorId', 'rechargeId', 'key', 'createdAt', 'body', 'requestHash', 'review', 'orderNo', 'buyerUid', 'view']);
  if (r.format !== 1 || !integer(actorId) || !integer(rechargeId) || r.actorId !== actorId || r.rechargeId !== rechargeId || !uuid(r.key) || !integer(r.createdAt)) return fail();
  const body = r.body === null ? null : parseRechargeRefundBody(r.body), review = r.review === null ? null : option(r.review);
  if (body ? body.rechargeId !== rechargeId || !hex(r.requestHash) || !review || review.quoteFingerprint !== body.quoteFingerprint || review.recoverGift !== body.recoverGift
    || !text(r.orderNo) || !integer(r.buyerUid) : r.requestHash !== null || r.review !== null || r.orderNo !== null || r.buyerUid !== null) return fail();
  const intent: RechargeRefundIntent = { format: 1, actorId, rechargeId, key: r.key, createdAt: r.createdAt, body, requestHash: r.requestHash as string | null,
    review, orderNo: r.orderNo as string | null, buyerUid: r.buyerUid as number | null, view: null };
  intent.view = parseRechargeRefundView(r.view, intent); return intent;
}
export async function verifyRechargeRefundIntent(raw: unknown, actorId: number, rechargeId: number) {
  const intent = parseRechargeRefundIntent(raw, actorId, rechargeId);
  if (intent.body && await rechargeRefundHash(actorId, intent.body) !== intent.requestHash) return fail(); return intent;
}
export async function makeRechargeRefundIntent(actorId: number, quote: RechargeRefundQuote, recoverGift: boolean) {
  const q = parseRechargeRefundQuote(quote, quote.rechargeId), selected = q.options.find(o => o.recoverGift === recoverGift); if (!selected || !integer(actorId)) return fail();
  const body: RechargeRefundBody = { version: rechargeRefundVersion, rechargeId: q.rechargeId, quoteFingerprint: selected.quoteFingerprint, recoverGift };
  return parseRechargeRefundIntent({ format: 1, actorId, rechargeId: q.rechargeId, key: crypto.randomUUID(), createdAt: Math.floor(Date.now() / 1000), body,
    requestHash: await rechargeRefundHash(actorId, body), review: selected, orderNo: q.orderNo, buyerUid: q.buyerUid, view: null }, actorId, q.rechargeId);
}
export function recoverRechargeRefundIntent(actorId: number, rechargeId: number, key: string): RechargeRefundIntent {
  return parseRechargeRefundIntent({ format: 1, actorId, rechargeId, key: key.trim().toLowerCase(), createdAt: Math.floor(Date.now() / 1000),
    body: null, requestHash: null, review: null, orderNo: null, buyerUid: null, view: null }, actorId, rechargeId);
}
export function applyRechargeRefundView(intent: RechargeRefundIntent, view: RechargeRefundView | null) {
  if (intent.view) {
    if (!view || !same(view.receipt, intent.view.receipt) || view.execution.attemptCount < intent.view.execution.attemptCount
      || rechargeRefundTerminal(intent.view) && !same(view.execution, intent.view.execution)) return fail();
  }
  return parseRechargeRefundIntent({ ...intent, view }, intent.actorId, intent.rechargeId);
}
export function applyRechargeRefundAbandonment(intent: RechargeRefundIntent, raw: unknown) {
  const r = object(raw, ['version', 'receipt']); if (r.version !== rechargeRefundVersion) return fail(); const proof = receipt(r.receipt, intent);
  if (proof.admission === 'reserved') { if (intent.view && !same(intent.view.receipt, proof)) return fail(); return intent; }
  return applyRechargeRefundView(intent, { receipt: proof, execution: { operationId: proof.operationId,
    phase: proof.admission === 'abandoned' ? 'abandoned' : 'rejected_insufficient', wallet: 'none', attemptCount: 0, nextQueryAt: null } });
}
export function rechargeRefundStorageKey(actorId: number, rechargeId: number) {
  if (!integer(actorId) || !integer(rechargeId)) return fail(); return `admin-recharge-refund-v1:${actorId}:${rechargeId}`;
}
export async function readRechargeRefundIntent(actorId: number, rechargeId: number) {
  const key = rechargeRefundStorageKey(actorId, rechargeId), raw = localStorage.getItem(key);
  if (raw !== null && new TextEncoder().encode(raw).byteLength > 16384) return fail();
  const intent = raw === null ? null : await verifyRechargeRefundIntent(JSON.parse(raw), actorId, rechargeId);
  if (raw !== localStorage.getItem(key)) throw Error('另一标签页已更新原申请，请重新读取'); return { raw, intent };
}
/** Caller holds the entity Web Lock and rechecks the sticky session after
 * each await. The original key remains a tombstone, including terminal states. */
export function writeRechargeRefundIntent(intent: RechargeRefundIntent, expectedRaw: string | null) {
  const key = rechargeRefundStorageKey(intent.actorId, intent.rechargeId), value = JSON.stringify(parseRechargeRefundIntent(intent, intent.actorId, intent.rechargeId));
  if (new TextEncoder().encode(value).byteLength > 16384) return fail();
  if (localStorage.getItem(key) !== expectedRaw) throw Error('另一标签页已更新原申请，请重新读取');
  if (expectedRaw !== null) {
    const prior = parseRechargeRefundIntent(JSON.parse(expectedRaw), intent.actorId, intent.rechargeId);
    if (prior.key !== intent.key) {
      if (!rechargeRefundRetryable(prior.view)) return fail();
      const archive = key + ':' + prior.key, saved = localStorage.getItem(archive);
      if (saved !== null && saved !== expectedRaw) return fail(); localStorage.setItem(archive, expectedRaw);
      if (localStorage.getItem(archive) !== expectedRaw) return fail();
    } else {
      if (!same(prior.body, intent.body) || prior.requestHash !== intent.requestHash || !same(prior.review, intent.review)
        || prior.orderNo !== intent.orderNo || prior.buyerUid !== intent.buyerUid || prior.createdAt !== intent.createdAt) return fail();
      applyRechargeRefundView(prior, intent.view);
    }
  }
  localStorage.setItem(key, value); if (localStorage.getItem(key) !== value) throw Error('原申请未能保存，禁止提交'); return value;
}
export async function withRechargeRefundLock<T>(rechargeId: number, work: () => Promise<T>): Promise<T> {
  if (!integer(rechargeId)) return fail();
  const locks = typeof navigator === 'undefined' ? undefined : (navigator as unknown as { locks?: {
    request<R>(name: string, options: { mode: 'exclusive'; ifAvailable: true }, callback: (lock: { name: string } | null) => Promise<R>): Promise<R>;
  } }).locks;
  if (!locks?.request) throw Error('当前浏览器不支持跨标签页退款保护，请使用支持 Web Locks 的浏览器');
  return locks.request('admin-recharge-refund:' + rechargeId, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw Error('另一标签页正在处理这笔充值，请稍后读取原申请'); return work();
  });
}
export function rechargeRefundStatus(view: RechargeRefundView | null): string {
  if (!view) return '尚未确认受理结果，请保留原申请';
  return ({ not_requested: '已预留余额，尚未派发退款', awaiting_provider: '渠道结果待确认', awaiting_local: '渠道结果已留存，结算待完成',
    succeeded: '退款成功', released: '渠道已关闭，预留余额已退回', cancelled: '已撤销未派发退款，预留余额已退回', manual_review: '需人工核对，请勿重复申请',
    rejected_insufficient: '余额不足，申请已拒绝，请人工处理', abandoned: '未受理申请已封存' } as Record<RechargeRefundPhase, string>)[view.execution.phase];
}
