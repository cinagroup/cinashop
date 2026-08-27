<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import MetricRail from "@/components/MetricRail.vue";
import SalesTrend from "@/components/SalesTrend.vue";
import { getDashboard, getOrders, getProducts } from "@/api/supplier";
import type { DashboardStats, OrderRow, ProductRow } from "@/types";
import { formatMoney, formatTime, orderStatus, payType } from "@/utils/format";

const loading = ref(true);
const stats = ref<DashboardStats | null>(null);
const orders = ref<OrderRow[]>([]);
const products = ref<ProductRow[]>([]);

onMounted(async () => {
  try {
    const [dashboard, orderResult, productResult] = await Promise.all([
      getDashboard(),
      getOrders({ page: 1, limit: 8 }),
      getProducts({ page: 1, limit: 8 }),
    ]);
    stats.value = dashboard;
    orders.value = orderResult.list;
    products.value = productResult.list;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "经营数据加载失败");
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div v-loading="loading" class="dashboard-page">
    <MetricRail v-if="stats" :stats="stats" />

    <section class="surface trend-surface">
      <div class="section-heading">
        <div>
          <h1>销售额 / 订单趋势</h1>
          <p>近七日已支付订单</p>
        </div>
        <div v-if="stats" class="month-summary">
          本月销售额 <strong>{{ formatMoney(stats.month_sales) }}</strong>
        </div>
      </div>
      <SalesTrend v-if="stats" :trend="stats.trend" />
    </section>

    <div class="dashboard-bottom">
      <section class="surface order-surface">
        <div class="section-heading compact">
          <h2>最近订单</h2>
          <RouterLink to="/orders">查看全部</RouterLink>
        </div>
        <div class="table-scroll">
          <table class="data-table dashboard-orders">
            <thead><tr><th>订单号</th><th>客户</th><th>订单金额</th><th>支付方式</th><th>订单状态</th><th>下单时间</th></tr></thead>
            <tbody>
              <tr v-for="order in orders" :key="order.id">
                <td class="mono">{{ order.order_id }}</td>
                <td>{{ order.real_name }}</td>
                <td>{{ formatMoney(order.pay_price) }}</td>
                <td>{{ payType(order.pay_type) }}</td>
                <td><span class="status-text" :class="orderStatus(order).tone">{{ orderStatus(order).label }}</span></td>
                <td>{{ formatTime(order.add_time) }}</td>
              </tr>
              <tr v-if="orders.length === 0"><td colspan="6" class="empty-cell">暂无订单</td></tr>
            </tbody>
          </table>
        </div>
        <div class="mobile-order-list">
          <RouterLink v-for="order in orders" :key="order.id" class="mobile-order-row" to="/orders">
            <div class="mobile-row-primary">
              <span class="mono">{{ order.order_id }}</span>
              <strong>{{ formatMoney(order.pay_price) }}</strong>
            </div>
            <div class="mobile-row-secondary">
              <span>{{ order.real_name }}</span>
              <span class="status-text" :class="orderStatus(order).tone">{{ orderStatus(order).label }}</span>
            </div>
            <div class="mobile-row-meta">
              <span>{{ payType(order.pay_type) }}</span>
              <time>{{ formatTime(order.add_time) }}</time>
            </div>
          </RouterLink>
          <div v-if="orders.length === 0" class="mobile-empty">暂无订单</div>
        </div>
      </section>

      <section class="surface product-surface">
        <div class="section-heading compact">
          <h2>商品状态</h2>
          <RouterLink to="/products">查看全部</RouterLink>
        </div>
        <div class="table-scroll">
          <table class="data-table product-status-table">
            <thead><tr><th>商品名称</th><th>库存数量</th><th>库存状态</th></tr></thead>
            <tbody>
              <tr v-for="product in products" :key="product.id">
                <td>{{ product.store_name }}</td>
                <td>{{ product.stock }}</td>
                <td><span class="status-text" :class="product.stock < 30 ? 'warning' : 'success'">{{ product.stock < 30 ? "低库存" : "正常" }}</span></td>
              </tr>
              <tr v-if="products.length === 0"><td colspan="3" class="empty-cell">暂无商品</td></tr>
            </tbody>
          </table>
        </div>
        <div class="mobile-product-list">
          <RouterLink v-for="product in products" :key="product.id" class="mobile-product-row" to="/products">
            <div>
              <strong>{{ product.store_name }}</strong>
              <span>库存 {{ product.stock }}</span>
            </div>
            <span class="status-text" :class="product.stock < 30 ? 'warning' : 'success'">
              {{ product.stock < 30 ? "低库存" : "正常" }}
            </span>
          </RouterLink>
          <div v-if="products.length === 0" class="mobile-empty">暂无商品</div>
        </div>
      </section>
    </div>
  </div>
</template>
