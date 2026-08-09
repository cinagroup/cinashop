<template>
  <div class="order-detail-page">
    <div class="page-head">
      <h2>订单详情</h2>
      <el-button @click="$router.back()">返回</el-button>
    </div>

    <el-skeleton v-if="loading" :rows="8" animated />

    <template v-else-if="order">
      <!-- 订单信息 -->
      <el-card class="section" shadow="never">
        <template #header>订单信息</template>
        <el-descriptions :column="3" border>
          <el-descriptions-item label="订单号">{{ order.orderId }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="statusType">{{ statusText }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="支付方式">{{ order.payType || "—" }}</el-descriptions-item>
          <el-descriptions-item label="下单用户">
            {{ order.realName }} {{ order.userPhone }}
          </el-descriptions-item>
          <el-descriptions-item label="收货地址">
            {{ order.province }}{{ order.userAddress || "—" }}
          </el-descriptions-item>
          <el-descriptions-item label="下单时间">{{ formatTime(order.addTime) }}</el-descriptions-item>
        </el-descriptions>
      </el-card>

      <!-- 金额信息 -->
      <el-card class="section" shadow="never">
        <template #header>金额信息</template>
        <el-descriptions :column="3" border>
          <el-descriptions-item label="商品金额">¥{{ order.totalPrice }}</el-descriptions-item>
          <el-descriptions-item label="运费">¥{{ order.totalPostage }}</el-descriptions-item>
          <el-descriptions-item label="实付金额">
            <span class="pay-price">¥{{ order.payPrice }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="积分抵扣">{{ order.payIntegral || 0 }}</el-descriptions-item>
          <el-descriptions-item label="获得积分">{{ order.gainIntegral || 0 }}</el-descriptions-item>
          <el-descriptions-item label="订单备注">{{ order.mark || "—" }}</el-descriptions-item>
        </el-descriptions>
      </el-card>

      <!-- 商品列表 -->
      <el-card class="section" shadow="never">
        <template #header>商品明细</template>
        <el-table :data="cartInfo" border>
          <el-table-column label="商品" min-width="220">
            <template #default="{ row }">
              <div class="goods-cell">
                <el-image
                  v-if="row.cartInfo?.product?.image"
                  :src="row.cartInfo.product.image"
                  class="goods-img"
                  fit="cover"
                />
                <span>{{ row.cartInfo?.product?.storeName || row.cartInfo?.product?.store_name || "商品" }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="规格" width="160">
            <template #default="{ row }">{{ row.cartInfo?.product?.attrInfo?.suk || "默认" }}</template>
          </el-table-column>
          <el-table-column label="单价" width="100">
            <template #default="{ row }">¥{{ row.cartInfo?.product?.price || "0" }}</template>
          </el-table-column>
          <el-table-column prop="cartNum" label="数量" width="80" />
        </el-table>
      </el-card>
    </template>
    <el-empty v-else-if="!loading" description="订单不存在" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRoute } from "vue-router";
import { apiAdminOrderDetail } from "@/api/order";

const route = useRoute();
// 后端返回 camelCase 字段 (drizzle 映射)
const order = ref<Record<string, any> | null>(null);
const loading = ref(true);

const cartInfo = computed(() => {
  const ci = (order.value as any)?.cartInfo;
  return Array.isArray(ci) ? ci : [];
});

const statusText = computed(() => {
  const o = order.value;
  if (!o) return "";
  if (o.paid === 0) return "待支付";
  switch (o.status) {
    case 0: return "待发货";
    case 1: return "待收货";
    case 2: return "已收货";
    case 3: return "已完成";
    default: return "未知";
  }
});

const statusType = computed(() => {
  const o = order.value;
  if (!o) return "info";
  if (o.paid === 0 || o.status === 0) return "warning";
  if (o.status >= 2) return "success";
  return "primary";
});

function formatTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

onMounted(async () => {
  const orderId = route.params.orderId as string;
  try {
    order.value = await apiAdminOrderDetail(orderId);
  } catch (e) {
    console.error("订单详情加载失败", e);
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.page-head h2 {
  font-size: 18px;
  margin: 0;
}
.section {
  margin-bottom: 16px;
}
.pay-price {
  color: #e64340;
  font-weight: 700;
}
.goods-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}
.goods-img {
  width: 48px;
  height: 48px;
  border-radius: 6px;
  flex-shrink: 0;
}
</style>
