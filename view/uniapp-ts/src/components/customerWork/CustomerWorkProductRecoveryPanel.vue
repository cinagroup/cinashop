<template>
 <view v-if="props.operations.current()&&props.operations.pending.value.length" class="cw-recovery" data-product-recovery="pending"><text class="cw-subtitle">商品原操作结果</text><text>按原编号查询；未确认前保留全部原内容。</text>
  <view v-for="intent in props.operations.pending.value" :key="intent.request_key" class="cw-recovery-row"><text>{{ names[intent.kind] }} · 商品 {{ intent.body.targets.map(row=>row.product_id).join('、') }}</text><text class="cw-muted cw-request-key">{{ intent.request_key }}</text><text>{{ status(intent) }}</text><text v-if="props.operations.states.value[intent.request_key]?.error" class="cw-error">{{ props.operations.states.value[intent.request_key]?.error }}</text>
   <view class="cw-controls"><button :disabled="props.operations.busy.value" @tap="props.operations.check(intent)">查询原结果</button><button v-if="!props.operations.states.value[intent.request_key]?.receipt" :disabled="!props.operations.canRestore(intent)" @tap="props.operations.restore(intent)">重发原意图</button><button v-if="!props.operations.states.value[intent.request_key]?.receipt" :disabled="props.operations.busy.value" @tap="props.operations.abandon(intent)">放弃尚未执行的意图</button><button v-else :disabled="props.operations.busy.value" @tap="props.operations.acknowledge(intent)">已核对，关闭记录</button></view>
  </view>
 </view>
</template>
<script setup lang="ts">
import type { CustomerWorkProductOperations } from '@/composables/useCustomerWorkProductOperations';
import type { CustomerWorkProductIntent,CustomerWorkProductKind } from '@/types/customerWorkProducts';
const props=defineProps<{operations:CustomerWorkProductOperations}>();
const names:Record<CustomerWorkProductKind,string>={set_show:'商品上下架',replace_categories:'替换分类',replace_labels:'替换标签',update_skus:'修改价格与库存'};
function status(intent:CustomerWorkProductIntent){const receipt=props.operations.states.value[intent.request_key]?.receipt;if(!receipt)return'结果尚未确认';if(receipt.outcome==='products-updated')return'商品修改已确认';if(receipt.outcome==='skus-updated')return'规格修改已确认';if(receipt.outcome==='abandoned')return'尚未执行的原意图已放弃';return'原意图被拒绝，请重新读取当前商品与权限';}
</script>
