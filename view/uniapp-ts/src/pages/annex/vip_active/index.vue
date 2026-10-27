<template>
  <ThemePage>
    <view class="activation-page" :data-activation-owner="s.loggedIn ? auth.uid : 0" data-member-card-activation>
      <image class="activation-hero" src="/static/membership/card-activation.png" mode="widthFix" aria-label="激活会员享权益" />
      <view v-if="!s.loggedIn" class="activation-login"><view>登录后激活会员卡</view><button @tap="s.login">去登录</button></view>
      <form v-else class="activation-form" @submit="s.activate">
        <input v-model="s.code" class="activation-input" name="account" type="text" maxlength="20" :disabled="!s.canSubmit" aria-label="会员卡号" placeholder="请输入卡号" placeholder-style="color:#CCCCCC" />
        <input v-model="s.password" class="activation-input" name="password" type="text" maxlength="12" password :cursor-spacing="85" :disabled="!s.canSubmit" aria-label="会员卡密" placeholder="请输入卡密" placeholder-style="color:#CCCCCC" />
        <view v-if="s.error" class="activation-notice" role="alert">{{s.error}}</view>
        <button class="activation-submit" form-type="submit" :disabled="!s.canSubmit">{{s.submitting?'激活中…':'确认激活'}}</button>
        <view v-if="s.phase==='uncertain'" class="uncertain-actions"><button @tap="s.viewMembership">查看会员状态</button><button @tap="s.anotherCard">使用其他卡密</button></view>
        <view class="activation-look"><button :disabled="s.submitting" @tap="s.viewRights">查看会员权益</button></view>
      </form>
      <view v-if="s.loggedIn && s.phase==='success'" class="activation-success" role="status" aria-live="polite" aria-label="会员卡激活成功">
        <image class="success-decoration" src="/static/membership/activation-success.png" mode="aspectFit" />
        <view class="success-card"><view class="success-circle"><text>✓</text></view><view class="success-nickname">亲爱的 {{s.nickname || '会员'}}</view></view>
        <view class="success-title">激活成功</view>
        <button class="success-start" @tap="s.startUse">开始使用</button>
        <button class="success-rights" @tap="s.viewRights">查看会员权益</button>
      </view>
    </view>
    <DiySuspendedNavigation />
  </ThemePage>
</template>
<script setup lang="ts">
import {reactive} from 'vue';
import ThemePage from '@/components/ThemePage.vue';
import {useAuthStore} from '@/stores/auth';
import {useMemberCardActivation} from '@/composables/useMemberCardActivation';
const auth=useAuthStore(),s=reactive(useMemberCardActivation());
</script>
<style scoped>
.activation-page{position:relative;min-height:100vh;max-width:750px;margin:auto;padding-bottom:calc(42rpx + env(safe-area-inset-bottom));box-sizing:border-box;background:#f3ece4;overflow:hidden}
.activation-hero{display:block;width:100%;height:710rpx}.activation-form{padding-bottom:30rpx}
.activation-input{height:88rpx;padding:0 24rpx;border:1rpx solid rgba(126,75,6,.5);border-radius:16rpx;margin:32rpx 40rpx;background:rgba(255,255,255,.6);font-size:30rpx;color:#333;box-sizing:border-box}.activation-input:first-child{margin-top:8rpx}
.activation-submit{height:88rpx;border-radius:44rpx;margin:56rpx 40rpx 40rpx;background:#333;font-weight:500;font-size:28rpx;line-height:88rpx;color:#facc7d}.activation-submit::after{border:0}.activation-submit[disabled]{background:#333;color:#facc7d;opacity:.55}
.activation-look{text-align:center;line-height:42rpx}.activation-look button,.success-rights{display:inline-block;margin:0;padding:0;background:transparent;font-size:26rpx;line-height:42rpx;color:#999}.activation-look button::after,.success-rights::after{border:0}
.activation-notice{margin:24rpx 40rpx;color:#8b421a;font-size:26rpx;line-height:40rpx;overflow-wrap:anywhere}.uncertain-actions{display:flex;gap:16rpx;margin:0 40rpx 30rpx}.uncertain-actions button{flex:1;margin:0;background:rgba(255,255,255,.6);font-size:24rpx;color:#6e4b1d;line-height:68rpx}
.activation-login{padding:20rpx 40rpx 60rpx;text-align:center;color:#6e4b1d;font-size:30rpx;line-height:48rpx}.activation-login button{margin:28rpx auto 0;max-width:350rpx;border-radius:44rpx;background:#333;color:#facc7d;font-size:28rpx}
.activation-success{position:fixed;inset:0;background:linear-gradient(180deg,#312b23 0%,#19140e 100%);z-index:20;overflow-y:auto;text-align:center;padding-bottom:calc(48rpx + env(safe-area-inset-bottom));box-sizing:border-box}
.success-decoration{position:absolute;top:276rpx;left:50%;transform:translateX(-50%);width:443rpx;height:392rpx}.success-card{position:relative;display:flex;align-items:center;justify-content:center;width:516rpx;height:298rpx;background:linear-gradient(270deg,#ecd8c8 0%,#dbbea2 100%);border-radius:24rpx;margin:314rpx auto 0}
.success-circle{position:absolute;top:-60rpx;left:50%;transform:translateX(-50%);display:flex;align-items:center;justify-content:center;width:120rpx;height:120rpx;border-radius:50%;border:6rpx solid #fff;background:#f0ca86;box-sizing:border-box;color:#fff;font-size:60rpx;font-weight:500}.success-nickname{max-width:430rpx;font-size:34rpx;overflow-wrap:anywhere;color:#333}
.success-title{margin:140rpx auto 48rpx;color:#facc7d;font-size:44rpx;font-weight:500}.success-start{width:516rpx;height:88rpx;border-radius:44rpx;background:#facc7d;margin:auto;line-height:88rpx;font-size:28rpx;font-weight:500;color:#333}.success-start::after{border:0}.success-rights{margin-top:32rpx;color:#f0dfc3}
@media(min-width:768px){.activation-hero{height:710px}.activation-input{height:54px;font-size:18px;margin:20px 40px}.activation-submit{height:52px;line-height:52px;margin:30px 40px;font-size:18px}.activation-look button{font-size:16px}.success-card{width:360px;height:210px;margin-top:180px}.success-decoration{width:310px;height:275px;top:155px}.success-circle{width:80px;height:80px;top:-40px;font-size:40px}.success-nickname{max-width:310px;font-size:24px}.success-title{margin:90px auto 32px;font-size:32px}.success-start{width:360px;height:56px;line-height:56px;font-size:20px}.success-rights{font-size:16px;margin-top:20px}}
</style>
