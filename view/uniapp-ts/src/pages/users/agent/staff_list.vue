<template>
  <ThemePage><view class="page">
    <text class="heading">我的员工</text>
    <view class="search"><input v-model="keyword" placeholder="昵称、手机号或 UID" :disabled="writing" @confirm="search" /><button :disabled="writing" @tap="search">搜索</button></view>
    <view class="dates"><picker mode="date" :value="startDate" :disabled="writing" @change="startDate = $event.detail.value"><text>{{ startDate || '加入起始日期' }}</text></picker><picker mode="date" :value="stopDate" :disabled="writing" @change="stopDate = $event.detail.value"><text>{{ stopDate || '加入结束日期' }}</text></picker><button :disabled="writing" @tap="clearDates">清除日期</button></view>
    <view v-if="state.error" class="card error"><text>{{ state.error }}</text><button :disabled="writing" @tap="refresh">重新读取</button></view>
    <view v-if="writeNotice" role="status" class="card notice">{{ writeNotice }}</view>
    <view v-if="state.loading" class="card">正在读取员工…</view>
    <view v-if="state.result" class="summary card"><text>共 {{ state.result.count }} 位员工</text><text>关联订单佣金记录 ¥{{ state.result.brokerage }}</text><text class="hint">历史订单记录合计，包含原有订单状态，不代表当前可提现余额。</text><button :disabled="inviting || writing" @tap="loadInvite">{{ inviting ? '正在生成邀请…' : '邀请员工' }}</button><text v-if="inviteError" class="error">{{ inviteError }}</text><template v-if="inviteImage"><image class="invite-code" :src="inviteImage" mode="aspectFit" @error="imageFailed"/><text class="hint">受邀用户扫码后确认当前代理关系。图片凭据将在短时间后失效，请重新生成。</text></template></view>
    <view v-for="item in state.result?.items || []" :key="item.uid" class="card employee">
      <text class="name">{{ item.nickname || `用户 ${item.uid}` }}</text><text>UID {{ item.uid }} · {{ item.phone }}</text>
      <text>加入时间 {{ item.joinedAt }} · 分佣比例 {{ item.percent }}%</text><text>直属推广 {{ item.children }} 人 · 订单 {{ item.orders }} 单 · 订单金额 ¥{{ item.orderAmount }}</text>
      <view class="actions"><button :disabled="writing || state.loading" @tap="beginPercent(item)">修改比例</button><button :disabled="writing || state.loading" class="danger" @tap="remove(item)">移除员工</button></view>
    </view>
    <view v-if="!state.loading && state.result && !state.result.items.length" class="card">暂无员工</view>
    <button v-if="state.result && state.result.items.length < state.result.count" :disabled="state.loading || writing" class="more" @tap="loadMore">加载更多</button>
    <view v-if="editing" class="editor card"><text class="name">{{ editing.nickname || `用户 ${editing.uid}` }} 的分佣比例</text><text>请输入 0 至 {{ Math.max(0, (state.result?.agent.percent || 0) - 1) }} 的整数，必须低于当前代理商比例。</text><input v-model="percent" type="number" :disabled="writing" placeholder="分佣比例"/><text v-if="actionError" class="error">{{ actionError }}</text><view class="actions"><button :disabled="writing" @tap="savePercent">{{ writing ? '正在提交…' : '确认修改' }}</button><button :disabled="writing" @tap="editing = null">取消</button></view></view>
  </view></ThemePage>
</template>
<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import { ref, watch } from 'vue';
import { onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiDivisionStaffList, apiDivisionStaffPercent, apiDivisionStaffRemove, apiDivisionStaffInviteImage } from '@/api/divisionStaff';
import { DivisionStaffSession, divisionStaffDates, divisionStaffOwnerEqual, type DivisionStaffItem, type DivisionStaffOwner } from '../../../../../common/divisionStaff';

const auth = useAuthStore(), keyword = ref(''), startDate = ref(''), stopDate = ref('');
const state = ref<DivisionStaffSession['state']>({ result: null, loading: false, error: '' });
const session = new DivisionStaffSession(apiDivisionStaffList, next => { state.value = { ...next }; });
const writing = ref(false), writeNotice = ref(''), actionError = ref(''), editing = ref<DivisionStaffItem | null>(null), percent = ref('');
const inviting = ref(false), inviteImage = ref(''), inviteError = ref('');
let visible = false, epoch = 0, writeEpoch = 0, editingOwner: (DivisionStaffOwner & { epoch: number }) | null = null;
let inviteTimer: ReturnType<typeof setTimeout> | undefined;
let filter = { keyword: '', start: 0, stop: 0, page: 1, limit: 20 };
const owner = () => ({ uid: auth.uid, token: auth.token, version: auth.sessionVersion, epoch });
const current = (snapshot: ReturnType<typeof owner>) => visible && auth.isLoggedIn && epoch === snapshot.epoch && divisionStaffOwnerEqual(snapshot, owner());
function withdrawInvite() { if (inviteTimer) clearTimeout(inviteTimer); inviteTimer = undefined; inviting.value = false; inviteImage.value = ''; inviteError.value = ''; }
function refresh(): void {
  ++epoch; session.reset(); editing.value = null; editingOwner = null; actionError.value = ''; writeNotice.value = ''; withdrawInvite();
  if (!visible) return;
  if (!auth.isLoggedIn) { state.value.error = '请先登录'; return; }
  filter.page = 1; void session.load(filter, owner());
}
function search(): void {
  if (writing.value) return;
  try { filter = { keyword: keyword.value.trim().slice(0, 50), ...divisionStaffDates(startDate.value, stopDate.value), page: 1, limit: 20 }; refresh(); }
  catch (error) { state.value.error = error instanceof Error ? error.message : '日期范围无效'; }
}
function clearDates() { startDate.value = ''; stopDate.value = ''; search(); }
function loadMore() { if (writing.value || state.value.loading || !state.value.result) return; filter.page = state.value.result.page + 1; void session.load(filter, owner(), true); }
function beginPercent(item: DivisionStaffItem) { if (!visible || writing.value) return; editing.value = { ...item }; editingOwner = owner(); percent.value = String(item.percent); actionError.value = ''; }
async function write(action: () => Promise<unknown>, snapshot: ReturnType<typeof owner>) {
  if (!current(snapshot) || writing.value) return;
  const actionId = ++writeEpoch; writing.value = true; actionError.value = ''; writeNotice.value = '';
  try { await action(); if (current(snapshot)) refresh(); }
  catch (cause) { if (current(snapshot)) { refresh(); writeNotice.value = `${cause instanceof Error ? cause.message : '操作结果未知'}；请核对重新读取后的员工信息，避免重复提交`; } }
  finally { if (actionId === writeEpoch) writing.value = false; }
}
async function savePercent() {
  if (!editing.value || !editingOwner || !current(editingOwner)) return;
  const ceiling = state.value.result?.agent.percent ?? 0;
  if (!/^(?:0|[1-9]\d?)$/.test(percent.value) || Number(percent.value) >= ceiling) { actionError.value = '员工比例须为非负整数，并低于当前代理商比例'; return; }
  const employee = { ...editing.value }; await write(() => apiDivisionStaffPercent(employee.uid, Number(percent.value), employee.revision), owner());
}
function remove(item: DivisionStaffItem) {
  if (writing.value || !visible || !auth.isLoggedIn) return;
  const snapshot = owner(), employee = { ...item };
  uni.showModal({ title: '移除员工', content: `确认移除 ${employee.nickname || employee.uid}？将解除本人及同代理下关联用户的分销身份，账号、推广关系和历史订单保留。`, success: async result => {
    if (result.confirm && current(snapshot)) await write(() => apiDivisionStaffRemove(employee.uid, employee.revision), snapshot);
  } });
}
async function loadInvite() {
  if (inviting.value || writing.value || !state.value.result) return;
  const snapshot = owner(); inviting.value = true; inviteError.value = ''; inviteImage.value = '';
  try { const image = await apiDivisionStaffInviteImage(); if (!current(snapshot)) return; inviteImage.value = image.url;
    inviteTimer = setTimeout(() => { inviteImage.value = ''; inviteError.value = '员工邀请码已过期，请重新生成'; }, Math.max(1, image.expires * 1000 - Date.now())); }
  catch (error) { if (current(snapshot)) inviteError.value = error instanceof Error ? error.message : '员工邀请生成失败'; }
  finally { if (current(snapshot)) inviting.value = false; }
}
function imageFailed() { inviteImage.value = ''; inviteError.value = '员工邀请图片未能读取，请重新生成'; }
function hide() { visible = false; ++epoch; ++writeEpoch; writing.value = false; editing.value = null; editingOwner = null; session.reset(); withdrawInvite(); }
onShow(() => { visible = true; refresh(); }); onHide(hide); onUnload(hide);
watch(() => [auth.uid, auth.token, auth.sessionVersion], () => { ++writeEpoch; writing.value = false; refresh(); });
</script>
<style scoped>
.page{min-height:100vh;padding:26rpx;background:#f5f6f8;box-sizing:border-box;max-width:1000rpx;margin:auto}.heading{display:block;margin-bottom:20rpx;font-size:38rpx;font-weight:700}.search,.dates,.actions{display:flex;gap:12rpx}.search input{flex:1;min-width:0;padding:15rpx;background:#fff}.search button,.dates button{margin:0;font-size:24rpx}.dates{margin-top:18rpx;flex-wrap:wrap;align-items:center}.dates picker{padding:14rpx;background:#fff;font-size:24rpx}.card{display:flex;flex-direction:column;gap:13rpx;margin-top:18rpx;padding:26rpx;border-radius:17rpx;background:#fff;color:#344;font-size:25rpx}.name{font-size:30rpx;font-weight:650}.actions button{flex:1;margin:0;font-size:24rpx}.danger,.error{color:#a33}.notice,.hint{color:#666;line-height:1.7}.hint{font-size:23rpx}.more{margin:24rpx 0}.editor input{padding:15rpx;border:1rpx solid #ddd}.invite-code{width:360rpx;height:360rpx;max-width:100%;align-self:center}
</style>
