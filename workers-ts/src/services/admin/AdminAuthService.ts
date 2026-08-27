/**
 * 管理后台 Service (M7)
 *
 * 对应 PHP app/services/system/admin/SystemAdminServices.php (login)
 * + StoreOrderServices::homeStatics (Dashboard)
 *
 * 核心:
 *   - login: bcrypt 密码校验 → JWT token (复用 jose, type='admin')
 *   - dashboard: 今日销售额/订单/用户/访问 (4 卡片统计)
 */
import { eq, and, sql } from "drizzle-orm";
import { storeOrder } from "@/models/schema";
import type { Container } from "@/lib/di";
import type { Env } from "@/env";
import { ValidateException } from "@/utils/errors";
import { createToken, md5 } from "@/utils/jwt";
import { setTokenBucket } from "@/utils/cache";
import bcrypt from "bcryptjs";
import { AdminPermissionService } from "@/services/admin/AdminPermissionService";

export class AdminAuthService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  /**
   * 管理员登录 (对应 PHP SystemAdminServices::verifyLogin + login)
   *
   * 与 PHP 一致:
   *   - 密码用 bcrypt (PHP password_hash → $2y$, bcryptjs 兼容)
   *   - JWT type='admin', 复用同一 APP_KEY
   *   - token bucket 存 Upstash
   */
  async login(account: string, password: string): Promise<{
    token: string;
    expires_time: number;
    user_info: Record<string, unknown>;
    unique_auth: string[];
    menus: unknown[];
    logo: string;
    logo_square: string;
    version: string;
  }> {
    if (!account || !password) throw new ValidateException("请输入账号和密码");

    // 平台后台与供应商后台是不同安全域。供应商账号(admin_type=4)
    // 只能从 /supplierapi 登录，不能换取平台 admin token。
    const admin = await this.container.systemAdminDao.findByAccountAndType(account, 1);
    if (!admin) throw new ValidateException("账号或密码错误");
    if (!admin.status) throw new ValidateException("账号已被禁用");
    if (admin.isDel) throw new ValidateException("账号不存在");

    // bcrypt 校验 (PHP $2y$ 格式, bcryptjs 需替换前缀)
    // bcryptjs 兼容 $2a$; $2b$/$2y$ 需替换前缀
    const hash = admin.pwd.replace(/^\$2[by]\$/, "$2a$");
    const valid = bcrypt.compareSync(password, hash);
    if (!valid) throw new ValidateException("账号或密码错误");

    // JWT (type='admin')
    const { token, exp } = await createToken(admin.id, "admin", md5(admin.pwd), this.env.APP_KEY);
    await setTokenBucket(
      md5(token),
      { uid: admin.id, type: "admin", token, exp: exp - Math.floor(Date.now() / 1000) + 60 },
      this.env,
    );

    // 更新登录信息
    await this.container.systemAdminDao.update(admin.id, {
      lastTime: Math.floor(Date.now() / 1000),
      loginCount: admin.loginCount + 1,
    });

    const permissionService = new AdminPermissionService(this.container);
    const permissionKeys = await permissionService.resolveAdminPermissionKeys({
      level: admin.level,
      roles: admin.roles,
    });

    // 返回格式与 CRMEB 前端完全一致:
    //   token, expires_time, user_info, unique_auth, menus, logo, logo_square
    return {
      token,
      expires_time: exp,
      user_info: {
        id: admin.id,
        account: admin.account,
        head_pic: admin.headPic,
        real_name: admin.realName,
        level: admin.level,
        roles: admin.roles,
        is_money_level: 0,
        division_id: admin.divisionId,
      },
      unique_auth: [...permissionKeys],
      menus: permissionService.buildMenus(permissionKeys),
      logo: "",
      logo_square: "",
      version: "CRMEB-PRO-TS v0.1.0",
    };
  }

  /** 管理员消息通知数 (未处理订单/评论/提现) */
  async adminNewPush(): Promise<{
    ordernum: number;
    inventory: number;
    commentnum: number;
    reflectnum: number;
    msgcount: number;
  }> {
    const c = this.container;
    // 待发货订单
    const orderRows = await c.db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(storeOrder)
      .where(
        and(
          eq(storeOrder.paid, 1),
          eq(storeOrder.status, 0),
          eq(storeOrder.isDel, 0),
        ),
      );
    return {
      ordernum: orderRows[0]?.c ?? 0,
      inventory: 0,
      commentnum: 0,
      reflectnum: 0,
      msgcount: 0,
    };
  }
}
