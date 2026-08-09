/**
 * Admin 管理接口控制器 (M7+)
 *
 * 对应 PHP app/controller/admin/v1/ 下的:
 *   - product/StoreProduct.php (商品管理)
 *   - order/StoreOrder.php (订单管理)
 *   - user/User.php (用户管理)
 *   - system/config/SystemConfig.php (系统配置)
 *
 * 所有接口需要 admin token (adminAuthMiddleware)
 */
import type { Context } from "hono";
import { jsonOk, jsonFail } from "@/utils/json";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

// ═══════════════════════════════════════════════════════════
// 商品管理
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/product/list — 商品列表 */
export async function adminProductList(c: C) {
  const q = c.req.query();
  const page = Number(q.page ?? 1);
  const limit = Number(q.limit ?? 10);
  const container = c.get("container");

  const where: Record<string, unknown> = {};
  if (q.store_name) where.store_name = q.store_name;
  if (q.status) where.status = Number(q.status);
  if (q.cate_id) where.cateId = q.cate_id;

  // admin 可看所有状态 (不像前台只看上架)
  const list = await container.storeProductDao.getSearchList({
    where: { ...where, isDel: 0 },
    page,
    limit,
  });

  return jsonOk(c, { list, page, limit });
}

/** GET /api/admin/product/detail/:id — 商品详情 */
export async function adminProductDetail(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  if (!id) return jsonFail(c, "参数错误");
  const product = await c.get("container").storeProductDao.getById(id);
  if (!product) return jsonFail(c, "商品不存在");
  return jsonOk(c, product);
}

/** POST /api/admin/product/create — 创建商品 */
export async function adminProductCreate(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!body.store_name) return jsonFail(c, "商品名称不能为空");
  if (!body.price) return jsonFail(c, "价格不能为空");

  const container = c.get("container");
  const row = await container.storeProductDao.save({
    storeName: String(body.store_name),
    storeInfo: String(body.store_info ?? ""),
    image: String(body.image ?? ""),
    price: String(body.price),
    otPrice: String(body.ot_price ?? body.price),
    stock: Number(body.stock ?? 0),
    cateId: String(body.cate_id ?? ""),
    keyword: String(body.keyword ?? ""),
    isShow: Number(body.is_show ?? 1),
    isVerify: 1,
    isDel: 0,
    specType: Number(body.spec_type ?? 0),
    addTime: Math.floor(Date.now() / 1000),
    unitName: String(body.unit_name ?? "件"),
    ficti: Number(body.ficti ?? 0),
  });
  return jsonOk(c, { id: row.id }, "创建成功");
}

/** POST /api/admin/product/update/:id — 编辑商品 */
export async function adminProductUpdate(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  if (!id) return jsonFail(c, "参数错误");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const container = c.get("container");

  const product = await container.storeProductDao.getById(id);
  if (!product) return jsonFail(c, "商品不存在");

  const updateData: Record<string, unknown> = {};
  const fields = [
    "storeName", "storeInfo", "image", "price", "otPrice", "stock",
    "cateId", "keyword", "isShow", "unitName", "ficti", "sort",
  ];
  for (const f of fields) {
    if (body[f] !== undefined) updateData[f] = body[f];
  }
  if (Object.keys(updateData).length > 0) {
    await container.storeProductDao.update(id, updateData);
  }
  return jsonOk(c, null, "修改成功");
}

/** POST /api/admin/product/set_show/:id — 上架/下架 */
export async function adminProductSetShow(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const body = (await c.req.json().catch(() => ({}))) as { is_show?: number };
  if (!id) return jsonFail(c, "参数错误");
  await c.get("container").storeProductDao.update(id, {
    isShow: body.is_show ?? 1,
  });
  return jsonOk(c, null, body.is_show ? "已上架" : "已下架");
}

/** DELETE /api/admin/product/del/:id — 删除商品 (软删除) */
export async function adminProductDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  if (!id) return jsonFail(c, "参数错误");
  await c.get("container").storeProductDao.update(id, { isDel: 1 });
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// 订单管理
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/order/list — 订单列表 */
export async function adminOrderList(c: C) {
  const q = c.req.query();
  const page = Number(q.page ?? 1);
  const limit = Number(q.limit ?? 10);
  const container = c.get("container");

  const where: Record<string, unknown> = { isDel: 0 };
  if (q.status !== undefined) where.status = Number(q.status);
  if (q.paid !== undefined) where.paid = Number(q.paid);
  if (q.uid) where.uid = Number(q.uid);
  if (q.order_id) where.orderId = q.order_id;

  const list = await container.storeOrderDao.selectList({ where, page, limit });
  return jsonOk(c, { list, page, limit });
}

/** GET /api/admin/order/detail/:orderId — 订单详情 */
export async function adminOrderDetail(c: C) {
  const orderId = c.req.param("orderId") ?? "";
  const container = c.get("container");
  const order = await container.storeOrderDao.findByOrderId(orderId);
  if (!order) return jsonFail(c, "订单不存在");
  const cartInfos = await container.storeOrderCartInfoDao.getByOid(order.id);
  return jsonOk(c, {
    ...order,
    cartInfo: cartInfos.map((ci) => ({
      ...ci,
      cartInfo: ci.cartInfo ? JSON.parse(ci.cartInfo) : null,
    })),
  });
}

/** POST /api/admin/order/remark/:orderId — 订单备注 */
export async function adminOrderRemark(c: C) {
  const orderId = c.req.param("orderId") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as { remark?: string };
  const container = c.get("container");
  const order = await container.storeOrderDao.findByOrderId(orderId);
  if (!order) return jsonFail(c, "订单不存在");
  await container.storeOrderDao.update(order.id, { remark: body.remark ?? "" });
  await container.storeOrderStatusDao.log(order.id, "remark", `管理员备注: ${body.remark ?? ""}`);
  return jsonOk(c, null, "备注成功");
}

/** POST /api/admin/order/delivery/:orderId — 发货 */
export async function adminOrderDelivery(c: C) {
  const orderId = c.req.param("orderId") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as {
    delivery_type?: string;
    delivery_name?: string;
    delivery_id?: string;
  };
  const container = c.get("container");
  const order = await container.storeOrderDao.findByOrderId(orderId);
  if (!order) return jsonFail(c, "订单不存在");
  if (!order.paid) return jsonFail(c, "订单未支付");
  if (order.status !== 0) return jsonFail(c, "订单状态不允许发货");

  await container.storeOrderDao.update(order.id, { status: 1 });
  await container.storeOrderStatusDao.log(
    order.id,
    "delivery_goods",
    `已发货: ${body.delivery_name ?? ""} ${body.delivery_id ?? ""}`,
  );
  return jsonOk(c, null, "发货成功");
}

// ═══════════════════════════════════════════════════════════
// 用户管理
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/user/list — 用户列表 */
export async function adminUserList(c: C) {
  const q = c.req.query();
  const page = Number(q.page ?? 1);
  const limit = Number(q.limit ?? 10);
  const container = c.get("container");

  const where: Record<string, unknown> = { isDel: 0 };
  if (q.uid) where.uid = Number(q.uid);
  if (q.phone) where.phone = q.phone;

  const list = await container.userDao.selectList({ where, page, limit });
  return jsonOk(c, { list, page, limit });
}

/** GET /api/admin/user/info/:id — 用户详情 */
export async function adminUserInfo(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const user = await c.get("container").userDao.get(id);
  if (!user) return jsonFail(c, "用户不存在");
  // 隐藏敏感字段
  const { pwd: _pwd, ...safeUser } = user;
  void _pwd;
  return jsonOk(c, safeUser);
}

/** POST /api/admin/user/update/:id — 编辑用户 */
export async function adminUserUpdate(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const container = c.get("container");
  const user = await container.userDao.get(id);
  if (!user) return jsonFail(c, "用户不存在");

  const updateData: Record<string, unknown> = {};
  if (body.nickname !== undefined) updateData.nickname = body.nickname;
  if (body.phone !== undefined) updateData.phone = body.phone;
  if (body.status !== undefined) updateData.status = body.status;
  if (body.level !== undefined) updateData.level = body.level;
  if (Object.keys(updateData).length > 0) {
    await container.userDao.update(id, updateData);
  }
  return jsonOk(c, null, "修改成功");
}

/** POST /api/admin/user/money/:id — 修改用户余额 */
export async function adminUserMoney(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const body = (await c.req.json().catch(() => ({}))) as {
    money?: string;
    type?: "add" | "sub";
  };
  if (body.money === undefined) return jsonFail(c, "金额不能为空");

  const container = c.get("container");
  const user = await container.userDao.get(id);
  if (!user) return jsonFail(c, "用户不存在");

  const amount = Number(body.money);
  const newMoney = body.type === "sub"
    ? Math.max(0, Number(user.nowMoney) - amount)
    : Number(user.nowMoney) + amount;

  await container.userDao.update(id, { nowMoney: newMoney.toFixed(2) });
  return jsonOk(c, { balance: newMoney.toFixed(2) }, "修改成功");
}

// ═══════════════════════════════════════════════════════════
// 系统配置
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/config/list — 配置列表 (按 tab 分组) */
export async function adminConfigList(c: C) {
  const container = c.get("container");
  const list = await container.systemConfigDao.selectList({
    where: { isStore: 0 },
  });
  return jsonOk(c, list);
}

/** POST /api/admin/config/save — 保存配置 (批量) */
export async function adminConfigSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, string>;
  const container = c.get("container");
  const configSvc = new (await import("@/services/system/SystemConfigService")).SystemConfigService(
    container,
    c.env,
  );

  for (const [key, value] of Object.entries(body)) {
    // 更新 DB
    const existing = await container.systemConfigDao.getOne({ menuName: key });
    if (existing) {
      await container.systemConfigDao.update(existing.id, { value });
    } else {
      await container.systemConfigDao.save({
        menuName: key,
        value,
        info: key,
        isStore: 0,
        type: "text",
        inputType: "input",
      });
    }
    // 失效 KV 缓存
    await configSvc.invalidate(key);
  }
  return jsonOk(c, null, "保存成功");
}

// ═══════════════════════════════════════════════════════════
// 退款审核
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/refund/list — 退款申请列表 */
export async function adminRefundList(c: C) {
  const container = c.get("container");
  const list = await container.storeOrderRefundDao.selectList({
    where: { isDel: 0 },
  });
  return jsonOk(c, list);
}

/** GET /api/admin/refund/detail/:id — 退款申请详情 */
export async function adminRefundDetail(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  if (!id) return jsonFail(c, "参数错误");
  const refund = await c.get("container").storeOrderRefundDao.get(id);
  if (!refund) return jsonFail(c, "退款记录不存在");
  return jsonOk(c, {
    ...refund,
    cartInfo: refund.cartInfo ? JSON.parse(refund.cartInfo) : null,
  });
}

/** POST /api/admin/refund/agree/:id — 同意退款 */
export async function adminRefundAgree(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  if (!id) return jsonFail(c, "参数错误");
  const { StoreOrderRefundService } = await import("@/services/order/StoreOrderRefundService");
  const svc = new StoreOrderRefundService(c.get("container"));
  try {
    await svc.agreeRefund(id);
    return jsonOk(c, null, "退款成功");
  } catch (e) {
    if (e instanceof Error) return jsonFail(c, e.message);
    throw e;
  }
}

/** POST /api/admin/refund/refuse/:id — 拒绝退款 */
export async function adminRefundRefuse(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  if (!id) return jsonFail(c, "参数错误");
  const body = (await c.req.json().catch(() => ({}))) as { refuse_reason?: string };
  const { StoreOrderRefundService } = await import("@/services/order/StoreOrderRefundService");
  const svc = new StoreOrderRefundService(c.get("container"));
  try {
    await svc.refuseRefund(id, body.refuse_reason ?? "不满足退款条件");
    return jsonOk(c, null, "已拒绝退款");
  } catch (e) {
    if (e instanceof Error) return jsonFail(c, e.message);
    throw e;
  }
}

/** GET /api/admin/config/:menuName — 取单个配置 */
export async function adminConfigGet(c: C) {
  const menuName = c.req.param("menuName") ?? "";
  const configSvc = new (await import("@/services/system/SystemConfigService")).SystemConfigService(
    c.get("container"),
    c.env,
  );
  const value = await configSvc.get(menuName);
  return jsonOk(c, { menuName, value });
}

// ═══════════════════════════════════════════════════════════
// 商品分类管理
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/category/list — 分类列表 (树形) */
export async function adminCategoryList(c: C) {
  const container = c.get("container");
  const list = await container.storeProductCategoryDao.getTierList({});
  return jsonOk(c, list);
}

/** POST /api/admin/category/save — 新增/编辑分类 */
export async function adminCategorySave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    pid?: number;
    cate_name?: string;
    pic?: string;
    sort?: number;
    is_show?: number;
  };
  const container = c.get("container");
  if (body.id) {
    await container.storeProductCategoryDao.update(body.id, {
      pid: body.pid ?? 0,
      cateName: body.cate_name ?? "",
      pic: body.pic ?? "",
      sort: body.sort ?? 0,
      isShow: body.is_show ?? 1,
    });
    return jsonOk(c, { id: body.id }, "更新成功");
  }
  const row = await container.storeProductCategoryDao.save({
    pid: body.pid ?? 0,
    cateName: body.cate_name ?? "",
    pic: body.pic ?? "",
    sort: body.sort ?? 0,
    isShow: body.is_show ?? 1,
  });
  return jsonOk(c, { id: row.id }, "创建成功");
}

/** DELETE /api/admin/category/del/:id — 删除分类 */
export async function adminCategoryDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  await container.storeProductCategoryDao.delete(id);
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// 优惠券管理
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/coupon/list — 优惠券列表 */
export async function adminCouponList(c: C) {
  const q = c.req.query();
  const page = Number(q.page ?? 1);
  const limit = Number(q.limit ?? 10);
  const container = c.get("container");
  const list = await container.storeCouponIssueDao.selectList({
    where: {},
    page,
    limit,
  });
  return jsonOk(c, list);
}

/** POST /api/admin/coupon/save — 新增/编辑优惠券 */
export async function adminCouponSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    title?: string;
    coupon_price?: string;
    use_min_price?: string;
    day?: number;
    status?: number;
    sort?: number;
  };
  const container = c.get("container");
  if (body.id) {
    await container.storeCouponIssueDao.update(body.id, {
      couponTitle: body.title,
      couponPrice: body.coupon_price,
      useMinPrice: body.use_min_price,
      day: body.day,
      status: body.status,
    });
    return jsonOk(c, { id: body.id }, "更新成功");
  }
  const row = await container.storeCouponIssueDao.save({
    couponType: 1,
    couponTitle: body.title ?? "优惠券",
    type: 1,
    couponPrice: body.coupon_price ?? "0",
    useMinPrice: body.use_min_price ?? "0",
    productId: "0",
    category_id: "0",
    brandId: "0",
    totalCount: 0,
    remainCount: 0,
    receiveLimit: 1,
    receiveType: 0,
    day: body.day ?? 7,
    status: body.status ?? 0,
    sort: body.sort ?? 0,
    addTime: Math.floor(Date.now() / 1000),
  });
  return jsonOk(c, { id: row.id }, "创建成功");
}

/** POST /api/admin/coupon/status/:id — 上架/下架 */
export async function adminCouponStatus(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const body = (await c.req.json().catch(() => ({}))) as { status?: number };
  const container = c.get("container");
  await container.storeCouponIssueDao.update(id, { status: body.status ?? 0 });
  return jsonOk(c, null, "操作成功");
}

/** DELETE /api/admin/coupon/del/:id — 删除优惠券 */
export async function adminCouponDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  await container.storeCouponIssueDao.delete(id);
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// 数据统计
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/statistic/overview — 统计概览 */
export async function adminStatisticOverview(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { storeOrder, storeProduct, user, storeOrderRefund } = await import("@/models/schema");

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStart = Math.floor(today.getTime() / 1000);
  const yesterdayStart = todayStart - 86400;

  // 今日订单数 + 销售额
  const orderStats = await container.db
    .select({
      todayCount: sql<number>`COUNT(*) FILTER (WHERE ${storeOrder.payTime} >= ${todayStart} AND ${storeOrder.paid} = 1)::int`,
      todaySales: sql<string>`COALESCE(SUM(${storeOrder.payPrice}) FILTER (WHERE ${storeOrder.payTime} >= ${todayStart} AND ${storeOrder.paid} = 1), 0)::numeric(12,2)`,
      totalCount: sql<number>`COUNT(*) FILTER (WHERE ${storeOrder.paid} = 1)::int`,
      totalSales: sql<string>`COALESCE(SUM(${storeOrder.payPrice}) FILTER (WHERE ${storeOrder.paid} = 1), 0)::numeric(12,2)`,
    })
    .from(storeOrder);

  // 昨日销售
  const yesterdayStats = await container.db
    .select({
      sales: sql<string>`COALESCE(SUM(${storeOrder.payPrice}) FILTER (WHERE ${storeOrder.payTime} >= ${yesterdayStart} AND ${storeOrder.payTime} < ${todayStart} AND ${storeOrder.paid} = 1), 0)::numeric(12,2)`,
      count: sql<number>`COUNT(*) FILTER (WHERE ${storeOrder.payTime} >= ${yesterdayStart} AND ${storeOrder.payTime} < ${todayStart} AND ${storeOrder.paid} = 1)::int`,
    })
    .from(storeOrder);

  // 商品数 + 用户数
  const productCount = await container.db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(storeProduct)
    .then((r) => r[0]?.c ?? 0);

  const userCount = await container.db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(user)
    .then((r) => r[0]?.c ?? 0);

  const refundCount = await container.db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(storeOrderRefund)
    .then((r) => r[0]?.c ?? 0);

  return jsonOk(c, {
    today: {
      orderCount: Number(orderStats[0]?.todayCount ?? 0),
      sales: String(orderStats[0]?.todaySales ?? "0"),
    },
    yesterday: {
      orderCount: Number(yesterdayStats[0]?.count ?? 0),
      sales: String(yesterdayStats[0]?.sales ?? "0"),
    },
    total: {
      orderCount: Number(orderStats[0]?.totalCount ?? 0),
      sales: String(orderStats[0]?.totalSales ?? "0"),
      productCount,
      userCount,
      refundCount,
    },
  });
}

// ═══════════════════════════════════════════════════════════
// 营销活动管理 (M10)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/activity/seckill — 秒杀活动列表 */
export async function adminSeckillList(c: C) {
  const container = c.get("container");
  const list = await container.storeSeckillDao.selectList({ where: {}, limit: 100 });
  return jsonOk(c, list);
}

/** GET /api/admin/activity/combination — 拼团活动列表 */
export async function adminCombinationList(c: C) {
  const container = c.get("container");
  const list = await container.storeCombinationDao.selectList({ where: {}, limit: 100 });
  return jsonOk(c, list);
}

/** GET /api/admin/activity/bargain — 砍价活动列表 */
export async function adminBargainList(c: C) {
  const container = c.get("container");
  const list = await container.storeBargainDao.selectList({ where: {}, limit: 100 });
  return jsonOk(c, list);
}

/** GET /api/admin/activity/integral — 积分商品列表 */
export async function adminIntegralList(c: C) {
  const container = c.get("container");
  const list = await container.storeIntegralDao.selectList({ where: {}, limit: 100 });
  return jsonOk(c, list);
}

/** POST /api/admin/activity/status — 活动上下架 (通用) */
export async function adminActivityStatus(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    type: string;
    id: number;
    status: number;
  };
  const container = c.get("container");
  const { type, id, status } = body;
  if (!type || !id) return jsonFail(c, "参数错误");

  switch (type) {
    case "seckill":
      await container.storeSeckillDao.update(id, { status });
      break;
    case "combination":
      await container.storeCombinationDao.update(id, { status });
      break;
    case "bargain":
      await container.storeBargainDao.update(id, { status });
      break;
    case "integral":
      await container.storeIntegralDao.update(id, { status });
      break;
    default:
      return jsonFail(c, "未知活动类型");
  }
  return jsonOk(c, null, "操作成功");
}

// ═══════════════════════════════════════════════════════════
// 商品评价管理 (M11)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/reply/list — 评价列表 */
export async function adminReplyList(c: C) {
  const q = c.req.query();
  const page = Number(q.page ?? 1);
  const limit = Number(q.limit ?? 10);
  const container = c.get("container");
  const list = await container.replyDao.selectList({ where: {}, page, limit });
  // 解析 pics JSON
  return jsonOk(
    c,
    list.map((item: any) => ({
      ...item,
      pics: (() => {
        try {
          const arr = JSON.parse(item.pics || "[]");
          return Array.isArray(arr) ? arr : [];
        } catch {
          return [];
        }
      })(),
    })),
  );
}

/** POST /api/admin/reply/status/:id — 评价隐藏/显示 */
export async function adminReplyStatus(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const body = (await c.req.json().catch(() => ({}))) as { status?: number };
  const container = c.get("container");
  await container.replyDao.update(id, { status: body.status ?? 0 });
  return jsonOk(c, null, "操作成功");
}

/** DELETE /api/admin/reply/del/:id — 删除评价 */
export async function adminReplyDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  await container.replyDao.update(id, { isDel: 1 });
  return jsonOk(c, null, "已删除");
}

// ═══════════════════════════════════════════════════════════
// 营销活动详情 (M12)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/activity/pink/:combinationId — 拼团团列表 */
export async function adminPinkList(c: C) {
  const combinationId = Number(c.req.param("combinationId") ?? "0");
  const container = c.get("container");
  const { sql, desc } = await import("drizzle-orm");
  const schema = await import("@/models/schema");
  const storePink = schema.storePink;
  const rows = await container.db
    .select({
      id: storePink.id,
      uid: storePink.uid,
      orderId: storePink.orderId,
      people: storePink.people,
      status: storePink.status,
      addTime: storePink.addTime,
    })
    .from(storePink)
    .where(sql`${storePink.combinationId} = ${combinationId}`)
    .orderBy(desc(storePink.addTime))
    .limit(50);
  return jsonOk(c, rows);
}

// ═══════════════════════════════════════════════════════════
// 营销细分管理 (M13)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/activity/bargain_users/:bargainId — 砍价参与记录 */
export async function adminBargainUsers(c: C) {
  const bargainId = Number(c.req.param("bargainId") ?? "0");
  const container = c.get("container");
  const schema = await import("@/models/schema");
  const { eq, desc } = await import("drizzle-orm");
  const rows = await container.db
    .select()
    .from(schema.storeBargainUser)
    .where(eq(schema.storeBargainUser.bargainId, bargainId))
    .orderBy(desc(schema.storeBargainUser.addTime))
    .limit(50);
  return jsonOk(c, rows);
}

/** GET /api/admin/activity/seckill_times — 秒杀时段列表 */
export async function adminSeckillTimes(c: C) {
  const container = c.get("container");
  const list = await container.storeSeckillTimeDao.selectList({ where: {}, limit: 50 });
  return jsonOk(c, list);
}

// ═══════════════════════════════════════════════════════════
// 品牌管理 (M15)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/brand/list — 品牌列表 */
export async function adminBrandList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { storeBrand } = await import("@/models/schema");
  const rows = await container.db
    .select()
    .from(storeBrand)
    .where(sql`${storeBrand.isDel} = 0`)
    .orderBy(sql`${storeBrand.sort} DESC, ${storeBrand.id} DESC`)
    .limit(100);
  return jsonOk(c, rows);
}

/** POST /api/admin/brand/save — 新增/编辑品牌 */
export async function adminBrandSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    brand_name?: string;
    sort?: number;
    is_show?: number;
  };
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { storeBrand } = await import("@/models/schema");
  if (body.id) {
    await container.db
      .update(storeBrand)
      .set({ brandName: body.brand_name ?? "", sort: body.sort ?? 0, isShow: body.is_show ?? 1 })
      .where(eq(storeBrand.id, body.id));
    return jsonOk(c, { id: body.id }, "更新成功");
  }
  const now = Math.floor(Date.now() / 1000);
  const row = await container.db
    .insert(storeBrand)
    .values({
      brandName: body.brand_name ?? "新品牌",
      pid: 0,
      fid: "",
      storeId: 0,
      sort: body.sort ?? 0,
      isShow: body.is_show ?? 1,
      addTime: now,
      isDel: 0,
    })
    .returning({ id: storeBrand.id });
  return jsonOk(c, { id: row[0].id }, "创建成功");
}

/** DELETE /api/admin/brand/del/:id — 删除品牌 */
export async function adminBrandDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { storeBrand } = await import("@/models/schema");
  await container.db.update(storeBrand).set({ isDel: 1 }).where(eq(storeBrand.id, id));
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// 系统管理员/角色管理 (M16)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/system_admin/list — 管理员列表 */
export async function adminSystemAdminList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { systemAdmin } = await import("@/models/schema");
  const rows = await container.db
    .select({
      id: systemAdmin.id,
      account: systemAdmin.account,
      realName: systemAdmin.realName,
      phone: systemAdmin.phone,
      roles: systemAdmin.roles,
      level: systemAdmin.level,
      status: systemAdmin.status,
      lastTime: systemAdmin.lastTime,
    })
    .from(systemAdmin)
    .where(sql`${systemAdmin.status} >= 0`)
    .orderBy(sql`${systemAdmin.id} DESC`)
    .limit(100);
  return jsonOk(c, rows);
}

/** POST /api/admin/system_admin/save — 新增/编辑管理员 */
export async function adminSystemAdminSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    account?: string;
    real_name?: string;
    phone?: string;
    pwd?: string;
    roles?: string;
    level?: number;
    status?: number;
  };
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { systemAdmin } = await import("@/models/schema");
  // 管理员密码与登录一致用 bcrypt (AdminAuthService.login 用 bcrypt 校验)
  const bcrypt = (await import("bcryptjs")).default;
  const hashPwd = (pwd: string) => bcrypt.hashSync(pwd, 10);

  if (body.id) {
    const updates: Record<string, unknown> = {};
    if (body.real_name !== undefined) updates.realName = body.real_name;
    if (body.phone !== undefined) updates.phone = body.phone;
    if (body.roles !== undefined) updates.roles = body.roles;
    if (body.level !== undefined) updates.level = body.level;
    if (body.status !== undefined) updates.status = body.status;
    if (body.pwd) updates.pwd = hashPwd(body.pwd);
    await container.db.update(systemAdmin).set(updates).where(eq(systemAdmin.id, body.id));
    return jsonOk(c, { id: body.id }, "更新成功");
  }

  if (!body.account) return jsonFail(c, "账号不能为空");
  const now = Math.floor(Date.now() / 1000);
  const row = await container.db
    .insert(systemAdmin)
    .values({
      account: body.account,
      pwd: hashPwd(body.pwd || "123456"),
      realName: body.real_name ?? "",
      phone: body.phone ?? "",
      roles: body.roles ?? "",
      level: body.level ?? 0,
      status: body.status ?? 1,
      adminType: 1,
      relationId: 0,
      headPic: "",
      lastIp: "",
      lastTime: now,
    })
    .returning({ id: systemAdmin.id });
  return jsonOk(c, { id: row[0].id }, "创建成功");
}

/** GET /api/admin/system_role/list — 角色列表 */
export async function adminSystemRoleList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { systemRole } = await import("@/models/schema");
  const rows = await container.db
    .select()
    .from(systemRole)
    .where(sql`${systemRole.status} >= 0`)
    .orderBy(sql`${systemRole.id} DESC`)
    .limit(50);
  return jsonOk(c, rows);
}

/** POST /api/admin/system_role/save — 新增/编辑角色 */
export async function adminSystemRoleSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    role_name?: string;
    rules?: string;
    level?: number;
    status?: number;
  };
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { systemRole } = await import("@/models/schema");

  if (body.id) {
    await container.db
      .update(systemRole)
      .set({ roleName: body.role_name ?? "", rules: body.rules ?? "", level: body.level ?? 0, status: body.status ?? 1 })
      .where(eq(systemRole.id, body.id));
    return jsonOk(c, { id: body.id }, "更新成功");
  }

  const row = await container.db
    .insert(systemRole)
    .values({
      roleName: body.role_name ?? "新角色",
      rules: body.rules ?? "",
      level: body.level ?? 0,
      status: body.status ?? 1,
      type: 0,
      relationId: 0,
    })
    .returning({ id: systemRole.id });
  return jsonOk(c, { id: row[0].id }, "创建成功");
}

/** DELETE /api/admin/system_role/del/:id — 删除角色 */
export async function adminSystemRoleDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { systemRole } = await import("@/models/schema");
  await container.db.update(systemRole).set({ status: -1 }).where(eq(systemRole.id, id));
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// 提现审核 (M17)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/extract/list — 提现记录 (状态筛选 + 用户信息) */
export async function adminExtractList(c: C) {
  const container = c.get("container");
  const { sql, and, eq } = await import("drizzle-orm");
  const { userExtract } = await import("@/models/schema");
  const { user: userTable } = await import("@/models/schema");
  const q = c.req.query();
  const status = q.status !== undefined && q.status !== "" ? Number(q.status) : undefined;
  const page = q.page ? Number(q.page) : 1;
  const limit = q.limit ? Number(q.limit) : 20;

  const conds: unknown[] = [];
  if (status !== undefined) conds.push(eq(userExtract.status, status));
  const where = conds.length ? and(...(conds as Parameters<typeof and>[0][])) : undefined;

  const rows = await container.db
    .select({
      id: userExtract.id,
      uid: userExtract.uid,
      extractType: userExtract.extractType,
      bankName: userExtract.bankName,
      realName: userExtract.realName,
      extractNumber: userExtract.extractNumber,
      extractPrice: userExtract.extractPrice,
      status: userExtract.status,
      failMsg: userExtract.failMsg,
      addTime: userExtract.addTime,
      nickname: userTable.nickname,
      account: userTable.account,
    })
    .from(userExtract)
    .leftJoin(userTable, eq(userTable.uid, userExtract.uid))
    .where(where as never)
    .orderBy(sql`${userExtract.addTime} DESC`)
    .limit(limit)
    .offset((page - 1) * limit);

  const totalRows = await container.db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(userExtract)
    .where(where as never);
  return jsonOk(c, { list: rows, total: totalRows[0]?.c ?? 0 });
}

/** POST /api/admin/extract/status/:id — 提现审核 (status=1 通过 / 2 拒绝) */
export async function adminExtractStatus(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const body = (await c.req.json().catch(() => ({}))) as { status?: number; fail_msg?: string };
  const container = c.get("container");
  const { eq, and, sql } = await import("drizzle-orm");
  const { userExtract, userBrokerage, user: userTable } = await import("@/models/schema");

  const rec = await container.db
    .select()
    .from(userExtract)
    .where(eq(userExtract.id, id))
    .limit(1);
  if (!rec[0]) return jsonFail(c, "提现记录不存在");
  if (rec[0].status !== 0) return jsonFail(c, "该记录已审核");

  const newStatus = body.status === 2 ? 2 : 1;
  await container.db
    .update(userExtract)
    .set({ status: newStatus, failMsg: newStatus === 2 ? (body.fail_msg ?? "审核拒绝") : "" })
    .where(eq(userExtract.id, id));

  if (newStatus === 2) {
    // 拒绝 → 返还佣金 + 流水标记无效
    const price = Number(rec[0].extractPrice);
    await container.db
      .update(userTable)
      .set({ brokeragePrice: sql`brokerage_price + ${price.toFixed(2)}` })
      .where(eq(userTable.uid, rec[0].uid));
    await container.db
      .update(userBrokerage)
      .set({ status: -1 })
      .where(and(eq(userBrokerage.linkId, String(id)), eq(userBrokerage.category, "extract")));
  } else {
    // 通过 → 提现流水置有效
    await container.db
      .update(userBrokerage)
      .set({ status: 1 })
      .where(and(eq(userBrokerage.linkId, String(id)), eq(userBrokerage.category, "extract")));
  }
  return jsonOk(c, null, newStatus === 2 ? "已拒绝" : "已通过");
}

// ═══════════════════════════════════════════════════════════
// 财务流水 (M18)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/bill/list — 资金流水 (join 用户 + 筛选) */
export async function adminBillList(c: C) {
  const container = c.get("container");
  const { sql, and, eq } = await import("drizzle-orm");
  const { userBill } = await import("@/models/schema");
  const { user: userTable } = await import("@/models/schema");
  const q = c.req.query();
  const pm = q.pm !== undefined && q.pm !== "" ? Number(q.pm) : undefined;
  const page = q.page ? Number(q.page) : 1;
  const limit = q.limit ? Number(q.limit) : 20;

  const conds: unknown[] = [];
  if (pm !== undefined) conds.push(eq(userBill.pm, pm));
  const where = conds.length ? and(...(conds as Parameters<typeof and>[0][])) : undefined;

  const rows = await container.db
    .select({
      id: userBill.id,
      uid: userBill.uid,
      linkId: userBill.linkId,
      pm: userBill.pm,
      title: userBill.title,
      category: userBill.category,
      type: userBill.type,
      number: userBill.number,
      balance: userBill.balance,
      mark: userBill.mark,
      status: userBill.status,
      addTime: userBill.addTime,
      nickname: userTable.nickname,
      account: userTable.account,
    })
    .from(userBill)
    .leftJoin(userTable, eq(userTable.uid, userBill.uid))
    .where(where as never)
    .orderBy(sql`${userBill.addTime} DESC`)
    .limit(limit)
    .offset((page - 1) * limit);

  const totalRows = await container.db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(userBill)
    .where(where as never);
  return jsonOk(c, { list: rows, total: totalRows[0]?.c ?? 0 });
}

// ═══════════════════════════════════════════════════════════
// 会员等级管理 (M18)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/level/list — 会员等级列表 */
export async function adminLevelList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { systemUserLevel } = await import("@/models/schema");
  const rows = await container.db
    .select()
    .from(systemUserLevel)
    .where(sql`${systemUserLevel.isDel} = 0`)
    .orderBy(sql`${systemUserLevel.grade} ASC`);
  return jsonOk(c, rows);
}

/** POST /api/admin/level/save — 新增/编辑会员等级 */
export async function adminLevelSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    name?: string;
    grade?: number;
    discount?: number;
    exp_num?: number;
    is_show?: number;
    image?: string;
    color?: string;
    explain?: string;
  };
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { systemUserLevel } = await import("@/models/schema");

  if (body.id) {
    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.grade !== undefined) updates.grade = body.grade;
    if (body.discount !== undefined) updates.discount = body.discount;
    if (body.exp_num !== undefined) updates.expNum = body.exp_num;
    if (body.is_show !== undefined) updates.isShow = body.is_show;
    if (body.image !== undefined) updates.image = body.image;
    if (body.color !== undefined) updates.color = body.color;
    if (body.explain !== undefined) updates.explain = body.explain;
    await container.db.update(systemUserLevel).set(updates).where(eq(systemUserLevel.id, body.id));
    return jsonOk(c, { id: body.id }, "更新成功");
  }

  const now = Math.floor(Date.now() / 1000);
  const row = await container.db
    .insert(systemUserLevel)
    .values({
      name: body.name ?? "新等级",
      grade: body.grade ?? 0,
      discount: (body.discount ?? 100).toFixed(2),
      expNum: body.exp_num ?? 0,
      isShow: body.is_show ?? 1,
      image: body.image ?? "",
      color: body.color ?? "",
      explain: body.explain ?? "",
      isDel: 0,
      addTime: now,
    })
    .returning({ id: systemUserLevel.id });
  return jsonOk(c, { id: row[0].id }, "创建成功");
}

/** DELETE /api/admin/level/del/:id — 删除会员等级 */
export async function adminLevelDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { systemUserLevel } = await import("@/models/schema");
  await container.db.update(systemUserLevel).set({ isDel: 1 }).where(eq(systemUserLevel.id, id));
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// 运费模板 + 快递公司 (M19)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/shipping_template/list — 运费模板列表 (含区域费率) */
export async function adminShippingTemplateList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { shippingTemplates, shippingTemplatesRegion } = await import("@/models/schema");
  const rows = await container.db
    .select()
    .from(shippingTemplates)
    .where(sql`${shippingTemplates.isDel} = 0`)
    .orderBy(sql`${shippingTemplates.sort} DESC, ${shippingTemplates.id} DESC`);
  // 区域费率
  const regions = await container.db
    .select()
    .from(shippingTemplatesRegion)
    .orderBy(sql`${shippingTemplatesRegion.id} ASC`);
  return jsonOk(c, { list: rows, regions });
}

/** POST /api/admin/shipping_template/save — 新增/编辑模板 (含区域) */
export async function adminShippingTemplateSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    name?: string;
    type?: number;
    sort?: number;
    status?: number;
    regions?: { region_id: number; region_name: string; first: string; first_price: string; continue: string; continue_price: string }[];
  };
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { shippingTemplates, shippingTemplatesRegion } = await import("@/models/schema");
  const now = Math.floor(Date.now() / 1000);

  if (body.id) {
    await container.db
      .update(shippingTemplates)
      .set({
        name: body.name ?? "",
        type: body.type ?? 1,
        sort: body.sort ?? 0,
        status: body.status ?? 1,
      })
      .where(eq(shippingTemplates.id, body.id));
    // 重建区域
    await container.db
      .delete(shippingTemplatesRegion)
      .where(eq(shippingTemplatesRegion.templateId, body.id));
    for (const r of body.regions ?? []) {
      await container.db.insert(shippingTemplatesRegion).values({
        templateId: body.id,
        regionId: r.region_id,
        regionName: r.region_name,
        first: r.first ?? "1",
        firstPrice: r.first_price ?? "0.00",
        continue: r.continue ?? "1",
        continuePrice: r.continue_price ?? "0.00",
        addTime: now,
      });
    }
    return jsonOk(c, { id: body.id }, "更新成功");
  }

  if (!body.name) return jsonFail(c, "请输入模板名称");
  const row = await container.db
    .insert(shippingTemplates)
    .values({ name: body.name, type: body.type ?? 1, sort: body.sort ?? 0, status: body.status ?? 1, isDel: 0, addTime: now })
    .returning({ id: shippingTemplates.id });
  const tid = row[0].id;
  for (const r of body.regions ?? []) {
    await container.db.insert(shippingTemplatesRegion).values({
      templateId: tid,
      regionId: r.region_id,
      regionName: r.region_name,
      first: r.first ?? "1",
      firstPrice: r.first_price ?? "0.00",
      continue: r.continue ?? "1",
      continuePrice: r.continue_price ?? "0.00",
      addTime: now,
    });
  }
  return jsonOk(c, { id: tid }, "创建成功");
}

/** DELETE /api/admin/shipping_template/del/:id — 删除模板 */
export async function adminShippingTemplateDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { shippingTemplates } = await import("@/models/schema");
  await container.db.update(shippingTemplates).set({ isDel: 1 }).where(eq(shippingTemplates.id, id));
  return jsonOk(c, null, "删除成功");
}

/** GET /api/admin/express/list — 快递公司列表 */
export async function adminExpressList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { expressCompany } = await import("@/models/schema");
  const rows = await container.db
    .select()
    .from(expressCompany)
    .orderBy(sql`${expressCompany.sort} DESC, ${expressCompany.id} ASC`);
  return jsonOk(c, rows);
}

/** POST /api/admin/express/save — 新增/编辑快递公司 */
export async function adminExpressSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number;
    code?: string;
    name?: string;
    is_show?: number;
    sort?: number;
    status?: number;
  };
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { expressCompany } = await import("@/models/schema");

  if (body.id) {
    await container.db
      .update(expressCompany)
      .set({
        code: body.code ?? "",
        name: body.name ?? "",
        isShow: body.is_show ?? 1,
        sort: body.sort ?? 0,
        status: body.status ?? 1,
      })
      .where(eq(expressCompany.id, body.id));
    return jsonOk(c, { id: body.id }, "更新成功");
  }
  if (!body.name) return jsonFail(c, "请输入快递公司名称");
  const row = await container.db
    .insert(expressCompany)
    .values({
      code: body.code ?? "",
      name: body.name,
      isShow: body.is_show ?? 1,
      sort: body.sort ?? 0,
      status: body.status ?? 1,
      addTime: Math.floor(Date.now() / 1000),
    })
    .returning({ id: expressCompany.id });
  return jsonOk(c, { id: row[0].id }, "创建成功");
}

/** DELETE /api/admin/express/del/:id — 删除快递公司 */
export async function adminExpressDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { expressCompany } = await import("@/models/schema");
  await container.db.delete(expressCompany).where(eq(expressCompany.id, id));
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// 营销活动创建/编辑/删除 (M20)
// ═══════════════════════════════════════════════════════════

/** POST /api/admin/activity/save — 创建/编辑活动 (type 分发) */
export async function adminActivitySave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    type: "seckill" | "combination" | "bargain" | "integral";
    id?: number;
    productId?: number;
    storeName?: string;
    image?: string;
    price?: string;
    otPrice?: string;
    quota?: number;
    stock?: number;
    num?: number;
    // 秒杀
    timeId?: string;
    // 拼团
    people?: number;
    // 砍价
    minPrice?: string;
    // 积分
    integral?: number;
    sort?: number;
    status?: number;
  };
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const schema = await import("@/models/schema");
  const now = Math.floor(Date.now() / 1000);
  const sort = body.sort ?? 90;
  const status = body.status ?? 1;
  const common = {
    productId: body.productId ?? 0,
    storeName: body.storeName ?? "新活动",
    image: body.image ?? "",
    price: body.price ?? "0.00",
    otPrice: body.otPrice ?? "0.00",
    quota: body.quota ?? 100,
    quotaShow: body.quota ?? 100,
    stock: body.stock ?? 100,
    status,
    sort,
  };

  try {
    if (body.type === "seckill") {
      const vals = {
        ...common,
        timeId: body.timeId ?? "1",
        num: body.num ?? 2,
        sales: 0,
        addTime: now,
      };
      if (body.id) {
        await container.db.update(schema.storeSeckill).set(vals).where(eq(schema.storeSeckill.id, body.id));
        return jsonOk(c, { id: body.id }, "更新成功");
      }
      const row = await container.db.insert(schema.storeSeckill).values(vals).returning({ id: schema.storeSeckill.id });
      return jsonOk(c, { id: row[0].id }, "创建成功");
    }
    if (body.type === "combination") {
      const vals = { ...common, people: body.people ?? 2, sales: 0, addTime: now };
      if (body.id) {
        await container.db.update(schema.storeCombination).set(vals).where(eq(schema.storeCombination.id, body.id));
        return jsonOk(c, { id: body.id }, "更新成功");
      }
      const row = await container.db.insert(schema.storeCombination).values(vals).returning({ id: schema.storeCombination.id });
      return jsonOk(c, { id: row[0].id }, "创建成功");
    }
    if (body.type === "bargain") {
      const vals = { ...common, minPrice: body.minPrice ?? "0.00", sales: 0, people: 10, addTime: now };
      if (body.id) {
        await container.db.update(schema.storeBargain).set(vals).where(eq(schema.storeBargain.id, body.id));
        return jsonOk(c, { id: body.id }, "更新成功");
      }
      const row = await container.db.insert(schema.storeBargain).values(vals).returning({ id: schema.storeBargain.id });
      return jsonOk(c, { id: row[0].id }, "创建成功");
    }
    if (body.type === "integral") {
      const vals = {
        ...common,
        integral: body.integral ?? 100,
        num: body.num ?? 1,
        sales: 0,
        addTime: now,
      };
      if (body.id) {
        await container.db.update(schema.storeIntegral).set(vals).where(eq(schema.storeIntegral.id, body.id));
        return jsonOk(c, { id: body.id }, "更新成功");
      }
      const row = await container.db.insert(schema.storeIntegral).values(vals).returning({ id: schema.storeIntegral.id });
      return jsonOk(c, { id: row[0].id }, "创建成功");
    }
    return jsonFail(c, "未知活动类型");
  } catch (e) {
    return jsonFail(c, e instanceof Error ? e.message : "保存失败");
  }
}

/** DELETE /api/admin/activity/del/:type/:id — 删除活动 */
export async function adminActivityDel(c: C) {
  const type = c.req.param("type") as "seckill" | "combination" | "bargain" | "integral";
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const schema = await import("@/models/schema");
  const tableMap = {
    seckill: schema.storeSeckill,
    combination: schema.storeCombination,
    bargain: schema.storeBargain,
    integral: schema.storeIntegral,
  };
  const table = tableMap[type];
  if (!table) return jsonFail(c, "未知活动类型");
  await container.db.delete(table).where(eq(table.id, id));
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// 统计趋势 (M21: 图表数据)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/statistic/trend — 近7天/30天订单与销售额趋势 */
export async function adminStatisticTrend(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { storeOrder } = await import("@/models/schema");
  const days = Number(c.req.query("days") ?? 7);
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - days + 1);
  start.setHours(0, 0, 0, 0);
  const startTs = Math.floor(start.getTime() / 1000);

  const rows = await container.db
    .select({
      date: sql<string>`to_char(to_timestamp(${storeOrder.payTime}) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      orderCount: sql<number>`COUNT(*)::int`,
      sales: sql<string>`COALESCE(SUM(${storeOrder.payPrice}), 0)::numeric(12,2)`,
    })
    .from(storeOrder)
    .where(sql`${storeOrder.payTime} >= ${startTs} AND ${storeOrder.paid} = 1`)
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  // 填充空日期
  const result: { date: string; orderCount: number; sales: number }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const p = (n: number) => String(n).padStart(2, "0");
    const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const found = (rows as unknown[]).find((r: any) => r.date === key);
    result.push({ date: key, orderCount: found ? Number((found as any).orderCount) : 0, sales: found ? Number((found as any).sales) : 0 });
  }
  return jsonOk(c, result);
}

/** GET /api/admin/statistic/rank — 商品销量 TOP */
export async function adminStatisticRank(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { storeOrderCartInfo } = await import("@/models/schema");
  const limit = Number(c.req.query("limit") ?? 10);
  const rows = await container.db
    .select({
      productId: storeOrderCartInfo.productId,
      name: sql<string>`MAX(${storeOrderCartInfo.cartInfo}->>'product'->>'storeName')`,
      salesCount: sql<number>`SUM(${storeOrderCartInfo.cartNum})::int`,
    })
    .from(storeOrderCartInfo)
    .groupBy(storeOrderCartInfo.productId)
    .orderBy(sql`SUM(${storeOrderCartInfo.cartNum}) DESC`)
    .limit(limit);
  return jsonOk(c, rows);
}

// ═══════════════════════════════════════════════════════════
// 商品标签 + 用户标签 (M21)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/product_label/list — 商品标签列表 */
export async function adminProductLabelList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { storeProductLabel } = await import("@/models/schema");
  const rows = await container.db
    .select()
    .from(storeProductLabel)
    .orderBy(sql`${storeProductLabel.sort} DESC, ${storeProductLabel.id} DESC`);
  return jsonOk(c, rows);
}

/** POST /api/admin/product_label/save — 商品标签增改 */
export async function adminProductLabelSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number; labelName?: string; color?: string; bgColor?: string; sort?: number; status?: number;
  };
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { storeProductLabel } = await import("@/models/schema");
  const now = Math.floor(Date.now() / 1000);
  if (body.id) {
    await container.db.update(storeProductLabel).set({
      labelName: body.labelName ?? "", color: body.color ?? "", bgColor: body.bgColor ?? "",
      sort: body.sort ?? 0, status: body.status ?? 1,
    }).where(eq(storeProductLabel.id, body.id));
    return jsonOk(c, { id: body.id }, "更新成功");
  }
  if (!body.labelName) return jsonFail(c, "请输入标签名");
  const row = await container.db.insert(storeProductLabel).values({
    labelName: body.labelName, color: body.color ?? "", bgColor: body.bgColor ?? "",
    sort: body.sort ?? 0, status: body.status ?? 1, type: 0, relationId: 0, labelCate: 0,
    styleType: 1, borderColor: "", icon: "", isShow: 1, addTime: now,
  }).returning({ id: storeProductLabel.id });
  return jsonOk(c, { id: row[0].id }, "创建成功");
}

/** DELETE /api/admin/product_label/del/:id */
export async function adminProductLabelDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { storeProductLabel } = await import("@/models/schema");
  await container.db.delete(storeProductLabel).where(eq(storeProductLabel.id, id));
  return jsonOk(c, null, "删除成功");
}

/** GET /api/admin/user_label/list — 用户标签列表 */
export async function adminUserLabelList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { userLabel } = await import("@/models/schema");
  const rows = await container.db.select().from(userLabel).orderBy(sql`${userLabel.sort} DESC`);
  return jsonOk(c, rows);
}

/** POST /api/admin/user_label/save */
export async function adminUserLabelSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number; name?: string; color?: string; sort?: number; status?: number;
  };
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { userLabel } = await import("@/models/schema");
  const now = Math.floor(Date.now() / 1000);
  if (body.id) {
    await container.db.update(userLabel).set({
      name: body.name ?? "", color: body.color ?? "", sort: body.sort ?? 0, status: body.status ?? 1,
    }).where(eq(userLabel.id, body.id));
    return jsonOk(c, { id: body.id }, "更新成功");
  }
  if (!body.name) return jsonFail(c, "请输入标签名");
  const row = await container.db.insert(userLabel).values({
    name: body.name, color: body.color ?? "#e93323", sort: body.sort ?? 0, status: body.status ?? 1, addTime: now,
  }).returning({ id: userLabel.id });
  return jsonOk(c, { id: row[0].id }, "创建成功");
}

/** DELETE /api/admin/user_label/del/:id */
export async function adminUserLabelDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { userLabel } = await import("@/models/schema");
  await container.db.delete(userLabel).where(eq(userLabel.id, id));
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// DIY 装修/自定义页面 (M22)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/dise/list — 自定义页面列表 */
export async function adminDiseList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const rows = await container.db.execute(sql`
    SELECT id, name, title, status, type, add_time FROM "system_dise" WHERE "is_del" = 0 ORDER BY "id" DESC LIMIT 100
  `);
  const arr = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
  return jsonOk(c, arr);
}

/** POST /api/admin/dise/save — 自定义页面增改 */
export async function adminDiseSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number; name?: string; title?: string; content?: string; type?: number; status?: number;
  };
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const now = Math.floor(Date.now() / 1000);
  if (body.id) {
    await container.db.execute(sql`
      UPDATE "system_dise" SET "name" = ${body.name ?? ""}, "title" = ${body.title ?? ""},
        "content" = ${body.content ?? ""}, "type" = ${body.type ?? 0}, "status" = ${body.status ?? 1}
      WHERE "id" = ${body.id}
    `);
    return jsonOk(c, { id: body.id }, "更新成功");
  }
  if (!body.name) return jsonFail(c, "请输入页面名称");
  await container.db.execute(sql`
    INSERT INTO "system_dise" ("name", "title", "content", "type", "status", "is_del", "value", "add_time")
    VALUES (${body.name}, ${body.title ?? ""}, ${body.content ?? ""}, ${body.type ?? 0}, ${body.status ?? 1}, 0, '', ${now})
  `);
  return jsonOk(c, null, "创建成功");
}

/** DELETE /api/admin/dise/del/:id */
export async function adminDiseDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  await container.db.execute(sql`UPDATE "system_dise" SET "is_del" = 1 WHERE "id" = ${id}`);
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// CMS 内容管理 (M22: 文章 + 分类)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/article/list — 文章列表 */
export async function adminArticleList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const rows = await container.db.execute(sql`
    SELECT id, cid, title, author, status, add_time FROM "system_article" WHERE "is_del" = 0 ORDER BY "id" DESC LIMIT 100
  `);
  const arr = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
  return jsonOk(c, arr);
}

/** POST /api/admin/article/save — 文章增改 */
export async function adminArticleSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number; cid?: number; title?: string; author?: string; content?: string; status?: number;
  };
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const now = Math.floor(Date.now() / 1000);
  if (body.id) {
    await container.db.execute(sql`
      UPDATE "system_article" SET "cid" = ${body.cid ?? 0}, "title" = ${body.title ?? ""},
        "author" = ${body.author ?? ""}, "content" = ${body.content ?? ""}, "status" = ${body.status ?? 1}
      WHERE "id" = ${body.id}
    `);
    return jsonOk(c, { id: body.id }, "更新成功");
  }
  if (!body.title) return jsonFail(c, "请输入标题");
  await container.db.execute(sql`
    INSERT INTO "system_article" ("cid", "title", "author", "content", "status", "is_del", "add_time")
    VALUES (${body.cid ?? 0}, ${body.title}, ${body.author ?? ""}, ${body.content ?? ""}, ${body.status ?? 1}, 0, ${now})
  `);
  return jsonOk(c, null, "创建成功");
}

/** DELETE /api/admin/article/del/:id */
export async function adminArticleDel(c: C) {
  const id = Number(c.req.param("id") ?? "0");
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  await container.db.execute(sql`UPDATE "system_article" SET "is_del" = 1 WHERE "id" = ${id}`);
  return jsonOk(c, null, "删除成功");
}

// ═══════════════════════════════════════════════════════════
// 系统工具 (M22: 操作日志)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/log/list — 操作日志 */
export async function adminLogList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);
  const offset = (page - 1) * limit;
  const rows = await container.db.execute(sql`
    SELECT * FROM "system_log" ORDER BY "id" DESC LIMIT ${limit} OFFSET ${offset}
  `);
  const countRows = await container.db.execute(sql`SELECT COUNT(*)::int AS c FROM "system_log"`);
  const arr = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
  const carr = Array.isArray(countRows) ? countRows : (countRows as { rows?: unknown[] }).rows ?? [];
  return jsonOk(c, { list: arr, total: (carr[0] as { c?: number })?.c ?? 0 });
}

// ═══════════════════════════════════════════════════════════
// 分销管理 (M24: 推广人 + 佣金明细)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/spread/list — 推广人列表 (有 spread_count > 0 的用户) */
export async function adminSpreadList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { user: userTable } = await import("@/models/schema");
  const page = Number(c.req.query("page") ?? 1);
  const limit = Number(c.req.query("limit") ?? 20);

  // 查 spread_count > 0 的用户 (推广人)
  const rows = await container.db
    .select({
      uid: userTable.uid,
      nickname: userTable.nickname,
      account: userTable.account,
      phone: userTable.phone,
      spreadCount: userTable.spreadCount,
      brokeragePrice: userTable.brokeragePrice,
      addTime: userTable.addTime,
    })
    .from(userTable)
    .where(sql`${userTable.spreadCount} > 0`)
    .orderBy(sql`${userTable.spreadCount} DESC`)
    .limit(limit)
    .offset((page - 1) * limit);

  const totalRows = await container.db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(userTable)
    .where(sql`${userTable.spreadCount} > 0`);

  return jsonOk(c, { list: rows, total: totalRows[0]?.c ?? 0 });
}

/** GET /api/admin/brokerage/list — 佣金明细 (全平台) */
export async function adminBrokerageList(c: C) {
  const container = c.get("container");
  const { sql, eq } = await import("drizzle-orm");
  const { userBrokerage, user: userTable } = await import("@/models/schema");
  const q = c.req.query();
  const page = Number(q.page ?? 1);
  const limit = Number(q.limit ?? 20);
  const uid = q.uid ? Number(q.uid) : undefined;

  const where = uid ? eq(userBrokerage.uid, uid) : undefined;

  const rows = await container.db
    .select({
      id: userBrokerage.id,
      uid: userBrokerage.uid,
      pm: userBrokerage.pm,
      title: userBrokerage.title,
      category: userBrokerage.category,
      type: userBrokerage.type,
      number: userBrokerage.number,
      balance: userBrokerage.balance,
      mark: userBrokerage.mark,
      status: userBrokerage.status,
      addTime: userBrokerage.addTime,
      nickname: userTable.nickname,
    })
    .from(userBrokerage)
    .leftJoin(userTable, eq(userTable.uid, userBrokerage.uid))
    .where(where as never)
    .orderBy(sql`${userBrokerage.addTime} DESC`)
    .limit(limit)
    .offset((page - 1) * limit);

  const totalRows = await container.db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(userBrokerage)
    .where(where as never);

  return jsonOk(c, { list: rows, total: totalRows[0]?.c ?? 0 });
}

// ═══════════════════════════════════════════════════════════
// 通知模板/短信配置 (M24)
// ═══════════════════════════════════════════════════════════

/** GET /api/admin/notification/list — 通知模板列表 */
export async function adminNotificationList(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const rows = await container.db.execute(sql`
    SELECT * FROM "notification_template" ORDER BY "id" ASC LIMIT 100
  `);
  const arr = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
  return jsonOk(c, arr);
}

/** POST /api/admin/notification/save — 通知模板编辑 */
export async function adminNotificationSave(c: C) {
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: number; title?: string; content?: string; status?: number; type?: string;
  };
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  if (body.id) {
    await container.db.execute(sql`
      UPDATE "notification_template" SET "title" = ${body.title ?? ""}, "content" = ${body.content ?? ""},
        "status" = ${body.status ?? 1}, "type" = ${body.type ?? "wechat"}
      WHERE "id" = ${body.id}
    `);
    return jsonOk(c, { id: body.id }, "更新成功");
  }
  await container.db.execute(sql`
    INSERT INTO "notification_template" ("title", "content", "status", "type", "mark", "add_time")
    VALUES (${body.title ?? ""}, ${body.content ?? ""}, ${body.status ?? 1}, ${body.type ?? "wechat"}, '', ${Math.floor(Date.now()/1000)})
  `);
  return jsonOk(c, null, "创建成功");
}

/** GET /api/admin/sms/config — 短信配置 (从 system_config 读取) */
export async function adminSmsConfig(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { systemConfig } = await import("@/models/schema");
  const rows = await container.db
    .select()
    .from(systemConfig)
    .where(sql`${systemConfig.menuName} LIKE 'sms_%' OR ${systemConfig.menuName} LIKE 'notice_%'`);
  const config: Record<string, string> = {};
  for (const r of rows) {
    config[r.menuName] = r.value ?? "";
  }
  return jsonOk(c, config);
}

/** POST /api/admin/sms/config — 短信配置保存 */
export async function adminSmsConfigSave(c: C) {
  const body = await c.req.json().catch(() => ({}));
  const container = c.get("container");
  const { eq } = await import("drizzle-orm");
  const { systemConfig } = await import("@/models/schema");
  for (const [key, value] of Object.entries(body)) {
    const existing = await container.db
      .select()
      .from(systemConfig)
      .where(eq(systemConfig.menuName, key))
      .limit(1);
    if (existing.length) {
      await container.db
        .update(systemConfig)
        .set({ value: String(value) })
        .where(eq(systemConfig.menuName, key));
    } else {
      await container.db.insert(systemConfig).values({
        menuName: key,
        info: key,
        value: String(value),
        isStore: 0,
        type: "input",
        inputType: "input",
        sort: 0,
        status: 1,
      });
    }
  }
  return jsonOk(c, null, "保存成功");
}
