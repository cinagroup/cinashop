<template>
  <view class="refund-list">
    <view v-if="list.length" class="refund-cards">
      <view v-for="r in list" :key="(r as any).id" class="refund-card" @tap="goDetail(r)">
        <view class="refund-head">
          <text class="refund-id">退款单 #{{ (r as any).id }}</text>
          <text class="refund-status">{{ statusText(r) }}</text>
        </view>
        <view class="refund-body">
          <view class="refund-reason">{{ (r as any).refundReason || "退款" }}</view>
          <view class="refund-meta">
            <text>金额 ¥{{ (r as any).refundPrice || "0" }}</text>
            <text class="time">{{ formatTime((r as any).addTime) }}</text>
          </view>
        </view>
        <view v-if="(r as any).status === 0" class="refund-action" @tap="cancel(r)">
          取消申请
        </view>
      </view>
    </view>
    <view v-else class="empty">暂无退款记录</view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { apiRefundList, apiRefundCancel } from "@/api/order";

const list = ref<unknown[]>([]);

function statusText(r: any): string {
  if (r.isCancel === 1) return "已取消";
  switch (r.refundType) {
    case 0: return "待审核";
    case 3: return "已拒绝";
    case 6: return "已退款";
    default: return "处理中";
  }
}

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function goDetail(r: unknown) {
  uni.navigateTo({ url: `/pages/order/refundDetail?id=${(r as any).id}` });
}

async function load() {
  try {
    list.value = await apiRefundList();
  } catch {
    list.value = [];
  }
}

async function cancel(r: unknown) {
  try {
    await apiRefundCancel((r as any).id);
    uni.showToast({ title: "已取消", icon: "success" });
    load();
  } catch (e) {
    uni.showToast({ title: (e as Error).message || "取消失败", icon: "none" });
  }
}

onMounted(load);
</script>

<style scoped>
.refund-list {
  padding: 20rpx;
}

.refund-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.refund-head {
  display: flex;
  justify-content: space-between;
  margin-bottom: 12rpx;
}

.refund-id {
  font-size: 24rpx;
  color: #999;
}

.refund-status {
  font-size: 26rpx;
  color: #e93323;
  font-weight: 600;
}

.refund-reason {
  font-size: 28rpx;
  color: #333;
}

.refund-meta {
  display: flex;
  justify-content: space-between;
  font-size: 24rpx;
  color: #999;
  margin-top: 12rpx;
}

.refund-action {
  text-align: right;
  color: #e93323;
  font-size: 26rpx;
  margin-top: 12rpx;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 26rpx;
  padding: 120rpx 0;
}
</style>
