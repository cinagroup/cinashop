<template>
  <div class="order-list">
    <el-card shadow="never" class="filter-card">
      <el-form inline>
        <el-form-item label="订单号">
          <el-input v-model="query.order_id" aria-label="订单号" placeholder="订单号 / 原支付单号" clearable @keyup.enter="reload" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="query.status" placeholder="全部" clearable style="width: 140px">
            <el-option label="待发货" :value="0" />
            <el-option label="待收货" :value="1" />
            <el-option label="已收货" :value="2" />
            <el-option label="已完成" :value="3" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :disabled="!sessionValid" @click="reload">搜索</el-button>
          <el-button :disabled="!sessionValid || !query.order_id.trim()" @click="openSearchedOrder">查看此单详情</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never">
      <p class="form-tip">展示当前履约单；输入原支付单号可查找其子单。</p>
      <el-alert v-if="readError" :title="readError" type="error" :closable="false" show-icon />
      <el-button v-if="readError && sessionValid" @click="fetch">重新加载</el-button>
      <el-table :data="list" v-loading="loading">
        <el-table-column prop="orderId" label="订单号" min-width="200" />
        <el-table-column prop="realName" label="收货人" width="100" />
        <el-table-column prop="userPhone" label="电话" width="120" />
        <el-table-column prop="totalNum" label="数量" width="70" />
        <el-table-column label="金额" width="110">
          <template #default="{ row }">¥{{ row.payPrice }}</template>
        </el-table-column>
        <el-table-column label="支付状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.paid === 1 ? 'success' : 'warning'">
              {{ row.paid === 1 ? "已支付" : "未支付" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="订单状态" width="100">
          <template #default="{ row }">{{ adminOrderStatus(row) }}</template>
        </el-table-column>
        <el-table-column label="下单时间" width="160">
          <template #default="{ row }">{{ formatTime(row.addTime) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="$router.push(`/order/${encodeURIComponent(row.orderId)}`)">
              详情
            </el-button>
            <el-button v-if="canManage" :disabled="printingIds.has(row.id)" link type="primary" @click="printOrder(row)">打印</el-button>
            <el-button
              v-if="canDeliver(row)"
              link
              type="primary"
              @click="deliver(row)"
            >
              发货
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-if="!loading && !readError && sessionValid"
        v-model:current-page="query.page"
        :page-size="query.limit"
        :total="total"
        :pager-count="5"
        :disabled="loading || !sessionValid"
        layout="total, prev, pager, next"
        class="pagination"
        @current-change="fetch"
      />
    </el-card>

    <el-dialog v-model="deliveryVisible" title="订单发货" width="min(560px, 94vw)" destroy-on-close>
      <el-form label-position="top">
        <el-form-item label="订单号"><strong>{{ deliveryOrder?.orderId }}</strong></el-form-item>
        <el-form-item label="发货方式">
          <el-radio-group v-model="deliveryForm.delivery_type">
            <template v-if="deliveryOrder?.productType === 3">
              <el-radio-button value="fictitious">虚拟交付</el-radio-button>
            </template>
            <template v-else>
              <el-radio-button value="waybill">电子面单</el-radio-button>
              <el-radio-button value="express">手填快递</el-radio-button>
              <el-radio-button value="send">平台配送</el-radio-button>
            </template>
          </el-radio-group>
        </el-form-item>
        <template v-if="deliveryForm.delivery_type === 'express' || deliveryForm.delivery_type === 'waybill'">
          <el-form-item label="快递公司"><el-select v-model="deliveryForm.carrier_id" filterable placeholder="请选择" style="width:100%" @change="selectCarrier"><el-option v-for="item in expressOptions" :key="item.id" :value="item.id" :label="item.name" /></el-select></el-form-item>
          <el-form-item v-if="deliveryForm.delivery_type === 'express'" label="快递单号"><el-input v-model="deliveryForm.delivery_id" maxlength="64" /></el-form-item>
          <el-alert v-else title="签发异步执行；超时或断线后不会自动重复申请单号，请在电子面单账本核对。" type="info" :closable="false" show-icon />
        </template>
        <el-form-item v-else-if="deliveryForm.delivery_type === 'send'" label="配送员">
          <el-select v-model="deliveryForm.delivery_uid" filterable placeholder="选择有效平台配送员" style="width: 100%">
            <el-option
              v-for="item in deliveryOptions"
              :key="item.id"
              :label="`${item.nickname} ${item.phone}`"
              :value="item.uid"
            />
          </el-select>
          <div v-if="!deliveryOptions.length" class="form-tip">请先在“配送员管理”中添加并启用配送员。</div>
        </el-form-item>
        <el-form-item v-else label="交付说明">
          <el-input v-model="deliveryForm.fictitious_content" type="textarea" :rows="4" maxlength="500" show-word-limit />
        </el-form-item>
        <el-alert
          v-if="deliveryForm.delivery_type === 'send'"
          title="平台配送发货后会生成12位送达核销码；客户不能绕过配送员自行确认收货。"
          type="warning"
          :closable="false"
          show-icon
        />
      </el-form>
      <template #footer>
        <el-button @click="deliveryVisible = false">取消</el-button>
        <el-button type="primary" :disabled="deliveryOptionsLoading" :loading="deliverySubmitting" @click="submitDelivery">{{ deliveryForm.delivery_type === 'waybill' ? '创建签发任务' : '确认发货' }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { ElMessage } from "element-plus";
import {
  apiAdminDeliveryOptions,
  apiAdminOrderList,
  apiAdminOrderDelivery,
  apiAdminCreateWaybill,
  type AdminDeliveryOption,
} from "@/api/order";
import { apiAdminExpressList, type ExpressItem } from "@/api/shipping";
import { apiAdminManualPrint } from "@/api/printing";
import type { AdminOrder } from "@/types/admin";
import dayjs from "dayjs";
import { createAdminSessionScope } from '@/utils/adminSessionScope';
import { getAdminSession } from '@/utils/auth';
import { adminOrderStatus, isCurrentFulfillment, orderNumber } from '@/utils/orderRead';

const router = useRouter();

const list = ref<AdminOrder[]>([]);
const loading = ref(false);
const total = ref(0);
const readError = ref('');
const sessionValid = ref(true);
const session = getAdminSession();
const canManage = computed(() => sessionValid.value && Boolean(session && (session.userInfo.level === 0 || session.uniqueAuth.includes('order.manage'))));
const printingIds = reactive(new Set<number>());
const deliveryVisible = ref(false);
const deliverySubmitting = ref(false);
const deliveryOptionsLoading = ref(false);
const deliveryOrder = ref<AdminOrder | null>(null);
const deliveryOptions = ref<AdminDeliveryOption[]>([]);
const expressOptions = ref<ExpressItem[]>([]);
const deliveryForm = reactive({
  delivery_type: "express" as "express" | "waybill" | "send" | "fictitious",
  carrier_id: 0,
  delivery_name: "",
  delivery_id: "",
  delivery_uid: 0,
  fictitious_content: "",
});
const query = reactive({ page: 1, limit: 10, order_id: "", status: undefined as number | undefined });
let epoch = 0, deliveryEpoch = 0;
let readController: AbortController | undefined;
const scope = createAdminSessionScope(() => {
  sessionValid.value = false; reset(); readError.value = '登录状态已变化，请重新打开页面';
});
function reset(clearCount = true) {
  epoch++; readController?.abort(); list.value = []; if (clearCount) total.value = 0; loading.value = false;
  deliveryVisible.value = false; deliveryOrder.value = null; deliveryEpoch++;
  deliveryOptions.value = []; expressOptions.value = []; deliveryOptionsLoading.value = false;
}
function dispose() { reset(); scope.dispose(); }
onBeforeUnmount(dispose);
onBeforeRouteLeave(dispose);
watch(deliveryVisible, visible => { if (!visible) { deliveryEpoch++; deliveryOrder.value = null; } }, { flush: 'sync' });
function currentRow(row: AdminOrder) {
  return scope.isCurrent() && !loading.value && list.value.some(item => item === row);
}
function canDeliver(row: AdminOrder) {
  return canManage.value && isCurrentFulfillment(row) && row.status === 0 && row.shippingType !== 2;
}

function formatTime(ts: number): string {
  return ts ? dayjs(ts * 1000).format("YYYY-MM-DD HH:mm") : "-";
}

async function fetch() {
  if (!scope.isCurrent()) return;
  // Retain the last count while the pager is hidden. A transient zero would
  // make Element Plus clamp current-page back to 1 and emit another request.
  reset(false);
  const generation = epoch;
  const controller = new AbortController(); readController = controller;
  readError.value = '';
  loading.value = true;
  try {
    const result = await apiAdminOrderList({
      page: query.page,
      limit: query.limit,
      order_id: query.order_id.trim() || undefined,
      status: typeof query.status === 'number' ? query.status : undefined,
    }, controller.signal);
    if (!scope.isCurrent() || generation !== epoch) return;
    list.value = result.list;
    total.value = result.total;
  } catch (e) {
    if (scope.isCurrent() && generation === epoch) { readError.value = e instanceof Error ? e.message : '加载失败'; total.value = 0; }
  } finally {
    if (generation === epoch) loading.value = false;
  }
}

function reload() {
  query.page = 1;
  fetch();
}

async function deliver(row: AdminOrder) {
  if (!currentRow(row) || !canDeliver(row) || deliverySubmitting.value) return;
  const generation = ++deliveryEpoch;
  deliveryOptions.value = []; expressOptions.value = []; deliveryOptionsLoading.value = true;
  deliveryOrder.value = row;
  Object.assign(deliveryForm, {
    delivery_type: row.productType === 3 ? "fictitious" : "express",
    delivery_name: "",
    carrier_id: 0,
    delivery_id: "",
    delivery_uid: 0,
    fictitious_content: "",
  });
  deliveryVisible.value = true;
  try {
    const [deliveries, carriers] = row.productType === 3
      ? [{ list: [] as AdminDeliveryOption[] }, [] as ExpressItem[]]
      : await Promise.all([apiAdminDeliveryOptions(scope.signal), apiAdminExpressList(scope.signal)]);
    if (!currentRow(row) || generation !== deliveryEpoch || !deliveryVisible.value) return;
    deliveryOptions.value = deliveries.list;
    expressOptions.value = carriers.filter((item) => item.status === 1 && item.isShow === 1);
  } catch (error) {
    if (!currentRow(row) || generation !== deliveryEpoch) return;
    deliveryOptions.value = [];
    ElMessage.warning(error instanceof Error ? error.message : "配送员列表加载失败");
  } finally {
    if (generation === deliveryEpoch) deliveryOptionsLoading.value = false;
  }
}
function openSearchedOrder() {
  if (!scope.isCurrent()) return;
  try { router.push('/order/' + orderNumber(query.order_id.trim())); }
  catch (error) { ElMessage.warning(error instanceof Error ? error.message : '订单号无效'); }
}

function selectCarrier(id: number) {
  const carrier = expressOptions.value.find((item) => item.id === id);
  deliveryForm.delivery_name = carrier?.name ?? "";
}

async function printOrder(row: AdminOrder) {
  if (!currentRow(row) || !canManage.value || printingIds.has(row.id)) return;
  printingIds.add(row.id);
  const generation = epoch;
  try {
    const result = await apiAdminManualPrint(row.id, undefined, scope.signal);
    if (!currentRow(row) || generation !== epoch) return;
    ElMessage.success(result.duplicate ? "该打印请求已受理" : `已创建 ${result.jobs.length} 个打印任务`);
  } catch (error) {
    if (!currentRow(row) || generation !== epoch) return;
    ElMessage.error(error instanceof Error ? error.message : "创建打印任务失败");
  } finally {
    printingIds.delete(row.id);
  }
}

async function submitDelivery() {
  const row = deliveryOrder.value, generation = deliveryEpoch;
  if (!row || !deliveryVisible.value || !currentRow(row) || !canDeliver(row) || deliverySubmitting.value || deliveryOptionsLoading.value) return;
  const current = () => currentRow(row) && generation === deliveryEpoch;
  if (["express", "waybill"].includes(deliveryForm.delivery_type) && deliveryForm.carrier_id <= 0) {
    return ElMessage.warning("请选择快递公司");
  }
  if (deliveryForm.delivery_type === "express" && !deliveryForm.delivery_id.trim()) {
    return ElMessage.warning("请输入快递单号");
  }
  if (deliveryForm.delivery_type === "send" && deliveryForm.delivery_uid <= 0) {
    return ElMessage.warning("请选择配送员");
  }
  if (deliveryForm.delivery_type === "fictitious" && !deliveryForm.fictitious_content.trim()) {
    return ElMessage.warning("请输入交付说明");
  }
  deliverySubmitting.value = true;
  try {
    if (deliveryForm.delivery_type === "waybill") {
      const result = await apiAdminCreateWaybill(row.orderId, deliveryForm.carrier_id, scope.signal);
      if (!current()) return;
      ElMessage.success(result.duplicate ? "该签发请求已受理" : "电子面单任务已创建，请在面单账本查看结果");
      deliveryVisible.value = false;
      return;
    }
    await apiAdminOrderDelivery(row.orderId, {
      delivery_type: deliveryForm.delivery_type as "express" | "send" | "fictitious",
      delivery_name: deliveryForm.delivery_name.trim(),
      delivery_id: deliveryForm.delivery_id.trim(),
      delivery_uid: deliveryForm.delivery_uid,
      fictitious_content: deliveryForm.fictitious_content.trim(),
    }, scope.signal);
    if (!current()) return;
    ElMessage.success("发货成功");
    deliveryVisible.value = false;
    await fetch();
  } catch (e) {
    if (!current()) return;
    ElMessage.error(e instanceof Error ? e.message : "发货失败");
  } finally {
    deliverySubmitting.value = false;
  }
}

onMounted(fetch);
</script>

<style scoped>
.filter-card {
  margin-bottom: 16px;
}

.pagination {
  margin-top: 16px;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 4px;
}

.form-tip {
  margin-top: 8px;
  color: #909399;
  font-size: 12px;
}
</style>
