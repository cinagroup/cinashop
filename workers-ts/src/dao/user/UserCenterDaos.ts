/**
 * 用户中心 DAO (M5)
 * 地址 / 收藏关系 / 签到 / 充值 / 发票
 */
import { eq, and, sql } from "drizzle-orm";
import { BaseDao, type DB } from "@/dao/BaseDao";
import {
  userAddress,
  userRelation,
  userSign,
  userRecharge,
  userInvoice,
} from "@/models/schema";

// ─── 收货地址 ────────────────────────────────────────────────
export class UserAddressDao extends BaseDao<typeof userAddress> {
  constructor(db: DB) {
    super(db, userAddress, {
      uid: (v) => eq(userAddress.uid, Number(v)),
      isDel: (v) => eq(userAddress.isDel, Number(v)),
      isDefault: (v) => eq(userAddress.isDefault, Number(v)),
    });
  }

  /** 取用户地址列表 */
  async listByUid(uid: number) {
    return this.db
      .select()
      .from(userAddress)
      .where(and(eq(userAddress.uid, uid), eq(userAddress.isDel, 0)))
      .orderBy(sql`${userAddress.isDefault} DESC, ${userAddress.addTime} DESC`);
  }

  /** 取默认地址 */
  async getDefault(uid: number) {
    const rows = await this.db
      .select()
      .from(userAddress)
      .where(and(eq(userAddress.uid, uid), eq(userAddress.isDefault, 1), eq(userAddress.isDel, 0)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 设默认 (先把所有取消, 再设当前) */
  async setDefault(uid: number, id: number): Promise<void> {
    await this.db
      .update(userAddress)
      .set({ isDefault: 0 })
      .where(eq(userAddress.uid, uid));
    await this.db
      .update(userAddress)
      .set({ isDefault: 1 })
      .where(and(eq(userAddress.id, id), eq(userAddress.uid, uid)));
  }
}

// ─── 收藏/点赞关系 ──────────────────────────────────────────
export class UserRelationDao extends BaseDao<typeof userRelation> {
  constructor(db: DB) {
    super(db, userRelation);
  }

  /** 收藏的商品 ID 列表 */
  async getCollectIds(uid: number, category = "product"): Promise<number[]> {
    const rows = await this.db
      .select({ id: userRelation.relationId })
      .from(userRelation)
      .where(
        and(
          eq(userRelation.uid, uid),
          eq(userRelation.type, "collect"),
          eq(userRelation.category, category),
        ),
      );
    return rows.map((r) => r.id);
  }

  /** 是否已收藏 */
  async isCollected(uid: number, relationId: number, category = "product"): Promise<boolean> {
    const rows = await this.db
      .select({ id: userRelation.id })
      .from(userRelation)
      .where(
        and(
          eq(userRelation.uid, uid),
          eq(userRelation.relationId, relationId),
          eq(userRelation.type, "collect"),
          eq(userRelation.category, category),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** 收藏 (UNIQUE 约束兜底防重复) */
  async addCollect(uid: number, relationIds: number[], category = "product"): Promise<number> {
    let count = 0;
    for (const rid of relationIds) {
      try {
        await this.db.insert(userRelation).values({
          uid,
          relationId: rid,
          type: "collect",
          category,
          addTime: Math.floor(Date.now() / 1000),
        });
        count++;
      } catch {
        // UNIQUE 冲突 = 已收藏, 跳过
      }
    }
    return count;
  }

  /** 取消收藏 */
  async removeCollect(uid: number, relationIds: number[], category = "product"): Promise<void> {
    for (const rid of relationIds) {
      await this.db
        .delete(userRelation)
        .where(
          and(
            eq(userRelation.uid, uid),
            eq(userRelation.relationId, rid),
            eq(userRelation.type, "collect"),
            eq(userRelation.category, category),
          ),
        );
    }
  }
}

// ─── 签到 ────────────────────────────────────────────────────
export class UserSignDao extends BaseDao<typeof userSign> {
  constructor(db: DB) {
    super(db, userSign);
  }

  /** 今日是否签到 */
  async isSignedToday(uid: number): Promise<boolean> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const rows = await this.db
      .select({ id: userSign.id })
      .from(userSign)
      .where(and(eq(userSign.uid, uid), sql`${userSign.addTime} >= ${Math.floor(todayStart.getTime() / 1000)}`))
      .limit(1);
    return rows.length > 0;
  }

  /** 昨日是否签到 (判断连续) */
  async isSignedYesterday(uid: number): Promise<boolean> {
    const yStart = new Date();
    yStart.setDate(yStart.getDate() - 1);
    yStart.setHours(0, 0, 0, 0);
    const yEnd = new Date();
    yEnd.setDate(yEnd.getDate() - 1);
    yEnd.setHours(23, 59, 59, 999);
    const rows = await this.db
      .select({ id: userSign.id })
      .from(userSign)
      .where(
        and(
          eq(userSign.uid, uid),
          sql`${userSign.addTime} >= ${Math.floor(yStart.getTime() / 1000)}`,
          sql`${userSign.addTime} <= ${Math.floor(yEnd.getTime() / 1000)}`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** 累计签到天数 */
  async getCumulativeDays(uid: number): Promise<number> {
    const rows = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(userSign)
      .where(eq(userSign.uid, uid));
    return rows[0]?.c ?? 0;
  }
}

// ─── 充值订单 ────────────────────────────────────────────────
export class UserRechargeDao extends BaseDao<typeof userRecharge> {
  constructor(db: DB) {
    super(db, userRecharge, {
      uid: (v) => eq(userRecharge.uid, Number(v)),
      orderId: (v) => eq(userRecharge.orderId, String(v)),
      paid: (v) => eq(userRecharge.paid, Number(v)),
    });
  }
}

// ─── 发票 ────────────────────────────────────────────────────
export class UserInvoiceDao extends BaseDao<typeof userInvoice> {
  constructor(db: DB) {
    super(db, userInvoice, {
      uid: (v) => eq(userInvoice.uid, Number(v)),
      isDel: (v) => eq(userInvoice.isDel, Number(v)),
      isDefault: (v) => eq(userInvoice.isDefault, Number(v)),
    });
  }
}
