<template>
 <ThemePage>
  <view class="level-activation" :data-level-activation-owner="s.loggedIn?auth.uid:0" :data-level-activation-phase="s.phase" :data-level-activation-loaded="!!s.state" :data-level-activation-status="s.state?.level_status??-32768">
   <view class="header-bg" />
   <view class="activation-header"><view class="title">激活会员卡</view><view>新用户免费激活会员卡</view></view>
   <view v-if="!s.loggedIn" class="state-card"><view>登录后免费激活会员卡</view><button @tap="s.login">去登录</button></view>
   <template v-else>
    <view v-if="s.loading" class="state-card" role="status">正在读取会员激活信息…</view>
    <view v-if="s.error" class="notice" role="alert">{{s.error}}</view>
    <view v-if="s.phase==='pending'" class="state-card" role="status">正在激活会员卡…</view>
    <view v-else-if="s.phase==='uncertain'" class="state-card uncertain"><view class="state-title">激活结果暂未确认</view><view>请先重新读取会员状态，确认当前账号是否已经激活。</view><view v-if="s.state&&!s.state.activated">当前账号尚未激活；上次请求仍可能完成。</view><button :disabled="s.loading" @tap="s.load">重新读取会员状态</button><button v-if="s.state&&!s.state.activated&&s.state.member_enabled&&s.state.activation_required" :disabled="s.loading" @tap="s.startAgain">重新填写资料</button><button @tap="s.viewWallet">查看我的优惠券</button></view>
    <template v-else-if="s.state">
     <view v-if="s.state.activated&&s.phase!=='success'" class="state-card"><view class="state-title">当前账号已激活</view><view>可在会员等级、资产和优惠券中查看当前权益。</view><button @tap="s.goLevel">查看会员等级</button><button @tap="s.viewWallet">查看我的优惠券</button></view>
     <view v-else-if="!s.state.member_enabled" class="state-card">会员卡功能暂未开启</view>
     <view v-else-if="!s.state.activation_required" class="state-card"><view>会员卡功能暂不需要激活</view><button @tap="s.goLevel">查看会员等级</button></view>
     <template v-else-if="s.phase==='idle'">
      <view class="form-card">
       <view class="form-heading">{{document.fields.length?'请填写以下信息':'我的成长特权'}}</view>
       <view class="form-body">
        <view v-for="field in document.fields" :key="`${document.epoch}:${field.info}`" class="field-row" :data-activation-field="field.info">
         <view class="field-name" :class="{required:field.required===1}">{{field.info}}</view>
         <view class="field-control">
          <picker v-if="field.format==='date'" mode="date" :value="field.value" start="1900-01-01" :end="s.dateEnd" :disabled="!document.allowed()" :aria-label="'选择'+field.info" @change="document.input(field.info,$event.detail.value)"><view class="picker-value" :class="{placeholder:!field.value}">{{field.value||field.tip}} <text>›</text></view></picker>
          <picker v-else-if="field.format==='address'" mode="multiSelector" :value="document.indices(field.info)" :range="document.ranges(field.info)" :disabled="!document.allowed()||s.citiesLoading||!s.cities.length" :aria-label="'选择'+field.info" @columnchange="document.column(field.info,$event.detail)" @change="document.region(field.info,$event.detail)"><view class="picker-value" :class="{placeholder:!field.value}">{{s.citiesLoading?'地区读取中…':document.label(field.info)}} <text>›</text></view></picker>
          <radio-group v-else-if="field.format==='radio'" class="radio-options" :aria-label="field.info" @change="document.input(field.info,$event.detail.value)"><label v-for="(choice,index) in field.singlearr" :key="index"><radio :value="String(index)" :checked="field.value===String(index)" :disabled="!document.allowed()" color="#E6993A" />{{choice}}</label></radio-group>
          <input v-else :type="field.format==='num'?'digit':field.format==='id'?'idcard':field.format==='phone'?'tel':'text'" :value="field.value" :placeholder="field.tip" placeholder-class="placeholder" :maxlength="1024" :disabled="!document.allowed()" :aria-label="field.info" @input="document.input(field.info,nativeValue($event))" />
         </view>
        </view>
        <view v-if="s.cityError" class="city-error" role="alert">{{s.cityError}}<button size="mini" @tap="s.loadCities">重新读取地区</button></view>
       </view>
      </view>
      <button class="activate-button" :disabled="!s.canSubmit" @tap="s.activate">确认激活</button>
     </template>
     <view v-else-if="s.phase==='success'" class="state-card"><view class="state-title">激活成功</view><button @tap="s.goLevel">查看会员等级</button></view>
    </template>
    <view v-if="!s.loading&&s.phase!=='pending'&&s.phase!=='success'&&s.phase!=='uncertain'" class="read-actions"><button @tap="s.load">重新读取会员状态</button></view>
   </template>
   <view v-if="s.loggedIn&&s.phase==='success'&&s.receipt&&(s.receipt.rewards.level_give_integral>0||s.receipt.rewards.level_give_money>0||s.receipt.owned_coupons.length>0)" class="gift-mask">
    <view class="gift-dialog" role="dialog" aria-label="激活送好礼"><image class="gift-header" src="/static/php-level-activation/gift-header.png" mode="aspectFit" /><view class="gift-title">激活送好礼</view><view class="gift-status">激活成功</view><scroll-view class="gift-list" scroll-y>
     <view v-if="s.receipt.rewards.level_give_integral>0" class="gift-row" data-activation-gift="integral"><text class="gift-number">{{s.receipt.rewards.level_give_integral}}</text><text>赠送积分</text></view>
     <view v-if="s.receipt.rewards.level_give_money>0" class="gift-row" data-activation-gift="money"><text class="gift-number">{{s.receipt.rewards.level_give_money}}<text class="unit">元</text></text><text>赠送余额</text></view>
     <view v-for="coupon in s.receipt.owned_coupons" :key="coupon.id" class="gift-row coupon-gift" role="button" :aria-label="'查看'+coupon.coupon_title" :data-activation-coupon-owned="coupon.id" @tap="s.viewCoupon(coupon.id)"><text class="gift-number">{{levelActivationCouponBenefit(coupon)}}</text><view><view>{{coupon.coupon_title||'优惠券'}}</view><view class="coupon-minimum">{{coupon.use_min_price==='0.00'?'无门槛':'满'+coupon.use_min_price+'元可用'}}</view></view></view>
    </scroll-view><button class="gift-accept" @tap="s.goLevel">立即收下</button><button class="gift-wallet" @tap="s.viewWallet">查看我的优惠券</button></view>
   </view>
  </view>
  <DiySuspendedNavigation />
 </ThemePage>
</template>
<script setup lang="ts">
import {computed,reactive} from 'vue';
import ThemePage from '@/components/ThemePage.vue';
import {useAuthStore} from '@/stores/auth';
import {useMemberLevelActivation} from '@/composables/useMemberLevelActivation';
import {levelActivationCouponBenefit} from '@/api/memberLevelActivation';
const auth=useAuthStore(),s=reactive(useMemberLevelActivation()),document=computed(()=>s.form());
function nativeValue(event:unknown):unknown{return(event as {detail?:{value?:unknown}}|null)?.detail?.value;}
</script>
<style scoped>
.level-activation{position:relative;min-height:100vh;max-width:750rpx;margin:auto;padding-bottom:150rpx;box-sizing:border-box;overflow:hidden;color:#333;font-size:28rpx;background:#f5f5f5}.header-bg{position:absolute;top:0;left:0;width:100%;height:568rpx;background:linear-gradient(180deg,#1e1c19,#19140e)}.activation-header{position:relative;background-image:url('/static/php-level-activation/card-art.png'),url('/static/php-level-activation/card-face.png');background-position:392rpx 34rpx,left top;background-repeat:no-repeat;background-size:240rpx 155rpx,100% 100%;width:686rpx;max-width:calc(100% - 64rpx);height:328rpx;padding:60rpx 0 0 64rpx;margin:44rpx auto 0;box-sizing:border-box;color:rgba(126,75,6,.8);font-size:24rpx;line-height:34rpx}.activation-header .title{margin-bottom:8rpx;font-weight:700;font-size:44rpx;line-height:62rpx}.form-card{position:relative;margin:-104rpx 0 0}.form-heading{height:104rpx;box-sizing:border-box;padding:40rpx 0 0 40rpx;background:url('/static/php-level-activation/form-heading.png') no-repeat;background-size:100% 100%;font-weight:600;font-size:30rpx;line-height:42rpx}.form-body{background:#fff;min-height:300rpx;border-radius:0 0 40rpx 40rpx;padding-bottom:24rpx}.field-row{display:flex;align-items:center;gap:20rpx;padding:32rpx 40rpx;font-size:28rpx;line-height:40rpx}.field-name{flex-shrink:0;max-width:42%;padding-left:26rpx;overflow-wrap:anywhere;background-repeat:no-repeat;background-position:left center;background-size:14rpx}.field-name.required{background-image:url('/static/php-level-activation/required.png')}.field-control{flex:1;min-width:0;text-align:right}.field-control input{width:100%;font-size:28rpx;text-align:right;line-height:40rpx}.placeholder{font-size:28rpx;font-weight:400;color:#ccc}.picker-value{display:flex;justify-content:flex-end;align-items:center;gap:8rpx;overflow-wrap:anywhere}.picker-value text{color:#999;font-size:30rpx}.radio-options{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:12rpx 24rpx}.radio-options label{display:flex;align-items:center;gap:8rpx;overflow-wrap:anywhere}.radio-options :deep(.uni-radio-input){width:28rpx;height:28rpx;margin-right:4rpx;border-color:#e6993a}.activate-button{position:fixed;z-index:5;left:50%;bottom:calc(32rpx + env(safe-area-inset-bottom));transform:translateX(-50%);width:686rpx;max-width:calc(100% - 64rpx);height:88rpx;padding:0;border-radius:44rpx;background:#facc7d;text-align:center;font-size:28rpx;font-weight:500;line-height:88rpx;color:#7e4b06}.activate-button::after,.state-card button::after,.read-actions button::after,.gift-dialog button::after{border:0}.activate-button[disabled]{background:#ead9bd;color:#998568}.state-card{position:relative;background:#fff;border-radius:24rpx;margin:24rpx 32rpx;padding:40rpx 28rpx;text-align:center;font-size:26rpx;line-height:1.8;overflow-wrap:anywhere}.state-title{font-size:32rpx;font-weight:600;margin-bottom:12rpx}.state-card button{display:inline-block;font-size:26rpx;line-height:64rpx;margin:20rpx 8rpx 0;padding:0 28rpx;background:#facc7d;color:#7e4b06;border-radius:32rpx}.notice{position:relative;margin:24rpx 32rpx;padding:20rpx 24rpx;border-radius:18rpx;background:#fff4e7;color:#8a4d26;font-size:24rpx;line-height:1.6;overflow-wrap:anywhere}.read-actions{position:relative;text-align:center;margin:30rpx}.read-actions button{display:inline-block;padding:0 24rpx;font-size:24rpx;background:#fff;color:#777;line-height:60rpx}.city-error{padding:20rpx 40rpx;color:#9a5231;font-size:24rpx;line-height:1.6}.city-error button{margin-top:12rpx;font-size:24rpx}.gift-mask{position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:130rpx 20rpx 30rpx;box-sizing:border-box}.gift-dialog{position:relative;width:538rpx;max-width:100%;max-height:calc(100vh - 160rpx);padding:40rpx 32rpx 24rpx;border-radius:16rpx;background:var(--view-theme,#e93323);box-sizing:border-box;text-align:center;color:#fff}.gift-header{position:absolute;top:-180rpx;left:50%;transform:translateX(-50%);width:590rpx;max-width:112%;height:294rpx;pointer-events:none}.gift-title{position:relative;font-size:44rpx;font-weight:600;line-height:1.5}.gift-status{position:relative;font-size:24rpx;margin:0 0 20rpx;opacity:.9}.gift-list{max-height:44vh;height:420rpx}.gift-row{display:flex;align-items:center;justify-content:space-between;gap:16rpx;min-height:100rpx;box-sizing:border-box;margin:12rpx 0;padding:14rpx 28rpx;background:url('/static/php-level-activation/gift-row.png') no-repeat;background-size:100% 100%;color:#ab531c;font-size:26rpx;text-align:right;overflow-wrap:anywhere}.gift-number{flex-shrink:0;max-width:52%;font-family:'CinaShop DIN',sans-serif;font-size:38rpx;font-weight:600;text-align:left;overflow-wrap:anywhere}.gift-number .unit{font-size:24rpx}.coupon-minimum{font-size:20rpx;margin-top:4rpx}.gift-accept{margin:24rpx 0 0;line-height:76rpx;background:#ffe1a5;color:#b05a20;border-radius:38rpx;font-size:28rpx;font-weight:600}.gift-wallet{margin-top:12rpx;font-size:24rpx;line-height:52rpx;color:#fff;background:transparent}
</style>
