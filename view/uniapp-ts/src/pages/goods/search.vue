<template>
  <view class="search-page">
    <!-- 搜索框 -->
    <view class="search-bar">
      <view class="search-box">
        <text class="search-icon">🔍</text>
        <input
          v-model="keyword"
          class="search-input"
          confirm-type="search"
          placeholder="搜索商品"
          @confirm="doSearch"
        />
      </view>
      <text class="search-btn" @tap="doSearch">搜索</text>
    </view>

    <!-- 热门搜索 -->
    <view class="section">
      <view class="section-title">热门搜索</view>
      <view v-if="hotWords.length" class="tags">
        <view v-for="w in hotWords" :key="(w as any).id" class="tag" @tap="useWord((w as any).keyword || (w as any).words)">
          {{ (w as any).keyword || (w as any).words }}
        </view>
      </view>
      <view v-else class="empty">暂无热词</view>
    </view>

    <!-- 搜索历史 (本地) -->
    <view v-if="history.length" class="section">
      <view class="section-title">
        搜索历史
        <text class="clear" @tap="clearHistory">清空</text>
      </view>
      <view class="tags">
        <view v-for="w in history" :key="w" class="tag gray" @tap="useWord(w)">{{ w }}</view>
      </view>
    </view>

    <!-- 搜索结果 -->
    <view v-if="searched" class="section">
      <view class="section-title">搜索结果</view>
      <view v-if="results.length" class="goods-list">
        <view v-for="g in results" :key="(g as any).id" class="goods-item" @tap="goDetail((g as any).id)">
          <view class="goods-name">{{ (g as any).storeName }}</view>
          <view class="goods-price">¥{{ (g as any).price }}</view>
        </view>
      </view>
      <view v-else class="empty">未找到相关商品</view>
    </view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { onLoad } from "@dcloudio/uni-app";
import { ref, onMounted } from "vue";
import { http } from "@/utils/request";
import { apiGoodsList } from "@/api/product";

const keyword = ref("");
const hotWords = ref<unknown[]>([]);
const history = ref<string[]>([]);
const searched = ref(false);
const results = ref<unknown[]>([]);
const HISTORY_KEY = "h5_search_history";

async function loadHot() {
  try {
    hotWords.value = await http.get<unknown[]>("/search/hot_keyword");
  } catch {
    hotWords.value = [];
  }
}

function loadHistory() {
  try {
    history.value = JSON.parse(uni.getStorageSync(HISTORY_KEY) || "[]");
  } catch {
    history.value = [];
  }
}

function pushHistory(word: string) {
  const list = [word, ...history.value.filter((h) => h !== word)].slice(0, 10);
  history.value = list;
  uni.setStorageSync(HISTORY_KEY, JSON.stringify(list));
}

async function doSearch() {
  const word = keyword.value.trim();
  if (!word) return uni.showToast({ title: "请输入搜索关键词", icon: "none" });
  pushHistory(word);
  searched.value = true;
  try {
    const res = await apiGoodsList({ keyword: word });
    results.value = res.list ?? [];
  } catch {
    results.value = [];
  }
}

function useWord(word: string) {
  keyword.value = word;
  doSearch();
}

function clearHistory() {
  history.value = [];
  uni.removeStorageSync(HISTORY_KEY);
}

function goDetail(id: number) {
  uni.navigateTo({ url: `/pages/goods/detail?id=${id}` });
}

onLoad((options) => {
  const initial = String(options?.keyword ?? options?.searchVal ?? "").trim().slice(0, 100);
  if (!initial) return;
  keyword.value = initial;
  void doSearch();
});

onMounted(() => {
  loadHot();
  loadHistory();
});
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
  flex: 1;
  font-size: 26rpx;
}

.search-btn {
  color: #e93323;
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
  font-size: 26rpx;
  color: #333;
  flex: 1;
}

.goods-price {
  font-size: 28rpx;
  color: #e93323;
  font-weight: 600;
}
</style>
