<template>
  <view class="cw-dialog" @tap.self="close"><view class="cw-dialog-panel">
    <text class="cw-subtitle">订单管理备注</text><text class="cw-scope">{{ props.operations.remark.value?.data.remark_target.order_id }}</text>
    <view class="cw-form-field"><text>管理备注</text><textarea v-model="remark" :maxlength="512" :disabled="props.operations.busy.value" placeholder="填写本订单的处理备注" :adjust-position="true" /></view>
    <text v-if="error" class="cw-error">{{ error }}</text><view class="cw-dialog-buttons"><button :disabled="props.operations.busy.value" @tap="close">取消</button><button :disabled="props.operations.busy.value || !props.operations.remark.value?.data.remark_target.available" @tap="save">{{ props.operations.busy.value?'核对中…':'核对并保存' }}</button></view>
  </view></view>
</template>
<script setup lang="ts">
import { ref } from 'vue';import type { CustomerWorkOperations } from '@/composables/useCustomerWorkOperations';
const props=defineProps<{operations:CustomerWorkOperations}>(),emit=defineEmits<{close:[];saved:[]}>(),remark=ref(props.operations.remark.value?.data.remark_target.remark??''),error=ref('');
function close(){if(!props.operations.busy.value)emit('close');}
async function save(){if(props.operations.busy.value||!props.operations.current())return;error.value='';try{const value=remark.value.trim();if(!value||value.length>512)throw Error('请填写不超过 512 字的管理备注');const receipt=await props.operations.submit('remark',{remark:value},'核对管理备注');if(!props.operations.current()||!receipt)return;if(receipt.outcome==='remark-saved'){emit('saved');return;}error.value='原备注操作未执行，请核对原记录。';}catch(failure){if(props.operations.current())error.value=failure instanceof Error?failure.message:'备注结果待核对';}}
</script>
