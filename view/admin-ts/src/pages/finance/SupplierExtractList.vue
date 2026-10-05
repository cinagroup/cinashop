<template>
  <div v-if="canView" class="supplier-extract-page">
    <div class="summary-grid">
      <el-card shadow="never"><span>待转账金额</span><strong>¥{{ statistics.pending_transfer }}</strong></el-card>
      <el-card shadow="never"><span>待审核金额</span><strong>¥{{ statistics.pending_review }}</strong></el-card>
      <el-card shadow="never"><span>可提现金额</span><strong>¥{{ statistics.withdrawable }}</strong></el-card>
      <el-card shadow="never"><span>累计提现金额</span><strong class="success">¥{{ statistics.paid }}</strong></el-card>
    </div>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <div><strong>供应商提现</strong><p>申请时间按 Asia/Shanghai 查询；审核和实际转账分别登记</p></div>
        </div>
      </template>

      <div class="filters">
        <label>供应商
          <el-select v-model="supplierId" clearable filterable placeholder="全部供应商" @change="load(1)">
            <el-option v-for="supplier in suppliers" :key="supplier.id" :value="supplier.id" :label="supplier.supplierName" />
          </el-select>
        </label>
        <label>申请时间（上海时间）
          <el-date-picker v-model="dateRange" type="datetimerange" clearable
            format="YYYY/MM/DD HH:mm:ss" value-format="YYYY/MM/DD HH:mm:ss"
            start-placeholder="开始时间" end-placeholder="结束时间" @change="load(1)" />
        </label>
        <label>审核状态
          <el-select v-model="statusFilter" placeholder="全部" @change="load(1)">
            <el-option label="全部" value="" />
            <el-option label="待审核" :value="0" />
            <el-option label="已通过" :value="1" />
            <el-option label="未通过" :value="-1" />
          </el-select>
        </label>
        <label>转账状态
          <el-select v-model="payStatusFilter" placeholder="全部" @change="load(1)">
            <el-option label="全部" value="" />
            <el-option label="未转账" :value="0" />
            <el-option label="已转账" :value="1" />
          </el-select>
        </label>
        <label>收款方式
          <el-select v-model="extractType" clearable placeholder="全部" @change="load(1)">
            <el-option label="银行卡" value="bank" />
            <el-option label="支付宝" value="alipay" />
            <el-option label="微信" value="weixin" />
          </el-select>
        </label>
        <label>关键词
          <el-input v-model="keyword" clearable placeholder="申请编号、供应商、联系人或手机号" @keyup.enter="load(1)" />
        </label>
        <el-button type="primary" :loading="loading" @click="load(1)">查询</el-button>
      </div>
      <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="list-error" />

      <el-table :data="list" v-loading="loading" stripe row-key="id">
        <el-table-column prop="id" label="申请编号" width="100" />
        <el-table-column label="供应商" min-width="190">
          <template #default="{ row }"><strong>{{ supplierDisplay(row) }}</strong><div class="sub-text">{{ row.contactName || "-" }} · {{ row.phone || "-" }}</div></template>
        </el-table-column>
        <el-table-column label="收款信息" min-width="230">
          <template #default="{ row }"><div>{{ typeText(row.extractType) }}</div><div class="sub-text recipient">{{ recipientText(row) }}</div><el-link v-if="row.qrcodeUrl" :href="row.qrcodeUrl" target="_blank" type="primary">查看收款码</el-link></template>
        </el-table-column>
        <el-table-column label="提现金额" width="130"><template #default="{ row }"><span class="price">¥{{ row.extractPrice }}</span></template></el-table-column>
        <el-table-column label="审核状态" width="110"><template #default="{ row }"><el-tag :type="statusInfo(row).tone">{{ statusInfo(row).label }}</el-tag></template></el-table-column>
        <el-table-column label="转账状态" width="110"><template #default="{ row }"><el-tag :type="row.payStatus === 1 ? 'success' : 'info'">{{ row.payStatus === 1 ? "已转账" : "未转账" }}</el-tag></template></el-table-column>
        <el-table-column label="共享备注" min-width="170"><template #default="{ row }">{{ row.supplierMark || "-" }}</template></el-table-column>
        <el-table-column label="处理信息" min-width="180"><template #default="{ row }"><div>{{ row.adminName || "-" }}</div><div v-if="row.failMsg" class="sub-text danger">{{ row.failMsg }}</div><div v-else-if="row.voucherTitle" class="sub-text">{{ row.voucherTitle }}</div></template></el-table-column>
        <el-table-column label="申请时间" width="170"><template #default="{ row }">{{ formatTime(row.addTime) }}</template></el-table-column>
        <el-table-column label="操作" width="255" fixed="right">
          <template #default="{ row }">
            <template v-if="canManage && row.status === 0">
              <el-button type="success" size="small" :disabled="submitting" @click="approve(row)">通过</el-button>
              <el-button type="danger" size="small" plain :disabled="submitting" @click="openReject(row)">拒绝</el-button>
            </template>
            <el-button v-if="canManage && row.status === 1 && row.payStatus === 0" type="primary" size="small" :disabled="submitting" @click="openTransfer(row)">登记转账</el-button>
            <el-button v-if="canManage" size="small" :disabled="submitting" @click="openRemark(row)">编辑共享备注</el-button>
            <el-link v-if="row.payStatus === 1 && row.voucherImage" :href="row.voucherImage" target="_blank" type="primary">查看凭证</el-link>
            <span v-if="!canManage && !(row.payStatus === 1 && row.voucherImage)" class="sub-text">只读</span>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination class="pager" layout="total, prev, pager, next" :total="total" :page-size="15" :current-page="page" @current-change="load" />
    </el-card>

    <el-dialog v-model="rejectVisible" title="拒绝供应商提现" width="440px" :close-on-click-modal="false">
      <p class="dialog-note">拒绝后该金额会从预占提现中释放，重新计入供应商可提现余额。</p>
      <el-input v-model="rejectReason" type="textarea" :rows="4" maxlength="128" show-word-limit placeholder="请填写供应商可见的拒绝原因" />
      <template #footer><el-button :disabled="submitting" @click="rejectVisible = false">取消</el-button><el-button v-if="canManage" type="danger" :loading="submitting" @click="confirmReject">确认拒绝</el-button></template>
    </el-dialog>

    <el-dialog v-model="transferVisible" title="登记实际转账" width="480px" :close-on-click-modal="false">
      <p class="dialog-note">请在银行或支付平台完成转账后再登记。凭证图片可留空；系统不会自动发起资金划转。</p>
      <el-form label-position="top">
        <el-form-item label="转账说明"><el-input v-model="transferForm.voucher_title" maxlength="30" placeholder="例如：招商银行转账回单 20260928" /></el-form-item>
        <el-form-item label="凭证地址（选填）"><el-input v-model="transferForm.voucher_image" maxlength="256" placeholder="https://..." /></el-form-item>
      </el-form>
      <template #footer><el-button :disabled="submitting" @click="transferVisible = false">取消</el-button><el-button v-if="canManage" type="primary" :loading="submitting" @click="confirmTransfer">确认已转账</el-button></template>
    </el-dialog>

    <el-dialog v-model="remarkVisible" title="编辑共享备注" width="440px" :close-on-click-modal="false">
      <p class="dialog-note">记录 #{{ currentRow?.id }} 的备注与供应商端共享。供应商也可修改；发生冲突后须重读并重新填写。</p>
      <el-input v-model="remarkDraft" type="textarea" :rows="4" maxlength="200" show-word-limit aria-label="供应商提现备注" placeholder="请填写备注" />
      <template #footer><el-button :disabled="submitting" @click="remarkVisible = false">取消</el-button><el-button v-if="canManage" type="primary" :loading="submitting" @click="saveRemark">保存备注</el-button></template>
    </el-dialog>
  </div>
  <el-empty v-else description="无供应商提现查看权限" />
</template>

<script setup lang="ts">
import { isAxiosError } from "axios";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import { AdminResponseError } from "@/utils/request";
import {
  apiAdminSupplierExtractList, apiAdminSupplierExtractMark, apiAdminSupplierExtractReview,
  apiAdminSupplierExtractSuppliers, apiAdminSupplierExtractTransfer, supplierExtractTimeRange,
  type SupplierExtractItem, type SupplierExtractQuery, type SupplierExtractStatistics,
  type SupplierExtractSupplier,
} from "@/api/finance";

const auth = useAuthStore();
const stored = ref(localStorage.getItem("admin_session"));
const sessionVersion = ref(0);
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ""}:${auth.uniqueAuth.join(",")}`);
const validSession = computed(() => {
  void sessionVersion.value;
  const session = getAdminSession();
  return !!auth.token && auth.token === getToken() && !!auth.userInfo && !!session &&
    stored.value === localStorage.getItem("admin_session") &&
    session.userInfo.id === auth.userInfo.id && session.userInfo.level === auth.userInfo.level;
});
const canView = computed(() => {
  if (!validSession.value) return false;
  const session = getAdminSession()!;
  return auth.userInfo?.level === 0 || (auth.uniqueAuth.includes("supplier_extract.view") &&
    session.uniqueAuth.includes("supplier_extract.view"));
});
const canManage = computed(() => {
  if (!canView.value) return false;
  const session = getAdminSession()!;
  return auth.userInfo?.level === 0 || (auth.uniqueAuth.includes("supplier_extract.manage") &&
    session.uniqueAuth.includes("supplier_extract.manage"));
});

const zeroStatistics = (): SupplierExtractStatistics => ({ pending_review: "0.00", pending_transfer: "0.00",
  paid: "0.00", rejected: "0.00", withdrawable: "0.00" });
const suppliers = ref<SupplierExtractSupplier[]>([]);
const supplierId = ref<number | "">("");
const dateRange = ref<string[] | null>(null);
const statusFilter = ref<-1 | 0 | 1 | "">("");
const payStatusFilter = ref<0 | 1 | "">("");
const extractType = ref("");
const keyword = ref("");
const list = ref<SupplierExtractItem[]>([]);
const total = ref(0), page = ref(1), loading = ref(false), error = ref("");
const statistics = ref<SupplierExtractStatistics>(zeroStatistics());
const submitting = ref(false);
const rejectVisible = ref(false), rejectReason = ref("");
const transferVisible = ref(false), remarkVisible = ref(false);
const currentRow = ref<SupplierExtractItem | null>(null), remarkDraft = ref("");
const transferForm = reactive({ voucher_title: "", voucher_image: "" });

let alive = false, generation = 0, supplierVersion = 0, listVersion = 0, mutationVersion = 0, confirmationVersion = 0;
let supplierAbort: AbortController | null = null, listAbort: AbortController | null = null,
  mutationAbort: AbortController | null = null;
type Stamp = { identity: string; stored: string | null; generation: number };
function stamp(): Stamp { return { identity: identity.value, stored: stored.value, generation }; }
function current(value: Stamp): boolean {
  return alive && canView.value && identity.value === value.identity && generation === value.generation &&
    stored.value === value.stored && stored.value === localStorage.getItem("admin_session") && auth.token === getToken();
}
function message(value: unknown): string { return value instanceof Error ? value.message : "供应商提现操作失败"; }
function isConflict(value: unknown): boolean {
  return (value instanceof AdminResponseError && Number(value.status) === 409) ||
    (isAxiosError(value) && value.response?.status === 409);
}
function closeDialogs(): void {
  rejectVisible.value = false; transferVisible.value = false; remarkVisible.value = false;
  currentRow.value = null; rejectReason.value = ""; remarkDraft.value = "";
  transferForm.voucher_title = ""; transferForm.voucher_image = "";
}
function invalidateList(): void {
  listVersion++; listAbort?.abort(); listAbort = null;
  list.value = []; total.value = 0; page.value = 1; statistics.value = zeroStatistics();
  loading.value = false; error.value = "";
  if (!submitting.value) closeDialogs();
}
function resetSession(): void {
  generation++; supplierVersion++; supplierAbort?.abort(); supplierAbort = null;
  mutationVersion++; confirmationVersion++; mutationAbort?.abort(); mutationAbort = null;
  submitting.value = false; closeDialogs(); suppliers.value = [];
  invalidateList();
}
function query(targetPage: number): SupplierExtractQuery {
  const time = supplierExtractTimeRange(dateRange.value);
  return { supplier_id: supplierId.value, ...time,
    ...(statusFilter.value === "" ? {} : { status: statusFilter.value }),
    ...(payStatusFilter.value === "" ? {} : { pay_status: payStatusFilter.value }),
    extract_type: extractType.value, keyword: keyword.value.trim(), page: targetPage, limit: 15 };
}
async function loadSuppliers(): Promise<void> {
  if (!canView.value) return;
  supplierAbort?.abort(); const value = stamp(), version = ++supplierVersion;
  const controller = new AbortController(); supplierAbort = controller;
  try {
    const result = await apiAdminSupplierExtractSuppliers(controller.signal);
    if (current(value) && supplierVersion === version && supplierAbort === controller) suppliers.value = result.list;
  } catch (failure) {
    if (current(value) && supplierVersion === version && !controller.signal.aborted) ElMessage.error(message(failure));
  } finally { if (supplierAbort === controller) supplierAbort = null; }
}
async function load(targetPage = 1): Promise<boolean> {
  if (!canView.value) return false;
  invalidateList();
  let params: SupplierExtractQuery;
  try { params = query(targetPage); }
  catch (failure) { error.value = message(failure); return false; }
  const value = stamp(), version = ++listVersion, controller = new AbortController();
  listAbort = controller; loading.value = true;
  try {
    const result = await apiAdminSupplierExtractList(params, controller.signal);
    if (!current(value) || listVersion !== version || listAbort !== controller) return false;
    list.value = result.list; total.value = result.count; page.value = targetPage;
    statistics.value = result.extract_statistics; return true;
  } catch (failure) {
    if (current(value) && listVersion === version && !controller.signal.aborted) error.value = message(failure);
    return false;
  } finally { if (listAbort === controller) { listAbort = null; loading.value = false; } }
}
function listed(row: SupplierExtractItem): boolean { return list.value.some((item) => item.id === row.id); }
function supplierDisplay(row: SupplierExtractItem): string {
  return row.supplierName?.trim() || `供应商 #${row.supplierId}`;
}
function typeText(type: string): string {
  return type === "bank" ? "银行卡" : type === "alipay" ? "支付宝" : type === "weixin" ? "微信" : type;
}
function recipientText(row: SupplierExtractItem): string {
  if (row.extractType === "bank") return `${row.bankAddress} · ${row.bankCode}`;
  if (row.extractType === "alipay") return row.alipayAccount;
  return row.wechat;
}
function statusInfo(row: SupplierExtractItem): { label: string; tone: "success" | "warning" | "danger" } {
  if (row.status === -1) return { label: "未通过", tone: "danger" };
  if (row.status === 0) return { label: "待审核", tone: "warning" };
  return { label: "已通过", tone: "success" };
}
const shanghaiFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric",
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function formatTime(timestamp: number): string {
  if (!timestamp) return "-";
  const parts = Object.fromEntries(shanghaiFormat.formatToParts(new Date(timestamp * 1000)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
async function commit(action: (signal: AbortSignal) => Promise<unknown>, success: string,
  conflictRefresh = false): Promise<void> {
  if (!canManage.value || submitting.value) return;
  const value = stamp(), version = ++mutationVersion, controller = new AbortController();
  mutationAbort = controller; submitting.value = true;
  try {
    await action(controller.signal);
    if (!current(value) || !canManage.value || mutationVersion !== version || mutationAbort !== controller) return;
    closeDialogs(); const targetPage = page.value;
    if (await load(targetPage)) {
      if (current(value)) ElMessage.success(success);
    } else if (current(value)) ElMessage.warning("操作已提交，列表刷新失败，请手动刷新核对");
  } catch (failure) {
    if (current(value) && mutationVersion === version && !controller.signal.aborted) {
      if (conflictRefresh && isConflict(failure)) {
        const targetPage = page.value; submitting.value = false; closeDialogs();
        await load(targetPage);
        if (current(value)) ElMessage.warning("备注已被其他操作更新，请核对最新内容后重新填写");
      } else ElMessage.error(`${message(failure)}；请刷新列表核对后再重试`);
    }
  } finally { if (mutationAbort === controller) { mutationAbort = null; submitting.value = false; } }
}
async function approve(row: SupplierExtractItem): Promise<void> {
  if (!canManage.value || !listed(row) || row.status !== 0 || submitting.value) return;
  const value = stamp(), version = ++confirmationVersion;
  try {
    await ElMessageBox.confirm(`确认通过「${supplierDisplay(row)}」的 ¥${row.extractPrice} 提现申请？通过后仍需单独登记实际转账。`,
      "审核供应商提现", { type: "warning", confirmButtonText: "审核通过", cancelButtonText: "取消" });
  } catch { return; }
  if (!current(value) || !canManage.value || version !== confirmationVersion || !listed(row)) return;
  await commit((signal) => apiAdminSupplierExtractReview(row.id, { type: 1 }, signal), "审核已通过，等待实际转账");
}
function openReject(row: SupplierExtractItem): void {
  if (!canManage.value || !listed(row) || row.status !== 0 || submitting.value) return;
  currentRow.value = row; rejectReason.value = ""; rejectVisible.value = true;
}
async function confirmReject(): Promise<void> {
  const row = currentRow.value;
  if (!canManage.value || !rejectVisible.value || !row || !listed(row) || row.status !== 0) return;
  if (!rejectReason.value.trim()) { ElMessage.warning("请填写拒绝原因"); return; }
  await commit((signal) => apiAdminSupplierExtractReview(row.id,
    { type: 0, message: rejectReason.value.trim() }, signal), "已拒绝，预占余额已释放");
}
function openTransfer(row: SupplierExtractItem): void {
  if (!canManage.value || !listed(row) || row.status !== 1 || row.payStatus !== 0 || submitting.value) return;
  currentRow.value = row; transferForm.voucher_title = ""; transferForm.voucher_image = "";
  transferVisible.value = true;
}
async function confirmTransfer(): Promise<void> {
  const row = currentRow.value;
  if (!canManage.value || !transferVisible.value || !row || !listed(row) || row.status !== 1 || row.payStatus !== 0) return;
  if (!transferForm.voucher_title.trim() || transferForm.voucher_title.trim().length > 30) {
    ElMessage.warning("转账说明须填写且不能超过 30 字"); return;
  }
  const body = { voucher_title: transferForm.voucher_title.trim(), voucher_image: transferForm.voucher_image.trim() };
  await commit((signal) => apiAdminSupplierExtractTransfer(row.id, body, signal), "实际转账已登记");
}
function openRemark(row: SupplierExtractItem): void {
  if (!canManage.value || !listed(row) || submitting.value) return;
  currentRow.value = row; remarkDraft.value = row.supplierMark ?? ""; remarkVisible.value = true;
}
async function saveRemark(): Promise<void> {
  const row = currentRow.value;
  if (!canManage.value || !remarkVisible.value || !row || !listed(row)) return;
  if (!remarkDraft.value.trim() || [...remarkDraft.value].length > 200) {
    ElMessage.warning("备注须填写且不能超过 200 字"); return;
  }
  await commit(async (signal) => {
    const result = await apiAdminSupplierExtractMark(row.id, remarkDraft.value, row.supplierMark, signal);
    if (result.id !== row.id || typeof result.supplierMark !== "string") throw new Error("备注保存结果与当前记录不一致");
  }, "备注已保存", true);
}
function syncSession(): void {
  stored.value = localStorage.getItem("admin_session"); sessionVersion.value++;
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
}
function syncStorage(event: StorageEvent): void {
  if (event.key === null || event.key === "admin_token" || event.key === "admin_session") syncSession();
}
watch([identity, canView, canManage, stored], () => {
  resetSession(); if (alive && canView.value) { void loadSuppliers(); void load(1); }
}, { flush: "sync" });
watch([supplierId, dateRange, statusFilter, payStatusFilter, extractType, keyword], () => {
  if (alive) invalidateList();
}, { deep: true, flush: "sync" });
onMounted(() => {
  alive = true;
  window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession);
  window.addEventListener("storage", syncStorage);
  const before = `${identity.value}:${stored.value}:${canView.value}:${canManage.value}`;
  syncSession();
  if (before === `${identity.value}:${stored.value}:${canView.value}:${canManage.value}` && canView.value) {
    void loadSuppliers(); void load(1);
  }
});
onBeforeUnmount(() => {
  alive = false; resetSession();
  window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession);
  window.removeEventListener("storage", syncStorage);
});
</script>

<style scoped>
.supplier-extract-page { display: grid; gap: 16px; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.summary-grid span { color: #7a8495; font-size: 13px; }
.summary-grid strong { display: block; margin-top: 12px; color: #172b4d; font-size: 24px; font-variant-numeric: tabular-nums; }
.summary-grid strong.success { color: #13a468; }
.card-header p { margin: 6px 0 0; color: #8a94a5; font-size: 12px; font-weight: 400; }
.filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin-bottom: 16px; }
.filters label { display: grid; gap: 5px; color: #667085; font-size: 12px; }
.filters .el-select { width: 150px; }
.filters .el-input { width: 250px; }
.filters .el-date-editor { width: 375px; }
.list-error { margin-bottom: 12px; }
.price { color: #e93323; font-size: 15px; font-weight: 650; }
.sub-text { margin-top: 5px; color: #8a94a5; font-size: 12px; }
.danger { color: #e93323; }
.recipient { overflow-wrap: anywhere; }
.pager { margin-top: 18px; justify-content: flex-end; }
.dialog-note { margin: 0 0 16px; padding: 10px 12px; border-left: 3px solid #e6a23c; color: #765c2f; background: #fff8e8; font-size: 12px; line-height: 1.6; }
@media (max-width: 1100px) { .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) { .summary-grid { grid-template-columns: 1fr; } .filters .el-date-editor { width: 100%; } }
</style>
