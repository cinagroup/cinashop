import { createRouter, createWebHistory } from "vue-router";
import { KEFU_TOKEN_KEY } from "@/api/client";

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", redirect: "/workbench" },
    { path: "/login", component: () => import("@/pages/LoginPage.vue") },
    { path: "/workbench", component: () => import("@/pages/WorkbenchPage.vue") },
    { path: "/messages", component: () => import("@/pages/InboxPage.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/workbench" },
  ],
});

router.beforeEach((to) => {
  const preview = import.meta.env.DEV && to.query.preview === "1";
  const authenticated = Boolean(sessionStorage.getItem(KEFU_TOKEN_KEY));
  if (to.path !== "/login" && !authenticated && !preview) {
    return { path: "/login", query: { redirect: to.fullPath } };
  }
  if (to.path === "/login" && authenticated) return "/workbench";
  return true;
});

router.afterEach((to) => {
  const name = to.path === '/login' ? '登录' : to.path === '/messages' ? '系统提醒' : '会话';
  document.title = `${name} - CinaShop 客服`;
});

export default router;
