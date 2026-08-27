<template>
  <div class="layout">
    <!-- 顶部导航 -->
    <header class="header">
      <div class="container header-inner">
        <div class="logo" @click="$router.push('/')">
          <img src="/logo.png" alt="CinaShop" class="logo-img" />
        </div>
        <nav class="nav">
          <router-link to="/" class="nav-link">首页</router-link>
          <router-link to="/category" class="nav-link">全部分类</router-link>
          <router-link to="/goods" class="nav-link">全部商品</router-link>
          <router-link to="/seckill" class="nav-link">秒杀</router-link>
          <router-link to="/bargain" class="nav-link">砍价</router-link>
          <router-link to="/combination" class="nav-link">拼团</router-link>
          <router-link to="/community" class="nav-link">社区</router-link>
        </nav>
        <div class="actions">
          <el-input
            v-model="searchWord"
            placeholder="搜索商品"
            class="search-input"
            @keyup.enter="doSearch"
          >
            <template #append>
              <el-button @click="doSearch">搜索</el-button>
            </template>
          </el-input>
          <router-link to="/cart" class="action-link">
            <el-badge :value="cartStore.count" :hidden="cartStore.count === 0">
              购物车
            </el-badge>
          </router-link>
          <template v-if="authStore.isLoggedIn">
            <router-link to="/user" class="action-link">个人中心</router-link>
            <el-button link @click="handleLogout">退出</el-button>
          </template>
          <router-link v-else to="/login" class="action-link">登录</router-link>
        </div>
      </div>
    </header>

    <!-- 主体 -->
    <main class="main">
      <router-view />
    </main>

    <!-- 页脚 -->
    <footer class="footer">
      <div class="container footer-inner">
        <span>© 2026 CinaShop</span>
        <span v-if="recordNo">{{ recordNo }}</span>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { useCartStore } from "@/stores/cart";
import { getSiteConfig } from "@/api/public";

const router = useRouter();
const authStore = useAuthStore();
const cartStore = useCartStore();
const searchWord = ref("");
const recordNo = ref("");

function doSearch() {
  router.push({ path: "/search", query: { keyword: searchWord.value } });
}

async function handleLogout() {
  await authStore.logout();
  ElMessage.success("已退出登录");
  router.push("/");
}

onMounted(async () => {
  if (authStore.isLoggedIn) {
    cartStore.fetchCount();
    cartStore.fetchList();
  }
  try {
    const config = await getSiteConfig();
    recordNo.value = config.record_No;
  } catch {
    // ignore
  }
});
</script>

<style scoped>
.header {
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
  position: sticky;
  top: 0;
  z-index: 100;
}

.header-inner {
  display: flex;
  align-items: center;
  gap: 24px;
  height: 64px;
}

.logo {
  cursor: pointer;
}

.logo-img {
  height: 40px;
  width: auto;
  object-fit: contain;
}

.nav {
  display: flex;
  gap: 20px;
}

.nav-link {
  color: #333;
  font-size: 15px;
  transition: color 0.2s;
}

.nav-link:hover,
.nav-link.router-link-active {
  color: #e64340;
}

.actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 16px;
}

.search-input {
  width: 260px;
}

.action-link {
  color: #333;
  font-size: 14px;
}

.action-link:hover {
  color: #e64340;
}

@media (max-width: 768px) {
  .header-inner {
    height: 56px;
    gap: 10px;
    padding-inline: 12px;
  }

  .logo-img {
    height: 34px;
  }

  .nav,
  .search-input {
    display: none;
  }

  .actions {
    min-width: 0;
    gap: 10px;
  }

  .action-link {
    white-space: nowrap;
    font-size: 13px;
  }
}

.main {
  min-height: calc(100vh - 150px);
}

.footer {
  background: #fff;
  padding: 20px 0;
  margin-top: 40px;
}

.footer-inner {
  display: flex;
  justify-content: center;
  gap: 24px;
  color: #999;
  font-size: 13px;
}
</style>
