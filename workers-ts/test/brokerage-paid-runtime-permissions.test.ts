import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import * as models from '../src/models/schema';
import { runBrokeragePaidOrderFence } from '../src/migrations/runBrokeragePaidOrderFence';
import { auditCheckoutRuntimePermissions, auditPaidOrderRuntimePermissions } from '../src/migrations/auditPaidOrderRuntimePermissions';
import { inspectCheckoutPricingLock, installCheckoutPricingLock } from '../src/migrations/checkoutPricingLock';
import { applyStoreOrderPayment, applyStoreOrderBalancePayment } from '../src/services/order/StoreOrderPayService';
import { applyOrderRefund, finalizeStoreOrderRefund } from '../src/services/order/StoreOrderRefundService';
import { assertCheckoutPaidOrderQualifications } from '../src/services/order/CheckoutPaidOrderAuthority';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

const exec = promisify(execFile);
const CLI_TIMEOUT_MS = 15_000;
// Each case starts several sequential CLI processes. Keep their individual
// deadlines, but let the case finish its bounded calls and fixture cleanup.
const cliCaseTimeout = (calls: number) => calls * CLI_TIMEOUT_MS + 10_000;
const cli = (connectionString?: string, args: string[] = []) => exec(process.execPath,
  ['node_modules/tsx/dist/cli.mjs', 'scripts/audit-paid-runtime-permissions.ts', ...args], {
    cwd: process.cwd(), timeout: CLI_TIMEOUT_MS,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP,
      // Wrangler augments ProcessEnv with these non-secret app variables.
      // Pass only that narrow set, never DATABASE_URL or host credentials.
      NODE_ENV: process.env.NODE_ENV, INTERNAL_API_URL: process.env.INTERNAL_API_URL, ORDER_DLQ_NAME: process.env.ORDER_DLQ_NAME,
      OUT_API_LOGIN_LIMIT_PER_MINUTE: process.env.OUT_API_LOGIN_LIMIT_PER_MINUTE,
      OUT_API_REFRESH_LIMIT_PER_MINUTE: process.env.OUT_API_REFRESH_LIMIT_PER_MINUTE,
      OUT_API_READ_LIMIT_PER_MINUTE: process.env.OUT_API_READ_LIMIT_PER_MINUTE,
      OUT_API_WRITE_LIMIT_PER_MINUTE: process.env.OUT_API_WRITE_LIMIT_PER_MINUTE,
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS, PC_AUTH_ALLOWED_ORIGINS: process.env.PC_AUTH_ALLOWED_ORIGINS,
      OFFLINE_PC_RETURN_ORIGIN: process.env.OFFLINE_PC_RETURN_ORIGIN, OFFLINE_H5_RETURN_ORIGIN: process.env.OFFLINE_H5_RETURN_ORIGIN,
      AUTH_ALLOWED_ORIGINS: process.env.AUTH_ALLOWED_ORIGINS, KEFU_AUTH_ALLOWED_ORIGINS: process.env.KEFU_AUTH_ALLOWED_ORIGINS,
      PAID_RUNTIME_AUDIT_DATABASE_URL: connectionString },
  });

it('rejects non-root and unsafe schema permission-audit calls before SQL', async () => {
  await expect(auditPaidOrderRuntimePermissions({ transaction: (() => { throw new Error('SQL reached'); }) }))
    .rejects.toThrow('root database');
  for (const schema of ['public;drop schema public', 'pg_catalog', 'information_schema', 'public,pg_temp']) {
    await expect(auditPaidOrderRuntimePermissions({ $client: {} } as DbClient, schema)).rejects.toThrow('Invalid runtime');
  }
});

it('CLI refuses missing or unauthorized remote target before opening a connection', async () => {
  for (const url of [undefined, 'postgresql://invalid@not-a-real-host.invalid/example']) {
    await expect(cli(url)).rejects.toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('No database was contacted') });
  }
}, cliCaseTimeout(2));

it('CLI validates its explicit checkout scope before any connection attempt', async () => {
  for (const args of [['--checkout'], ['--unknown'], ['--checkout', '--checkout']]) {
    await expect(cli(undefined, args)).rejects.toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('No database was contacted') });
  }
}, cliCaseTimeout(3));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('paid-order fence runtime identity and least-privilege preflight', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  const pendingRuntimeWork = new Set<Promise<unknown>>();
  type Runtime = SequenceRunnerPeer & { role: string; connectionString: string };
  const tables = ['user', 'user_bill', 'user_brokerage', 'store_order', 'store_order_cart_info', 'store_order_invoice',
    'store_order_outbox', 'store_order_status', 'store_order_refund', 'store_order_refund_payment', 'store_product',
    'store_product_attr_value', 'store_pink', 'store_combination'];
  async function grant(peer: Runtime) {
    await f.exec(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${tables.map(name => `public."${name}"`).join(',')} TO "${peer.role}";
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO "${peer.role}"`);
  }
  const run = <T>(callback: (peer: Runtime) => Promise<T>) => {
    if (!f.withRuntimeRole) throw new Error('Real runtime login required');
    const task = f.withRuntimeRole(async peer => { await grant(peer); return callback(peer); });
    pendingRuntimeWork.add(task);
    void task.then(() => pendingRuntimeWork.delete(task), () => pendingRuntimeWork.delete(task));
    return task;
  };
  const withPricing = async <T>(peer: Runtime, callback: (owner: string) => Promise<T>) => {
    const owner = `cinashop_runtime_${randomUUID().replaceAll('-', '')}`;
    await f.exec(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    try {
      await installCheckoutPricingLock(f.db, owner);
      await f.exec(`GRANT SELECT ON member_right,system_config TO "${peer.role}";
        GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO "${peer.role}"`);
      return await callback(owner);
    } finally {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(owner)) throw Error('Unsafe owned pricing test role');
      await f.exec(`DROP OWNED BY "${owner}"; DROP ROLE "${owner}"`);
      expect((await f.query(`SELECT oid FROM pg_roles WHERE rolname='${owner}'`)).rows).toEqual([]);
    }
  };
  const snapshot = () => f.query(`SELECT jsonb_build_object(
    'users',(SELECT jsonb_agg(to_jsonb(u) ORDER BY uid) FROM "user" u),
    'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM store_order o),
    'bills',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM user_bill b),
    'outbox',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM store_order_outbox o)) AS state`);
  beforeEach(async () => {
    f = await sequenceRunnerDatabase();
    const api = await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
    await runBrokeragePaidOrderFence(f.db);
    await f.db.insert(models.user).values({ uid: 11, account: 'isolated-runtime', nowMoney: '100.00' });
    await f.db.insert(models.storeProduct).values({ id: 70, stock: 8, sales: 2 });
    await f.db.insert(models.storeProductAttrValue).values({ id: 1, productId: 70, unique: 'role0001', stock: 8, sales: 2 });
    await f.db.insert(models.storeOrder).values({ id: 501, uid: 11, orderId: 'runtime-501', unique: 'runtime-key', totalNum: 2,
      payPrice: '20.00', totalPrice: '20.00' });
    await f.db.insert(models.storeOrderCartInfo).values({ id: 701, oid: 501, uid: 11, productId: 70, cartId: '701',
      cartNum: 2, unique: 'runtime-cart', skuUnique: 'role0001', cartInfo: JSON.stringify({ sku: { id: 1 }, sum_true_price: '20.00' }) });
  }, 30_000);
  afterEach(async () => {
    // Vitest timeout does not cancel an async body. Let its bounded CLI calls
    // and role-finally handlers settle before dropping their database.
    await Promise.allSettled([...pendingRuntimeWork]);
    await f?.close();
  }, cliCaseTimeout(4));

  it('uses a real non-owner login for readonly audit, qualification, balance payment and full refund', async () => {
    await run(async peer => {
      const before = await snapshot();
      const settings = await peer.exec("SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle");
      const observed = new Proxy(peer.db, { get(target, key, receiver) {
        if (key === 'transaction') return ((callback, config) => target.transaction(async tx => {
          expect(config).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
          const result = await callback(tx);
          const rows = await tx.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,
            current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock`);
          expect(Array.from(rows)).toEqual([{ readonly: 'on', statement: '5s', lock: '1s' }]);
          return result;
        }, config)) satisfies DbClient['transaction'];
        return Reflect.get(target, key, receiver);
      } });
      expect(await auditPaidOrderRuntimePermissions(observed)).toMatchObject({ ready: true, failures: [] });
      expect(await snapshot()).toEqual(before);
      expect(await peer.exec("SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle")).toEqual(settings);
      const c = createContainerFromDb(peer.db);
      expect(await applyStoreOrderBalancePayment(c, { uid: 11, orderId: 'runtime-501' })).toMatchObject({ outcome: 'paid' });
      await peer.db.transaction(async tx => {
        await tx.execute(sql`UPDATE store_order SET remark=remark WHERE id=501`);
        await tx.execute(sql`SELECT uid FROM "user" WHERE uid=11 FOR SHARE`);
        await assertCheckoutPaidOrderQualifications(tx, [{ uid: 11, thresholdCents: 1000, eligible: true }]);
      });
      const { refundId } = await applyOrderRefund(c, { uid: 11, orderId: 'runtime-501', refundReason: 'isolated',
        refundExplain: '', applyType: 1, applicationOrderId: 'runtime-refund' });
      expect(await finalizeStoreOrderRefund(c, refundId)).toBe('completed');
      expect(await finalizeStoreOrderRefund(c, refundId)).toBe('already-completed');
      expect((await f.db.select().from(models.user))[0].nowMoney).toBe('100.00');
      expect((await f.db.select().from(models.storeOrder))[0]).toMatchObject({ paid: 1, refundStatus: 2 });
      expect((await f.db.select().from(models.storeProduct))[0].stock).toBe(10);
    });
  });

  it('requires a user UPDATE privilege for the invoker trigger even when provider payment does not debit balance', async () => {
    await run(async peer => {
      await f.exec(`REVOKE UPDATE ON "user" FROM "${peer.role}"`);
      expect((await auditPaidOrderRuntimePermissions(peer.db)).failures).toContain('protocolReadWritePrivileges');
      const before = await snapshot();
      await expect(applyStoreOrderPayment(createContainerFromDb(peer.db), { orderId: 501, payType: 'weixin', tradeNo: 'synthetic' }))
        .rejects.toMatchObject({ cause: { code: '42501' } });
      expect(await snapshot()).toEqual(before);
      // PostgreSQL row locking needs UPDATE on at least one user column, not
      // ownership or SECURITY DEFINER. This is not a complete app GRANT recipe.
      await f.exec(`GRANT UPDATE(now_money) ON "user" TO "${peer.role}"`);
      expect((await auditPaidOrderRuntimePermissions(peer.db)).ready).toBe(true);
      expect(await applyStoreOrderPayment(createContainerFromDb(peer.db), { orderId: 501, payType: 'weixin', tradeNo: 'synthetic' }))
        .toMatchObject({ outcome: 'paid' });
    });
  });

  it('holds an independently authenticated writer until the runtime reader commits', async () => {
    await run(async reader => run(async payer => {
      const [observer] = await f.db.select({ pid: sql<number>`pg_backend_pid()` }).from(sql`(values(1)) v(n)`);
      expect(new Set([reader.pid, payer.pid, observer.pid]).size).toBe(3);
      // Zero-row UPDATE obtains the required relation lock without holding the
      // payer's order row. The observed wait must reach the user write fence.
      await reader.exec('BEGIN; UPDATE store_order SET remark=remark WHERE id=-1; SELECT uid FROM "user" WHERE uid=11 FOR SHARE');
      const txView: Pick<DbClient, 'select'> = { select: reader.db.select.bind(reader.db) };
      await assertCheckoutPaidOrderQualifications(txView, [{ uid: 11, thresholdCents: 1000, eligible: false }]);
      const paying = outcome(applyStoreOrderPayment(createContainerFromDb(payer.db), { orderId: 501, payType: 'weixin', tradeNo: 'synthetic' }));
      await waitForFinanceBlock(f.db, payer.pid, reader.pid);
      await assertCheckoutPaidOrderQualifications(txView, [{ uid: 11, thresholdCents: 1000, eligible: false }]);
      await reader.exec('COMMIT');
      expect(await paying).toMatchObject({ ok: true, value: { outcome: 'paid' } });
    }));
  });

  it('CLI returns exit zero for the approved permission envelope and exit one for an elevated runtime login', async () => {
    await run(async peer => {
      const before = await snapshot();
      const result = await cli(peer.connectionString);
      expect(JSON.parse(result.stdout)).toMatchObject({ ready: true, failures: [] });
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain(peer.role);
      await f.exec(`ALTER ROLE "${peer.role}" CREATEDB`);
      await expect(cli(peer.connectionString)).rejects.toMatchObject({ code: 1,
        stdout: expect.stringContaining('"ready":false'), stderr: '' });
      expect(await snapshot()).toEqual(before);
    });
  }, cliCaseTimeout(2));

  it('denies destructive trigger/function/table operations and replication bypass to the runtime login', async () => {
    await run(async peer => {
      const before = await snapshot();
      for (const statement of [
        'ALTER TABLE store_order DISABLE TRIGGER brokerage_paid_update_0150',
        'DROP TRIGGER brokerage_paid_update_0150 ON store_order',
        'DROP FUNCTION brokerage_paid_order_fence_0150() CASCADE',
        "CREATE OR REPLACE FUNCTION brokerage_paid_order_fence_0150() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$",
        'TRUNCATE store_order',
        "SET session_replication_role='replica'",
        'CREATE SCHEMA runtime_shadow',
        'CREATE TABLE public.runtime_shadow(id integer)',
      ]) await expect(peer.exec(statement)).rejects.toMatchObject({ code: '42501' });
      expect(await snapshot()).toEqual(before);
      expect((await auditPaidOrderRuntimePermissions(peer.db)).ready).toBe(true);
      expect(await applyStoreOrderPayment(createContainerFromDb(peer.db), { orderId: 501, payType: 'weixin', tradeNo: 'synthetic' }))
        .toMatchObject({ outcome: 'paid' });
    });
  });

  it('does not mistake superuser SET ROLE for a safe connection identity', async () => {
    await run(async runtime => {
      expect((await auditPaidOrderRuntimePermissions(runtime.db)).ready).toBe(true);
      expect((await auditPaidOrderRuntimePermissions(f.db)).failures).toContain('unprivilegedReachableRoles');
      await f.withPeer!(async peer => {
        await peer.exec(`SET ROLE "${runtime.role}"`);
        try {
          const result = await auditPaidOrderRuntimePermissions(peer.db);
          expect(result.failures).toEqual(expect.arrayContaining(['unprivilegedReachableRoles', 'noOwnerControl']));
        } finally { await peer.exec('RESET ROLE'); }
      });
    });
  });

  it('rejects a superuser disguised by session authorization', async () => {
    await run(async runtime => {
      await f.withPeer!(async maintenance => {
        await maintenance.exec(`SET SESSION AUTHORIZATION "${runtime.role}"`);
        try {
          const identities = await maintenance.exec('SELECT current_user,session_user,usename FROM pg_stat_activity WHERE pid=pg_backend_pid()');
          expect(identities).toEqual([{ current_user: runtime.role, session_user: runtime.role, usename: 'finance_test' }]);
          const result = await auditPaidOrderRuntimePermissions(maintenance.db);
          expect(result.ready).toBe(false);
          expect(result.failures).toEqual(expect.arrayContaining(['unprivilegedReachableRoles', 'noOwnerControl']));
        } finally { await maintenance.exec('RESET SESSION AUTHORIZATION'); }
      });
    });
  });

  it.each(['CREATEDB', 'CREATEROLE', 'REPLICATION', 'BYPASSRLS'])('flags the elevated %s role attribute', async attribute => {
    await run(async peer => {
      await f.exec(`ALTER ROLE "${peer.role}" ${attribute}`);
      expect((await auditPaidOrderRuntimePermissions(peer.db)).failures).toContain('unprivilegedReachableRoles');
    });
  });

  it.each([
    ['TRIGGER', 'noTriggerCreation'], ['TRUNCATE', 'noTruncate'],
  ])('flags an explicit order %s grant', async (privilege, failure) => {
    await run(async peer => {
      await f.exec(`GRANT ${privilege} ON store_order TO "${peer.role}"`);
      expect((await auditPaidOrderRuntimePermissions(peer.db)).failures).toContain(failure);
    });
  });

  it('flags schema CREATE and session_replication_role SET grants, not just role attributes', async () => {
    await run(async peer => {
      await f.exec(`GRANT CREATE ON SCHEMA public TO "${peer.role}"; GRANT SET ON PARAMETER session_replication_role TO "${peer.role}"`);
      expect((await auditPaidOrderRuntimePermissions(peer.db)).failures).toEqual(expect.arrayContaining(['noSchemaCreation', 'noReplicationBypass']));
      await peer.exec("SET session_replication_role='replica'");
      expect((await auditPaidOrderRuntimePermissions(peer.db)).checks.noReplicationBypass).toBe(false);
      await peer.exec("SET session_replication_role='origin'");
    });
  });

  it.each(['set', 'admin'] as const)('detects indirect owner control through %s-only membership', async mode => {
    await run(async peer => f.withRuntimeRole!(async owner => {
      await f.exec(`GRANT CREATE ON SCHEMA public TO "${owner.role}";
        ALTER FUNCTION brokerage_paid_order_fence_0150() OWNER TO "${owner.role}";
        GRANT "${owner.role}" TO "${peer.role}" WITH INHERIT FALSE;
        ${mode === 'admin' ? `GRANT "${owner.role}" TO "${peer.role}" WITH SET FALSE; GRANT "${owner.role}" TO "${peer.role}" WITH ADMIN TRUE;` : ''}`);
      try {
        expect((await auditPaidOrderRuntimePermissions(peer.db)).failures).toContain('noOwnerControl');
      } finally { await f.exec('ALTER FUNCTION brokerage_paid_order_fence_0150() OWNER TO finance_test'); }
    }));
  });

  it('requires manual review of callable user SECURITY DEFINER routines, including PUBLIC execute', async () => {
    await run(async peer => {
      await f.exec('CREATE FUNCTION public.permission_review_probe() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$SELECT 1$$');
      expect((await auditPaidOrderRuntimePermissions(peer.db)).failures).toContain('noUnreviewedDefinerRoutine');
      await f.exec('REVOKE ALL ON FUNCTION public.permission_review_probe() FROM PUBLIC');
      expect((await auditPaidOrderRuntimePermissions(peer.db)).ready).toBe(true);
    });
  });

  it('reviews definer routines in pgx-prefixed ordinary schemas rather than treating LIKE underscore as literal', async () => {
    await run(async peer => {
      await f.exec(`CREATE SCHEMA pgx_review; GRANT USAGE ON SCHEMA pgx_review TO "${peer.role}";
        CREATE FUNCTION pgx_review.permission_review_probe() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$SELECT 1$$`);
      const result = await auditPaidOrderRuntimePermissions(peer.db);
      expect(result.ready).toBe(false);
      expect(result.failures).toContain('noUnreviewedDefinerRoutine');
      await f.exec('REVOKE ALL ON FUNCTION pgx_review.permission_review_probe() FROM PUBLIC');
      expect((await auditPaidOrderRuntimePermissions(peer.db)).ready).toBe(true);
    });
  });

  it('returns not-ready on absent fence objects without creating or repairing them', async () => {
    await run(async peer => {
      await f.exec('DROP FUNCTION brokerage_paid_order_fence_0150() CASCADE');
      expect((await auditPaidOrderRuntimePermissions(peer.db)).checks.objectsPresent).toBe(false);
      expect((await f.query("SELECT to_regprocedure('brokerage_paid_order_fence_0150()') AS function")).rows).toEqual([{ function: null }]);
    });
  });

  it('cleans a created login and its grants when the callback fails', async () => {
    let created = '';
    const failure = new Error('intentional runtime callback failure');
    await expect(run(async peer => { created = peer.role; throw failure; })).rejects.toBe(failure);
    expect(created).toMatch(/^cinashop_runtime_[a-f0-9]{32}$/);
    const rows = await f.db.select({ oid: sql<number>`oid` }).from(sql`pg_roles`).where(sql`rolname=${created}`);
    expect(rows).toEqual([]);
  });

  it('keeps the paid-only scope separate and fails checkout closed when the pricing protocol is absent', async () => {
    await run(async peer => {
      expect((await auditPaidOrderRuntimePermissions(peer.db)).ready).toBe(true);
      const result = await auditCheckoutRuntimePermissions(peer.db);
      expect(result.ready).toBe(false);
      expect(result.failures).toEqual(expect.arrayContaining(['checkoutPricingCatalog', 'checkoutPricingPrivileges']));
      expect((await inspectCheckoutPricingLock(f.db)).absent).toBe(true);
    });
  });

  it('recognizes only the exact safe pricing capability without executing it, granting or changing business data', async () => {
    await run(async peer => withPricing(peer, async () => {
      const before = await snapshot(), catalog = await inspectCheckoutPricingLock(f.db);
      const observed = new Proxy(peer.db, { get(target, key, receiver) {
        if (key === 'transaction') return ((callback, config) => target.transaction(async tx => {
          expect(config).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
          const result = await callback(tx);
          const [locks] = await tx.execute(sql`SELECT count(*)::integer AS count FROM pg_locks
            WHERE pid=pg_backend_pid() AND mode IN ('ShareLock','AccessExclusiveLock') AND locktype='relation'`);
          expect(locks?.count).toBe(0);
          return result;
        }, config)) satisfies DbClient['transaction'];
        return Reflect.get(target, key, receiver);
      } });
      expect(await auditPaidOrderRuntimePermissions(observed)).toMatchObject({ ready: true, failures: [] });
      expect(await auditCheckoutRuntimePermissions(observed)).toMatchObject({ ready: true, failures: [], checks: {
        noUnreviewedDefinerRoutine: true, checkoutPricingCatalog: true, checkoutPricingCaller: true,
        checkoutPricingPrivileges: true, checkoutPricingDefinerReview: true,
      } });
      expect(await snapshot()).toEqual(before);
      expect(await inspectCheckoutPricingLock(f.db)).toEqual(catalog);
      const output = JSON.stringify(await auditCheckoutRuntimePermissions(peer.db));
      expect(output).not.toContain(peer.role); expect(output).not.toContain(catalog.functionOid);
    }));
  });

  it.each([
    ['body', "CREATE OR REPLACE FUNCTION public.checkout_lock_pricing_v1() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'BEGIN NULL; END'"],
    ['invoker', 'ALTER FUNCTION public.checkout_lock_pricing_v1() SECURITY INVOKER'],
    ['path', 'ALTER FUNCTION public.checkout_lock_pricing_v1() SET search_path=public,pg_temp'],
    ['PUBLIC execute', 'GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO PUBLIC'],
    ['overload', "CREATE FUNCTION public.checkout_lock_pricing_v1(int) RETURNS void LANGUAGE plpgsql AS 'BEGIN NULL; END'"],
    ['RLS', 'ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY'],
  ])('does not turn the %s-drifted function name into a checkout permission whitelist', async (_kind, statement) => {
    await run(async peer => withPricing(peer, async () => {
      await f.exec(statement);
      const result = await auditCheckoutRuntimePermissions(peer.db);
      expect(result.ready).toBe(false); expect(result.failures).toContain('checkoutPricingCatalog');
      if (_kind !== 'invoker') expect(result.failures).toContain('noUnreviewedDefinerRoutine');
    }));
  });

  it.each(['config-write', 'no-execute', 'no-select', 'owner-login', 'owner-membership', 'execute-grant-option'] as const)
    ('rejects %s in the composed checkout permission envelope', async mode => {
      await run(async peer => withPricing(peer, async owner => {
        const mutation = {
          'config-write': `GRANT UPDATE(value) ON system_config TO "${peer.role}"`,
          'no-execute': `REVOKE EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() FROM "${peer.role}"`,
          'no-select': `REVOKE SELECT ON member_right FROM "${peer.role}"`,
          'owner-login': `ALTER ROLE "${owner}" LOGIN`,
          'owner-membership': `GRANT "${owner}" TO "${peer.role}" WITH INHERIT FALSE, SET FALSE`,
          'execute-grant-option': `GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO "${peer.role}" WITH GRANT OPTION`,
        }[mode];
        await f.exec(mutation);
        expect((await auditCheckoutRuntimePermissions(peer.db)).ready).toBe(false);
      }));
    });

  it('does not exempt a second callable definer or an identical function name in another schema', async () => {
    await run(async peer => withPricing(peer, async () => {
      await f.exec(`CREATE SCHEMA pgx_pricing;
        CREATE FUNCTION pgx_pricing.checkout_lock_pricing_v1() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN NULL; END'`);
      const result = await auditCheckoutRuntimePermissions(peer.db);
      expect(result.failures).toContain('noUnreviewedDefinerRoutine');
      expect(result.failures).toContain('checkoutPricingDefinerReview');
      await f.exec('REVOKE ALL ON FUNCTION pgx_pricing.checkout_lock_pricing_v1() FROM PUBLIC');
      expect((await auditCheckoutRuntimePermissions(peer.db)).ready).toBe(true);
    }));
  });

  it('conservatively includes mixed and disabled membership ancestry in both permission scopes', async () => {
    await run(async peer => f.withRuntimeRole!(async bridge => f.withRuntimeRole!(async ancestor => {
      await f.exec(`ALTER ROLE "${ancestor.role}" CREATEDB;
        GRANT "${ancestor.role}" TO "${bridge.role}" WITH INHERIT FALSE, SET FALSE;
        GRANT "${bridge.role}" TO "${peer.role}" WITH INHERIT FALSE, SET TRUE`);
      expect((await auditPaidOrderRuntimePermissions(peer.db)).failures).toContain('unprivilegedReachableRoles');
      expect((await auditCheckoutRuntimePermissions(peer.db)).failures).toContain('checkoutPricingCaller');
    })));
  });

  it('CLI checkout scope returns zero only with the reviewed installed protocol and preserves the paid-only scope', async () => {
    await run(async peer => {
      await expect(cli(peer.connectionString, ['--checkout'])).rejects.toMatchObject({ code: 1, stderr: '',
        stdout: expect.stringContaining('checkoutPricingCatalog') });
      await withPricing(peer, async () => {
        const result = await cli(peer.connectionString, ['--checkout']);
        expect(JSON.parse(result.stdout)).toMatchObject({ ready: true, failures: [] });
        expect(result.stderr).toBe(''); expect(result.stdout).not.toContain(peer.role);
        await f.exec(`REVOKE EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() FROM "${peer.role}"`);
        await expect(cli(peer.connectionString, ['--checkout'])).rejects.toMatchObject({ code: 1, stderr: '' });
        expect(JSON.parse((await cli(peer.connectionString)).stdout).ready).toBe(true);
      });
    });
  }, cliCaseTimeout(4));
});
