<template>
  <div class="writeoff-orders">
    <div class="heading"><div><h2>核销订单</h2><p class="hint">按已核销订单读取。时间筛选作用于订单创建时间。</p></div>
      <el-button v-if="canView" :loading="loading" @click="load(page)">刷新</el-button></div>
    <el-alert v-if="!canView" title="当前账号没有核销订单查看权限" type="warning" show-icon :closable="false" />
    <template v-else>
      <el-card shadow="never" class="section">
        <div class="filters">
          <label class="field preset-field"><span>订单创建时间（上海时间）</span><el-select v-model="draftPreset" @change="choosePreset">
            <el-option label="全部" value="" /><el-option label="今天" value="today" /><el-option label="昨天" value="yesterday" />
            <el-option label="最近7天" value="lately7" /><el-option label="最近30天" value="lately30" />
            <el-option label="本月" value="month" /><el-option label="本年" value="year" />
          </el-select></label>
          <label class="field dates-field"><span>自定义创建日期</span><el-date-picker v-model="draftDates" type="daterange"
            value-format="YYYY/MM/DD" format="YYYY/MM/DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期"
            @change="chooseDates" /></label>
          <label class="field key-field"><span>筛选字段</span><el-select v-model="draftField">
            <el-option label="全部" value="all" /><el-option label="订单号" value="order_id" /><el-option label="UID" value="uid" />
            <el-option label="用户姓名" value="real_name" /><el-option label="用户电话" value="user_phone" />
            <el-option label="商品名称（模糊）" value="title" />
          </el-select></label>
          <label class="field search-field"><span>筛选内容</span><el-input v-model="draftKeyword" clearable maxlength="80"
            placeholder="姓名、电话、订单号、商品名称" @keyup.enter="search" /></label>
          <label class="field store-field"><span>核销门店</span><el-select v-model="draftStore" clearable :loading="storesLoading"
            placeholder="全部门店"><el-option label="全部门店" value="" />
            <el-option v-for="store in stores" :key="store.id" :label="store.name" :value="store.id" /></el-select></label>
          <div class="actions"><el-button type="primary" @click="search">搜索</el-button><el-button @click="reset">重置</el-button></div>
        </div>
        <el-alert v-if="filterError" :title="filterError" type="error" :closable="false" show-icon />
        <el-alert v-if="storesError" :title="storesError" type="warning" :closable="false" show-icon>
          <el-button link type="primary" @click="loadStores">重试门店列表</el-button></el-alert>
      </el-card>
      <el-card shadow="never" class="section">
        <p class="hint">匹配 {{ count }} 条；每页 15 条。订单号和下单时间可对当前页排序。</p>
        <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon>
          <el-button link type="primary" @click="load(page)">重新读取</el-button></el-alert>
        <div v-else class="table-scroll"><el-table :data="list" v-loading="loading" border row-key="id"
          :empty-text="loading ? '读取中…' : '暂无核销订单'">
          <el-table-column prop="order_id" label="订单号" min-width="185" sortable />
          <el-table-column label="用户信息" min-width="145"><template #default="{ row }">{{ row.nickname || '—' }} / {{ row.uid }}</template></el-table-column>
          <el-table-column label="推荐人信息" min-width="125"><template #default="{ row }">
            <el-button v-if="row.spread_nickname" link type="primary" @click="openSpread(row)">{{ row.spread_nickname }}</el-button>
            <span v-else>—</span></template></el-table-column>
          <el-table-column label="商品信息" min-width="340"><template #default="{ row }">
            <div v-if="row.goods.length" class="goods-cell"><div v-for="(good, index) in row.goods" :key="index" class="good">
              <img v-if="safeImage(good.image)" :src="good.image" alt="商品图" loading="lazy" />
              <div><div>{{ good.name || '商品名称缺失' }}<span v-if="good.spec"> · {{ good.spec }}</span></div>
                <small>¥{{ good.true_price }} × {{ good.cart_num }}</small></div>
            </div></div><span v-else class="hint">商品快照缺失</span></template></el-table-column>
          <el-table-column label="实际支付" min-width="105"><template #default="{ row }">¥{{ row.pay_price }}</template></el-table-column>
          <el-table-column prop="clerk_name" label="核销员" min-width="100" />
          <el-table-column prop="store_name" label="核销门店" min-width="130" />
          <el-table-column prop="pay_type_name" label="支付状态" min-width="105" />
          <el-table-column label="订单状态" min-width="110"><template #default="{ row }">{{ row.status_name }}
            <el-tag v-if="row.issues.length" size="small" type="warning">需核对</el-tag></template></el-table-column>
          <el-table-column prop="add_time" label="下单时间" min-width="165" sortable>
            <template #default="{ row }">{{ writeoffTime(row.add_time) }}</template></el-table-column>
        </el-table></div>
        <el-pagination v-if="!loading && !listError" class="pager" :current-page="page" :page-size="15" :total="count"
          layout="total, prev, pager, next" @current-change="load" />
      </el-card>
      <el-dialog v-model="spreadVisible" title="推荐人信息" width="min(620px, calc(100vw - 24px))" @closed="closeSpread">
        <div v-loading="spreadLoading">
          <el-alert v-if="spreadError" :title="spreadError" type="error" :closable="false" show-icon>
            <el-button link type="primary" @click="loadSpread">重新读取</el-button></el-alert>
          <el-empty v-else-if="!spreadLoading && !spread" description="该订单用户暂无推荐人" />
          <div v-else-if="spread" class="spread-detail"><div class="spread-heading">
            <el-avatar v-if="safeImage(spread.avatar)" :src="spread.avatar" :size="42" />
            <strong>{{ spread.nickname || `UID ${spread.uid}` }}</strong></div>
            <el-descriptions :column="descriptionColumns" border>
              <el-descriptions-item label="UID">{{ spread.uid }}</el-descriptions-item>
              <el-descriptions-item label="真实姓名">{{ spread.real_name || '—' }}</el-descriptions-item>
              <el-descriptions-item label="手机号">{{ spread.phone || '—' }}</el-descriptions-item>
              <el-descriptions-item label="余额">¥{{ spread.now_money }}</el-descriptions-item>
              <el-descriptions-item label="佣金">¥{{ spread.brokerage_price }}</el-descriptions-item>
              <el-descriptions-item label="积分">{{ spread.integral }}</el-descriptions-item>
              <el-descriptions-item label="生日">{{ writeoffTime(spread.birthday, true) }}</el-descriptions-item>
              <el-descriptions-item label="最后登录">{{ writeoffTime(spread.last_time) }}</el-descriptions-item>
              <el-descriptions-item label="用户备注">{{ spread.mark || '—' }}</el-descriptions-item>
            </el-descriptions></div>
        </div>
        <template #footer><el-button @click="spreadVisible = false">关闭</el-button></template>
      </el-dialog>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import { apiWriteoffOrders, apiWriteoffSpread, apiWriteoffStores, normalizeWriteoffOrderQuery, writeoffTime,
  type WriteoffField, type WriteoffOrder, type WriteoffOrderQuery, type WriteoffPreset, type WriteoffSpread,
  type WriteoffStore } from "@/api/writeoffOrders";

const auth = useAuthStore();
const draftPreset = ref<WriteoffPreset>(""), draftDates = ref<[string, string] | null>(null);
const draftField = ref<WriteoffField>("all"), draftKeyword = ref(""), draftStore = ref<number | "">("");
const applied = ref<Omit<WriteoffOrderQuery, "page" | "limit">>({ data: "", real_name: "", field_key: "all", store_id: "" });
const page = ref(1), list = ref<WriteoffOrder[]>([]), count = ref(0), loading = ref(false), listError = ref("");
const stores = ref<WriteoffStore[]>([]), storesLoading = ref(false), storesError = ref(""), filterError = ref("");
const spreadVisible = ref(false), spreadUid = ref(0), spread = ref<WriteoffSpread | null>(null);
const spreadLoading = ref(false), spreadError = ref("");
const descriptionColumns = computed(() => window.innerWidth <= 600 ? 1 : 2);
let alive = false, syncing = false, generation = 0, spreadVersion = 0, storesVersion = 0;
let stored = localStorage.getItem("admin_session");
let listAbort: AbortController | null = null, storesAbort: AbortController | null = null, spreadAbort: AbortController | null = null;
const sessionVersion = ref(0);
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ""}:${auth.uniqueAuth.join(",")}`);
const canView = computed(() => {
  void sessionVersion.value;
  const session = getAdminSession();
  return !!auth.token && auth.token === getToken() && stored === localStorage.getItem("admin_session") && !!auth.userInfo && !!session &&
    session.userInfo.id === auth.userInfo.id && session.userInfo.level === auth.userInfo.level &&
    (auth.userInfo.level === 0 || (auth.uniqueAuth.includes("writeoff_order.view") && session.uniqueAuth.includes("writeoff_order.view")));
});
type Scope = { identity: string; stored: string | null; generation: number };
function scope(): Scope { return { identity: identity.value, stored, generation }; }
function current(value: Scope): boolean { return alive && canView.value && value.identity === identity.value &&
  value.stored === stored && stored === localStorage.getItem("admin_session") && value.generation === generation && auth.token === getToken(); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "请求失败"; }
function safeImage(value: string): boolean { return /^(?:https?:\/\/|\/(?!\/))/iu.test(value); }
function resetSpread(): void {
  spreadVersion++; spreadAbort?.abort(); spreadAbort = null; spreadVisible.value = false; spreadUid.value = 0;
  spread.value = null; spreadLoading.value = false; spreadError.value = "";
}
function closeSpread(): void { if (!spreadVisible.value) resetSpread(); }
function clear(): void {
  generation++; listAbort?.abort(); storesAbort?.abort(); listAbort = storesAbort = null; storesVersion++;
  list.value = []; count.value = 0; page.value = 1; loading.value = false;
  stores.value = []; storesLoading.value = false; storesError.value = listError.value = filterError.value = "";
  draftPreset.value = ""; draftDates.value = null; draftField.value = "all"; draftKeyword.value = ""; draftStore.value = "";
  applied.value = { data: "", real_name: "", field_key: "all", store_id: "" }; resetSpread();
}
async function load(target = page.value): Promise<void> {
  if (!current(scope()) || !Number.isSafeInteger(target) || target < 1 || target > 667) return;
  listAbort?.abort(); resetSpread(); const stamp = scope(), controller = new AbortController(); listAbort = controller;
  loading.value = true; listError.value = ""; list.value = []; count.value = 0; page.value = target;
  try {
    const result = await apiWriteoffOrders({ page: target, limit: 15, ...applied.value }, controller.signal);
    if (current(stamp) && listAbort === controller) { list.value = result.list; count.value = result.count; }
  } catch (error) { if (current(stamp) && listAbort === controller) listError.value = errorMessage(error); }
  finally { if (listAbort === controller) { listAbort = null; loading.value = false; } }
}
async function loadStores(): Promise<void> {
  if (!current(scope())) return;
  storesVersion++; storesAbort?.abort(); const version = storesVersion, stamp = scope(), controller = new AbortController();
  storesAbort = controller; storesLoading.value = true; storesError.value = "";
  try { const result = await apiWriteoffStores(controller.signal);
    if (current(stamp) && storesAbort === controller && storesVersion === version) stores.value = result;
  } catch (error) { if (current(stamp) && storesAbort === controller && storesVersion === version) storesError.value = errorMessage(error); }
  finally { if (storesAbort === controller) { storesAbort = null; storesLoading.value = false; } }
}
function search(): void {
  if (!current(scope())) return;
  try { const query = normalizeWriteoffOrderQuery({ page: 1, limit: 15,
    data: draftDates.value ? draftDates.value.join("-") : draftPreset.value,
    real_name: draftKeyword.value, field_key: draftField.value, store_id: draftStore.value });
    applied.value = { data: query.data, real_name: query.real_name, field_key: query.field_key, store_id: query.store_id };
    filterError.value = ""; void load(1);
  } catch (error) { filterError.value = errorMessage(error); }
}
function choosePreset(): void { draftDates.value = null; search(); }
function chooseDates(): void { if (draftDates.value?.length) draftPreset.value = ""; }
function reset(): void {
  draftPreset.value = ""; draftDates.value = null; draftField.value = "all"; draftKeyword.value = ""; draftStore.value = "";
  search();
}
async function openSpread(row: WriteoffOrder): Promise<void> {
  if (!current(scope()) || !list.value.some(item => item.id === row.id && item.uid === row.uid) || !row.spread_nickname || row.uid <= 0) return;
  resetSpread(); spreadUid.value = row.uid; spreadVisible.value = true; await loadSpread();
}
async function loadSpread(): Promise<void> {
  const uid = spreadUid.value;
  if (!uid || !spreadVisible.value || !current(scope())) return;
  spreadVersion++; spreadAbort?.abort(); const version = spreadVersion, stamp = scope(), controller = new AbortController();
  spreadAbort = controller; spreadLoading.value = true; spreadError.value = ""; spread.value = null;
  try { const result = await apiWriteoffSpread(uid, controller.signal);
    if (current(stamp) && spreadVersion === version && spreadAbort === controller && spreadVisible.value) spread.value = result;
  } catch (error) { if (current(stamp) && spreadVersion === version && spreadAbort === controller) spreadError.value = errorMessage(error); }
  finally { if (spreadAbort === controller) { spreadAbort = null; spreadLoading.value = false; } }
}
function syncSession(): void {
  syncing = true; clear(); const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  stored = localStorage.getItem("admin_session"); sessionVersion.value++; syncing = false;
  if (canView.value) { void load(1); void loadStores(); }
}
function syncStorage(event: StorageEvent): void { if (event.key === null || event.key === "admin_token" || event.key === "admin_session") syncSession(); }
watch(identity, () => { if (alive && !syncing) syncSession(); }, { flush: "sync" });
watch(spreadVisible, visible => { if (!visible) resetSpread(); }, { flush: "sync" });
onMounted(() => { alive = true; window.addEventListener("admin-session-changed", syncSession); window.addEventListener("admin-auth-expired", syncSession);
  window.addEventListener("storage", syncStorage); syncSession(); });
onBeforeUnmount(() => { alive = false; clear(); window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession); window.removeEventListener("storage", syncStorage); });
</script>

<style scoped>
.writeoff-orders { min-width: 0; }.heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.heading h2 { margin: 0 0 6px; font-size: 20px; }.hint { color: var(--el-text-color-secondary); font-size: 13px; }
.section { margin-top: 16px; }.filters { display: flex; align-items: end; flex-wrap: wrap; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }.preset-field { width: 205px; }
.dates-field { flex: 1 1 290px; }.key-field { width: 170px; }.search-field { flex: 1 1 190px; }.store-field { width: 190px; }
.field :deep(.el-select), .field :deep(.el-date-editor), .field :deep(.el-input) { width: 100%; }
.actions { display: flex; gap: 8px; }.actions :deep(.el-button + .el-button) { margin-left: 0; }
.table-scroll { overflow-x: auto; width: 100%; }.pager { margin-top: 16px; justify-content: flex-end; }
.goods-cell { display: grid; gap: 8px; }.good { display: flex; align-items: center; gap: 8px; min-width: 0; }
.good img { width: 42px; height: 42px; object-fit: cover; border-radius: 4px; }.good small { color: var(--el-text-color-secondary); }
.spread-heading { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
@media (max-width: 650px) { .field, .preset-field, .dates-field, .key-field, .search-field, .store-field { flex: 1 1 100%; width: 100%; } }
</style>
