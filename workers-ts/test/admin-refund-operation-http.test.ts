import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app';
import type { Container } from '../src/lib/di';
import { adminRefundEvidenceFixture } from './helpers/adminRefundEvidenceFixture';
import { adminRefundOperation, systemAdmin, systemRole, storeOrder, storeOrderCartInfo,
  storeOrderRefund, storeOrderRefundPayment, storeOrderOutbox, userBrokerage } from '../src/models/schema';
import { WechatPayService } from '../src/services/wechat/WechatPayService';
import { AlipayRefundService } from '../src/services/payment/AlipayRefundService';
import { createToken, md5 } from '../src/utils/jwt';

// Keep the actual app/routes/auth/permissions/controllers and SQL service graph.
// Only the request's database binding is redirected to this owned SQL fixture;
// external providers and fetch fail closed unless explicitly modeled below.
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('../src/lib/di', async importOriginal => {
  const original = await importOriginal<typeof import('../src/lib/di')>();
  return { ...original, createAdminDatabaseSession: () => {
    if (!wiring.container) throw new Error('HTTP SQL fixture unavailable');
    return { container: wiring.container, close: async () => {} };
  }, createContainer: () => {
    if (!wiring.container) throw new Error('HTTP SQL fixture unavailable');
    return wiring.container;
  } };
});

const protocol = 'admin-refund-operation-v1';
const prefix = '/adminapi/refund/operations';
const aliases = [prefix, '/api/admin/refund/operations'];
const input = (action: 'return' | 'refuse' | 'refund' = 'return') => ({
  version: protocol, action,
  review: { uid: 11, storeOrderId: 28, storeId: 0, supplierId: 0, orderId: 'history_refund_28', refundPrice: '5.00' },
  decision: { applyType: action === 'refund' ? 1 : 2, refundType: 0, received: false },
  ...(action === 'refuse' ? { reason: '仅供本机测试的拒绝原因' } : {}),
});
// Validate response objects before extracting expected evidence. No untyped
// response casts can hide a malformed envelope or a missing receipt.
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected HTTP response object');
  return value as Record<string, unknown>;
};
const envelope = async (response: Response) => {
  const value = object(await response.json());
  if (typeof value.status !== 'number' || typeof value.msg !== 'string' || !Object.hasOwn(value, 'data')) throw new Error('Invalid HTTP envelope');
  return { status: value.status, msg: value.msg, data: value.data };
};

describe('assembled Admin refund operation HTTP protocol on isolated SQL', () => {
  let f: Awaited<ReturnType<typeof adminRefundEvidenceFixture>>;
  const app = createApp();
  beforeEach(async () => {
    f = await adminRefundEvidenceFixture(undefined, [adminRefundOperation, userBrokerage]);
    wiring.container = f.container;
    const forbidden = async () => { throw new Error('Unconfigured external provider I/O'); };
    vi.spyOn(WechatPayService.prototype, 'requestRefund').mockImplementation(forbidden);
    vi.spyOn(WechatPayService.prototype, 'queryRefund').mockImplementation(forbidden);
    vi.spyOn(AlipayRefundService.prototype, 'requestRefund').mockImplementation(forbidden);
    vi.spyOn(AlipayRefundService.prototype, 'queryRefund').mockImplementation(forbidden);
    vi.spyOn(globalThis, 'fetch').mockImplementation(forbidden);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  }, 30000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { wiring.container = undefined; vi.restoreAllMocks(); await f?.close(); }
  }, 45000);
  const headers = (key: string, id = 100) => new Headers({
    'Authori-zation': `Bearer ${f.tokens.get(id)}`, 'Content-Type': 'application/json',
    'Idempotency-Key': key, 'X-Refund-Operation-Scope': `v1:admin:${id}`,
  });
  const send = (path: string, key: string, value: unknown = { version: protocol }, id = 100) =>
    app.request(path, { method: 'POST', headers: headers(key, id), body: JSON.stringify(value) }, f.env);
  const receipts = () => f.db.select().from(adminRefundOperation);
  const financial = async (payType: 'yue' | 'weixin') => {
    await f.db.update(storeOrder).set({ payType, status: 0 }).where(eq(storeOrder.id, 28));
    await f.db.update(storeOrderRefund).set({ applyType: 1 }).where(eq(storeOrderRefund.id, 28));
    await f.db.update(storeOrderCartInfo).set({ skuUnique: 'qared001' }).where(eq(storeOrderCartInfo.id, 28));
    return input('refund');
  };
  const noStore = (response: Response) => {
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
  };

  it.each(aliases)('uses the real authenticated %s route for single approval and cross-alias replay/lookup', async base => {
    const key = crypto.randomUUID(), value = input();
    const first = await send(`${base}/execute/28`, key, value); noStore(first);
    expect(first.status).toBe(200);
    const result = await envelope(first), receipt = object(result.data).receipt;
    expect(result).toMatchObject({ status: 200, data: { version: protocol, replayed: false, execution: null,
      receipt: { version: protocol, adminId: 100, requestKey: key, refundId: 28, action: 'return', outcome: 'return-approved' } } });
    const other = aliases.find(path => path !== base)!;
    const duplicate = await send(`${other}/execute/28`, key, value); noStore(duplicate);
    expect(await duplicate.json()).toMatchObject({ status: 200, data: { replayed: true, receipt, execution: null } });
    const lookup = await send(`${other}/receipt`, key); noStore(lookup);
    expect(await lookup.json()).toMatchObject({ status: 200, data: { version: protocol, receipt } });
    expect(await receipts()).toHaveLength(1); expect(await f.statuses()).toHaveLength(1);
    expect((await f.applications()).find(row => row.id === 28)?.refundType).toBe(4);
    expect(WechatPayService.prototype.requestRefund).not.toHaveBeenCalled();
  });

  it('requires manage rather than view permission for all three POSTs, including read-only receipt lookup', async () => {
    const before = await f.snapshot();
    for (const id of [101, 102, 103]) for (const endpoint of ['execute/28', 'receipt', 'abandon/28']) {
      const response = await send(`${prefix}/${endpoint}`, crypto.randomUUID(), endpoint === 'receipt' ? { version: protocol } : input(), id);
      noStore(response);
      expect(await response.json()).toMatchObject({ status: id === 103 ? 410002 : 400011, data: null });
    }
    expect(await receipts()).toEqual([]); expect(await f.snapshot()).toEqual(before);
    await f.db.update(systemRole).set({ rules: 'refund.manage' }).where(eq(systemRole.id, 1));
    const allowed = await send(`${prefix}/execute/28`, crypto.randomUUID(), input(), 101);
    expect(await allowed.json()).toMatchObject({ status: 200, data: { receipt: { adminId: 101, outcome: 'return-approved' } } });
  });

  it('rejects missing, invalid and non-admin JWTs without exposing or writing receipts', async () => {
    const customer = await createToken(100, 'api', md5('synthetic-digest'), f.env.APP_KEY);
    for (const token of ['', 'not-a-token', customer.token]) {
      const h = headers(crypto.randomUUID()); h.set('Authori-zation', token ? `Bearer ${token}` : '');
      const response = await app.request(`${prefix}/receipt`, { method: 'POST', headers: h, body: JSON.stringify({ version: protocol }) }, f.env);
      noStore(response); expect((await envelope(response)).status).toBeGreaterThanOrEqual(410000);
    }
    expect(await receipts()).toEqual([]);
  });

  it('keeps ownership server-derived and refuses a stale expected actor on execution, lookup and abandonment', async () => {
    const key = crypto.randomUUID(); await send(`${prefix}/execute/28`, key, input());
    await f.db.update(systemAdmin).set({ level: 0 }).where(eq(systemAdmin.id, 101));
    for (const endpoint of ['execute/28', 'receipt', 'abandon/28']) {
      const h = headers(key, 101); h.set('X-Refund-Operation-Scope', 'v1:admin:100');
      const response = await app.request(`${prefix}/${endpoint}`, { method: 'POST', headers: h,
        body: JSON.stringify(endpoint === 'receipt' ? { version: protocol } : input()) }, f.env);
      expect(response.status).toBe(412); noStore(response);
      expect(await response.json()).toMatchObject({ status: 412, data: null });
    }
    expect(await (await send(`${prefix}/receipt`, key, { version: protocol }, 101)).json())
      .toMatchObject({ status: 200, data: { receipt: null } });
    expect(await receipts()).toHaveLength(1);
  });

  it('does not turn a missing receipt into a fence; explicit abandonment blocks the actual delayed HTTP execution', async () => {
    const key = crypto.randomUUID(), before = await f.snapshot();
    expect(await (await send(`${prefix}/receipt`, key)).json()).toEqual({ status: 200, msg: 'ok', data: { version: protocol, receipt: null } });
    expect(await receipts()).toEqual([]); expect(await f.snapshot()).toEqual(before);
    const fence = object((await envelope(await send(`${prefix}/abandon/28`, key, input()))).data).receipt;
    expect(object(fence).outcome).toBe('abandoned');
    expect(await (await send(`${prefix}/execute/28`, key, input())).json())
      .toMatchObject({ status: 200, data: { receipt: fence, replayed: true, execution: null } });
    expect(await f.snapshot()).toEqual(before); expect(await f.statuses()).toEqual([]);
    expect(await receipts()).toHaveLength(1);
  });

  it('returns the accepted result unchanged when abandonment loses, including after deletion of the business row', async () => {
    const key = crypto.randomUUID(), value = input('refuse');
    const receipt = object((await envelope(await send(`${prefix}/execute/28`, key, value))).data).receipt;
    expect(object(receipt).outcome).toBe('refused');
    expect((await f.db.select().from(storeOrderOutbox))).toHaveLength(1);
    await f.exec('DELETE FROM store_order_refund WHERE id=28; DELETE FROM store_order WHERE id=28');
    expect(await (await send(`${prefix}/abandon/28`, key, value)).json()).toMatchObject({ status: 200, data: { receipt } });
    expect(await (await send(`${prefix}/execute/28`, key, value)).json()).toMatchObject({ status: 200, data: { replayed: true, receipt } });
    expect(await receipts()).toHaveLength(1); expect(await f.statuses()).toHaveLength(1);
  });

  it('returns a real HTTP409 for reused keys with different content, never rewrites the receipt', async () => {
    const key = crypto.randomUUID(); await send(`${prefix}/execute/28`, key, input('refuse'));
    const before = await receipts();
    for (const value of [{ ...input('refuse'), reason: '更改拒绝原因' }, input()]) {
      for (const endpoint of ['execute/28', 'abandon/28']) {
        const response = await send(`${prefix}/${endpoint}`, key, value);
        expect(response.status).toBe(409); noStore(response);
        expect(await response.json()).toMatchObject({ status: 409, data: null });
      }
    }
    expect(await receipts()).toEqual(before); expect(await f.statuses()).toHaveLength(1);
  });

  it('settles actual balance/bill/inventory once through HTTP and returns stable execution evidence on replay', async () => {
    const value = await financial('yue'), key = crypto.randomUUID(), before = await f.snapshot();
    const first = await envelope(await send(`${prefix}/execute/28`, key, value));
    expect(first).toMatchObject({ status: 200, data: { receipt: { outcome: 'balance-settled' }, execution: { completed: true, status: 'BALANCE_SUCCESS' } } });
    const after = await f.snapshot();
    expect(after.users.find(row => row.uid === 11)?.nowMoney).toBe('5.00');
    expect(after.bills.filter(row => row.type === 'pay_product_refund')).toHaveLength(1);
    expect(after.products.find(row => row.id === 70)?.stock).toBe(before.products.find(row => row.id === 70)!.stock + 1);
    expect(await (await send(`${prefix}/execute/28`, key, value)).json()).toMatchObject({ status: 200, data: { ...object(first.data), replayed: true } });
    expect(await f.snapshot()).toEqual(after); expect(await receipts()).toHaveLength(1);
  });

  it('keeps unknown provider acceptance query-only until an explicit original-key execution retry', async () => {
    const value = await financial('weixin'), key = crypto.randomUUID();
    vi.mocked(WechatPayService.prototype.requestRefund).mockRejectedValueOnce(new Error('synthetic lost provider response'));
    const first = await send(`${prefix}/execute/28`, key, value); noStore(first);
    expect((await envelope(first)).status).not.toBe(200);
    const accepted = await envelope(await send(`${prefix}/receipt`, key));
    expect(accepted).toMatchObject({ status: 200, data: { receipt: { outcome: 'provider-admitted' } } });
    expect(await (await send(`${prefix}/abandon/28`, key, value)).json()).toMatchObject({ status: 200, data: accepted.data });
    expect(WechatPayService.prototype.queryRefund).not.toHaveBeenCalled();
    expect(await f.db.select().from(storeOrderRefundPayment)).toMatchObject([{ providerStatus: 'UNKNOWN', attemptCount: 1 }]);
    vi.mocked(WechatPayService.prototype.queryRefund).mockResolvedValueOnce({ status: 'SUCCESS', providerRefundId: 'http-synthetic-28' });
    const recovered = await (await send(`${prefix}/execute/28`, key, value)).json();
    expect(recovered).toMatchObject({ status: 200, data: { receipt: object(accepted.data).receipt, execution: { completed: true, status: 'SUCCESS' } } });
    expect(WechatPayService.prototype.requestRefund).toHaveBeenCalledTimes(1);
    expect(WechatPayService.prototype.queryRefund).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outRefundNo: 'CNSR28', refundAmount: 500 }));
    expect(await f.statuses()).toHaveLength(1);
  });

  it('exposes committed admission to HTTP lookup and preserves the lease during a duplicate in-flight HTTP execution', async () => {
    const value = await financial('weixin'), key = crypto.randomUUID();
    vi.mocked(WechatPayService.prototype.requestRefund).mockImplementationOnce(async () => {
      expect(await (await send(`${prefix}/receipt`, key)).json())
        .toMatchObject({ status: 200, data: { receipt: { outcome: 'provider-admitted' } } });
      expect(await f.db.select().from(storeOrderRefundPayment)).toMatchObject([{ providerStatus: 'REQUESTING', attemptCount: 1 }]);
      expect(await (await send(`${prefix}/execute/28`, key, value)).json()).toMatchObject({ status: 200,
        data: { receipt: { outcome: 'provider-admitted' }, execution: { completed: false, status: 'PROCESSING' } } });
      return { status: 'PROCESSING' };
    });
    expect(await (await send(`${prefix}/execute/28`, key, value)).json()).toMatchObject({ status: 200,
      data: { receipt: { outcome: 'provider-admitted' }, execution: { completed: false, status: 'PROCESSING' } } });
    expect(WechatPayService.prototype.requestRefund).toHaveBeenCalledTimes(1);
    expect(WechatPayService.prototype.queryRefund).not.toHaveBeenCalled();
    expect(await receipts()).toHaveLength(1); expect(await f.statuses()).toEqual([]);
  });

  it.each(['execute/28', 'receipt', 'abandon/28'].flatMap(endpoint =>
    ['disabled', 'password', 'role', 'expired'].map(change => ({ endpoint, change }))))
    ('rechecks $change after real middleware auth while reading $endpoint', async ({ endpoint, change }) => {
    const key = crypto.randomUUID(); await send(`${prefix}/execute/28`, key, input());
    const before = await receipts(), statuses = await f.statuses();
    const authenticationRead = vi.spyOn(f.container.systemAdminDao, 'get');
    const data = new TextEncoder().encode(JSON.stringify(endpoint === 'receipt' ? { version: protocol } : input()));
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
      pulls++;
      // highWaterMark0 means this code runs only when the controller reads the
      // body, after real middleware authentication has completed.
      expect(authenticationRead).toHaveBeenCalledExactlyOnceWith(100);
      if (change === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 8 * 24 * 3600 * 1000);
      else await f.db.update(systemAdmin).set(change === 'disabled' ? { status: 0 }
        : change === 'password' ? { pwd: 'changed-local-password-digest' } : { level: 1, roles: '' }).where(eq(systemAdmin.id, 100));
      controller.enqueue(data); controller.close();
    } }, { highWaterMark: 0 });
    // Node's streaming Request requires duplex; structural extension avoids
    // pretending this Node test option belongs to the Workers RequestInit API.
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers: headers(key), body: stream, duplex: 'half' };
    const request = new Request(`http://localhost${prefix}/${endpoint}`, init);
    const response = await app.request(request, undefined, f.env); noStore(response);
    expect(pulls).toBe(1);
    expect(await response.json()).toMatchObject({ status: change === 'disabled' ? 410002 : change === 'role' ? 400011 : 410001, data: null });
    expect(await receipts()).toEqual(before); expect(await f.statuses()).toEqual(statuses);
  });

  it('preserves a same-actor receipt across renewed tokens but rejects expiry even inside JWT clock tolerance', async () => {
    const key = crypto.randomUUID(), now = Math.floor(Date.now() / 1000);
    f.tokens.set(100, (await createToken(100, 'admin', md5('synthetic-digest'), f.env.APP_KEY, 'cinashop', now - 120)).token);
    const receipt = object((await envelope(await send(`${prefix}/execute/28`, key, input()))).data).receipt;
    f.tokens.set(100, (await createToken(100, 'admin', md5('synthetic-digest'), f.env.APP_KEY, 'cinashop', now)).token);
    expect(await (await send(`${prefix}/execute/28`, key, input())).json()).toMatchObject({ status: 200, data: { replayed: true, receipt } });
    f.tokens.set(100, (await createToken(100, 'admin', md5('synthetic-digest'), f.env.APP_KEY, 'cinashop', now - 7 * 24 * 3600 - 30)).token);
    expect(await (await send(`${prefix}/receipt`, key)).json()).toMatchObject({ status: 410001, data: null });
    expect(await receipts()).toHaveLength(1); expect(await f.statuses()).toHaveLength(1);
  });

  it('rolls back real balance/bill/stock on receipt insertion failure and redacts SQL error details', async () => {
    const value = await financial('yue'), before = await f.snapshot();
    await f.exec(`CREATE FUNCTION reject_http_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'SYNTHETIC_PRIVATE_PAYLOAD'; END$$;
      CREATE TRIGGER reject_http_receipt BEFORE INSERT ON admin_refund_operation FOR EACH ROW EXECUTE FUNCTION reject_http_receipt()`);
    const response = await send(`${prefix}/execute/28`, crypto.randomUUID(), value); noStore(response);
    expect(await response.json()).toEqual({ status: 500, msg: '系统繁忙,请稍后再试', data: null });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('SYNTHETIC_PRIVATE_PAYLOAD');
    expect(await f.snapshot()).toEqual(before); expect(await receipts()).toEqual([]); expect(await f.statuses()).toEqual([]);
  });

  it('never installs a missing receipt table from any HTTP operation', async () => {
    const before = await f.snapshot(); await f.exec('DROP TABLE admin_refund_operation');
    for (const endpoint of ['execute/28', 'receipt', 'abandon/28']) {
      const response = await send(`${prefix}/${endpoint}`, crypto.randomUUID(), endpoint === 'receipt' ? { version: protocol } : input());
      noStore(response); expect(await response.json()).toMatchObject({ status: 500, data: null });
    }
    expect(await f.snapshot()).toEqual(before); expect(await f.statuses()).toEqual([]);
    expect(WechatPayService.prototype.requestRefund).not.toHaveBeenCalled();
  });

  it('fails closed before controller execution when production token storage is unavailable', async () => {
    f.env.NODE_ENV = 'production';
    const response = await send(`${prefix}/execute/28`, crypto.randomUUID(), input());
    expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toMatchObject({ status: 503, data: null });
    expect(await receipts()).toEqual([]); expect(await f.statuses()).toEqual([]);
  });

  it('cancels a too-large streamed body despite a false small Content-Length', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(4097).fill(32)); }, cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const h = headers(crypto.randomUUID()); h.set('Content-Length', '1');
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers: h, body: stream, duplex: 'half' };
    const response = await app.request(new Request(`http://localhost${prefix}/receipt`, init), undefined, f.env);
    noStore(response); expect(await response.json()).toMatchObject({ status: 400, data: null });
    expect(cancelled).toBe(true); expect(await receipts()).toEqual([]);
  });

  it('rejects noncanonical identifiers, unknown protocol fields and malformed decisions without writes', async () => {
    const before = await f.snapshot();
    const badBodies: unknown[] = [null, [], {}, { ...input(), version: 'v2' }, { ...input(), version: undefined },
      { ...input(), action: ['return'] }, { ...input(), action: 'agree' }, { ...input(), adminId: 101 },
      { ...input(), requestKey: crypto.randomUUID() }, { ...input(), reason: 'unexpected' },
      { ...input('refuse'), reason: '' }, { ...input('refuse'), reason: 'x'.repeat(256) },
      { ...input(), review: { ...input().review, uid: '11' } }, { ...input(), review: { ...input().review, extra: 1 } },
      { ...input(), decision: { ...input().decision, received: 1 } }, { ...input(), decision: { ...input().decision, extra: 1 } }];
    for (const value of badBodies) {
      const response = await send(`${prefix}/execute/28`, crypto.randomUUID(), value); noStore(response);
      expect(await response.json()).toMatchObject({ status: 400, data: null });
    }
    for (const id of ['0', '028', '-1', '2147483648', '1e2']) {
      expect(await (await send(`${prefix}/execute/${id}`, crypto.randomUUID(), input())).json()).toMatchObject({ status: 400, data: null });
    }
    expect(await receipts()).toEqual([]); expect(await f.snapshot()).toEqual(before);
  });

  it('enforces scope/key headers, JSON transport, strict UTF8 and the actual byte limit', async () => {
    for (const [name, value] of [
      ['Idempotency-Key', ''], ['Idempotency-Key', 'not-a-key'], ['Idempotency-Key', `${crypto.randomUUID()}, ${crypto.randomUUID()}`],
      ['X-Refund-Operation-Scope', ''], ['X-Refund-Operation-Scope', 'v1:admin:0100'],
      ['X-Refund-Operation-Scope', 'v1:admin:100, v1:admin:100'], ['Content-Type', 'text/plain'],
      ['Content-Type', 'application/json; charset=utf-16'], ['Content-Encoding', 'gzip'], ['Content-Length', 'invalid'], ['Content-Length', '4097'],
    ]) {
      const h = headers(crypto.randomUUID()); h.set(name, value);
      const response = await app.request(`${prefix}/execute/28`, { method: 'POST', headers: h, body: JSON.stringify(input()) }, f.env);
      noStore(response); expect((await envelope(response)).status).toBe(name === 'X-Refund-Operation-Scope' ? 412 : 400);
    }
    for (const data of ['{', ' '.repeat(4097), new Uint8Array([0xff, 0xfe])]) {
      const response = await app.request(`${prefix}/receipt`, { method: 'POST', headers: headers(crypto.randomUUID()), body: data }, f.env);
      noStore(response); expect(await response.json()).toMatchObject({ status: 400, data: null });
    }
    expect(await (await send(`${prefix}/receipt?key=forbidden`, crypto.randomUUID())).json()).toMatchObject({ status: 400, data: null });
    expect(await (await send(`${prefix}/receipt`, crypto.randomUUID(), input())).json()).toMatchObject({ status: 400, data: null });
    expect(await receipts()).toEqual([]);
  });

  it('does not dispatch via GET/HEAD/PUT and advertises the new scope header only to allowed CORS origins', async () => {
    for (const method of ['GET', 'HEAD', 'PUT']) for (const endpoint of ['execute/28', 'receipt', 'abandon/28']) {
      const response = await app.request(`${prefix}/${endpoint}`, { method, headers: headers(crypto.randomUUID()) }, f.env);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
    }
    const response = await app.request(`${prefix}/receipt`, { method: 'OPTIONS', headers: {
      Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,authori-zation,idempotency-key,x-refund-operation-scope',
    } }, f.env);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(response.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('x-refund-operation-scope');
    expect(await receipts()).toEqual([]); expect(await f.statuses()).toEqual([]);
    expect(WechatPayService.prototype.requestRefund).not.toHaveBeenCalled();
  });
});
