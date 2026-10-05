<template>
  <view v-if="props.operations.current() && props.operations.pending.value.length" class="cw-recovery" data-customer-work="pending-intents">
    <text class="cw-subtitle">原操作结果待核对</text><text>请先查询原请求。超时、关闭页面或刷新订单均不能证明原操作失败。</text>
    <view v-for="intent in props.operations.pending.value" :key="intent.request_key" class="cw-recovery-row">
      <text>{{ customerWorkOperationLabel(intent.kind) }} · {{ intent.order_no }}</text><text class="cw-muted cw-request-key">原请求 {{ intent.request_key }}</text>
      <text v-if="props.operations.states.value[intent.request_key]?.receipt" class="cw-muted">{{ outcomeLabel(props.operations.states.value[intent.request_key]?.receipt?.outcome) }}</text>
      <text v-if="props.operations.states.value[intent.request_key]?.waybill">面单任务：{{ props.operations.states.value[intent.request_key]?.waybill?.status }}</text>
      <text v-if="props.operations.states.value[intent.request_key]?.city">同城任务：{{ props.operations.states.value[intent.request_key]?.city?.status }}</text>
      <view class="cw-controls">
        <button :disabled="props.operations.busy.value" @tap="props.operations.check(intent)">查询原操作</button>
        <button v-if="props.operations.canRecoverCity(intent)" :disabled="props.operations.busy.value" @tap="props.operations.recoverCity(intent)">核对原同城渠道结果</button>
        <template v-if="terminal(intent)"><button :disabled="props.operations.busy.value" @tap="props.operations.acknowledge(intent)">确认关闭原记录</button></template>
        <template v-else-if="!props.operations.states.value[intent.request_key]?.receipt">
          <button :disabled="props.operations.busy.value || !props.operations.canRestore(intent)" @tap="props.operations.restore(intent)">恢复同一操作</button>
          <button :disabled="props.operations.busy.value" @tap="props.operations.restore(intent,true)">核对并放弃</button>
        </template>
      </view>
    </view>
  </view>
  <view v-if="props.operations.current() && props.operations.error.value" class="cw-recovery" data-customer-work="operation-result">{{ props.operations.error.value }}</view>
</template>
<script setup lang="ts">
import type { CustomerWorkOperations } from '@/composables/useCustomerWorkOperations';
import type { CustomerWorkPendingIntent } from '@/types/customerWorkFulfillment';
import { customerWorkOperationLabel } from '@/utils/customerWorkFulfillment';
const props=defineProps<{operations:CustomerWorkOperations}>();
function terminal(intent:CustomerWorkPendingIntent){const state=props.operations.states.value[intent.request_key];return state?.terminal||['abandoned','rollback-rejected'].includes(state?.receipt?.outcome??'');}
function outcomeLabel(value:unknown){return value==='provider-admitted'?'已受理，继续核对任务结果':value==='rollback-rejected'?'已确认未执行':value==='abandoned'?'已确认放弃':'原操作已确认';}
</script>
