<template>
<section class="commerce-author-editor" aria-label="商城组件作者编辑器">
<h3>商城活动、促销与优惠券</h3><p class="hint">沿用 PHP 原版字段和图片。切换风格保留未显示配置，编辑后保存页面生效。</p>
<el-alert v-if="parsed.error" :title="parsed.error" type="warning" :closable="false" />
<template v-else-if="document">
<div class="toolbar"><el-select v-model="addKind" aria-label="新增商城组件类型" :disabled="!canEdit"><el-option v-for="name in names" :key="name" :label="labels[name]" :value="name" /></el-select><el-button :disabled="!canEdit" @click="add()">添加商城组件</el-button></div>
<template v-if="entries.length"><el-select :model-value="selected" aria-label="选择商城组件" @update:model-value="select"><el-option v-for="entry in entries" :key="entry.index" :value="entry.index" :label="`第 ${entry.index+1} 项 · ${labels[entry.kind]}`" /></el-select>
<div class="toolbar"><el-button :disabled="!canEdit" @click="move(-1)">上移商城组件</el-button><el-button :disabled="!canEdit" @click="move(1)">下移商城组件</el-button><el-button :disabled="!canEdit" @click="add(true)">复制商城组件</el-button><el-button type="danger" :disabled="!canEdit" @click="remove">删除当前商城组件</el-button></div>
<template v-if="block&&kind"><el-form label-position="top" :disabled="!canEdit">
<el-form-item label="商城组件显示"><el-select :model-value="!flag(block.isHide)" @update:model-value="visible"><el-option label="显示" :value="true" /><el-option label="隐藏并保留配置" :value="false" /></el-select></el-form-item>
<el-form-item label="商城编辑面板"><el-radio-group :model-value="number(read(block,['setUp','tabVal']))" @update:model-value="setLeaf(['setUp','tabVal'],$event)"><el-radio-button :value="0">内容设置</el-radio-button><el-radio-button :value="1">样式设置</el-radio-button></el-radio-group></el-form-item>
<DiyCommerceFields :block="block" @change="setLeaf">
<template #image="slot"><div class="image-slot"><img v-if="previewImage(slot.path)" :src="previewImage(slot.path)" alt="商城作者图片" /><span class="stored">{{text(read(block,slot.path))||'未选择图片'}}</span><SeckillActivityImagePicker :disabled="!canChooseMedia" :editor-key="mediaSession(slot.path).key" :title="`选择${slot.field.label}`" @choose="mediaSession(slot.path).choose" /><el-button :disabled="!canEdit" @click="setImage(slot.path,'')">清空图片</el-button></div></template>
<template #tabs>
<el-alert v-if="tabResult.error" :title="tabResult.error" type="warning" :closable="false" />
<template v-else><div class="toolbar"><el-select :model-value="tabIndex" aria-label="选择促销页签" @update:model-value="selectTab"><el-option v-for="(raw,index) in tabs" :key="index" :value="index" :label="`${index+1} · ${tabLabel(raw,index)}`" /></el-select><el-button :disabled="!canEdit" @click="tabEdit('add')">添加促销页签</el-button></div>
<template v-if="tab"><div class="toolbar"><el-button :disabled="!canEdit||tabIndex===0" @click="tabEdit('move',-1)">上移页签</el-button><el-button :disabled="!canEdit||tabIndex===tabs.length-1" @click="tabEdit('move',1)">下移页签</el-button><el-button :disabled="!canEdit" @click="tabEdit('remove')">删除页签</el-button></div>
<el-form-item v-for="(label,index) in ['页签标题','页签简介']" :key="index" :label="label"><el-input :model-value="text(read(tab,['chiild',index,'val']))" :maxlength="Math.max(4,text(read(tab,['chiild',index,'val'])).length)" @update:model-value="setTab(['chiild',index,'val'],$event)" /></el-form-item>
<el-form-item v-if="number(read(block,['styleConfig','tabVal']))===4" label="页签图片"><div class="image-slot"><img v-if="previewImage(['tabConfig','list',tabIndex,'image'])" :src="previewImage(['tabConfig','list',tabIndex,'image'])" alt="促销页签图片" /><span class="stored">{{text(tab.image)||'未选择图片'}}</span><SeckillActivityImagePicker :disabled="!canChooseMedia" :editor-key="mediaSession(['tabConfig','list',tabIndex,'image']).key" title="选择页签图片" @choose="mediaSession(['tabConfig','list',tabIndex,'image']).choose" /><el-button :disabled="!canEdit" @click="setImage(['tabConfig','list',tabIndex,'image'],'')">清空页签图片</el-button></div></el-form-item>
<el-form-item label="促销商品范围"><el-select :model-value="number(tab.tabVal,3)" @update:model-value="setTab(['tabVal'],$event)"><el-option v-for="(label,index) in ['指定商品','商品品牌','商品分类','商品标签']" :key="index" :value="index+1" :label="label" /></el-select></el-form-item>
<el-alert v-if="selectionResult.error" :title="selectionResult.error" type="warning" :closable="false" />
<div v-for="(raw,index) in selectionResult.list" :key="index" class="selection-row"><span>{{record(raw)?.id??record(raw)?.value??raw}}</span><el-button :disabled="!canEdit||index===0" @click="selectionEdit('move',index,-1)">上移范围项</el-button><el-button :disabled="!canEdit||index===selectionResult.list.length-1" @click="selectionEdit('move',index,1)">下移范围项</el-button><el-button :disabled="!canEdit" @click="selectionEdit('remove',index)">移除范围项</el-button></div>
<DiyListSelectionPicker :kind="selectionKind" :editor-key="picker.key" :disabled="!canEdit||!!selectionResult.error" @choose="picker.choose" /><el-button :disabled="!canEdit" @click="selectionEdit('clear')">清空当前范围</el-button>
<el-form-item v-if="selectionKind!=='product'" label="促销商品排序"><el-select :model-value="number(tab.goodsSort)" @update:model-value="setTab(['goodsSort'],$event)"><el-option label="默认" :value="0" /><el-option label="销量降序" :value="1" /><el-option label="价格降序" :value="2" /></el-select></el-form-item>
<el-form-item label="促销商品数量"><el-input-number :model-value="number(read(tab,['numConfig','val']),6)" :min="0" :max="Math.max(100,number(read(tab,['numConfig','val'])))" @update:model-value="setTab(['numConfig','val'],$event)" /></el-form-item>
</template><p v-else-if="tabs.length" class="hint">该导入页签结构异常，保留原值，可通过装修 JSON 明确修复。</p></template>
</template>
</DiyCommerceFields></el-form>
<p v-if="kind!=='promotionList'&&kind!=='liveBroadcast'&&number(read(block,['numberConfig','val']))>10" class="hint">当前用户端每个组件最多展示 10 项；已存配置数量保留。</p>
<p v-if="kind==='liveBroadcast'" class="hint">直播面向小程序。此处只展示公开房间信息，H5 和 App 不播放直播。</p>
<el-alert v-if="error" :title="error" type="error" :closable="false" />
<div class="toolbar"><el-button :disabled="!canEdit||!pageId||!pagePublished||mediaLoading" :loading="mediaLoading" @click="loadSavedMedia">读取已发布商城图片预览</el-button><el-button :disabled="!canEdit||previewLoading" :loading="previewLoading" @click="loadContent">读取公开商城预览</el-button></div>
<DiyCommercePreview :block="previewBlock" :data="previewData" :loading="previewLoading" :loaded="previewLoaded" :error="error" :selected-tab="previewTab" :selected-slot="previewSlot" @tab="selectPreviewTab" @slot="selectPreviewSlot" />
</template></template><p v-else class="hint">此页面暂无商城组件。</p></template>
</section>
</template>
<script setup lang="ts">

import { computed,nextTick,onBeforeUnmount,ref,watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getToken } from '@/utils/auth';
import SeckillActivityImagePicker from '@/pages/activity/SeckillActivityImagePicker.vue';
import DiyListSelectionPicker from './DiyListSelectionPicker.vue';
import DiyCommerceFields from './DiyCommerceFields.vue';
import DiyCommercePreview from './DiyCommercePreview.vue';
import { COMMERCE_NAMES as names,commerceLabels as labels,commerceKind,commerceEntries,commerceDocument,commerceRecord as record,commerceRead as read,addCommerceBlock,moveCommerceBlock,commerceImageIdentity as imageIdentity,commerceMediaPaths,canonicalCommerceBlock,commercePreviewUrl,commerceFieldPatch,commerceTabs,commerceTabListEdit,commerceTabPatch,commerceTabScope,commerceTabSelections,chooseCommerceSelection,changeCommerceSelection,type CommerceKind,type CommercePath,type CommerceRecord } from '@/utils/diyCommerceEditor';
import { navFlag as flag,navText as text,navSet } from '@/utils/diyNavigationEditor';
import { listRawNumber as number,type ListSelection } from '@/utils/diyListEditor';
import { normalizeDiyCommerce } from '@/utils/diyCommerceProjection';
import { themePreset } from '../../../../common/theme';
import { readCommercePreview,type CommercePreview } from '@/api/diyCommerceAuthor';
const props=withDefaults(defineProps<{modelValue:string;editorKey:string;disabled?:boolean;pageId?:number;pagePublished?:boolean}>(),{disabled:false,pageId:0,pagePublished:false}),emit=defineEmits<{'update:modelValue':[value:string]}>(),auth=useAuthStore();
const selected=ref(-1),addKind=ref<CommerceKind>('promotionList'),revision=ref(0),error=ref(''),previews=ref<Record<string,string>>({}),mediaLoading=ref(false),leaseTick=ref(0);
let alive=true,lastCommitted='',mediaAbort:AbortController|null=null,leaseTimer:ReturnType<typeof setTimeout>|undefined;
type OwnEcho={beforeRaw:string;expectedRaw:string;owner:string;editor:string;index:number;disabled:boolean;pageId:number;pagePublished:boolean;leases:Record<string,string>;echo:boolean};
let pendingOwnEcho:OwnEcho|null=null;
function ownEchoCurrent(own:OwnEcho){return editable()&&own.owner===actor()&&own.editor===props.editorKey&&own.index===selected.value&&own.disabled===props.disabled&&own.pageId===props.pageId&&own.pagePublished===props.pagePublished&&own.expectedRaw===props.modelValue;}
const actor=()=>`${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}:${getToken()}:${localStorage.getItem('admin_session')}`;
function editable(){return alive&&!props.disabled&&!!auth.token&&auth.token===getToken()&&!!auth.userInfo&&(auth.userInfo.level===0||auth.uniqueAuth.includes('dise.manage'));}
const canEdit=computed(()=>{void revision.value;return editable();}),canChooseMedia=computed(()=>canEdit.value&&!!auth.userInfo&&(auth.userInfo.level===0||auth.uniqueAuth.includes('attachment.view')));
const parsed=computed(()=>{try{return{value:commerceDocument(props.modelValue),error:''};}catch(reason){return{value:null,error:reason instanceof Error?reason.message:'装修 JSON 无效'};}}),document=computed(()=>parsed.value.value),entries=computed(()=>commerceEntries(document.value??[])),block=computed(()=>record(document.value?.[selected.value])),kind=computed(()=>commerceKind(block.value?.name));

const tabIndex=ref(0),previewTab=ref(0),previewSlot=ref(0),previewData=ref<CommercePreview|null>(null),previewLoading=ref(false),previewLoaded=ref(false);
let previewAbort:AbortController|null=null,contentTimer:ReturnType<typeof setTimeout>|undefined;
const tabResult=computed(()=>{try{return{list:kind.value==='promotionList'&&block.value?commerceTabs(block.value):[],error:''};}catch(reason){return{list:[],error:reason instanceof Error?reason.message:'页签异常'};}});
const tabs=computed(()=>tabResult.value.list),tab=computed(()=>record(tabs.value[tabIndex.value])),selectionKind=computed(()=>commerceTabScope(tab.value)),selectionResult=computed(()=>{try{return{list:tab.value?commerceTabSelections(tab.value):[],error:''};}catch(reason){return{list:[],error:reason instanceof Error?reason.message:'范围异常'};}});
function tabLabel(raw:unknown,index:number){return text(read(raw,['chiild',0,'val']))||`页签 ${index+1}`;}
function selectTab(value:unknown){if(typeof value==='number'&&value>=0&&value<tabs.value.length){invalidate();tabIndex.value=value;}}
function tabEdit(action:'add'|'remove'|'move',direction:-1|1=1){const index=tabIndex.value,oldLength=tabs.value.length;if(edit(row=>commerceTabListEdit(row,action,index,direction))){tabIndex.value=action==='add'?oldLength:action==='remove'?Math.max(0,index-1):index+direction;}}
function setTab(path:CommercePath,value:unknown){edit(row=>commerceTabPatch(row,tabIndex.value,path,value));}
function selectionEdit(action:'clear'|'remove'|'move',at=-1,direction:-1|1=1){edit(row=>changeCommerceSelection(row,tabIndex.value,action,at,direction));}
const picker=computed(()=>{const issued=stamp(),index=tabIndex.value,expected=selectionKind.value;return{key:`${props.editorKey}:${revision.value}:${selected.value}:${index}:${expected}`,choose:(choice:ListSelection)=>{if(current(issued)&&index===tabIndex.value&&choice.kind===expected)edit(row=>chooseCommerceSelection(row,index,choice));}};});
function selectPreviewTab(index:number){if(!editable())return;invalidate();previewTab.value=index;void loadContent();}
function selectPreviewSlot(id:number){if(!editable())return;invalidate();previewSlot.value=id;void loadContent();}
async function loadContent(){
 if(!editable()||!block.value)return;previewAbort?.abort();const issued=stamp(),controller=new AbortController(),tab=previewTab.value,slot=previewSlot.value;previewAbort=controller;previewLoading.value=true;previewLoaded.value=false;previewData.value=null;error.value='';
 try{const result=await readCommercePreview(normalizeDiyCommerce(block.value,themePreset(3)),tab,slot,controller.signal);if(!current(issued)||previewAbort!==controller||controller.signal.aborted||tab!==previewTab.value||slot!==previewSlot.value)return;previewData.value=result;previewSlot.value=result.selectedSlot;previewLoaded.value=true;
 const expiries=[...JSON.stringify(result).matchAll(/[?&]expires=(\d+)/gu)].map(match=>Number(match[1])*1000).filter(value=>Number.isFinite(value));clearTimeout(contentTimer);if(expiries.length)contentTimer=setTimeout(()=>{if(current(issued)){previewData.value=null;previewLoaded.value=false;error.value='公开素材预览已过期，请重新读取';}},Math.min(2147483647,Math.max(1,Math.min(...expiries)-Date.now()+1)));
 }catch(reason){if(current(issued)&&previewAbort===controller&&!controller.signal.aborted)error.value=reason instanceof Error?reason.message:'商城预览读取失败';}finally{if(previewAbort===controller){previewAbort=null;previewLoading.value=false;}}
}
function stamp(){return{revision:revision.value,actor:actor(),editor:props.editorKey,index:selected.value,raw:props.modelValue};}
function current(s:ReturnType<typeof stamp>){return editable()&&s.revision===revision.value&&s.actor===actor()&&s.editor===props.editorKey&&s.index===selected.value&&s.raw===props.modelValue;}
function invalidate(preserveOwnEcho:unknown=false){if(preserveOwnEcho!==true)pendingOwnEcho=null;revision.value++;error.value='';mediaAbort?.abort();mediaAbort=null;mediaLoading.value=false;previewAbort?.abort();previewAbort=null;previewLoading.value=false;previewLoaded.value=false;previewData.value=null;clearTimeout(contentTimer);previews.value={};clearTimeout(leaseTimer);leaseTimer=undefined;leaseTick.value++;}
watch(entries,()=>{if(!entries.value.some(row=>row.index===selected.value))selected.value=entries.value[0]?.index??-1;},{immediate:true});
watch(selected,()=>{invalidate();tabIndex.value=previewTab.value=previewSlot.value=0;},{flush:'sync'});
watch(()=>[props.modelValue,props.editorKey,props.disabled,props.pageId,props.pagePublished,actor()],(next,previous)=>{
  const own=pendingOwnEcho,echo=!!own&&!own.echo&&!!previous&&previous[0]===own.beforeRaw&&next[0]===own.expectedRaw&&next.slice(1).every((value,index)=>value===previous[index+1])&&ownEchoCurrent(own);
  invalidate(echo);if(echo&&own)own.echo=true;
},{flush:'sync'});
window.addEventListener('admin-session-changed',invalidate);window.addEventListener('admin-auth-expired',invalidate);window.addEventListener('storage',invalidate);
onBeforeUnmount(()=>{alive=false;invalidate();window.removeEventListener('admin-session-changed',invalidate);window.removeEventListener('admin-auth-expired',invalidate);window.removeEventListener('storage',invalidate);});
function commit(value:unknown[]){if(!editable())return false;try{
  const raw=JSON.stringify(value,null,2);commerceDocument(raw);
  const own:OwnEcho={beforeRaw:props.modelValue,expectedRaw:raw,owner:actor(),editor:props.editorKey,index:selected.value,disabled:props.disabled,pageId:props.pageId,pagePublished:props.pagePublished,leases:{...previews.value},echo:false};
  invalidate();pendingOwnEcho=own;lastCommitted=raw;emit('update:modelValue',raw);
  void nextTick(()=>{
    if(pendingOwnEcho!==own)return;
    if(!own.echo||!ownEchoCurrent(own)){pendingOwnEcho=null;return;}
    const next:Record<string,string>={};
    if(block.value)for(const path of commerceMediaPaths(block.value)){const raw=read(block.value,path),identity=imageIdentity(raw),lease=own.leases[identity];if(lease&&commercePreviewUrl(raw,lease))next[identity]=lease;}
    renewLeases(next);
  });return true;
}catch(reason){error.value=reason instanceof Error?reason.message:'无法完整保存';return false;}}
function edit(change:(row:CommerceRecord)=>boolean|void){if(!editable()||!document.value||!block.value||!kind.value)return false;try{const value=structuredClone(document.value),row=record(value[selected.value]);if(!row||change(row)===false)return false;return commit(value);}catch(reason){error.value=reason instanceof Error?reason.message:'当前字段无法修改';return false;}}
function setLeaf(path:CommercePath,value:unknown){if(read(block.value,path)===value)return false;return edit(row=>commerceFieldPatch(row,path,value));}
function select(value:unknown){if(typeof value==='number'&&entries.value.some(entry=>entry.index===value)){invalidate();selected.value=value;}}
function add(duplicate=false){if(!editable()||!document.value)return;try{const k=duplicate?kind.value:addKind.value;if(!k)return;const result=addCommerceBlock(document.value,k,duplicate&&block.value?block.value:undefined);if(commit(result.value))selected.value=result.selected;}catch(reason){error.value=reason instanceof Error?reason.message:'无法添加组件';}}
function remove(){if(!document.value||!kind.value)return;const value=structuredClone(document.value);value.splice(selected.value,1);if(commit(value))selected.value=-1;}
function move(direction:-1|1){if(!document.value)return;try{const result=moveCommerceBlock(document.value,selected.value,direction);if(commit(result.value))selected.value=result.selected;}catch(reason){error.value=reason instanceof Error?reason.message:'不能移动组件';}}
function visible(value:unknown){if(typeof value==='boolean'&&flag(block.value?.isHide)!==!value)setLeaf(['isHide'],!value);}
function mediaPathAllowed(path:CommercePath){return !!block.value&&commerceMediaPaths(block.value).some(p=>JSON.stringify(p)===JSON.stringify(path));}
function setImage(path:CommercePath,value:string){if(!mediaPathAllowed(path))return false;const canonical=imageIdentity(value);if(canonical&&!(canonical.startsWith('https://')||/^\/(?!\/)/u.test(canonical))||/[\u0000-\u0020\u007f\\]/u.test(canonical))return false;if(imageIdentity(read(block.value,path))===canonical)return false;return edit(row=>{navSet(row,path,canonical);});}
function previewImage(path:CommercePath){void leaseTick.value;if(!editable()||!block.value||!mediaPathAllowed(path))return '';const raw=read(block.value,path);return commercePreviewUrl(raw,previews.value[imageIdentity(raw)]);}
function renewLeases(next:Record<string,string>){previews.value=next;clearTimeout(leaseTimer);leaseTick.value++;const expires=Object.values(next).flatMap(url=>{const match=/[?&]expires=(\d+)/u.exec(url);return match?[Number(match[1])*1000]:[];});if(expires.length)leaseTimer=setTimeout(()=>{const retained=Object.fromEntries(Object.entries(previews.value).filter(([,url])=>!!commercePreviewUrl(url,url)));renewLeases(retained);},Math.min(2147483647,Math.max(1,Math.min(...expires)-Date.now()+1)));}
function mediaSession(path:CommercePath){const issued=stamp(),owner=actor(),editor=props.editorKey,index=selected.value;return{key:`${props.editorKey}:${revision.value}:${index}:${JSON.stringify(path)}`,choose:async(reference:string,signed:string)=>{if(!current(issued)||!canChooseMedia.value||!mediaPathAllowed(path))return;const approved=commercePreviewUrl(reference,signed);if(!approved)return;const canonical=imageIdentity(reference);if(imageIdentity(read(block.value,path))===canonical){renewLeases({...previews.value,[canonical]:approved});return;}if(!setImage(path,reference))return;const expected=lastCommitted,own=pendingOwnEcho;await nextTick();if(own&&pendingOwnEcho===own&&own.echo&&ownEchoCurrent(own)&&alive&&editable()&&canChooseMedia.value&&actor()===owner&&props.editorKey===editor&&selected.value===index&&props.modelValue===expected&&mediaPathAllowed(path)&&imageIdentity(read(block.value,path))===canonical&&commercePreviewUrl(reference,approved))renewLeases({...previews.value,[canonical]:approved});}};}
const previewBlock=computed(()=>{const copy=structuredClone(block.value??{});for(const path of commerceMediaPaths(copy))navSet(copy,path,previewImage(path));return copy;});
async function loadSavedMedia(){if(!editable()||!block.value||!props.pageId||!props.pagePublished)return;mediaAbort?.abort();const issued=stamp(),id=props.pageId,expected=JSON.stringify(canonicalCommerceBlock(block.value,true)),paths=commerceMediaPaths(block.value),controller=new AbortController();mediaAbort=controller;mediaLoading.value=true;renewLeases({});error.value='';try{const response=await fetch(`/api/diy/get_diy/${id}`,{method:'GET',credentials:'omit',cache:'no-store',signal:controller.signal}),body=record(await response.json()),data=record(body?.data);if(!current(issued)||props.pageId!==id||!props.pagePublished||controller.signal.aborted)return;if(!response.ok||body?.status!==200||!Array.isArray(data?.value))throw Error('公开商城图片暂不可用');const found=data.value.map(record).find(row=>row&&JSON.stringify(canonicalCommerceBlock(row,true))===expected);if(!found)throw Error('当前组件与已发布内容不同，请保存后再读取');const next:Record<string,string>={};for(const path of paths){const raw=read(block.value,path),approved=commercePreviewUrl(raw,read(found,path));if(approved)next[imageIdentity(raw)]=approved;}renewLeases(next);}catch(reason){if(current(issued)&&mediaAbort===controller&&!controller.signal.aborted)error.value=reason instanceof Error?reason.message:'组件图片预览失败';}finally{if(mediaAbort===controller){mediaAbort=null;mediaLoading.value=false;}}}

</script>
<style scoped>
.commerce-author-editor{width:100%;min-width:0}.hint{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary);margin:6px 0 10px}.toolbar,.selection-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:10px 0}.stored{overflow-wrap:anywhere;min-width:0}.image-slot{width:100%;display:flex;align-items:center;gap:8px;flex-wrap:wrap}.image-slot img{width:90px;height:50px;object-fit:contain}.commerce-author-editor :deep(.el-select){width:100%;max-width:100%}.commerce-author-editor :deep(.el-form){min-width:0}
</style>
