<template>
  <view class="article-page">
    <swiper
      v-if="banners.length"
      class="banner"
      indicator-dots
      autoplay
      circular
      :interval="4000"
    >
      <swiper-item v-for="item in banners" :key="item.id" @tap="goDetail(item.id)">
        <image class="banner-image" :src="coverOf(item)" mode="aspectFill" />
        <view class="banner-shade">
          <text class="banner-title">{{ item.title }}</text>
        </view>
      </swiper-item>
    </swiper>

    <scroll-view v-if="categories.length" scroll-x class="category-scroll" show-scrollbar="false">
      <view class="category-row">
        <view
          v-for="category in categories"
          :key="category.id"
          class="category-tab"
          :class="{ active: activeCategory === category.id }"
          @tap="switchCategory(category.id)"
        >
          {{ category.title }}
        </view>
      </view>
    </scroll-view>

    <view class="article-list">
      <view
        v-for="item in articles"
        :key="item.id"
        class="article-row"
        @tap="goDetail(item.id)"
      >
        <image class="article-cover" :src="coverOf(item)" mode="aspectFill" />
        <view class="article-copy">
          <view class="article-title">{{ item.title }}</view>
          <view v-if="item.synopsis" class="article-synopsis">{{ item.synopsis }}</view>
          <view class="article-meta">
            <text>{{ item.add_time }}</text>
            <text>{{ item.visit }} 次阅读</text>
          </view>
        </view>
      </view>
    </view>

    <view v-if="errorMessage && !articles.length" class="state-block">
      <text>{{ errorMessage }}</text>
      <view class="retry" @tap="refreshAll">重新加载</view>
    </view>
    <view v-else-if="!loading && !articles.length" class="state-block">暂无资讯</view>
    <view v-else-if="articles.length" class="load-state" @tap="loadMore">
      {{ loading ? "加载中..." : hasMore ? "加载更多" : "没有更多了" }}
    </view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { ref } from "vue";
import { onLoad, onPullDownRefresh, onReachBottom } from "@dcloudio/uni-app";
import {
  apiArticleBannerList,
  apiArticleCategoryList,
  apiArticleHotList,
  apiArticleList,
  type ArticleCategory,
  type ArticleListItem,
} from "@/api/article";

const PAGE_SIZE = 10;
const BANNER_LIMIT = 5;
const FALLBACK_COVER =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='480' height='300'%3E%3Crect fill='%23eeeeee' width='100%25' height='100%25'/%3E%3Cpath d='M190 182l34-42 28 32 18-20 40 48H170z' fill='%23cccccc'/%3E%3C/svg%3E";

const categories = ref<ArticleCategory[]>([{ id: 0, title: "热门" }]);
const banners = ref<ArticleListItem[]>([]);
const articles = ref<ArticleListItem[]>([]);
const activeCategory = ref(0);
const page = ref(1);
const loading = ref(false);
const hasMore = ref(true);
const errorMessage = ref("");
let requestVersion = 0;

function coverOf(item: ArticleListItem): string {
  return item.image_input.find((image) => image.trim().length > 0) ?? FALLBACK_COVER;
}

async function loadPage(reset = false): Promise<void> {
  if (!reset && (loading.value || !hasMore.value)) return;

  if (reset) {
    requestVersion += 1;
    page.value = 1;
    articles.value = [];
    hasMore.value = true;
    errorMessage.value = "";
  }

  const version = requestVersion;
  const categoryId = activeCategory.value;
  const requestedPage = page.value;
  loading.value = true;

  try {
    const params = { page: requestedPage, limit: PAGE_SIZE };
    const rows = categoryId === 0
      ? await apiArticleHotList(params)
      : await apiArticleList(categoryId, params);
    if (version !== requestVersion || categoryId !== activeCategory.value) return;
    articles.value = articles.value.concat(rows);
    page.value = requestedPage + 1;
    hasMore.value = rows.length >= PAGE_SIZE;
  } catch (error) {
    if (version !== requestVersion) return;
    errorMessage.value = error instanceof Error ? error.message : "资讯加载失败";
  } finally {
    if (version === requestVersion) loading.value = false;
  }
}

async function loadNavigation(): Promise<void> {
  const [categoryResult, bannerResult] = await Promise.allSettled([
    apiArticleCategoryList(),
    apiArticleBannerList({ page: 1, limit: BANNER_LIMIT }),
  ]);

  if (categoryResult.status === "fulfilled" && categoryResult.value.length) {
    const hasHot = categoryResult.value.some((category) => category.id === 0);
    categories.value = hasHot
      ? categoryResult.value
      : [{ id: 0, title: "热门" }, ...categoryResult.value];
  }
  banners.value = bannerResult.status === "fulfilled" ? bannerResult.value : [];
}

async function refreshAll(): Promise<void> {
  await Promise.all([loadNavigation(), loadPage(true)]);
}

function switchCategory(id: number): void {
  if (activeCategory.value === id) return;
  activeCategory.value = id;
  void loadPage(true);
}

function loadMore(): void {
  void loadPage();
}

function goDetail(id: number): void {
  uni.navigateTo({ url: `/pages/article/detail?id=${id}` });
}

onLoad(() => {
  void refreshAll();
});

onPullDownRefresh(async () => {
  await refreshAll();
  uni.stopPullDownRefresh();
});

onReachBottom(loadMore);
</script>

<style scoped>
.article-page {
  min-height: 100vh;
  padding: 20rpx;
  background: #f5f5f5;
  box-sizing: border-box;
}

.banner {
  width: 100%;
  height: 320rpx;
  margin-bottom: 20rpx;
  overflow: hidden;
  border-radius: 16rpx;
  background: #eee;
}

.banner-image {
  width: 100%;
  height: 100%;
}

.banner-shade {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  padding: 56rpx 28rpx 24rpx;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.64));
}

.banner-title {
  display: block;
  overflow: hidden;
  color: #fff;
  font-size: 30rpx;
  font-weight: 600;
  line-height: 42rpx;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.category-scroll {
  margin-bottom: 20rpx;
  border-radius: 16rpx;
  background: #fff;
  white-space: nowrap;
}

.category-row {
  display: inline-flex;
  min-width: 100%;
  padding: 0 12rpx;
  box-sizing: border-box;
}

.category-tab {
  position: relative;
  flex-shrink: 0;
  padding: 26rpx 24rpx 24rpx;
  color: #777;
  font-size: 28rpx;
  line-height: 36rpx;
}

.category-tab.active {
  color: #222;
  font-weight: 600;
}

.category-tab.active::after {
  position: absolute;
  bottom: 10rpx;
  left: 50%;
  width: 36rpx;
  height: 5rpx;
  border-radius: 3rpx;
  background: #e93323;
  content: "";
  transform: translateX(-50%);
}

.article-list {
  overflow: hidden;
  border-radius: 16rpx;
  background: #fff;
}

.article-row {
  display: flex;
  gap: 22rpx;
  padding: 24rpx;
  border-bottom: 1rpx solid #f0f0f0;
}

.article-row:last-child {
  border-bottom: 0;
}

.article-cover {
  flex-shrink: 0;
  width: 220rpx;
  height: 150rpx;
  border-radius: 12rpx;
  background: #eee;
}

.article-copy {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
}

.article-title {
  display: -webkit-box;
  overflow: hidden;
  color: #222;
  font-size: 29rpx;
  font-weight: 600;
  line-height: 41rpx;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.article-synopsis {
  margin-top: 8rpx;
  overflow: hidden;
  color: #888;
  font-size: 23rpx;
  line-height: 32rpx;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.article-meta {
  display: flex;
  justify-content: space-between;
  margin-top: auto;
  color: #aaa;
  font-size: 21rpx;
  line-height: 30rpx;
}

.state-block,
.load-state {
  padding: 56rpx 20rpx;
  color: #999;
  font-size: 25rpx;
  text-align: center;
}

.retry {
  width: 180rpx;
  margin: 24rpx auto 0;
  padding: 14rpx 0;
  border: 1rpx solid #e93323;
  border-radius: 32rpx;
  color: #e93323;
}
</style>
