import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../src/lib/di';
import { outRequestHash } from '../src/services/out/OutIdempotency';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { installCustomerWorkScopeLock } from '../src/migrations/runCustomerWorkScopeLock';
import { CUSTOMER_WORK_LOCK_FUNCTIONS } from '../src/migrations/customerWorkRuntimePrivilegePlan';
import { CASHIER_SECOND_CARD_FUNCTIONS, CASHIER_SECOND_CARD_TABLES, CASHIER_SECOND_CARD_PURCHASE_APPEND_TABLES,
  cashierSecondCardRuntimePrivilegePlan, cashierSecondCardRuntimeGrantSql } from '../src/migrations/cashierSecondCardRuntimePlan';
import { customerWriteoffRuntimePrivilegePlan } from '../src/migrations/customerWriteoffRuntimePlan';
import { CASHIER_SECOND_CARD_PROMOTION_LOCK_FUNCTION, CASHIER_SECOND_CARD_PROMOTION_LOCK_TRIGGER,
  inspectCashierSecondCardPromotionLock, installCashierSecondCardPromotionLock,
  cashierSecondCardPromotionLockGrantSql } from '../src/migrations/cashierSecondCardPromotionLock';
import { CASHIER_SECOND_CARD_MAINTENANCE_LOCK_KEY, CASHIER_SECOND_CARD_ORIGIN_INSTALLATION_SQL } from '../src/migrations/cashierSecondCardOrigin';
import { CASHIER_SECOND_CARD_ORIGIN_CATALOG_SHA256, CASHIER_SECOND_CARD_ORIGIN_CATALOG_SQL,
  inspectCashierSecondCardOrigin, assertCashierSecondCardOriginCatalog, cashierSecondCardOriginReadiness,
  runCashierSecondCardOrigin } from '../src/migrations/runCashierSecondCardOrigin';

type Native = Extract<Awaited<ReturnType<typeof sequenceRunnerDatabase>>, { format: 'pg16' }>;
type Peer = SequenceRunnerPeer & { role: string; connectionString: string };
const ident = (value: string) => { if (!/^[a-z_][a-z_0-9]{0,62}$/.test(value)) throw Error('Unsafe owned cashier catalog identifier'); return `"${value}"`; };
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const json = (value: unknown) => `${literal(JSON.stringify(value))}::jsonb`;
const hash = (value: string) => value.repeat(64);
function postgresCode(error: unknown): string | undefined {
  let next = error;
  for (let i = 0; i < 8 && next && typeof next === 'object'; i++) {
    const row = next as { code?: unknown; cause?: unknown }; if (typeof row.code === 'string') return row.code; next = row.cause;
  }
  return undefined;
}
async function rejectsCode(pending: Promise<unknown>, code: string) {
  let error: unknown; try { await pending; } catch (failure) { error = failure; }
  expect(error).toBeDefined(); expect(postgresCode(error)).toBe(code);
}
async function rejectsPostgresMessage(pending: Promise<unknown>, message: string) {
  let error: unknown; try { await pending; } catch (failure) { error = failure; }
  expect(error).toBeDefined();
  let next = error; let actual: { code: string; message: string } | undefined;
  for (let i = 0; i < 8 && next && typeof next === 'object'; i++) {
    const row = next as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof row.code === 'string' && typeof row.message === 'string') { actual = { code: row.code, message: row.message }; break; }
    next = row.cause;
  }
  // A Drizzle wrapper contains the submitted SQL. Only the real PostgreSQL
  // exception, never that query text, may prove which guard rejected it.
  expect(actual).toEqual({ code: 'P0001', message });
}
async function fixture(installed = true) {
  const candidate = await sequenceRunnerDatabase();
  if (candidate.format !== 'pg16' || !candidate.withRuntimeRole) { await candidate.close(); throw Error('Cashier catalog requires native PG16 independent LOGIN'); }
  const f = candidate as Native, owner = `csc_scope_${randomUUID().replaceAll('-', '')}`; let ownerCreated = false;
  const close = async () => { try { if (ownerCreated) await f.exec(`DROP OWNED BY ${ident(owner)}; DROP ROLE ${ident(owner)}`); } finally { await f.close(); } };
  try {
    await f.exec(`CREATE TABLE public."user"(uid integer PRIMARY KEY,status integer NOT NULL DEFAULT 1);
 CREATE TABLE public.store_service(id integer PRIMARY KEY,uid integer NOT NULL,online integer NOT NULL DEFAULT 0,customer integer NOT NULL DEFAULT 1);
 CREATE TABLE public.express_company(id integer PRIMARY KEY); CREATE TABLE public.delivery_service(id integer PRIMARY KEY,uid integer NOT NULL);
 CREATE TABLE public.store_order_promotions(id serial PRIMARY KEY,oid integer NOT NULL DEFAULT 0,uid integer NOT NULL DEFAULT 0,
 promotions_id integer NOT NULL DEFAULT 0,product_id integer NOT NULL DEFAULT 0,promotions_price numeric(12,2) NOT NULL DEFAULT 0.00,add_time integer NOT NULL DEFAULT 0);
 CREATE INDEX sop_order_promotion ON public.store_order_promotions(oid,promotions_id);
 CREATE INDEX sop_order_product ON public.store_order_promotions(oid,product_id);
 CREATE INDEX sop_uid_time ON public.store_order_promotions(uid,add_time);
 INSERT INTO public."user"(uid) VALUES(101); INSERT INTO public.store_service(id,uid) VALUES(1,101);
 INSERT INTO public.express_company(id) VALUES(1); INSERT INTO public.delivery_service(id,uid) VALUES(1,102);`);
    await f.exec(`CREATE ROLE ${ident(owner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`); ownerCreated = true;
    await installCustomerWorkScopeLock(f.db, owner); if (installed) await runCashierSecondCardOrigin(f.db);
    const app = <T>(callback: (peer: Peer) => Promise<T>) => f.withRuntimeRole(async peer => {
      const plan = cashierSecondCardRuntimePrivilegePlan();
      expect((await installCashierSecondCardPromotionLock(f.db, peer.role)).ready).toBe(true);
      expect((await inspectCashierSecondCardPromotionLock(f.db, peer.role)).ready).toBe(true);
      for (const table of ['user', 'store_service', 'express_company', 'delivery_service', ...CASHIER_SECOND_CARD_PURCHASE_APPEND_TABLES, ...(installed ? CASHIER_SECOND_CARD_TABLES : [])]) {
        const privileges = plan.tables[table]; if (!privileges) throw Error('Cashier table absent from fixed runtime profile');
        if (privileges.length) await f.exec(`GRANT ${privileges.join(',')} ON public.${ident(table)} TO ${ident(peer.role)}`);
        const columns = plan.updateColumns[table]; if (columns?.length && table !== 'store_order_promotions') await f.exec(`GRANT UPDATE(${columns.map(ident).join(',')}) ON public.${ident(table)} TO ${ident(peer.role)}`);
      }
      await f.exec(cashierSecondCardPromotionLockGrantSql(peer.role));
      const [sequence] = await f.exec("SELECT s.relname AS name FROM pg_class s WHERE s.oid=pg_get_serial_sequence('public.store_order_promotions','id')::regclass AND s.relkind='S'");
      if (!sequence || typeof sequence.name !== 'string') throw Error('Actual promotions owned id sequence absent');
      for (const _statement of cashierSecondCardRuntimeGrantSql(peer.role, [{ name: sequence.name, table: 'store_order_promotions' }])
        .filter(statement => statement.startsWith('GRANT USAGE ON SEQUENCE ') && statement.includes(`public.${ident(sequence.name)}`)))
        await f.exec(`GRANT USAGE ON SEQUENCE public.${ident(sequence.name)} TO ${ident(peer.role)}`);
      for (const signature of [...CUSTOMER_WORK_LOCK_FUNCTIONS, ...(installed ? CASHIER_SECOND_CARD_FUNCTIONS : [])]) {
        expect(plan.functions).toContain(signature); await f.exec(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${ident(peer.role)}`);
      }
      const [identity] = await peer.exec(`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,
 current_setting('server_version_num')::integer AS version,
 (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated`);
      expect(identity).toMatchObject({ role: peer.role, session: peer.role, pid: peer.pid, elevated: false }); expect(Math.floor(Number(identity.version) / 10000)).toBe(16);
      return callback(peer);
    });
    return { ...f, owner, app, close };
  } catch (error) { await close(); throw error; }
}
async function withFixture(callback: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, installed = true) {
  const f = await fixture(installed); try { await callback(f); } finally { await f.close(); }
}
function origin() {
  return { version: 'cashier-second-card-origin-v1', creator_kind: 'customer', creator_uid: 101, service_id: 1, buyer_uid: 201,
    scope_key: hash('a'), root_order_id: 11, root_order_no: 'CASHIER_SN', creation_key: '00112233-4455-4677-8899-aabbccddeeff',
    creation_hash: hash('b'), quote_fingerprint: hash('c'), creation_status_id: 71,
    cart_facts: [{ cart_row_id: 7, opaque_cart_id: '901', product_id: 301, product_type: 4, owner_type: 0, owner_id: 0,
      sku_unique: 'SKU001', purchase_quantity: 2, write_times: 6, snapshot_hash: hash('d') }] };
}
function payment(amount = '14.00') {
  return { version: 'cashier-second-card-payment-v1', order_id: 11, order_no: 'CASHIER_SN', buyer_uid: 201, creator_uid: 101,
    paid: 1, pay_type: 'cash', pay_time: 1791196800, amount, trade_no: '', status_id: 81, outbox_id: 91,
    event_key: 'order.paid:11', payload_hash: hash('e'), origin_hash: hash('f') };
}
async function validOrigin(db: Pick<SequenceRunnerPeer, 'exec'>, value: unknown, fingerprint?: string) {
  const digest = fingerprint ?? await outRequestHash(value);
  return (await db.exec(`SELECT public.cashier_second_card_origin_valid_v1(${literal(digest)},${json(value)}) AS valid`))[0].valid;
}
async function validPayment(db: Pick<SequenceRunnerPeer, 'exec'>, value: unknown, kind = 'cash') {
  return (await db.exec(`SELECT public.cashier_second_card_payment_valid_v1(${literal(kind)},${json(value)}) AS valid`))[0].valid;
}
const insert = (table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row); return `INSERT INTO public.${ident(table)}(${columns.map(ident).join(',')}) VALUES(${columns.map(name => ['origin', 'evidence'].includes(name)
    ? json(row[name]) : typeof row[name] === 'number' ? String(row[name]) : literal(String(row[name]))).join(',')})`;
};
async function draftSql(patch: Record<string, unknown> = {}) {
  return insert('cashier_second_card_cart_v1', { actor_uid: 101, buyer_uid: 201, cart_id: 901, request_key: origin().creation_key,
    request_hash: hash('b'), tourist_hash: await outRequestHash(''), ...patch });
}
async function originSql(patch: Record<string, unknown> = {}, body = origin()) {
  return insert('cashier_second_card_origin_v1', { order_id: body.root_order_id, actor_uid: body.creator_uid, service_id: body.service_id, buyer_uid: body.buyer_uid,
    request_key: body.creation_key, request_hash: body.creation_hash, scope_key: body.scope_key, origin_hash: await outRequestHash(body), origin: body, ...patch });
}
const paymentSql = (patch: Record<string, unknown> = {}, body = payment()) => insert('cashier_second_card_payment_v1', {
  order_id: body.order_id, actor_uid: body.creator_uid, service_id: 1, request_key: '11223344-5566-4788-99aa-bbccddeeff00', request_hash: hash('c'), scope_key: hash('a'),
  amount: body.amount, payment_kind: body.amount === '0.00' ? 'zero' : 'cash', order_paid_status_id: body.status_id, outbox_id: body.outbox_id, evidence: body, ...patch });
const count = async (db: Pick<SequenceRunnerPeer, 'exec'>, table: string) => Number((await db.exec(`SELECT count(*) AS n FROM public.${ident(table)}`))[0].n);

describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('cashier second card origin PG16 independent LOGIN contract', () => {
  it('measures exact three-table seven-ten-twelve columns and two immutable validator catalog on PG16', async () => {
    await withFixture(async f => {
      const state = await inspectCashierSecondCardOrigin(f.db), [shape] = await f.db.execute<{ shape: unknown }>(sql.raw(CASHIER_SECOND_CARD_ORIGIN_CATALOG_SQL));
      const [server] = await f.exec("SELECT current_database() AS database,current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version");
      const columns = await f.exec("SELECT c.relname AS name,count(*)::integer AS n FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN('cashier_second_card_cart_v1','cashier_second_card_origin_v1','cashier_second_card_payment_v1') AND a.attnum>0 AND NOT a.attisdropped GROUP BY c.relname ORDER BY c.relname");
      expect(columns).toEqual([{ name: 'cashier_second_card_cart_v1', n: 7 }, { name: 'cashier_second_card_origin_v1', n: 10 }, { name: 'cashier_second_card_payment_v1', n: 12 }]);
      expect(state.present).toBe(true); expect(state.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      console.info('CASHIER_SECOND_CARD_CANONICAL_PG16 ' + JSON.stringify({ server, fingerprint: state.fingerprint, expected: CASHIER_SECOND_CARD_ORIGIN_CATALOG_SHA256, shape: shape.shape }));
      if (CASHIER_SECOND_CARD_ORIGIN_CATALOG_SHA256.startsWith('NOT_MEASURED')) { expect(state.complete).toBe(false); await expect(assertCashierSecondCardOriginCatalog(f.db)).rejects.toThrow(); }
      else { expect(state.complete).toBe(true); expect(state.fingerprint).toBe(CASHIER_SECOND_CARD_ORIGIN_CATALOG_SHA256); }
    });
  }, 60000);
  it('rejects absent and partial protocols without installing or repairing any object', async () => {
    await withFixture(async f => {
      await f.app(async peer => { expect(await cashierSecondCardOriginReadiness(peer.db)).toMatchObject({ ready: false, reason: 'cashier_second_card_origin_not_installed' }); });
      await f.exec('CREATE TABLE public.cashier_second_card_cart_v1(actor_uid integer)');
      expect(await inspectCashierSecondCardOrigin(f.db)).toMatchObject({ present: true, complete: false });
      await expect(runCashierSecondCardOrigin(f.db)).rejects.toThrow('Existing');
      expect((await f.exec("SELECT to_regclass('public.cashier_second_card_origin_v1') AS origin,to_regclass('public.cashier_second_card_payment_v1') AS payment"))[0]).toEqual({ origin: null, payment: null });
    }, false);
  }, 60000);
  it('accepts exact commissioned append-only LOGIN privileges and rejects owner reinstall', async () => {
    await withFixture(async f => {
      const before = await inspectCashierSecondCardOrigin(f.db); expect(before.complete).toBe(true);
      await expect(runCashierSecondCardOrigin(f.db)).rejects.toThrow('Existing'); expect(await inspectCashierSecondCardOrigin(f.db)).toEqual(before);
      await f.app(async peer => { expect(await cashierSecondCardOriginReadiness(peer.db)).toMatchObject({ ready: true,
        privileges: { read: true, append: true, mutable: false, append_only_acl: true, validator_safe: true, authority_safe: true } }); });
    });
  }, 60000);
  it('hashes recursive sorted compact JSON exactly including nested quotes backslashes and Unicode', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const value = origin(); expect(await validOrigin(peer, value)).toBe(true);
      const reordered = Object.fromEntries(Object.entries(value).reverse()); expect(await validOrigin(peer, reordered)).toBe(true);
      const unicode = { ...value, cart_facts: [{ ...value.cart_facts[0], opaque_cart_id: '非数字"标识\\', sku_unique: '规格😀' }] };
      expect(await validOrigin(peer, unicode)).toBe(true);
      const ordinaryJsonHash = createHash('sha256').update(JSON.stringify(value)).digest('hex'); expect(ordinaryJsonHash).not.toBe(await outRequestHash(value));
      expect(await validOrigin(peer, value, ordinaryJsonHash)).toBe(false); expect(await validOrigin(peer, value, hash('a'))).toBe(false);
    }); });
  }, 60000);
  it('adds only cashier promotion SELECT INSERT and actual owned sequence USAGE without mutating the inherited profile', async () => {
    const inherited = customerWriteoffRuntimePrivilegePlan();
    const snapshot = JSON.stringify(inherited);
    const plan = cashierSecondCardRuntimePrivilegePlan();
    expect(CASHIER_SECOND_CARD_PURCHASE_APPEND_TABLES).toEqual(['store_order_promotions']);
    expect(inherited.tables.store_order_promotions).toEqual(['SELECT']);
    expect(plan.tables.store_order_promotions).toEqual(['SELECT', 'INSERT']);
    expect(plan.updateColumns.store_order_promotions).toEqual(['id']);
    expect(JSON.stringify(inherited)).toBe(snapshot);
    await withFixture(async f => { await f.app(async peer => {
      const [sequence] = await f.exec("SELECT s.relname AS name FROM pg_class s WHERE s.oid=pg_get_serial_sequence('public.store_order_promotions','id')::regclass AND s.relkind='S'");
      expect(typeof sequence.name).toBe('string');
      const grants = cashierSecondCardRuntimeGrantSql(peer.role, [{ name: String(sequence.name), table: 'store_order_promotions' }]);
      expect(grants.some(statement => statement.startsWith('GRANT INSERT ON ') && statement.includes('public."store_order_promotions"'))).toBe(true);
      expect(grants.some(statement => statement.startsWith('GRANT USAGE ON SEQUENCE ') && statement.includes(`public.${ident(String(sequence.name))}`))).toBe(true);
      expect(grants.some(statement => /^GRANT (?:UPDATE|DELETE) ON .*public\."store_order_promotions"(?:,| TO)/.test(statement))).toBe(false);
      const [row] = await peer.exec('INSERT INTO public.store_order_promotions(oid,uid,promotions_id,product_id,promotions_price,add_time) VALUES(11,201,4,301,1.40,1791196800) RETURNING *');
      expect(row).toMatchObject({ oid: 11, uid: 201, promotions_id: 4, product_id: 301, promotions_price: '1.40', add_time: 1791196800 });
      expect(Number(row.id)).toBeGreaterThan(0);
      expect(await cashierSecondCardOriginReadiness(peer.db)).toMatchObject({ ready: true,
        privileges: { promotion_read: true, promotion_append: true, promotion_sequence_usage: true, promotion_safe: true } });
      await rejectsCode(peer.exec('UPDATE public.store_order_promotions SET uid=202'), '42501');
      await rejectsCode(peer.exec('DELETE FROM public.store_order_promotions'), '42501');
      await rejectsCode(peer.exec('TRUNCATE public.store_order_promotions'), '42501');
      await rejectsCode(peer.exec(`SELECT setval('public.${String(sequence.name)}'::regclass,9000)`), '42501');
      expect((await peer.exec('SELECT uid FROM public.store_order_promotions'))).toEqual([{ uid: 201 }]);
    }); });
  }, 60000);
  it('closes readiness and rejects actual promotion append when the fixed cashier INSERT grant is absent', async () => {
    await withFixture(async f => { await f.app(async peer => {
      expect(await cashierSecondCardOriginReadiness(peer.db)).toMatchObject({ ready: true });
      await f.exec(`REVOKE INSERT ON public.store_order_promotions FROM ${ident(peer.role)}`);
      expect(await cashierSecondCardOriginReadiness(peer.db)).toMatchObject({ ready: false, reason: 'cashier_second_card_runtime_privileges_unreviewed',
        privileges: { promotion_read: true, promotion_append: false, promotion_sequence_usage: true } });
      await rejectsCode(peer.exec('INSERT INTO public.store_order_promotions DEFAULT VALUES'), '42501');
      expect(await count(f, 'store_order_promotions')).toBe(0);
      await f.exec(`GRANT INSERT ON public.store_order_promotions TO ${ident(peer.role)}`);
      expect(await cashierSecondCardOriginReadiness(peer.db)).toMatchObject({ ready: true });
    }); });
  }, 60000);
  it('closes readiness and rejects serial allocation when actual owned promotion sequence USAGE is absent', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const [sequence] = await f.exec("SELECT s.relname AS name FROM pg_class s WHERE s.oid=pg_get_serial_sequence('public.store_order_promotions','id')::regclass AND s.relkind='S'");
      await f.exec(`REVOKE USAGE ON SEQUENCE public.${ident(String(sequence.name))} FROM ${ident(peer.role)}`);
      expect(await cashierSecondCardOriginReadiness(peer.db)).toMatchObject({ ready: false, reason: 'cashier_second_card_runtime_privileges_unreviewed',
        privileges: { promotion_read: true, promotion_append: true, promotion_sequence_usage: false } });
      await rejectsCode(peer.exec('INSERT INTO public.store_order_promotions DEFAULT VALUES'), '42501');
      expect(await count(f, 'store_order_promotions')).toBe(0);
      await f.exec(`GRANT USAGE ON SEQUENCE public.${ident(String(sequence.name))} TO ${ident(peer.role)}`);
      expect(await cashierSecondCardOriginReadiness(peer.db)).toMatchObject({ ready: true });
    }); });
  }, 60000);
  it('requires all thirteen origin and ten cart keys and rejects Admin assisted or client capability flags', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const value = origin();
      for (const field of Object.keys(value)) { const missing: Record<string, unknown> = { ...value }; delete missing[field]; expect(await validOrigin(peer, missing)).toBe(false); }
      for (const field of Object.keys(value.cart_facts[0])) { const missing: Record<string, unknown> = { ...value.cart_facts[0] }; delete missing[field]; expect(await validOrigin(peer, { ...value, cart_facts: [missing] })).toBe(false); }
      for (const patch of [{ creator_kind: 'admin' }, { creator_kind: 'staff' }, { customer_cashier: true }, { version: 'purchase-origin-v1' }, { service_id: 0 }, { buyer_uid: '0' }, { creator_uid: 0 }, { buyer_uid: -1 }])
        expect(await validOrigin(peer, { ...value, ...patch })).toBe(false);
    }); });
  }, 60000);
  it('rejects malformed nested scalars null arrays and invalid integer casts without throwing', async () => {
    await withFixture(async f => { await f.app(async peer => {
      for (const malformed of [null, 7, true, 'bad', []]) {
        expect(await validOrigin(peer, malformed)).toBe(false); expect(await validOrigin(peer, { ...origin(), cart_facts: malformed })).toBe(false);
        expect(await validOrigin(peer, { ...origin(), cart_facts: [malformed] })).toBe(false); expect(await validPayment(peer, malformed)).toBe(false);
      }
      expect((await peer.exec('SELECT public.cashier_second_card_origin_valid_v1(NULL,NULL) AS origin,public.cashier_second_card_payment_valid_v1(NULL,NULL) AS payment'))[0]).toEqual({ origin: false, payment: false });
    }); });
  }, 60000);
  it('requires one true second-card line with whole purchase-to-entitlement multiples and valid ownership', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const value = origin(), cart = value.cart_facts[0];
      for (const cart_facts of [[], [cart, cart]]) expect(await validOrigin(peer, { ...value, cart_facts })).toBe(false);
      for (const patch of [{ product_type: 0 }, { cart_row_id: '7' }, { purchase_quantity: 0 }, { write_times: 5 }, { write_times: 2147483648 },
        { purchase_quantity: 1.5 }, { owner_type: 3 }, { owner_type: 0, owner_id: 1 }, { owner_type: 1, owner_id: 0 }, { snapshot_hash: hash('A') }, { sale_price: '7.00' }])
        expect(await validOrigin(peer, { ...value, cart_facts: [{ ...cart, ...patch }] })).toBe(false);
      expect(await validOrigin(peer, { ...value, cart_facts: [{ ...cart, owner_type: 2, owner_id: 22 }] })).toBe(true);
      expect(await validOrigin(peer, { ...value, buyer_uid: 0 })).toBe(true);
    }); });
  }, 60000);
  it('enforces canonical UUID ASCII SN SHA and text controls while preserving string JSON escaping', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const value = origin();
      for (const patch of [{ creation_key: '00112233-4455-1677-8899-aabbccddeeff' }, { creation_key: value.creation_key.toUpperCase() },
        { root_order_no: '订单' }, { root_order_no: 'SN\n' }, { root_order_no: 'x'.repeat(33) }, { scope_key: hash('A') }])
        expect(await validOrigin(peer, { ...value, ...patch })).toBe(false);
      for (const opaque_cart_id of ['', ' row', 'row\u00a0', 'row\nID', 'row\u007fID', 'x'.repeat(65)])
        expect(await validOrigin(peer, { ...value, cart_facts: [{ ...value.cart_facts[0], opaque_cart_id }] })).toBe(false);
      await expect(validOrigin(peer, { ...value, cart_facts: [{ ...value.cart_facts[0], opaque_cart_id: 'row\u0000ID' }] })).rejects.toThrow();
      await expect(validOrigin(peer, { ...value, cart_facts: [{ ...value.cart_facts[0], opaque_cart_id: 'row\ud800ID' }] })).rejects.toThrow();
    }); });
  }, 60000);
  it('binds real draft actor buyer cart key hash and guest namespace without an Admin fallback', async () => {
    await withFixture(async f => { await f.app(async peer => {
      await peer.exec(await draftSql());
      for (const patch of [{ actor_uid: 0 }, { buyer_uid: -1 }, { cart_id: 0 }, { request_hash: hash('A') }, { buyer_uid: 0 },
        { tourist_hash: hash('e') }, { request_key: '00000000-0000-1000-8000-000000000000' }])
        await rejectsCode(peer.exec(await draftSql({ request_key: randomUUID(), cart_id: 902, ...patch })), '23514');
      await peer.exec(await draftSql({ buyer_uid: 0, cart_id: 903, request_key: randomUUID(), tourist_hash: await outRequestHash('actual-tourist') }));
      await rejectsCode(peer.exec(await draftSql({ request_key: randomUUID() })), '23505');
      expect(await count(peer, 'cashier_second_card_cart_v1')).toBe(2);
    }); });
  }, 60000);
  it('binds origin typed columns to immutable actual creator root buyer scope request and canonical hash', async () => {
    await withFixture(async f => { await f.app(async peer => {
      for (const patch of [{ order_id: 12 }, { actor_uid: 102 }, { service_id: 2 }, { buyer_uid: 202 }, { request_key: randomUUID() },
        { request_hash: hash('e') }, { scope_key: hash('e') }, { origin_hash: hash('e') }]) await rejectsCode(peer.exec(await originSql(patch)), '23514');
      await peer.exec(await originSql()); expect(await count(peer, 'cashier_second_card_origin_v1')).toBe(1);
      await rejectsCode(peer.exec(await originSql()), '23505');
    }); });
  }, 60000);
  it('validates all fifteen cash-payment evidence keys and exact genuine zero-price semantics', async () => {
    await withFixture(async f => { await f.app(async peer => {
      expect(await validPayment(peer, payment())).toBe(true); expect(await validPayment(peer, payment('0.00'), 'zero')).toBe(true);
      expect(await validPayment(peer, { ...payment('0.00'), buyer_uid: 0 }, 'zero')).toBe(true);
      expect(await validPayment(peer, payment('0.00'))).toBe(false); expect(await validPayment(peer, payment(), 'zero')).toBe(false);
      for (const field of Object.keys(payment())) { const missing: Record<string, unknown> = { ...payment() }; delete missing[field]; expect(await validPayment(peer, missing)).toBe(false); }
      for (const patch of [{ paid: true }, { pay_type: 'weixin' }, { trade_no: 'fake' }, { pay_time: 0 }, { status_id: 0 }, { outbox_id: 0 },
        { amount: 14 }, { amount: '014.00' }, { amount: '14.0' }, { amount: '10000000000.00' }, { event_key: 'order.paid:12' }, { payload_hash: hash('A') }, { origin_hash: hash('A') }, { provider_claim: 'UNKNOWN' }])
        expect(await validPayment(peer, { ...payment(), ...patch })).toBe(false);
      expect(await validPayment(peer, payment(), 'provider')).toBe(false);
    }); });
  }, 60000);
  it('binds payment actor order amount paid audit and original outbox IDs without synthetic terminal receipts', async () => {
    await withFixture(async f => { await f.app(async peer => {
      for (const patch of [{ order_id: 12 }, { actor_uid: 102 }, { service_id: 0 }, { amount: '13.00' }, { order_paid_status_id: 82 },
        { outbox_id: 92 }, { request_hash: hash('A') }, { scope_key: hash('A') }, { payment_kind: 'zero' }, { request_key: '00000000-0000-1000-8000-000000000000' }])
        await rejectsCode(peer.exec(paymentSql(patch)), '23514');
      await peer.exec(paymentSql()); await rejectsCode(peer.exec(paymentSql({ request_key: randomUUID() })), '23505');
      const guest = { ...payment('0.00'), order_id: 12, order_no: 'GUEST_SN', buyer_uid: 0, event_key: 'order.paid:12' };
      await peer.exec(paymentSql({ request_key: randomUUID() }, guest)); expect(await count(peer, 'cashier_second_card_payment_v1')).toBe(2);
    }); });
  }, 60000);
  it('allows append read while denying update delete truncate alter and API installation across all three tables', async () => {
    await withFixture(async f => { await f.app(async peer => {
      await peer.exec(await draftSql()); await peer.exec(await originSql()); await peer.exec(paymentSql());
      for (const table of CASHIER_SECOND_CARD_TABLES) {
        expect(await count(peer, table)).toBe(1);
        for (const statement of [`UPDATE public.${ident(table)} SET actor_uid=102`, `DELETE FROM public.${ident(table)}`, `TRUNCATE public.${ident(table)}`,
          `ALTER TABLE public.${ident(table)} ADD COLUMN forged integer`]) await rejectsCode(peer.exec(statement), '42501');
      }
      await expect(runCashierSecondCardOrigin(peer.db)).rejects.toThrow();
    }); });
  }, 60000);
  it('detects each table column ACL PUBLIC access and grant option without automatic repairs', async () => {
    await withFixture(async f => { await f.app(async peer => {
      for (const table of CASHIER_SECOND_CARD_TABLES) {
        await f.exec(`GRANT UPDATE(actor_uid) ON public.${ident(table)} TO ${ident(peer.role)}`);
        expect(await cashierSecondCardOriginReadiness(peer.db)).toMatchObject({ ready: false, privileges: { mutable: true, append_only_acl: false } });
        await f.exec(`REVOKE UPDATE(actor_uid) ON public.${ident(table)} FROM ${ident(peer.role)}`);
        await f.exec(`GRANT SELECT ON public.${ident(table)} TO PUBLIC`); expect((await cashierSecondCardOriginReadiness(peer.db)).ready).toBe(false);
        await f.exec(`REVOKE SELECT ON public.${ident(table)} FROM PUBLIC`);
        await f.exec(`GRANT SELECT ON public.${ident(table)} TO ${ident(peer.role)} WITH GRANT OPTION`);
        expect((await cashierSecondCardOriginReadiness(peer.db)).ready).toBe(false);
        await f.exec(`REVOKE GRANT OPTION FOR SELECT ON public.${ident(table)} FROM ${ident(peer.role)}`);
      }
      expect((await cashierSecondCardOriginReadiness(peer.db)).ready).toBe(true);
      await f.exec('GRANT EXECUTE ON FUNCTION public.cashier_second_card_origin_valid_v1(text,jsonb) TO PUBLIC');
      expect(await cashierSecondCardOriginReadiness(peer.db)).toMatchObject({ ready: false, privileges: { validator_safe: false } });
      expect((await peer.exec("SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='public.cashier_second_card_origin_valid_v1(text,jsonb)'::regprocedure AND a.grantee=0) AS retained"))[0].retained).toBe(true);
    }); });
  }, 60000);
  it('rejects latent SET ROLE authority and mismatched table/function owners', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const [maintenance] = await f.exec('SELECT current_user AS role'), ownerRole = String(maintenance.role);
      await f.exec(`GRANT ${ident(ownerRole)} TO ${ident(peer.role)}`);
      try { expect((await cashierSecondCardOriginReadiness(peer.db)).ready).toBe(false); }
      finally { await f.exec(`REVOKE ${ident(ownerRole)} FROM ${ident(peer.role)}`); }
      expect((await cashierSecondCardOriginReadiness(peer.db)).ready).toBe(true);
      const distinctOwner = `csc_probe_${randomUUID().replaceAll('-', '')}`;
      await f.exec(`CREATE ROLE ${ident(distinctOwner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      await f.exec(`ALTER TABLE public.cashier_second_card_payment_v1 OWNER TO ${ident(distinctOwner)}`);
      try { expect(await cashierSecondCardOriginReadiness(peer.db)).toMatchObject({ ready: false, privileges: { validator_safe: false } }); }
      finally { await f.exec(`ALTER TABLE public.cashier_second_card_payment_v1 OWNER TO ${ident(ownerRole)}; DROP OWNED BY ${ident(distinctOwner)}; DROP ROLE ${ident(distinctOwner)}`); }
    }); });
  }, 60000);
  it('detects full relation constraints index RLS trigger rule and foreign-key drift in every realm', async () => {
    await withFixture(async f => {
      const probes = [
        'ALTER TABLE public.cashier_second_card_cart_v1 ADD COLUMN unsupported integer',
        'ALTER TABLE public.cashier_second_card_origin_v1 DROP CONSTRAINT csco_origin_ck',
        'ALTER TABLE public.cashier_second_card_payment_v1 ALTER COLUMN created_at DROP DEFAULT',
        'ALTER INDEX public.cscc_actor_history SET(fillfactor=80)',
        'ALTER TABLE public.cashier_second_card_cart_v1 ENABLE ROW LEVEL SECURITY',
        'CREATE POLICY forged ON public.cashier_second_card_payment_v1 USING(true)',
        "CREATE FUNCTION public.csc_mutation_probe() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'; CREATE TRIGGER forged BEFORE INSERT ON public.cashier_second_card_origin_v1 FOR EACH ROW EXECUTE FUNCTION public.csc_mutation_probe()",
        'CREATE RULE forged AS ON INSERT TO public.cashier_second_card_payment_v1 DO INSTEAD NOTHING',
        'CREATE TABLE public.foreign_probe(order_id integer REFERENCES public.cashier_second_card_origin_v1(order_id))',
      ];
      for (const probe of probes) {
        const rollback = Error('Owned cashier relation drift rollback');
        try { await f.db.transaction(async tx => { await tx.execute(sql.raw(probe));
          expect((await inspectCashierSecondCardOrigin(tx as unknown as DbClient)).complete).toBe(false);
          await expect(assertCashierSecondCardOriginCatalog(tx as unknown as DbClient)).rejects.toThrow(); throw rollback;
        }); } catch (error) { if (error !== rollback) throw error; }
        expect((await inspectCashierSecondCardOrigin(f.db)).complete).toBe(true);
      }
    });
  }, 60000);
  it('detects validator definitions overloads volatility parallel status and unsafe search path', async () => {
    await withFixture(async f => {
      const probes = ['ALTER FUNCTION public.cashier_second_card_origin_valid_v1(text,jsonb) STABLE',
        'ALTER FUNCTION public.cashier_second_card_payment_valid_v1(text,jsonb) SECURITY DEFINER',
        'ALTER FUNCTION public.cashier_second_card_origin_valid_v1(text,jsonb) PARALLEL UNSAFE',
        'ALTER FUNCTION public.cashier_second_card_payment_valid_v1(text,jsonb) SET search_path=public,pg_temp',
        "CREATE OR REPLACE FUNCTION public.cashier_second_card_origin_valid_v1(text,jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS 'SELECT true'",
        "CREATE FUNCTION public.cashier_second_card_origin_valid_v1(text) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'",
        "CREATE FUNCTION public.cashier_second_card_payment_valid_v1(varchar,jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'",
      ];
      for (const probe of probes) {
        const rollback = Error('Owned cashier validator drift rollback');
        try { await f.db.transaction(async tx => { await tx.execute(sql.raw(probe)); expect((await inspectCashierSecondCardOrigin(tx as unknown as DbClient)).complete).toBe(false); throw rollback; }); }
        catch (error) { if (error !== rollback) throw error; }
        expect((await inspectCashierSecondCardOrigin(f.db)).complete).toBe(true);
      }
    });
  }, 60000);
  it('serializes exact maintenance installation and refuses transaction facades or unreviewed isolation', async () => {
    await withFixture(async f => {
      await f.app(async peer => { await peer.db.transaction(async tx => { await tx.execute(sql`SELECT pg_advisory_xact_lock(${CASHIER_SECOND_CARD_MAINTENANCE_LOCK_KEY},0)`);
        await expect(runCashierSecondCardOrigin(f.db)).rejects.toThrow('already running'); }); });
      await f.db.transaction(async tx => { await expect(runCashierSecondCardOrigin(tx as unknown as DbClient)).rejects.toThrow('root maintenance client'); });
      await expect(f.db.transaction(async tx => { await tx.execute(sql.raw(CASHIER_SECOND_CARD_ORIGIN_INSTALLATION_SQL)); },
        { isolationLevel: 'repeatable read', accessMode: 'read write' })).rejects.toThrow('reviewed PG16 owner transaction');
      expect((await f.exec("SELECT to_regclass('public.cashier_second_card_cart_v1') AS draft,to_regclass('public.cashier_second_card_origin_v1') AS origin,to_regclass('public.cashier_second_card_payment_v1') AS payment"))[0]).toEqual({ draft: null, origin: null, payment: null });
    }, false);
  }, 60000);
  it('permits actual promotion FOR UPDATE locks while refusing every runtime UPDATE including id equals id', async () => {
    await withFixture(async f => { await f.app(async peer => {
      await peer.exec('INSERT INTO public.store_order_promotions(oid,uid,promotions_id,product_id,promotions_price,add_time) VALUES(11,201,31,301,2.00,10)');
      const [before] = await peer.exec('SELECT * FROM public.store_order_promotions');
      expect((await peer.exec(`SELECT has_function_privilege(current_user,'public.${CASHIER_SECOND_CARD_PROMOTION_LOCK_FUNCTION}()','EXECUTE') AS allowed`))[0].allowed).toBe(false);
      await peer.db.transaction(async tx => {
        expect((await tx.execute(sql`SELECT id FROM public.store_order_promotions WHERE id=${Number(before.id)} FOR UPDATE`))[0].id).toBe(before.id);
        await f.withPeer(async other => {
          expect(other.pid).not.toBe(peer.pid);
          await rejectsCode(other.exec(`SELECT id FROM public.store_order_promotions WHERE id=${Number(before.id)} FOR UPDATE NOWAIT`), '55P03');
        });
      });
      for (const update of ['id=id', 'id=id+1', 'uid=202', 'promotions_price=3.00'])
        await rejectsCode(peer.exec(`UPDATE public.store_order_promotions SET ${update} WHERE id=${Number(before.id)}`), '42501');
      expect((await peer.exec('SELECT * FROM public.store_order_promotions'))[0]).toEqual(before);
      expect((await cashierSecondCardOriginReadiness(peer.db)).ready).toBe(true);
      await f.exec(`UPDATE public.store_order_promotions SET uid=202 WHERE id=${Number(before.id)}`);
      expect((await peer.exec('SELECT uid FROM public.store_order_promotions'))[0].uid).toBe(202);
      await f.exec(`UPDATE public.store_order_promotions SET uid=201 WHERE id=${Number(before.id)}`);
      expect((await peer.exec('SELECT * FROM public.store_order_promotions'))[0]).toEqual(before);
    }); });
  }, 60000);
  it('refuses the atomic compiler grant when the exact invoker guard is missing without reinstalling it', async () => {
    await withFixture(async f => { await f.app(async peer => {
      await f.exec(`REVOKE UPDATE(id) ON public.store_order_promotions FROM ${ident(peer.role)}; DROP TRIGGER ${CASHIER_SECOND_CARD_PROMOTION_LOCK_TRIGGER} ON public.store_order_promotions`);
      expect((await inspectCashierSecondCardPromotionLock(peer.db, peer.role)).ready).toBe(false);
      expect((await cashierSecondCardOriginReadiness(peer.db)).ready).toBe(false);
      await rejectsPostgresMessage(f.exec(cashierSecondCardPromotionLockGrantSql(peer.role)), 'Cashier promotion lock guard must be verified before UPDATE(id) grant');
      await rejectsPostgresMessage(installCashierSecondCardPromotionLock(f.db, peer.role), 'Cashier promotion lock catalog role ACL drift');
      const [state] = await peer.exec(`SELECT has_column_privilege(current_user,'public.store_order_promotions','id','UPDATE') AS granted,
        (SELECT count(*)::integer FROM pg_trigger WHERE tgrelid='public.store_order_promotions'::regclass AND NOT tgisinternal) AS triggers`);
      expect(state).toEqual({ granted: false, triggers: 0 });
    }); });
  }, 60000);
  it('closes readiness on missing id lock privilege while preserving append and requiring the guarded compiler to restore it', async () => {
    await withFixture(async f => { await f.app(async peer => {
      await f.exec(`REVOKE UPDATE(id) ON public.store_order_promotions FROM ${ident(peer.role)}`);
      expect(await cashierSecondCardOriginReadiness(peer.db)).toMatchObject({ ready: false, privileges: { promotion_lock_update: false, promotion_append: true } });
      await peer.exec('INSERT INTO public.store_order_promotions(oid,uid) VALUES(11,201)');
      await rejectsCode(peer.exec('SELECT id FROM public.store_order_promotions FOR UPDATE'), '42501');
      await f.exec(cashierSecondCardPromotionLockGrantSql(peer.role));
      expect((await cashierSecondCardOriginReadiness(peer.db)).ready).toBe(true);
      expect((await peer.exec('SELECT id FROM public.store_order_promotions FOR UPDATE')).length).toBe(1);
    }); });
  }, 60000);
  it('rejects function body security owner overload search path and trigger definition drift without repairing it', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const name = CASHIER_SECOND_CARD_PROMOTION_LOCK_FUNCTION, trigger = CASHIER_SECOND_CARD_PROMOTION_LOCK_TRIGGER;
      const probes = [
        `ALTER FUNCTION public.${name}() SECURITY DEFINER`,
        `ALTER FUNCTION public.${name}() SET search_path=public,pg_temp`,
        `ALTER FUNCTION public.${name}() STABLE`,
        `ALTER FUNCTION public.${name}() OWNER TO ${ident(f.owner)}`,
        `CREATE OR REPLACE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS 'BEGIN RETURN NEW; END'`,
        `CREATE FUNCTION public.${name}(integer) RETURNS integer LANGUAGE sql AS 'SELECT $1'`,
        `ALTER TABLE public.store_order_promotions DISABLE TRIGGER ${trigger}`,
        `DROP TRIGGER ${trigger} ON public.store_order_promotions; CREATE TRIGGER ${trigger} BEFORE UPDATE OF id ON public.store_order_promotions FOR EACH ROW EXECUTE FUNCTION public.${name}()`,
        `DROP TRIGGER ${trigger} ON public.store_order_promotions; CREATE TRIGGER ${trigger} BEFORE UPDATE ON public.store_order_promotions FOR EACH ROW WHEN(NEW.id<>OLD.id) EXECUTE FUNCTION public.${name}()`,
        `CREATE TRIGGER cashier_forged_promotion BEFORE INSERT ON public.store_order_promotions FOR EACH ROW EXECUTE FUNCTION public.${name}()`,
        `CREATE TABLE public.csc_foreign_guard(id integer); CREATE TRIGGER cashier_forged_foreign BEFORE UPDATE ON public.csc_foreign_guard FOR EACH ROW EXECUTE FUNCTION public.${name}()`,
      ];
      for (const probe of probes) {
        await rejectsPostgresMessage(f.db.transaction(async tx => {
          await tx.execute(sql.raw(probe)); expect((await inspectCashierSecondCardPromotionLock(tx, peer.role)).ready).toBe(false);
          await tx.execute(sql.raw(cashierSecondCardPromotionLockGrantSql(peer.role)));
        }), 'Cashier promotion lock guard must be verified before UPDATE(id) grant');
        expect((await inspectCashierSecondCardPromotionLock(peer.db, peer.role)).ready).toBe(true);
      }
    }); });
  }, 60000);
  it('rejects promotion relation index sequence RLS default and dropped-column drift before granting lock authority', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const probes = [
        'ALTER TABLE public.store_order_promotions ADD COLUMN forged integer',
        'ALTER TABLE public.store_order_promotions ADD COLUMN forged integer; ALTER TABLE public.store_order_promotions DROP COLUMN forged',
        'ALTER TABLE public.store_order_promotions ALTER COLUMN uid SET DEFAULT 1',
        'ALTER TABLE public.store_order_promotions ENABLE ROW LEVEL SECURITY',
        `ALTER TABLE public.store_order_promotions OWNER TO ${ident(f.owner)}`,
        'ALTER INDEX public.sop_order_product SET(fillfactor=80)',
        'DROP INDEX public.sop_order_product; CREATE INDEX sop_order_product ON public.store_order_promotions(product_id,oid)',
        'DROP INDEX public.sop_order_product; CREATE INDEX sop_order_product ON public.store_order_promotions(oid DESC,product_id)',
        'ALTER SEQUENCE public.store_order_promotions_id_seq INCREMENT 2',
        'ALTER SEQUENCE public.store_order_promotions_id_seq CYCLE',
        'ALTER SEQUENCE public.store_order_promotions_id_seq OWNED BY NONE',
      ];
      for (const probe of probes) {
        await rejectsPostgresMessage(f.db.transaction(async tx => {
          await tx.execute(sql.raw(probe)); expect((await inspectCashierSecondCardPromotionLock(tx, peer.role)).ready).toBe(false);
          await tx.execute(sql.raw(cashierSecondCardPromotionLockGrantSql(peer.role)));
        }), probe === `ALTER TABLE public.store_order_promotions OWNER TO ${ident(f.owner)}`
          ? 'Cashier promotion lock requires explicit PG16 table-owner maintenance'
          : 'Cashier promotion lock guard must be verified before UPDATE(id) grant');
        expect((await inspectCashierSecondCardPromotionLock(peer.db, peer.role)).ready).toBe(true);
      }
    }); });
  }, 60000);
  it('rejects every foreign mutation PUBLIC grant option and function ACL drift in the guarded promotion lane', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const probes = [`GRANT UPDATE ON public.store_order_promotions TO ${ident(peer.role)}`,
        `GRANT UPDATE(uid) ON public.store_order_promotions TO ${ident(peer.role)}`,
        `GRANT DELETE ON public.store_order_promotions TO ${ident(peer.role)}`,
        `GRANT UPDATE(id) ON public.store_order_promotions TO ${ident(peer.role)} WITH GRANT OPTION`,
        'GRANT SELECT ON public.store_order_promotions TO PUBLIC',
        'GRANT USAGE ON SEQUENCE public.store_order_promotions_id_seq TO PUBLIC',
        `GRANT UPDATE ON SEQUENCE public.store_order_promotions_id_seq TO ${ident(peer.role)}`,
        `GRANT EXECUTE ON FUNCTION public.${CASHIER_SECOND_CARD_PROMOTION_LOCK_FUNCTION}() TO ${ident(peer.role)}`,
        `GRANT EXECUTE ON FUNCTION public.${CASHIER_SECOND_CARD_PROMOTION_LOCK_FUNCTION}() TO PUBLIC`];
      for (const probe of probes) {
        await rejectsPostgresMessage(f.db.transaction(async tx => {
          await tx.execute(sql.raw(probe)); expect((await inspectCashierSecondCardPromotionLock(tx, peer.role)).ready).toBe(false);
          await tx.execute(sql.raw(cashierSecondCardPromotionLockGrantSql(peer.role)));
        }), 'Cashier promotion lock guard must be verified before UPDATE(id) grant');
        expect((await cashierSecondCardOriginReadiness(peer.db)).ready).toBe(true);
      }
    }); });
  }, 60000);
  it('rejects real LOGIN SET ROLE updates even when the assumed foreign role has actual id update privilege', async () => {
    await withFixture(async f => { await f.app(async peer => {
      const auxiliary = `csc_assumed_${randomUUID().replaceAll('-', '')}`;
      await peer.exec('INSERT INTO public.store_order_promotions(oid,uid) VALUES(11,201)');
      const [before] = await peer.exec('SELECT * FROM public.store_order_promotions');
      await f.exec(`CREATE ROLE ${ident(auxiliary)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
        GRANT SELECT ON public.store_order_promotions TO ${ident(auxiliary)}; GRANT UPDATE(id) ON public.store_order_promotions TO ${ident(auxiliary)}; GRANT ${ident(auxiliary)} TO ${ident(peer.role)}`);
      try {
        expect((await inspectCashierSecondCardPromotionLock(peer.db, peer.role)).ready).toBe(false);
        await peer.exec(`SET ROLE ${ident(auxiliary)}`);
        const [actual] = await peer.exec(`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,
          (SELECT usesysid::regrole::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS backend`);
        expect(actual).toEqual({ role: auxiliary, session: peer.role, pid: peer.pid, backend: peer.role });
        await rejectsCode(peer.exec('UPDATE public.store_order_promotions SET id=id'), '42501');
        await peer.exec('RESET ROLE'); expect((await peer.exec('SELECT * FROM public.store_order_promotions'))[0]).toEqual(before);
      } finally { await peer.exec('RESET ROLE'); await f.exec(`REVOKE ${ident(auxiliary)} FROM ${ident(peer.role)}; DROP OWNED BY ${ident(auxiliary)}; DROP ROLE ${ident(auxiliary)}`); }
      expect((await cashierSecondCardOriginReadiness(peer.db)).ready).toBe(true);
    }); });
  }, 60000);
  it('rejects actual inherited and SET ROLE delegation from a second independent LOGIN while keeping all rows immutable', async () => {
    await withFixture(async f => { await f.app(async peer => {
      await peer.exec('INSERT INTO public.store_order_promotions(oid,uid) VALUES(11,201)'); const [before] = await peer.exec('SELECT * FROM public.store_order_promotions');
      await f.withRuntimeRole(async delegate => {
        expect(delegate.pid).not.toBe(peer.pid); expect(delegate.role).not.toBe(peer.role);
        await f.exec(`GRANT ${ident(peer.role)} TO ${ident(delegate.role)} WITH INHERIT TRUE; GRANT ${ident(peer.role)} TO ${ident(delegate.role)} WITH SET TRUE`);
        try {
          expect((await delegate.exec(`SELECT pg_has_role(current_user,${literal(peer.role)},'USAGE') AS inherited`))[0].inherited).toBe(true);
          await rejectsCode(delegate.exec('UPDATE public.store_order_promotions SET id=id'), '42501');
          await delegate.exec(`SET ROLE ${ident(peer.role)}`);
          expect((await delegate.exec('SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid'))[0]).toEqual({ role: peer.role, session: delegate.role, pid: delegate.pid });
          await rejectsCode(delegate.exec('UPDATE public.store_order_promotions SET id=id'), '42501');
          await delegate.exec('RESET ROLE'); expect((await delegate.exec('SELECT * FROM public.store_order_promotions'))[0]).toEqual(before);
        } finally { await delegate.exec('RESET ROLE'); await f.exec(`REVOKE ${ident(peer.role)} FROM ${ident(delegate.role)}`); }
      });
      expect((await cashierSecondCardOriginReadiness(peer.db)).ready).toBe(true);
    }); });
  }, 60000);
  it('rejects actual SET ROLE to a nonsuperuser table owner while that owners real independent LOGIN can maintain rows', async () => {
    await withFixture(async f => { await f.app(async peer => {
      await peer.exec('INSERT INTO public.store_order_promotions(oid,uid) VALUES(11,201)');
      const [before] = await peer.exec('SELECT * FROM public.store_order_promotions'), [maintenance] = await f.exec('SELECT current_user AS role');
      await f.withRuntimeRole(async ownerPeer => {
        expect(ownerPeer.pid).not.toBe(peer.pid); expect(ownerPeer.role).not.toBe(peer.role);
        await f.exec(`ALTER TABLE public.store_order_promotions OWNER TO ${ident(ownerPeer.role)};
          ALTER FUNCTION public.${CASHIER_SECOND_CARD_PROMOTION_LOCK_FUNCTION}() OWNER TO ${ident(ownerPeer.role)};
          GRANT ${ident(ownerPeer.role)} TO ${ident(peer.role)} WITH SET TRUE`);
        try {
          expect((await inspectCashierSecondCardPromotionLock(peer.db, peer.role)).ready).toBe(false);
          await peer.exec(`SET ROLE ${ident(ownerPeer.role)}`);
          expect((await peer.exec('SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid'))[0]).toEqual({ role: ownerPeer.role, session: peer.role, pid: peer.pid });
          await rejectsCode(peer.exec('UPDATE public.store_order_promotions SET id=id'), '42501');
          await peer.exec('RESET ROLE'); expect((await peer.exec('SELECT * FROM public.store_order_promotions'))[0]).toEqual(before);
          await ownerPeer.exec('UPDATE public.store_order_promotions SET uid=202');
          expect((await ownerPeer.exec('SELECT uid FROM public.store_order_promotions'))[0].uid).toBe(202);
          await ownerPeer.exec('UPDATE public.store_order_promotions SET uid=201');
          expect((await peer.exec('SELECT * FROM public.store_order_promotions'))[0]).toEqual(before);
        } finally {
          await peer.exec('RESET ROLE');
          await f.exec(`REVOKE ${ident(ownerPeer.role)} FROM ${ident(peer.role)};
            ALTER FUNCTION public.${CASHIER_SECOND_CARD_PROMOTION_LOCK_FUNCTION}() OWNER TO ${ident(String(maintenance.role))};
            ALTER TABLE public.store_order_promotions OWNER TO ${ident(String(maintenance.role))}`);
        }
      });
      expect((await cashierSecondCardOriginReadiness(peer.db)).ready).toBe(true);
    }); });
  }, 60000);
  it('refuses runtime installation trigger disable replication changes and latent owner authority without granting repairs', async () => {
    await withFixture(async f => { await f.app(async peer => {
      await rejectsPostgresMessage(installCashierSecondCardPromotionLock(peer.db, peer.role), 'Cashier promotion lock requires explicit PG16 table-owner maintenance');
      await rejectsPostgresMessage(peer.exec(cashierSecondCardPromotionLockGrantSql(peer.role)), 'Cashier promotion lock requires explicit PG16 table-owner maintenance');
      await rejectsCode(peer.exec(`ALTER TABLE public.store_order_promotions DISABLE TRIGGER ${CASHIER_SECOND_CARD_PROMOTION_LOCK_TRIGGER}`), '42501');
      await rejectsCode(peer.exec("SET session_replication_role='replica'"), '42501');
      await f.exec(`GRANT SET ON PARAMETER session_replication_role TO ${ident(peer.role)}`);
      try { expect((await inspectCashierSecondCardPromotionLock(peer.db, peer.role)).ready).toBe(false); }
      finally { await f.exec(`REVOKE SET ON PARAMETER session_replication_role FROM ${ident(peer.role)}`); }
      const [owner] = await f.exec('SELECT current_user AS role');
      await f.exec(`GRANT ${ident(String(owner.role))} TO ${ident(peer.role)}`);
      try { expect((await inspectCashierSecondCardPromotionLock(peer.db, peer.role)).ready).toBe(false); }
      finally { await f.exec(`REVOKE ${ident(String(owner.role))} FROM ${ident(peer.role)}`); }
      expect((await cashierSecondCardOriginReadiness(peer.db)).ready).toBe(true);
    }); });
  }, 60000);
  it('keeps independent actor UUID and physical-order uniqueness across two real LOGIN peers', async () => {
    await withFixture(async f => { await f.app(async first => { await f.app(async second => {
      expect(first.role).not.toBe(second.role); expect(first.pid).not.toBe(second.pid);
      await first.exec(await draftSql()); await rejectsCode(second.exec(await draftSql()), '23505');
      await first.exec(await originSql()); await rejectsCode(second.exec(await originSql()), '23505');
      await first.exec(paymentSql()); await rejectsCode(second.exec(paymentSql({ request_key: randomUUID() })), '23505');
      expect((await second.exec('SELECT origin FROM public.cashier_second_card_origin_v1'))[0].origin).toEqual(origin());
      expect((await second.exec('SELECT evidence FROM public.cashier_second_card_payment_v1'))[0].evidence).toEqual(payment());
    }); }); });
  }, 60000);
});
