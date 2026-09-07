<template>
  <div class="layout">
    <!-- 顶部导航 -->
    <header class="header">
      <div class="container header-inner">
        <router-link to="/" class="logo" aria-label="返回商城首页">
          <img :src="siteLogo" :alt="siteName" class="logo-img" />
        </router-link>
        <nav class="nav" aria-label="商城导航">
          <router-link to="/" class="nav-link">首页</router-link>
          <router-link to="/category" class="nav-link">全部分类</router-link>
          <router-link to="/goods" class="nav-link">全部商品</router-link>
          <router-link to="/seckill" class="nav-link">秒杀</router-link>
          <router-link to="/bargain" class="nav-link">砍价</router-link>
          <router-link to="/combination" class="nav-link">拼团</router-link>
          <router-link to="/community" class="nav-link">社区</router-link>
          <router-link to="/service" class="nav-link">客服</router-link>
        </nav>
        <form class="search-form" role="search" aria-label="商品搜索" @submit.prevent="doSearch">
          <el-input
            v-model="searchWord"
            placeholder="搜索商品"
            aria-label="搜索商品"
            class="search-input"
          >
            <template #append>
              <el-button native-type="submit">搜索</el-button>
            </template>
          </el-input>
        </form>
        <div class="actions">
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
        <span>© 2026 {{ siteName }}</span>
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
import { getShareConfig, getSiteConfig } from "@/api/public";

const router = useRouter();
const authStore = useAuthStore();
const cartStore = useCartStore();
const searchWord = ref("");
const recordNo = ref("");
const siteName = ref("CinaShop");
const siteLogo = ref("/logo.png");

function setMeta(selector: string, attribute: "name" | "property", key: string, content: string) {
  if (!content) return;
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attribute, key);
    document.head.append(element);
  }
  element.content = content;
}

function setFavicon(url: string) {
  if (!url) return;
  let link = document.head.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.append(link);
  }
  link.href = url;
}

function doSearch() {
  router.push({ path: "/search", query: { keyword: searchWord.value } });
}

async function handleLogout() {
  const serverRevoked = await authStore.logout();
  if (serverRevoked) ElMessage.success("已退出登录");
  else ElMessage.warning("本机已退出，但服务器会话撤销未确认；旧会话可能持续到过期，如需立即失效请修改密码或联系管理员");
  router.push("/");
}

onMounted(async () => {
  if (authStore.isLoggedIn) {
    cartStore.fetchCount();
    cartStore.fetchList();
  }
  const [site, share] = await Promise.allSettled([getSiteConfig(), getShareConfig()]);
  if (site.status === "fulfilled") {
    recordNo.value = site.value.record_No;
    siteName.value = site.value.site_name || "CinaShop";
    siteLogo.value = site.value.site_logo || "/logo.png";
    document.title = siteName.value;
    setFavicon(site.value.ico_path);
  }
  if (share.status === "fulfilled") {
    const title = share.value.title || siteName.value;
    setMeta('meta[property="og:title"]', "property", "og:title", title);
    setMeta('meta[property="og:description"]', "property", "og:description", share.value.synopsis);
    setMeta('meta[property="og:image"]', "property", "og:image", share.value.img);
    setMeta('meta[name="description"]', "name", "description", share.value.synopsis);
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
  display: grid;
  grid-template-areas: "logo nav search account";
  grid-template-columns: auto minmax(0, 1fr) 260px auto;
  align-items: center;
  gap: 16px;
  min-height: 64px;
  padding-block: 10px;
}

.logo {
  grid-area: logo;
  display: flex;
  cursor: pointer;
}

.logo-img {
  height: 40px;
  width: auto;
  object-fit: contain;
}

.nav {
  grid-area: nav;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 16px;
  min-width: 0;
}

.nav-link {
  white-space: nowrap;
  padding-block: 6px;
  color: #333;
  font-size: 15px;
  transition: color 0.2s;
}

.nav-link:hover,
.nav-link.router-link-active {
  color: #e64340;
}

.actions {
  grid-area: account;
  display: flex;
  align-items: center;
  gap: 16px;
}

.search-form {
  grid-area: search;
  min-width: 0;
}

.search-input {
  width: 100%;
}

.action-link {
  white-space: nowrap;
  color: #333;
  font-size: 14px;
}

.action-link:hover {
  color: #e64340;
}

@media (max-width: 1100px) {
  .header-inner {
    grid-template-areas: "logo search account" "nav nav nav";
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 6px 16px;
  }

  .nav {
    justify-content: center;
  }
}

@media (max-width: 600px) {
  .header-inner {
    grid-template-areas: "logo account" "search search" "nav nav";
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px 12px;
    padding-inline: 12px;
  }

  .logo-img {
    height: 34px;
  }

  .nav {
    justify-content: flex-start;
    gap: 0 16px;
  }

  .nav-link {
    font-size: 14px;
    padding-block: 8px;
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
  flex-wrap: wrap;
  overflow-wrap: anywhere;
  justify-content: center;
  gap: 24px;
  color: #999;
  font-size: 13px;
}
</style>
