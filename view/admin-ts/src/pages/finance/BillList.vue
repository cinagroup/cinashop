<template>
  <div class="money-ledger">
    <el-card shadow="never">
      <template #header>
        <div class="heading">
          <div><strong>资金流水</strong><p class="hint">查看用户余额变动；时间按北京时间筛选。</p></div>
          <div class="heading-actions">
            <el-button v-if="canExport" type="primary" :loading="exporting" :disabled="loading || exporting" @click="exportCsv">导出当前筛选结果（CSV）</el-button>
            <el-button v-if="exporting" @click="cancelExport(true)">取消导出</el-button>
            <el-button v-if="canView" :loading="loading || typesLoading" @click="refresh">刷新</el-button>
          </div>
        </div>
      </template>
      <el-alert v-if="!canView" title="当前账号没有资金流水查看权限" type="warning" :closable="false" show-icon />
      <template v-else>
        <div class="filters">
          <label class="field"><span>昵称 / 用户 ID</span>
            <el-input v-model="draftKeyword" aria-label="昵称或用户 ID" clearable maxlength="100" placeholder="请输入昵称或用户 ID" @keyup.enter="search" />
          </label>
          <label class="field type-field"><span>流水类型</span>
            <el-select v-model="draftType" aria-label="流水类型" clearable filterable placeholder="全部类型" :loading="typesLoading">
              <el-option v-for="item in types" :key="item.type" :label="item.title" :value="item.type" />
            </el-select>
          </label>
          <label class="field time-field"><span>创建时间（北京时间）</span>
            <el-date-picker v-model="draftRange" aria-label="创建时间范围" type="datetimerange"
              format="YYYY/MM/DD HH:mm" value-format="YYYY-MM-DD HH:mm" start-placeholder="开始时间"
              end-placeholder="结束时间" range-separator="至" clearable />
          </label>
          <div class="filter-actions"><el-button type="primary" :loading="loading" @click="search">搜索</el-button>
            <el-button :disabled="loading" @click="reset">重置</el-button></div>
        </div>
        <el-alert v-if="typesError" :title="typesError" type="error" :closable="false" show-icon class="notice">
          <el-button link type="primary" @click="loadTypes">重试类型目录</el-button>
        </el-alert>
        <el-alert v-if="filterError" :title="filterError" type="error" :closable="false" show-icon class="notice" />
        <el-alert v-if="exportError" :title="exportError" type="error" :closable="false" show-icon class="notice" />
        <p v-if="exporting" class="progress" role="status">正在导出 {{ exportRead }} / {{ exportTotal }} 条，文件完成后下载。</p>
        <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon class="notice">
          <el-button link type="primary" @click="load(page)">重试列表</el-button>
        </el-alert>
        <div class="table-scroll"><el-table :data="list" v-loading="loading" row-key="id" stripe empty-text="暂无资金流水">
          <el-table-column prop="uid" label="用户 ID" width="110" />
          <el-table-column label="昵称" min-width="150"><template #default="{ row }">{{ row.nickname || `用户 #${row.uid}` }}</template></el-table-column>
          <el-table-column label="金额" min-width="120"><template #default="{ row }">
            <span :class="row.pm === 1 ? 'income' : 'expense'">{{ row.pm === 0 ? '-' : '' }}{{ row.number }}</span>
          </template></el-table-column>
          <el-table-column prop="title" label="类型" min-width="150" />
          <el-table-column prop="mark" label="备注" min-width="190" show-overflow-tooltip />
          <el-table-column label="创建时间" min-width="175"><template #default="{ row }">{{ row.add_time || '—' }}</template></el-table-column>
        </el-table></div>
        <el-pagination class="pager" :current-page="page" :page-size="USER_MONEY_PAGE_SIZE" :total="count"
          :disabled="loading" layout="total, prev, pager, next" @current-change="load" />
      </template>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import { capitalFlowRange } from "./capitalFlowRange";
import { apiUserMoneyLedger, apiUserMoneyLedgerTypes, collectUserMoneyExport, downloadUserMoneyCsv,
  normalizeUserMoneyFilters, USER_MONEY_PAGE_SIZE, type UserMoneyLedgerFilters,
  type UserMoneyLedgerRow, type UserMoneyLedgerType } from "@/api/userMoneyLedger";

const auth = useAuthStore();
const draftKeyword = ref(""), draftType = ref(""), draftRange = ref<string[] | null>(null);
const filters = ref<UserMoneyLedgerFilters>(normalizeUserMoneyFilters());
const types = ref<UserMoneyLedgerType[]>([]), typesLoading = ref(false), typesError = ref("");
const list = ref<UserMoneyLedgerRow[]>([]), count = ref(0), page = ref(1), loading = ref(false);
const listError = ref(""), filterError = ref("");
const exporting = ref(false), exportRead = ref(0), exportTotal = ref(0), exportError = ref("");
let alive = false, syncing = false, generation = 0, listAbort: AbortController | null = null;
let typesAbort: AbortController | null = null, exportAbort: AbortController | null = null;
let exportGeneration = 0;
let stored = localStorage.getItem("admin_session");
const sessionVersion = ref(0);
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ""}:${auth.uniqueAuth.join(",")}`);
function hasPermission(key: string): boolean {
  void sessionVersion.value;
  const session = getAdminSession();
  return !!auth.token && auth.token === getToken() && stored === localStorage.getItem("admin_session") &&
    !!auth.userInfo && !!session && session.userInfo.id === auth.userInfo.id &&
    session.userInfo.level === auth.userInfo.level &&
    (auth.userInfo.level === 0 || (auth.uniqueAuth.includes(key) && session.uniqueAuth.includes(key)));
}
const canView = computed(() => hasPermission("bill.view"));
const canExport = computed(() => canView.value && hasPermission("bill.export"));
type Stamp = { identity: string; stored: string | null; generation: number };
function stamp(): Stamp { return { identity: identity.value, stored, generation }; }
function current(value: Stamp): boolean {
  return alive && canView.value && value.identity === identity.value && value.stored === stored &&
    stored === localStorage.getItem("admin_session") && value.generation === generation &&
    auth.token === getToken();
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : "请求失败"; }

function cancelExport(notify = false): void {
  exportGeneration++; exportAbort?.abort(); exportAbort = null;
  exporting.value = false; exportRead.value = exportTotal.value = 0;
  exportError.value = notify ? "导出已取消，没有生成文件。" : "";
}
function clear(): void {
  generation++; listAbort?.abort(); typesAbort?.abort(); listAbort = typesAbort = null;
  cancelExport();
  list.value = []; count.value = 0; page.value = 1; loading.value = false; listError.value = "";
  types.value = []; typesLoading.value = false; typesError.value = "";
  draftKeyword.value = draftType.value = ""; draftRange.value = null;
  filters.value = normalizeUserMoneyFilters(); filterError.value = "";
}
async function loadTypes(): Promise<void> {
  if (!current(stamp())) return;
  typesAbort?.abort(); const scope = stamp(), controller = new AbortController(); typesAbort = controller;
  typesLoading.value = true; typesError.value = "";
  try {
    const result = await apiUserMoneyLedgerTypes(controller.signal);
    if (current(scope) && typesAbort === controller) types.value = result;
  } catch (error) { if (current(scope) && typesAbort === controller) typesError.value = errorText(error); }
  finally { if (typesAbort === controller) { typesAbort = null; typesLoading.value = false; } }
}
async function load(target = page.value): Promise<void> {
  if (!current(stamp())) return;
  listAbort?.abort(); const scope = stamp(), controller = new AbortController(); listAbort = controller;
  page.value = target; loading.value = true; listError.value = ""; list.value = []; count.value = 0;
  try {
    const result = await apiUserMoneyLedger({ ...filters.value, page: target, limit: USER_MONEY_PAGE_SIZE }, controller.signal);
    if (!current(scope) || listAbort !== controller) return;
    if (target > 1 && !result.list.length && result.count > 0) {
      await load(Math.min(target - 1, Math.ceil(result.count / USER_MONEY_PAGE_SIZE)));
      return;
    }
    list.value = result.list; count.value = result.count;
  } catch (error) { if (current(scope) && listAbort === controller) listError.value = errorText(error); }
  finally { if (listAbort === controller) { listAbort = null; loading.value = false; } }
}
function search(): void {
  if (!current(stamp())) return;
  try {
    const range = capitalFlowRange(draftRange.value);
    filters.value = normalizeUserMoneyFilters({ keyword: draftKeyword.value, type: draftType.value,
      start: range.start ?? 0, stop: range.stop ?? 0 });
    filterError.value = ""; cancelExport(); void load(1);
  } catch (error) { filterError.value = errorText(error); }
}
function reset(): void {
  if (!current(stamp())) return;
  draftKeyword.value = draftType.value = ""; draftRange.value = null; search();
}
function refresh(): void { if (current(stamp())) { void loadTypes(); void load(page.value); } }
async function exportCsv(): Promise<void> {
  if (!canExport.value || !current(stamp()) || exporting.value) return;
  cancelExport(); const scope = stamp(), version = exportGeneration;
  const controller = new AbortController(); exportAbort = controller; exporting.value = true;
  const active = () => current(scope) && canExport.value && version === exportGeneration &&
    exportAbort === controller && !controller.signal.aborted;
  try {
    const result = await collectUserMoneyExport({ ...filters.value }, controller.signal, (read, total) => {
      if (active()) { exportRead.value = read; exportTotal.value = total; }
    });
    if (active()) downloadUserMoneyCsv(result.csv, result.filename);
  } catch (error) { if (active()) exportError.value = errorText(error); }
  finally { if (exportAbort === controller) { exportAbort = null; exporting.value = false; } }
}
function syncSession(): void {
  syncing = true; clear(); const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  stored = localStorage.getItem("admin_session"); sessionVersion.value++; syncing = false;
  if (canView.value) { void loadTypes(); void load(1); }
}
function syncStorage(event: StorageEvent): void {
  if (event.key === null || event.key === "admin_token" || event.key === "admin_session") syncSession();
}
watch(identity, () => { if (alive && !syncing) syncSession(); }, { flush: "sync" });
onMounted(() => { alive = true; window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession); window.addEventListener("storage", syncStorage);
  syncSession(); });
onBeforeUnmount(() => { alive = false; clear(); window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession); window.removeEventListener("storage", syncStorage); });
</script>

<style scoped>
.money-ledger { min-width: 0; }
.heading, .heading-actions, .filters { display: flex; gap: 12px; flex-wrap: wrap; }
.heading { align-items: center; justify-content: space-between; }
.heading-actions { align-items: center; }
.hint { margin: 5px 0 0; color: var(--el-text-color-secondary); font-size: 13px; }
.filters { align-items: end; margin-bottom: 16px; }
.field { display: flex; flex: 1 1 190px; flex-direction: column; gap: 6px; min-width: 0; font-size: 13px; }
.type-field { flex-basis: 155px; }.time-field { flex-basis: 320px; }
.field :deep(.el-input), .field :deep(.el-select), .field :deep(.el-date-editor) { width: 100%; }
.filter-actions { display: flex; gap: 8px; }
.notice, .progress { margin-bottom: 14px; }.progress { color: var(--el-text-color-secondary); font-size: 13px; }
.table-scroll { width: 100%; overflow-x: auto; }
.income { color: #32936d; font-weight: 600; }.expense { color: #d74732; font-weight: 600; }
.pager { margin-top: 16px; justify-content: flex-end; flex-wrap: wrap; }
@media (max-width: 650px) { .filters { display: grid; grid-template-columns: minmax(0, 1fr); }.pager { justify-content: center; } }
</style>
