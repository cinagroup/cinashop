/**
 * 会员等级 Dao
 *
 * 对应 PHP app/dao/user/level/SystemUserLevelDao.php
 */
import { eq } from "drizzle-orm";
import { BaseDao, type DB } from "@/dao/BaseDao";
import { systemUserLevel } from "@/models/schema";

export class SystemUserLevelDao extends BaseDao<typeof systemUserLevel> {
  constructor(db: DB) {
    super(db, systemUserLevel);
  }

  /** 按 grade 取等级 (PHP getLevel) */
  async getById(id: number) {
    const rows = await this.db
      .select()
      .from(systemUserLevel)
      .where(eq(systemUserLevel.id, id))
      .limit(1);
    return rows[0] ?? null;
  }
}
