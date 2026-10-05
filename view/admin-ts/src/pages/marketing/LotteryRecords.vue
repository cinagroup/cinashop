<template>
  <div class="lottery-records">
    <div class="heading">
      <div>
        <h2>中奖记录</h2>
        <p>按活动、奖品和时间查询中奖历史；发货与备注需要中奖记录管理权限。</p>
      </div>
      <router-link v-if="canActivityView" to="/marketing/lottery">返回抽奖活动</router-link>
    </div>
    <el-alert v-if="!canView" title="当前账号没有中奖记录查看权限" type="warning" :closable="false" show-icon />
    <template v-else>
      <el-alert v-if="routeScope.error" :title="routeScope.error" type="error" :closable="false" show-icon />
      <el-card v-else shadow="never">
        <div v-if="routeScope.id" class="scope-bar">
          <el-tag type="info">活动 ID {{ routeScope.id }}</el-tag>
          <router-link to="/marketing/lottery-records">查看全部中奖记录</router-link>
        </div>
        <div class="filters">
          <label v-if="!routeScope.id" class="filter-field narrow"><span>活动 ID</span><el-input v-model="draftLotteryId" aria-label="活动 ID" clearable placeholder="全部活动" @keyup.enter="search" /></label>
          <label class="filter-field"><span>活动类型</span><el-select v-model="draftFactor" aria-label="活动类型" clearable placeholder="全部类型"><el-option v-for="item in factors" :key="item.value" :label="item.label" :value="item.value" /></el-select></label>
          <label class="filter-field"><span>奖品类型</span><el-select v-model="draftType" aria-label="奖品类型" clearable placeholder="全部奖品"><el-option v-for="item in prizeTypes" :key="item.value" :label="item.label" :value="item.value" /></el-select></label>
          <label class="filter-field wide"><span>用户</span><el-input v-model="draftKeyword" aria-label="中奖用户" maxlength="100" clearable placeholder="昵称或用户 ID" @keyup.enter="search" /></label>
          <label class="filter-field wide"><span>抽奖日期（上海时间）</span><el-date-picker v-model="draftDates" aria-label="抽奖日期" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" /></label>
          <label class="filter-field"><span>领取状态</span><el-select v-model="draftReceive" aria-label="领取状态" clearable placeholder="全部"><el-option label="待领取" :value="0" /><el-option label="已领取" :value="1" /></el-select></label>
          <label class="filter-field"><span>处理状态</span><el-select v-model="draftDeliver" aria-label="处理状态" clearable placeholder="全部"><el-option label="未处理" :value="0" /><el-option label="已处理" :value="1" /></el-select></label>
          <div class="filter-actions"><el-button type="primary" :disabled="loading" @click="search">查询</el-button><el-button :disabled="loading" @click="reset">重置</el-button></div>
        </div>
        <el-alert v-if="errorMessage" :title="errorMessage" type="error" :closable="false" show-icon class="notice"><template #default><el-button link @click="load(page)">重试</el-button></template></el-alert>
        <div class="table-scroll">
          <el-table :data="records" v-loading="loading" row-key="id" border empty-text="暂无中奖记录">
            <el-table-column prop="id" label="记录 ID" width="95" />
            <el-table-column label="用户" min-width="150"><template #default="{ row }"><strong>{{ row.user?.nickname || `UID ${row.uid}` }}</strong><el-tag v-if="row.user?.is_deleted" type="info" size="small">已注销</el-tag><small class="block">UID {{ row.uid }}</small></template></el-table-column>
            <el-table-column label="活动" min-width="150"><template #default="{ row }">{{ row.lottery?.name || `活动 #${row.lotteryId}` }}</template></el-table-column>
            <el-table-column label="奖品" min-width="180"><template #default="{ row }"><div class="prize-cell"><el-image v-if="row.prize?.image" :src="row.prize.image" fit="cover" /><span>{{ row.prize?.name || prizeTypeLabel(row.type) }}<small class="block">{{ prizeTypeLabel(row.type) }}</small></span></div></template></el-table-column>
            <el-table-column label="抽奖时间" min-width="175"><template #default="{ row }">{{ formatTime(row.addTime) }}</template></el-table-column>
            <el-table-column label="领取" width="100"><template #default="{ row }"><el-tag :type="row.isReceive ? 'success' : 'warning'">{{ row.isReceive ? '已领取' : '待领取' }}</el-tag></template></el-table-column>
            <el-table-column label="处理" width="100"><template #default="{ row }"><el-tag v-if="row.type === 6" :type="row.isDeliver ? 'success' : 'warning'">{{ row.isDeliver ? '已发货' : '待发货' }}</el-tag><span v-else>自动</span></template></el-table-column>
            <el-table-column label="备注" min-width="160"><template #default="{ row }">{{ row.deliver_info.mark || '—' }}</template></el-table-column>
            <el-table-column v-if="canManage" label="操作" width="110"><template #default="{ row }"><el-button link type="primary" :disabled="detailLoading || delivering" @click="openDeliver(row)">{{ row.type === 6 ? '发货 / 备注' : '备注' }}</el-button></template></el-table-column>
          </el-table>
        </div>
        <el-pagination :current-page="page" :page-size="15" :total="count" :disabled="loading" layout="total, prev, pager, next" class="pagination" @current-change="load" />
      </el-card>
    </template>
    <el-dialog v-if="canManage" v-model="deliverVisible" title="中奖记录处理" width="min(480px, 94vw)" destroy-on-close>
      <el-form :model="deliverForm" label-width="90px">
        <el-form-item v-if="deliverRecord?.type === 6" label="快递公司"><el-input v-model="deliverForm.deliver_name" maxlength="64" /></el-form-item>
        <el-form-item v-if="deliverRecord?.type === 6" label="快递单号"><el-input v-model="deliverForm.deliver_number" maxlength="64" /></el-form-item>
        <el-form-item label="处理备注"><el-input v-model="deliverForm.mark" type="textarea" maxlength="255" show-word-limit :rows="3" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="deliverVisible = false">取消</el-button><el-button type="primary" :loading="delivering" @click="submitDeliver">确认处理</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import { apiLotteryDeliver, apiLotteryRecordFulfillment, apiLotteryRecords, shanghaiLotteryDay, type LotteryRecord, type LotteryRecordQuery } from "@/api/lottery";

const factors = [
  { value: 1, label: "积分" }, { value: 2, label: "余额" }, { value: 3, label: "订单支付" },
  { value: 4, label: "订单评价" }, { value: 5, label: "邀请 / 关注" },
];
const prizeTypes = [
  { value: 2, label: "积分" }, { value: 3, label: "余额" }, { value: 4, label: "历史红包" },
  { value: 5, label: "优惠券" }, { value: 6, label: "商品" }, { value: 7, label: "等级经验" },
  { value: 9, label: "SVIP 天数" },
];
const auth = useAuthStore();
const route = useRoute();
const has = (permission: string) => !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes(permission));
const canView = computed(() => !!auth.token && auth.token === getToken() && (has("lottery_record.view") || has("lottery_record.manage")));
const canManage = computed(() => canView.value && has("lottery_record.manage"));
const canActivityView = computed(() => canView.value && (has("lottery.view") || has("lottery.manage")));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? -1}:${auth.uniqueAuth.join(",")}`);
const routeScope = computed(() => {
  const raw = route.query.lottery_id;
  if (raw === undefined) return { id: undefined as number | undefined, error: "" };
  if (typeof raw !== "string" || !/^[1-9]\d{0,9}$/u.test(raw) || Number(raw) > 2_147_483_647) {
    return { id: undefined, error: "活动 ID 无效，请从抽奖活动列表重新进入" };
  }
  return { id: Number(raw), error: "" };
});
const draftLotteryId = ref("");
const draftFactor = ref<number | undefined>();
const draftType = ref<number | undefined>();
const draftKeyword = ref("");
const draftDates = ref<string[]>([]);
const draftReceive = ref<0 | 1 | undefined>();
const draftDeliver = ref<0 | 1 | undefined>();
const filters = ref<Omit<LotteryRecordQuery, "page" | "limit">>({});
const records = ref<LotteryRecord[]>([]);
const count = ref(0);
const page = ref(1);
const loading = ref(false);
const errorMessage = ref("");
const deliverVisible = ref(false);
const detailLoading = ref(false);
const delivering = ref(false);
const deliverRecord = ref<LotteryRecord | null>(null);
const deliverForm = reactive({ id: 0, deliver_name: "", deliver_number: "", mark: "" });
const deliverOriginal = reactive({ deliver_name: "", deliver_number: "", mark: "" });
let mounted = false;
let generation = 0;
let pending: AbortController | null = null;
let detailGeneration = 0;
let detailPending: AbortController | null = null;
let storedSession = localStorage.getItem("admin_session");

function active(stamp: string, scopeId?: number): boolean {
  return mounted && canView.value && sessionKey.value === stamp && storedSessionMatches() && routeScope.value.id === scopeId && !routeScope.value.error;
}

function storedSessionMatches(): boolean {
  const stored = getAdminSession();
  const key = `${getToken() ?? ""}:${stored?.userInfo.id ?? 0}:${stored?.userInfo.level ?? -1}:${stored?.uniqueAuth.join(",") ?? ""}`;
  if (key === sessionKey.value && storedSession === localStorage.getItem("admin_session")) return true;
  syncSession();
  return false;
}

function discard() {
  generation++;
  pending?.abort();
  pending = null;
  detailGeneration++;
  detailPending?.abort();
  detailPending = null;
  detailLoading.value = false;
  records.value = [];
  count.value = 0;
  page.value = 1;
  loading.value = false;
  errorMessage.value = "";
  deliverVisible.value = false;
  deliverRecord.value = null;
  delivering.value = false;
  Object.assign(deliverForm, { id: 0, deliver_name: "", deliver_number: "", mark: "" });
  Object.assign(deliverOriginal, { deliver_name: "", deliver_number: "", mark: "" });
}

function syncSession() {
  const previous = sessionKey.value;
  const nextStored = localStorage.getItem("admin_session");
  const changed = storedSession !== nextStored;
  storedSession = nextStored;
  if (changed) discard();
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  if (changed && mounted && previous === sessionKey.value && canView.value && !routeScope.value.error) void load(1);
}

function onStorage(event: StorageEvent) {
  if (event.key === "admin_token" || event.key === "admin_session" || event.key === null) syncSession();
}

async function load(targetPage = page.value) {
  if (!mounted || !canView.value || !storedSessionMatches() || routeScope.value.error || !Number.isSafeInteger(targetPage) || targetPage < 1 || targetPage > 10_000) return;
  const stamp = sessionKey.value;
  const scopeId = routeScope.value.id;
  const current = ++generation;
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  loading.value = true;
  errorMessage.value = "";
  records.value = [];
  count.value = 0;
  try {
    const result = await apiLotteryRecords({ ...filters.value, lottery_id: scopeId ?? filters.value.lottery_id,
      page: targetPage, limit: 15 }, scopeId, controller.signal);
    if (!active(stamp, scopeId) || current !== generation) return;
    records.value = result.list;
    count.value = result.count;
    page.value = targetPage;
  } catch (error) {
    if (active(stamp, scopeId) && current === generation && !controller.signal.aborted) {
      errorMessage.value = error instanceof Error ? error.message : "加载中奖记录失败";
    }
  } finally { if (current === generation) { pending = null; loading.value = false; } }
}

function search() {
  if (!canView.value || !storedSessionMatches() || routeScope.value.error) return;
  try {
    const rawId = String(draftLotteryId.value ?? "").trim();
    if (!routeScope.value.id && rawId && (!/^[1-9]\d{0,9}$/u.test(rawId) || Number(rawId) > 2_147_483_647)) throw new Error("活动 ID 无效");
    const dates = Array.isArray(draftDates.value) ? draftDates.value : [];
    if (dates.length !== 0 && dates.length !== 2) throw new Error("请选择完整的抽奖日期范围");
    const start = dates.length ? shanghaiLotteryDay(dates[0]) : undefined;
    const end = dates.length ? shanghaiLotteryDay(dates[1], true) : undefined;
    if (start !== undefined && end !== undefined && (end < start || end - start > 366 * 86_400)) throw new Error("抽奖日期范围无效");
    filters.value = { lottery_id: routeScope.value.id ?? (rawId ? Number(rawId) : undefined),
      factor: [1, 2, 3, 4, 5].includes(Number(draftFactor.value)) ? Number(draftFactor.value) : undefined,
      type: [2, 3, 4, 5, 6, 7, 9].includes(Number(draftType.value)) ? Number(draftType.value) : undefined,
      keyword: String(draftKeyword.value ?? "").trim(), start_time: start, end_time: end,
      is_receive: draftReceive.value === 0 || draftReceive.value === 1 ? draftReceive.value : undefined,
      is_deliver: draftDeliver.value === 0 || draftDeliver.value === 1 ? draftDeliver.value : undefined };
    void load(1);
  } catch (error) { errorMessage.value = error instanceof Error ? error.message : "筛选条件无效"; }
}

function reset() {
  draftLotteryId.value = "";
  draftFactor.value = undefined;
  draftType.value = undefined;
  draftKeyword.value = "";
  draftDates.value = [];
  draftReceive.value = undefined;
  draftDeliver.value = undefined;
  filters.value = {};
  void load(1);
}

function prizeTypeLabel(type: number): string { return prizeTypes.find(item => item.value === type)?.label ?? "未知奖品"; }
function formatTime(seconds: number): string {
  return seconds ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(seconds * 1000)) : "—";
}

async function openDeliver(row: LotteryRecord) {
  if (!mounted || !canManage.value || !storedSessionMatches() || detailLoading.value || delivering.value || !records.value.some(item => item.id === row.id)) return;
  const stamp = sessionKey.value;
  const scopeId = routeScope.value.id;
  const current = ++detailGeneration;
  detailPending?.abort();
  const controller = new AbortController();
  detailPending = controller;
  detailLoading.value = true;
  try {
    const detail = await apiLotteryRecordFulfillment(row.id, controller.signal);
    if (!active(stamp, scopeId) || !canManage.value || current !== detailGeneration ||
      !records.value.some(item => item.id === row.id) || detail.type !== row.type) return;
    deliverRecord.value = row;
    Object.assign(deliverForm, { id: row.id, deliver_name: detail.deliver_info.deliver_name,
      deliver_number: detail.deliver_info.deliver_number, mark: detail.deliver_info.mark });
    Object.assign(deliverOriginal, detail.deliver_info);
    deliverVisible.value = true;
  } catch (error) {
    if (active(stamp, scopeId) && current === detailGeneration && !controller.signal.aborted) {
      ElMessage.error((error as Error).message || "加载中奖记录详情失败");
    }
  } finally { if (current === detailGeneration) { detailPending = null; detailLoading.value = false; } }
}

async function submitDeliver() {
  if (!mounted || !canManage.value || !storedSessionMatches() || !deliverVisible.value || !deliverRecord.value || delivering.value ||
    deliverForm.id !== deliverRecord.value.id || !records.value.some(item => item.id === deliverForm.id)) return;
  const name = deliverRecord.value.type === 6 ? deliverForm.deliver_name.trim() : "";
  const number = deliverRecord.value.type === 6 ? deliverForm.deliver_number.trim() : "";
  if (!!name !== !!number) { ElMessage.error("请填写完整快递公司和单号"); return; }
  const shippingChanged = deliverRecord.value.type === 6 && !!name &&
    (deliverRecord.value.isDeliver === 0 || name !== deliverOriginal.deliver_name || number !== deliverOriginal.deliver_number);
  const mark = deliverForm.mark.trim();
  const payload = { id: deliverForm.id, mark: mark !== deliverOriginal.mark ? mark : "",
    deliver_name: shippingChanged ? name : "", deliver_number: shippingChanged ? number : "" };
  if (!payload.deliver_name && !payload.mark) { ElMessage.error("请填写快递信息或修改处理备注"); return; }
  const stamp = sessionKey.value;
  const scopeId = routeScope.value.id;
  delivering.value = true;
  try {
    await apiLotteryDeliver(payload);
    if (!active(stamp, scopeId) || !canManage.value) return;
    ElMessage.success("中奖记录已处理");
    deliverVisible.value = false;
    await load(page.value);
  } catch (error) { if (active(stamp, scopeId) && canManage.value) ElMessage.error((error as Error).message || "处理失败"); }
  finally { delivering.value = false; }
}

watch(sessionKey, () => { discard(); if (mounted && canView.value && !routeScope.value.error) void load(1); });
watch(() => route.query.lottery_id, () => { discard(); reset(); });
onMounted(() => {
  mounted = true;
  window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession);
  window.addEventListener("storage", onStorage);
  const previous = sessionKey.value;
  syncSession();
  if (previous === sessionKey.value && canView.value && !routeScope.value.error) void load(1);
});
onBeforeUnmount(() => {
  mounted = false;
  window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession);
  window.removeEventListener("storage", onStorage);
  discard();
});
</script>

<style scoped>
.lottery-records { display: grid; gap: 16px; min-width: 0; }
.heading, .scope-bar, .filters, .filter-actions { display: flex; flex-wrap: wrap; gap: 12px; }
.heading, .scope-bar { align-items: center; justify-content: space-between; }
.heading h2 { margin: 0; color: #172033; font-size: 22px; }
.heading p { margin: 5px 0 0; color: #737985; font-size: 13px; }
.scope-bar { margin-bottom: 16px; }
.filters { align-items: end; margin-bottom: 16px; }
.filter-field { display: flex; flex: 1 1 150px; flex-direction: column; gap: 6px; min-width: 0; font-size: 13px; }
.filter-field.wide { flex-basis: 240px; }
.filter-field.narrow { flex-basis: 110px; }
.filter-field :deep(.el-select), .filter-field :deep(.el-input), .filter-field :deep(.el-date-editor) { width: 100%; }
.notice { margin-bottom: 14px; }
.table-scroll { max-width: 100%; overflow-x: auto; }
.prize-cell { display: flex; align-items: center; gap: 8px; }
.prize-cell :deep(.el-image) { flex: none; width: 36px; height: 36px; border-radius: 5px; }
.block { display: block; margin-top: 3px; color: #8991a3; font-size: 12px; }
.pagination { display: flex; justify-content: flex-end; margin-top: 16px; flex-wrap: wrap; }
@media (max-width: 640px) { .filters { display: grid; grid-template-columns: minmax(0, 1fr); } .pagination { justify-content: center; } }
</style>
