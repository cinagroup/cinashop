<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
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

import { ApiError } from "@/api/http";
import { createSupplierSessionScope } from "@/utils/supplierSession";
import { checkOrderPage, checkOrderDetail, checkDeliveryInputs, checkNullReceipt, positiveId } from "@/utils/orderView";

type DeliveryType = "express" | "waybill" | "send" | "fictitious";

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const mountedPath = route.fullPath;
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
const selectedQuantities = reactive<Record<string, number>>(Object.create(null));
const deliveryForm = reactive({
  delivery_type: "express" as DeliveryType,
  company_id: "" as number | "",
  delivery_name: "",
  delivery_code: "",
  delivery_id: "",
  fictitious_content: "",
});

const invalidated = ref(false);
const listError = ref("");
const detailError = ref("");
const deliveryError = ref("");
const selectedId = ref<number | null>(null);
const deliveryTarget = ref<OrderRow | null>(null);
const deliveryLoading = ref(false);
const uncertainIds = reactive(new Set<number>());
let confirming = false;

// A generation remains invalid even if selection/account later returns A -> B -> A.
function requestSlot() {
  let version = 0;
  let controller: AbortController | undefined;
  return {
    get version() { return version; },
    cancel() { version++; controller?.abort(); },
    start() {
      this.cancel(); controller = new AbortController();
      const ticket = version;
      return { signal: controller.signal, current: () => active() && ticket === version };
    },
  };
}
const listRequest = requestSlot(), detailRequest = requestSlot(), deliveryRequest = requestSlot();
const queueRequest = requestSlot(), queueDetailRequest = requestSlot(), exportRequest = requestSlot();
const session = createSupplierSessionScope(invalidate, previewMode);
function active() { return !invalidated.value && route.fullPath === mountedPath && session.isCurrent(); }
function clearDetail() {
  detailRequest.cancel(); selectedId.value = null; current.value = null;
  remark.value = ""; statusLogs.value = []; shipments.value = []; detailLoading.value = false; detailError.value = "";
  if (confirming) ElMessageBox.close();
}
function clearDelivery() {
  deliveryRequest.cancel(); deliveryTarget.value = null; deliveryLoading.value = false; deliveryError.value = "";
  expressCompanies.value = []; splitItems.value = []; deliveryMode.value = "whole";
  for (const key of Object.keys(selectedQuantities)) delete selectedQuantities[key];
  Object.assign(deliveryForm, { delivery_type: "express", company_id: "", delivery_name: "", delivery_code: "", delivery_id: "", fictitious_content: "" });
}
function invalidate() {
  if (invalidated.value) return;
  invalidated.value = true;
  [listRequest, queueRequest, queueDetailRequest, exportRequest].forEach(request => request.cancel());
  clearDetail(); clearDelivery(); rows.value = []; total.value = 0; selectedOrders.value = [];
  queueRows.value = []; queueTotal.value = 0; queueDetailRows.value = []; queueDetailTotal.value = 0; queueDetailCurrent.value = null;
  drawerOpen.value = deliveryDialogOpen.value = queueDialogOpen.value = queueDetailOpen.value = false;
  loading.value = queueLoading.value = queueDetailLoading.value = exportLoading.value = false;
  Object.assign(filters, { page: 1, limit: 20, order: "", paid: "", status: "" });
  Object.assign(queueFilters, { page: 1, limit: 20, type: "", status: "" });
  listError.value = "会话或页面已变化，请重新进入订单页";
}
watch(() => route.fullPath, () => { invalidate(); session.dispose(); }, { flush: "sync" });
watch(drawerOpen, open => { if (!open) clearDetail(); }, { flush: "sync" });
watch(deliveryDialogOpen, open => { if (!open) clearDelivery(); }, { flush: "sync" });
watch(queueDialogOpen, open => {
  if (!open) { queueRequest.cancel(); queueRows.value = []; queueTotal.value = 0; queueLoading.value = false; queueDetailOpen.value = false; }
}, { flush: "sync" });
watch(queueDetailOpen, open => {
  if (!open) { queueDetailRequest.cancel(); queueDetailRows.value = []; queueDetailTotal.value = 0; queueDetailCurrent.value = null; queueDetailLoading.value = false; }
}, { flush: "sync" });
onBeforeUnmount(() => { invalidate(); session.dispose(); });

const canManageOrders = computed(() => !invalidated.value && auth.can("supplier.order.manage"));
const canManagePrint = computed(() => !invalidated.value && auth.can("supplier.print.manage"));
const canManageWaybills = computed(() => !invalidated.value && auth.can("supplier.waybill.manage"));
const isManualVirtualOrder = computed(() => deliveryTarget.value?.product_type === 3);

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
  return canManageOrders.value && !uncertainIds.has(row.id) && row.paid === 1 && row.status === 0
    && [0, 3].includes(row.refund_status) && row.shipping_type !== 2;
}

function canConfirmTake(row: OrderRow) {
  return canManageOrders.value && !uncertainIds.has(row.id) && row.paid === 1 && row.status === 1;
}

function selectOrders(selection: OrderRow[]) {
  selectedOrders.value = active() && !loading.value ? selection.filter(row => rows.value.some(visible => visible.id === row.id)) : [];
}

function openPickingSheets(orders: OrderRow[]) {
  if (!active()) return;
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
  if (!active() || !canManageOrders.value || exportLoading.value) return;
  const ids = selectedOrders.value.map(row => row.id);
  if (!ids.length) return void ElMessage.warning("请先选择本页订单");
  const version = listRequest.version, request = exportRequest.start();
  exportLoading.value = true;
  try {
    const manifest = await exportSupplierOrders({ ids: ids.join(","), type, page: 1, selection: "exact" });
    if (!request.current() || listRequest.version !== version) return;
    downloadLegacyExport(manifest);
    ElMessage.success(type === 1 ? "发货单已下载" : "订单清单已下载");
  } catch (error) {
    if (request.current() && listRequest.version === version) ElMessage.error(error instanceof Error ? error.message : "订单导出失败");
  } finally { if (request.current()) exportLoading.value = false; }
}

async function downloadExpressDirectory() {
  if (!active() || exportLoading.value) return;
  const request = exportRequest.start(); exportLoading.value = true;
  try {
    const manifest = await exportSupplierExpressList();
    if (!request.current()) return;
    downloadLegacyExport(manifest); ElMessage.success("物流公司对照表已下载");
  } catch (error) { if (request.current()) ElMessage.error(error instanceof Error ? error.message : "物流公司导出失败"); }
  finally { if (request.current()) exportLoading.value = false; }
}

async function loadQueueHistory() {
  if (!active() || !queueDialogOpen.value) return;
  const request = queueRequest.start(), params = { ...queueFilters };
  queueLoading.value = true; queueRows.value = [];
  try {
    const result = await getSupplierQueueHistory(params);
    if (!request.current() || !queueDialogOpen.value) return;
    if (!result || !Array.isArray(result.list) || !Number.isSafeInteger(result.count) || result.count < 0) throw new Error("任务列表响应不完整");
    queueRows.value = result.list; queueTotal.value = result.count;
  } catch (error) {
    if (request.current()) { queueTotal.value = 0; ElMessage.error(error instanceof Error ? error.message : "批量任务历史加载失败"); }
  } finally { if (request.current()) queueLoading.value = false; }
}

async function openQueueHistory() {
  if (!active()) return;
  queueDialogOpen.value = true;
  await loadQueueHistory();
}

function searchQueueHistory() {
  queueFilters.page = 1;
  void loadQueueHistory();
}

async function loadQueueDetail() {
  if (!active() || !queueDetailOpen.value || !queueDetailCurrent.value) return;
  const target = { ...queueDetailCurrent.value }, request = queueDetailRequest.start();
  const params = { page: queueDetailPage.value, limit: 20 };
  queueDetailLoading.value = true; queueDetailRows.value = [];
  try {
    const result = await getSupplierQueueDeliveryLog(target.id, target.cache_type, params);
    if (!request.current() || !queueDetailOpen.value) return;
    if (!result || !Array.isArray(result.list) || !Number.isSafeInteger(result.count) || result.count < 0
      || result.list.some(row => row.binding_id !== target.id || row.type !== target.cache_type)) throw new Error("任务明细响应不匹配");
    queueDetailRows.value = result.list; queueDetailTotal.value = result.count;
  } catch (error) {
    if (request.current()) { queueDetailTotal.value = 0; ElMessage.error(error instanceof Error ? error.message : "任务明细加载失败"); }
  } finally { if (request.current()) queueDetailLoading.value = false; }
}

async function openQueueDetail(row: SupplierQueueHistoryRow) {
  if (!active()) return;
  queueDetailCurrent.value = row;
  queueDetailPage.value = 1;
  queueDetailOpen.value = true;
  await loadQueueDetail();
}

async function downloadQueueHistory(row: SupplierQueueHistoryRow) {
  if (!active() || !canManageOrders.value || exportLoading.value) return;
  const target = { ...row }, version = queueRequest.version, request = exportRequest.start(); exportLoading.value = true;
  try {
    const manifest = await exportSupplierBatchDelivery(target.id, target.type, target.cache_type);
    if (!request.current() || version !== queueRequest.version) return;
    downloadLegacyExport(manifest); ElMessage.success("批量任务记录已下载");
  } catch (error) {
    if (request.current() && version === queueRequest.version) ElMessage.error(error instanceof Error ? error.message : "任务记录导出失败");
  } finally { if (request.current()) exportLoading.value = false; }
}

async function load() {
  if (!active()) return false;
  const request = listRequest.start(), params = { ...filters };
  loading.value = true; rows.value = []; selectedOrders.value = []; listError.value = "";
  // Keep the last total while pending, otherwise Element Plus clamps page > 1 to 1.
  try {
    const result = await getOrders(params, request.signal);
    if (!request.current()) return false;
    checkOrderPage(result, params.limit);
    rows.value = result.list; total.value = result.count;
    return true;
  } catch (error) {
    if (request.current()) { total.value = 0; listError.value = error instanceof Error ? error.message : "订单加载失败"; }
    return false;
  } finally { if (request.current()) loading.value = false; }
}

function search() {
  filters.page = 1;
  void load();
}

async function loadOrderDetail(id: number) {
  if (!active() || !drawerOpen.value || selectedId.value !== id) return false;
  const request = detailRequest.start();
  current.value = null; remark.value = ""; statusLogs.value = []; shipments.value = [];
  detailError.value = ""; detailLoading.value = true;
  try {
    const [detail, logs, splitOrderRows] = await Promise.all([
      getOrderDetail(id, request.signal), getOrderStatus(id, request.signal), getSplitOrders(id, request.signal),
    ]);
    if (!request.current() || !drawerOpen.value || selectedId.value !== id) return false;
    checkOrderDetail(detail, id, logs, splitOrderRows);
    current.value = detail; remark.value = detail.remark; statusLogs.value = logs; shipments.value = splitOrderRows;
    return true;
  } catch (error) {
    if (request.current()) detailError.value = error instanceof Error ? error.message : "订单详情加载失败";
    return false;
  } finally { if (request.current()) detailLoading.value = false; }
}

async function openOrder(row: OrderRow) {
  if (!active() || !positiveId(row.id)) return;
  clearDetail(); selectedId.value = row.id; drawerOpen.value = true;
  await loadOrderDetail(row.id);
}
async function refreshCurrent() { if (selectedId.value) return loadOrderDetail(selectedId.value); }

async function saveRemark() {
  if (!active() || !current.value || !drawerOpen.value || !canManageOrders.value || actionLoading.value || uncertainIds.has(current.value.id)) return;
  const id = current.value.id, value = remark.value, version = detailRequest.version;
  const owns = () => active() && drawerOpen.value && selectedId.value === id && version === detailRequest.version;
  actionLoading.value = true;
  try {
    checkNullReceipt(await updateOrderRemark(id, value));
    if (!owns() || !current.value) return;
    current.value.remark = value;
    const row = rows.value.find(item => item.id === id); if (row) row.remark = value;
    ElMessage.success("备注已保存");
  } catch (error) { writeFailure(error, id, owns); }
  finally { actionLoading.value = false; }
}

async function openDelivery(row: OrderRow) {
  if (!active() || !positiveId(row.id) || !canDeliver(row) || actionLoading.value) return;
  clearDelivery(); deliveryTarget.value = { ...row };
  deliveryForm.delivery_type = row.product_type === 3 ? "fictitious" : "express";
  deliveryDialogOpen.value = true; deliveryLoading.value = true;
  const request = deliveryRequest.start(), id = row.id;
  try {
    const [companies, items] = await Promise.all([
      row.product_type === 3 ? Promise.resolve([]) : getExpressList(request.signal),
      getSplitCartInfo(id, request.signal),
    ]);
    if (!request.current() || !deliveryDialogOpen.value || deliveryTarget.value?.id !== id) return;
    checkDeliveryInputs(companies, items); expressCompanies.value = companies; splitItems.value = items;
  } catch (error) {
    if (request.current()) deliveryError.value = error instanceof Error ? error.message : "发货准备加载失败";
  } finally { if (request.current()) deliveryLoading.value = false; }
}
async function retryDelivery() { if (deliveryTarget.value) await openDelivery(deliveryTarget.value); }

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
  if (!active() || !deliveryTarget.value || !deliveryDialogOpen.value || deliveryLoading.value || deliveryError.value
    || actionLoading.value || !canDeliver(deliveryTarget.value) || !splitItems.value.length) return;
  const validation = validateDelivery();
  if (validation) return void ElMessage.warning(validation);
  const id = deliveryTarget.value.id, mode = deliveryMode.value, type = deliveryForm.delivery_type, version = deliveryRequest.version;
  if (deliveryTarget.value.product_type === 3 ? type !== "fictitious" || mode !== "whole" : !["express", "waybill"].includes(type)) return void ElMessage.warning("发货方式与订单不匹配");
  if (splitItems.value.some(item => !Number.isSafeInteger(selectedQuantities[item.cart_id] ?? 0) || (selectedQuantities[item.cart_id] ?? 0) < 0
    || (selectedQuantities[item.cart_id] ?? 0) > item.surplus_num)) return void ElMessage.warning("请选择有效的发货数量");
  if (mode === "partial" && (selectedQuantity.value <= 0 || selectedQuantity.value >= availableQuantity.value)) return void ElMessage.warning("分批数量须大于零且小于全部可发数量");
  const selectedCarts = splitItems.value.filter(item => (selectedQuantities[item.cart_id] ?? 0) > 0)
    .map(item => ({ cart_id: item.cart_id, cart_num: selectedQuantities[item.cart_id] }));
  const data = { delivery_type: type, delivery_name: deliveryForm.delivery_name, delivery_code: deliveryForm.delivery_code,
    delivery_id: deliveryForm.delivery_id, fictitious_content: deliveryForm.fictitious_content };
  const carrier = deliveryForm.company_id;
  const owns = () => active() && deliveryDialogOpen.value && deliveryTarget.value?.id === id && version === deliveryRequest.version;
  actionLoading.value = true;
  try {
    if (type === "waybill") {
      const result = await createWaybillJob(id, { request_key: crypto.randomUUID(), fulfillment_mode: mode === "partial" ? "split" : "whole",
        carrier_id: carrier, ...(mode === "partial" ? { cart_ids: selectedCarts } : {}) });
      if (!result || typeof result.duplicate !== "boolean" || !positiveId(result.job?.id) || typeof result.job.status !== "string") throw new Error("面单受理结果未知");
      if (owns()) { deliveryDialogOpen.value = false; ElMessage.success(result.duplicate ? "该签发请求已受理" : "电子面单任务已创建，请在面单账本查看结果"); }
    } else {
      if (mode === "partial") {
        const result = await splitDeliverOrder(id, { ...data, cart_ids: selectedCarts });
        if (!result || typeof result.split !== "boolean" || !positiveId(result.order_id)
          || !(result.remaining_order_id === null || positiveId(result.remaining_order_id))) throw new Error("发货结果未知");
      } else checkNullReceipt(await deliverOrder(id, data));
      if (!active()) return;
      const owned = owns();
      if (owned) deliveryDialogOpen.value = false;
      if (owned) ElMessage.success(mode === "partial" ? "本批商品已发货" : "订单已发货");
      await refreshAfterWrite(id);
    }
  } catch (error) { writeFailure(error, id, owns); }
  finally { actionLoading.value = false; }
}
// A transport/5xx/malformed receipt does not prove the command was rejected.
// Keep this order read-only for this mounted session; inspect the ledger before any deliberate retry.
function writeFailure(error: unknown, id: number, owns: () => boolean) {
  if (!active()) return;
  const rejected = error instanceof ApiError && error.status === 400;
  if (!rejected) uncertainIds.add(id);
  if (owns()) {
    if (rejected) ElMessage.error(error.message);
    else ElMessage.warning("提交结果未知；该订单已暂停写入，请先核对订单或任务账本，勿重复提交");
  }
}
async function refreshAfterWrite(id: number) {
  if (!active()) return;
  const results = await Promise.all([load(), drawerOpen.value && selectedId.value === id ? loadOrderDetail(id) : Promise.resolve(true)]);
  if (active() && results.some(ok => !ok)) ElMessage.warning("操作已成功，但最新状态未能完整读取；请重新查询，勿重复提交");
}
function captureRowView(row: OrderRow) {
  const inDrawer = drawerOpen.value && current.value?.id === row.id;
  const version = inDrawer ? detailRequest.version : listRequest.version;
  return () => active() && (inDrawer ? drawerOpen.value && current.value?.id === row.id && version === detailRequest.version
    : version === listRequest.version && rows.value.some(item => item.id === row.id));
}

async function confirmTake(row: OrderRow) {
  if (!active() || actionLoading.value || !canConfirmTake(row)) return;
  const id = row.id, owns = captureRowView(row);
  actionLoading.value = true; confirming = true;
  let dispatched = false;
  try {
    await ElMessageBox.confirm("确认该订单已完成收货？确认后供应商收入将进入可提现余额。", "确认收货",
      { type: "warning", confirmButtonText: "确认收货", cancelButtonText: "取消" });
    confirming = false;
    if (!owns() || !canManageOrders.value || uncertainIds.has(id)) return;
    dispatched = true; checkNullReceipt(await confirmOrderTake(id));
    if (!active()) return;
    if (owns()) ElMessage.success("已确认收货，订单进入结算");
    await refreshAfterWrite(id);
  } catch (error) { if (dispatched) writeFailure(error, id, owns); }
  finally { confirming = false; actionLoading.value = false; }
}

async function printOrder(row: OrderRow) {
  if (!active() || !canManagePrint.value || actionLoading.value || uncertainIds.has(row.id)) return;
  const id = row.id, owns = captureRowView(row);
  actionLoading.value = true; confirming = true;
  let dispatched = false;
  try {
    await ElMessageBox.confirm("将向当前供应商所有已启用且配置完整的打印机创建幂等打印任务。", "打印订单小票",
      { type: "info", confirmButtonText: "创建打印任务", cancelButtonText: "取消" });
    confirming = false;
    if (!owns() || !canManagePrint.value || uncertainIds.has(id)) return;
    dispatched = true;
    const result = await createManualPrintJobs(id);
    if (!result || typeof result.duplicate !== "boolean" || !Array.isArray(result.jobs)
      || result.jobs.some(job => !positiveId(job.id) || typeof job.status !== "string")) throw new Error("打印受理结果未知");
    if (owns()) ElMessage.success(result.duplicate ? "该请求已受理" : `已创建 ${result.jobs.length} 个打印任务`);
  } catch (error) { if (dispatched) writeFailure(error, id, owns); }
  finally { confirming = false; actionLoading.value = false; }
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
    <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon />
    <el-alert v-if="uncertainIds.size" title="存在结果未知的提交，本页已暂停对应订单写入。请先核对订单或打印/面单账本，勿重复提交。" type="warning" :closable="false" show-icon />
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
        <el-button type="primary" :disabled="invalidated" @click="search">查询</el-button>
      </div>
      <div class="export-toolbar">
        <span>已选 {{ selectedOrders.length }} 个本页订单</span>
        <el-button :disabled="!selectedOrders.length" @click="openPickingSheets(selectedOrders)">配货单预览</el-button>
        <el-button v-if="canManageOrders" :disabled="!selectedOrders.length" :loading="exportLoading" @click="downloadSelectedOrders(0)">导出订单清单</el-button>
        <el-button v-if="canManageOrders" :disabled="!selectedOrders.length" :loading="exportLoading" @click="downloadSelectedOrders(1)">导出发货单</el-button>
      </div>
      <el-table v-loading="loading" :data="rows" row-key="id" @selection-change="selectOrders" @row-click="openOrder">
        <el-table-column type="selection" width="48" />
        <el-table-column prop="order_id" label="订单号" min-width="190" />
        <el-table-column label="客户" min-width="170"><template #default="scope"><div class="customer-cell"><strong>{{ scope.row.real_name }}</strong><span>{{ scope.row.user_phone }}</span></div></template></el-table-column>
        <el-table-column label="金额" width="120"><template #default="scope">{{ formatMoney(scope.row.pay_price) }}</template></el-table-column>
        <el-table-column label="支付方式" width="120"><template #default="scope">{{ payType(scope.row.pay_type) }}</template></el-table-column>
        <el-table-column label="状态" width="110"><template #default="scope"><span class="status-text" :class="orderStatus(scope.row).tone">{{ orderStatus(scope.row).label }}</span></template></el-table-column>
        <el-table-column label="下单时间" width="180"><template #default="scope">{{ formatTime(scope.row.add_time) }}</template></el-table-column>
        <el-table-column label="操作" width="290"><template #default="scope"><el-button link type="primary" @click.stop="openOrder(scope.row)">详情</el-button><el-button link type="primary" @click.stop="openPickingSheets([scope.row])">配货单</el-button><el-button v-if="canManagePrint" link type="primary" :disabled="actionLoading || uncertainIds.has(scope.row.id)" @click.stop="printOrder(scope.row)">打印</el-button><el-button v-if="canDeliver(scope.row)" link type="primary" :disabled="actionLoading" @click.stop="openDelivery(scope.row)">发货</el-button><el-button v-if="canConfirmTake(scope.row)" link type="success" :disabled="actionLoading" @click.stop="confirmTake(scope.row)">确认收货</el-button></template></el-table-column>
      </el-table>
      <div class="pagination-row"><span>共 {{ total }} 个订单</span><el-pagination v-model:current-page="filters.page" :page-size="filters.limit" :total="total" layout="prev, pager, next" @current-change="load" /></div>
    </div>

    <el-drawer v-model="drawerOpen" title="订单详情" size="min(560px, 94vw)">
      <el-alert v-if="detailError" :title="detailError" type="error" :closable="false" show-icon />
      <el-button v-if="detailError" :disabled="invalidated" @click="refreshCurrent">重新读取详情</el-button>
      <div v-loading="detailLoading" class="order-detail">
        <template v-if="current">
          <el-alert v-if="uncertainIds.has(current.id)" title="此订单的提交结果未知，请先核对；重新读取不会解除写入保护。" type="warning" :closable="false" />
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
            <el-button v-if="canManagePrint" plain :disabled="uncertainIds.has(current.id)" :loading="actionLoading" @click="printOrder(current)">打印小票</el-button>
            <el-button v-if="canDeliver(current)" type="primary" :disabled="actionLoading" @click="openDelivery(current)">订单发货</el-button>
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
          <div class="remark-editor"><label for="order-remark">供应商备注</label><el-input id="order-remark" v-model="remark" type="textarea" :rows="4" maxlength="512" show-word-limit :disabled="!canManageOrders || actionLoading || uncertainIds.has(current.id)" /></div>
          <el-button v-if="canManageOrders" type="primary" :loading="actionLoading" :disabled="uncertainIds.has(current.id)" @click="saveRemark">保存备注</el-button>
        </template>
      </div>
    </el-drawer>

    <el-dialog v-model="deliveryDialogOpen" :title="deliveryTitle" width="min(680px, 94vw)">
      <p v-if="deliveryTarget" class="delivery-target">发货订单：{{ deliveryTarget.order_id }} · {{ deliveryTarget.real_name }}</p>
      <p v-if="deliveryLoading" role="status">正在读取当前订单的可发商品…</p>
      <el-alert v-if="deliveryError" :title="deliveryError" type="error" :closable="false" show-icon />
      <el-button v-if="deliveryError" :disabled="invalidated || actionLoading" @click="retryDelivery">重新读取发货信息</el-button>
      <el-alert v-if="deliveryTarget && uncertainIds.has(deliveryTarget.id)" title="提交结果未知，请先核对订单或面单账本，勿重复提交。" type="warning" :closable="false" />
      <el-form v-if="deliveryTarget && !deliveryLoading && !deliveryError" label-position="top" class="delivery-form" :disabled="actionLoading || uncertainIds.has(deliveryTarget.id)">
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
      <template #footer><el-button @click="deliveryDialogOpen = false">取消</el-button><el-button type="primary" :loading="actionLoading" :disabled="invalidated || deliveryLoading || !!deliveryError || !deliveryTarget || uncertainIds.has(deliveryTarget.id)" @click="submitDelivery">{{ deliveryForm.delivery_type === 'waybill' ? '创建签发任务' : '确认发货' }}</el-button></template>
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
.delivery-target,
.detail-order-id,
.order-detail :deep(dd) {
  overflow-wrap: anywhere;
}

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
