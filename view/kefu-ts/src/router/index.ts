import { createRouter, createWebHistory } from "vue-router";
import { KEFU_TOKEN_KEY } from "@/api/client";

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", redirect: "/workbench" },
    { path: "/login", component: () => import("@/pages/LoginPage.vue") },
    { path: "/workbench", component: () => import("@/pages/WorkbenchPage.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/workbench" },
  ],
});

router.beforeEach((to) => {
  const preview = import.meta.env.DEV && to.query.preview === "1";
  const authenticated = Boolean(localStorage.getItem(KEFU_TOKEN_KEY));
  if (to.path !== "/login" && !authenticated && !preview) {
    return { path: "/login", query: { redirect: to.fullPath } };
  }
  if (to.path === "/login" && authenticated) return "/workbench";
  return true;
});

export default router;
