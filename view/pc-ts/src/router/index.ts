/**
 * 路由配置
 * 对应旧版 PC 前端 30 个页面
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { isLoggedIn } from "@/utils/auth";

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    component: () => import("@/layouts/DefaultLayout.vue"),
    children: [
      { path: "", name: "home", component: () => import("@/pages/Home.vue") },
      { path: "goods", name: "goods-list", component: () => import("@/pages/goods/GoodsList.vue") },
      { path: "goods/:id", name: "goods-detail", component: () => import("@/pages/goods/GoodsDetail.vue") },
      { path: "category", name: "goods-cate", component: () => import("@/pages/goods/GoodsCate.vue") },
      { path: "search", name: "goods-search", component: () => import("@/pages/goods/GoodsSearch.vue") },
      { path: "seckill", name: "seckill", component: () => import("@/pages/activity/Seckill.vue") },
      { path: "bargain", name: "bargain", component: () => import("@/pages/activity/Bargain.vue") },
      { path: "combination", name: "combination", component: () => import("@/pages/activity/Combination.vue") },
      { path: "combination/:id", name: "combination-detail", component: () => import("@/pages/activity/CombinationDetail.vue") },
      { path: "refund/:orderId", name: "refund-apply", component: () => import("@/pages/order/RefundApply.vue") },
      { path: "cart", name: "cart", component: () => import("@/pages/cart/Cart.vue") },
      { path: "checkout", name: "checkout", component: () => import("@/pages/order/Checkout.vue") },
      { path: "order/:orderId", name: "order-detail", component: () => import("@/pages/order/OrderDetail.vue") },
      { path: "express", name: "order-express", component: () => import("@/pages/order/OrderExpress.vue") },
      { path: "order", name: "order-list", component: () => import("@/pages/order/OrderList.vue") },
      { path: "login", name: "login", component: () => import("@/pages/auth/Login.vue") },
      { path: "register", name: "register", component: () => import("@/pages/auth/Register.vue"), meta: { title: "注册" } },
      { path: "forgot-password", name: "forgot-password", component: () => import("@/pages/auth/ForgotPassword.vue"), meta: { title: "找回密码" } },
      // 用户中心
      { path: "user", name: "user", component: () => import("@/pages/user/UserCenter.vue") },
      { path: "user/phone", name: "user-phone", component: () => import("@/pages/user/PhoneSettings.vue"), meta: { title: "手机号管理" } },
      { path: "user/address", name: "user-address", component: () => import("@/pages/user/AddressList.vue") },
      { path: "user/collect", name: "user-collect", component: () => import("@/pages/user/CollectList.vue") },
      { path: "user/coupon", name: "user-coupon", component: () => import("@/pages/user/CouponList.vue") },
      { path: "user/balance", name: "user-balance", component: () => import("@/pages/user/BalanceList.vue") },
      { path: "user/spread", name: "user-spread", component: () => import("@/pages/user/SpreadCenter.vue") },
      { path: "user/invoice", name: "user-invoice", component: () => import("@/pages/user/InvoiceList.vue") },
      { path: "user/level", name: "user-level", component: () => import("@/pages/user/UserLevel.vue") },
      { path: "user/recharge", name: "user-recharge", component: () => import("@/pages/user/Recharge.vue") },
      { path: "community", name: "community", component: () => import("@/pages/community/Community.vue") },
    ],
  },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

// 需要登录的路由
const AUTH_PATHS = ["/cart", "/checkout", "/order", "/user"];

// 路由守卫
router.beforeEach((to) => {
  const needAuth = AUTH_PATHS.some((p) => to.path.startsWith(p));
  if (needAuth && !isLoggedIn()) {
    return { path: "/login", query: { redirect: to.fullPath } };
  }
  return true;
});

export default router;
