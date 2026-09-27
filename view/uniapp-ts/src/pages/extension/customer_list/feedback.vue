<template>
  <view class="feedback-page">
    <view class="intro">
      <text class="title">客服暂时离线</text>
      <text class="message">{{ message || "请留下您的反馈，我们会尽快处理。" }}</text>
    </view>
    <view v-if="!loggedIn" class="panel">
      <text>登录后可以提交反馈。</text>
      <button class="primary" @tap="login">去登录</button>
    </view>
    <view v-else class="panel">
      <text class="heading">我要反馈</text>
      <input v-model="name" :disabled="!canEdit" maxlength="255" placeholder="请输入您的姓名" aria-label="姓名" />
      <input v-model="phone" :disabled="!canEdit" maxlength="30" type="number" placeholder="请输入您的联系电话" aria-label="联系电话" />
      <textarea v-model="content" :disabled="!canEdit" maxlength="500" placeholder="请填写反馈内容" aria-label="反馈内容" />
      <text v-if="error" class="error" role="alert">{{ error }}</text>
      <button class="primary" :disabled="!canEdit" @tap="submit">{{ submitting ? "正在提交…" : unknown ? "请先核实提交结果" : "提交反馈" }}</button>
    </view>
  </view>
</template>

<script setup lang="ts">
import { useFeedback } from "@/composables/useFeedback";

const { name, phone, content, message, error, loggedIn, submitting, unknown, canEdit, submit, login } = useFeedback();
</script>

<style scoped>
.feedback-page { min-height: 100vh; background: #f5f6f8; box-sizing: border-box; }
.intro { background: #343b49; color: #fff; padding: 48rpx 32rpx 68rpx; display: flex; flex-direction: column; gap: 18rpx; }
.title { font-size: 38rpx; font-weight: 700; }.message { font-size: 26rpx; line-height: 1.6; overflow-wrap: anywhere; }
.panel { margin: -22rpx 24rpx 24rpx; padding: 32rpx; border-radius: 18rpx; background: #fff; display: flex; flex-direction: column; gap: 24rpx; box-sizing: border-box; }
.heading { font-size: 32rpx; font-weight: 600; }
input, textarea { width: 100%; background: #f5f6f8; border-radius: 12rpx; padding: 18rpx 20rpx; box-sizing: border-box; font-size: 28rpx; }
input { height: 88rpx; min-height: 88rpx; }
textarea { height: 260rpx; }.primary { width: 100%; background: #2768ca; color: #fff; border-radius: 44rpx; margin: 16rpx 0 0; }
.primary[disabled] { opacity: .55; }.error { color: #a72d2d; font-size: 26rpx; overflow-wrap: anywhere; }
</style>
