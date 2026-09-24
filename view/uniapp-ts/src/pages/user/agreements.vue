<template>
  <view class="agreements-page">
    <navigator class="agreement-link" url="/pages/user/legalContent?type=user">
      <text>用户协议</text><text class="arrow">›</text>
    </navigator>
    <navigator class="agreement-link" url="/pages/user/legalContent?type=privacy">
      <text>隐私协议</text><text class="arrow">›</text>
    </navigator>
    <navigator class="agreement-link" url="/pages/user/legalContent?type=cancel">
      <text>注销协议</text><text class="arrow">›</text>
    </navigator>
  </view>
</template>

<style scoped>
.agreements-page { min-height: 100vh; box-sizing: border-box; padding: 24rpx 20rpx; background: #f7f7f7; }
.agreement-link { display: flex; justify-content: space-between; align-items: center; box-sizing: border-box; min-height: 106rpx; padding: 0 30rpx; border-bottom: 1rpx solid #f0f0f0; background: #fff; color: #282828; font-size: 30rpx; }
.agreement-link:first-child { border-radius: 18rpx 18rpx 0 0; }
.agreement-link:last-child { border: 0; border-radius: 0 0 18rpx 18rpx; }
.arrow { color: #888; font-size: 38rpx; }
</style>
