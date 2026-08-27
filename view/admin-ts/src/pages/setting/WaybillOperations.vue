<template>
  <div class="waybill-operations">
    <el-row :gutter="12" class="summary-row">
      <el-col v-for="item in summaryCards" :key="item.label" :xs="12" :sm="8" :md="4">
        <el-card shadow="never"><el-statistic :title="item.label" :value="item.value" /></el-card>
      </el-col>
    </el-row>

    <el-card shadow="never">
      <div class="toolbar">
        <el-select v-model="filters.status" clearable placeholder="全部状态" style="width: 180px" @change="load">
          <el-option v-for="item in statusOptions" :key="item.value" :value="item.value" :label="item.label" />
        </el-select>
        <el-input v-model="filters.supplier_id" clearable placeholder="供应商 ID" style="width: 160px" @keyup.enter="load" />
        <el-button type="primary" @click="load">查询</el-button>
      </div>
      <el-alert
        class="ledger-note"
        title="UNKNOWN 表示提供商可能已经签发。请先到一号通核对；只有人工明确确认后才能重签或关闭。"
        type="warning"
        :closable="false"
        show-icon
      />
      <el-table v-loading="loading" :data="rows" row-key="id">
        <el-table-column prop="order_no" label="订单号" min-width="180" />
        <el-table-column prop="supplier_id" label="供应商" width="90" />
        <el-table-column label="快递" min-width="130"><template #default="{ row }"><strong>{{ row.carrier_name }}</strong><small>{{ row.carrier_code }}</small></template></el-table-column>
        <el-table-column label="范围" width="80"><template #default="{ row }">{{ row.fulfillment_mode === 'split' ? '分批' : '整单' }}</template></el-table-column>
        <el-table-column prop="tracking_number" label="快递单号" min-width="150"><template #default="{ row }">{{ row.tracking_number || '—' }}</template></el-table-column>
        <el-table-column label="状态" width="110"><template #default="{ row }"><el-tag :type="statusMeta(row.status).type" effect="plain">{{ statusMeta(row.status).label }}</el-tag></template></el-table-column>
        <el-table-column label="更新时间" width="160"><template #default="{ row }">{{ formatTime(row.update_time) }}</template></el-table-column>
        <el-table-column label="操作" min-width="250" fixed="right">
          <template #default="{ row }">
            <el-link v-if="row.label_url" :href="row.label_url" target="_blank" rel="noopener noreferrer" type="primary">面单</el-link>
            <el-button v-if="row.status === 'UNKNOWN' && row.tracking_number" link type="success" :loading="busyId === row.id" @click="operate(row, 'apply-existing')">应用已有</el-button>
            <el-button v-if="row.status === 'UNKNOWN' && !row.tracking_number" link type="primary" @click="openConfirm(row)">确认已签发</el-button>
            <el-button v-if="(row.status === 'UNKNOWN' || row.status === 'DEAD') && !row.tracking_number" link type="warning" :loading="busyId === row.id" @click="operate(row, 'confirm-retry')">确认重签</el-button>
            <el-button v-if="row.status === 'UNKNOWN' || row.status === 'DEAD'" link type="danger" :loading="busyId === row.id" @click="operate(row, 'close')">关闭</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && rows.length === 0" description="暂无电子面单任务" />
    </el-card>

    <el-dialog v-model="confirmVisible" title="确认提供商已签发" width="min(560px, 94vw)">
      <el-alert title="不会再次请求提供商；只使用已核对的单号完成订单发货。" type="warning" :closable="false" show-icon />
      <el-form label-position="top" class="confirm-form">
        <el-form-item label="快递单号"><el-input v-model="confirmForm.tracking_number" maxlength="64" /></el-form-item>
        <el-form-item label="面单图片地址（可选）"><el-input v-model="confirmForm.label_url" maxlength="255" /></el-form-item>
        <el-form-item label="提供商引用（可选）"><el-input v-model="confirmForm.provider_reference" maxlength="255" /></el-form-item>
        <el-form-item label="审计原因"><el-input v-model="confirmForm.reason" type="textarea" :rows="3" maxlength="500" show-word-limit /></el-form-item>
      </el-form>
      <template #footer><el-button @click="confirmVisible = false">取消</el-button><el-button type="primary" :loading="busyId === current?.id" @click="confirmIssued">确认并发货</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import dayjs from "dayjs";
import {
  apiAdminOperateWaybill,
  apiAdminWaybillJobs,
  type AdminWaybillJob,
} from "@/api/order";

const loading = ref(false);
const busyId = ref<number | null>(null);
const rows = ref<AdminWaybillJob[]>([]);
const summary = reactive({ pending: 0, sent: 0, unknown: 0, dead: 0, closed: 0 });
const filters = reactive({ status: "", supplier_id: "" });
const confirmVisible = ref(false);
const current = ref<AdminWaybillJob | null>(null);
const confirmForm = reactive({ tracking_number: "", label_url: "", provider_reference: "", reason: "" });

const statusOptions = [
  { value: "PENDING", label: "待调度" }, { value: "ENQUEUING", label: "投递中" },
  { value: "ENQUEUED", label: "已入队" }, { value: "PROCESSING", label: "签发中" },
  { value: "RETRYABLE", label: "待重试" }, { value: "SENT", label: "已发货" },
  { value: "UNKNOWN", label: "结果未知" }, { value: "DEAD", label: "明确失败" },
  { value: "CLOSED", label: "已关闭" },
];
const summaryCards = computed(() => [
  { label: "处理中", value: summary.pending }, { label: "已发货", value: summary.sent },
  { label: "结果未知", value: summary.unknown }, { label: "明确失败", value: summary.dead },
  { label: "已关闭", value: summary.closed },
]);

function formatTime(value: number) {
  return value ? dayjs(value * 1000).format("YYYY-MM-DD HH:mm") : "—";
}

function statusMeta(value: AdminWaybillJob["status"]) {
  if (value === "SENT") return { label: "已发货", type: "success" as const };
  if (value === "UNKNOWN") return { label: "结果未知", type: "warning" as const };
  if (value === "DEAD") return { label: "明确失败", type: "danger" as const };
  if (value === "CLOSED") return { label: "已关闭", type: "info" as const };
  return { label: statusOptions.find((item) => item.value === value)?.label ?? value, type: "primary" as const };
}

async function load() {
  loading.value = true;
  try {
    const supplierId = Number(filters.supplier_id);
    const result = await apiAdminWaybillJobs({
      ...(filters.status ? { status: filters.status } : {}),
      ...(Number.isSafeInteger(supplierId) && supplierId > 0 ? { supplier_id: supplierId } : {}),
      limit: 100,
    });
    rows.value = result.list;
    Object.assign(summary, result.summary);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "电子面单账本加载失败");
  } finally {
    loading.value = false;
  }
}

async function reasonFor(title: string) {
  try {
    const { value } = await ElMessageBox.prompt("请填写不少于 8 个字符的审计原因", title, {
      inputPattern: /^.{8,500}$/s,
      inputErrorMessage: "原因必须为 8 到 500 个字符",
      confirmButtonText: "确认",
      cancelButtonText: "取消",
    });
    return value.trim();
  } catch {
    return "";
  }
}

async function operate(row: AdminWaybillJob, action: "apply-existing" | "confirm-retry" | "close") {
  const reason = await reasonFor(action === "apply-existing" ? "应用已有面单" : action === "confirm-retry" ? "确认重新签发" : "关闭面单任务");
  if (!reason) return;
  busyId.value = row.id;
  try {
    await apiAdminOperateWaybill(row.id, action, { reason });
    ElMessage.success("操作已记录");
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "电子面单操作失败");
  } finally {
    busyId.value = null;
  }
}

function openConfirm(row: AdminWaybillJob) {
  current.value = row;
  confirmForm.tracking_number = row.tracking_number;
  confirmForm.label_url = row.label_url;
  confirmForm.provider_reference = row.provider_reference;
  confirmForm.reason = "";
  confirmVisible.value = true;
}

async function confirmIssued() {
  if (!current.value) return;
  if (!confirmForm.tracking_number.trim()) return ElMessage.warning("请填写快递单号");
  if (confirmForm.reason.trim().length < 8) return ElMessage.warning("审计原因不少于 8 个字符");
  busyId.value = current.value.id;
  try {
    await apiAdminOperateWaybill(current.value.id, "confirm-issued", {
      tracking_number: confirmForm.tracking_number.trim(),
      label_url: confirmForm.label_url.trim(),
      provider_reference: confirmForm.provider_reference.trim(),
      reason: confirmForm.reason.trim(),
    });
    confirmVisible.value = false;
    ElMessage.success("已确认面单并完成发货");
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "确认面单失败");
  } finally {
    busyId.value = null;
  }
}

onMounted(load);
</script>

<style scoped>
.summary-row { margin-bottom: 16px; row-gap: 12px; }
.toolbar { display: flex; gap: 10px; margin-bottom: 14px; }
.ledger-note { margin-bottom: 14px; }
small { display: block; color: #909399; }
.confirm-form { margin-top: 18px; }
</style>
