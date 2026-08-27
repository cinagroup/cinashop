import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type DbClient,
} from "@/lib/di";
import {
  AdminStatisticService,
  parseAdminStatisticRange,
  type AdminOrderBasic,
} from "@/services/admin/AdminStatisticService";

const FIXED_NOW = Math.floor(Date.parse("2026-08-27T04:00:00.000Z") / 1000);
const epoch = (value: string) => Math.floor(Date.parse(value) / 1000);

interface PublicCounts {
  store_order: number;
  store_visit: number;
  store_cart: number;
  store_order_refund: number;
  store_product_log: number;
  store_product: number;
  store_product_relation: number;
  user: number;
}

export interface AdminStatisticPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_row_counts_unchanged: boolean;
  production: {
    rows: PublicCounts;
    order_basic_30d: AdminOrderBasic;
    product_basic_30d: { browse: number; payPrice: number; payPercent: number };
    product_ranking_rows_30d: number;
  };
  isolated: Record<string, boolean>;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Admin statistic integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function randomSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_statistic_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

async function publicCounts(db: DbClient): Promise<PublicCounts> {
  const row = (await db.$client<PublicCounts[]>`
    SELECT
      (SELECT count(*)::int FROM public.store_order) AS store_order,
      (SELECT count(*)::int FROM public.store_visit) AS store_visit,
      (SELECT count(*)::int FROM public.store_cart) AS store_cart,
      (SELECT count(*)::int FROM public.store_order_refund) AS store_order_refund,
      (SELECT count(*)::int FROM public.store_product_log) AS store_product_log,
      (SELECT count(*)::int FROM public.store_product) AS store_product,
      (SELECT count(*)::int FROM public.store_product_relation) AS store_product_relation,
      (SELECT count(*)::int FROM public."user") AS "user"
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
        refund_price numeric(12,2) NOT NULL DEFAULT 0,
        refund_reason_time integer NOT NULL DEFAULT 0,
        coupon_id integer NOT NULL DEFAULT 0,
        coupon_price numeric(12,2) NOT NULL DEFAULT 0,
        pay_price numeric(12,2) NOT NULL DEFAULT 0,
        is_channel smallint NOT NULL DEFAULT 0,
        type smallint NOT NULL DEFAULT 0,
        total_num integer NOT NULL DEFAULT 0,
        cost numeric(12,2) NOT NULL DEFAULT 0,
        uid integer NOT NULL DEFAULT 0,
        pay_time integer NOT NULL DEFAULT 0,
        add_time integer NOT NULL DEFAULT 0
      );
      CREATE TABLE ${schema}.store_visit (
        id integer PRIMARY KEY,
        product_id integer NOT NULL DEFAULT 0,
        uid integer NOT NULL DEFAULT 0,
        count integer NOT NULL DEFAULT 0,
        add_time integer NOT NULL DEFAULT 0
      );
      CREATE TABLE ${schema}.store_cart (
        id integer PRIMARY KEY,
        cart_num integer NOT NULL DEFAULT 0,
        add_time integer NOT NULL DEFAULT 0
      );
      CREATE TABLE ${schema}.store_order_refund (
        id integer PRIMARY KEY,
        refunded_price numeric(12,2) NOT NULL DEFAULT 0,
        refund_num integer NOT NULL DEFAULT 0,
        refund_type smallint NOT NULL DEFAULT 0,
        is_cancel smallint NOT NULL DEFAULT 0,
        is_del smallint NOT NULL DEFAULT 0,
        add_time integer NOT NULL DEFAULT 0
      );
      CREATE TABLE ${schema}.store_product (
        id integer PRIMARY KEY,
        store_name varchar(256) NOT NULL DEFAULT '',
        image varchar(256) NOT NULL DEFAULT '',
        price numeric(12,2) NOT NULL DEFAULT 0,
        stock integer NOT NULL DEFAULT 0,
        is_show smallint NOT NULL DEFAULT 1,
        is_del smallint NOT NULL DEFAULT 0
      );
      CREATE TABLE ${schema}.store_product_log (
        id integer PRIMARY KEY,
        product_id integer NOT NULL DEFAULT 0,
        uid integer NOT NULL DEFAULT 0,
        visit_num integer NOT NULL DEFAULT 0,
        cart_num integer NOT NULL DEFAULT 0,
        order_num integer NOT NULL DEFAULT 0,
        pay_num integer NOT NULL DEFAULT 0,
        pay_price numeric(12,2) NOT NULL DEFAULT 0,
        cost_price numeric(12,2) NOT NULL DEFAULT 0,
        pay_uid integer NOT NULL DEFAULT 0,
        collect_num integer NOT NULL DEFAULT 0,
        add_time integer NOT NULL DEFAULT 0,
        delete_time timestamptz
      );
      CREATE TABLE ${schema}.store_product_relation (
        id integer PRIMARY KEY,
        type integer NOT NULL DEFAULT 0,
        product_id integer NOT NULL DEFAULT 0,
        relation_id integer NOT NULL DEFAULT 0
      );
      CREATE TABLE ${schema}."user" (
        uid integer PRIMARY KEY,
        delete_time timestamptz
      );
    `);

    const aug27 = epoch("2026-08-26T16:00:00.000Z");
    const aug26 = aug27 - 86_400;
    const aug25 = aug26 - 86_400;
    const aug24 = aug25 - 86_400;
    const aug23 = aug24 - 86_400;
    const jul2 = epoch("2026-07-01T16:00:00.000Z");
    const jul3 = jul2 + 86_400;
    await tx.unsafe(`
      INSERT INTO ${schema}.store_order
        (id, pid, paid, is_del, is_system_del, refund_status, refund_price, refund_reason_time,
         coupon_id, coupon_price, pay_price, is_channel, type, total_num, cost, uid, pay_time, add_time)
      VALUES
        (1, 0, 1, 0, 0, 0,  0, 0, 1, 10, 100, 1, 0, 2, 60, 1, $1, $1),
        (2, 0, 1, 0, 0, 0,  0, 0, 0,  0,  50, 3, 3, 1, 20, 2, $2, $2),
        (3, 1, 1, 0, 0, 0,  0, 0, 0,  0,  40, 1, 0, 1, 20, 1, $1, $1),
        (4, 0, 1, 0, 0, 2, 30, $3, 0, 0, 80, 0, 0, 2, 50, 1, $3, $3),
        (5, 0, 1, 0, 1, 0,  0, 0, 0,  0, 999, 0, 0, 9,  1, 1, $1, $1),
        (6, 0, 0, 0, 0, 0,  0, 0, 0,  0, 999, 0, 0, 9,  1, 3,  0, $1),
        (7, 0, 1, 0, 0, 0,  0, 0, 5,  7,  40, 2, 0, 1, 25, 1, $4, $4),
        (8, 0, 1, 0, 0, 0,  0, 0, 0,  0,  60, 4, 5, 1, 35, 3, $5, $5),
        (9, 0, 1, 1, 0, 0,  0, 0, 0,  0, 999, 0, 0, 9,  1, 1, $1, $1),
        (10,0, 1, 0, 0, 0,  0, 0, 0,  0,  11, 0, 0, 1,  5, 1, $6, $6),
        (11,0, 1, 0, 0, 0,  0, 0, 0,  0,  12, 0, 0, 1,  6, 2, $7, $7)
    `, [aug27 + 3600, aug26 + 3600, aug25 + 3600, aug24 + 3600, aug23 + 3600, jul2 + 3600, jul3 + 3600]);

    await tx.unsafe(`
      INSERT INTO ${schema}.store_visit (id, product_id, uid, count, add_time) VALUES
        (1, 1, 1, 5, $1), (2, 2, 2, 3, $2), (3, 1, 1, 2, $3),
        (4, 1, 1, 4, $4), (5, 2, 3, 2, $5)
    `, [aug27 + 1000, aug26 + 1000, aug25 + 1000, aug24 + 1000, aug23 + 1000]);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_cart (id, cart_num, add_time) VALUES
        (1, 3, $1), (2, 2, $2), (3, 4, $3)
    `, [aug27 + 1200, aug25 + 1200, aug24 + 1200]);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_order_refund
        (id, refunded_price, refund_num, refund_type, is_cancel, is_del, add_time)
      VALUES
        (1, 30, 1, 6, 0, 0, $1),
        (2, 10, 1, 6, 0, 0, $2),
        (3,999, 9, 6, 1, 0, $1),
        (4,999, 9, 6, 0, 1, $1),
        (5,999, 9, 4, 0, 0, $1)
    `, [aug27 + 1800, aug24 + 1800]);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_product (id, store_name, image, price, stock, is_show, is_del) VALUES
        (1, '商品一', '/one.png', 50, 20, 1, 0),
        (2, '商品二', '/two.png', 30, 10, 1, 0),
        (3, '已删除商品', '/three.png', 90, 0, 0, 1)
    `);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_product_log
        (id, product_id, uid, visit_num, cart_num, order_num, pay_num, pay_price,
         cost_price, pay_uid, collect_num, add_time, delete_time)
      VALUES
        (1, 1, 1, 5, 1, 2, 2, 50, 60, 1, 1, $1, NULL),
        (2, 1, 2, 3, 2, 1, 1, 40, 20, 2, 2, $2, NULL),
        (3, 2, 1,10, 1, 1, 1, 30, 20, 1, 4, $3, NULL),
        (4, 3, 1,99, 9, 9, 9, 99,  1, 1, 9, $1, NULL),
        (5, 1, 1,99, 9, 9, 9, 99,  1, 1, 9, $1, now())
    `, [aug27 + 2200, aug26 + 2200, aug25 + 2200]);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_product_relation (id, type, product_id, relation_id) VALUES
        (1, 1, 1, 7), (2, 1, 2, 8)
    `);
    await tx.unsafe(`INSERT INTO ${schema}."user" (uid, delete_time) VALUES (1, NULL), (2, NULL), (3, now())`);
  });
}

async function temporarySchemaCount(db: DbClient): Promise<number> {
  return (await db.$client<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM pg_namespace
    WHERE nspname LIKE 'codex_statistic_%'
  `)[0]?.count ?? 0;
}

export async function runAdminStatisticPostgresScenario(
  connectionString: string,
): Promise<AdminStatisticPostgresReport> {
  const root = createDbFromConnectionString(connectionString, 2, {
    searchPath: "public",
    applicationName: "cinashop_statistic_audit_root",
  });
  const schemaName = randomSchemaName();
  let schemaCreated = false;
  let isolatedDb: DbClient | null = null;
  try {
    const before = await publicCounts(root);
    const productionService = new AdminStatisticService(createContainerFromDb(root));
    const productionRange = parseAdminStatisticRange();
    const productionOrderBasic = await productionService.orderBasic(productionRange);
    const productionProductBasic = await productionService.productBasic(productionRange);
    const productionRanking = await productionService.productRanking(productionRange, "visit", [], 20);

    await setupSchema(root, schemaName);
    schemaCreated = true;
    isolatedDb = createDbFromConnectionString(connectionString, 2, {
      searchPath: schemaName,
      applicationName: "cinashop_statistic_audit_isolated",
    });
    const isolatedContainer = createContainerFromDb(isolatedDb);
    const results = await withTx(isolatedContainer, async (tx) => {
      const service = new AdminStatisticService(createContainerFromDb(tx));
      const range = parseAdminStatisticRange("2026/08/25-2026/08/27", FIXED_NOW);
      const orderBasic = await service.orderBasic(range);
      const orderTrend = await service.orderTrend(range);
      const orderChannel = await service.orderChannel(range);
      const orderType = await service.orderType(range);
      const productBasic = await service.productBasic(range);
      const productTrend = await service.productTrend(range);
      const ranking = await service.productRanking(range, "visit", [], 20);
      const categoryRanking = await service.productRanking(range, "visit", [7], 20);
      const threeDayTrend = await service.orderTrend(
        parseAdminStatisticRange("2026/07/01-2026/08/01", FIXED_NOW),
      );
      const legacyOverview = await service.legacyOverview(FIXED_NOW);
      return {
        orderBasic,
        orderTrend,
        orderChannel,
        orderType,
        productBasic,
        productTrend,
        ranking,
        categoryRanking,
        threeDayTrend,
        legacyOverview,
      };
    });

    const orderSeries = Object.fromEntries(results.orderTrend.series.map((item) => [item.name, item.data]));
    const productSeries = Object.fromEntries(results.productTrend.series.map((item) => [item.name, item.data]));
    const channelValues = Object.fromEntries(results.orderChannel.bing_data.map((item) => [item.name, item.value]));
    const typeValues = Object.fromEntries(results.orderType.bing_data.map((item) => [item.name, item.value]));
    const threeDayCount = results.threeDayTrend.series.find((item) => item.name === "订单量")?.data ?? [];
    const isolated = {
      order_basic_exact:
        results.orderBasic.pay_count === 3 && results.orderBasic.pay_price === "230.00" &&
        results.orderBasic.refund_count === 1 && results.orderBasic.refund_price === "30.00" &&
        results.orderBasic.coupon_count === 1 && results.orderBasic.coupon_price === "10.00",
      order_trend_exact:
        (orderSeries["订单金额"] ?? []).reduce((sum, value) => sum + value, 0) === 230 &&
        (orderSeries["订单量"] ?? []).reduce((sum, value) => sum + value, 0) === 3 &&
        (orderSeries["退款金额"] ?? []).reduce((sum, value) => sum + value, 0) === 30,
      root_and_deleted_orders_excluded: results.orderBasic.pay_count === 3,
      order_channel_exact:
        channelValues["公众号"] === 1 && channelValues["小程序"] === 1 && channelValues.PC === 1 &&
        Object.values(channelValues).reduce((sum, value) => sum + value, 0) === 3,
      order_type_exact: typeValues["普通订单"] === 180 && typeValues["拼团订单"] === 50,
      product_basic_exact:
        results.productBasic.browse.num === 10 && results.productBasic.user.num === 2 &&
        results.productBasic.cart.num === 5 && results.productBasic.order.num === 14 &&
        results.productBasic.pay.num === 5 && results.productBasic.payPrice.num === 230 &&
        results.productBasic.cost.num === 130 && results.productBasic.refundPrice.num === 30 &&
        results.productBasic.refund.num === 1 && results.productBasic.payPercent.num === 100,
      product_trend_exact:
        (productSeries["商品浏览量"] ?? []).reduce((sum, value) => sum + value, 0) === 10 &&
        (productSeries["支付金额"] ?? []).reduce((sum, value) => sum + value, 0) === 230 &&
        (productSeries["退款金额"] ?? []).reduce((sum, value) => sum + value, 0) === 30,
      product_ranking_exact:
        results.ranking.length === 2 && results.ranking[0]?.product_id === 2 &&
        results.ranking[1]?.product_id === 1 && results.ranking[1]?.price === 140 &&
        results.ranking[1]?.profit === 42.86 && results.ranking[1]?.changes === 100,
      category_filter_exact:
        results.categoryRanking.length === 1 && results.categoryRanking[0]?.product_id === 1,
      deleted_log_and_product_excluded: results.ranking.every((row) => row.product_id !== 3),
      three_day_buckets_do_not_drop_dates:
        threeDayCount.reduce((sum, value) => sum + value, 0) === 2 && threeDayCount[0] === 2,
      legacy_alias_uses_shanghai_day:
        results.legacyOverview.today.orderCount === 1 && results.legacyOverview.today.sales === "100.00" &&
        results.legacyOverview.yesterday.orderCount === 1 && results.legacyOverview.yesterday.sales === "50.00",
    };
    for (const [key, value] of Object.entries(isolated)) {
      assertCondition(value, `${key}; results=${JSON.stringify(results)}`);
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
        order_basic_30d: productionOrderBasic,
        product_basic_30d: {
          browse: productionProductBasic.browse.num,
          payPrice: productionProductBasic.payPrice.num,
          payPercent: productionProductBasic.payPercent.num,
        },
        product_ranking_rows_30d: productionRanking.length,
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
