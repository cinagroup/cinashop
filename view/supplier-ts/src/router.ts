import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { previewMode } from "@/api/supplier";
import Login from "@/pages/Login.vue";
import AppShell from "@/components/AppShell.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", component: Login, meta: { public: true } },
    {
      path: "/",
      component: AppShell,
      children: [
        { path: "", redirect: "/dashboard" },
        { path: "dashboard", component: () => import("@/pages/Dashboard.vue") },
        { path: "products", component: () => import("@/pages/Products.vue") },
        { path: "products/new", component: () => import("@/pages/ProductForm.vue") },
        { path: "products/:id/edit", component: () => import("@/pages/ProductForm.vue") },
        { path: "products/virtual-alerts", component: () => import("@/pages/VirtualInventoryAlerts.vue") },
        { path: "products/:id/virtual-inventory", component: () => import("@/pages/VirtualInventory.vue") },
        { path: "shipping-templates", component: () => import("@/pages/ShippingTemplates.vue") },
        { path: "orders", component: () => import("@/pages/Orders.vue") },
        { path: "refunds", component: () => import("@/pages/Refunds.vue") },
        { path: "finance", component: () => import("@/pages/Finance.vue") },
        { path: "printers", component: () => import("@/pages/Printers.vue") },
        { path: "waybills", component: () => import("@/pages/Waybills.vue") },
        { path: "settings", component: () => import("@/pages/Settings.vue") },
        { path: "profile", component: () => import("@/pages/Profile.vue") },
      ],
    },
    { path: "/:pathMatch(.*)*", redirect: "/dashboard" },
  ],
});

router.beforeEach((to) => {
  if (to.meta.public || previewMode) return true;
  const auth = useAuthStore();
  if (!auth.token) return { path: "/login", query: { redirect: to.fullPath } };
  return true;
});

export default router;
