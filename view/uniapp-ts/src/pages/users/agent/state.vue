<template>
  <view class="page">
    <view class="card">
      <text class="title">{{ kind === "promoter" ? "分销员申请状态" : "代理商申请状态" }}</text>
      <text v-if="loading">正在读取服务器状态…</text>
      <template v-else-if="error"><text class="error">{{ error }}</text><button @tap="load">重新读取</button></template>
      <template v-else-if="application">
        <text class="status">{{ label(application.status) }}</text>
        <text v-if="application.status !== -1">申请编号 {{ application.id }}</text>
        <text v-if="application.addTime">提交时间 {{ formatAgentApplicationTime(application.addTime) }}</text>
        <text v-if="application.statusTime">审核时间 {{ formatAgentApplicationTime(application.statusTime) }}</text>
        <text v-if="application.status === 2" class="error">{{ application.refusalReason || "审核未通过，请核对资料" }}</text>
        <text v-if="application.status === 0">正在审核，请稍后手动刷新。</text>
        <button v-if="application.status === 2 || application.status === -1" class="primary" @tap="edit">
          {{ application.status === 2 ? "修改并重新提交" : "填写申请" }}
        </button>
        <button v-if="kind === 'agent' && application.status === 1" class="secondary" @tap="openStaff">我的员工</button>
        <button class="secondary" @tap="load">刷新状态</button>
      </template>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { onLoad, onShow, onHide, onUnload } from "@dcloudio/uni-app";
import { apiAgentApplication, formatAgentApplicationTime, type AgentApplication, type AgentApplicationKind, type AgentApplicationStatus } from "@/api/agentSelfService";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();
const kind = ref<AgentApplicationKind>("agent");
const requestedId = ref("");
const application = ref<AgentApplication | null>(null);
const loading = ref(true);
const error = ref("");
let epoch = 0;
function label(value: AgentApplicationStatus): string {
  return ({ [-1]: "尚未申请", 0: "正在审核", 1: "审核通过", 2: "审核未通过" } as Record<number, string>)[value] || "状态未知";
}
async function load(): Promise<void> {
  const current = ++epoch;
  application.value = null;
  loading.value = true; error.value = "";
  if (!auth.isLoggedIn) { error.value = "请先登录"; loading.value = false; return; }
  try {
    const result = await apiAgentApplication(kind.value);
    if (current !== epoch) return;
    if (requestedId.value && (!/^[1-9]\d{0,9}$/.test(requestedId.value) || Number(requestedId.value) !== result.id)) {
      throw new Error("申请编号与当前账号不匹配");
    }
    application.value = result;
  } catch (cause) { if (current === epoch) error.value = cause instanceof Error ? cause.message : "状态读取失败"; }
  finally { if (current === epoch) loading.value = false; }
}
function edit(): void {
  const path = kind.value === "promoter" ? "/pages/users/distributor/apply" : "/pages/users/agent/apply";
  const id = application.value?.id ?? 0;
  uni.redirectTo({ url: `${path}${id ? `?id=${id}` : ""}` });
}
function openStaff(): void { uni.navigateTo({ url: "/pages/users/agent/staff_list" }); }
onLoad((query) => {
  const type = String(query?.type ?? "agent");
  if (type !== "agent" && type !== "promoter") { error.value = "申请类型无效"; loading.value = false; return; }
  kind.value = type;
  requestedId.value = String(query?.id ?? "");
});
onShow(() => { if (error.value !== "申请类型无效") void load(); });
onHide(() => { ++epoch; });
onUnload(() => { ++epoch; });
watch(() => [auth.uid, auth.token, auth.sessionVersion], () => { void load(); });
</script>

<style scoped>
.page { min-height: 100vh; padding: 28rpx; background: #f5f6f8; box-sizing: border-box; }
.card { display: flex; flex-direction: column; gap: 22rpx; padding: 38rpx 30rpx; border-radius: 20rpx; background: #fff; color: #344; font-size: 26rpx; }
.title { font-size: 36rpx; font-weight: 700; }.status { font-size: 32rpx; color: #176e61; font-weight: 650; }
.error { color: #ab3f37; }.primary { color: #fff; background: #176e61; }.secondary { color: #176e61; background: #fff; border: 1rpx solid #176e61; }
</style>
