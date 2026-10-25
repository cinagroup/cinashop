<template>
  <div class="community-fields">
    <template v-for="field in fields" :key="field.key">
      <h4 v-if="field.type==='heading'" :data-community-field="field.key">{{field.label}}</h4>
      <el-form-item v-else :label="field.label" :data-community-field="field.key">
        <el-select v-if="field.type==='enum'" :model-value="ordinal(field)" :aria-label="`${field.label} ${field.key}`" @update:model-value="change([field.key,'tabVal'],$event)"><el-option v-for="option in field.options" :key="option.value" :value="option.value" :label="option.label" /></el-select>
        <el-input v-else-if="field.type==='text'" :model-value="text(read(block,[field.key,'value']))" :aria-label="field.label" :maxlength="Math.max(field.maximum,text(read(block,[field.key,'value'])).length)" show-word-limit @update:model-value="change([field.key,'value'],$event)" />
        <el-input-number v-else-if="field.type==='number'" :model-value="number(read(block,[field.key,'val']),number(record(field.defaultValue)?.val))" :aria-label="field.label" :min="Math.min(field.minimum,number(read(block,[field.key,'val']),field.minimum))" :max="Math.max(field.maximum,number(read(block,[field.key,'val'])))" @update:model-value="change([field.key,'val'],$event)" />
        <div v-else-if="field.type==='color'" class="colour-fields"><div v-for="(raw,index) in colours(field)" :key="index"><span v-if="colours(field).length>1">{{index===0?'起始色':'结束色'}}</span><el-color-picker :model-value="colour(field,index,raw)" show-alpha @update:model-value="change([field.key,'color',index,'item'],$event)" /><el-input :model-value="colour(field,index,raw)" :aria-label="`${field.label} ${index+1}`" @update:model-value="change([field.key,'color',index,'item'],$event)" /></div></div>
        <div v-else-if="field.type==='radius'" class="radius-fields"><el-select :model-value="flag(read(block,[field.key,'type']))?1:0" :aria-label="`${field.label}模式`" @update:model-value="change([field.key,'type'],$event)"><el-option label="全部圆角" :value="0" /><el-option label="独立四角" :value="1" /></el-select><el-input-number v-if="!flag(read(block,[field.key,'type']))" :model-value="number(read(block,[field.key,'val']))" :min="Math.min(0,number(read(block,[field.key,'val'])))" :max="Math.max(100,number(read(block,[field.key,'val'])))" :aria-label="`${field.label}值`" @update:model-value="change([field.key,'val'],$event)" /><div v-else class="corners"><label v-for="(label,index) in ['左上','右上','左下','右下']" :key="index">{{label}}<el-input-number :model-value="number(read(block,[field.key,'valList',index,'val']))" :min="Math.min(0,number(read(block,[field.key,'valList',index,'val'])))" :max="Math.max(100,number(read(block,[field.key,'valList',index,'val'])))" :aria-label="`${field.label}${label}`" @update:model-value="change([field.key,'valList',index,'val'],$event)" /></label></div></div>
        <slot v-else-if="field.type==='image'" name="image" :field="field" :path="[field.key,'url']" />
        <slot v-else-if="field.type==='topic'" name="topic" :field="field" :path="['selectConfig','activeValue']"><el-input :model-value="text(read(block,['selectConfig','activeValue']))" :aria-label="field.label" @update:model-value="change(['selectConfig','activeValue'],$event)" /></slot>
      </el-form-item>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { communityFields, communityRecord as record, communityRead as read, type CommunityRecord, type CommunityPath, type CommunityField } from '@/utils/diyCommunityEditor';
import { navText as text, navFlag as flag } from '@/utils/diyNavigationEditor';
import { listOrdinal } from '@/utils/diyListEditor';
import { listSafeColor } from '@/utils/diyListProjection';
const props=defineProps<{block:CommunityRecord}>(),emit=defineEmits<{change:[path:CommunityPath,value:unknown]}>();
const fields=computed(()=>communityFields(props.block));
const change=(path:CommunityPath,value:unknown)=>emit('change',path,value);
const number=(value:unknown,fallback=0)=>{const parsed=typeof value==='number'||typeof value==='string'&&value.trim()!==''?Number(value):NaN;return Number.isFinite(parsed)?parsed:fallback;};
const ordinal=(field:CommunityField)=>listOrdinal(read(props.block,[field.key,'tabVal']),Number(record(field.defaultValue)?.tabVal??0),Math.max(...field.options.map(option=>option.value)));
const colours=(field:CommunityField)=>record(field.defaultValue)?.color as unknown[]??[];
const colour=(field:CommunityField,index:number,raw:unknown)=>listSafeColor(read(props.block,[field.key,'color',index,'item']),String(record(raw)?.item??'#ffffff'));
</script>
<style scoped>
.community-fields{width:100%;min-width:0}.community-fields h4{margin:18px 0 10px;font-size:14px}.colour-fields,.radius-fields{width:100%}.colour-fields>div{display:flex;align-items:center;gap:8px;margin-bottom:5px}.colour-fields .el-input{width:180px}.corners{display:grid;grid-template-columns:1fr 1fr;gap:8px}.community-fields :deep(.el-select){width:100%}.community-fields :deep(.el-input-number){max-width:100%}
</style>
