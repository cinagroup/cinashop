<template>
  <view class="confirm-page">
    <view v-if="loading" class="section">正在加载结算要求…</view>
    <view v-if="error" class="section error">
      <text>{{ error }}</text><button size="mini" :disabled="submitting" @tap="load">重新加载结算</button>
    </view>
    <view v-if="pending" class="section pending">
      <view class="heading">{{ pending.orderId ? '订单已创建' : '有一笔订单结果待确认' }}</view>
      <text>{{ pending.orderId ? '请查看订单详情，再选择支付方式。' : '提交内容已锁定。刷新或返回本页后仍会复用同一订单标识和内容，不会自动付款。' }}</text>
      <view class="muted">订单标识：{{ pending.key }}</view>
      <view class="muted">已锁定 {{ pending.payload.cartIds.length }} 项商品，{{ pending.payload.shippingType === 2 ? '门店自提' : '快递配送' }}</view>
    </view>
    <template v-if="!pending && !loading && !error">
      <view class="section">
        <view class="heading">配送方式</view>
        <view v-if="items.some(item => item.productInfo?.productType === 4)" class="muted">次卡商品仅支持门店自提，支付后到店按次数核销。</view>
        <view class="choices">
          <button size="mini" :class="{ active: shippingType === 1 }" :disabled="locked || items.some(item => item.productInfo?.productType === 4)" @tap="setShipping(1)">快递配送</button>
          <button size="mini" :class="{ active: shippingType === 2 }" :disabled="locked" @tap="setShipping(2)">门店自提</button>
        </view>
        <template v-if="shippingType === 1">
          <button v-for="address in addresses" :key="address.id" class="address" :class="{ active: addressId === address.id }" :disabled="locked" @tap="addressId = address.id">
            <view>{{ address.real_name }} {{ address.phone }}</view>
            <view class="muted">{{ address.province }}{{ address.city }}{{ address.district }}{{ address.detail }}</view>
          </button>
          <button size="mini" :disabled="locked" @tap="addAddress">新增或管理地址</button>
        </template>
        <template v-else>
          <button v-for="store in stores" :key="store.id" class="address" :class="{ active: storeId === store.id }" :disabled="locked" @tap="storeId = store.id">
            <view>{{ store.name }}</view><view class="muted">{{ store.address }}{{ store.detailed_address }}</view>
          </button>
          <input v-model="contact.realName" :disabled="locked" maxlength="32" placeholder="自提联系人" />
          <input v-model="contact.userPhone" :disabled="locked" maxlength="18" placeholder="自提手机号" />
        </template>
        <view v-if="deliveryError" class="error">{{ deliveryError }}<button size="mini" @tap="load">重试配送信息</button></view>
      </view>
      <view class="section">
        <view class="heading">结算商品</view>
        <view v-for="item in displayItems" :key="item.id" class="cart-line">
          <image class="cart-image" :src="item.productInfo?.image" mode="aspectFill" />
          <view class="cart-info">
            <view>{{ item.productInfo?.storeName }}</view><view class="muted">{{ item.productInfo?.suk }} × {{ item.cartNum }}</view>
            <view class="price">{{ ready ? `¥${item.sumPrice}` : '待报价' }}</view>
          </view>
        </view>
        <view v-if="activity.type === 0" class="integral-option">
          <text>使用积分抵扣（额度由系统计算）</text>
          <switch :checked="useIntegral" :disabled="locked" @change="integralChange" />
        </view>
      </view>
      <view v-if="couponScope" class="section">
        <view class="heading">当前订单优惠券</view>
        <view class="choices">
          <button size="mini" :disabled="locked || coupons.loading" @tap="selectCoupon(0)">不使用优惠券</button>
          <button size="mini" :disabled="locked || coupons.loading" @tap="loadCoupons(false)">刷新优惠券</button>
        </view>
        <view v-if="coupons.loading" class="muted">正在查找适用优惠券…</view>
        <view v-if="coupons.error" class="error">{{ coupons.error }}<button size="mini" :disabled="locked || coupons.loading" @tap="loadCoupons(coupons.nextCursor !== null)">重试加载优惠券</button></view>
        <button v-for="coupon in coupons.list" :key="coupon.id" class="coupon-card" :class="{ active: couponId === coupon.id }" :disabled="locked || coupons.loading" @tap="selectCoupon(coupon.id)">
          <view class="coupon-head"><text class="price">{{ coupon.benefit }}</text><text>{{ coupon.title }}</text><text v-if="couponId === coupon.id">✓</text></view>
          <view class="muted">满 {{ coupon.minimum }} 可用 · {{ coupon.scope }}</view>
          <view class="muted">{{ coupon.validity }}</view>
          <view>适用商品 ¥{{ coupon.eligibleSubtotal }} · 预计抵扣 ¥{{ coupon.estimatedDiscount }}</view>
        </button>
        <view v-if="!coupons.loading && !coupons.error && !coupons.list.length" class="muted">{{ coupons.nextCursor !== null ? '本页暂无适用优惠券，可继续查找。' : '当前订单暂无适用优惠券，可能受首单优惠或适用范围限制。' }}</view>
        <button v-if="coupons.nextCursor !== null" size="mini" :disabled="locked || coupons.loading" @tap="loadCoupons(true)">继续查找可用优惠券</button>
        <view v-if="couponId && ready && quote.result?.prices.couponDiscount === '0.00'" class="muted">所选券本次未产生抵扣，可取消或重选。</view>
      </view>
      <SystemFormFields :key="formRevision" v-model="customForm" :title="formName" :disabled="formLocked" @pending="uploads = $event" />
      <view v-if="formValidation || uploads" class="section error">{{ uploads ? '图片上传中，完成前不能提交。' : formValidation }}</view>
      <view class="section">
        <view class="heading">费用明细</view>
        <view v-if="quote.loading">正在获取最新报价，完成前不能提交…</view>
        <view v-if="quote.error" class="error">{{ quote.error }}<button size="mini" :disabled="locked" @tap="refreshQuote(true)">重新获取报价</button></view>
        <template v-if="ready && quote.result">
          <view class="price-row"><text>商品金额</text><text>¥{{ quote.result.prices.subtotal }}</text></view>
          <view class="price-row"><text>会员优惠</text><text>-¥{{ quote.result.prices.memberDiscount }}</text></view>
          <view class="price-row"><text>首单优惠</text><text>-¥{{ quote.result.prices.firstOrderDiscount }}</text></view>
          <view class="price-row"><text>优惠券</text><text>-¥{{ quote.result.prices.couponDiscount }}</text></view>
          <view class="price-row"><text>积分抵扣（{{ quote.result.prices.usedIntegral }}积分）</text><text>-¥{{ quote.result.prices.integralDiscount }}</text></view>
          <view v-if="activity.type === 4" class="price-row"><text>兑换所需积分</text><text>{{ quote.result.prices.requiredIntegral }} 积分</text></view>
          <view class="price-row"><text>运费</text><text>¥{{ quote.result.prices.postage }}</text></view>
          <view class="price-row"><text>运费优惠</text><text>-¥{{ quote.result.prices.postageDiscount }}</text></view>
          <view class="price-row price"><text>应付金额</text><text>¥{{ quote.result.prices.payable }}</text></view>
        </template>
      </view>
      <view class="section"><textarea v-model="mark" :disabled="locked" :maxlength="200" placeholder="订单备注（选填）" /><view class="muted">提交仅创建订单。请在订单详情确认金额后选择支付方式。</view></view>
    </template>
    <view v-if="submissionError" class="section error">{{ submissionError }}</view>
    <view class="submit-bar">
      <text class="price">{{ pending ? '确认原订单结果' : ready ? `${activity.type === 4 ? quote.result?.prices.requiredIntegral + '积分 + ' : '合计 '}¥${quote.result?.prices.payable}` : '待报价' }}</text>
      <button class="submit-btn" :disabled="!canSubmit" :loading="submitting" @tap="submit">{{ pending?.orderId ? '查看订单' : pending ? '重试确认订单' : '提交订单' }}</button>
    </view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import SystemFormFields from "@/components/SystemFormFields.vue";
import { useCheckout } from "@/composables/useCheckout";
const { loading, error, load, locked, formLocked, items, displayItems, addresses, stores, addressId, storeId, shippingType, setShipping, contact, mark,
  customForm, formName, formRevision, formValidation, uploads, activity, useIntegral, quote, ready, deliveryError, refreshQuote,
  coupons, couponId, couponScope, selectCoupon, loadCoupons, pending, submissionError, submitting, canSubmit, submit } = useCheckout();
function addAddress() { if (!locked.value) uni.navigateTo({ url: "/pages/user/address" }); }
function integralChange(event: Event) { if (!locked.value) useIntegral.value = (event as unknown as { detail: { value: boolean } }).detail.value === true; }
</script>

<style scoped>
.confirm-page { padding: 20rpx 20rpx 180rpx; font-size: 28rpx; overflow-wrap: anywhere; }
.section { background: #fff; border-radius: 12rpx; padding: 24rpx; margin-bottom: 20rpx; }
.heading { font-size: 30rpx; font-weight: 600; margin-bottom: 18rpx; }
.muted { color: #777; font-size: 24rpx; margin-top: 10rpx; line-height: 1.6; }
.error { color: #b72a1d; line-height: 1.7; }
.pending { border: 2rpx solid #f0b384; }
.choices { display: flex; flex-wrap: wrap; gap: 14rpx; margin: 14rpx 0; }
.choices button { margin: 0; }
button { font-size: 26rpx; white-space: normal; }
.active { color: #c8271a; background: #fff5f4; border: 2rpx solid #e93323; }
.address, .coupon-card { width: 100%; text-align: left; padding: 18rpx; line-height: 1.6; margin-bottom: 16rpx; }
.coupon-head { display: flex; flex-wrap: wrap; gap: 16rpx; align-items: baseline; }
input { border: 1rpx solid #ddd; border-radius: 8rpx; padding: 18rpx; margin-top: 18rpx; }
textarea { box-sizing: border-box; width: 100%; min-height: 100rpx; font-size: 28rpx; }
.cart-line { display: flex; gap: 20rpx; padding: 18rpx 0; }
.cart-image { width: 120rpx; height: 120rpx; border-radius: 8rpx; flex-shrink: 0; }
.cart-info { flex: 1; min-width: 0; }
.price { color: #d32c1d; font-weight: 600; }
.price-row, .integral-option { display: flex; justify-content: space-between; align-items: center; gap: 16rpx; padding: 10rpx 0; }
.price-row > text:last-child { flex-shrink: 0; }
.submit-bar { position: fixed; left: 0; right: 0; bottom: 0; background: #fff; box-shadow: 0 -2rpx 10rpx #0001; padding: 20rpx 24rpx calc(20rpx + env(safe-area-inset-bottom)); display: flex; align-items: center; justify-content: space-between; gap: 16rpx; z-index: 5; }
.submit-btn { background: #e93323; color: white; margin: 0; border-radius: 40rpx; font-size: 28rpx; }
.submit-btn[disabled] { background: #eee; color: #999; }
</style>
