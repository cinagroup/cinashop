<template>
  <view class="balance-logs">
    <!-- 余额总览 -->
    <view class="balance-card">
      <view class="balance-label">当前余额</view>
      <view class="balance-num">¥{{ balance }}</view>
    </view>

    <!-- 余额明细 -->
    <view class="filter-bar">
      <view
        v-for="f in filters"
        :key="f.value"
        class="filter-item"
        :class="{ active: filter === f.value }"
        @tap="switchFilter(f.value)"
      >
        {{ f.name }}
      </view>
    </view>

    <view v-if="filteredList.length" class="log-list">
      <view v-for="l in filteredList" :key="(l as any).id" class="log-item">
        <view class="log-left">
          <view class="log-title">{{ (l as any).title }}</view>
          <view class="log-mark">{{ (l as any).mark || "" }}</view>
          <view class="log-time">{{ formatTime((l as any).addTime) }}</view>
        </view>
        <view class="log-right" :class="{ income: (l as any).pm === 1 }">
          {{ (l as any).pm === 1 ? "+" : "-" }}¥{{ (l as any).number }}
        </view>
      </view>
    </view>
    <view v-else class="empty">暂无余额明细</view>

    <view v-if="hasMore" class="load-more" @tap="loadMore">加载更多</view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { http } from "@/utils/request";

const list = ref<unknown[]>([]);
const balance = ref("0.00");
const page = ref(1);
const hasMore = ref(true);
const filter = ref(0);

const filters = [
  { value: 0, name: "全部" },
  { value: 1, name: "收入" },
  { value: 2, name: "支出" },
];

function switchFilter(value: number) {
  filter.value = value;
  load(true);
}

const filteredList = computed(() => {
  if (filter.value === 1) return list.value.filter((l) => (l as any).pm === 1);
  if (filter.value === 2) return list.value.filter((l) => (l as any).pm === 0);
  return list.value;
});

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function load(reset = false) {
  if (reset) {
    page.value = 1;
    list.value = [];
  }
  try {
    const rows = await http.get<unknown[]>("/user/balance", { page: page.value, limit: 20 });
    list.value = [...list.value, ...rows];
    hasMore.value = rows.length >= 20;
  } catch {
    hasMore.value = false;
  }
}

async function loadMore() {
  page.value += 1;
  await load();
}

onMounted(async () => {
  await load(true);
  try {
    const info = await http.get<Record<string, unknown>>("/user/info");
    balance.value = String(info.now_money ?? "0.00");
  } catch {
    // 静默
  }
});
</script>

<style scoped>
.balance-logs {
  padding: 20rpx;
}

.balance-card {
  background: linear-gradient(135deg, #e93323, #ff7a45);
  border-radius: 16rpx;
  padding: 30rpx;
  color: #fff;
  margin-bottom: 20rpx;
}

.balance-label {
  font-size: 24rpx;
  opacity: 0.9;
}

.balance-num {
  font-size: 48rpx;
  font-weight: 700;
  margin-top: 8rpx;
}

.filter-bar {
  display: flex;
  gap: 20rpx;
  margin-bottom: 20rpx;
}

.filter-item {
  flex: 1;
  text-align: center;
  padding: 14rpx 0;
  background: #fff;
  border-radius: 12rpx;
  font-size: 26rpx;
  color: #666;
}

.filter-item.active {
  background: #e93323;
  color: #fff;
  font-weight: 600;
}

.log-list {
  background: #fff;
  border-radius: 16rpx;
  padding: 0 24rpx;
}

.log-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20rpx 0;
  border-bottom: 1rpx solid #f7f7f7;
}

.log-title {
  font-size: 26rpx;
  color: #333;
}

.log-mark {
  font-size: 22rpx;
  color: #999;
  margin-top: 4rpx;
}

.log-time {
  font-size: 20rpx;
  color: #ccc;
  margin-top: 4rpx;
}

.log-right {
  font-size: 28rpx;
  color: #999;
  font-weight: 600;
}

.log-right.income {
  color: #e93323;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 26rpx;
  padding: 100rpx 0;
}

.load-more {
  text-align: center;
  color: #999;
  font-size: 26rpx;
  padding: 24rpx;
}
</style>
