<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Box, DataAnalysis, Goods, List, Menu, Printer, RefreshLeft, Setting, SwitchButton, Tickets, Tools, Wallet } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { previewMode } from "@/api/supplier";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const mobileOpen = ref(false);

const supplierName = computed(
  () => auth.user?.supplier_name || (previewMode ? "优选贸易有限公司" : "供应商中心"),
);

const navigation = [
  { path: "/dashboard", label: "经营概览", icon: DataAnalysis },
  { path: "/products", label: "商品管理", icon: Goods },
  { path: "/shipping-templates", label: "运费模板", icon: Box },
  { path: "/orders", label: "订单管理", icon: List },
  { path: "/refunds", label: "售后管理", icon: RefreshLeft },
  { path: "/finance", label: "财务结算", icon: Wallet },
  { path: "/printers", label: "小票打印机", icon: Printer },
  { path: "/waybills", label: "电子面单", icon: Tickets },
  { path: "/settings", label: "履约配置", icon: Tools },
  { path: "/profile", label: "供应商资料", icon: Setting },
];

async function navigate(path: string) {
  mobileOpen.value = false;
  await router.push(path);
}

async function signOut() {
  mobileOpen.value = false;
  const serverRevoked = await auth.signOut();
  await router.push("/login");
  if (!serverRevoked) {
    ElMessage.warning("本机已退出，但服务器会话撤销未确认；旧会话可能持续到过期，请联系管理员禁用账号或重置密码");
  }
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar" aria-label="供应商后台导航">
      <div class="brand">CinaShop <span>供应商中心</span></div>
      <nav class="main-nav">
        <button
          v-for="item in navigation"
          :key="item.path"
          type="button"
          class="nav-item"
          :class="{ active: route.path === item.path }"
          @click="navigate(item.path)"
        >
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </button>
      </nav>
      <button type="button" class="sidebar-logout" @click="signOut">
        <el-icon><SwitchButton /></el-icon>
        <span>退出登录</span>
      </button>
    </aside>

    <div class="workspace">
      <header class="topbar">
        <button
          type="button"
          class="mobile-menu-button"
          aria-label="打开导航"
          @click="mobileOpen = true"
        >
          <el-icon><Menu /></el-icon>
        </button>
        <div class="mobile-brand">CinaShop <span>供应商中心</span></div>
        <div class="supplier-name">{{ supplierName }}</div>
        <button type="button" class="topbar-logout" @click="signOut">退出登录</button>
      </header>
      <main class="page-content">
        <RouterView />
      </main>
    </div>

    <Transition name="fade">
      <button
        v-if="mobileOpen"
        type="button"
        class="drawer-backdrop"
        aria-label="关闭导航"
        @click="mobileOpen = false"
      />
    </Transition>
    <Transition name="slide">
      <aside v-if="mobileOpen" class="mobile-drawer" aria-label="移动端导航">
        <div class="drawer-title">CinaShop 供应商中心</div>
        <nav>
          <button
            v-for="item in navigation"
            :key="item.path"
            type="button"
            class="drawer-item"
            :class="{ active: route.path === item.path }"
            @click="navigate(item.path)"
          >
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.label }}</span>
          </button>
        </nav>
        <button type="button" class="drawer-item danger" @click="signOut">
          <el-icon><SwitchButton /></el-icon>
          <span>退出登录</span>
        </button>
      </aside>
    </Transition>
  </div>
</template>
