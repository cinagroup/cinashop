/**
 * 购物车 + 订单 Dao
 *
 * 对应 PHP app/dao/order/StoreCartDao.php + StoreOrderDao.php +
 *       app/dao/order/StoreOrderCartInfoDao.php + app/dao/user/UserBillDao.php
 */
import { eq, and, sql, inArray } from "drizzle-orm";
import { BaseDao, type DB } from "@/dao/BaseDao";
import {
  storeCart,
  storeOrder,
  storeOrderCartInfo,
  userBill,
} from "@/models/schema";

// ─── 购物车 ──────────────────────────────────────────────────
export class StoreCartDao extends BaseDao<typeof storeCart> {
  constructor(db: DB) {
    super(db, storeCart, {
      uid: (v) => eq(storeCart.uid, Number(v)),
      productId: (v) => eq(storeCart.productId, Number(v)),
      type: (v) => eq(storeCart.type, Number(v)),
      isPay: (v) => eq(storeCart.isPay, Number(v)),
      isDel: (v) => eq(storeCart.isDel, Number(v)),
      isNew: (v) => eq(storeCart.isNew, Number(v)),
      status: (v) => eq(storeCart.status, Number(v)),
    });
  }

  /** 取用户购物车 (未删除/未购买) */
  async getUserCart(uid: number): Promise<(typeof storeCart.$inferSelect)[]> {
    return this.db
      .select()
      .from(storeCart)
      .where(
        and(
          eq(storeCart.uid, uid),
          eq(storeCart.isDel, 0),
          eq(storeCart.isPay, 0),
        ),
      )
      .orderBy(sql`${storeCart.addTime} DESC`);
  }

  /** 按 ids 批量取 (下单时用) */
  async getByIds(ids: number[]): Promise<(typeof storeCart.$inferSelect)[]> {
    if (!ids.length) return [];
    return this.db
      .select()
      .from(storeCart)
      .where(inArray(storeCart.id, ids));
  }

  /** 已存在的同 SKU 购车项 (合并数量用) */
  async findExisting(
    uid: number,
    productId: number,
    unique: string,
    type = 0,
    activityId = 0,
  ): Promise<(typeof storeCart.$inferSelect) | null> {
    const rows = await this.db
      .select()
      .from(storeCart)
      .where(
        and(
          eq(storeCart.uid, uid),
          eq(storeCart.productId, productId),
          eq(storeCart.productAttrUnique, unique),
          eq(storeCart.type, type),
          eq(storeCart.activityId, activityId),
          eq(storeCart.isDel, 0),
          eq(storeCart.isPay, 0),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}

// ─── 订单主表 ────────────────────────────────────────────────
export class StoreOrderDao extends BaseDao<typeof storeOrder> {
  constructor(db: DB) {
    super(db, storeOrder, {
      uid: (v) => eq(storeOrder.uid, Number(v)),
      orderId: (v) => eq(storeOrder.orderId, String(v)),
      paid: (v) => eq(storeOrder.paid, Number(v)),
      status: (v) => eq(storeOrder.status, Number(v)),
      type: (v) => eq(storeOrder.type, Number(v)),
      unique: (v) => eq(storeOrder.unique, String(v)),
      isDel: (v) => eq(storeOrder.isDel, Number(v)),
    });
  }

  /** 按 unique + uid 幂等查 (对应 PHP getOne(['unique'=>$key,'uid'=>$uid])) */
  async findByUnique(uid: number, unique: string) {
    const rows = await this.db
      .select()
      .from(storeOrder)
      .where(and(eq(storeOrder.unique, unique), eq(storeOrder.uid, uid)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 按 orderId 取 (前端查订单详情) */
  async findByOrderId(orderId: string) {
    const rows = await this.db
      .select()
      .from(storeOrder)
      .where(eq(storeOrder.orderId, orderId))
      .limit(1);
    return rows[0] ?? null;
  }
}

// ─── 订单商品快照 ───────────────────────────────────────────
export class StoreOrderCartInfoDao extends BaseDao<typeof storeOrderCartInfo> {
  constructor(db: DB) {
    super(db, storeOrderCartInfo, {
      oid: (v) => eq(storeOrderCartInfo.oid, Number(v)),
      uid: (v) => eq(storeOrderCartInfo.uid, Number(v)),
    });
  }

  /** 按订单 id 取商品行 */
  async getByOid(oid: number) {
    return this.db
      .select()
      .from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.oid, oid));
  }

  /** 按 unique (评价标识) 取单行 */
  async getByUnique(unique: string) {
    const rows = await this.db
      .select()
      .from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.unique, unique))
      .limit(1);
    return rows[0] ?? null;
  }
}

// ─── 用户账单 ────────────────────────────────────────────────
export class UserBillDao extends BaseDao<typeof userBill> {
  constructor(db: DB) {
    super(db, userBill, {
      uid: (v) => eq(userBill.uid, Number(v)),
      linkId: (v) => eq(userBill.linkId, String(v)),
      category: (v) => eq(userBill.category, String(v)),
      type: (v) => eq(userBill.type, String(v)),
    });
  }

  /** 记录积分流水 (下单扣积分 / 支付返积分) */
  async recordIntegral(params: {
    uid: number;
    linkId: string;
    pm: number; // 0支出 1获得
    number: string;
    balance: string;
    title: string;
    mark: string;
    category: string;
    type: string;
  }): Promise<void> {
    await this.db.insert(userBill).values({
      uid: params.uid,
      linkId: params.linkId,
      pm: params.pm,
      number: params.number,
      balance: params.balance,
      title: params.title,
      mark: params.mark,
      category: params.category,
      type: params.type,
      status: 1,
      addTime: Math.floor(Date.now() / 1000),
    });
  }
}
