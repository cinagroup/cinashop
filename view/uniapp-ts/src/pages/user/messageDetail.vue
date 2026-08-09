<template>
  <view class="msg-detail">
    <view v-if="detail" class="body">
      <view class="msg-card">
        <view class="msg-title">{{ detail.title || "系统通知" }}</view>
        <view class="msg-time">{{ formatTime(detail.addTime) }}</view>
        <view class="msg-divider" />
        <view class="msg-content">{{ detail.content }}</view>
      </view>
    </view>
    <view v-else class="empty">消息不存在</view>
  </view>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";
import { http } from "@/utils/request";

const detail = ref<any>(null);

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

onLoad(async (query) => {
  const id = Number(query?.id ?? 0);
  if (!id) return;
  try {
    detail.value = await http.get<any>(`/user/message_system/detail/${id}`);
  } catch {
    detail.value = null;
  }
});
</script>

<style scoped>
.body {
  padding: 20rpx;
}

.msg-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 30rpx 24rpx;
}

.msg-title {
  font-size: 32rpx;
  font-weight: 700;
  color: #333;
}

.msg-time {
  font-size: 22rpx;
  color: #bbb;
  margin-top: 10rpx;
}

.msg-divider {
  height: 1rpx;
  background: #f0f0f0;
  margin: 20rpx 0;
}

.msg-content {
  font-size: 28rpx;
  color: #444;
  line-height: 1.8;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 26rpx;
  padding: 120rpx 0;
}
</style>
