<template>
  <view class="page">
    <text class="heading">我的员工</text>
    <view class="search"><input v-model="keyword" placeholder="昵称、手机号或 UID" @confirm="search" /><button @tap="search">搜索</button></view>
    <view v-if="error" class="card error"><text>{{ error }}</text><button @tap="refresh">重新读取</button></view>
    <view v-if="writeNotice" class="card error">{{ writeNotice }}</view>
    <view v-if="loading && !staff.length" class="card">正在读取员工…</view>
    <view v-for="item in staff" :key="item.uid" class="card">
      <text class="name">{{ item.nickname || `用户 ${item.uid}` }}</text>
      <text>UID {{ item.uid }} · {{ item.phone }}</text>
      <text>分佣比例 {{ item.divisionPercent }}% · 订单 {{ item.orderCount }}</text>
      <view class="actions"><button @tap="beginPercent(item)">修改比例</button><button class="danger" @tap="remove(item)">移除员工</button></view>
    </view>
    <view v-if="!loading && !error && !staff.length" class="card">暂无员工</view>
    <button v-if="staff.length < total" :disabled="loading" class="more" @tap="loadMore">{{ loading ? "加载中" : "加载更多" }}</button>
    <view v-if="editing" class="editor card">
      <text class="name">{{ editing.nickname || `用户 ${editing.uid}` }} 的分佣比例</text>
      <input v-model="percent" type="number" placeholder="0–100 的整数" />
      <text v-if="actionError" class="error">{{ actionError }}</text>
      <view class="actions"><button :disabled="writing" @tap="savePercent">确认修改</button><button @tap="editing = null">取消</button></view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { onShow, onHide, onUnload } from "@dcloudio/uni-app";
import { apiAgentStaff, apiAgentStaffPercent, apiRemoveAgentStaff, type AgentStaff } from "@/api/agentSelfService";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();
const staff = ref<AgentStaff[]>([]);
const total = ref(0);
const page = ref(0);
const keyword = ref("");
const appliedKeyword = ref("");
const loading = ref(false);
const writing = ref(false);
const error = ref("");
const actionError = ref("");
const writeNotice = ref("");
const editing = ref<AgentStaff | null>(null);
const percent = ref("");
let epoch = 0;
let writeEpoch = 0;
type Owner = { uid: number; token: string; version: number; epoch: number };
let editingOwner: Owner | null = null;
function ownerSnapshot(): Owner { return { uid: auth.uid, token: auth.token, version: auth.sessionVersion, epoch }; }
function sameSession(owner: Owner): boolean {
  return auth.isLoggedIn && auth.uid === owner.uid && auth.token === owner.token
    && auth.sessionVersion === owner.version;
}
function sameOwner(owner: Owner): boolean { return sameSession(owner) && epoch === owner.epoch; }

async function fetchPage(nextPage: number): Promise<void> {
  if (loading.value || !auth.isLoggedIn) return;
  const current = ++epoch;
  loading.value = true; error.value = "";
  try {
    const result = await apiAgentStaff(nextPage, appliedKeyword.value);
    if (current !== epoch) return;
    if (!Array.isArray(result.list) || !Number.isSafeInteger(result.count) || result.count < 0) throw new Error("员工列表响应无效");
    staff.value = nextPage === 1 ? result.list : [...staff.value, ...result.list.filter((row) => !staff.value.some((old) => old.uid === row.uid))];
    total.value = result.count;
    page.value = nextPage;
  } catch (cause) { if (current === epoch) error.value = cause instanceof Error ? cause.message : "员工列表读取失败"; }
  finally { if (current === epoch) loading.value = false; }
}
function refresh(): void {
  ++epoch; loading.value = false; staff.value = []; total.value = 0; page.value = 0;
  editing.value = null; editingOwner = null; actionError.value = ""; writeNotice.value = "";
  if (!auth.isLoggedIn) { error.value = "请先登录"; return; }
  void fetchPage(1);
}
function search(): void { appliedKeyword.value = keyword.value.trim().slice(0, 50); refresh(); }
function loadMore(): void { if (staff.value.length < total.value) void fetchPage(page.value + 1); }
function beginPercent(item: AgentStaff): void {
  if (!auth.isLoggedIn) return;
  editingOwner = ownerSnapshot(); editing.value = item; percent.value = String(item.divisionPercent); actionError.value = "";
}
async function savePercent(): Promise<void> {
  if (!editing.value || !editingOwner || !sameOwner(editingOwner) || writing.value) return;
  if (!/^(?:0|[1-9]\d?)$|^100$/.test(percent.value)) { actionError.value = "请输入 0–100 的整数"; return; }
  const uid = editing.value.uid;
  const owner = ownerSnapshot();
  const action = ++writeEpoch;
  writing.value = true; actionError.value = "";
  try { await apiAgentStaffPercent(uid, Number(percent.value)); if (sameOwner(owner)) refresh(); }
  catch (cause) {
    if (sameOwner(owner)) { refresh(); writeNotice.value = `${cause instanceof Error ? cause.message : "修改结果未知"}；请核对刷新后的比例再操作`; }
  } finally { if (sameSession(owner) && action === writeEpoch) writing.value = false; }
}
function remove(item: AgentStaff): void {
  if (writing.value || !auth.isLoggedIn) return;
  const owner = ownerSnapshot();
  uni.showModal({ title: "移除员工", content: `确认移除 ${item.nickname || item.uid}？`, success: async (result) => {
    if (!result.confirm || writing.value || !sameOwner(owner)) return;
    const action = ++writeEpoch;
    writing.value = true; actionError.value = "";
    try { await apiRemoveAgentStaff(item.uid); if (sameOwner(owner)) refresh(); }
    catch (cause) {
      if (sameOwner(owner)) { refresh(); writeNotice.value = cause instanceof Error ? `${cause.message}；请核对刷新后的员工列表` : "操作结果未知，请核对刷新后的员工列表"; }
    } finally { if (sameSession(owner) && action === writeEpoch) writing.value = false; }
  } });
}
onShow(refresh);
onHide(() => { ++epoch; ++writeEpoch; writing.value = false; });
onUnload(() => { ++epoch; ++writeEpoch; writing.value = false; });
watch(() => [auth.uid, auth.token, auth.sessionVersion], () => { ++writeEpoch; writing.value = false; refresh(); });
</script>

<style scoped>
.page { min-height: 100vh; padding: 26rpx; background: #f5f6f8; box-sizing: border-box; }
.heading { display: block; margin-bottom: 20rpx; font-size: 38rpx; font-weight: 700; }
.search { display: flex; gap: 12rpx; }.search input { flex: 1; min-width: 0; padding: 15rpx; background: #fff; }.search button { margin: 0; }
.card { display: flex; flex-direction: column; gap: 13rpx; margin-top: 18rpx; padding: 26rpx; border-radius: 17rpx; background: #fff; color: #344; font-size: 25rpx; }
.name { font-size: 30rpx; font-weight: 650; }.actions { display: flex; gap: 12rpx; }.actions button { flex: 1; margin: 0; font-size: 24rpx; }
.danger,.error { color: #a33; }.more { margin: 24rpx 0; }.editor input { padding: 15rpx; border: 1rpx solid #ddd; }
</style>
