/**
 * UserDao
 *
 * 对应 PHP app/dao/user/UserDao.php + app/model/user/User.php 的 searcher。
 */
import { and, eq, like, or } from "drizzle-orm";
import { BaseDao, type DB } from "@/dao/BaseDao";
import { user, type User } from "@/models/schema/user";
import type { SearcherMap } from "@/models/searchers/types";

/** User 表的 searcher 注册表 (对应 PHP User::searchXxxAttr 方法集合) */
const userSearchers: SearcherMap<typeof user> = {
  /** UID 精确或批量 (对应 searchUidAttr) */
  uid: (value) => {
    if (Array.isArray(value)) return eq(user.uid, value as never);
    return eq(user.uid, value as number);
  },
  /** 状态精确 (对应 searchStatusAttr) */
  status: (value) => eq(user.status, value as number),
  /** 昵称模糊 (对应 searchNicknameAttr) */
  nickname: (value) => like(user.nickname, `%${value as string}%`),
  /** 多字段模糊: 账号|昵称|手机|真实姓名|UID (对应 searchLikeAttr) */
  like: (value) =>
    or(
      like(user.account, `%${value as string}%`),
      like(user.nickname, `%${value as string}%`),
      like(user.phone, `%${value as string}%`),
      like(user.realName, `%${value as string}%`),
    )!,
  /** 手机号精确 (登录用) */
  phone: (value) => eq(user.phone, value as string),
  /** 账号精确 */
  account: (value) => eq(user.account, value as string),
  /** 默认过滤未软删除 */
  isDel: (value) => eq(user.isDel, value as number),
};

export class UserDao extends BaseDao<typeof user> {
  constructor(db: DB) {
    super(db, user, userSearchers);
  }

  /**
   * 按手机号查登录用户 (对应 PHP LoginServices::login 里的 getOne)
   * 只取登录需要的字段, 不泄露余额等敏感字段。
   */
  async findForLogin(phone: string): Promise<Pick<User, "uid" | "pwd" | "status"> | null> {
    const rows = await (this.db
      .select({ uid: user.uid, pwd: user.pwd, status: user.status })
      .from(user)
      .where(and(eq(user.phone, phone), eq(user.isDel, 0)))
      .limit(1) as Promise<Pick<User, "uid" | "pwd" | "status">[]>);
    return rows[0] ?? null;
  }

  /**
   * 按 UID 取鉴权用户 (对应 PHP UserServices::getUserCacheInfo)
   * 用于 auth 中间件: 拿 pwd 校验 auth claim, 拿 status 校验是否封禁。
   */
  async findForAuth(uid: number): Promise<User | null> {
    const rows = await (this.db
      .select()
      .from(user)
      .where(and(eq(user.uid, uid), eq(user.isDel, 0)))
      .limit(1) as Promise<User[]>);
    return rows[0] ?? null;
  }

  /** 更新最后登录时间/IP (对应 PHP updateUserInfo 的 last_time/last_ip) */
  async touchLogin(uid: number, ip: string): Promise<void> {
    await this.update(uid, {
      lastTime: Math.floor(Date.now() / 1000),
      lastIp: ip.slice(0, 16),
    });
  }
}
