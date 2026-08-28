import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/models/schema";
import { createContainerFromDb, createDbFromConnectionString, type DbClient } from "@/lib/di";
import { UserFinanceService } from "@/services/user/UserFinanceService";
import { UserBehaviorService } from "@/services/user/UserBehaviorService";
import { StoreOrderInvoiceService } from "@/services/order/StoreOrderInvoiceService";
import { ReplyService } from "@/services/product/ReplyService";
import { ValidateException } from "@/utils/errors";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

async function authorize(request: Request, expected: string): Promise<boolean> {
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied));
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function transactionDb(tx: unknown, options: unknown): DbClient {
  const client = tx as { options?: unknown };
  if (!client.options) client.options = options;
  return drizzle(tx as never, { schema }) as unknown as DbClient;
}

async function readState(connectionString: string) {
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_api004_read_audit" },
  });
  try {
    return await sql.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const state = await tx<Array<Record<string, unknown>>>`
        SELECT
          current_setting('server_version') AS server_version,
          (SELECT count(*)::integer FROM user_invoice) AS user_invoices,
          (SELECT count(*)::integer FROM user_invoice WHERE is_del = 0) AS active_user_invoices,
          (SELECT count(*)::integer FROM store_order_invoice) AS order_invoices,
          (SELECT count(*)::integer FROM user_search WHERE is_del = 0) AS active_search_rows,
          (SELECT count(*)::integer FROM store_service_log) AS service_messages,
          (SELECT count(*)::integer FROM agent_level WHERE is_del = 0 AND status = 1) AS active_agent_levels,
          (SELECT count(*)::integer FROM agent_level_task WHERE is_del = 0 AND status = 1) AS active_agent_tasks,
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_api004_%') AS temporary_schemas,
          (SELECT count(*)::integer FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'user_invoice') AS invoice_indexes,
          (SELECT COALESCE(jsonb_agg(indexname ORDER BY indexname), '[]'::jsonb)
             FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'user_invoice') AS invoice_index_names
      `;
      const listPlan = await tx<Array<{ "QUERY PLAN": unknown }>>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT * FROM user_invoice
        WHERE uid = -1 AND is_del = 0
        ORDER BY is_default DESC, id DESC
        LIMIT 10
      `;
      return {
        transaction: "READ ONLY",
        state: state[0],
        invoice_list_plan: listPlan[0]?.["QUERY PLAN"] ?? null,
      };
    });
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function readContracts(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api004_contract_audit",
  });
  try {
    return await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const scoped = transactionDb(tx, db.$client.options);
      const container = createContainerFromDb(scoped);
      const users = await tx<Array<{ uid: number }>>`SELECT uid FROM "user" WHERE is_del = 0 ORDER BY uid LIMIT 1`;
      const products = await tx<Array<{ id: number }>>`
        SELECT id FROM store_product WHERE is_show = 1 AND is_del = 0 AND is_verify = 1 ORDER BY id LIMIT 1
      `;
      const uid = users[0]?.uid ?? 0;
      const productId = products[0]?.id ?? 0;
      const finance = new UserFinanceService(container);
      const behavior = new UserBehaviorService(container);
      const orderInvoices = new StoreOrderInvoiceService(container);
      const replies = new ReplyService(container);
      const [invoiceList, searchList, orderInvoiceList, replyList] = await Promise.all([
        uid ? finance.invoiceListLegacy(uid, { page: 1, limit: 10 }) : Promise.resolve([]),
        uid ? behavior.searchHistory(uid, 1, 10) : Promise.resolve([]),
        uid ? orderInvoices.list(uid, 1, 10) : Promise.resolve([]),
        productId ? replies.replyList(productId, 1, 10, uid, 0) : Promise.resolve([]),
      ]);
      return {
        transaction: "READ ONLY",
        assertions: {
          invoice_contract: Array.isArray(invoiceList),
          search_contract: Array.isArray(searchList),
          order_invoice_contract: Array.isArray(orderInvoiceList),
          reply_contract: Array.isArray(replyList),
        },
        counts: {
          invoices: invoiceList.length,
          searches: searchList.length,
          order_invoices: orderInvoiceList.length,
          replies: replyList.length,
        },
        invoice_keys: invoiceList[0] ? Object.keys(invoiceList[0]).sort() : [],
      };
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

async function isolatedScenario(connectionString: string) {
  const suffix = `${Date.now()}_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const schemaName = `codex_api004_${suffix}`;
  if (!/^codex_api004_[a-z0-9_]+$/.test(schemaName)) throw new Error("unsafe audit schema");
  const setupDb = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api004_schema_audit",
  });
  let schemaCreated = false;
  let assertions: Record<string, boolean> = {};
  let before: { rows: number; temporary_schemas: number } | undefined;
  let scenarioError: unknown;
  try {
    before = (await setupDb.$client<Array<{ rows: number; temporary_schemas: number }>>`
      SELECT
        (SELECT count(*)::integer FROM public.user_invoice) AS rows,
        (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_api004_%') AS temporary_schemas
    `)[0];
    await setupDb.$client.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '40s'`;
      await tx.unsafe(`CREATE SCHEMA "${schemaName}"`);
      await tx.unsafe(`CREATE TABLE "${schemaName}"."user_invoice" (LIKE public."user_invoice" INCLUDING ALL)`);
      await tx.unsafe(`CREATE SEQUENCE "${schemaName}"."user_invoice_id_seq" START WITH 9100 OWNED BY "${schemaName}"."user_invoice"."id"`);
      await tx.unsafe(`ALTER TABLE "${schemaName}"."user_invoice" ALTER COLUMN "id" SET DEFAULT nextval('"${schemaName}"."user_invoice_id_seq"'::regclass)`);
    });
    schemaCreated = true;

    const scopedDb = createDbFromConnectionString(connectionString, 1, {
      applicationName: "cinashop_api004_isolated_audit",
      searchPath: schemaName,
    });
    try {
      const container = createContainerFromDb(scopedDb);
      const service = new UserFinanceService(container);
      const created = await service.invoiceSave(101, {
        headerType: 1,
        type: 1,
        name: "审计用户",
        dutyNumber: "",
        drawerPhone: "13800138000",
        email: "audit@example.test",
        isDefault: 1,
      });
      const [list, detail, foreignDetail, defaultInvoice] = await setupDb.$client.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
        await tx`SET TRANSACTION READ ONLY`;
        const readService = new UserFinanceService(
          createContainerFromDb(transactionDb(tx, setupDb.$client.options)),
        );
        return Promise.all([
          readService.invoiceListLegacy(101, { page: 1, limit: 10 }),
          readService.invoiceDetailLegacy(101, created.id),
          readService.invoiceDetailLegacy(102, created.id),
          readService.getDefaultLegacy(101, 1),
        ]);
      });
      let duplicateRejected = false;
      try {
        await service.invoiceSave(101, {
          headerType: 1,
          type: 1,
          name: "审计用户",
          dutyNumber: "",
          drawerPhone: "13800138000",
        });
      } catch (error) {
        duplicateRejected = error instanceof ValidateException && error.message === "该发票已经存在";
      }
      await service.invoiceDel(101, created.id);
      const afterDelete = await setupDb.$client.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
        await tx`SET TRANSACTION READ ONLY`;
        return new UserFinanceService(
          createContainerFromDb(transactionDb(tx, setupDb.$client.options)),
        ).invoiceListLegacy(101, { page: 1, limit: 10 });
      });
      assertions = {
        created: created.created && created.id >= 9100,
        snake_case: list[0]?.drawer_phone === "13800138000" && !("drawerPhone" in (list[0] ?? {})),
        ownership: detail?.uid === 101 && foreignDetail === null,
        default_scope: defaultInvoice?.id === created.id && defaultInvoice.is_default === 1,
        duplicate_rejected: duplicateRejected,
        soft_delete: afterDelete.length === 0,
      };
      if (Object.values(assertions).some((value) => !value)) {
        throw new Error(`isolated assertions failed: ${JSON.stringify(assertions)}`);
      }
    } finally {
      await scopedDb.$client.end({ timeout: 1 });
    }
  } catch (error) {
    scenarioError = error;
  } finally {
    if (schemaCreated) {
      await setupDb.$client.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '5s'`;
        await tx`SET LOCAL statement_timeout = '20s'`;
        await tx.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      });
    }
  }
  if (scenarioError) {
    await setupDb.$client.end({ timeout: 1 });
    throw scenarioError;
  }
  const after = (await setupDb.$client<Array<{ rows: number; temporary_schemas: number }>>`
    SELECT
      (SELECT count(*)::integer FROM public.user_invoice) AS rows,
      (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_api004_%') AS temporary_schemas
  `)[0];
  await setupDb.$client.end({ timeout: 1 });
  const publicStateUnchanged = before?.rows === after?.rows;
  if (!publicStateUnchanged || after?.temporary_schemas !== before?.temporary_schemas) {
    throw new Error("public state or temporary schema count changed");
  }
  return {
    schema: schemaName,
    assertions,
    cleanup: "dropped",
    public_state_unchanged: publicStateUnchanged,
    temporary_schemas_before: before?.temporary_schemas,
    temporary_schemas_after: after?.temporary_schemas,
  };
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (request.method !== "POST" || !["/state", "/contracts", "/isolated"].includes(path)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    try {
      const result = path === "/state"
        ? await readState(env.HYPERDRIVE.connectionString)
        : path === "/contracts"
          ? await readContracts(env.HYPERDRIVE.connectionString)
          : await isolatedScenario(env.HYPERDRIVE.connectionString);
      return Response.json(result);
    } catch (error) {
      console.error(JSON.stringify({
        event: "api004_audit_failed",
        error: error instanceof Error ? error.name : "unknown",
      }));
      return Response.json(
        { error: error instanceof Error ? error.message : "unknown audit error" },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
