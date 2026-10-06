<template>
  <div class="lottery-page">
    <div class="page-head">
      <div>
        <h2>抽奖活动</h2>
        <p>配置活动、8 个奖位与中奖履约；同一参与条件仅允许一个活动启用。</p>
      </div>
      <div class="head-actions">
        <router-link v-if="canRecordView" to="/marketing/lottery-records">中奖记录</router-link>
        <el-button v-if="canManage" type="primary" :disabled="saving" @click="openForm()">＋ 新建抽奖</el-button>
      </div>
    </div>

    <el-alert v-if="!canView" title="当前账号没有抽奖活动查看权限" type="warning" :closable="false" show-icon />
    <template v-else>
    <div class="summary-grid">
      <div class="summary-card"><span>匹配活动数</span><strong>{{ total }}</strong></div>
      <div class="summary-card"><span>当前页启用</span><strong>{{ enabledCount }}</strong></div>
      <div class="summary-card"><span>当前页进行中</span><strong>{{ runningCount }}</strong></div>
      <div class="summary-card warning"><span>安全策略</span><strong>红包停建</strong></div>
    </div>

    <el-card shadow="never">
      <div class="filters">
        <el-input v-model="query.name" clearable maxlength="100" placeholder="搜索活动名称或 ID" style="width: 220px" @keyup.enter="search" />
        <el-select v-model="query.factor" clearable placeholder="参与条件" style="width: 180px">
          <el-option v-for="item in factors" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-select v-model="query.status" clearable placeholder="上下架状态" style="width: 140px">
          <el-option label="启用" :value="1" />
          <el-option label="停用" :value="0" />
        </el-select>
        <el-select v-model="query.startStatus" clearable placeholder="活动阶段" style="width: 140px">
          <el-option label="未开始" :value="0" />
          <el-option label="进行中" :value="1" />
          <el-option label="已结束" :value="-1" />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="resetQuery">重置</el-button>
      </div>

      <el-table :data="list" v-loading="loading" border>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column label="活动" min-width="240">
          <template #default="{ row }">
            <div class="activity-cell">
              <el-image :src="row.image" fit="cover" class="activity-image">
                <template #error><div class="image-fallback">奖</div></template>
              </el-image>
              <div><strong>{{ row.name }}</strong><small>{{ row.desc || "暂无活动描述" }}</small></div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="参与条件" width="150">
          <template #default="{ row }">{{ row.lottery_type || factorLabel(row.factor) }} · {{ row.factorNum }}</template>
        </el-table-column>
        <el-table-column label="活动时间" width="220">
          <template #default="{ row }">
            <div class="time-range"><span>{{ formatTime(row.startTime) }}</span><span>{{ formatTime(row.endTime) }}</span></div>
          </template>
        </el-table-column>
        <el-table-column label="进度" width="100">
          <template #default="{ row }">
            <el-tag :type="timeTag(row.time_status)">{{ timeLabel(row.time_status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? "启用" : "停用" }}</el-tag></template>
        </el-table-column>
        <el-table-column prop="lottery_all" label="参与次数" width="100" />
        <el-table-column prop="lottery_people" label="参与人数" width="100" />
        <el-table-column prop="lottery_win" label="中奖人数" width="100" />
        <el-table-column label="操作" fixed="right" width="250">
          <template #default="{ row }">
            <router-link v-if="canRecordView" :to="{ path: '/marketing/lottery-records', query: { lottery_id: String(row.id) } }">记录</router-link>
            <el-button v-if="canManage" link type="primary" @click="openForm(row)">编辑</el-button>
            <el-button v-if="canManage" link :type="row.status === 1 ? 'warning' : 'success'" @click="toggleStatus(row)">{{ row.status === 1 ? "停用" : "启用" }}</el-button>
            <el-button v-if="canManage" link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && !list.length" description="暂无抽奖活动" />
      <div class="pagination"><el-pagination :current-page="query.page" :page-size="15" :total="total" :disabled="loading" layout="prev, pager, next, total" @current-change="load" /></div>
    </el-card>

    <el-dialog v-if="canManage" v-model="formVisible" :title="form.id ? '编辑抽奖活动' : '新建抽奖活动'" width="min(1040px, 94vw)" destroy-on-close>
      <el-alert title="奖品库存、用户扣款与发奖在一个数据库事务内完成。微信红包和未明确等级的奖品暂不允许新建。" type="info" :closable="false" show-icon />
      <el-tabs v-model="formTab" class="form-tabs">
        <el-tab-pane label="活动设置" name="activity">
          <el-form :model="form" label-width="110px" class="activity-form">
            <el-form-item label="活动名称" required><el-input v-model="form.name" maxlength="255" show-word-limit /></el-form-item>
            <el-form-item label="活动描述"><el-input v-model="form.desc" maxlength="255" /></el-form-item>
            <el-form-item label="背景图 URL" required><el-input v-model="form.image" placeholder="https://... 或 /static/..." /></el-form-item>
            <el-form-item label="展示样式"><el-radio-group v-model="form.type"><el-radio-button :value="1">九宫格</el-radio-button><el-radio-button :value="2">转盘</el-radio-button><el-radio-button :value="3">升级九宫格</el-radio-button><el-radio-button :value="4">翻牌</el-radio-button></el-radio-group></el-form-item>
            <el-form-item label="参与条件" required>
              <el-select v-model="form.factor" style="width: 220px"><el-option v-for="item in factors" :key="item.value" :label="item.label" :value="item.value" /></el-select>
              <el-input-number v-if="form.factor !== 5" v-model="form.factorNum" :min="1" :max="32767" class="inline-number" />
              <span class="field-hint">{{ factorHint(form.factor) }}</span>
            </el-form-item>
            <el-form-item label="活动时间" required><el-date-picker v-model="form.period" type="datetimerange" range-separator="至" start-placeholder="开始时间" end-placeholder="结束时间" /></el-form-item>
            <el-form-item label="积分次数限制" v-if="form.factor === 1">
              <el-input-number v-model="form.lotteryNum" :min="1" /><span class="field-hint">每天</span>
              <el-input-number v-model="form.totalLotteryNum" :min="form.lotteryNum" class="inline-number" /><span class="field-hint">每人总计</span>
            </el-form-item>
            <el-form-item label="邀请奖励" v-if="form.factor === 5"><el-input-number v-model="form.spreadNum" :min="1" /><span class="field-hint">次，最高 {{ form.lotteryNum }} 次</span></el-form-item>
            <el-form-item label="活动规则" required><el-input v-model="form.content" type="textarea" :rows="5" maxlength="200000" /></el-form-item>
            <el-form-item label="展示中奖记录"><el-switch v-model="form.isAllRecord" :active-value="1" :inactive-value="0" /><span class="field-hint">全站记录</span><el-switch v-model="form.isPersonalRecord" :active-value="1" :inactive-value="0" class="inline-switch" /><span class="field-hint">个人记录</span></el-form-item>
            <el-form-item label="启用"><el-switch v-model="form.status" :active-value="1" :inactive-value="0" /><span class="field-hint">启用后会停用同参与条件下的其他活动</span></el-form-item>
          </el-form>
        </el-tab-pane>
        <el-tab-pane label="8 个奖位" name="prizes">
          <el-table :data="form.prize" border class="prize-table">
            <el-table-column type="index" label="#" width="48" />
            <el-table-column label="类型" width="130"><template #default="{ row }"><el-select v-model="row.type"><el-option v-for="item in prizeTypes" :key="item.value" :label="item.label" :value="item.value" /></el-select></template></el-table-column>
            <el-table-column label="名称 / 图片" min-width="220"><template #default="{ row }"><el-input v-model="row.name" placeholder="奖品名称" /><el-input v-model="row.image" placeholder="图片 URL" class="cell-second" /></template></el-table-column>
            <el-table-column label="权重" width="105"><template #default="{ row }"><el-input-number v-model="row.chance" :min="0" :max="32767" controls-position="right" /></template></el-table-column>
            <el-table-column label="库存" width="105"><template #default="{ row }"><el-input-number v-model="row.total" :min="-1" :max="32767" controls-position="right" /><small class="stock-hint">-1 不限</small></template></el-table-column>
            <el-table-column label="数量 / 关联 ID" min-width="180"><template #default="{ row }"><el-input v-if="[2,3,7,9].includes(row.type)" v-model="row.num" placeholder="奖励数量" /><el-input-number v-else-if="row.type === 5" v-model="row.couponId" :min="1" placeholder="优惠券ID" /><el-input-number v-else-if="row.type === 6" v-model="row.productId" :min="1" placeholder="商品ID" /><span v-else class="muted">无需配置</span></template></el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
      <template #footer><el-button @click="formVisible = false">取消</el-button><el-button type="primary" :loading="saving" :disabled="formLoading" @click="save">保存活动</el-button></template>
    </el-dialog>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import {
  apiLotteryAdd,
  apiLotteryDelete,
  apiLotteryDetail,
  apiLotteryEdit,
  apiLotteryList,
  apiLotteryStatus,
  type LotteryActivity,
  type LotteryListQuery,
  type LotteryPrize,
} from "@/api/lottery";

const factors = [
  { value: 1, label: "积分" }, { value: 2, label: "余额" }, { value: 3, label: "支付订单" },
  { value: 4, label: "完成评价" }, { value: 5, label: "邀请好友" },
];
const prizeTypes = [
  { value: 1, label: "未中奖" }, { value: 2, label: "积分" }, { value: 3, label: "余额" },
  { value: 5, label: "优惠券" }, { value: 6, label: "站内商品" },
  { value: 7, label: "等级经验" }, { value: 9, label: "SVIP 天数" },
];
const list = ref<LotteryActivity[]>([]);
const total = ref(0);
const loading = ref(false);
const query = reactive<{ page: number; name: string; factor?: number; status?: 0 | 1; startStatus?: -1 | 0 | 1 }>({ page: 1, name: "" });
const enabledCount = computed(() => list.value.filter((item) => item.status === 1).length);
const runningCount = computed(() => list.value.filter((item) => item.time_status === 1).length);
const auth = useAuthStore();
const has = (permission: string) => !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes(permission));
const canView = computed(() => !!auth.token && auth.token === getToken() && (has("lottery.view") || has("lottery.manage")));
const canManage = computed(() => canView.value && has("lottery.manage"));
const canRecordView = computed(() => canView.value && (has("lottery_record.view") || has("lottery_record.manage")));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? -1}:${auth.uniqueAuth.join(",")}`);
const formVisible = ref(false);
const formTab = ref("activity");
const formLoading = ref(false);
const saving = ref(false);
let mounted = false;
let listGeneration = 0;
let detailGeneration = 0;
let listRequest: AbortController | null = null;
let detailRequest: AbortController | null = null;
let storedSession = localStorage.getItem("admin_session");

function blankPrize(index: number): LotteryPrize {
  return { type: 1, name: `谢谢参与${index + 1}`, prompt: "再接再厉", image: "/logo.png", chance: index === 0 ? 10 : 0, total: -1, couponId: 0, productId: 0, unique: "", num: "0.00", sort: index, status: 1 };
}
function blankForm() {
  return { id: 0, type: 1, name: "", desc: "", image: "/logo.png", factor: 1, factorNum: 10, attendsUser: 1, userLevel: [] as number[], userLabel: [] as number[], isSvip: -1, period: [new Date(Date.now() + 3_600_000), new Date(Date.now() + 8 * 86_400_000)] as Date[], lotteryNumTerm: 1, lotteryNum: 1, totalLotteryNum: 10, spreadNum: 1, isAllRecord: 1, isPersonalRecord: 1, isContent: 1, content: "", status: 1, sort: 0, prize: Array.from({ length: 8 }, (_, index) => blankPrize(index)) };
}
const form = reactive(blankForm());

function resetForm() { Object.assign(form, blankForm()); }
function factorLabel(value: number) { return factors.find((item) => item.value === value)?.label ?? "未知"; }
function factorHint(value: number) { return value === 1 ? "每次消耗积分" : value === 2 ? "每次消耗余额（元）" : value === 3 || value === 4 ? "每个事件获得的抽奖次数" : "每位新好友奖励次数"; }
function formatTime(value: number) { return value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric",
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value * 1000)) : "—"; }
function timeLabel(value?: number) { return value === 0 ? "未开始" : value === 2 ? "已结束" : "进行中"; }
function timeTag(value?: number): "info" | "success" | "warning" { return value === 0 ? "info" : value === 2 ? "warning" : "success"; }

function active(stamp: string): boolean {
  return mounted && canView.value && sessionKey.value === stamp && storedSessionMatches();
}

function storedSessionMatches(): boolean {
  const stored = getAdminSession();
  const key = `${getToken() ?? ""}:${stored?.userInfo.id ?? 0}:${stored?.userInfo.level ?? -1}:${stored?.uniqueAuth.join(",") ?? ""}`;
  if (key === sessionKey.value && storedSession === localStorage.getItem("admin_session")) return true;
  syncSession();
  return false;
}

function clearSessionData() {
  listGeneration++;
  detailGeneration++;
  listRequest?.abort();
  detailRequest?.abort();
  listRequest = detailRequest = null;
  list.value = [];
  total.value = 0;
  loading.value = false;
  formVisible.value = false;
  formLoading.value = false;
  saving.value = false;
  resetForm();
}

function syncSession() {
  const previous = sessionKey.value;
  const nextStored = localStorage.getItem("admin_session");
  const changed = storedSession !== nextStored;
  storedSession = nextStored;
  if (changed) clearSessionData();
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  if (changed && mounted && previous === sessionKey.value && canView.value) void load(1);
}

function onStorage(event: StorageEvent) {
  if (event.key === "admin_token" || event.key === "admin_session" || event.key === null) syncSession();
}

async function load(targetPage = query.page) {
  if (!mounted || !canView.value || !storedSessionMatches() || !Number.isSafeInteger(targetPage) || targetPage < 1 || targetPage > 10_000) return;
  const stamp = sessionKey.value;
  const generation = ++listGeneration;
  listRequest?.abort();
  const controller = new AbortController();
  listRequest = controller;
  loading.value = true;
  try {
    const params: LotteryListQuery = { page: targetPage, limit: 15, name: String(query.name ?? "").trim(),
      factor: [1, 2, 3, 4, 5].includes(Number(query.factor)) ? query.factor : undefined,
      status: query.status === 0 || query.status === 1 ? query.status : undefined,
      start_status: query.startStatus === -1 || query.startStatus === 0 || query.startStatus === 1 ? query.startStatus : undefined };
    const result = await apiLotteryList(params, controller.signal);
    if (!active(stamp) || generation !== listGeneration) return;
    if (!Array.isArray(result.list) || !Number.isSafeInteger(result.count) || result.count < 0 || result.list.length > 15) {
      throw new Error("抽奖活动分页响应无效");
    }
    list.value = result.list;
    total.value = result.count;
    query.page = targetPage;
  } catch (error) { if (active(stamp) && generation === listGeneration && !controller.signal.aborted) ElMessage.error((error as Error).message || "加载抽奖活动失败"); }
  finally { if (generation === listGeneration) { loading.value = false; listRequest = null; } }
}
function search() { void load(1); }
function resetQuery() { query.name = ""; query.factor = undefined; query.status = undefined; query.startStatus = undefined; void load(1); }
async function openForm(row?: LotteryActivity) {
  if (!mounted || !canManage.value || !storedSessionMatches()) return;
  detailGeneration++;
  detailRequest?.abort();
  detailRequest = null;
  formLoading.value = false;
  resetForm(); formTab.value = "activity"; formVisible.value = true;
  if (!row) return;
  const stamp = sessionKey.value;
  const generation = ++detailGeneration;
  const controller = new AbortController();
  detailRequest = controller;
  formLoading.value = true;
  try {
    const detail = await apiLotteryDetail(row.id, controller.signal);
    if (!active(stamp) || !canManage.value || generation !== detailGeneration || !formVisible.value) return;
    Object.assign(form, detail, {
      userLevel: Array.isArray(detail.userLevel) ? detail.userLevel : [],
      userLabel: Array.isArray(detail.userLabel) ? detail.userLabel : [],
      period: [new Date(detail.startTime * 1000), new Date(detail.endTime * 1000)],
      prize: (detail.prize ?? []).map((item, index) => ({ ...blankPrize(index), ...item })),
    });
  } catch (error) { if (active(stamp) && generation === detailGeneration && !controller.signal.aborted) { ElMessage.error((error as Error).message || "加载活动详情失败"); formVisible.value = false; } }
  finally { if (generation === detailGeneration) { formLoading.value = false; detailRequest = null; } }
}
function payload(): Record<string, unknown> {
  return { ...form, period: form.period.map((date) => Math.floor(date.getTime() / 1000)), user_level: form.userLevel, user_label: form.userLabel, factor_num: form.factorNum, attends_user: form.attendsUser, is_svip: form.isSvip, lottery_num_term: form.lotteryNumTerm, lottery_num: form.lotteryNum, total_lottery_num: form.totalLotteryNum, spread_num: form.spreadNum, is_all_record: form.isAllRecord, is_personal_record: form.isPersonalRecord, is_content: form.isContent };
}
async function save() {
  if (!mounted || !canManage.value || !storedSessionMatches() || !formVisible.value || formLoading.value || saving.value) return;
  if (!form.name.trim() || !form.image.trim() || !form.content.trim()) return ElMessage.error("请完整填写活动名称、背景图和规则");
  if (form.prize.length !== 8 || form.prize.some((item) => !item.name.trim() || !item.image.trim())) { formTab.value = "prizes"; return ElMessage.error("请完整配置 8 个奖位"); }
  const stamp = sessionKey.value;
  saving.value = true;
  try { form.id ? await apiLotteryEdit(form.id, payload()) : await apiLotteryAdd(payload());
    if (!active(stamp) || !canManage.value) return;
    ElMessage.success("抽奖活动已保存"); formVisible.value = false; await load(); }
  catch (error) { if (active(stamp) && canManage.value) ElMessage.error((error as Error).message || "保存失败"); }
  finally { saving.value = false; }
}
async function toggleStatus(row: LotteryActivity) {
  if (!mounted || !canManage.value || !storedSessionMatches() || !list.value.some(item => item.id === row.id)) return;
  const stamp = sessionKey.value;
  try { await apiLotteryStatus(row.id, row.status === 1 ? 0 : 1); if (!active(stamp) || !canManage.value) return;
    ElMessage.success("状态已更新"); await load(); }
  catch (error) { if (active(stamp) && canManage.value) ElMessage.error((error as Error).message || "操作失败"); }
}
async function remove(row: LotteryActivity) {
  if (!mounted || !canManage.value || !storedSessionMatches() || !list.value.some(item => item.id === row.id)) return;
  const stamp = sessionKey.value;
  try { await ElMessageBox.confirm(`确认删除活动「${row.name}」？历史中奖记录仍会保留。`, "删除确认", { type: "warning" });
    if (!active(stamp) || !canManage.value || !list.value.some(item => item.id === row.id)) return;
    await apiLotteryDelete(row.id);
    if (!active(stamp) || !canManage.value) return;
    ElMessage.success("活动已删除"); await load(); }
  catch (error) { if (error !== "cancel" && active(stamp) && canManage.value) ElMessage.error((error as Error).message || "删除失败"); }
}
watch(sessionKey, () => { clearSessionData(); if (mounted && canView.value) void load(1); });
onMounted(() => {
  mounted = true;
  window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession);
  window.addEventListener("storage", onStorage);
  const previous = sessionKey.value;
  syncSession();
  if (previous === sessionKey.value && canView.value) void load(1);
});
onBeforeUnmount(() => {
  mounted = false;
  window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession);
  window.removeEventListener("storage", onStorage);
  clearSessionData();
});
</script>

<style scoped>
.lottery-page { display: grid; gap: 16px; }
.page-head { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; }
.page-head h2 { margin: 0; font-size: 22px; color: #172033; }
.page-head p { margin: 6px 0 0; color: #7b8497; }
.head-actions, .filters { display: flex; gap: 10px; flex-wrap: wrap; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.summary-card { padding: 18px 20px; border-radius: 12px; background: linear-gradient(135deg, #fff, #f7f9ff); border: 1px solid #e8ebf3; display: flex; justify-content: space-between; align-items: center; }
.summary-card span { color: #7b8497; } .summary-card strong { font-size: 22px; color: #1f4ed8; }
.summary-card.warning strong { color: #d97706; font-size: 16px; }
.filters { margin-bottom: 16px; }
.activity-cell { display: flex; align-items: center; gap: 12px; } .activity-image { width: 54px; height: 54px; border-radius: 10px; background: #f0f2f6; flex: none; }
.image-fallback { width: 100%; height: 100%; display: grid; place-items: center; color: #9aa2b1; font-size: 20px; }
.activity-cell strong, .activity-cell small { display: block; } .activity-cell small, .block { color: #8991a3; margin-top: 5px; }
.time-range span { display: block; line-height: 1.6; color: #5f687b; font-size: 13px; }
.pagination { display: flex; justify-content: flex-end; margin-top: 16px; }
.form-tabs { margin-top: 16px; } .activity-form { max-width: 820px; padding-top: 8px; }
.inline-number { margin-left: 12px; } .inline-switch { margin-left: 20px; } .field-hint { color: #8a93a5; font-size: 12px; margin-left: 8px; }
.prize-table :deep(.el-input-number) { width: 100%; } .cell-second { margin-top: 6px; } .stock-hint { color: #9aa2b1; display: block; text-align: center; }
.muted { color: #a1a8b5; } .block { display: block; }
@media (max-width: 900px) { .summary-grid { grid-template-columns: repeat(2, 1fr); } .page-head { flex-direction: column; } }
</style>
