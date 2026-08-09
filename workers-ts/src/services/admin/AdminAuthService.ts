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
import { storeOrder, user as userTable } from "@/models/schema";
import type { Container } from "@/lib/di";
import type { Env } from "@/env";
import { ValidateException } from "@/utils/errors";
import { createToken, md5 } from "@/utils/jwt";
import { setTokenBucket } from "@/utils/cache";
import bcrypt from "bcryptjs";

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

    const admin = await this.container.systemAdminDao.findByAccount(account);
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
      unique_auth: ["*"], // 占位: 全部权限 (M7+ 接入菜单表后按角色过滤)
      // 嵌套菜单结构 (前端 getChilden 递归取第一个叶子 path → /home)
      menus: [
        {
          id: 1,
          pid: 0,
          path: "/home",
          name: "首页",
          icon: "ios-home",
          sort: 1,
          type: 0,
          children: [
            {
              id: 11,
              pid: 1,
              path: "/home/index",
              name: "控制台",
              icon: "ios-speedometer",
              sort: 1,
              type: 1,
              children: [],
            },
          ],
        },
        {
          id: 2,
          pid: 0,
          path: "/order",
          name: "订单",
          icon: "ios-list-box",
          sort: 2,
          type: 0,
          children: [
            {
              id: 21,
              pid: 2,
              path: "/order/list",
              name: "订单列表",
              icon: "ios-list",
              sort: 1,
              type: 1,
              children: [],
            },
          ],
        },
        {
          id: 3,
          pid: 0,
          path: "/product",
          name: "商品",
          icon: "ios-pricetags",
          sort: 3,
          type: 0,
          children: [
            {
              id: 31,
              pid: 3,
              path: "/product/list",
              name: "商品列表",
              icon: "ios-apps",
              sort: 1,
              type: 1,
              children: [],
            },
          ],
        },
      ],
      logo: "",
      logo_square: "",
      version: "CRMEB-PRO-TS v0.1.0",
    };
  }

  // ─── Dashboard 统计 (对应 PHP StoreOrderServices::homeStatics) ─

  /**
   * 首页统计卡片 (对应 PHP homeStatics)
   *
   * 4 个卡片: 销售额 / 订单量 / 新增用户 / 用户访问
   * 每个返回: { today, yesterday, today_ratio, total, title }
   */
  async dashboard(): Promise<{
    sales: StatCard;
    order: StatCard;
    user: StatCard;
  }> {
    // 时间范围
    const todayStart = this.dayStart(0);
    const todayEnd = this.dayEnd(0);
    const yesterdayStart = this.dayStart(-1);
    const yesterdayEnd = this.dayEnd(-1);
    const monthStart = this.monthStart();

    // 销售额 (pay_price 求和, paid=1, refund_status IN (0,3))
    const salesToday = await this.sumSales(todayStart, todayEnd);
    const salesYesterday = await this.sumSales(yesterdayStart, yesterdayEnd);
    const salesMonth = await this.sumSales(monthStart, todayEnd);

    // 订单量
    const orderToday = await this.countOrders(todayStart, todayEnd);
    const orderYesterday = await this.countOrders(yesterdayStart, yesterdayEnd);
    const orderMonth = await this.countOrders(monthStart, todayEnd);

    // 新增用户
    const userToday = await this.countUsers(todayStart, todayEnd);
    const userYesterday = await this.countUsers(yesterdayStart, yesterdayEnd);
    const userMonth = await this.countUsers(monthStart, todayEnd);

    return {
      sales: {
        today: salesToday.toFixed(2),
        yesterday: salesYesterday.toFixed(2),
        today_ratio: this.countRate(salesToday, salesYesterday),
        total: salesMonth.toFixed(2),
        title: "销售额",
        total_name: "本月销售额",
      },
      order: {
        today: orderToday,
        yesterday: orderYesterday,
        today_ratio: this.countRate(orderToday, orderYesterday),
        total: orderMonth,
        title: "订单量",
        total_name: "本月订单量",
      },
      user: {
        today: userToday,
        yesterday: userYesterday,
        today_ratio: this.countRate(userToday, userYesterday),
        total: userMonth,
        title: "新增用户",
        total_name: "本月新增",
      },
    };
  }

  /** 销售额求和 */
  private async sumSales(start: number, end: number): Promise<number> {
    const c = this.container;
    const rows = await c.db
      .select({ total: sql<number>`COALESCE(SUM(${storeOrder.payPrice}), 0)::numeric(12,2)` })
      .from(storeOrder)
      .where(
        and(
          eq(storeOrder.pid, 0),
          eq(storeOrder.paid, 1),
          eq(storeOrder.isDel, 0),
          sql`${storeOrder.refundStatus} IN (0, 3)`,
          sql`${storeOrder.payTime} BETWEEN ${start} AND ${end}`,
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }

  /** 订单计数 */
  private async countOrders(start: number, end: number): Promise<number> {
    const c = this.container;
    const rows = await c.db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(storeOrder)
      .where(
        and(
          eq(storeOrder.pid, 0),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.paid, 1),
          sql`${storeOrder.refundStatus} IN (0, 3)`,
          sql`${storeOrder.addTime} BETWEEN ${start} AND ${end}`,
        ),
      );
    return rows[0]?.c ?? 0;
  }

  /** 用户计数 */
  private async countUsers(start: number, end: number): Promise<number> {
    const c = this.container;
    const rows = await c.db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(userTable)
      .where(sql`${userTable.addTime} BETWEEN ${start} AND ${end}`);
    return rows[0]?.c ?? 0;
  }

  // ─── 时间工具 (对应 PHP BaseServices::timeHandle) ──────────

  private dayStart(offsetDays: number): number {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  private dayEnd(offsetDays: number): number {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    d.setHours(23, 59, 59, 999);
    return Math.floor(d.getTime() / 1000);
  }

  private monthStart(): number {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  /** 环比增长率 (对应 PHP BaseServices::countRate) */
  private countRate(now: number, last: number): number {
    if (last === 0 && now === 0) return 0;
    if (last === 0) return Math.round((now / 1) * 10000) / 100;
    if (now === 0) return -Math.round((last / 1) * 10000) / 100;
    return Math.round(((now - last) / last) * 10000) / 100;
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

interface StatCard {
  today: string | number;
  yesterday: string | number;
  today_ratio: number;
  total: string | number;
  title: string;
  total_name: string;
}
