<template>
 <view v-if="props.visible" class="cw-dialog" role="dialog" :aria-label="props.bulk?'批量修改规格':'修改价格与库存'" @tap.self="emit('close')">
  <view class="cw-dialog-panel"><text class="cw-subtitle">{{ props.bulk?'批量修改规格':'修改价格与库存' }}</text><text class="cw-scope">{{ props.bulk?'空白字段保持各规格原值；填写 0 会设为零。':'按当前真实规格修改价格与库存。' }}</text>
   <label v-for="field in fields" :key="field.key" class="cw-form-field"><text>{{ field.name }}</text><input v-model="draft[field.key]" :type="field.key==='stock'?'number':'digit'" :disabled="props.busy || field.key==='stock'&&!props.stockEditable" :placeholder="props.bulk?'留空保持原值':`填写${field.name}`" :aria-label="field.name" /></label>
   <text v-if="!props.stockEditable" class="cw-muted">所选规格库存由专用功能维护，价格仍可按实际权限编辑。</text><text v-if="error||props.message" class="cw-error" role="alert">{{ error || props.message }}</text>
   <view class="cw-dialog-buttons"><button :disabled="props.busy" @tap="emit('close')">取消</button><button :disabled="props.busy" @tap="apply">{{ props.bulk?'应用到选中规格':'保存' }}</button></view>
  </view>
 </view>
</template>
<script setup lang="ts">
import { reactive,ref,watch } from 'vue';
import { customerWorkProductDecimal,customerWorkProductStock } from '@/utils/customerWorkProductsContract';
import type { CustomerWorkProductSku } from '@/types/customerWorkProducts';
const props=defineProps<{visible:boolean;bulk?:boolean;sku?:CustomerWorkProductSku|null;stockEditable:boolean;busy:boolean;message?:string}>();
const emit=defineEmits<{close:[];apply:[values:{price:string;cost:string;ot_price:string;stock:string}]}>();
const fields:{key:'price'|'cost'|'ot_price'|'stock';name:string}[]=[{key:'price',name:'售价'},{key:'cost',name:'成本价'},{key:'ot_price',name:'划线价'},{key:'stock',name:'库存'}];
const draft=reactive({price:'',cost:'',ot_price:'',stock:''}),error=ref('');
watch(()=>[props.visible,props.sku,props.bulk],()=>{error.value='';Object.assign(draft,props.bulk?{price:'',cost:'',ot_price:'',stock:''}:{price:props.sku?.price??'',cost:props.sku?.cost??'',ot_price:props.sku?.ot_price??'',stock:props.sku?String(props.sku.stock):''});},{immediate:true});
function apply(){if(props.busy)return;try{const result={...draft};for(const key of['price','cost','ot_price']as const)if(!props.bulk||result[key]!=='')result[key]=customerWorkProductDecimal(result[key]);if(!props.bulk||result.stock!=='')result.stock=String(customerWorkProductStock(result.stock));if(!props.stockEditable)result.stock=props.bulk?'':String(props.sku?.stock??0);if(props.bulk&&Object.values(result).every(value=>value===''))throw Error('请至少填写一个需要修改的字段');error.value='';emit('apply',result);}catch(failure){error.value=failure instanceof Error?failure.message:'编辑内容无效';}}
</script>
