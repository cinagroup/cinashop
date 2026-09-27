<template>
  <view class="history-page">
    <view class="history-header">
      <view><view class="heading">我的足迹</view><text class="hint">按最近浏览时间排列 · 共 {{ total }} 件商品</text></view>
      <button v-if="items.length" class="small-button" :disabled="blocked" @tap="toggleManage">{{ managing ? '取消管理' : '管理' }}</button>
    </view>
    <view v-if="!loggedIn" class="notice"><text>登录后查看自己的浏览记录</text><button @tap="login">去登录</button></view>
    <view v-else>
      <view v-if="error" class="notice error" role="alert"><text>{{ error }}</text></view>
      <view class="actions"><button class="small-button" :disabled="deleting || collecting" @tap="load()">刷新记录</button></view>
      <view v-if="managing" class="manage-panel">
        <text>已选择 {{ selected.length }} 件；仅选择已加载记录，删除上限 200 件，收藏上限 100 件</text>
        <view class="manage-actions"><button :disabled="blocked" @tap="toggleAll">{{ selected.length ? '取消选择' : '选择已加载' }}</button>
          <button :disabled="blocked || !selected.length" @tap="collectSelected">{{ collecting ? '正在收藏…' : '加入收藏' }}</button>
          <button class="delete-button" :disabled="blocked || !selected.length" @tap="removeSelected">{{ deleting ? '正在删除…' : `删除所选 (${selected.length})` }}</button></view>
      </view>
      <view v-for="group in groups" :key="group.time" class="day-group">
        <view class="date-label">{{ group.time }}</view>
        <view class="product-grid">
          <view v-for="item in group.products" :key="item.productId" class="product-card" :class="{ selected: selected.includes(item.productId) }" @tap="openProduct(item.productId)">
            <image v-if="item.image && !failedImages.includes(item.image)" class="product-image" :src="item.image" mode="aspectFill" @error="failImage(item.image)" />
            <view v-else class="product-image image-placeholder">暂无商品图片</view>
            <view class="product-info"><text class="product-name">{{ item.name || '未命名商品' }}</text><view class="price">¥{{ item.price }}</view>
              <text v-if="!item.visible" class="availability">已下架</text><text v-else-if="!item.stock" class="availability">暂时售罄</text></view>
            <button v-if="managing" class="select-button" :disabled="blocked" @tap.stop="toggle(item.productId)">{{ selected.includes(item.productId) ? '已选择' : '选择' }}</button>
          </view>
        </view>
      </view>
      <view v-if="loading" class="empty">正在加载浏览记录…</view>
      <view v-else-if="loaded && !items.length && !error" class="empty">暂无浏览记录，去逛逛喜欢的商品吧</view>
      <view v-if="loaded && !loading && !items.length && !error" class="recommendations">
        <view class="date-label">为你推荐</view>
        <text class="hint">商品展示价；会员资格与优惠以详情和结算为准</text>
        <view v-if="recommendationError" class="notice error" role="alert"><text>{{ recommendationError }}</text></view>
        <view class="product-grid recommendation-grid">
          <view v-for="item in recommendations" :key="item.productId" class="product-card recommendation-card" @tap="openRecommendation(item.productId)">
            <VisitRecommendationImage :item="item" />
            <view class="product-info">
              <text v-if="item.brand" class="brand-name">{{ item.brand }}</text>
              <text class="product-name">{{ item.name || '未命名商品' }}</text>
              <view v-if="item.labels.length" class="product-labels">
                <view v-for="label in item.labels" :key="label.id" class="product-label" :style="{ color: label.color, backgroundColor: label.background, borderColor: label.border }">
                  <image v-if="label.icon && !failedImages.includes(label.icon)" class="label-icon" :src="label.icon" mode="aspectFit" @error="failImage(label.icon)" />
                  <text>{{ label.name }}</text>
                </view>
              </view>
              <view class="price">¥{{ item.price }}</view>
              <view v-if="item.offer" class="member-offer">{{ item.offer.label }} ¥{{ item.offer.price }}</view>
              <text v-if="!item.stock" class="availability">暂时售罄</text>
              <text v-if="item.navigationHint" class="navigation-note">{{ item.navigationHint }}</text>
            </view>
          </view>
        </view>
        <view v-if="recommendationLoading" class="empty">正在加载推荐商品…</view>
        <button v-else-if="recommendationHasMore" class="more-button" @tap="loadRecommendations">{{ recommendationError ? '重试推荐本页' : '加载更多推荐' }}</button>
        <text v-else-if="recommendationLoaded" class="end">{{ recommendations.length ? '推荐商品已加载完毕' : '暂无推荐商品' }}</text>
      </view>
      <button v-if="hasMore && !uncertain" class="more-button" :disabled="loading || deleting || collecting || confirming" @tap="load(true)">{{ error ? '重试加载本页' : '加载更多' }}</button>
      <text v-else-if="items.length && !loading && !error" class="end">已显示全部可读记录</text>
    </view>
    <DiySuspendedNavigation />
  </view>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useVisitHistory } from "@/composables/useVisitHistory";
import VisitRecommendationImage from "@/components/VisitRecommendationImage.vue";
const { items, total, groups, loading, loaded, error, hasMore, managing, selected, confirming, deleting, collecting, uncertain,
  loggedIn, blocked, load, toggleManage, toggle, toggleAll, openProduct, removeSelected, collectSelected, login,
  recommendations, recommendationLoading, recommendationLoaded, recommendationError, recommendationHasMore, loadRecommendations, openRecommendation } = useVisitHistory();
const failedImages = ref<string[]>([]);
watch(items, rows => { if (!rows.length) failedImages.value = []; }, { flush: "sync" });
function failImage(url: string) { if (!failedImages.value.includes(url)) failedImages.value.push(url); }
</script>

<style scoped>
.history-page { max-width: 960px; margin: 0 auto; padding: 24rpx 24rpx 100rpx; box-sizing: border-box; }
.history-header, .manage-actions { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; }
.heading { font-size: 38rpx; font-weight: 700; color: #282828; }
.hint, .availability { font-size: 24rpx; color: #666; }
.small-button { margin: 0; font-size: 26rpx; flex-shrink: 0; }
.actions { display: flex; justify-content: flex-end; margin: 20rpx 0; }
.notice, .manage-panel { background: #fff; padding: 24rpx; margin: 20rpx 0; border-radius: 16rpx; font-size: 26rpx; }
.notice button { margin-top: 20rpx; }.error { color: #9b241e; background: #fff1ef; overflow-wrap: anywhere; }
.manage-actions { margin-top: 16rpx; flex-wrap: wrap; }.manage-actions button { flex: 1; min-width: 180rpx; font-size: 24rpx; }
.delete-button { color: #fff; background: #c83226; }
.day-group { margin: 28rpx 0; }.date-label { font-size: 28rpx; font-weight: 600; margin-bottom: 18rpx; }
.product-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20rpx; }
.product-card { min-width: 0; background: #fff; border: 2rpx solid transparent; border-radius: 16rpx; overflow: hidden; }
.product-card.selected { border-color: #c83226; }.product-image { display: block; width: 100%; height: 280rpx; }
.image-placeholder { background: #ededed; color: #777; display: flex; justify-content: center; align-items: center; font-size: 24rpx; }
.product-info { padding: 16rpx; }.product-name { display: block; overflow-wrap: anywhere; font-size: 26rpx; line-height: 1.5; }
.price { color: #bd3025; font-size: 30rpx; font-weight: 600; margin-top: 8rpx; }.select-button { font-size: 24rpx; margin: 0 16rpx 16rpx; }
.empty, .end { display: block; text-align: center; color: #777; padding: 40rpx 8rpx; font-size: 26rpx; }.more-button { font-size: 28rpx; }
.recommendation-grid { margin: 20rpx 0; }
.brand-name { display: block; font-size: 22rpx; font-weight: 600; color: #555; overflow-wrap: anywhere; margin-bottom: 6rpx; }
.product-labels { display: flex; flex-wrap: wrap; gap: 8rpx; margin-top: 12rpx; }
.product-label { display: inline-flex; align-items: center; gap: 6rpx; max-width: 100%; padding: 2rpx 8rpx; border: 1rpx solid; border-radius: 6rpx; box-sizing: border-box; font-size: 20rpx; overflow-wrap: anywhere; }
.product-label text { min-width: 0; }.label-icon { width: 24rpx; height: 24rpx; flex-shrink: 0; }
.member-offer { color: #805526; font-size: 22rpx; line-height: 1.5; margin-top: 8rpx; overflow-wrap: anywhere; }
.navigation-note { display: block; color: #765f3f; font-size: 22rpx; line-height: 1.5; margin-top: 12rpx; }
@media (min-width: 700px) { .product-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } .product-image { height: 180px; } }
</style>
