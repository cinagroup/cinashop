<template><view class="merchant-action-grid"><view v-for="action in visibleActions" :key="action.key" class="merchant-action-wrap"><button :disabled="busy || !capabilities?.[action.key] || !item.actions[action.key].available" :data-action="action.key" @tap="emit('action',action.key)">{{ action.label }}</button><text v-if="!capabilities?.[action.key] || !item.actions[action.key].available" class="merchant-action-reason">{{ reason(item.actions[action.key].reason) || '当前门店操作暂未开放' }}</text></view></view></template>
<script setup lang="ts">
import { computed } from 'vue';import type { MerchantOrderListItem,MerchantOrderAction,MerchantCapabilities } from '@/types/merchantOrders';
const props=defineProps<{item:MerchantOrderListItem;capabilities?:MerchantCapabilities;busy?:boolean;detail?:boolean}>(),emit=defineEmits<{action:[action:MerchantOrderAction]}>();
const visibleActions=computed(()=>[{key:'remark' as const,label:'订单备注'},{key:'change_price' as const,label:'修改价格'},{key:'confirm_offline' as const,label:'确认线下收款'},{key:'manual_delivery' as const,label:'发货'},{key:'tracking' as const,label:'查看物流'},...(props.detail?[{key:'refund_create' as const,label:'发起退款'},{key:'refund_decide' as const,label:'处理退款'}]:[]),{key:'writeoff' as const,label:'订单核销'}]);
function reason(value:string){return /^[a-z0-9_.:-]+$/u.test(value)?'当前账号或订单状态不允许此操作':value;}
</script>
