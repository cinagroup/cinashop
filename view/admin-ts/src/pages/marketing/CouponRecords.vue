<template>
  <div class="coupon-records">
    <el-card shadow="never">
      <template #header>
        <div class="heading">
          <div>
            <strong>用户领取记录</strong>
            <p class="hint">查看已领取优惠券的历史状态和领取方式。</p>
          </div>
          <el-button v-if="canView" :loading="loading" @click="loadList(page)">刷新</el-button>
        </div>
      </template>
      <el-alert v-if="!canView" title="当前账号没有领取记录查看权限" type="warning" :closable="false" show-icon />
      <template v-else>
        <div class="filters">
          <label class="filter-field status-field">
            <span>状态</span>
            <el-select v-model="draftStatus" aria-label="领取记录状态" placeholder="全部状态" clearable>
              <el-option label="未使用" value="0" />
              <el-option label="已使用" value="1" />
              <el-option label="已过期" value="2" />
              <el-option label="未支付订单占用中" value="3" />
            </el-select>
          </label>
          <label class="filter-field">
            <span>领取人</span>
            <el-input v-model="draftNickname" aria-label="领取人" clearable maxlength="100" placeholder="用户 ID / 姓名 / 昵称 / 手机号" @keyup.enter="search" />
          </label>
          <label class="filter-field">
            <span>优惠券名称</span>
            <el-input v-model="draftCouponTitle" aria-label="优惠券名称" clearable maxlength="100" placeholder="输入优惠券名称" @keyup.enter="search" />
          </label>
          <div class="filter-actions">
            <el-button type="primary" :loading="loading" @click="search">查询</el-button>
            <el-button :disabled="loading" @click="reset">重置</el-button>
          </div>
        </div>

        <el-alert v-if="errorMessage" :title="errorMessage" type="error" :closable="false" show-icon class="notice">
          <template #default><el-button link type="primary" @click="loadList(page)">重试列表</el-button></template>
        </el-alert>
        <div class="table-scroll">
          <el-table :data="list" v-loading="loading" stripe row-key="id" empty-text="暂无领取记录">
            <el-table-column prop="id" label="ID" width="85" />
            <el-table-column prop="coupon_title" label="优惠券名称" min-width="150" />
            <el-table-column label="领取人" min-width="130">
              <template #default="{ row }">{{ row.nickname || `用户 #${row.uid}` }}</template>
            </el-table-column>
            <el-table-column label="面值" min-width="150">
              <template #default="{ row }">{{ formatFace(row) }}</template>
            </el-table-column>
            <el-table-column prop="use_min_price" label="最低消费额" min-width="120" />
            <el-table-column label="开始使用时间" min-width="165">
              <template #default="{ row }">{{ formatTime(row.start_time) }}</template>
            </el-table-column>
            <el-table-column label="结束使用时间" min-width="165">
              <template #default="{ row }">{{ formatTime(row.end_time) }}</template>
            </el-table-column>
            <el-table-column prop="receive_source_label" label="获取方式" min-width="130" />
            <el-table-column label="是否可用" min-width="100">
              <template #default="{ row }"><el-tag :type="row.is_fail === 0 ? 'success' : 'danger'" size="small">{{ row.is_fail === 0 ? '有效' : '失效' }}</el-tag></template>
            </el-table-column>
            <el-table-column label="状态" min-width="150">
              <template #default="{ row }"><el-tag :type="row.status === 0 ? 'success' : row.status === 3 ? 'warning' : 'info'" size="small">{{ row.status_label }}</el-tag></template>
            </el-table-column>
          </el-table>
        </div>
        <el-pagination :current-page="page" :page-size="PAGE_SIZE" :total="count" :disabled="loading" layout="total, prev, pager, next" class="pager" @current-change="loadList" />
      </template>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import { apiAdminCouponRecords, type CouponRecordQuery, type CouponRecordRow } from "@/api/couponRecords";

const PAGE_SIZE = 15;
const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes("coupon_record.view")));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.uniqueAuth.join(",")}`);
const draftStatus = ref("");
const draftNickname = ref("");
const draftCouponTitle = ref("");
const filters = ref<Omit<CouponRecordQuery, "page" | "limit">>({});
const list = ref<CouponRecordRow[]>([]);
const count = ref(0);
const page = ref(1);
const loading = ref(false);
const errorMessage = ref("");
let mounted = false;
let generation = 0;
let pending: AbortController | null = null;

function active(stamp: string): boolean {
  return mounted && canView.value && sessionKey.value === stamp && auth.token === getToken();
}

function discard() {
  generation++;
  pending?.abort();
  pending = null;
  list.value = [];
  count.value = 0;
  loading.value = false;
  errorMessage.value = "";
}

async function loadList(targetPage = page.value): Promise<void> {
  if (!mounted || !canView.value) return;
  const stamp = sessionKey.value;
  const current = ++generation;
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  loading.value = true;
  errorMessage.value = "";
  list.value = [];
  count.value = 0;
  try {
    const result = await apiAdminCouponRecords({ ...filters.value, page: targetPage, limit: PAGE_SIZE }, controller.signal);
    if (!active(stamp) || current !== generation) return;
    if (result.page !== targetPage || result.limit !== PAGE_SIZE) throw new Error("领取记录分页结果与请求不一致");
    list.value = result.list;
    count.value = result.count;
    page.value = targetPage;
  } catch (error) {
    if (active(stamp) && current === generation && !controller.signal.aborted) {
      errorMessage.value = error instanceof Error ? error.message : "加载领取记录失败";
    }
  } finally {
    if (current === generation) { pending = null; loading.value = false; }
  }
}

function search() {
  const status = draftStatus.value === "" ? undefined : Number(draftStatus.value) as 0 | 1 | 2 | 3;
  filters.value = { status, nickname: draftNickname.value.trim(), coupon_title: draftCouponTitle.value.trim() };
  void loadList(1);
}

function reset() {
  draftStatus.value = "";
  draftNickname.value = "";
  draftCouponTitle.value = "";
  filters.value = {};
  void loadList(1);
}

function formatFace(row: CouponRecordRow): string {
  if (row.coupon_type === 1) return `${row.coupon_price}元`;
  if (row.coupon_type === 2) {
    const percent = Number(row.coupon_price);
    return `${percent / 10}折（${row.coupon_price.split(".")[0]}%）`;
  }
  return "—";
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  return new Date(Date.parse(value) + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function syncSession() {
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
}

watch(sessionKey, () => {
  discard();
  if (mounted && canView.value) void loadList(1);
});
onMounted(() => {
  mounted = true;
  window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession);
  const previous = sessionKey.value;
  syncSession();
  if (previous === sessionKey.value && canView.value) void loadList(1);
});
onBeforeUnmount(() => {
  mounted = false;
  window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession);
  discard();
});
</script>

<style scoped>
.coupon-records { min-width: 0; }
.heading, .filters { display: flex; gap: 12px; flex-wrap: wrap; }
.heading { align-items: center; justify-content: space-between; }
.hint { margin: 4px 0 0; color: #737985; font-size: 12px; }
.filters { align-items: end; margin-bottom: 18px; }
.filter-field { display: flex; flex: 1 1 200px; flex-direction: column; gap: 6px; min-width: 0; font-size: 13px; }
.status-field { flex: 0 1 180px; }
.filter-field :deep(.el-input), .filter-field :deep(.el-select) { width: 100%; }
.filter-actions { display: flex; gap: 8px; }
.notice { margin-bottom: 14px; }
.table-scroll { max-width: 100%; overflow-x: auto; }
.pager { margin-top: 16px; justify-content: flex-end; flex-wrap: wrap; }
@media (max-width: 600px) { .filters { display: grid; grid-template-columns: minmax(0, 1fr); } .pager { justify-content: center; } }
</style>
