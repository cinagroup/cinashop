<template>
  <div class="home container">
    <section class="home-banners" aria-label="首页轮播">
      <div v-if="bannerLoading" class="banner-loading"><el-skeleton :rows="2" animated /></div>
      <p v-else-if="bannerError" class="banner-notice" role="status">首页轮播暂时无法读取。</p>
      <el-carousel v-else-if="banners.length" height="clamp(160px, 26vw, 370px)" :interval="5000" :autoplay="banners.length > 1" :arrow="banners.length > 1 ? 'hover' : 'never'" :indicator-position="banners.length > 1 ? '' : 'none'" aria-label="PC 首页轮播图">
        <el-carousel-item v-for="banner in banners" :key="banner.id">
          <router-link v-if="bannerLink(banner)?.kind === 'router'" class="banner-card" :to="bannerLink(banner)!.href" :aria-label="banner.title || '查看轮播内容'"><ProductImage :src="banner.image" :alt="banner.title || '首页轮播'" /><span v-if="banner.title" class="banner-title">{{ banner.title }}</span></router-link>
          <a v-else-if="bannerLink(banner)" class="banner-card" :href="bannerLink(banner)!.href" :aria-label="banner.title || '查看轮播内容'" rel="noopener noreferrer"><ProductImage :src="banner.image" :alt="banner.title || '首页轮播'" /><span v-if="banner.title" class="banner-title">{{ banner.title }}</span></a>
          <div v-else class="banner-card"><ProductImage :src="banner.image" :alt="banner.title || '首页轮播'" /><span v-if="banner.title" class="banner-title">{{ banner.title }}</span></div>
        </el-carousel-item>
      </el-carousel>
    </section>
    <!-- 营销入口 -->
    <div class="marketing-bar">
      <div class="marketing-item" @click="$router.push('/seckill')">
        <span class="marketing-icon">⚡</span>
        <span>限时秒杀</span>
      </div>
      <div class="marketing-item" @click="$router.push('/combination')">
        <span class="marketing-icon">👥</span>
        <span>多人拼团</span>
      </div>
    </div>

    <!-- 推荐商品 -->
    <p v-if="homeError" role="alert">首页商品暂时无法完整读取，请重新加载。</p>
    <section v-for="collection in collections" :key="collection.key" class="section" :aria-label="collection.title">
      <h2 class="section-title">{{ collection.title }} <small v-if="!loading">共 {{ collection.rows.length }} 件</small></h2>
      <div v-if="loading" class="loading">
        <el-skeleton :rows="6" animated />
      </div>
      <div v-else class="goods-grid">
        <div
          v-for="item in collection.rows"
          :key="item.id"
          class="goods-card"
          @click="$router.push(`/goods/${item.id}`)"
        >
          <div class="goods-image">
            <ProductImage :src="item.image" :alt="item.store_name" loading="lazy" />
          </div>
          <div class="goods-info">
            <div class="goods-name">{{ item.store_name }}</div>
            <div class="goods-bottom">
              <span class="price">¥{{ item.price_type && item.vip_price ? item.vip_price : item.price }}</span>
              <span v-if="item.price_type" class="member-price">{{ item.level_name || '会员价' }}</span>
              <span class="sales">已售 {{ item.sales }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 分类快捷入口 -->
    <section class="section">
      <h2 class="section-title">商品分类</h2>
      <div class="cate-grid">
        <div
          v-for="cate in categories"
          :key="cate.id"
          class="cate-card"
          @click="$router.push({ path: '/goods', query: { cid: cate.id } })"
        >
          <img v-if="cate.pic" :src="cate.pic" class="cate-icon" />
          <span class="cate-name">{{ cate.cate_name }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import ProductImage from "@/components/ProductImage.vue";
import { computed, ref, onMounted, onBeforeUnmount } from "vue";
import { apiCategory } from "@/api/product";
import type { GoodsItem, CategoryNode } from "@/types/product";
import { apiPcHomepage } from '@/api/pcBase';
import { captureAuthSession, isCurrentAuthSession, onAuthChange } from '@/utils/auth';
import { apiPcHomeBanners, resolvePcBannerLink, type PcHomeBanner } from '@/api/pcBanner';

const best = ref<GoodsItem[]>([]), fresh = ref<GoodsItem[]>([]), homeError = ref(false);
const collections = computed(() => [{ key: 'best', title: '精品推荐', rows: best.value }, { key: 'new', title: '首发新品', rows: fresh.value }]);
let homeEpoch = 0, homeAbort: AbortController | undefined;
async function loadHome() {
  homeAbort?.abort(); homeAbort = new AbortController(); const controller = homeAbort, epoch = ++homeEpoch, session = captureAuthSession();
  const current = () => alive && epoch === homeEpoch && !controller.signal.aborted && isCurrentAuthSession(session);
  best.value = []; fresh.value = []; loading.value = true; homeError.value = false;
  try { const result = await apiPcHomepage(controller.signal); if (current()) { best.value = result.best; fresh.value = result.fresh; } }
  catch { if (current()) homeError.value = true; }
  finally { if (current()) loading.value = false; }
}
const stopAuth = onAuthChange(() => { if (alive) void loadHome(); });
const categories = ref<CategoryNode[]>([]);
const loading = ref(true);
const banners = ref<PcHomeBanner[]>([]), bannerLoading = ref(true), bannerError = ref(false);
const bannerAbort = new AbortController();
let alive = true;
const bannerLink = (banner: PcHomeBanner) => resolvePcBannerLink(banner.url);

onMounted(async () => {
  try { const result = await apiPcHomeBanners(bannerAbort.signal); if (alive) banners.value = result; }
  catch { if (alive) bannerError.value = true; }
  finally { if (alive) bannerLoading.value = false; }
});
onBeforeUnmount(() => { alive = false; bannerAbort.abort(); homeAbort?.abort(); homeEpoch++; stopAuth(); });

onMounted(() => { void loadHome(); });
onMounted(async () => {
  try { const result = await apiCategory(); if (alive) categories.value = result.slice(0, 8); }
  catch { /* Product categories have an independent public read. */ }
});

</script>

<style scoped>
.home {
  padding-top: 20px;
}
.home-banners{margin-bottom:24px;min-width:0}.banner-card{position:relative;display:block;height:100%;overflow:hidden;background:#f5f5f5;color:#fff;text-decoration:none}.banner-card>.product-media{height:100%;aspect-ratio:auto}.banner-title{position:absolute;right:0;left:0;bottom:0;padding:14px 20px 32px;background:linear-gradient(transparent,rgba(0,0,0,.68));font-size:16px;line-height:1.5;overflow-wrap:anywhere}.banner-loading{padding:20px;background:#fff;min-height:160px}.banner-notice{padding:12px;color:#777;background:#fff;font-size:13px}.home-banners :deep(.el-carousel__indicators--horizontal){display:flex;width:max-content;max-width:100%}
@media(max-width:600px){.home-banners{margin-bottom:16px}.banner-title{padding:12px 14px 32px;font-size:13px}.home-banners :deep(.el-carousel__button){width:15px}.home-banners :deep(.el-carousel__indicator--horizontal){padding-left:3px;padding-right:3px}}

.marketing-bar {
  display: flex;
  gap: 16px;
  margin-bottom: 24px;
}

.marketing-item {
  flex: 1;
  background: linear-gradient(135deg, #ff6a88, #ff9a8b);
  color: #fff;
  border-radius: 12px;
  padding: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.2s;
}

.marketing-item:nth-child(2) {
  background: linear-gradient(135deg, #ff9a45, #ffd36e);
}

.marketing-item:hover {
  transform: translateY(-2px);
}

.marketing-icon {
  font-size: 24px;
}

.section {
  margin-bottom: 32px;
}

.section-title {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 16px;
  padding-left: 10px;
  border-left: 4px solid #e64340;
}

.goods-card {
  background: #fff;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
}

.goods-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
}

.goods-image {
  aspect-ratio: 1;
  overflow: hidden;
  background: #f8f8f8;
}

.goods-image > .product-media {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.goods-info {
  padding: 12px;
}

.goods-name {
  font-size: 14px;
  line-height: 1.4;
  height: 40px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.goods-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
}

.price {
  color: #e64340;
  font-size: 18px;
  font-weight: 600;
}

.sales {
  color: #999;
  font-size: 12px;
}

.cate-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 16px;
}

.cate-card {
  background: #fff;
  border-radius: 8px;
  padding: 20px 10px;
  text-align: center;
  cursor: pointer;
  transition: box-shadow 0.2s;
}

.cate-card:hover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
}

.cate-icon {
  width: 48px;
  height: 48px;
  object-fit: contain;
  margin-bottom: 8px;
}

.cate-name {
  font-size: 13px;
  color: #555;
}
</style>
