import type { Env, OrderPrintJobMessage } from "@/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type Container,
  type DbClient,
} from "@/lib/di";
import {
  orderPrintJob,
  orderPrintJobAction,
  printDocument,
  storeOrder,
  storeOrderCartInfo,
  systemConfig,
} from "@/models/schema";
import { MigrationService } from "@/services/MigrationService";
import {
  enqueueAutomaticReceiptPrintJobs,
  ReceiptPrintJobService,
  type PrintJobActor,
} from "@/services/printing/ReceiptPrintJobService";

const CLONED_TABLES = [
  "print_document",
  "store_order",
  "store_order_cart_info",
  "system_config",
] as const;
const PUBLIC_TABLES = [
  ...CLONED_TABLES,
  "order_print_job",
  "order_print_job_action",
] as const;
const PUBLIC_SEQUENCES = PUBLIC_TABLES.map((table) => `${table}_id_seq`);
const IDS = {
  order: 1_930_000_101,
  foreignOrder: 1_930_000_102,
  platformPrinter: 1_930_001_101,
  supplierPrinter: 1_930_001_102,
  invalidPrinter: 1_930_001_103,
} as const;

interface Fingerprint {
  tables: Record<string, { exists: boolean; rows: string; digest: string }>;
  sequences: Record<string, string | null>;
}

export interface ProductionPrintState {
  server_version: string;
  printer_rows: number;
  enabled_rows: number;
  platform_rows: number;
  supplier_rows: number;
  yilian_rows: number;
  feie_rows: number;
  credential_complete_rows: number;
  print_job_table_exists: boolean;
  print_job_rows: number;
  print_action_rows: number;
  temporary_schemas: number;
}

export interface ProductionAuditSyntheticState {
  print_documents: number;
  orders: number;
  cart_snapshots: number;
  system_configs: number;
  print_jobs: number;
  print_actions: number;
  mismatched_rows: number;
  temporary_schemas: number;
}

export interface ReceiptPrintJobPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  production: ProductionPrintState;
  outbox: {
    automatic_created_exact: boolean;
    automatic_paid_exact: boolean;
    invalid_provider_skipped: boolean;
    automatic_replay_idempotent: boolean;
    manual_replay_idempotent: boolean;
    tenant_boundary_rejected: boolean;
    tenant_ledgers_exact: boolean;
  };
  queue: {
    references_only: boolean;
    provider_secrets_absent: boolean;
    rendered_order_absent: boolean;
  };
  provider: {
    concurrent_single_call: boolean;
    concurrent_results: string[];
    markup_injection_escaped: boolean;
    ambiguous_result_not_retried: boolean;
    operator_retry_then_sent: boolean;
    operator_confirm_sent: boolean;
    operator_close_without_retry: boolean;
    immutable_action_rows: number;
    final_statuses: Record<string, number>;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Receipt print integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function randomSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_receipt_print_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
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
    const name = identifier(table);
    const rows = await db.$client.unsafe<Array<{ rows: string; digest: string }>>(
      `SELECT count(*)::text AS rows,
        md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')) AS digest
       FROM public.${name} t WHERE random() >= 0`,
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

export async function productionReceiptPrintState(db: DbClient): Promise<ProductionPrintState> {
  const state = (await db.$client<{
    server_version: string;
    printer_rows: number;
    enabled_rows: number;
    platform_rows: number;
    supplier_rows: number;
    yilian_rows: number;
    feie_rows: number;
    credential_complete_rows: number;
    print_job_table_exists: boolean;
    temporary_schemas: number;
  }[]>`
    SELECT current_setting('server_version') AS server_version,
      count(*)::int AS printer_rows,
      count(*) FILTER (WHERE status = 1 AND is_del = 0)::int AS enabled_rows,
      count(*) FILTER (WHERE supplier_id = 0 AND is_del = 0)::int AS platform_rows,
      count(*) FILTER (WHERE supplier_id > 0 AND is_del = 0)::int AS supplier_rows,
      count(*) FILTER (WHERE type = 1 AND is_del = 0)::int AS yilian_rows,
      count(*) FILTER (WHERE type = 2 AND is_del = 0)::int AS feie_rows,
      count(*) FILTER (WHERE is_del = 0 AND times > 0 AND (
        (type = 1 AND yly_user_id <> '' AND yly_app_id <> '' AND yly_app_secret <> '' AND yly_sn <> '')
        OR (type = 2 AND fey_user <> '' AND fey_ukey <> '' AND fey_sn <> '')
      ))::int AS credential_complete_rows,
      to_regclass('public.order_print_job') IS NOT NULL AS print_job_table_exists,
      (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'codex_receipt_print_%')
        AS temporary_schemas
    FROM public.print_document
  `)[0];
  assertCondition(state, "production printer state returned no row");
  let printJobRows = 0;
  let printActionRows = 0;
  if (state.print_job_table_exists) {
    const jobState = (await db.$client.unsafe<Array<{ jobs: number; actions: number }>>(`
      SELECT (SELECT count(*)::int FROM public.order_print_job) AS jobs,
        CASE WHEN to_regclass('public.order_print_job_action') IS NULL THEN 0
          ELSE (SELECT count(*)::int FROM public.order_print_job_action) END AS actions
    `))[0];
    printJobRows = jobState?.jobs ?? 0;
    printActionRows = jobState?.actions ?? 0;
  }
  return { ...state, print_job_rows: printJobRows, print_action_rows: printActionRows };
}

export async function productionAuditSyntheticState(
  db: DbClient,
): Promise<ProductionAuditSyntheticState> {
  const base = (await db.$client<{
    print_documents: number;
    orders: number;
    cart_snapshots: number;
    system_configs: number;
    mismatched_rows: number;
    temporary_schemas: number;
    jobs_exist: boolean;
  }[]>`
    SELECT
      (SELECT count(*)::int FROM public.print_document
        WHERE id IN (${IDS.platformPrinter}, ${IDS.supplierPrinter}, ${IDS.invalidPrinter})) AS print_documents,
      (SELECT count(*)::int FROM public.store_order
        WHERE id IN (${IDS.order}, ${IDS.foreignOrder})) AS orders,
      (SELECT count(*)::int FROM public.store_order_cart_info
        WHERE id IN (1930002101, 1930002102)) AS cart_snapshots,
      (SELECT count(*)::int FROM public.system_config
        WHERE id IN (1930003101, 1930003102)) AS system_configs,
      (
        (SELECT count(*) FROM public.print_document WHERE
          (id = ${IDS.platformPrinter} AND print_name <> '隔离平台打印机') OR
          (id = ${IDS.supplierPrinter} AND print_name <> '隔离供应商打印机') OR
          (id = ${IDS.invalidPrinter} AND print_name <> '隔离无效旧平台打印机'))
        + (SELECT count(*) FROM public.store_order WHERE
          (id = ${IDS.order} AND order_id <> 'audit-print-order-101') OR
          (id = ${IDS.foreignOrder} AND order_id <> 'audit-print-order-foreign'))
        + (SELECT count(*) FROM public.store_order_cart_info WHERE
          id IN (1930002101, 1930002102) AND "unique" NOT LIKE 'audit-cart-snapshot-%')
        + (SELECT count(*) FROM public.system_config WHERE
          id IN (1930003101, 1930003102) AND menu_name NOT IN ('site_name', 'site_url'))
      )::int AS mismatched_rows,
      (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'codex_receipt_print_%')
        AS temporary_schemas,
      to_regclass('public.order_print_job') IS NOT NULL AS jobs_exist
  `)[0];
  assertCondition(base, "synthetic-row state returned no row");
  let printJobs = 0;
  let printActions = 0;
  if (base.jobs_exist) {
    const jobs = (await db.$client.unsafe<Array<{ jobs: number; actions: number }>>(`
      SELECT count(*)::int AS jobs,
        CASE WHEN to_regclass('public.order_print_job_action') IS NULL THEN 0 ELSE (
          SELECT count(*)::int FROM public.order_print_job_action
          WHERE job_id IN (SELECT id FROM public.order_print_job
            WHERE order_id IN (${IDS.order}, ${IDS.foreignOrder})
              OR printer_id IN (${IDS.platformPrinter}, ${IDS.supplierPrinter}, ${IDS.invalidPrinter}))
        ) END AS actions
      FROM public.order_print_job
      WHERE order_id IN (${IDS.order}, ${IDS.foreignOrder})
        OR printer_id IN (${IDS.platformPrinter}, ${IDS.supplierPrinter}, ${IDS.invalidPrinter})
    `))[0];
    printJobs = jobs?.jobs ?? 0;
    printActions = jobs?.actions ?? 0;
  }
  const { jobs_exist: _jobsExist, ...state } = base;
  return { ...state, print_jobs: printJobs, print_actions: printActions };
}

export async function cleanupProductionAuditSyntheticRows(db: DbClient) {
  const before = await productionAuditSyntheticState(db);
  assertCondition(before.mismatched_rows === 0, "synthetic IDs collide with non-audit production rows");
  const jobTableExists = (await db.$client<{ exists: boolean }[]>`
    SELECT to_regclass('public.order_print_job') IS NOT NULL AS exists
  `)[0]?.exists === true;
  const actionTableExists = (await db.$client<{ exists: boolean }[]>`
    SELECT to_regclass('public.order_print_job_action') IS NOT NULL AS exists
  `)[0]?.exists === true;
  const deleted = await db.$client.begin(async (tx) => {
    await tx`SET LOCAL search_path TO public`;
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    let actions: Array<{ id: number }> = [];
    let jobs: Array<{ id: number }> = [];
    if (jobTableExists) {
      if (actionTableExists) {
        actions = await tx.unsafe<Array<{ id: number }>>(`
          DELETE FROM public.order_print_job_action
          WHERE job_id IN (SELECT id FROM public.order_print_job
            WHERE order_id IN (${IDS.order}, ${IDS.foreignOrder})
              OR printer_id IN (${IDS.platformPrinter}, ${IDS.supplierPrinter}, ${IDS.invalidPrinter}))
          RETURNING id
        `);
      }
      jobs = await tx.unsafe<Array<{ id: number }>>(`
        DELETE FROM public.order_print_job
        WHERE order_id IN (${IDS.order}, ${IDS.foreignOrder})
          OR printer_id IN (${IDS.platformPrinter}, ${IDS.supplierPrinter}, ${IDS.invalidPrinter})
        RETURNING id
      `);
    }
    const carts = await tx<{ id: number }[]>`
      DELETE FROM public.store_order_cart_info
      WHERE id IN (1930002101, 1930002102) AND "unique" LIKE 'audit-cart-snapshot-%'
      RETURNING id
    `;
    const orders = await tx<{ id: number }[]>`
      DELETE FROM public.store_order
      WHERE (id = ${IDS.order} AND order_id = 'audit-print-order-101')
        OR (id = ${IDS.foreignOrder} AND order_id = 'audit-print-order-foreign')
      RETURNING id
    `;
    const printers = await tx<{ id: number }[]>`
      DELETE FROM public.print_document
      WHERE (id = ${IDS.platformPrinter} AND print_name = '隔离平台打印机')
        OR (id = ${IDS.supplierPrinter} AND print_name = '隔离供应商打印机')
        OR (id = ${IDS.invalidPrinter} AND print_name = '隔离无效旧平台打印机')
      RETURNING id
    `;
    const configs = await tx<{ id: number }[]>`
      DELETE FROM public.system_config
      WHERE id IN (1930003101, 1930003102) AND menu_name IN ('site_name', 'site_url')
      RETURNING id
    `;
    return {
      print_actions: actions.length,
      print_jobs: jobs.length,
      cart_snapshots: carts.length,
      orders: orders.length,
      print_documents: printers.length,
      system_configs: configs.length,
    };
  });
  const after = await productionAuditSyntheticState(db);
  assertCondition(
    after.print_documents === 0 && after.orders === 0 && after.cart_snapshots === 0
      && after.system_configs === 0 && after.print_jobs === 0 && after.print_actions === 0,
    "synthetic production cleanup did not converge",
  );
  return { before, deleted, after };
}

async function setupSchema(root: DbClient, name: string): Promise<void> {
  const schema = identifier(name);
  const migration = new MigrationService(createContainerFromDb(root))
    .receiptPrintJobMigrationSqlForVerification();
  await root.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of CLONED_TABLES) {
      const tableName = identifier(table);
      await tx.unsafe(`CREATE TABLE ${schema}.${tableName} (LIKE public.${tableName} INCLUDING ALL)`);
    }
    await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
    await tx.unsafe(migration);
  });
}

function contentConfig(): string {
  return JSON.stringify({
    header: true,
    delivery: true,
    buyer_remarks: true,
    goods: [0, 1],
    freight: true,
    preferential: true,
    pay: [0, 1],
    order: [0, 1, 2, 3],
    code: false,
    code_url: "",
    show_notice: true,
    notice_content: "生产隔离审计，不会真实出纸",
  });
}

async function seed(container: Container, now: number): Promise<void> {
  await container.db.insert(printDocument).values([
    {
      id: IDS.platformPrinter,
      type: 2,
      supplierId: 0,
      printName: "隔离平台打印机",
      feyUser: "audit-platform-user",
      feyUkey: "audit-platform-secret",
      feySn: "audit-platform-sn",
      times: 1,
      printType: 2,
      printContent: contentConfig(),
      status: 1,
      isDel: 0,
      addTime: now,
    },
    {
      id: IDS.supplierPrinter,
      type: 2,
      supplierId: 101,
      printName: "隔离供应商打印机",
      feyUser: "audit-supplier-user",
      feyUkey: "audit-supplier-secret",
      feySn: "audit-supplier-sn",
      times: 1,
      printType: 1,
      printContent: contentConfig(),
      status: 1,
      isDel: 0,
      addTime: now,
    },
    {
      id: IDS.invalidPrinter,
      type: 9,
      supplierId: 0,
      printName: "隔离无效旧平台打印机",
      feyUser: "invalid-user",
      feyUkey: "invalid-secret",
      feySn: "invalid-sn",
      times: 1,
      printType: 2,
      printContent: contentConfig(),
      status: 1,
      isDel: 0,
      addTime: now,
    },
  ]);
  await container.db.insert(storeOrder).values([
    {
      id: IDS.order,
      orderId: "audit-print-order-101",
      supplierId: 101,
      uid: 1_930_100_101,
      unique: "audit-print-unique-101",
      realName: "审计＜用户＞",
      userPhone: "000-0000-0101",
      userAddress: "隔离地址 </CB><CB>INJECT",
      mark: "备注 <QR>INJECT</QR>",
      shippingType: 1,
      totalPrice: "20.00",
      payPostage: "2.00",
      deductionPrice: "1.00",
      payPrice: "21.00",
      paid: 1,
      payType: "weixin",
      addTime: now - 60,
      payTime: now - 30,
    },
    {
      id: IDS.foreignOrder,
      orderId: "audit-print-order-foreign",
      supplierId: 202,
      uid: 1_930_100_102,
      unique: "audit-print-unique-102",
      paid: 1,
      addTime: now - 60,
      payTime: now - 30,
    },
  ]);
  await container.db.insert(storeOrderCartInfo).values([
    {
      id: 1_930_002_101,
      uid: 1_930_100_101,
      oid: IDS.order,
      cartId: "audit-cart-101",
      cartNum: 2,
      cartInfo: JSON.stringify({
        product: { storeName: "商品 </CB><CB>INJECT" },
        sku: { suk: "规格 <QR>INJECT", code: "SKU-101", price: "10.00" },
      }),
      unique: "audit-cart-snapshot-101",
      addTime: now - 60,
    },
    {
      id: 1_930_002_102,
      uid: 1_930_100_102,
      oid: IDS.foreignOrder,
      cartId: "audit-cart-102",
      cartNum: 1,
      cartInfo: JSON.stringify({ product: { storeName: "外部租户商品" }, sku: { price: "1.00" } }),
      unique: "audit-cart-snapshot-102",
      addTime: now - 60,
    },
  ]);
  await container.db.insert(systemConfig).values([
    { id: 1_930_003_101, menuName: "site_name", value: "CinaShop 隔离审计", isStore: 0, sort: 1 },
    { id: 1_930_003_102, menuName: "site_url", value: "https://audit.invalid", isStore: 0, sort: 1 },
  ]);
}

async function runScenario(containerA: Container, containerB: Container) {
  const messages: OrderPrintJobMessage[] = [];
  const queue = {
    async sendBatch(batch: Array<{ body: OrderPrintJobMessage }>) {
      messages.push(...batch.map((entry) => structuredClone(entry.body)));
    },
  } as unknown as Env["ORDER_QUEUE"];
  const env = { ORDER_QUEUE: queue } as Env;
  const serviceA = new ReceiptPrintJobService(containerA, env);
  const serviceB = new ReceiptPrintJobService(containerB, env);
  const now = Math.floor(Date.now() / 1_000);
  await withTx(containerA, (tx) => seed(createContainerFromDb(tx), now));

  const automaticOrder = { id: IDS.order, orderId: "audit-print-order-101", supplierId: 101 };
  const createdFirst = await withTx(containerA, (tx) =>
    enqueueAutomaticReceiptPrintJobs(tx, [automaticOrder], "created", now));
  const createdReplay = await withTx(containerA, (tx) =>
    enqueueAutomaticReceiptPrintJobs(tx, [automaticOrder], "created", now));
  const paidFirst = await withTx(containerA, (tx) =>
    enqueueAutomaticReceiptPrintJobs(tx, [automaticOrder], "paid", now));
  const paidReplay = await withTx(containerA, (tx) =>
    enqueueAutomaticReceiptPrintJobs(tx, [automaticOrder], "paid", now));
  await serviceA.dispatchPending(100);

  const admin: PrintJobActor = { supplierId: 0, actorType: "admin", actorId: 901 };
  const supplier: PrintJobActor = { supplierId: 101, actorType: "supplier", actorId: 902 };
  const adminRequest = crypto.randomUUID();
  const supplierRequest = crypto.randomUUID();
  const adminManual = await serviceA.createManualJobs(IDS.order, admin, {
    requestKey: adminRequest,
    printerId: IDS.platformPrinter,
  });
  const supplierManual = await serviceA.createManualJobs(IDS.order, supplier, {
    requestKey: supplierRequest,
    printerId: IDS.supplierPrinter,
  });
  const supplierReplay = await serviceA.createManualJobs(IDS.order, supplier, {
    requestKey: supplierRequest,
    printerId: IDS.supplierPrinter,
  });
  let tenantBoundaryRejected = false;
  try {
    await serviceA.createManualJobs(IDS.foreignOrder, supplier, {
      requestKey: crypto.randomUUID(),
      printerId: IDS.supplierPrinter,
    });
  } catch {
    tenantBoundaryRejected = true;
  }

  const findMessage = (jobId: number) => {
    const message = [...messages].reverse().find((candidate) => candidate.printJobId === jobId);
    assertCondition(message, `Queue message missing for job ${jobId}`);
    return message;
  };
  const jobs = await withTx(containerA, (tx) => tx.select().from(orderPrintJob));
  const createdJob = jobs.find((job) => job.eventKey.startsWith("order.print.created:"));
  const paidJob = jobs.find((job) => job.eventKey.startsWith("order.print.paid:"));
  assertCondition(createdJob && paidJob, "automatic jobs missing");

  let successCalls = 0;
  let markupInjectionEscaped = false;
  const successFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    successCalls += 1;
    assertCondition(String(input) === "https://api.feieyun.cn/Api/Open/printMsg", "unexpected provider URL");
    const form = init?.body instanceof URLSearchParams
      ? init.body
      : new URLSearchParams(String(init?.body ?? ""));
    const content = form.get("content") ?? "";
    markupInjectionEscaped = markupInjectionEscaped || (
      !content.includes("</CB><CB>INJECT")
      && !content.includes("<QR>INJECT</QR>")
      && content.includes("＜/CB＞＜CB＞INJECT")
    );
    return Response.json({ ret: 0, msg: "ok", data: `audit-provider-${successCalls}` });
  }) as typeof fetch;
  const beforeConcurrentCalls = successCalls;
  const concurrentResults = await Promise.all([
    serviceA.processMessage(findMessage(createdJob.id), successFetch),
    serviceB.processMessage(findMessage(createdJob.id), successFetch),
  ]);
  const concurrentSingleCall = successCalls - beforeConcurrentCalls === 1
    && concurrentResults.includes("sent")
    && (concurrentResults.includes("busy") || concurrentResults.includes("already-sent"));

  let ambiguousCalls = 0;
  const ambiguousFetch = (async () => {
    ambiguousCalls += 1;
    throw new Error("audit_transport_ambiguous_after_submit");
  }) as typeof fetch;
  const paidUnknown = await serviceA.processMessage(findMessage(paidJob.id), ambiguousFetch);
  const ambiguousResultNotRetried = paidUnknown === "unknown" && ambiguousCalls === 1;
  const retryOperation = await serviceA.confirmRetry(paidJob.id, supplier, {
    requestKey: crypto.randomUUID(),
    reason: "生产隔离审计确认人工重发",
  });
  const retryResult = await serviceA.processMessage(findMessage(paidJob.id), successFetch);

  const adminJobId = adminManual.jobs[0]?.id;
  const supplierJobId = supplierManual.jobs[0]?.id;
  assertCondition(adminJobId && supplierJobId, "manual jobs missing");
  const adminUnknown = await serviceA.processMessage(findMessage(adminJobId), ambiguousFetch);
  const closeOperation = await serviceA.closeWithoutRetry(adminJobId, admin, {
    requestKey: crypto.randomUUID(),
    reason: "生产隔离审计关闭不再重发",
  });
  const supplierUnknown = await serviceA.processMessage(findMessage(supplierJobId), ambiguousFetch);
  const sentOperation = await serviceA.confirmSent(supplierJobId, supplier, {
    requestKey: crypto.randomUUID(),
    reason: "生产隔离审计人工确认已出纸",
    providerReference: "audit-human-reference",
  });

  const [adminLedger, supplierLedger, finalJobs, actions] = await Promise.all([
    serviceA.listJobs(admin, { limit: 100 }),
    serviceA.listJobs(supplier, { limit: 100 }),
    withTx(containerA, (tx) => tx.select().from(orderPrintJob)),
    withTx(containerA, (tx) => tx.select().from(orderPrintJobAction)),
  ]);
  const statusCounts: Record<string, number> = {};
  for (const job of finalJobs) statusCounts[job.status] = (statusCounts[job.status] ?? 0) + 1;
  const queueJson = JSON.stringify(messages);
  const referencesOnly = messages.every((message) => {
    const keys = Object.keys(message).sort();
    return JSON.stringify(keys) === JSON.stringify(["action", "eventKey", "printJobId"])
      && message.action === "processOrderPrintJob";
  });

  return {
    outbox: {
      automatic_created_exact: createdFirst === 1,
      automatic_paid_exact: paidFirst === 1,
      invalid_provider_skipped: finalJobs.filter((job) => job.trigger === "created").length === 1,
      automatic_replay_idempotent: createdReplay === 0 && paidReplay === 0,
      manual_replay_idempotent: !adminManual.duplicate && !supplierManual.duplicate
        && supplierReplay.duplicate && supplierReplay.jobs[0]?.id === supplierJobId,
      tenant_boundary_rejected: tenantBoundaryRejected,
      tenant_ledgers_exact: adminLedger.list.length === 2 && supplierLedger.list.length === 2
        && adminLedger.list.every((job) => job.supplier_id === 0)
        && supplierLedger.list.every((job) => job.supplier_id === 101),
    },
    queue: {
      references_only: referencesOnly,
      provider_secrets_absent: !queueJson.includes("audit-platform-secret")
        && !queueJson.includes("audit-supplier-secret"),
      rendered_order_absent: !queueJson.includes("000-0000-0101")
        && !queueJson.includes("INJECT") && !queueJson.includes("商品"),
    },
    provider: {
      concurrent_single_call: concurrentSingleCall,
      concurrent_results: [...concurrentResults].sort(),
      markup_injection_escaped: markupInjectionEscaped,
      ambiguous_result_not_retried: ambiguousResultNotRetried,
      operator_retry_then_sent: !retryOperation.duplicate && retryResult === "sent",
      operator_confirm_sent: supplierUnknown === "unknown" && sentOperation.job.status === "SENT",
      operator_close_without_retry: adminUnknown === "unknown" && closeOperation.job.status === "CLOSED",
      immutable_action_rows: actions.length,
      final_statuses: statusCounts,
    },
  };
}

export async function runReceiptPrintJobPostgresScenario(
  connectionString: string,
  strict = true,
): Promise<ReceiptPrintJobPostgresReport> {
  const name = randomSchemaName();
  const schema = identifier(name);
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_receipt_print_audit_root",
  });
  let rootEnded = false;
  let scopedA: DbClient | undefined;
  let scopedB: DbClient | undefined;
  let created = false;
  let removed = false;
  let prefixCount = -1;
  let before: Fingerprint | undefined;
  let after: Fingerprint | undefined;
  let production: ProductionPrintState | undefined;
  let scenario: Awaited<ReturnType<typeof runScenario>> | undefined;
  try {
    before = await publicFingerprint(root);
    production = await productionReceiptPrintState(root);
    await setupSchema(root, name);
    created = true;
    await root.$client.end({ timeout: 1 });
    rootEnded = true;
    scopedA = createDbFromConnectionString(connectionString, 2, {
      searchPath: name,
      applicationName: "cinashop_receipt_print_audit_a",
    });
    scopedB = createDbFromConnectionString(connectionString, 1, {
      searchPath: name,
      applicationName: "cinashop_receipt_print_audit_b",
    });
    scenario = await runScenario(createContainerFromDb(scopedA), createContainerFromDb(scopedB));
  } finally {
    await scopedA?.$client.end({ timeout: 1 }).catch(() => undefined);
    await scopedB?.$client.end({ timeout: 1 }).catch(() => undefined);
    if (!rootEnded) await root.$client.end({ timeout: 1 }).catch(() => undefined);
    const cleanup = createDbFromConnectionString(connectionString, 1, {
      applicationName: "cinashop_receipt_print_audit_cleanup",
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
          (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'codex_receipt_print_%') AS count
      `)[0];
      removed = state?.removed === true;
      prefixCount = state?.count ?? -1;
      after = await publicFingerprint(cleanup);
    } finally {
      await cleanup.$client.end({ timeout: 1 });
    }
  }
  assertCondition(production && scenario, "audit report missing");
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  if (strict) {
    assertCondition(Object.values(scenario.outbox).every(Boolean), `outbox contract diverged: ${JSON.stringify(scenario.outbox)}`);
    assertCondition(Object.values(scenario.queue).every(Boolean), `Queue contract diverged: ${JSON.stringify(scenario.queue)}`);
    assertCondition(
      scenario.provider.concurrent_single_call && scenario.provider.markup_injection_escaped
        && scenario.provider.ambiguous_result_not_retried
        && scenario.provider.operator_retry_then_sent && scenario.provider.operator_confirm_sent
        && scenario.provider.operator_close_without_retry && scenario.provider.immutable_action_rows === 3
        && scenario.provider.final_statuses.SENT === 3 && scenario.provider.final_statuses.CLOSED === 1,
      `provider/operation contract diverged: ${JSON.stringify(scenario.provider)}`,
    );
    assertCondition(removed && prefixCount === 0 && unchanged, "cleanup or public fingerprint diverged");
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
