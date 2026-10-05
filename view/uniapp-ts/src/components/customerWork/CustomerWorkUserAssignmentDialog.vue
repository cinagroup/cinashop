<template>
 <view v-show="props.visible" class="cw-dialog" role="dialog" :aria-label="title" @tap.self="emit('close')"><view class="cw-dialog-panel">
  <text class="cw-subtitle">{{ title }} · {{ props.targetCount }} 位用户</text><text class="cw-scope">{{ props.kind==='replace_labels'?'替换平台标签；清空标签可提交空选择。':'选择当前真实目录中的选项，确认后重新读取用户资料。' }}</text>
  <text v-if="props.loading" class="cw-muted">正在读取可选目录…</text><text v-if="props.error" class="cw-error">{{ props.error }}</text>
  <template v-if="props.kind!=='replace_labels'"><picker :range="options" range-key="name" :value="index" :disabled="props.loading||props.busy" @change="choose"><view>{{ options[index]?.name || '请选择' }}</view></picker><text v-if="!options.length&&!props.loading" class="cw-muted">当前没有可用选项</text></template>
  <template v-else><label class="cw-form-field"><text>搜索平台标签</text><input v-model="keyword" :disabled="props.busy" placeholder="输入标签名称" /></label><checkbox-group @change="changeLabels"><view v-for="group in visibleGroups" :key="group.id" class="cw-user-label-group"><text class="cw-subtitle">{{ group.name }}</text><label v-for="label in group.label" :key="label.id" class="cw-user-label-row"><checkbox :value="String(label.id)" :checked="chosen.includes(label.id)" :disabled="props.busy" /><text>{{ label.label_name }}</text></label></view></checkbox-group><text class="cw-muted">已选 {{ chosen.length }}/100</text><view v-for="id in unavailable" :key="id" class="cw-row"><text>标签 #{{ id }} 当前不在平台目录</text><button :disabled="props.busy" @tap="chosen=chosen.filter(value=>value!==id)">移除</button></view><button :disabled="props.busy" @tap="chosen=[]">清空标签</button></template>
  <text v-if="localError" class="cw-error" role="alert">{{ localError }}</text><view class="cw-dialog-buttons"><button :disabled="props.busy" @tap="emit('close')">取消</button><button :disabled="props.busy||props.loading||!!props.error" @tap="submit">确认修改</button></view>
 </view></view>
</template>
<script setup lang="ts">
import { computed,ref,watch } from 'vue';
import type { CustomerWorkUserKind,CustomerWorkUserGroups,CustomerWorkUserLevels,CustomerWorkUserLabels } from '@/types/customerWorkUsers';
import { CUSTOMER_WORK_USER_NAMES } from '@/utils/customerWorkUsersContract';
const props=defineProps<{visible:boolean;kind:Extract<CustomerWorkUserKind,'replace_level'|'replace_group'|'replace_labels'>;targetCount:number;groups:CustomerWorkUserGroups['list'];levels:CustomerWorkUserLevels['list'];labels:CustomerWorkUserLabels['list'];selected:number[];loading:boolean;busy:boolean;error:string}>();
const emit=defineEmits<{close:[];submit:[payload:Record<string,unknown>]} >();
const chosen=ref<number[]>([]),keyword=ref(''),localError=ref(''),title=computed(()=>CUSTOMER_WORK_USER_NAMES[props.kind]);
const options=computed(()=>[{id:0,name:'请选择'},...(props.kind==='replace_group'?props.groups.map(row=>({id:row.id,name:row.group_name})):props.levels.map(row=>({id:row.id,name:row.name})))]),index=computed(()=>Math.max(0,options.value.findIndex(row=>row.id===chosen.value[0])));
const visibleGroups=computed(()=>props.labels.map(group=>({...group,label:group.label.filter(label=>group.name.includes(keyword.value.trim())||label.label_name.includes(keyword.value.trim()))})).filter(group=>group.label.length)),allLabels=computed(()=>props.labels.flatMap(group=>group.label.map(label=>label.id))),unavailable=computed(()=>chosen.value.filter(id=>!allLabels.value.includes(id)));
watch(()=>[props.visible,props.kind,props.selected],()=>{chosen.value=props.visible?[...props.selected]:[];keyword.value='';localError.value='';},{immediate:true});
function choose(event:{detail:{value:string|number}}){const row=options.value[Number(event.detail.value)];chosen.value=row?.id?[row.id]:[];localError.value='';}
function changeLabels(event:{detail:{value:string[]}}){const visible=new Set(visibleGroups.value.flatMap(group=>group.label.map(label=>label.id)));chosen.value=[...new Set([...chosen.value.filter(id=>!visible.has(id)),...event.detail.value.map(Number)])];localError.value='';}
function submit(){if(props.loading||props.busy||props.error)return;if(props.kind==='replace_labels'){if(chosen.value.length>100||unavailable.value.length||chosen.value.some(id=>!Number.isInteger(id)||id<1)){localError.value='请选择不超过100个当前有效平台标签';return;}emit('submit',{label_ids:[...chosen.value].sort((a,b)=>a-b)});}else{const id=chosen.value[0];if(!id||!options.value.some(row=>row.id===id)){localError.value='请选择当前有效选项';return;}emit('submit',props.kind==='replace_level'?{level_id:id}:{group_id:id});}}
</script>
<style scoped>.cw-user-label-row{display:flex;align-items:center;gap:14rpx;padding:18rpx 0}.cw-user-label-group{padding:18rpx 0;border-bottom:1rpx solid #e3ebe5}</style>
