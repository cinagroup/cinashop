import { sql } from "drizzle-orm";
import postgres from "postgres";
import type { Env } from "../../src/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type DbClient,
} from "../../src/lib/di";
import { ShortVideoService } from "../../src/services/activity/ShortVideoService";
import { DiyHomeCompatibilityService } from "../../src/services/content/DiyHomeCompatibilityService";

export const DIY_HOME_SCHEMA_PREFIX = "codex_diy_home_widgets_";

export const DIY_HOME_PUBLIC_TABLES = [
  "system_dise",
  "system_config",
  "user",
  "system_user_level",
  "store_coupon_user",
  "user_relation",
  "store_product_log",
  "video",
  "live_room",
  "store_product",
  "store_newcomer",
  "store_order",
  "store_coupon_issue",
  "system_sign_reward",
  "user_sign",
  "store_brand",
  "store_product_label",
  "member_right",
  "store_coupon_product",
  "store_seckill",
  "store_combination",
  "store_bargain",
  "store_promotions",
  "store_promotions_auxiliary",
] as const;

/**
 * Transitive rank-decoration reads discovered from the real compatibility
 * service. They are kept separate so the original 24-table audit contract
 * remains explicit while strict search-path isolation has no public fallback.
 */
export const DIY_HOME_SUPPORT_TABLES = [
  "store_product_relation",
  "store_seckill_time",
] as const;

const DIY_HOME_CLONE_TABLES = [
  ...DIY_HOME_PUBLIC_TABLES,
  ...DIY_HOME_SUPPORT_TABLES,
] as const;

const FIXTURE = {
  defaultDiy: 7_001,
  explicitDiy: 7_002,
  owner: 7_101,
  paidMember: 7_102,
  visibleProduct: 7_501,
  salesProduct: 7_502,
  starProduct: 7_503,
  vipProduct: 7_504,
  hiddenProduct: 7_505,
  visibleVideo: 7_701,
} as const;

interface PublicTableFingerprint {
  table: string;
  rows: string;
  digest: string;
}

interface PublicSequenceFingerprint {
  sequence: string;
  lastValue: string;
  isCalled: boolean;
}

interface SafetySnapshot {
  tables: PublicTableFingerprint[];
  sequences: PublicSequenceFingerprint[];
  temporarySchemas: number;
}

interface ScenarioAssertions {
  diy: {
    defaultContract: boolean;
    explicitContract: boolean;
    missingFallsBack: boolean;
    versionContract: boolean;
    componentSanitization: boolean;
  };
  user: {
    anonymousEmpty: boolean;
    authenticatedShape: boolean;
    aggregateCounts: boolean;
  };
  video: {
    listContract: boolean;
    disabledContract: boolean;
    readPathDidNotWrite: boolean;
    isolatedPlaybackWrite: boolean;
  };
  newcomer: {
    anonymousContract: boolean;
    eligibleContract: boolean;
    paidOrderIneligible: boolean;
    anonymousCouponShape: boolean;
    loggedCouponShape: boolean;
    earlyIntegralArray: boolean;
    limitPresenceContract: boolean;
  };
  rank: {
    threeLists: boolean;
    anonymousVipBoundary: boolean;
    memberVipBoundary: boolean;
    decorationKeys: boolean;
  };
  sign: {
    shanghaiWeek: boolean;
    authenticatedState: boolean;
    rewardContract: boolean;
  };
  suspended: {
    defaultsMerged: boolean;
    unknownKeysDropped: boolean;
  };
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`isolated DIY-HOME-WIDGETS assertion failed: ${message}`);
}

function quoteIdentifier(value: string): string {
  invariant(/^[a-z_][a-z0-9_]{0,62}$/.test(value), "unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): unknown[] {
  invariant(Array.isArray(value), `${label} must be an array`);
  return value;
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key));
}

function numericProductId(value: unknown): number {
  const item = objectValue(value, "rank item");
  return Number(item.product_id ?? item.id ?? 0);
}

function componentName(value: unknown): string {
  const component = objectValue(value, "DIY component");
  return String(component.name ?? component.componentName ?? "");
}

export function createDiyHomeAuditRuntimeEnv(env: Env): Env {
  const cache = new Map<string, string>();
  const memoryConfig = {
    async get(key: string): Promise<string | null> {
      return cache.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      cache.set(key, value);
    },
    async delete(key: string): Promise<void> {
      cache.delete(key);
    },
  };
  return new Proxy(env, {
    get(_target, property) {
      if (property === "CONFIG_KV") return memoryConfig;
      if (property === "APP_KEY") return "diy-home-widgets-isolated-fixture-key";
      if (property === "NODE_ENV") return "production";
      throw new Error(`isolated DIY service attempted external binding access: ${String(property)}`);
    },
  });
}

function tableFingerprintSql(): string {
  return DIY_HOME_CLONE_TABLES.map((name) => {
    const table = quoteIdentifier(name);
    return `
      SELECT '${name}'::text AS table_name,
             count(*)::text AS row_count,
             md5(COALESCE(string_agg(row_digest, '|' ORDER BY row_digest), '')) AS digest
      FROM (
        SELECT md5(to_jsonb(source_row)::text) AS row_digest
        FROM public.${table} AS source_row
      ) AS row_digests`;
  }).join(" UNION ALL ");
}

async function publicSequenceNames(
  tx: postgres.TransactionSql,
): Promise<string[]> {
  const rows = await tx<Array<{ sequence_name: string }>>`
    SELECT DISTINCT sequence_class.relname AS sequence_name
    FROM pg_class AS table_class
    JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
    JOIN pg_depend AS dependency
      ON dependency.refobjid = table_class.oid
     AND dependency.refobjsubid > 0
     AND dependency.deptype IN ('a', 'i')
    JOIN pg_class AS sequence_class
      ON sequence_class.oid = dependency.objid
     AND sequence_class.relkind = 'S'
    JOIN pg_namespace AS sequence_namespace
      ON sequence_namespace.oid = sequence_class.relnamespace
    WHERE table_namespace.nspname = 'public'
      AND sequence_namespace.nspname = 'public'
      AND table_class.relname IN ${tx(DIY_HOME_CLONE_TABLES)}
    ORDER BY sequence_class.relname
  `;
  return rows.map((row) => row.sequence_name);
}

async function safetySnapshot(
  client: ReturnType<typeof postgres>,
): Promise<SafetySnapshot> {
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx`SET LOCAL search_path TO public, pg_temp`;
    await tx`SET LOCAL statement_timeout = '45s'`;
    await tx`SET LOCAL lock_timeout = '2s'`;
    const tableRows = await tx.unsafe<Array<{
      table_name: string;
      row_count: string;
      digest: string;
    }>>(tableFingerprintSql());
    const sequenceNames = await publicSequenceNames(tx);
    const sequences: PublicSequenceFingerprint[] = [];
    for (const sequenceName of sequenceNames) {
      const sequence = quoteIdentifier(sequenceName);
      const rows = await tx.unsafe<Array<{ last_value: string; is_called: boolean }>>(
        `SELECT last_value::text AS last_value, is_called FROM public.${sequence}`,
      );
      invariant(rows[0], `could not fingerprint public sequence ${sequenceName}`);
      sequences.push({
        sequence: sequenceName,
        lastValue: String(rows[0].last_value),
        isCalled: Boolean(rows[0].is_called),
      });
    }
    const schemaRows = await tx<Array<{ count: number }>>`
      SELECT count(*)::integer AS count
      FROM pg_namespace
      WHERE starts_with(nspname, ${DIY_HOME_SCHEMA_PREFIX})
    `;
    return {
      tables: tableRows.map((row) => ({
        table: row.table_name,
        rows: row.row_count,
        digest: row.digest,
      })).sort((left, right) => left.table.localeCompare(right.table)),
      sequences,
      temporarySchemas: Number(schemaRows[0]?.count ?? -1),
    };
  });
}

function sameSnapshot(left: SafetySnapshot, right: SafetySnapshot): boolean {
  return JSON.stringify(left.tables) === JSON.stringify(right.tables)
    && JSON.stringify(left.sequences) === JSON.stringify(right.sequences)
    && left.temporarySchemas === right.temporarySchemas;
}

async function generatedColumns(
  client: ReturnType<typeof postgres>,
): Promise<Array<{ tableName: string; columnName: string }>> {
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx`SET LOCAL search_path TO public, pg_temp`;
    const rows = await tx<Array<{ table_name: string; column_name: string }>>`
      SELECT DISTINCT table_class.relname AS table_name,
             attribute.attname AS column_name
      FROM pg_class AS table_class
      JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = table_class.oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
      JOIN pg_depend AS dependency
        ON dependency.refobjid = table_class.oid
       AND dependency.refobjsubid = attribute.attnum
       AND dependency.deptype IN ('a', 'i')
      JOIN pg_class AS sequence_class
        ON sequence_class.oid = dependency.objid
       AND sequence_class.relkind = 'S'
      WHERE table_namespace.nspname = 'public'
        AND table_class.relname IN ${tx(DIY_HOME_CLONE_TABLES)}
      ORDER BY table_class.relname, attribute.attname
    `;
    return rows.map((row) => ({
      tableName: row.table_name,
      columnName: row.column_name,
    }));
  });
}

async function createIsolatedSchema(
  client: ReturnType<typeof postgres>,
  schemaName: string,
): Promise<number> {
  const schema = quoteIdentifier(schemaName);
  const identityColumns = await generatedColumns(client);
  await client.begin(async (tx) => {
    await tx`SET LOCAL search_path TO public, pg_temp`;
    await tx`SET LOCAL statement_timeout = '45s'`;
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const tableName of DIY_HOME_CLONE_TABLES) {
      const table = quoteIdentifier(tableName);
      await tx.unsafe(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    for (const binding of identityColumns) {
      const table = quoteIdentifier(binding.tableName);
      const column = quoteIdentifier(binding.columnName);
      await tx.unsafe(`ALTER TABLE ${schema}.${table} ALTER COLUMN ${column} DROP IDENTITY IF EXISTS`);
      await tx.unsafe(`ALTER TABLE ${schema}.${table} ALTER COLUMN ${column} DROP DEFAULT`);
      await tx.unsafe(
        `ALTER TABLE ${schema}.${table} ALTER COLUMN ${column} ADD GENERATED BY DEFAULT AS IDENTITY`,
      );
    }
    const leaked = await tx.unsafe<Array<{ count: number }>>(`
      WITH external_default_sequences AS (
        SELECT DISTINCT sequence_class.oid
        FROM pg_class AS table_class
        JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
        JOIN pg_attribute AS attribute ON attribute.attrelid = table_class.oid
        JOIN pg_attrdef AS default_value
          ON default_value.adrelid = table_class.oid
         AND default_value.adnum = attribute.attnum
        JOIN pg_depend AS dependency
          ON dependency.classid = 'pg_attrdef'::regclass
         AND dependency.objid = default_value.oid
        JOIN pg_class AS sequence_class
          ON sequence_class.oid = dependency.refobjid
         AND sequence_class.relkind = 'S'
        JOIN pg_namespace AS sequence_namespace
          ON sequence_namespace.oid = sequence_class.relnamespace
        WHERE table_namespace.nspname = '${schemaName}'
          AND sequence_namespace.nspname <> '${schemaName}'
      ), external_owned_sequences AS (
        SELECT DISTINCT sequence_class.oid
        FROM pg_class AS table_class
        JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
        JOIN pg_depend AS dependency
          ON dependency.refobjid = table_class.oid
         AND dependency.refobjsubid > 0
         AND dependency.deptype IN ('a', 'i')
        JOIN pg_class AS sequence_class
          ON sequence_class.oid = dependency.objid
         AND sequence_class.relkind = 'S'
        JOIN pg_namespace AS sequence_namespace
          ON sequence_namespace.oid = sequence_class.relnamespace
        WHERE table_namespace.nspname = '${schemaName}'
          AND sequence_namespace.nspname <> '${schemaName}'
      )
      SELECT count(*)::integer AS count
      FROM (
        SELECT oid FROM external_default_sequences
        UNION
        SELECT oid FROM external_owned_sequences
      ) AS external_sequences
    `);
    invariant(Number(leaked[0]?.count ?? -1) === 0, "clone retained an external sequence dependency");
  });
  return identityColumns.length;
}

async function dropIsolatedSchema(
  client: ReturnType<typeof postgres>,
  schemaName: string,
): Promise<void> {
  const schema = quoteIdentifier(schemaName);
  await client.begin(async (tx) => {
    await tx`SET LOCAL search_path TO public, pg_temp`;
    await tx`SET LOCAL statement_timeout = '45s'`;
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });
}

async function schemaExists(
  client: ReturnType<typeof postgres>,
  schemaName: string,
): Promise<boolean> {
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION READ ONLY`;
    await tx`SET LOCAL search_path TO public, pg_temp`;
    const rows = await tx<Array<{ present: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_namespace WHERE nspname = ${schemaName}
      ) AS present
    `;
    return Boolean(rows[0]?.present);
  });
}

/**
 * Hyperdrive can reuse a backend that ignored a startup search_path option.
 * Pin one isolated schema in every top-level transaction. Nested service
 * transactions become savepoints and inherit this SET LOCAL value.
 */
async function withIsolatedTransaction<T>(
  db: DbClient,
  schemaName: string,
  action: (tx: DbClient) => Promise<T>,
): Promise<T> {
  const schema = quoteIdentifier(schemaName);
  return db.transaction(async (rawTx) => {
    const tx: DbClient = Object.assign(rawTx, { $client: db.$client });
    // Listing pg_temp explicitly places it after the isolated schema. If it is
    // omitted PostgreSQL implicitly searches a session temp schema first.
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${schema}, pg_temp`));
    // Keep timestamp-without-time-zone fixtures stable regardless of the
    // production server's session TimeZone.
    await tx.execute(sql`SET LOCAL TIME ZONE 'UTC'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    const current = await tx.execute(sql<{
      schema_name: string;
      configured_path: string;
      resolved_schema: string | null;
    }>`
      SELECT
        current_schema() AS schema_name,
        current_setting('search_path') AS configured_path,
        (
          SELECT namespace.nspname
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE relation.oid = to_regclass('system_dise')
        ) AS resolved_schema
    `);
    const pinned = current[0];
    invariant(pinned, "transaction search_path state was not returned");
    invariant(pinned.schema_name === schemaName, "transaction schema was not pinned");
    const configuredPath = String(pinned.configured_path)
      .split(",")
      .map((entry) => entry.trim().replaceAll('"', ""));
    invariant(
      configuredPath.length === 2
        && configuredPath[0] === schemaName
        && configuredPath[1] === "pg_temp",
      "transaction search_path was not isolated with pg_temp last",
    );
    invariant(pinned.resolved_schema === schemaName, "unqualified table escaped isolated schema");
    return action(tx);
  });
}

async function seedFixture(db: DbClient, schemaName: string): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  const homeComponents = JSON.stringify([
    { name: "customerService", routine_contact_type: 0 },
    {
      name: "promotionList",
      titleShow: { title: "drop", val: 1 },
      opriceShow: { title: "drop", val: 1 },
      priceShow: { title: "drop", val: 1 },
      couponShow: { title: "drop", val: 1 },
    },
    {
      name: "activeParty",
      titleConfig: { place: 1, max: 2, color: "#000000" },
      desConfig: { place: 1, max: 2, color: "#111111" },
      menuConfig: { list: { info: [{ tips: "drop", max: 2, id: 1 }] } },
    },
    { name: "pageFoot", list: [] },
  ]);
  const suspended = JSON.stringify({
    is_show: 1,
    index: 1,
    shifting: 0,
    main_ago_image: "/fixture/ago.png",
    unknown_fixture_key: "must-not-survive",
  });
  await withIsolatedTransaction(db, schemaName, async (tx) => {
    await tx.execute(sql`
      INSERT INTO system_dise
        (id, name, title, value, type, status, is_del, template_name, version,
         is_diy, is_show, is_bg_color, is_bg_pic, color_picker, bg_pic, bg_tab_val, order_status)
      VALUES
        (${FIXTURE.defaultDiy}, 'fixture-home', 'Fixture Home', ${homeComponents}, 1, 1, 0,
         'default', 'fixture-v1', 1, 1, 1, 0, '#ffffff', '', 0, 1),
        (${FIXTURE.explicitDiy}, 'fixture-explicit', 'Fixture Explicit', ${homeComponents}, 1, 0, 0,
         'fixture-explicit', 'fixture-v2', 1, 1, 0, 0, '#ffffff', '', 0, 1),
        (7003, 'fixture-suspended', 'Fixture Suspended', ${suspended}, 3, 1, 0,
         'suspended_window', 'fixture-v1', 0, 1, 0, 0, '', '', 0, 0)
    `);

    await tx.execute(sql`
      INSERT INTO system_config (id, is_store, menu_name, value, sort, status)
      VALUES
        (71001, 0, 'station_open', '1', 1, 1),
        (71002, 0, 'routine_contact_type', '2', 1, 1),
        (71003, 0, 'image_thumb_status', '0', 1, 1),
        (71004, 0, 'site_url', 'https://fixture.invalid', 1, 1),
        (71005, 0, 'video_func_status', '1', 1, 1),
        (71006, 0, 'site_name', 'Fixture Shop', 1, 1),
        (71007, 0, 'wap_login_logo', '/fixture/logo.png', 1, 1),
        (71008, 0, 'newcomer_status', '1', 1, 1),
        (71009, 0, 'register_integral_status', '1', 1, 1),
        (71010, 0, 'register_give_integral', '8', 1, 1),
        (71011, 0, 'register_coupon_status', '1', 1, 1),
        (71012, 0, 'register_give_coupon', '7301', 1, 1),
        (71013, 0, 'register_price_status', '1', 1, 1),
        (71014, 0, 'newcomer_limit_status', '1', 1, 1),
        (71015, 0, 'newcomer_limit_time', '30', 1, 1),
        (71016, 0, 'member_card_status', '1', 1, 1),
        (71017, 0, 'svip_price_status', '1', 1, 1),
        (71018, 0, 'sign_give_point', '3', 1, 1),
        (71019, 0, 'member_func_status', '1', 1, 1),
        (71020, 0, 'sign_give_exp', '0', 1, 1),
        (71021, 0, 'sign_status', '1', 1, 1)
    `);

    await tx.execute(sql`
      INSERT INTO system_user_level
        (id, name, is_show, grade, is_del, exp_num, discount)
      VALUES
        (7201, 'Fixture Level One', 1, 1, 0, 0, 95),
        (7202, 'Fixture Level Two', 1, 2, 0, 100, 90)
    `);
    await tx.execute(sql`
      INSERT INTO "user"
        (uid, account, nickname, phone, avatar, status, is_del, level, integral, exp,
         now_money, is_money_level, is_ever_level, overdue_time, is_newcomer, add_time)
      VALUES
        (${FIXTURE.owner}, 'fixture_owner', 'Fixture Owner', '', '', 1, 0, 7201, 10, 20,
         5, 0, 0, 0, 0, ${now - 86_400}),
        (${FIXTURE.paidMember}, 'fixture_paid', 'Fixture Paid', '', '', 1, 0, 7201, 0, 0,
         0, 1, 1, ${now + 86_400}, 0, ${now - 86_400})
    `);

    await tx.execute(sql`
      INSERT INTO store_brand (id, brand_name, is_show, is_del, sort)
      VALUES (7601, 'Fixture Brand', 1, 0, 1)
    `);
    await tx.execute(sql`
      INSERT INTO store_product_label
        (id, type, relation_id, label_name, style_type, is_show, status, sort)
      VALUES (7602, 0, 0, 'Fixture Label', 1, 1, 1, 1)
    `);
    await tx.execute(sql`
      INSERT INTO store_product
        (id, store_name, image, price, ot_price, vip_price, stock, sales, ficti, star,
         collect, sort, is_show, is_del, is_verify, pid, is_vip, is_vip_product,
         store_label_id, brand_id, activity)
      VALUES
        (${FIXTURE.visibleProduct}, 'Fixture Visible', '/fixture/product-1.png', 19.90, 29.90, 17.90,
         20, 10, 5, 4.2, 1, 3, 1, 0, 1, 0, 1, 0, '7602', 7601, '0,1,2,3'),
        (${FIXTURE.salesProduct}, 'Fixture Sales', '/fixture/product-2.png', 25.90, 35.90, 0,
         20, 5, 30, 3.0, 5, 2, 1, 0, 1, 0, 0, 0, '', 0, ''),
        (${FIXTURE.starProduct}, 'Fixture Star', '/fixture/product-3.png', 15.90, 20.90, 0,
         20, 20, 0, 4.9, 0, 1, 1, 0, 1, 0, 0, 0, '', 0, ''),
        (${FIXTURE.vipProduct}, 'Fixture VIP', '/fixture/product-4.png', 39.90, 49.90, 29.90,
         20, 40, 0, 4.8, 3, 4, 1, 0, 1, 0, 1, 1, '', 0, ''),
        (${FIXTURE.hiddenProduct}, 'Fixture Hidden', '/fixture/product-5.png', 9.90, 12.90, 0,
         20, 100, 100, 5.0, 100, 9, 0, 0, 0, 0, 0, 0, '', 0, '')
    `);

    await tx.execute(sql`
      INSERT INTO store_coupon_issue
        (id, cid, category, coupon_type, coupon_title, type, coupon_price, use_min_price,
         legacy_product_ids, legacy_category_id, legacy_brand_id, status, is_del, receive_type,
         start_time, end_time, day, full_reduction, use_start_time, use_end_time, rule,
         total_count, remain_count, add_time)
      VALUES
        (7301, 73, 0, 2, 'Fixture Newcomer Coupon', 1, 12.50, 99.00,
         ${String(FIXTURE.visibleProduct)}, 7601, 7601, 1, 0, 2,
         to_timestamp(${now - 3_600}), to_timestamp(${now + 86_400}), 7, 3.25,
         to_timestamp(${now - 3_600}), to_timestamp(${now + 7 * 86_400}), 'fixture rule',
         100, 50, ${now})
    `);
    await tx.execute(sql`
      INSERT INTO store_coupon_user
        (id, uid, issue_coupon_id, coupon_title, coupon_price, use_min_price, status,
         start_time, end_time, use_time, receive_time, receive_source, is_fail)
      VALUES
        (7302, ${FIXTURE.owner}, 7301, 'Fixture User Coupon', 12.50, 99.00, 0,
         to_timestamp(${now - 3_600}), to_timestamp(${now + 86_400}), NULL,
         ${now}, 'newcomer', 0)
    `);
    await tx.execute(sql`
      INSERT INTO store_coupon_product (coupon_id, product_id)
      VALUES (7301, ${FIXTURE.visibleProduct})
    `);

    await tx.execute(sql`
      INSERT INTO user_relation (id, uid, relation_id, type, category, add_time)
      VALUES
        (7401, ${FIXTURE.owner}, ${FIXTURE.visibleProduct}, 'collect', 'product', ${now}),
        (7402, ${FIXTURE.owner}, ${FIXTURE.visibleVideo}, 'collect', 'video', ${now})
    `);
    await tx.execute(sql`
      INSERT INTO store_product_log
        (id, type, product_id, uid, visit_num, add_time)
      VALUES
        (7451, 'visit', ${FIXTURE.visibleProduct}, ${FIXTURE.owner}, 1, ${now - 100}),
        (7452, 'visit', ${FIXTURE.visibleProduct}, ${FIXTURE.owner}, 1, ${now})
    `);

    await tx.execute(sql`
      INSERT INTO video
        (id, image, "desc", video_url, product_id, is_show, is_recommend, sort,
         is_verify, collect_num, play_num, add_time, is_del)
      VALUES
        (${FIXTURE.visibleVideo}, '/fixture/video.png', 'Fixture Video', '/fixture/video.mp4',
         '7501,7505', 1, 1, 10, 1, 1, 4, ${now}, 0),
        (7702, '/fixture/unreviewed.png', 'Fixture Unreviewed', '/fixture/unreviewed.mp4',
         '7502', 1, 1, 20, 0, 0, 0, ${now}, 0)
    `);
    await tx.execute(sql`
      INSERT INTO live_room
        (id, room_id, name, anchor_name, anchor_wechat, phone, status, live_status,
         is_show, is_del, start_time, end_time)
      VALUES
        (7801, 78001, 'Fixture Live', 'Fixture Anchor', 'fixture-anchor', 'fixture-phone',
         1, 101, 1, 0, ${now - 600}, ${now + 3_600})
    `);

    await tx.execute(sql`
      INSERT INTO store_newcomer
        (id, product_id, price, ot_price, sales, is_del, add_time)
      VALUES
        (7901, ${FIXTURE.visibleProduct}, 1.00, 19.90, 5, 0, ${now}),
        (7902, ${FIXTURE.hiddenProduct}, 2.00, 9.90, 10, 1, ${now})
    `);
    await tx.execute(sql`
      INSERT INTO store_order
        (id, type, order_id, uid, paid, status, is_del, is_system_del, add_time, "unique")
      VALUES
        (8001, 7, 'fixture-newcomer-paid', ${FIXTURE.paidMember}, 1, 1, 0, 0, ${now},
         'fixture-newcomer-paid')
    `);

    await tx.execute(sql`
      INSERT INTO system_sign_reward (id, type, days, point, exp)
      VALUES
        (8101, 0, 2, 7, 0),
        (8102, 0, 5, 12, 0)
    `);
    await tx.execute(sql`
      INSERT INTO user_sign (id, uid, title, number, balance, exp_num, exp_balance, add_time)
      VALUES (8151, ${FIXTURE.owner}, 'Fixture Sign', 3, 13, 0, 20, ${now})
    `);

    await tx.execute(sql`
      INSERT INTO member_right (id, right_type, title, status, number, sort, add_time)
      VALUES (8301, 'vip_price', 'Fixture VIP Price', 1, 1, 1, ${now})
    `);
    await tx.execute(sql`
      INSERT INTO store_promotions
        (id, promotions_type, name, title, image, product_partake_type, product_id,
         start_time, stop_time, status, is_del, sort, add_time)
      VALUES
        (8201, 1, 'Fixture Promotion', 'Fixture Promotion', '', 1, '7501',
         ${now - 600}, ${now + 3_600}, 1, 0, 3, ${now}),
        (8202, 5, 'Fixture Frame', 'Fixture Frame', '/fixture/frame.png', 1, '7501',
         ${now - 600}, ${now + 3_600}, 1, 0, 2, ${now}),
        (8203, 6, 'Fixture Background', 'Fixture Background', '/fixture/background.png', 1, '7501',
         ${now - 600}, ${now + 3_600}, 1, 0, 1, ${now})
    `);
    await tx.execute(sql`
      INSERT INTO store_promotions_auxiliary
        (id, type, promotions_id, product_partake_type, product_id, is_all)
      VALUES
        (8251, 1, 8201, 1, ${FIXTURE.visibleProduct}, 0),
        (8252, 1, 8202, 1, ${FIXTURE.visibleProduct}, 0),
        (8253, 1, 8203, 1, ${FIXTURE.visibleProduct}, 0)
    `);
    await tx.execute(sql`
      INSERT INTO store_seckill
        (id, product_id, store_name, image, price, stock, is_show, is_del, start_time, stop_time, status)
      VALUES
        (8401, ${FIXTURE.visibleProduct}, 'Fixture Seckill', '/fixture/seckill.png', 9.90, 10,
         1, 0, to_timestamp(${now - 600}), to_timestamp(${now + 3_600}), 1)
    `);
    await tx.execute(sql`
      INSERT INTO store_combination
        (id, product_id, store_name, image, price, stock, is_show, is_del, start_time, stop_time, status)
      VALUES
        (8402, ${FIXTURE.visibleProduct}, 'Fixture Combination', '/fixture/combination.png', 11.90, 10,
         1, 0, to_timestamp(${now - 600}), to_timestamp(${now + 3_600}), 1)
    `);
    await tx.execute(sql`
      INSERT INTO store_bargain
        (id, product_id, title, image, price, stock, is_del, start_time, stop_time, status)
      VALUES
        (8403, ${FIXTURE.visibleProduct}, 'Fixture Bargain', '/fixture/bargain.png', 10.90, 10,
         0, to_timestamp(${now - 600}), to_timestamp(${now + 3_600}), 1)
    `);
  });
}

async function useDiyService<T>(
  db: DbClient,
  schemaName: string,
  env: Env,
  action: (service: DiyHomeCompatibilityService) => Promise<T>,
): Promise<T> {
  return withIsolatedTransaction(db, schemaName, (tx) => action(
    new DiyHomeCompatibilityService(createContainerFromDb(tx), createDiyHomeAuditRuntimeEnv(env)),
  ));
}

async function exerciseDiy(
  db: DbClient,
  schemaName: string,
  env: Env,
): Promise<ScenarioAssertions["diy"]> {
  const [homeValue, explicitValue, missingValue, defaultVersion, explicitVersion] = await Promise.all([
    useDiyService(db, schemaName, env, (service) => service.getDiy(0)),
    useDiyService(db, schemaName, env, (service) => service.getDiy(FIXTURE.explicitDiy)),
    useDiyService(db, schemaName, env, (service) => service.getDiy(2_147_000_000)),
    useDiyService(db, schemaName, env, (service) => service.diyVersion(0)),
    useDiyService(db, schemaName, env, (service) => service.diyVersion(FIXTURE.explicitDiy)),
  ]);
  const home = objectValue(homeValue, "default DIY");
  const explicit = objectValue(explicitValue, "explicit DIY");
  const missing = objectValue(missingValue, "fallback DIY");
  const homeComponents = arrayValue(home.value, "default DIY value");
  const explicitComponents = arrayValue(explicit.value, "explicit DIY value");
  const missingComponents = arrayValue(missing.value, "fallback DIY value");
  const defaultNames = homeComponents.map(componentName);
  const explicitNames = explicitComponents.map(componentName);
  const promotion = objectValue(
    homeComponents.find((component) => componentName(component) === "promotionList"),
    "promotionList component",
  );
  const activeParty = objectValue(
    homeComponents.find((component) => componentName(component) === "activeParty"),
    "activeParty component",
  );
  const promotionViews = ["titleShow", "opriceShow", "priceShow", "couponShow"]
    .map((key) => objectValue(promotion[key], `promotionList ${key}`));
  const titleConfig = objectValue(activeParty.titleConfig, "activeParty titleConfig");
  const desConfig = objectValue(activeParty.desConfig, "activeParty desConfig");
  const menuConfig = objectValue(activeParty.menuConfig, "activeParty menuConfig");
  const menuList = objectValue(menuConfig.list, "activeParty menu list");
  const menuInfo = arrayValue(menuList.info, "activeParty menu info");
  const firstMenuItem = objectValue(menuInfo[0], "activeParty menu item");
  const defaultContract = hasKeys(home, [
    "title", "value", "is_show", "is_bg_color", "color_picker", "bg_pic",
    "bg_tab_val", "is_bg_pic", "order_status",
  ]) && !defaultNames.includes("pageFoot") && defaultNames.includes("customerService");
  const explicitContract = explicitNames.includes("pageFoot");
  // PHP falls back to the default row but still evaluates pageFoot against the
  // original non-zero request id, so the fallback retains the footer.
  const missingFallsBack = JSON.stringify(explicitNames) === JSON.stringify(
    missingComponents.map(componentName),
  );
  const versionContract = hasKeys(objectValue(defaultVersion, "default DIY version"), ["version"])
    && hasKeys(objectValue(explicitVersion, "explicit DIY version"), ["version"]);
  const componentSanitization = promotionViews.every((view) => (
    !Object.hasOwn(view, "title") && view.val === 1
  ))
    && !Object.hasOwn(titleConfig, "place")
    && !Object.hasOwn(titleConfig, "max")
    && titleConfig.color === "#000000"
    && !Object.hasOwn(desConfig, "place")
    && !Object.hasOwn(desConfig, "max")
    && desConfig.color === "#111111"
    && !Object.hasOwn(firstMenuItem, "tips")
    && !Object.hasOwn(firstMenuItem, "max")
    && firstMenuItem.id === 1;
  invariant(defaultContract, "default DIY projection and pageFoot removal");
  invariant(explicitContract, "explicit DIY retains pageFoot");
  invariant(missingFallsBack, "missing explicit DIY falls back to default");
  invariant(versionContract, "DIY version response");
  invariant(componentSanitization, "legacy DIY component fields are stripped without losing siblings");
  return {
    defaultContract,
    explicitContract,
    missingFallsBack,
    versionContract,
    componentSanitization,
  };
}

async function exerciseUser(
  db: DbClient,
  schemaName: string,
  env: Env,
): Promise<ScenarioAssertions["user"]> {
  const [anonymousValue, authenticatedValue] = await Promise.all([
    useDiyService(db, schemaName, env, (service) => service.userInfo(0)),
    useDiyService(db, schemaName, env, (service) => service.userInfo(FIXTURE.owner)),
  ]);
  const anonymousEmpty = Array.isArray(anonymousValue) && anonymousValue.length === 0;
  const authenticated = objectValue(authenticatedValue, "authenticated user_info");
  const authenticatedShape = hasKeys(authenticated, [
    "uid", "nickname", "phone", "avatar", "level", "integral", "now_money", "exp",
    "is_money_level", "bar_code", "coupon_num", "vip_name", "next_exp", "collectCount", "visit_num",
  ]);
  const aggregateCounts = Number(authenticated.coupon_num) === 1
    && Number(authenticated.collectCount) === 2
    && Number(authenticated.visit_num) === 1;
  invariant(anonymousEmpty, "anonymous user_info is an empty array");
  invariant(authenticatedShape, "authenticated user_info keys");
  invariant(aggregateCounts, "coupon, collection and distinct visit aggregates");
  return { anonymousEmpty, authenticatedShape, aggregateCounts };
}

async function playCount(db: DbClient, schemaName: string): Promise<{ counter: number; relations: number }> {
  return withIsolatedTransaction(db, schemaName, async (tx) => {
    const rows = await tx.execute(sql<{ counter: number; relations: number }>`
      SELECT
        (SELECT play_num::integer FROM video WHERE id = ${FIXTURE.visibleVideo}) AS counter,
        (SELECT count(*)::integer FROM user_relation
          WHERE relation_id = ${FIXTURE.visibleVideo} AND type = 'play' AND category = 'video') AS relations
    `);
    invariant(rows[0], "video play state missing");
    return { counter: Number(rows[0].counter), relations: Number(rows[0].relations) };
  });
}

async function exerciseVideo(
  db: DbClient,
  schemaName: string,
  env: Env,
): Promise<ScenarioAssertions["video"]> {
  const before = await playCount(db, schemaName);
  const enabledValue = await useDiyService(
    db,
    schemaName,
    env,
    (service) => service.videoList(FIXTURE.owner, { page: "1", limit: "10" }),
  );
  const afterRead = await playCount(db, schemaName);
  const enabled = objectValue(enabledValue, "video_list");
  const list = arrayValue(enabled.list, "video list items");
  const playIds = arrayValue(enabled.playIds, "video play ids").map(Number);
  const first = objectValue(list[0], "video list item");
  const productInfo = arrayValue(first.product_info, "video product_info");
  const listContract = list.length === 1
    && playIds.length === 1
    && Array.isArray(first.product_id)
    && first.product_id[0] === String(FIXTURE.visibleProduct)
    && Number(first.product_num) === productInfo.length
    && productInfo.length === 1
    && hasKeys(objectValue(productInfo[0], "video product"), ["id", "store_name", "image", "price"]);
  const readPathDidNotWrite = before.counter === afterRead.counter && before.relations === afterRead.relations;
  invariant(listContract, "video list filtering and product projection");
  invariant(readPathDidNotWrite, "video list read path changed play state");

  await withIsolatedTransaction(db, schemaName, (tx) => tx.execute(sql`
    UPDATE system_config SET value = '0' WHERE is_store = 0 AND menu_name = 'video_func_status'
  `));
  const disabledValue = await useDiyService(
    db,
    schemaName,
    env,
    (service) => service.videoList(FIXTURE.owner, { page: "1", limit: "10" }),
  );
  const disabled = objectValue(disabledValue, "disabled video_list");
  const disabledContract = arrayValue(disabled.list, "disabled video list").length === 0
    && arrayValue(disabled.playIds, "disabled video play ids").length === 0;
  invariant(disabledContract, "disabled video contract");
  await withIsolatedTransaction(db, schemaName, (tx) => tx.execute(sql`
    UPDATE system_config SET value = '1' WHERE is_store = 0 AND menu_name = 'video_func_status'
  `));

  await withIsolatedTransaction(db, schemaName, (tx) => new ShortVideoService(
    createContainerFromDb(tx),
    createDiyHomeAuditRuntimeEnv(env),
  ).recordPlays(playIds, 0));
  const afterWrite = await playCount(db, schemaName);
  const isolatedPlaybackWrite = afterWrite.counter === before.counter + 1
    && afterWrite.relations === before.relations + 1;
  invariant(isolatedPlaybackWrite, "isolated playback write and relation evidence");
  return { listContract, disabledContract, readPathDidNotWrite, isolatedPlaybackWrite };
}

function newcomerProductCount(value: Record<string, unknown>): number {
  return Array.isArray(value.newcomer_products) ? value.newcomer_products.length : -1;
}

async function exerciseNewcomer(
  db: DbClient,
  schemaName: string,
  env: Env,
): Promise<ScenarioAssertions["newcomer"]> {
  const params = { page: "1", limit: "10", priceOrder: "asc", salesOrder: "" };
  const [anonymousValue, eligibleValue, paidValue] = await Promise.all([
    useDiyService(db, schemaName, env, (service) => service.newcomerList(0, params)),
    useDiyService(db, schemaName, env, (service) => service.newcomerList(FIXTURE.owner, params)),
    useDiyService(db, schemaName, env, (service) => service.newcomerList(FIXTURE.paidMember, params)),
  ]);
  const anonymous = objectValue(anonymousValue, "anonymous newcomer_list");
  const eligible = objectValue(eligibleValue, "eligible newcomer_list");
  const paid = objectValue(paidValue, "paid newcomer_list");
  const keys = ["newcomer_products", "newcomer_integral", "newcomer_coupon"] as const;
  const anonymousCoupons = arrayValue(anonymous.newcomer_coupon, "anonymous newcomer coupons");
  const loggedCoupons = arrayValue(eligible.newcomer_coupon, "logged-in newcomer coupons");
  const anonymousCoupon = objectValue(anonymousCoupons[0], "anonymous newcomer coupon");
  const loggedCoupon = objectValue(loggedCoupons[0], "logged-in newcomer coupon");
  const anonymousContract = hasKeys(anonymous, keys)
    && newcomerProductCount(anonymous) === 1
    && anonymousCoupons.length === 1;
  const eligibleContract = hasKeys(eligible, keys)
    && newcomerProductCount(eligible) === 1
    && typeof eligible.newcomer_integral === "number"
    && loggedCoupons.length === 1;
  const paidOrderIneligible = hasKeys(paid, keys)
    && newcomerProductCount(paid) === 0
    && arrayValue(paid.newcomer_coupon, "paid newcomer coupons").length === 0;
  const anonymousCouponShape = Number(anonymousCoupon.type) === 2
    && Number(anonymousCoupon.coupon_type) === 1
    && typeof anonymousCoupon.coupon_price === "string"
    && typeof anonymousCoupon.use_min_price === "string"
    && typeof anonymousCoupon.full_reduction === "string"
    && typeof anonymousCoupon.start_time === "number"
    && typeof anonymousCoupon.end_time === "number";
  const loggedCouponChecks = {
    status: loggedCoupon.status === "未使用",
    receiveSource: loggedCoupon.type === "新人礼赠送",
    couponPriceValue: Number(loggedCoupon.coupon_price) === 12.5,
    couponPriceType: typeof loggedCoupon.coupon_price === "number",
    mobileType: loggedCoupon._type === 2,
    mobileMessage: loggedCoupon._msg === "立即使用",
    pcType: loggedCoupon.pc_type === 1,
    pcMessage: loggedCoupon.pc_msg === "可使用",
    addTime: typeof loggedCoupon._add_time === "string",
    endTime: typeof loggedCoupon._end_time === "string",
    applicableType: Number(loggedCoupon.applicable_type) === 2,
    couponType: Number(loggedCoupon.coupon_type) === 1,
    couponTime: Number(loggedCoupon.coupon_time) === 7,
    rule: loggedCoupon.rule === "fixture rule",
  };
  const loggedCouponShape = Object.values(loggedCouponChecks).every(Boolean);
  const earlyIntegralArray = Array.isArray(paid.newcomer_integral);

  const now = Math.floor(Date.now() / 1_000);
  await withIsolatedTransaction(db, schemaName, async (tx) => {
    await tx.execute(sql`
      UPDATE "user" SET add_time = ${now - 90 * 86_400} WHERE uid = ${FIXTURE.owner}
    `);
    await tx.execute(sql`
      DELETE FROM system_config WHERE is_store = 0 AND menu_name = 'newcomer_limit_status'
    `);
  });
  const missingLimit = objectValue(await useDiyService(
    db,
    schemaName,
    env,
    (service) => service.newcomerList(FIXTURE.owner, params),
  ), "missing newcomer_limit_status");
  await withIsolatedTransaction(db, schemaName, (tx) => tx.execute(sql`
    INSERT INTO system_config (id, is_store, menu_name, value, sort, status)
    VALUES (71014, 0, 'newcomer_limit_status', '', 1, 1)
  `));
  const explicitEmptyLimit = objectValue(await useDiyService(
    db,
    schemaName,
    env,
    (service) => service.newcomerList(FIXTURE.owner, params),
  ), "explicit-empty newcomer_limit_status");
  const limitPresenceContract = newcomerProductCount(missingLimit) === 0
    && Array.isArray(missingLimit.newcomer_integral)
    && newcomerProductCount(explicitEmptyLimit) === 1
    && typeof explicitEmptyLimit.newcomer_integral === "number";
  await withIsolatedTransaction(db, schemaName, async (tx) => {
    await tx.execute(sql`
      UPDATE "user" SET add_time = ${now - 86_400} WHERE uid = ${FIXTURE.owner}
    `);
    await tx.execute(sql`
      UPDATE system_config SET value = '1'
        WHERE is_store = 0 AND menu_name = 'newcomer_limit_status'
    `);
  });

  invariant(anonymousContract, "anonymous newcomer products and stable keys");
  invariant(eligibleContract, "eligible newcomer projection");
  invariant(paidOrderIneligible, "paid type-7 order blocks newcomer eligibility");
  invariant(anonymousCouponShape, "anonymous newcomer coupon preserves raw model types");
  invariant(
    loggedCouponShape,
    `logged newcomer coupon accessors, tidy states and issue binds: ${Object.entries(loggedCouponChecks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
      .join(",")}`,
  );
  invariant(earlyIntegralArray, "ineligible newcomer integral keeps PHP empty-array type");
  invariant(limitPresenceContract, "missing and explicit-empty newcomer limit configs differ");
  return {
    anonymousContract,
    eligibleContract,
    paidOrderIneligible,
    anonymousCouponShape,
    loggedCouponShape,
    earlyIntegralArray,
    limitPresenceContract,
  };
}

function flattenedRankItems(rank: Record<string, unknown>): unknown[] {
  return ["sales", "star", "collect"].flatMap((key) => arrayValue(rank[key], `rank ${key}`));
}

async function exerciseRank(
  db: DbClient,
  schemaName: string,
  env: Env,
): Promise<ScenarioAssertions["rank"]> {
  const [anonymousValue, memberValue] = await Promise.all([
    useDiyService(db, schemaName, env, (service) => service.productRank(0, 3)),
    useDiyService(db, schemaName, env, (service) => service.productRank(FIXTURE.paidMember, 3)),
  ]);
  const anonymous = objectValue(anonymousValue, "anonymous product_rank");
  const member = objectValue(memberValue, "member product_rank");
  const anonymousItems = flattenedRankItems(anonymous);
  const memberItems = flattenedRankItems(member);
  const threeLists = ["sales", "star", "collect"].every((key) => {
    const items = arrayValue(anonymous[key], `anonymous rank ${key}`);
    return items.length > 0 && items.length <= 3;
  });
  const anonymousVipBoundary = anonymousItems.every((item) => numericProductId(item) !== FIXTURE.vipProduct)
    && anonymousItems.every((item) => numericProductId(item) !== FIXTURE.hiddenProduct);
  const memberVipBoundary = memberItems.some((item) => numericProductId(item) === FIXTURE.vipProduct);
  const decorated = objectValue(arrayValue(anonymous.sales, "sales rank")[0], "decorated rank item");
  const decorationKeys = hasKeys(decorated, [
    "product_id", "activity", "checkCoupon", "promotions", "activity_frame",
    "activity_background", "store_label", "presale_pay_status",
  ]);
  invariant(threeLists, "three nonempty bounded rank lists");
  invariant(anonymousVipBoundary, "anonymous rank excludes VIP-only and hidden products");
  invariant(memberVipBoundary, "paid member rank includes VIP-only products");
  invariant(decorationKeys, "rank decoration compatibility keys");
  return { threeLists, anonymousVipBoundary, memberVipBoundary, decorationKeys };
}

async function exerciseSign(
  db: DbClient,
  schemaName: string,
  env: Env,
): Promise<ScenarioAssertions["sign"]> {
  const [anonymousValue, authenticatedValue] = await Promise.all([
    useDiyService(db, schemaName, env, (service) => service.homeSign(0)),
    useDiyService(db, schemaName, env, (service) => service.homeSign(FIXTURE.owner)),
  ]);
  const anonymous = objectValue(anonymousValue, "anonymous home sign");
  const authenticated = objectValue(authenticatedValue, "authenticated home sign");
  const signOuter = arrayValue(authenticated.signList, "home sign outer list");
  const signWeek = arrayValue(signOuter[0], "home sign week");
  const shanghaiWeek = signOuter.length === 1
    && signWeek.length === 7
    && signWeek.every((item) => hasKeys(
      objectValue(item, "home sign day"),
      ["day", "is_sign", "sign_day", "type", "point"],
    ))
    && signWeek.filter((item) => objectValue(item, "home sign day").sign_day === true).length === 1;
  const authenticatedState = anonymous.checkSign === false && authenticated.checkSign === true;
  const rewardList = arrayValue(
    authenticated.nextContinuousSignRewardList,
    "next continuous sign reward list",
  );
  const rewardContract = rewardList.length === 1
    && hasKeys(objectValue(rewardList[0], "continuous sign reward"), ["id", "type", "days", "point", "exp"])
    && hasKeys(authenticated, ["signStatus", "sign_give_point"]);
  invariant(shanghaiWeek, "home sign Shanghai Monday-Sunday shape");
  invariant(authenticatedState, "anonymous/authenticated sign state");
  invariant(rewardContract, "next continuous reward and config projection");
  return { shanghaiWeek, authenticatedState, rewardContract };
}

async function exerciseSuspended(
  db: DbClient,
  schemaName: string,
  env: Env,
): Promise<ScenarioAssertions["suspended"]> {
  const value = objectValue(
    await useDiyService(db, schemaName, env, (service) => service.suspended()),
    "suspended window",
  );
  const defaultsMerged = hasKeys(value, [
    "is_show", "index", "shifting", "main_ago_image", "main_after_image", "button",
  ]) && arrayValue(value.button, "suspended buttons").length === 4;
  const unknownKeysDropped = !Object.hasOwn(value, "unknown_fixture_key");
  invariant(defaultsMerged, "suspended defaults and four buttons");
  invariant(unknownKeysDropped, "suspended unknown keys are dropped");
  return { defaultsMerged, unknownKeysDropped };
}

async function exerciseScenario(
  db: DbClient,
  schemaName: string,
  env: Env,
): Promise<ScenarioAssertions> {
  await seedFixture(db, schemaName);
  return {
    diy: await exerciseDiy(db, schemaName, env),
    user: await exerciseUser(db, schemaName, env),
    video: await exerciseVideo(db, schemaName, env),
    newcomer: await exerciseNewcomer(db, schemaName, env),
    rank: await exerciseRank(db, schemaName, env),
    sign: await exerciseSign(db, schemaName, env),
    suspended: await exerciseSuspended(db, schemaName, env),
  };
}

/**
 * Exercise write-capable behavior only in a cryptographically random schema.
 * Public business rows and their owned sequence states are compared before
 * and after cleanup, including when a fixture or service assertion throws.
 */
export async function runDiyHomeWidgetsCompatibilityScenario(
  connectionString: string,
  env: Env,
) {
  const schemaName = `${DIY_HOME_SCHEMA_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(connectionString, {
    max: 2,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_diy_home_widgets_isolated_admin" },
  });
  let db: DbClient | undefined;
  let assertions: ScenarioAssertions | undefined;
  let identityColumnsRebound = 0;
  let scenarioFailure: unknown;
  let cleanupFailure: unknown;
  try {
    const before = await safetySnapshot(admin);
    try {
      identityColumnsRebound = await createIsolatedSchema(admin, schemaName);
      db = createDbFromConnectionString(connectionString, 5, {
        applicationName: "cinashop_diy_home_widgets_isolated_services",
      });
      assertions = await exerciseScenario(db, schemaName, env);
    } catch (error) {
      scenarioFailure = error;
    } finally {
      if (db) {
        try {
          await db.$client.end({ timeout: 1 });
        } catch (error) {
          cleanupFailure = error;
        }
      }
      try {
        await dropIsolatedSchema(admin, schemaName);
      } catch (error) {
        cleanupFailure ??= error;
      }
    }

    const dropped = !(await schemaExists(admin, schemaName));
    const after = await safetySnapshot(admin);
    invariant(dropped, "isolated schema still exists after cleanup");
    invariant(sameSnapshot(before, after), "public table or sequence fingerprint changed");
    if (cleanupFailure) throw cleanupFailure;
    if (scenarioFailure) throw scenarioFailure;
    invariant(assertions, "scenario did not produce assertions");
    return {
      passed: true,
      assertions,
      safety: {
        searchPathPinned: true,
        searchPathMode: "explicit target schema followed by pg_temp in every top-level transaction",
        timeZonePinned: "UTC",
        publicTablesFingerprinted: DIY_HOME_PUBLIC_TABLES.length,
        supportTablesFingerprinted: DIY_HOME_SUPPORT_TABLES.length,
        publicSequencesFingerprinted: before.sequences.length,
        publicRowsAndSequencesUnchanged: true,
        identityColumnsRebound,
        externalSequenceDependencies: 0,
        temporarySchemaCountUnchanged: true,
        isolatedSchemaDropped: true,
        fixtureDataReturned: false,
        realExternalBindingsUsed: false,
      },
    };
  } finally {
    await admin.end({ timeout: 1 });
  }
}
