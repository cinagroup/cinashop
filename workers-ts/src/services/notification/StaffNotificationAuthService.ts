import { and, eq, sql } from "drizzle-orm";
import { createContainerFromDb, withTx, type Container } from "@/lib/di";
import { storeService, systemAdmin, user } from "@/models/schema";
import { AdminPermissionService } from "@/services/admin/AdminPermissionService";
import { eligibleKefuInboxAccount } from "@/services/kefu/KefuInboxService";
import { getTokenBucket, type RedisEnv } from "@/utils/cache";
import { AuthException } from "@/utils/errors";
import { md5 } from "@/utils/jwt";
import { parseStaffSession, type StaffSocketSession } from "./StaffNotificationProtocol";

/** Recheck the token and current database authority before EVERY connection/delivery/heartbeat. */
export class StaffNotificationAuthService {
  constructor(private readonly container: Container, private readonly env: RedisEnv) {}
  async assertSession(value: StaffSocketSession): Promise<void> {
    const s = parseStaffSession(value);
    if (s.expiresAt <= Math.floor(Date.now() / 1000)) throw new AuthException("通知登录已过期");
    const bucket = await getTokenBucket(s.tokenKey, this.env);
    if (this.env.UPSTASH_REDIS_URL && this.env.UPSTASH_REDIS_TOKEN) {
      if (!bucket || bucket.type !== s.audience || Number(bucket.uid) !== s.authId
        || typeof bucket.token !== "string" || md5(bucket.token) !== s.tokenKey) throw new AuthException("通知令牌已撤销");
    }
    await withTx(this.container, async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      if (s.audience === "kefu") {
        const [account] = await tx.select({ password: storeService.password }).from(storeService)
          .innerJoin(user, eq(user.uid, storeService.uid))
          .where(eligibleKefuInboxAccount({ id: s.authId, uid: s.id })).limit(1);
        if (!account || md5(account.password) !== s.authVersion) throw new AuthException("客服通知权限已撤销");
      } else {
        const [admin] = await tx.select().from(systemAdmin).where(and(eq(systemAdmin.id, s.id),
          eq(systemAdmin.adminType, 1), eq(systemAdmin.status, 1), eq(systemAdmin.isDel, 0))).limit(1);
        if (!admin || md5(admin.pwd) !== s.authVersion) throw new AuthException("管理员通知身份已撤销");
        const keys = await new AdminPermissionService(createContainerFromDb(tx)).resolveAdminPermissionKeys(admin);
        if (!keys.has("extract.view")) throw new AuthException("无提现通知查看权限");
      }
    });
  }
}
