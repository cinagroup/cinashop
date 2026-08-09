<template>
  <view class="message-page">
    <view v-if="list.length" class="msg-list">
      <view v-for="m in list" :key="(m as any).id" class="msg-item" @tap="openDetail(m)">
        <view class="msg-head">
          <text class="msg-title">{{ (m as any).title || "系统通知" }}</text>
          <text class="msg-time">{{ formatTime((m as any).addTime) }}</text>
        </view>
        <view class="msg-content">{{ (m as any).content }}</view>
      </view>
    </view>
    <view v-else class="empty">暂无消息</view>
  </view>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { http } from "@/utils/request";

const list = ref<unknown[]>([]);

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function load() {
  try {
    list.value = await http.get<unknown[]>("/user/message");
  } catch {
    list.value = [];
  }
}

async function openDetail(m: unknown) {
  uni.navigateTo({ url: `/pages/user/messageDetail?id=${(m as any).id}` });
}

onMounted(load);
</script>

<style scoped>
.message-page {
  padding: 20rpx;
}

.msg-list {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}

.msg-item {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
}

.msg-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10rpx;
}

.msg-title {
  font-size: 28rpx;
  font-weight: 600;
  color: #333;
}

.msg-time {
  font-size: 22rpx;
  color: #bbb;
}

.msg-content {
  font-size: 25rpx;
  color: #666;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 26rpx;
  padding: 120rpx 0;
}
</style>
