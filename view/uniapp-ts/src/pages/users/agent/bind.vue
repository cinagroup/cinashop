<template><ThemePage><view class="page"><text class="heading">员工邀请</text><text class="hint">绑定后成为该代理商的员工。账号和已有订单保留，新订单的推广关系由服务端重新核验。</text><view v-if="error" role="alert" class="card error">{{ error }}</view><view v-if="!auth.isLoggedIn" class="card"><text>请先登录后读取当前邀请。</text><button @tap="login">登录后继续</button></view><view v-if="loading" class="card">正在核验员工邀请…</view><view v-if="info" class="card"><text class="name">{{ info.name || `代理商 ${info.agentId}` }}</text><text>代理商 UID {{ info.agentId }}</text><text v-if="info.alreadyBound" class="success">已读取当前关系：您已是该代理商的员工。</text><template v-else-if="info.canBind"><text v-if="target?.autoBind" class="hint">正在恢复原扫码员工绑定流程，提交一次后重新读取真实关系。</text><button :disabled="writing || loading" @tap="confirmBind">{{ writing ? '正在绑定…' : '确认成为该代理商员工' }}</button></template><text v-else class="hint">当前账户已有事业部角色，不能重复绑定员工。</text></view><button v-if="auth.isLoggedIn && target" :disabled="loading || writing" @tap="readInvite()">重新读取邀请与当前关系</button></view></ThemePage></template>
<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import { ref, watch } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiDivisionStaffPreview, apiDivisionStaffBind } from '@/api/divisionStaff';
import { divisionStaffOwnerEqual, parseDivisionStaffInviteRoute, type DivisionStaffInvite, type DivisionStaffInviteInfo } from '../../../../../common/divisionStaff';
const auth = useAuthStore(), target = ref<DivisionStaffInvite | null>(null), info = ref<DivisionStaffInviteInfo | null>(null);
const loading = ref(false), writing = ref(false), error = ref('');
let visible = false, epoch = 0, automaticAttempted = false, loginRestorePending = false;
const owner = () => ({ uid: auth.uid, token: auth.token, version: auth.sessionVersion, epoch });
const current = (snapshot: ReturnType<typeof owner>) => visible && auth.isLoggedIn && epoch === snapshot.epoch && divisionStaffOwnerEqual(snapshot, owner());
async function readInvite(allowAutomatic = true): Promise<void> {
  if (!visible || !target.value || !auth.isLoggedIn || loading.value || writing.value) return;
  const snapshot = owner(), input = { ...target.value }; loading.value = true; info.value = null; error.value = '';
  try { const result = await apiDivisionStaffPreview(input); if (!current(snapshot)) return; info.value = result; }
  catch (cause) { if (current(snapshot)) error.value = cause instanceof Error ? cause.message : '员工邀请读取失败'; }
  finally { if (current(snapshot)) loading.value = false; }
  if (current(snapshot) && allowAutomatic && input.autoBind && !automaticAttempted && info.value?.canBind) await confirmBind();
}
async function confirmBind(): Promise<void> {
  if (!visible || writing.value || loading.value || !target.value || !info.value?.canBind || !auth.isLoggedIn) return;
  const snapshot = owner(), input = { ...target.value }, revision = info.value.revision; automaticAttempted = true; loginRestorePending = false; writing.value = true; error.value = '';
  let notice = '';
  try { await apiDivisionStaffBind(input, revision); }
  catch (cause) { notice = `${cause instanceof Error ? cause.message : '绑定结果未知'}；请核对重新读取的关系，避免重复绑定`; }
  finally { if (current(snapshot)) writing.value = false; }
  if (!current(snapshot)) return;
  await readInvite(false);
  if (current(snapshot) && notice && !info.value?.alreadyBound) error.value = notice;
}
function login() { if (auth.isLoggedIn || !target.value) return; loginRestorePending = true; uni.navigateTo({ url: '/pages/auth/login' }); }
function withdraw() { ++epoch; loading.value = false; writing.value = false; info.value = null; error.value = ''; if (!loginRestorePending) automaticAttempted = true; }
onLoad(options => { try { target.value = parseDivisionStaffInviteRoute(options ?? {}); } catch (cause) { error.value = cause instanceof Error ? cause.message : '员工邀请参数无效'; } });
onShow(() => { visible = true; void readInvite(); });
onHide(() => { visible = false; withdraw(); }); onUnload(() => { visible = false; withdraw(); target.value = null; });
watch(() => [auth.uid, auth.token, auth.sessionVersion], () => { withdraw(); if (visible) void readInvite(loginRestorePending); });
</script>
<style scoped>.page{padding:32rpx;max-width:780rpx;margin:auto}.heading{display:block;font-size:38rpx;font-weight:700;margin:16rpx 0}.hint{display:block;font-size:25rpx;color:#666;line-height:1.8}.card{display:flex;flex-direction:column;gap:20rpx;padding:28rpx;background:#fff;border-radius:18rpx;margin:24rpx 0;font-size:28rpx}.name{font-size:32rpx;font-weight:650}.error{color:#a33}.success{color:#236f35}button{font-size:27rpx}</style>
