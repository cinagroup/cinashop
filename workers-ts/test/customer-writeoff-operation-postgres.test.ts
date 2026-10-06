import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../src/lib/di';
import { outRequestHash } from '../src/services/out/OutIdempotency';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { installCustomerWorkScopeLock } from '../src/migrations/runCustomerWorkScopeLock';
import { CUSTOMER_WORK_LOCK_FUNCTIONS } from '../src/migrations/customerWorkRuntimePrivilegePlan';
import { CUSTOMER_WRITEOFF_FUNCTIONS, customerWriteoffRuntimePrivilegePlan } from '../src/migrations/customerWriteoffRuntimePlan';
import { CUSTOMER_WRITEOFF_MAINTENANCE_LOCK_KEY, CUSTOMER_WRITEOFF_MAX_JSON_BYTES, CUSTOMER_WRITEOFF_OPERATION_INSTALLATION_SQL } from '../src/migrations/customerWriteoffOperation';
import { CUSTOMER_WRITEOFF_OPERATION_CATALOG_SHA256, CUSTOMER_WRITEOFF_OPERATION_CATALOG_SQL,
  inspectCustomerWriteoffOperation, assertCustomerWriteoffOperationCatalog,
  customerWriteoffOperationReadiness, runCustomerWriteoffOperation } from '../src/migrations/runCustomerWriteoffOperation';

type Native = Extract<Awaited<ReturnType<typeof sequenceRunnerDatabase>>, { format: 'pg16' }>;
type Peer = SequenceRunnerPeer & { role: string; connectionString: string };
const ident = (value: string) => {
  if (!/^[a-z_][a-z_0-9]{0,62}$/.test(value)) throw Error('Unsafe owned writeoff catalog identifier');
  return `"${value}"`;
};
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const json = (value: unknown) => `${literal(JSON.stringify(value))}::jsonb`;
const hash = (value: string) => value.repeat(64);
function postgresCode(error: unknown): string | undefined {
  let next = error;
  for (let i = 0; i < 8 && next && typeof next === 'object'; i++) {
    const row = next as { code?: unknown; cause?: unknown };
    if (typeof row.code === 'string') return row.code;
    next = row.cause;
  }
  return undefined;
}
async function rejectsCode(pending: Promise<unknown>, code: string) {
  let error: unknown;
  try { await pending; } catch (failure) { error = failure; }
  expect(error).toBeDefined(); expect(postgresCode(error)).toBe(code);
}
const relations = ['user', 'store_service', 'express_company', 'delivery_service', 'customer_writeoff_operation_request'];
async function fixture(ledger = true) {
  const candidate = await sequenceRunnerDatabase();
  if (candidate.format !== 'pg16' || !candidate.withRuntimeRole) { await candidate.close(); throw Error('Writeoff catalog requires native PG16 independent LOGIN'); }
  const f = candidate as Native, owner = `cwo_scope_${randomUUID().replaceAll('-', '')}`;
  let ownerCreated = false;
  const close = async () => { try { if (ownerCreated) await f.exec(`DROP OWNED BY ${ident(owner)}; DROP ROLE ${ident(owner)}`); } finally { await f.close(); } };
  try {
    await f.exec(`CREATE TABLE public."user"(uid integer PRIMARY KEY,status integer NOT NULL DEFAULT 1);
 CREATE TABLE public.store_service(id integer PRIMARY KEY,uid integer NOT NULL,online integer NOT NULL DEFAULT 0,customer integer NOT NULL DEFAULT 1);
 CREATE TABLE public.express_company(id integer PRIMARY KEY);
 CREATE TABLE public.delivery_service(id integer PRIMARY KEY,uid integer NOT NULL);
 INSERT INTO public."user"(uid) VALUES(101); INSERT INTO public.store_service(id,uid) VALUES(1,101);
 INSERT INTO public.express_company(id) VALUES(1); INSERT INTO public.delivery_service(id,uid) VALUES(1,102);`);
    await f.exec(`CREATE ROLE ${ident(owner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    ownerCreated = true;
    await installCustomerWorkScopeLock(f.db, owner);
    if (ledger) await runCustomerWriteoffOperation(f.db);
    const app = <T>(callback: (peer: Peer) => Promise<T>) => f.withRuntimeRole(async peer => {
      const plan = customerWriteoffRuntimePrivilegePlan();
      for (const table of relations.filter(name => ledger || name !== 'customer_writeoff_operation_request')) {
        const privileges = plan.tables[table];
        if (!privileges) throw Error('Installed writeoff relation absent from fixed runtime plan');
        if (privileges.length) await f.exec(`GRANT ${privileges.join(',')} ON public.${ident(table)} TO ${ident(peer.role)}`);
        const columns = plan.updateColumns[table];
        if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(ident).join(',')}) ON public.${ident(table)} TO ${ident(peer.role)}`);
      }
      for (const signature of [...CUSTOMER_WORK_LOCK_FUNCTIONS, ...(ledger ? CUSTOMER_WRITEOFF_FUNCTIONS : [])]) {
        expect(plan.functions).toContain(signature);
        await f.exec(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${ident(peer.role)}`);
      }
      const [identity] = await peer.exec(`SELECT current_database() AS database,current_user AS role,session_user AS session,
 pg_backend_pid() AS pid,current_setting('server_version_num')::integer AS version,
 (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated`);
      expect(identity).toMatchObject({ role: peer.role, session: peer.role, pid: peer.pid, elevated: false });
      expect(Math.floor(Number(identity.version) / 10000)).toBe(16);
      return callback(peer);
    });
    return { ...f, owner, app, close };
  } catch (error) { await close(); throw error; }
}
async function withFixture(callback: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, ledger = true) {
  const f = await fixture(ledger); try { await callback(f); } finally { await f.close(); }
}
function intent(items = [{ cart_row_id: 7, writeoff_num: 2 }]) {
  return { version: 'customer-work-writeoff-operation-v1', scope_key: hash('a'), order_id: 11,
    expected_order_revision: hash('b'), expected_writeoff_revision: hash('c'),
    payload: { order_no: 'PHYSICAL_SN', root_order_id: 5, root_order_no: 'ROOT_SN', code: '123456789012', target_fingerprint: hash('d'), items } };
}
function settlement() {
  return { version: 'customer-writeoff-settlement-v1', take_delivery_status_id: 71,
    supplier_rows: [{ row_id: 81, before_status: 0, after_status: 1, amount: '7.00', pm: 1, type: 1 }],
    reward_rows: [{ row_id: 91, uid: 201, link_id: '11', category: 'integral', event_key: 'order_reward', type: 'gain', pm: 1, amount: '2.00', balance: '12.00' }],
    brokerage_rows: [{ row_id: 101, uid: 202, link_id: '11', type: 'order', source_type: '', pm: 1, amount: '1.00', balance: '11.00' }],
    account_deltas: [
      { uid: 201, integral_before: 10, integral_after: 12, exp_before: '0.00', exp_after: '0.00', brokerage_before: '0.00', brokerage_after: '0.00' },
      { uid: 202, integral_before: 0, integral_after: 0, exp_before: '0.00', exp_after: '0.00', brokerage_before: '10.00', brokerage_after: '11.00' },
    ],
    paid_root: { order_id: 5, order_no: 'ROOT_SN', uid: 201, pay_type: 'cash', pay_price: '14.00', paid: 1, identity_hash: hash('e') },
    paid_outbox_rows: [{ row_id: 111, event_key: 'order.paid:5:cash', event_type: 'order.paid', payload_hash: hash('f') }], new_paid_outbox_count: 0 };
}
async function evidence(body = intent(), completed = false) {
  return { verified: true, order_completed: completed, status: completed ? 2 : 5, physical_order_id: body.order_id, root_order_id: body.payload.root_order_id,
    writeoff_rows: body.payload.items.map((item, index) => ({ writeoff_id: index + 1, cart_row_id: item.cart_row_id,
      opaque_cart_id: `opaque-${item.cart_row_id}`, quantity: item.writeoff_num, before_remaining: completed ? item.writeoff_num : item.writeoff_num + 4,
      after_remaining: completed ? 0 : 4, writeoff_price: '14.00', snapshot_hash: hash('e'), sale_price_hash: hash('f') })),
    before_code_hash: await outRequestHash(body.payload.code), after_code_hash: await outRequestHash(completed ? '' : '123456789013'),
    post_order_revision: hash('a'), post_writeoff_revision: hash('b'), settlement: completed ? settlement() : null };
}
async function validIntent(db: Pick<SequenceRunnerPeer, 'exec'>, value: unknown, kind = 'writeoff') {
  return (await db.exec(`SELECT public.customer_writeoff_intent_valid_v1(${literal(kind)},${json(value)}) AS valid`))[0].valid;
}
async function validEvidence(db: Pick<SequenceRunnerPeer, 'exec'>, value: unknown, outcome = 'partial-writtenoff', body: unknown = intent(), kind = 'writeoff') {
  return (await db.exec(`SELECT public.customer_writeoff_evidence_valid_v1(${literal(kind)},${literal(outcome)},${json(body)},${json(value)}) AS valid`))[0].valid;
}
async function receiptSql(overrides: Record<string, unknown> = {}) {
  const body = intent();
  const row: Record<string, unknown> = { actor_uid: 101, request_key: randomUUID(), request_hash: hash('d'), service_id: 1, order_id: body.order_id,
    kind: 'writeoff', outcome: 'partial-writtenoff', scope_key: body.scope_key, expected_revision: body.expected_order_revision,
    expected_writeoff_revision: body.expected_writeoff_revision, intent: body, evidence: await evidence(body), ...overrides };
  const columns = Object.keys(row);
  return `INSERT INTO public.customer_writeoff_operation_request(${columns.map(ident).join(',')}) VALUES(${columns.map(name => name === 'intent' || name === 'evidence'
    ? json(row[name]) : typeof row[name] === 'number' ? String(row[name]) : literal(String(row[name]))).join(',')})`;
}
const count = async (peer: Pick<SequenceRunnerPeer, 'exec'>) => Number((await peer.exec('SELECT count(*) AS n FROM public.customer_writeoff_operation_request'))[0].n);

describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('customer writeoff operation PG16 independent LOGIN contract', () => {
  it('measures thirteen columns and both exact immutable validator catalogs on actual PG16', async () => {
    await withFixture(async f => {
      const state = await inspectCustomerWriteoffOperation(f.db);
      const [shape] = await f.db.execute<{ shape: unknown }>(sql.raw(CUSTOMER_WRITEOFF_OPERATION_CATALOG_SQL));
      expect(state.present).toBe(true); expect(state.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      const [server] = await f.exec("SELECT current_database() AS database,current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version");
      const [columns] = await f.exec("SELECT count(*) AS n FROM pg_attribute WHERE attrelid='public.customer_writeoff_operation_request'::regclass AND attnum>0 AND NOT attisdropped");
      expect(Number(columns.n)).toBe(13);
      console.info('CUSTOMER_WRITEOFF_CANONICAL_PG16 ' + JSON.stringify({ server, fingerprint: state.fingerprint, expected: CUSTOMER_WRITEOFF_OPERATION_CATALOG_SHA256, shape: shape.shape }));
      if (CUSTOMER_WRITEOFF_OPERATION_CATALOG_SHA256.startsWith('NOT_MEASURED')) {
        expect(state.complete).toBe(false); await expect(assertCustomerWriteoffOperationCatalog(f.db)).rejects.toThrow();
      } else { expect(state.fingerprint).toBe(CUSTOMER_WRITEOFF_OPERATION_CATALOG_SHA256); expect(state.complete).toBe(true); }
    });
  }, 60000);
  it('reports missing installation from runtime reads without DDL or privilege repair', async () => {
    await withFixture(async f => { await f.app(async peer => {
      expect(await customerWriteoffOperationReadiness(peer.db)).toMatchObject({ ready: false, reason: 'customer_writeoff_operation_not_installed' });
      await expect(assertCustomerWriteoffOperationCatalog(peer.db)).rejects.toThrow();
      expect((await peer.exec("SELECT to_regclass('public.customer_writeoff_operation_request') AS relation"))[0].relation).toBeNull();
    }); }, false);
  }, 60000);
  it('accepts commissioned append-only LOGIN authority and rejects owner reinstall', async () => {
    await withFixture(async f => {
      const before = await inspectCustomerWriteoffOperation(f.db); expect(before.complete).toBe(true);
      await expect(runCustomerWriteoffOperation(f.db)).rejects.toThrow('Existing'); expect(await inspectCustomerWriteoffOperation(f.db)).toEqual(before);
      await f.app(async peer => { expect(await customerWriteoffOperationReadiness(peer.db)).toMatchObject({ ready: true,
        privileges: { read: true, append: true, mutable: false, append_only_acl: true, validator_safe: true, authority_safe: true } }); });
    });
  }, 60000);
  it('accepts the full two-hundred sorted physical-row intent and rejects empty or excess selections', async () => {
    await withFixture(async f => { await f.app(async peer => {
      expect(await validIntent(peer, intent())).toBe(true);
      const twoHundred = Array.from({ length: 200 }, (_, i) => ({ cart_row_id: i + 1, writeoff_num: 1 }));
      expect(await validIntent(peer, intent(twoHundred))).toBe(true);
      expect(await validIntent(peer, intent([]))).toBe(false);
      expect(await validIntent(peer, intent([...twoHundred, { cart_row_id: 201, writeoff_num: 1 }]))).toBe(false);
    }); });
  }, 60000);
  it('rejects nonobjects scalars arrays null and missing keys without unsafe JSON operators', async () => {
    await withFixture(async f => { await f.app(async peer => {
      for (const malformed of [null, 7, true, 'bad', []]) {
        expect(await validIntent(peer, malformed)).toBe(false);
        expect(await validIntent(peer, { ...intent(), payload: malformed })).toBe(false);
        expect(await validIntent(peer, { ...intent(), payload: { ...intent().payload, items: malformed } })).toBe(false);
        expect(await validIntent(peer, { ...intent(), payload: { ...intent().payload, items: [malformed] } })).toBe(false);
        expect(await validEvidence(peer, malformed)).toBe(false);
      }
      expect((await peer.exec('SELECT public.customer_writeoff_intent_valid_v1(NULL,NULL) AS intent,public.customer_writeoff_evidence_valid_v1(NULL,NULL,NULL,NULL) AS evidence'))[0]).toEqual({ intent: false, evidence: false });
    }); });
  }, 60000);
  it('rejects identity aliases forged actor fields unsorted duplicate rows and noncanonical int4 quantities', async () => {
    await withFixture(async f => { await f.app(async peer => {
      for (const patch of [{ order_id: '11' }, { order_id: 0 }, { order_id: 2147483648 }, { actor_uid: 101 }, { version: 'customer-work-financial-operation-v1' }, { scope_key: hash('A') }])
        expect(await validIntent(peer, { ...intent(), ...patch })).toBe(false);
      for (const items of [[{ cart_row_id: 1, writeoff_num: 1 }, { cart_row_id: 1, writeoff_num: 1 }],
        [{ cart_row_id: 2, writeoff_num: 1 }, { cart_row_id: 1, writeoff_num: 1 }], [{ cart_id: 1, writeoff_num: 1 }],
        [{ cart_row_id: 1, writeoff_num: '1' }], [{ cart_row_id: 1, writeoff_num: 0 }], [{ cart_row_id: 1, writeoff_num: -1 }],
        [{ cart_row_id: 1, writeoff_num: 1.5 }], [{ cart_row_id: 1, writeoff_num: 2147483648 }], [{ cart_row_id: 1, writeoff_num: 1, staff_id: 101 }]])
        expect(await validIntent(peer, { ...intent(), payload: { ...intent().payload, items } })).toBe(false);
      expect(await validIntent(peer, intent([{ cart_row_id: 2147483647, writeoff_num: 2147483647 }]))).toBe(true);
      expect(await validIntent(peer, intent(), 'delivery')).toBe(false);
    }); });
  }, 60000);
  it('requires exact twelve-digit code ASCII order numbers and lowercase identity hashes', async () => {
    await withFixture(async f => { await f.app(async peer => {
      for (const patch of [{ code: 123456789012 }, { code: ' 123456789012' }, { code: '123456789012\n' }, { code: '１２３４５６７８９０１２' },
        { order_no: '订单' }, { order_no: ' SN' }, { root_order_no: 'x'.repeat(33) }, { root_order_id: '5' }, { target_fingerprint: hash('A') }, { customer: true }])
        expect(await validIntent(peer, { ...intent(), payload: { ...intent().payload, ...patch } })).toBe(false);
      expect(await validIntent(peer, { ...intent(), payload: { ...intent().payload, order_no: 'a'.repeat(32), root_order_no: 'ROOT_1-2' } })).toBe(true);
    }); });
  }, 60000);
  it('binds partial and completed outcomes to the original selected rows and canonical code hashes', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const partial = await evidence(), final = await evidence(intent(), true);
      expect(await validEvidence(peer, partial)).toBe(true);
      expect(await validEvidence(peer, final, 'written-off')).toBe(true);
      expect(await validEvidence(peer, {}, 'abandoned')).toBe(true);
      expect(await validEvidence(peer, { code: 'authority_revoked' }, 'rollback-rejected')).toBe(true);
      for (const patch of [{ verified: false }, { status: 2 }, { order_completed: true }, { physical_order_id: 5 }, { root_order_id: 11 },
        { before_code_hash: hash('a') }, { after_code_hash: partial.before_code_hash }, { after_code_hash: await outRequestHash('') }, { settlement: settlement() }, { extra: 1 }])
        expect(await validEvidence(peer, { ...partial, ...patch })).toBe(false);
      for (const patch of [{ status: 5 }, { order_completed: false }, { after_code_hash: partial.after_code_hash }, { settlement: null }])
        expect(await validEvidence(peer, { ...final, ...patch }, 'written-off')).toBe(false);
      expect(await validEvidence(peer, partial, 'written-off')).toBe(false);
      expect(await validEvidence(peer, final, 'partial-writtenoff')).toBe(false);
      expect(await validEvidence(peer, final, 'success')).toBe(false);
    }); });
  }, 60000);
  it('rejects fabricated record IDs changed quantities remaining counters prices and immutable proof hashes', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const value = await evidence();
      for (const patch of [{ writeoff_id: 0 }, { cart_row_id: 8 }, { quantity: 1 }, { before_remaining: 7 }, { after_remaining: -1 },
        { after_remaining: '4' }, { writeoff_price: 14 }, { writeoff_price: '014.00' }, { writeoff_price: '14.0' },
        { snapshot_hash: null }, { sale_price_hash: hash('A') }, { operator_uid: 101 }])
        expect(await validEvidence(peer, { ...value, writeoff_rows: [{ ...value.writeoff_rows[0], ...patch }] })).toBe(false);
      for (const writeoff_rows of [[], [null], 7, null]) expect(await validEvidence(peer, { ...value, writeoff_rows })).toBe(false);
      const body = intent([{ cart_row_id: 7, writeoff_num: 1 }, { cart_row_id: 9, writeoff_num: 1 }]), multi = await evidence(body);
      expect(await validEvidence(peer, multi, 'partial-writtenoff', body)).toBe(true);
      expect(await validEvidence(peer, { ...multi, writeoff_rows: [...multi.writeoff_rows].reverse() }, 'partial-writtenoff', body)).toBe(false);
      expect(await validEvidence(peer, { ...multi, writeoff_rows: multi.writeoff_rows.map(row => ({ ...row, writeoff_id: 1 })) }, 'partial-writtenoff', body)).toBe(false);
      const final = await evidence(intent(), true);
      expect(await validEvidence(peer, { ...final, writeoff_rows: [{ ...final.writeoff_rows[0], before_remaining: 3, after_remaining: 1 }] }, 'written-off')).toBe(false);
    }); });
  }, 60000);
  it('accepts a two-hundred record receipt above sixteen KiB without truncation', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const body = intent(Array.from({ length: 200 }, (_, i) => ({ cart_row_id: i + 1, writeoff_num: 1 }))), value = await evidence(body);
      const [size] = await peer.exec(`SELECT octet_length(${json(value)}::text) AS bytes`);
      expect(Number(size.bytes)).toBeGreaterThan(16384); expect(Number(size.bytes)).toBeLessThanOrEqual(CUSTOMER_WRITEOFF_MAX_JSON_BYTES);
      expect(await validEvidence(peer, value, 'partial-writtenoff', body)).toBe(true);
      await peer.exec(await receiptSql({ intent: body, evidence: value })); expect(await count(peer)).toBe(1);
    }); });
  }, 60000);
  it('counts opaque IDs by Unicode code point and rejects controls edge whitespace NUL and lone surrogates', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const value = await evidence(), withOpaque = (opaque_cart_id: string) => ({ ...value, writeoff_rows: [{ ...value.writeoff_rows[0], opaque_cart_id }] });
      expect(await validEvidence(peer, withOpaque('😀'.repeat(128)))).toBe(true);
      for (const opaque of ['😀'.repeat(129), '', ' opaque', 'opaque\u00a0', '\ufeffopaque', 'opaque\nID', 'opaque\u0001ID', 'opaque\u007fID'])
        expect(await validEvidence(peer, withOpaque(opaque))).toBe(false);
      await expect(validEvidence(peer, withOpaque('opaque\u0000ID'))).rejects.toThrow();
      await expect(validEvidence(peer, withOpaque('opaque\ud800ID'))).rejects.toThrow();
    }); });
  }, 60000);
  it('requires every exact settlement key and typed arrays without scalar coercion', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const value = await evidence(intent(), true), proof = settlement();
      for (const field of Object.keys(proof)) {
        const missing: Record<string, unknown> = { ...proof }; delete missing[field];
        expect(await validEvidence(peer, { ...value, settlement: missing }, 'written-off')).toBe(false);
      }
      for (const malformed of [null, 7, true, 'bad', []]) expect(await validEvidence(peer, { ...value, settlement: malformed }, 'written-off')).toBe(false);
      for (const field of ['supplier_rows', 'reward_rows', 'brokerage_rows', 'account_deltas', 'paid_outbox_rows'])
        for (const malformed of [null, 7, '[]', {}, [null], [true]])
          expect(await validEvidence(peer, { ...value, settlement: { ...proof, [field]: malformed } }, 'written-off')).toBe(false);
      expect(await validEvidence(peer, { ...value, settlement: { ...proof, extra: 1 } }, 'written-off')).toBe(false);
    }); });
  }, 60000);
  it('permits only bound paid roots and no new paid outbox while keeping real guest and zero-price shapes', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const value = await evidence(intent(), true), proof = settlement();
      for (const patch of [{ order_id: 11 }, { order_no: 'PHYSICAL_SN' }, { uid: -1 }, { uid: '0' }, { paid: 0 }, { paid: true },
        { pay_price: '0' }, { pay_type: '' }, { identity_hash: hash('A') }, { customer_origin: true }])
        expect(await validEvidence(peer, { ...value, settlement: { ...proof, paid_root: { ...proof.paid_root, ...patch } } }, 'written-off')).toBe(false);
      const guest = { ...proof, supplier_rows: [], reward_rows: [], brokerage_rows: [], account_deltas: [], paid_outbox_rows: [],
        paid_root: { ...proof.paid_root, uid: 0, pay_price: '0.00' } };
      expect(await validEvidence(peer, { ...value, settlement: guest }, 'written-off')).toBe(true);
      for (const new_paid_outbox_count of [1, '0', -1, true])
        expect(await validEvidence(peer, { ...value, settlement: { ...proof, new_paid_outbox_count } }, 'written-off')).toBe(false);
      // This is typed receipt structure only; actual guest authorization requires the server's origin proof.
    }); });
  }, 60000);
  it('rejects supplier status type price and ordering aliases and accepts all valid boundary rows', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const value = await evidence(intent(), true), proof = settlement(), row = proof.supplier_rows[0];
      for (const patch of [{ row_id: 0 }, { before_status: 2 }, { after_status: 0 }, { pm: 2 }, { type: 0 }, { amount: '-1.00' }, { amount: '10000000000.00' }, { extra: 1 }])
        expect(await validEvidence(peer, { ...value, settlement: { ...proof, supplier_rows: [{ ...row, ...patch }] } }, 'written-off')).toBe(false);
      for (const rows of [[row, row], [{ ...row, row_id: 82 }, row]])
        expect(await validEvidence(peer, { ...value, settlement: { ...proof, supplier_rows: rows } }, 'written-off')).toBe(false);
      const rows = Array.from({ length: 200 }, (_, i) => ({ ...row, row_id: i + 1, before_status: 1, amount: '0.00', type: 2 }));
      expect(await validEvidence(peer, { ...value, settlement: { ...proof, supplier_rows: rows } }, 'written-off')).toBe(true);
      expect(await validEvidence(peer, { ...value, settlement: { ...proof, supplier_rows: [...rows, { ...row, row_id: 201 }] } }, 'written-off')).toBe(false);
    }); });
  }, 60000);
  it('binds reward and brokerage recipients to positive accounts and keeps compensation link IDs canonical', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const value = await evidence(intent(), true), proof = settlement();
      for (const field of ['reward_rows', 'brokerage_rows'] as const) {
        const row = proof[field][0];
        for (const patch of [{ uid: 0 }, { uid: 999 }, { link_id: 11 }, { link_id: '011' }, { link_id: '2147483648' },
          { type: 'line\n' }, { pm: -1 }, { amount: 1 }, { balance: '-0.01' }, { extra: 1 }])
          expect(await validEvidence(peer, { ...value, settlement: { ...proof, [field]: [{ ...row, ...patch }] } }, 'written-off')).toBe(false);
        expect(await validEvidence(peer, { ...value, settlement: { ...proof, [field]: [{ ...row, link_id: '2147483647' }] } }, 'written-off')).toBe(true);
      }
      expect(await validEvidence(peer, { ...value, settlement: { ...proof, reward_rows: [{ ...proof.reward_rows[0], category: 'money' }] } }, 'written-off')).toBe(false);
      expect(await validEvidence(peer, { ...value, settlement: { ...proof, brokerage_rows: [{ ...proof.brokerage_rows[0], source_type: null }] } }, 'written-off')).toBe(false);
      expect(await validEvidence(peer, { ...value, settlement: { ...proof, account_deltas: [] } }, 'written-off')).toBe(false);
    }); });
  }, 60000);
  it('requires ordered unique account deltas with int4 integral and bounded canonical money', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const value = await evidence(intent(), true), proof = settlement(), row = proof.account_deltas[0];
      for (const patch of [{ uid: 0 }, { integral_before: -1 }, { integral_after: '12' }, { integral_after: 2147483648 },
        { exp_before: '00.00' }, { exp_after: '0.0' }, { brokerage_before: null }, { extra: 1 }])
        expect(await validEvidence(peer, { ...value, settlement: { ...proof, reward_rows: [], brokerage_rows: [], account_deltas: [{ ...row, ...patch }] } }, 'written-off')).toBe(false);
      for (const rows of [[row, row], [...proof.account_deltas].reverse()])
        expect(await validEvidence(peer, { ...value, settlement: { ...proof, account_deltas: rows } }, 'written-off')).toBe(false);
      const rows = Array.from({ length: 70 }, (_, i) => ({ ...row, uid: i + 1 }));
      expect(await validEvidence(peer, { ...value, settlement: { ...proof, reward_rows: [], brokerage_rows: [], account_deltas: rows } }, 'written-off')).toBe(true);
      expect(await validEvidence(peer, { ...value, settlement: { ...proof, reward_rows: [], brokerage_rows: [], account_deltas: [...rows, { ...row, uid: 71 }] } }, 'written-off')).toBe(false);
    }); });
  }, 60000);
  it('requires exact ordered immutable original paid events without invented event types or payload hashes', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const value = await evidence(intent(), true), proof = settlement(), row = proof.paid_outbox_rows[0];
      for (const patch of [{ row_id: 0 }, { event_key: '' }, { event_key: 'paid\n' }, { event_type: 'order.create' }, { payload_hash: hash('A') }, { extra: 1 }])
        expect(await validEvidence(peer, { ...value, settlement: { ...proof, paid_outbox_rows: [{ ...row, ...patch }] } }, 'written-off')).toBe(false);
      expect(await validEvidence(peer, { ...value, settlement: { ...proof, paid_outbox_rows: [row, row] } }, 'written-off')).toBe(false);
      expect(await validEvidence(peer, { ...value, settlement: { ...proof, paid_outbox_rows: [] } }, 'written-off')).toBe(true);
    }); });
  }, 60000);
  it('enforces the real 262144-byte receipt ceiling without shortening permitted fields', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const body = intent(Array.from({ length: 200 }, (_, i) => ({ cart_row_id: i + 1, writeoff_num: 1 }))), value = await evidence(body, true), proof = settlement();
      value.writeoff_rows = value.writeoff_rows.map(row => ({ ...row, opaque_cart_id: '😀'.repeat(128) }));
      const full = { ...proof,
        supplier_rows: Array.from({ length: 200 }, (_, i) => ({ ...proof.supplier_rows[0], row_id: i + 1 })),
        reward_rows: Array.from({ length: 200 }, (_, i) => ({ ...proof.reward_rows[0], row_id: i + 1, event_key: 'r'.repeat(64), type: 'r'.repeat(64) })),
        brokerage_rows: Array.from({ length: 200 }, (_, i) => ({ ...proof.brokerage_rows[0], row_id: i + 1, type: 'b'.repeat(64), source_type: 'b'.repeat(64) })),
        paid_outbox_rows: Array.from({ length: 200 }, (_, i) => ({ ...proof.paid_outbox_rows[0], row_id: i + 1, event_key: 'e'.repeat(128) })),
      };
      const large = { ...value, settlement: full };
      const [size] = await peer.exec(`SELECT octet_length(${json(large)}::text) AS bytes`);
      expect(Number(size.bytes)).toBeGreaterThan(CUSTOMER_WRITEOFF_MAX_JSON_BYTES);
      expect(await validEvidence(peer, large, 'written-off', body)).toBe(false);
      await rejectsCode(peer.exec(await receiptSql({ intent: body, evidence: large, outcome: 'written-off' })), '23514');
      expect(await count(peer)).toBe(0);
    }); });
  }, 60000);
  it('binds both revisions positive actor service terminal service zero and strong UUID v4', async () => {
    await withFixture(async f => { await f.app(async peer => {
      await peer.exec(await receiptSql());
      await peer.exec(await receiptSql({ outcome: 'written-off', evidence: await evidence(intent(), true) }));
      await peer.exec(await receiptSql({ service_id: 0, outcome: 'abandoned', evidence: {} }));
      await peer.exec(await receiptSql({ service_id: 0, outcome: 'rollback-rejected', evidence: { code: 'revoked' } }));
      for (const patch of [{ actor_uid: 0 }, { order_id: 5 }, { scope_key: hash('e') }, { expected_revision: hash('e') }, { expected_writeoff_revision: hash('e') },
        { request_hash: hash('A') }, { service_id: 0 }, { service_id: 1, outcome: 'abandoned', evidence: {} },
        { request_key: '00000000-0000-1000-8000-000000000000' }, { kind: 'refund_execute' }])
        await rejectsCode(peer.exec(await receiptSql(patch)), '23514');
      expect(await count(peer)).toBe(4);
      expect((await peer.exec('SELECT bool_and(created_at IS NOT NULL) AS timestamps FROM public.customer_writeoff_operation_request'))[0].timestamps).toBe(true);
    }); });
  }, 60000);
  it('rejects malformed abandonment and rollback reasons instead of fabricating successful effects', async () => {
    await withFixture(async f => { await f.app(async peer => {
      for (const value of [{ verified: true }, { code: 'revoked' }, [], null]) expect(await validEvidence(peer, value, 'abandoned')).toBe(false);
      for (const value of [{}, { code: '' }, { code: ' revocation' }, { code: 'bad\nreason' }, { code: 403 }, { code: 'x'.repeat(129) }, { code: 'revoked', verified: true }])
        expect(await validEvidence(peer, value, 'rollback-rejected')).toBe(false);
      expect(await validEvidence(peer, {}, 'abandoned', { ...intent(), order_id: '11' })).toBe(false);
    }); });
  }, 60000);
  it('permits actual append and read while denying update delete truncate alter and runtime installation', async () => {
    await withFixture(async f => { await f.app(async peer => {
      await peer.exec(await receiptSql()); expect(await count(peer)).toBe(1);
      for (const statement of ["UPDATE public.customer_writeoff_operation_request SET evidence='{}'::jsonb", 'DELETE FROM public.customer_writeoff_operation_request',
        'TRUNCATE public.customer_writeoff_operation_request', 'ALTER TABLE public.customer_writeoff_operation_request ADD COLUMN forged integer'])
        await rejectsCode(peer.exec(statement), '42501');
      await expect(runCustomerWriteoffOperation(peer.db)).rejects.toThrow(); expect(await count(peer)).toBe(1);
    }); });
  }, 60000);
  it('detects column PUBLIC table and validator grant-option escapes without repairing grants', async () => {
    await withFixture(async f => { await f.app(async peer => {
      await f.exec(`GRANT UPDATE(evidence) ON public.customer_writeoff_operation_request TO ${ident(peer.role)}`);
      expect(await customerWriteoffOperationReadiness(peer.db)).toMatchObject({ ready: false, privileges: { mutable: true, append_only_acl: false } });
      await f.exec(`REVOKE UPDATE(evidence) ON public.customer_writeoff_operation_request FROM ${ident(peer.role)}`);
      await f.exec('GRANT SELECT ON public.customer_writeoff_operation_request TO PUBLIC');
      expect(await customerWriteoffOperationReadiness(peer.db)).toMatchObject({ ready: false, privileges: { append_only_acl: false } });
      await f.exec('REVOKE SELECT ON public.customer_writeoff_operation_request FROM PUBLIC');
      await f.exec(`GRANT SELECT ON public.customer_writeoff_operation_request TO ${ident(peer.role)} WITH GRANT OPTION`);
      expect(await customerWriteoffOperationReadiness(peer.db)).toMatchObject({ ready: false, privileges: { append_only_acl: false } });
      await f.exec(`REVOKE GRANT OPTION FOR SELECT ON public.customer_writeoff_operation_request FROM ${ident(peer.role)}`);
      await f.exec(`GRANT EXECUTE ON FUNCTION public.customer_writeoff_intent_valid_v1(text,jsonb) TO ${ident(peer.role)} WITH GRANT OPTION`);
      expect(await customerWriteoffOperationReadiness(peer.db)).toMatchObject({ ready: false, privileges: { validator_safe: false } });
      await f.exec(`REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION public.customer_writeoff_intent_valid_v1(text,jsonb) FROM ${ident(peer.role)}`);
      await f.exec('GRANT EXECUTE ON FUNCTION public.customer_writeoff_evidence_valid_v1(text,text,jsonb,jsonb) TO PUBLIC');
      expect(await customerWriteoffOperationReadiness(peer.db)).toMatchObject({ ready: false, privileges: { validator_safe: false } });
      expect((await peer.exec("SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='public.customer_writeoff_evidence_valid_v1(text,text,jsonb,jsonb)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS retained"))[0].retained).toBe(true);
    }); });
  }, 60000);
  it('rejects latent SET ROLE ownership even when the ordinary LOGIN does not inherit it', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const [maintenance] = await f.exec('SELECT current_user AS role'); const ownerRole = String(maintenance.role);
      await f.exec(`GRANT ${ident(ownerRole)} TO ${ident(peer.role)}`);
      try {
        expect((await peer.exec('SELECT current_user AS role,session_user AS session'))[0]).toEqual({ role: peer.role, session: peer.role });
        expect((await customerWriteoffOperationReadiness(peer.db)).ready).toBe(false);
      } finally { await f.exec(`REVOKE ${ident(ownerRole)} FROM ${ident(peer.role)}`); }
      expect((await customerWriteoffOperationReadiness(peer.db)).ready).toBe(true);
    }); });
  }, 60000);
  it('detects column index constraint RLS policy trigger rule and inbound foreign-key drift', async () => {
    await withFixture(async f => {
      const probes = [
        'ALTER TABLE public.customer_writeoff_operation_request ADD COLUMN unsupported integer',
        'ALTER TABLE public.customer_writeoff_operation_request ALTER COLUMN created_at DROP DEFAULT',
        'ALTER TABLE public.customer_writeoff_operation_request DROP CONSTRAINT cwo_outcome_ck',
        'ALTER INDEX public.cwo_actor_history SET(fillfactor=80)',
        'ALTER TABLE public.customer_writeoff_operation_request ENABLE ROW LEVEL SECURITY',
        'CREATE POLICY forged ON public.customer_writeoff_operation_request USING(true)',
        "CREATE FUNCTION public.cwo_mutation_probe() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'; CREATE TRIGGER forged BEFORE INSERT ON public.customer_writeoff_operation_request FOR EACH ROW EXECUTE FUNCTION public.cwo_mutation_probe()",
        'CREATE RULE forged AS ON INSERT TO public.customer_writeoff_operation_request DO INSTEAD NOTHING',
        'CREATE TABLE public.foreign_probe(actor_uid integer,request_key uuid,FOREIGN KEY(actor_uid,request_key) REFERENCES public.customer_writeoff_operation_request(actor_uid,request_key))',
      ];
      for (const probe of probes) {
        const rollback = Error('Owned writeoff catalog mutation rollback');
        try { await f.db.transaction(async tx => { await tx.execute(sql.raw(probe));
          expect(await inspectCustomerWriteoffOperation(tx as unknown as DbClient)).toMatchObject({ present: true, complete: false }); throw rollback;
        }); } catch (error) { if (error !== rollback) throw error; }
        expect((await inspectCustomerWriteoffOperation(f.db)).complete).toBe(true);
      }
    });
  }, 60000);
  it('detects validator volatility definer search path source overload and parallel-safety drift', async () => {
    await withFixture(async f => {
      const probes = [
        'ALTER FUNCTION public.customer_writeoff_intent_valid_v1(text,jsonb) STABLE',
        'ALTER FUNCTION public.customer_writeoff_evidence_valid_v1(text,text,jsonb,jsonb) SECURITY DEFINER',
        'ALTER FUNCTION public.customer_writeoff_intent_valid_v1(text,jsonb) PARALLEL UNSAFE',
        'ALTER FUNCTION public.customer_writeoff_intent_valid_v1(text,jsonb) SET search_path=public,pg_temp',
        "CREATE OR REPLACE FUNCTION public.customer_writeoff_intent_valid_v1(text,jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS 'SELECT true'",
        "CREATE FUNCTION public.customer_writeoff_intent_valid_v1(text) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'",
        "CREATE FUNCTION public.customer_writeoff_evidence_valid_v1(varchar,text,jsonb,jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'",
      ];
      for (const probe of probes) {
        const rollback = Error('Owned writeoff validator mutation rollback');
        try { await f.db.transaction(async tx => { await tx.execute(sql.raw(probe));
          expect((await inspectCustomerWriteoffOperation(tx as unknown as DbClient)).complete).toBe(false); throw rollback;
        }); } catch (error) { if (error !== rollback) throw error; }
        expect((await inspectCustomerWriteoffOperation(f.db)).complete).toBe(true);
      }
    });
  }, 60000);
  it('rechecks catalog drift within the caller transaction before any immutable append', async () => {
    await withFixture(async f => {
      const rollback = Error('Owned transaction catalog drift rollback');
      try { await f.db.transaction(async tx => {
        await tx.execute(sql.raw('ALTER TABLE public.customer_writeoff_operation_request DROP CONSTRAINT cwo_intent_ck'));
        await expect(assertCustomerWriteoffOperationCatalog(tx as unknown as DbClient)).rejects.toThrow();
        const [remaining] = await tx.execute<{ n: number }>(sql`SELECT count(*)::integer AS n FROM public.customer_writeoff_operation_request`);
        expect(remaining.n).toBe(0); throw rollback;
      }); } catch (error) { if (error !== rollback) throw error; }
      expect((await inspectCustomerWriteoffOperation(f.db)).complete).toBe(true); expect(await count(f)).toBe(0);
    });
  }, 60000);
  it('serializes installation under its independent maintenance key and rejects transaction facades', async () => {
    await withFixture(async f => {
      await f.app(async peer => { await peer.db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${CUSTOMER_WRITEOFF_MAINTENANCE_LOCK_KEY},0)`);
        await expect(runCustomerWriteoffOperation(f.db)).rejects.toThrow('already running');
      }); });
      await f.db.transaction(async tx => { await expect(runCustomerWriteoffOperation(tx as unknown as DbClient)).rejects.toThrow('root maintenance client'); });
      expect((await f.exec("SELECT to_regclass('public.customer_writeoff_operation_request') AS ledger"))[0].ledger).toBeNull();
    }, false);
  }, 60000);
  it('refuses installation from a repeatable-read owner transaction without creating partial objects', async () => {
    await withFixture(async f => {
      await expect(f.db.transaction(async tx => { await tx.execute(sql.raw(CUSTOMER_WRITEOFF_OPERATION_INSTALLATION_SQL)); },
        { isolationLevel: 'repeatable read', accessMode: 'read write' })).rejects.toThrow('reviewed PG16 owner transaction');
      expect((await f.exec("SELECT to_regclass('public.customer_writeoff_operation_request') AS ledger,to_regprocedure('public.customer_writeoff_intent_valid_v1(text,jsonb)') AS validator"))[0]).toEqual({ ledger: null, validator: null });
    }, false);
  }, 60000);
  it('keeps one actor UUID key across two ordinary LOGIN connections and immutable outcome histories', async () => {
    await withFixture(async f => { await f.app(async first => { await f.app(async second => {
      expect(first.pid).not.toBe(second.pid); expect(first.role).not.toBe(second.role);
      const key = randomUUID(); await first.exec(await receiptSql({ request_key: key }));
      await rejectsCode(second.exec(await receiptSql({ request_key: key, service_id: 0, outcome: 'abandoned', evidence: {} })), '23505');
      await second.exec(await receiptSql({ request_key: key, actor_uid: 102 }));
      const rows = await first.exec('SELECT actor_uid,request_key,outcome,intent,evidence FROM public.customer_writeoff_operation_request ORDER BY actor_uid');
      expect(rows).toHaveLength(2); expect(rows[0].outcome).toBe('partial-writtenoff'); expect(rows[0].intent).toEqual(intent());
      expect(rows[0].evidence).toEqual(await evidence());
      const finalBody = intent(), final = await evidence(finalBody, true);
      await second.exec(await receiptSql({ intent: finalBody, evidence: final, outcome: 'written-off' }));
      expect((await first.exec(`SELECT evidence FROM public.customer_writeoff_operation_request WHERE actor_uid=101 AND request_key=${literal(key)}::uuid`))[0].evidence).toEqual(await evidence());
      expect(await count(second)).toBe(3);
    }); }); });
  }, 60000);
});
