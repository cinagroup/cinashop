import { sql } from "drizzle-orm";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type DbClient,
  withTx,
} from "@/lib/di";

const CLONED_TABLES = [
  "user",
  "store_order",
  "store_order_cart_info",
  "store_order_status",
  "store_order_outbox",
  "system_supplier",
  "supplier_flowing_water",
  "supplier_transactions",
  "store_product_coupon",
] as const;

const LOCAL_SEQUENCE_TABLES = [
  "store_order",
  "store_order_cart_info",
  "store_order_status",
  "supplier_flowing_water",
  "supplier_transactions",
] as const;

const SCENARIOS = ["normal", "interruption", "expired_lease", "failure"] as const;
export type OrderPaidOutboxAuditScenario = (typeof SCENARIOS)[number];

interface PublicSnapshot {
  rows: Record<string, string>;
  sequences: Record<string, string | null>;
}

export interface AuditFixture {
  scenario: OrderPaidOutboxAuditScenario;
  outbox_id: number;
  order_id: number;
  order_no: string;
  event_key: string;
}

export interface AuditScenarioControl {
  scenario: OrderPaidOutboxAuditScenario;
  interrupt_first: boolean;
}

interface ScenarioStatus {
  scenario: OrderPaidOutboxAuditScenario;
  outbox_status: string;
  attempt_count: number;
  last_error: string;
  root_pid: number;
  pay_count: number;
  child_count: number;
  supplier_child_count: number;
  platform_child_count: number;
  flowing_rows: number;
  transaction_rows: number;
  status_rows: number;
  pay_success_rows: number;
  root_cart_split_rows: number;
  child_cart_rows: number;
}

interface DeliverySummary {
  scenario: OrderPaidOutboxAuditScenario;
  received: number;
  completed: number;
  already_completed: number;
  processor_failed: number;
  injected_interruption: number;
  queue_attempts: number[];
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Payment outbox Queue audit failed: ${message}`);
}

export function validateAuditSchemaName(value: string): string {
  if (!/^codex_outbox_queue_[a-z0-9_]{1,42}$/.test(value) || value.length > 63) {
    throw new Error("unsafe payment outbox audit schema name");
  }
  return value;
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

async function withAdminDb<T>(
  connectionString: string,
  fn: (db: DbClient) => Promise<T>,
): Promise<T> {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_outbox_queue_audit",
  });
  try {
    return await fn(db);
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

async function publicSnapshot(db: DbClient): Promise<PublicSnapshot> {
  const rows: Record<string, string> = {};
  const sequences: Record<string, string | null> = {};
  for (const table of CLONED_TABLES) {
    const result = await db.$client.unsafe<{ value: string }[]>(
      `SELECT count(*)::text AS value FROM public.${identifier(table)}`,
    );
    rows[table] = result[0]?.value ?? "missing";
    const column = table === "user" ? "uid" : "id";
    const sequenceRows = await db.$client<{ sequence_name: string | null }[]>`
      SELECT pg_get_serial_sequence(${`public.${table}`}, ${column}) AS sequence_name
    `;
    const sequenceName = sequenceRows[0]?.sequence_name?.split(".").at(-1) ?? null;
    if (!sequenceName) {
      sequences[table] = null;
      continue;
    }
    const valueRows = await db.$client<{ value: string | null }[]>`
      SELECT last_value::text AS value
      FROM pg_sequences
      WHERE schemaname = 'public' AND sequencename = ${sequenceName}
    `;
    sequences[table] = valueRows[0]?.value ?? null;
  }
  return { rows, sequences };
}

function snapshotsEqual(left: PublicSnapshot, right: PublicSnapshot): boolean {
  const delta = snapshotDelta(left, right);
  return Object.keys(delta.rows).length === 0 && Object.keys(delta.sequences).length === 0;
}

function snapshotDelta(left: PublicSnapshot, right: PublicSnapshot) {
  const rows: Record<string, { before: string; after: string }> = {};
  const sequences: Record<string, { before: string | null; after: string | null }> = {};
  for (const table of CLONED_TABLES) {
    if (left.rows[table] !== right.rows[table]) {
      rows[table] = { before: left.rows[table], after: right.rows[table] };
    }
    if (left.sequences[table] !== right.sequences[table]) {
      sequences[table] = {
        before: left.sequences[table],
        after: right.sequences[table],
      };
    }
  }
  return { rows, sequences };
}

async function publicAuditMarkers(db: DbClient, schema: string) {
  const rows = await db.$client.unsafe<{ orders: number; outboxes: number }[]>(`
    SELECT
      (SELECT count(*)::int FROM public.store_order audit_order
        WHERE audit_order.order_id IN (SELECT fixture.order_no FROM ${schema}.audit_fixture fixture)) AS orders,
      (SELECT count(*)::int FROM public.store_order_outbox audit_outbox
        WHERE audit_outbox.event_key IN (SELECT fixture.event_key FROM ${schema}.audit_fixture fixture)) AS outboxes
  `);
  return rows[0] ?? { orders: -1, outboxes: -1 };
}

function numericSeed(): number {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return 1_500_000_000 + random[0] % 100_000_000;
}

export async function setupOrderPaidOutboxQueueAudit(
  connectionString: string,
  rawSchemaName: string,
): Promise<{ schema: string; fixtures: AuditFixture[]; public_before: PublicSnapshot }> {
  const schemaName = validateAuditSchemaName(rawSchemaName);
  const schema = identifier(schemaName);
  return withAdminDb(connectionString, async (db) => {
    const existing = await db.$client<{ exists: boolean }[]>`
      SELECT to_regnamespace(${schemaName}) IS NOT NULL AS exists
    `;
    assertCondition(existing[0]?.exists === false, "temporary schema already exists");
    const before = await publicSnapshot(db);
    const base = numericSeed();
    const now = Math.floor(Date.now() / 1000);
    const supplierId = base + 50;
    const fixtures: AuditFixture[] = SCENARIOS.map((scenario, index) => {
      const orderId = base + 100 + index;
      return {
        scenario,
        outbox_id: base + 200 + index,
        order_id: orderId,
        order_no: `OQA${orderId}`,
        event_key: `order.paid:${orderId}`,
      };
    });

    try {
      await db.$client.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '5s'`;
        await tx`SET LOCAL statement_timeout = '30s'`;
        await tx.unsafe(`CREATE SCHEMA ${schema}`);
        for (const table of CLONED_TABLES) {
          const tableName = identifier(table);
          await tx.unsafe(
            `CREATE TABLE ${schema}.${tableName} (LIKE public.${tableName} INCLUDING ALL)`,
          );
        }
        for (const [index, table] of LOCAL_SEQUENCE_TABLES.entries()) {
          const tableName = identifier(table);
          const sequenceName = identifier(`${table}_id_seq_audit`);
          const start = base + 10_000 + index * 10_000;
          await tx.unsafe(`CREATE SEQUENCE ${schema}.${sequenceName} START WITH ${start}`);
          await tx.unsafe(
            `ALTER SEQUENCE ${schema}.${sequenceName} OWNED BY ${schema}.${tableName}."id"`,
          );
          await tx.unsafe(
            `ALTER TABLE ${schema}.${tableName} ALTER COLUMN "id" SET DEFAULT nextval('${schemaName}.${table}_id_seq_audit'::regclass)`,
          );
        }

        await tx.unsafe(`
          CREATE TABLE ${schema}.audit_fixture (
            scenario text PRIMARY KEY,
            outbox_id integer UNIQUE NOT NULL,
            order_id integer UNIQUE NOT NULL,
            uid integer UNIQUE NOT NULL,
            order_no text UNIQUE NOT NULL,
            event_key text UNIQUE NOT NULL,
            interrupt_first boolean NOT NULL DEFAULT false,
            fail_enabled boolean NOT NULL DEFAULT false
          )
        `);
        await tx.unsafe(`
          CREATE TABLE ${schema}.audit_delivery (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            scenario text NOT NULL,
            message_id text NOT NULL,
            queue_attempt integer NOT NULL,
            phase text NOT NULL,
            result text NOT NULL DEFAULT '',
            error text NOT NULL DEFAULT '',
            created_at timestamptz NOT NULL DEFAULT now()
          )
        `);
        await tx.unsafe(`
          CREATE TABLE ${schema}.audit_metadata (
            key text PRIMARY KEY,
            value jsonb NOT NULL
          )
        `);
        await tx.unsafe(`
          CREATE TABLE ${schema}.audit_checkpoint (
            scenario text PRIMARY KEY,
            value jsonb NOT NULL
          )
        `);
        await tx.unsafe(
          `INSERT INTO ${schema}.audit_metadata (key, value) VALUES ('public_before', $1::jsonb)`,
          [JSON.stringify(before)],
        );
        await tx.unsafe(
          `INSERT INTO ${schema}.system_supplier (id, supplier_name, name, phone, is_show, is_del, add_time)
           VALUES ($1, $2, $2, '13000000000', 1, 0, $3)`,
          [supplierId, `Queue audit supplier ${base}`, now],
        );

        for (const [index, fixture] of fixtures.entries()) {
          const uid = base + 300 + index;
          const firstCartId = base + 400 + index * 2;
          const secondCartId = firstCartId + 1;
          await tx.unsafe(
            `INSERT INTO ${schema}."user" (uid, account, status, is_del, pay_count, add_time)
             VALUES ($1, $2, 1, 0, 0, $3)`,
            [uid, `outbox-audit-${base}-${index}`.slice(0, 32), now],
          );
          await tx.unsafe(
            `INSERT INTO ${schema}.store_order (
               id, type, pid, order_id, supplier_id, supplier_allocation_status, uid, cart_id,
               total_num, total_price, pay_price, paid, status, is_del, is_system_del,
               pay_type, pay_time, add_time, "unique"
             ) VALUES ($1, 0, 0, $2, 0, 1, $3, $4, 2, '10.00', '10.00', 1, 0, 0, 0,
               'offline', $5, $5, $6)`,
            [
              fixture.order_id,
              fixture.order_no,
              uid,
              `${firstCartId},${secondCartId}`,
              now,
              `outbox-${base}-${index}`,
            ],
          );
          await tx.unsafe(
            `INSERT INTO ${schema}.store_order_cart_info (
               id, uid, oid, cart_id, type, relation_id, product_id, cart_num, refund_num,
               surplus_num, split_surplus_num, split_status, settle_price, cart_info, "unique", add_time
             ) VALUES
               ($1, $2, $3, $4, 2, $5, $6, 1, 0, 1, 1, 0, '4.00', $7, $8, $9),
               ($10, $2, $3, $11, 1, 0, $12, 1, 0, 1, 1, 0, '6.00', $13, $14, $9)`,
            [
              firstCartId,
              uid,
              fixture.order_id,
              `supplier-${firstCartId}`,
              supplierId,
              base + 600 + index * 2,
              JSON.stringify({ truePrice: "4.00" }),
              `supplier-${index}`,
              now,
              secondCartId,
              `platform-${secondCartId}`,
              base + 601 + index * 2,
              JSON.stringify({ truePrice: "6.00" }),
              `platform-${index}`,
            ],
          );
          const expired = fixture.scenario === "expired_lease";
          await tx.unsafe(
            `INSERT INTO ${schema}.store_order_outbox (
               id, event_key, aggregate_type, aggregate_id, event_type, payload, status,
               attempt_count, available_time, lease_until, lease_token, enqueued_time, add_time, update_time
             ) VALUES ($1, $2, 'order', $3, 'order.paid', $4::jsonb, $5, $6, 0, $7, $8, $9, $9, $9)`,
            [
              fixture.outbox_id,
              fixture.event_key,
              fixture.order_id,
              JSON.stringify({ orderId: fixture.order_id, orderNo: fixture.order_no }),
              expired ? "PROCESSING" : "ENQUEUED",
              expired ? 1 : 0,
              expired ? now - 10 : now + 600,
              expired ? "expired-audit-lease" : "",
              now,
            ],
          );
          await tx.unsafe(
            `INSERT INTO ${schema}.audit_fixture (
               scenario, outbox_id, order_id, uid, order_no, event_key, interrupt_first, fail_enabled
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              fixture.scenario,
              fixture.outbox_id,
              fixture.order_id,
              uid,
              fixture.order_no,
              fixture.event_key,
              fixture.scenario === "interruption",
              fixture.scenario === "failure",
            ],
          );
        }

        await tx.unsafe(`
          CREATE FUNCTION ${schema}.reject_audit_supplier_transaction() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM ${schema}.audit_fixture fixture
              WHERE fixture.scenario = 'failure'
                AND fixture.fail_enabled
                AND left(NEW.link_id, length(fixture.order_no) + 1) = fixture.order_no || '_'
            ) THEN
              RAISE EXCEPTION 'integration supplier transaction failure';
            END IF;
            RETURN NEW;
          END;
          $$
        `);
        await tx.unsafe(`
          CREATE TRIGGER reject_audit_supplier_transaction
          BEFORE INSERT ON ${schema}.supplier_transactions
          FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_audit_supplier_transaction()
        `);
      });
    } catch (error) {
      await db.$client.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      throw error;
    }

    return { schema: schemaName, fixtures, public_before: before };
  });
}

export async function listOrderPaidOutboxAuditFixtures(
  connectionString: string,
  rawSchemaName: string,
): Promise<AuditFixture[]> {
  const schema = identifier(validateAuditSchemaName(rawSchemaName));
  return withAdminDb(connectionString, async (db) => db.$client.unsafe<AuditFixture[]>(
    `SELECT scenario, outbox_id, order_id, order_no, event_key
     FROM ${schema}.audit_fixture ORDER BY order_id`,
  ));
}

export async function readOrderPaidOutboxAuditControl(
  db: DbClient,
  rawSchemaName: string,
  outboxId: number,
): Promise<AuditScenarioControl> {
  const schema = identifier(validateAuditSchemaName(rawSchemaName));
  const rows = await db.$client.unsafe<AuditScenarioControl[]>(
    `SELECT scenario, interrupt_first FROM ${schema}.audit_fixture WHERE outbox_id = $1`,
    [outboxId],
  );
  const row = rows[0];
  assertCondition(row, `fixture for outbox ${outboxId} is missing`);
  return row;
}

export async function recordOrderPaidOutboxAuditDelivery(
  db: DbClient,
  rawSchemaName: string,
  input: {
    scenario: OrderPaidOutboxAuditScenario;
    messageId: string;
    queueAttempt: number;
    phase: string;
    result?: string;
    error?: string;
  },
): Promise<void> {
  const schema = identifier(validateAuditSchemaName(rawSchemaName));
  await db.$client.unsafe(
    `INSERT INTO ${schema}.audit_delivery (
       scenario, message_id, queue_attempt, phase, result, error
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.scenario,
      input.messageId,
      input.queueAttempt,
      input.phase,
      input.result ?? "",
      input.error ?? "",
    ],
  );
}

export async function recordOrderPaidOutboxAuditWorkerError(
  connectionString: string,
  rawSchemaName: string,
  input: {
    outboxId: number;
    messageId: string;
    queueAttempt: number;
    error: string;
  },
): Promise<void> {
  const schema = identifier(validateAuditSchemaName(rawSchemaName));
  await withAdminDb(connectionString, async (db) => {
    await db.$client.unsafe(
      `INSERT INTO ${schema}.audit_delivery (
         scenario, message_id, queue_attempt, phase, error
       )
       SELECT fixture.scenario, $2, $3, 'worker_error', $4
       FROM ${schema}.audit_fixture fixture
       WHERE fixture.outbox_id = $1`,
      [input.outboxId, input.messageId, input.queueAttempt, input.error],
    );
  });
}

export async function probeOrderPaidOutboxAuditTransactionScope(
  connectionString: string,
  rawSchemaName: string,
): Promise<{ search_path: string; current_schema: string; fixtures: number }> {
  const schemaName = validateAuditSchemaName(rawSchemaName);
  const db = createDbFromConnectionString(connectionString, 1, {
    searchPath: schemaName,
    applicationName: "cinashop_outbox_audit_probe",
  });
  try {
    return await withTx(createContainerFromDb(db), async (tx) => {
      const raw = await tx.execute(sql.raw(`
        SELECT
          current_setting('search_path') AS search_path,
          current_schema() AS current_schema,
          (SELECT count(*)::int FROM audit_fixture) AS fixtures
      `));
      const rows = Array.isArray(raw)
        ? raw
        : (raw as { rows?: Array<Record<string, unknown>> }).rows ?? [];
      const row = rows[0] as Record<string, unknown> | undefined;
      assertCondition(row, "transaction scope probe returned no row");
      return {
        search_path: String(row.search_path),
        current_schema: String(row.current_schema),
        fixtures: Number(row.fixtures),
      };
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

async function readScenarioStatus(db: DbClient, schema: string): Promise<ScenarioStatus[]> {
  return db.$client.unsafe<ScenarioStatus[]>(`
    SELECT
      fixture.scenario,
      outbox.status AS outbox_status,
      outbox.attempt_count,
      outbox.last_error,
      root.pid AS root_pid,
      buyer.pay_count,
      (SELECT count(*)::int FROM ${schema}.store_order child WHERE child.pid = fixture.order_id) AS child_count,
      (SELECT count(*)::int FROM ${schema}.store_order child WHERE child.pid = fixture.order_id AND child.supplier_id > 0) AS supplier_child_count,
      (SELECT count(*)::int FROM ${schema}.store_order child WHERE child.pid = fixture.order_id AND child.supplier_id = 0) AS platform_child_count,
      (SELECT count(*)::int FROM ${schema}.supplier_flowing_water flow
        WHERE flow.link_id IN (SELECT child.order_id FROM ${schema}.store_order child WHERE child.pid = fixture.order_id)) AS flowing_rows,
      (SELECT count(*)::int FROM ${schema}.supplier_transactions txs
        WHERE txs.link_id IN (SELECT child.order_id FROM ${schema}.store_order child WHERE child.pid = fixture.order_id)) AS transaction_rows,
      (SELECT count(*)::int FROM ${schema}.store_order_status status
        WHERE status.oid = fixture.order_id OR status.oid IN (
          SELECT child.id FROM ${schema}.store_order child WHERE child.pid = fixture.order_id
        )) AS status_rows,
      (SELECT count(*)::int FROM ${schema}.store_order_status status
        WHERE status.oid = fixture.order_id AND status.change_type = 'pay_success') AS pay_success_rows,
      (SELECT count(*)::int FROM ${schema}.store_order_cart_info cart
        WHERE cart.oid = fixture.order_id AND cart.split_status = 2 AND cart.split_surplus_num = 0) AS root_cart_split_rows,
      (SELECT count(*)::int FROM ${schema}.store_order_cart_info cart
        WHERE cart.oid IN (SELECT child.id FROM ${schema}.store_order child WHERE child.pid = fixture.order_id)) AS child_cart_rows
    FROM ${schema}.audit_fixture fixture
    JOIN ${schema}.store_order_outbox outbox ON outbox.id = fixture.outbox_id
    JOIN ${schema}.store_order root ON root.id = fixture.order_id
    JOIN ${schema}."user" buyer ON buyer.uid = fixture.uid
    ORDER BY fixture.order_id
  `);
}

async function readDeliverySummary(db: DbClient, schema: string): Promise<DeliverySummary[]> {
  return db.$client.unsafe<DeliverySummary[]>(`
    SELECT
      fixture.scenario,
      count(*) FILTER (WHERE delivery.phase = 'received')::int AS received,
      count(*) FILTER (WHERE delivery.phase = 'processor_result' AND delivery.result = 'completed')::int AS completed,
      count(*) FILTER (WHERE delivery.phase = 'processor_result' AND delivery.result = 'already-completed')::int AS already_completed,
      count(*) FILTER (WHERE delivery.phase = 'processor_failed')::int AS processor_failed,
      count(*) FILTER (WHERE delivery.phase = 'injected_interruption')::int AS injected_interruption,
      COALESCE(
        jsonb_agg(delivery.queue_attempt ORDER BY delivery.id) FILTER (WHERE delivery.phase = 'received'),
        '[]'::jsonb
      ) AS queue_attempts
    FROM ${schema}.audit_fixture fixture
    LEFT JOIN ${schema}.audit_delivery delivery ON delivery.scenario = fixture.scenario
    GROUP BY fixture.scenario, fixture.order_id
    ORDER BY fixture.order_id
  `);
}

export async function readOrderPaidOutboxQueueAuditStatus(
  connectionString: string,
  rawSchemaName: string,
): Promise<{
  scenarios: ScenarioStatus[];
  deliveries: DeliverySummary[];
  checkpoints: unknown[];
  recent_events: unknown[];
}> {
  const schema = identifier(validateAuditSchemaName(rawSchemaName));
  return withAdminDb(connectionString, async (db) => {
    const [scenarios, deliveries, checkpoints, recentEvents] = await Promise.all([
      readScenarioStatus(db, schema),
      readDeliverySummary(db, schema),
      db.$client.unsafe<{ scenario: string; value: unknown }[]>(
        `SELECT scenario, value FROM ${schema}.audit_checkpoint ORDER BY scenario`,
      ),
      db.$client.unsafe<{
        scenario: string;
        queue_attempt: number;
        phase: string;
        result: string;
        error: string;
      }[]>(`
        SELECT scenario, queue_attempt, phase, result, error
        FROM ${schema}.audit_delivery ORDER BY id DESC LIMIT 20
      `),
    ]);
    return { scenarios, deliveries, checkpoints, recent_events: recentEvents };
  });
}

export async function captureFailureRollbackAndRelease(
  connectionString: string,
  rawSchemaName: string,
): Promise<ScenarioStatus> {
  const schema = identifier(validateAuditSchemaName(rawSchemaName));
  return withAdminDb(connectionString, async (db) => db.$client.begin(async (tx) => {
    const rows = await tx.unsafe<ScenarioStatus[]>(`
      SELECT
        fixture.scenario,
        outbox.status AS outbox_status,
        outbox.attempt_count,
        outbox.last_error,
        root.pid AS root_pid,
        buyer.pay_count,
        (SELECT count(*)::int FROM ${schema}.store_order child WHERE child.pid = fixture.order_id) AS child_count,
        (SELECT count(*)::int FROM ${schema}.store_order child WHERE child.pid = fixture.order_id AND child.supplier_id > 0) AS supplier_child_count,
        (SELECT count(*)::int FROM ${schema}.store_order child WHERE child.pid = fixture.order_id AND child.supplier_id = 0) AS platform_child_count,
        (SELECT count(*)::int FROM ${schema}.supplier_flowing_water flow
          WHERE flow.link_id IN (SELECT child.order_id FROM ${schema}.store_order child WHERE child.pid = fixture.order_id)) AS flowing_rows,
        (SELECT count(*)::int FROM ${schema}.supplier_transactions txs
          WHERE txs.link_id IN (SELECT child.order_id FROM ${schema}.store_order child WHERE child.pid = fixture.order_id)) AS transaction_rows,
        (SELECT count(*)::int FROM ${schema}.store_order_status status
          WHERE status.oid = fixture.order_id OR status.oid IN (
            SELECT child.id FROM ${schema}.store_order child WHERE child.pid = fixture.order_id
          )) AS status_rows,
        (SELECT count(*)::int FROM ${schema}.store_order_status status WHERE status.oid = fixture.order_id AND status.change_type = 'pay_success') AS pay_success_rows,
        (SELECT count(*)::int FROM ${schema}.store_order_cart_info cart WHERE cart.oid = fixture.order_id AND cart.split_status = 2) AS root_cart_split_rows,
        (SELECT count(*)::int FROM ${schema}.store_order_cart_info cart WHERE cart.oid IN (
          SELECT child.id FROM ${schema}.store_order child WHERE child.pid = fixture.order_id
        )) AS child_cart_rows
      FROM ${schema}.audit_fixture fixture
      JOIN ${schema}.store_order_outbox outbox ON outbox.id = fixture.outbox_id
      JOIN ${schema}.store_order root ON root.id = fixture.order_id
      JOIN ${schema}."user" buyer ON buyer.uid = fixture.uid
      WHERE fixture.scenario = 'failure'
      FOR UPDATE OF fixture, outbox
    `);
    const row = rows[0];
    assertCondition(row, "failure fixture is missing");
    assertCondition(row.outbox_status === "FAILED", "injected transaction failure was not recorded");
    assertCondition(row.attempt_count === 1, "failure did not consume exactly one application attempt");
    assertCondition(row.root_pid === 0, "failed split changed the root order");
    assertCondition(row.pay_count === 0, "failed transaction incremented pay_count");
    assertCondition(row.child_count === 0, "failed transaction left child orders");
    assertCondition(row.flowing_rows === 0 && row.transaction_rows === 0, "failed transaction left finance rows");
    assertCondition(row.status_rows === 0, "failed transaction left status rows");
    assertCondition(row.root_cart_split_rows === 0 && row.child_cart_rows === 0, "failed transaction changed cart splits");
    await tx.unsafe(
      `INSERT INTO ${schema}.audit_checkpoint (scenario, value) VALUES ('failure_before_retry', $1::jsonb)
       ON CONFLICT (scenario) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(row)],
    );
    await tx.unsafe(
      `UPDATE ${schema}.audit_fixture SET fail_enabled = false WHERE scenario = 'failure'`,
    );
    return row;
  }));
}

function assertCompletedBusinessState(row: ScenarioStatus, label: string): void {
  assertCondition(row.outbox_status === "COMPLETED", `${label} outbox is not completed`);
  assertCondition(row.root_pid === -1, `${label} root is not a split audit order`);
  assertCondition(row.pay_count === 1, `${label} buyer pay_count is not exactly one`);
  assertCondition(row.child_count === 2, `${label} did not create exactly two child orders`);
  assertCondition(
    row.supplier_child_count === 1 && row.platform_child_count === 1,
    `${label} supplier/platform allocation is incorrect`,
  );
  assertCondition(
    row.flowing_rows === 1 && row.transaction_rows === 1,
    `${label} supplier finance evidence is not exactly once`,
  );
  assertCondition(row.status_rows === 4 && row.pay_success_rows === 1, `${label} status evidence is incorrect`);
  assertCondition(
    row.root_cart_split_rows === 2 && row.child_cart_rows === 2,
    `${label} cart split evidence is incorrect`,
  );
}

export async function verifyOrderPaidOutboxQueueAudit(
  connectionString: string,
  rawSchemaName: string,
): Promise<{
  scenarios: ScenarioStatus[];
  deliveries: DeliverySummary[];
  failure_rollback: unknown;
  public_state_unchanged: boolean;
  public_state_delta: ReturnType<typeof snapshotDelta>;
  public_audit_markers: { orders: number; outboxes: number };
}> {
  const schemaName = validateAuditSchemaName(rawSchemaName);
  const schema = identifier(schemaName);
  return withAdminDb(connectionString, async (db) => {
    const scenarios = await readScenarioStatus(db, schema);
    const deliveries = await readDeliverySummary(db, schema);
    const scenarioByName = new Map(scenarios.map((row) => [row.scenario, row]));
    const deliveryByName = new Map(deliveries.map((row) => [row.scenario, row]));
    for (const scenario of SCENARIOS) {
      const row = scenarioByName.get(scenario);
      assertCondition(row, `${scenario} scenario is missing`);
      assertCompletedBusinessState(row, scenario);
    }
    assertCondition(scenarioByName.get("normal")?.attempt_count === 1, "duplicates reclaimed completed outbox");
    assertCondition(scenarioByName.get("interruption")?.attempt_count === 1, "pre-business interruption changed application attempts");
    assertCondition(scenarioByName.get("expired_lease")?.attempt_count === 2, "expired PROCESSING lease was not reclaimed");
    assertCondition(scenarioByName.get("failure")?.attempt_count === 2, "transaction retry did not use second application attempt");

    const normalDelivery = deliveryByName.get("normal");
    assertCondition(
      normalDelivery?.received === 3
      && normalDelivery.completed === 1
      && normalDelivery.already_completed === 2
      && JSON.stringify(normalDelivery.queue_attempts) === "[1,1,1]",
      "duplicate deliveries were not idempotently acknowledged",
    );
    const interruptionDelivery = deliveryByName.get("interruption");
    assertCondition(
      interruptionDelivery?.received === 2
      && interruptionDelivery.injected_interruption === 1
      && interruptionDelivery.completed === 1
      && JSON.stringify(interruptionDelivery.queue_attempts) === "[1,2]",
      "consumer interruption did not recover on Queue attempt two",
    );
    const expiredDelivery = deliveryByName.get("expired_lease");
    assertCondition(
      expiredDelivery?.received === 1
      && expiredDelivery.completed === 1
      && JSON.stringify(expiredDelivery.queue_attempts) === "[1]",
      "expired lease scenario delivery evidence is incorrect",
    );
    const failureDelivery = deliveryByName.get("failure");
    assertCondition(
      failureDelivery?.received === 2
      && failureDelivery.processor_failed === 1
      && failureDelivery.completed === 1
      && JSON.stringify(failureDelivery.queue_attempts) === "[1,2]",
      "transaction failure did not recover on Queue attempt two",
    );

    const checkpointRows = await db.$client.unsafe<{ value: unknown }[]>(
      `SELECT value FROM ${schema}.audit_checkpoint WHERE scenario = 'failure_before_retry'`,
    );
    const checkpoint = checkpointRows[0]?.value;
    assertCondition(checkpoint, "failure rollback checkpoint is missing");
    const beforeRows = await db.$client.unsafe<{ value: PublicSnapshot }[]>(
      `SELECT value FROM ${schema}.audit_metadata WHERE key = 'public_before'`,
    );
    const before = beforeRows[0]?.value;
    assertCondition(before, "public snapshot is missing");
    const after = await publicSnapshot(db);
    const publicStateUnchanged = snapshotsEqual(before, after);
    const markers = await publicAuditMarkers(db, schema);
    assertCondition(
      markers.orders === 0 && markers.outboxes === 0,
      "audit-specific business rows escaped into public schema",
    );
    return {
      scenarios,
      deliveries,
      failure_rollback: checkpoint,
      public_state_unchanged: publicStateUnchanged,
      public_state_delta: snapshotDelta(before, after),
      public_audit_markers: markers,
    };
  });
}

export async function cleanupOrderPaidOutboxQueueAudit(
  connectionString: string,
  rawSchemaName: string,
): Promise<{
  schema_removed: boolean;
  public_state_unchanged: boolean;
  public_state_delta: ReturnType<typeof snapshotDelta>;
  public_audit_markers: { orders: number; outboxes: number };
}> {
  const schemaName = validateAuditSchemaName(rawSchemaName);
  const schema = identifier(schemaName);
  return withAdminDb(connectionString, async (db) => {
    const beforeRows = await db.$client.unsafe<{ value: PublicSnapshot }[]>(
      `SELECT value FROM ${schema}.audit_metadata WHERE key = 'public_before'`,
    );
    const before = beforeRows[0]?.value;
    assertCondition(before, "public snapshot is missing before cleanup");
    const after = await publicSnapshot(db);
    const publicStateUnchanged = snapshotsEqual(before, after);
    const markers = await publicAuditMarkers(db, schema);
    await db.$client.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    const removedRows = await db.$client<{ removed: boolean }[]>`
      SELECT to_regnamespace(${schemaName}) IS NULL AS removed
    `;
    const schemaRemoved = removedRows[0]?.removed === true;
    assertCondition(schemaRemoved, "temporary audit schema was not removed");
    assertCondition(
      markers.orders === 0 && markers.outboxes === 0,
      "audit-specific business rows escaped into public schema",
    );
    return {
      schema_removed: schemaRemoved,
      public_state_unchanged: publicStateUnchanged,
      public_state_delta: snapshotDelta(before, after),
      public_audit_markers: markers,
    };
  });
}
