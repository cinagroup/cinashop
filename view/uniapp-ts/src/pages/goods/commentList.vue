<template>
  <view class="comment-page">
    <!-- 评价统计 -->
    <view class="stats-bar" v-if="stats">
      <view class="stats-score">{{ stats.avgScore }}</view>
      <view class="stars">{{ starText(Number(stats.avgScore)) }}</view>
      <view class="stats-info">
        <text>{{ stats.total }} 条评价</text>
        <text>好评率 {{ stats.goodRate }}%</text>
      </view>
    </view>

    <!-- 筛选 tabs -->
    <view class="filter-bar">
      <view class="filter-tab" :class="{ active: filter === 'all' }" @tap="filter = 'all'; load(1)">全部 {{ stats?.total || 0 }}</view>
      <view class="filter-tab" :class="{ active: filter === 'pic' }" @tap="filter = 'pic'; load(1)">有图 {{ picCount }}</view>
      <view class="filter-tab" :class="{ active: filter === 'good' }" @tap="filter = 'good'; load(1)">好评</view>
    </view>

    <!-- 评价列表 -->
    <view class="comment-list">
      <view class="comment-item" v-for="r in filteredList" :key="(r as any).id">
        <view class="comment-head">
          <text class="avatar">{{ ((r as any).nickname || "用")[0] }}</text>
          <text class="nickname">{{ (r as any).nickname || "匿名用户" }}</text>
          <text class="stars">{{ starText((r as any).productScore) }}</text>
        </view>
        <view class="comment-text">{{ (r as any).comment }}</view>
        <view class="comment-pics" v-if="(r as any).pics && (r as any).pics.length">
          <image
            v-for="(p, i) in (r as any).pics"
            :key="i"
            class="comment-pic"
            :src="p"
            mode="aspectFill"
            @tap="previewImage((r as any).pics, i)"
          />
        </view>
        <view class="comment-foot">
          <text class="sku">{{ (r as any).sku || "默认规格" }}</text>
          <text class="time">{{ formatTime((r as any).addTime) }}</text>
        </view>
      </view>
    </view>
    <view v-if="!list.length && !loading" class="empty">暂无评价</view>
    <view v-if="list.length && hasMore" class="load-more" @tap="loadMore">加载更多</view>
    <view v-if="list.length && !hasMore" class="load-more">没有更多了</view>
  </view>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { onLoad } from "@dcloudio/uni-app";
import { http } from "@/utils/request";

const productId = ref(0);
const list = ref<any[]>([]);
const stats = ref<{ total: number; avgScore: string; goodRate: number } | null>(null);
const page = ref(1);
const loading = ref(true);
const hasMore = ref(true);
const filter = ref("all");

const picCount = computed(() => list.value.filter((r) => r.pics && r.pics.length).length);

const filteredList = computed(() => {
  if (filter.value === "pic") return list.value.filter((r) => r.pics && r.pics.length);
  if (filter.value === "good") return list.value.filter((r) => Number(r.productScore) >= 4);
  return list.value;
});

function starText(score: number): string {
  const n = Math.min(5, Math.max(1, Number(score) || 5));
  return "★".repeat(n) + "☆".repeat(5 - n);
}

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function previewImage(pics: string[], current: number) {
  uni.previewImage({ urls: pics, current: pics[current] });
}

async function loadStats() {
  try {
    stats.value = await http.get(`/reply/config/${productId.value}`);
  } catch {
    stats.value = null;
  }
}

async function load(p = 1) {
  if (p === 1) {
    list.value = [];
    hasMore.value = true;
  }
  loading.value = true;
  page.value = p;
  try {
    const data = await http.get<any[]>(`/reply/list/${productId.value}`, { page: p, limit: 20 });
    list.value = list.value.concat(data || []);
    hasMore.value = (data || []).length >= 20;
  } catch {
    hasMore.value = false;
  } finally {
    loading.value = false;
  }
}

function loadMore() {
  if (hasMore.value && !loading.value) load(page.value + 1);
}

onLoad((options) => {
  const id = Number(options?.productId ?? options?.id ?? 0);
  if (id) {
    productId.value = id;
    loadStats();
    load(1);
  }
});
</script>

<style scoped>
.comment-page {
  padding: 20rpx;
}

.stats-bar {
  display: flex;
  align-items: center;
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx;
  margin-bottom: 20rpx;
}

.stats-score {
  font-size: 56rpx;
  font-weight: 700;
  color: #ff9900;
  margin-right: 20rpx;
}

.stars {
  font-size: 24rpx;
  color: #ff9900;
  margin-right: 20rpx;
}

.stats-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  font-size: 24rpx;
  color: #999;
  gap: 6rpx;
}

.filter-bar {
  display: flex;
  background: #fff;
  border-radius: 16rpx;
  padding: 8rpx;
  margin-bottom: 20rpx;
}

.filter-tab {
  flex: 1;
  text-align: center;
  padding: 16rpx 0;
  font-size: 26rpx;
  color: #666;
  border-radius: 12rpx;
}

.filter-tab.active {
  background: #fff5f4;
  color: #e93323;
  font-weight: 600;
}

.comment-item {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 16rpx;
}

.comment-head {
  display: flex;
  align-items: center;
  margin-bottom: 14rpx;
}

.avatar {
  width: 48rpx;
  height: 48rpx;
  background: #e93323;
  color: #fff;
  border-radius: 50%;
  font-size: 24rpx;
  text-align: center;
  line-height: 48rpx;
  margin-right: 14rpx;
}

.nickname {
  font-size: 26rpx;
  color: #333;
  flex: 1;
}

.stars {
  font-size: 22rpx;
  color: #ff9900;
}

.comment-text {
  font-size: 28rpx;
  color: #444;
  line-height: 1.6;
}

.comment-pics {
  display: flex;
  gap: 12rpx;
  margin-top: 14rpx;
}

.comment-pic {
  width: 160rpx;
  height: 160rpx;
  border-radius: 8rpx;
}

.comment-foot {
  display: flex;
  justify-content: space-between;
  margin-top: 14rpx;
}

.sku,
.time {
  font-size: 22rpx;
  color: #bbb;
}

.empty {
  text-align: center;
  color: #999;
  padding: 100rpx 0;
  font-size: 26rpx;
}

.load-more {
  text-align: center;
  color: #999;
  font-size: 24rpx;
  padding: 30rpx 0;
}
</style>
