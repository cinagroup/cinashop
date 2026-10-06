<template>
  <div class="supplier-capital-flow">
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <div><strong>供应商资金流水</strong><p>按供应商和创建时间核对交易记录及平台备注。</p></div>
          <el-button v-if="canView" :loading="loading" @click="load(page)">刷新</el-button>
        </div>
      </template>
      <el-alert v-if="!canView" title="当前账号没有供应商资金流水查看权限" type="warning" :closable="false" show-icon />
      <template v-else>
        <div class="filters">
          <label class="filter-field">
            <span>选择供应商</span>
            <el-select v-model="supplierId" aria-label="选择供应商" clearable filterable placeholder="全部供应商" :disabled="saving">
              <el-option v-for="supplier in suppliers" :key="supplier.id"
                :label="supplier.supplier_name" :value="supplier.id" />
            </el-select>
          </label>
          <label class="filter-field date-field">
            <span>创建时间（北京时间）</span>
            <el-date-picker v-model="timeRange" type="datetimerange" aria-label="创建时间范围"
              format="YYYY/MM/DD HH:mm:ss" value-format="YYYY/MM/DD HH:mm:ss"
              start-placeholder="开始时间" end-placeholder="结束时间" range-separator="至"
              clearable :disabled="saving" />
          </label>
          <label class="filter-field keyword-field">
            <span>订单搜索</span>
            <el-input v-model="keyword" aria-label="交易单号或交易人" maxlength="80" clearable
              placeholder="交易单号或交易人" :disabled="saving" @keyup.enter="load(1)" />
          </label>
          <div class="filter-actions">
            <el-button type="primary" :loading="loading" :disabled="saving" @click="load(1)">查询</el-button>
            <el-button :disabled="loading || saving" @click="resetFilters">重置</el-button>
            <el-button :loading="exporting" :disabled="loading || saving || !appliedScope"
              @click="download">导出全部筛选结果</el-button>
          </div>
        </div>
        <p class="time-note">日期按记录创建时间筛选；结束点为午夜或起止相同时，沿用旧系统的次日边界。</p>
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="notice" />
        <div class="table-scroll">
          <el-table :data="list" v-loading="loading" row-key="id" stripe empty-text="暂无供应商流水">
            <el-table-column prop="order_id" label="交易单号" min-width="165" />
            <el-table-column prop="link_id" label="关联订单" min-width="165" />
            <el-table-column prop="trade_time" label="交易时间" min-width="165" />
            <el-table-column label="交易金额" min-width="115">
              <template #default="{ row }"><span :class="row.pm === 1 ? 'income' : 'expense'">{{ row.pm === 1 ? '+' : '-' }} ¥{{ row.number }}</span></template>
            </el-table-column>
            <el-table-column prop="user_nickname" label="交易人" min-width="110" show-overflow-tooltip />
            <el-table-column prop="supplier_name" label="供应商" min-width="130" show-overflow-tooltip />
            <el-table-column prop="type_name" label="交易类型" min-width="115" />
            <el-table-column prop="pay_type_name" label="支付方式" min-width="110" />
            <el-table-column prop="remark" label="平台备注" min-width="170" show-overflow-tooltip />
            <el-table-column label="操作" fixed="right" min-width="88">
              <template #default="{ row }">
                <el-button v-if="canManage && row.remark_editable" link type="primary" @click="openRemark(row)">备注</el-button>
                <span v-else class="readonly">{{ row.remark_editable ? '仅查看' : '系统记录' }}</span>
              </template>
            </el-table-column>
          </el-table>
        </div>
        <el-pagination class="pager" layout="total, prev, pager, next" :total="total"
          :page-size="20" :current-page="page" @current-change="load" />
      </template>
    </el-card>

    <el-dialog v-model="remarkVisible" title="修改平台备注" width="min(440px, calc(100vw - 32px))"
      :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving"
      @closed="closeRemark">
      <template v-if="editingRow && canManage">
        <p class="dialog-context">交易单号：{{ editingRow.order_id }}</p>
        <el-input v-model="remarkDraft" type="textarea" :rows="4" maxlength="200"
          show-word-limit aria-label="供应商流水平台备注" placeholder="请输入备注（最多 200 字）" />
      </template>
      <template #footer>
        <el-button :disabled="saving" @click="remarkVisible = false">取消</el-button>
        <el-button v-if="canManage" type="primary" :loading="saving" @click="saveRemark">保存备注</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { isAxiosError } from "axios";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import { AdminResponseError } from "@/utils/request";
import {
  apiSupplierCapitalExport, apiSupplierCapitalList, apiSupplierCapitalRemark, apiSupplierCapitalSuppliers,
  supplierCapitalCsv, supplierCapitalDataRange, type SupplierCapitalRow, type SupplierCapitalScope,
  type SupplierCapitalSupplier,
} from "@/api/supplierCapital";

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
  return auth.userInfo?.level === 0 || (auth.uniqueAuth.includes("supplier_capital.view") &&
    session.uniqueAuth.includes("supplier_capital.view"));
});
const canManage = computed(() => {
  if (!canView.value) return false;
  const session = getAdminSession()!;
  return auth.userInfo?.level === 0 || (auth.uniqueAuth.includes("supplier_capital.manage") &&
    session.uniqueAuth.includes("supplier_capital.manage"));
});

const suppliers = ref<SupplierCapitalSupplier[]>([]);
const supplierId = ref<number | "">("");
const timeRange = ref<string[] | null>(null);
const keyword = ref("");
const list = ref<SupplierCapitalRow[]>([]), total = ref(0), page = ref(1);
const loading = ref(false), error = ref("");
const exporting = ref(false);
const remarkVisible = ref(false), editingRow = ref<SupplierCapitalRow | null>(null);
const remarkDraft = ref(""), saving = ref(false);
const appliedScope = ref<SupplierCapitalScope | null>(null);
let alive = false, sessionGeneration = 0, supplierVersion = 0, listVersion = 0, exportVersion = 0, saveVersion = 0;
let supplierAbort: AbortController | null = null, listAbort: AbortController | null = null,
  exportAbort: AbortController | null = null, saveAbort: AbortController | null = null;
type ScopeStamp = { identity: string; stored: string | null; generation: number };
function stamp(): ScopeStamp { return { identity: identity.value, stored: stored.value, generation: sessionGeneration }; }
function current(value: ScopeStamp): boolean {
  return alive && canView.value && identity.value === value.identity && stored.value === value.stored &&
    stored.value === localStorage.getItem("admin_session") && sessionGeneration === value.generation;
}
function message(value: unknown): string { return value instanceof Error ? value.message : "供应商流水操作失败"; }
function isConflict(value: unknown): boolean {
  return (value instanceof AdminResponseError && Number(value.status) === 409) ||
    (isAxiosError(value) && value.response?.status === 409);
}
function closeRemark(): void {
  if (saving.value && remarkVisible.value) return;
  editingRow.value = null; remarkDraft.value = "";
}
function invalidateList(): void {
  listVersion++; listAbort?.abort(); listAbort = null;
  exportVersion++; exportAbort?.abort(); exportAbort = null;
  exporting.value = false; loading.value = false; error.value = "";
  list.value = []; total.value = 0; page.value = 1; appliedScope.value = null;
  if (!saving.value) { remarkVisible.value = false; closeRemark(); }
}
function resetSession(): void {
  sessionGeneration++; supplierVersion++; supplierAbort?.abort(); supplierAbort = null;
  saveVersion++; saveAbort?.abort(); saveAbort = null; saving.value = false;
  remarkVisible.value = false; closeRemark(); suppliers.value = [];
  invalidateList();
}
function requestedScope(): SupplierCapitalScope {
  return { supplier_id: supplierId.value || "", data: supplierCapitalDataRange(timeRange.value),
    keyword: keyword.value.trim() };
}
async function loadSuppliers(): Promise<void> {
  if (!canView.value) return;
  supplierAbort?.abort(); const value = stamp(), version = ++supplierVersion;
  const controller = new AbortController(); supplierAbort = controller;
  try {
    const result = await apiSupplierCapitalSuppliers(controller.signal);
    if (current(value) && supplierVersion === version && supplierAbort === controller) suppliers.value = result;
  } catch (failure) {
    if (current(value) && supplierVersion === version && !controller.signal.aborted) ElMessage.error(message(failure));
  } finally { if (supplierAbort === controller) supplierAbort = null; }
}
async function load(targetPage = 1): Promise<boolean> {
  if (!canView.value) return false;
  invalidateList();
  let scope: SupplierCapitalScope;
  try { scope = requestedScope(); }
  catch (failure) { error.value = message(failure); return false; }
  const value = stamp(), version = ++listVersion, controller = new AbortController();
  listAbort = controller; loading.value = true;
  try {
    const result = await apiSupplierCapitalList({ ...scope, page: targetPage, limit: 20 }, controller.signal);
    if (!current(value) || listVersion !== version || listAbort !== controller) return false;
    list.value = result.list; total.value = result.count; page.value = targetPage; appliedScope.value = scope;
    return true;
  } catch (failure) {
    if (current(value) && listVersion === version && !controller.signal.aborted) error.value = message(failure);
    return false;
  } finally { if (listAbort === controller) { listAbort = null; loading.value = false; } }
}
function resetFilters(): void {
  supplierId.value = ""; timeRange.value = null; keyword.value = ""; void load(1);
}
async function download(): Promise<void> {
  const scope = appliedScope.value;
  if (!canView.value || !scope || exporting.value) return;
  exportAbort?.abort(); const value = stamp(), version = ++exportVersion;
  const controller = new AbortController(); exportAbort = controller; exporting.value = true;
  try {
    const result = await apiSupplierCapitalExport(scope, controller.signal);
    if (!current(value) || exportVersion !== version || exportAbort !== controller || appliedScope.value !== scope) return;
    const csv = supplierCapitalCsv(result);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = `${result.filename.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_").slice(0, 100) || "供应商资金流水"}.csv`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (failure) {
    if (current(value) && exportVersion === version && !controller.signal.aborted) ElMessage.error(message(failure));
  } finally { if (exportAbort === controller) { exportAbort = null; exporting.value = false; } }
}
function openRemark(row: SupplierCapitalRow): void {
  if (!canManage.value || !row.remark_editable || !appliedScope.value ||
    !list.value.some(item => item.id === row.id && item.remark_editable)) return;
  editingRow.value = row; remarkDraft.value = row.remark; remarkVisible.value = true;
}
async function saveRemark(): Promise<void> {
  const row = editingRow.value;
  if (!row || !row.remark_editable || !canManage.value || !remarkVisible.value || saving.value) return;
  if (!remarkDraft.value.trim() || [...remarkDraft.value].length > 200) {
    ElMessage.error("备注须填写且不能超过 200 字"); return;
  }
  const value = stamp(), version = ++saveVersion, controller = new AbortController();
  saveAbort = controller; saving.value = true;
  try {
    const committed = await apiSupplierCapitalRemark(row.id, remarkDraft.value, row.remark, controller.signal);
    if (!current(value) || !canManage.value || saveVersion !== version || saveAbort !== controller) return;
    if (committed.id !== row.id || typeof committed.remark !== "string") {
      throw new Error("备注保存结果与当前流水不一致");
    }
    const visible = list.value.find(item => item.id === row.id);
    if (visible) visible.remark = committed.remark;
    remarkVisible.value = false; closeRemark();
    const targetPage = page.value;
    if (await load(targetPage)) ElMessage.success("平台备注已保存");
    else ElMessage.warning("备注已提交，列表刷新失败，请手动刷新核对");
  } catch (failure) {
    if (current(value) && saveVersion === version && !controller.signal.aborted) {
      if (isConflict(failure)) {
        const targetPage = page.value;
        saving.value = false; remarkVisible.value = false; closeRemark();
        await load(targetPage);
        ElMessage.warning("平台备注已被其他操作更新，请核对最新内容后重新填写");
      } else {
        ElMessage.error(`${message(failure)}；请刷新列表核对后再重试`);
      }
    }
  } finally { if (saveAbort === controller) { saveAbort = null; saving.value = false; } }
}
function syncSession(): void {
  stored.value = localStorage.getItem("admin_session"); sessionVersion.value++;
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
}
watch([identity, canView, canManage, stored], () => {
  resetSession(); if (canView.value) { void loadSuppliers(); void load(1); }
});
watch([supplierId, timeRange, keyword], () => { if (alive) invalidateList(); }, { deep: true, flush: "sync" });
onMounted(() => {
  alive = true;
  window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession);
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
});
</script>

<style scoped>
.supplier-capital-flow { min-width: 0; }
.card-header { display: flex; justify-content: space-between; align-items: start; gap: 12px; }
.card-header p, .time-note, .readonly, .dialog-context { margin: 5px 0 0; color: #7a8391; font-size: 12px; }
.filters { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin: 12px 0; }
.filter-field { display: flex; flex: 1 1 170px; flex-direction: column; gap: 6px; min-width: 0; font-size: 13px; }
.date-field { flex: 2 1 340px; }.keyword-field { flex: 2 1 230px; }
.filter-field :deep(.el-select), .filter-field :deep(.el-date-editor), .filter-field :deep(.el-input) { width: 100%; }
.filter-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.notice { margin-top: 12px; }.table-scroll { max-width: 100%; overflow-x: auto; }
.income { color: #dc4c3f; font-weight: 600; }.expense { color: #238e68; font-weight: 600; }
.pager { display: flex; justify-content: flex-end; margin-top: 16px; flex-wrap: wrap; }
.dialog-context { margin-bottom: 12px; overflow-wrap: anywhere; }
@media (max-width: 640px) { .filters { display: grid; grid-template-columns: minmax(0, 1fr); }.pager { justify-content: center; } }
</style>
