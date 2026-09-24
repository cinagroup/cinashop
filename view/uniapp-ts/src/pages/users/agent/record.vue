<template>
  <view class="page">
    <text class="heading">分销与代理申请</text>
    <view v-if="loading" class="card">正在读取申请记录…</view>
    <view v-else-if="error" class="card error"><text>{{ error }}</text><button @tap="load">重试</button></view>
    <template v-else>
      <view v-for="item in applications" :key="item.kind" class="card">
        <text class="name">{{ item.kind === "promoter" ? "分销员" : "代理商" }} · {{ item.name }}</text>
        <text>{{ label(item.status) }}</text>
        <text v-if="item.addTime">提交时间 {{ formatAgentApplicationTime(item.addTime) }}</text>
        <text v-if="item.status === 2" class="error">{{ item.refusalReason }}</text>
        <button @tap="open(item)">{{ item.status === 2 ? "查看并修改" : "查看状态" }}</button>
      </view>
      <view v-if="!applications.length" class="card">当前账号暂无分销员或代理商申请。</view>
      <button class="secondary" @tap="goApply('promoter')">申请分销员</button>
      <button class="secondary" @tap="goApply('agent')">申请代理商</button>
    </template>
  </view>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { onShow, onHide, onUnload } from "@dcloudio/uni-app";
import { apiAgentApplication, formatAgentApplicationTime, type AgentApplication, type AgentApplicationKind, type AgentApplicationStatus } from "@/api/agentSelfService";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();
const applications = ref<AgentApplication[]>([]);
const loading = ref(true);
const error = ref("");
let epoch = 0;
function label(value: AgentApplicationStatus): string {
  return ({ [-1]: "未申请", 0: "待审核", 1: "审核通过", 2: "审核未通过" } as Record<number, string>)[value] || "状态未知";
}
async function load(): Promise<void> {
  const current = ++epoch;
  applications.value = []; loading.value = true; error.value = "";
  if (!auth.isLoggedIn) { error.value = "请先登录"; loading.value = false; return; }
  try {
    const result = await Promise.all([apiAgentApplication("promoter"), apiAgentApplication("agent")]);
    if (current === epoch) applications.value = result.filter((item) => item.status !== -1);
  } catch (cause) { if (current === epoch) error.value = cause instanceof Error ? cause.message : "申请记录读取失败"; }
  finally { if (current === epoch) loading.value = false; }
}
function goApply(kind: AgentApplicationKind): void {
  const url = kind === "promoter" ? "/pages/users/distributor/apply" : "/pages/users/agent/apply";
  uni.navigateTo({ url });
}
function open(item: AgentApplication): void {
  uni.navigateTo({ url: `/pages/users/agent/state?type=${item.kind}&id=${item.id}` });
}
onShow(() => { void load(); });
onHide(() => { ++epoch; });
onUnload(() => { ++epoch; });
watch(() => [auth.uid, auth.token, auth.sessionVersion], () => { ++epoch; applications.value = []; if (auth.isLoggedIn) void load(); });
</script>

<style scoped>
.page { min-height: 100vh; padding: 28rpx; background: #f5f6f8; box-sizing: border-box; }
.heading { display: block; margin: 8rpx 0 22rpx; font-size: 38rpx; font-weight: 700; }
.card { display: flex; flex-direction: column; gap: 16rpx; margin-top: 18rpx; padding: 28rpx; border-radius: 18rpx; background: #fff; color: #344; font-size: 26rpx; }
.name { font-size: 30rpx; font-weight: 650; }.error { color: #a33; }.secondary { margin-top: 20rpx; color: #176e61; background: #fff; border: 1rpx solid #176e61; }
</style>
