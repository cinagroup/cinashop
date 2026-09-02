/**
 * 路由配置 (admin)
 * 对应后端已实现的 CRUD + Dashboard
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { isLoggedIn } from "@/utils/auth";

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

const routes: RouteRecordRaw[] = [
  {
    path: "/login",
    name: "login",
    component: () => import("@/pages/Login.vue"),
    meta: { title: "登录" },
  },
  {
    path: "/",
    component: () => import("@/layouts/AdminLayout.vue"),
    children: [
      {
        path: "",
        redirect: "/dashboard",
      },
      {
        path: "dashboard",
        name: "dashboard",
        component: () => import("@/pages/Dashboard.vue"),
        meta: { title: "控制台" },
      },
      {
        path: "community",
        name: "community",
        component: () => import("@/pages/community/CommunityOperations.vue"),
        meta: { title: "社区运营" },
      },
      {
        path: "product",
        name: "product",
        component: () => import("@/pages/product/ProductList.vue"),
        meta: { title: "商品管理" },
      },
      {
        path: "product/metadata",
        name: "product-metadata",
        component: () => import("@/pages/product/ProductMetadata.vue"),
        meta: { title: "商品基础资料" },
      },
      {
        path: "product/create",
        name: "product-create",
        component: () => import("@/pages/product/ProductForm.vue"),
        meta: { title: "添加商品" },
      },
      {
        path: "product/edit/:id",
        name: "product-edit",
        component: () => import("@/pages/product/ProductForm.vue"),
        meta: { title: "编辑商品" },
      },
      {
        path: "product/virtual-alerts",
        name: "product-virtual-alerts",
        component: () => import("@/pages/product/VirtualInventoryAlerts.vue"),
        meta: { title: "卡密库存预警" },
      },
      {
        path: "product/virtual/:id",
        name: "product-virtual-inventory",
        component: () => import("@/pages/product/VirtualInventory.vue"),
        meta: { title: "卡密库存" },
      },
      {
        path: "order",
        name: "order",
        component: () => import("@/pages/order/OrderList.vue"),
        meta: { title: "订单管理" },
      },
      {
        path: "order/:orderId",
        name: "order-detail",
        component: () => import("@/pages/order/OrderDetail.vue"),
        meta: { title: "订单详情" },
      },
      {
        path: "user",
        name: "user",
        component: () => import("@/pages/user/UserList.vue"),
        meta: { title: "用户管理" },
      },
      {
        path: "member",
        name: "paid-membership",
        component: () => import("@/pages/user/PaidMembership.vue"),
        meta: { title: "付费会员" },
      },
      {
        path: "refund",
        name: "refund",
        component: () => import("@/pages/refund/RefundList.vue"),
        meta: { title: "退款审核" },
      },
      {
        path: "supplier/applications",
        name: "supplier-applications",
        component: () => import("@/pages/supplier/SupplierApplications.vue"),
        meta: { title: "供应商入驻" },
      },
      {
        path: "operations/outbox",
        name: "operations-outbox",
        component: () => import("@/pages/operations/OrderOutboxList.vue"),
        meta: { title: "任务运维" },
      },
      {
        path: "operations/legacy-runtime",
        name: "operations-legacy-runtime",
        component: () => import("@/pages/operations/LegacyRuntimeHistory.vue"),
        meta: { title: "迁移运行历史" },
      },
      {
        path: "operations/work",
        name: "operations-work",
        component: () => import("@/pages/operations/EnterpriseWechat.vue"),
        meta: { title: "企业微信" },
      },
      {
        path: "operations/store",
        name: "operations-store",
        component: () => import("@/pages/operations/StoreOperations.vue"),
        meta: { title: "门店与配送" },
      },
      {
        path: "config/newcomer",
        name: "config-newcomer",
        component: () => import("@/pages/config/NewcomerSettings.vue"),
        meta: { title: "新人运营" },
      },
      {
        path: "config/runtime-content",
        name: "config-runtime-content",
        component: () => import("@/pages/config/RuntimeContent.vue"),
        meta: { title: "客户端内容" },
      },
      {
        path: "config",
        name: "config",
        component: () => import("@/pages/ConfigList.vue"),
        meta: { title: "系统配置" },
      },
      {
        path: "category",
        name: "category",
        component: () => import("@/pages/category/CategoryList.vue"),
        meta: { title: "商品分类" },
      },
      {
        path: "coupon",
        name: "coupon",
        component: () => import("@/pages/coupon/CouponList.vue"),
        meta: { title: "优惠券管理" },
      },
      {
        path: "activity",
        name: "activity",
        component: () => import("@/pages/activity/ActivityList.vue"),
        meta: { title: "营销活动" },
      },
      {
        path: "marketing/lottery",
        name: "lottery",
        component: () => import("@/pages/activity/LotteryList.vue"),
        meta: { title: "抽奖活动" },
      },
      {
        path: "marketing/live",
        name: "wechat-live",
        component: () => import("@/pages/marketing/WechatLiveCatalog.vue"),
        meta: { title: "小程序直播" },
      },
      {
        path: "system/out",
        name: "external-api",
        component: () => import("@/pages/system/ExternalApi.vue"),
        meta: { title: "对外接口" },
      },
      {
        path: "kefu",
        name: "kefu",
        component: () => import("@/pages/kefu/KefuList.vue"),
        meta: { title: "客服会话" },
      },
      {
        path: "reply",
        name: "reply",
        component: () => import("@/pages/reply/ReplyList.vue"),
        meta: { title: "商品评价" },
      },
      {
        path: "brand",
        name: "brand",
        component: () => import("@/pages/brand/BrandList.vue"),
        meta: { title: "品牌管理" },
      },
      {
        path: "system",
        name: "system",
        component: () => import("@/pages/system/SystemList.vue"),
        meta: { title: "系统管理" },
      },
      {
        path: "finance/extract",
        name: "finance-extract",
        component: () => import("@/pages/finance/ExtractList.vue"),
        meta: { title: "提现审核" },
      },
      {
        path: "assets",
        name: "assets",
        component: () => import("@/pages/system/AttachmentLibrary.vue"),
        meta: { title: "素材中心" },
      },
      {
        path: "finance/supplier-extract",
        name: "finance-supplier-extract",
        component: () => import("@/pages/finance/SupplierExtractList.vue"),
        meta: { title: "供应商提现" },
      },
      {
        path: "finance/bill",
        name: "finance-bill",
        component: () => import("@/pages/finance/BillList.vue"),
        meta: { title: "财务流水" },
      },
      {
        path: "level",
        name: "level",
        component: () => import("@/pages/level/LevelList.vue"),
        meta: { title: "会员等级" },
      },
      {
        path: "shipping",
        name: "shipping",
        component: () => import("@/pages/shipping/ShippingTemplates.vue"),
        meta: { title: "运费模板" },
      },
      {
        path: "express",
        name: "express",
        component: () => import("@/pages/express/ExpressList.vue"),
        meta: { title: "快递公司" },
      },
      {
        path: "statistic",
        name: "statistic",
        component: () => import("@/pages/statistic/Dashboard.vue"),
        meta: { title: "统计报表" },
      },
      {
        path: "label",
        name: "label",
        component: () => import("@/pages/label/LabelList.vue"),
        meta: { title: "标签管理" },
      },
      {
        path: "content/article",
        name: "content-article",
        component: () => import("@/pages/content/ArticleList.vue"),
        meta: { title: "CMS 文章" },
      },
      {
        path: "content/wechat-card",
        name: "content-wechat-card",
        component: () => import("@/pages/content/WechatMemberCard.vue"),
        meta: { title: "公众号会员卡" },
      },
      {
        path: "content/wechat",
        name: "content-wechat",
        component: () => import("@/pages/content/WechatContent.vue"),
        meta: { title: "公众号内容" },
      },
      {
        path: "content/wechat-qrcode",
        name: "content-wechat-qrcode",
        component: () => import("@/pages/content/WechatQrcode.vue"),
        meta: { title: "渠道二维码" },
      },
      {
        path: "content/dise",
        name: "content-dise",
        component: () => import("@/pages/content/DiseList.vue"),
        meta: { title: "DIY 装修" },
      },
      {
        path: "system/log",
        name: "system-log",
        component: () => import("@/pages/system/LogList.vue"),
        meta: { title: "操作日志" },
      },
      {
        path: "agent",
        name: "agent",
        component: () => import("@/pages/agent/AgentList.vue"),
        meta: { title: "分销管理" },
      },
      {
        path: "division",
        name: "division",
        component: () => import("@/pages/agent/DivisionManagement.vue"),
        meta: { title: "事业部管理" },
      },
      {
        path: "setting/notification",
        name: "setting-notification",
        component: () => import("@/pages/setting/NotificationList.vue"),
        meta: { title: "通知配置" },
      },
      {
        path: "setting/print",
        name: "setting-print",
        component: () => import("@/pages/setting/PrintOperations.vue"),
        meta: { title: "小票打印" },
      },
      {
        path: "setting/waybill",
        name: "setting-waybill",
        component: () => import("@/pages/setting/WaybillOperations.vue"),
        meta: { title: "电子面单" },
      },
    ],
  },
  { path: "/:pathMatch(.*)*", redirect: "/dashboard" },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

// 路由守卫: 未登录跳登录页
router.beforeEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} - CinaShop 管理后台` : "CinaShop 管理后台";
  if (previewMode) return true;
  if (to.path !== "/login" && !isLoggedIn()) {
    return { path: "/login" };
  }
  if (to.path === "/login" && isLoggedIn()) {
    return { path: "/dashboard" };
  }
  return true;
});

export default router;
