<template>
  <view class="reply-page">
    <view v-if="order" class="body">
      <!-- 订单商品 -->
      <view class="goods-card">
        <view v-for="item in orderItems" :key="(item as any).id" class="goods-line">
          <view class="goods-info">
            <view class="goods-name">{{ (item as any).name }}</view>
            <view class="goods-sku">{{ (item as any).sku || "" }}</view>
          </view>
          <view class="goods-price">¥{{ (item as any).price }}</view>
        </view>
      </view>

      <!-- 评分 -->
      <view class="score-card">
        <view class="score-row">
          <text class="score-label">商品质量</text>
          <view class="stars">
            <text v-for="n in 5" :key="n" class="star" :class="{ on: n <= form.productScore }" @tap="form.productScore = n">★</text>
          </view>
        </view>
        <view class="score-row">
          <text class="score-label">服务态度</text>
          <view class="stars">
            <text v-for="n in 5" :key="n" class="star" :class="{ on: n <= form.serviceScore }" @tap="form.serviceScore = n">★</text>
          </view>
        </view>
        <view class="score-row">
          <text class="score-label">物流速度</text>
          <view class="stars">
            <text v-for="n in 5" :key="n" class="star" :class="{ on: n <= form.logisticsScore }" @tap="form.logisticsScore = n">★</text>
          </view>
        </view>
      </view>

      <!-- 评价内容 -->
      <view class="comment-card">
        <textarea
          v-model="form.comment"
          class="comment-textarea"
          placeholder="分享你的购物体验, 帮助更多买家..."
          :maxlength="500"
        />
        <view class="submit-btn" @tap="submit">提交评价</view>
      </view>
    </view>
    <view v-else class="empty">订单不存在</view>
  </view>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { onLoad } from "@dcloudio/uni-app";
import { apiOrderDetail, apiReplySubmit } from "@/api/order";
import type { OrderInfo } from "@/types/order";

const order = ref<OrderInfo | null>(null);
const form = ref({
  productScore: 5,
  serviceScore: 5,
  logisticsScore: 5,
  comment: "",
});

const orderItems = computed(() => {
  const ci = (order.value as any)?.cart_info;
  if (!Array.isArray(ci)) return [];
  // cart_info 字段是 JSON 字符串, 解析出商品名/价格/规格
  return ci.map((item: any) => {
    let info: any = {};
    try {
      info = JSON.parse(item.cart_info || "{}");
    } catch {
      // ignore
    }
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

async function submit() {
  if (!order.value) return;
  if (!form.value.comment.trim()) {
    return uni.showToast({ title: "请填写评价内容", icon: "none" });
  }
  const items = orderItems.value;
  if (!items.length) return uni.showToast({ title: "订单商品不存在", icon: "none" });

  try {
    // 逐商品提交评价 (unique 从 cart_info 取)
    for (const item of items) {
      const unique = (item as any).unique || "";
      if (!unique) continue;
      await apiReplySubmit({
        unique,
        comment: form.value.comment.trim(),
        productScore: form.value.productScore,
        serviceScore: form.value.serviceScore,
        logisticsScore: form.value.logisticsScore,
      });
    }
    uni.showToast({ title: "评价成功, 感谢您的反馈", icon: "success" });
    setTimeout(() => uni.navigateBack(), 1200);
  } catch (e) {
    uni.showToast({ title: (e as Error).message || "评价失败", icon: "none" });
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

.goods-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.goods-line {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12rpx 0;
}

.goods-name {
  font-size: 28rpx;
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

.score-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.score-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14rpx 0;
}

.score-label {
  font-size: 26rpx;
  color: #333;
}

.stars {
  display: flex;
  gap: 12rpx;
}

.star {
  font-size: 40rpx;
  color: #ddd;
}

.star.on {
  color: #ff9900;
}

.comment-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
}

.comment-textarea {
  width: 100%;
  height: 220rpx;
  background: #f7f7f7;
  border-radius: 12rpx;
  padding: 20rpx;
  box-sizing: border-box;
  font-size: 26rpx;
}

.submit-btn {
  background: #e93323;
  color: #fff;
  text-align: center;
  border-radius: 40rpx;
  padding: 22rpx 0;
  font-size: 30rpx;
  margin-top: 20rpx;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 26rpx;
  padding: 120rpx 0;
}
</style>
