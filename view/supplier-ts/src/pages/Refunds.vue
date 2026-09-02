<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Search } from "@element-plus/icons-vue";
import {
  agreeRefundReturn,
  getRefundDetail,
  getRefundReasons,
  getRefunds,
  refundOrder,
  refuseRefund,
  updateRefundRemark,
} from "@/api/supplier";
import type { RefundDetail, RefundRow } from "@/types";
import { formatMoney, formatTime, payType } from "@/utils/format";

const loading = ref(false);
const rows = ref<RefundRow[]>([]);
const total = ref(0);
const filters = reactive({
  page: 1,
  limit: 20,
  keyword: "",
  refund_type: "",
  apply_type: "",
  refund_reason: "",
});
const refundReasons = ref<string[]>([]);
const drawerOpen = ref(false);
const detailLoading = ref(false);
const current = ref<RefundDetail | null>(null);
const remark = ref("");
const refuseDialogOpen = ref(false);
const refuseReason = ref("");
const actionLoading = ref(false);

const statusMap: Record<number, { label: string; tone: string }> = {
  0: { label: "待处理", tone: "warning" },
  1: { label: "待处理", tone: "warning" },
  2: { label: "待处理", tone: "warning" },
  3: { label: "已拒绝", tone: "danger" },
  4: { label: "等待退货", tone: "primary" },
  5: { label: "用户已退货", tone: "primary" },
  6: { label: "已退款", tone: "success" },
};

function refundStatus(type: number) {
  return statusMap[type] ?? { label: "未知", tone: "info" };
}

const providerStatusMap: Record<string, { label: string; tone: string }> = {
  CREATED: { label: "待发起", tone: "warning" },
  REQUESTING: { label: "渠道请求中", tone: "warning" },
  PROCESSING: { label: "渠道处理中", tone: "primary" },
  SUCCESS: { label: "渠道已成功", tone: "success" },
  CLOSED: { label: "渠道已关闭", tone: "danger" },
  ABNORMAL: { label: "渠道异常", tone: "danger" },
  FAILED: { label: "渠道失败", tone: "danger" },
  UNKNOWN: { label: "结果待核对", tone: "warning" },
};

function displayStatus(row: RefundRow) {
  return row.provider_status ? providerStatusMap[row.provider_status] ?? refundStatus(row.refund_type) : refundStatus(row.refund_type);
}

function applyType(type: number) {
  return type === 1 ? "仅退款" : type === 2 ? "退货退款" : type === 3 ? "到店退货" : "平台退款";
}

const canProcess = computed(() => current.value && [0, 1, 2, 4, 5].includes(current.value.refund_type));
const canAgreeReturn = computed(
  () => canProcess.value && current.value && [2, 3].includes(current.value.apply_type) && current.value.refund_type < 4,
);
const canRefund = computed(
  () => canProcess.value && current.value &&
    ([0, 1, 2, 5].includes(current.value.refund_type) ||
      (current.value.refund_type === 4 && current.value.apply_type === 3)) &&
    ["yue", "weixin", "alipay"].includes(current.value.pay_type),
);
const canRefuse = computed(() => {
  if (!canProcess.value || !current.value) return false;
  return !["REQUESTING", "PROCESSING", "SUCCESS", "UNKNOWN", "ABNORMAL"].includes(current.value.provider_status ?? "");
});

async function load() {
  loading.value = true;
  try {
    const result = await getRefunds(filters);
    rows.value = result.list;
    total.value = result.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "售后列表加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadRefundReasons() {
  try {
    refundReasons.value = await getRefundReasons();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "退款原因加载失败");
  }
}

function search() {
  filters.page = 1;
  void load();
}

async function openRefund(row: RefundRow) {
  drawerOpen.value = true;
  detailLoading.value = true;
  try {
    current.value = await getRefundDetail(row.id);
    remark.value = current.value.remark;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "售后详情加载失败");
  } finally {
    detailLoading.value = false;
  }
}

async function refreshCurrent() {
  if (!current.value) return;
  current.value = await getRefundDetail(current.value.id);
  const index = rows.value.findIndex((item) => item.id === current.value?.id);
  if (index >= 0) rows.value[index] = { ...rows.value[index], ...current.value };
}

async function saveRemark() {
  if (!current.value) return;
  actionLoading.value = true;
  try {
    await updateRefundRemark(current.value.id, remark.value);
    await refreshCurrent();
    ElMessage.success("备注已保存");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "备注保存失败");
  } finally {
    actionLoading.value = false;
  }
}

async function agreeReturnAction() {
  if (!current.value) return;
  actionLoading.value = true;
  try {
    await agreeRefundReturn(current.value.id);
    await refreshCurrent();
    ElMessage.success("已同意退货，等待用户寄回");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "操作失败");
  } finally {
    actionLoading.value = false;
  }
}

function openRefuse() {
  refuseReason.value = "";
  refuseDialogOpen.value = true;
}

async function submitRefuse() {
  if (!current.value || !refuseReason.value.trim()) {
    ElMessage.warning("请输入拒绝原因");
    return;
  }
  actionLoading.value = true;
  try {
    await refuseRefund(current.value.id, refuseReason.value);
    refuseDialogOpen.value = false;
    await refreshCurrent();
    ElMessage.success("已拒绝退款");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "拒绝退款失败");
  } finally {
    actionLoading.value = false;
  }
}

async function refundAction() {
  if (!current.value) return;
  try {
    await ElMessageBox.confirm(
      `确认向用户退款 ${formatMoney(current.value.refund_price)}？该操作不可撤销。`,
      "确认退款",
      { type: "warning", confirmButtonText: "确认退款", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  actionLoading.value = true;
  try {
    const result = await refundOrder(current.value.id, current.value.refund_price);
    await refreshCurrent();
    ElMessage.success(result.completed ? "退款完成" : "退款已受理，正在等待渠道确认");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "退款失败");
  } finally {
    actionLoading.value = false;
  }
}

onMounted(() => {
  void Promise.all([load(), loadRefundReasons()]);
});
</script>

<template>
  <section class="page-section">
    <header class="page-heading"><div><h1>售后管理</h1><p>所有售后操作均限定当前供应商订单</p></div></header>
    <div class="surface list-surface">
      <div class="filter-row">
        <el-input v-model="filters.keyword" class="search-input" clearable placeholder="售后单号、订单号或客户" @keyup.enter="search">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <el-select v-model="filters.apply_type" class="state-select" placeholder="售后类型" clearable @change="search">
          <el-option label="仅退款" value="1" /><el-option label="退货退款" value="2" /><el-option label="到店退货" value="3" />
        </el-select>
        <el-select v-model="filters.refund_type" class="state-select" placeholder="处理状态" clearable @change="search">
          <el-option label="待处理" value="0" /><el-option label="已拒绝" value="3" /><el-option label="等待退货" value="4" /><el-option label="用户已退货" value="5" /><el-option label="已退款" value="6" />
        </el-select>
        <el-select v-model="filters.refund_reason" class="state-select" placeholder="退款原因" clearable filterable @change="search">
          <el-option v-for="reason in refundReasons" :key="reason" :label="reason" :value="reason" />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
      </div>
      <el-table v-loading="loading" :data="rows" row-key="id" @row-click="openRefund">
        <el-table-column prop="refund_order_id" label="售后单号" min-width="170" />
        <el-table-column prop="order_id" label="订单号" min-width="180" />
        <el-table-column label="客户" min-width="170"><template #default="scope"><div class="customer-cell"><strong>{{ scope.row.real_name }}</strong><span>{{ scope.row.user_phone }}</span></div></template></el-table-column>
        <el-table-column label="类型" width="110"><template #default="scope">{{ applyType(scope.row.apply_type) }}</template></el-table-column>
        <el-table-column label="退款金额" width="130"><template #default="scope">{{ formatMoney(scope.row.refund_price) }}</template></el-table-column>
        <el-table-column label="状态" width="130"><template #default="scope"><span class="status-text" :class="displayStatus(scope.row).tone">{{ displayStatus(scope.row).label }}</span></template></el-table-column>
        <el-table-column label="申请时间" width="180"><template #default="scope">{{ formatTime(scope.row.add_time) }}</template></el-table-column>
        <el-table-column label="操作" width="90"><template #default="scope"><el-button link type="primary" @click.stop="openRefund(scope.row)">详情</el-button></template></el-table-column>
      </el-table>
      <div class="pagination-row"><span>共 {{ total }} 个售后单</span><el-pagination v-model:current-page="filters.page" :page-size="filters.limit" :total="total" layout="prev, pager, next" @current-change="load" /></div>
    </div>

    <el-drawer v-model="drawerOpen" title="售后详情" size="min(560px, 94vw)">
      <div v-loading="detailLoading" class="order-detail">
        <template v-if="current">
          <div class="detail-order-id">{{ current.refund_order_id }}</div>
          <dl class="detail-grid">
            <div><dt>关联订单</dt><dd>{{ current.order_id }}</dd></div>
            <div><dt>客户</dt><dd>{{ current.real_name }}</dd></div>
            <div><dt>售后类型</dt><dd>{{ applyType(current.apply_type) }}</dd></div>
            <div><dt>支付方式</dt><dd>{{ payType(current.pay_type) }}</dd></div>
            <div><dt>申请金额</dt><dd>{{ formatMoney(current.refund_price) }}</dd></div>
            <div><dt>处理状态</dt><dd><span class="status-text" :class="displayStatus(current).tone">{{ displayStatus(current).label }}</span></dd></div>
            <div v-if="current.out_refund_no"><dt>渠道退款号</dt><dd>{{ current.out_refund_no }}</dd></div>
          </dl>
          <div class="refund-reason"><span>用户原因</span><p>{{ current.refund_reason || "未填写" }}</p></div>
          <div v-if="current.refuse_reason" class="refund-reason danger-note"><span>拒绝原因</span><p>{{ current.refuse_reason }}</p></div>
          <div class="remark-editor"><label for="refund-remark">供应商备注</label><el-input id="refund-remark" v-model="remark" type="textarea" :rows="3" maxlength="255" show-word-limit /></div>
          <div class="drawer-actions">
            <el-button :loading="actionLoading" @click="saveRemark">保存备注</el-button>
            <el-button v-if="canAgreeReturn" type="primary" plain :loading="actionLoading" @click="agreeReturnAction">同意退货</el-button>
            <el-button v-if="canRefuse" type="danger" plain :loading="actionLoading" @click="openRefuse">拒绝退款</el-button>
            <el-button v-if="canRefund" type="primary" :loading="actionLoading" @click="refundAction">{{ current.provider_status ? "查询 / 重试退款" : "确认退款" }}</el-button>
          </div>
          <p v-if="current.provider_error" class="security-note">渠道信息：{{ current.provider_error }}</p>
          <p v-if="current.provider_status && current.refund_type !== 6" class="security-note">渠道受理不等于退款完成；系统仅在验签回调或主动查询确认成功后完成本地入账。</p>
        </template>
      </div>
    </el-drawer>

    <el-dialog v-model="refuseDialogOpen" title="拒绝退款" width="min(460px, 92vw)">
      <el-input v-model="refuseReason" type="textarea" :rows="4" maxlength="255" show-word-limit placeholder="请填写清晰、可审计的拒绝原因" />
      <template #footer><el-button @click="refuseDialogOpen = false">取消</el-button><el-button type="danger" :loading="actionLoading" @click="submitRefuse">确认拒绝</el-button></template>
    </el-dialog>
  </section>
</template>
