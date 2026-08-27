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

      <el-card
        v-if="canAdminWriteoff"
        class="section"
        shadow="never"
      >
        <template #header>{{ order.deliveryType === "send" ? "送达核销" : "门店核销" }}</template>
        <div class="writeoff-entry">
          <el-input
            v-model="writeoffCode"
            maxlength="12"
            placeholder="扫描或输入客户出示的12位核销码"
            @keyup.enter="previewWriteoff"
          />
          <el-button type="primary" :loading="writeoffLoading" @click="previewWriteoff">校验核销码</el-button>
        </div>
        <el-alert
          title="管理端核销会直接进入订单结算；请当面确认客户、履约人员和商品后操作。"
          type="warning"
          :closable="false"
          show-icon
        />
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

    <el-dialog v-model="writeoffVisible" title="确认订单核销" width="min(720px, 94vw)" destroy-on-close>
      <template v-if="writeoffPreview">
        <el-descriptions :column="2" border class="writeoff-summary">
          <el-descriptions-item label="订单号">{{ writeoffPreview.order_id }}</el-descriptions-item>
          <el-descriptions-item label="客户">{{ writeoffPreview.real_name }} {{ writeoffPreview.user_phone }}</el-descriptions-item>
        </el-descriptions>
        <el-table :data="writeoffPreview.cart_info" border>
          <el-table-column label="商品" min-width="220">
            <template #default="{ row }">{{ writeoffProductName(row.cart_info) }}</template>
          </el-table-column>
          <el-table-column label="总次数" prop="write_times" width="90" />
          <el-table-column label="剩余" prop="write_surplus_times" width="90" />
          <el-table-column label="本次核销" width="170">
            <template #default="{ row }">
              <el-input-number
                v-model="writeoffQuantities[row.id]"
                :min="0"
                :max="row.write_surplus_times"
                :disabled="row.write_surplus_times <= 0"
              />
            </template>
          </el-table-column>
        </el-table>
      </template>
      <template #footer>
        <el-button @click="writeoffVisible = false">取消</el-button>
        <el-button :loading="writeoffLoading" @click="executeWriteoff(false)">核销选定数量</el-button>
        <el-button type="danger" :loading="writeoffLoading" @click="executeWriteoff(true)">全部核销</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRoute } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiAdminOrderDetail,
  apiAdminWriteoff,
  apiAdminWriteoffInfo,
  type AdminWriteoffPreview,
} from "@/api/order";

const route = useRoute();
// 后端返回 camelCase 字段 (drizzle 映射)
const order = ref<Record<string, any> | null>(null);
const loading = ref(true);
const writeoffCode = ref("");
const writeoffVisible = ref(false);
const writeoffLoading = ref(false);
const writeoffPreview = ref<AdminWriteoffPreview | null>(null);
const writeoffQuantities = ref<Record<number, number>>({});
const canAdminWriteoff = computed(() => Boolean(
  order.value?.paid === 1 &&
  (
    (order.value.shippingType === 2 && [0, 5].includes(order.value.status)) ||
    (order.value.deliveryType === "send" && [1, 5].includes(order.value.status))
  ),
));

const cartInfo = computed(() => {
  const ci = (order.value as any)?.cartInfo;
  return Array.isArray(ci) ? ci : [];
});

const statusText = computed(() => {
  const o = order.value;
  if (!o) return "";
  if (o.paid === 0) return "待支付";
  if (o.shippingType === 2 && o.status === 0) return "待到店核销";
  if (o.shippingType === 2 && o.status === 5) return "部分核销";
  if (o.deliveryType === "send" && o.status === 1) return "配送中，待送达核销";
  if (o.deliveryType === "send" && o.status === 5) return "部分送达核销";
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

function writeoffProductName(snapshot: Record<string, unknown> | null): string {
  if (!snapshot || typeof snapshot !== "object") return "商品";
  const product = snapshot.product;
  if (!product || typeof product !== "object" || Array.isArray(product)) return "商品";
  const value = (product as Record<string, unknown>).storeName;
  return typeof value === "string" && value ? value : "商品";
}

async function previewWriteoff() {
  const code = writeoffCode.value.trim();
  if (!/^\d{12}$/.test(code)) return ElMessage.warning("请输入12位核销码");
  writeoffLoading.value = true;
  try {
    const preview = await apiAdminWriteoffInfo(code);
    if (preview.order_id !== order.value?.orderId) {
      return ElMessage.error("核销码不属于当前订单");
    }
    writeoffPreview.value = preview;
    writeoffQuantities.value = Object.fromEntries(
      preview.cart_info.map((item) => [item.id, item.write_surplus_times]),
    );
    writeoffVisible.value = true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "核销码校验失败");
  } finally {
    writeoffLoading.value = false;
  }
}

async function executeWriteoff(all: boolean) {
  if (!writeoffPreview.value || writeoffLoading.value) return;
  const items = all
    ? undefined
    : writeoffPreview.value.cart_info
        .map((item) => ({ order_cart_id: item.id, quantity: Number(writeoffQuantities.value[item.id] ?? 0) }))
        .filter((item) => item.quantity > 0);
  if (!all && !items?.length) return ElMessage.warning("请选择本次核销数量");
  try {
    await ElMessageBox.confirm(
      all ? "确认核销该订单全部剩余商品并进入结算？" : "确认核销选定商品数量？",
      "不可撤销操作",
      { type: "warning", confirmButtonText: "确认核销" },
    );
  } catch {
    return;
  }
  writeoffLoading.value = true;
  try {
    const result = await apiAdminWriteoff(writeoffCode.value.trim(), items);
    ElMessage.success(result.completed ? "订单已全部核销" : "部分核销成功，客户核销码已更新");
    writeoffVisible.value = false;
    writeoffCode.value = "";
    await loadOrder();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "核销失败");
  } finally {
    writeoffLoading.value = false;
  }
}

async function loadOrder() {
  const orderId = route.params.orderId as string;
  order.value = await apiAdminOrderDetail(orderId);
}

onMounted(async () => {
  try {
    await loadOrder();
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

.writeoff-entry {
  display: flex;
  gap: 12px;
  max-width: 620px;
  margin-bottom: 14px;
}

.writeoff-summary {
  margin-bottom: 16px;
}
</style>
