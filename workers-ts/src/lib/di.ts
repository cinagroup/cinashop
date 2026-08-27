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

/** Drizzle DB 类型 (postgres-js 驱动) */
export type DbClient = PostgresJsDatabase<Record<string, never>> & {
  $client: ReturnType<typeof postgres>;
};

export interface DbConnectionOptions {
  /** Restrict every connection to one validated PostgreSQL schema. */
  searchPath?: string;
  /** Visible in pg_stat_activity and PostgreSQL logs. */
  applicationName?: string;
}

const POSTGRES_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const POSTGRES_APPLICATION_NAME = /^[A-Za-z0-9._-]{1,63}$/;
const transactionSearchPaths = new WeakMap<DbClient, string>();

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
  if (options.searchPath && !POSTGRES_IDENTIFIER.test(options.searchPath)) {
    throw new Error("PostgreSQL search path must be one safe schema identifier");
  }
  if (options.applicationName && !POSTGRES_APPLICATION_NAME.test(options.applicationName)) {
    throw new Error("PostgreSQL application name contains unsupported characters");
  }

  const connection: Record<string, string> = {};
  // Hyperdrive forwards PostgreSQL's standard startup `options` parameter,
  // but may not preserve a custom `search_path` startup key.
  if (options.searchPath) connection.options = `-c search_path=${options.searchPath}`;
  if (options.applicationName) connection.application_name = options.applicationName;

  const client = postgres(connectionString, {
    prepare: false,
    max: maxConnections,
    connection,
  });
  const db = drizzle(client, { schema }) as unknown as DbClient;
  if (options.searchPath) transactionSearchPaths.set(db, options.searchPath);
  return db;
}

export function createDb(env: Env): DbClient {
  return createDbFromConnectionString(env.HYPERDRIVE.connectionString);
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
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${searchPath}"`));
    }
    return fn(tx as unknown as DbClient);
  });
}
