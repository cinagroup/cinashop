import { eq, sql } from "drizzle-orm";
import type { Env } from "@/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type Container,
  type DbClient,
  withTx,
} from "@/lib/di";
import {
  legacyCache,
  storeCouponIssue,
  storeCouponIssueUser,
  storeCouponUser,
  storeProduct,
  storeProductAttrValue,
  systemConfig,
  user,
  userBill,
  userMoney,
} from "@/models/schema";
import { AdminNewcomerService } from "@/services/activity/AdminNewcomerService";
import { LoginService } from "@/services/user/LoginService";

const TABLES = [
  "system_config",
  "cache",
  "store_newcomer",
  "store_product",
  "store_product_attr_value",
  "user",
  "user_bill",
  "user_money",
  "store_coupon_issue",
  "store_coupon_user",
  "store_coupon_issue_user",
] as const;

const SEQUENCES = [
  ["system_config", "id"],
  ["store_newcomer", "id"],
  ["store_product", "id"],
  ["store_product_attr_value", "id"],
  ["user", "uid"],
  ["user_bill", "id"],
  ["user_money", "id"],
  ["store_coupon_issue", "id"],
  ["store_coupon_user", "id"],
] as const;

const CONFIG_INPUT = {
  store_user_mobile: 0,
  routine_auth_type: [1, 2],
  store_user_agreement: 1,
  newcomer_status: 1,
  newcomer_limit_status: 1,
  newcomer_limit_time: 7,
  register_integral_status: 1,
  register_give_integral: 100,
  register_money_status: 1,
  register_give_money: "9.99",
  register_coupon_status: 1,
  register_give_coupon: [1],
  first_order_status: 1,
  first_order_discount: "90",
  first_order_discount_limit: "15.00",
  register_price_status: 1,
  newcomer_agreement: "production Hyperdrive isolated newcomer audit",
};

interface Fingerprint {
  count: string;
  digest: string;
}

interface PublicSnapshot {
  tables: Record<string, Fingerprint>;
  sequences: Record<string, string | null>;
}

export interface NewcomerAdminPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  public_state_unchanged: boolean;
  admin_save: {
    config_rows: number;
    missing_keys_after_save: number;
    agreement_saved: boolean;
    active_products: number;
    activity_skus: number;
    base_stock_unchanged: boolean;
  };
  catalog_replace: {
    active_products: number;
    removed_soft_deleted: boolean;
    selected_price: string;
    activity_skus: number;
  };
  admin_rollback: {
    rejected: boolean;
    config_unchanged: boolean;
    agreement_unchanged: boolean;
    catalog_unchanged: boolean;
  };
  password_registration: {
    integral: number;
    money: string;
    whole_unit_money_compatible: boolean;
    flags_initialized: boolean;
    integral_ledger: number;
    money_ledger: number;
    coupons: number;
    coupon_evidence: number;
  };
  concurrent_registration: {
    successes: number;
    failures: number;
    users: number;
    integral_ledgers: number;
    money_ledgers: number;
    coupons: number;
    exactly_once: boolean;
  };
  registration_rollback: {
    rejected: boolean;
    users: number;
    coupon_inventory_unchanged: boolean;
    coupon_evidence_unchanged: boolean;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Newcomer Admin integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function schemaName(): string {
  const random = crypto.getRandomValues(new Uint32Array(1))[0];
  return `codex_newcomer_${Date.now().toString(36)}_${random.toString(36)}`.slice(0, 63);
}

function runtimeEnv(): Env {
  const cache = new Map<string, string>();
  return {
    APP_KEY: "newcomer-production-isolated-audit-key",
    UPSTASH_REDIS_URL: "",
    UPSTASH_REDIS_TOKEN: "",
    CONFIG_KV: {
      async get(key: string) { return cache.get(key) ?? null; },
      async put(key: string, value: string) { cache.set(key, value); },
      async delete(key: string) { cache.delete(key); },
    },
  } as unknown as Env;
}

async function publicSnapshot(db: DbClient): Promise<PublicSnapshot> {
  const tables: Record<string, Fingerprint> = {};
  for (const table of TABLES) {
    const rows = await db.$client.unsafe<Array<Fingerprint>>(`
      SELECT count(*)::text AS count,
        md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) AS digest
      FROM public.${identifier(table)} t
    `);
    assertCondition(rows[0], `could not fingerprint public.${table}`);
    tables[table] = rows[0];
  }
  const names = SEQUENCES.map(([table, column]) => `${table}_${column}_seq`);
  const rows = await db.$client<{ sequencename: string; last_value: string | null }[]>`
    SELECT sequencename, last_value::text
    FROM pg_sequences
    WHERE schemaname = 'public' AND sequencename = ANY(${names})
    ORDER BY sequencename
  `;
  return { tables, sequences: Object.fromEntries(rows.map((row) => [row.sequencename, row.last_value])) };
}

async function setupSchema(db: DbClient, schema: string): Promise<void> {
  const target = identifier(schema);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${target}`);
    for (const table of TABLES) {
      await tx.unsafe(`CREATE TABLE ${target}.${identifier(table)} (LIKE public.${identifier(table)} INCLUDING ALL)`);
    }
    for (const [table, column] of SEQUENCES) {
      const sequence = `${table}_${column}_seq_it`;
      await tx.unsafe(`CREATE SEQUENCE ${target}.${identifier(sequence)}`);
      await tx.unsafe(`ALTER SEQUENCE ${target}.${identifier(sequence)} OWNED BY ${target}.${identifier(table)}.${identifier(column)}`);
      await tx.unsafe(
        `ALTER TABLE ${target}.${identifier(table)} ALTER COLUMN ${identifier(column)} SET DEFAULT nextval('${schema}.${sequence}'::regclass)`,
      );
    }
  });
}

function rootContainer(connectionString: string, applicationName: string): Container {
  return createContainerFromDb(createDbFromConnectionString(connectionString, 1, {
    applicationName,
  }));
}

async function withSchema<T>(
  root: Container,
  schema: string,
  callback: (scoped: Container) => Promise<T>,
): Promise<T> {
  return withTx(root, async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${identifier(schema)}`));
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    return callback(createContainerFromDb(tx));
  });
}

async function seed(containerValue: Container): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await containerValue.db.insert(storeProduct).values([
    {
      id: 1,
      storeName: "newcomer audit product one",
      image: "one.png",
      price: "100.00",
      otPrice: "120.00",
      stock: 12,
      isShow: 1,
      isDel: 0,
      isVerify: 1,
      isVipProduct: 0,
      isPresaleProduct: 0,
    },
    {
      id: 2,
      storeName: "newcomer audit product two",
      image: "two.png",
      price: "80.00",
      otPrice: "100.00",
      stock: 7,
      isShow: 1,
      isDel: 0,
      isVerify: 1,
      isVipProduct: 0,
      isPresaleProduct: 0,
    },
  ]);
  await containerValue.db.insert(storeProductAttrValue).values([
    { id: 1, productId: 1, suk: "blue", unique: "BASE0001", price: "100.00", otPrice: "120.00", stock: 5, sumStock: 5, type: 0 },
    { id: 2, productId: 1, suk: "black", unique: "BASE0002", price: "100.00", otPrice: "120.00", stock: 7, sumStock: 7, type: 0 },
    { id: 3, productId: 2, suk: "default", unique: "BASE0003", price: "80.00", otPrice: "100.00", stock: 7, sumStock: 7, type: 0 },
  ]);
  await containerValue.db.insert(storeCouponIssue).values({
    id: 1,
    couponTitle: "newcomer audit coupon",
    title: "newcomer audit coupon",
    couponPrice: "5.00",
    useMinPrice: "0.00",
    totalCount: 10,
    remainCount: 10,
    receiveType: 2,
    day: 7,
    isPermanent: 0,
    isDel: 0,
    status: 1,
    addTime: now,
  });
  await containerValue.db.execute(sql.raw(`
    SELECT setval('store_product_id_seq_it', 2, true);
    SELECT setval('store_product_attr_value_id_seq_it', 3, true);
    SELECT setval('store_coupon_issue_id_seq_it', 1, true);
  `));
}

function firstCatalog() {
  return [
    { product_id: 1, attr: [
      { unique: "BASE0001", price: "20.00" },
      { unique: "BASE0002", price: "21.00" },
    ] },
    { product_id: 2, attr: [{ unique: "BASE0003", price: "18.00" }] },
  ];
}

async function configValue(containerValue: Container, key: string): Promise<string> {
  const rows = await containerValue.db.select({ value: systemConfig.value }).from(systemConfig)
    .where(eq(systemConfig.menuName, key)).limit(1);
  return rows[0]?.value ?? "";
}

async function agreementValue(containerValue: Container): Promise<string> {
  const rows = await containerValue.db.select({ result: legacyCache.result }).from(legacyCache)
    .where(eq(legacyCache.key, "newcomer_agreement")).limit(1);
  return rows[0]?.result ?? "";
}

async function catalogSignature(containerValue: Container): Promise<string> {
  const rows = await containerValue.db.execute(sql.raw(`
      SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) AS signature
      FROM (
        SELECT * FROM store_newcomer
        UNION ALL
        SELECT id, type, product_id, product_type, 0 AS relation_id, price, ot_price, sales,
          0 AS is_del, 0 AS update_time, 0 AS add_time
        FROM store_product_attr_value WHERE type = 7
      ) t
    `)) as unknown as Array<{ signature: string }>;
  return rows[0]?.signature ?? "";
}

async function registrationState(containerValue: Container, account: string) {
  const users = await containerValue.db.select().from(user).where(eq(user.account, account));
  const uid = users[0]?.uid ?? 0;
  const [bills, money, coupons, evidence] = await Promise.all([
    containerValue.db.select().from(userBill).where(eq(userBill.uid, uid)),
    containerValue.db.select().from(userMoney).where(eq(userMoney.uid, uid)),
    containerValue.db.select().from(storeCouponUser).where(eq(storeCouponUser.uid, uid)),
    containerValue.db.select().from(storeCouponIssueUser).where(eq(storeCouponIssueUser.uid, uid)),
  ]);
  return { users, bills, money, coupons, evidence };
}

export async function runNewcomerAdminPostgresScenario(
  connectionString: string,
): Promise<NewcomerAdminPostgresReport> {
  const schema = schemaName();
  const adminDb = createDbFromConnectionString(connectionString, 1, { applicationName: "cinashop_newcomer_audit_admin" });
  const clients: DbClient[] = [];
  let created = false;
  let removed = false;
  let before: PublicSnapshot | undefined;
  let after: PublicSnapshot | undefined;
  let report: Omit<NewcomerAdminPostgresReport, "schema_removed" | "public_state_unchanged"> | undefined;
  try {
    const version = await adminDb.$client<{ server_version: string }[]>`
      SELECT current_setting('server_version') AS server_version
    `;
    before = await publicSnapshot(adminDb);
    await setupSchema(adminDb, schema);
    created = true;

    const primary = rootContainer(connectionString, "cinashop_newcomer_audit_primary");
    clients.push(primary.db);
    const env = runtimeEnv();
    await withSchema(primary, schema, seed);
    const { saved, configCount, activeCount, activityCount, baseSkus } = await withSchema(
      primary,
      schema,
      async (scoped) => {
        const savedConfig = await new AdminNewcomerService(scoped, env)
          .saveRegisterConfig({ ...CONFIG_INPUT, product: firstCatalog() });
        const counts = await Promise.all([
          scoped.db.execute(sql`SELECT count(*)::int AS count FROM system_config`) as unknown as Promise<Array<{ count: number }>>,
          scoped.db.execute(sql`SELECT count(*)::int AS count FROM store_newcomer WHERE is_del = 0`) as unknown as Promise<Array<{ count: number }>>,
          scoped.db.execute(sql`SELECT count(*)::int AS count FROM store_product_attr_value WHERE type = 7`) as unknown as Promise<Array<{ count: number }>>,
          scoped.db.select({ unique: storeProductAttrValue.unique, stock: storeProductAttrValue.stock })
            .from(storeProductAttrValue).where(eq(storeProductAttrValue.type, 0)),
        ]);
        return {
          saved: savedConfig,
          configCount: counts[0],
          activeCount: counts[1],
          activityCount: counts[2],
          baseSkus: counts[3],
        };
      },
    );
    const adminSave = {
      config_rows: configCount[0]?.count ?? 0,
      missing_keys_after_save: saved.missing_config_keys.length,
      agreement_saved: saved.newcomer_agreement === CONFIG_INPUT.newcomer_agreement,
      active_products: activeCount[0]?.count ?? 0,
      activity_skus: activityCount[0]?.count ?? 0,
      base_stock_unchanged: baseSkus.map((sku) => [sku.unique, sku.stock]).sort().join("|")
        === [["BASE0001", 5], ["BASE0002", 7], ["BASE0003", 7]].join("|"),
    };
    assertCondition(
      adminSave.config_rows === 16
      && adminSave.missing_keys_after_save === 0
      && adminSave.agreement_saved
      && adminSave.active_products === 2
      && adminSave.activity_skus === 3
      && adminSave.base_stock_unchanged,
      "initial Admin save diverged",
    );

    const replacement = await withSchema(primary, schema, async (scoped) => {
      await new AdminNewcomerService(scoped, env).saveRegisterConfig({
        ...CONFIG_INPUT,
        product: [{ product_id: 2, attr: [{ unique: "BASE0003", price: "16.50" }] }],
      });
      return scoped.db.execute(sql` 
        SELECT
          count(*) FILTER (WHERE is_del = 0)::int AS active_products,
          bool_and(is_del = 1) FILTER (WHERE product_id = 1) AS removed_soft_deleted,
          (SELECT price::text FROM store_newcomer WHERE product_id = 2 AND is_del = 0 LIMIT 1) AS selected_price,
          (SELECT count(*)::int FROM store_product_attr_value WHERE type = 7 AND product_id =
            (SELECT id FROM store_newcomer WHERE product_id = 2 AND is_del = 0 LIMIT 1)) AS activity_skus
        FROM store_newcomer
      `) as unknown as Promise<Array<{
      active_products: number;
      removed_soft_deleted: boolean;
      selected_price: string;
      activity_skus: number;
      }>>;
    });
    const catalogReplace = replacement[0];
    assertCondition(
      catalogReplace?.active_products === 1
      && catalogReplace.removed_soft_deleted === true
      && catalogReplace.selected_price === "16.50"
      && catalogReplace.activity_skus === 1,
      "catalog replacement diverged",
    );

    const [configBefore, agreementBefore, catalogBefore] = await withSchema(
      primary,
      schema,
      (scoped) => Promise.all([
        configValue(scoped, "newcomer_limit_time"),
        agreementValue(scoped),
        catalogSignature(scoped),
      ]),
    );
    let adminRejected = false;
    try {
      await withSchema(primary, schema, (scoped) =>
        new AdminNewcomerService(scoped, env).saveRegisterConfig({
          ...CONFIG_INPUT,
          newcomer_limit_time: 99,
          newcomer_agreement: "must roll back",
          product: [{ product_id: 999999, attr: [{ unique: "BASE0003", price: "1.00" }] }],
        })
      );
    } catch {
      adminRejected = true;
    }
    const [configAfter, agreementAfter, catalogAfter] = await withSchema(
      primary,
      schema,
      (scoped) => Promise.all([
        configValue(scoped, "newcomer_limit_time"),
        agreementValue(scoped),
        catalogSignature(scoped),
      ]),
    );
    const adminRollback = {
      rejected: adminRejected,
      config_unchanged: configAfter === configBefore,
      agreement_unchanged: agreementAfter === agreementBefore,
      catalog_unchanged: catalogAfter === catalogBefore,
    };
    assertCondition(Object.values(adminRollback).every(Boolean), "failed Admin save was not atomic");

    await withSchema(primary, schema, (scoped) =>
      new LoginService(scoped, env).register("13900000001", "audit-password", 0)
    );
    const registered = await withSchema(primary, schema, (scoped) =>
      registrationState(scoped, "13900000001")
    );
    const account = registered.users[0];
    const passwordRegistration = {
      integral: account?.integral ?? -1,
      money: account?.nowMoney ?? "missing",
      whole_unit_money_compatible: account?.nowMoney === "9.00",
      flags_initialized: account?.isFirstOrder === 0 && account.isNewcomer === 0,
      integral_ledger: registered.bills.length,
      money_ledger: registered.money.length,
      coupons: registered.coupons.length,
      coupon_evidence: registered.evidence.length,
    };
    assertCondition(
      passwordRegistration.integral === 100
      && passwordRegistration.whole_unit_money_compatible
      && passwordRegistration.flags_initialized
      && passwordRegistration.integral_ledger === 1
      && passwordRegistration.money_ledger === 1
      && passwordRegistration.coupons === 1
      && passwordRegistration.coupon_evidence === 1,
      "password registration gifts diverged",
    );

    const concurrentA = rootContainer(connectionString, "cinashop_newcomer_audit_concurrent_a");
    const concurrentB = rootContainer(connectionString, "cinashop_newcomer_audit_concurrent_b");
    clients.push(concurrentA.db, concurrentB.db);
    const settled = await Promise.allSettled([
      withSchema(concurrentA, schema, (scoped) =>
        new LoginService(scoped, runtimeEnv()).register("13900000002", "audit-password", 0)
      ),
      withSchema(concurrentB, schema, (scoped) =>
        new LoginService(scoped, runtimeEnv()).register("13900000002", "audit-password", 0)
      ),
    ]);
    const concurrentState = await withSchema(primary, schema, (scoped) =>
      registrationState(scoped, "13900000002")
    );
    const concurrentRegistration = {
      successes: settled.filter((item) => item.status === "fulfilled").length,
      failures: settled.filter((item) => item.status === "rejected").length,
      users: concurrentState.users.length,
      integral_ledgers: concurrentState.bills.length,
      money_ledgers: concurrentState.money.length,
      coupons: concurrentState.coupons.length,
      exactly_once: false,
    };
    concurrentRegistration.exactly_once = Object.entries(concurrentRegistration)
      .filter(([key]) => key !== "exactly_once")
      .every(([key, value]) => key === "failures" ? value === 1 : value === 1);
    assertCondition(concurrentRegistration.exactly_once, "concurrent registration was not exactly once");

    const [couponBeforeRollback, evidenceBeforeRollback] = await withSchema(
      primary,
      schema,
      (scoped) => Promise.all([
        scoped.db.select({ remainCount: storeCouponIssue.remainCount })
          .from(storeCouponIssue).where(eq(storeCouponIssue.id, 1)).limit(1),
        scoped.db.execute(sql`SELECT count(*)::int AS count FROM store_coupon_issue_user`),
      ]),
    );
    await withSchema(primary, schema, (scoped) => scoped.db.execute(sql.raw(`
        CREATE FUNCTION fail_newcomer_money() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'forced newcomer money failure'; END $$;
        CREATE TRIGGER fail_newcomer_money BEFORE INSERT ON user_money
        FOR EACH ROW EXECUTE FUNCTION fail_newcomer_money();
      `))
    );
    let registrationRejected = false;
    try {
      await withSchema(primary, schema, (scoped) =>
        new LoginService(scoped, runtimeEnv()).register("13900000003", "audit-password", 0)
      );
    } catch {
      registrationRejected = true;
    } finally {
      await withSchema(primary, schema, (scoped) => scoped.db.execute(sql.raw(`
          DROP TRIGGER IF EXISTS fail_newcomer_money ON user_money;
          DROP FUNCTION IF EXISTS fail_newcomer_money();
        `))
      );
    }
    const [rollbackState, couponAfterRollback, evidenceAfterRollback] = await withSchema(
      primary,
      schema,
      (scoped) => Promise.all([
        registrationState(scoped, "13900000003"),
        scoped.db.select({ remainCount: storeCouponIssue.remainCount })
          .from(storeCouponIssue).where(eq(storeCouponIssue.id, 1)).limit(1),
        scoped.db.execute(sql`SELECT count(*)::int AS count FROM store_coupon_issue_user`),
      ]),
    );
    const registrationRollback = {
      rejected: registrationRejected,
      users: rollbackState.users.length,
      coupon_inventory_unchanged: couponAfterRollback[0]?.remainCount === couponBeforeRollback[0]?.remainCount,
      coupon_evidence_unchanged:
        Number(evidenceAfterRollback[0]?.count) === Number(evidenceBeforeRollback[0]?.count),
    };
    assertCondition(
      registrationRollback.rejected
      && registrationRollback.users === 0
      && registrationRollback.coupon_inventory_unchanged
      && registrationRollback.coupon_evidence_unchanged,
      "failed registration left side effects",
    );

    report = {
      server_version: version[0]?.server_version ?? "unknown",
      schema_created: true,
      admin_save: adminSave,
      catalog_replace: catalogReplace,
      admin_rollback: adminRollback,
      password_registration: passwordRegistration,
      concurrent_registration: concurrentRegistration,
      registration_rollback: registrationRollback,
    };
  } finally {
    try {
      await Promise.all(clients.map((db) => db.$client.end({ timeout: 1 })));
      if (created) await adminDb.$client.unsafe(`DROP SCHEMA IF EXISTS ${identifier(schema)} CASCADE`);
      const rows = await adminDb.$client<{ removed: boolean }[]>`
        SELECT to_regnamespace(${schema}) IS NULL AS removed
      `;
      removed = rows[0]?.removed === true;
      after = await publicSnapshot(adminDb);
    } finally {
      await adminDb.$client.end({ timeout: 1 });
    }
  }
  assertCondition(report, "scenario did not produce a report");
  assertCondition(removed, "temporary schema was not removed");
  assertCondition(before && after, "public snapshots are missing");
  const publicUnchanged = JSON.stringify(before) === JSON.stringify(after);
  assertCondition(publicUnchanged, "public tables or sequences changed");
  return { ...report, schema_removed: removed, public_state_unchanged: publicUnchanged };
}
