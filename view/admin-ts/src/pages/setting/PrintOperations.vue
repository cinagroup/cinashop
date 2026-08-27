<template>
  <div class="print-operations">
    <div class="page-header">
      <div><h2>小票打印</h2><p>平台打印机配置、持久任务与不确定结果处置</p></div>
      <el-button type="primary" @click="openPrinter(0)">添加打印机</el-button>
    </div>
    <el-alert
      title="打印任务由 PostgreSQL outbox 记账并通过 Cloudflare Queue 唤醒；UNKNOWN 任务不会自动重打。"
      type="success"
      :closable="false"
      show-icon
      class="rollout-alert"
    />

    <el-tabs v-model="tab">
      <el-tab-pane label="打印机" name="printers">
        <el-card shadow="never">
          <el-table v-loading="printerLoading" :data="printers" class="desktop-print-table">
            <el-table-column prop="print_name" label="打印机" min-width="180" />
            <el-table-column label="平台" width="100"><template #default="{ row }">{{ row.type === 1 ? "易联云" : "飞鹅云" }}</template></el-table-column>
            <el-table-column label="时机" width="100"><template #default="{ row }">{{ row.print_type === 1 ? "支付后" : "下单后" }}</template></el-table-column>
            <el-table-column prop="times" label="联数" width="70" />
            <el-table-column label="配置" width="120"><template #default="{ row }"><el-tag :type="row.ready ? 'success' : 'warning'">{{ row.ready ? "就绪" : "未完成" }}</el-tag></template></el-table-column>
            <el-table-column label="启用" width="90"><template #default="{ row }"><el-switch v-model="row.status" :active-value="1" :inactive-value="0" :disabled="row.status === 0 && !row.ready" @change="changeStatus(row, $event)" /></template></el-table-column>
            <el-table-column label="操作" width="220" fixed="right"><template #default="{ row }">
              <el-button link type="primary" @click="openPrinter(row.id)">编辑</el-button>
              <el-button link type="primary" @click="openContent(row)">打印内容</el-button>
              <el-button link type="danger" @click="removePrinter(row)">删除</el-button>
            </template></el-table-column>
          </el-table>
          <div class="mobile-print-list">
            <article v-for="row in printers" :key="row.id" class="mobile-print-card">
              <header><div><strong>{{ row.print_name }}</strong><span>{{ row.type === 1 ? "易联云" : "飞鹅云" }} · {{ row.print_type === 1 ? "支付后" : "下单后" }}</span></div><el-tag :type="row.ready ? 'success' : 'warning'" size="small">{{ row.ready ? "就绪" : "未完成" }}</el-tag></header>
              <p>{{ row.type === 1 ? row.yly_sn : row.fey_sn }} · {{ row.times }} 联</p>
              <footer><el-button size="small" @click="openPrinter(row.id)">编辑</el-button><el-button size="small" @click="openContent(row)">打印内容</el-button><el-switch v-model="row.status" :active-value="1" :inactive-value="0" :disabled="row.status === 0 && !row.ready" @change="changeStatus(row, $event)" /></footer>
            </article>
            <el-empty v-if="!printerLoading && !printers.length" description="暂无打印机" :image-size="72" />
          </div>
        </el-card>
      </el-tab-pane>

      <el-tab-pane :label="`打印任务 (${summary.pending})`" name="jobs">
        <el-card shadow="never">
          <div class="job-filter">
            <el-select v-model="jobStatus" clearable placeholder="全部状态" @change="loadJobs">
              <el-option label="已发送" value="SENT" /><el-option label="结果未知" value="UNKNOWN" />
              <el-option label="已停止" value="DEAD" /><el-option label="人工关闭" value="CLOSED" />
            </el-select>
            <el-button @click="loadJobs">刷新</el-button>
            <span>未知 {{ summary.unknown }} · 停止 {{ summary.dead }} · 已关闭 {{ summary.closed }}</span>
          </div>
          <el-table v-loading="jobLoading" :data="jobs" empty-text="暂无打印任务" class="desktop-print-table">
            <el-table-column prop="order_no" label="订单号" min-width="180" />
            <el-table-column label="触发" width="90"><template #default="{ row }">{{ triggerLabel(row.trigger) }}</template></el-table-column>
            <el-table-column label="平台" width="90"><template #default="{ row }">{{ row.provider === "yilianyun" ? "易联云" : "飞鹅云" }}</template></el-table-column>
            <el-table-column label="状态" width="110"><template #default="{ row }"><el-tag :type="statusMeta(row.status).type">{{ statusMeta(row.status).label }}</el-tag></template></el-table-column>
            <el-table-column prop="attempt_count" label="尝试" width="70" />
            <el-table-column prop="provider_reference" label="提供商引用" min-width="140" />
            <el-table-column prop="last_error" label="最近错误" min-width="220" show-overflow-tooltip />
            <el-table-column label="操作" width="250" fixed="right"><template #default="{ row }">
              <el-button v-if="row.status === 'UNKNOWN'" link type="success" @click="operate(row, 'confirm-sent')">确认已打印</el-button>
              <el-button v-if="row.status === 'UNKNOWN' || row.status === 'DEAD'" link type="warning" @click="operate(row, 'confirm-retry')">核验后重打</el-button>
              <el-button v-if="row.status === 'UNKNOWN'" link type="danger" @click="operate(row, 'close')">关闭</el-button>
            </template></el-table-column>
          </el-table>
          <div class="mobile-print-list">
            <article v-for="row in jobs" :key="row.id" class="mobile-print-card">
              <header><div><strong>{{ row.order_no }}</strong><span>{{ triggerLabel(row.trigger) }} · {{ row.provider === "yilianyun" ? "易联云" : "飞鹅云" }}</span></div><el-tag :type="statusMeta(row.status).type" size="small">{{ statusMeta(row.status).label }}</el-tag></header>
              <p>{{ row.last_error || row.provider_reference || `已尝试 ${row.attempt_count} 次` }}</p>
              <footer><el-button v-if="row.status === 'UNKNOWN'" size="small" type="success" plain @click="operate(row, 'confirm-sent')">确认已打印</el-button><el-button v-if="row.status === 'UNKNOWN' || row.status === 'DEAD'" size="small" type="warning" plain @click="operate(row, 'confirm-retry')">核验后重打</el-button><el-button v-if="row.status === 'UNKNOWN'" size="small" type="danger" plain @click="operate(row, 'close')">关闭</el-button></footer>
            </article>
            <el-empty v-if="!jobLoading && !jobs.length" description="暂无打印任务" :image-size="72" />
          </div>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="printerDialog" :title="printerForm.id ? '编辑打印机' : '添加打印机'" width="min(680px, 94vw)">
      <el-form label-position="top">
        <el-form-item label="打印机名称"><el-input v-model="printerForm.print_name" maxlength="255" /></el-form-item>
        <div class="form-grid">
          <el-form-item label="平台"><el-radio-group v-model="printerForm.type"><el-radio-button :value="1">易联云</el-radio-button><el-radio-button :value="2">飞鹅云</el-radio-button></el-radio-group></el-form-item>
          <el-form-item label="时机"><el-radio-group v-model="printerForm.print_type"><el-radio-button :value="1">支付后</el-radio-button><el-radio-button :value="2">下单后</el-radio-button></el-radio-group></el-form-item>
          <el-form-item label="联数"><el-input-number v-model="printerForm.times" :min="1" :max="10" /></el-form-item>
        </div>
        <div v-if="printerForm.type === 1" class="form-grid">
          <el-form-item label="用户 ID"><el-input v-model="printerForm.yly_user_id" /></el-form-item>
          <el-form-item label="应用 ID"><el-input v-model="printerForm.yly_app_id" /></el-form-item>
          <el-form-item label="应用密钥"><el-input v-model="printerForm.yly_app_secret" type="password" show-password :placeholder="printerForm.yly_app_secret_configured ? '已配置，留空保持' : ''" /></el-form-item>
          <el-form-item label="终端号"><el-input v-model="printerForm.yly_sn" /></el-form-item>
        </div>
        <div v-else class="form-grid">
          <el-form-item label="账号"><el-input v-model="printerForm.fey_user" /></el-form-item>
          <el-form-item label="UKEY"><el-input v-model="printerForm.fey_ukey" type="password" show-password :placeholder="printerForm.fey_ukey_configured ? '已配置，留空保持' : ''" /></el-form-item>
          <el-form-item label="打印机 SN"><el-input v-model="printerForm.fey_sn" /></el-form-item>
        </div>
      </el-form>
      <template #footer><el-button @click="printerDialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="savePrinter">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="contentDialog" title="打印内容" width="min(680px, 94vw)">
      <el-form label-position="top">
        <div class="switch-grid">
          <el-checkbox v-model="content.header" :true-value="1" :false-value="0">店铺标题</el-checkbox>
          <el-checkbox v-model="content.delivery" :true-value="1" :false-value="0">配送信息</el-checkbox>
          <el-checkbox v-model="content.buyer_remarks" :true-value="1" :false-value="0">买家备注</el-checkbox>
          <el-checkbox v-model="content.freight" :true-value="1" :false-value="0">运费</el-checkbox>
          <el-checkbox v-model="content.preferential" :true-value="1" :false-value="0">优惠</el-checkbox>
        </div>
        <el-form-item label="商品"><el-checkbox-group v-model="content.goods"><el-checkbox :value="0">商品明细</el-checkbox><el-checkbox :value="1">规格编码</el-checkbox></el-checkbox-group></el-form-item>
        <el-form-item label="支付"><el-checkbox-group v-model="content.pay"><el-checkbox :value="0">支付方式</el-checkbox><el-checkbox :value="1">实付金额</el-checkbox></el-checkbox-group></el-form-item>
        <el-form-item label="订单"><el-checkbox-group v-model="content.order"><el-checkbox :value="0">编号</el-checkbox><el-checkbox :value="1">下单时间</el-checkbox><el-checkbox :value="2">支付时间</el-checkbox><el-checkbox :value="3">打印时间</el-checkbox></el-checkbox-group></el-form-item>
        <el-form-item label="二维码"><el-switch v-model="content.code" :active-value="1" :inactive-value="0" /><el-input v-if="content.code" v-model="content.code_url" placeholder="站内绝对路径" /></el-form-item>
        <el-form-item label="底部提示"><el-switch v-model="content.show_notice" :active-value="1" :inactive-value="0" /><el-input v-if="content.show_notice" v-model="content.notice_content" maxlength="500" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="contentDialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveContent">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiDeletePrintDocument,
  apiOperatePrintJob,
  apiPrintContent,
  apiPrintDocument,
  apiPrintDocuments,
  apiPrintJobs,
  apiSavePrintContent,
  apiSavePrintDocument,
  apiSetPrintDocumentStatus,
  type PrintContent,
  type PrintDocumentView,
  type PrintJobStatus,
  type PrintJobView,
} from "@/api/printing";

const tab = ref("printers");
const printerLoading = ref(false);
const jobLoading = ref(false);
const saving = ref(false);
const printers = ref<PrintDocumentView[]>([]);
const jobs = ref<PrintJobView[]>([]);
const jobStatus = ref("");
const summary = ref({ pending: 0, sent: 0, unknown: 0, dead: 0, closed: 0 });
const printerDialog = ref(false);
const contentDialog = ref(false);
const contentPrinterId = ref(0);

const emptyPrinter = () => ({
  id: 0, print_name: "", type: 1 as 1 | 2, print_type: 1 as 1 | 2, times: 1,
  yly_user_id: "", yly_app_id: "", yly_app_secret: "", yly_app_secret_configured: false, yly_sn: "",
  fey_user: "", fey_ukey: "", fey_ukey_configured: false, fey_sn: "",
});
const emptyContent = (): PrintContent => ({ header: 1, delivery: 1, buyer_remarks: 1, goods: [0], freight: 1, preferential: 1, pay: [0, 1], custom: 0, order: [0, 1, 2, 3], code: 0, code_url: "", show_notice: 0, notice_content: "" });
const printerForm = reactive(emptyPrinter());
const content = reactive(emptyContent());

async function loadPrinters() {
  printerLoading.value = true;
  try { printers.value = (await apiPrintDocuments()).list; }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "打印机加载失败"); }
  finally { printerLoading.value = false; }
}
async function loadJobs() {
  jobLoading.value = true;
  try { const result = await apiPrintJobs({ status: jobStatus.value, limit: 100 }); jobs.value = result.list; summary.value = result.summary; }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "打印任务加载失败"); }
  finally { jobLoading.value = false; }
}
async function openPrinter(id: number) {
  try { Object.assign(printerForm, emptyPrinter(), await apiPrintDocument(id), { yly_app_secret: "", fey_ukey: "" }); printerDialog.value = true; }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "打印机配置加载失败"); }
}
async function savePrinter() {
  saving.value = true;
  try { await apiSavePrintDocument(printerForm.id, {
    print_name: printerForm.print_name,
    type: printerForm.type,
    print_type: printerForm.print_type,
    times: printerForm.times,
    yly_user_id: printerForm.yly_user_id,
    yly_app_id: printerForm.yly_app_id,
    yly_app_secret: printerForm.yly_app_secret,
    yly_sn: printerForm.yly_sn,
    fey_user: printerForm.fey_user,
    fey_ukey: printerForm.fey_ukey,
    fey_sn: printerForm.fey_sn,
  }); printerDialog.value = false; ElMessage.success("打印机配置已保存"); await loadPrinters(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "保存失败"); }
  finally { saving.value = false; }
}
async function changeStatus(row: PrintDocumentView, value: string | number | boolean) {
  const next = Number(value) as 0 | 1;
  try { await apiSetPrintDocumentStatus(row.id, next); await loadPrinters(); }
  catch (error) { row.status = next === 1 ? 0 : 1; ElMessage.error(error instanceof Error ? error.message : "状态修改失败"); }
}
async function removePrinter(row: PrintDocumentView) {
  try { await ElMessageBox.confirm(`确认删除“${row.print_name}”吗？`, "删除打印机", { type: "warning" }); await apiDeletePrintDocument(row.id); await loadPrinters(); }
  catch (error) { if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : "删除失败"); }
}
async function openContent(row: PrintDocumentView) {
  try { contentPrinterId.value = row.id; Object.assign(content, emptyContent(), await apiPrintContent(row.id)); contentDialog.value = true; }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "打印内容加载失败"); }
}
async function saveContent() {
  saving.value = true;
  try { await apiSavePrintContent(contentPrinterId.value, { ...content }); contentDialog.value = false; ElMessage.success("打印内容已保存"); await loadPrinters(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "保存失败"); }
  finally { saving.value = false; }
}
function triggerLabel(trigger: PrintJobView["trigger"]) { return trigger === "created" ? "下单后" : trigger === "paid" ? "支付后" : "手工"; }
function statusMeta(status: PrintJobStatus) {
  if (status === "SENT") return { label: "已发送", type: "success" as const };
  if (status === "UNKNOWN") return { label: "结果未知", type: "warning" as const };
  if (status === "DEAD") return { label: "已停止", type: "danger" as const };
  if (status === "CLOSED") return { label: "人工关闭", type: "info" as const };
  return { label: "处理中", type: "primary" as const };
}
async function operate(row: PrintJobView, action: "confirm-sent" | "confirm-retry" | "close") {
  if (action === "confirm-retry") {
    try { await ElMessageBox.confirm("提供商可能已经接单。请先核验，重打可能产生重复小票。", "重复打印风险", { type: "warning", confirmButtonText: "已核验，继续" }); }
    catch { return; }
  }
  try {
    const { value } = await ElMessageBox.prompt("请输入至少 8 个字符的核验依据或原因。", "审计原因", { inputPattern: /^.{8,500}$/s, inputErrorMessage: "请输入 8 到 500 个字符" });
    await apiOperatePrintJob(row.id, action, value); ElMessage.success("打印任务已更新"); await loadJobs();
  } catch (error) { if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : "操作失败"); }
}

onMounted(() => { void Promise.all([loadPrinters(), loadJobs()]); });
</script>

<style scoped>
.page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.page-header h2 { margin: 0; }.page-header p { margin: 6px 0 0; color: #909399; }
.rollout-alert { margin-bottom: 16px; }.job-filter { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }.job-filter span { margin-left: auto; color: #606266; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }.switch-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 18px; }
.mobile-print-list { display: none; }
@media (max-width: 680px) {
  .form-grid, .switch-grid { grid-template-columns: 1fr; }.job-filter { flex-wrap: wrap; }.job-filter span { width: 100%; margin-left: 0; }
  .desktop-print-table { display: none; }.mobile-print-list { display: block; }
  .mobile-print-card { padding: 14px 0; border-bottom: 1px solid #ebeef5; }.mobile-print-card:last-child { border-bottom: 0; }
  .mobile-print-card header, .mobile-print-card footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; }.mobile-print-card header > div { min-width: 0; }
  .mobile-print-card strong, .mobile-print-card span { display: block; }.mobile-print-card strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.mobile-print-card header span, .mobile-print-card p { color: #909399; font-size: 12px; }.mobile-print-card header span { margin-top: 4px; }.mobile-print-card p { margin: 12px 0; overflow-wrap: anywhere; }.mobile-print-card footer { justify-content: flex-start; flex-wrap: wrap; }.mobile-print-card footer .el-switch { margin-left: auto; }
}
</style>
