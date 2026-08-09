/**
 * 营销活动 DAO (M5)
 * 优惠券 + 秒杀 + 拼团 + 砍价 + 积分商品
 */
import { eq, sql } from "drizzle-orm";
import { BaseDao, type DB } from "@/dao/BaseDao";
import {
  storeCouponIssue,
  storeCouponUser,
  storeSeckill,
  storeSeckillTime,
  storeCombination,
  storeBargain,
  storeIntegral,
} from "@/models/schema";

// ─── 优惠券模板 ──────────────────────────────────────────────
export class StoreCouponIssueDao extends BaseDao<typeof storeCouponIssue> {
  constructor(db: DB) {
    super(db, storeCouponIssue, {
      status: (v) => eq(storeCouponIssue.status, Number(v)),
    });
  }

  /** 可领取的优惠券列表 (status=0 且未过期) */
  async getIssueList() {
    const now = new Date().toISOString();
    return this.db
      .select()
      .from(storeCouponIssue)
      .where(
        sql`${storeCouponIssue.status} = 0 AND (${storeCouponIssue.receiveType} = 0 OR (${storeCouponIssue.receiveType} = 1 AND ${storeCouponIssue.startTime} <= ${now} AND ${storeCouponIssue.endTime} >= ${now}))`,
      )
      .orderBy(sql`${storeCouponIssue.sort} DESC, ${storeCouponIssue.addTime} DESC`);
  }
}

// ─── 用户优惠券 ──────────────────────────────────────────────
export class StoreCouponUserDao extends BaseDao<typeof storeCouponUser> {
  constructor(db: DB) {
    super(db, storeCouponUser, {
      uid: (v) => eq(storeCouponUser.uid, Number(v)),
      status: (v) => eq(storeCouponUser.status, Number(v)),
    });
  }

  /** 已领取数量 (限领取校验) */
  async countReceived(uid: number, issueId: number): Promise<number> {
    const rows = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(storeCouponUser)
      .where(
        sql`${storeCouponUser.uid} = ${uid} AND ${storeCouponUser.issueCouponId} = ${issueId}`,
      );
    return rows[0]?.c ?? 0;
  }

  /** 用户优惠券列表 */
  async listByUid(uid: number, status?: number) {
    const where = status !== undefined
      ? sql`${storeCouponUser.uid} = ${uid} AND ${storeCouponUser.status} = ${status}`
      : sql`${storeCouponUser.uid} = ${uid}`;
    return this.db
      .select()
      .from(storeCouponUser)
      .where(where)
      .orderBy(sql`${storeCouponUser.receiveTime} DESC`);
  }
}

// ─── 秒杀 ────────────────────────────────────────────────────
export class StoreSeckillDao extends BaseDao<typeof storeSeckill> {
  constructor(db: DB) {
    super(db, storeSeckill, { status: (v) => eq(storeSeckill.status, Number(v)) });
  }

  /** 按时间段取秒杀商品 (time_id 逗号分隔 → PG string_to_array 匹配) */
  async getByTimeId(timeId: string) {
    return this.db
      .select()
      .from(storeSeckill)
      .where(
        sql`${timeId} = ANY(string_to_array(${storeSeckill.timeId}, ',')) AND ${storeSeckill.status} = 1`,
      )
      .orderBy(sql`${storeSeckill.sort} DESC`);
  }

  /** 取单个秒杀活动 */
  async getById(id: number) {
    const rows = await this.db
      .select()
      .from(storeSeckill)
      .where(eq(storeSeckill.id, id))
      .limit(1);
    return rows[0] ?? null;
  }
}

// ─── 秒杀时间段 ─────────────────────────────────────────────
export class StoreSeckillTimeDao extends BaseDao<typeof storeSeckillTime> {
  constructor(db: DB) {
    super(db, storeSeckillTime, { status: (v) => eq(storeSeckillTime.status, Number(v)) });
  }

  /** 取所有时间段 */
  async getAll() {
    return this.db
      .select()
      .from(storeSeckillTime)
      .where(eq(storeSeckillTime.status, 1))
      .orderBy(sql`${storeSeckillTime.startTime}`);
  }
}

// ─── 拼团 ────────────────────────────────────────────────────
export class StoreCombinationDao extends BaseDao<typeof storeCombination> {
  constructor(db: DB) {
    super(db, storeCombination, { status: (v) => eq(storeCombination.status, Number(v)) });
  }

  async list() {
    const now = new Date().toISOString();
    return this.db
      .select()
      .from(storeCombination)
      .where(
        sql`${storeCombination.status} = 1 AND (${storeCombination.stopTime} IS NULL OR ${storeCombination.stopTime} >= ${now})`,
      )
      .orderBy(sql`${storeCombination.sort} DESC`);
  }

  async getById(id: number) {
    const rows = await this.db
      .select()
      .from(storeCombination)
      .where(eq(storeCombination.id, id))
      .limit(1);
    return rows[0] ?? null;
  }
}

// ─── 砍价 ────────────────────────────────────────────────────
export class StoreBargainDao extends BaseDao<typeof storeBargain> {
  constructor(db: DB) {
    super(db, storeBargain, { status: (v) => eq(storeBargain.status, Number(v)) });
  }

  async list() {
    const now = new Date().toISOString();
    return this.db
      .select()
      .from(storeBargain)
      .where(
        sql`${storeBargain.status} = 1 AND (${storeBargain.stopTime} IS NULL OR ${storeBargain.stopTime} >= ${now})`,
      )
      .orderBy(sql`${storeBargain.sort} DESC`);
  }

  async getById(id: number) {
    const rows = await this.db
      .select()
      .from(storeBargain)
      .where(eq(storeBargain.id, id))
      .limit(1);
    return rows[0] ?? null;
  }
}

// ─── 积分商品 ────────────────────────────────────────────────
export class StoreIntegralDao extends BaseDao<typeof storeIntegral> {
  constructor(db: DB) {
    super(db, storeIntegral, { status: (v) => eq(storeIntegral.status, Number(v)) });
  }

  async list(page = 1, limit = 10) {
    return this.db
      .select()
      .from(storeIntegral)
      .where(eq(storeIntegral.status, 1))
      .orderBy(sql`${storeIntegral.sort} DESC, ${storeIntegral.addTime} DESC`)
      .limit(limit)
      .offset((page - 1) * limit);
  }

  async getById(id: number) {
    const rows = await this.db
      .select()
      .from(storeIntegral)
      .where(eq(storeIntegral.id, id))
      .limit(1);
    return rows[0] ?? null;
  }
}
