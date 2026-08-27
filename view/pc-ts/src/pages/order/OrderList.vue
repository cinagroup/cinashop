<template>
  <div class="order-list container">
    <h2 class="title">我的订单</h2>
    <el-tabs v-model="activeTab" @tab-change="reload">
      <el-tab-pane label="全部" name="all" />
      <el-tab-pane label="待支付" name="unpaid" />
      <el-tab-pane label="待发货" name="pending" />
      <el-tab-pane label="待收货" name="shipping" />
    </el-tabs>

    <div v-if="orders.length" class="order-cards">
      <div v-for="order in orders" :key="order.order_id" class="order-card">
        <div class="order-header">
          <span class="order-id">订单号: {{ order.order_id }}</span>
          <span class="order-status">{{ statusText(order) }}</span>
        </div>
        <div class="order-body" @click="$router.push(`/order/${order.order_id}`)">
          <template v-if="order.cart_info?.length">
            <div v-for="ci in order.cart_info" :key="ci.id" class="cart-line">
              <img v-if="ci.cart_info?.product" :src="ci.cart_info.product.image" class="thumb" />
              <span class="cart-name">{{ ci.cart_info?.product?.storeName }}</span>
              <span class="cart-num">x{{ ci.cart_num }}</span>
            </div>
          </template>
        </div>
        <div class="order-footer">
          <span class="total">¥{{ order.pay_price }}</span>
          <template v-if="order.paid === 0">
            <el-button type="primary" size="small" @click="pay(order)">去支付</el-button>
          </template>
          <template v-else-if="order.status === 1">
            <el-button size="small" @click="take(order)">确认收货</el-button>
          </template>
          <template v-if="order.paid === 1 && order.status >= 1">
            <el-button size="small" @click="$router.push({ path: '/express', query: { orderId: order.order_id } })">
              查看物流
            </el-button>
          </template>
          <template v-if="order.paid === 1 && order.status >= 2">
            <el-button size="small" type="success" @click="$router.push(`/order/${order.order_id}`)">
              评价
            </el-button>
          </template>
        </div>
      </div>
    </div>
    <el-empty v-else description="暂无订单" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { apiOrderList, apiOrderTake } from "@/api/order";
import { useRouter } from "vue-router";
import type { OrderInfo } from "@/types/order";

const activeTab = ref("all");
const orders = ref<OrderInfo[]>([]);
const router = useRouter();

function statusText(order: OrderInfo): string {
  if (order.paid === 0) return "待支付";
  switch (order.status) {
    case 0:
      return "待发货";
    case 1:
      return "待收货";
    case 2:
      return "已收货";
    case 3:
      return "已完成";
    default:
      return "未知";
  }
}

async function reload() {
  const statusMap: Record<string, number | undefined> = {
    all: undefined,
    unpaid: 0,
    pending: 1,
    shipping: 2,
  };
  try {
    orders.value = await apiOrderList({ status: statusMap[activeTab.value], page: 1, limit: 20 });
  } catch (e) {
    console.error("订单列表加载失败", e);
  }
}

function pay(order: OrderInfo) {
  void router.push(`/order/${order.order_id}`);
}

async function take(order: OrderInfo) {
  try {
    await apiOrderTake(order.order_id);
    ElMessage.success("已确认收货");
    reload();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "操作失败");
  }
}

onMounted(reload);
</script>

<style scoped>
.title {
  font-size: 20px;
  margin: 20px 0;
}

.order-card {
  background: #fff;
  border-radius: 8px;
  padding: 16px 20px;
  margin-bottom: 16px;
}

.order-header {
  display: flex;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f0f0;
}

.order-id {
  color: #999;
  font-size: 13px;
}

.order-status {
  color: #e64340;
  font-size: 14px;
}

.order-body {
  padding: 12px 0;
  cursor: pointer;
}

.cart-line {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
}

.thumb {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 4px;
}

.cart-name {
  flex: 1;
  font-size: 14px;
}

.cart-num {
  color: #999;
}

.order-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 16px;
  padding-top: 12px;
  border-top: 1px solid #f0f0f0;
}

.total {
  color: #e64340;
  font-size: 18px;
  font-weight: 600;
}
</style>
