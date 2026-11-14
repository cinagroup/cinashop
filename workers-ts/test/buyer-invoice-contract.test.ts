import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { buyerInvoiceDraft, buyerInvoiceQuery, parseBuyerInvoiceAck, parseBuyerInvoiceOrder, parseBuyerInvoicePage, parseBuyerInvoiceRecord, validateBuyerInvoiceDraft, type BuyerInvoiceQuery } from '../../view/common/buyerInvoices';
import { buyerInvoiceParameters, createBuyerInvoiceFlow, initialBuyerInvoiceFlow } from '../../view/common/buyerInvoiceFlow';
const { title, record, page, order } = createRequire(import.meta.url)('../../view/common/test/buyerInvoiceFixture.cjs');
const deferred = <T>() => { let resolve!: (v: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve }; };
const query = buyerInvoiceQuery('titles');

it('projects only invoice fields and binds pages, records and acknowledgements to their owner and request', () => {
  expect(parseBuyerInvoicePage(page(query, { privateAdmin: 'hidden' }), query, 11)).not.toHaveProperty('privateAdmin');
  expect(parseBuyerInvoiceRecord(record({ adminUser: 'hidden' }), 11)).not.toHaveProperty('adminUser');
  expect(parseBuyerInvoiceOrder(order(), 'invoice_order_A', 11).canApply).toBe(true);
  expect(parseBuyerInvoiceAck({ version: 1, uid: 11, action: 'save', id: 71 }, 'save', 11, 71).id).toBe(71);
});
it.each([
  { uid: 22 }, { query: { ...query, limit: 19 } }, { query: { ...query, cursor: 'wrong' } }, { items: [title({ uid: 22 })] },
  { items: [title(), title()] }, { items: [title({ revision: 'wrong' })] }, { capabilities: { enabled: false, special: true } }, { nextCursor: 'cycle' },
])('rejects a mismatched or malformed title page %j', change => expect(() => parseBuyerInvoicePage(page(query, change), query, 11)).toThrow());
it.each([{ product: { name: 'x', image: 'javascript:alert(1)' } }, { state: 2 }, { state: 0, remark: 'private merchant note' }, { amount: '1e3' }, { uid: 22 }, { orderNo: '../private' }])
  ('rejects unsafe record %j', change => expect(() => parseBuyerInvoiceRecord(record(change), 11)).toThrow());
it.each([{ uid: 22 }, { orderNo: 'other' }, { invoice: record({ orderId: 92 }) }, { canApply: true, amount: null }, { pid: -1 }, { status: 4 }, { capabilities: { enabled: false, special: false } }, { invoice: record() }])
  ('rejects contradictory eligibility or order binding %j', change => expect(() => parseBuyerInvoiceOrder(order(change), 'invoice_order_A', 11)).toThrow());
it('keeps zero legacy amounts unknown and displays refused notes only on refused records', () => {
  expect(parseBuyerInvoiceRecord(record({ amount: null }), 11).amount).toBeNull();
  expect(parseBuyerInvoiceRecord(record({ state: -1, remark: '请核对税号' }), 11).remark).toBe('请核对税号');
  expect(() => parseBuyerInvoicePage(page({ kind: 'records', cursor: null, limit: 20 }, { items: [record({ paid: false })] }), buyerInvoiceQuery('records'), 11)).toThrow();
});
it('normalizes personal/company drafts while requiring all special-invoice fields and forbidding authority fields', () => {
  expect(validateBuyerInvoiceDraft({ ...buyerInvoiceDraft(title()), dutyNumber: 'stale', bank: 'stale' })).toMatchObject({ dutyNumber: '', bank: '' });
  const company = { ...buyerInvoiceDraft(title()), headerType: 2, type: 2, name: '本机公司', dutyNumber: 'a'.repeat(18), bank: '本机银行', cardNumber: '123', address: '本机地址', tell: '010-00000000' };
  expect(validateBuyerInvoiceDraft(company).dutyNumber).toBe('A'.repeat(18));
  for (const change of [{ uid: 22 }, { drawerPhone: '' }, { email: '' }, { ...company, bank: '' }, { headerType: 1, type: 2 }])
    expect(() => validateBuyerInvoiceDraft({ ...buyerInvoiceDraft(title()), ...change })).toThrow();
});
it.each(['orderId=a&orderId=b', 'orderId=../x', 'orderId=a&other=1', ''])('rejects malformed invoice routes %s', raw => expect(() => buyerInvoiceParameters(new URLSearchParams(raw), true)).toThrow());

function setup(overrides: Record<string, any> = {}) {
  const state = initialBuyerInvoiceFlow(), calls: string[] = []; let current = true, uid = 11, token = 'owned';
  const flow = createBuyerInvoiceFlow(state, {
    capture: () => { const u = uid, t = token; return { uid, token, current: () => current && uid === u && token === t }; },
    page: async q => { calls.push('read-page'); return page(q); }, order: async () => { calls.push('read-order'); return order(); },
    save: async () => { calls.push('save'); return { version: 1, uid, action: 'save', id: 71 }; }, remove: async () => { calls.push('delete'); return { version: 1, uid, action: 'delete', id: 71 }; },
    setDefault: async () => ({ version: 1, uid, action: 'default', id: 71 }), apply: async () => { calls.push('apply'); return { version: 1, uid, action: 'apply', id: 81 }; }, confirm: async () => true, ...overrides,
  });
  flow.setRoute('invoice_order_A', true);
  return { state, flow, calls, hide() { current = false; flow.clear(); }, show() { current = true; }, switch() { uid = 22; token = 'new'; flow.clear(); } };
}
it('complete existing-order application copies the current versioned title and reads back immutable status', async () => {
  const f = setup(); await f.flow.load(); await f.flow.apply(f.flow.titles()[0]!);
  expect(f.calls).toEqual(['read-order', 'read-page', 'apply', 'read-order', 'read-page']); expect(f.state.message).toContain('开票申请已提交');
});
it('delayed deletion confirmation cannot act after a read generation or identity change', async () => {
  const confirm = deferred<boolean>(), f = setup({ confirm: () => confirm.promise }); await f.flow.load(); const old = f.flow.titles()[0]!;
  const wait = f.flow.remove(old); await f.flow.load(); confirm.resolve(true); await wait; expect(f.calls).not.toContain('delete');
});
it.each(['hide', 'switch'] as const)('late reads cannot repopulate private fields after %s', async ending => {
  const result = deferred<unknown>(), f = setup({ page: () => result.promise }); const wait = f.flow.load(); await Promise.resolve(); f[ending](); result.resolve(page()); await wait;
  expect(f.state.page).toBeNull(); expect(f.state.order).toBeNull(); expect(f.state.draft).toBeNull();
});
it('lost save acknowledgement does one write, clears the draft and reconciles through read-only requests', async () => {
  const f = setup({ save: async () => { f.calls.push('save'); throw Error('owned network loss'); } }); await f.flow.load(); f.flow.edit(f.flow.titles()[0]); await f.flow.save();
  expect(f.calls.filter(x => x === 'save')).toHaveLength(1); expect(f.state.draft).toBeNull(); expect(f.state.uncertain).toBe(false); expect(f.state.message).toContain('重新读取当前资料');
});
it('a hidden in-flight write blocks another write until its terminal result and a later read', async () => {
  const result = deferred<unknown>(), f = setup({ save: async () => { f.calls.push('save'); return result.promise; } }); await f.flow.load(); f.flow.edit(f.flow.titles()[0]); const wait = f.flow.save();
  f.hide(); f.show(); await f.flow.load(); expect(f.state.uncertain).toBe(true); f.flow.edit(); expect(f.state.draft).toBeNull();
  result.resolve({ version: 1, uid: 11, action: 'save', id: 71 }); await wait; expect(f.state.page).not.toBeNull(); await f.flow.load(); expect(f.state.uncertain).toBe(false); expect(f.calls.filter(x => x === 'save')).toHaveLength(1);
});
it('read failure clears all previously displayed data and a foreign acknowledgement never reports success', async () => {
  let fail = false; const f = setup({ page: async (q: BuyerInvoiceQuery) => { if (fail) throw Error('read unavailable'); return page(q); }, save: async () => ({ version: 1, uid: 22, action: 'save', id: 71 }) });
  await f.flow.load(); f.flow.edit(f.flow.titles()[0]); await f.flow.save(); expect(f.state.message).not.toBe('抬头已保存');
  fail = true; await f.flow.load(); expect(f.state.page).toBeNull(); expect(f.state.order).toBeNull(); expect(f.state.error).toBe('read unavailable');
});
