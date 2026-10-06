<template>
 <view v-if="props.visible" class="cw-dialog" role="dialog" :aria-label="props.kind==='categories'?'修改商品分类':'替换商品标签'" @tap.self="emit('close')"><view class="cw-dialog-panel">
  <text class="cw-subtitle">{{ props.kind==='categories'?'修改商品分类':'替换商品标签' }}</text><text class="cw-scope">{{ props.kind==='categories'?'选择实际目录中的分类，可选择不同层级。':'所选标签替换当前商品标签；清空后可提交空标签。' }}</text>
  <view v-if="props.loading" class="cw-empty">正在读取当前可选目录…</view><text v-else-if="props.error" class="cw-error" role="alert">{{ props.error }}</text>
  <template v-else><label class="cw-form-field"><text>搜索分类或标签</text><input v-model="keyword" type="text" :disabled="props.busy" placeholder="输入名称筛选当前完整目录" /></label><checkbox-group @change="change">
   <template v-if="props.kind==='categories'"><label v-for="row in categoryRows" :key="row.id" class="cw-taxonomy-row" :style="{paddingLeft:Math.min(row.depth,4)*12+'px'}"><checkbox :value="String(row.id)" :checked="chosen.includes(row.id)" :disabled="props.busy" /><text>{{ row.name }}</text></label><text v-if="!categoryRows.length" class="cw-muted">没有匹配的可选分类</text></template>
   <template v-else><view v-for="group in labelGroups" :key="group.id" class="cw-taxonomy-group"><text class="cw-subtitle">{{ group.label_name }}</text><label v-for="label in group.children" :key="label.id" class="cw-taxonomy-row"><checkbox :value="String(label.id)" :checked="chosen.includes(label.id)" :disabled="props.busy" /><text>{{ label.label_name }}</text></label></view><text v-if="!labelGroups.some(group=>group.children.length)" class="cw-muted">没有匹配的可选标签，可清空已有标签。</text></template>
  </checkbox-group></template>
  <view v-for="id in unavailable" :key="id" class="cw-row"><text class="cw-muted">原选项 #{{ id }} 当前不可选</text><button :disabled="props.busy" @tap="chosen=chosen.filter(value=>value!==id)">移除</button></view>
  <text v-if="localError" class="cw-error" role="alert">{{ localError }}</text><view class="cw-dialog-buttons"><button :disabled="props.busy||props.loading" @tap="chosen=[...props.selected]">恢复原选择</button><button :disabled="props.busy||props.loading" @tap="chosen=[]">{{ props.kind==='categories'?'重置选择':'清空标签' }}</button><button :disabled="props.busy" @tap="emit('close')">取消</button><button :disabled="props.busy||props.loading||!!props.error" @tap="submit">确定</button></view>
 </view></view>
</template>
<script setup lang="ts">
import { computed,ref,watch } from 'vue';
import { customerWorkProductCategoryRows } from '@/utils/customerWorkProductsContract';
import type { CustomerWorkProductCategory,CustomerWorkProductLabelGroup } from '@/types/customerWorkProducts';
const props=defineProps<{visible:boolean;kind:'categories'|'labels';categories?:CustomerWorkProductCategory[];labels?:CustomerWorkProductLabelGroup[];selected:number[];loading:boolean;busy:boolean;error:string}>();
const emit=defineEmits<{close:[];submit:[ids:number[]]}>(),chosen=ref<number[]>([]),localError=ref(''),keyword=ref('');
const allCategoryRows=computed(()=>customerWorkProductCategoryRows(props.categories??[])),categoryRows=computed(()=>allCategoryRows.value.filter(row=>row.name.includes(keyword.value.trim()))),labelGroups=computed(()=>(props.labels??[]).map(group=>({...group,children:group.children.filter(label=>group.label_name.includes(keyword.value.trim())||label.label_name.includes(keyword.value.trim()))})).filter(group=>group.children.length)),allowed=computed(()=>props.kind==='categories'?allCategoryRows.value.map(row=>row.id):(props.labels??[]).flatMap(group=>group.children.map(row=>row.id))),unavailable=computed(()=>chosen.value.filter(id=>!allowed.value.includes(id)));
watch(()=>[props.visible,props.kind,props.selected],()=>{chosen.value=[...props.selected];localError.value='';keyword.value='';},{immediate:true});
function change(event:{detail:{value:string[]}}){const visible=new Set(props.kind==='categories'?categoryRows.value.map(row=>row.id):labelGroups.value.flatMap(group=>group.children.map(label=>label.id)));chosen.value=[...new Set([...chosen.value.filter(id=>!visible.has(id)),...event.detail.value.map(Number)])];localError.value='';}
function submit(){if(props.busy||props.loading||props.error)return;if(props.kind==='categories'&&!chosen.value.length){localError.value='请选择至少一个分类';return;}if(chosen.value.length>50||new Set(chosen.value).size!==chosen.value.length||unavailable.value.length){localError.value='请选择不超过50个当前有效选项';return;}const ids=[...chosen.value].sort((a,b)=>a-b);if(props.kind==='categories'&&ids.join(',').length>64){localError.value='所选分类过多，请减少分类数量';return;}emit('submit',ids);}
</script>
<style scoped>.cw-taxonomy-row{display:flex;align-items:center;gap:14rpx;padding:18rpx 0;word-break:break-word}.cw-taxonomy-group{padding:16rpx 0;border-bottom:1rpx solid #e3ebe5}</style>
