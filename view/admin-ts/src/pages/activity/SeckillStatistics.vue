<template>
  <div class="seckill-statistics">
    <div class="heading">
      <div>
        <el-button v-if="canActivityList" link type="primary" @click="back">← 营销活动</el-button>
        <h2>秒杀统计 <small v-if="head">#{{ head.id }} · {{ head.store_name }}</small></h2>
        <p class="hint">查看指定秒杀商品的参与人、已支付订单与历史汇总。</p>
      </div>
      <el-button v-if="canView" :loading="headLoading || listLoading" @click="reload">刷新</el-button>
    </div>

    <el-alert v-if="!canView" title="当前账号没有秒杀统计查看权限" type="warning" :closable="false" show-icon />
    <div v-else-if="!validId()" class="id-chooser">
      <el-alert title="输入秒杀商品 ID 查看统计" type="info" :closable="false" show-icon />
      <el-input v-model="idInput" aria-label="秒杀商品 ID" inputmode="numeric" maxlength="10" placeholder="秒杀商品 ID" @keyup.enter="openId" />
      <el-button type="primary" @click="openId">打开统计</el-button>
      <p v-if="idError" class="id-error">{{ idError }}</p>
    </div>
    <template v-else>
      <el-alert v-if="headError" :title="headError" type="error" :closable="false" show-icon class="notice">
        <template #default><el-button link type="primary" @click="loadHead">重试汇总</el-button></template>
      </el-alert>
      <el-row :gutter="12" class="cards" v-loading="headLoading">
        <el-col v-for="card in cards" :key="card.label" :xs="12" :sm="12" :md="6">
          <el-card shadow="never" class="metric">
            <p class="metric-label">{{ card.label }}</p>
            <strong>{{ card.value }}</strong>
          </el-card>
        </el-col>
      </el-row>
      <p class="hint stock-note">库存按旧页口径展示“剩余额度 / 展示总额度”，旧接口字段 pay_rate 并非支付转化率。</p>

      <el-card shadow="never">
        <el-tabs v-model="tab" @tab-change="changeTab">
          <el-tab-pane label="活动参与人" name="people" />
          <el-tab-pane label="活动订单" name="orders" />
        </el-tabs>
        <div class="filters">
          <label class="filter-field">
            <span>搜索</span>
            <el-input v-model="draftKeyword" aria-label="秒杀统计搜索" maxlength="100" clearable
              :placeholder="tab === 'people' ? '用户姓名 / 手机号 / UID' : '订单号 / 订单姓名 / 订单电话 / UID'" @keyup.enter="search" />
          </label>
          <label v-if="tab === 'orders'" class="filter-field status-field">
            <span>订单状态</span>
            <el-select v-model="draftStatus" aria-label="秒杀订单状态" clearable placeholder="全部状态">
              <el-option label="未支付（此页无数据）" value="0" />
              <el-option label="待发货" value="1" />
              <el-option label="待收货" value="2" />
              <el-option label="待评价" value="3" />
              <el-option label="交易完成" value="4" />
            </el-select>
          </label>
          <div class="actions">
            <el-button type="primary" :loading="listLoading" @click="search">查询</el-button>
            <el-button :disabled="listLoading" @click="reset">重置</el-button>
          </div>
        </div>
        <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon class="notice">
          <template #default><el-button link type="primary" @click="loadList(requestedPage)">重试列表</el-button></template>
        </el-alert>
        <div class="table-scroll">
          <el-table v-if="tab === 'people'" :data="people" v-loading="listLoading" border row-key="uid" empty-text="暂无参与人">
            <el-table-column prop="real_name" label="用户姓名" min-width="130" />
            <el-table-column prop="uid" label="UID" min-width="90" />
            <el-table-column prop="goods_num" label="购买件数" min-width="100" />
            <el-table-column prop="order_num" label="支付订单数" min-width="110" />
            <el-table-column prop="total_price" label="支付金额（元）" min-width="130" />
            <el-table-column label="最近参与时间" min-width="170">
              <template #default="{ row }">{{ formatTime(row.add_time) }}</template>
            </el-table-column>
          </el-table>
          <el-table v-else :data="orders" v-loading="listLoading" border row-key="id" empty-text="暂无订单">
            <el-table-column prop="order_id" label="订单号" min-width="220" />
            <el-table-column prop="real_name" label="用户" min-width="130" />
            <el-table-column prop="status" label="订单状态" min-width="105" />
            <el-table-column prop="pay_price" label="支付金额（元）" min-width="135" />
            <el-table-column prop="total_num" label="商品数" min-width="90" />
            <el-table-column label="下单时间" min-width="170">
              <template #default="{ row }">{{ formatTime(row.add_time) }}</template>
            </el-table-column>
            <el-table-column label="支付时间" min-width="170">
              <template #default="{ row }">{{ formatTime(row.pay_time) }}</template>
            </el-table-column>
          </el-table>
        </div>
        <el-pagination :current-page="page" :page-size="PAGE_SIZE" :total="count" :disabled="listLoading"
          layout="total, prev, pager, next" class="pager" @current-change="loadList" />
        <p v-if="tab === 'orders'" class="hint">订单列表及总数统一统计已支付主单；旧页的总数曾包含其他订单，可能出现分页不一致。搜索限于订单号、订单姓名、订单电话和 UID。</p>
      </el-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import { apiSeckillStatisticsHead, apiSeckillStatisticsPeople, apiSeckillStatisticsOrders,
  type SeckillStatisticsHead, type SeckillParticipant, type SeckillOrder, type SeckillStatisticsQuery } from "@/api/seckillStatistics";

const PAGE_SIZE = 15;
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const id = computed(() => Number(route.params.id));
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes("seckill_statistics.view")));
const canActivityList = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes("activity.view")));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.uniqueAuth.join(",")}`);
const idInput = ref("");
const idError = ref("");
const head = ref<SeckillStatisticsHead | null>(null);
const headLoading = ref(false);
const headError = ref("");
const tab = ref<"people" | "orders">("people");
const draftKeyword = ref("");
const draftStatus = ref("");
const keyword = ref("");
const status = ref<0 | 1 | 2 | 3 | 4 | undefined>();
const people = ref<SeckillParticipant[]>([]);
const orders = ref<SeckillOrder[]>([]);
const count = ref(0);
const page = ref(1);
const requestedPage = ref(1);
const listLoading = ref(false);
const listError = ref("");
let mounted = false;
let generation = 0;
let headAbort: AbortController | null = null;
let listAbort: AbortController | null = null;

const cards = computed(() => [
  { label: "下单人数（人）", value: head.value?.order_count ?? "—" },
  { label: "支付订单额（元）", value: head.value?.all_price ?? "—" },
  { label: "支付人数（人）", value: head.value?.pay_count ?? "—" },
  { label: "剩余额度 / 展示总额度", value: head.value?.pay_rate ?? "—" },
]);

function validId() { return Number.isSafeInteger(id.value) && id.value > 0 && id.value <= 2_147_483_647; }
function active(stamp: string, requestedId: number) {
  return mounted && canView.value && sessionKey.value === stamp && id.value === requestedId && auth.token === getToken();
}
function discard() {
  generation++;
  headAbort?.abort(); listAbort?.abort();
  headAbort = null; listAbort = null;
  head.value = null; people.value = []; orders.value = []; count.value = 0; page.value = 1; requestedPage.value = 1;
  headLoading.value = false; listLoading.value = false; headError.value = ""; listError.value = "";
}

async function loadHead() {
  if (!mounted || !canView.value) return;
  if (!validId()) return;
  const stamp = sessionKey.value;
  const requestedId = id.value;
  const current = generation;
  headAbort?.abort();
  const controller = new AbortController();
  headAbort = controller; headLoading.value = true; headError.value = "";
  try {
    const result = await apiSeckillStatisticsHead(requestedId, controller.signal);
    if (active(stamp, requestedId) && current === generation && !controller.signal.aborted) head.value = result;
  } catch (error) {
    if (active(stamp, requestedId) && current === generation && !controller.signal.aborted)
      headError.value = error instanceof Error ? error.message : "加载汇总失败";
  } finally {
    if (headAbort === controller) { headAbort = null; headLoading.value = false; }
  }
}

async function loadList(targetPage = page.value) {
  if (!mounted || !canView.value) return;
  if (!validId()) return;
  requestedPage.value = targetPage;
  const stamp = sessionKey.value;
  const requestedId = id.value;
  const current = generation;
  const requestedTab = tab.value;
  listAbort?.abort();
  const controller = new AbortController();
  listAbort = controller; listLoading.value = true; listError.value = "";
  people.value = []; orders.value = []; count.value = 0;
  const query: SeckillStatisticsQuery = { page: targetPage, limit: PAGE_SIZE, real_name: keyword.value };
  if (requestedTab === "orders") query.status = status.value;
  try {
    const result = requestedTab === "people"
      ? await apiSeckillStatisticsPeople(requestedId, query, controller.signal)
      : await apiSeckillStatisticsOrders(requestedId, query, controller.signal);
    if (!active(stamp, requestedId) || current !== generation || requestedTab !== tab.value || controller.signal.aborted) return;
    if (result.page !== targetPage || result.limit !== PAGE_SIZE || !Number.isSafeInteger(result.count) || result.count < 0) throw new Error("统计分页结果无效");
    if (requestedTab === "people") people.value = result.list as SeckillParticipant[];
    else orders.value = result.list as SeckillOrder[];
    count.value = result.count; page.value = targetPage;
  } catch (error) {
    if (active(stamp, requestedId) && current === generation && requestedTab === tab.value && !controller.signal.aborted)
      listError.value = error instanceof Error ? error.message : "加载列表失败";
  } finally {
    if (listAbort === controller) { listAbort = null; listLoading.value = false; }
  }
}

function reload() { discard(); if (canView.value) { void loadHead(); void loadList(1); } }
function changeTab() { listAbort?.abort(); page.value = 1; count.value = 0; people.value = []; orders.value = []; void loadList(1); }
function search() {
  keyword.value = draftKeyword.value.trim();
  status.value = draftStatus.value === "" ? undefined : Number(draftStatus.value) as 0 | 1 | 2 | 3 | 4;
  void loadList(1);
}
function reset() { draftKeyword.value = ""; draftStatus.value = ""; keyword.value = ""; status.value = undefined; void loadList(1); }
function back() { void router.push("/activity"); }
function openId() {
  const value = idInput.value.trim();
  if (!/^[1-9]\d*$/u.test(value) || Number(value) > 2_147_483_647) { idError.value = "请输入有效的秒杀商品 ID"; return; }
  idError.value = "";
  void router.push({ name: "seckill-statistics", params: { id: value } });
}
function formatTime(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) return "—";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value * 1000);
}
function syncSession() {
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
}

watch([sessionKey, id], () => { if (mounted) reload(); });
onMounted(() => {
  mounted = true;
  window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession);
  const previous = sessionKey.value;
  syncSession();
  if (previous === sessionKey.value) reload();
});
onBeforeUnmount(() => {
  mounted = false;
  window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession);
  discard();
});
</script>

<style scoped>
.seckill-statistics { min-width: 0; }
.heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.heading h2 { margin: 6px 0; }
.heading h2 small { font-size: 14px; font-weight: 400; color: #737985; }
.hint { color: #737985; font-size: 12px; margin: 5px 0; }
.cards { margin-bottom: 5px; }
.metric { margin-bottom: 12px; }
.metric-label { font-size: 12px; color: #737985; margin: 0 0 8px; }
.metric strong { font-size: 21px; overflow-wrap: anywhere; }
.stock-note { margin-bottom: 18px; }
.filters { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; margin: 12px 0 18px; }
.filter-field { display: flex; flex: 1 1 220px; min-width: 0; flex-direction: column; gap: 6px; font-size: 13px; }
.status-field { flex: 0 1 210px; }
.filter-field :deep(.el-input), .filter-field :deep(.el-select) { width: 100%; }
.actions { display: flex; gap: 8px; }
.notice { margin-bottom: 12px; }
.id-chooser { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.id-chooser :deep(.el-alert) { flex: 1 0 100%; }
.id-chooser :deep(.el-input) { width: min(260px, 100%); }
.id-error { color: #c45656; font-size: 13px; }
.table-scroll { max-width: 100%; overflow-x: auto; }
.pager { margin: 16px 0 8px; justify-content: flex-end; flex-wrap: wrap; }
@media (max-width: 600px) { .filters { display: grid; grid-template-columns: minmax(0, 1fr); } .pager { justify-content: center; } }
</style>
