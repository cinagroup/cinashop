<template>
  <div class="order-detail-page">
    <div class="page-head">
      <h2>订单详情</h2>
      <el-button v-if="order && canRefund" @click="$router.push({ path: '/refund', query: { creationOrderId: String(order.id) } })">{{ order.pid === -1 ? '查看退款 / 恢复原请求' : '主动退款 / 恢复原请求' }}</el-button>
      <el-button v-if="sessionValid" :disabled="loading" @click="loadOrder">刷新</el-button>
      <el-button @click="$router.back()">返回</el-button>
    </div>

    <el-skeleton v-if="loading" :rows="8" animated />
    <el-alert v-else-if="readError" :title="readError" type="error" :closable="false" show-icon />

    <template v-else-if="order">
      <el-alert v-if="order.pid === -1" class="section" title="这是已拆分的支付主单：金额和商品是原始历史记录，不代表当前可履约数量。请打开下方子单查看当前状态；不要将主单金额与子单金额重复相加。" type="info" :closable="false" show-icon />
      <el-card v-if="order.pid === -1" class="section" shadow="never">
        <template #header>当前子单</template>
        <ul v-if="order.splitOrders.length" class="split-orders">
          <li v-for="child in order.splitOrders" :key="child.id">
            <router-link :to="`/order/${encodeURIComponent(child.orderId)}`">{{ child.orderId }}</router-link>
            <span>{{ adminOrderStatus(child) }} · {{ child.totalNum }} 件 · ¥{{ child.payPrice }}</span>
          </li>
        </ul>
        <el-empty v-else description="无可见子单，请按子单号核对" />
      </el-card>
      <!-- 订单信息 -->
      <el-card class="section" shadow="never">
        <template #header>订单信息</template>
        <el-descriptions :column="descriptionColumns" border>
          <el-descriptions-item label="订单号">{{ order.orderId }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag>{{ adminOrderStatus(order) }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="支付方式">{{ order.payType || "—" }}</el-descriptions-item>
          <el-descriptions-item label="下单用户">
            {{ order.realName }} {{ order.userPhone }}
          </el-descriptions-item>
          <el-descriptions-item label="收货地址">
            {{ order.userAddress || order.province || "—" }}
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
        <el-descriptions :column="descriptionColumns" border>
          <el-descriptions-item label="商品金额">¥{{ order.totalPrice }}</el-descriptions-item>
          <el-descriptions-item label="运费">¥{{ order.totalPostage }}</el-descriptions-item>
          <el-descriptions-item label="实付金额">
            <span class="pay-price">¥{{ order.payPrice }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="积分抵扣金额"><span class="deduction-price">¥{{ order.deductionPrice }}</span></el-descriptions-item>
          <el-descriptions-item label="使用积分"><span class="used-integral">{{ order.useIntegral }}</span></el-descriptions-item>
          <el-descriptions-item label="积分支付">{{ order.payIntegral }}</el-descriptions-item>
          <el-descriptions-item label="获得积分">{{ order.gainIntegral || 0 }}</el-descriptions-item>
          <el-descriptions-item label="订单备注">{{ order.mark || "—" }}</el-descriptions-item>
        </el-descriptions>
      </el-card>

      <!-- 商品列表 -->
      <el-card class="section" shadow="never">
        <template #header>{{ order.pid === -1 ? '原支付单商品历史' : '当前订单商品明细' }}</template>
        <el-table :data="order.cartInfo" border>
          <el-table-column prop="cartId" label="商品项 ID" width="110" />
          <el-table-column label="商品" min-width="220">
            <template #default="{ row }">
              <div class="goods-cell">
                <el-image
                  v-if="row.image"
                  :src="row.image"
                  class="goods-img"
                  fit="cover"
                />
                <span>{{ row.name }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="规格" width="160">
            <template #default="{ row }">{{ row.sku }}</template>
          </el-table-column>
          <el-table-column label="单价" width="100">
            <template #default="{ row }">{{ row.price === null ? '—' : `¥${row.price}` }}</template>
          </el-table-column>
          <el-table-column prop="cartNum" label="数量" width="80" />
        </el-table>
      </el-card>
    </template>
    <el-empty v-else-if="!loading" description="订单不存在" />

    <el-dialog v-model="writeoffVisible" title="确认订单核销" width="min(720px, 94vw)" destroy-on-close>
      <template v-if="writeoffPreview">
        <el-descriptions :column="descriptionColumns === 1 ? 1 : 2" border class="writeoff-summary">
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
import { ref, computed, watch, onBeforeUnmount } from "vue";
import { useRoute, onBeforeRouteLeave } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiAdminOrderDetail,
  apiAdminWriteoff,
  apiAdminWriteoffInfo,
  type AdminWriteoffPreview,
} from "@/api/order";
import { createAdminSessionScope } from '@/utils/adminSessionScope';
import { getAdminSession } from '@/utils/auth';
import { adminOrderStatus, isCurrentFulfillment, type AdminOrderDetail } from '@/utils/orderRead';

const route = useRoute();
const order = ref<AdminOrderDetail | null>(null);
const loading = ref(true);
const readError = ref('');
const sessionValid = ref(true);
const session = getAdminSession();
const permitted = (permission: string) => sessionValid.value && Boolean(session && (session.userInfo.level === 0 || session.uniqueAuth.includes(permission)));
const canRefund = computed(() => permitted('refund.manage'));
const narrowScreen = window.matchMedia('(max-width: 768px)');
const descriptionColumns = ref(narrowScreen.matches ? 1 : 3);
const resize = () => { descriptionColumns.value = narrowScreen.matches ? 1 : 3; };
narrowScreen.addEventListener('change', resize);
const writeoffCode = ref("");
const writeoffVisible = ref(false);
const writeoffLoading = ref(false);
const writeoffPreview = ref<AdminWriteoffPreview | null>(null);
const writeoffQuantities = ref<Record<number, number>>({});
const canAdminWriteoff = computed(() => Boolean(
  permitted('order.manage') && order.value && isCurrentFulfillment(order.value) &&
  (
    (order.value.shippingType === 2 && [0, 5].includes(order.value.status)) ||
    (order.value.deliveryType === "send" && [1, 5].includes(order.value.status))
  ),
));

let epoch = 0, writeoffEpoch = 0;
let previewCode = '';
let readController: AbortController | undefined;
const scope = createAdminSessionScope(() => {
  sessionValid.value = false; reset(); readError.value = '登录状态已变化，请重新打开页面';
});
function resetWriteoff() {
  writeoffEpoch++; writeoffVisible.value = false; writeoffPreview.value = null;
  writeoffQuantities.value = {}; writeoffLoading.value = false; previewCode = '';
}
function reset() {
  epoch++; readController?.abort(); order.value = null; loading.value = false;
  resetWriteoff(); writeoffCode.value = '';
}
function dispose() { reset(); scope.dispose(); }
onBeforeRouteLeave(dispose);
onBeforeUnmount(() => { dispose(); narrowScreen.removeEventListener('change', resize); });
watch(writeoffCode, resetWriteoff, { flush: 'sync' });
watch(writeoffVisible, visible => { if (!visible) resetWriteoff(); }, { flush: 'sync' });

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
  if (!scope.isCurrent() || !canAdminWriteoff.value || writeoffLoading.value) return;
  const code = writeoffCode.value.trim();
  if (!/^\d{12}$/.test(code)) return ElMessage.warning("请输入12位核销码");
  writeoffLoading.value = true;
  const generation = ++writeoffEpoch, currentOrder = order.value!;
  const current = () => scope.isCurrent() && generation === writeoffEpoch && order.value === currentOrder;
  try {
    const preview = await apiAdminWriteoffInfo(code, scope.signal);
    if (!current()) return;
    if (!preview || preview.order_id !== currentOrder.orderId || preview.id !== currentOrder.id || preview.actor_kind !== 'admin'
      || !Array.isArray(preview.cart_info) || !preview.cart_info.length || preview.cart_info.length > 200
      || new Set(preview.cart_info.map(item => item.id)).size !== preview.cart_info.length
      || preview.cart_info.some(item => !currentOrder.cartInfo.some(cart => cart.id === item.id && cart.cartId === item.cart_id)
        || !Number.isSafeInteger(item.write_surplus_times) || item.write_surplus_times < 0)) throw Error('核销响应不属于当前订单或不完整');
    writeoffPreview.value = preview;
    writeoffQuantities.value = Object.fromEntries(
      preview.cart_info.map((item) => [item.id, item.write_surplus_times]),
    );
    writeoffVisible.value = true;
    previewCode = code;
  } catch (error) {
    if (!current()) return;
    ElMessage.error(error instanceof Error ? error.message : "核销码校验失败");
  } finally {
    if (current()) writeoffLoading.value = false;
  }
}

async function executeWriteoff(all: boolean) {
  if (!scope.isCurrent() || !canAdminWriteoff.value || !writeoffVisible.value || !writeoffPreview.value || writeoffLoading.value) return;
  const preview = writeoffPreview.value, code = previewCode, generation = writeoffEpoch, orderEpoch = epoch;
  if (!code || code !== writeoffCode.value.trim()) return;
  const current = () => scope.isCurrent() && epoch === orderEpoch && writeoffEpoch === generation && writeoffPreview.value === preview && writeoffVisible.value;
  if (!all && preview.cart_info.some(item => !Number.isSafeInteger(writeoffQuantities.value[item.id])
    || writeoffQuantities.value[item.id] < 0 || writeoffQuantities.value[item.id] > item.write_surplus_times)) return ElMessage.warning('核销数量无效');
  const items = all
    ? undefined
    : writeoffPreview.value.cart_info
        .map((item) => ({ order_cart_id: item.id, quantity: Number(writeoffQuantities.value[item.id] ?? 0) }))
        .filter((item) => item.quantity > 0);
  if (!all && !items?.length) return ElMessage.warning("请选择本次核销数量");
  const quantities = JSON.stringify(writeoffQuantities.value);
  writeoffLoading.value = true;
  try {
    await ElMessageBox.confirm(
      all ? "确认核销该订单全部剩余商品并进入结算？" : "确认核销选定商品数量？",
      "不可撤销操作",
      { type: "warning", confirmButtonText: "确认核销" },
    );
  } catch {
    if (current()) writeoffLoading.value = false;
    return;
  }
  if (!current()) return;
  if (quantities !== JSON.stringify(writeoffQuantities.value)) { writeoffLoading.value = false; return ElMessage.warning('数量已变化，请重新确认'); }
  try {
    const result = await apiAdminWriteoff(code, items, scope.signal);
    if (!current()) return;
    if (!result || result.order_id !== preview.order_id || typeof result.completed !== 'boolean' || !Number.isSafeInteger(result.status)) throw Error('核销回执不完整，请刷新核对，不要重复操作');
    ElMessage.success(result.completed ? "订单已全部核销" : "部分核销成功，客户核销码已更新");
    writeoffVisible.value = false;
    writeoffCode.value = "";
    await loadOrder();
  } catch (error) {
    if (!current()) return;
    ElMessage.error(error instanceof Error ? error.message : "核销失败");
  } finally {
    if (current()) writeoffLoading.value = false;
  }
}

async function loadOrder() {
  if (!scope.isCurrent()) return;
  reset(); readError.value = ''; loading.value = true;
  const generation = epoch, orderId = route.params.orderId;
  const controller = new AbortController(); readController = controller;
  try {
    if (typeof orderId !== 'string') throw Error('订单号无效');
    const result = await apiAdminOrderDetail(orderId, controller.signal);
    if (scope.isCurrent() && generation === epoch) order.value = result;
  } catch (e) {
    if (scope.isCurrent() && generation === epoch) readError.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    if (generation === epoch) loading.value = false;
  }
}
watch(() => route.params.orderId, loadOrder, { immediate: true, flush: 'sync' });
</script>

<style scoped>
.page-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
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
.split-orders { list-style: none; margin: 0; padding: 0; }
.split-orders li { display: flex; flex-wrap: wrap; gap: 8px 24px; padding: 10px 0; border-bottom: 1px solid #ebeef5; overflow-wrap: anywhere; }
.split-orders a { color: #337ecc; }
:deep(.el-descriptions__content) { overflow-wrap: anywhere; }
@media (max-width: 768px) {
  .page-head h2 { width: 100%; }
  .page-head .el-button { margin-left: 0; }
  .writeoff-entry { flex-wrap: wrap; }
  :deep(.el-card__body) { padding: 12px; }
}
</style>
