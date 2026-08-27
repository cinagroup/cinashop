import type { Env, OrderWaybillJobMessage } from "@/env";
import { eq, sql } from "drizzle-orm";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type Container,
  type DbClient,
} from "@/lib/di";
import {
  expressCompany,
  orderWaybillJob,
  orderWaybillJobAction,
  storeConfig,
  storeOrder,
  storeOrderCartInfo,
  storeOrderOutbox,
  storeOrderStatus,
  systemConfig,
} from "@/models/schema";
import { MigrationService } from "@/services/MigrationService";
import {
  OrderWaybillJobService,
  type WaybillActor,
} from "@/services/waybill/OrderWaybillJobService";

const CLONED_TABLES = [
  "express_company",
  "store_config",
  "store_order",
  "store_order_cart_info",
  "store_order_outbox",
  "store_order_refund",
  "store_order_status",
  "store_pink",
  "system_config",
] as const;
const PUBLIC_TABLES = [
  ...CLONED_TABLES,
  "order_waybill_job",
  "order_waybill_job_action",
] as const;
const PUBLIC_SEQUENCES = PUBLIC_TABLES.map((table) => `${table}_id_seq`);
const IDS = {
  carrier: 1_940_001_001,
  success: 1_940_010_101,
  retry: 1_940_010_102,
  confirm: 1_940_010_103,
  apply: 1_940_010_104,
  reject: 1_940_010_105,
} as const;

interface Fingerprint {
  tables: Record<string, { exists: boolean; rows: string; digest: string }>;
  sequences: Record<string, string | null>;
}

export interface ProductionWaybillState {
  server_version: string;
  eligible_carriers: number;
  platform_config_rows: number;
  platform_nonblank_rows: number;
  supplier_config_rows: number;
  waybill_job_table_exists: boolean;
  waybill_action_table_exists: boolean;
  waybill_job_rows: number;
  waybill_action_rows: number;
  temporary_schemas: number;
}

export interface OrderWaybillJobPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  production: ProductionWaybillState;
  outbox: {
    create_replay_idempotent: boolean;
    active_root_guarded: boolean;
    tenant_boundary_rejected: boolean;
    tenant_ledgers_exact: boolean;
    immutable_actions_exact: boolean;
  };
  queue: {
    references_only: boolean;
    provider_secrets_absent: boolean;
    recipient_and_sender_absent: boolean;
  };
  provider: {
    concurrent_single_issue: boolean;
    concurrent_results: string[];
    https_protocol_and_direction_exact: boolean;
    ambiguous_result_not_retried: boolean;
    operator_retry_then_sent: boolean;
    operator_confirm_issued: boolean;
    provider_success_survives_local_failure: boolean;
    operator_apply_existing: boolean;
    explicit_rejection_dead: boolean;
    operator_close_without_retry: boolean;
  };
  fulfillment: {
    delivered_exactly_once: boolean;
    notification_outbox_exact: boolean;
    replay_evidence_exact: boolean;
    final_statuses: Record<string, number>;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Order waybill integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function randomSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_waybill_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

async function publicFingerprint(db: DbClient): Promise<Fingerprint> {
  const tables: Fingerprint["tables"] = {};
  for (const table of PUBLIC_TABLES) {
    const exists = (await db.$client<{ exists: boolean }[]>`
      SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS exists
    `)[0]?.exists === true;
    if (!exists) {
      tables[table] = { exists: false, rows: "0", digest: "" };
      continue;
    }
    const tableName = identifier(table);
    const rows = await db.$client.unsafe<Array<{ rows: string; digest: string }>>(
      `SELECT count(*)::text AS rows,
        md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')) AS digest
       FROM public.${tableName} t WHERE random() >= 0`,
    );
    assertCondition(rows[0], `could not fingerprint public.${table}`);
    tables[table] = { exists: true, ...rows[0] };
  }
  const rows = await db.$client<{ sequencename: string; last_value: string | null }[]>`
    SELECT sequencename, last_value::text
    FROM pg_sequences
    WHERE schemaname = 'public' AND sequencename = ANY(${PUBLIC_SEQUENCES})
    ORDER BY sequencename
  `;
  const byName = new Map(rows.map((row) => [row.sequencename, row.last_value]));
  return {
    tables,
    sequences: Object.fromEntries(PUBLIC_SEQUENCES.map((name) => [name, byName.get(name) ?? null])),
  };
}

export async function productionWaybillState(db: DbClient): Promise<ProductionWaybillState> {
  const base = (await db.$client<{
    server_version: string;
    eligible_carriers: number;
    platform_config_rows: number;
    platform_nonblank_rows: number;
    supplier_config_rows: number;
    waybill_job_table_exists: boolean;
    waybill_action_table_exists: boolean;
    temporary_schemas: number;
  }[]>`
    SELECT current_setting('server_version') AS server_version,
      (SELECT count(*)::int FROM public.express_company
        WHERE is_show = 1 AND status = 1 AND code <> '' AND name <> '') AS eligible_carriers,
      (SELECT count(*)::int FROM public.system_config WHERE is_store = 0 AND menu_name = ANY(ARRAY[
        'config_export_open', 'config_export_id', 'config_export_temp_id',
        'config_export_to_name', 'config_export_to_tel', 'config_export_to_address',
        'config_export_siid'
      ])) AS platform_config_rows,
      (SELECT count(*)::int FROM public.system_config WHERE is_store = 0 AND value <> '' AND menu_name = ANY(ARRAY[
        'config_export_open', 'config_export_id', 'config_export_temp_id',
        'config_export_to_name', 'config_export_to_tel', 'config_export_to_address',
        'config_export_siid'
      ])) AS platform_nonblank_rows,
      (SELECT count(*)::int FROM public.store_config WHERE type = 2 AND key_name = ANY(ARRAY[
        'store_config_export_open', 'store_config_export_id', 'store_config_export_temp_id',
        'store_config_export_to_name', 'store_config_export_to_tel',
        'store_config_export_to_address', 'store_config_export_siid'
      ])) AS supplier_config_rows,
      to_regclass('public.order_waybill_job') IS NOT NULL AS waybill_job_table_exists,
      to_regclass('public.order_waybill_job_action') IS NOT NULL AS waybill_action_table_exists,
      (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'codex_waybill_%') AS temporary_schemas
  `)[0];
  assertCondition(base, "production state returned no row");
  let waybillJobRows = 0;
  let waybillActionRows = 0;
  if (base.waybill_job_table_exists) {
    waybillJobRows = (await db.$client.unsafe<Array<{ count: number }>>(
      "SELECT count(*)::int AS count FROM public.order_waybill_job",
    ))[0]?.count ?? 0;
  }
  if (base.waybill_action_table_exists) {
    waybillActionRows = (await db.$client.unsafe<Array<{ count: number }>>(
      "SELECT count(*)::int AS count FROM public.order_waybill_job_action",
    ))[0]?.count ?? 0;
  }
  return {
    ...base,
    waybill_job_rows: waybillJobRows,
    waybill_action_rows: waybillActionRows,
  };
}

async function setupSchema(root: DbClient, name: string): Promise<void> {
  const schema = identifier(name);
  const migration = new MigrationService(createContainerFromDb(root))
    .waybillJobMigrationSqlForVerification();
  await root.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of CLONED_TABLES) {
      const tableName = identifier(table);
      const sequenceName = identifier(`${table}_id_seq_waybill_it`);
      await tx.unsafe(`CREATE TABLE ${schema}.${tableName} (LIKE public.${tableName} INCLUDING ALL)`);
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${sequenceName} START WITH 1940900001`);
      await tx.unsafe(
        `ALTER TABLE ${schema}.${tableName} ALTER COLUMN "id" SET DEFAULT nextval('${name}.${table}_id_seq_waybill_it'::regclass)`,
      );
    }
    await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
    await tx.unsafe(migration);
  });
}

function configRows(prefix: "config_export" | "store_config_export") {
  return [
    [`${prefix}_open`, "1"],
    [`${prefix}_id`, String(IDS.carrier)],
    [`${prefix}_temp_id`, "audit-template-001"],
    [`${prefix}_to_name`, "隔离审计发件人"],
    [`${prefix}_to_tel`, "000-0000-9000"],
    [`${prefix}_to_address`, "隔离审计发件地址"],
    [`${prefix}_siid`, ""],
  ] as const;
}

async function seed(container: Container, now: number): Promise<void> {
  await container.db.insert(expressCompany).values({
    id: IDS.carrier,
    code: "AUDITEXPRESS",
    name: "隔离审计快递",
    isShow: 1,
    status: 1,
    sort: 100,
    addTime: now,
  });
  await container.db.insert(systemConfig).values(configRows("config_export").map(
    ([menuName, value], index) => ({
      id: 1_940_002_001 + index,
      menuName,
      value,
      isStore: 0,
      sort: index,
    }),
  ));
  await container.db.insert(storeConfig).values(configRows("store_config_export").map(
    ([keyName, value], index) => ({
      id: 1_940_003_001 + index,
      type: 2,
      relationId: 101,
      keyName,
      value,
      addTime: now,
    }),
  ));
  const orders = [
    [IDS.success, 101, "success"],
    [IDS.retry, 101, "retry"],
    [IDS.confirm, 101, "confirm"],
    [IDS.apply, 101, "apply"],
    [IDS.reject, 202, "reject"],
  ] as const;
  await container.db.insert(storeOrder).values(orders.map(([id, supplierId, suffix]) => ({
    id,
    orderId: `audit-waybill-${suffix}`,
    supplierId,
    storeId: supplierId,
    uid: 1_940_100_000 + (id % 1000),
    unique: `audit-wb-order-${suffix}`,
    realName: `隔离收件人-${suffix}`,
    userPhone: `000-0000-${String(id % 10000).padStart(4, "0")}`,
    userAddress: `隔离收件地址-${suffix}`,
    shippingType: 1,
    paid: 1,
    status: 0,
    refundStatus: 0,
    totalNum: 1,
    totalPrice: "10.00",
    payPrice: "10.00",
    addTime: now - 60,
    payTime: now - 30,
  })));
  await container.db.insert(storeOrderCartInfo).values(orders.map(([orderId, , suffix], index) => ({
    id: 1_940_020_101 + index,
    uid: 1_940_100_000 + (orderId % 1000),
    oid: orderId,
    cartId: `audit-waybill-cart-${suffix}`,
    cartNum: 1,
    splitSurplusNum: 1,
    splitStatus: 0,
    cartInfo: JSON.stringify({
      product: { storeName: `隔离商品-${suffix}` },
      sku: { weight: "0.50", price: "10.00" },
    }),
    unique: `audit-wb-cart-${suffix}`,
    addTime: now - 60,
  })));
}

async function installFulfillmentFailure(container: Container, schemaName: string): Promise<void> {
  const schema = identifier(schemaName);
  await withTx(container, async (tx) => {
    await tx.execute(sql.raw(`
        CREATE OR REPLACE FUNCTION ${schema}.audit_waybill_fail_fulfillment()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.id = ${IDS.apply} AND NEW.status = 1 THEN
            RAISE EXCEPTION 'audit_local_fulfillment_failure';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER audit_waybill_fail_fulfillment
          BEFORE UPDATE ON ${schema}.store_order
          FOR EACH ROW EXECUTE FUNCTION ${schema}.audit_waybill_fail_fulfillment();
      `));
  });
}

async function removeFulfillmentFailure(container: Container, schemaName: string): Promise<void> {
  const schema = identifier(schemaName);
  await withTx(container, async (tx) => {
    await tx.execute(sql.raw(`
        DROP TRIGGER IF EXISTS audit_waybill_fail_fulfillment ON ${schema}.store_order;
        DROP FUNCTION IF EXISTS ${schema}.audit_waybill_fail_fulfillment();
      `));
  });
}

async function runScenario(containerA: Container, containerB: Container, schemaName: string) {
  const messages: OrderWaybillJobMessage[] = [];
  const queue = {
    async sendBatch(batch: Array<{ body: OrderWaybillJobMessage }>) {
      messages.push(...batch.map((entry) => structuredClone(entry.body)));
    },
  } as unknown as Env["ORDER_QUEUE"];
  const env = {
    ORDER_QUEUE: queue,
    CRMEB_ONEPASS_ACCESS_KEY: "audit-access-key-waybill",
    CRMEB_ONEPASS_SECRET_KEY: "audit-secret-key-waybill",
  } as Env;
  const serviceA = new OrderWaybillJobService(containerA, env);
  const serviceB = new OrderWaybillJobService(containerB, env);
  const supplier: WaybillActor = { actorType: "supplier", actorId: 901, supplierId: 101 };
  const admin: WaybillActor = { actorType: "admin", actorId: 902 };
  const now = Math.floor(Date.now() / 1_000);
  await withTx(containerA, (tx) => seed(createContainerFromDb(tx), now));

  const create = (orderId: number, actor: WaybillActor, requestKey: string) =>
    serviceA.create(orderId, actor, { requestKey, carrierId: IDS.carrier });
  const successKey = crypto.randomUUID();
  const success = await create(IDS.success, supplier, successKey);
  const successReplay = await create(IDS.success, supplier, successKey);
  let activeRootGuarded = false;
  try {
    await create(IDS.success, supplier, crypto.randomUUID());
  } catch {
    activeRootGuarded = true;
  }
  let tenantBoundaryRejected = false;
  try {
    await create(IDS.reject, supplier, crypto.randomUUID());
  } catch {
    tenantBoundaryRejected = true;
  }
  const retry = await create(IDS.retry, supplier, crypto.randomUUID());
  const confirm = await create(IDS.confirm, supplier, crypto.randomUUID());
  const apply = await create(IDS.apply, supplier, crypto.randomUUID());
  const reject = await create(IDS.reject, admin, crypto.randomUUID());

  const findMessage = (jobId: number) => {
    const message = [...messages].reverse().find((candidate) => candidate.waybillJobId === jobId);
    assertCondition(message, `Queue message missing for job ${jobId}`);
    return message;
  };

  let issueCalls = 0;
  let protocolExact = true;
  const loginResponse = () => Response.json({
    status: 200,
    msg: "ok",
    data: { access_token: "audit-waybill-token" },
  });
  const successFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://sms.crmeb.net/api/v2/user/login") return loginResponse();
    assertCondition(url === "https://sms.crmeb.net/api/v2/expr/dump", "unexpected provider URL");
    issueCalls += 1;
    const form = init?.body as FormData;
    protocolExact = protocolExact
      && init?.method === "POST"
      && new Headers(init?.headers).get("Authorization") === "Bearer-audit-waybill-token"
      && new Headers(init?.headers).get("version") === "v1.1"
      && String(form.get("to_name") ?? "").startsWith("隔离收件人-")
      && String(form.get("to_tel") ?? "").startsWith("000-0000-")
      && String(form.get("to_addr") ?? "").startsWith("隔离收件地址-")
      && form.get("from_name") === "隔离审计发件人"
      && form.get("from_tel") === "000-0000-9000"
      && form.get("from_addr") === "隔离审计发件地址"
      && form.get("print_type") === "IMAGE"
      && form.get("com") === "AUDITEXPRESS";
    return Response.json({
      status: 200,
      msg: "ok",
      data: {
        kuaidinum: `AUDIT-WAYBILL-${issueCalls}`,
        label: `https://audit.invalid/waybill/${issueCalls}.png`,
        task_id: `audit-provider-task-${issueCalls}`,
      },
    });
  }) as typeof fetch;

  const beforeConcurrent = issueCalls;
  const concurrentResults = await Promise.all([
    serviceA.processMessage(findMessage(success.job.id), successFetch),
    serviceB.processMessage(findMessage(success.job.id), successFetch),
  ]);
  const concurrentSingleIssue = issueCalls - beforeConcurrent === 1
    && concurrentResults.includes("sent")
    && (concurrentResults.includes("busy") || concurrentResults.includes("already-sent"));

  let ambiguousIssueCalls = 0;
  const ambiguousFetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/v2/user/login")) return loginResponse();
    ambiguousIssueCalls += 1;
    throw new Error("audit_transport_ambiguous_after_issue");
  }) as typeof fetch;

  const retryUnknown = await serviceA.processMessage(findMessage(retry.job.id), ambiguousFetch);
  let unknownBlocksSecondJob = false;
  try {
    await create(IDS.retry, supplier, crypto.randomUUID());
  } catch {
    unknownBlocksSecondJob = true;
  }
  const retryOperationKey = crypto.randomUUID();
  const retryOperation = await serviceA.confirmRetry(retry.job.id, supplier, {
    requestKey: retryOperationKey,
    reason: "生产隔离审计已向提供商核实，可以人工重签",
  });
  const retryOperationReplay = await serviceA.confirmRetry(retry.job.id, supplier, {
    requestKey: retryOperationKey,
    reason: "生产隔离审计已向提供商核实，可以人工重签",
  });
  const retrySent = await serviceA.processMessage(findMessage(retry.job.id), successFetch);

  const confirmUnknown = await serviceA.processMessage(findMessage(confirm.job.id), ambiguousFetch);
  const confirmOperation = await serviceA.confirmIssued(confirm.job.id, supplier, {
    requestKey: crypto.randomUUID(),
    reason: "生产隔离审计已从提供商后台确认签发结果",
    trackingNumber: "AUDIT-HUMAN-CONFIRMED-103",
    labelUrl: "https://audit.invalid/waybill/human-confirmed.png",
    providerReference: "audit-human-confirmed-reference",
  });

  await installFulfillmentFailure(containerA, schemaName);
  const applyUnknown = await serviceA.processMessage(findMessage(apply.job.id), successFetch);
  const applyBefore = (await withTx(containerA, (tx) => tx.select().from(orderWaybillJob)
    .where(eq(orderWaybillJob.id, apply.job.id))
    .limit(1)))[0];
  await removeFulfillmentFailure(containerA, schemaName);
  const applyOperation = await serviceA.applyExisting(apply.job.id, supplier, {
    requestKey: crypto.randomUUID(),
    reason: "生产隔离审计确认提供商已签发，应用账本中已有面单",
  });

  const rejectedFetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/v2/user/login")) return loginResponse();
    issueCalls += 1;
    return Response.json({ status: 422, msg: "audit_explicit_rejection", data: {} });
  }) as typeof fetch;
  const rejectDead = await serviceA.processMessage(findMessage(reject.job.id), rejectedFetch);
  const closeOperation = await serviceA.closeWithoutRetry(reject.job.id, admin, {
    requestKey: crypto.randomUUID(),
    reason: "生产隔离审计确认明确拒绝并关闭，不再自动重试",
  });

  let foreignLedgerRejected = false;
  try {
    await serviceA.listActions(reject.job.id, supplier);
  } catch {
    foreignLedgerRejected = true;
  }
  const [adminLedger, supplierLedger, finalJobs, actions, delivered, notices, replayRows] =
    await Promise.all([
      serviceA.listJobs(admin, { limit: 100 }),
      serviceA.listJobs(supplier, { limit: 100 }),
      withTx(containerA, (tx) => tx.select().from(orderWaybillJob)),
      withTx(containerA, (tx) => tx.select().from(orderWaybillJobAction)),
      withTx(containerA, (tx) => tx.select({
        id: storeOrder.id,
        status: storeOrder.status,
        deliveryId: storeOrder.deliveryId,
      }).from(storeOrder)),
      withTx(containerA, (tx) => tx.select().from(storeOrderOutbox)),
      withTx(containerA, (tx) => tx.select().from(storeOrderStatus)),
    ]);
  const statusCounts: Record<string, number> = {};
  for (const job of finalJobs) statusCounts[job.status] = (statusCounts[job.status] ?? 0) + 1;
  const queueJson = JSON.stringify(messages);
  const actionJson = JSON.stringify(actions);
  const referencesOnly = messages.every((message) => {
    const keys = Object.keys(message).sort();
    return JSON.stringify(keys) === JSON.stringify(["action", "eventKey", "waybillJobId"])
      && message.action === "processOrderWaybillJob";
  });
  const deliveredById = new Map(delivered.map((order) => [order.id, order]));
  const sentOrderIds = [IDS.success, IDS.retry, IDS.confirm, IDS.apply];

  return {
    outbox: {
      create_replay_idempotent: !success.duplicate && successReplay.duplicate
        && successReplay.job.id === success.job.id,
      active_root_guarded: activeRootGuarded && unknownBlocksSecondJob,
      tenant_boundary_rejected: tenantBoundaryRejected && foreignLedgerRejected,
      tenant_ledgers_exact: adminLedger.list.length === 5 && supplierLedger.list.length === 4
        && supplierLedger.list.every((job) => job.supplier_id === 101),
      immutable_actions_exact: actions.length === 4 && retryOperationReplay.duplicate
        && !actionJson.includes("000-0000-")
        && !actionJson.includes("隔离收件地址")
        && !actionJson.includes("audit-secret-key-waybill"),
    },
    queue: {
      references_only: referencesOnly,
      provider_secrets_absent: !queueJson.includes("audit-access-key-waybill")
        && !queueJson.includes("audit-secret-key-waybill")
        && !queueJson.includes("audit-waybill-token"),
      recipient_and_sender_absent: !queueJson.includes("000-0000-")
        && !queueJson.includes("隔离收件") && !queueJson.includes("隔离审计发件"),
    },
    provider: {
      concurrent_single_issue: concurrentSingleIssue,
      concurrent_results: [...concurrentResults].sort(),
      https_protocol_and_direction_exact: protocolExact,
      ambiguous_result_not_retried: retryUnknown === "unknown" && confirmUnknown === "unknown"
        && ambiguousIssueCalls === 2,
      operator_retry_then_sent: !retryOperation.duplicate && retryOperationReplay.duplicate
        && retrySent === "sent",
      operator_confirm_issued: confirmOperation.job.status === "SENT"
        && confirmOperation.job.tracking_number === "AUDIT-HUMAN-CONFIRMED-103",
      provider_success_survives_local_failure: applyUnknown === "unknown"
        && !!applyBefore?.trackingNumber && applyBefore.status === "UNKNOWN",
      operator_apply_existing: applyOperation.job.status === "SENT"
        && applyOperation.job.tracking_number === applyBefore?.trackingNumber,
      explicit_rejection_dead: rejectDead === "dead",
      operator_close_without_retry: closeOperation.job.status === "CLOSED",
    },
    fulfillment: {
      delivered_exactly_once: sentOrderIds.every((id) => deliveredById.get(id)?.status === 1)
        && deliveredById.get(IDS.reject)?.status === 0
        && new Set(sentOrderIds.map((id) => deliveredById.get(id)?.deliveryId)).size === 4,
      notification_outbox_exact: notices.length === 4
        && notices.every((row) => row.eventType === "order.delivery.notice"),
      replay_evidence_exact: replayRows.filter((row) => row.changeType === "waybill_delivery").length === 4,
      final_statuses: statusCounts,
    },
  };
}

export async function runOrderWaybillJobPostgresScenario(
  connectionString: string,
  strict = true,
): Promise<OrderWaybillJobPostgresReport> {
  const name = randomSchemaName();
  const schema = identifier(name);
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_waybill_audit_root",
  });
  let rootEnded = false;
  let scopedA: DbClient | undefined;
  let scopedB: DbClient | undefined;
  let created = false;
  let removed = false;
  let prefixCount = -1;
  let before: Fingerprint | undefined;
  let after: Fingerprint | undefined;
  let production: ProductionWaybillState | undefined;
  let scenario: Awaited<ReturnType<typeof runScenario>> | undefined;
  try {
    before = await publicFingerprint(root);
    production = await productionWaybillState(root);
    await setupSchema(root, name);
    created = true;
    await root.$client.end({ timeout: 1 });
    rootEnded = true;
    scopedA = createDbFromConnectionString(connectionString, 2, {
      searchPath: name,
      applicationName: "cinashop_waybill_audit_a",
    });
    scopedB = createDbFromConnectionString(connectionString, 1, {
      searchPath: name,
      applicationName: "cinashop_waybill_audit_b",
    });
    scenario = await runScenario(
      createContainerFromDb(scopedA),
      createContainerFromDb(scopedB),
      name,
    );
  } finally {
    await scopedA?.$client.end({ timeout: 1 }).catch(() => undefined);
    await scopedB?.$client.end({ timeout: 1 }).catch(() => undefined);
    if (!rootEnded) await root.$client.end({ timeout: 1 }).catch(() => undefined);
    const cleanup = createDbFromConnectionString(connectionString, 1, {
      applicationName: "cinashop_waybill_audit_cleanup",
    });
    try {
      if (created) {
        await cleanup.$client.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '3s'`;
          await tx`SET LOCAL statement_timeout = '30s'`;
          await tx.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        });
      }
      const state = (await cleanup.$client<{ removed: boolean; count: number }[]>`
        SELECT to_regnamespace(${name}) IS NULL AS removed,
          (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'codex_waybill_%') AS count
      `)[0];
      removed = state?.removed === true;
      prefixCount = state?.count ?? -1;
      after = await publicFingerprint(cleanup);
    } finally {
      await cleanup.$client.end({ timeout: 1 });
    }
  }
  assertCondition(production && scenario && before && after, "audit report missing");
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  if (strict) {
    assertCondition(Object.values(scenario.outbox).every(Boolean),
      `outbox contract diverged: ${JSON.stringify(scenario.outbox)}`);
    assertCondition(Object.values(scenario.queue).every(Boolean),
      `Queue contract diverged: ${JSON.stringify(scenario.queue)}`);
    assertCondition(
      scenario.provider.concurrent_single_issue
        && scenario.provider.https_protocol_and_direction_exact
        && scenario.provider.ambiguous_result_not_retried
        && scenario.provider.operator_retry_then_sent
        && scenario.provider.operator_confirm_issued
        && scenario.provider.provider_success_survives_local_failure
        && scenario.provider.operator_apply_existing
        && scenario.provider.explicit_rejection_dead
        && scenario.provider.operator_close_without_retry,
      `provider/operation contract diverged: ${JSON.stringify(scenario.provider)}`,
    );
    assertCondition(
      scenario.fulfillment.delivered_exactly_once
        && scenario.fulfillment.notification_outbox_exact
        && scenario.fulfillment.replay_evidence_exact
        && scenario.fulfillment.final_statuses.SENT === 4
        && scenario.fulfillment.final_statuses.CLOSED === 1,
      `fulfillment contract diverged: ${JSON.stringify(scenario.fulfillment)}`,
    );
    assertCondition(removed && prefixCount === 0 && unchanged,
      "cleanup or public fingerprint diverged");
  }
  return {
    server_version: production.server_version,
    schema_created: created,
    schema_removed: removed,
    temporary_schemas_after: prefixCount,
    public_state_unchanged: unchanged,
    production,
    ...scenario,
  };
}
