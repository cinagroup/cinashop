import { computed, ref } from 'vue';
import { createOrdinaryCashierRequests, type OrdinaryCashierRequests, type OrdinaryCashierDraftInput,
  type OrdinaryCashierIntent, type OrdinaryCashierRead } from '@/api/customerWorkOrdinaryCashier';
import { customerWorkRequestKey } from '@/utils/customerWorkFulfillment';
import { customerWorkCanonicalJson } from '../../../common/customerWorkIntent';
import { customerWorkRecord } from '@/utils/customerWork';
import { isOrdinaryQuoteData } from '@/utils/customerWorkOrdinaryCashierRead';
import { isOrdinaryDraftSnapshot, makeOrdinaryCashierPending, makeOrdinaryCreationQuote, ordinaryCashierPending,
  retainOrdinaryCashierPending, releaseOrdinaryCashierPending, parseOrdinaryCashierRead, parseOrdinaryCashierResult,
  parseOrdinaryCashierOperation, type OrdinaryCashierBody, type OrdinaryCashierKind, type OrdinaryCashierPending,
  type OrdinaryCashierReceipt, type OrdinaryDraftSnapshot, type OrdinaryPaymentSource } from '@/utils/customerWorkOrdinaryCashier';
import type { CustomerWorkController } from './useCustomerWork';

const base = '/mobile/work/cashier/ordinary';
interface OrdinaryReadiness { writes: boolean; reason: string; product_types: [0]; max_rows: 200;
  payments: { cash: boolean; zero: boolean; weixin: false; alipay: false } }
interface RecoveryState { checked: boolean; receipt: OrdinaryCashierReceipt | null; error: string }
function assert(v: unknown, message: string): asserts v { if (!v) throw Error(message); }
function readiness(v: unknown): v is OrdinaryReadiness {
  return customerWorkRecord(v) && typeof v.writes === 'boolean' && typeof v.reason === 'string' && v.reason.length <= 1000
    && Array.isArray(v.product_types) && v.product_types.length === 1 && v.product_types[0] === 0 && v.max_rows === 200
    && customerWorkRecord(v.payments) && v.payments.cash === v.writes && v.payments.zero === v.writes
    && v.payments.weixin === false && v.payments.alipay === false;
}
function draftRead(v: unknown): v is { draft: OrdinaryDraftSnapshot; readiness: { writes: boolean; reason: string } } {
  return customerWorkRecord(v) && isOrdinaryDraftSnapshot(v.draft) && customerWorkRecord(v.readiness)
    && typeof v.readiness.writes === 'boolean' && typeof v.readiness.reason === 'string';
}
const confirm = (title: string, content: string) => new Promise<boolean>(resolve => uni.showModal({ title, content,
  success: result => resolve(result.confirm === true), fail: () => resolve(false) }));
export function useCustomerOrdinaryCashier(manager: CustomerWorkController) {
  const busy = ref(false), error = ref(''), draft = ref<OrdinaryDraftSnapshot | null>(null);
  const gate = ref<OrdinaryReadiness | null>(null), pending = ref<OrdinaryCashierPending[]>([]);
  const states = ref<Record<string, RecoveryState>>({});
  const quotation = ref<OrdinaryCashierPending | null>(null), created = ref<OrdinaryCashierReceipt | null>(null), payment = ref<OrdinaryCashierReceipt | null>(null);
  const requests = new Set<OrdinaryCashierRequests>();
  let epoch = 0;
  function refreshPending() {
    try { pending.value = ordinaryCashierPending().filter(row => row.actor_uid === manager.auth.uid); }
    catch (failure) { pending.value = []; error.value = failure instanceof Error ? failure.message : '原收银记录无法读取'; throw failure; }
  }
  function clearDomain() {
    epoch++; for (const r of [...requests]) r.abort(); requests.clear();
    busy.value = false; error.value = ''; gate.value = null; draft.value = null; quotation.value = null; created.value = null; payment.value = null; states.value = {}; pending.value = [];
    try { refreshPending(); } catch { /* Keep damaged durable records for verification. */ }
  }
  const unresolved = computed(() => pending.value.some(row => !states.value[row.request_key]?.receipt));
  const canWrite = computed(() => manager.context.value?.data.capabilities.cashier_ordinary === true
    && manager.context.value.data.cashier_ordinary_readiness?.writes === true && gate.value?.writes === true && !busy.value && !unresolved.value);
  function authority() {
    const context = manager.context.value;
    assert(manager.current() && context && context.actor_uid === manager.auth.uid && manager.auth.isLoggedIn, '请重新读取原经营身份');
    return context;
  }
  function scope(recovery = false): OrdinaryCashierRequests {
    const version = epoch, context = recovery ? null : authority();
    const r = createOrdinaryCashierRequests(() => manager.current() && epoch === version && (recovery || (!!context
      && manager.context.value?.scope_key === context.scope_key && manager.context.value.principal.service_id === context.principal.service_id)));
    requests.add(r); return r;
  }
  function closeScope(r: OrdinaryCashierRequests) { requests.delete(r); r.abort(); }
  function writes() { refreshPending(); assert(canWrite.value, '普通收银暂不可提交，请先核对经营资格和所有原请求'); return authority(); }
  function currentRead<T>(response: OrdinaryCashierRead<T>) {
    const context = authority();
    assert(response.actor_uid === manager.auth.uid && response.scope_key === context.scope_key
      && response.principal.service_id === context.principal.service_id, '读取结果已不属于当前经营账号');
  }
  function failed(r: OrdinaryCashierRequests, failure: unknown, original?: OrdinaryCashierPending) {
    if (!r.active()) return;
    const message = failure instanceof Error ? failure.message : '普通收银结果未确认，请查询原编号';
    error.value = message;
    if (original) states.value[original.request_key] = { checked: false, receipt: null, error: message };
  }
  async function read<T>(suffix: string, guard: (value: unknown) => value is T, data: Record<string, unknown> = {}): Promise<OrdinaryCashierRead<T>> {
    const context = authority(), r = scope();
    try {
      const value = parseOrdinaryCashierRead(await r.request(`${base}${suffix}`, 'GET', { ...data, scope_key: context.scope_key }), r.owner.uid, context, guard);
      assert(r.active(), '账号或经营身份已变化'); return value;
    } finally { closeScope(r); }
  }
  async function load() {
    const response = await read('/readiness', readiness);
    currentRead(response);
    gate.value = response.data; refreshPending();
  }
  async function readDraft(key: string) {
    const response = await read(`/drafts/${key}`, draftRead);
    currentRead(response);
    assert(response.data.draft.actor_uid === manager.auth.uid && response.data.draft.draft_key === key
      && response.data.draft.scope_key === response.scope_key, '原完整购物车与经营身份不匹配');
    draft.value = response.data.draft; quotation.value = null; return response.data.draft;
  }
  async function query(r: OrdinaryCashierRequests, original: OrdinaryCashierPending): Promise<OrdinaryCashierReceipt | null> {
    assert(r.owner.uid === original.actor_uid, '请登录原经营账号核对收银编号');
    const receipt = parseOrdinaryCashierOperation(await r.request(`${base}/operations/${original.request_key}`), original);
    assert(r.active(), '页面或原经营账号已变化');
    states.value[original.request_key] = { checked: true, receipt, error: receipt ? '' : '原编号尚无回执，请继续核对；这不代表原请求未入账' };
    if (receipt?.kind === 'creation') { created.value = receipt; draft.value = null; quotation.value = null; }
    if (receipt?.kind === 'payment') payment.value = receipt;
    return receipt;
  }
  async function check(original: OrdinaryCashierPending) {
    if (busy.value || !manager.current()) return null;
    const r = scope(true); busy.value = true; error.value = '';
    try { return await query(r, original); }
    catch (failure) { failed(r, failure, original); return null; }
    finally { if (r.active()) busy.value = false; closeScope(r); }
  }
  function requestFor(original: OrdinaryCashierPending): { path: string; body: Record<string, unknown> } {
    if (original.kind === 'draft') return { path: `${base}/drafts`, body: { ...original.body } };
    if (original.kind === 'creation') return { path: `${base}/orders`, body: { intent: original.body, quote_token: original.quote!.quote_token } };
    if (original.kind === 'payment') return { path: `${base}/orders/${(original.body as { order_id: number }).order_id}/cash`, body: { ...original.body } };
    const input = original.body as { draft_key: string };
    return { path: `${base}/drafts/${input.draft_key}/${original.kind === 'append' ? 'rows' : original.kind}`, body: { ...original.body } };
  }
  async function submit(r: OrdinaryCashierRequests, original: OrdinaryCashierPending) {
    assert(r.active(), '原收银页面已变化');
    const context = authority(); refreshPending();
    assert(context.data.capabilities.cashier_ordinary === true && context.data.cashier_ordinary_readiness?.writes === true && gate.value?.writes === true
      && !unresolved.value && original.actor_uid === r.owner.uid && original.body.scope_key === context.scope_key
      && original.service_id === context.principal.service_id, '原请求或经营资格已变化，请先核对');
    retainOrdinaryCashierPending(original); refreshPending();
    states.value[original.request_key] = { checked: false, receipt: null, error: '' };
    const command = requestFor(original); let feedbackFailure: unknown;
    try { parseOrdinaryCashierResult(await r.request(command.path, 'POST', command.body, original.request_key), original); }
    catch (failure) { feedbackFailure = failure; }
    if (!r.active()) return null;
    const receipt = await query(r, original);
    if (!receipt) error.value = feedbackFailure instanceof Error ? feedbackFailure.message : '原收银结果尚未确认，请继续查询原编号';
    quotation.value = null;
    if (receipt && ['draft', 'append', 'quantity', 'remove'].includes(receipt.kind)) await readDraft((receipt.evidence.draft as OrdinaryDraftSnapshot).draft_key);
    return receipt;
  }
  async function change(kind: Exclude<OrdinaryCashierKind, 'creation' | 'payment'>, body: OrdinaryCashierBody) {
    if (busy.value) return null;
    const context = writes(), r = scope(); busy.value = true; error.value = '';
    let original: OrdinaryCashierPending | undefined;
    try {
      const frozen = JSON.parse(customerWorkCanonicalJson(body)), before = kind === 'draft' ? null : draft.value;
      assert(frozen.scope_key === context.scope_key, '原收银内容不属于当前经营范围');
      const key = await customerWorkRequestKey(); assert(r.active(), '原经营身份已变化');
      original = makeOrdinaryCashierPending(r.owner.uid, context.principal.service_id, key, kind, frozen, before);
      return await submit(r, original);
    } catch (failure) { failed(r, failure, original); return null; }
    finally { if (r.active()) busy.value = false; closeScope(r); }
  }
  const beginDraft = (body: OrdinaryCashierDraftInput) => change('draft', body);
  const append = (rows: OrdinaryCashierDraftInput['rows']) => {
    assert(draft.value, '请先核对原购物车'); return change('append', { version: draft.value.version, scope_key: draft.value.scope_key,
      draft_key: draft.value.draft_key, draft_hash: draft.value.draft_hash, rows });
  };
  const quantity = (cartId: number, value: number) => {
    assert(draft.value, '请先核对原购物车'); return change('quantity', { version: draft.value.version, scope_key: draft.value.scope_key,
      draft_key: draft.value.draft_key, draft_hash: draft.value.draft_hash, cart_id: cartId, quantity: value });
  };
  const remove = (ids: readonly number[]) => {
    assert(draft.value, '请先核对原购物车'); return change('remove', { version: draft.value.version, scope_key: draft.value.scope_key,
      draft_key: draft.value.draft_key, draft_hash: draft.value.draft_hash, cart_ids: ids });
  };
  async function prepareQuote(input: OrdinaryCashierIntent) {
    if (busy.value) return null;
    const context = writes(), r = scope(); busy.value = true; error.value = ''; quotation.value = null;
    try {
      assert(draft.value, '请先建立并核对完整购物车');
      const body = JSON.parse(customerWorkCanonicalJson(input)), before = JSON.parse(customerWorkCanonicalJson(draft.value));
      assert(body.scope_key === context.scope_key, '原下单内容不属于当前经营范围');
      const key = await customerWorkRequestKey(); assert(r.active(), '原经营身份已变化');
      const value = await r.request(`${base}/quote`, 'POST', { request_key: key, intent: body });
      assert(r.active(), '原经营身份已变化');
      parseOrdinaryCashierRead(value, r.owner.uid, context, isOrdinaryQuoteData);
      const quote = makeOrdinaryCreationQuote(value, r.owner.uid, context.principal.service_id, key, body, before);
      quotation.value = makeOrdinaryCashierPending(r.owner.uid, context.principal.service_id, key, 'creation', body, before, null, quote);
      return quotation.value;
    } catch (failure) { failed(r, failure); return null; }
    finally { if (r.active()) busy.value = false; closeScope(r); }
  }
  async function create() {
    if (busy.value || !quotation.value) return null;
    const context = writes(), r = scope(), original = JSON.parse(customerWorkCanonicalJson(quotation.value)) as OrdinaryCashierPending;
    busy.value = true; error.value = '';
    try {
      assert(context.scope_key === original.body.scope_key && context.principal.service_id === original.service_id && original.quote,
        '原实际报价与经营资格不匹配');
      assert(Date.now() < original.quote.expires_at * 1000, '实际报价已过期，请重新核对');
      if (!await confirm('确认创建普通商品订单', `实际应付 ¥${original.quote.amount}，包含 ${original.quote.quantity} 件商品。创建订单会扣减实际库存，现金付款另行确认。`) || !r.active()) return null;
      assert(customerWorkCanonicalJson(quotation.value) === customerWorkCanonicalJson(original)
        && customerWorkCanonicalJson(draft.value) === customerWorkCanonicalJson(original.draft), '报价或购物行已变化，请重新核对');
      assert(Date.now() < original.quote.expires_at * 1000, '实际报价已过期，请重新核对');
      return await submit(r, original);
    } catch (failure) { failed(r, failure, original); return null; }
    finally { if (r.active()) busy.value = false; closeScope(r); }
  }
  async function pay(source: OrdinaryPaymentSource) {
    if (busy.value) return null;
    const context = writes(), r = scope(); busy.value = true; error.value = ''; let original: OrdinaryCashierPending | undefined;
    try {
      const frozen = JSON.parse(customerWorkCanonicalJson(source));
      if (!await confirm(source.amount === '0.00' ? '确认零元订单' : '确认现金已收款', source.amount === '0.00'
        ? `确认记录订单 ${source.order_no} 的真实零元付款。` : `订单 ${source.order_no} 应付 ¥${source.amount}。确认已经收到现金后记录付款。`) || !r.active()) return null;
      const key = await customerWorkRequestKey(); assert(r.active(), '原经营身份已变化');
      original = makeOrdinaryCashierPending(r.owner.uid, context.principal.service_id, key, 'payment', {
        version: 'customer-cashier-ordinary-payment-v1', scope_key: context.scope_key, order_id: frozen.order_id,
        order_no: frozen.order_no, expected_amount: frozen.amount }, null, frozen);
      return await submit(r, original);
    } catch (failure) { failed(r, failure, original); return null; }
    finally { if (r.active()) busy.value = false; closeScope(r); }
  }
  async function abandon(original: OrdinaryCashierPending) {
    if (busy.value || !manager.current()) return null;
    const r = scope(true), frozen = JSON.parse(customerWorkCanonicalJson(original)) as OrdinaryCashierPending;
    busy.value = true; error.value = '';
    try {
      assert(frozen.actor_uid === r.owner.uid && ordinaryCashierPending().some(row => row.actor_uid === frozen.actor_uid
        && row.request_key === frozen.request_key && customerWorkCanonicalJson(row) === customerWorkCanonicalJson(frozen)), '请保留原经营账号的完整请求');
      const actual = await query(r, frozen);
      if (actual || !r.active()) return actual;
      if (!await confirm('永久放弃原收银请求', '原编号尚无回执。确认永久终止这份原请求；如果它已经入账，系统会返回真实结果，订单和付款仍需核对。') || !r.active()) return null;
      try { parseOrdinaryCashierResult(await r.request(`${base}/operations/${frozen.request_key}/abandon`, 'POST',
        { kind: frozen.kind, intent: frozen.body }, frozen.request_key), frozen); }
      catch { /* Recover a lost closure response using this same original UUID. */ }
      const receipt = await query(r, frozen);
      if (!receipt) error.value = '原请求终止结果未确认，请继续查询原编号';
      return receipt;
    } catch (failure) { failed(r, failure, frozen); return null; }
    finally { if (r.active()) busy.value = false; closeScope(r); }
  }
  function acknowledge(original: OrdinaryCashierPending) {
    assert(!busy.value && manager.current() && original.actor_uid === manager.auth.uid, '请在原经营账号核对后关闭记录');
    const state = states.value[original.request_key]; assert(state?.checked && state.receipt, '原结果尚未核对，不能关闭');
    releaseOrdinaryCashierPending(original, state.receipt); refreshPending(); delete states.value[original.request_key];
  }
  function clearQuotation() {
    assert(!busy.value, '请等待原报价或收银请求核对');
    quotation.value = null;
  }
  return { busy, error, draft, gate, pending, states, quotation, created, payment, unresolved, canWrite,
    refreshPending, clearDomain, clearQuotation, read, load, readDraft, beginDraft, append, quantity, remove, prepareQuote, create, pay, check, abandon, acknowledge };
}
