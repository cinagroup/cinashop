<template>
  <CustomerWorkShell title="手机经营工作台" :manager="manager" :operations="operations" active="index">
    <template #recovery><CustomerWorkProductRecoveryPanel :operations="productOperations" /><CustomerWorkUserRecoveryPanel :operations="userOperations" /><CustomerWorkWriteoffRecoveryPanel :operations="writeoff" /></template>
    <template v-if="overview">
      <view class="cw-card"><text class="cw-subtitle">今日经营</text><text class="cw-scope">销售额与订单数：全站履约订单 · 支付人数按用户去重 · 浏览量：全站商品浏览</text>
        <view class="cw-row"><text>销售额</text><text class="cw-money">¥{{ overview.today.after_price }}</text></view>
        <view class="cw-row"><text>订单数</text><text>{{ overview.today.after_number }}</text></view>
        <view class="cw-row"><text>支付人数</text><text>{{ overview.today.after_pay_number }}</text></view>
        <view class="cw-row"><text>浏览量</text><text>{{ overview.today.today_visits }}</text></view>
        <button class="cw-full" @tap="manager.go('statistics')">查看经营统计</button>
      </view>
      <view v-if="manager.context.value?.data.capabilities.writeoff_read===true" class="cw-card"><text class="cw-subtitle">普通客户核销</text><text class="cw-scope">扫码、手输或会员条码查单，核对实际商品与次数，再明确提交分次或全部核销。</text><button class="cw-full" @tap="manager.go('scanning')">进入客户核销</button></view>
      <text class="cw-subtitle">待处理概况</text>
      <view class="cw-grid">
        <view class="cw-metric"><text class="cw-money">{{ overview.badges.unshipped_count }}</text><text>待发货</text><text class="cw-muted">平台履约订单</text></view>
        <view class="cw-metric"><text class="cw-money">{{ overview.badges.refunding_count }}</text><text>待售后</text><text class="cw-muted">全站退款申请</text></view>
        <view class="cw-metric"><text class="cw-money">{{ overview.badges.refunded_count }}</text><text>已退款</text><text class="cw-muted">全站退款申请</text></view>
        <view class="cw-metric"><text class="cw-money">{{ overview.badges.outofstock }}</text><text>待补货</text><text class="cw-muted">全站商品</text><button v-if="manager.context.value?.data.capabilities.product_management" @tap="manager.go('products',{type:4})">查看售罄商品</button></view>
        <view class="cw-metric"><text class="cw-money">{{ overview.badges.policeforce }}</text><text>库存预警</text><text class="cw-muted">全站商品</text><button v-if="manager.context.value?.data.capabilities.product_management" @tap="manager.go('products',{type:5})">查看预警商品</button></view>
      </view>
      <view class="cw-card"><text class="cw-subtitle">经营管理</text><view class="cw-controls"><button @tap="manager.go('orders')">全站订单查询</button><button @tap="manager.go('orders',{status:'1'})">核对待发货订单</button><button @tap="manager.go('refunds')">全站售后查询</button><button v-if="manager.context.value?.data.capabilities.product_management" @tap="manager.go('products')">商品管理</button><button v-if="manager.context.value?.data.capabilities.user_management" @tap="manager.go('users')">用户管理</button></view><text class="cw-muted">订单详情可核对管理备注与发货。资金管理、代客及退款审批功能暂未开放。</text></view>
    </template>
  </CustomerWorkShell>
</template>
<script setup lang="ts">
import { ref } from 'vue'; import CustomerWorkShell from '@/components/customerWork/CustomerWorkShell.vue';
import { useCustomerWork } from '@/composables/useCustomerWork'; import { isCustomerWorkOverview } from '@/utils/customerWork';
import { useCustomerWorkOperations } from '@/composables/useCustomerWorkOperations';
import { useCustomerWorkProductOperations } from '@/composables/useCustomerWorkProductOperations';
import CustomerWorkProductRecoveryPanel from '@/components/customerWork/CustomerWorkProductRecoveryPanel.vue';
import CustomerWorkUserRecoveryPanel from '@/components/customerWork/CustomerWorkUserRecoveryPanel.vue';
import { useCustomerWorkUserOperations } from '@/composables/useCustomerWorkUserOperations';
import {useCustomerWorkWriteoffOperations} from '@/composables/useCustomerWorkWriteoffOperations';
import CustomerWorkWriteoffRecoveryPanel from '@/components/customerWork/CustomerWorkWriteoffRecoveryPanel.vue';
import type { CustomerWorkOverview } from '@/types/customerWork';
const overview=ref<CustomerWorkOverview|null>(null);
const manager=useCustomerWork({page:'index',clear(){overview.value=null;writeoff.clearDomain();},async load(controller){const valid=controller.fence();const response=await controller.read('overview',isCustomerWorkOverview);if(valid())overview.value=response.data;}});
const operations=useCustomerWorkOperations(manager);
const productOperations=useCustomerWorkProductOperations(manager);
const userOperations=useCustomerWorkUserOperations(manager);
const writeoff=useCustomerWorkWriteoffOperations(manager);
</script>
