import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type DbClient,
} from "@/lib/di";
import { parseAdminStatisticRange } from "@/services/admin/AdminStatisticService";
import { AdminExtendedStatisticService } from "@/services/admin/AdminExtendedStatisticService";

const FIXED_NOW = Math.floor(Date.parse("2026-08-27T04:00:00.000Z") / 1000);
const epoch = (value: string) => Math.floor(Date.parse(value) / 1000);

interface PublicCounts {
  user: number;
  user_visit: number;
  user_address: number;
  wechat_user: number;
  user_money: number;
  user_recharge: number;
  user_extract: number;
  other_order: number;
  store_order: number;
  store_cart: number;
  store_order_refund: number;
  store_visit: number;
}

export interface AdminExtendedStatisticPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_row_counts_unchanged: boolean;
  production: {
    rows: PublicCounts;
    user_people_30d: number;
    balance_now: number;
    trade_turnover_30d: number;
  };
  isolated: Record<string, boolean>;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Admin extended statistic integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function randomSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_extended_stat_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

async function publicCounts(db: DbClient): Promise<PublicCounts> {
  const row = (await db.$client<PublicCounts[]>`
    SELECT
      (SELECT count(*)::int FROM public."user") AS "user",
      (SELECT count(*)::int FROM public.user_visit) AS user_visit,
      (SELECT count(*)::int FROM public.user_address) AS user_address,
      (SELECT count(*)::int FROM public.wechat_user) AS wechat_user,
      (SELECT count(*)::int FROM public.user_money) AS user_money,
      (SELECT count(*)::int FROM public.user_recharge) AS user_recharge,
      (SELECT count(*)::int FROM public.user_extract) AS user_extract,
      (SELECT count(*)::int FROM public.other_order) AS other_order,
      (SELECT count(*)::int FROM public.store_order) AS store_order,
      (SELECT count(*)::int FROM public.store_cart) AS store_cart,
      (SELECT count(*)::int FROM public.store_order_refund) AS store_order_refund,
      (SELECT count(*)::int FROM public.store_visit) AS store_visit
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
      CREATE TABLE ${schema}."user" (
        uid integer PRIMARY KEY, add_time integer NOT NULL, now_money numeric(12,2) NOT NULL DEFAULT 0,
        status smallint NOT NULL DEFAULT 1, is_del smallint NOT NULL DEFAULT 0,
        delete_time timestamptz, user_type varchar(32) NOT NULL DEFAULT '', sex smallint NOT NULL DEFAULT 0
      );
      CREATE TABLE ${schema}.user_visit (
        id integer PRIMARY KEY, uid integer NOT NULL DEFAULT 0, add_time integer NOT NULL DEFAULT 0,
        channel_type varchar(32) NOT NULL DEFAULT '', province varchar(64) NOT NULL DEFAULT ''
      );
      CREATE TABLE ${schema}.user_address (
        id integer PRIMARY KEY, uid integer NOT NULL DEFAULT 0, province varchar(64) NOT NULL DEFAULT '',
        is_del smallint NOT NULL DEFAULT 0, add_time integer NOT NULL DEFAULT 0
      );
      CREATE TABLE ${schema}.wechat_user (
        id integer PRIMARY KEY, uid integer NOT NULL DEFAULT 0, subscribe smallint NOT NULL DEFAULT 1,
        subscribe_time integer NOT NULL DEFAULT 0, user_type varchar(32) NOT NULL DEFAULT 'wechat',
        is_del smallint NOT NULL DEFAULT 0
      );
      CREATE TABLE ${schema}.user_money (
        id integer PRIMARY KEY, uid integer NOT NULL DEFAULT 0, type varchar(64) NOT NULL DEFAULT '',
        number numeric(12,2) NOT NULL DEFAULT 0, pm smallint NOT NULL DEFAULT 0,
        status smallint NOT NULL DEFAULT 1, add_time integer NOT NULL DEFAULT 0
      );
      CREATE TABLE ${schema}.user_recharge (
        id integer PRIMARY KEY, store_id integer NOT NULL DEFAULT 0, uid integer NOT NULL DEFAULT 0,
        price numeric(12,2) NOT NULL DEFAULT 0, paid smallint NOT NULL DEFAULT 0,
        pay_time integer NOT NULL DEFAULT 0, add_time integer NOT NULL DEFAULT 0,
        refund_price numeric(12,2) NOT NULL DEFAULT 0, channel_type varchar(32) NOT NULL DEFAULT ''
      );
      CREATE TABLE ${schema}.user_extract (
        id integer PRIMARY KEY, uid integer NOT NULL DEFAULT 0, extract_price numeric(12,2) NOT NULL DEFAULT 0,
        status smallint NOT NULL DEFAULT 0, add_time integer NOT NULL DEFAULT 0
      );
      CREATE TABLE ${schema}.other_order (
        id integer PRIMARY KEY, store_id integer NOT NULL DEFAULT 0, uid integer NOT NULL DEFAULT 0,
        type smallint NOT NULL DEFAULT 0, paid smallint NOT NULL DEFAULT 0,
        pay_price numeric(12,2) NOT NULL DEFAULT 0, pay_type varchar(32) NOT NULL DEFAULT '',
        pay_time integer NOT NULL DEFAULT 0, channel_type varchar(32) NOT NULL DEFAULT '',
        is_del smallint NOT NULL DEFAULT 0, is_permanent smallint NOT NULL DEFAULT 0,
        overdue_time integer NOT NULL DEFAULT 0, add_time integer NOT NULL DEFAULT 0
      );
      CREATE TABLE ${schema}.store_order (
        id integer PRIMARY KEY, pid integer NOT NULL DEFAULT 0, uid integer NOT NULL DEFAULT 0,
        paid smallint NOT NULL DEFAULT 0, refund_status smallint NOT NULL DEFAULT 0,
        is_del smallint NOT NULL DEFAULT 0, is_system_del smallint NOT NULL DEFAULT 0,
        pay_price numeric(12,2) NOT NULL DEFAULT 0, pay_type varchar(32) NOT NULL DEFAULT '',
        total_num integer NOT NULL DEFAULT 0, cost numeric(12,2) NOT NULL DEFAULT 0,
        pay_time integer NOT NULL DEFAULT 0, add_time integer NOT NULL DEFAULT 0,
        channel_type varchar(32) NOT NULL DEFAULT '', province varchar(64) NOT NULL DEFAULT '',
        user_address varchar(128) NOT NULL DEFAULT ''
      );
      CREATE TABLE ${schema}.store_cart (
        id integer PRIMARY KEY, uid integer NOT NULL DEFAULT 0, cart_num integer NOT NULL DEFAULT 0,
        is_del smallint NOT NULL DEFAULT 0, add_time integer NOT NULL DEFAULT 0
      );
      CREATE TABLE ${schema}.store_order_refund (
        id integer PRIMARY KEY, refund_type smallint NOT NULL DEFAULT 0,
        refund_num integer NOT NULL DEFAULT 0, refunded_price numeric(12,2) NOT NULL DEFAULT 0,
        refunded_time integer NOT NULL DEFAULT 0, is_cancel smallint NOT NULL DEFAULT 0,
        is_del smallint NOT NULL DEFAULT 0, add_time integer NOT NULL DEFAULT 0
      );
      CREATE TABLE ${schema}.store_visit (
        id integer PRIMARY KEY, product_id integer NOT NULL DEFAULT 0, uid integer NOT NULL DEFAULT 0,
        count integer NOT NULL DEFAULT 0, add_time integer NOT NULL DEFAULT 0
      );
    `);

    const aug27 = epoch("2026-08-26T16:00:00.000Z");
    const aug26 = aug27 - 86_400;
    const aug25 = aug26 - 86_400;
    const aug24 = aug25 - 86_400;
    await tx.unsafe(`
      INSERT INTO ${schema}."user" (uid, add_time, now_money, status, is_del, delete_time, user_type, sex) VALUES
        (1,$1,100,1,0,NULL,'wechat',1), (2,$2,50,1,0,NULL,'routine',2),
        (3,$3,20,1,0,NULL,'wechat',0), (4,$1,999,1,1,now(),'wechat',1),
        (5,$1,999,0,0,NULL,'wechat',2)
    `, [aug27 + 100, aug26 + 100, aug24 + 100]);
    await tx.unsafe(`
      INSERT INTO ${schema}.user_visit (id,uid,add_time,channel_type,province) VALUES
        (1,1,$1,'wechat','北京'), (2,1,$2,'wechat','北京'), (3,2,$3,'routine','上海'),
        (4,3,$4,'wechat','广东')
    `, [aug27 + 200, aug27 + 300, aug26 + 200, aug24 + 200]);
    await tx.unsafe(`
      INSERT INTO ${schema}.user_address (id,uid,province,is_del,add_time) VALUES
        (1,1,'北京',0,$1), (2,2,'上海',0,$2), (3,3,'广东',0,$3), (4,4,'浙江',0,$1)
    `, [aug27, aug26, aug24]);
    await tx.unsafe(`
      INSERT INTO ${schema}.wechat_user (id,uid,subscribe,subscribe_time,user_type,is_del) VALUES
        (1,1,1,$1,'wechat',0), (2,2,0,$2,'wechat',0), (3,3,1,$3,'wechat',0),
        (4,4,1,$1,'wechat',1)
    `, [aug27 + 400, aug26 + 400, aug24 + 400]);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_order
        (id,pid,uid,paid,refund_status,is_del,is_system_del,pay_price,pay_type,total_num,cost,pay_time,add_time,channel_type,province,user_address)
      VALUES
        (1,0,1,1,0,0,0,100,'yue',2,60,$1,$1,'wechat','北京','北京 朝阳'),
        (2,0,2,1,0,0,0,50,'weixin',1,20,$2,$2,'routine','上海','上海 浦东'),
        (3,1,1,1,0,0,0,40,'weixin',1,20,$1,$1,'wechat','北京','北京 朝阳'),
        (4,0,1,1,0,0,1,999,'weixin',9,1,$1,$1,'wechat','北京','北京 朝阳'),
        (5,0,3,1,0,0,0,40,'yue',1,25,$3,$3,'wechat','广东','广东 广州')
    `, [aug27 + 500, aug26 + 500, aug24 + 500]);
    await tx.unsafe(`
      INSERT INTO ${schema}.user_recharge (id,store_id,uid,price,paid,pay_time,add_time,refund_price,channel_type) VALUES
        (1,0,1,30,1,$1,$1,0,'wechat'), (2,0,3,10,1,$2,$2,0,'wechat'),
        (3,0,1,99,1,$1,$1,99,'wechat')
    `, [aug27 + 600, aug24 + 600]);
    await tx.unsafe(`
      INSERT INTO ${schema}.other_order
        (id,store_id,uid,type,paid,pay_price,pay_type,pay_time,channel_type,is_del,is_permanent,overdue_time,add_time)
      VALUES
        (1,0,1,1,1,20,'yue',$1,'wechat',0,1,0,$1),
        (2,0,3,1,1,10,'yue',$2,'wechat',0,1,0,$2),
        (3,0,2,3,1,25,'cash',$3,'routine',0,0,0,$3),
        (4,0,1,1,1,999,'yue',$1,'wechat',1,1,0,$1)
    `, [aug27 + 700, aug24 + 700, aug27 + 800]);
    await tx.unsafe(`
      INSERT INTO ${schema}.user_money (id,uid,type,number,pm,status,add_time) VALUES
        (1,1,'system_add',5,1,1,$1), (2,1,'recharge',10,1,1,$1),
        (3,1,'pay_product_refund',8,1,1,$1), (4,1,'system_add',999,1,0,$1),
        (5,3,'system_add',4,1,1,$2), (6,1,'pay_product',20,0,1,$1),
        (7,2,'system_sub',3,0,1,$3), (8,1,'pay_product',999,0,0,$1),
        (9,3,'pay_product',2,0,1,$2)
    `, [aug27 + 900, aug24 + 900, aug26 + 900]);
    await tx.unsafe(`
      INSERT INTO ${schema}.user_extract (id,uid,extract_price,status,add_time) VALUES
        (1,1,7,1,$1), (2,3,2,1,$2), (3,1,999,0,$1)
    `, [aug27 + 1000, aug24 + 1000]);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_order_refund
        (id,refund_type,refund_num,refunded_price,refunded_time,is_cancel,is_del,add_time) VALUES
        (1,6,1,8,$1,0,0,$1), (2,6,1,4,$2,0,0,$2),
        (3,6,9,999,$1,1,0,$1), (4,6,9,999,$1,0,1,$1)
    `, [aug27 + 1100, aug24 + 1100]);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_cart (id,uid,cart_num,is_del,add_time) VALUES
        (1,1,3,0,$1), (2,1,99,1,$1)
    `, [aug27 + 1200]);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_visit (id,product_id,uid,count,add_time) VALUES
        (1,1,1,5,$1), (2,1,2,3,$2)
    `, [aug27 + 1300, aug26 + 1300]);
  });
}

async function temporarySchemaCount(db: DbClient): Promise<number> {
  return (await db.$client<{ count: number }[]>`
    SELECT count(*)::int AS count FROM pg_namespace WHERE nspname LIKE 'codex_extended_stat_%'
  `)[0]?.count ?? 0;
}

export async function runAdminExtendedStatisticPostgresScenario(
  connectionString: string,
): Promise<AdminExtendedStatisticPostgresReport> {
  const root = createDbFromConnectionString(connectionString, 2, {
    searchPath: "public",
    applicationName: "cinashop_extended_stat_audit_root",
  });
  const schemaName = randomSchemaName();
  let schemaCreated = false;
  let isolatedDb: DbClient | null = null;
  try {
    const before = await publicCounts(root);
    const productionService = new AdminExtendedStatisticService(createContainerFromDb(root));
    const productionRange = parseAdminStatisticRange(undefined, FIXED_NOW);
    const productionUser = await productionService.userBasic(productionRange, "");
    const productionBalance = await productionService.balanceBasic();
    const productionTrade = await productionService.tradeBottom(productionRange);

    await setupSchema(root, schemaName);
    schemaCreated = true;
    isolatedDb = createDbFromConnectionString(connectionString, 2, {
      searchPath: schemaName,
      applicationName: "cinashop_extended_stat_audit_isolated",
    });
    const results = await withTx(createContainerFromDb(isolatedDb), async (tx) => {
      const service = new AdminExtendedStatisticService(createContainerFromDb(tx));
      const range = parseAdminStatisticRange("2026/08/25-2026/08/27", FIXED_NOW);
      const userBasic = await service.userBasic(range, "");
      const wechatBasic = await service.userBasic(range, "wechat");
      const userTrend = await service.userTrend(range, "");
      const userExport = await service.userExport(range, "", FIXED_NOW);
      const wechat = await service.userWechat(range);
      const wechatTrend = await service.userWechatTrend(range);
      const region = await service.userRegion(range, "", "payPrice");
      const sex = await service.userSex(range, "");
      const productExport = await service.productExport(range, FIXED_NOW);
      const balanceBasic = await service.balanceBasic();
      const balanceTrend = await service.balanceTrend(range);
      const balanceChannel = await service.balanceChannel(range);
      const balanceType = await service.balanceType(range);
      const tradeBottom = await service.tradeBottom(range);
      const tradeTop = await service.tradeTop(FIXED_NOW);
      const threeDayBalance = await service.balanceTrend(
        parseAdminStatisticRange("2026/07/01-2026/08/01", FIXED_NOW),
      );
      return {
        userBasic, wechatBasic, userTrend, userExport, wechat, wechatTrend, region, sex,
        productExport, balanceBasic, balanceTrend, balanceChannel, balanceType,
        tradeBottom, tradeTop, threeDayBalance,
      };
    });

    const userTrendValues = Object.fromEntries(results.userTrend.series.map((item) => [item.name, item.value]));
    const balanceTrendValues = Object.fromEntries(results.balanceTrend.series.map((item) => [item.name, item.data]));
    const balanceChannels = Object.fromEntries(results.balanceChannel.bing_data.map((item) => [item.name, item.value]));
    const balanceTypes = Object.fromEntries(results.balanceType.bing_data.map((item) => [item.name, item.value]));
    const trade = Object.fromEntries(results.tradeBottom.series.map((item) => [item.name, item]));
    const isolated = {
      user_basic_exact:
        results.userBasic.people.num === 2 && results.userBasic.people.last_num === 1 &&
        results.userBasic.browse.num === 3 && results.userBasic.newUser.num === 2 &&
        results.userBasic.payPeople.num === 2 && results.userBasic.payPrice.num === 75 &&
        results.userBasic.cumulativeUser.num === 3 && results.userBasic.cumulativePayUser.num === 2,
      user_channel_exact:
        results.wechatBasic.people.num === 1 && results.wechatBasic.newUser.num === 1 &&
        results.wechatBasic.payPeople.num === 1,
      user_trend_exact:
        (userTrendValues["新增用户数"] ?? []).reduce((sum, value) => sum + value, 0) === 2 &&
        (userTrendValues["访客数"] ?? []).reduce((sum, value) => sum + value, 0) === 2 &&
        (userTrendValues["成交用户数"] ?? []).reduce((sum, value) => sum + value, 0) === 2,
      user_export_exact:
        results.userExport.filekey.join(",") === "time,user,browse,new,paid,changes,vip,recharge,payPrice" &&
        results.userExport.export.length === 3,
      wechat_exact:
        results.wechat.subscribe.num === 1 && results.wechat.unSubscribe.num === 1 &&
        results.wechat.cumulativeSubscribe.num === 2 && results.wechat.cumulativeUnSubscribe.num === 1,
      wechat_trend_cumulative:
        results.wechatTrend.series.find((item) => item.name === "累计关注用户")?.value.at(-1) === 2 &&
        results.wechatTrend.series.find((item) => item.name === "累计取关用户")?.value.at(-1) === 1,
      region_exact:
        results.region[0]?.province === "北京" && results.region[0]?.payPrice === 100 &&
        results.region.find((item) => item.province === "上海")?.payPrice === 50 &&
        results.region.every((item) => item.province !== "浙江"),
      sex_all_buckets:
        results.sex[0]?.value === 0 && results.sex[1]?.value === 1 && results.sex[2]?.value === 1,
      product_export_exact:
        results.productExport.filekey.join(",") === "time,browse,user,cart,order,payNum,pay,cost,refund,refundNum,changes" &&
        results.productExport.export.reduce((sum, row) => sum + Number(row.browse), 0) === 8 &&
        results.productExport.export.reduce((sum, row) => sum + Number(row.pay), 0) === 150,
      balance_basic_exact:
        results.balanceBasic.now_balance === 170 && results.balanceBasic.add_balance === 27 &&
        results.balanceBasic.sub_balance === 25,
      balance_trend_exact:
        (balanceTrendValues["余额积累"] ?? []).reduce((sum, value) => sum + value, 0) === 23 &&
        (balanceTrendValues["余额消耗"] ?? []).reduce((sum, value) => sum + value, 0) === 23,
      balance_distribution_exact:
        balanceChannels["系统增加"] === 5 && balanceChannels["用户充值"] === 10 &&
        balanceChannels["商品退款"] === 8 && balanceTypes["购买商品"] === 20 &&
        balanceTypes["系统减少"] === 3,
      trade_exact:
        trade["营业额"]?.money === 230 && trade["支出金额"]?.money === 135 &&
        trade["交易毛利金额"]?.money === 95 && trade["余额支付金额"]?.money === 120 &&
        trade["商品退款金额"]?.money === 8,
      trade_export_compatible:
        results.tradeBottom.export.startsWith("data:text/csv;charset=utf-8,") &&
        results.tradeBottom.series.length === 10,
      trade_top_24_hours:
        results.tradeTop.left.x.length === 24 && results.tradeTop.left.series[0]?.money === 180 &&
        results.tradeTop.right.today.series[0]?.now_money === 1,
      invalid_rows_excluded:
        results.balanceBasic.add_balance !== 1026 && trade["营业额"]?.money !== 2227,
      three_day_buckets_preserved:
        results.threeDayBalance.xAxis.length === 11,
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
        user_people_30d: productionUser.people.num,
        balance_now: productionBalance.now_balance,
        trade_turnover_30d: productionTrade.series[0]?.money ?? 0,
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
