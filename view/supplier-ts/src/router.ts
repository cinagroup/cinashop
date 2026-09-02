import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { previewMode } from "@/api/supplier";
import Login from "@/pages/Login.vue";
import AppShell from "@/components/AppShell.vue";

const protectedDestinations = [
  { path: "/dashboard", permission: "supplier.dashboard.view" },
  { path: "/products", permission: "supplier.product.view" },
  { path: "/shipping-templates", permission: "supplier.shipping.view" },
  { path: "/orders", permission: "supplier.order.view" },
  { path: "/refunds", permission: "supplier.refund.view" },
  { path: "/finance", permission: "supplier.finance.view" },
  { path: "/printers", permission: "supplier.print.view" },
  { path: "/waybills", permission: "supplier.waybill.view" },
  { path: "/settings", permission: "supplier.config.view" },
  { path: "/profile", permission: "supplier.profile.view" },
  { path: "/administrators", permission: "supplier.admin.view" },
] as const;

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", component: Login, meta: { public: true } },
    {
      path: "/",
      component: AppShell,
      children: [
        { path: "", redirect: "/dashboard" },
        { path: "dashboard", component: () => import("@/pages/Dashboard.vue"), meta: { permission: "supplier.dashboard.view" } },
        { path: "products", component: () => import("@/pages/Products.vue"), meta: { permission: "supplier.product.view" } },
        { path: "products/new", component: () => import("@/pages/ProductForm.vue"), meta: { permission: "supplier.product.manage" } },
        { path: "products/:id/edit", component: () => import("@/pages/ProductForm.vue"), meta: { permission: "supplier.product.manage" } },
        { path: "products/virtual-alerts", component: () => import("@/pages/VirtualInventoryAlerts.vue"), meta: { permission: "supplier.product.view" } },
        { path: "products/:id/virtual-inventory", component: () => import("@/pages/VirtualInventory.vue"), meta: { permission: "supplier.product.manage" } },
        { path: "shipping-templates", component: () => import("@/pages/ShippingTemplates.vue"), meta: { permission: "supplier.shipping.view" } },
        { path: "orders", component: () => import("@/pages/Orders.vue"), meta: { permission: "supplier.order.view" } },
        { path: "refunds", component: () => import("@/pages/Refunds.vue"), meta: { permission: "supplier.refund.view" } },
        { path: "finance", component: () => import("@/pages/Finance.vue"), meta: { permission: "supplier.finance.view" } },
        { path: "printers", component: () => import("@/pages/Printers.vue"), meta: { permission: "supplier.print.view" } },
        { path: "waybills", component: () => import("@/pages/Waybills.vue"), meta: { permission: "supplier.waybill.view" } },
        { path: "settings", component: () => import("@/pages/Settings.vue"), meta: { permission: "supplier.config.view" } },
        { path: "profile", component: () => import("@/pages/Profile.vue"), meta: { permission: "supplier.profile.view" } },
        { path: "administrators", component: () => import("@/pages/Administrators.vue"), meta: { permission: "supplier.admin.view" } },
      ],
    },
    { path: "/:pathMatch(.*)*", redirect: "/dashboard" },
  ],
});

router.beforeEach((to) => {
  if (to.meta.public || previewMode) return true;
  const auth = useAuthStore();
  if (!auth.token) return { path: "/login", query: { redirect: to.fullPath } };
  const permission = typeof to.meta.permission === "string" ? to.meta.permission : "";
  if (permission && !auth.can(permission)) {
    const fallback = protectedDestinations.find((item) => auth.can(item.permission));
    return fallback?.path ?? "/login";
  }
  return true;
});

export default router;
