<template>
  <ThemePage>
    <view class="member-code-page">
      <view v-if="loading" class="message">正在读取会员信息...</view>
      <view v-if="error" class="message" role="alert"><text>{{ error }}</text><button @tap="load">重新加载</button></view>
      <template v-if="snapshot && snapshot.menu.profile && auth.isLoggedIn">
        <view class="member-heading"><text>{{ snapshot.menu.profile.nickname }}</text><text class="level">{{ snapshot.menu.profile.level_name || '会员' }}</text></view>
        <view class="code-card">
          <view class="code-title">会员付款码</view>
          <view v-if="codeLoading" class="message">正在获取付款码...</view>
          <view v-else-if="codeError" class="message" role="alert">{{ codeError }}</view>
          <view v-if="qrRows.length" class="qr-code" aria-label="当前账号会员付款码">
            <view v-for="(row,r) in qrRows" :key="r" class="qr-row"><view v-for="(dark,c) in row" :key="c" class="qr-cell" :class="{dark}" /></view>
          </view>
          <text v-if="code" class="code-number">{{ code }}</text>
          <text v-if="code" class="expires">{{ userCenterCountdown(codeDeadline,clock) }} 后失效</text>
          <text class="code-tip">此码可用于店员识别会员并发起余额支付。请仅在确认消费时出示。</text>
          <button :disabled="codeLoading" @tap="getMemberCode">{{ code ? '核对付款码' : '获取付款码' }}</button>
        </view>
        <view v-if="snapshot.menu.capabilities.balance" class="assets">
          <view @tap="showBalance=!showBalance"><text>当前余额</text><text class="asset-number">{{ showBalance ? snapshot.menu.profile.now_money : '••••••' }}</text><text class="sub">{{ showBalance ? '点击隐藏' : '点击查看' }}</text></view>
          <view @tap="go('/pages/user/coupon')"><text>优惠券</text><text class="asset-number">{{ snapshot.menu.profile.couponCount }}</text></view>
          <view @tap="go('/pages/user/integral')"><text>积分</text><text class="asset-number">{{ snapshot.menu.profile.integral }}</text></view>
        </view>
        <button v-if="snapshot.menu.capabilities.member" @tap="go('/pages/user/level')">查看会员等级与权益</button>
      </template>
      <view v-else-if="!loading && !auth.isLoggedIn" class="message"><text>登录后出示会员码</text><button @tap="login">前往登录</button></view>
    </view>
  </ThemePage>
</template>
<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import { useUserCenter } from '@/composables/useUserCenter';
import { userCenterCountdown } from '@/utils/userCenter';
const {auth,snapshot,loading,error,load,login,go,codeLoading,codeError,code,codeDeadline,clock,qrRows,showBalance,getMemberCode}=useUserCenter({autoMemberCode:true});
</script>
<style scoped>
.member-code-page{padding:32rpx;max-width:900rpx;margin:auto}.member-heading{display:flex;justify-content:space-between;align-items:center;font-size:34rpx;font-weight:600;padding:30rpx 8rpx}.level{font-size:24rpx;color:var(--view-theme,#e93323)}.code-card{border-radius:28rpx;background:#fff;padding:40rpx;display:flex;flex-direction:column;align-items:center;gap:22rpx}.code-title{font-size:32rpx;font-weight:600}.qr-code{width:440rpx;height:440rpx;max-width:100%;display:flex;flex-direction:column;background:#fff}.qr-row{display:flex;flex:1;min-height:0}.qr-cell{flex:1;background:#fff;min-width:0}.qr-cell.dark{background:#111}.code-number{letter-spacing:12rpx;font-size:40rpx;font-weight:600}.expires,.sub{font-size:24rpx;color:#777}.code-tip{font-size:24rpx;color:#666;line-height:1.7;text-align:center}.code-card button{margin:8rpx 0;width:100%;font-size:28rpx}.assets{display:flex;justify-content:space-around;gap:20rpx;background:#fff;margin:24rpx 0;border-radius:24rpx;padding:32rpx 16rpx}.assets>view{display:flex;flex:1;flex-direction:column;align-items:center;gap:16rpx;font-size:26rpx}.asset-number{font-size:34rpx;font-weight:600}.message{text-align:center;padding:30rpx;color:#777;font-size:28rpx;line-height:1.7}.message button{margin-top:24rpx}
</style>
