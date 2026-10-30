import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkedCrmebExpressCatalog, listCrmebOnePassExpressCatalog,
  listCrmebOnePassWaybillTemplates, issueCrmebOnePassWaybill,
  WaybillConfigurationError, WaybillPreflightError, type WaybillIssueInput } from '@/services/waybill/CrmebOnePassWaybillProvider';

const row = (overrides: Record<string, unknown> = {}) => ({ code: 'SF', name: '顺丰速运',
  partner_id: 1, partner_key: 1, net: 0, check_man: 0, partner_name: 0, is_code: 0, ...overrides });
const envelope = (rows: unknown[] = [row()], extra: Record<string, unknown> = {}) => ({ status: 200, data: { data: rows, ...extra } });
const credentials = () => ({ accessKey: `owned-${crypto.randomUUID()}`, secretKey: 'private-provider-secret' });
function remote(response: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    calls.push({ url: String(input), init });
    return String(input).endsWith('/v2/user/login')
      ? Response.json({ status: 200, data: { access_token: 'owned-catalog-token' } }) : response();
  });
  return { calls, fetcher };
}
function issueInput(): WaybillIssueInput {
  return { carrierCode: 'SF', recipientName: '收件人', recipientPhone: '13800000000', recipientAddress: '收件地址',
    senderName: '发件人', senderPhone: '13900000000', senderAddress: '发件地址', templateId: 'SF-1', cloudPrinterId: '',
    count: 1, cargo: '商品', weight: '1.00', orderNo: 'OWNED-1', carrier: { partnerId: false, partnerKey: false,
      net: false, checkMan: false, partnerName: false, isCode: false, account: '', key: '', netName: '', courierName: '', customerName: '', codeName: '' } };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Express provider response snapshot: complete validation without issuing a waybill', () => {
  it('accepts the exact fixed PHP nested data shape without claiming a remote total', () => {
    const raw = envelope([row({ partner_id: '0', is_code: '1', account: 'must-not-project', unknown: { key: 'private' } })]);
    const before = structuredClone(raw), result = checkedCrmebExpressCatalog(raw);
    expect(result).toEqual([{ code: 'SF', name: '顺丰速运', partner_id: 0, partner_key: 1, net: 0, check_man: 0, partner_name: 0, is_code: 1 }]);
    expect(raw).toEqual(before); expect(result[0]).not.toHaveProperty('account'); expect(result[0]).not.toHaveProperty('unknown');
  });
  it('accepts an explicit empty snapshot and exact complete count/pagination metadata', () => {
    expect(checkedCrmebExpressCatalog(envelope([]))).toEqual([]);
    expect(checkedCrmebExpressCatalog(envelope([row()], { count: 1, total: 1, page: 1, per_page: 20, last_page: 1, has_more: false, next_page_url: null }))).toHaveLength(1);
    expect(checkedCrmebExpressCatalog(envelope([], { count: 0, pages: 0 }))).toEqual([]);
  });
  it.each([
    ['raw array', [row()]], ['flat array', { status: 200, data: [row()] }], ['missing nested data', { status: 200, data: {} }],
    ['failure status', { status: 400, data: { data: [row()] } }], ['coerced status', { status: '0200', data: { data: [row()] } }],
    ['null row', envelope([null])], ['bad tail', envelope([row(), row({ code: 'ZTO', name: '' })])],
    ['duplicate code', envelope([row(), row({ name: 'duplicate' })])], ['missing flag', envelope([Object.fromEntries(Object.entries(row()).filter(([k]) => k !== 'is_code'))])],
    ['flag boolean', envelope([row({ net: false })])], ['flag coercion', envelope([row({ net: '00' })])], ['flag unknown', envelope([row({ net: 2 })])],
    ['remote code URL', envelope([row({ code: 'https://bad.invalid' })])], ['code overflow', envelope([row({ code: 'A'.repeat(51) })])],
    ['name overflow', envelope([row({ name: '字'.repeat(65) })])], ['name control', envelope([row({ name: '顺丰\u0000' })])], ['name whitespace', envelope([row({ name: ' 顺丰 ' })])],
    ['count mismatch', envelope([row()], { count: 2 })], ['count numeric string', envelope([row()], { count: '1' })], ['negative count', envelope([], { count: -1 })],
    ['contradictory totals', envelope([row()], { count: 1, total: 2 })], ['has more', envelope([row()], { has_more: true })],
    ['unknown has more', envelope([row()], { has_more: 'false' })], ['next page', envelope([row()], { next_page_url: '/page/2' })],
    ['page 2', envelope([row()], { count: 1, page: 2 })], ['unknown pagination', envelope([row()], { pagination: {} })],
    ['unproven limit', envelope([row()], { limit: 1 })], ['partial capacity', envelope([row()], { count: 1, per_page: 0 })],
    ['unknown cursor', envelope([row()], { cursor: 'opaque' })],
  ])('rejects the complete batch: %s', (_label, raw) => {
    expect(() => checkedCrmebExpressCatalog(raw)).toThrow(WaybillPreflightError);
  });
  it('rejects sparse rows and accessors without executing a supplied getter', () => {
    const sparse = new Array(2); sparse[0] = row(); expect(() => checkedCrmebExpressCatalog(envelope(sparse))).toThrow();
    const get = vi.fn(() => 'SF'), value = row(); Object.defineProperty(value, 'code', { get });
    expect(() => checkedCrmebExpressCatalog(envelope([value]))).toThrow(); expect(get).not.toHaveBeenCalled();
  });
  it('accepts exactly 5000 rows but rejects a 5001st valid row instead of truncating', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => row({ code: `C${i}` }));
    expect(checkedCrmebExpressCatalog(envelope(rows, { count: 5000 }))).toHaveLength(5000);
    expect(() => checkedCrmebExpressCatalog(envelope([...rows, row({ code: 'LAST' })]))).toThrow();
  });
  it('retains full 64 Unicode names and the input order without merging codes', () => {
    const result = checkedCrmebExpressCatalog(envelope([row({ code: 'b', name: '🦆'.repeat(64) }), row({ code: 'A' })]));
    expect(result.map(r => r.code)).toEqual(['b', 'A']); expect([...result[0].name]).toHaveLength(64);
  });
});

describe('Actual HTTPS catalog transport and unchanged template/issue response budgets', () => {
  it('uses login then one GET without paging/credentials/body and reuses the same authenticated token', async () => {
    const r = remote(() => Response.json(envelope())), creds = credentials();
    expect(await listCrmebOnePassExpressCatalog(creds, r.fetcher)).toHaveLength(1);
    await listCrmebOnePassExpressCatalog(creds, r.fetcher);
    expect(r.calls.map(c => c.url)).toEqual(['https://sms.crmeb.net/api/v2/user/login', 'https://sms.crmeb.net/api/v2/expr/express', 'https://sms.crmeb.net/api/v2/expr/express']);
    const request = r.calls[1].init!;
    expect(request.method).toBe('GET'); expect(request.body).toBeUndefined(); expect(request.redirect).toBe('error');
    expect(new Headers(request.headers).get('Authorization')).toBe('Bearer-owned-catalog-token');
    expect(new Headers(request.headers).get('Accept')).toBe('application/json'); expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(r.calls[1].url).not.toContain(creds.secretKey); expect(r.calls.some(c => /dump|shipment|\/open/.test(c.url))).toBe(false);
  });
  it('missing credentials refuse before any provider I/O', async () => {
    const fetcher: typeof fetch = vi.fn(async () => { throw Error('must not call'); });
    await expect(listCrmebOnePassExpressCatalog({}, fetcher)).rejects.toBeInstanceOf(WaybillConfigurationError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('shares the existing credential cache with real template reads without sharing unrelated credentials', async () => {
    const creds = credentials(), calls: string[] = [];
    const fetcher: typeof fetch = vi.fn(async input => { const url = String(input); calls.push(url);
      if (url.endsWith('/login')) return Response.json({ status: 200, data: { access_token: 'cross-token' } });
      return Response.json(url.includes('expr_dump') ? { status: 200, data: { data: [] } } : envelope()); });
    await listCrmebOnePassWaybillTemplates(creds, { carrierCode: 'SF', cloudPrinterConfigured: false }, fetcher);
    await listCrmebOnePassExpressCatalog(creds, fetcher);
    await listCrmebOnePassExpressCatalog(credentials(), fetcher);
    expect(calls.filter(c => c.endsWith('/login'))).toHaveLength(2);
    expect(calls.filter(c => c.endsWith('/expr/express'))).toHaveLength(2);
  });
  it('accepts a catalog above 32KiB while the same templates and issue responses still refuse', async () => {
    const rows = Array.from({ length: 400 }, (_, i) => row({ code: `C${i}` }));
    const r = remote(() => Response.json(envelope(rows)));
    expect(new TextEncoder().encode(JSON.stringify(envelope(rows))).length).toBeGreaterThan(32768);
    await expect(listCrmebOnePassExpressCatalog(credentials(), r.fetcher)).resolves.toHaveLength(400);
    const padding = 'x'.repeat(33000), template = remote(() => Response.json({ status: 200, data: { data: [], padding } }));
    await expect(listCrmebOnePassWaybillTemplates(credentials(), { carrierCode: 'SF', cloudPrinterConfigured: false }, template.fetcher)).rejects.toBeInstanceOf(WaybillPreflightError);
    const issue = remote(() => Response.json({ status: 200, data: { kuaidinum: 'SF1', padding } }));
    await expect(issueCrmebOnePassWaybill(credentials(), issueInput(), issue.fetcher)).rejects.toThrow('provider_response_too_large');
  });
  it('counts UTF8 stream bytes at the independent 1MiB boundary and cancels oversized responses', async () => {
    const text = JSON.stringify({ ...envelope(), pad: '' }), budget = 1024 * 1024;
    const exact = text.replace('"pad":""', `"pad":"${'x'.repeat(budget - new TextEncoder().encode(text).length)}"`);
    expect(new TextEncoder().encode(exact)).toHaveLength(budget);
    await expect(listCrmebOnePassExpressCatalog(credentials(), remote(() => new Response(exact)).fetcher)).resolves.toHaveLength(1);
    const cancel = vi.fn(), stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(budget)); c.enqueue(new Uint8Array(1)); }, cancel });
    await expect(listCrmebOnePassExpressCatalog(credentials(), remote(() => new Response(stream)).fetcher)).rejects.toBeInstanceOf(WaybillPreflightError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['HTTP error', () => new Response('private provider account must not echo', { status: 503 })],
    ['malformed JSON', () => new Response('private-secret')],
    ['application refusal', () => Response.json({ status: 400, msg: 'private-secret' })],
    ['invalid tail', () => Response.json(envelope([row(), row({ code: 'TAIL', partner_key: null })]))],
  ])('refuses %s without a second catalog attempt or sensitive error text', async (_label, response) => {
    const r = remote(response); const result = await listCrmebOnePassExpressCatalog(credentials(), r.fetcher).catch(e => e);
    expect(result).toBeInstanceOf(WaybillPreflightError); expect(result.message).not.toContain('private');
    expect(r.calls.filter(c => c.url.endsWith('/expr/express'))).toHaveLength(1);
  });
  it('does not leak a provider-controlled login failure', async () => {
    const fetcher: typeof fetch = vi.fn(async () => Response.json({ status: 400, msg: 'private-secret' }));
    const error = await listCrmebOnePassExpressCatalog(credentials(), fetcher).catch(e => e);
    expect(error).toBeInstanceOf(WaybillPreflightError); expect(error.message).not.toContain('private-secret'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('aborts a pending catalog at 10s while keeping the old transport deadline', async () => {
    vi.useFakeTimers(); let started!: () => void; const requested = new Promise<void>(resolve => { started = resolve; });
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      if (String(input).endsWith('/login')) return Response.json({ status: 200, data: { access_token: 'timer-token' } });
      started(); return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    });
    // Finish the real digest/login before advancing the transport timer.
    const creds = credentials(); await listCrmebOnePassExpressCatalog(creds, remote(() => Response.json(envelope())).fetcher);
    const pending = listCrmebOnePassExpressCatalog(creds, fetcher); const rejected = expect(pending).rejects.toBeInstanceOf(WaybillPreflightError);
    await requested; await vi.advanceTimersByTimeAsync(10_000); await rejected; expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
