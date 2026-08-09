<template>
  <view class="home">
    <!-- Logo -->
    <view class="logo-wrap">
      <image src="/static/logo.png" class="logo-img" mode="aspectFit" />
    </view>

    <!-- 搜索栏 -->
    <view class="search-bar" @tap="goSearch">
      <text class="search-placeholder">🔍 搜索商品</text>
    </view>

    <!-- 轮播图 Banner -->
    <swiper class="banner-swiper" indicator-dots autoplay circular :interval="4000">
      <swiper-item v-for="(banner, i) in banners" :key="i" @tap="goBanner(banner)">
        <image class="banner-img" :src="banner.image" mode="aspectFill" />
      </swiper-item>
    </swiper>

    <!-- 快捷入口 -->
    <view class="quick-grid">
      <view class="quick-item" @tap="goActivity">
        <text class="quick-icon">🎯</text>
        <text class="quick-text">营销活动</text>
      </view>
      <view class="quick-item" @tap="goSign">
        <text class="quick-icon">✍️</text>
        <text class="quick-text">每日签到</text>
      </view>
      <view class="quick-item" @tap="goCouponCenter">
        <text class="quick-icon">🎁</text>
        <text class="quick-text">领券中心</text>
      </view>
      <view class="quick-item" @tap="goIntegral">
        <text class="quick-icon">🏆</text>
        <text class="quick-text">积分商城</text>
      </view>
    </view>

    <!-- 分类入口 -->
    <scroll-view scroll-x class="cate-scroll" v-if="categories.length">
      <view class="cate-item" v-for="cate in categories" :key="cate.id" @tap="goCate(cate)">
        <image v-if="cate.pic" :src="cate.pic" class="cate-icon" mode="aspectFill" />
        <text class="cate-text">{{ cate.cate_name }}</text>
      </view>
    </scroll-view>

    <!-- 推荐商品 -->
    <view class="section-title">为你推荐</view>
    <view class="goods-grid">
      <view
        class="goods-card"
        v-for="item in goods"
        :key="item.id"
        @tap="goDetail(item.id)"
      >
        <image class="goods-image" :src="item.image || placeholder" mode="aspectFill" />
        <view class="goods-info">
          <view class="goods-name">{{ item.store_name }}</view>
          <view class="goods-bottom">
            <text class="price">¥{{ item.price }}</text>
            <text class="sales">已售 {{ item.sales }}</text>
          </view>
        </view>
      </view>
    </view>

    <view v-if="!goods.length && !loading" class="empty">暂无商品</view>
  </view>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { onPullDownRefresh } from "@dcloudio/uni-app";
import { apiGoodsList, apiCategory } from "@/api/product";
import type { GoodsItem, CategoryNode } from "@/types/product";

const goods = ref<GoodsItem[]>([]);
const categories = ref<CategoryNode[]>([]);
const loading = ref(true);
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

const banners = [
  { image: "https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=750&h=300&fit=crop", link: "/pages/activity/index" },
  { image: "https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=750&h=300&fit=crop", link: "/pages/user/sign" },
  { image: "https://images.unsplash.com/photo-1607083206869-4c7672e72a8a?w=750&h=300&fit=crop", link: "/pages/user/integral" },
];

async function load() {
  loading.value = true;
  try {
    const [g, c] = await Promise.all([
      apiGoodsList({ page: 1, limit: 8 }),
      apiCategory(),
    ]);
    goods.value = g.list;
    categories.value = c.slice(0, 8);
  } catch (e) {
    console.error("首页加载失败", e);
  } finally {
    loading.value = false;
  }
}

function onSearch(e: { detail: { value: string } }) {
  uni.navigateTo({ url: `/pages/goods/list?keyword=${e.detail.value}` });
}

function goSearch() {
  uni.navigateTo({ url: "/pages/goods/search" });
}

function goActivity() {
  uni.navigateTo({ url: "/pages/activity/index" });
}

function goSign() {
  uni.navigateTo({ url: "/pages/user/sign" });
}

function goCouponCenter() {
  uni.navigateTo({ url: "/pages/user/couponCenter" });
}

function goIntegral() {
  uni.navigateTo({ url: "/pages/user/integral" });
}

function goBanner(banner: { link: string }) {
  if (banner.link) uni.navigateTo({ url: banner.link });
}

function goCate(cate: CategoryNode) {
  // cate 是 tabbar 页, navigateTo 会静默失败 → switchTab + storage 定位
  uni.setStorageSync("cate_selected", cate.id);
  uni.switchTab({ url: "/pages/goods/cate" });
}

function goDetail(id: number) {
  uni.navigateTo({ url: `/pages/goods/detail?id=${id}` });
}

onPullDownRefresh(async () => {
  await load();
  uni.stopPullDownRefresh();
});

onMounted(load);
</script>

<style scoped>
.home {
  padding: 20rpx;
}

.logo-wrap {
  display: flex;
  justify-content: center;
  margin-bottom: 20rpx;
}

.logo-img {
  width: 240rpx;
  height: 100rpx;
}

.search-bar {
  background: #fff;
  border-radius: 40rpx;
  padding: 20rpx 30rpx;
  margin-bottom: 20rpx;
}

.search-placeholder {
  font-size: 28rpx;
  color: #999;
}

.activity-entry {
  display: none;
}

.banner-swiper {
  width: 100%;
  height: 300rpx;
  border-radius: 16rpx;
  overflow: hidden;
  margin-bottom: 20rpx;
}

.banner-img {
  width: 100%;
  height: 300rpx;
}

.quick-grid {
  display: flex;
  background: #fff;
  border-radius: 16rpx;
  padding: 20rpx 0;
  margin-bottom: 20rpx;
}

.quick-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10rpx 0;
}

.quick-icon {
  font-size: 48rpx;
  margin-bottom: 8rpx;
}

.quick-text {
  font-size: 22rpx;
  color: #666;
}

.act-icon {
  font-size: 36rpx;
  margin-right: 16rpx;
}

.act-text {
  flex: 1;
  font-size: 28rpx;
  font-weight: 600;
}

.act-arrow {
  font-size: 32rpx;
}

.cate-scroll {
  white-space: nowrap;
  margin-bottom: 20rpx;
}

.cate-item {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  margin-right: 30rpx;
  width: 100rpx;
}

.cate-icon {
  width: 80rpx;
  height: 80rpx;
  border-radius: 50%;
  background: #f8f8f8;
}

.cate-text {
  font-size: 24rpx;
  margin-top: 8rpx;
  color: #555;
}

.section-title {
  font-size: 32rpx;
  font-weight: 600;
  margin: 20rpx 0;
  padding-left: 16rpx;
  border-left: 6rpx solid #e93323;
}
</style>
