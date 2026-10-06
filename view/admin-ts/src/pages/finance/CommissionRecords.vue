<template>
  <div class="commission-records">
    <div class="heading"><div><h2>佣金记录</h2><p class="hint">列表每页 20 条，旧全量导出尚未迁移。</p>
      <p class="hint">“提现到账佣金”沿用旧列名，包含审核中及已通过提现的本金与手续费；详情“佣金总收入”按佣金流水收入扣退款，和列表总佣金口径不同。</p></div>
      <el-tag type="info">导出待迁移</el-tag></div>
    <el-alert v-if="!canView" title="当前账号没有佣金记录查看权限" type="warning" show-icon :closable="false" />
    <template v-else>
      <el-card shadow="never" class="section">
        <div class="filters">
          <label class="field date-field"><span>佣金时间（上海完整分钟）</span><el-date-picker v-model="draftDates" type="datetimerange"
            value-format="YYYY-MM-DD HH:mm" format="YYYY-MM-DD HH:mm" range-separator="至" start-placeholder="开始" end-placeholder="结束" /></label>
          <label class="field keyword-field"><span>昵称/ID</span><el-input v-model="draftKeyword" maxlength="80" clearable placeholder="昵称、手机号或 UID" @keyup.enter="search" /></label>
          <label class="field money-field"><span>账户佣金最小值</span><el-input v-model="draftMin" clearable placeholder="¥" @keyup.enter="search" /></label>
          <label class="field money-field"><span>账户佣金最大值</span><el-input v-model="draftMax" clearable placeholder="¥" @keyup.enter="search" /></label>
          <div class="actions"><el-button type="primary" @click="search">查询</el-button><el-button @click="reset">重置</el-button></div>
        </div>
        <el-alert v-if="filterError" :title="filterError" type="error" :closable="false" show-icon />
      </el-card>
      <el-card shadow="never" class="section">
        <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon><el-button link type="primary" @click="load(page)">重新读取</el-button></el-alert>
        <el-table v-else :data="list" v-loading="loading" border row-key="uid" :empty-text="loading ? '读取中…' : '暂无佣金记录'">
          <el-table-column label="昵称/姓名/ID" min-width="220"><template #default="{ row }">{{ row.display_name }} <el-tag v-if="row.user_deleted" type="info" size="small">已注销</el-tag></template></el-table-column>
          <el-table-column prop="sum_number" label="总佣金金额" min-width="120" />
          <el-table-column prop="now_money" label="账户余额" min-width="110" />
          <el-table-column prop="brokerage_price" label="账户佣金" min-width="120" />
          <el-table-column prop="extract_price" label="提现到账佣金" min-width="150" />
          <el-table-column label="最近匹配流水时间" min-width="165"><template #default="{ row }">{{ commissionTime(row.time) }}</template></el-table-column>
          <el-table-column label="操作" width="125" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openDetail(row)">详情</el-button><el-tag v-if="row.issues.length" size="small" type="warning">需核对</el-tag></template></el-table-column>
        </el-table>
        <el-pagination v-if="!listError" class="pager" :current-page="page" :page-size="20" :total="count"
          layout="total, prev, pager, next" @current-change="load" />
      </el-card>
      <el-dialog v-model="detailVisible" title="用户佣金详情" width="min(760px, calc(100vw - 24px))" @closed="closeDetail">
        <div v-loading="detailLoading">
          <el-alert v-if="detailError" :title="detailError" type="error" :closable="false" show-icon><el-button link type="primary" @click="loadDetail">重新读取</el-button></el-alert>
          <template v-else-if="detail">
            <el-descriptions :column="descriptionColumns" border>
              <el-descriptions-item label="昵称">{{ detail.nickname || `UID ${detail.uid}` }}</el-descriptions-item>
              <el-descriptions-item label="上级推广人">{{ detail.spread_name || '无' }}</el-descriptions-item>
              <el-descriptions-item label="佣金总收入">¥{{ detail.number }}</el-descriptions-item>
              <el-descriptions-item label="用户余额">¥{{ detail.now_money }}</el-descriptions-item>
              <el-descriptions-item label="账户佣金">¥{{ detail.brokerage_price }}</el-descriptions-item>
              <el-descriptions-item label="创建时间">{{ commissionTime(detail.add_time) }}</el-descriptions-item>
            </el-descriptions>
            <el-alert v-if="detail.issues.length" class="section" title="历史记录需核对" type="warning" :closable="false"><ul><li v-for="(issue, index) in detail.issues" :key="index">{{ issue }}</li></ul></el-alert>
          </template>
        </div>
        <div class="record-filter"><span>明细时间（上海整日）</span><el-date-picker v-model="recordDates" type="daterange" value-format="YYYY-MM-DD"
          format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" />
          <el-button type="primary" @click="searchRecords">搜索</el-button></div>
        <el-alert v-if="recordsError" :title="recordsError" type="error" :closable="false" show-icon><el-button link type="primary" @click="loadRecords(recordPage)">重新读取</el-button></el-alert>
        <el-table v-else :data="records" v-loading="recordsLoading" border row-key="id" :empty-text="recordsLoading ? '读取中…' : '暂无佣金明细'">
          <el-table-column prop="number" label="佣金金额" min-width="105" />
          <el-table-column label="获得时间" min-width="160"><template #default="{ row }">{{ commissionTime(row.add_time) }}</template></el-table-column>
          <el-table-column prop="mark" label="备注" min-width="280" show-overflow-tooltip />
        </el-table>
        <el-pagination v-if="!recordsError" class="pager" :current-page="recordPage" :page-size="20" :total="recordCount"
          layout="total, prev, pager, next" @current-change="loadRecords" />
        <template #footer><el-button @click="detailVisible = false">关闭</el-button></template>
      </el-dialog>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import { apiCommissionDetail, apiCommissionList, apiCommissionRecords, commissionTime,
  normalizeCommissionQuery, normalizeCommissionRecordsQuery,
  type CommissionDetail, type CommissionListQuery, type CommissionRecord, type CommissionRow } from "@/api/commissionRecords";

const auth = useAuthStore();
const draftDates = ref<[string, string] | null>(null), draftKeyword = ref(""), draftMin = ref(""), draftMax = ref("");
const applied = ref<Omit<CommissionListQuery, "page" | "limit">>({ keyword: "", price_min: "", price_max: "", start_time: "", end_time: "" });
const page = ref(1), list = ref<CommissionRow[]>([]), count = ref(0), loading = ref(false), listError = ref(""), filterError = ref("");
const detailVisible = ref(false), detailUid = ref(0), detail = ref<CommissionDetail | null>(null), detailLoading = ref(false), detailError = ref("");
const recordDates = ref<[string, string] | null>(null), recordPage = ref(1), records = ref<CommissionRecord[]>([]), recordCount = ref(0), recordsLoading = ref(false), recordsError = ref("");
const descriptionColumns = computed(() => window.innerWidth <= 680 ? 1 : 2);
let alive = false, syncing = false, generation = 0, detailVersion = 0, recordsVersion = 0;
let stored = localStorage.getItem("admin_session");
let listAbort: AbortController | null = null, detailAbort: AbortController | null = null, recordsAbort: AbortController | null = null;
const sessionVersion = ref(0);
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ""}:${auth.uniqueAuth.join(",")}`);
const canView = computed(() => {
  void sessionVersion.value;
  const session = getAdminSession();
  return !!auth.token && auth.token === getToken() && stored === localStorage.getItem("admin_session") && !!auth.userInfo && !!session &&
    session.userInfo.id === auth.userInfo.id && session.userInfo.level === auth.userInfo.level &&
    (auth.userInfo.level === 0 || (auth.uniqueAuth.includes("commission.view") && session.uniqueAuth.includes("commission.view")));
});
type Scope = { identity: string; stored: string | null; generation: number };
function scope(): Scope { return { identity: identity.value, stored, generation }; }
function current(value: Scope) { return alive && canView.value && value.identity === identity.value && value.generation === generation &&
  value.stored === stored && stored === localStorage.getItem("admin_session") && auth.token === getToken(); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "请求失败"; }

function resetDetail() {
  detailVersion++; recordsVersion++; detailAbort?.abort(); recordsAbort?.abort(); detailAbort = recordsAbort = null;
  detailVisible.value = false; detailUid.value = 0; detail.value = null; detailLoading.value = false; detailError.value = "";
  recordDates.value = null; recordPage.value = 1; records.value = []; recordCount.value = 0; recordsLoading.value = false; recordsError.value = "";
}
function closeDetail() { if (!detailVisible.value) resetDetail(); }
function clear() {
  generation++; listAbort?.abort(); listAbort = null; list.value = []; count.value = 0; page.value = 1; loading.value = false;
  listError.value = filterError.value = ""; draftDates.value = null; draftKeyword.value = draftMin.value = draftMax.value = "";
  applied.value = { keyword: "", price_min: "", price_max: "", start_time: "", end_time: "" }; resetDetail();
}

async function load(target = page.value) {
  if (!current(scope()) || !Number.isSafeInteger(target) || target < 1 || target > 501) return;
  listAbort?.abort(); const stamp = scope(), controller = new AbortController(); listAbort = controller;
  loading.value = true; listError.value = ""; list.value = []; count.value = 0; page.value = target;
  try {
    const result = await apiCommissionList({ page: target, limit: 20, ...applied.value }, controller.signal);
    if (current(stamp) && listAbort === controller) { list.value = result.list; count.value = result.count; }
  } catch (error) { if (current(stamp) && listAbort === controller) listError.value = errorMessage(error); }
  finally { if (listAbort === controller) { listAbort = null; loading.value = false; } }
}
function search() {
  if (!current(scope())) return;
  try {
    const query = normalizeCommissionQuery({ page: 1, limit: 20, keyword: draftKeyword.value,
      price_min: draftMin.value.trim(), price_max: draftMax.value.trim(),
      start_time: draftDates.value?.[0] ?? "", end_time: draftDates.value?.[1] ?? "" });
    applied.value = { keyword: query.keyword, price_min: query.price_min, price_max: query.price_max,
      start_time: query.start_time, end_time: query.end_time }; filterError.value = ""; void load(1);
  } catch (error) { filterError.value = errorMessage(error); }
}
function reset() { draftDates.value = null; draftKeyword.value = draftMin.value = draftMax.value = ""; search(); }

async function openDetail(row: CommissionRow) {
  if (!current(scope()) || !list.value.some(item => item.uid === row.uid)) return;
  resetDetail(); detailUid.value = row.uid; detailVisible.value = true;
  await Promise.all([loadDetail(), loadRecords(1)]);
}
async function loadDetail() {
  const uid = detailUid.value;
  if (!uid || !detailVisible.value || !current(scope())) return;
  detailVersion++; detailAbort?.abort(); const version = detailVersion, stamp = scope(), controller = new AbortController();
  detailAbort = controller; detailLoading.value = true; detailError.value = ""; detail.value = null;
  try { const result = await apiCommissionDetail(uid, controller.signal);
    if (current(stamp) && version === detailVersion && detailAbort === controller && detailVisible.value) detail.value = result;
  } catch (error) { if (current(stamp) && version === detailVersion && detailAbort === controller) detailError.value = errorMessage(error); }
  finally { if (detailAbort === controller) { detailAbort = null; detailLoading.value = false; } }
}
async function loadRecords(target = recordPage.value) {
  const uid = detailUid.value;
  if (!uid || !detailVisible.value || !current(scope())) return;
  recordsVersion++; recordsAbort?.abort(); const version = recordsVersion, stamp = scope(), controller = new AbortController();
  recordsAbort = controller; recordsLoading.value = true; recordsError.value = ""; records.value = []; recordCount.value = 0;
  try { const query = normalizeCommissionRecordsQuery({ page: target, limit: 20,
      start_time: recordDates.value?.[0] ?? "", end_time: recordDates.value?.[1] ?? "" });
    const result = await apiCommissionRecords(uid, query, controller.signal);
    if (current(stamp) && version === recordsVersion && recordsAbort === controller && detailVisible.value) {
      records.value = result.list; recordCount.value = result.count; recordPage.value = target;
    }
  } catch (error) { if (current(stamp) && version === recordsVersion && recordsAbort === controller) recordsError.value = errorMessage(error); }
  finally { if (recordsAbort === controller) { recordsAbort = null; recordsLoading.value = false; } }
}
function searchRecords() { if (current(scope())) void loadRecords(1); }

function syncSession() {
  syncing = true; clear(); const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  stored = localStorage.getItem("admin_session"); sessionVersion.value++; syncing = false;
  if (canView.value) void load(1);
}
function syncStorage(event: StorageEvent) { if (event.key === null || event.key === "admin_token" || event.key === "admin_session") syncSession(); }
watch(identity, () => { if (alive && !syncing) syncSession(); }, { flush: "sync" });
watch(detailVisible, visible => { if (!visible) resetDetail(); }, { flush: "sync" });
onMounted(() => { alive = true; window.addEventListener("admin-session-changed", syncSession); window.addEventListener("admin-auth-expired", syncSession);
  window.addEventListener("storage", syncStorage); syncSession(); });
onBeforeUnmount(() => { alive = false; clear(); window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession); window.removeEventListener("storage", syncStorage); });
</script>

<style scoped>
.commission-records { min-width: 0; }.heading, .filters, .record-filter { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; }
.heading { align-items: center; justify-content: space-between; }.heading h2 { margin: 0 0 6px; font-size: 20px; }
.hint { color: var(--el-text-color-secondary); font-size: 13px; }.section { margin-top: 16px; }
.filters { margin-bottom: 4px; }.field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.date-field { flex: 1 1 300px; }.keyword-field { flex: 1 1 180px; }.money-field { flex: 1 1 110px; }
.field :deep(.el-date-editor), .field :deep(.el-input) { width: 100%; }.actions { display: flex; gap: 8px; }
.record-filter { margin: 16px 0 12px; align-items: center; }.pager { margin-top: 16px; justify-content: flex-end; }
@media(max-width: 600px) { .field, .date-field, .keyword-field, .money-field { flex: 1 1 100%; } }
</style>
