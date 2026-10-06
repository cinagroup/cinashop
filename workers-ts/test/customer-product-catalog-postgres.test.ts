import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../src/lib/di';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { CUSTOMER_PRODUCT_OPERATION_INSTALLATION_SQL } from '../src/migrations/customerProductOperation';
import {
  CUSTOMER_PRODUCT_OPERATION_CATALOG_SHA256, CUSTOMER_PRODUCT_OPERATION_CATALOG_SQL,
  inspectCustomerProductOperation, customerProductOperationReadiness, runCustomerProductOperation,
} from '../src/migrations/runCustomerProductOperation';
import {
  CUSTOMER_PRODUCT_CATALOG_LOCK_KEY, CUSTOMER_PRODUCT_CATALOG_OWNER_SETTING,
  customerProductCatalogLockInstallationSql,
} from '../src/migrations/customerProductCatalogLock';
import {
  acquireCustomerProductCatalogLock, customerProductCatalogLockReadiness,
  inspectCustomerProductCatalogLock, installCustomerProductCatalogLock,
} from '../src/migrations/runCustomerProductCatalogLock';
import { installCustomerWorkScopeLock, acquireCustomerWorkScopeLock } from '../src/migrations/runCustomerWorkScopeLock';
import { CUSTOMER_WORK_LOCK_FUNCTIONS } from '../src/migrations/customerWorkRuntimePrivilegePlan';
import { CUSTOMER_PRODUCT_FUNCTIONS, customerProductRuntimePrivilegePlan } from '../src/migrations/customerProductRuntimePlan';

type Native = Extract<Awaited<ReturnType<typeof sequenceRunnerDatabase>>, { format: 'pg16' }>;
type RuntimePeer = SequenceRunnerPeer & { role: string; connectionString: string };
const taxonomy = ['store_product_category', 'store_product_label', 'category'] as const;
const relationNames = [...taxonomy, 'store_service', 'express_company', 'delivery_service', 'customer_product_operation_request'];
const ident = (value: string) => {
  if (!/^[a-z_][a-z_0-9]{0,62}$/.test(value)) throw Error('Unsafe owned catalog fixture identifier');
  return `"${value}"`;
};
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const json = (value: unknown) => `${literal(JSON.stringify(value))}::jsonb`;
const hash = (letter: string) => letter.repeat(64);
function postgresCode(error: unknown): string | undefined {
  let current = error;
  for (let i = 0; i < 8 && current && typeof current === 'object'; i++) {
    const row = current as { code?: unknown; cause?: unknown };
    if (typeof row.code === 'string') return row.code;
    current = row.cause;
  }
  return undefined;
}
async function rejectsCode(pending: Promise<unknown>, expected: string) {
  let failure: unknown;
  try { await pending; } catch (error) { failure = error; }
  expect(failure, `SQL must fail with ${expected}`).toBeDefined();
  expect(postgresCode(failure)).toBe(expected);
}
const txClient = (tx: unknown) => tx as DbClient; // Actual Drizzle transaction, never a root handle or SET ROLE.
async function rolledBack(db: DbClient, callback: (tx: DbClient) => Promise<void>) {
  const rollback = Error('Owned catalog probe rollback');
  try {
    await db.transaction(async tx => { await callback(txClient(tx)); throw rollback; });
    throw Error('Catalog probe unexpectedly committed');
  } catch (error) { if (error !== rollback) throw error; }
}

/** Only these minimal real relations are installed. Every grant on an installed
 * relation/routine comes from the actual product runtime profile. Missing shop
 * objects are not fabricated merely to apply its unrelated historical grants. */
async function fixture(ledger = true) {
  const candidate = await sequenceRunnerDatabase();
  if (candidate.format !== 'pg16' || !candidate.withRuntimeRole) {
    await candidate.close(); throw Error('Product catalog contract requires native PG16 independent LOGIN');
  }
  const f = candidate as Native;
  const roles: string[] = [];
  const createRole = async (prefix: string) => {
    const role = `${prefix}_${randomUUID().replaceAll('-', '')}`;
    await f.exec(`CREATE ROLE ${ident(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    roles.push(role); return role;
  };
  const close = async () => {
    try {
      for (const role of [...roles].reverse()) {
        await f.exec(`DROP OWNED BY ${ident(role)}; DROP ROLE ${ident(role)}`);
      }
    } finally { await f.close(); }
  };
  try {
    await f.exec(`
      CREATE TABLE public.store_product_category(id integer PRIMARY KEY,name text NOT NULL DEFAULT '',status integer NOT NULL DEFAULT 1);
      CREATE TABLE public.store_product_label(id integer PRIMARY KEY,name text NOT NULL DEFAULT '',status integer NOT NULL DEFAULT 1);
      CREATE TABLE public.category(id integer PRIMARY KEY,name text NOT NULL DEFAULT '',status integer NOT NULL DEFAULT 1);
      CREATE TABLE public.store_service(id integer PRIMARY KEY,uid integer NOT NULL,online integer NOT NULL DEFAULT 0,customer integer NOT NULL DEFAULT 1);
      CREATE TABLE public.express_company(id integer PRIMARY KEY,name text NOT NULL DEFAULT '');
      CREATE TABLE public.delivery_service(id integer PRIMARY KEY,uid integer NOT NULL);
      INSERT INTO public.store_product_category(id,name) VALUES(1,'actual category');
      INSERT INTO public.store_product_label(id,name) VALUES(1,'actual label');
      INSERT INTO public.category(id,name) VALUES(1,'actual group');
      INSERT INTO public.store_service(id,uid) VALUES(1,101);
      INSERT INTO public.express_company(id) VALUES(1);
      INSERT INTO public.delivery_service(id,uid) VALUES(1,102);
    `);
    const scopeOwner = await createRole('cpo_scope');
    const catalogOwner = await createRole('cpo_taxonomy');
    await installCustomerWorkScopeLock(f.db, scopeOwner);
    await installCustomerProductCatalogLock(f.db, catalogOwner);
    if (ledger) await runCustomerProductOperation(f.db);
    const app = <T>(callback: (peer: RuntimePeer) => Promise<T>) => f.withRuntimeRole(async peer => {
      const plan = customerProductRuntimePrivilegePlan();
      for (const table of relationNames.filter(name => ledger || name !== 'customer_product_operation_request')) {
        const privileges = plan.tables[table];
        if (!privileges) throw Error(`Installed table absent from actual product profile: ${table}`);
        if (privileges.length) await f.exec(`GRANT ${privileges.join(',')} ON public.${ident(table)} TO ${ident(peer.role)}`);
        const columns = plan.updateColumns[table];
        if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(ident).join(',')}) ON public.${ident(table)} TO ${ident(peer.role)}`);
      }
      for (const signature of [...CUSTOMER_WORK_LOCK_FUNCTIONS, ...CUSTOMER_PRODUCT_FUNCTIONS]) {
        if (!ledger && signature === 'customer_product_targets_valid_v1(jsonb)') continue;
        expect(plan.functions).toContain(signature);
        await f.exec(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${ident(peer.role)}`);
      }
      const [identity] = await peer.exec(`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,
        current_setting('server_version_num')::int AS version,current_database() AS database,
        (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated`);
      expect(identity).toMatchObject({ role: peer.role, session: peer.role, pid: peer.pid, elevated: false });
      expect(Math.floor(Number(identity.version) / 10000)).toBe(16);
      return callback(peer);
    });
    return { ...f, close, app, createRole, scopeOwner, catalogOwner };
  } catch (error) { await close(); throw error; }
}
async function withFixture(callback: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, ledger = true) {
  const f = await fixture(ledger);
  try { await callback(f); } finally { await f.close(); }
}
function receiptSql(overrides: Record<string, unknown> = {}) {
  const targets = [{ product_id: 1, expected_product_revision: hash('a') }];
  const row: Record<string, unknown> = {
    actor_uid: 101, request_key: randomUUID(), request_hash: hash('d'), service_id: 1,
    kind: 'replace_categories', scope_key: hash('b'), targets,
    expected_catalog_revision: hash('c'), evidence: {}, outcome: 'products-updated', ...overrides,
  };
  if (!Object.hasOwn(overrides, 'intent')) row.intent = {
    version: 'customer-work-product-operation-v1', scope_key: row.scope_key, targets: row.targets,
    expected_catalog_revision: row.expected_catalog_revision, payload: { ids: [1] },
  };
  const columns = ['actor_uid', 'request_key', 'request_hash', 'service_id', 'kind', 'scope_key', 'targets', 'expected_catalog_revision', 'intent', 'evidence', 'outcome'];
  return `INSERT INTO public.customer_product_operation_request(${columns.join(',')}) VALUES(${columns.map(column => {
    const value = row[column];
    if (['targets', 'intent', 'evidence'].includes(column)) return json(value);
    return typeof value === 'number' ? String(value) : literal(String(value));
  }).join(',')})`;
}
const countReceipts = async (peer: Pick<SequenceRunnerPeer, 'exec'>) => Number((await peer.exec('SELECT count(*) AS count FROM public.customer_product_operation_request'))[0].count);

describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('customer product catalog PG16 independent LOGIN contract', () => {
  it('measures canonical product ledger and immutable validator fingerprint from actual PG16', async () => {
    await withFixture(async f => {
      const state = await inspectCustomerProductOperation(f.db);
      expect(state.present).toBe(true); expect(state.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      const [server] = await f.exec('SELECT current_database() AS database,current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting(\'server_version_num\') AS version');
      const shape = await f.db.execute<{ shape: unknown }>(sql.raw(CUSTOMER_PRODUCT_OPERATION_CATALOG_SQL));
      expect(shape).toHaveLength(1);
      console.info('CUSTOMER_PRODUCT_CANONICAL_PG16 ' + JSON.stringify({ server, fingerprint: state.fingerprint, expected: CUSTOMER_PRODUCT_OPERATION_CATALOG_SHA256, shape: shape[0].shape }));
      // The measurement case is intentionally runnable while the constant is
      // unmeasured. All readiness-positive cases below require the measured pin.
      if (String(CUSTOMER_PRODUCT_OPERATION_CATALOG_SHA256) !== 'unmeasured') {
        expect(state.fingerprint).toBe(CUSTOMER_PRODUCT_OPERATION_CATALOG_SHA256); expect(state.complete).toBe(true);
      } else expect(state.complete).toBe(false);
    });
  }, 60000);

  it('enforces real SQL sorted bounded exact targets and rejects malformed JSON without nullable CHECK escapes', async () => {
    await withFixture(async f => f.app(async peer => {
      const target = (product_id: unknown) => ({ product_id, expected_product_revision: hash('a') });
      const good = [target(1), target(2)];
      const invalid: unknown[] = [null, {}, [], [null], [1], [target(0)], [target(-1)], [target(2147483648)],
        [target('1')], [target(true)], [target(1.5)], [target(2), target(1)], [target(1), target(1)],
        [{ product_id: 1 }], [{ ...target(1), extra: true }], [{ ...target(1), expected_product_revision: 'A'.repeat(64) }],
        Array.from({ length: 101 }, (_, i) => target(i + 1))];
      for (const targets of invalid) {
        const [row] = await peer.exec(`SELECT public.customer_product_targets_valid_v1(${json(targets)}) AS valid`);
        expect(row.valid).toBe(false);
        await rejectsCode(peer.exec(receiptSql({ targets })), '23514');
      }
      for (const targets of [good, Array.from({ length: 100 }, (_, i) => target(i + 1))]) {
        expect((await peer.exec(`SELECT public.customer_product_targets_valid_v1(${json(targets)}) AS valid`))[0].valid).toBe(true);
      }
      expect(await countReceipts(peer)).toBe(0);
      await peer.exec(receiptSql({ targets: good })); expect(await countReceipts(peer)).toBe(1);
    }));
  }, 60000);

  it('enforces complete intent, actor, UUID, hash and kind/outcome pairing while preserving append-only identity', async () => {
    await withFixture(async f => f.app(async peer => {
      const targets = [{ product_id: 1, expected_product_revision: hash('a') }];
      const intent = { version: 'customer-work-product-operation-v1', scope_key: hash('b'), targets, expected_catalog_revision: hash('c'), payload: {} };
      const invalid = [{ actor_uid: 0 }, { service_id: 0 }, { request_key: '11111111-1111-1111-8111-111111111111' },
        { request_hash: 'A'.repeat(64) }, { scope_key: 'bad' }, { expected_catalog_revision: 'bad' },
        { kind: 'admin_reward' }, { kind: 'update_skus', outcome: 'products-updated' }, { kind: 'set_show', outcome: 'skus-updated' },
        { evidence: [] }, { evidence: { text: 'x'.repeat(17000) } }, { intent: [] },
        { intent: { ...intent, version: 'customer-work-operation-v1' } }, { intent: { ...intent, scope_key: hash('e') } },
        { intent: { ...intent, targets: [] } }, { intent: { ...intent, expected_catalog_revision: hash('e') } },
        { intent: { ...intent, payload: null } }, { intent: { ...intent, extra: true } },
        { intent: { version: intent.version } }, { intent: { ...intent, payload: { text: 'x'.repeat(263000) } } }];
      for (const row of invalid) await rejectsCode(peer.exec(receiptSql(row)), '23514');
      expect(await countReceipts(peer)).toBe(0);
      const key = randomUUID();
      await peer.exec(receiptSql({ request_key: key }));
      await rejectsCode(peer.exec(receiptSql({ request_key: key })), '23505');
      await peer.exec(receiptSql({ actor_uid: 102, request_key: key }));
      await peer.exec(receiptSql({ kind: 'update_skus', outcome: 'skus-updated' }));
      await peer.exec(receiptSql({ service_id: 0, outcome: 'abandoned' }));
      expect(await countReceipts(peer)).toBe(4);
    }));
  }, 60000);

  it('detects same-name constraint, index, column and immutable validator structural drift from actual catalogs', async () => {
    await withFixture(async f => {
      const canonical = await inspectCustomerProductOperation(f.db);
      expect(canonical.fingerprint).toBe(CUSTOMER_PRODUCT_OPERATION_CATALOG_SHA256);
      const probes = [
        'ALTER TABLE customer_product_operation_request DROP CONSTRAINT cpo_outcome_ck; ALTER TABLE customer_product_operation_request ADD CONSTRAINT cpo_outcome_ck CHECK(true)',
        'DROP INDEX cpo_actor_history; CREATE INDEX cpo_actor_history ON customer_product_operation_request(actor_uid,created_at,request_key) WHERE actor_uid>100',
        'ALTER TABLE customer_product_operation_request ADD COLUMN unreviewed text',
        "CREATE OR REPLACE FUNCTION customer_product_targets_valid_v1(jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS 'SELECT true'",
        "CREATE FUNCTION customer_product_targets_valid_v1(integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'",
        'CREATE POLICY cpo_unreviewed_policy ON customer_product_operation_request USING(true)',
        'CREATE TABLE cpo_inbound_fk_probe(actor_uid integer,request_key uuid,FOREIGN KEY(actor_uid,request_key) REFERENCES customer_product_operation_request(actor_uid,request_key))',
      ];
      for (const probe of probes) await rolledBack(f.db, async tx => {
        await tx.execute(sql.raw(probe)); const changed = await inspectCustomerProductOperation(tx);
        expect(changed.fingerprint).not.toBe(canonical.fingerprint); expect(changed.complete).toBe(false);
      });
      expect((await inspectCustomerProductOperation(f.db)).fingerprint).toBe(canonical.fingerprint);
    });
  }, 60000);

  it('accepts the actual minimal runtime profile and rejects mutable table/column/PUBLIC and reachable owner authority', async () => {
    await withFixture(async f => f.app(async peer => {
      expect(CUSTOMER_PRODUCT_OPERATION_CATALOG_SHA256).toMatch(/^[a-f0-9]{64}$/);
      expect((await customerProductOperationReadiness(peer.db)).ready).toBe(true);
      for (const table of taxonomy) {
        await peer.exec(`SELECT id FROM public.${ident(table)}`);
        await rejectsCode(peer.exec(`UPDATE public.${ident(table)} SET status=0`), '42501');
        await rejectsCode(peer.exec(`DELETE FROM public.${ident(table)} WHERE id=1`), '42501');
        await rejectsCode(peer.exec(`INSERT INTO public.${ident(table)}(id) VALUES(99)`), '42501');
      }
      await peer.exec(receiptSql());
      await rejectsCode(peer.exec('UPDATE customer_product_operation_request SET service_id=9'), '42501');
      await rejectsCode(peer.exec('DELETE FROM customer_product_operation_request'), '42501');
      await rejectsCode(peer.exec('TRUNCATE customer_product_operation_request'), '42501');
      const probes = [
        { grant: `GRANT UPDATE ON customer_product_operation_request TO ${ident(peer.role)}`, revoke: `REVOKE UPDATE ON customer_product_operation_request FROM ${ident(peer.role)}` },
        { grant: `GRANT UPDATE(evidence) ON customer_product_operation_request TO ${ident(peer.role)}`, revoke: `REVOKE UPDATE(evidence) ON customer_product_operation_request FROM ${ident(peer.role)}` },
        { grant: 'GRANT SELECT ON customer_product_operation_request TO PUBLIC', revoke: 'REVOKE SELECT ON customer_product_operation_request FROM PUBLIC' },
        { grant: `GRANT UPDATE(status) ON category TO ${ident(peer.role)}`, revoke: `REVOKE UPDATE(status) ON category FROM ${ident(peer.role)}` },
      ];
      for (const probe of probes) {
        try { await f.exec(probe.grant); expect((await customerProductOperationReadiness(peer.db)).ready).toBe(false); }
        finally { await f.exec(probe.revoke); }
        expect((await customerProductOperationReadiness(peer.db)).ready).toBe(true);
      }
      const broad = await f.createRole('cpo_reachable');
      try {
        await f.exec(`GRANT UPDATE ON category TO ${ident(broad)}; GRANT ${ident(broad)} TO ${ident(peer.role)}`);
        expect((await customerProductCatalogLockReadiness(peer.db)).ready).toBe(false);
      } finally { await f.exec(`REVOKE ${ident(broad)} FROM ${ident(peer.role)}; REVOKE UPDATE ON category FROM ${ident(broad)}`); }
      // Ownership is reachable with SET ROLE even though this ordinary LOGIN
      // is NOINHERIT and has no direct ledger UPDATE. Both protocol owners move
      // together so validator_safe alone cannot accidentally conceal the path.
      try {
        await f.exec(`ALTER TABLE customer_product_operation_request OWNER TO ${ident(broad)}; ALTER FUNCTION customer_product_targets_valid_v1(jsonb) OWNER TO ${ident(broad)}; GRANT ${ident(broad)} TO ${ident(peer.role)}`);
        expect((await customerProductOperationReadiness(peer.db)).ready).toBe(false);
      } finally {
        await f.exec(`REVOKE ${ident(broad)} FROM ${ident(peer.role)}; ALTER TABLE customer_product_operation_request OWNER TO finance_test; ALTER FUNCTION customer_product_targets_valid_v1(jsonb) OWNER TO finance_test`);
      }
      expect((await customerProductOperationReadiness(peer.db)).ready).toBe(true);
    }));
  }, 60000);

  it('rejects unsafe NOLOGIN owner capabilities, both membership directions and exact definer body drift', async () => {
    await withFixture(async f => f.app(async peer => {
      const original = await inspectCustomerProductCatalogLock(f.db);
      expect(original).toMatchObject({ tablesSafe: true, definitionSafe: true, ownerSafe: true, aclSafe: true });
      expect(f.scopeOwner).not.toBe(f.catalogOwner);
      const other = await f.createRole('cpo_owner_probe');
      await f.exec('CREATE SEQUENCE public.cpo_owner_sequence_probe');
      const probes = [
        { grant: `ALTER ROLE ${ident(f.catalogOwner)} LOGIN`, revoke: `ALTER ROLE ${ident(f.catalogOwner)} NOLOGIN` },
        { grant: `GRANT ${ident(f.catalogOwner)} TO ${ident(other)}`, revoke: `REVOKE ${ident(f.catalogOwner)} FROM ${ident(other)}` },
        { grant: `GRANT ${ident(other)} TO ${ident(f.catalogOwner)}`, revoke: `REVOKE ${ident(other)} FROM ${ident(f.catalogOwner)}` },
        { grant: `GRANT CREATE ON SCHEMA public TO ${ident(f.catalogOwner)}`, revoke: `REVOKE CREATE ON SCHEMA public FROM ${ident(f.catalogOwner)}` },
        { grant: `GRANT USAGE ON SEQUENCE cpo_owner_sequence_probe TO ${ident(f.catalogOwner)}`, revoke: `REVOKE USAGE ON SEQUENCE cpo_owner_sequence_probe FROM ${ident(f.catalogOwner)}` },
        { grant: 'GRANT EXECUTE ON FUNCTION customer_product_lock_catalog_v1(text,integer[]) TO PUBLIC', revoke: 'REVOKE EXECUTE ON FUNCTION customer_product_lock_catalog_v1(text,integer[]) FROM PUBLIC' },
      ];
      for (const probe of probes) {
        try { await f.exec(probe.grant); expect((await customerProductCatalogLockReadiness(peer.db)).ready).toBe(false); }
        finally { await f.exec(probe.revoke); }
        expect((await customerProductCatalogLockReadiness(peer.db)).ready).toBe(true);
      }
      await rolledBack(f.db, async tx => {
        await tx.execute(sql.raw("CREATE OR REPLACE FUNCTION customer_product_lock_catalog_v1(text,integer[]) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'BEGIN RETURN; END'"));
        expect((await inspectCustomerProductCatalogLock(tx)).definitionSafe).toBe(false);
      });
      await rolledBack(f.db, async tx => {
        await tx.execute(sql.raw(`CREATE FUNCTION cpo_unreviewed_owned() RETURNS integer LANGUAGE sql AS 'SELECT 1'; ALTER FUNCTION cpo_unreviewed_owned() OWNER TO ${ident(f.catalogOwner)}`));
        expect((await inspectCustomerProductCatalogLock(tx)).ownerSafe).toBe(false);
      });
    }));
  }, 60000);

  it('fences absent taxonomy inserts with two real LOGIN transactions and releases table SHARE only on commit', async () => {
    await withFixture(async f => f.app(async customer => f.withRuntimeRole(async writer => {
      for (const table of taxonomy) await f.exec(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.${ident(table)} TO ${ident(writer.role)}`);
      expect(customer.pid).not.toBe(writer.pid); expect(customer.role).not.toBe(writer.role);
      let reached!: () => void, release!: () => void, peerOpen = false;
      const entered = new Promise<void>(resolve => { reached = resolve; });
      const resume = new Promise<void>(resolve => { release = resolve; });
      const codes: string[] = [];
      const pending = customer.db.transaction(async tx => {
        // Invoke actual reviewed routines; the barrier does not replace them.
        await acquireCustomerWorkScopeLock(txClient(tx), 101);
        await acquireCustomerProductCatalogLock(txClient(tx), 'label', []);
        reached(); await resume;
        await tx.execute(sql.raw(receiptSql()));
      }, { isolationLevel: 'read committed', accessMode: 'read write' }).then(() => ({ error: null }), error => ({ error }));
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([entered, pending.then(() => { throw Error('Caller completed before actual catalog fence barrier'); }),
          new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(Error('Actual catalog fence barrier not reached')), 7000); })]);
        if (deadline) clearTimeout(deadline);
        // Observe through maintenance's separate connection. The paused caller
        // owns its single runtime connection until the transaction completes.
        expect(await countReceipts(f)).toBe(0);
        for (const table of taxonomy) {
          await writer.exec('BEGIN'); peerOpen = true;
          await writer.exec("SET LOCAL lock_timeout='150ms'");
          let failure: unknown;
          try { await writer.exec(`INSERT INTO public.${ident(table)}(id,name) VALUES(999,'actual phantom')`); }
          catch (error) { failure = error; }
          codes.push(postgresCode(failure) ?? 'none'); expect(postgresCode(failure)).toBe('55P03');
          await writer.exec('ROLLBACK'); peerOpen = false;
        }
        release(); expect((await pending).error).toBeNull(); expect(await countReceipts(customer)).toBe(1);
        for (const table of taxonomy) {
          await writer.exec(`INSERT INTO public.${ident(table)}(id,name) VALUES(999,'committed after fence')`);
          expect(Number((await writer.exec(`SELECT count(*) AS count FROM public.${ident(table)} WHERE id=999`))[0].count)).toBe(1);
        }
        console.info('CUSTOMER_PRODUCT_PHANTOM_FENCE ' + JSON.stringify({ customer: { role: customer.role, pid: customer.pid }, writer: { role: writer.role, pid: writer.pid }, codes, receiptCount: await countReceipts(customer), commitReleased: true }));
      } finally {
        if (deadline) clearTimeout(deadline); release();
        try { if (peerOpen) await writer.exec('ROLLBACK'); }
        finally { await pending; }
      }
    })));
  }, 60000);

  it('refuses reverse ROW EXCLUSIVE and maintenance collisions without a receipt and then permits the released caller', async () => {
    await withFixture(async f => f.app(async customer => f.withRuntimeRole(async writer => {
      await f.exec(`GRANT INSERT,SELECT ON category TO ${ident(writer.role)}`);
      let peerOpen = false;
      try {
        await writer.exec('BEGIN'); peerOpen = true;
        await writer.exec("INSERT INTO category(id,name) VALUES(999,'uncommitted phantom first')");
        await rejectsCode(customer.db.transaction(async tx => {
          await acquireCustomerWorkScopeLock(txClient(tx), 101);
          await acquireCustomerProductCatalogLock(txClient(tx), 'category', [1]);
          await tx.execute(sql.raw(receiptSql()));
        }, { isolationLevel: 'read committed', accessMode: 'read write' }), '55P03');
        expect(await countReceipts(customer)).toBe(0);
        await writer.exec('ROLLBACK'); peerOpen = false;
        await writer.exec('BEGIN'); peerOpen = true;
        const [held] = await writer.exec(`SELECT pg_try_advisory_xact_lock(${CUSTOMER_PRODUCT_CATALOG_LOCK_KEY},oid::int) AS locked FROM pg_namespace WHERE nspname='public'`);
        expect(held.locked).toBe(true);
        await expect(customer.db.transaction(tx => acquireCustomerProductCatalogLock(txClient(tx), 'category', [1]))).rejects.toThrow('maintenance busy');
        expect(await countReceipts(customer)).toBe(0);
        await writer.exec('ROLLBACK'); peerOpen = false;
        await customer.db.transaction(async tx => {
          await acquireCustomerProductCatalogLock(txClient(tx), 'category', [1]); await tx.execute(sql.raw(receiptSql()));
        }, { isolationLevel: 'read committed', accessMode: 'read write' });
        expect(await countReceipts(customer)).toBe(1);
        expect(Number((await writer.exec('SELECT count(*) AS count FROM category WHERE id=999'))[0].count)).toBe(0);
        console.info('CUSTOMER_PRODUCT_REVERSE_FENCE ' + JSON.stringify({ customer: { role: customer.role, pid: customer.pid }, writer: { role: writer.role, pid: writer.pid }, lockCode: '55P03', maintenanceRefused: true, releasedCallerCommitted: true }));
      } finally { if (peerOpen) await writer.exec('ROLLBACK'); }
    })));
  }, 60000);

  it('requires root maintenance and caller RW READ COMMITTED while leaving an absent protocol uncommissioned', async () => {
    await withFixture(async f => f.app(async peer => {
      expect((await customerProductOperationReadiness(peer.db)).ready).toBe(false);
      expect((await inspectCustomerProductOperation(peer.db)).present).toBe(false);
      await expect(acquireCustomerProductCatalogLock(peer.db, 'category', [1])).rejects.toThrow('caller-owned transaction');
      await peer.db.transaction(async tx => {
        await expect(runCustomerProductOperation(txClient(tx))).rejects.toThrow('root maintenance');
        await expect(installCustomerProductCatalogLock(txClient(tx), f.catalogOwner)).rejects.toThrow('root maintenance');
      });
      for (const settings of [{ isolationLevel: 'repeatable read', accessMode: 'read write' }, { isolationLevel: 'read committed', accessMode: 'read only' }] as const) {
        await rejectsCode(peer.db.transaction(tx => acquireCustomerProductCatalogLock(txClient(tx), 'category', [1]), settings), '25000');
        await rejectsCode(f.db.transaction(tx => tx.execute(sql.raw(CUSTOMER_PRODUCT_OPERATION_INSTALLATION_SQL)), settings), 'P0001');
        await rejectsCode(f.db.transaction(async tx => {
          await tx.execute(sql`SELECT set_config(${CUSTOMER_PRODUCT_CATALOG_OWNER_SETTING},${f.catalogOwner},true)`);
          await tx.execute(sql.raw(customerProductCatalogLockInstallationSql()));
        }, settings), 'P0001');
      }
      // An ordinary LOGIN root handle still lacks maintenance CREATE. The root
      // handle requirement is not a privileged connection fallback.
      await rejectsCode(runCustomerProductOperation(peer.db), '42501');
      expect((await inspectCustomerProductOperation(peer.db)).present).toBe(false);
      expect((await customerProductCatalogLockReadiness(peer.db)).ready).toBe(true);
    }), false);
  }, 60000);
});
