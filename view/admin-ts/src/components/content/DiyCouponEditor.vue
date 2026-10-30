<template>
  <section class="coupon-editor" aria-label="优惠券作者编辑器">
    <strong>优惠券</strong><p class="hint">编辑与装修 JSON 同步，保存页面后生效。自动展示公开优惠券，不指定发行、不读写领取记录；完整导入与隐藏字段保留。</p>
    <el-alert v-if="parsed.error" :title="parsed.error" type="warning" :closable="false" />
    <template v-else>
      <div class="toolbar"><el-button :disabled="!canEdit" @click="session.add">添加优惠券组件</el-button></div>
      <template v-if="entries.length">
        <el-select :model-value="selected" aria-label="选择优惠券组件" @update:model-value="session.select"><el-option v-for="entry in entries" :key="entry.index" :value="entry.index" :label="`第 ${entry.index+1} 项 · 优惠券`" /></el-select>
        <div class="toolbar"><el-button :disabled="!canEdit" @click="session.up">上移优惠券组件</el-button><el-button :disabled="!canEdit" @click="session.down">下移优惠券组件</el-button><el-button :disabled="!canEdit" type="danger" @click="session.remove">删除优惠券组件</el-button></div>
        <template v-if="block"><el-form :key="contextEpoch" label-position="top" :disabled="!canEdit">
          <div class="fields">
            <el-form-item label="优惠券显示"><el-switch :model-value="!flag(block.isHide)" @update:model-value="session.visible" /></el-form-item>
            <el-form-item label="优惠券编辑分组"><el-select :model-value="number(read(block,['setUp','tabVal']))" @update:model-value="session.group"><el-option label="内容" :value="0" /><el-option label="样式" :value="1" /></el-select></el-form-item>
            <el-form-item label="优惠券风格"><el-select :model-value="view.style" @update:model-value="session.style"><el-option v-for="(label,index) in ['弧形券','竖向卡片','虚线票券','领券站','横向票券']" :key="index" :value="index" :label="label" /></el-select></el-form-item>
            <el-form-item label="优惠券展示数量"><el-input-number :model-value="number(read(block,['numberConfig','val']),6)" :min="Math.min(1,number(read(block,['numberConfig','val']),6))" :max="Math.max(100,number(read(block,['numberConfig','val']),6))" aria-label="优惠券展示数量" @update:model-value="session.count" /></el-form-item>
            <el-form-item label="优惠券色调"><el-select :model-value="view.custom?1:0" @update:model-value="session.tone"><el-option label="跟随主题" :value="0" /><el-option label="自定义" :value="1" /></el-select></el-form-item>
          </div>
          <p class="hint">普通新数量为1–100；公开列表最多展示10张。完整导入值不会在挂载时改写，超出当前公开范围的配置仍可保存。</p>
          <div class="fields">
            <el-form-item v-for="field in shownColours" :key="field.label" :label="field.label"><el-input :model-value="colour(field)" :aria-label="field.label" @update:model-value="session.colours[field.label]" /><el-color-picker :model-value="colour(field)" show-alpha @update:model-value="session.colours[field.label]" /></el-form-item>
            <el-form-item v-for="field in lengths" :key="field.key" :label="field.label+'（设计 px）'"><el-input-number :model-value="number(read(block,[field.key,'val']))" :min="0" :max="Math.max(100,number(read(block,[field.key,'val'])))" :aria-label="field.label" @update:model-value="session.lengths[field.key]" /></el-form-item>
            <el-form-item label="优惠券背景圆角方式"><el-select :model-value="flag(read(block,['fillet','type']))?1:0" @update:model-value="session.radiusMode"><el-option label="统一圆角" :value="0" /><el-option label="独立四角" :value="1" /></el-select></el-form-item>
            <el-form-item v-for="(label,index) in flag(read(block,['fillet','type']))?['左上','右上','左下','右下']:['统一']" :key="label" :label="'优惠券背景圆角'+label"><el-input-number :model-value="number(read(block,radiusPath(index)),8)" :min="0" :max="Math.max(100,number(read(block,radiusPath(index)),8))" :aria-label="'优惠券背景圆角'+label" @update:model-value="session.radii[index]" /></el-form-item>
          </div>
          <p class="hint">优惠券间距仅在领券站生效，其他公开风格使用固定间距。独立四角按左上、右上、左下、右下编辑，隐藏样式资料完整保留。</p>
        </el-form>
        <el-alert v-if="error" :title="error" type="warning" :closable="false" />
        <div class="toolbar"><el-button :disabled="!canEdit || loading" :loading="loading" @click="session.preview">读取公开优惠券</el-button></div>
        <DiyCouponPreview :block="block" :coupons="coupons" :loaded="loaded" :loading="loading" :error="previewError" />
        </template>
      </template><p v-else class="hint">此页面暂无优惠券组件。</p>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getToken } from '@/utils/auth';
import { couponDocument, couponRecord as record, couponEntries, couponRead as read, couponFlag as flag, couponNumber as number, addCouponBlock, moveCouponBlock, removeCouponBlock, couponSet, setCouponNumber, setCouponCount, type CouponRecord } from '@/utils/diyCouponEditor';
import { apiDiyCouponPreview, type CouponPreview } from '@/api/diyCouponAuthor';
import { couponPresentation } from '../../../../common/diyCoupon';
import { listPreviewTheme, listSafeColor } from '@/utils/diyListProjection';
import DiyCouponPreview from './DiyCouponPreview.vue';
const props=withDefaults(defineProps<{modelValue:string;editorKey:string;disabled?:boolean;pageId?:number}>(),{disabled:false,pageId:0}),emit=defineEmits<{'update:modelValue':[value:string]}>(),auth=useAuthStore();
const selected=ref(-1),revision=ref(0),contextEpoch=ref(0),error=ref(''),coupons=ref<CouponPreview[]>([]),loading=ref(false),loaded=ref(false),previewError=ref('');
let alive=true,abort:AbortController|null=null,receiptSerial=0,pending:null|{raw:string;serial:number;keep:boolean}=null;
const actor=()=>`${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}:${getToken()}:${localStorage.getItem('admin_session')}`;
const editable=()=>alive&&!props.disabled&&!!auth.token&&auth.token===getToken()&&!!auth.userInfo&&(auth.userInfo.level===0||auth.uniqueAuth.includes('dise.manage'));
const canEdit=computed(()=>{void revision.value;return editable();});
const parsed=computed(()=>{try{return{value:couponDocument(props.modelValue),error:''};}catch(reason){return{value:null,error:reason instanceof Error?reason.message:'装修JSON无效'};}}),document=computed(()=>parsed.value.value),entries=computed(()=>couponEntries(document.value??[]));
const block=computed(()=>{const row=record(document.value?.[selected.value]);return row?.name==='coupon'?row:null;}),view=computed(()=>couponPresentation(block.value,listPreviewTheme,listSafeColor));
function stamp(){return{actor:actor(),editor:props.editorKey,page:props.pageId,index:selected.value,raw:props.modelValue,revision:revision.value};}
function current(s:ReturnType<typeof stamp>){return editable()&&s.actor===actor()&&s.editor===props.editorKey&&s.page===props.pageId&&s.index===selected.value&&s.raw===props.modelValue&&s.revision===revision.value;}
function invalidate(keep=false){revision.value++;abort?.abort();abort=null;loading.value=false;error.value='';if(!keep){coupons.value=[];loaded.value=false;previewError.value='';}}
function context(){pending=null;contextEpoch.value++;invalidate();}
watch(entries,()=>{if(!entries.value.some(row=>row.index===selected.value))selected.value=entries.value[0]?.index??-1;},{immediate:true,flush:'sync'});
watch(selected,context,{flush:'sync'});
watch(()=>props.modelValue,raw=>{const receipt=pending;pending=null;if(receipt?.raw===raw)invalidate(receipt.keep);else context();},{flush:'sync'});
watch(()=>[props.editorKey,props.disabled,props.pageId,actor()],context,{flush:'sync'});
for(const event of ['admin-session-changed','admin-auth-expired','storage'])window.addEventListener(event,context);
onBeforeUnmount(()=>{alive=false;context();for(const event of ['admin-session-changed','admin-auth-expired','storage'])window.removeEventListener(event,context);});
function commit(value:unknown[],keep=false){if(!editable())return false;try{const raw=JSON.stringify(value,null,2);couponDocument(raw);if(raw===props.modelValue)return false;invalidate(keep);const serial=++receiptSerial;pending={raw,serial,keep};emit('update:modelValue',raw);void nextTick(()=>{if(pending?.serial===serial)pending=null;});return true;}catch(reason){error.value=reason instanceof Error?reason.message:'当前配置无法完整保存';return false;}}
function edit(change:(row:CouponRecord)=>unknown){if(!editable()||!document.value||!block.value)return false;try{const copy=structuredClone(document.value),row=record(copy[selected.value])!;change(row);if(JSON.stringify(copy)===JSON.stringify(document.value))return false;const next=couponPresentation(row,listPreviewTheme,listSafeColor);return commit(copy,next.limit===view.value.limit);}catch(reason){error.value=reason instanceof Error?reason.message:'当前字段无法修改';return false;}}
function leaf(path:Array<string|number>,value:unknown){return edit(row=>couponSet(row,path,value));}
function select(value:unknown){if(typeof value==='number'&&entries.value.some(row=>row.index===value)&&value!==selected.value){context();selected.value=value;}}
function add(){if(!editable()||!document.value)return;try{const result=addCouponBlock(document.value);if(commit(result.value))selected.value=result.selected;}catch(reason){error.value=reason instanceof Error?reason.message:'无法添加优惠券';}}
function move(direction:-1|1){if(!editable()||!document.value)return;try{const result=moveCouponBlock(document.value,selected.value,direction);if(commit(result.value))selected.value=result.selected;}catch(reason){error.value=reason instanceof Error?reason.message:'无法移动优惠券';}}
function remove(){if(!editable()||!document.value)return;try{const result=removeCouponBlock(document.value,selected.value);if(commit(result.value))selected.value=result.selected;}catch(reason){error.value=reason instanceof Error?reason.message:'无法删除优惠券';}}
function ordinal(path:Array<string|number>,value:unknown,max:number){if(typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=max&&value!==number(read(block.value,path)))leaf(path,value);}
type Colour={key:string;index:number;label:string;fallback:string;visible:()=>boolean};
const colours:Colour[]=[{key:'couponMoneyColor',index:0,label:'优惠金额颜色',fallback:'#E93323',visible:()=>view.value.custom},{key:'bntBgColor',index:0,label:'领取按钮起始色',fallback:'#FF7931',visible:()=>view.value.custom&&view.value.style!==2},{key:'bntBgColor',index:1,label:'领取按钮结束色',fallback:'#E93323',visible:()=>view.value.custom&&view.value.style!==2},{key:'couponBgColor',index:0,label:'券背景颜色',fallback:'#E93323',visible:()=>view.value.custom&&[0,3].includes(view.value.style)},{key:'moduleColor',index:0,label:'组件背景起始色',fallback:'#E93323',visible:()=>view.value.style===1},{key:'moduleColor',index:1,label:'组件背景结束色',fallback:'#FF7931',visible:()=>view.value.style===1},{key:'moduleColor2',index:0,label:'组件背景颜色',fallback:'#ffffff',visible:()=>view.value.style!==1},{key:'bottomBgColor',index:0,label:'外层背景颜色',fallback:'#f5f5f5',visible:()=>true}];
const shownColours=computed(()=>colours.filter(field=>field.visible()));
function colour(field:Colour){return listSafeColor(read(block.value,[field.key,'color',field.index,'item']),field.fallback);}
function setColour(field:Colour,value:unknown){if(field.visible()&&typeof value==='string'&&listSafeColor(value,'')===value.trim())leaf([field.key,'color',field.index,'item'],value.trim());}
const lengths=[{key:'spacingConfig',label:'优惠券间距'},{key:'topConfig',label:'优惠券上边距'},{key:'bottomConfig',label:'优惠券下边距'},{key:'prConfig',label:'优惠券左右边距'},{key:'mbConfig',label:'优惠券页面上间距'}];
function length(key:string,value:unknown){if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Math.max(100,number(read(block.value,[key,'val']))))edit(row=>setCouponNumber(row,[key,'val'],value));}
function radiusPath(index:number):Array<string|number>{return flag(read(block.value,['fillet','type']))?['fillet','valList',index,'val']:['fillet','val'];}
function radius(index:number,value:unknown){const path=radiusPath(index);if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Math.max(100,number(read(block.value,path),8)))edit(row=>setCouponNumber(row,path,value));}
async function preview(){if(!editable()||!block.value||loading.value)return;abort?.abort();const controller=new AbortController(),s=stamp(),limit=view.value.limit;abort=controller;loading.value=true;loaded.value=false;previewError.value='';coupons.value=[];
 try{const rows=limit>0?await apiDiyCouponPreview(limit,controller.signal):[];if(!current(s)||abort!==controller||controller.signal.aborted)return;coupons.value=rows;loaded.value=true;}catch(reason){if(current(s)&&abort===controller&&!controller.signal.aborted)previewError.value=reason instanceof Error?reason.message:'优惠券读取失败，请重试';}finally{if(abort===controller){abort=null;loading.value=false;}}
}
const session=computed(()=>{const s=stamp(),guard=<T extends unknown[]>(fn:(...args:T)=>unknown)=>(...args:T)=>{if(current(s))return fn(...args);};return{add:guard(add),select:guard(select),up:guard(()=>move(-1)),down:guard(()=>move(1)),remove:guard(remove),visible:guard((v:unknown)=>{if(typeof v==='boolean'&&flag(block.value?.isHide)!==!v)leaf(['isHide'],!v);}),group:guard((v:unknown)=>ordinal(['setUp','tabVal'],v,1)),style:guard((v:unknown)=>ordinal(['styleConfig','tabVal'],v,4)),tone:guard((v:unknown)=>ordinal(['toneConfig','tabVal'],v,1)),count:guard((v:unknown)=>edit(row=>setCouponCount(row,v))),radiusMode:guard((v:unknown)=>{if((v===0||v===1)&&flag(read(block.value,['fillet','type']))!==!!v)leaf(['fillet','type'],v);}),preview:guard(preview),colours:Object.fromEntries(colours.map(f=>[f.label,guard((v:unknown)=>setColour(f,v))])),lengths:Object.fromEntries(lengths.map(f=>[f.key,guard((v:unknown)=>length(f.key,v))])),radii:[0,1,2,3].map(i=>guard((v:unknown)=>radius(i,v)))};});
</script>
<style scoped>
.coupon-editor{width:100%;min-width:0;overflow-wrap:anywhere}.hint{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary);overflow-wrap:anywhere}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 14px}.el-form-item{min-width:0}.el-select{max-width:100%}.el-form-item :deep(.el-input-number){max-width:100%}@media(max-width:600px){.fields{grid-template-columns:1fr}}
</style>
