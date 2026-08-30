import postgres from "postgres";
import { sql as drizzleSql } from "drizzle-orm";
import type { Env } from "@/env";
import { createContainerFromDb, createDbFromConnectionString, withTx } from "@/lib/di";
import {
  EnterpriseWechatContextService,
  type WorkContextStateStore,
} from "@/services/work/EnterpriseWechatContextService";
import { ForbiddenException, NotFoundException } from "@/utils/errors";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_READ_TOKEN_SHA256: string;
  AUDIT_ISOLATED_TOKEN_SHA256: string;
}

const TABLES = [
  "system_config",
  "work_member",
  "work_client",
  "work_client_follow",
  "work_client_follow_tags",
  "work_group_chat",
  "work_group_chat_member",
  "work_group_chat_statistic",
  "user",
  "store_order",
  "store_order_cart_info",
  "store_product",
  "store_visit",
] as const;
const SCHEMA_PREFIX = "codex_work_context_";

function decodeSha256(value: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function authorized(request: Request, expectedHex: string): Promise<boolean> {
  const expected = decodeSha256(expectedHex);
  if (!expected) return false;
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const actual = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied));
  return crypto.subtle.timingSafeEqual(actual, expected);
}

async function productionAudit(connectionString: string) {
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_work_context_read_only_audit" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      await tx`SET LOCAL search_path TO public, pg_temp`;
      await tx`SET LOCAL statement_timeout = '45s'`;
      await tx`SET LOCAL lock_timeout = '2s'`;

      const catalog = await tx<Array<{
        table_name: string;
        column_count: number;
        columns: string[];
        estimated_live_rows: number;
        estimated_dead_rows: number;
      }>>`
        SELECT table_name,
          count(*)::integer AS column_count,
          array_agg(column_name ORDER BY ordinal_position) AS columns,
          COALESCE(max(stats.n_live_tup), 0)::bigint AS estimated_live_rows,
          COALESCE(max(stats.n_dead_tup), 0)::bigint AS estimated_dead_rows
        FROM information_schema.columns AS columns
        LEFT JOIN pg_stat_user_tables AS stats
          ON stats.schemaname = columns.table_schema AND stats.relname = columns.table_name
        WHERE columns.table_schema = 'public' AND columns.table_name IN ${tx(TABLES)}
        GROUP BY table_name
        ORDER BY table_name
      `;

      const indexes = await tx<Array<{
        tablename: string;
        indexname: string;
        indexdef: string;
      }>>`
        SELECT tablename, indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN ${tx(TABLES)}
        ORDER BY tablename, indexname
      `;

      const work = await tx<Array<Record<string, number>>>`
        SELECT
          (SELECT count(*)::integer FROM work_member) AS members,
          (SELECT count(*)::integer FROM work_member WHERE enable = 1 AND status = 1) AS active_members,
          (SELECT count(*)::integer FROM work_client) AS clients,
          (SELECT count(*)::integer FROM work_client WHERE delete_time IS NULL) AS active_clients,
          (SELECT count(*)::integer FROM work_client WHERE delete_time IS NULL AND uid > 0) AS clients_bound_to_uid,
          (SELECT count(*)::integer FROM work_client_follow) AS follows,
          (SELECT count(*)::integer FROM work_client_follow WHERE is_del_user = 0) AS active_follows,
          (SELECT count(*)::integer FROM work_group_chat) AS groups,
          (SELECT count(*)::integer FROM work_group_chat WHERE status = 1) AS active_groups,
          (SELECT count(*)::integer FROM work_group_chat_member) AS group_members,
          (SELECT count(*)::integer FROM work_group_chat_member WHERE status = 1) AS active_group_members,
          (SELECT count(*)::integer FROM work_group_chat_statistic) AS group_statistics,
          (SELECT count(*)::integer FROM system_config
            WHERE is_store = 0 AND menu_name = 'wechat_work_corpid' AND value <> '') AS corp_config_nonblank,
          (SELECT count(*)::integer FROM system_config
            WHERE is_store = 0 AND menu_name = 'wechat_work_build_agent_id' AND value <> '') AS agent_config_nonblank
      `;

      const anomalies = await tx<Array<Record<string, number>>>`
        SELECT
          (SELECT count(*)::integer FROM (
            SELECT corp_id, userid FROM work_member
            GROUP BY corp_id, userid HAVING count(*) > 1
          ) AS duplicate) AS duplicate_member_identity_groups,
          (SELECT count(*)::integer FROM (
            SELECT corp_id, userid FROM work_member WHERE enable = 1 AND status = 1
            GROUP BY corp_id, userid HAVING count(*) > 1
          ) AS duplicate) AS duplicate_active_member_identity_groups,
          (SELECT count(*)::integer FROM (
            SELECT corp_id, external_userid FROM work_client WHERE delete_time IS NULL
            GROUP BY corp_id, external_userid HAVING count(*) > 1
          ) AS duplicate) AS duplicate_active_client_identity_groups,
          (SELECT count(*)::integer FROM (
            SELECT userid, client_id FROM work_client_follow WHERE is_del_user = 0
            GROUP BY userid, client_id HAVING count(*) > 1
          ) AS duplicate) AS duplicate_active_follow_groups,
          (SELECT count(*)::integer FROM (
            SELECT corp_id, chat_id FROM work_group_chat
            GROUP BY corp_id, chat_id HAVING count(*) > 1
          ) AS duplicate) AS duplicate_group_identity_groups,
          (SELECT count(*)::integer FROM (
            SELECT group_id, userid FROM work_group_chat_member WHERE status = 1
            GROUP BY group_id, userid HAVING count(*) > 1
          ) AS duplicate) AS duplicate_active_group_member_groups,
          (SELECT count(*)::integer FROM work_client AS client
            LEFT JOIN "user" AS account ON account.uid = client.uid
            WHERE client.delete_time IS NULL AND client.uid > 0 AND account.uid IS NULL) AS client_user_orphans,
          (SELECT count(*)::integer FROM work_client_follow AS follow
            LEFT JOIN work_client AS client ON client.id = follow.client_id
            WHERE follow.is_del_user = 0 AND client.id IS NULL) AS follow_client_orphans,
          (SELECT count(*)::integer FROM work_client_follow AS follow
            LEFT JOIN work_member AS member ON member.userid = follow.userid
              AND member.enable = 1 AND member.status = 1
            WHERE follow.is_del_user = 0 AND member.id IS NULL) AS follow_active_member_orphans,
          (SELECT count(*)::integer FROM work_group_chat_member AS relation
            LEFT JOIN work_group_chat AS group_chat ON group_chat.id = relation.group_id
            WHERE relation.status = 1 AND group_chat.id IS NULL) AS group_member_group_orphans,
          (SELECT count(*)::integer FROM work_group_chat_statistic AS statistic
            LEFT JOIN work_group_chat AS group_chat ON group_chat.id = statistic.group_id
            WHERE group_chat.id IS NULL) AS group_statistic_orphans,
          (SELECT count(*)::integer FROM work_group_chat AS group_chat
            LEFT JOIN work_member AS owner ON owner.corp_id = group_chat.corp_id
              AND owner.userid = group_chat.owner AND owner.enable = 1 AND owner.status = 1
            WHERE group_chat.status = 1 AND owner.id IS NULL) AS active_group_owner_orphans
      `;

      const visibility = await tx<Array<Record<string, number>>>`
        SELECT
          (SELECT count(*)::integer FROM work_client AS client
            JOIN work_client_follow AS follow ON follow.client_id = client.id AND follow.is_del_user = 0
            JOIN work_member AS member ON member.corp_id = client.corp_id
              AND member.userid = follow.userid AND member.enable = 1 AND member.status = 1
            WHERE client.delete_time IS NULL) AS employee_client_visibility_relations,
          (SELECT count(DISTINCT client.id)::integer FROM work_client AS client
            JOIN work_client_follow AS follow ON follow.client_id = client.id AND follow.is_del_user = 0
            JOIN work_member AS member ON member.corp_id = client.corp_id
              AND member.userid = follow.userid AND member.enable = 1 AND member.status = 1
            WHERE client.delete_time IS NULL) AS visible_clients,
          (SELECT count(*)::integer FROM work_group_chat AS group_chat
            JOIN work_member AS member ON member.corp_id = group_chat.corp_id
              AND member.userid = group_chat.owner AND member.enable = 1 AND member.status = 1
            WHERE group_chat.status = 1) AS employee_owned_groups,
          (SELECT count(*)::integer FROM work_group_chat_member AS relation
            JOIN work_group_chat AS group_chat ON group_chat.id = relation.group_id AND group_chat.status = 1
            JOIN work_member AS member ON member.corp_id = group_chat.corp_id
              AND member.userid = relation.userid AND member.enable = 1 AND member.status = 1
            WHERE relation.status = 1 AND relation.type = 1) AS employee_group_memberships,
          (SELECT count(*)::integer FROM store_order AS orders
            WHERE orders.uid > 0 AND EXISTS (
              SELECT 1 FROM work_client AS client
              WHERE client.uid = orders.uid AND client.delete_time IS NULL
            )) AS orders_for_bound_clients,
          (SELECT count(*)::integer FROM store_visit AS visit
            WHERE visit.uid > 0 AND EXISTS (
              SELECT 1 FROM work_client AS client
              WHERE client.uid = visit.uid AND client.delete_time IS NULL
            )) AS visits_for_bound_clients
      `;

      const plans = await Promise.all([
        tx<Array<{ "QUERY PLAN": unknown }>>`
          EXPLAIN (FORMAT JSON)
          SELECT id FROM work_member
          WHERE corp_id = '__audit_corp__' AND userid = '__audit_employee__'
            AND enable = 1 AND status = 1 LIMIT 2
        `,
        tx<Array<{ "QUERY PLAN": unknown }>>`
          EXPLAIN (FORMAT JSON)
          SELECT client.id FROM work_client AS client
          JOIN work_client_follow AS follow ON follow.client_id = client.id
          WHERE client.corp_id = '__audit_corp__'
            AND client.external_userid = '__audit_external__'
            AND client.delete_time IS NULL
            AND follow.userid = '__audit_employee__' AND follow.is_del_user = 0 LIMIT 2
        `,
        tx<Array<{ "QUERY PLAN": unknown }>>`
          EXPLAIN (FORMAT JSON)
          SELECT group_chat.id FROM work_group_chat AS group_chat
          LEFT JOIN work_group_chat_member AS relation
            ON relation.group_id = group_chat.id AND relation.userid = '__audit_employee__'
              AND relation.type = 1 AND relation.status = 1
          WHERE group_chat.corp_id = '__audit_corp__' AND group_chat.chat_id = '__audit_chat__'
            AND group_chat.status = 1
            AND (group_chat.owner = '__audit_employee__' OR relation.group_id IS NOT NULL) LIMIT 2
        `,
        tx<Array<{ "QUERY PLAN": unknown }>>`
          EXPLAIN (FORMAT JSON)
          SELECT id FROM store_order
          WHERE uid = 2147483647 AND is_system_del = 0
          ORDER BY id DESC LIMIT 20
        `,
        tx<Array<{ "QUERY PLAN": unknown }>>`
          EXPLAIN (FORMAT JSON)
          SELECT id FROM store_visit
          WHERE uid = 2147483647 AND product_type = 'product'
          ORDER BY add_time DESC, id DESC LIMIT 20
        `,
      ]);

      return {
        complete: true,
        server_version: await tx`SELECT current_setting('server_version') AS value`,
        catalog,
        indexes,
        work: work[0] ?? {},
        anomalies: anomalies[0] ?? {},
        visibility: visibility[0] ?? {},
        plans: {
          employee_identity: plans[0][0]?.["QUERY PLAN"] ?? null,
          client_visibility: plans[1][0]?.["QUERY PLAN"] ?? null,
          group_visibility: plans[2][0]?.["QUERY PLAN"] ?? null,
          client_orders: plans[3][0]?.["QUERY PLAN"] ?? null,
          client_visits: plans[4][0]?.["QUERY PLAN"] ?? null,
        },
        guarantees: {
          transaction: "REPEATABLE READ, READ ONLY",
          search_path: "public, pg_temp",
          row_level_values_returned: false,
          identifiers_or_pii_returned: false,
          dml_or_ddl_executed: false,
        },
      };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

function memoryKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    async get(key: string, type?: string) {
      const value = values.get(key) ?? null;
      return value !== null && type === "json" ? JSON.parse(value) as unknown : value;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
  } as unknown as KVNamespace;
}

function memoryStateStore(): WorkContextStateStore {
  const values = new Map<string, unknown>();
  return {
    async putOnce(key, value) {
      if (values.has(key)) return false;
      values.set(key, value);
      return true;
    },
    async take<T>(key: string) {
      const value = values.get(key) as T | undefined;
      values.delete(key);
      return value ?? null;
    },
  };
}

async function relevantPublicFingerprint(client: postgres.Sql): Promise<string> {
  const rows = await client<Array<{ fingerprint: string }>>`
    SELECT md5(concat_ws(':',
      (SELECT count(*)::text || '/' || COALESCE(max(id), 0)::text FROM public.system_config),
      (SELECT count(*)::text || '/' || COALESCE(max(id), 0)::text FROM public.work_member),
      (SELECT count(*)::text || '/' || COALESCE(max(id), 0)::text FROM public.work_client),
      (SELECT count(*)::text || '/' || COALESCE(max(id), 0)::text FROM public.work_client_follow),
      (SELECT count(*)::text || '/' || COALESCE(max(id), 0)::text FROM public.work_group_chat),
      (SELECT count(*)::text || '/' || COALESCE(max(id), 0)::text FROM public.work_group_chat_member),
      (SELECT count(*)::text || '/' || COALESCE(max(uid), 0)::text FROM public."user"),
      (SELECT count(*)::text || '/' || COALESCE(max(id), 0)::text FROM public.store_order),
      (SELECT count(*)::text || '/' || COALESCE(max(id), 0)::text FROM public.store_order_cart_info),
      (SELECT count(*)::text || '/' || COALESCE(max(id), 0)::text FROM public.store_product),
      (SELECT count(*)::text || '/' || COALESCE(max(id), 0)::text FROM public.store_visit)
    )) AS fingerprint
  `;
  return String(rows[0]?.fingerprint ?? "");
}

async function temporarySchemaCount(client: postgres.Sql): Promise<number> {
  const rows = await client<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM pg_namespace
    WHERE starts_with(nspname, ${SCHEMA_PREFIX})
  `;
  return Number(rows[0]?.count ?? -1);
}

async function rejected(fn: () => Promise<unknown>, expected: new (...args: never[]) => Error) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof expected;
  }
}

async function isolatedScenario(connectionString: string) {
  const admin = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_work_context_isolated_audit" },
  });
  const schema = `${SCHEMA_PREFIX}${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const scenarioNow = 1_788_069_218;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error("invalid temporary schema");
  const beforeFingerprint = await relevantPublicFingerprint(admin);
  const beforeSchemas = await temporarySchemaCount(admin);
  let scenarioDb: ReturnType<typeof createDbFromConnectionString> | null = null;
  let report: Record<string, unknown> = {};
  try {
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    for (const table of [
      "system_config", "work_member", "work_client", "work_client_follow",
      "work_client_follow_tags", "work_group_chat", "work_group_chat_member",
      "user", "user_group", "user_label", "user_label_relation", "store_order",
      "store_order_cart_info", "store_order_refund", "store_product", "store_visit",
    ]) {
      await admin.unsafe(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
    }
    await admin.unsafe(`
      INSERT INTO "${schema}".system_config
        (id, is_store, menu_name, value, sort, status)
      VALUES
        (900000001, 0, 'wechat_work_corpid', 'ww0123456789abcdef', 0, 1),
        (900000002, 0, 'wechat_work_build_agent_id', '1000002', 0, 1);
      INSERT INTO "${schema}".work_member
        (id, corp_id, userid, uid, name, enable, status, create_time, update_time)
      VALUES
        (900001001, 'ww0123456789abcdef', 'employee-1', 0, 'Employee One', 1, 1, 1788000000, 1788000000),
        (900001002, 'ww0123456789abcdef', 'employee-2', 0, 'Employee Two', 1, 1, 1788000000, 1788000000);
      INSERT INTO "${schema}"."user"
        (uid, account, nickname, avatar, phone, status, is_del, add_time)
      VALUES
        (900002001, 'customer-a', 'Customer A', 'https://assets.example.test/customer-a.jpg', '13000000001', 1, 0, 1788000000),
        (900002002, 'customer-b', 'Customer B', 'https://assets.example.test/customer-b.jpg', '13000000002', 1, 0, 1788000000);
      INSERT INTO "${schema}".user_group (id, group_name)
        VALUES (900002101, 'VIP Customers');
      INSERT INTO "${schema}".user_label
        (id, type, relation_id, label_cate, name, tag_id, status, add_time)
        VALUES (900002201, 0, 0, 0, 'High Intent', 'tag-high-intent', 1, 1788000000);
      INSERT INTO "${schema}".user_label_relation
        (id, uid, type, relation_id, label_id)
        VALUES (900002301, 900002001, 0, 0, 900002201);
      UPDATE "${schema}"."user" SET group_id = 900002101 WHERE uid = 900002001;
      INSERT INTO "${schema}".work_client
        (id, corp_id, external_userid, uid, name, avatar, gender, create_time, update_time)
      VALUES
        (900003001, 'ww0123456789abcdef', 'external-a', 900002001, 'External A', 'https://assets.example.test/external-a.jpg', 1, 1788000000, 1788000000),
        (900003002, 'ww0123456789abcdef', 'external-b', 900002002, 'External B', 'https://assets.example.test/external-b.jpg', 2, 1788000000, 1788000000);
      INSERT INTO "${schema}".work_client_follow
        (id, client_id, userid, remark, is_del_user, create_time, update_time)
      VALUES
        (900004001, 900003001, 'employee-1', 'owned customer', 0, 1788000000, 1788000000),
        (900004002, 900003002, 'employee-2', 'foreign customer', 0, 1788000000, 1788000000);
      INSERT INTO "${schema}".work_client_follow_tags
        (follow_id, group_name, tag_name, type, tag_id, create_time)
        VALUES (900004001, 'Intent', 'High Intent', 1, 'tag-high-intent', 1788000000);
      INSERT INTO "${schema}".work_group_chat
        (id, corp_id, chat_id, name, owner, group_create_time, member_num,
          retreat_group_num, status, create_time, update_time)
      VALUES
        (900005001, 'ww0123456789abcdef', 'chat-a', 'Owned Group', 'employee-1', 1788000000, 2, 0, 1, 1788000000, 1788000000),
        (900005002, 'ww0123456789abcdef', 'chat-b', 'Foreign Group', 'employee-2', 1788000000, 1, 0, 1, 1788000000, 1788000000),
        (900005003, 'wwfedcba9876543210', 'chat-other-corp', 'Other Corp Group', 'other-corp-employee', 1788000000, 1, 0, 1, 1788000000, 1788000000);
      INSERT INTO "${schema}".work_group_chat_member
        (id, group_id, userid, type, name, status, join_time, create_time, update_time)
      VALUES
        (900006001, 900005001, 'employee-1', 1, 'Employee One', 1, 1788000000, 1788000000, 1788000000),
        (900006002, 900005001, 'external-a', 2, 'External A', 1, 1788000000, 1788000000, 1788000000),
        (900006003, 900005002, 'employee-2', 1, 'Employee Two', 1, 1788000000, 1788000000, 1788000000),
        (900006004, 900005003, 'external-a', 2, 'External A Other Corp', 1, 1788000000, 1788000000, 1788000000),
        (900006005, 900005001, 'external-today', 2, 'Joined Today', 1, ${scenarioNow}, ${scenarioNow}, ${scenarioNow}),
        (900006006, 900005001, 'external-left', 2, 'Left Today', 0, ${scenarioNow}, ${scenarioNow}, 1788000000);
      INSERT INTO "${schema}".store_product
        (id, pid, type, relation_id, store_name, image, price, stock, sales, ficti,
          sort, is_show, is_del, is_verify, add_time)
      VALUES
        (900007001, 0, 0, 0, 'Audited Product', 'https://assets.example.test/product.jpg', 9.90, 12, 3, 2, 10, 1, 0, 1, 1788000000);
      INSERT INTO "${schema}".store_order
        (id, order_id, "unique", uid, pid, store_id, is_del, is_system_del,
          refund_type, refund_status, paid, status, total_num, total_price, pay_price, add_time)
      VALUES
        (900008001, 'AUDIT-ORDER-A', 'audit-unique-a', 900002001, 0, 0, 0, 0, 0, 0, 1, 0, 1, 9.90, 9.90, 1788000000),
        (900008002, 'AUDIT-ORDER-B', 'audit-unique-b', 900002002, 0, 0, 0, 0, 0, 0, 1, 0, 1, 9.90, 9.90, 1788000000);
      INSERT INTO "${schema}".store_order_cart_info
        (id, uid, oid, cart_id, product_id, cart_num, surplus_num, cart_info,
          "unique", add_time)
      VALUES
        (900009001, 900002001, 900008001, 'audit-cart-a', 900007001, 1, 1,
          '{"productInfo":{"id":900007001,"store_name":"Audited Product","image":"https://assets.example.test/product.jpg","attrInfo":{"price":"9.90","suk":"Default"}},"truePrice":"9.90"}',
          'audit-cart-unique-a', 1788000000),
        (900009002, 900002002, 900008002, 'audit-cart-b', 900007001, 1, 1,
          '{"productInfo":{"id":900007001,"store_name":"Audited Product","image":"https://assets.example.test/product.jpg","attrInfo":{"price":"9.90","suk":"Default"}},"truePrice":"9.90"}',
          'audit-cart-unique-b', 1788000000);
      INSERT INTO "${schema}".store_visit
        (id, product_id, product_type, uid, count, add_time)
        VALUES (900010001, 900007001, 'product', 900002001, 1, 1788000000);
    `);

    scenarioDb = createDbFromConnectionString(connectionString, 1, {
      searchPath: schema,
      applicationName: "cinashop_work_context_scenario",
    });
    const isolatedContainer = createContainerFromDb(scenarioDb);
    report = await withTx(isolatedContainer, async (tx) => {
    await tx.execute(drizzleSql.raw(`SET LOCAL search_path TO "${schema}", pg_temp`));
    const resolutionResult = await tx.execute<{
      current_schema: string;
      resolved_schema: string;
    }>(drizzleSql`
      SELECT current_schema(),
        (SELECT namespace.nspname FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE relation.oid = to_regclass('system_config')) AS resolved_schema
    `);
    const resolution = Array.isArray(resolutionResult)
      ? resolutionResult
      : (resolutionResult as { rows?: Array<{ current_schema: string; resolved_schema: string }> }).rows ?? [];
    if (resolution[0]?.current_schema !== schema || resolution[0]?.resolved_schema !== schema) {
      throw new Error("isolated service connection escaped its schema");
    }
    const container = createContainerFromDb(tx);
    const stateStore = memoryStateStore();
    const identityProvider = {
      async employeeIdentity(code: string) {
        if (!code.startsWith("audit-code-")) throw new Error("unexpected OAuth code");
        return { corpId: "ww0123456789abcdef", agentId: 1000002, userid: "employee-1" };
      },
    };
    const env = {
      APP_KEY: "isolated-work-context-signing-key-at-least-32-bytes",
      CONFIG_KV: memoryKv(),
      WORK_WECHAT_ALLOWED_ORIGINS: "https://work.example.test",
    } as Env;
    const service = new EnterpriseWechatContextService(container, env, {
      stateStore,
      identityProvider,
      now: () => scenarioNow,
    });

    const clientChallenge = await service.challenge(
      "https://work.example.test",
      "https://work.example.test/pages/work/client#fragment",
    );
    const clientExchange = await service.exchange({
      origin: "https://work.example.test",
      state: clientChallenge.state,
      code: "audit-code-client",
      cookieValue: clientChallenge.cookie_value,
      target: { type: "client", externalUserid: "external-a" },
    });
    const [client, orders, detail, purchased, visited] = await Promise.all([
      service.clientInfo(clientExchange.token),
      service.orderList(clientExchange.token, { page: "1", limit: "20" }),
      service.orderInfo(clientExchange.token, 900008001),
      service.purchasedProducts(clientExchange.token, { page: "1", limit: "20" }),
      service.visitedProducts(clientExchange.token, { page: "1", limit: "20" }),
    ]);
    const replayRejected = await rejected(() => service.exchange({
      origin: "https://work.example.test",
      state: clientChallenge.state,
      code: "audit-code-client",
      cookieValue: clientChallenge.cookie_value,
      target: { type: "client", externalUserid: "external-a" },
    }), ForbiddenException as new (...args: never[]) => Error);
    const foreignOrderRejected = await rejected(
      () => service.orderInfo(clientExchange.token, 900008002),
      NotFoundException as new (...args: never[]) => Error,
    );

    const groupChallenge = await service.challenge(
      "https://work.example.test",
      "https://work.example.test/pages/work/group",
    );
    const groupExchange = await service.exchange({
      origin: "https://work.example.test",
      state: groupChallenge.state,
      code: "audit-code-group",
      cookieValue: groupChallenge.cookie_value,
      target: { type: "group", chatId: "chat-a" },
    });
    const [group, members] = await Promise.all([
      service.groupInfo(groupExchange.token),
      service.groupMembers(groupExchange.token, 900005001, { page: "1", limit: "20" }),
    ]);
    const wrongGroupRejected = await rejected(
      () => service.groupMembers(groupExchange.token, 900005002, {}),
      ForbiddenException as new (...args: never[]) => Error,
    );
    const crossAudienceRejected = await rejected(
      () => service.groupInfo(clientExchange.token),
      ForbiddenException as new (...args: never[]) => Error,
    );
    await tx.execute(drizzleSql`
      UPDATE work_client_follow SET is_del_user = 1 WHERE id = 900004001
    `);
    const revokedFollowRejected = await rejected(
      () => service.clientInfo(clientExchange.token),
      ForbiddenException as new (...args: never[]) => Error,
    );

    const assertions = {
      client_scope_bound: client.id === 900003001 && client.userInfo?.uid === 900002001,
      order_list_owned: orders.length === 1 && orders[0]?.id === 900008001,
      order_detail_owned: detail.orderInfo.id === 900008001 && detail.userInfo.uid === 900002001,
      foreign_order_rejected: foreignOrderRejected,
      purchased_products_owned: purchased.length === 1 && purchased[0]?.id === 900007001,
      visited_products_owned: visited.length === 1 && visited[0]?.id === 900007001,
      oauth_state_one_time: replayRejected,
      group_scope_bound: group.id === 900005001 && group.member_num === 3,
      group_daily_status_semantics: group.todaySum === 1 && group.todayReturnSum === 1,
      group_members_paged: members.count === 3 && members.list.length === 3,
      group_counts_corp_bound: members.list.find((item) => item.userid === "external-a")?.group_chat_num === 0,
      wrong_group_path_rejected: wrongGroupRejected,
      cross_audience_rejected: crossAudienceRejected,
      revoked_follow_revalidated: revokedFollowRejected,
    };
    if (Object.values(assertions).some((value) => !value)) {
      throw new Error(`isolated assertion failed: ${JSON.stringify(assertions)}`);
    }
    return {
      complete: true,
      assertions,
      checks_passed: Object.keys(assertions).length,
      expected_checks: 14,
      public_state_unchanged: true,
    };
    });
  } finally {
    if (scenarioDb) await scenarioDb.$client.end({ timeout: 1 });
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const afterSchemas = await temporarySchemaCount(admin);
    const afterFingerprint = await relevantPublicFingerprint(admin);
    if (afterSchemas !== beforeSchemas) throw new Error("temporary schema leaked");
    if (afterFingerprint !== beforeFingerprint) throw new Error("public business state changed");
    await admin.end({ timeout: 1 });
  }
  return { ...report, schema_cleanup: "dropped", temporary_schemas_before: beforeSchemas };
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || !["/audit", "/isolated"].includes(url.pathname)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const expected = url.pathname === "/audit"
      ? env.AUDIT_READ_TOKEN_SHA256
      : env.AUDIT_ISOLATED_TOKEN_SHA256;
    if (!(await authorized(request, expected ?? ""))) {
      return Response.json(
        { error: "forbidden" },
        { status: 403, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    try {
      return Response.json(
        url.pathname === "/audit"
          ? await productionAudit(env.HYPERDRIVE.connectionString)
          : await isolatedScenario(env.HYPERDRIVE.connectionString),
        { headers: { "Cache-Control": "private, no-store" } },
      );
    } catch (error) {
      console.error(JSON.stringify({
        event: "enterprise_wechat_context_read_audit_failed",
        error: error instanceof Error ? error.message : String(error),
      }));
      return Response.json(
        {
          error: "audit failed",
          ...(url.pathname === "/isolated"
            ? { detail: error instanceof Error ? error.message : String(error) }
            : {}),
        },
        { status: 500, headers: { "Cache-Control": "private, no-store" } },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
