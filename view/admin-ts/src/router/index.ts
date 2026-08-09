/**
 * 路由配置 (admin)
 * 对应后端已实现的 CRUD + Dashboard
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { isLoggedIn } from "@/utils/auth";

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
        path: "product",
        name: "product",
        component: () => import("@/pages/product/ProductList.vue"),
        meta: { title: "商品管理" },
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
        path: "refund",
        name: "refund",
        component: () => import("@/pages/refund/RefundList.vue"),
        meta: { title: "退款审核" },
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
  if (to.path !== "/login" && !isLoggedIn()) {
    return { path: "/login" };
  }
  if (to.path === "/login" && isLoggedIn()) {
    return { path: "/dashboard" };
  }
  return true;
});

export default router;
