/**
 * 数据库连接 + 依赖注入容器
 *
 * 对应 PHP 的 app()->make() —— 按需创建并复用单例。
 *
 * Workers 驱动选择:
 *   - 使用 postgres.js (`postgres` 包) + drizzle 的 postgres-js 适配器
 *   - Cloudflare Workers 通过 Hyperdrive 注入的 connectionString 支持
 *     postgres.js 的 TCP over fetch (需 nodejs_compat)
 *   - 这是 Cloudflare 官方推荐的 PG 连接方式
 *
 * Workers 每个请求是独立 isolate, 每请求建一次连接, Hyperdrive 内部复用池。
 */
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { HttpApiException } from "@/utils/errors";
import * as schema from "@/models/schema";
import { UserDao } from "@/dao/user/UserDao";
import { SystemConfigDao } from "@/dao/system/SystemConfigDao";
import { SystemUserLevelDao } from "@/dao/user/SystemUserLevelDao";
import { StoreProductDao } from "@/dao/product/StoreProductDao";
import { StoreProductCategoryDao } from "@/dao/product/StoreProductCategoryDao";
import { StoreProductAttrValueDao } from "@/dao/product/StoreProductAttrValueDao";
import {
  StoreCartDao,
  StoreOrderDao,
  StoreOrderCartInfoDao,
  UserBillDao,
} from "@/dao/order/OrderDaos";
import { StoreOrderRefundDao, StoreOrderStatusDao } from "@/dao/order/RefundDaos";
import {
  UserAddressDao,
  UserRelationDao,
  UserSignDao,
  UserRechargeDao,
  UserInvoiceDao,
} from "@/dao/user/UserCenterDaos";
import { UserBrokerageDao, UserExtractDao } from "@/dao/user/BrokerageDaos";
import { CommunityDao, CommunityCommentDao } from "@/dao/community/CommunityDaos";
import {
  StoreCouponIssueDao,
  StoreCouponUserDao,
  StoreSeckillDao,
  StoreSeckillTimeDao,
  StoreCombinationDao,
  StoreBargainDao,
  StoreIntegralDao,
} from "@/dao/activity/ActivityDaos";
import { WechatUserDao } from "@/services/wechat/WechatAuthService";
import { SystemAdminDao, StoreServiceLogDao } from "@/dao/admin/AdminDaos";
import { StoreProductReplyDao } from "@/dao/product/ReplyDaos";
import { SystemSupplierDao } from "@/dao/supplier/SupplierDaos";
import type { Env } from "@/env";
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from "@/migrations/customerFinancialRuntimePlan";
import { MANAGER_RUNTIME_ROLE } from "@/migrations/managerRuntimePrivilegePlan";
import { captureCashierRuntimeConditionalBinding } from "@/migrations/cashierRuntimeConditionalBinding";

/** Drizzle DB 类型 (postgres-js 驱动) */
export type DbClient = PostgresJsDatabase<Record<string, never>> & {
  $client: ReturnType<typeof postgres>;
};

export interface DbConnectionOptions {
  /** Restrict every connection to one schema, or the exact public,pg_temp runtime path. */
  searchPath?: string;
  /** Visible in pg_stat_activity and PostgreSQL logs. */
  applicationName?: string;
}

const POSTGRES_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const POSTGRES_APPLICATION_NAME = /^[A-Za-z0-9._-]{1,63}$/;
const transactionSearchPaths = new WeakMap<DbClient, readonly string[]>();

function validatedSearchPath(value: string | undefined): readonly string[] | undefined {
  if (!value) return undefined;
  if (POSTGRES_IDENTIFIER.test(value)) return [value];
  // Production explicitly keeps pg_temp last. Arbitrary fallback paths such as
  // audit_schema,public remain forbidden so isolated test clients fail closed.
  if (value === "public,pg_temp") return ["public", "pg_temp"];
  throw new Error("PostgreSQL search path must be one safe schema identifier or public,pg_temp");
}

function searchPathSql(searchPath: readonly string[]): string {
  return searchPath
    .map((schemaName) => schemaName === "pg_temp" ? "pg_temp" : `"${schemaName}"`)
    .join(", ");
}

/**
 * 从 Hyperdrive 建立 postgres.js 客户端。
 * Hyperdrive 注入的 connectionString 已包含连接池优化。
 *
 * 注意: prepare=false 是 Cloudflare Workers + postgres.js 的必需配置
 * (Workers 不支持 prepared statements 跨请求复用)。
 */
export function createDbFromConnectionString(
  connectionString: string,
  maxConnections = 5,
  options: DbConnectionOptions = {},
): DbClient {
  if (!connectionString.trim()) throw new Error("PostgreSQL connection string is required");
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 10) {
    throw new Error("PostgreSQL client connection limit must be between 1 and 10");
  }
  const searchPath = validatedSearchPath(options.searchPath);
  if (options.applicationName && !POSTGRES_APPLICATION_NAME.test(options.applicationName)) {
    throw new Error("PostgreSQL application name contains unsupported characters");
  }

  const connection: Record<string, string> = {};
  // Hyperdrive forwards PostgreSQL's standard startup `options` parameter,
  // but may not preserve a custom `search_path` startup key.
  if (searchPath) connection.options = `-c search_path=${searchPath.join(",")}`;
  if (options.applicationName) connection.application_name = options.applicationName;

  const client = postgres(connectionString, {
    prepare: false,
    max: maxConnections,
    connection,
  });
  const db = drizzle(client, { schema }) as unknown as DbClient;
  if (searchPath) transactionSearchPaths.set(db, searchPath);
  return db;
}

export function createDb(env: Env): DbClient {
  return createDbFromConnectionString(env.HYPERDRIVE.connectionString, 5, {
    searchPath: "public,pg_temp",
    applicationName: "cinashop_api",
  });
}

export interface Container {
  db: DbClient;
  userDao: UserDao;
  systemConfigDao: SystemConfigDao;
  systemUserLevelDao: SystemUserLevelDao;
  storeProductDao: StoreProductDao;
  storeProductCategoryDao: StoreProductCategoryDao;
  storeProductAttrValueDao: StoreProductAttrValueDao;
  storeCartDao: StoreCartDao;
  storeOrderDao: StoreOrderDao;
  storeOrderCartInfoDao: StoreOrderCartInfoDao;
  userBillDao: UserBillDao;
  storeOrderRefundDao: StoreOrderRefundDao;
  storeOrderStatusDao: StoreOrderStatusDao;
  // M5 用户中心
  userAddressDao: UserAddressDao;
  userRelationDao: UserRelationDao;
  userSignDao: UserSignDao;
  userRechargeDao: UserRechargeDao;
  userInvoiceDao: UserInvoiceDao;
  userBrokerageDao: UserBrokerageDao;
  userExtractDao: UserExtractDao;
  communityDao: CommunityDao;
  communityCommentDao: CommunityCommentDao;
  // M5 营销活动
  storeCouponIssueDao: StoreCouponIssueDao;
  storeCouponUserDao: StoreCouponUserDao;
  storeSeckillDao: StoreSeckillDao;
  storeSeckillTimeDao: StoreSeckillTimeDao;
  storeCombinationDao: StoreCombinationDao;
  storeBargainDao: StoreBargainDao;
  storeIntegralDao: StoreIntegralDao;
  // M6 微信
  wechatUserDao: WechatUserDao;
  // M7 管理后台
  systemAdminDao: SystemAdminDao;
  storeServiceLogDao: StoreServiceLogDao;
  // M8 商品评价
  replyDao: StoreProductReplyDao;
  // Supplier 独立后台
  systemSupplierDao: SystemSupplierDao;
}

/** Build a request-scoped container around an existing Drizzle client/transaction. */
export function createContainerFromDb(db: DbClient): Container {
  return {
    db,
    userDao: new UserDao(db),
    systemConfigDao: new SystemConfigDao(db),
    systemUserLevelDao: new SystemUserLevelDao(db),
    storeProductDao: new StoreProductDao(db),
    storeProductCategoryDao: new StoreProductCategoryDao(db),
    storeProductAttrValueDao: new StoreProductAttrValueDao(db),
    storeCartDao: new StoreCartDao(db),
    storeOrderDao: new StoreOrderDao(db),
    storeOrderCartInfoDao: new StoreOrderCartInfoDao(db),
    userBillDao: new UserBillDao(db),
    storeOrderRefundDao: new StoreOrderRefundDao(db),
    storeOrderStatusDao: new StoreOrderStatusDao(db),
    // M5
    userAddressDao: new UserAddressDao(db),
    userRelationDao: new UserRelationDao(db),
    userSignDao: new UserSignDao(db),
    userRechargeDao: new UserRechargeDao(db),
    userInvoiceDao: new UserInvoiceDao(db),
    userBrokerageDao: new UserBrokerageDao(db),
    userExtractDao: new UserExtractDao(db),
    communityDao: new CommunityDao(db),
    communityCommentDao: new CommunityCommentDao(db),
    storeCouponIssueDao: new StoreCouponIssueDao(db),
    storeCouponUserDao: new StoreCouponUserDao(db),
    storeSeckillDao: new StoreSeckillDao(db),
    storeSeckillTimeDao: new StoreSeckillTimeDao(db),
    storeCombinationDao: new StoreCombinationDao(db),
    storeBargainDao: new StoreBargainDao(db),
    storeIntegralDao: new StoreIntegralDao(db),
    // M6
    wechatUserDao: new WechatUserDao(db),
    // M7
    systemAdminDao: new SystemAdminDao(db),
    storeServiceLogDao: new StoreServiceLogDao(db),
    // M8
    replyDao: new StoreProductReplyDao(db),
    systemSupplierDao: new SystemSupplierDao(db),
  };
}

export function createContainer(env: Env): Container {
  return createContainerFromDb(createDb(env));
}

/** Open only after the complete Admin authentication/route-permission check.
 * Never reuse the application binding or fall back when isolation is missing. */
export function createAdminDatabaseSession(env: Env) {
  const binding = env.HYPERDRIVE_ADMIN;
  if (!binding?.connectionString?.trim() || binding === env.HYPERDRIVE
    || binding.connectionString === env.HYPERDRIVE?.connectionString) {
    throw new Error("Independent Admin database binding is required");
  }
  const db = createDbFromConnectionString(binding.connectionString, 2, {
    searchPath: "public,pg_temp", applicationName: "cinashop_admin",
  });
  return { container: createContainerFromDb(db), close: () => db.$client.end({ timeout: 5 }) };
}

/** Manager writes and customer payment-history reads have different SQL
 * authority. The authenticated manager boundary never borrows main/Admin I/O. */
export function createManagerDatabaseSession(env: Env) {
  const binding = env.HYPERDRIVE_MANAGER;
  if (!binding?.connectionString?.trim() || binding === env.HYPERDRIVE
    || binding === env.HYPERDRIVE_ADMIN
    || binding.connectionString === env.HYPERDRIVE?.connectionString
    || binding.connectionString === env.HYPERDRIVE_ADMIN?.connectionString) {
    throw new HttpApiException("门店管理运行环境尚未完成独立配置", 503, 503);
  }
  const db = createDbFromConnectionString(binding.connectionString, 2, {
    searchPath: "public,pg_temp", applicationName: "cinashop_manager",
  });
  return { container: createContainerFromDb(db), close: () => db.$client.end({ timeout: 5 }) };
}

/** Open only after complete UserJWT authentication. Commissioning validates
 * the full profile; this request-time read checks the actual fixed LOGIN and
 * its basic restrictions before any financial container is handed over. */
export async function createCustomerFinancialDatabaseSession(env: Env) {
  const unavailable = () => new HttpApiException("客服财务运行环境尚未完成独立配置", 503, 503);
  const binding = env.HYPERDRIVE_CUSTOMER_FINANCIAL;
  const connectionString = binding?.connectionString?.trim();
  const otherBindings = [env.HYPERDRIVE, env.HYPERDRIVE_ADMIN, env.HYPERDRIVE_MANAGER];
  if (!connectionString || otherBindings.some(other => other && (other === binding
    || other.connectionString?.trim() === connectionString))) throw unavailable();

  let db: DbClient | undefined;
  try {
    db = createDbFromConnectionString(connectionString, 1, {
      searchPath: "public,pg_temp", applicationName: "cinashop_customer_financial",
    });
    const identity = await db.transaction(async tx => {
      await tx.execute(sql`SELECT
        set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
        set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
        set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
      const [state] = await tx.execute(sql`SELECT current_user AS role,session_user AS session,
        (SELECT r.rolname FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
          WHERE a.pid=pg_backend_pid()) AS backend_role,
        current_setting('server_version_num')::integer/10000=16 AS pg16,
        current_setting('session_replication_role')='origin' AS origin,
        r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit
          OR r.rolreplication OR r.rolbypassrls) AS restricted,
        NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS no_memberships,
        NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass
          AND refobjid=r.oid AND deptype='o') AS no_ownership,
        pg_catalog.has_database_privilege(r.oid,current_database(),'CONNECT')
          AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE') AS connected,
        NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%'
            AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE')) AS no_ddl,
        NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM') AS no_replication_bypass
        FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
      return state;
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    if (!identity || ['role', 'session', 'backend_role'].some(key => identity[key] !== CUSTOMER_FINANCIAL_RUNTIME_ROLE)
      || ['pg16', 'origin', 'restricted', 'no_memberships', 'no_ownership', 'connected', 'no_ddl', 'no_replication_bypass']
        .some(key => identity[key] !== true)) throw unavailable();
    const selected = db;
    let closed = false;
    return { container: createContainerFromDb(selected), close: async () => {
      if (closed) return;
      closed = true;
      await selected.$client.end({ timeout: 5 });
    } };
  } catch {
    await db?.$client.end({ timeout: 5 }).catch(() => {});
    throw unavailable();
  }
}

/** The formal full Cashier commissioning returns the trusted name/OID receipt
 * after proving its distinction from App/Admin/Manager/Financial and the full
 * profile. Env identity must be that maintenance result, not a caller-chosen
 * expected principal used as a substitute for commissioning.
 * This request-time SELECT proves that exact actual LOGIN and database before
 * handing over I/O; it neither commissions a role nor infers one from a DSN. */
export async function createCustomerCashierDatabaseSession(env: Env) {
  const unavailable = () => new HttpApiException("客服收银运行环境尚未完成独立配置", 503, 503);
  let db: DbClient | undefined;
  let closed = false;
  const close = async () => {
    if (!db || closed) return;
    closed = true;
    try { await db.$client.end({ timeout: 5 }); }
    catch { throw unavailable(); }
  };
  try {
    const binding = env.HYPERDRIVE_CUSTOMER_CASHIER;
    const connectionString = binding?.connectionString?.trim();
    const expected = captureCashierRuntimeConditionalBinding(env.CUSTOMER_CASHIER_RUNTIME_IDENTITY!);
    const otherBindings = [env.HYPERDRIVE, env.HYPERDRIVE_ADMIN,
      env.HYPERDRIVE_MANAGER, env.HYPERDRIVE_CUSTOMER_FINANCIAL];
    if (!connectionString || otherBindings.some(other => other && (other === binding
      || other.connectionString?.trim() === connectionString))
      || [MANAGER_RUNTIME_ROLE, CUSTOMER_FINANCIAL_RUNTIME_ROLE].includes(expected.role)) throw unavailable();

    db = createDbFromConnectionString(connectionString, 1, {
      searchPath: "public,pg_temp", applicationName: "cinashop_customer_cashier",
    });
    const identity = await db.transaction(async tx => {
      await tx.execute(sql`SELECT
        set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
        set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
        set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
      const [state] = await tx.execute(sql`SELECT current_user AS role,session_user AS session,
        r.oid::text AS role_oid,
        (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=session_user) AS session_oid,
        (SELECT b.rolname FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles b ON b.oid=a.usesysid
          WHERE a.pid=pg_backend_pid()) AS backend_role,
        (SELECT usesysid::text FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid()) AS backend_role_oid,
        current_database() AS database,
        (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS database_oid,
        current_setting('server_version_num')::integer/10000=16 AS pg16,
        current_setting('session_replication_role')='origin' AS origin,
        r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit
          OR r.rolreplication OR r.rolbypassrls) AS restricted,
        NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS no_memberships,
        NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass
          AND refobjid=r.oid AND deptype='o') AS no_ownership,
        pg_catalog.has_database_privilege(r.oid,current_database(),'CONNECT')
          AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE') AS connected,
        NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%'
            AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE')) AS no_ddl,
        NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM') AS no_replication_bypass
        FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
      return state;
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    if (!identity || ['role', 'session', 'backend_role'].some(key => identity[key] !== expected.role)
      || ['role_oid', 'session_oid', 'backend_role_oid'].some(key => identity[key] !== expected.roleOid)
      || identity.database !== expected.database || identity.database_oid !== expected.databaseOid
      || ['pg16', 'origin', 'restricted', 'no_memberships', 'no_ownership', 'connected', 'no_ddl', 'no_replication_bypass']
        .some(key => identity[key] !== true)) throw unavailable();
    return { container: createContainerFromDb(db), close };
  } catch {
    await close().catch(() => {});
    throw unavailable();
  }
}

/**
 * 安全执行事务 (对应 PHP BaseServices::transaction)。
 * 出错自动回滚。
 *
 * @example
 * const result = await withTx(container, async (tx) => {
 *   const orderDao = new OrderDao(tx);
 *   await orderDao.save(order);
 *   return order.id;
 * });
 */
export async function withTx<T>(
  container: Container,
  fn: (tx: DbClient) => Promise<T>,
): Promise<T> {
  const searchPath = transactionSearchPaths.get(container.db);
  return container.db.transaction(async (tx) => {
    if (searchPath) {
      await tx.execute(sql.raw(`SET LOCAL search_path TO ${searchPathSql(searchPath)}`));
    }
    return fn(tx as unknown as DbClient);
  });
}
