<template>
  <view class="refund-detail">
    <view v-if="detail" class="body">
      <!-- 状态卡 -->
      <view class="status-card" :class="{ done: isDone }">
        <view class="status-text">{{ statusText }}</view>
        <view class="status-sub">{{ statusSub }}</view>
      </view>

      <!-- 退款信息 -->
      <view class="info-card">
        <view class="info-row">
          <text class="label">退款单号</text>
          <text class="value">#{{ detail.id }}</text>
        </view>
        <view class="info-row">
          <text class="label">退款金额</text>
          <text class="value money">¥{{ detail.refundPrice || "0" }}</text>
        </view>
        <view class="info-row">
          <text class="label">退款原因</text>
          <text class="value">{{ detail.refundReason || "—" }}</text>
        </view>
        <view class="info-row" v-if="detail.refundExplain">
          <text class="label">补充说明</text>
          <text class="value">{{ detail.refundExplain }}</text>
        </view>
        <view class="info-row">
          <text class="label">申请时间</text>
          <text class="value">{{ formatTime(detail.addTime) }}</text>
        </view>
        <view class="info-row" v-if="detail.refuseReason">
          <text class="label">拒绝原因</text>
          <text class="value danger">{{ detail.refuseReason }}</text>
        </view>
      </view>

      <!-- 商家同意退货后展示可信服务端计算的收件信息 -->
      <view v-if="needsReturn" class="return-card">
        <view class="card-title">退货收件信息</view>
        <view class="return-tip">请寄回下列地址，并在寄出后填写物流信息</view>
        <view class="info-row">
          <text class="label">收货人</text>
          <text class="value">{{ returnContact.name || "—" }}</text>
        </view>
        <view class="info-row">
          <text class="label">联系电话</text>
          <text class="value">{{ returnContact.phone || "—" }}</text>
        </view>
        <view class="info-row address-row">
          <text class="label">退货地址</text>
          <text class="value address-value">{{ returnContact.address || "—" }}</text>
        </view>
      </view>

      <!-- 商品 -->
      <view class="goods-card" v-if="cartInfo.length">
        <view class="card-title">退款商品</view>
        <view v-for="g in cartInfo" :key="(g as any).id" class="goods-line">
          <text class="goods-name">{{ (g as any).name }}</text>
          <text class="goods-num">x{{ (g as any).num }}</text>
        </view>
      </view>

      <!-- 退款进度 -->
      <view class="progress-card">
        <view class="card-title">退款进度</view>
        <view class="step-row">
          <view class="step-dot done" />
          <view class="step-info">
            <text class="step-text">已提交退款申请</text>
            <text class="step-time">{{ formatTime(detail.addTime) }}</text>
          </view>
        </view>
        <view class="step-line" />
        <view class="step-row">
          <view class="step-dot" :class="{ done: detail.refundType === 3 || detail.refundType === 6 }" />
          <view class="step-info">
            <text class="step-text">
              {{ detail.refundType === 6 ? "退款已到账" : detail.refundType === 3 ? "申请被拒绝" : "商家处理中" }}
            </text>
            <text v-if="detail.refundType === 3 && detail.refuseReason" class="step-time">{{ detail.refuseReason }}</text>
          </view>
        </view>
      </view>

      <!-- 联系客服 -->
      <view class="service-link" @tap="goService">💬 联系在线客服</view>
    </view>
    <view v-else class="empty">退款单不存在</view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { onLoad } from "@dcloudio/uni-app";
import { http } from "@/utils/request";

const detail = ref<any>(null);

const statusText = computed(() => {
  const d = detail.value;
  if (!d) return "";
  if (d.isCancel === 1) return "已取消";
  switch (d.refundType) {
    case 0: return "退款处理中";
    case 3: return "退款被拒绝";
    case 4: return "请寄回商品";
    case 5: return "等待商家收货";
    case 6: return "退款成功";
    default: return "处理中";
  }
});

const statusSub = computed(() => {
  const d = detail.value;
  if (!d) return "";
  if (d.refundType === 6) return "款项已原路退回";
  if (d.refundType === 3) return "如有疑问请联系客服";
  if (d.refundType === 4) return "请按页面中的收件信息寄回商品";
  if (d.refundType === 5) return "退货商品正在送往商家";
  if (d.isCancel === 1) return "您已取消该退款申请";
  return "商家正在审核您的申请";
});

const isDone = computed(() => detail.value?.refundType === 6);

const returnContact = computed(() => detail.value?.returnContact ?? {
  name: detail.value?._status?.refund_name ?? "",
  phone: detail.value?._status?.refund_phone ?? "",
  address: detail.value?._status?.refund_address ?? "",
});

const needsReturn = computed(() => {
  const status = detail.value?.refundType;
  const contact = returnContact.value;
  return (status === 4 || status === 5)
    && Boolean(contact.name || contact.phone || contact.address);
});

const cartInfo = computed(() => {
  const raw = detail.value?.cartInfo;
  if (Array.isArray(raw)) {
    return raw.map((item: any) => {
      let info: any = {};
      try {
        info = JSON.parse(item.cartInfo || "{}");
      } catch {}
      const product = info.product || info;
      return { id: item.id, name: product.storeName || product.store_name || "商品", num: item.cartNum || 1 };
    });
  }
  return [];
});

function formatTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function goService() {
  uni.navigateTo({ url: "/pages/user/kefu" });
}

onLoad(async (query) => {
  const id = Number(query?.id ?? 0);
  if (!id) return;
  try {
    detail.value = await http.get<any>(`/order/refund/detail/${id}`);
  } catch {
    detail.value = null;
  }
});
</script>

<style scoped>
.body {
  padding: 20rpx;
}

.status-card {
  background: linear-gradient(135deg, #ff9900, #ff7a45);
  border-radius: 16rpx;
  padding: 40rpx 30rpx;
  color: #fff;
  margin-bottom: 20rpx;
}

.status-card.done {
  background: linear-gradient(135deg, #52c41a, #73d13d);
}

.status-text {
  font-size: 36rpx;
  font-weight: 700;
}

.status-sub {
  font-size: 24rpx;
  opacity: 0.9;
  margin-top: 10rpx;
}

.info-card,
.goods-card,
.return-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.return-tip {
  color: #ff7a45;
  font-size: 24rpx;
  line-height: 1.5;
  margin-bottom: 10rpx;
}

.address-row {
  align-items: flex-start;
  gap: 24rpx;
}

.address-value {
  flex: 1;
  min-width: 0;
  text-align: right;
  overflow-wrap: anywhere;
}

.info-row {
  display: flex;
  justify-content: space-between;
  padding: 14rpx 0;
  border-bottom: 1rpx solid #f7f7f7;
}

.info-row:last-child {
  border-bottom: none;
}

.label {
  font-size: 26rpx;
  color: #999;
}

.value {
  font-size: 26rpx;
  color: #333;
}

.value.money {
  color: #e93323;
  font-weight: 700;
}

.value.danger {
  color: #e93323;
}

.card-title {
  font-size: 28rpx;
  font-weight: 600;
  margin-bottom: 12rpx;
}

.goods-line {
  display: flex;
  justify-content: space-between;
  padding: 10rpx 0;
}

.goods-name {
  font-size: 26rpx;
  color: #333;
}

.goods-num {
  font-size: 24rpx;
  color: #999;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 26rpx;
  padding: 120rpx 0;
}

.progress-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.step-row {
  display: flex;
  gap: 16rpx;
  align-items: flex-start;
}

.step-dot {
  width: 16rpx;
  height: 16rpx;
  border-radius: 50%;
  background: #ddd;
  margin-top: 10rpx;
  flex-shrink: 0;
}

.step-dot.done {
  background: #52c41a;
}

.step-line {
  width: 2rpx;
  height: 24rpx;
  background: #eee;
  margin-left: 7rpx;
}

.step-info {
  flex: 1;
  padding-bottom: 10rpx;
}

.step-text {
  font-size: 26rpx;
  color: #333;
  display: block;
}

.step-time {
  font-size: 22rpx;
  color: #999;
  margin-top: 4rpx;
}

.service-link {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  text-align: center;
  font-size: 28rpx;
  color: #e93323;
}
</style>
