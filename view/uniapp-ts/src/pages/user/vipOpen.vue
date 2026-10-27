<template>
 <ThemePage>
  <view class="vip-home" :data-member-home-owner="s.loggedIn ? auth.uid : 0" :data-member-home-phase="s.phase" :data-selected-plan="s.selectedId" :data-member-order="s.order?.orderId || ''">
   <view class="header-bg" />
   <view class="card-section">
    <image class="vip-paid" src="/static/membership/vip-paid.png" mode="aspectFit" />
    <view class="member-card">
     <view class="avatar-wrap">
      <image v-if="s.home && s.avatarPreview.src" :key="s.avatarPreview.src" class="avatar" :src="s.avatarPreview.src" mode="aspectFill" @error="s.avatarPreview.error" />
      <view v-else class="avatar avatar-placeholder">{{s.home?.nickname.slice(0,1) || '会'}}</view>
      <view class="identity">
       <view class="nickname">{{s.home?.nickname || (s.loggedIn ? 'SVIP会员' : '登录后开通会员')}}</view>
       <view v-if="s.home?.permanent" class="member-tips">永久SVIP会员</view>
       <view v-else-if="s.home?.member" class="member-tips">会员有效期至 {{s.expiry}}</view>
       <view v-else class="member-tips">享受会员专属优惠与权益</view>
       <button v-if="s.loggedIn" class="rights-entry" @tap="s.rights()">权益介绍 <text>›</text></button>
       <button v-else class="rights-entry" @tap="s.login">去登录 <text>›</text></button>
      </view>
     </view>
     <scroll-view v-if="s.rightItems.length" class="rights-scroll" scroll-x :show-scrollbar="false">
      <view class="rights-row" :class="{compact:s.rightItems.length<=5}">
       <button v-for="right in s.rightItems" :key="right.id" class="right-item" :data-member-right="right.id" :aria-label="'查看'+right.title+'权益'" @tap="s.rights(right.id)">
        <view class="right-icon"><image v-if="right.preview.src" :key="right.preview.src" class="right-image" :src="right.preview.src" mode="aspectFit" @error="right.preview.error" /><text v-else>{{right.title.slice(0,1)}}</text></view>
        <view class="right-name">{{right.title}}</view><view class="right-explain">{{right.explain}}</view>
       </button>
      </view>
     </scroll-view>
     <view v-else class="rights-empty">{{s.loggedIn ? '尊享更多会员权益' : '会员专享 · 品质好物'}}</view>
    </view>
   </view>
   <view class="other-section">
    <view v-if="!s.loggedIn" class="state"><view>登录后查看会员卡种和专属优惠</view><button class="gold-button" @tap="s.login">去登录</button></view>
    <template v-else>
     <view v-if="s.loading" class="state compact-state" role="status">正在读取会员资料…</view>
     <view v-if="s.error" class="notice" role="alert">{{s.error}}</view>
     <view v-if="s.phase==='uncertain'" class="recovery-actions">
      <button :disabled="s.loading || s.busy" @tap="s.readOriginal">查看原订单状态</button>
      <button class="gold-button" :disabled="s.loading || s.busy" @tap="s.continueOriginal">继续处理原订单</button>
     </view>
     <view v-if="!s.home && !s.loading" class="state"><view>会员资料暂不可用</view><button @tap="s.load">重新读取会员首页</button></view>
     <template v-if="s.home">
      <view class="member-statistics"><text>{{s.home.shopName || '会员专享'}}</text><text>已加入 {{s.home.registerDays}} 天 · 累计节省 ¥{{s.home.saved}}</text></view>
      <view v-if="s.home.permanent" class="permanent-note">您已是永久SVIP会员，尽享会员权益</view>
      <view v-else-if="s.plans.length" class="type-section">
       <view class="type-inner">
        <view class="section-heading plan-heading"><text>选择卡种</text><button :disabled="s.busy" @tap="s.activation">点击兑换卡密</button></view>
        <scroll-view class="plan-scroll" scroll-x :show-scrollbar="false">
         <button v-for="plan in s.plans" :key="plan.id" :data-member-plan="plan.id" :aria-label="'选择'+plan.title" :aria-pressed="s.selectedId===plan.id" class="plan-card" :class="{on:s.selectedId===plan.id}" :disabled="s.phase!=='idle' || s.busy" @tap="s.selectPlan(plan.id)">
          <view v-if="plan.label" class="badge">限时特惠</view><view class="plan-name">{{plan.title}}</view>
          <view class="plan-price">￥<text>{{plan.payPrice}}</text></view><view class="original-price">￥{{plan.price}}</view>
          <view class="saving">{{s.savings(plan)==='0.00' ? (plan.type==='free' ? '免费体验' : '会员专享') : '立省'+s.savings(plan)+'元'}}</view>
         </button>
        </scroll-view>
        <view v-if="s.selected" class="plan-duration">{{s.selected.type==='ever' ? '永久有效' : s.selected.vipDay+'天会员'}} · 开通后{{s.selected.expiry}}</view>
       </view>
      </view>
      <view v-else class="state compact-state">{{s.home.freeUsed ? '体验会员已领取，暂无其他可用卡种' : '暂无可用会员卡种'}}</view>
      <view v-if="s.home.coupons.length" class="coupon-section">
       <view class="section-heading"><text>会员优惠券</text><button @tap="s.allCoupons">查看更多会员优惠券 <text>›</text></button></view>
       <scroll-view class="coupon-scroll" scroll-x :show-scrollbar="false">
        <view v-for="coupon in s.home.coupons" :key="coupon.id" class="coupon-item" :class="{gray:coupon.disabled}" :data-member-coupon="coupon.id" :aria-label="coupon.title+' '+coupon.status">
         <view class="coupon-inner"><view class="coupon-type">{{coupon.scope}}</view><view class="coupon-price"><text v-if="coupon.type===1">￥</text><text class="coupon-number">{{s.couponAmount(coupon)}}</text><text v-if="coupon.type===2">折</text></view><view class="coupon-status">{{coupon.status}}</view></view>
         <view class="coupon-footer">{{coupon.minimum==='0.00' ? '无门槛券' : '满'+coupon.minimum+'可用'}}</view>
        </view>
       </scroll-view>
      </view>
      <view v-if="s.mediaExpired" class="notice">图片预览已过期，重新读取后查看 <button :disabled="s.busy" @tap="s.load">重新读取</button></view>
      <view class="recommend-section">
       <view class="recommend-heading"><view /><text>SVIP商品推荐</text><view /></view>
       <view class="products">
        <button v-for="item in s.productItems" :key="item.id" class="product-card" :data-member-product="item.id" :aria-label="'查看'+item.title" @tap="s.product(item.id)">
         <image v-if="item.preview.src" :key="item.preview.src" :src="item.preview.src" class="product-image" mode="aspectFill" @error="item.preview.error" /><view v-else class="product-image product-placeholder">商品图片暂不可用</view>
         <view class="product-name">{{item.title}}</view><view class="product-price">¥{{item.price}} <text v-if="item.vipPrice!=='0.00'" class="vip-price">SVIP ¥{{item.vipPrice}}</text></view>
        </button>
       </view>
       <view v-if="s.productError" class="notice" role="alert">{{s.productError}}</view>
       <view v-if="!s.products.length && s.productFinished" class="state compact-state">暂无推荐商品</view>
       <button v-if="!s.productFinished" class="more-products" :disabled="s.productLoading" @tap="s.moreProducts">{{s.productLoading?'推荐加载中…':'加载更多推荐'}}</button>
       <view v-else-if="s.products.length" class="list-end">已经到底了</view>
      </view>
     </template>
    </template>
   </view>
   <view v-if="s.loggedIn && s.selected && (s.phase==='idle' || s.phase==='creating')" class="purchase-footer">
    <view class="purchase-row"><view class="footer-price"><text class="currency">¥</text><text class="amount">{{s.selected.payPrice}}</text><text class="struck-price">划线价¥{{s.selected.price}}</text></view><button :disabled="!s.canCreate" class="buy" @tap="s.create">{{s.busy?'正在创建…':s.selected.type==='free'?'立即试用':'立即支付'}}</button></view>
    <view class="agreement-row"><button role="checkbox" aria-label="同意会员服务协议" :aria-checked="s.agreed" :disabled="s.busy" class="agreement-check" :class="{checked:s.agreed}" @tap="s.toggleAgreement"><text>{{s.agreed?'✓':''}}</text></button><text>开通前请确认</text><button class="agreement-link" @tap="s.agreement">《会员服务协议》</button></view>
   </view>
   <view v-if="s.phase==='choosing' || s.phase==='paying'" class="modal-mask">
    <view class="payment-dialog" role="dialog" aria-label="会员订单支付" aria-modal="true">
     <view class="dialog-title">会员订单支付</view><view class="order-number">{{s.order?.orderId}}</view><view class="checkout-price">¥{{s.cashier?.price || s.order?.price}}</view>
     <view class="balance-caption">账户余额 ¥{{s.home?.balance || '—'}}</view>
     <button v-for="entry in paymentMethods" :key="entry.value" :data-member-pay-method="entry.value" class="payment-method" :class="{on:s.method===entry.value}" :disabled="s.busy || !s.cashier?.methods[entry.value].enabled || (s.lockedMethod && s.method!==entry.value)" :aria-pressed="s.method===entry.value" @tap="s.selectMethod(entry.value)"><text>{{entry.label}}</text><text>{{s.cashier?.methods[entry.value].enabled ? (s.method===entry.value?'✓':'') : s.cashier?.methods[entry.value].reason}}</text></button>
     <view v-if="s.error" class="notice" role="alert">{{s.error}}</view><view v-if="s.cashier && !s.cashier.payable" class="notice">{{s.cashier.reason}}</view>
     <button class="gold-button confirm-pay" :disabled="!s.canPay" @tap="s.pay">{{s.busy?'正在支付…':'确认支付 ¥'+(s.cashier?.price || s.order?.price || '0.00')}}</button>
     <button v-if="!s.lockedMethod" class="change-plan" :disabled="s.busy" @tap="s.changePlan">更换套餐</button>
     <button v-else class="change-plan" :disabled="s.busy" @tap="s.readOriginal">查看原订单状态</button>
    </view>
   </view>
   <view v-if="s.phase==='success' && s.order?.paid" class="modal-mask">
    <view class="success-dialog" role="dialog" aria-label="会员开通成功" aria-modal="true"><view class="success-mark">✓</view><view class="dialog-title">会员开通成功</view><view class="success-note">{{s.home?.permanent?'尊享永久会员权益':'会员权益已生效'}}</view><view v-if="s.error" class="notice">{{s.error}}</view><button class="gold-button" @tap="s.successHome">返回会员首页</button></view>
   </view>

  </view>
  <DiySuspendedNavigation />
 </ThemePage>
</template>
<script setup lang="ts">
import {computed,reactive} from 'vue';
import {onShow} from '@dcloudio/uni-app';
import ThemePage from '@/components/ThemePage.vue';
import {useAuthStore} from '@/stores/auth';
import {useMemberHome} from '@/composables/useMemberHome';
import type {MemberPayMethod} from '@/api/memberHome';
const auth=useAuthStore(),s=reactive(useMemberHome());
const paymentMethods=computed(()=>[{value:'yue' as MemberPayMethod,label:'余额支付'},{value:'weixin' as MemberPayMethod,label:'微信支付'},...(s.platform==='h5'?[{value:'alipay' as MemberPayMethod,label:'支付宝支付'}]:[])]);
onShow(()=>{if(typeof uni.setNavigationBarTitle==='function')uni.setNavigationBarTitle({title:'SVIP会员'});if(typeof uni.setNavigationBarColor==='function')uni.setNavigationBarColor({frontColor:'#ffffff',backgroundColor:'#121212'});});
</script>
<style scoped>
.vip-home{position:relative;min-height:100vh;max-width:750px;margin:auto;padding-bottom:calc(220rpx + env(safe-area-inset-bottom));overflow:hidden;color:#333;background:#f5f5f5;box-sizing:border-box}.vip-home button{font:inherit;line-height:inherit;box-sizing:border-box}.vip-home button::after{border:0}.vip-home button:disabled{opacity:.48}
.header-bg{position:absolute;top:0;left:0;width:100%;height:820rpx;background:#121212 url('/static/membership/home-header.png') no-repeat right top;background-size:566rpx 334rpx}.card-section{position:relative;min-height:528rpx;padding:48rpx 20rpx 30rpx;box-sizing:border-box}.vip-paid{position:absolute;top:40rpx;right:52rpx;width:229rpx;height:329rpx;pointer-events:none}.member-card{position:relative;min-height:450rpx;border-radius:24rpx;background:rgba(255,255,255,.05)}.avatar-wrap{display:flex;align-items:flex-start;min-height:236rpx;padding:62rpx 24rpx 0 40rpx;box-sizing:border-box}.avatar{flex:none;width:88rpx;height:88rpx;border-radius:50%;margin-right:35rpx}.avatar-placeholder{display:flex;align-items:center;justify-content:center;background:#3c3327;color:#f3d598;font-size:36rpx}.identity{min-width:0;max-width:330rpx;z-index:1}.nickname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ffeac0;font-weight:500;font-size:32rpx;line-height:44rpx}.member-tips{margin-top:6rpx;font-size:22rpx;line-height:30rpx;color:rgba(254,227,174,.8)}.rights-entry{display:inline-block;padding:0;margin:12rpx 0 0;background:transparent;text-align:left;font-size:22rpx!important;line-height:30rpx!important;color:rgba(254,227,174,.6)}.rights-entry text{font-size:30rpx;margin-left:8rpx}
.rights-scroll{width:100%}.rights-row{display:flex;width:max-content;min-width:100%;padding:0 0 32rpx;box-sizing:border-box}.rights-row.compact{width:100%}.right-item{flex:0 0 140rpx;width:140rpx;padding:0 8rpx;margin:0;border:0;border-radius:0;background:transparent;color:rgba(255,255,255,.4);text-align:center}.compact .right-item{flex:1;width:auto;min-width:0}.right-icon{display:flex;align-items:center;justify-content:center;width:88rpx;height:88rpx;margin:auto;border-radius:50%;color:#edca86;font-size:32rpx;background:linear-gradient(180deg,rgba(255,255,255,.08),transparent)}.right-image{width:100%;height:100%}.right-name{margin-top:24rpx;color:rgba(255,255,255,.7);font-size:26rpx;line-height:37rpx;overflow-wrap:anywhere}.right-explain{margin-top:8rpx;font-size:20rpx;line-height:28rpx;overflow-wrap:anywhere}.rights-empty{padding:60rpx 24rpx 50rpx;text-align:center;color:#89735b;font-size:24rpx}
.other-section{position:relative;border-radius:48rpx 48rpx 0 0;background:#f5f5f5;min-height:500rpx}.member-statistics{display:flex;justify-content:space-between;flex-wrap:wrap;gap:10rpx;padding:26rpx 32rpx 6rpx;color:#89735b;font-size:20rpx;line-height:30rpx}.permanent-note{margin:26rpx 20rpx;padding:30rpx;border-radius:24rpx;background:#fff2d9;color:#7e4b06;font-size:28rpx;text-align:center}.type-section{padding:20rpx}.type-inner{border-radius:24rpx;background:#fff;overflow:hidden}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:16rpx;padding:32rpx 32rpx 24rpx;font-size:32rpx;font-weight:700;line-height:44rpx}.section-heading button{flex:none;padding:0;margin:0;background:transparent;font-size:24rpx;font-weight:400;line-height:36rpx;color:#666}.plan-heading{padding-bottom:36rpx;border-radius:24rpx 24rpx 0 0;background:linear-gradient(180deg,#ffefce,#fff)}.plan-heading button{color:rgba(217,126,29,.8)}.plan-scroll{width:100%;white-space:nowrap}.plan-card{position:relative;display:inline-block;vertical-align:top;width:220rpx;padding:36rpx 8rpx 32rpx;border:1rpx solid #ddd;border-radius:24rpx;margin:16rpx 24rpx 18rpx 0;background:#fff;white-space:normal;text-align:center}.plan-card:first-child{margin-left:32rpx}.plan-card:last-child{margin-right:32rpx}.plan-card.on{border:2rpx solid #d97e1d;background:linear-gradient(180deg,#fff,#fef5e6)}.badge{position:absolute;top:-18rpx;left:0;padding:0 12rpx;border-radius:22rpx 22rpx 22rpx 0;background:linear-gradient(90deg,#ff7931,#e93323);color:#fff;font-size:24rpx;line-height:44rpx}.plan-name{min-height:40rpx;color:#7e4b06;font-size:28rpx;font-weight:500;line-height:40rpx}.plan-price{margin-top:16rpx;font-size:30rpx;line-height:62rpx;color:#333}.plan-price text{font-size:48rpx;font-weight:600}.original-price{margin-top:4rpx;text-decoration:line-through;color:#999;font-size:24rpx;line-height:34rpx}.saving{width:160rpx;height:52rpx;margin:18rpx auto 0;border-radius:22rpx;background:#fee8bc;font-size:22rpx;line-height:52rpx}.plan-duration{padding:0 26rpx 22rpx;color:#999;font-size:22rpx;line-height:32rpx;text-align:center;overflow-wrap:anywhere}
.coupon-section{margin:0 20rpx;border-radius:24rpx;background:#fff}.coupon-scroll{width:100%;padding-bottom:24rpx;white-space:nowrap}.coupon-item{position:relative;display:inline-block;vertical-align:top;width:151rpx;padding:0 6rpx;border-radius:24rpx;margin:20rpx 14rpx 0 0;background:#e0a558;box-sizing:content-box}.coupon-item:first-child{margin-left:32rpx}.coupon-item:last-child{margin-right:32rpx}.coupon-inner{min-height:185rpx;padding-bottom:76rpx;border:2rpx solid #ffedca;border-radius:12rpx;margin-top:-20rpx;background:#fff;box-sizing:border-box}.coupon-type{width:96rpx;height:38rpx;margin:auto;border-radius:0 0 12rpx 12rpx;background:rgba(224,165,88,.2);font-size:20rpx;line-height:38rpx;text-align:center}.coupon-price{margin-top:16rpx;text-align:center;color:#e0a558;font-size:24rpx;line-height:44rpx}.coupon-number{font-size:40rpx;font-weight:500}.coupon-status{text-align:center;color:#a08769;font-size:18rpx;line-height:28rpx}.coupon-footer{position:absolute;bottom:0;left:0;width:100%;height:76rpx;padding-top:30rpx;box-sizing:border-box;background:url('/static/membership/coupon-footer.png') no-repeat;background-size:100% 100%;text-align:center;color:rgba(250,204,125,.8);font-size:20rpx;line-height:30rpx}.coupon-item.gray{background:#aaa url('/static/membership/coupon-unavailable.png') center/100% 100%}.gray .coupon-inner{border-color:#ddd;background:#eee}.gray .coupon-price,.gray .coupon-status,.gray .coupon-footer{color:#999}.gray .coupon-footer{filter:grayscale(1)}
.recommend-section{padding:32rpx 20rpx}.recommend-heading{display:flex;align-items:center;justify-content:center;gap:18rpx;margin-bottom:26rpx;color:#7e4b06;font-size:30rpx;font-weight:600}.recommend-heading view{width:50rpx;height:1rpx;background:#bca584}.products{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20rpx}.product-card{display:block;min-width:0;padding:0;margin:0;border:0;border-radius:20rpx;background:#fff;overflow:hidden;text-align:left}.product-image{display:block;width:100%;height:330rpx}.product-placeholder{display:flex;align-items:center;justify-content:center;background:#eee8df;color:#9b8b75;font-size:22rpx}.product-name{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;min-height:72rpx;margin:16rpx 20rpx;color:#333;font-size:26rpx;line-height:36rpx;overflow-wrap:anywhere}.product-price{padding:0 20rpx 22rpx;color:#333;font-size:28rpx;font-weight:600;overflow-wrap:anywhere}.vip-price{display:inline-block;margin-left:8rpx;color:#a56a13;font-size:21rpx;font-weight:400}.more-products,.list-end{display:block;margin:24rpx auto 0;padding:20rpx;background:transparent;text-align:center;font-size:24rpx;line-height:36rpx;color:#9b8b75}.state{padding:70rpx 32rpx;text-align:center;font-size:26rpx;line-height:40rpx;color:#999}.compact-state{padding:26rpx 24rpx}.state button{max-width:360rpx;margin:24rpx auto 0;padding:18rpx;background:#fff;border-radius:40rpx;color:#7e4b06;font-size:26rpx}.notice{margin:20rpx;padding:20rpx;border-radius:14rpx;background:#fff3df;color:#8e5c20;font-size:24rpx;line-height:36rpx;overflow-wrap:anywhere}.notice button{display:inline;padding:0;margin:0;background:transparent;text-decoration:underline;font-size:inherit;color:inherit}.recovery-actions{display:flex;gap:16rpx;padding:0 20rpx 20rpx}.recovery-actions button{flex:1;padding:20rpx 12rpx;border-radius:40rpx;background:#fff;color:#7e4b06;font-size:24rpx;text-align:center}
.purchase-footer{position:fixed;bottom:0;left:50%;z-index:20;width:100%;max-width:750px;transform:translateX(-50%);padding:22rpx 20rpx calc(22rpx + env(safe-area-inset-bottom));box-sizing:border-box;background:#fff}.purchase-row{display:flex;height:108rpx}.footer-price{display:flex;align-items:center;flex:1;min-width:0;padding-left:34rpx;border-radius:54rpx 0 0 54rpx;background:#222;color:#facc7d;white-space:nowrap}.currency{font-size:36rpx;font-weight:600}.amount{font-size:48rpx;font-weight:600}.struck-price{margin-left:12rpx;text-decoration:line-through;color:rgba(255,255,255,.4);font-size:22rpx}.buy{position:relative;flex:none;width:250rpx;margin:0;padding:0 10rpx 0 20rpx;border-radius:0 54rpx 54rpx 0;background:linear-gradient(90deg,#ffdd9c,#eea82f);color:#7e4b06;font-size:32rpx!important;line-height:108rpx!important;font-weight:500}.buy::before{content:'';position:absolute;top:0;left:0;border-width:54rpx 20rpx;border-style:solid;border-color:#222 transparent transparent #222}.agreement-row{display:flex;align-items:center;justify-content:center;gap:6rpx;padding-top:20rpx;color:#999;font-size:24rpx;line-height:36rpx}.agreement-check{display:flex;align-items:center;justify-content:center;flex:none;width:30rpx;height:30rpx;padding:0;margin:0 8rpx 0 0;border:2rpx solid #ccc;border-radius:50%;color:#fff;font-size:22rpx!important;line-height:26rpx!important;background:#fff}.agreement-check.checked{border-color:#d88d0e;background:#d88d0e}.agreement-link{padding:0;margin:0;background:transparent;color:#d88d0e;font-size:24rpx!important;line-height:36rpx!important}
.modal-mask{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;padding:28rpx;background:rgba(0,0,0,.5);box-sizing:border-box}.payment-dialog,.success-dialog{width:100%;max-width:570px;max-height:85vh;padding:34rpx;border-radius:28rpx;background:#fffaf2;box-sizing:border-box;overflow:auto}.dialog-title{text-align:center;font-size:34rpx;font-weight:600;line-height:48rpx;color:#5b3c16}.order-number{text-align:center;margin-top:12rpx;font-size:20rpx;line-height:30rpx;color:#999;overflow-wrap:anywhere}.checkout-price{text-align:center;margin:20rpx 0 8rpx;font-size:56rpx;font-weight:600;color:#7e4b06}.balance-caption{text-align:center;margin-bottom:24rpx;color:#999;font-size:24rpx}.payment-method{display:flex;justify-content:space-between;align-items:center;gap:20rpx;width:100%;margin:0;padding:22rpx 8rpx;border:0;border-bottom:1rpx solid #ebdfd1;border-radius:0;background:transparent;font-size:28rpx!important;line-height:40rpx!important;text-align:left;color:#514234}.payment-method text:last-child{max-width:65%;font-size:22rpx}.payment-method.on{color:#bb7c18}.gold-button{display:block;padding:22rpx 20rpx;border-radius:50rpx;background:linear-gradient(90deg,#ffdd9c,#eea82f)!important;color:#7e4b06!important;text-align:center;font-size:28rpx!important;line-height:40rpx!important}.confirm-pay{margin-top:30rpx}.change-plan{display:block;margin:18rpx auto 0;padding:12rpx;background:transparent;color:#9b8b75;font-size:24rpx!important;line-height:36rpx!important}.success-mark{display:flex;align-items:center;justify-content:center;width:100rpx;height:100rpx;margin:12rpx auto 26rpx;border-radius:50%;background:#f6dfae;color:#9c681e;font-size:56rpx}.success-note{margin:20rpx 0 36rpx;text-align:center;color:#9b8b75;font-size:26rpx;line-height:38rpx}
@media(min-width:768px){.vip-home{padding-bottom:150px}.card-section{padding-top:32px}.member-statistics{font-size:14px}.purchase-footer{padding:14px 18px calc(14px + env(safe-area-inset-bottom))}.purchase-row{height:64px}.footer-price{padding-left:28px}.currency{font-size:24px}.amount{font-size:32px}.struck-price{font-size:14px}.buy{width:230px;font-size:22px!important;line-height:64px!important}.buy::before{border-width:32px 14px}.agreement-row{padding-top:12px;font-size:16px;line-height:24px}.agreement-link{font-size:16px!important;line-height:24px!important}.agreement-check{width:20px;height:20px;font-size:14px!important}.payment-dialog,.success-dialog{padding:28px}.dialog-title{font-size:24px;line-height:32px}.gold-button{padding:14px 20px;font-size:18px!important;line-height:28px!important}.payment-method{padding:16px 8px;font-size:18px!important;line-height:28px!important}.payment-method text:last-child{font-size:14px}.checkout-price{font-size:38px}.balance-caption,.notice{font-size:16px}.order-number{font-size:14px}}
</style>
