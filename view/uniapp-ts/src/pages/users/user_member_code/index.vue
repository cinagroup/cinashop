<template>
  <view class="page">
    <view class="card">
      <text class="title">会员核销码</text>
      <text class="description">请让工作人员在履约核销页内扫码查单，再核对并选择需要核销的订单。</text>
      <view v-if="code" class="code-panel">
        <MemberCodeQr :code="code" @error="drawFailed" />
        <text class="member-code">{{ code }}</text>
        <text class="privacy-note">仅向本次办理业务的工作人员出示</text>
        <button class="secondary" @tap="hideCode">隐藏会员核销码</button>
      </view>
      <template v-else>
        <text class="placeholder">点击下方按钮后显示本人会员核销码</text>
        <text v-if="error" class="error" role="alert">{{ error }}</text>
        <button v-if="loggedIn" class="primary" :loading="loading" :disabled="loading" @tap="showCode">
          {{ loading ? "正在读取会员核销码" : error ? "重新显示会员核销码" : "显示会员核销码" }}
        </button>
        <button v-else class="primary" @tap="login">登录后显示会员核销码</button>
      </template>
    </view>
  </view>
</template>

<script setup lang="ts">
import MemberCodeQr from "@/components/MemberCodeQr.vue";
import { useMemberCode } from "@/composables/useMemberCode";

const { code, loading, error, loggedIn, showCode, hideCode, drawFailed, login } = useMemberCode();
</script>

<style scoped>
.page { min-height: 100vh; padding: 32rpx 28rpx; box-sizing: border-box; background: #f5f6f8; }
.card { display: flex; flex-direction: column; gap: 24rpx; padding: 38rpx 28rpx; border-radius: 24rpx; background: #fff; color: #25354c; }
.title { font-size: 36rpx; font-weight: 700; }
.description, .placeholder { font-size: 28rpx; line-height: 1.7; color: #526178; }
.placeholder { padding: 58rpx 0; text-align: center; }
.code-panel { display: flex; flex-direction: column; gap: 24rpx; }
.member-code { text-align: center; font-size: 30rpx; overflow-wrap: anywhere; }
.privacy-note { text-align: center; color: #657184; font-size: 24rpx; }
.error { font-size: 26rpx; color: #ab3f37; }
.primary { width: 100%; color: #fff; background: #176e61; font-size: 28rpx; }
.secondary { width: 100%; color: #176e61; border: 1rpx solid #176e61; background: #fff; font-size: 28rpx; }
</style>
