<template>
  <view class="legal-page">
    <view class="legal-heading">{{ title }}</view>
    <view v-if="loading" class="state">正在加载协议…</view>
    <view v-else-if="error" class="state">
      <text>{{ error }}</text>
      <button v-if="error !== '协议类型不支持'" class="retry" @tap="load">重新加载</button>
    </view>
    <view v-else-if="loaded && !content" class="state">商家尚未配置该协议</view>
    <view v-else-if="content" class="legal-body">
      <rich-text :nodes="content" />
    </view>
  </view>
</template>

<script setup lang="ts">
import { useGovernanceAgreement } from "@/composables/useGovernanceAgreement";

const { title, content, loading, loaded, error, load } = useGovernanceAgreement();
</script>

<style scoped>
.legal-page { min-height: 100vh; box-sizing: border-box; padding: 36rpx 30rpx 70rpx; background: #fff; color: #282828; }
.legal-heading { font-size: 38rpx; line-height: 1.4; font-weight: 600; margin-bottom: 32rpx; }
.legal-body { font-size: 28rpx; line-height: 1.7; overflow-wrap: anywhere; }
.state { color: #777; font-size: 27rpx; line-height: 1.6; }
.retry { display: block; width: 220rpx; margin: 24rpx 0 0; padding: 0; background: #fff; color: #d6382a; border: 1rpx solid #d6382a; font-size: 26rpx; }
</style>
