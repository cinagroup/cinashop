<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  deletePrintDocument,
  getPrintContent,
  getPrintDocument,
  getPrintDocuments,
  getPrintJobs,
  operatePrintJob,
  savePrintContent,
  savePrintDocument,
  setPrintDocumentStatus,
} from "@/api/supplier";
import type { PrintContent, PrintDocumentView, PrintJobSummary, PrintJobView } from "@/types";

interface PrinterForm {
  id: number;
  print_name: string;
  type: 1 | 2;
  yly_user_id: string;
  yly_app_id: string;
  yly_app_secret: string;
  yly_app_secret_configured: boolean;
  yly_sn: string;
  fey_user: string;
  fey_ukey: string;
  fey_ukey_configured: boolean;
  fey_sn: string;
  times: number;
  print_type: 1 | 2;
}

const loading = ref(false);
const saving = ref(false);
const contentSaving = ref(false);
const rows = ref<PrintDocumentView[]>([]);
const count = ref(0);
const filter = reactive({ keyword: "", type: 0 });
const formVisible = ref(false);
const contentVisible = ref(false);
const contentPrinter = ref<PrintDocumentView | null>(null);
const jobsLoading = ref(false);
const jobs = ref<PrintJobView[]>([]);
const jobSummary = ref<PrintJobSummary>({ pending: 0, sent: 0, unknown: 0, dead: 0, closed: 0 });
const jobStatus = ref("");

const blankForm = (): PrinterForm => ({
  id: 0,
  print_name: "",
  type: 1,
  yly_user_id: "",
  yly_app_id: "",
  yly_app_secret: "",
  yly_app_secret_configured: false,
  yly_sn: "",
  fey_user: "",
  fey_ukey: "",
  fey_ukey_configured: false,
  fey_sn: "",
  times: 1,
  print_type: 1,
});

const blankContent = (): PrintContent => ({
  header: 1,
  delivery: 1,
  buyer_remarks: 1,
  goods: [0],
  freight: 1,
  preferential: 1,
  pay: [0, 1],
  custom: 0,
  order: [0, 1, 2, 3],
  code: 0,
  code_url: "",
  show_notice: 0,
  notice_content: "",
});

const form = reactive<PrinterForm>(blankForm());
const contentForm = reactive<PrintContent>(blankContent());

async function load() {
  loading.value = true;
  try {
    const result = await getPrintDocuments({ keyword: filter.keyword, type: filter.type });
    rows.value = result.list;
    count.value = result.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "打印机列表加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadJobs() {
  jobsLoading.value = true;
  try {
    const result = await getPrintJobs({ status: jobStatus.value, limit: 50 });
    jobs.value = result.list;
    jobSummary.value = result.summary;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "打印任务加载失败");
  } finally {
    jobsLoading.value = false;
  }
}

function jobStatusMeta(status: PrintJobView["status"]) {
  if (status === "SENT") return { label: "已发送", type: "success" as const };
  if (status === "UNKNOWN") return { label: "结果未知", type: "warning" as const };
  if (status === "DEAD") return { label: "已停止", type: "danger" as const };
  if (status === "CLOSED") return { label: "人工关闭", type: "info" as const };
  return { label: "处理中", type: "primary" as const };
}

async function handleJob(job: PrintJobView, action: "confirm-sent" | "confirm-retry" | "close") {
  if (action === "confirm-retry") {
    try {
      await ElMessageBox.confirm(
        "打印商可能已经接单。确认重打可能产生重复小票，请先在打印商后台核验。",
        "确认承担重复打印风险",
        { type: "warning", confirmButtonText: "已核验，仍要重打", cancelButtonText: "取消" },
      );
    } catch {
      return;
    }
  }
  try {
    const { value } = await ElMessageBox.prompt(
      "请输入至少 8 个字符的核验依据或操作原因，内容将永久写入审计记录。",
      action === "confirm-sent" ? "确认已打印" : action === "confirm-retry" ? "确认重打" : "关闭任务",
      { inputPattern: /^.{8,500}$/s, inputErrorMessage: "请输入 8 到 500 个字符" },
    );
    await operatePrintJob(job.id, action, value);
    ElMessage.success("打印任务已更新");
    await loadJobs();
  } catch (error) {
    if (error !== "cancel" && error !== "close") {
      ElMessage.error(error instanceof Error ? error.message : "打印任务操作失败");
    }
  }
}

async function openForm(id = 0) {
  try {
    const detail = await getPrintDocument(id);
    Object.assign(form, blankForm(), {
      ...detail,
      yly_app_secret: "",
      fey_ukey: "",
    });
    formVisible.value = true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "打印机配置加载失败");
  }
}

async function submitForm() {
  saving.value = true;
  try {
    const saved = await savePrintDocument(form.id, {
      print_name: form.print_name,
      type: form.type,
      yly_user_id: form.yly_user_id,
      yly_app_id: form.yly_app_id,
      yly_app_secret: form.yly_app_secret,
      yly_sn: form.yly_sn,
      fey_user: form.fey_user,
      fey_ukey: form.fey_ukey,
      fey_sn: form.fey_sn,
      times: form.times,
      print_type: form.print_type,
    });
    formVisible.value = false;
    ElMessage.success(saved.id === form.id && form.id ? "打印机配置已更新" : "打印机已添加，请继续配置打印内容");
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "打印机保存失败");
  } finally {
    saving.value = false;
  }
}

async function openContent(row: PrintDocumentView) {
  try {
    Object.assign(contentForm, blankContent(), await getPrintContent(row.id));
    contentPrinter.value = row;
    contentVisible.value = true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "打印内容加载失败");
  }
}

async function submitContent() {
  if (!contentPrinter.value) return;
  contentSaving.value = true;
  try {
    await savePrintContent(contentPrinter.value.id, { ...contentForm });
    contentVisible.value = false;
    ElMessage.success("打印内容已保存");
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "打印内容保存失败");
  } finally {
    contentSaving.value = false;
  }
}

async function changeStatus(row: PrintDocumentView, value: string | number | boolean) {
  const next = Number(value) as 0 | 1;
  const previous = next === 1 ? 0 : 1;
  try {
    await setPrintDocumentStatus(row.id, next);
    ElMessage.success(next ? "打印机已启用" : "打印机已停用");
    await load();
  } catch (error) {
    row.status = previous;
    ElMessage.error(error instanceof Error ? error.message : "状态修改失败");
  }
}

async function remove(row: PrintDocumentView) {
  try {
    await ElMessageBox.confirm(`确认删除“${row.print_name}”吗？`, "删除打印机", {
      type: "warning",
      confirmButtonText: "确认删除",
      cancelButtonText: "取消",
    });
    await deletePrintDocument(row.id);
    ElMessage.success("打印机已删除");
    await load();
  } catch (error) {
    if (error !== "cancel" && error !== "close") {
      ElMessage.error(error instanceof Error ? error.message : "删除失败");
    }
  }
}

function readiness(row: PrintDocumentView) {
  if (row.ready) return { label: "配置就绪", type: "success" as const };
  if (!row.provider_ready) return { label: "凭据不完整", type: "warning" as const };
  if (!row.content_valid) return { label: "模板需修复", type: "danger" as const };
  return { label: "待配打印内容", type: "info" as const };
}

onMounted(() => { void Promise.all([load(), loadJobs()]); });
</script>

<template>
  <section class="page-section printers-page">
    <header class="page-heading printers-heading">
      <div>
        <h1>小票打印机</h1>
        <p>管理易联云与飞鹅云终端、打印时机和订单小票内容</p>
      </div>
      <el-button type="primary" @click="openForm(0)">添加打印机</el-button>
    </header>

    <el-alert
      class="printer-rollout-note"
      title="打印任务已使用持久 outbox 和 Cloudflare Queue；结果未知的任务绝不会自动重打，必须人工核验并留下审计原因。"
      type="success"
      :closable="false"
      show-icon
    />

    <article class="surface list-surface printer-list-surface">
      <div class="filter-row printer-filter-row">
        <el-input
          v-model="filter.keyword"
          class="search-input"
          clearable
          placeholder="搜索打印机名称"
          @keyup.enter="load"
        />
        <el-select v-model="filter.type" class="state-select" @change="load">
          <el-option label="全部平台" :value="0" />
          <el-option label="易联云" :value="1" />
          <el-option label="飞鹅云" :value="2" />
        </el-select>
        <el-button @click="load">查询</el-button>
        <span class="printer-count">共 {{ count }} 台</span>
      </div>

      <el-table v-loading="loading" :data="rows" class="printer-table">
        <el-table-column label="打印机" min-width="210">
          <template #default="{ row }">
            <div class="printer-name-cell">
              <strong>{{ row.print_name }}</strong>
              <span>{{ row.type === 1 ? row.yly_sn || "未填写终端号" : row.fey_sn || "未填写 SN" }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="平台" width="110">
          <template #default="{ row }">{{ row.type === 1 ? "易联云" : "飞鹅云" }}</template>
        </el-table-column>
        <el-table-column label="打印时机" width="120">
          <template #default="{ row }">{{ row.print_type === 1 ? "支付后" : "下单后" }}</template>
        </el-table-column>
        <el-table-column prop="times" label="联数" width="80" />
        <el-table-column label="配置状态" width="130">
          <template #default="{ row }">
            <el-tag :type="readiness(row).type" effect="plain">{{ readiness(row).label }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="启用" width="92">
          <template #default="{ row }">
            <el-switch
              v-model="row.status"
              :active-value="1"
              :inactive-value="0"
              :disabled="row.status === 0 && !row.ready"
              @change="changeStatus(row, $event)"
            />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openForm(row.id)">编辑</el-button>
            <el-button link type="primary" @click="openContent(row)">打印内容</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="mobile-printer-list">
        <article v-for="row in rows" :key="row.id" class="mobile-printer-card">
          <header>
            <div><strong>{{ row.print_name }}</strong><span>{{ row.type === 1 ? "易联云" : "飞鹅云" }} · {{ row.print_type === 1 ? "支付后" : "下单后" }}</span></div>
            <el-tag :type="readiness(row).type" effect="plain" size="small">{{ readiness(row).label }}</el-tag>
          </header>
          <p>{{ row.type === 1 ? row.yly_sn || "未填写终端号" : row.fey_sn || "未填写 SN" }} · {{ row.times }} 联</p>
          <footer>
            <el-button size="small" @click="openForm(row.id)">编辑</el-button>
            <el-button size="small" @click="openContent(row)">打印内容</el-button>
            <el-switch
              v-model="row.status"
              :active-value="1"
              :inactive-value="0"
              :disabled="row.status === 0 && !row.ready"
              @change="changeStatus(row, $event)"
            />
          </footer>
        </article>
        <div v-if="!loading && !rows.length" class="mobile-empty">暂无打印机</div>
      </div>
    </article>

    <article class="surface list-surface printer-job-surface">
      <div class="filter-row printer-filter-row">
        <strong>打印任务</strong>
        <el-select v-model="jobStatus" class="state-select" placeholder="全部状态" clearable @change="loadJobs">
          <el-option label="处理中" value="PENDING" />
          <el-option label="已发送" value="SENT" />
          <el-option label="结果未知" value="UNKNOWN" />
          <el-option label="已停止" value="DEAD" />
          <el-option label="人工关闭" value="CLOSED" />
        </el-select>
        <el-button @click="loadJobs">刷新</el-button>
        <span class="printer-count">待处理 {{ jobSummary.pending }} · 未知 {{ jobSummary.unknown }} · 停止 {{ jobSummary.dead }}</span>
      </div>
      <el-table v-loading="jobsLoading" :data="jobs" empty-text="暂无打印任务">
        <el-table-column prop="order_no" label="订单号" min-width="180" />
        <el-table-column label="触发" width="100">
          <template #default="{ row }">{{ row.trigger === "created" ? "下单后" : row.trigger === "paid" ? "支付后" : "手工" }}</template>
        </el-table-column>
        <el-table-column label="平台" width="100">
          <template #default="{ row }">{{ row.provider === "yilianyun" ? "易联云" : "飞鹅云" }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }"><el-tag :type="jobStatusMeta(row.status).type" effect="plain">{{ jobStatusMeta(row.status).label }}</el-tag></template>
        </el-table-column>
        <el-table-column prop="attempt_count" label="尝试" width="70" />
        <el-table-column label="提供商引用" min-width="150">
          <template #default="{ row }">{{ row.provider_reference || "-" }}</template>
        </el-table-column>
        <el-table-column label="最近错误" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">{{ row.last_error || "-" }}</template>
        </el-table-column>
        <el-table-column label="操作" width="250" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.status === 'UNKNOWN'" link type="success" @click="handleJob(row, 'confirm-sent')">确认已打印</el-button>
            <el-button v-if="row.status === 'UNKNOWN' || row.status === 'DEAD'" link type="warning" @click="handleJob(row, 'confirm-retry')">核验后重打</el-button>
            <el-button v-if="row.status === 'UNKNOWN'" link type="danger" @click="handleJob(row, 'close')">关闭</el-button>
          </template>
        </el-table-column>
      </el-table>
    </article>

    <el-dialog v-model="formVisible" :title="form.id ? '编辑打印机' : '添加打印机'" width="min(680px, 94vw)">
      <el-form label-position="top" class="printer-form">
        <el-form-item label="打印机名称" required>
          <el-input v-model="form.print_name" maxlength="255" placeholder="例如：仓库一号打印机" />
        </el-form-item>
        <div class="printer-form-grid">
          <el-form-item label="打印平台">
            <el-radio-group v-model="form.type">
              <el-radio-button :value="1">易联云</el-radio-button>
              <el-radio-button :value="2">飞鹅云</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="打印时机">
            <el-radio-group v-model="form.print_type">
              <el-radio-button :value="1">支付后</el-radio-button>
              <el-radio-button :value="2">下单后</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="打印联数">
            <el-input-number v-model="form.times" :min="1" :max="10" />
          </el-form-item>
        </div>

        <section v-if="form.type === 1" class="provider-fields">
          <h3>易联云凭据</h3>
          <div class="printer-form-grid">
            <el-form-item label="用户 ID"><el-input v-model="form.yly_user_id" /></el-form-item>
            <el-form-item label="应用 ID"><el-input v-model="form.yly_app_id" /></el-form-item>
            <el-form-item label="应用密钥">
              <el-input v-model="form.yly_app_secret" type="password" show-password autocomplete="new-password" :placeholder="form.yly_app_secret_configured ? '已配置，留空保持不变' : '请输入应用密钥'" />
            </el-form-item>
            <el-form-item label="终端号"><el-input v-model="form.yly_sn" /></el-form-item>
          </div>
        </section>
        <section v-else class="provider-fields">
          <h3>飞鹅云凭据</h3>
          <div class="printer-form-grid">
            <el-form-item label="账号"><el-input v-model="form.fey_user" /></el-form-item>
            <el-form-item label="UKEY">
              <el-input v-model="form.fey_ukey" type="password" show-password autocomplete="new-password" :placeholder="form.fey_ukey_configured ? '已配置，留空保持不变' : '请输入 UKEY'" />
            </el-form-item>
            <el-form-item label="打印机 SN"><el-input v-model="form.fey_sn" /></el-form-item>
          </div>
        </section>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitForm">保存配置</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="contentVisible" :title="`打印内容 · ${contentPrinter?.print_name ?? ''}`" width="min(720px, 94vw)">
      <el-form label-position="top" class="print-content-form">
        <section class="content-switch-grid">
          <label><span>店铺标题</span><el-switch v-model="contentForm.header" :active-value="1" :inactive-value="0" /></label>
          <label><span>配送与收件信息</span><el-switch v-model="contentForm.delivery" :active-value="1" :inactive-value="0" /></label>
          <label><span>买家备注</span><el-switch v-model="contentForm.buyer_remarks" :active-value="1" :inactive-value="0" /></label>
          <label><span>运费</span><el-switch v-model="contentForm.freight" :active-value="1" :inactive-value="0" /></label>
          <label><span>优惠明细</span><el-switch v-model="contentForm.preferential" :active-value="1" :inactive-value="0" /></label>
        </section>
        <el-form-item label="商品信息">
          <el-checkbox-group v-model="contentForm.goods">
            <el-checkbox :value="0">商品名称、价格与数量</el-checkbox>
            <el-checkbox :value="1">规格编码</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="支付信息">
          <el-checkbox-group v-model="contentForm.pay">
            <el-checkbox :value="0">支付方式</el-checkbox>
            <el-checkbox :value="1">实付金额</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="订单信息">
          <el-checkbox-group v-model="contentForm.order">
            <el-checkbox :value="0">订单编号</el-checkbox>
            <el-checkbox :value="1">下单时间</el-checkbox>
            <el-checkbox :value="2">支付时间</el-checkbox>
            <el-checkbox :value="3">打印时间</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="订单二维码">
          <el-switch v-model="contentForm.code" :active-value="1" :inactive-value="0" />
          <el-input v-if="contentForm.code" v-model="contentForm.code_url" class="content-inline-input" placeholder="站内路径，例如 /pages/order/detail" />
        </el-form-item>
        <el-form-item label="底部提示语">
          <el-switch v-model="contentForm.show_notice" :active-value="1" :inactive-value="0" />
          <el-input v-if="contentForm.show_notice" v-model="contentForm.notice_content" class="content-inline-input" maxlength="500" placeholder="例如：感谢惠顾，请核对商品数量" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="contentVisible = false">取消</el-button>
        <el-button type="primary" :loading="contentSaving" @click="submitContent">保存打印内容</el-button>
      </template>
    </el-dialog>
  </section>
</template>
