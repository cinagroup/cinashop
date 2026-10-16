import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as Idempotency from '@/services/out/OutIdempotency';
import { supplierManualRefundMac } from '@/services/supplier/SupplierManualRefundInput';
import {
  assertSupplierProactiveRefundCash, assertSupplierProactiveRefundRevision, parseSupplierProactiveRefundIntent,
  supplierProactiveRefundConflict, supplierProactiveRefundJson, supplierProactiveRefundMac,
} from '@/services/supplier/SupplierProactiveRefundInput';
import type { SupplierVideoActor } from '@/services/supplier/SupplierVideoAuthority';
import { HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';

const uuid = '01234567-89ab-4cde-8fab-0123456789ab', revision = 'b'.repeat(64);
const actor = (): SupplierVideoActor => ({ id: 21, supplierId: 7, authVersion: 'a'.repeat(32), expiresAt: 2_000_000_000 });
const body = () => ({ operation_id: uuid, revision, refund_price: '18.75' });

describe('Supplier order-ID proactive refund input contract', () => {
  it('binds full and goodwill amounts to the actual actor, tenant, order and immutable operation', async () => {
    const full = await parseSupplierProactiveRefundIntent(81, body(), actor());
    const small = await parseSupplierProactiveRefundIntent(81, { ...body(), refund_price: '7.00' }, actor());
    expect(full.intent).toEqual({ version: 'supplier-proactive-refund-intent-v1', actor_id: 21, supplier_id: 7,
      order_id: 81, operation_id: uuid, revision, refund_price: '18.75', type: 1 });
    expect(small.hash).not.toBe(full.hash);
    for (const changed of [
      await parseSupplierProactiveRefundIntent(82, body(), actor()),
      await parseSupplierProactiveRefundIntent(81, body(), { ...actor(), id: 22 }),
      await parseSupplierProactiveRefundIntent(81, body(), { ...actor(), supplierId: 8 }),
      await parseSupplierProactiveRefundIntent(81, { ...body(), operation_id: '01234567-89ab-4cde-9fab-0123456789ab' }, actor()),
      await parseSupplierProactiveRefundIntent(81, { ...body(), revision: 'c'.repeat(64) }, actor()),
    ]) expect(changed.hash).not.toBe(full.hash);
  });

  it('normalizes only the existing exact nonnegative decimal contract, without rounding', async () => {
    for (const [wire, amount] of [[0, '0.00'], ['0', '0.00'], ['7.1', '7.10'], [18.75, '18.75'], ['9999999999.99', '9999999999.99']] as const) {
      expect((await parseSupplierProactiveRefundIntent(81, { ...body(), refund_price: wire }, actor())).intent.refund_price).toBe(amount);
    }
    const a = await parseSupplierProactiveRefundIntent(81, { ...body(), refund_price: 7.1 }, actor());
    const b = await parseSupplierProactiveRefundIntent(81, { ...body(), refund_price: '7.10' }, actor());
    expect(a).toEqual(b);
    for (const refund_price of ['7.001', '01.00', '-1', -1, '1e2', ' 7.00', '7.00 ', '', true, null, undefined, NaN, Infinity, 10000000000]) {
      await expect(parseSupplierProactiveRefundIntent(81, { ...body(), refund_price }, actor())).rejects.toBeInstanceOf(ValidateException);
    }
  });

  it('normalizes PHP processing types and defaults only an absent type to approval', async () => {
    const defaulted = await parseSupplierProactiveRefundIntent(81, body(), actor());
    for (const type of [1, '1'] as const) expect(await parseSupplierProactiveRefundIntent(81, { ...body(), type }, actor())).toEqual(defaulted);
    const refusal = await parseSupplierProactiveRefundIntent(81, { ...body(), type: 2 }, actor());
    expect(refusal.intent.type).toBe(2);
    expect(await parseSupplierProactiveRefundIntent(81, { ...body(), type: '2' }, actor())).toEqual(refusal);
    expect(refusal.hash).not.toBe(defaulted.hash);
    for (const type of [0, 3, -1, 1.1, '01', '1.0', ' 1', '2 ', '', null, undefined, true, false, [], {}]) {
      await expect(parseSupplierProactiveRefundIntent(81, { ...body(), type }, actor())).rejects.toBeInstanceOf(ValidateException);
    }
  });

  it('rejects actor, tenant, path-order, capability and all unknown body fields', async () => {
    for (const [key, value] of Object.entries({ actor_id: 21, supplier_id: 7, order_id: 81, actor: actor(),
      manualRefund: true, supplierManualRefundCapability: {}, provider_status: 'SUCCESS', settlement: 'cash', cart_ids: [],
      version: 'supplier-proactive-refund-intent-v1', request_hash: revision, extra: undefined })) {
      await expect(parseSupplierProactiveRefundIntent(81, { ...body(), [key]: value }, actor())).rejects.toBeInstanceOf(ValidateException);
    }
    const symbol = { ...body(), [Symbol('supplier')]: 7 };
    await expect(parseSupplierProactiveRefundIntent(81, symbol, actor())).rejects.toBeInstanceOf(ValidateException);
    const hidden = Object.defineProperty(body(), 'supplier_id', { value: 7, enumerable: false });
    await expect(parseSupplierProactiveRefundIntent(81, hidden, actor())).rejects.toBeInstanceOf(ValidateException);
  });

  it('rejects missing fields, non-JSON records and executable accessor properties', async () => {
    for (const value of [null, undefined, [], 'refund', 1, true, new Date(), Object.create({ ...body() })]) {
      await expect(parseSupplierProactiveRefundIntent(81, value, actor())).rejects.toBeInstanceOf(ValidateException);
    }
    for (const key of ['operation_id', 'revision', 'refund_price'] as const) {
      const missing: Record<string, unknown> = { ...body() }; delete missing[key];
      await expect(parseSupplierProactiveRefundIntent(81, missing, actor())).rejects.toBeInstanceOf(ValidateException);
    }
    const getter = vi.fn(() => '18.75');
    await expect(parseSupplierProactiveRefundIntent(81, Object.defineProperty(body(), 'refund_price', { get: getter }), actor()))
      .rejects.toBeInstanceOf(ValidateException);
    expect(getter).not.toHaveBeenCalled();
    expect((await parseSupplierProactiveRefundIntent(81, Object.assign(Object.create(null), body()), actor())).intent.order_id).toBe(81);
  });

  it('requires a canonical UUIDv4, lowercase revision and positive bounded path ID', async () => {
    for (const operation_id of [uuid.toUpperCase(), ` ${uuid}`, `${uuid} `, uuid.replace('-4cde-', '-3cde-'), uuid.replace('-8fab-', '-7fab-'), '', 1, null]) {
      await expect(parseSupplierProactiveRefundIntent(81, { ...body(), operation_id }, actor())).rejects.toBeInstanceOf(ValidateException);
    }
    for (const candidate of [revision.toUpperCase(), revision.slice(1), `${revision}b`, '', 1, null]) {
      await expect(parseSupplierProactiveRefundIntent(81, { ...body(), revision: candidate }, actor())).rejects.toBeInstanceOf(ValidateException);
    }
    for (const id of [0, -1, 1.1, 2147483648, NaN, Infinity]) {
      await expect(parseSupplierProactiveRefundIntent(id, body(), actor())).rejects.toBeInstanceOf(ValidateException);
    }
  });

  it('requires explicit true for positive cash after the service determines the real channel', async () => {
    const unconfirmed = (await parseSupplierProactiveRefundIntent(81, body(), actor())).intent;
    expect(() => assertSupplierProactiveRefundCash(unconfirmed, 'cash')).toThrow('实际返还');
    const confirmed = await parseSupplierProactiveRefundIntent(81, { ...body(), cash_returned: true }, actor());
    expect(() => assertSupplierProactiveRefundCash(confirmed.intent, 'cash')).not.toThrow();
    expect(confirmed.hash).not.toBe((await parseSupplierProactiveRefundIntent(81, body(), actor())).hash);
    for (const cash_returned of [false, 1, 'true', null, undefined]) {
      await expect(parseSupplierProactiveRefundIntent(81, { ...body(), cash_returned }, actor())).rejects.toBeInstanceOf(ValidateException);
    }
  });

  it('never carries a cash declaration into balance, provider or zero settlement', async () => {
    const unconfirmed = (await parseSupplierProactiveRefundIntent(81, body(), actor())).intent;
    const confirmed = (await parseSupplierProactiveRefundIntent(81, { ...body(), cash_returned: true }, actor())).intent;
    for (const channel of ['balance', 'provider'] as const) {
      expect(() => assertSupplierProactiveRefundCash(unconfirmed, channel)).not.toThrow();
      expect(() => assertSupplierProactiveRefundCash(confirmed, channel)).toThrow('省略');
    }
    expect(() => assertSupplierProactiveRefundCash(unconfirmed, 'zero')).toThrow('零元');
  });

  it('keeps zero and refusal operations free of cash confirmations for every settlement', async () => {
    for (const patch of [{ refund_price: '0' }, { type: 2 }, { type: 2, refund_price: '0' }]) {
      const intent = (await parseSupplierProactiveRefundIntent(81, { ...body(), ...patch }, actor())).intent;
      for (const channel of ['cash', 'balance', 'provider', 'zero'] as const) {
        expect(() => assertSupplierProactiveRefundCash(intent, channel)).not.toThrow();
        expect(() => assertSupplierProactiveRefundCash({ ...intent, cash_returned: true }, channel)).toThrow('省略');
      }
      await expect(parseSupplierProactiveRefundIntent(81, { ...body(), ...patch, cash_returned: true }, actor())).rejects.toThrow('省略');
    }
  });

  it('detaches and freezes actor and body fields before awaiting the actual request hash', async () => {
    const actualHash = Idempotency.outRequestHash;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let hashing: unknown;
    const spy = vi.spyOn(Idempotency, 'outRequestHash').mockImplementationOnce(async value => {
      hashing = value; await gate; return actualHash(value);
    });
    const wire = { ...body(), cash_returned: true }, session = actor();
    const pending = parseSupplierProactiveRefundIntent(81, wire, session);
    try {
      expect(spy).toHaveBeenCalledOnce();
      if (!hashing || typeof hashing !== 'object') throw Error('请求哈希未取得原输入快照');
      expect(Object.isFrozen(hashing)).toBe(true);
      expect(Reflect.set(hashing, 'actor_id', 99)).toBe(false);
      wire.refund_price = '99.00'; wire.cash_returned = false; wire.operation_id = '01234567-89ab-4cde-9fab-0123456789ab';
      session.id = 99; session.supplierId = 8; session.authVersion = 'c'.repeat(32);
      release();
      const result = await pending;
      expect(result.intent).toMatchObject({ actor_id: 21, supplier_id: 7, operation_id: uuid, refund_price: '18.75', cash_returned: true });
      expect(result.hash).toBe(await actualHash(result.intent));
      expect(Object.isFrozen(result.intent)).toBe(true);
    } finally { release(); spy.mockRestore(); }
  });

  it('binds the revision to the complete source, real identity, tenant and login version', () => {
    const source = { order: { id: 81, payPrice: '18.75' }, carts: [{ id: 3, quantity: 2 }], prior: { returnedCash: '7.00' } };
    const mac = supplierProactiveRefundMac('owned-fixture-key', source, actor());
    expect(() => assertSupplierProactiveRefundRevision(mac, mac)).not.toThrow();
    const changed = [
      supplierProactiveRefundMac('owned-fixture-key', { ...source, prior: { returnedCash: '7.01' } }, actor()),
      supplierProactiveRefundMac('owned-fixture-key', { ...source, carts: [{ id: 3, quantity: 1 }] }, actor()),
      supplierProactiveRefundMac('owned-fixture-key', source, { ...actor(), id: 22 }),
      supplierProactiveRefundMac('owned-fixture-key', source, { ...actor(), supplierId: 8 }),
      supplierProactiveRefundMac('owned-fixture-key', source, { ...actor(), authVersion: 'c'.repeat(32) }),
    ];
    for (const expected of changed) expect(() => assertSupplierProactiveRefundRevision(mac, expected)).toThrow('变化');
    expect(supplierProactiveRefundMac('owned-fixture-key', { prior: source.prior, carts: source.carts, order: source.order }, actor())).toBe(mac);
  });

  it('uses a dedicated revision domain and fails closed when signing is unavailable', () => {
    const source = { amount: '18.75' }, key = 'owned-fixture-key', session = actor();
    const mac = supplierProactiveRefundMac(key, source, session);
    expect(mac).toBe(createHmac('sha256', key).update('cinashop.supplier-proactive-refund.revision.v1\0')
      .update(supplierProactiveRefundJson({ source, actor_id: 21, supplier_id: 7, auth_version: session.authVersion })).digest('hex'));
    expect(mac).not.toBe(supplierManualRefundMac(key, source, session));
    expect(() => supplierProactiveRefundMac('', source, session)).toThrow(ServiceUnavailableException);
  });

  it('rejects malformed received or stored revisions as conflicts without timing-safe length errors', () => {
    for (const invalid of ['', 'b'.repeat(63), 'b'.repeat(65), 'B'.repeat(64), 'g'.repeat(64)]) {
      expect(() => assertSupplierProactiveRefundRevision(invalid, revision)).toThrow(HttpApiException);
      expect(() => assertSupplierProactiveRefundRevision(revision, invalid)).toThrow(HttpApiException);
    }
    expect(supplierProactiveRefundConflict()).toMatchObject({ code: 409, httpStatus: 409 });
  });
});
