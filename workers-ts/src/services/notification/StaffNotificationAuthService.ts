import { and, eq, sql } from "drizzle-orm";
import { createContainerFromDb, withTx, type Container } from "@/lib/di";
import { storeService, systemAdmin, user } from "@/models/schema";
import { AdminPermissionService } from "@/services/admin/AdminPermissionService";
import { eligibleKefuInboxAccount } from "@/services/kefu/KefuInboxService";
import { getTokenBucket, type RedisEnv } from "@/utils/cache";
import { AuthException } from "@/utils/errors";
import { md5 } from "@/utils/jwt";
import { parseStaffSession, type StaffSocketSession } from "./StaffNotificationProtocol";
import { loadAdminLegacyRoleReferenceHistory } from '@/services/admin/AdminLegacyRoleDeletionProof';
import { parseAdminAuthorityRoleIds } from '@/services/admin/AdminAuthorityWriteService';

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
          eq(systemAdmin.adminType, 1), eq(systemAdmin.relationId, 0), eq(systemAdmin.status, 1), eq(systemAdmin.isDel, 0))).limit(1);
        if (!admin || md5(admin.pwd) !== s.authVersion) throw new AuthException("管理员通知身份已撤销");
        if (s.scope === 'product_stock') {
          if (!Number.isInteger(admin.level) || admin.level < 0 || admin.level > 9) throw new AuthException('管理员库存通知身份无效');
          await loadAdminLegacyRoleReferenceHistory(tx, parseAdminAuthorityRoleIds(admin.roles), admin.level);
        }
        const keys = await new AdminPermissionService(createContainerFromDb(tx)).resolveAdminPermissionKeys(admin);
        if (!keys.has(s.scope === 'product_stock' ? 'product.view' : 'extract.view')) throw new AuthException(s.scope === 'product_stock' ? '无库存通知查看权限' : '无提现通知查看权限');
      }
      const [clock] = await tx.execute(sql`SELECT extract(epoch FROM clock_timestamp()) >= ${s.expiresAt} AS expired`) as unknown as Array<{ expired: boolean }>;
      if (clock?.expired !== false) throw new AuthException('通知登录已过期');
    });
  }
}
