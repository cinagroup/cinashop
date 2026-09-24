<template>
  <view class="work-page">
    <!-- #ifdef H5 -->
    <view v-if="access.error.value" class="notice" role="alert">
      {{ access.error.value }}
      <button @tap="load">重新授权或重试</button>
    </view>
    <view v-else-if="loading" class="notice">正在读取客户资料…</view>
    <template v-else-if="client">
      <view class="identity card">
        <image v-if="client.avatar" :src="client.avatar" class="avatar" mode="aspectFill" />
        <view><text class="name">{{ client.name || "客户" }}</text><text class="muted">{{ client.corp_name || client.position || "企业微信客户" }}</text></view>
      </view>
      <view class="card">
        <view class="heading">客户资料</view>
        <view class="row"><text>备注</text><text>{{ client.remark || "暂无" }}</text></view>
        <view class="row"><text>电话</text><text>{{ client.userInfo?.phone || "暂无" }}</text></view>
        <view class="row"><text>分组</text><text>{{ client.userInfo?.userGroup?.group_name || "暂无" }}</text></view>
        <view class="row"><text>会员等级</text><text>{{ client.userInfo?.level || "暂无" }}</text></view>
        <view class="row"><text>余额</text><text>{{ client.userInfo?.now_money ?? "暂无" }}</text></view>
        <view class="row"><text>推荐人</text><text>{{ client.userInfo?.spreadUser?.nickname || "暂无" }}</text></view>
        <view class="row"><text>注册来源</text><text>{{ client.userInfo?.user_type || "暂无" }}</text></view>
      </view>
      <view class="card">
        <view class="heading">跟进标签</view>
        <view v-if="client.tags.length" class="tags"><text v-for="tag in client.tags" :key="`${tag.group_name}:${tag.tag_name}`" class="tag">{{ tag.tag_name }}</text></view>
        <text v-else class="muted">暂无</text>
        <view class="heading subheading">商城用户标签</view>
        <view v-if="client.userInfo?.label?.length" class="tags"><text v-for="tag in client.userInfo.label" :key="tag.id" class="tag">{{ tag.label_name }}</text></view>
        <text v-else class="muted">暂无</text>
      </view>
      <view v-if="!client.userInfo" class="notice">该客户尚未绑定商城账号，订单与浏览记录可能为空。</view>
    </template>
    <WorkNav active="client" :ready="!!access.token.value && !!client" :target-hint="client && hint === client.external_userid ? hint : undefined" />
    <!-- #endif -->
    <!-- #ifndef H5 -->
    <view class="notice">企业微信工作台仅支持 H5 侧边栏。</view>
    <!-- #endif -->
  </view>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { onLoad, onUnload } from "@dcloudio/uni-app";
import { getWorkClientInfo, type WorkClientInfo } from "@/api/work";
import { useWorkAccess } from "@/composables/useWorkAccess";
import WorkNav from "@/components/work/WorkNav.vue";

const access = useWorkAccess("client");
const client = ref<WorkClientInfo | null>(null);
const loading = ref(false);
watch(access.token, (value) => { if (!value) client.value = null; }, { flush: "sync" });
let hint: string | undefined;
let epoch = 0;

onLoad((query) => {
  hint = typeof query?.userid === "string" ? query.userid : undefined;
  void load();
});
onUnload(() => { epoch++; access.dispose(); client.value = null; });

async function load() {
  const current = ++epoch;
  client.value = null;
  loading.value = true;
  const route = `/pages/work/userInfo/index${hint ? `?userid=${encodeURIComponent(hint)}` : ""}`;
  try {
    const token = await access.connect(route, hint);
    if (!token || current !== epoch) return;
    const result = await getWorkClientInfo(token);
    if (current === epoch && await access.verifiedToken(hint, token)) client.value = result;
  } catch (cause) {
    if (current === epoch) access.readFailure(cause);
  } finally {
    if (current === epoch) loading.value = false;
  }
}
</script>

<style scoped>
.work-page { min-height: 100vh; background: #f3f6f9; box-sizing: border-box; padding: 24rpx 24rpx 130rpx; }
.card, .notice { background: #fff; border-radius: 18rpx; padding: 28rpx; margin-bottom: 22rpx; }
.notice { color: #526071; line-height: 1.6; overflow-wrap: anywhere; }.notice button { margin-top: 24rpx; }
.identity { display: flex; align-items: center; gap: 22rpx; }.identity view { display: flex; flex-direction: column; min-width: 0; }
.avatar { width: 88rpx; height: 88rpx; border-radius: 50%; flex-shrink: 0; }.name { font-size: 34rpx; font-weight: 700; }
.muted { color: #657285; font-size: 25rpx; }.heading { font-size: 30rpx; font-weight: 650; margin-bottom: 20rpx; }.subheading { margin-top: 24rpx; }
.row { display: flex; justify-content: space-between; gap: 24rpx; padding: 17rpx 0; border-bottom: 1rpx solid #edf0f4; font-size: 27rpx; }
.row text:last-child { text-align: right; max-width: 64%; overflow-wrap: anywhere; }.tags { display: flex; flex-wrap: wrap; gap: 10rpx; }.tag { background: #e6f2ff; color: #1663b2; padding: 7rpx 12rpx; border-radius: 8rpx; font-size: 24rpx; }
</style>
