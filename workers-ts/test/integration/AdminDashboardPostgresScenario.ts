import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type DbClient,
} from "@/lib/di";
import { AdminDashboardService } from "@/services/admin/AdminDashboardService";

const FIXED_NOW = Math.floor(Date.parse("2026-08-27T04:00:00.000Z") / 1000);

interface PublicCounts {
  store_order: number;
  user: number;
  store_product_log: number;
}

export interface AdminDashboardPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_row_counts_unchanged: boolean;
  production: {
    rows: PublicCounts;
    header_cards: Array<{ title: string; today: string | number; total: string }>;
    current_30_day_orders: number;
    current_30_day_sales: number;
    active_user_segments: Record<string, number>;
  };
  isolated: {
    header_contract_exact: boolean;
    system_deleted_order_excluded: boolean;
    order_chart_exact: boolean;
    order_chart_zero_filled: boolean;
    user_chart_exact: boolean;
    deleted_user_excluded: boolean;
    deleted_visit_excluded: boolean;
    rank_contract_exact: boolean;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Admin dashboard integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function randomSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_dashboard_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

async function publicCounts(db: DbClient): Promise<PublicCounts> {
  const row = (await db.$client<PublicCounts[]>`
    SELECT
      (SELECT count(*)::int FROM public.store_order) AS store_order,
      (SELECT count(*)::int FROM public."user") AS "user",
      (SELECT count(*)::int FROM public.store_product_log) AS store_product_log
  `)[0];
  assertCondition(row, "public row counts returned no row");
  return row;
}

async function setupSchema(db: DbClient, name: string): Promise<void> {
  const schema = identifier(name);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    await tx.unsafe(`
      CREATE TABLE ${schema}.store_order (
        id integer PRIMARY KEY,
        pid integer NOT NULL DEFAULT 0,
        paid smallint NOT NULL DEFAULT 0,
        is_del smallint NOT NULL DEFAULT 0,
        is_system_del smallint NOT NULL DEFAULT 0,
        refund_status smallint NOT NULL DEFAULT 0,
        pay_price numeric(12,2) NOT NULL DEFAULT 0,
        pay_time integer NOT NULL DEFAULT 0,
        add_time integer NOT NULL DEFAULT 0
      );
      CREATE TABLE ${schema}."user" (
        uid integer PRIMARY KEY,
        add_time integer NOT NULL DEFAULT 0,
        pay_count integer NOT NULL DEFAULT 0,
        delete_time timestamptz
      );
      CREATE TABLE ${schema}.store_product_log (
        id integer PRIMARY KEY,
        type varchar(16) NOT NULL DEFAULT 'visit',
        add_time integer NOT NULL DEFAULT 0,
        delete_time timestamptz
      );
    `);

    const today = FIXED_NOW - 4 * 60 * 60;
    const yesterday = today - 86_400;
    await tx.unsafe(`
      INSERT INTO ${schema}.store_order
        (id, pid, paid, is_del, is_system_del, refund_status, pay_price, pay_time, add_time)
      VALUES
        (1, 0, 1, 0, 0, 0, 100.00, $1, $1),
        (2, 0, 1, 0, 0, 3,  50.00, $2, $2),
        (3, 1, 1, 0, 0, 0,  40.00, $3, $3),
        (4, 1, 1, 0, 0, 0,  20.00, $4, $4),
        (5, 0, 1, 0, 1, 0, 999.00, $1, $1),
        (6, 0, 1, 0, 0, 1, 999.00, $1, $1),
        (7, 0, 0, 0, 0, 0, 999.00, $1, $1),
        (8, 0, 1, 1, 0, 0, 999.00, $1, $1)
    `, [today + 3600, yesterday + 3600, today - 35 * 86_400, today - 10 * 86_400]);
    await tx.unsafe(`
      INSERT INTO ${schema}."user" (uid, add_time, pay_count, delete_time) VALUES
        (1, $1, 0, NULL),
        (2, $2, 1, NULL),
        (3, $3, 2, NULL),
        (4, $4, 5, NULL),
        (5, $1, 0, now())
    `, [today + 7200, yesterday + 7200, today - 10 * 86_400, today - 20 * 86_400]);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_product_log (id, type, add_time, delete_time) VALUES
        (1, 'visit', $1, NULL),
        (2, 'visit', $2, NULL),
        (3, 'visit', $3, NULL),
        (4, 'visit', $1, now()),
        (5, 'pay',   $1, NULL)
    `, [today + 1800, yesterday + 1800, today - 10 * 86_400]);
  });
}

async function temporarySchemaCount(db: DbClient): Promise<number> {
  return (await db.$client<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM pg_namespace
    WHERE nspname LIKE 'codex_dashboard_%'
  `)[0]?.count ?? 0;
}

export async function runAdminDashboardPostgresScenario(
  connectionString: string,
): Promise<AdminDashboardPostgresReport> {
  const root = createDbFromConnectionString(connectionString, 2, {
    searchPath: "public",
    applicationName: "cinashop_dashboard_audit_root",
  });
  const schemaName = randomSchemaName();
  let schemaCreated = false;
  let isolatedDb: DbClient | null = null;
  try {
    const before = await publicCounts(root);
    const productionService = new AdminDashboardService(createContainerFromDb(root));
    const [productionHeader, productionOrder, productionUser] = await Promise.all([
      productionService.header(),
      productionService.orderChart("thirtyday"),
      productionService.userChart(),
    ]);

    await setupSchema(root, schemaName);
    schemaCreated = true;
    isolatedDb = createDbFromConnectionString(connectionString, 2, {
      searchPath: schemaName,
      applicationName: "cinashop_dashboard_audit_isolated",
    });
    const isolatedContainer = createContainerFromDb(isolatedDb);
    const { service, header, order, users } = await withTx(isolatedContainer, async (tx) => {
      const transactionService = new AdminDashboardService(createContainerFromDb(tx));
      const transactionHeader = await transactionService.header(FIXED_NOW);
      const transactionOrder = await transactionService.orderChart("thirtyday", FIXED_NOW);
      const transactionUsers = await transactionService.userChart(FIXED_NOW);
      return {
        service: transactionService,
        header: transactionHeader,
        order: transactionOrder,
        users: transactionUsers,
      };
    });
    const byTitle = new Map(header.info.map((item) => [item.title, item]));
    const segmentValues = Object.fromEntries(users.bing_data.map((item) => [item.name, item.value]));
    const currentOrderSeries = order.series.find((item) => item.name === "订单数")?.data ?? [];

    const isolated = {
      header_contract_exact:
        header.info.length === 4 &&
        header.info.map((item) => item.title).join(",") === "销售额,用户访问量,订单量,新增用户",
      system_deleted_order_excluded:
        Number(byTitle.get("销售额")?.today) === 100 && Number(byTitle.get("订单量")?.today) === 1,
      order_chart_exact:
        order.cycle.count.data === 3 &&
        order.cycle.price.data === 170 &&
        order.pre_cycle.count.data === 1 &&
        order.pre_cycle.price.data === 40,
      order_chart_zero_filled:
        currentOrderSeries.length === 30 && currentOrderSeries.filter((value) => value === 0).length === 27,
      user_chart_exact:
        users.series.length === 30 && users.series.reduce((sum, value) => sum + value, 0) === 4,
      deleted_user_excluded:
        segmentValues["未消费用户"] === 1 && Object.values(segmentValues).reduce((sum, value) => sum + value, 0) === 4,
      deleted_visit_excluded:
        byTitle.get("用户访问量")?.today === 1 && byTitle.get("用户访问量")?.total === "3Pv",
      rank_contract_exact: service.purchaseRanking().list.length === 0,
    };
    for (const [key, value] of Object.entries(isolated)) {
      assertCondition(value, `${key}; header=${JSON.stringify(header)}; order=${JSON.stringify(order.cycle)}`);
    }

    await isolatedDb.$client.end({ timeout: 1 });
    isolatedDb = null;
    await root.$client.unsafe(`DROP SCHEMA ${identifier(schemaName)} CASCADE`);
    schemaCreated = false;
    const after = await publicCounts(root);
    const temporarySchemasAfter = await temporarySchemaCount(root);
    const publicUnchanged = JSON.stringify(before) === JSON.stringify(after);
    assertCondition(publicUnchanged, "public row counts changed");
    assertCondition(temporarySchemasAfter === 0, "temporary schema leaked");

    return {
      server_version: (await root.$client<{ version: string }[]>`
        SELECT current_setting('server_version') AS version
      `)[0]?.version ?? "",
      schema_created: true,
      schema_removed: true,
      temporary_schemas_after: temporarySchemasAfter,
      public_row_counts_unchanged: publicUnchanged,
      production: {
        rows: before,
        header_cards: productionHeader.info.map((item) => ({
          title: item.title,
          today: item.today,
          total: item.total,
        })),
        current_30_day_orders: productionOrder.cycle.count.data,
        current_30_day_sales: productionOrder.cycle.price.data,
        active_user_segments: Object.fromEntries(
          productionUser.bing_data.map((item) => [item.name, item.value]),
        ),
      },
      isolated,
    };
  } finally {
    if (isolatedDb) await isolatedDb.$client.end({ timeout: 1 }).catch(() => undefined);
    if (schemaCreated) {
      await root.$client.unsafe(`DROP SCHEMA IF EXISTS ${identifier(schemaName)} CASCADE`).catch(() => undefined);
    }
    await root.$client.end({ timeout: 1 });
  }
}
