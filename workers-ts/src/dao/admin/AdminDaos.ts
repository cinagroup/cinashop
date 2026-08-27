/**
 * 管理后台 Dao (M7)
 */
import { and, eq, ne } from "drizzle-orm";
import { BaseDao, type DB } from "@/dao/BaseDao";
import { systemAdmin, storeServiceLog } from "@/models/schema";

// ─── 管理员 ──────────────────────────────────────────────────
export class SystemAdminDao extends BaseDao<typeof systemAdmin> {
  constructor(db: DB) {
    super(db, systemAdmin, {
      id: (v) => eq(systemAdmin.id, Number(v)),
      account: (v) => eq(systemAdmin.account, String(v)),
      status: (v) => eq(systemAdmin.status, Number(v)),
      isDel: (v) => eq(systemAdmin.isDel, Number(v)),
    });
  }

  /** 按账号查 (登录用) */
  async findByAccount(account: string) {
    const rows = await this.db
      .select()
      .from(systemAdmin)
      .where(eq(systemAdmin.account, account))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 按账号和后台类型查询，避免平台管理员与供应商账号串域。 */
  async findByAccountAndType(account: string, adminType: number) {
    const rows = await this.db
      .select()
      .from(systemAdmin)
      .where(and(eq(systemAdmin.account, account), eq(systemAdmin.adminType, adminType)))
      .limit(1);
    return rows[0] ?? null;
  }

  async accountExistsForOtherAdmin(account: string, adminType: number, adminId: number) {
    const rows = await this.db
      .select({ id: systemAdmin.id })
      .from(systemAdmin)
      .where(
        and(
          eq(systemAdmin.account, account),
          eq(systemAdmin.adminType, adminType),
          ne(systemAdmin.id, adminId),
          eq(systemAdmin.isDel, 0),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** 按手机号查 */
  async findByPhone(phone: string) {
    const rows = await this.db
      .select()
      .from(systemAdmin)
      .where(eq(systemAdmin.phone, phone))
      .limit(1);
    return rows[0] ?? null;
  }
}

// ─── 聊天消息 ────────────────────────────────────────────────
export class StoreServiceLogDao extends BaseDao<typeof storeServiceLog> {
  constructor(db: DB) {
    super(db, storeServiceLog, {
      uid: (v) => eq(storeServiceLog.uid, Number(v)),
      toUid: (v) => eq(storeServiceLog.toUid, Number(v)),
    });
  }

  /** 取两个用户的聊天记录 */
  async getConversation(uid1: number, uid2: number, limit = 50) {
    const { or, and, eq: eqOp, sql } = await import("drizzle-orm");
    return this.db
      .select()
      .from(storeServiceLog)
      .where(
        or(
          and(eqOp(storeServiceLog.uid, uid1), eqOp(storeServiceLog.toUid, uid2)),
          and(eqOp(storeServiceLog.uid, uid2), eqOp(storeServiceLog.toUid, uid1)),
        ) ?? sql`true`,
      )
      .orderBy(sql`${storeServiceLog.addTime} DESC`)
      .limit(limit);
  }

  /** 记录消息 */
  async addMessage(params: {
    uid: number;
    toUid: number;
    msn: string;
    msnType: number;
    isTourist?: number;
  }) {
    return this.save({
      uid: params.uid,
      toUid: params.toUid,
      msn: params.msn,
      msnType: params.msnType,
      isTourist: params.isTourist ?? 0,
      addTime: Math.floor(Date.now() / 1000),
    });
  }
}
