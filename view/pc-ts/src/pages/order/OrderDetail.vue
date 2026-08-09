<template>
  <div class="order-detail container">
    <el-skeleton v-if="loading" :rows="6" animated />
    <template v-else-if="order">
      <div class="detail-card">
        <div class="detail-header">
          <h2>订单详情</h2>
          <span class="status">{{ statusText }}</span>
        </div>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="订单号">{{ order.order_id }}</el-descriptions-item>
          <el-descriptions-item label="下单时间">{{ formatTime(order.add_time) }}</el-descriptions-item>
          <el-descriptions-item label="收货人">
            {{ order.real_name }} {{ order.user_phone }}
          </el-descriptions-item>
          <el-descriptions-item label="收货地址">
            {{ order.province }}{{ order.user_address }}
          </el-descriptions-item>
          <el-descriptions-item label="商品数量">{{ order.total_num }}</el-descriptions-item>
          <el-descriptions-item label="支付方式">
            {{ payTypeText }}
          </el-descriptions-item>
        </el-descriptions>
      </div>

      <div class="detail-card">
        <h3>商品清单</h3>
        <div v-for="ci in order.cart_info" :key="ci.id" class="cart-line">
          <img v-if="ci.cart_info?.product" :src="ci.cart_info.product.image" class="thumb" />
          <span class="cart-name">{{ ci.cart_info?.product?.storeName }}</span>
          <span class="cart-price">¥{{ ci.cart_info?.sku?.price }}</span>
          <span class="cart-num">x{{ ci.cart_num }}</span>
        </div>
      </div>

      <div class="detail-card">
        <div class="amount-row">
          <span>商品金额</span>
          <span>¥{{ order.total_price }}</span>
        </div>
        <div class="amount-row total-row">
          <span>实付金额</span>
          <span class="price">¥{{ order.pay_price }}</span>
        </div>
      </div>

      <div v-if="order.paid === 0" class="pay-bar">
        <el-button type="primary" size="large" :loading="paying" @click="pay">
          余额支付 ¥{{ order.pay_price }}
        </el-button>
      </div>
      <div v-else class="pay-bar">
        <el-button v-if="order.status === 1" type="primary" size="large" @click="take">
          确认收货
        </el-button>
        <el-button v-if="order.status === 0" size="large" @click="goRefund">
          申请退款
        </el-button>
      </div>
    </template>
    <el-empty v-else description="订单不存在" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiOrderDetail, apiOrderPay, apiOrderTake } from "@/api/order";
import type { OrderInfo } from "@/types/order";
import dayjs from "dayjs";

const route = useRoute();
const router = useRouter();
const order = ref<OrderInfo | null>(null);
const loading = ref(true);
const paying = ref(false);

const statusText = computed(() => {
  if (!order.value) return "";
  if (order.value.paid === 0) return "待支付";
  switch (order.value.status) {
    case 0: return "待发货";
    case 1: return "待收货";
    case 2: return "已收货";
    case 3: return "已完成";
    default: return "未知";
  }
});

const payTypeText = computed(() => {
  switch (order.value?.pay_type) {
    case "yue": return "余额支付";
    case "weixin": return "微信支付";
    case "alipay": return "支付宝";
    case "offline": return "线下支付";
    default: return "未支付";
  }
});

function formatTime(ts: number): string {
  return ts ? dayjs(ts * 1000).format("YYYY-MM-DD HH:mm") : "-";
}

async function pay() {
  if (!order.value) return;
  try {
    await ElMessageBox.confirm(`确认使用余额支付 ¥${order.value.pay_price}?`, "支付确认");
  } catch {
    return;
  }
  paying.value = true;
  try {
    await apiOrderPay(order.value.order_id, "yue");
    ElMessage.success("支付成功");
    load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "支付失败");
  } finally {
    paying.value = false;
  }
}

async function take() {
  if (!order.value) return;
  await apiOrderTake(order.value.order_id);
  ElMessage.success("已确认收货");
  load();
}

function goRefund() {
  if (!order.value) return;
  router.push(`/refund/${order.value.order_id}`);
}

async function load() {
  loading.value = true;
  try {
    order.value = await apiOrderDetail(String(route.params.orderId));
  } catch (e) {
    console.error("订单加载失败", e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.container {
  padding-top: 20px;
}

.detail-card {
  background: #fff;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 16px;
}

.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.status {
  color: #e64340;
  font-size: 16px;
}

.cart-line {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}

.thumb {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 4px;
}

.cart-name {
  flex: 1;
}

.cart-price {
  color: #e64340;
}

.cart-num {
  color: #999;
}

.amount-row {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  color: #666;
}

.total-row {
  border-top: 1px solid #f0f0f0;
  padding-top: 12px;
  font-size: 15px;
}

.price {
  color: #e64340;
  font-size: 20px;
  font-weight: 700;
}

.pay-bar {
  display: flex;
  justify-content: flex-end;
  padding: 12px 0 40px;
}
</style>
