<template>
  <el-container class="admin-layout">
    <!-- 侧边栏 -->
    <el-aside :width="navigationCollapsed ? '64px' : '200px'" class="aside">
      <div class="logo">
        <img src="/logo.png" alt="CinaShop" class="logo-img" />
      </div>
      <AdminSidebarNavigation :active="activeMenu" :collapsed="navigationCollapsed" :can-menu="canMenu" />
    </el-aside>

    <el-container>
      <!-- 顶栏 -->
      <el-header class="header">
        <div class="header-left">
          <el-button v-if="!compactNavigation" class="navigation-toggle" text circle
            :aria-label="desktopNavigationCollapsed ? '展开导航' : '收起导航'"
            :aria-expanded="!desktopNavigationCollapsed" @click="desktopNavigationCollapsed = !desktopNavigationCollapsed">
            <el-icon><Expand v-if="desktopNavigationCollapsed" /><Fold v-else /></el-icon>
          </el-button>
          <span>{{ currentTitle }}</span>
        </div>
        <div class="header-right">
          <AdminTodoBell :key="authStore.token" />
          <AdminStockNotice :key="authStore.token" />
          <el-dropdown @command="handleCommand">
            <span class="user-name">
              {{ authStore.userInfo?.account ?? "管理员" }}
              <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="profile">个人中心</el-dropdown-item>
                <el-dropdown-item command="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <!-- 主体 -->
      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import AdminTodoBell from "./AdminTodoBell.vue";
import AdminStockNotice from './AdminStockNotice.vue';

import AdminSidebarNavigation from './AdminSidebarNavigation.vue';
import { exactAdminMenuPath } from '@/utils/adminNavigation';

const navigationMedia = window.matchMedia('(max-width: 768px)');
const compactNavigation = ref(navigationMedia.matches);
const desktopNavigationCollapsed = ref(false);
const navigationCollapsed = computed(() => compactNavigation.value || desktopNavigationCollapsed.value);
const updateCompactNavigation = () => { compactNavigation.value = navigationMedia.matches; };
onMounted(() => navigationMedia.addEventListener('change', updateCompactNavigation));
onBeforeUnmount(() => navigationMedia.removeEventListener('change', updateCompactNavigation));

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
const allowedMenuPaths = computed(() => new Set(authStore.menus.map((menu) => menu.path)));

function canMenu(path: string): boolean {
  if (path === "/system/frontend-log") return authStore.isLoggedIn;
  if (previewMode || !authStore.userInfo || authStore.userInfo.level === 0) return true;
  return allowedMenuPaths.value.has(path);
}

const activeMenu = computed(() => {
  const path = route.matched.at(-1)?.aliasOf?.path ?? route.path;
  const exact = exactAdminMenuPath(path);
  if (exact) return exact;
  if (path === "/label/products" || path === "/admin/product/label") return "/label/products";
  if (path.startsWith("/product")) return "/product";
  if (path === "/order/offline") return "/order/offline";
  if (path === "/order/invoice") return "/order/invoice";
  if (path.startsWith("/order")) return "/order";
  if (path.startsWith("/user/groups")) return "/user/groups";
  if (path.startsWith("/user")) return "/user";
  if (path.startsWith("/community")) return "/community";
  if (path.startsWith("/member")) return "/member";
  if (path.startsWith("/supplier/applications")) return "/supplier/applications";
  if (path.startsWith("/supplier/menu-rules")) return "/supplier/menu-rules";
  if (path.startsWith("/supplier/bills")) return "/supplier/bills";
  if (path.startsWith("/supplier/capital-flow")) return "/supplier/capital-flow";
  if (path.startsWith("/supplier/order-statistics")) return "/supplier/order-statistics";
  if (path.startsWith("/refund")) return "/refund";
  if (path.startsWith("/operations/outbox")) return "/operations/outbox";
  if (path.startsWith("/operations/legacy-runtime")) return "/operations/legacy-runtime";
  if (path.startsWith("/operations/work")) return "/operations/work";
  if (path.startsWith("/operations/store")) return "/operations/store";
  if (path.startsWith("/operations/writeoff-orders")) return "/operations/writeoff-orders";
  if (path.startsWith("/config/newcomer")) return "/config/newcomer";
  if (path.startsWith("/config/level-activation")) return "/config/level-activation";
  if (path.startsWith("/config/paid-membership")) return "/config/paid-membership";
  if (path.startsWith("/config/runtime-content")) return "/config/runtime-content";
  if (path.startsWith("/config")) return "/config";
  if (path.startsWith("/assets")) return "/assets";
  if (path.startsWith("/category")) return "/category";
  if (path.startsWith("/coupon")) return "/coupon";
  if (path.startsWith("/marketing/coupon-records")) return "/marketing/coupon-records";
  if (path.startsWith("/marketing/coupon-templates")) return "/marketing/coupon-templates";
  if (path.startsWith("/activity/seckill-statistics")) return "/activity/seckill-statistics";
  if (path.startsWith("/activity/seckill-times")) return "/activity/seckill-times";
  if (path.startsWith("/activity/seckill-activities")) return "/activity/seckill-activities";
  if (path.startsWith("/activity/combinations")) return "/activity/combinations";
  if (path.startsWith("/activity/combination-groups")) return "/activity/combination-groups";
  if (path.startsWith("/activity/combination-statistics")) return "/activity/combination-statistics";
  if (path.startsWith("/activity/integral-batch")) return "/activity/integral-batch";
  if (path.startsWith("/activity")) return "/activity";
  if (path.startsWith("/marketing/lottery-records")) return "/marketing/lottery-records";
  if (path.startsWith("/marketing/lottery")) return "/marketing/lottery";
  if (path.startsWith("/marketing/activity-frame")) return "/marketing/activity-frame";
  if (path.startsWith("/marketing/activity-background")) return "/marketing/activity-background";
  if (path.startsWith("/marketing/time-discounts")) return "/marketing/time-discounts";
  if (path.startsWith("/marketing/full-discounts")) return "/marketing/full-discounts";
  if (path.startsWith("/marketing/nth-discounts")) return "/marketing/nth-discounts";
  if (path.startsWith("/marketing/full-gifts")) return "/marketing/full-gifts";
  if (path.startsWith("/marketing/live")) return "/marketing/live";
  if (path.startsWith("/marketing/user-point")) return "/marketing/user-point";
  if (path.startsWith("/marketing/point-statistic")) return "/marketing/point-statistic";
  if (path.startsWith("/marketing/recharge-options")) return "/marketing/recharge-options";
  if (path.startsWith("/marketing/integral-categories")) return "/marketing/integral-categories";
  if (path.startsWith("/marketing/sign-rewards")) return "/marketing/sign-rewards";
  if (path.startsWith("/marketing/sign-day-config")) return "/marketing/sign-day-config";
  if (path.startsWith("/system/out")) return "/system/out";
  if (path.startsWith("/kefu/feedback")) return "/kefu/feedback";
  if (path.startsWith("/kefu/speechcraft")) return "/kefu/speechcraft";
  if (path.startsWith("/kefu")) return "/kefu";
  if (path.startsWith("/reply")) return "/reply";
  if (path.startsWith("/brand")) return "/brand";
  if (path.startsWith("/system/log")) return "/system/log";
  if (path === "/system/legacy-staff") return "/system/legacy-staff";
  if (path === "/system/legacy-roles") return "/system/legacy-roles";
  if (path.startsWith("/system")) return "/system";
  if (path.startsWith("/finance/supplier-extract")) return "/finance/supplier-extract";
  if (path.startsWith("/finance/recharges")) return "/finance/recharges";
  if (path.startsWith("/finance/commissions")) return "/finance/commissions";
  if (path.startsWith("/finance/capital-flow")) return "/finance/capital-flow";
  if (path.startsWith("/finance/bill")) return "/finance/bill";
  if (path.startsWith("/finance")) return "/finance/extract";
  if (path.startsWith("/level")) return "/level";
  if (path.startsWith("/shipping")) return "/shipping";
  if (path.startsWith("/express")) return "/express";
  if (path.startsWith("/statistic")) return "/statistic";
  if (path.startsWith("/label")) return "/label";
  if (path.startsWith("/content/article")) return "/content/article";
  if (path.startsWith("/content/wechat-card")) return "/content/wechat-card";
  if (path.startsWith("/content/wechat-qrcode")) return "/content/wechat-qrcode";
  if (path.startsWith("/content/wechat")) return "/content/wechat";
  if (path.startsWith("/content/dise")) return "/content/dise";
  if (path.startsWith("/agent/promoter-applications")) return "/agent/promoter-applications";
  if (path.startsWith("/agent")) return "/agent";
  if (path.startsWith("/division/statistics")) return "/division/statistics";
  if (path.startsWith("/division")) return "/division";
  if (path.startsWith("/setting/shipping")) return "/setting/shipping";
  if (path.startsWith("/setting/city-delivery-records")) return "/setting/city-delivery-records";
  if (path.startsWith("/setting/city-delivery-settings") || path === "/admin/setting/city/delivery/setting") return "/setting/city-delivery-settings";
  if (path.startsWith("/setting/pc-banner")) return "/setting/pc-banner";
  if (path.startsWith('/setting/operational-groups')) return '/setting/operational-groups';
  if (path.startsWith("/setting/product-category-style") || path === "/admin/setting/pages/product_category") return "/setting/product-category-style";
  if (path.startsWith("/setting/product-detail-design") || path === "/admin/setting/pages/product_detail") return "/setting/product-detail-design";
  if (path.startsWith("/setting/user-center-design") || path === "/admin/setting/pages/home") return "/setting/user-center-design";
  if (path.startsWith("/setting/theme-style") || path === "/admin/setting/theme_style") return "/setting/theme-style";
  if (path.startsWith("/setting/fab")) return "/setting/fab";
  if (path.startsWith("/setting/distributor-levels/tasks")) return "/setting/distributor-levels/tasks";
  if (path.startsWith("/setting/distributor-levels")) return "/setting/distributor-levels";
  if (path.startsWith("/setting/print")) return "/setting/print";
  if (path.startsWith("/setting/waybill")) return "/setting/waybill";
  if (path.startsWith("/setting")) return "/setting/notification";
  return "/dashboard";
});

const currentTitle = computed(() => (route.meta.title as string) ?? "控制台");

function handleCommand(cmd: string) {
  if (cmd === 'profile') { void router.push('/system/profile'); return; }
  if (cmd === "logout") {
    authStore.logout();
    ElMessage.success("已退出登录");
    router.push("/login");
  }
}

</script>

<style scoped>
.admin-layout {
  height: 100vh;
  width: 100%;
  overflow: hidden;
}

.admin-layout > .el-container {
  min-width: 0;
  overflow: hidden;
}

.aside {
  background: #fff;
  border-right: 1px solid #e8eaec;
  overflow-y: auto;
  overflow-x: hidden;
}

.logo {
  color: #17233d;
  font-size: 16px;
  font-weight: 600;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-bottom: 1px solid #e8eaec;
}

.logo-img {
  height: 40px;
  width: auto;
  object-fit: contain;
}

.aside :deep(.el-menu) {
  border-right: none;
}

.aside :deep(.el-menu-item),
.aside :deep(.el-sub-menu__title) {
  height: 52px;
  line-height: 52px;
}

.aside :deep(.el-menu-item .el-icon),
.aside :deep(.el-sub-menu__title > .el-icon:not(.el-sub-menu__icon-arrow)) {
  width: 24px;
  margin-right: 8px;
}

.aside :deep(.el-menu-item:hover),
.aside :deep(.el-menu-item.is-active) {
  background: #f3f8fe;
}

.aside :deep(.el-menu-item.is-active) {
  border-right: 3px solid #2d8cf0;
}

.header {
  --el-header-height: 64px;
  color: #fff;
  background: linear-gradient(to right, #1d42ab, #2173dc, #1e93ff);
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  font-size: 16px;
  font-weight: 600;
}

.navigation-toggle {
  color: #fff;
  font-size: 20px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 20px;
}

.user-name {
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
}

.main {
  background: #f0f2f5;
  min-width: 0;
  overflow-x: hidden;
  padding: 20px;
}

@media (max-width: 768px) {
  .aside {
    width: 64px !important;
  }

  .admin-layout > .el-container {
    flex: 0 0 calc(100vw - 64px);
    width: calc(100vw - 64px);
    max-width: calc(100vw - 64px);
  }

  .logo {
    padding: 12px 4px;
  }

  .logo-img {
    height: 32px;
    max-width: 52px;
  }

  .aside :deep(.el-menu-item) {
    justify-content: center;
    padding: 0 !important;
  }


  .header {
    padding: 0 12px;
  }

  .header-left {
    max-width: 132px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .header-right {
    gap: 10px;
  }

  .main {
    width: 100%;
    max-width: 100%;
    padding: 10px;
  }
}
</style>
