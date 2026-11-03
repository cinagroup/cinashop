/** Closed codec/batch units. Catalog, LOGIN, SAVEPOINT and group rows are
 * explicit structural stubs, not real payment, formation, owner or send proof. */
import { createHmac } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { captureRoutineSubscriptionPinkBusiness, createRoutineSubscriptionPinkRequestTx, parseRoutineSubscriptionPinkRequest,
  prepareRoutineSubscriptionPinkRequestsTx, readRoutineSubscriptionPinkTargetTx,
  type RoutineSubscriptionPinkBusiness, type RoutineSubscriptionPinkRequest } from '@/services/wechat/RoutineSubscriptionPinkRequest';

const catalog = vi.hoisted(() => vi.fn());
vi.mock('@/migrations/routineSubscriptionDelivery', () => ({ inspectRoutineSubscriptionDeliveryCatalog: catalog }));
const env = { APP_KEY: 'inert-pink-request-key' }, now = 1793602800;
const scope = { database: 'pink_fixture', databaseOid: '102', maintenance: 'pink_owner', maintenanceOid: '103' };
const actor = { role: 'pink_app', roleOid: '104' };
const business: RoutineSubscriptionPinkBusiness = { orderId: 17, orderNo: 'pink_order_17', userId: 11, pinkId: 100, people: 2 };
const raw = (body = business) => ({ eventKey: `order.pink.success.notice:${body.orderId}`, aggregateId: body.orderId, payload: { ...body }, now });
const ready = () => ({ present: true, ready: true, failures: [], binding: { maintenance: scope.maintenance,
  maintenanceOid: scope.maintenanceOid, app: actor.role, appOid: actor.roleOid } });
const context = () => ({ ...scope, ...actor, now: String(now + 1), ready: true });
function members(count = 2, virtual = 0) {
  return Array.from({ length: count }, (_, i) => ({ id: 100 + i, uid: i >= count - virtual ? 0 : 11 + i,
    nickname: i ? '成员' + i : '团长123', orderId: i >= count - virtual ? '0' : `pink_order_${17 + i}`,
    orderIdKey: i >= count - virtual ? '0' : String(17 + i), combinationId: 3, productId: 9, kId: i ? 100 : 0,
    people: count, status: 2, stopTime: now + 7, isRefund: 0, isVirtual: i >= count - virtual ? 1 : 0, addTime: now - 40 + Math.min(i, 30) }));
}
function orders(count = 2) {
  return Array.from({ length: count }, (_, i) => ({ id: 17 + i, orderNo: `pink_order_${17 + i}`, unique: `unique_${17 + i}`,
    uid: 11 + i, type: 3, activityId: 3, pinkId: 100, paid: 1, isDel: 0, isSystemDel: 0, refundStatus: 0, pendingRefund: false }));
}
const memberResults = (rows = members()) => rows.map(member => ({ member, resolution: true }));
const orderResults = (rows = orders()) => rows.map(order => ({ order, resolution: true }));
function query(groupRows = members(), orderRows = orders()) {
  let count = 0;
  const execute = vi.fn(async (_query: unknown): Promise<unknown[]> => ++count === 1 ? [context()] : count === 2 ? memberResults(groupRows) : orderResults(orderRows));
  const nested = { execute } as unknown as DbClient;
  const transaction = vi.fn(async (fn: (value: DbClient) => Promise<unknown>) => fn(nested));
  const tx = { execute, transaction } as unknown as DbClient;
  return { tx, nested, execute, transaction };
}
const message = '小程序原账号订阅通知批准、凭据或证据尚未完整就绪';
const unavailable = { kind: 'original', request: { format: 4, unavailable: true } };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
function mac(domain: string, value: unknown, key = env.APP_KEY) {
  return createHmac('sha256', key).update('cinashop.routine.original-payment.subscription-' + domain + '.v1\0').update(canonical(value)).digest('hex');
}
function projection(rows = members()) {
  return rows.map(m => ({ id: m.id, uid: m.uid, orderId: m.orderId, orderIdKey: m.orderIdKey, combinationId: m.combinationId,
    productId: m.productId, kId: m.kId, people: m.people, isVirtual: m.isVirtual, addTime: m.addTime }));
}
async function signed(): Promise<Readonly<RoutineSubscriptionPinkRequest>> {
  const f = query(), candidate = await prepareRoutineSubscriptionPinkRequestsTx(f.tx, env, { pinkId: 100, now });
  const outcome = createRoutineSubscriptionPinkRequestTx(f.tx, candidate, raw());
  if (outcome.kind !== 'original' || 'unavailable' in outcome.request) throw Error('Expected explicit signed codec fixture'); return outcome.request;
}
function fresh(groupRows = members(), orderRows = [orders()[0]!]) {
  let count = 0;
  const execute = vi.fn(async (_query: unknown): Promise<unknown[]> => ++count === 1 ? memberResults(groupRows) : orderResults(orderRows));
  return { execute, tx: { execute } as unknown as DbClient };
}

describe('independent pink request4 and bounded same-transaction formation batch', () => {
  beforeEach(() => { catalog.mockReset().mockResolvedValue(ready()); });

  it('independently MAC-binds unchanged five business fields, complete formation and one real member', async () => {
    const f = query(), candidate = await prepareRoutineSubscriptionPinkRequestsTx(f.tx, env, { pinkId: 100, now });
    const outcome = createRoutineSubscriptionPinkRequestTx(f.tx, candidate, raw());
    if (outcome.kind !== 'original' || 'unavailable' in outcome.request) throw Error('Missing signed fixture');
    const request = outcome.request;
    expect(request).toMatchObject({ format: 4, scope, actor, eventKey: raw().eventKey, aggregateId: 17, eventTime: now, body: business,
      group: { pinkId: 100, combinationId: 3, productId: 9, people: 2, completedAt: now + 7, realMembers: 2, virtualMembers: 0,
        memberIds: [100, 101], membersDigest: mac('pink-formation', projection()) },
      member: { id: 100, uid: 11, orderId: 17, orderNo: business.orderNo, orderIdKey: '17', addTime: now - 40 }, createdAt: now + 1 });
    const { signature, ...unsigned } = request; expect(signature).toBe(mac('pink-notice-request', unsigned));
    expect(parseRoutineSubscriptionPinkRequest(env, JSON.parse(JSON.stringify(request)), scope)).toEqual(request);
    expect(catalog).toHaveBeenCalledTimes(1); expect(f.transaction).toHaveBeenCalledTimes(1); expect(f.execute).toHaveBeenCalledTimes(3);
    expect(f.transaction.mock.calls[0]![0]).toBeTypeOf('function');
    const queries = f.execute.mock.calls.map(([q]) => new PgDialect().sqlToQuery(q as never).sql);
    expect(queries[0]).toContain('current_user=session_user'); expect(queries[1]).toContain('LIMIT 501 FOR SHARE OF p NOWAIT');
    expect(queries[2]).toContain('LIMIT 501 FOR SHARE OF o NOWAIT');
    for (const q of queries) {
      expect(q).not.toMatch(/pg_(?:try_)?advisory|set_config|\bGRANT\b|\bINSERT\s+INTO\b|\bUPDATE\b/u);
      expect(q).not.toMatch(/FROM\s+(?:public\.)?(?:routine_original_payment_evidence|routine_identity_ownership|routine_subscription_account_policy)\b/u);
    }
    for (const v of [candidate, outcome, request, request.body, request.scope, request.actor, request.group, request.group.memberIds, request.member]) expect(Object.isFrozen(v)).toBe(true);
  });

  it('captures primitive key and input before asynchronous catalog inspection', async () => {
    let release!: (v: ReturnType<typeof ready>) => void; catalog.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const input = { pinkId: 100, now }, mutable = { ...env }, f = query();
    const pending = prepareRoutineSubscriptionPinkRequestsTx(f.tx, mutable, input);
    input.pinkId = 200; input.now = 1; mutable.APP_KEY = 'changed'; release(ready());
    const candidate = await pending, outcome = createRoutineSubscriptionPinkRequestTx(f.tx, candidate, raw());
    if (outcome.kind !== 'original' || 'unavailable' in outcome.request) throw Error('Missing captured fixture');
    expect(parseRoutineSubscriptionPinkRequest(env, outcome.request, scope)).toEqual(outcome.request);
    expect(() => parseRoutineSubscriptionPinkRequest(mutable, outcome.request, scope)).toThrow(message);
  });

  it('resolves 500 buyers once and derives 500 independent requests without another SQL/catalog read', async () => {
    const f = query(members(500), orders(500)), candidate = await prepareRoutineSubscriptionPinkRequestsTx(f.tx, env, { pinkId: 100, now });
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const body = { ...business, orderId: 17 + i, orderNo: `pink_order_${17 + i}`, userId: 11 + i, people: 500 };
      const outcome = createRoutineSubscriptionPinkRequestTx(f.tx, candidate, raw(body));
      if (outcome.kind !== 'original' || 'unavailable' in outcome.request) throw Error('Missing bounded member ' + i);
      expect(outcome.request.member.uid).toBe(11 + i); expect(outcome.request.group.memberIds).toHaveLength(500); ids.add(outcome.request.requestId);
    }
    expect(ids.size).toBe(500); expect(catalog).toHaveBeenCalledTimes(1); expect(f.execute).toHaveBeenCalledTimes(3); expect(f.transaction).toHaveBeenCalledTimes(1);
  });

  it('signs virtual formation members only in the shared set and never gives them an order/request', async () => {
    const f = query(members(3, 1), orders(2)), candidate = await prepareRoutineSubscriptionPinkRequestsTx(f.tx, env, { pinkId: 100, now });
    const outcome = createRoutineSubscriptionPinkRequestTx(f.tx, candidate, raw({ ...business, people: 3 }));
    if (outcome.kind !== 'original' || 'unavailable' in outcome.request) throw Error('Missing virtual formation fixture');
    expect(outcome.request.group).toMatchObject({ realMembers: 2, virtualMembers: 1, memberIds: [100, 101, 102] });
    expect(() => createRoutineSubscriptionPinkRequestTx(f.tx, candidate, raw({ ...business, orderId: 19, userId: 0, people: 3 }))).toThrow(message);
    expect(createRoutineSubscriptionPinkRequestTx(f.tx, candidate, raw({ ...business, orderId: 19, orderNo: 'pink_order_19', userId: 13, people: 3 }))).toEqual(unavailable);
  });

  it('binds private candidate to exact outer transaction, group, event time and actual per-member body', async () => {
    const f = query(), candidate = await prepareRoutineSubscriptionPinkRequestsTx(f.tx, env, { pinkId: 100, now });
    expect(createRoutineSubscriptionPinkRequestTx(f.nested, candidate, raw())).toEqual(unavailable);
    expect(createRoutineSubscriptionPinkRequestTx(query().tx, candidate, raw())).toEqual(unavailable);
    expect(createRoutineSubscriptionPinkRequestTx(f.tx, JSON.parse(JSON.stringify(candidate)), raw())).toEqual(unavailable);
    expect(createRoutineSubscriptionPinkRequestTx(f.tx, undefined, raw())).toEqual(unavailable);
    for (const patch of [{ pinkId: 200 }, { people: 3 }, { userId: 22 }, { orderNo: 'foreign_order' }])
      expect(createRoutineSubscriptionPinkRequestTx(f.tx, candidate, raw({ ...business, ...patch }))).toEqual(unavailable);
    expect(createRoutineSubscriptionPinkRequestTx(f.tx, candidate, { ...raw(), now: now + 1 })).toEqual(unavailable);
    expect(f.execute).toHaveBeenCalledTimes(3);
  });

  it('keeps whole namespace absent legacy without writer or formation reads', async () => {
    catalog.mockResolvedValue({ present: false, ready: false, failures: [], binding: null }); const f = query();
    const candidate = await prepareRoutineSubscriptionPinkRequestsTx(f.tx, undefined, { pinkId: 100, now });
    expect(createRoutineSubscriptionPinkRequestTx(f.tx, candidate, raw())).toEqual({ kind: 'legacy' }); expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(['partial', 'binding', 'key', 'getter', 'inherit', 'root', 'writer', 'catalog-sql', 'writer-sql', 'group-sql', 'order-sql', 'savepoint'] as const)
    ('keeps unavailable or failed optional metadata %# unavailable4 without current pin fallback', async kind => {
      const f = query(); let reads = 0, key: { APP_KEY?: string } | undefined = env;
      if (kind === 'partial') catalog.mockResolvedValue({ ...ready(), ready: false });
      if (kind === 'binding') catalog.mockResolvedValue({ ...ready(), binding: null });
      if (kind === 'key') key = undefined;
      if (kind === 'getter') key = { get APP_KEY() { reads++; return env.APP_KEY; } };
      if (kind === 'inherit') key = Object.create(env);
      if (kind === 'root') Object.defineProperty(f.tx, '$client', { value: {} });
      if (kind === 'writer') f.execute.mockResolvedValueOnce([{ ...context(), ready: false }]);
      if (kind === 'catalog-sql') catalog.mockRejectedValue(Error('catalog query fault'));
      if (kind === 'writer-sql') f.execute.mockRejectedValueOnce(Error('writer query fault'));
      if (kind === 'group-sql') f.execute.mockResolvedValueOnce([context()]).mockRejectedValueOnce(Error('group query fault'));
      if (kind === 'order-sql') f.execute.mockResolvedValueOnce([context()]).mockResolvedValueOnce(memberResults()).mockRejectedValueOnce(Error('orders query fault'));
      if (kind === 'savepoint') f.transaction.mockRejectedValueOnce(Error('SAVEPOINT failed'));
      const candidate = await prepareRoutineSubscriptionPinkRequestsTx(f.tx, key, { pinkId: 100, now });
      expect(createRoutineSubscriptionPinkRequestTx(f.tx, candidate, raw())).toEqual(unavailable); expect(reads).toBe(0);
    });

  it.each(['underfull', 'overflow', 'duplicate-member', 'duplicate-user', 'wrong-activity', 'wrong-product', 'wrong-root', 'pending', 'refunded', 'virtual-uid', 'virtual-order', 'shadow'] as const)
    ('rejects incomplete or contradictory initial formation %#', async kind => {
      let m = members();
      if (kind === 'underfull') m = m.slice(0, 1);
      if (kind === 'overflow') m = members(501);
      if (kind === 'duplicate-member') m[1]!.id = 100;
      if (kind === 'duplicate-user') m[1]!.uid = 11;
      if (kind === 'wrong-activity') m[1]!.combinationId = 4;
      if (kind === 'wrong-product') m[1]!.productId = 10;
      if (kind === 'wrong-root') m[1]!.kId = 200;
      if (kind === 'pending') m[1]!.status = 1;
      if (kind === 'refunded') m[1]!.isRefund = 100;
      if (kind === 'virtual-uid') m[1]!.isVirtual = 1;
      if (kind === 'virtual-order') { m[1]!.isVirtual = 1; m[1]!.uid = 0; }
      const f = query(m);
      if (kind === 'shadow') f.execute.mockResolvedValueOnce([context()]).mockResolvedValueOnce(memberResults().map(r => ({ ...r, resolution: false })));
      const candidate = await prepareRoutineSubscriptionPinkRequestsTx(f.tx, env, { pinkId: 100, now });
      expect(createRoutineSubscriptionPinkRequestTx(f.tx, candidate, raw())).toEqual(unavailable);
    });

  it.each(['missing-order', 'duplicate-order', 'wrong-order', 'wrong-uid', 'wrong-key', 'wrong-group', 'unpaid', 'deleted', 'shadow'] as const)
    ('rejects incomplete or conflicting actual per-buyer order identities %#', async kind => {
      let o = orders(); const m = members();
      if (kind === 'missing-order') o = o.slice(0, 1);
      if (kind === 'duplicate-order') o[1]!.id = 17;
      if (kind === 'wrong-order') o[1]!.orderNo = 'foreign_order';
      if (kind === 'wrong-uid') o[1]!.uid = 11;
      if (kind === 'wrong-key') m[1]!.orderIdKey = 'foreign_key';
      if (kind === 'wrong-group') o[1]!.pinkId = 200;
      if (kind === 'unpaid') o[1]!.paid = 0;
      if (kind === 'deleted') o[1]!.isSystemDel = 1;
      const f = query(m, o);
      if (kind === 'shadow') f.execute.mockResolvedValueOnce([context()]).mockResolvedValueOnce(memberResults()).mockResolvedValueOnce(orderResults().map(r => ({ ...r, resolution: false })));
      const candidate = await prepareRoutineSubscriptionPinkRequestsTx(f.tx, env, { pinkId: 100, now });
      expect(createRoutineSubscriptionPinkRequestTx(f.tx, candidate, raw())).toEqual(unavailable);
    });

  it('does not let one other buyer pending refund prevent independent candidates, but denies that buyer', async () => {
    const o = orders(); o[1]!.pendingRefund = true; o[1]!.refundStatus = 1;
    const f = query(members(), o), candidate = await prepareRoutineSubscriptionPinkRequestsTx(f.tx, env, { pinkId: 100, now });
    expect(createRoutineSubscriptionPinkRequestTx(f.tx, candidate, raw())).toMatchObject({ kind: 'original', request: { format: 4, body: business } });
    expect(createRoutineSubscriptionPinkRequestTx(f.tx, candidate, raw({ ...business, orderId: 18, orderNo: 'pink_order_18', userId: 12 }))).toEqual(unavailable);
  });

  it('rejects DTO getters, symbols, extra fields and invalid primitive values before catalog I/O', async () => {
    let reads = 0; const f = query();
    for (const value of [{ pinkId: 100, now: 0 }, { pinkId: 0, now }, { pinkId: 100, now, extra: true },
      { get pinkId() { reads++; return 100; }, now }, { pinkId: 100, now, [Symbol('foreign')]: 1 }])
      await expect(prepareRoutineSubscriptionPinkRequestsTx(f.tx, env, value)).rejects.toThrow(message);
    for (const body of [{ ...business, userId: 0 }, { ...business, people: 501 }, { ...business, orderNo: '\ud800' }, { ...business, extra: true },
      { ...business, get userId() { reads++; return 11; } }]) expect(() => captureRoutineSubscriptionPinkBusiness(body)).toThrow(message);
    expect(reads).toBe(0); expect(catalog).not.toHaveBeenCalled();
  });

  it('does not invoke source field getters or primitive coercion hooks', async () => {
    let reads = 0;
    const getter = { ...members()[0]! }; Object.defineProperty(getter, 'nickname', { enumerable: true, get() { reads++; return 'foreign'; } });
    for (const row of [getter, { ...members()[0]!, isVirtual: { valueOf() { reads++; return 0; } } }]) {
      const f = query(); f.execute.mockResolvedValueOnce([context()]).mockResolvedValueOnce([{ member: row, resolution: true }, ...memberResults().slice(1)]);
      const candidate = await prepareRoutineSubscriptionPinkRequestsTx(f.tx, env, { pinkId: 100, now });
      expect(createRoutineSubscriptionPinkRequestTx(f.tx, candidate, raw())).toEqual(unavailable);
    }
    expect(reads).toBe(0);
  });

  it('fresh-matches exact signed membership and target while allowing another signed member later to refund', async () => {
    const request = await signed(), m = members(); m[1]!.status = 3; m[1]!.isRefund = 100; m[1]!.stopTime = now + 50;
    const f = fresh(m);
    expect(await readRoutineSubscriptionPinkTargetTx(f.tx, env, request)).toEqual({ group: request.group, member: request.member,
      leaderNickname: '团长123', memberAddTime: now - 40 });
    expect(f.execute).toHaveBeenCalledTimes(2);
    const sql = new PgDialect().sqlToQuery(f.execute.mock.calls[0]![0] as never).sql;
    expect(sql).toContain('ANY('); expect(sql).toContain('p.status=2 AND p.is_refund=0');
  });

  it.each(['missing', 'undeclared', 'identity', 'leader-refund', 'target-refund', 'leader-time', 'pending-refund', 'target-order'] as const)
    ('denies fresh changed identity, decision or target qualification %#', async kind => {
      const request = await signed(); let m = members(); const o = [orders()[0]!];
      if (kind === 'missing') m = m.slice(0, 1);
      if (kind === 'undeclared') m.push({ ...m[1]!, id: 102, uid: 13, orderId: 'pink_order_19', orderIdKey: '19' });
      if (kind === 'identity') m[1]!.orderIdKey = 'foreign_key';
      if (kind === 'leader-refund' || kind === 'target-refund') m[0]!.isRefund = 100;
      if (kind === 'leader-time') m[0]!.stopTime = now + 8;
      if (kind === 'pending-refund') o[0]!.pendingRefund = true;
      if (kind === 'target-order') o[0]!.orderNo = 'foreign_order';
      await expect(readRoutineSubscriptionPinkTargetTx(fresh(m, o).tx, env, request)).rejects.toThrow(message);
    });

  it('parses history without a live catalog and rejects other versions/domains, scope, key, getters and tampering', async () => {
    const request = await signed(), { signature: _signature, ...unsigned } = request;
    catalog.mockRejectedValue(Error('Parser must not inspect current catalog'));
    expect(parseRoutineSubscriptionPinkRequest(env, JSON.parse(JSON.stringify(request)), scope)).toEqual(request);
    for (const value of [{ format: 4, unavailable: true }, { ...request, format: 2 }, { ...request, format: 3 }, { ...request, extra: true },
      { ...request, signature: mac('notice-request', unsigned) }, { ...request, signature: mac('refusal-notice-request', unsigned) },
      { ...request, eventKey: 'order.delivery.notice:17' }, { ...request, member: { ...request.member, addTime: now - 1 } },
      { ...request, group: { ...request.group, memberIds: [101, 100] } }, { ...request, group: { ...request.group, memberIds: [100, 100] } },
      { ...request, group: { ...request.group, realMembers: 1 } }]) expect(() => parseRoutineSubscriptionPinkRequest(env, value, scope)).toThrow(message);
    expect(() => parseRoutineSubscriptionPinkRequest({ APP_KEY: 'wrong-key' }, request, scope)).toThrow(message);
    expect(() => parseRoutineSubscriptionPinkRequest(env, request, { ...scope, databaseOid: '999' })).toThrow(message);
    let reads = 0; const getter = { ...request.group, get membersDigest() { reads++; return request.group.membersDigest; } };
    expect(() => parseRoutineSubscriptionPinkRequest(env, { ...request, group: getter }, scope)).toThrow(message); expect(reads).toBe(0);
  });
});
