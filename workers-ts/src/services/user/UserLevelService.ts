/**
 * 会员等级 Service
 *
 * 对应 PHP app/services/user/level/SystemUserLevelServices.php::getLevelCache
 *
 * 缓存: KV 存等级信息 (变更频率低), key=level_grade_<id>, TTL 6h。
 */
import { sql } from "drizzle-orm";
import { systemUserLevel, userBill as userBillTable } from "@/models/schema";
import type { Container } from "@/lib/di";
import type { Env } from "@/env";
import { ValidateException } from "@/utils/errors";

const CACHE_TTL = 6 * 3600;

export interface LevelInfo {
  id: number;
  name: string;
  discount: number; // 0-100
  grade: number;
  /** 升级所需经验 (可选) */
  expNum?: number;
  /** 购买金额 (可选) */
  money?: string;
  icon?: string;
  image?: string;
  isForever?: number;
}

export class UserLevelService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  /**
   * 取会员等级信息 (带缓存, 对应 PHP getLevelCache)
   * @param levelId user.level 字段 (system_user_level.id)
   */
  async getLevel(levelId: number): Promise<LevelInfo | null> {
    if (!levelId) return null;

    const cacheKey = `level_${levelId}`;
    const cached = await this.env.CONFIG_KV.get<LevelInfo>(cacheKey, "json");
    if (cached) return cached;

    const row = await this.container.systemUserLevelDao.getById(levelId);
    if (!row || !row.isShow || row.isDel) return null;

    const info: LevelInfo = {
      id: row.id,
      name: row.name,
      discount: Number(row.discount) || 100,
      grade: row.grade,
    };

    await this.env.CONFIG_KV.put(cacheKey, JSON.stringify(info), {
      expirationTtl: CACHE_TTL,
    });
    return info;
  }

  /** 失效缓存 (后台改等级后调用) */
  async invalidate(levelId: number): Promise<void> {
    await this.env.CONFIG_KV.delete(`level_${levelId}`);
  }

  // ═══ 用户端 API (对应原版 user/level/*) ═════════════════

  /** 等级列表 (user/level/grade) */
  async gradeList(): Promise<LevelInfo[]> {
    const rows = await this.container.db
      .select()
      .from(systemUserLevel)
      .where(sql`${systemUserLevel.isShow} = 1 AND ${systemUserLevel.isDel} = 0`)
      .orderBy(sql`${systemUserLevel.grade} ASC`);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      discount: Number(r.discount) || 100,
      grade: r.grade,
      money: r.money,
      expNum: r.expNum,
      icon: r.icon,
      image: r.image,
      isForever: r.isForever,
    }));
  }

  /** 用户等级信息 (user/level/info) */
  async userLevelInfo(uid: number): Promise<{
    level: LevelInfo | null;
    currentExp: number;
    nextLevel: LevelInfo | null;
    nextExpNeed: number;
  }> {
    const user = await this.container.userDao.findForAuth(uid);
    if (!user) return { level: null, currentExp: 0, nextLevel: null, nextExpNeed: 0 };

    const current = user.level ? await this.getLevel(user.level) : null;
    const all = await this.gradeList();
    const idx = all.findIndex((l) => l.id === user.level);
    const next = idx >= 0 && idx < all.length - 1 ? all[idx + 1] : null;

    return {
      level: current,
      currentExp: Number(user.exp) || 0,
      nextLevel: next,
      nextExpNeed: next ? Math.max(0, (next.expNum ?? 0) - (Number(user.exp) || 0)) : 0,
    };
  }

  /** 激活等级 (user/level/activate, 简化: 升级到指定等级) */
  async activateLevel(
    uid: number,
    levelId: number,
  ): Promise<{ levelId: number; name: string }> {
    const level = await this.getLevel(levelId);
    if (!level) throw new ValidateException("等级不存在");

    // 简化实现: 直接设置用户等级 (M5+ 完整版按条件校验经验/付费)
    await this.container.userDao.update(uid, { level: levelId });
    return { levelId, name: level.name };
  }

  /** 经验明细 (user/level/expList) */
  async expList(uid: number, page = 1, limit = 10) {
    const c = this.container;
    const rows = await c.db
      .select({
        id: userBillTable.id,
        title: userBillTable.title,
        number: userBillTable.number,
        addTime: userBillTable.addTime,
      })
      .from(userBillTable)
      .where(sql`${userBillTable.uid} = ${uid} AND ${userBillTable.category} = 'exp'`)
      .orderBy(sql`${userBillTable.addTime} DESC`)
      .limit(limit)
      .offset((page - 1) * limit);
    return rows;
  }
}
