import { issueCheckoutConfirmation, readCheckoutConfirmation } from '@/services/order/CheckoutConfirmation';
import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { checkoutInvoiceInput, assertCheckoutInvoiceActor } from '@/services/order/CheckoutInvoice';
import { md5 } from '@/utils/jwt';
import { createCheckoutInvoice, initialCheckoutInvoice } from '../../view/common/checkoutInvoice';
import { CheckoutIntentJournal, decodeCheckoutIntent } from '../../view/common/checkoutIntent';
const { page, revision } = createRequire(import.meta.url)('../../view/common/test/buyerInvoiceFixture.cjs');
const deferred = <T>() => { let resolve!: (v: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve }; };
it('normalizes legacy/new title ids and rejects conflicting aliases', () => {
  expect(checkoutInvoiceInput({})).toEqual({ id: 0 });
  expect(checkoutInvoiceInput({ invoiceAlias: '00071' })).toEqual({ id: 71 });
  expect(checkoutInvoiceInput({ invoiceId: 71, invoiceAlias: '71', invoiceRevision: revision })).toEqual({ id: 71, revision });
  expect(() => checkoutInvoiceInput({ invoiceId: 71, invoiceAlias: 72 })).toThrow();
  expect(() => checkoutInvoiceInput({ invoiceId: 71, invoiceRevision: revision, invoiceRevisionAlias: 'b'.repeat(64) })).toThrow();
});
it.each([null, true, false, {}, [], -1, 1.5, 2147483648, '1e2', '-1', '', ' 1'])('rejects malformed invoice identifier %j', value => expect(() => checkoutInvoiceInput({ invoiceId: value })).toThrow());
it.each([null, false, {}, '', 'A'.repeat(64), 'a'.repeat(63)])('rejects malformed invoice revision %j', value => expect(() => checkoutInvoiceInput({ invoiceId: 71, invoiceRevision: value })).toThrow());
it('rejects orphan revisions and mismatched/expired admitted accounts', () => {
  expect(() => checkoutInvoiceInput({ invoiceRevision: revision })).toThrow();
  const account = { uid: 11, pwd: 'owned-local-password' }, actor = { uid: 11, authVersion: md5(account.pwd), expiresAt: Math.floor(Date.now()/1000)+60 };
  expect(() => assertCheckoutInvoiceActor(account, actor)).not.toThrow();
  for (const change of [{ uid: 22 }, { authVersion: 'old-password' }, { expiresAt: 1 }]) expect(() => assertCheckoutInvoiceActor(account, { ...actor, ...change })).toThrow();
  expect(() => assertCheckoutInvoiceActor(account, null)).toThrow();
});
function setup(read: (q: any) => Promise<unknown> = async q => page(q)) {
  const state = initialCheckoutInvoice(); let uid = 11, token = 'owned', live = true, editable = true;
  const flow = createCheckoutInvoice(state, { page: read, canEdit: () => editable,
    capture: () => { const u = uid, t = token; return { uid, token, current: () => live && uid === u && token === t }; } });
  return { state, flow, hide() { live = false; flow.clear(true); }, switch() { uid = 22; token = 'new'; flow.clear(); }, lock() { editable = false; } };
}
it('selects only current row objects, returns only id/revision and requires a new choice after refresh', async () => {
  const f = setup(); await f.flow.load(); expect(f.flow.options()).toEqual({});
  const title = f.flow.titles()[0]; f.flow.select({ ...title }); expect(f.flow.options()).toEqual({});
  f.flow.select(title); expect(f.flow.options()).toEqual({ invoiceId: 71, invoiceRevision: revision });
  expect(JSON.stringify(f.flow.options())).not.toMatch(/本机买家|13800000000|buyer@|cardNumber/);
  await f.flow.load(); expect(f.flow.ready()).toBe(false); expect(f.state.selected).toBeNull();
  f.flow.select(title); expect(f.flow.ready()).toBe(false); f.flow.select(null); expect(f.flow.ready()).toBe(true);
});
it.each(['hide', 'switch'] as const)('drops late private responses after %s', async ending => {
  const d = deferred<unknown>(), f = setup(() => d.promise); const loading = f.flow.load(); f[ending](); d.resolve(page()); await loading;
  expect(f.state.page).toBeNull(); expect(f.state.selected).toBeNull(); expect(f.flow.options()).toEqual({});
});
it('clears private fields on failed/foreign responses or disabled flags without silently cancelling an invoice request', async () => {
  let mode = 0; const f = setup(async q => { if (mode === 1) throw Error('owned unavailable'); return page(q, mode === 2 ? { uid: 22 } : mode === 3 ? { capabilities: { enabled: false, special: false } } : {}); });
  await f.flow.load(); f.flow.select(f.flow.titles()[0]);
  for (mode = 1; mode <= 3; mode++) { await f.flow.load(); expect(f.state.selected).toBeNull(); expect(f.flow.ready()).toBe(false); expect(f.flow.options()).toEqual({}); }
  f.flow.select(f.flow.titles()[0]); expect(f.flow.ready()).toBe(false); f.flow.select(null); expect(f.flow.ready()).toBe(true);
});
it('does not change a title while an order submission is locked', async () => {
  const f = setup(); await f.flow.load(); f.flow.select(f.flow.titles()[0]); f.lock(); f.flow.select(null); expect(f.state.required).toBe(true);
});
it('bounds pages and drops a selection when switching to another current title page', async () => {
  const requests: unknown[] = [], f = setup(async q => { requests.push(q.cursor); return page(q, { nextCursor: q.cursor ? null : 'next', items: Array.from({ length: 20 }, (_, n) => ({ ...page(q).items[0], id: (q.cursor ? 171 : 71) + n })) }); });
  await f.flow.load(); f.flow.select(f.flow.titles()[0]); await f.flow.next(); expect(f.flow.ready()).toBe(false); expect(f.flow.titles()[0].id).toBe(171);
  f.flow.select(f.flow.titles()[0]); await f.flow.back(); expect(f.flow.ready()).toBe(false); expect(requests).toEqual([null, 'next', null]);
});
it('journals exact same-key invoice retries using only id/revision and rejects private template fields', () => {
  const values = new Map<string,string>(), journal = new CheckoutIntentJournal({ get: k => values.get(k), set: (k,v) => { values.set(k,v); }, remove: k => { values.delete(k); } });
  const payload = { addressId: 0, shippingType: 1 as const, storeId: 0, couponId: 0, useIntegral: false, type: 0, invoiceId: 71, invoiceRevision: revision, cartIds: [1], mark: '', customForm: [] }, intent = journal.begin(11, 'checkout_invoice_retry', payload);
  expect(journal.assertCurrent(intent).payload).toEqual(payload); expect(() => journal.begin(11, 'another_invoice_retry', payload)).toThrow();
  for (const change of [{ invoiceRevision: undefined }, { invoiceId: 2147483648 }, { bank: 'private-field' }, { email: 'private-field' }]) expect(() => decodeCheckoutIntent(JSON.stringify({ ...intent, payload: { ...payload, ...change } }), 11)).toThrow();
  expect(JSON.stringify([...values.values()])).not.toContain('private-field');
});

it('retains invoice binding in the immutable server receipt and refuses malformed binding metadata', async () => {
  const values = new Map<string,string>(), store = { get: async (k:string) => values.get(k) ?? null, put: async (k:string,v:string) => { values.set(k,v); } }, scope = { uid:11,key:'checkout_invoice_receipt' };
  const old = await issueCheckoutConfirmation(store,scope,'b'.repeat(64)); expect((await readCheckoutConfirmation(store,scope,old)).invoiceSelection).toBeUndefined();
  const token = await issueCheckoutConfirmation(store,scope,'c'.repeat(64),{ id:71,revision }); expect((await readCheckoutConfirmation(store,scope,token)).invoiceSelection).toEqual({ id:71,revision });
  const key = [...values.keys()].find(k => k.endsWith(token))!, row = JSON.parse(values.get(key)!);
  for (const invoiceSelection of [null,{}, { id:72,revision:'invalid' },{ id:71,revision,uid:22 }]) { values.set(key,JSON.stringify({ ...row,invoiceSelection })); await expect(readCheckoutConfirmation(store,scope,token)).rejects.toThrow(); }
});
