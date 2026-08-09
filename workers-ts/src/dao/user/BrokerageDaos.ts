/**
 * 分销/佣金 Dao
 */
import { eq, and, sql } from "drizzle-orm";
import { BaseDao, type DB } from "@/dao/BaseDao";
import { userBrokerage, userExtract } from "@/models/schema";

export class UserBrokerageDao extends BaseDao<typeof userBrokerage> {
  constructor(db: DB) {
    super(db, userBrokerage, {
      uid: (v) => eq(userBrokerage.uid, Number(v)),
      category: (v) => eq(userBrokerage.category, String(v)),
      type: (v) => eq(userBrokerage.type, String(v)),
      status: (v) => eq(userBrokerage.status, Number(v)),
    });
  }

  /** 佣金总额 (pm=1 有效) */
  async sumBrokerage(uid: number): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${userBrokerage.number}), 0)::numeric(12,2)` })
      .from(userBrokerage)
      .where(
        and(eq(userBrokerage.uid, uid), eq(userBrokerage.pm, 1), eq(userBrokerage.status, 1)),
      );
    return Number(rows[0]?.total ?? 0);
  }

  /** 佣金明细列表 */
  async listByUid(uid: number, page = 1, limit = 10) {
    return this.db
      .select()
      .from(userBrokerage)
      .where(eq(userBrokerage.uid, uid))
      .orderBy(sql`${userBrokerage.addTime} DESC`)
      .limit(limit)
      .offset((page - 1) * limit);
  }
}

export class UserExtractDao extends BaseDao<typeof userExtract> {
  constructor(db: DB) {
    super(db, userExtract, {
      uid: (v) => eq(userExtract.uid, Number(v)),
      status: (v) => eq(userExtract.status, Number(v)),
    });
  }
}
