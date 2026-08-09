<template>
  <el-container class="admin-layout">
    <!-- 侧边栏 -->
    <el-aside width="200px" class="aside">
      <div class="logo">
        <img src="/logo.png" alt="CinaShop" class="logo-img" />
      </div>
      <el-menu
        :default-active="activeMenu"
        router
        background-color="#001529"
        text-color="rgba(255,255,255,0.65)"
        active-text-color="#fff"
      >
        <el-menu-item index="/dashboard">
          <el-icon><Odometer /></el-icon>
          <span>控制台</span>
        </el-menu-item>
        <el-menu-item index="/product">
          <el-icon><Goods /></el-icon>
          <span>商品管理</span>
        </el-menu-item>
        <el-menu-item index="/order">
          <el-icon><Tickets /></el-icon>
          <span>订单管理</span>
        </el-menu-item>
        <el-menu-item index="/user">
          <el-icon><User /></el-icon>
          <span>用户管理</span>
        </el-menu-item>
        <el-menu-item index="/refund">
          <el-icon><RefreshLeft /></el-icon>
          <span>退款审核</span>
        </el-menu-item>
        <el-menu-item index="/config">
          <el-icon><Setting /></el-icon>
          <span>系统配置</span>
        </el-menu-item>
        <el-menu-item index="/category">
          <el-icon><Folder /></el-icon>
          <span>商品分类</span>
        </el-menu-item>
        <el-menu-item index="/coupon">
          <el-icon><Ticket /></el-icon>
          <span>优惠券管理</span>
        </el-menu-item>
        <el-menu-item index="/activity">
          <el-icon><Present /></el-icon>
          <span>营销活动</span>
        </el-menu-item>
        <el-menu-item index="/kefu">
          <el-icon><ChatDotRound /></el-icon>
          <span>客服会话</span>
        </el-menu-item>
        <el-menu-item index="/reply">
          <el-icon><Star /></el-icon>
          <span>商品评价</span>
        </el-menu-item>
        <el-menu-item index="/brand">
          <el-icon><Collection /></el-icon>
          <span>品牌管理</span>
        </el-menu-item>
        <el-menu-item index="/system">
          <el-icon><UserFilled /></el-icon>
          <span>系统管理</span>
        </el-menu-item>
        <el-menu-item index="/finance/extract">
          <el-icon><Wallet /></el-icon>
          <span>提现审核</span>
        </el-menu-item>
        <el-menu-item index="/finance/bill">
          <el-icon><Tickets /></el-icon>
          <span>财务流水</span>
        </el-menu-item>
        <el-menu-item index="/level">
          <el-icon><Medal /></el-icon>
          <span>会员等级</span>
        </el-menu-item>
        <el-menu-item index="/shipping">
          <el-icon><Van /></el-icon>
          <span>运费模板</span>
        </el-menu-item>
        <el-menu-item index="/express">
          <el-icon><Box /></el-icon>
          <span>快递公司</span>
        </el-menu-item>
        <el-menu-item index="/statistic">
          <el-icon><TrendCharts /></el-icon>
          <span>统计报表</span>
        </el-menu-item>
        <el-menu-item index="/label">
          <el-icon><PriceTag /></el-icon>
          <span>标签管理</span>
        </el-menu-item>
        <el-menu-item index="/content/article">
          <el-icon><Document /></el-icon>
          <span>CMS 文章</span>
        </el-menu-item>
        <el-menu-item index="/content/dise">
          <el-icon><Brush /></el-icon>
          <span>DIY 装修</span>
        </el-menu-item>
        <el-menu-item index="/system/log">
          <el-icon><Tickets /></el-icon>
          <span>操作日志</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <!-- 顶栏 -->
      <el-header class="header">
        <div class="header-left">{{ currentTitle }}</div>
        <div class="header-right">
          <el-badge :value="pushCount.ordernum" :hidden="pushCount.ordernum === 0">
            <el-icon size="20" class="bell-icon"><Bell /></el-icon>
          </el-badge>
          <el-dropdown @command="handleCommand">
            <span class="user-name">
              {{ authStore.userInfo?.account ?? "管理员" }}
              <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
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
import { computed, ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { apiNewPush } from "@/api/auth";

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const pushCount = ref({ ordernum: 0, inventory: 0, commentnum: 0, reflectnum: 0, msgcount: 0 });

const activeMenu = computed(() => {
  const path = route.path;
  if (path.startsWith("/product")) return "/product";
  if (path.startsWith("/order")) return "/order";
  if (path.startsWith("/user")) return "/user";
  if (path.startsWith("/refund")) return "/refund";
  if (path.startsWith("/config")) return "/config";
  if (path.startsWith("/category")) return "/category";
  if (path.startsWith("/coupon")) return "/coupon";
  if (path.startsWith("/activity")) return "/activity";
  if (path.startsWith("/kefu")) return "/kefu";
  if (path.startsWith("/reply")) return "/reply";
  if (path.startsWith("/brand")) return "/brand";
  if (path.startsWith("/system")) return "/system";
  if (path.startsWith("/finance/bill")) return "/finance/bill";
  if (path.startsWith("/finance")) return "/finance/extract";
  if (path.startsWith("/level")) return "/level";
  if (path.startsWith("/shipping")) return "/shipping";
  if (path.startsWith("/express")) return "/express";
  if (path.startsWith("/statistic")) return "/statistic";
  if (path.startsWith("/label")) return "/label";
  if (path.startsWith("/content/article")) return "/content/article";
  if (path.startsWith("/content/dise")) return "/content/dise";
  if (path.startsWith("/system/log")) return "/system/log";
  return "/dashboard";
});

const currentTitle = computed(() => (route.meta.title as string) ?? "控制台");

function handleCommand(cmd: string) {
  if (cmd === "logout") {
    authStore.logout();
    ElMessage.success("已退出登录");
    router.push("/login");
  }
}

onMounted(async () => {
  try {
    pushCount.value = await apiNewPush();
  } catch {
    // ignore
  }
});
</script>

<style scoped>
.admin-layout {
  height: 100vh;
}

.aside {
  background: #001529;
}

.logo {
  color: #fff;
  font-size: 16px;
  font-weight: 600;
  padding: 16px;
  text-align: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.logo-img {
  height: 40px;
  width: auto;
  object-fit: contain;
}

.aside :deep(.el-menu) {
  border-right: none;
}

.header {
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}

.header-left {
  font-size: 16px;
  font-weight: 600;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 20px;
}

.bell-icon {
  cursor: pointer;
}

.user-name {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
}

.main {
  background: #f0f2f5;
  padding: 20px;
}
</style>
