<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Search } from "@element-plus/icons-vue";
import {
  confirmOrderTake,
  createWaybillJob,
  createManualPrintJobs,
  deliverOrder,
  exportSupplierBatchDelivery,
  exportSupplierExpressList,
  exportSupplierOrders,
  getExpressList,
  getOrderDetail,
  getOrders,
  getOrderStatus,
  getSplitCartInfo,
  getSplitOrders,
  getSupplierQueueDeliveryLog,
  getSupplierQueueHistory,
  previewMode,
  splitDeliverOrder,
  updateOrderRemark,
} from "@/api/supplier";
import type {
  ExpressCompany,
  OrderRow,
  OrderStatusLog,
  SplitCartItem,
  SplitOrder,
  SupplierQueueDeliveryLogRow,
  SupplierQueueHistoryRow,
} from "@/types";
import { useAuthStore } from "@/stores/auth";
import { formatMoney, formatTime, orderStatus, payType } from "@/utils/format";
import { downloadLegacyExport } from "@/utils/legacy-export";

type DeliveryType = "express" | "waybill" | "send" | "fictitious";

const auth = useAuthStore();
const router = useRouter();
const loading = ref(false);
const rows = ref<OrderRow[]>([]);
const total = ref(0);
const filters = reactive({ page: 1, limit: 20, order: "", paid: "", status: "" });
const selectedOrders = ref<OrderRow[]>([]);
const exportLoading = ref(false);
const queueDialogOpen = ref(false);
const queueLoading = ref(false);
const queueRows = ref<SupplierQueueHistoryRow[]>([]);
const queueTotal = ref(0);
const queueFilters = reactive({ page: 1, limit: 20, type: "", status: "" });
const queueDetailOpen = ref(false);
const queueDetailLoading = ref(false);
const queueDetailRows = ref<SupplierQueueDeliveryLogRow[]>([]);
const queueDetailTotal = ref(0);
const queueDetailPage = ref(1);
const queueDetailCurrent = ref<SupplierQueueHistoryRow | null>(null);
const drawerOpen = ref(false);
const detailLoading = ref(false);
const current = ref<(OrderRow & { cart_info: unknown[] }) | null>(null);
const remark = ref("");
const statusLogs = ref<OrderStatusLog[]>([]);
const shipments = ref<SplitOrder[]>([]);
const expressCompanies = ref<ExpressCompany[]>([]);
const deliveryDialogOpen = ref(false);
const actionLoading = ref(false);
const deliveryMode = ref<"whole" | "partial">("whole");
const splitItems = ref<SplitCartItem[]>([]);
const selectedQuantities = reactive<Record<string, number>>({});
const deliveryForm = reactive({
  delivery_type: "express" as DeliveryType,
  company_id: "" as number | "",
  delivery_name: "",
  delivery_code: "",
  delivery_id: "",
  fictitious_content: "",
});

const canManageOrders = computed(() => auth.can("supplier.order.manage"));
const canManagePrint = computed(() => auth.can("supplier.print.manage"));
const canManageWaybills = computed(() => auth.can("supplier.waybill.manage"));
const isManualVirtualOrder = computed(() => current.value?.product_type === 3);

const deliveryTitle = computed(() => {
  const prefix = deliveryMode.value === "partial" ? "分批" : "整单";
  if (deliveryForm.delivery_type === "send") return `${prefix}同城配送`;
  if (deliveryForm.delivery_type === "fictitious") return `${prefix}虚拟发货`;
  if (deliveryForm.delivery_type === "waybill") return `${prefix}电子面单签发`;
  return `${prefix}快递发货`;
});

const availableQuantity = computed(() =>
  splitItems.value.reduce((sum, item) => sum + item.surplus_num, 0),
);

const selectedQuantity = computed(() =>
  splitItems.value.reduce((sum, item) => sum + (selectedQuantities[item.cart_id] ?? 0), 0),
);

function canDeliver(row: OrderRow) {
  return canManageOrders.value && row.paid === 1 && row.status === 0 && row.refund_status === 0;
}

function canConfirmTake(row: OrderRow) {
  return canManageOrders.value && row.paid === 1 && row.status === 1;
}

function selectOrders(selection: OrderRow[]) {
  selectedOrders.value = selection;
}

function openPickingSheets(orders: OrderRow[]) {
  const ids = [...new Set(orders.map((row) => row.id))];
  if (!ids.length) return ElMessage.warning("请先选择本页订单");
  if (ids.length > 10) return ElMessage.warning("每次最多预览10个订单");
  const target = router.resolve({
    path: "/orders/picking-sheet",
    query: { ids: ids.join(","), ...(previewMode ? { preview: "1" } : {}) },
  });
  window.open(target.href, "_blank", "noopener,noreferrer");
}

async function downloadSelectedOrders(type: 0 | 1) {
  if (!canManageOrders.value) return;
  if (!selectedOrders.value.length) {
    ElMessage.warning("请先选择本页订单");
    return;
  }
  exportLoading.value = true;
  try {
    const manifest = await exportSupplierOrders({
      ids: selectedOrders.value.map((row) => row.id).join(","),
      type,
      page: 1,
    });
    downloadLegacyExport(manifest);
    ElMessage.success(type === 1 ? "发货单已下载" : "订单清单已下载");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "订单导出失败");
  } finally {
    exportLoading.value = false;
  }
}

async function downloadExpressDirectory() {
  exportLoading.value = true;
  try {
    downloadLegacyExport(await exportSupplierExpressList());
    ElMessage.success("物流公司对照表已下载");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "物流公司导出失败");
  } finally {
    exportLoading.value = false;
  }
}

async function loadQueueHistory() {
  queueLoading.value = true;
  try {
    const result = await getSupplierQueueHistory(queueFilters);
    queueRows.value = result.list;
    queueTotal.value = result.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "批量任务历史加载失败");
  } finally {
    queueLoading.value = false;
  }
}

async function openQueueHistory() {
  queueDialogOpen.value = true;
  await loadQueueHistory();
}

function searchQueueHistory() {
  queueFilters.page = 1;
  void loadQueueHistory();
}

async function loadQueueDetail() {
  if (!queueDetailCurrent.value) return;
  queueDetailLoading.value = true;
  try {
    const result = await getSupplierQueueDeliveryLog(
      queueDetailCurrent.value.id,
      queueDetailCurrent.value.cache_type,
      { page: queueDetailPage.value, limit: 20 },
    );
    queueDetailRows.value = result.list;
    queueDetailTotal.value = result.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "任务明细加载失败");
  } finally {
    queueDetailLoading.value = false;
  }
}

async function openQueueDetail(row: SupplierQueueHistoryRow) {
  queueDetailCurrent.value = row;
  queueDetailPage.value = 1;
  queueDetailOpen.value = true;
  await loadQueueDetail();
}

async function downloadQueueHistory(row: SupplierQueueHistoryRow) {
  if (!canManageOrders.value) return;
  exportLoading.value = true;
  try {
    downloadLegacyExport(await exportSupplierBatchDelivery(row.id, row.type, row.cache_type));
    ElMessage.success("批量任务记录已下载");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "任务记录导出失败");
  } finally {
    exportLoading.value = false;
  }
}

async function load() {
  loading.value = true;
  try {
    const result = await getOrders(filters);
    rows.value = result.list;
    total.value = result.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "订单加载失败");
  } finally {
    loading.value = false;
  }
}

function search() {
  filters.page = 1;
  void load();
}

async function loadOrderDetail(id: number) {
  const [detail, logs, splitOrderRows] = await Promise.all([
    getOrderDetail(id),
    getOrderStatus(id),
    getSplitOrders(id),
  ]);
  current.value = detail;
  remark.value = detail.remark;
  statusLogs.value = logs;
  shipments.value = splitOrderRows;
}

async function openOrder(row: OrderRow) {
  drawerOpen.value = true;
  detailLoading.value = true;
  try {
    await loadOrderDetail(row.id);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "订单详情加载失败");
  } finally {
    detailLoading.value = false;
  }
}

async function saveRemark() {
  if (!current.value || !canManageOrders.value) return;
  try {
    await updateOrderRemark(current.value.id, remark.value);
    current.value.remark = remark.value;
    const row = rows.value.find((item) => item.id === current.value?.id);
    if (row) row.remark = remark.value;
    ElMessage.success("备注已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "备注保存失败");
  }
}

async function openDelivery(row: OrderRow) {
  current.value = current.value?.id === row.id ? current.value : { ...row, cart_info: [] };
  deliveryForm.delivery_type = row.product_type === 3 ? "fictitious" : "express";
  deliveryForm.company_id = "";
  deliveryForm.delivery_name = "";
  deliveryForm.delivery_code = "";
  deliveryForm.delivery_id = "";
  deliveryForm.fictitious_content = "";
  deliveryMode.value = "whole";
  splitItems.value = [];
  for (const key of Object.keys(selectedQuantities)) delete selectedQuantities[key];
  try {
    const [companies, items] = await Promise.all([
      row.product_type === 3
        ? Promise.resolve([])
        : expressCompanies.value.length === 0 ? getExpressList() : Promise.resolve(expressCompanies.value),
      getSplitCartInfo(row.id),
    ]);
    expressCompanies.value = companies;
    splitItems.value = items;
    deliveryDialogOpen.value = true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "快递公司加载失败");
  }
}

function toggleSplitItem(item: SplitCartItem, checked: boolean | string | number) {
  selectedQuantities[item.cart_id] = checked ? Math.max(1, selectedQuantities[item.cart_id] ?? 1) : 0;
}

function selectExpress(companyId: number | "") {
  const company = expressCompanies.value.find((item) => item.id === companyId);
  deliveryForm.delivery_name = company?.name ?? "";
  deliveryForm.delivery_code = company?.code ?? "";
}

function validateDelivery() {
  if (deliveryForm.delivery_type === "send") {
    return "供应商同城配送尚未接入实名配送员与核销链路，请使用快递或虚拟交付";
  }
  if (deliveryForm.delivery_type === "fictitious") {
    if (!deliveryForm.fictitious_content.trim()) return "请填写虚拟交付内容";
    return "";
  }
  if (!deliveryForm.delivery_name.trim()) return "请选择快递公司";
  if (deliveryForm.delivery_type === "waybill") {
    return canManageWaybills.value ? "" : "当前账号没有电子面单签发权限";
  }
  if (!deliveryForm.delivery_id.trim()) return "请填写快递单号";
  return "";
}

async function submitDelivery() {
  if (!current.value) return;
  const validation = validateDelivery();
  if (validation) {
    ElMessage.warning(validation);
    return;
  }
  if (deliveryMode.value === "partial") {
    if (selectedQuantity.value <= 0) {
      ElMessage.warning("请至少选择一件本次发货商品");
      return;
    }
    if (selectedQuantity.value >= availableQuantity.value) {
      ElMessage.warning("已选择全部商品，请改用整单发货");
      return;
    }
  }
  actionLoading.value = true;
  try {
    const selectedCarts = splitItems.value
      .filter((item) => (selectedQuantities[item.cart_id] ?? 0) > 0)
      .map((item) => ({
        cart_id: item.cart_id,
        cart_num: selectedQuantities[item.cart_id],
      }));
    if (deliveryForm.delivery_type === "waybill") {
      const result = await createWaybillJob(current.value.id, {
        request_key: crypto.randomUUID(),
        fulfillment_mode: deliveryMode.value === "partial" ? "split" : "whole",
        carrier_id: deliveryForm.company_id,
        ...(deliveryMode.value === "partial" ? { cart_ids: selectedCarts } : {}),
      });
      deliveryDialogOpen.value = false;
      ElMessage.success(result.duplicate ? "该签发请求已受理" : "电子面单任务已创建，请在面单账本查看结果");
      return;
    }
    const deliveryData = {
      delivery_type: deliveryForm.delivery_type,
      delivery_name: deliveryForm.delivery_name,
      delivery_code: deliveryForm.delivery_code,
      delivery_id: deliveryForm.delivery_id,
      fictitious_content: deliveryForm.fictitious_content,
    };
    if (deliveryMode.value === "partial") {
      await splitDeliverOrder(current.value.id, {
        ...deliveryData,
        cart_ids: selectedCarts,
      });
    } else {
      await deliverOrder(current.value.id, deliveryData);
    }
    deliveryDialogOpen.value = false;
    await Promise.all([loadOrderDetail(current.value.id), load()]);
    ElMessage.success(deliveryMode.value === "partial" ? "本批商品已发货" : "订单已发货");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "发货失败");
  } finally {
    actionLoading.value = false;
  }
}

async function confirmTake(row: OrderRow) {
  try {
    await ElMessageBox.confirm("确认该订单已完成收货？确认后供应商收入将进入可提现余额。", "确认收货", {
      type: "warning",
      confirmButtonText: "确认收货",
      cancelButtonText: "取消",
    });
  } catch {
    return;
  }
  actionLoading.value = true;
  try {
    await confirmOrderTake(row.id);
    await Promise.all([load(), current.value?.id === row.id ? loadOrderDetail(row.id) : Promise.resolve()]);
    ElMessage.success("已确认收货，订单进入结算");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "确认收货失败");
  } finally {
    actionLoading.value = false;
  }
}

async function printOrder(row: OrderRow) {
  if (!canManagePrint.value) return;
  try {
    await ElMessageBox.confirm(
      "将向当前供应商所有已启用且配置完整的打印机创建幂等打印任务。",
      "打印订单小票",
      { type: "info", confirmButtonText: "创建打印任务", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  actionLoading.value = true;
  try {
    const result = await createManualPrintJobs(row.id);
    ElMessage.success(result.duplicate ? "该请求已受理" : `已创建 ${result.jobs.length} 个打印任务`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "创建打印任务失败");
  } finally {
    actionLoading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="page-section">
    <header class="page-heading">
      <div><h1>订单管理</h1><p>订单、发货和收货操作均严格限定当前供应商</p></div>
      <div class="heading-actions">
        <el-button :loading="exportLoading" @click="downloadExpressDirectory">物流公司对照表</el-button>
        <el-button @click="openQueueHistory">批量任务历史</el-button>
      </div>
    </header>
    <div class="surface list-surface">
      <div class="filter-row">
        <el-input v-model="filters.order" class="search-input" clearable placeholder="订单号、客户或手机号" @keyup.enter="search">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <el-select v-model="filters.paid" class="state-select" placeholder="支付状态" clearable @change="search">
          <el-option label="未支付" value="0" /><el-option label="已支付" value="1" />
        </el-select>
        <el-select v-model="filters.status" class="state-select" placeholder="订单状态" clearable @change="search">
          <el-option label="待发货" value="0" /><el-option label="已发货" value="1" /><el-option label="已收货" value="2" /><el-option label="已完成" value="3" />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
      </div>
      <div class="export-toolbar">
        <span>已选 {{ selectedOrders.length }} 个本页订单</span>
        <el-button :disabled="!selectedOrders.length" @click="openPickingSheets(selectedOrders)">配货单预览</el-button>
        <el-button v-if="canManageOrders" :disabled="!selectedOrders.length" :loading="exportLoading" @click="downloadSelectedOrders(0)">导出订单清单</el-button>
        <el-button v-if="canManageOrders" :disabled="!selectedOrders.length" :loading="exportLoading" @click="downloadSelectedOrders(1)">导出发货单</el-button>
      </div>
      <el-table v-loading="loading" :data="rows" row-key="id" @selection-change="selectOrders" @row-click="openOrder">
        <el-table-column type="selection" width="48" reserve-selection />
        <el-table-column prop="order_id" label="订单号" min-width="190" />
        <el-table-column label="客户" min-width="170"><template #default="scope"><div class="customer-cell"><strong>{{ scope.row.real_name }}</strong><span>{{ scope.row.user_phone }}</span></div></template></el-table-column>
        <el-table-column label="金额" width="120"><template #default="scope">{{ formatMoney(scope.row.pay_price) }}</template></el-table-column>
        <el-table-column label="支付方式" width="120"><template #default="scope">{{ payType(scope.row.pay_type) }}</template></el-table-column>
        <el-table-column label="状态" width="110"><template #default="scope"><span class="status-text" :class="orderStatus(scope.row).tone">{{ orderStatus(scope.row).label }}</span></template></el-table-column>
        <el-table-column label="下单时间" width="180"><template #default="scope">{{ formatTime(scope.row.add_time) }}</template></el-table-column>
        <el-table-column label="操作" width="290"><template #default="scope"><el-button link type="primary" @click.stop="openOrder(scope.row)">详情</el-button><el-button link type="primary" @click.stop="openPickingSheets([scope.row])">配货单</el-button><el-button v-if="canManagePrint" link type="primary" @click.stop="printOrder(scope.row)">打印</el-button><el-button v-if="canDeliver(scope.row)" link type="primary" @click.stop="openDelivery(scope.row)">发货</el-button><el-button v-if="canConfirmTake(scope.row)" link type="success" @click.stop="confirmTake(scope.row)">确认收货</el-button></template></el-table-column>
      </el-table>
      <div class="pagination-row"><span>共 {{ total }} 个订单</span><el-pagination v-model:current-page="filters.page" :page-size="filters.limit" :total="total" layout="prev, pager, next" @current-change="load" /></div>
    </div>

    <el-drawer v-model="drawerOpen" title="订单详情" size="min(560px, 94vw)">
      <div v-loading="detailLoading" class="order-detail">
        <template v-if="current">
          <div class="detail-order-id">{{ current.order_id }}</div>
          <dl class="detail-grid">
            <div><dt>客户</dt><dd>{{ current.real_name }}</dd></div>
            <div><dt>手机号</dt><dd>{{ current.user_phone }}</dd></div>
            <div><dt>订单金额</dt><dd>{{ formatMoney(current.pay_price) }}</dd></div>
            <div><dt>支付方式</dt><dd>{{ payType(current.pay_type) }}</dd></div>
            <div><dt>订单状态</dt><dd>{{ orderStatus(current).label }}</dd></div>
            <div><dt>下单时间</dt><dd>{{ formatTime(current.add_time) }}</dd></div>
            <div v-if="current.delivery_type"><dt>发货方式</dt><dd>{{ current.delivery_type === "express" ? "快递" : current.delivery_type === "send" ? "同城配送" : "虚拟发货" }}</dd></div>
            <div v-if="current.delivery_type"><dt>物流 / 交付信息</dt><dd>{{ current.delivery_type === "fictitious" ? current.fictitious_content : `${current.delivery_name} ${current.delivery_id}` }}</dd></div>
          </dl>
          <div class="drawer-actions delivery-actions">
            <el-button v-if="canManagePrint" plain :loading="actionLoading" @click="printOrder(current)">打印小票</el-button>
            <el-button v-if="canDeliver(current)" type="primary" @click="openDelivery(current)">订单发货</el-button>
            <el-button v-if="canConfirmTake(current)" type="success" plain :loading="actionLoading" @click="confirmTake(current)">确认收货</el-button>
          </div>
          <div v-if="shipments.length" class="shipment-section">
            <h3>发货包裹</h3>
            <article v-for="shipment in shipments" :key="shipment.id" class="shipment-card">
              <div class="shipment-card__heading">
                <div><strong>{{ shipment.order_id }}</strong><span>{{ shipment.total_num }} 件 · {{ formatMoney(shipment.pay_price) }}</span></div>
                <span class="status-text" :class="orderStatus(shipment).tone">{{ orderStatus(shipment).label }}</span>
              </div>
              <div v-if="shipment.delivery_type" class="shipment-logistics">
                {{ shipment.delivery_type === 'fictitious' ? shipment.fictitious_content : `${shipment.delivery_name} ${shipment.delivery_id}` }}
              </div>
              <ul class="shipment-products">
                <li v-for="item in shipment.cart_info" :key="item.id"><span>{{ item.product_name }}<small v-if="item.sku">{{ item.sku }}</small></span><strong>× {{ item.cart_num }}</strong></li>
              </ul>
            </article>
          </div>
          <div v-if="statusLogs.length" class="delivery-timeline">
            <h3>订单轨迹</h3>
            <el-timeline>
              <el-timeline-item v-for="log in statusLogs" :key="log.id" :timestamp="formatTime(log.changeTime)">{{ log.changeMessage }}</el-timeline-item>
            </el-timeline>
          </div>
          <div class="remark-editor"><label for="order-remark">供应商备注</label><el-input id="order-remark" v-model="remark" type="textarea" :rows="4" maxlength="512" show-word-limit :disabled="!canManageOrders" /></div>
          <el-button v-if="canManageOrders" type="primary" @click="saveRemark">保存备注</el-button>
        </template>
      </div>
    </el-drawer>

    <el-dialog v-model="deliveryDialogOpen" :title="deliveryTitle" width="min(680px, 94vw)">
      <el-form label-position="top" class="delivery-form">
        <el-form-item label="发货范围">
          <el-radio-group v-model="deliveryMode">
            <el-radio-button value="whole">整单发货</el-radio-button>
            <el-radio-button value="partial" :disabled="availableQuantity <= 1 || isManualVirtualOrder">分批发货</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <div v-if="deliveryMode === 'partial'" class="split-picker">
          <div class="split-picker__summary"><strong>选择本批商品</strong><span>已选 {{ selectedQuantity }} / {{ availableQuantity }} 件</span></div>
          <div v-for="item in splitItems" :key="item.cart_id" class="split-picker__item">
            <el-checkbox :model-value="(selectedQuantities[item.cart_id] ?? 0) > 0" @change="toggleSplitItem(item, $event)">
              <span class="split-product-name">{{ item.product_name }}</span>
              <small v-if="item.sku">{{ item.sku }}</small>
            </el-checkbox>
            <el-input-number
              v-if="(selectedQuantities[item.cart_id] ?? 0) > 0"
              v-model="selectedQuantities[item.cart_id]"
              :min="1"
              :max="item.surplus_num"
              controls-position="right"
              size="small"
            />
            <span v-else class="split-picker__available">可发 {{ item.surplus_num }} 件</span>
          </div>
        </div>
        <el-form-item label="发货方式"><el-radio-group v-model="deliveryForm.delivery_type"><template v-if="isManualVirtualOrder"><el-radio-button value="fictitious">虚拟交付</el-radio-button></template><template v-else><el-radio-button v-if="canManageWaybills" value="waybill">电子面单</el-radio-button><el-radio-button value="express">手填快递</el-radio-button></template></el-radio-group></el-form-item>
        <template v-if="deliveryForm.delivery_type === 'express' || deliveryForm.delivery_type === 'waybill'">
          <el-form-item label="快递公司"><el-select v-model="deliveryForm.company_id" filterable placeholder="请选择" style="width:100%" @change="selectExpress"><el-option v-for="company in expressCompanies" :key="company.id" :label="company.name" :value="company.id" /></el-select></el-form-item>
          <el-form-item v-if="deliveryForm.delivery_type === 'express'" label="快递单号"><el-input v-model="deliveryForm.delivery_id" maxlength="64" placeholder="请输入快递单号" /></el-form-item>
          <el-alert v-else title="签发会异步执行；结果未知时系统不会盲目重签，请到电子面单账本人工核对。" type="info" :closable="false" show-icon />
        </template>
        <el-form-item v-else label="交付内容"><el-input v-model="deliveryForm.fictitious_content" type="textarea" :rows="5" maxlength="500" show-word-limit placeholder="填写卡密、下载地址或其他可审计交付说明" /></el-form-item>
      </el-form>
      <p class="security-note">供应商同城配送需先接入实名配送员、订单归属与核销码闭环；当前仅开放快递和虚拟交付。</p>
      <p class="security-note">{{ deliveryMode === 'partial' ? '系统将生成已发货子单并保留一个待发货子单，订单金额按商品价值分摊且总额保持不变。' : '发货后订单进入“已发货”；存在进行中售后的订单不能发货。' }}</p>
      <template #footer><el-button @click="deliveryDialogOpen = false">取消</el-button><el-button type="primary" :loading="actionLoading" @click="submitDelivery">{{ deliveryForm.delivery_type === 'waybill' ? '创建签发任务' : '确认发货' }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="queueDialogOpen" title="批量任务历史（只读）" width="min(1040px, 96vw)">
      <el-alert title="这里仅展示旧系统履约任务的租户内历史；重新执行、停止和删除旧队列的入口已安全退役。" type="info" :closable="false" show-icon />
      <div class="filter-row queue-filter-row">
        <el-select v-model="queueFilters.type" clearable placeholder="任务类型" @change="searchQueueHistory">
          <el-option label="批量手动发货" value="7" />
          <el-option label="批量打印电子面单" value="8" />
          <el-option label="批量配送" value="9" />
          <el-option label="批量虚拟发货" value="10" />
        </el-select>
        <el-select v-model="queueFilters.status" clearable placeholder="任务状态" @change="searchQueueHistory">
          <el-option label="未处理" value="0" /><el-option label="正在处理" value="1" /><el-option label="完成" value="2" /><el-option label="失败" value="3" />
        </el-select>
        <el-button type="primary" @click="searchQueueHistory">查询</el-button>
      </div>
      <el-table v-loading="queueLoading" :data="queueRows" row-key="id">
        <el-table-column prop="id" label="任务 ID" width="100" />
        <el-table-column prop="add_time" label="操作时间" width="180" />
        <el-table-column prop="title" label="任务类型" min-width="170" />
        <el-table-column prop="total_num" label="总数" width="90" />
        <el-table-column prop="success_num" label="成功" width="90" />
        <el-table-column prop="surplus_num" label="未成功" width="90" />
        <el-table-column prop="status_cn" label="状态" width="100" />
        <el-table-column label="操作" width="150"><template #default="scope"><el-button link type="primary" @click="openQueueDetail(scope.row)">查看</el-button><el-button v-if="canManageOrders" link type="primary" :loading="exportLoading" @click="downloadQueueHistory(scope.row)">下载</el-button></template></el-table-column>
      </el-table>
      <div class="pagination-row"><span>共 {{ queueTotal }} 个任务</span><el-pagination v-model:current-page="queueFilters.page" :page-size="queueFilters.limit" :total="queueTotal" layout="prev, pager, next" @current-change="loadQueueHistory" /></div>
    </el-dialog>

    <el-dialog v-model="queueDetailOpen" :title="`任务 ${queueDetailCurrent?.id ?? ''} 明细`" width="min(920px, 96vw)">
      <el-table v-loading="queueDetailLoading" :data="queueDetailRows" row-key="id">
        <el-table-column prop="order_id" label="订单号" min-width="190" />
        <el-table-column prop="delivery_name" label="物流 / 类型" min-width="140" />
        <el-table-column prop="delivery_id" label="物流单号" min-width="160" />
        <el-table-column prop="fictitious_content" label="虚拟交付" min-width="160" show-overflow-tooltip />
        <el-table-column prop="status_cn" label="状态" width="100" />
        <el-table-column prop="update_time" label="更新时间" width="180" />
      </el-table>
      <div class="pagination-row"><span>共 {{ queueDetailTotal }} 条明细</span><el-pagination v-model:current-page="queueDetailPage" :page-size="20" :total="queueDetailTotal" layout="prev, pager, next" @current-change="loadQueueDetail" /></div>
    </el-dialog>
  </section>
</template>

<style scoped>
.heading-actions,
.export-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.export-toolbar {
  justify-content: flex-end;
  margin: 0 0 14px;
  color: var(--el-text-color-secondary);
}

.queue-filter-row {
  margin-top: 16px;
}

@media (max-width: 720px) {
  .heading-actions {
    width: 100%;
  }

  .heading-actions :deep(.el-button),
  .export-toolbar :deep(.el-button) {
    margin-left: 0;
  }
}
</style>
