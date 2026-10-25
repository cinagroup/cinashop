<template>
  <div class="commerce-fields">
    <template v-for="field in fields" :key="field.key">
      <h4 v-if="field.type==='heading'">{{field.label}}</h4>
      <slot v-else-if="field.type==='tabs'" name="tabs" />
      <el-form-item v-else :label="field.label">
        <el-select v-if="field.type==='enum'" :model-value="ordinal(field)" :aria-label="`${field.label} ${field.key}`" @update:model-value="change([field.key,'tabVal'],$event)"><el-option v-for="option in field.options" :key="option.value" :value="option.value" :label="option.label" /></el-select>
        <el-input v-else-if="field.type==='text'" :model-value="text(read(block,[field.key,'value']))" :maxlength="Math.max(field.maximum,text(read(block,[field.key,'value'])).length)" show-word-limit @update:model-value="change([field.key,'value'],$event)" />
        <el-input-number v-else-if="field.type==='number'" :model-value="number(read(block,[field.key,'val']),number(record(field.defaultValue)?.val))" :min="Math.min(field.minimum,number(read(block,[field.key,'val']),field.minimum))" :max="Math.max(field.maximum,number(read(block,[field.key,'val'])))" @update:model-value="change([field.key,'val'],$event)" />
        <div v-else-if="field.type==='color'" class="colour-fields"><div v-for="(raw,index) in colours(field)" :key="index"><span v-if="colours(field).length>1">{{index===0?'起始色':'结束色'}}</span><el-color-picker :model-value="colour(field,index,raw)" show-alpha @update:model-value="change([field.key,'color',index,'item'],$event)" /><el-input :model-value="colour(field,index,raw)" :aria-label="`${field.label} ${index+1}`" @update:model-value="change([field.key,'color',index,'item'],$event)" /></div></div>
        <div v-else-if="field.type==='radius'" class="radius-fields"><el-select :model-value="flag(read(block,[field.key,'type']))?1:0" :aria-label="`${field.label}模式`" @update:model-value="change([field.key,'type'],$event)"><el-option label="全部圆角" :value="0" /><el-option label="独立四角" :value="1" /></el-select><el-input-number v-if="!flag(read(block,[field.key,'type']))" :model-value="number(read(block,[field.key,'val']))" :min="0" :max="Math.max(100,number(read(block,[field.key,'val'])))" @update:model-value="change([field.key,'val'],$event)" /><div v-else class="corners"><label v-for="(label,index) in ['左上','右上','左下','右下']" :key="index">{{label}}<el-input-number :model-value="number(read(block,[field.key,'valList',index,'val']))" :min="0" :max="Math.max(100,number(read(block,[field.key,'valList',index,'val'])))" @update:model-value="change([field.key,'valList',index,'val'],$event)" /></label></div></div>
        <div v-else-if="field.type==='check'"><el-checkbox v-for="option in checks(field)" :key="Number(record(option)?.id)" :model-value="checked(field,record(option)?.id)" @update:model-value="check(field,record(option)?.id,$event)">{{record(option)?.name}}</el-checkbox></div>
        <slot v-else-if="field.type==='image'" name="image" :field="field" :path="[field.key,'url']" />
      </el-form-item>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { commerceFields, commerceRecord as record, commerceRead as read, type CommerceRecord, type CommercePath, type CommerceField } from '@/utils/diyCommerceEditor';
import { navText as text, navFlag as flag } from '@/utils/diyNavigationEditor';
import { listRawNumber as number, listOrdinal } from '@/utils/diyListEditor';
import { listSafeColor } from '@/utils/diyListProjection';
const props=defineProps<{block:CommerceRecord}>(),emit=defineEmits<{change:[path:CommercePath,value:unknown]}>(),fields=computed(()=>commerceFields(props.block));
const change=(path:CommercePath,value:unknown)=>emit('change',path,value);
const ordinal=(field:CommerceField)=>listOrdinal(read(props.block,[field.key,'tabVal']),Number(record(field.defaultValue)?.tabVal??0),Math.max(...field.options.map(option=>option.value)));
const colours=(field:CommerceField)=>record(field.defaultValue)?.color as unknown[]??[];
const colour=(field:CommerceField,index:number,raw:unknown)=>listSafeColor(read(props.block,[field.key,'color',index,'item']),String(record(raw)?.item??'#ffffff'));
const checks=(field:CommerceField)=>record(field.defaultValue)?.list as unknown[]??[];
function checked(field:CommerceField,id:unknown){const raw=read(props.block,[field.key,'type']);return Array.isArray(raw)&&raw.includes(id);}
function check(field:CommerceField,id:unknown,enabled:unknown){if(typeof enabled!=='boolean')return;const raw=read(props.block,[field.key,'type']),next=Array.isArray(raw)?raw.filter(value=>value!==id):[];if(enabled)next.push(id);change([field.key,'type'],next);}
</script>
<style scoped>
.commerce-fields{width:100%;min-width:0}.commerce-fields h4{margin:18px 0 10px;font-size:14px}.colour-fields,.radius-fields{width:100%}.colour-fields>div{display:flex;align-items:center;gap:8px;margin-bottom:5px}.colour-fields .el-input{width:180px}.corners{display:grid;grid-template-columns:1fr 1fr;gap:8px}.commerce-fields :deep(.el-select){width:100%}.commerce-fields :deep(.el-input-number){max-width:100%}
</style>
