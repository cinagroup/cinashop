<template>
  <view class="refund-page">
    <view v-if="order" class="body">
      <!-- 订单商品 (可勾选) -->
      <view class="goods-card">
        <view class="card-title">选择退款商品</view>
        <view
          v-for="item in orderItems"
          :key="(item as any).id"
          class="goods-line"
          @tap="toggleItem(item)"
        >
          <view class="check" :class="{ checked: selectedIds.includes((item as any).id) }">
            <text v-if="selectedIds.includes((item as any).id)">✓</text>
          </view>
          <view class="goods-info">
            <view class="goods-name">{{ (item as any).name }}</view>
            <view class="goods-sku">{{ (item as any).sku || "" }}</view>
          </view>
          <view class="goods-price">¥{{ (item as any).price }}</view>
        </view>
      </view>

      <!-- 退款原因 -->
      <view class="form-card">
        <view class="card-title">退款原因</view>
        <view class="reason-list">
          <view
            v-for="r in reasons"
            :key="r"
            class="reason-item"
            :class="{ active: reason === r }"
            @tap="reason = r"
          >
            {{ r }}
          </view>
        </view>
        <textarea
          v-model="explain"
          class="explain-input"
          placeholder="补充说明 (选填)"
          :maxlength="200"
        />
      </view>

      <view class="submit-btn" @tap="submit">提交退款申请</view>
    </view>
    <view v-else class="empty">订单不存在</view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { onLoad } from "@dcloudio/uni-app";
import { apiOrderDetail, apiRefundApply } from "@/api/order";

const order = ref<any>(null);
const selectedIds = ref<number[]>([]);
const reason = ref("不想要了");
const explain = ref("");
const reasons = ["不想要了", "商品质量问题", "发错货", "与描述不符", "其他"];

const orderItems = computed(() => {
  const ci = order.value?.cart_info;
  if (!Array.isArray(ci)) return [];
  return ci.map((item: any) => {
    let info: any = {};
    try {
      info = JSON.parse(item.cart_info || "{}");
    } catch {}
    const product = info.product || info;
    return {
      id: item.id,
      unique: item.unique,
      name: product.storeName || product.store_name || "商品",
      price: product.price || "0",
      sku: product.attrInfo?.suk || "",
    };
  });
});

function toggleItem(item: any) {
  const idx = selectedIds.value.indexOf(item.id);
  if (idx >= 0) {
    selectedIds.value.splice(idx, 1);
  } else {
    selectedIds.value.push(item.id);
  }
}

async function submit() {
  if (!order.value) return;
  if (!selectedIds.value.length) return uni.showToast({ title: "请选择退款商品", icon: "none" });
  try {
    await apiRefundApply(order.value.order_id, {
      refundReason: reason.value,
      refundExplain: explain.value,
      applyType: 1,
      cartIds: selectedIds.value,
    });
    uni.showToast({ title: "退款申请已提交", icon: "success" });
    setTimeout(() => uni.navigateBack(), 1200);
  } catch (e) {
    uni.showToast({ title: (e as Error).message || "提交失败", icon: "none" });
  }
}

onLoad(async (query) => {
  const orderId = (query?.orderId as string) ?? "";
  if (!orderId) return;
  try {
    order.value = await apiOrderDetail(orderId);
  } catch {
    order.value = null;
  }
});
</script>

<style scoped>
.body {
  padding: 20rpx;
}

.goods-card,
.form-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.card-title {
  font-size: 28rpx;
  font-weight: 600;
  margin-bottom: 16rpx;
}

.goods-line {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 16rpx 0;
  border-bottom: 1rpx solid #f7f7f7;
}

.check {
  width: 36rpx;
  height: 36rpx;
  border: 2rpx solid #ddd;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 22rpx;
  flex-shrink: 0;
}

.check.checked {
  background: #e93323;
  border-color: #e93323;
}

.goods-info {
  flex: 1;
}

.goods-name {
  font-size: 26rpx;
  color: #333;
}

.goods-sku {
  font-size: 22rpx;
  color: #999;
  margin-top: 4rpx;
}

.goods-price {
  font-size: 26rpx;
  color: #e93323;
  font-weight: 600;
}

.reason-list {
  display: flex;
  flex-wrap: wrap;
  gap: 16rpx;
}

.reason-item {
  background: #f7f7f7;
  color: #555;
  font-size: 24rpx;
  padding: 12rpx 24rpx;
  border-radius: 28rpx;
}

.reason-item.active {
  background: #e93323;
  color: #fff;
}

.explain-input {
  width: 100%;
  height: 160rpx;
  background: #f7f7f7;
  border-radius: 12rpx;
  padding: 20rpx;
  box-sizing: border-box;
  font-size: 26rpx;
  margin-top: 20rpx;
}

.submit-btn {
  background: #e93323;
  color: #fff;
  text-align: center;
  border-radius: 40rpx;
  padding: 22rpx 0;
  font-size: 30rpx;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 26rpx;
  padding: 120rpx 0;
}
</style>
