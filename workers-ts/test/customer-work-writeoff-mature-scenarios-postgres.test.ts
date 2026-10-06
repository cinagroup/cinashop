import { describe, expect, it } from 'vitest';
import { SQL } from 'drizzle-orm';
import { IndexedColumn, PgDialect, getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import {
  deliveryService, expressCompany, memberRight, orderWaybillJob,
  storeBranchProduct, storeBranchProductAttrValue, storeConfig, storeCouponIssue,
  storeOrder, storeOrderCartInfo, storeOrderInvoice, storeOrderOutbox,
  storeOrderPromotions, storeOrderRefund, storeOrderStatus, storeOrderWriteoff,
  storePink, storeProduct, storeProductAttr, storeProductAttrResult,
  storeProductAttrValue, storeProductRelation, storeProductRule,
  storeProductStockRecord, storeProductVirtual, storeService, storeServiceRecord,
  supplierFlowingWater, systemConfig, systemLog, systemStore, systemStoreStaff,
  systemUserLevel, user, userBill, userBrokerage, userLevel,
} from '../src/models/schema';
import {
  financePostgres, ownsFinanceFixtureEndpoint, validateFinanceFixtureUrl,
} from './helpers/financePostgres';
import {
  runSecondCardProductPostgresScenario, runStoreOrderWriteoffPostgresScenario,
  type SecondCardProductPostgresReport, type StoreOrderWriteoffPostgresReport,
} from './integration/StoreOrderWriteoffPostgresScenario';
import { runSecondCardValidityPostgresScenario } from './integration/SecondCardValidityPostgresScenario';
import {
  runStoreMobileOrderCompatibilityScenario, type StoreMobileOrderScenarioReport,
} from './integration/StoreMobileOrderCompatibilityScenario';

// These are real ORM definitions, including serial/default/type information.
// Each original scenario still owns its complete private-schema setup, SQL,
// service calls, assertions, public fingerprint and schema cleanup.
const TABLES: PgTable[] = [
  user, systemStore, systemStoreStaff, deliveryService, storeOrder,
  storeOrderCartInfo, storeOrderRefund, storeOrderWriteoff, storeOrderOutbox,
  storePink, storeOrderStatus, supplierFlowingWater, storeProduct,
  storeProductRelation, storeProductRule, storeProductAttr, storeProductAttrResult,
  storeProductAttrValue, systemLog, storeBranchProduct,
  storeBranchProductAttrValue, storeProductVirtual, storeService,
  storeServiceRecord, storeOrderInvoice, storeOrderPromotions, storeCouponIssue,
  storeConfig, systemConfig, expressCompany, orderWaybillJob, memberRight,
  userBill, userBrokerage, systemUserLevel, userLevel, storeProductStockRecord,
];
const NAMES = TABLES.map(table => getTableConfig(table).name);
const dialect = new PgDialect();

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw Error('Unsafe mature scenario fixture identifier');
  }
  return `"${value}"`;
}

function indexExpression(expression: SQL): string {
  const query = dialect.sqlToQuery(expression.inlineParams(), 'indexes');
  if (query.params.length) throw Error('Unbound ORM fixture index expression');
  return query.sql;
}

/** financePostgres creates the real columns/serial PKs. Install the declared
 * secondary indexes too, so INCLUDING ALL and ON CONFLICT retain actual keys.
 * This DDL is allowed only after verifying this process's fresh owned target. */
async function installIndexes(f: Awaited<ReturnType<typeof financePostgres>>) {
  expect(new Set(NAMES).size).toBe(TABLES.length);
  for (const table of TABLES) {
    const definition = getTableConfig(table);
    expect(definition.schema ?? 'public').toBe('public');
    for (const index of definition.indexes) {
      const config = index.config;
      if (config.concurrently || config.only || config.with) {
        throw Error('Unsupported ORM mature fixture index options');
      }
      const columns = config.columns.map(column => {
        if (column instanceof SQL) return indexExpression(column);
        if (!(column instanceof IndexedColumn)) {
          throw Error('Missing ORM mature fixture index column');
        }
        const options = column.indexConfig;
        if (options.order && options.order !== 'asc' && options.order !== 'desc') {
          throw Error('Unexpected ORM index order');
        }
        if (options.nulls && options.nulls !== 'first' && options.nulls !== 'last') {
          throw Error('Unexpected ORM index null order');
        }
        return identifier(column.name)
          + (options.opClass ? ` ${identifier(options.opClass)}` : '')
          + (options.order ? ` ${options.order}` : '')
          + (options.nulls ? ` NULLS ${options.nulls}` : '');
      });
      if (!columns.length) throw Error('Empty ORM fixture index');
      await f.exec(`CREATE ${config.unique ? 'UNIQUE ' : ''}INDEX ${identifier(config.name)} `
        + `ON public.${identifier(definition.name)} USING ${identifier(config.method ?? 'btree')} `
        + `(${columns.join(',')})${config.where ? ` WHERE ${indexExpression(config.where)}` : ''}`);
    }
  }
}

// In addition to the unchanged original scenario guards, cover every public
// fixture table and sequence, including an accidentally unqualified new audit
// dependency. A missing private clone must fail, not silently write public.
async function publicFingerprint(f: Awaited<ReturnType<typeof financePostgres>>) {
  const tables: Record<string, unknown> = {};
  for (const name of NAMES) {
    const rows = await f.db.$client.unsafe(`SELECT count(*)::text AS count,
      md5(COALESCE(sum(hashtextextended(to_jsonb(source)::text,0)::numeric)::text,'')) AS digest
      FROM public.${identifier(name)} AS source`);
    expect(rows).toHaveLength(1);
    tables[name] = rows[0];
  }
  const sequences = await f.db.$client`SELECT sequencename,last_value::text
    FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`;
  const schemas = await f.db.$client`SELECT nspname FROM pg_namespace
    WHERE starts_with(nspname,'codex_writeoff_it_')
       OR starts_with(nspname,'codex_second_card_validity_')
       OR starts_with(nspname,'codex_store_mobile_order_') ORDER BY nspname`;
  return { tables, sequences: [...sequences], schemas: [...schemas] };
}

async function ownedScenario<R>(name: string, run: (url: string) => Promise<R>, verify: (report: R) => void) {
  const value = process.env.TEST_FINANCE_POSTGRES_URL;
  if (!value) throw Error('Registered local native PostgreSQL16 is required');
  const base = validateFinanceFixtureUrl(value);
  const f = await financePostgres(TABLES, { namespace: 'public' });
  try {
    const [identity] = await f.db.$client<Array<{
      database: string; role: string; session_role: string; schema: string;
      version: number; host: string; port: number;
    }>>`SELECT current_database() AS database,current_user AS role,
      session_user AS session_role,current_schema() AS schema,
      current_setting('server_version_num')::integer AS version,
      host(inet_server_addr()) AS host,inet_server_port() AS port`;
    expect(identity).toBeDefined();
    expect(identity.role).toBe('finance_test');
    expect(identity.session_role).toBe('finance_test');
    expect(identity.schema).toBe('public');
    expect(Math.floor(identity.version / 10000)).toBe(16);
    expect(ownsFinanceFixtureEndpoint(identity.database, 'public', base.href, identity.host, identity.port)).toBe(true);
    const target = new URL(base.href);
    target.pathname = `/${identity.database}`;
    expect(target.hostname).toBe(base.hostname);
    expect(target.port).toBe(base.port);
    expect(target.username).toBe(base.username);
    expect(target.password).toBe(base.password);
    await installIndexes(f);
    const before = await publicFingerprint(f);
    let report: R;
    try {
      // Never use or print the coordinator URL as the scenario target.
      report = await run(target.href);
    } finally {
      expect(await publicFingerprint(f)).toEqual(before);
    }
    verify(report);
    console.info(`MATURE_SCENARIO_REPORT ${name} ${JSON.stringify(report)}`);
  } finally {
    // The registered fixture helper confirms exact database deletion; it never
    // disconnects unrelated clients or drops a guessed database/schema.
    await f.close();
  }
}

function secondCard(report: StoreOrderWriteoffPostgresReport['second_card']) {
  for (const name of [
    'product_created', 'product_updated', 'single_sku_persisted',
    'pickup_policy_persisted', 'validity_activated_at_payment',
    'partial_writeoff_verified', 'repeated_code_rejected', 'completed_writeoff_verified',
    'expired_rejected', 'unauthorized_store_rejected', 'unused_refund_allowed',
    'consumed_refund_rejected', 'reminder_staged', 'reminder_replay_idempotent',
    'reminder_queue_payload_opaque',
  ] as const) expect(report[name]).toBe(true);
  expect(report.immutable_writeoff_rows).toBe(2);
}

function completeReport(report: SecondCardProductPostgresReport | StoreOrderWriteoffPostgresReport | StoreMobileOrderScenarioReport) {
  expect(report.server_version).toMatch(/^16(?:\.|$)/);
  expect(report.schema_created).toBe(true);
  expect(report.schema_removed).toBe(true);
  expect(report.public_state_unchanged).toBe(true);
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('complete mature writeoff PostgreSQL scenarios', () => {
  it('runs the complete pickup/delivery/concurrency/refund/second-card writeoff scenario', async () => {
    await ownedScenario('runStoreOrderWriteoffPostgresScenario', runStoreOrderWriteoffPostgresScenario, report => {
      completeReport(report);
      expect(report.pickup).toEqual({ preview_masked: true, partial_status: 5, code_rotated: true,
        completed_status: 2, writeoff_rows: 2, staff_recorded: true });
      expect(report.delivery).toEqual({ wrong_actor_rejected: true, completed_status: 2,
        delivery_recorded: true, immutable_row_staff_id: 0 });
      expect(report.concurrency).toEqual({ successes: 1, rejections: 1, writeoff_rows: 1, completed_status: 2 });
      expect(report.receipt_guard).toEqual({ delivery_rejected: true, pickup_rejected: true, express_completed: true });
      expect(report.identity_guards).toEqual({ staff_conflict_reported: true, staff_conflict_rejected: true,
        delivery_conflict_reported: true, delivery_conflict_rejected: true });
      expect(report.pink_guard).toEqual({ unformed_rejected: true, completed_after_formed: true, completed_status: 2 });
      expect(report.refund_race.successes).toBe(1);
      expect(report.refund_race.rejections).toBe(1);
      expect(report.refund_race.loser_business_rejected).toBe(true);
      expect(['refund', 'writeoff']).toContain(report.refund_race.winner);
      expect(report.refund_race.refund_rows).toBe(report.refund_race.winner === 'refund' ? 1 : 0);
      expect(report.refund_race.writeoff_rows).toBe(report.refund_race.winner === 'writeoff' ? 1 : 0);
      secondCard(report.second_card);
    });
  }, 180000);

  it('runs the complete second-card product create/edit/payment/writeoff/refund/reminder scenario', async () => {
    await ownedScenario('runSecondCardProductPostgresScenario', runSecondCardProductPostgresScenario, report => {
      completeReport(report);
      secondCard(report.second_card);
    });
  }, 180000);

  it('runs the complete second-card validity payment/replay/unpaid rejection scenario', async () => {
    await ownedScenario('runSecondCardValidityPostgresScenario', runSecondCardValidityPostgresScenario, report => {
      expect(report).toBeDefined();
      expect(report?.first_matched).toBe(3);
      expect(report?.first_changed).toBe(1);
      expect(report?.replay_changed).toBe(0);
      for (const field of ['purchase_days_started_at_payment', 'fixed_window_preserved',
        'unlimited_window_preserved', 'physical_line_ignored', 'replay_did_not_drift',
        'unpaid_order_rejected', 'cleanup_succeeded', 'temporary_schema_count_unchanged',
        'public_state_unchanged'] as const) expect(report?.[field]).toBe(true);
      expect(report?.production).toBeDefined();
    });
  }, 180000);

  it('runs every mobile-order compatibility assertion and original public/schema guards', async () => {
    await ownedScenario('runStoreMobileOrderCompatibilityScenario', runStoreMobileOrderCompatibilityScenario, report => {
      completeReport(report);
      expect(report.temporary_schemas_after).toBe(report.temporary_schemas_before);
      expect(report.assertions.total).toBe(13);
      expect(report.assertions.passed).toBe(report.assertions.total);
      const assertions = Object.entries(report.assertions).filter(([field]) => !['total', 'passed'].includes(field));
      expect(assertions).toHaveLength(report.assertions.total);
      for (const [, passed] of assertions) expect(passed).toBe(true);
      expect(report.guarantees).toEqual({ isolated_schema_ddl_and_fixture_dml_executed: true,
        public_schema_ddl_or_dml_executed: false, public_business_rows_or_sequences_changed: false,
        production_reads_are_bounded_aggregates: true, single_flight_advisory_lock: true,
        fingerprints_returned: false, business_ids_returned: false });
    });
  }, 180000);
});
