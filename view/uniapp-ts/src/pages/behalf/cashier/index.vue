<template>
  <view class="cashier-page">
    <view class="eyebrow">管理员 · 代客下单</view><view class="title">订单收银</view>
    <view v-if="!canRead" class="panel notice" role="alert">请登录具有代客下单权限的管理员。商城会员登录不能授权收银。<button @tap="goRecords">前往代客记录／登录</button></view>
    <template v-else>
      <view class="session">当前管理员：{{ session.label }}（{{ session.id }}）</view>
      <view v-if="loading" class="panel center" role="status">正在核对本人创建的订单…</view>
      <view v-if="error" class="panel notice" role="alert">{{ error }}<button :disabled="loading || busy" @tap="load">重新读取</button></view>
      <template v-if="detail && !loading && !error">
        <view class="panel">
          <view class="row"><text>订单号</text><text class="order-no">{{ detail.orderNo }}</text></view>
          <view class="row"><text>买家</text><text>{{ detail.uid ? `会员 UID ${detail.uid}` : '游客' }}</text></view>
          <view class="row"><text>订单状态</text><text>{{ detail.statusTitle }}</text></view>
          <view class="amount"><text>服务器订单应付</text><text>¥{{ detail.amount }}</text></view>
          <view class="hint">进入此页仅读取订单，不会自动发起付款。收银前会重新核对归属、状态和金额。</view>
        </view>
        <view v-if="notice" class="panel notice" role="status">{{ notice }}</view>
        <view v-if="actionError" class="panel notice" role="alert">{{ actionError }}</view>
        <view v-if="detail.paid" class="panel paid">服务器已确认付款。此页不提供取消或退款操作。</view>
        <template v-else>
          <view v-if="isZeroDue" class="panel">
            <view class="section-title">零元代客订单</view>
            <view class="hint">此订单应付 ¥0.00，无需现金或扫码。只有管理员点击并再次确认后，服务器才会完成订单；不会自动发起。</view>
            <button class="primary" :loading="busy" :disabled="busy || uncertain" @tap="startPayment">确认零元代客订单完成</button>
            <view v-if="uncertain" class="hint">完成结果尚需核对。核对成功前不能再次提交。</view>
          </view>
          <view v-else-if="canPay" class="panel">
            <view class="section-title">选择收款方式</view>
            <view class="methods">
              <button v-for="option in methods" :key="option.value" :class="{ chosen: method === option.value }"
                :aria-pressed="method === option.value" :disabled="busy || !!qr || uncertain" @tap="chooseMethod(option.value)">{{ option.label }}</button>
            </view>
            <view v-if="method === 'cash'" class="hint">现金仅由管理员在确已收款后确认；点击发起后还会弹出订单号与金额二次确认。</view>
            <view v-else class="hint">扫码链接只在本机绘制为二维码，不会发送给第三方图片服务。</view>
            <button class="primary" :loading="busy" :disabled="busy || !!qr || uncertain" @tap="startPayment">
              {{ method === 'cash' ? '确认现金收款' : `手动发起${method === 'weixin' ? '微信' : '支付宝'}扫码支付` }}
            </button>
            <view v-if="uncertain" class="hint">上次发起或二维码到期后的付款结果尚需核对。核对成功前禁止再次发起。</view>
          </view>
          <view v-if="qr" class="panel qr-panel">
            <view class="section-title">{{ qr.method === 'weixin' ? '微信' : '支付宝' }}扫码支付</view>
            <view class="hint">剩余 {{ secondsLeft }} 秒 · 二维码仅供当前订单使用</view>
            <AssistedPaymentQr :code="qr.code" />
            <view class="hint">请买家使用相应支付应用扫码。二维码过期后会清屏，但不会自动发起新支付。</view>
          </view>
          <button class="status-button" :disabled="busy" :loading="busy" @tap="checkPaid">核对服务器付款状态</button>
        </template>
      </template>
      <button class="back-button" @tap="goRecords">返回代客记录</button>
    </template>
    <DiySuspendedNavigation />
  </view>
</template>

<script setup lang="ts">
import AssistedPaymentQr from '@/components/AssistedPaymentQr.vue';
import { useAssistedCashier } from '@/composables/useAssistedCashier';
import type { AssistedPaymentMethod } from '@/api/assistedCashier';

const { session, canRead, detail, loading, busy, error, actionError, notice, method, qr,
  uncertain, canPay, isZeroDue, secondsLeft, load, checkPaid, chooseMethod, startPayment, goRecords } = useAssistedCashier();
const methods: Array<{ value: AssistedPaymentMethod; label: string }> = [
  { value: 'weixin', label: '微信扫码' }, { value: 'alipay', label: '支付宝扫码' }, { value: 'cash', label: '现金' },
];
</script>

<style scoped>
.cashier-page{max-width:860px;min-height:100vh;box-sizing:border-box;margin:auto;padding:36rpx 28rpx 140rpx;background:#f5f6f8;color:#202b3c}.eyebrow{font-size:24rpx;color:#506883}.title{font-size:44rpx;font-weight:700;margin:10rpx 0 28rpx}.session{font-size:26rpx;margin-bottom:24rpx;color:#46546a}.panel{background:#fff;border:1px solid #e5e9ef;border-radius:18rpx;padding:28rpx;margin-bottom:24rpx}.notice{background:#eef4fb;color:#23496b;font-size:27rpx;line-height:1.65;overflow-wrap:anywhere}.notice button{margin:14rpx 0 0}.center{text-align:center;color:#617287}.row,.amount{display:flex;justify-content:space-between;gap:20rpx;align-items:flex-start;margin-bottom:20rpx;font-size:27rpx}.row>text:first-child,.amount>text:first-child{color:#607087;flex:none}.order-no{text-align:right;overflow-wrap:anywhere}.amount{border-top:1px solid #e5e9ef;padding-top:24rpx;font-size:36rpx;font-weight:700}.hint{font-size:25rpx;line-height:1.7;color:#607087;margin-top:16rpx}.section-title{font-size:32rpx;font-weight:600;margin-bottom:18rpx}.methods{display:flex;gap:12rpx;flex-wrap:wrap}.methods button{margin:0;font-size:26rpx;min-width:170rpx}.methods .chosen{background:#244e78;color:#fff}.primary{background:#244e78;color:#fff;margin-top:28rpx;font-size:29rpx}.qr-panel{text-align:center}.qr-panel .hint{margin:18rpx auto;max-width:580rpx}.status-button,.back-button{margin:20rpx 0;font-size:28rpx}.paid{color:#195d38;background:#e8f6ec;font-size:29rpx}button[disabled]{opacity:.65}
</style>
