/**
 * API v1 路由
 *
 * 对应 PHP route/api.php 的部分。
 * 命名与 PHP 路由保持一致, 方便前端无感切换。
 */
import { Hono } from "hono";
import { authMiddleware } from "@/middleware/auth";
import * as LoginController from "@/controllers/api/v1/LoginController";
import * as PublicController from "@/controllers/api/v1/PublicController";
import * as ProductController from "@/controllers/api/v1/ProductController";
import * as OrderController from "@/controllers/api/v1/OrderController";
import * as PayController from "@/controllers/api/v1/PayController";
import * as UserActivityController from "@/controllers/api/v1/UserActivityController";
import * as UserFinanceController from "@/controllers/api/v1/UserFinanceController";
import * as UserLevelController from "@/controllers/api/v1/UserLevelController";
import * as CommunityController from "@/controllers/api/v1/CommunityController";
import * as ActivityJoinController from "@/controllers/api/v1/ActivityJoinController";
import * as UserMessageController from "@/controllers/api/v1/UserMessageController";
import * as WechatController from "@/controllers/api/v1/WechatController";
import * as ReplyController from "@/controllers/api/v1/ReplyController";
import * as AdminController from "@/controllers/api/v1/AdminController";
import * as AdminCrud from "@/controllers/api/v1/AdminCrudController";
import { adminAuthMiddleware } from "@/middleware/admin-auth";
import type { AppVariables, Env } from "@/env";

export const v1Routes = new Hono<{
  Bindings: Env;
  Variables: AppVariables & { container: import("@/lib/di").Container };
}>();

// ─── 登录类 (无需 auth) ───────────────────────────────────────
v1Routes.post("/login", LoginController.login);
v1Routes.post("/register", LoginController.register);
v1Routes.post("/user/change_password", authMiddleware({ force: true }), LoginController.changePassword);

// ─── 无需授权接口 ─────────────────────────────────────────────
v1Routes.get("/site_config", PublicController.getSiteConfig);
v1Routes.get("/get_copyright", PublicController.getCopyright);
v1Routes.get("/search/hot_keyword", PublicController.hotKeywords);
v1Routes.get("/search/keyword", PublicController.searchWords);
v1Routes.get("/user_agreement/:type", PublicController.getUserAgreement);
v1Routes.get("/agreement/:type", PublicController.getUserAgreement);

// ─── 商品域 (可选登录, 对应 PHP AuthTokenMiddleware force=false) ──
// 无需登录浏览, 带 token 时返回收藏状态等
v1Routes.get("/category", authMiddleware({ force: false }), ProductController.category);
v1Routes.get("/category_version", ProductController.categoryVersion);
v1Routes.get("/level_category", ProductController.levelCategory);
v1Routes.get("/products", authMiddleware({ force: false }), ProductController.lst);
v1Routes.get("/product/detail/:id", authMiddleware({ force: false }), ProductController.detail);

// ─── 需授权接口 ────────────────────────────────────────────────
v1Routes.get("/logout", authMiddleware({ force: true }), LoginController.logout);

// ─── 购物车 (M3) ───────────────────────────────────────────────
v1Routes.post("/cart/add", authMiddleware({ force: true }), OrderController.cartAdd);
v1Routes.get("/cart/list", authMiddleware({ force: true }), OrderController.cartList);
v1Routes.post("/cart/num", authMiddleware({ force: true }), OrderController.cartNum);
v1Routes.post("/cart/del", authMiddleware({ force: true }), OrderController.cartDel);
v1Routes.get("/cart/count", authMiddleware({ force: true }), OrderController.cartCount);

// ─── 订单 (M3) ─────────────────────────────────────────────────
v1Routes.post("/order/create/:key", authMiddleware({ force: true }), OrderController.orderCreate);
v1Routes.get("/order/list", authMiddleware({ force: true }), OrderController.orderList);
v1Routes.get("/order/detail/:uni", authMiddleware({ force: true }), OrderController.orderDetail);
// 订单操作 (补全)
v1Routes.post("/order/take", authMiddleware({ force: true }), OrderController.orderTake);
v1Routes.post("/order/cancel", authMiddleware({ force: true }), OrderController.orderCancel);
v1Routes.post("/order/del", authMiddleware({ force: true }), OrderController.orderDel);
v1Routes.post("/order/again", authMiddleware({ force: true }), OrderController.orderAgain);

// ─── 支付 (M4+M6) ──────────────────────────────────────────────
v1Routes.post("/order/pay", authMiddleware({ force: true }), PayController.orderPay);
// 支付回调 (无需 auth, 第三方调用)
// M6: 微信回调直连验签; 其他类型仍走 PHP 转发
v1Routes.all("/pay/notify/wechat", WechatController.wechatPayNotify);
v1Routes.all("/pay/notify/:type", PayController.payNotify);
// 微信 JSAPI 下单
v1Routes.post("/order/wechat_pay", authMiddleware({ force: true }), WechatController.wechatPayOrder);

// ─── 售后退款 (M4) ─────────────────────────────────────────────
v1Routes.post("/order/refund/apply/:id", authMiddleware({ force: true }), PayController.refundApply);
v1Routes.post("/order/refund/cancel/:uni", authMiddleware({ force: true }), PayController.refundCancel);
v1Routes.get("/order/refund/list", authMiddleware({ force: true }), PayController.refundList);
v1Routes.get("/order/refund/detail/:uni", authMiddleware({ force: true }), PayController.refundDetail);

// ─── 用户中心: 地址 (M5) ───────────────────────────────────────
v1Routes.get("/address/list", authMiddleware({ force: true }), UserActivityController.addressList);
v1Routes.get("/address/default", authMiddleware({ force: true }), UserActivityController.addressDefault);
v1Routes.post("/address/edit", authMiddleware({ force: true }), UserActivityController.addressEdit);
v1Routes.post("/address/del", authMiddleware({ force: true }), UserActivityController.addressDel);

// ─── 用户中心: 收藏 (M5) ───────────────────────────────────────
v1Routes.post("/collect/add", authMiddleware({ force: true }), UserActivityController.collectAdd);
v1Routes.post("/collect/del", authMiddleware({ force: true }), UserActivityController.collectDel);
v1Routes.get("/collect/user", authMiddleware({ force: true }), UserActivityController.collectList);

// ─── 用户中心: 签到 (M5) ───────────────────────────────────────
v1Routes.post("/sign/integral", authMiddleware({ force: true }), UserActivityController.signDo);
v1Routes.get("/sign/status", authMiddleware({ force: true }), UserActivityController.signStatus);

// ─── 分销/佣金/提现 (补全) ─────────────────────────────────────
v1Routes.post("/user/spread", authMiddleware({ force: true }), UserFinanceController.bindSpread);
v1Routes.get("/commission", authMiddleware({ force: true }), UserFinanceController.commission);
v1Routes.post("/spread/people", authMiddleware({ force: true }), UserFinanceController.spreadPeople);
v1Routes.get("/spread/commission/:type", authMiddleware({ force: true }), UserFinanceController.commissionList);
v1Routes.post("/extract/cash", authMiddleware({ force: true }), UserFinanceController.extractCash);
v1Routes.get("/user/extract/list", authMiddleware({ force: true }), UserFinanceController.extractList);

// ─── 会员等级 (补全) ───────────────────────────────────────────
v1Routes.get("/user/level/grade", authMiddleware({ force: false }), UserLevelController.levelGrade);
v1Routes.get("/user/level/info", authMiddleware({ force: true }), UserLevelController.levelInfo);
v1Routes.post("/user/level/activate", authMiddleware({ force: true }), UserLevelController.levelActivate);
v1Routes.get("/user/level/expList", authMiddleware({ force: true }), UserLevelController.levelExpList);

// ─── 社区 (补全) ───────────────────────────────────────────────
v1Routes.get("/community/list", authMiddleware({ force: false }), CommunityController.communityList);
v1Routes.get("/community/detail/:id", authMiddleware({ force: false }), CommunityController.communityDetail);
v1Routes.post("/community/like/:id", authMiddleware({ force: true }), CommunityController.communityLike);
v1Routes.post("/community_save", authMiddleware({ force: true }), CommunityController.communitySave);
v1Routes.get("/community/comment/list", authMiddleware({ force: false }), CommunityController.communityCommentList);
v1Routes.post("/community/comment/save", authMiddleware({ force: true }), CommunityController.communityCommentSave);
v1Routes.delete("/community_delete/:id", authMiddleware({ force: true }), CommunityController.communityDelete);

// ─── 充值 (补全) ───────────────────────────────────────────────
v1Routes.post("/recharge/recharge", authMiddleware({ force: true }), UserMessageController.rechargeCreate);
v1Routes.get("/recharge/index", authMiddleware({ force: true }), UserMessageController.rechargeIndex);

// ─── 站内信 (补全) ─────────────────────────────────────────────
v1Routes.get("/user/info", authMiddleware({ force: true }), UserMessageController.userInfo);
v1Routes.post("/user/edit", authMiddleware({ force: true }), UserMessageController.userEdit);
v1Routes.get("/service/chat_history", authMiddleware({ force: true }), UserMessageController.serviceChatHistory);
v1Routes.post("/service/send", authMiddleware({ force: true }), UserMessageController.serviceSend);
v1Routes.get("/user/message", authMiddleware({ force: true }), UserMessageController.messageList);
v1Routes.get("/user/message_system/list", authMiddleware({ force: true }), UserMessageController.messageList);
v1Routes.get("/user/message_system/detail/:id", authMiddleware({ force: true }), UserMessageController.messageDetail);

// ─── 发票 (补全) ───────────────────────────────────────────────
v1Routes.get("/invoice", authMiddleware({ force: true }), UserFinanceController.invoiceList);
v1Routes.post("/invoice/save", authMiddleware({ force: true }), UserFinanceController.invoiceSave);
v1Routes.delete("/invoice/del/:id", authMiddleware({ force: true }), UserFinanceController.invoiceDel);
v1Routes.post("/invoice/set_default/:id", authMiddleware({ force: true }), UserFinanceController.invoiceSetDefault);
v1Routes.get("/invoice/get_default/:type", authMiddleware({ force: true }), UserFinanceController.invoiceGetDefault);

// ─── 优惠券 (M5) ───────────────────────────────────────────────
v1Routes.get("/coupons", authMiddleware({ force: false }), UserActivityController.couponList);
v1Routes.post("/coupon/receive", authMiddleware({ force: true }), UserActivityController.couponReceive);
v1Routes.get("/coupons/user/:types", authMiddleware({ force: true }), UserActivityController.myCoupons);

// ─── 秒杀 (M5) ─────────────────────────────────────────────────
v1Routes.get("/seckill/index", authMiddleware({ force: false }), UserActivityController.seckillIndex);
v1Routes.get("/seckill/list/:time", authMiddleware({ force: false }), UserActivityController.seckillList);
v1Routes.get("/seckill/detail/:id", authMiddleware({ force: false }), UserActivityController.seckillDetail);

// ─── 拼团 (M5) ─────────────────────────────────────────────────
v1Routes.get("/combination/list", authMiddleware({ force: false }), UserActivityController.combinationList);
v1Routes.get("/combination/detail/:id", authMiddleware({ force: false }), UserActivityController.combinationDetail);

// ─── 砍价 (M5) ─────────────────────────────────────────────────
v1Routes.get("/bargain/list", authMiddleware({ force: false }), UserActivityController.bargainList);
v1Routes.get("/bargain/detail/:id", authMiddleware({ force: false }), UserActivityController.bargainDetail);

// ─── 活动参与 (拼团/砍价, 补全) ───────────────────────────────
v1Routes.get("/combination/pink/:id", authMiddleware({ force: false }), ActivityJoinController.pinkInfo);
v1Routes.post("/pink", authMiddleware({ force: true }), ActivityJoinController.joinPink);
v1Routes.post("/combination/remove", authMiddleware({ force: true }), ActivityJoinController.removePink);
v1Routes.post("/bargain/start", authMiddleware({ force: true }), ActivityJoinController.startBargain);
v1Routes.post("/bargain/help", authMiddleware({ force: true }), ActivityJoinController.helpBargain);
v1Routes.get("/bargain/user/list", authMiddleware({ force: true }), ActivityJoinController.myBargains);
v1Routes.post("/bargain/user/cancel", authMiddleware({ force: true }), ActivityJoinController.cancelBargain);

// ─── 积分商城 (M5) ─────────────────────────────────────────────
v1Routes.get("/store_integral/list", authMiddleware({ force: false }), UserActivityController.integralList);
v1Routes.get("/store_integral/detail/:id", authMiddleware({ force: false }), UserActivityController.integralDetail);
v1Routes.post("/store_integral/exchange/:id", authMiddleware({ force: true }), UserActivityController.integralExchange);

// ─── 商品评价 (M8) ─────────────────────────────────────────────
v1Routes.get("/reply/config/:productId", authMiddleware({ force: false }), ReplyController.replyConfig);
v1Routes.get("/reply/list/:productId", authMiddleware({ force: false }), ReplyController.replyList);
v1Routes.post("/reply/submit", authMiddleware({ force: true }), ReplyController.submitReply);
v1Routes.post("/reply/praise/:id", authMiddleware({ force: true }), ReplyController.praiseReply);

// ─── 物流查询 (M8) ─────────────────────────────────────────────
v1Routes.get("/order/express/:orderId", authMiddleware({ force: true }), OrderController.orderExpress);

// ─── 调试 (开发用, 生产通过 ENV DEBUG=1 启用) ────────────────
const debugGuard = (c: any) => {
  if (c.env.DEBUG !== "1" && c.env.NODE_ENV !== "development") {
    return c.json({ status: 403, msg: "调试接口已禁用", data: null }, 403);
  }
};
v1Routes.get("/_debug", async (c) => {
  const blocked = debugGuard(c);
  if (blocked) return blocked;
  const hasRedis = !!c.env.UPSTASH_REDIS_URL && !!c.env.UPSTASH_REDIS_TOKEN;
  const { setTokenBucket, getTokenBucket } = await import("@/utils/cache");
  const testKey = "debug_test";
  const testBucket = { uid: 999, type: "api", token: "test", exp: 60 };
  let writeOk: boolean | string = false;
  let readOk: boolean | string = false;
  let readVal = null;
  try {
    writeOk = await setTokenBucket(testKey, testBucket, c.env);
  } catch (e) {
    writeOk = `error: ${e instanceof Error ? e.message : String(e)}`;
  }
  try {
    readVal = await getTokenBucket(testKey, c.env);
    readOk = !!readVal;
  } catch (e) {
    readOk = `error: ${e instanceof Error ? e.message : String(e)}`;
  }
  return c.json({
    hasRedis,
    redisUrl: c.env.UPSTASH_REDIS_URL?.slice(0, 30) ?? "(empty)",
    redisTokenLen: c.env.UPSTASH_REDIS_TOKEN?.length ?? 0,
    writeOk,
    readOk,
    readVal,
  });
});

// ─── 迁移 + 种子数据 (开发用, 生产删除) ─────────────────────
// 支持 ?reset=1: 先 drop activity 表再重建 (修复表结构不一致)
v1Routes.get("/_migrate", async (c) => {
  const blocked = debugGuard(c);
  if (blocked) return blocked;
  const { sql } = await import("drizzle-orm");
  if (c.req.query("reset") === "1") {
    const container = c.get("container");
    const dropTables = [
      "store_combination", "store_seckill", "store_seckill_time", "store_pink",
      "store_bargain", "store_integral", "store_coupon_issue", "store_coupon_user",
      "store_order_refund", "store_order_status",
    "user_invoice", "user_money", "user_recharge", "user_brokerage", "user_extract",
    ];
    const dropped: string[] = [];
    for (const t of dropTables) {
      try {
        await container.db.execute(sql.raw(`DROP TABLE IF EXISTS "${t}" CASCADE`));
        dropped.push(t);
      } catch (e) {
        dropped.push(`${t}: ${e instanceof Error ? e.message.slice(0, 40) : e}`);
      }
    }
    // 同一请求内重建 (确保用当前代码建表)
    const { MigrationService } = await import("@/services/MigrationService");
    const svc = new MigrationService(container);
    const result = await svc.runAll();
    return c.json({ ok: true, dropped, migrated: result.executed });
  }

  const { MigrationService } = await import("@/services/MigrationService");
  const svc = new MigrationService(c.get("container"));
  const result = await svc.runAll();

  // 诊断: 检查关键表是否存在
  const container = c.get("container");
  // 数据库连接诊断
  const dbInfo: string[] = [];
  try {
    const raw = await container.db.execute(sql.raw("SELECT current_database() AS db, current_schema() AS sch"));
    const arr = Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? [];
    dbInfo.push(`db=${(arr[0] as { db?: string })?.db ?? "?"} schema=${(arr[0] as { sch?: string })?.sch ?? "?"}`);
  } catch (e) {
    dbInfo.push(`ERR ${e instanceof Error ? e.message.slice(0, 80) : e}`);
  }
  const tables: string[] = [];
  for (const t of [
    "user", "system_config", "store_product", "store_cart", "store_order",
    "store_order_refund", "system_admin", "store_order_status",
    "user_invoice", "user_money", "user_recharge", "user_brokerage", "user_extract",
    "store_combination", "store_seckill", "store_coupon_issue", "store_bargain",
    "store_integral", "store_seckill_time", "store_pink",
  ]) {
    try {
      // to_regclass 不接受参数化, 用字符串拼接 (t 来自白名单)
      const raw = await container.db.execute(sql.raw(`SELECT to_regclass('${t}') AS tbl`));
      const arr = Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? [];
      const exists = (arr[0] as { tbl?: string } | undefined)?.tbl ?? null;
      tables.push(`${t}: ${exists ? "OK" : "MISSING"}`);
    } catch (e) {
      tables.push(`${t}: ERR ${e instanceof Error ? e.message.slice(0, 50) : e}`);
    }
  }
  return c.json({ ...result, dbInfo, tables });
});

v1Routes.get("/_seed", async (c) => {
  const blocked = debugGuard(c);
  if (blocked) return blocked;
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const now = Math.floor(Date.now() / 1000);

  try {
    // 测试用户幂等 (M18 修复: 不 DELETE, UPDATE 保持 uid 稳定, 避免旧订单/地址对不上)
    const { md5 } = await import("@/utils/jwt");
    const upsertUser = async (account: string, nickname: string) => {
      await container.db.execute(sql`
        UPDATE "user" SET pwd = ${md5("password")}, nickname = ${nickname}, status = 1, is_del = 0,
          now_money = 1000.00, integral = 500, last_time = ${now}
        WHERE account = ${account}
      `);
      await container.db.execute(sql`
        INSERT INTO "user" ("account", "pwd", "nickname", "phone", "now_money", "integral", "status", "add_time", "last_time")
        SELECT ${account}, ${md5("password")}, ${nickname}, ${account}, 1000.00, 500, 1, ${now}, ${now}
        WHERE NOT EXISTS (SELECT 1 FROM "user" WHERE account = ${account})
      `);
    };
    await upsertUser("13800138000", "测试用户");
    await upsertUser("13900000002", "测试买家");
    // 重置买家推广关系 → 绑定到测试用户 (可重复执行验证佣金链路)
    await container.db.execute(sql`
      UPDATE "user" SET spread_uid = (SELECT uid FROM "user" WHERE account = '13800138000' LIMIT 1),
        spread_time = ${now}
      WHERE account = '13900000002'
    `);

    // 插入测试商品
    await container.db.execute(sql`
      INSERT INTO "store_product" ("store_name", "store_info", "image", "price", "ot_price", "stock", "sales", "ficti", "is_show", "is_verify", "is_del", "spec_type", "add_time", "cate_id", "keyword")
      VALUES ('测试商品A', '这是一个测试商品', 'https://via.placeholder.com/300', 99.90, 199.00, 100, 50, 200, 1, 1, 0, 0, ${now}, '1', '测试')
      ON CONFLICT DO NOTHING
    `);
    await container.db.execute(sql`
      INSERT INTO "store_product" ("store_name", "store_info", "image", "price", "ot_price", "stock", "sales", "ficti", "is_show", "is_verify", "is_del", "spec_type", "add_time", "cate_id", "keyword", "is_vip", "vip_price")
      VALUES ('会员专享商品B', '会员价商品', 'https://via.placeholder.com/300', 299.00, 399.00, 50, 30, 100, 1, 1, 0, 0, ${now}, '1', '会员', 1, 199.00)
      ON CONFLICT DO NOTHING
    `);

    // 插入 SKU (unique='sku00001')
    await container.db.execute(sql`
      INSERT INTO "store_product_attr_value" ("product_id", "suk", "stock", "sales", "price", "ot_price", "unique", "type")
      VALUES (1, '默认', 100, 50, 99.90, 199.00, 'sku00001', 0)
      ON CONFLICT DO NOTHING
    `);
    await container.db.execute(sql`
      INSERT INTO "store_product_attr_value" ("product_id", "suk", "stock", "sales", "price", "ot_price", "vip_price", "unique", "type")
      VALUES (2, '默认', 50, 30, 299.00, 399.00, 199.00, 'sku00002', 0)
      ON CONFLICT DO NOTHING
    `);

    // 插入分类 (幂等: 先清种子分类再插, cate_name 无唯一约束)
    // 结构: 6 个一级 + 14 个二级, 显式 id 避开既有数据
    const CATE_NAMES = [
      "电子产品", "服装", "食品生鲜", "美妆个护", "家居日用", "运动户外",
      "手机通讯", "电脑办公", "影音娱乐", "男装", "女装", "童装",
      "休闲零食", "粮油调味", "水果蔬菜", "面部护肤", "彩妆香水", "洗护用品",
      "厨房用品", "收纳整理", "床上用品", "运动服饰", "健身器材", "户外装备",
    ];
    await container.db.execute(
      sql`DELETE FROM store_product_category WHERE cate_name IN (${sql.join(CATE_NAMES.map((n) => sql`${n}`), sql`,`)})`,
    );
    // 分类图标用内联 SVG data URI (不依赖外部占位图服务)
    const CATE_PIC = (color: string) =>
      "data:image/svg+xml," +
      encodeURIComponent(
        `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><rect width='120' height='120' rx='16' fill='#${color}'/></svg>`,
      );
    // 一级分类 id: 60-65; 二级 id: 70-83 (显式指定, 避免与序列冲突)
    await container.db.execute(sql`
      INSERT INTO "store_product_category" ("id", "pid", "cate_name", "level", "is_show", "sort", "pic", "add_time") VALUES
        (60, 0, '电子产品', 0, 1, 100, ${CATE_PIC("3a7afe")}, ${now}),
        (61, 0, '服装', 0, 1, 99, ${CATE_PIC("f56c6c")}, ${now}),
        (62, 0, '食品生鲜', 0, 1, 98, ${CATE_PIC("f7ba2a")}, ${now}),
        (63, 0, '美妆个护', 0, 1, 97, ${CATE_PIC("ec7dc5")}, ${now}),
        (64, 0, '家居日用', 0, 1, 96, ${CATE_PIC("67c23a")}, ${now}),
        (65, 0, '运动户外', 0, 1, 95, ${CATE_PIC("9261dc")}, ${now})
      ON CONFLICT DO NOTHING
    `);
    await container.db.execute(sql`
      INSERT INTO "store_product_category" ("id", "pid", "cate_name", "level", "is_show", "sort", "pic", "add_time") VALUES
        (70, 60, '手机通讯', 1, 1, 100, ${CATE_PIC("3a7afe")}, ${now}),
        (71, 60, '电脑办公', 1, 1, 99, ${CATE_PIC("3a7afe")}, ${now}),
        (72, 60, '影音娱乐', 1, 1, 98, ${CATE_PIC("3a7afe")}, ${now}),
        (73, 61, '男装', 1, 1, 100, ${CATE_PIC("f56c6c")}, ${now}),
        (74, 61, '女装', 1, 1, 99, ${CATE_PIC("f56c6c")}, ${now}),
        (75, 61, '童装', 1, 1, 98, ${CATE_PIC("f56c6c")}, ${now}),
        (76, 62, '休闲零食', 1, 1, 100, ${CATE_PIC("f7ba2a")}, ${now}),
        (77, 62, '粮油调味', 1, 1, 99, ${CATE_PIC("f7ba2a")}, ${now}),
        (78, 62, '水果蔬菜', 1, 1, 98, ${CATE_PIC("f7ba2a")}, ${now}),
        (79, 63, '面部护肤', 1, 1, 100, ${CATE_PIC("ec7dc5")}, ${now}),
        (80, 63, '彩妆香水', 1, 1, 99, ${CATE_PIC("ec7dc5")}, ${now}),
        (81, 63, '洗护用品', 1, 1, 98, ${CATE_PIC("ec7dc5")}, ${now}),
        (82, 64, '厨房用品', 1, 1, 100, ${CATE_PIC("67c23a")}, ${now}),
        (83, 64, '收纳整理', 1, 1, 99, ${CATE_PIC("67c23a")}, ${now}),
        (84, 64, '床上用品', 1, 1, 98, ${CATE_PIC("67c23a")}, ${now}),
        (85, 65, '运动服饰', 1, 1, 100, ${CATE_PIC("9261dc")}, ${now}),
        (86, 65, '健身器材', 1, 1, 99, ${CATE_PIC("9261dc")}, ${now}),
        (87, 65, '户外装备', 1, 1, 98, ${CATE_PIC("9261dc")}, ${now})
      ON CONFLICT DO NOTHING
    `);
    // 分类树缓存失效 (TTL 1h, 不失效则前端拿旧树)
    try {
      const { StoreCategoryService } = await import("@/services/product/StoreCategoryService");
      await new StoreCategoryService(container, c.env).invalidate();
    } catch {
      // 忽略: 缓存 1h 后自然过期
    }

    // 纯种子表幂等: 无唯一约束, ON CONFLICT 不生效, 先清再插
    await container.db.execute(
      sql`DELETE FROM system_user_level; DELETE FROM system_message; DELETE FROM store_product_words;
          DELETE FROM system_config WHERE menu_name IS NULL OR menu_name = '' OR menu_name IN ('site_name','site_logo','site_url','record_No','site_phone','share_info','sign_in_integral','sign_in_switch','auto_receive_day','auto_evaluate_day','sign_give_point','sign_status','system_delivery_time','system_comment_time');`,
    );

    // SKU 去重 (M18: 重复 seed 产生的同 unique 多行, 保留 id 最小)
    await container.db.execute(sql`
      DELETE FROM store_product_attr_value a USING store_product_attr_value b
      WHERE a.product_id = b.product_id AND a.unique = b.unique AND a.type = b.type AND a.id > b.id
    `);
    // 商品详情缓存失效 (600s TTL, 否则前端拿到旧 SKU)
    try {
      const { cacheDelete } = await import("@/utils/cache");
      await cacheDelete("product_info_1", c.env);
      await cacheDelete("product_info_2", c.env);
    } catch {
      // 忽略
    }

    // 插入基础配置 (Web 端 site_config 读取; system_config 无 add_time 列)
    await container.db.execute(sql`
      INSERT INTO "system_config" ("menu_name", "info", "value", "is_store", "type", "input_type", "sort", "status")
      VALUES
        ('site_name', '站点名称', 'CinaShop', 0, 'input', 'input', 100, 1),
        ('site_logo', '站点Logo', 'https://cinashop-pc.pages.dev/logo.png', 0, 'image', 'image', 99, 1),
        ('site_url', '站点地址', 'https://cinashop-pc.pages.dev', 0, 'input', 'input', 98, 1),
        ('record_No', '网站备案号', '京ICP备12345678号', 0, 'input', 'input', 97, 1),
        ('site_phone', '客服电话', '400-000-0000', 0, 'input', 'input', 96, 1),
        ('share_info', '分享描述', 'CinaShop 商城系统', 0, 'textarea', 'textarea', 95, 1),
        ('sign_in_integral', '签到基础积分', '1', 0, 'number', 'number', 90, 1),
        ('sign_in_switch', '签到开关', '1', 0, 'switch', 'switch', 89, 1),
        ('auto_receive_day', '自动收货天数', '7', 0, 'number', 'number', 88, 1),
        ('auto_evaluate_day', '自动评价天数', '7', 0, 'number', 'number', 87, 1)
    `);

    // 插入会员等级
    await container.db.execute(sql`
      INSERT INTO "system_user_level" ("name", "discount", "grade", "is_show", "exp_num", "add_time")
      VALUES ('白银会员', 95, 1, 1, 100, ${now}), ('黄金会员', 88, 2, 1, 500, ${now}), ('钻石会员', 70, 3, 1, 2000, ${now})
      ON CONFLICT DO NOTHING
    `);

    // 插入搜索热词
    await container.db.execute(sql`
      INSERT INTO "store_product_words" ("name", "is_show", "is_hot", "sort", "add_time")
      VALUES ('测试商品', 1, 1, 100, ${now}), ('手机', 1, 1, 99, ${now}), ('电脑', 1, 1, 98, ${now}), ('连衣裙', 1, 1, 97, ${now})
      ON CONFLICT DO NOTHING
    `);

    // 插入站内信
    await container.db.execute(sql`
      INSERT INTO "system_message" ("title", "content", "status", "add_time")
      VALUES ('欢迎使用 CinaShop', '感谢您选择我们, 祝您购物愉快!', 1, ${now})
      ON CONFLICT DO NOTHING
    `);

    // 砍价商品 upsert (M19: 保持活动 id 稳定)
    await container.db.execute(sql`
      UPDATE "store_bargain" SET product_id = 1, image = 'https://via.placeholder.com/300',
        price = 99.90, min_price = 59.90, quota = 100, quota_show = 100, stock = 100, people = 10, status = 1, sort = 90
      WHERE store_name = '砍价商品-测试商品A'
    `);
    await container.db.execute(sql`
      INSERT INTO "store_bargain" ("product_id", "store_name", "image", "price", "min_price", "quota", "quota_show", "stock", "sales", "people", "status", "sort", "add_time")
      SELECT 1, '砍价商品-测试商品A', 'https://via.placeholder.com/300', 99.90, 59.90, 100, 100, 100, 0, 10, 1, 90, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM store_bargain WHERE store_name = '砍价商品-测试商品A')
    `);

    // 拼团商品 upsert (M19: 保持活动 id 稳定)
    await container.db.execute(sql`
      UPDATE "store_combination" SET product_id = 1, image = 'https://via.placeholder.com/300',
        price = 89.90, ot_price = 99.90, people = 2, quota = 100, quota_show = 100, stock = 100, status = 1, sort = 88
      WHERE store_name = '拼团商品-测试商品A'
    `);
    await container.db.execute(sql`
      INSERT INTO "store_combination" ("product_id", "store_name", "image", "price", "ot_price", "people", "quota", "quota_show", "stock", "sales", "status", "sort", "add_time")
      SELECT 1, '拼团商品-测试商品A', 'https://via.placeholder.com/300', 89.90, 99.90, 2, 100, 100, 100, 0, 1, 88, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM store_combination WHERE store_name = '拼团商品-测试商品A')
    `);

    // 秒杀时间段 + 秒杀商品 (幂等, M17 补)
    await container.db.execute(
      sql`DELETE FROM store_seckill_time WHERE id IN (1,2,3)`,
    );
    await container.db.execute(sql`
      INSERT INTO "store_seckill_time" ("id", "start_time", "end_time", "status", "add_time")
      VALUES (1, '00:00', '11:59', 1, ${now}), (2, '12:00', '17:59', 1, ${now}), (3, '18:00', '23:59', 1, ${now})
      ON CONFLICT DO NOTHING
    `);
    // 秒杀商品 upsert (M19: 不 DELETE, 保持活动 id 稳定)
    await container.db.execute(sql`
      UPDATE "store_seckill" SET product_id = 1, time_id = '1,2,3', image = 'https://via.placeholder.com/300',
        price = 49.90, ot_price = 99.90, num = 2, quota = 100, quota_show = 100, stock = 100, status = 1, sort = 92
      WHERE store_name = '秒杀商品-测试商品A'
    `);
    await container.db.execute(sql`
      INSERT INTO "store_seckill" ("product_id", "time_id", "store_name", "image", "price", "ot_price", "num", "quota", "quota_show", "stock", "sales", "status", "sort", "add_time")
      SELECT 1, '1,2,3', '秒杀商品-测试商品A', 'https://via.placeholder.com/300', 49.90, 99.90, 2, 100, 100, 100, 0, 1, 92, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM store_seckill WHERE store_name = '秒杀商品-测试商品A')
    `);

    // 积分商品 upsert (M19: 保持活动 id 稳定)
    await container.db.execute(sql`
      UPDATE "store_integral" SET product_id = 1, image = 'https://via.placeholder.com/300',
        integral = 300, price = 0.00, ot_price = 39.90, quota = 100, quota_show = 100, stock = 100, num = 1, status = 1, sort = 90
      WHERE store_name = '积分商品-保温杯'
    `);
    await container.db.execute(sql`
      INSERT INTO "store_integral" ("product_id", "store_name", "image", "integral", "price", "ot_price", "quota", "quota_show", "stock", "sales", "num", "status", "sort", "add_time")
      SELECT 1, '积分商品-保温杯', 'https://via.placeholder.com/300', 300, 0.00, 39.90, 100, 100, 100, 0, 1, 1, 90, ${now}
      WHERE NOT EXISTS (SELECT 1 FROM store_integral WHERE store_name = '积分商品-保温杯')
    `);

    // 秒杀诊断: 返回表中实际行数
    const seckillDiag: Record<string, unknown> = {};
    try {
      const t = await container.db.execute(sql`SELECT COUNT(*)::int AS c FROM store_seckill_time`);
      const s = await container.db.execute(sql`SELECT COUNT(*)::int AS c FROM store_seckill`);
      const arr = (x: unknown) => (Array.isArray(x) ? x : (x as { rows?: unknown[] })?.rows ?? []);
      seckillDiag.timeCount = (arr(t)[0] as { c?: number })?.c ?? -1;
      seckillDiag.seckillCount = (arr(s)[0] as { c?: number })?.c ?? -1;
    } catch (e) {
      seckillDiag.error = e instanceof Error ? e.message.slice(0, 120) : String(e);
    }
    return c.json({ ok: true, message: "种子数据插入成功", seckillDiag });

    // 注: admin 密码在迁移中用 bcrypt hash, 这里更新为正确值
    void container;
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// 更新 admin 密码 (开发调试用)
v1Routes.get("/_fix_admin", async (c) => {
  const blocked = debugGuard(c);
  if (blocked) return blocked;
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  try {
    // bcrypt hash for "crmeb.com" (bcryptjs 生成的 $2b$ hash)
    const hash = "$2b$10$QZbQLAnjcmYKOzLI0fQP/.uqTIAiEuLUZWXvSY5XkX0jTsz37IbAW";
    await container.db.execute(sql`
      UPDATE "system_admin" SET "pwd" = ${hash} WHERE "account" = 'admin'
    `);
    return c.json({ ok: true, message: "admin 密码已更新为 crmeb.com" });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// ─── 微信生态 (M6) ─────────────────────────────────────────────
// 小程序登录 (无需 auth)
v1Routes.post("/wechat/mp_auth", WechatController.mpAuth);
// 公众号 OAuth (无需 auth)
v1Routes.get("/wechat/auth", WechatController.wechatAuth);
// JS-SDK 配置 (无需 auth)
v1Routes.get("/wechat/config", WechatController.wechatConfig);
// 小程序手机号绑定 (需 auth)
v1Routes.post("/wechat/auth_binding_phone", authMiddleware({ force: true }), WechatController.authBindingPhone);

// ─── 后续里程碑接入 ───────────────────────────────────────────
// M7+ 完整 admin CRUD (商品管理/订单管理/用户管理/系统配置等)

// ─── 管理后台 (M7 核心: 登录 + Dashboard + WebSocket 客服) ────
// 管理员登录 (无需 auth)
v1Routes.post("/admin/login", AdminController.adminLogin);
const adminAuth = adminAuthMiddleware();
// Dashboard + 通知 (需 admin token)
v1Routes.get("/admin/home/header", adminAuth, AdminController.adminDashboard);
v1Routes.get("/admin/new_push", adminAuth, AdminController.adminNewPush);
// 客服聊天记录 (需 admin token)
v1Routes.get("/admin/service/chat", adminAuth, AdminController.chatHistory);
v1Routes.post("/admin/service/send", adminAuth, AdminController.serviceReply);
v1Routes.get("/admin/service/sessions", adminAuth, AdminController.chatSessions);

// ─── Admin CRUD (M7+, 全部需 admin token) ────────────────────

// 商品管理
v1Routes.get("/admin/product/list", adminAuth, AdminCrud.adminProductList);
v1Routes.get("/admin/product/detail/:id", adminAuth, AdminCrud.adminProductDetail);
v1Routes.post("/admin/product/create", adminAuth, AdminCrud.adminProductCreate);
v1Routes.post("/admin/product/update/:id", adminAuth, AdminCrud.adminProductUpdate);
v1Routes.post("/admin/product/set_show/:id", adminAuth, AdminCrud.adminProductSetShow);
v1Routes.delete("/admin/product/del/:id", adminAuth, AdminCrud.adminProductDel);

// 订单管理
v1Routes.get("/admin/order/list", adminAuth, AdminCrud.adminOrderList);
v1Routes.get("/admin/order/detail/:orderId", adminAuth, AdminCrud.adminOrderDetail);
v1Routes.post("/admin/order/remark/:orderId", adminAuth, AdminCrud.adminOrderRemark);
v1Routes.post("/admin/order/delivery/:orderId", adminAuth, AdminCrud.adminOrderDelivery);

// 用户管理
v1Routes.get("/admin/user/list", adminAuth, AdminCrud.adminUserList);
v1Routes.get("/admin/user/info/:id", adminAuth, AdminCrud.adminUserInfo);
v1Routes.post("/admin/user/update/:id", adminAuth, AdminCrud.adminUserUpdate);
v1Routes.post("/admin/user/money/:id", adminAuth, AdminCrud.adminUserMoney);

// 退款审核
v1Routes.get("/admin/refund/list", adminAuth, AdminCrud.adminRefundList);
v1Routes.get("/admin/refund/detail/:id", adminAuth, AdminCrud.adminRefundDetail);
v1Routes.post("/admin/refund/agree/:id", adminAuth, AdminCrud.adminRefundAgree);
v1Routes.post("/admin/refund/refuse/:id", adminAuth, AdminCrud.adminRefundRefuse);

// 系统配置
v1Routes.get("/admin/config/list", adminAuth, AdminCrud.adminConfigList);
v1Routes.post("/admin/config/save", adminAuth, AdminCrud.adminConfigSave);
v1Routes.get("/admin/config/:menuName", adminAuth, AdminCrud.adminConfigGet);

// ─── Admin 分类管理 (M9) ─────────────────────────────────────
v1Routes.get("/admin/category/list", adminAuth, AdminCrud.adminCategoryList);
v1Routes.post("/admin/category/save", adminAuth, AdminCrud.adminCategorySave);
v1Routes.delete("/admin/category/del/:id", adminAuth, AdminCrud.adminCategoryDel);

// ─── Admin 优惠券管理 (M9) ───────────────────────────────────
v1Routes.get("/admin/coupon/list", adminAuth, AdminCrud.adminCouponList);
v1Routes.post("/admin/coupon/save", adminAuth, AdminCrud.adminCouponSave);
v1Routes.post("/admin/coupon/status/:id", adminAuth, AdminCrud.adminCouponStatus);
v1Routes.delete("/admin/coupon/del/:id", adminAuth, AdminCrud.adminCouponDel);

// ─── Admin 数据统计 (M9) ─────────────────────────────────────
v1Routes.get("/admin/statistic/overview", adminAuth, AdminCrud.adminStatisticOverview);

// ─── Admin 营销活动管理 (M10) ─────────────────────────────────
v1Routes.get("/admin/activity/seckill", adminAuth, AdminCrud.adminSeckillList);
v1Routes.get("/admin/activity/combination", adminAuth, AdminCrud.adminCombinationList);
v1Routes.get("/admin/activity/bargain", adminAuth, AdminCrud.adminBargainList);
v1Routes.get("/admin/activity/integral", adminAuth, AdminCrud.adminIntegralList);
v1Routes.post("/admin/activity/status", adminAuth, AdminCrud.adminActivityStatus);

// ─── Admin 商品评价管理 (M11) ─────────────────────────────────
v1Routes.get("/admin/reply/list", adminAuth, AdminCrud.adminReplyList);
v1Routes.post("/admin/reply/status/:id", adminAuth, AdminCrud.adminReplyStatus);
v1Routes.delete("/admin/reply/del/:id", adminAuth, AdminCrud.adminReplyDel);

// ─── Admin 品牌管理 (M15) ────────────────────────────────────
v1Routes.get("/admin/brand/list", adminAuth, AdminCrud.adminBrandList);
v1Routes.post("/admin/brand/save", adminAuth, AdminCrud.adminBrandSave);
v1Routes.delete("/admin/brand/del/:id", adminAuth, AdminCrud.adminBrandDel);

// ─── Admin 系统管理员/角色 (M16) ─────────────────────────────
v1Routes.get("/admin/system_admin/list", adminAuth, AdminCrud.adminSystemAdminList);
v1Routes.post("/admin/system_admin/save", adminAuth, AdminCrud.adminSystemAdminSave);
v1Routes.get("/admin/system_role/list", adminAuth, AdminCrud.adminSystemRoleList);
v1Routes.post("/admin/system_role/save", adminAuth, AdminCrud.adminSystemRoleSave);
v1Routes.delete("/admin/system_role/del/:id", adminAuth, AdminCrud.adminSystemRoleDel);
// 提现审核 (M17)
v1Routes.get("/admin/extract/list", adminAuth, AdminCrud.adminExtractList);
v1Routes.post("/admin/extract/status/:id", adminAuth, AdminCrud.adminExtractStatus);

// ─── Admin 营销详情 (M12) ─────────────────────────────────────
v1Routes.get("/admin/activity/pink/:combinationId", adminAuth, AdminCrud.adminPinkList);

// ─── Admin 营销细分 (M13) ─────────────────────────────────────
v1Routes.get("/admin/activity/bargain_users/:bargainId", adminAuth, AdminCrud.adminBargainUsers);
v1Routes.get("/admin/activity/seckill_times", adminAuth, AdminCrud.adminSeckillTimes);

// ─── 用户积分明细 (M13) ───────────────────────────────────────
v1Routes.get("/user/integral_logs", authMiddleware({ force: true }), UserFinanceController.integralLogs);
v1Routes.get("/user/balance", authMiddleware({ force: true }), UserFinanceController.balanceLogs);

// ─── WebSocket 客服 (M7) ───────────────────────────────────────
// 无需 auth (WebSocket 在 DO 内校验 token)
v1Routes.get("/ws/kefu", AdminController.wsUpgrade);
v1Routes.post("/internal/chat_save", AdminController.chatSave);

// 财务流水 (M18)
v1Routes.get("/admin/bill/list", adminAuth, AdminCrud.adminBillList);
// 会员等级 (M18)
v1Routes.get("/admin/level/list", adminAuth, AdminCrud.adminLevelList);
v1Routes.post("/admin/level/save", adminAuth, AdminCrud.adminLevelSave);
v1Routes.delete("/admin/level/del/:id", adminAuth, AdminCrud.adminLevelDel);

// 运费模板 + 快递公司 (M19)
v1Routes.get("/admin/shipping_template/list", adminAuth, AdminCrud.adminShippingTemplateList);
v1Routes.post("/admin/shipping_template/save", adminAuth, AdminCrud.adminShippingTemplateSave);
v1Routes.delete("/admin/shipping_template/del/:id", adminAuth, AdminCrud.adminShippingTemplateDel);
v1Routes.get("/admin/express/list", adminAuth, AdminCrud.adminExpressList);
v1Routes.post("/admin/express/save", adminAuth, AdminCrud.adminExpressSave);
v1Routes.delete("/admin/express/del/:id", adminAuth, AdminCrud.adminExpressDel);


// 营销活动创建/编辑/删除 (M20)
v1Routes.post("/admin/activity/save", adminAuth, AdminCrud.adminActivitySave);
v1Routes.delete("/admin/activity/del/:type/:id", adminAuth, AdminCrud.adminActivityDel);

// 统计趋势 + 标签 (M21)
v1Routes.get("/admin/statistic/trend", adminAuth, AdminCrud.adminStatisticTrend);
v1Routes.get("/admin/statistic/rank", adminAuth, AdminCrud.adminStatisticRank);
v1Routes.get("/admin/product_label/list", adminAuth, AdminCrud.adminProductLabelList);
v1Routes.post("/admin/product_label/save", adminAuth, AdminCrud.adminProductLabelSave);
v1Routes.delete("/admin/product_label/del/:id", adminAuth, AdminCrud.adminProductLabelDel);
v1Routes.get("/admin/user_label/list", adminAuth, AdminCrud.adminUserLabelList);
v1Routes.post("/admin/user_label/save", adminAuth, AdminCrud.adminUserLabelSave);
v1Routes.delete("/admin/user_label/del/:id", adminAuth, AdminCrud.adminUserLabelDel);

// DIY + CMS + 系统工具 (M22)
v1Routes.get("/admin/dise/list", adminAuth, AdminCrud.adminDiseList);
v1Routes.post("/admin/dise/save", adminAuth, AdminCrud.adminDiseSave);
v1Routes.delete("/admin/dise/del/:id", adminAuth, AdminCrud.adminDiseDel);
v1Routes.get("/admin/article/list", adminAuth, AdminCrud.adminArticleList);
v1Routes.post("/admin/article/save", adminAuth, AdminCrud.adminArticleSave);
v1Routes.delete("/admin/article/del/:id", adminAuth, AdminCrud.adminArticleDel);
v1Routes.get("/admin/log/list", adminAuth, AdminCrud.adminLogList);

// 分销管理 + 通知模板 + 短信配置 (M24)
v1Routes.get("/admin/spread/list", adminAuth, AdminCrud.adminSpreadList);
v1Routes.get("/admin/brokerage/list", adminAuth, AdminCrud.adminBrokerageList);
v1Routes.get("/admin/notification/list", adminAuth, AdminCrud.adminNotificationList);
v1Routes.post("/admin/notification/save", adminAuth, AdminCrud.adminNotificationSave);
v1Routes.get("/admin/sms/config", adminAuth, AdminCrud.adminSmsConfig);
v1Routes.post("/admin/sms/config", adminAuth, AdminCrud.adminSmsConfigSave);
