<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { getWaybillJobs, operateWaybillJob } from "@/api/supplier";
import type { WaybillJobSummary, WaybillJobView } from "@/types";
import { formatTime } from "@/utils/format";

const loading = ref(false);
const actionLoading = ref<number | null>(null);
const rows = ref<WaybillJobView[]>([]);
const summary = ref<WaybillJobSummary>({ pending: 0, sent: 0, unknown: 0, dead: 0, closed: 0 });
const status = ref("");
const confirmVisible = ref(false);
const current = ref<WaybillJobView | null>(null);
const confirmForm = reactive({ tracking_number: "", label_url: "", provider_reference: "", reason: "" });

const statusOptions = [
  ["PENDING", "待调度"], ["ENQUEUING", "投递中"], ["ENQUEUED", "已入队"],
  ["PROCESSING", "签发中"], ["RETRYABLE", "待重试"], ["SENT", "已发货"],
  ["UNKNOWN", "结果未知"], ["DEAD", "明确失败"], ["CLOSED", "已关闭"],
] as const;

function statusMeta(value: WaybillJobView["status"]) {
  if (value === "SENT") return { label: "已发货", type: "success" as const };
  if (value === "UNKNOWN") return { label: "结果未知", type: "warning" as const };
  if (value === "DEAD") return { label: "明确失败", type: "danger" as const };
  if (value === "CLOSED") return { label: "已关闭", type: "info" as const };
  return { label: statusOptions.find(([key]) => key === value)?.[1] ?? value, type: "primary" as const };
}

async function load() {
  loading.value = true;
  try {
    const result = await getWaybillJobs({ ...(status.value ? { status: status.value } : {}), limit: 100 });
    rows.value = result.list;
    summary.value = result.summary;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "电子面单账本加载失败");
  } finally {
    loading.value = false;
  }
}

async function reasonFor(title: string): Promise<string | null> {
  try {
    const { value } = await ElMessageBox.prompt("请填写不少于 8 个字符的审计原因", title, {
      inputPattern: /^.{8,500}$/s,
      inputErrorMessage: "原因必须为 8 到 500 个字符",
      confirmButtonText: "确认",
      cancelButtonText: "取消",
    });
    return value.trim();
  } catch {
    return null;
  }
}

async function operate(row: WaybillJobView, action: "apply-existing" | "confirm-retry" | "close") {
  const title = action === "apply-existing" ? "应用已有面单" : action === "confirm-retry" ? "确认重新签发" : "关闭面单任务";
  const reason = await reasonFor(title);
  if (!reason) return;
  actionLoading.value = row.id;
  try {
    await operateWaybillJob(row.id, action, { request_key: crypto.randomUUID(), reason });
    ElMessage.success(action === "apply-existing" ? "已使用已有单号完成发货" : action === "confirm-retry" ? "已进入人工确认重签队列" : "任务已关闭");
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "面单任务操作失败");
  } finally {
    actionLoading.value = null;
  }
}

function openConfirm(row: WaybillJobView) {
  current.value = row;
  confirmForm.tracking_number = row.tracking_number;
  confirmForm.label_url = row.label_url;
  confirmForm.provider_reference = row.provider_reference;
  confirmForm.reason = "";
  confirmVisible.value = true;
}

async function confirmIssued() {
  if (!current.value) return;
  if (!confirmForm.tracking_number.trim()) return ElMessage.warning("请填写已签发的快递单号");
  if (confirmForm.reason.trim().length < 8) return ElMessage.warning("审计原因不少于 8 个字符");
  actionLoading.value = current.value.id;
  try {
    await operateWaybillJob(current.value.id, "confirm-issued", {
      request_key: crypto.randomUUID(),
      tracking_number: confirmForm.tracking_number.trim(),
      label_url: confirmForm.label_url.trim(),
      provider_reference: confirmForm.provider_reference.trim(),
      reason: confirmForm.reason.trim(),
    });
    confirmVisible.value = false;
    ElMessage.success("已确认既有面单并完成发货");
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "确认面单失败");
  } finally {
    actionLoading.value = null;
  }
}

onMounted(load);
</script>

<template>
  <section class="page-section waybill-page">
    <header class="page-heading">
      <div><h1>电子面单账本</h1><p>每次一号通签发都有持久证据；结果未知时必须人工核对，系统不会自动重复申请单号</p></div>
    </header>

    <div class="metric-strip">
      <article><span>处理中</span><strong>{{ summary.pending }}</strong></article>
      <article><span>已发货</span><strong>{{ summary.sent }}</strong></article>
      <article class="warning"><span>结果未知</span><strong>{{ summary.unknown }}</strong></article>
      <article class="danger"><span>明确失败</span><strong>{{ summary.dead }}</strong></article>
      <article><span>已关闭</span><strong>{{ summary.closed }}</strong></article>
    </div>

    <div class="surface list-surface">
      <div class="filter-row">
        <el-select v-model="status" clearable placeholder="全部状态" style="width: 180px" @change="load">
          <el-option v-for="option in statusOptions" :key="option[0]" :value="option[0]" :label="option[1]" />
        </el-select>
        <el-button @click="load">刷新</el-button>
      </div>
      <el-table v-loading="loading" :data="rows" row-key="id">
        <el-table-column prop="order_no" label="订单号" min-width="180" />
        <el-table-column label="快递" min-width="130"><template #default="{ row }"><strong>{{ row.carrier_name }}</strong><small class="muted-code">{{ row.carrier_code }}</small></template></el-table-column>
        <el-table-column label="范围" width="90"><template #default="{ row }">{{ row.fulfillment_mode === 'split' ? '分批' : '整单' }}</template></el-table-column>
        <el-table-column prop="tracking_number" label="快递单号" min-width="150"><template #default="{ row }">{{ row.tracking_number || '—' }}</template></el-table-column>
        <el-table-column label="状态" width="110"><template #default="{ row }"><el-tag :type="statusMeta(row.status).type" effect="plain">{{ statusMeta(row.status).label }}</el-tag></template></el-table-column>
        <el-table-column label="更新时间" width="175"><template #default="{ row }">{{ formatTime(row.update_time) }}</template></el-table-column>
        <el-table-column label="操作" min-width="250" fixed="right">
          <template #default="{ row }">
            <el-link v-if="row.label_url" :href="row.label_url" target="_blank" rel="noopener noreferrer" type="primary">面单</el-link>
            <el-button v-if="row.status === 'UNKNOWN' && row.tracking_number" link type="success" :loading="actionLoading === row.id" @click="operate(row, 'apply-existing')">应用已有</el-button>
            <el-button v-if="row.status === 'UNKNOWN' && !row.tracking_number" link type="primary" @click="openConfirm(row)">确认已签发</el-button>
            <el-button v-if="(row.status === 'UNKNOWN' || row.status === 'DEAD') && !row.tracking_number" link type="warning" :loading="actionLoading === row.id" @click="operate(row, 'confirm-retry')">确认重签</el-button>
            <el-button v-if="row.status === 'UNKNOWN' || row.status === 'DEAD'" link type="danger" :loading="actionLoading === row.id" @click="operate(row, 'close')">关闭</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && rows.length === 0" description="暂无电子面单任务" />
    </div>

    <el-dialog v-model="confirmVisible" title="确认提供商已签发" width="min(560px, 94vw)">
      <el-alert title="此操作不会再次调用一号通；它只使用已核对的单号完成本地发货。" type="warning" :closable="false" show-icon />
      <el-form label-position="top" class="confirm-form">
        <el-form-item label="快递单号"><el-input v-model="confirmForm.tracking_number" maxlength="64" /></el-form-item>
        <el-form-item label="面单图片地址（可选）"><el-input v-model="confirmForm.label_url" maxlength="255" /></el-form-item>
        <el-form-item label="提供商引用（可选）"><el-input v-model="confirmForm.provider_reference" maxlength="255" /></el-form-item>
        <el-form-item label="审计原因"><el-input v-model="confirmForm.reason" type="textarea" :rows="3" maxlength="500" show-word-limit /></el-form-item>
      </el-form>
      <template #footer><el-button @click="confirmVisible = false">取消</el-button><el-button type="primary" :loading="actionLoading === current?.id" @click="confirmIssued">确认并发货</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.metric-strip { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
.metric-strip article { padding: 16px 18px; border: 1px solid var(--border-color); border-radius: 14px; background: var(--surface-color); }
.metric-strip span, .muted-code { display: block; color: var(--text-muted); font-size: 12px; }
.metric-strip strong { display: block; margin-top: 6px; font-size: 24px; }
.metric-strip .warning strong { color: #b26a00; }
.metric-strip .danger strong { color: #c33b3b; }
.confirm-form { margin-top: 18px; }
@media (max-width: 820px) { .metric-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
