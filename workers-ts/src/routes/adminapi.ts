/**
 * Admin 前端兼容路由 (VUE_APP_API_URL 指向 Workers)
 *
 * PHP 原版: baseURL = {origin}/adminapi, 请求路径 = /order/list 等
 * Workers:   已有 /api/admin/order/list 等接口
 *
 * 这个文件把 /adminapi/<module>/<action> 映射到现有的 admin 处理函数,
 * 让 Vue2 前端零改动即可对接。
 *
 * 映射表 (已实现的 admin 端点):
 *   POST /adminapi/login              → adminLogin
 *   GET  /adminapi/home/header        → adminDashboard
 *   GET  /adminapi/home/order         → 订单统计 (TODO)
 *   GET  /adminapi/product/list       → adminProductList
 *   GET  /adminapi/product/detail/:id → adminProductDetail
 *   POST /adminapi/product/add        → adminProductCreate
 *   POST /adminapi/product/set_show/:id → adminProductSetShow
 *   GET  /adminapi/order/list         → adminOrderList
 *   GET  /adminapi/order/detail/:id   → adminOrderDetail
 *   POST /adminapi/order/remark/:id   → adminOrderRemark
 *   GET  /adminapi/user/list          → adminUserList
 *   GET  /adminapi/user/info/:id      → adminUserInfo
 *   GET  /adminapi/setting/config/:menuName → adminConfigGet
 *
 * 未实现端点返回 501, 前端会提示"接口未迁移"。
 */
import { Hono } from "hono";
import { adminAuthMiddleware } from "@/middleware/admin-auth";
import * as AdminController from "@/controllers/api/v1/AdminController";
import * as AdminCrud from "@/controllers/api/v1/AdminCrudController";
import type { AppVariables, Env } from "@/env";

export const adminapiRoutes = new Hono<{
  Bindings: Env;
  Variables: AppVariables;
}>();

const adminAuth = adminAuthMiddleware();

// ─── 登录 (无 auth) ─────────────────────────────────────────
adminapiRoutes.post("/login", AdminController.adminLogin);
// 是否启用滑块验证码 (返回 false 则前端跳过滑块直接登录)
adminapiRoutes.post("/is_captcha", (c) =>
  c.json({ status: 200, msg: "ok", data: { is_captcha: false } }),
);

// ─── Dashboard (admin auth) ─────────────────────────────────
adminapiRoutes.get("/home/header", adminAuth, AdminController.adminDashboard);
adminapiRoutes.get("/home/order", adminAuth, AdminController.adminDashboard);
adminapiRoutes.get("/home/user", adminAuth, AdminController.adminDashboard);

// ─── 商品管理 ───────────────────────────────────────────────
adminapiRoutes.get("/product/list", adminAuth, AdminCrud.adminProductList);
adminapiRoutes.get("/product/detail/:id", adminAuth, AdminCrud.adminProductDetail);
adminapiRoutes.post("/product/add", adminAuth, AdminCrud.adminProductCreate);
adminapiRoutes.post("/product/edit/:id", adminAuth, AdminCrud.adminProductUpdate);
adminapiRoutes.post("/product/set_show/:id", adminAuth, AdminCrud.adminProductSetShow);
adminapiRoutes.post("/product/del/:id", adminAuth, AdminCrud.adminProductDel);

// ─── 订单管理 ───────────────────────────────────────────────
adminapiRoutes.get("/order/list", adminAuth, AdminCrud.adminOrderList);
adminapiRoutes.get("/order/detail/:id", adminAuth, AdminCrud.adminOrderDetail);
adminapiRoutes.post("/order/remark/:id", adminAuth, AdminCrud.adminOrderRemark);
adminapiRoutes.post("/order/delivery/:id", adminAuth, AdminCrud.adminOrderDelivery);

// ─── 用户管理 ───────────────────────────────────────────────
adminapiRoutes.get("/user/list", adminAuth, AdminCrud.adminUserList);
adminapiRoutes.get("/user/info/:id", adminAuth, AdminCrud.adminUserInfo);
adminapiRoutes.post("/user/set_user_grade/:id", adminAuth, AdminCrud.adminUserUpdate);
adminapiRoutes.post("/user/set_other/:id", adminAuth, AdminCrud.adminUserMoney);

// ─── 退款审核 ───────────────────────────────────────────────
adminapiRoutes.get("/refund/list", adminAuth, AdminCrud.adminRefundList);
adminapiRoutes.get("/refund/detail/:id", adminAuth, AdminCrud.adminRefundDetail);
adminapiRoutes.post("/refund/refund/:id", adminAuth, AdminCrud.adminRefundAgree);
adminapiRoutes.post("/refund/refuse/:id", adminAuth, AdminCrud.adminRefundRefuse);

// ─── 系统配置 ───────────────────────────────────────────────
adminapiRoutes.get("/setting/config/:menuName", adminAuth, AdminCrud.adminConfigGet);

// ─── 分类管理 (M9) ──────────────────────────────────────────
adminapiRoutes.get("/category/list", adminAuth, AdminCrud.adminCategoryList);
adminapiRoutes.post("/category/save", adminAuth, AdminCrud.adminCategorySave);
adminapiRoutes.delete("/category/del/:id", adminAuth, AdminCrud.adminCategoryDel);

// ─── 优惠券管理 (M9) ────────────────────────────────────────
adminapiRoutes.get("/coupon/list", adminAuth, AdminCrud.adminCouponList);
adminapiRoutes.post("/coupon/save", adminAuth, AdminCrud.adminCouponSave);
adminapiRoutes.post("/coupon/status/:id", adminAuth, AdminCrud.adminCouponStatus);
adminapiRoutes.delete("/coupon/del/:id", adminAuth, AdminCrud.adminCouponDel);

// ─── 数据统计 (M9) ──────────────────────────────────────────
adminapiRoutes.get("/statistic/overview", adminAuth, AdminCrud.adminStatisticOverview);

// ─── 营销活动管理 (M10) ─────────────────────────────────────
adminapiRoutes.get("/activity/seckill", adminAuth, AdminCrud.adminSeckillList);
adminapiRoutes.get("/activity/combination", adminAuth, AdminCrud.adminCombinationList);
adminapiRoutes.get("/activity/bargain", adminAuth, AdminCrud.adminBargainList);
adminapiRoutes.get("/activity/integral", adminAuth, AdminCrud.adminIntegralList);
adminapiRoutes.post("/activity/status", adminAuth, AdminCrud.adminActivityStatus);

// ─── 客服 (M10) ─────────────────────────────────────────────
adminapiRoutes.get("/service/sessions", adminAuth, AdminController.chatSessions);
adminapiRoutes.get("/service/chat", adminAuth, AdminController.chatHistory);

// ─── 商品评价管理 (M11) ─────────────────────────────────────
adminapiRoutes.get("/reply/list", adminAuth, AdminCrud.adminReplyList);
adminapiRoutes.post("/reply/status/:id", adminAuth, AdminCrud.adminReplyStatus);
adminapiRoutes.delete("/reply/del/:id", adminAuth, AdminCrud.adminReplyDel);
adminapiRoutes.get("/activity/pink/:combinationId", adminAuth, AdminCrud.adminPinkList);

// ─── 营销细分 (M13) ─────────────────────────────────────────
adminapiRoutes.get("/activity/bargain_users/:bargainId", adminAuth, AdminCrud.adminBargainUsers);
adminapiRoutes.get("/activity/seckill_times", adminAuth, AdminCrud.adminSeckillTimes);

// 客服回复 (M14)
adminapiRoutes.post("/service/send", adminAuth, AdminController.serviceReply);

// ─── 品牌管理 (M15) ─────────────────────────────────────────
adminapiRoutes.get("/brand/list", adminAuth, AdminCrud.adminBrandList);
adminapiRoutes.post("/brand/save", adminAuth, AdminCrud.adminBrandSave);
adminapiRoutes.delete("/brand/del/:id", adminAuth, AdminCrud.adminBrandDel);

// ─── 系统管理员/角色 (M16) ──────────────────────────────────
adminapiRoutes.get("/system_admin/list", adminAuth, AdminCrud.adminSystemAdminList);
adminapiRoutes.post("/system_admin/save", adminAuth, AdminCrud.adminSystemAdminSave);
adminapiRoutes.get("/system_role/list", adminAuth, AdminCrud.adminSystemRoleList);
adminapiRoutes.post("/system_role/save", adminAuth, AdminCrud.adminSystemRoleSave);
adminapiRoutes.delete("/system_role/del/:id", adminAuth, AdminCrud.adminSystemRoleDel);

// ─── 提现审核 (M17) ─────────────────────────────────────────
adminapiRoutes.get("/extract/list", adminAuth, AdminCrud.adminExtractList);
adminapiRoutes.post("/extract/status/:id", adminAuth, AdminCrud.adminExtractStatus);

// ─── 财务流水 (M18) ─────────────────────────────────────────
adminapiRoutes.get("/bill/list", adminAuth, AdminCrud.adminBillList);

// ─── 会员等级 (M18) ─────────────────────────────────────────
adminapiRoutes.get("/level/list", adminAuth, AdminCrud.adminLevelList);
adminapiRoutes.post("/level/save", adminAuth, AdminCrud.adminLevelSave);
adminapiRoutes.delete("/level/del/:id", adminAuth, AdminCrud.adminLevelDel);

// ─── 运费模板 + 快递公司 (M19) ─────────────────────────────
adminapiRoutes.get("/shipping_template/list", adminAuth, AdminCrud.adminShippingTemplateList);
adminapiRoutes.post("/shipping_template/save", adminAuth, AdminCrud.adminShippingTemplateSave);
adminapiRoutes.delete("/shipping_template/del/:id", adminAuth, AdminCrud.adminShippingTemplateDel);
adminapiRoutes.get("/express/list", adminAuth, AdminCrud.adminExpressList);
adminapiRoutes.post("/express/save", adminAuth, AdminCrud.adminExpressSave);
adminapiRoutes.delete("/express/del/:id", adminAuth, AdminCrud.adminExpressDel);

// ─── 营销活动创建/编辑/删除 (M20) ─────────────────────────
adminapiRoutes.post("/activity/save", adminAuth, AdminCrud.adminActivitySave);
adminapiRoutes.delete("/activity/del/:type/:id", adminAuth, AdminCrud.adminActivityDel);

// ─── 统计趋势 + 标签 (M21) ─────────────────────────────────
adminapiRoutes.get("/statistic/trend", adminAuth, AdminCrud.adminStatisticTrend);
adminapiRoutes.get("/statistic/rank", adminAuth, AdminCrud.adminStatisticRank);
adminapiRoutes.get("/product_label/list", adminAuth, AdminCrud.adminProductLabelList);
adminapiRoutes.post("/product_label/save", adminAuth, AdminCrud.adminProductLabelSave);
adminapiRoutes.delete("/product_label/del/:id", adminAuth, AdminCrud.adminProductLabelDel);
adminapiRoutes.get("/user_label/list", adminAuth, AdminCrud.adminUserLabelList);
adminapiRoutes.post("/user_label/save", adminAuth, AdminCrud.adminUserLabelSave);
adminapiRoutes.delete("/user_label/del/:id", adminAuth, AdminCrud.adminUserLabelDel);

// ─── DIY + CMS + 系统工具 (M22) ──────────────────────────────
adminapiRoutes.get("/dise/list", adminAuth, AdminCrud.adminDiseList);
adminapiRoutes.post("/dise/save", adminAuth, AdminCrud.adminDiseSave);
adminapiRoutes.delete("/dise/del/:id", adminAuth, AdminCrud.adminDiseDel);
adminapiRoutes.get("/article/list", adminAuth, AdminCrud.adminArticleList);
adminapiRoutes.post("/article/save", adminAuth, AdminCrud.adminArticleSave);
adminapiRoutes.delete("/article/del/:id", adminAuth, AdminCrud.adminArticleDel);
adminapiRoutes.get("/log/list", adminAuth, AdminCrud.adminLogList);

// ─── 未实现端点兜底 (必须最后注册, 否则吞掉后续路由) ─────────
adminapiRoutes.all("/*", (c) =>
  c.json({ status: 501, msg: `接口 ${c.req.path} 尚未迁移到 Workers`, data: null }),
);
