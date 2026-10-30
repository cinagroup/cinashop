<template>
  <ThemePage>
    <view class="search-page">
      <view v-for="action in controls" :key="action.key" class="search-bar">
        <view class="search-box">
          <text class="search-icon">🔍</text>
          <input :value="keyword" :maxlength="-1" class="search-input" confirm-type="search"
            placeholder="搜索商品" @input="action.input" @confirm="action.search" />
        </view>
        <text class="search-btn" @tap="action.search">搜索</text>
      </view>
      <view class="section">
        <view class="section-title">
          热门搜索
          <text v-for="action in controls" :key="action.key" class="refresh" @tap="action.refresh">刷新</text>
        </view>
        <view v-if="hotLoading" class="empty" role="status">热词加载中…</view>
        <view v-else-if="hotError" class="empty error" role="alert">{{ hotError }}，请点击刷新重试</view>
        <view v-else-if="hotEntries.length" class="tags">
          <view v-for="entry in hotEntries" :key="entry.key" class="tag hotword" :style="entry.style" @tap="entry.tap">
            <image v-if="entry.icon" :key="entry.key" class="hotword-icon" :src="entry.icon" mode="aspectFill" @error="entry.error" />
            <text class="word">{{ entry.row.name }}</text>
          </view>
        </view>
        <view v-else class="empty">暂无热词</view>
      </view>
      <view v-if="history.length || historyError" class="section">
        <view class="section-title">
          搜索历史（本机）
          <text v-for="action in controls" :key="action.key" class="clear" @tap="action.clear">清空</text>
        </view>
        <view v-if="historyError" class="empty error" role="alert">{{ historyError }}</view>
        <view v-else class="tags">
          <view v-for="entry in historyEntries" :key="entry.key" class="tag gray" @tap="entry.tap">{{ entry.word }}</view>
        </view>
      </view>
      <view v-if="searched" class="section">
        <view class="section-title">搜索结果</view>
        <view v-if="searchLoading" class="empty" role="status">搜索中…</view>
        <view v-else-if="searchError" class="empty error" role="alert">{{ searchError }}，请重新搜索</view>
        <view v-else-if="resultEntries.length" class="goods-list">
          <view v-for="entry in resultEntries" :key="entry.key" class="goods-item" @tap="entry.tap">
            <view class="goods-name">{{ entry.row.store_name }}</view>
            <view class="goods-price">¥{{ entry.row.price }}</view>
          </view>
        </view>
        <view v-else class="empty">未找到相关商品</view>
      </view>
    </view>
    <DiySuspendedNavigation />
  </ThemePage>
</template>

<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import { useGoodsSearch } from '@/composables/useGoodsSearch';
const { keyword, history, hotLoading, hotError, searchLoading, searchError, historyError, searched, controls, hotEntries, historyEntries, resultEntries } = useGoodsSearch();
</script>

<style scoped>
.search-page {
  padding: 20rpx;
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 16rpx;
  margin-bottom: 30rpx;
}

.search-box {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  background: #fff;
  border-radius: 36rpx;
  padding: 16rpx 24rpx;
}

.search-icon {
  font-size: 28rpx;
  margin-right: 12rpx;
}

.search-input {
  min-width: 0;
  flex: 1;
  font-size: 26rpx;
}

.search-btn {
  color: var(--view-theme, #e93323);
  font-size: 28rpx;
}

.section {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.section-title {
  font-size: 28rpx;
  font-weight: 600;
  color: #333;
  margin-bottom: 20rpx;
  display: flex;
  justify-content: space-between;
}

.clear {
  font-size: 22rpx;
  color: #999;
  font-weight: 400;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 16rpx;
}

.tag {
  max-width: 100%;
  box-sizing: border-box;
  overflow-wrap: anywhere;
  word-break: break-word;
  background: #f7f7f7;
  color: #555;
  font-size: 24rpx;
  padding: 12rpx 24rpx;
  border-radius: 28rpx;
}

.tag.gray {
  background: #f0f0f0;
  color: #999;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 24rpx;
  padding: 40rpx 0;
}

.goods-list {
  display: flex;
  flex-direction: column;
}

.goods-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20rpx 0;
  border-bottom: 1rpx solid #f7f7f7;
}

.goods-name {
  min-width: 0;
  overflow-wrap: anywhere;
  padding-right: 16rpx;
  font-size: 26rpx;
  color: #333;
  flex: 1;
}

.goods-price {
  font-size: 28rpx;
  color: var(--view-priceColor, #e93323);
  font-weight: 600;
}
.hotword { display: flex; align-items: center; }
.word { min-width: 0; }
.hotword-icon { width: 24rpx; height: 24rpx; flex-shrink: 0; border-radius: 4rpx; margin-right: 8rpx; }
.refresh { font-size: 22rpx; font-weight: 400; color: var(--view-theme, #e93323); }
.error { color: #b42318; overflow-wrap: anywhere; }
.goods-price { flex-shrink: 0; }
</style>
