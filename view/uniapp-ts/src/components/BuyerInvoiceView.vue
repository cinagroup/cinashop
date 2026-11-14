<template>
  <view class="invoice-page container">
    <view class="invoice-heading"><view><text class="page-title">{{ orderPage ? '订单发票' : '我的发票' }}</text><view class="muted">{{ orderPage ? flow.state.order?.orderNo || '核对当前订单的开票资料' : '查看开票进度，管理常用抬头' }}</view></view>
      <view class="invoice-actions"><button :disabled="flow.state.loading || flow.state.busy" @tap="flow.load">刷新资料</button><button v-if="orderPage" @tap="flow.manage">我的发票</button></view></view>
    <view v-if="!orderPage" class="invoice-tabs" role="group" aria-label="发票内容"><button :class="{ primary: flow.state.kind === 'records' }" :disabled="flow.state.loading || flow.state.busy" @tap="flow.selectKind('records')">开票记录</button><button :class="{ primary: flow.state.kind === 'titles' }" :disabled="flow.state.loading || flow.state.busy" @tap="flow.selectKind('titles')">抬头管理</button></view>
    <view v-if="flow.state.loading" role="status">正在读取发票资料…</view><view v-if="flow.state.error" class="notice error" role="alert">{{ flow.state.error }}</view>
    <button v-if="!flow.auth.isLoggedIn" class="primary" @tap="flow.login">登录后查看发票</button>
    <view v-if="flow.state.message" role="status" class="invoice-message">{{ flow.state.message }}</view>
    <BuyerInvoiceSnapshot v-if="orderPage && flow.state.order?.invoice" :invoice="flow.state.order.invoice" />
    <view v-else-if="orderPage && flow.state.order && !flow.state.order.canApply" class="notice">{{ flow.state.order.reason || '当前订单不能申请发票，请联系商家核对' }}</view>
    <template v-if="flow.state.page">
      <view v-if="!flow.state.page.capabilities.enabled" class="muted">商家暂未开启新的开票申请，已有记录和抬头仍可查看管理。</view>
      <template v-if="flow.state.kind === 'records'">
        <view class="muted">显示已支付且未退款的开票记录。需要补开时，请从对应订单详情进入。</view>
        <view v-for="record in flow.records" :key="record.id" class="invoice-card"><view class="invoice-row"><text class="card-title">{{ record.name }}</text><text class="invoice-tag">{{ invoiceStateText(record) }}</text></view>
          <view>{{ record.product?.name || '订单开票申请' }}</view><view class="muted">{{ invoiceTypeText(record) }} · {{ record.orderNo }}</view><view>{{ record.amount === null ? '历史金额未记录' : '¥' + record.amount }} · {{ record.addTime || '申请时间未记录' }}</view><button @tap="flow.openRecord(record)">查看开票详情</button></view>
        <view v-if="!flow.records.length" class="empty">暂无开票记录</view>
      </template>
      <template v-else>
        <view v-if="orderPage && flow.state.order" class="invoice-card"><text class="card-title">选择开票抬头</text><view>申请金额：<text class="amount">¥{{ flow.state.order.amount }}</text></view><view class="muted">提交申请后由商家处理，请以开票记录状态为准。{{ flow.state.order.paid ? '' : '订单尚未支付，申请将等待支付完成。' }}</view></view>
        <button class="primary" :disabled="blocked" @tap="flow.edit()">新增抬头</button>
        <BuyerInvoiceForm v-if="flow.state.draft" :draft="flow.state.draft" :disabled="flow.state.busy" :special="flow.state.page.capabilities.special" @save="flow.save" @cancel="flow.closeForm" />
        <view v-for="title in flow.titles" :key="title.id" class="invoice-card"><view class="invoice-row"><text class="card-title">{{ title.name }}</text><text v-if="title.isDefault" class="invoice-tag">同类默认</text></view>
          <view class="muted">{{ invoiceTypeText(title) }}</view><view v-if="title.dutyNumber">税号：{{ title.dutyNumber }}</view><view>手机号：{{ title.drawerPhone || '未记录' }}</view><view>邮箱：{{ title.email || '未记录' }}</view>
          <view v-if="orderPage && title.type === 2 && !flow.state.page.capabilities.special" class="muted">商家暂未开启专用发票，请选择普通发票抬头。</view>
          <view class="invoice-actions"><button :disabled="blocked || !!flow.state.draft" @tap="flow.edit(title)">编辑抬头</button>
            <button v-if="orderPage" class="primary" :disabled="blocked || !!flow.state.draft || (title.type === 2 && !flow.state.page.capabilities.special)" @tap="flow.apply(title)">使用此抬头申请</button>
            <template v-else><button v-if="!title.isDefault" :disabled="blocked || !!flow.state.draft" @tap="flow.setDefault(title)">设为同类默认</button><button class="danger" :disabled="blocked || !!flow.state.draft" @tap="flow.remove(title)">删除抬头</button></template></view></view>
        <view v-if="!flow.titles.length && !flow.state.draft" class="empty">{{ orderPage ? '请先添加开票抬头' : '暂无抬头资料' }}</view>
      </template>
      <view class="invoice-pagination"><button v-if="flow.hasPrevious" :disabled="blocked" @tap="flow.back">上一页</button><button v-if="flow.state.page.nextCursor" :disabled="blocked" @tap="flow.next">下一页</button></view>
    </template>
  </view>
</template>
<script setup lang="ts">
import { computed, type UnwrapNestedRefs } from 'vue';
import type { useBuyerInvoices } from '@/composables/useBuyerInvoices';
import BuyerInvoiceForm from './BuyerInvoiceForm.vue';
import BuyerInvoiceSnapshot from './BuyerInvoiceSnapshot.vue';
import { invoiceStateText, invoiceTypeText } from '../../../common/buyerInvoiceFlow';
const props = defineProps<{ flow: UnwrapNestedRefs<ReturnType<typeof useBuyerInvoices>>; orderPage?: boolean }>();
const blocked = computed(() => props.flow.state.loading || props.flow.state.busy || props.flow.state.uncertain);
</script>
<style scoped>
.invoice-page{padding:28rpx 24rpx 60rpx;overflow-wrap:anywhere;font-size:28rpx;background:#f6f7f9;min-height:100vh;box-sizing:border-box}.invoice-page button{font-size:26rpx;margin:0;max-width:100%;white-space:normal;line-height:1.6;padding:18rpx 24rpx}.invoice-page button.primary{background:var(--view-theme,#e93323)}.invoice-heading,.invoice-row{display:flex;justify-content:space-between;align-items:center;gap:18rpx;flex-wrap:wrap}.invoice-heading{margin:12rpx 0 28rpx}.page-title{display:block;font-size:40rpx;font-weight:600;margin-bottom:12rpx}.card-title{font-size:32rpx;font-weight:600}.invoice-tabs,.invoice-pagination,.invoice-actions{display:flex;gap:16rpx;flex-wrap:wrap;margin:24rpx 0}.invoice-card{background:#fff;border:1px solid #e2e7ee;border-radius:16rpx;padding:30rpx;margin:24rpx 0}.invoice-card>view{margin:16rpx 0;line-height:1.7}.muted{color:#65717d;font-size:24rpx;line-height:1.8}.invoice-tag{font-size:24rpx;padding:4rpx 12rpx;border-radius:6rpx;background:#eef3f8;color:#425b72}.invoice-message,.notice{padding:24rpx;background:#edf5ff;color:#21548b;border-radius:12rpx;line-height:1.8;margin:24rpx 0}.error{background:#fff0ef;color:#a32b22}.empty{padding:70rpx 20rpx;text-align:center;color:#65717d}.danger{color:#b53a31}.amount{font-weight:600}
</style>
