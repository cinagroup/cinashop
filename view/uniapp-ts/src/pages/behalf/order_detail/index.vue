<template>
  <view class="detail-page">
    <view class="eyebrow">管理员 · 代客下单</view><view class="title">订单详情</view>
    <view v-if="!canRead" class="panel notice">请登录具有代客下单权限的管理员。商城会员登录不能授权此页面。<button @tap="goRecords">前往代客记录／登录</button></view>
    <template v-else>
      <view class="session">当前管理员：{{ session.label }}（{{ session.id }}）</view>
      <view v-if="loading" class="panel empty" role="status">正在读取服务器订单详情…</view>
      <view v-if="error" class="panel notice" role="alert">{{ error }}<button :disabled="loading" @tap="load">重新读取</button></view>
      <template v-if="detail && !loading && !error">
        <view class="panel">
          <view class="row"><text class="label">订单号</text><text class="order-no">{{ detail.orderNo }}</text></view>
          <view class="row"><text class="label">当前状态</text><text class="badge">{{ detail.statusTitle }}</text></view>
          <view class="row"><text class="label">付款状态</text><text>{{ detail.paid ? '服务器已确认付款' : '服务器尚未确认付款' }}</text></view>
          <view class="row"><text class="label">创建时间</text><text>{{ formatTime(detail.createdAt) }}</text></view>
          <view class="row"><text class="label">收款方式</text><text>{{ payTypeLabel(detail.payType) }}</text></view>
          <view class="row"><text class="label">配送方式</text><text>{{ shippingTypeLabel(detail.shippingType) }}</text></view>
          <view v-if="detail.split" class="hint">此付款根单已拆分；下方为原始购买商品快照，不代表各履约子单状态。</view>
        </view>
        <view class="panel">
          <view class="section-title">购买商品 · {{ detail.quantity }} 件</view>
          <view v-if="!detail.items.length" class="hint">暂无可展示的商品快照。</view>
          <view v-for="item in detail.items" :key="item.id" class="product">
            <view class="product-name">{{ item.name || `商品 ${item.productId}` }}</view>
            <view class="hint">{{ item.sku || '默认规格' }} · {{ item.quantity }} 件 · 单价 ¥{{ item.price }}</view>
          </view>
          <view class="total"><text>订单应付</text><text>¥{{ detail.amount }}</text></view>
        </view>
        <view class="hint">这里仅展示服务器归属核验后的订单摘要，不直接执行付款、取消或退款。</view>
        <button v-if="!detail.paid" @tap="goCashier">前往独立收银页</button>
      </template>
      <button @tap="goRecords">返回代客记录</button>
    </template>
    <DiySuspendedNavigation />
  </view>
</template>
<script setup lang="ts">
import { useAssistedDetail } from '@/composables/useAssistedDetail';
const { session, canRead, detail, loading, error, load, goRecords, goCashier } = useAssistedDetail();
function formatTime(seconds: number) { return seconds ? new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false }) : '时间未记录'; }
function payTypeLabel(value: string) { return ({ cash: '现金', weixin: '微信', alipay: '支付宝' } as Record<string, string>)[value] || '其他方式'; }
function shippingTypeLabel(value: number) { return value === 1 ? '快递或无需物流' : value === 2 ? '门店自提' : '其他方式'; }
</script>
<style scoped>
.detail-page{max-width:860px;margin:auto;padding:36rpx 28rpx 140rpx;background:#f5f6f8;min-height:100vh;box-sizing:border-box;color:#202b3c}.eyebrow{font-size:24rpx;color:#506883}.title{font-size:44rpx;font-weight:700;margin:10rpx 0 28rpx}.session{font-size:26rpx;margin-bottom:24rpx;color:#46546a}.panel{background:white;border:1px solid #e5e9ef;border-radius:18rpx;padding:28rpx;margin-bottom:24rpx}.notice{background:#eef4fb;color:#23496b;line-height:1.6;overflow-wrap:anywhere;font-size:27rpx}.notice button{margin:14rpx 0 0}.empty{text-align:center;color:#617287;font-size:28rpx}.row{display:flex;justify-content:space-between;gap:20rpx;align-items:flex-start;margin-bottom:20rpx;font-size:27rpx}.label{color:#607087;flex:none}.order-no{overflow-wrap:anywhere;text-align:right}.badge{color:#295272;background:#eef4fa;padding:7rpx 16rpx;border-radius:8rpx}.section-title{font-size:32rpx;font-weight:600;margin-bottom:16rpx}.product{border-top:1px solid #edf0f4;padding:20rpx 0}.product-name{font-size:29rpx;font-weight:600;overflow-wrap:anywhere}.hint{font-size:25rpx;line-height:1.7;color:#607087}.total{border-top:1px solid #e5e9ef;padding-top:24rpx;display:flex;justify-content:space-between;font-size:34rpx;font-weight:700}
</style>
