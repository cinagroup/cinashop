<template>
  <div class="layout">
    <!-- 顶部导航 -->
    <header class="header">
      <div class="container header-inner">
        <router-link to="/" class="logo" aria-label="返回商城首页">
          <img v-if="siteLogo" :src="siteLogo" :alt="siteName" class="logo-img" /><span v-else>{{ siteName }}</span>
        </router-link>
        <nav class="nav" aria-label="商城导航">
          <router-link to="/" class="nav-link">首页</router-link>
          <router-link to="/category" class="nav-link">全部分类</router-link>
          <router-link to="/goods" class="nav-link">全部商品</router-link>
          <router-link to="/seckill" class="nav-link">秒杀</router-link>
          <router-link to="/bargain" class="nav-link">砍价</router-link>
          <router-link to="/combination" class="nav-link">拼团</router-link>
          <router-link to="/presale" class="nav-link">预售</router-link>
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
        <span v-if="company?.copyright">{{ company.copyright }}</span>
        <span v-if="company?.phone">联系电话：{{ company.phone }}</span>
        <span v-if="company?.address">{{ company.address }}</span>
        <nav v-if="company?.links.length" aria-label="友情链接"><a v-for="(link, index) in company.links" :key="index" :href="link.url" rel="noopener noreferrer">{{ link.name }}</a></nav>
        <div v-for="(filing, index) in company?.filings ?? []" :key="index" class="filing"><a v-if="filing.url" :href="filing.url" rel="noopener noreferrer"><img v-if="filing.icon" :src="filing.icon" alt="" />{{ filing.name }}</a><span v-else><img v-if="filing.icon" :src="filing.icon" alt="" />{{ filing.name }}</span></div>
        <span v-if="recordNo">{{ recordNo }}</span>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, onUnmounted, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { useCartStore } from "@/stores/cart";
import type { ShareConfig, SiteConfig } from "@/api/public";
import request, { getData } from '@/utils/request';
import { captureAuthSession, isCurrentAuthSession, onAuthChange } from '@/utils/auth';

import { apiPcCompany, type PcCompany } from '@/api/pcBase';
import { pcBaseMetadataLease } from '@/utils/pcBaseMetadata';
const router = useRouter(), route = useRoute();
const company = ref<PcCompany | null>(null);
let alive = false, metadataActive = true, routeEpoch = 0, readEpoch = 0, controller: AbortController | undefined, ownedTitle: string | undefined;
// A route ABA must never revive the initial global metadata writer. Public
// header/footer data can refresh across child routes; their metadata cannot.
watch(() => route.fullPath, () => { routeEpoch++; metadataActive = false; }, { flush: 'sync' });
const initialRoute = route.fullPath, initialTitle = document.title, metadata = pcBaseMetadataLease(document.head);
function retirePublicRead() { readEpoch++; controller?.abort(); }
const stopAuth = onAuthChange(() => { if (alive) void loadPublicData(); });
onBeforeUnmount(() => {
  alive = false; retirePublicRead(); stopAuth();
});
// Child route owners may restore our previous values during their own
// teardown. Release our still-owned values after those child hooks finish.
onUnmounted(() => {
  metadata.close();
  if (ownedTitle !== undefined && document.title === ownedTitle) document.title = initialTitle;
});
const authStore = useAuthStore();
const cartStore = useCartStore();
const searchWord = ref("");
const recordNo = ref("");
const siteName = ref("CinaShop");
const siteLogo = ref("");

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
  const { serverRevoked, clearedCurrentSession } = await authStore.logout();
  if (!clearedCurrentSession) return;
  if (serverRevoked) ElMessage.success("已退出登录");
  else ElMessage.warning("本机已退出，但服务器会话撤销未确认；旧会话可能持续到过期，如需立即失效请修改密码或联系管理员");
  router.push("/");
}

async function loadPublicData() {
  if (!alive) return;
  retirePublicRead(); controller = new AbortController();
  const own = readEpoch, ownRoute = routeEpoch, session = captureAuthSession(), signal = controller.signal;
  const current = () => alive && own === readEpoch && !signal.aborted && isCurrentAuthSession(session);
  const metadataCurrent = () => current() && metadataActive && ownRoute === routeEpoch && route.fullPath === initialRoute;
  const [site, share, pc] = await Promise.allSettled([
    getData<SiteConfig>(request.get('/site_config', { signal })),
    getData<ShareConfig>(request.get('/share', { signal })),
    apiPcCompany(signal),
  ]);
  if (!current()) return;
  if (site.status === "fulfilled") {
    siteName.value = site.value.site_name || "CinaShop";
    setFavicon(site.value.ico_path);
  }
  if (pc.status === "fulfilled") {
    company.value = pc.value; siteLogo.value = pc.value.logo; recordNo.value = pc.value.recordNo;
    siteName.value = pc.value.siteName || siteName.value;
    if (metadataCurrent()) {
      metadata.set('name', 'description', pc.value.description);
      metadata.set('name', 'keywords', pc.value.keywords);
    }
  }
  if (site.status === "fulfilled" && metadataCurrent() && document.title === (ownedTitle ?? initialTitle)) {
    document.title = siteName.value; ownedTitle = siteName.value;
  }
  if (share.status === "fulfilled" && metadataCurrent()) {
    metadata.set('property', 'og:title', share.value.title || siteName.value);
    metadata.set('property', 'og:description', share.value.synopsis);
    metadata.set('property', 'og:image', share.value.img);
    if (pc.status !== "fulfilled") metadata.set('name', 'description', share.value.synopsis);
  }
}
onMounted(() => {
  alive = true;
  if (authStore.isLoggedIn) {
    cartStore.fetchCount();
    void cartStore.fetchList().catch(() => {});
  }
  void loadPublicData();
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

.footer-inner nav{display:flex;gap:16px;flex-wrap:wrap}.filing img{width:20px;height:20px;object-fit:contain;vertical-align:middle;margin-right:5px}.footer-inner a{color:inherit}.footer-inner {
  display: flex;
  flex-wrap: wrap;
  overflow-wrap: anywhere;
  justify-content: center;
  gap: 24px;
  color: #999;
  font-size: 13px;
}
</style>
