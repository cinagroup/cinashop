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
        path: "order/offline",
        name: "offline-orders",
        component: () => import("@/pages/order/OfflineOrders.vue"),
        meta: { title: "线下消费" },
      },
      {
        path: "order/invoice",
        name: "order-invoice",
        component: () => import("@/pages/order/InvoiceManagement.vue"),
        meta: { title: "发票管理" },
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
        path: "user/groups",
        name: "user-groups",
        component: () => import("@/pages/user/UserGroups.vue"),
        meta: { title: "商城用户分组" },
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
        path: "supplier/directory",
        name: "supplier-directory",
        component: () => import("@/pages/supplier/SupplierDirectory.vue"),
        meta: { title: "供应商目录" },
      },
      {
        path: "supplier/menu-rules",
        name: "supplier-menu-rules",
        component: () => import("@/pages/supplier/SupplierMenuRules.vue"),
        meta: { title: "供应商菜单规则" },
      },
      {
        path: "supplier/bills",
        name: "supplier-bills",
        component: () => import("@/pages/supplier/SupplierBills.vue"),
        meta: { title: "供应商账单" },
      },
      {
        path: "supplier/capital-flow",
        name: "supplier-capital-flow",
        component: () => import("@/pages/supplier/SupplierCapitalFlow.vue"),
        meta: { title: "供应商资金流水" },
      },
      {
        path: "supplier/order-statistics",
        name: "supplier-order-statistics",
        component: () => import("@/pages/supplier/SupplierOrderStatistics.vue"),
        meta: { title: "供应商订单统计" },
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
        path: "operations/writeoff-orders",
        name: "operations-writeoff-orders",
        component: () => import("@/pages/operations/WriteoffOrders.vue"),
        meta: { title: "核销订单" },
      },
      {
        path: "config/newcomer",
        name: "config-newcomer",
        component: () => import("@/pages/config/NewcomerSettings.vue"),
        meta: { title: "新人运营" },
      },
      {
        path: "config/level-activation",
        name: "config-level-activation",
        component: () => import("@/pages/config/LevelActivationSettings.vue"),
        meta: { title: "普通等级卡激活" },
      },
      {
        path: "config/paid-membership",
        name: "config-paid-membership",
        component: () => import("@/pages/config/PaidMembershipSettings.vue"),
        meta: { title: "付费会员功能设置" },
      },
      {
        path: "config/commerce",
        name: "config-commerce",
        component: () => import("@/pages/config/CommerceSettings.vue"),
        meta: { title: "商城运行设置" },
      },
      {
        path: "setting/shipping",
        name: "shipping-settings",
        component: () => import("@/pages/setting/ShippingSettings.vue"),
        meta: { title: "发货设置" },
      },
      {
        path: "setting/city-delivery-settings",
        alias: "/admin/setting/city/delivery/setting",
        name: "city-delivery-settings",
        component: () => import("@/pages/setting/CityDeliverySettings.vue"),
        meta: { title: "同城配送设置" },
      },
      {
        path: "setting/city-delivery-records",
        name: "city-delivery-records",
        component: () => import("@/pages/setting/CityDeliveryRecords.vue"),
        meta: { title: "同城配送记录" },
      },
      {
        path: "setting/distributor-levels/tasks/:levelId?",
        name: "distributor-level-tasks",
        component: () => import("@/pages/setting/DistributorLevelTasks.vue"),
        meta: { title: "分销等级任务" },
      },
      {
        path: "setting/distributor-levels",
        name: "distributor-levels",
        component: () => import("@/pages/setting/DistributorLevels.vue"),
        meta: { title: "分销等级" },
      },
      {
        path: "setting/pc-banner",
        name: "pc-home-banner",
        component: () => import("@/pages/system/PcBannerList.vue"),
        meta: { title: "PC首页轮播" },
      },
      {
        path: "setting/product-category-style",
        alias: "/admin/setting/pages/product_category",
        name: "product-category-style",
        component: () => import("@/pages/setting/ProductCategoryStyle.vue"),
        meta: { title: "商品分类页面" },
      },
      {
        path: "setting/product-detail-design",
        alias: "/admin/setting/pages/product_detail",
        name: "product-detail-design",
        component: () => import("@/pages/setting/ProductDetailDesign.vue"),
        meta: { title: "商品详情设计" },
      },
      {
        path: "setting/user-center-design",
        alias: "/admin/setting/pages/home",
        name: "user-center-design",
        component: () => import("@/pages/setting/UserCenterDesign.vue"),
        meta: { title: "个人中心设计" },
      },
      {
        path: "setting/theme-style",
        alias: "/admin/setting/theme_style",
        name: "theme-settings",
        component: () => import("@/pages/setting/ThemeSettings.vue"),
        meta: { title: "主题风格" },
      },
      {
        path: "setting/fab",
        name: "fab-settings",
        component: () => import("@/pages/setting/FabSettings.vue"),
        meta: { title: "悬浮按钮" },
      },
      {
        path: "config/forms",
        name: "config-forms",
        component: () => import("@/pages/config/SystemForms.vue"),
        meta: { title: "系统表单" },
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
        path: "activity/integral-batch",
        name: "integral-batch",
        component: () => import("@/pages/activity/IntegralBatch.vue"),
        meta: { title: "批量添加积分商品" },
      },
      {
        path: "activity",
        name: "activity",
        component: () => import("@/pages/activity/ActivityList.vue"),
        meta: { title: "营销活动" },
      },
      {
        path: "activity/seckill-statistics/:id?",
        name: "seckill-statistics",
        component: () => import("@/pages/activity/SeckillStatistics.vue"),
        meta: { title: "秒杀统计" },
      },
      {
        path: "activity/seckill-times",
        name: "seckill-times",
        component: () => import("@/pages/activity/SeckillTimes.vue"),
        meta: { title: "秒杀时段" },
      },
      {
        path: "activity/seckill-activities",
        name: "seckill-activities",
        component: () => import("@/pages/activity/SeckillActivities.vue"),
        meta: { title: "秒杀父活动" },
      },
      {
        path: "activity/combinations",
        name: "combinations",
        component: () => import("@/pages/activity/Combinations.vue"),
        meta: { title: "拼团商品" },
      },
      {
        path: "activity/combination-groups",
        name: "combination-groups",
        component: () => import("@/pages/activity/CombinationGroups.vue"),
        meta: { title: "全局拼团记录" },
      },
      {
        path: "activity/combination-statistics/:id?",
        name: "combination-statistics",
        component: () => import("@/pages/activity/CombinationStatistics.vue"),
        meta: { title: "拼团统计" },
      },
      {
        path: "marketing/lottery",
        name: "lottery",
        component: () => import("@/pages/activity/LotteryList.vue"),
        meta: { title: "抽奖活动" },
      },
      {
        path: "marketing/lottery-records",
        name: "lottery-records",
        component: () => import("@/pages/marketing/LotteryRecords.vue"),
        meta: { title: "抽奖记录" },
      },
      {
        path: "marketing/activity-frame",
        name: "activity-frame",
        component: () => import("@/pages/marketing/ActivityFrameList.vue"),
        meta: { title: "活动边框" },
      },
      {
        path: "marketing/activity-frame/create/:id?",
        name: "activity-frame-form",
        component: () => import("@/pages/marketing/ActivityFrameForm.vue"),
        meta: { title: "活动边框编辑" },
      },
      {
        path: "marketing/activity-background",
        name: "activity-background",
        component: () => import("@/pages/marketing/ActivityBackgroundList.vue"),
        meta: { title: "活动背景" },
      },
      {
        path: "marketing/activity-background/create/:id?",
        name: "activity-background-form",
        component: () => import("@/pages/marketing/ActivityBackgroundForm.vue"),
        meta: { title: "活动背景编辑" },
      },
      {
        path: "marketing/live",
        name: "wechat-live",
        component: () => import("@/pages/marketing/WechatLiveCatalog.vue"),
        meta: { title: "小程序直播" },
      },
      {
        path: "marketing/time-discounts",
        name: "time-discounts",
        component: () => import("@/pages/marketing/TimeDiscountList.vue"),
        meta: { title: "限时折扣" },
      },
      {
        path: "marketing/time-discounts/create/:id?",
        name: "time-discount-form",
        component: () => import("@/pages/marketing/TimeDiscountForm.vue"),
        meta: { title: "限时折扣编辑" },
      },
      {
        path: "marketing/full-discounts",
        name: "full-discounts",
        component: () => import("@/pages/marketing/FullDiscountList.vue"),
        meta: { title: "满减满折" },
      },
      {
        path: "marketing/full-discounts/create/:id?",
        name: "full-discount-form",
        component: () => import("@/pages/marketing/FullDiscountForm.vue"),
        meta: { title: "满减满折编辑" },
      },
      {
        path: "marketing/nth-discounts",
        name: "nth-discounts",
        component: () => import("@/pages/marketing/NthDiscountList.vue"),
        meta: { title: "第N件N折" },
      },
      {
        path: "marketing/nth-discounts/create/:id?",
        name: "nth-discount-form",
        component: () => import("@/pages/marketing/NthDiscountForm.vue"),
        meta: { title: "第N件N折编辑" },
      },
      {
        path: "marketing/full-gifts",
        name: "full-gifts",
        component: () => import("@/pages/marketing/FullGiftList.vue"),
        meta: { title: "满送活动" },
      },
      {
        path: "marketing/full-gifts/create/:id?",
        name: "full-gift-form",
        component: () => import("@/pages/marketing/FullGiftForm.vue"),
        meta: { title: "满送活动编辑" },
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
        path: "kefu/feedback",
        name: "feedback",
        component: () => import("@/pages/kefu/Feedback.vue"),
        meta: { title: "客服反馈" },
      },
      {
        path: "kefu/speechcraft",
        name: "speechcraft",
        component: () => import("@/pages/kefu/Speechcraft.vue"),
        meta: { title: "客服话术" },
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
        path: "finance/recharges",
        name: "finance-recharges",
        component: () => import("@/pages/finance/RechargeOrders.vue"),
        meta: { title: "充值订单" },
      },
      {
        path: "finance/commissions",
        name: "finance-commissions",
        component: () => import("@/pages/finance/CommissionRecords.vue"),
        meta: { title: "佣金记录" },
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
        path: "finance/capital-flow",
        name: "finance-capital-flow",
        component: () => import("@/pages/finance/CapitalFlowList.vue"),
        meta: { title: "平台资金流水" },
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
        path: "agent/promoter-applications",
        name: "promoter-applications",
        component: () => import("@/pages/agent/PromoterApplications.vue"),
        meta: { title: "分销员申请审核" },
      },
      {
        path: "agent/agreement",
        name: "agent-agreement",
        component: () => import("@/pages/agent/AgentAgreement.vue"),
        meta: { title: "分销说明" },
      },
      {
        path: "division",
        name: "division",
        component: () => import("@/pages/agent/DivisionManagement.vue"),
        meta: { title: "事业部管理" },
      },
      {
        path: "division/statistics",
        name: "division-statistics",
        component: () => import("@/pages/agent/DivisionStatistics.vue"),
        meta: { title: "事业部统计" },
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
      {
        path: "marketing/user-point",
        name: "integral-log",
        component: () => import("@/pages/marketing/IntegralLog.vue"),
        meta: { title: "积分日志" },
      },
      {
        path: "marketing/point-statistic",
        name: "point-statistic",
        component: () => import("@/pages/marketing/PointStatistic.vue"),
        meta: { title: "积分统计" },
      },
      {
        path: "marketing/recharge-options",
        name: "recharge-options",
        component: () => import("@/pages/marketing/RechargeOptions.vue"),
        meta: { title: "充值金额档位" },
      },
      {
        path: "marketing/integral-categories",
        name: "integral-categories",
        component: () => import("@/pages/marketing/IntegralCategories.vue"),
        meta: { title: "积分分类" },
      },
      {
        path: "marketing/sign-rewards",
        name: "sign-rewards",
        component: () => import("@/pages/marketing/SignRewards.vue"),
        meta: { title: "签到奖励" },
      },
      {
        path: "marketing/sign-day-config",
        name: "sign-day-config",
        component: () => import("@/pages/marketing/SignDayConfig.vue"),
        meta: { title: "签到天数组" },
      },
      {
        path: "marketing/coupon-records",
        name: "coupon-records",
        component: () => import("@/pages/marketing/CouponRecords.vue"),
        meta: { title: "用户领取记录" },
      },
      {
        path: "marketing/coupon-templates",
        name: "coupon-templates",
        component: () => import("@/pages/marketing/CouponTemplates.vue"),
        meta: { title: "优惠券模板" },
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
