<template>
  <view class="page">
    <view class="form-section">
      <view class="form-title">设置支付密码</view>
      <input v-model="form.password" class="form-input" type="number" password maxlength="6" placeholder="请输入6位数字密码" />
      <input v-model="form.confirm" class="form-input" type="number" password maxlength="6" placeholder="请再次确认密码" />
      <view class="tips">支付密码用于余额支付、提现等敏感操作</view>
      <view class="submit-btn" @tap="save">确认设置</view>
    </view>
  </view>
</template>
<script setup lang="ts">
import { reactive } from "vue";
import { http } from "@/utils/request";
const form = reactive({ password: "", confirm: "" });
async function save() {
  if (!form.password || form.password.length !== 6) return uni.showToast({ title: "请输入6位数字", icon: "none" });
  if (form.password !== form.confirm) return uni.showToast({ title: "两次密码不一致", icon: "none" });
  try {
    await http.post("/user/edit", { pay_password: form.password });
    uni.showToast({ title: "设置成功", icon: "success" });
    setTimeout(() => uni.navigateBack(), 800);
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : "设置失败", icon: "none" });
  }
}
</script>
<style scoped>
.page { padding: 20rpx; }
.form-section { background: #fff; border-radius: 16rpx; padding: 40rpx 30rpx; }
.form-title { font-size: 32rpx; font-weight: 600; margin-bottom: 30rpx; }
.form-input { background: #f7f7f7; border-radius: 12rpx; padding: 24rpx; margin-bottom: 20rpx; font-size: 30rpx; letter-spacing: 8rpx; }
.tips { font-size: 22rpx; color: #999; margin-bottom: 30rpx; }
.submit-btn { background: #e93323; color: #fff; text-align: center; padding: 24rpx; border-radius: 44rpx; font-size: 30rpx; }
</style>
