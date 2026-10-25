<template>
<section class="community-author-editor" aria-label="社区组件作者编辑器">
<h3>种草社区</h3><p class="hint">切换风格保留已有配置，保存页面后生效。</p>
<el-alert v-if="parsed.error" :title="parsed.error" type="warning" :closable="false" />
<template v-else-if="document">
<div class="toolbar"><el-select v-model="addKind" aria-label="新增社区组件类型" :disabled="!canEdit"><el-option v-for="name in names" :key="name" :label="labels[name]" :value="name" /></el-select><el-button :disabled="!canEdit" @click="add()">添加社区组件</el-button></div>
<template v-if="entries.length"><el-select :model-value="selected" aria-label="选择社区组件" @update:model-value="select"><el-option v-for="entry in entries" :key="entry.index" :value="entry.index" :label="`第 ${entry.index+1} 项 · ${labels[entry.kind]}`" /></el-select>
<div class="toolbar"><el-button :disabled="!canEdit" @click="move(-1)">上移社区组件</el-button><el-button :disabled="!canEdit" @click="move(1)">下移社区组件</el-button><el-button :disabled="!canEdit" @click="add(true)">复制社区组件</el-button><el-button type="danger" :disabled="!canEdit" @click="remove">删除当前社区组件</el-button></div>
<template v-if="block&&kind"><el-form label-position="top" :disabled="!canEdit">
<el-form-item label="社区组件显示"><el-select :model-value="!flag(block.isHide)" @update:model-value="visible"><el-option label="显示" :value="true" /><el-option label="隐藏并保留配置" :value="false" /></el-select></el-form-item>
<el-form-item label="社区编辑面板"><el-radio-group :model-value="number(read(block,['setUp','tabVal']))" @update:model-value="setLeaf(['setUp','tabVal'],$event)"><el-radio-button :value="0">内容设置</el-radio-button><el-radio-button :value="1">样式设置</el-radio-button></el-radio-group></el-form-item>
<DiyCommunityFields :block="block" @change="setLeaf">
<template #image="slot"><div class="image-slot"><img v-if="previewImage(slot.path)" :src="previewImage(slot.path)" alt="社区作者图片" /><span class="stored">{{text(read(block,slot.path))||'未选择图片'}}</span><SeckillActivityImagePicker :disabled="!canChooseMedia" :editor-key="mediaSession(slot.path).key" :title="`选择${slot.field.label}`" @choose="mediaSession(slot.path).choose" /><el-button :disabled="!canEdit" @click="setImage(slot.path,'')">清空图片</el-button></div></template>
<template #topic="slot"><el-button :disabled="!canReadTopics||topicsLoading" :loading="topicsLoading" @click="loadTopics">读取可用社区话题</el-button><el-select :model-value="text(read(block,slot.path))" aria-label="社区话题" :disabled="!canEdit" @update:model-value="chooseTopic"><el-option label="未选择话题" value="" /><el-option v-if="topicValue&&!topics.some(row=>String(row.id)===topicValue)" :label="`保留已存话题 ${topicValue}`" :value="topicValue" /><el-option v-for="row in topics" :key="row.id" :label="row.name" :value="String(row.id)" /></el-select><p class="hint">保留原版话题配置；用户端展示公开社区列表。</p></template>
</DiyCommunityFields></el-form>
<el-alert v-if="error" :title="error" type="error" :closable="false" />
<div class="toolbar"><el-button :disabled="!canEdit||!pageId||!pagePublished||mediaLoading" :loading="mediaLoading" @click="loadSavedMedia">读取已发布社区图片预览</el-button><el-button :disabled="!canEdit||previewLoading" :loading="previewLoading" @click="loadContent">读取公开社区预览</el-button></div>
<DiyCommunityPreview :block="previewBlock" :data="previewData" :loading="previewLoading" :loaded="previewLoaded" :error="error" />
</template></template><p v-else class="hint">此页面暂无社区组件。</p></template>
</section>
</template>
<script setup lang="ts">

import { computed,nextTick,onBeforeUnmount,ref,watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getToken } from '@/utils/auth';
import SeckillActivityImagePicker from '@/pages/activity/SeckillActivityImagePicker.vue';
import DiyCommunityFields from './DiyCommunityFields.vue';
import DiyCommunityPreview from './DiyCommunityPreview.vue';
import { COMMUNITY_NAMES as names,communityLabels as labels,communityKind,communityEntries,communityDocument,communityRecord as record,communityRead as read,addCommunityBlock,moveCommunityBlock,communityImageIdentity as imageIdentity,communityMediaPaths,canonicalCommunityBlock,communityPreviewUrl,communityFieldPatch,type CommunityKind,type CommunityPath,type CommunityRecord } from '@/utils/diyCommunityEditor';
import { navFlag as flag,navText as text,navSet } from '@/utils/diyNavigationEditor';
import { listRawNumber as number } from '@/utils/diyListEditor';
import { normalizeDiyCommunity } from '@/utils/diyCommunityProjection';
import { readCommunityPreview,communityPreviewDeadline,type CommunityPreview } from '@/api/diyCommunityAuthor';
import { apiCommunityAllTopics } from '@/api/community';
const props=withDefaults(defineProps<{modelValue:string;editorKey:string;disabled?:boolean;pageId?:number;pagePublished?:boolean}>(),{disabled:false,pageId:0,pagePublished:false}),emit=defineEmits<{'update:modelValue':[value:string]}>(),auth=useAuthStore();
const selected=ref(-1),addKind=ref<CommunityKind>('community'),revision=ref(0),error=ref(''),previews=ref<Record<string,string>>({}),mediaLoading=ref(false),leaseTick=ref(0);
let alive=true,lastCommitted='',mediaAbort:AbortController|null=null,leaseTimer:ReturnType<typeof setTimeout>|undefined;
type OwnEcho={beforeRaw:string;expectedRaw:string;owner:string;editor:string;index:number;disabled:boolean;pageId:number;pagePublished:boolean;leases:Record<string,string>;echo:boolean};
let pendingOwnEcho:OwnEcho|null=null;
function ownEchoCurrent(own:OwnEcho){return editable()&&own.owner===actor()&&own.editor===props.editorKey&&own.index===selected.value&&own.disabled===props.disabled&&own.pageId===props.pageId&&own.pagePublished===props.pagePublished&&own.expectedRaw===props.modelValue;}
const actor=()=>`${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}:${getToken()}:${localStorage.getItem('admin_session')}`;
function editable(){return alive&&!props.disabled&&!!auth.token&&auth.token===getToken()&&!!auth.userInfo&&(auth.userInfo.level===0||auth.uniqueAuth.includes('dise.manage'));}
const canReadTopics=computed(()=>canEdit.value&&!!auth.userInfo&&(auth.userInfo.level===0||auth.uniqueAuth.includes('community.view')));
const canEdit=computed(()=>{void revision.value;return editable();}),canChooseMedia=computed(()=>canEdit.value&&!!auth.userInfo&&(auth.userInfo.level===0||auth.uniqueAuth.includes('attachment.view')));
const parsed=computed(()=>{try{return{value:communityDocument(props.modelValue),error:''};}catch(reason){return{value:null,error:reason instanceof Error?reason.message:'装修 JSON 无效'};}}),document=computed(()=>parsed.value.value),entries=computed(()=>communityEntries(document.value??[])),block=computed(()=>record(document.value?.[selected.value])),kind=computed(()=>communityKind(block.value?.name));

const previewData=ref<CommunityPreview|null>(null),previewLoading=ref(false),previewLoaded=ref(false);
const topics=ref<Array<{id:number;name:string}>>([]),topicsLoading=ref(false),topicValue=computed(()=>text(read(block.value,['selectConfig','activeValue'])));
let previewAbort:AbortController|null=null,contentTimer:ReturnType<typeof setTimeout>|undefined,topicGeneration=0;
async function loadTopics(){
 if(!canReadTopics.value)return;const issued=stamp(),generation=++topicGeneration;topicsLoading.value=true;topics.value=[];error.value='';
 try{const result=await apiCommunityAllTopics();if(!current(issued)||generation!==topicGeneration)return;const seen=new Set<number>();if(!Array.isArray(result)||result.length>1000||result.some(row=>!row||!Number.isSafeInteger(row.id)||row.id<=0||row.id>2147483647||seen.has(row.id)||!seen.add(row.id)||typeof row.name!=='string'||!row.name||row.name.length>512))throw Error('社区话题目录格式错误');topics.value=result.map(({id,name})=>({id,name}));}
 catch(reason){if(current(issued)&&generation===topicGeneration)error.value=reason instanceof Error?reason.message:'社区话题读取失败';}finally{if(generation===topicGeneration)topicsLoading.value=false;}
}
function chooseTopic(value:unknown){if(typeof value!=='string'||value!==''&&!topics.value.some(row=>String(row.id)===value))return;setLeaf(['selectConfig','activeValue'],value);}
async function loadContent(){
 if(!editable()||!block.value)return;previewAbort?.abort();const issued=stamp(),controller=new AbortController();previewAbort=controller;previewLoading.value=true;previewLoaded.value=false;previewData.value=null;error.value='';
 try{const result=await readCommunityPreview(normalizeDiyCommunity(block.value).limit,controller.signal);if(!current(issued)||previewAbort!==controller||controller.signal.aborted)return;previewData.value=result;previewLoaded.value=true;
 const deadline=communityPreviewDeadline(result);clearTimeout(contentTimer);if(Number.isFinite(deadline))contentTimer=setTimeout(()=>{if(current(issued)){previewData.value=null;previewLoaded.value=false;error.value='公开素材预览已过期，请重新读取';}},Math.min(2147483647,Math.max(1,deadline-Date.now()+1)));
 }catch(reason){if(current(issued)&&previewAbort===controller&&!controller.signal.aborted)error.value=reason instanceof Error?reason.message:'社区预览读取失败';}finally{if(previewAbort===controller){previewAbort=null;previewLoading.value=false;}}
}
function stamp(){return{revision:revision.value,actor:actor(),editor:props.editorKey,index:selected.value,raw:props.modelValue};}
function current(s:ReturnType<typeof stamp>){return editable()&&s.revision===revision.value&&s.actor===actor()&&s.editor===props.editorKey&&s.index===selected.value&&s.raw===props.modelValue;}
function invalidate(preserveOwnEcho:unknown=false){if(preserveOwnEcho!==true)pendingOwnEcho=null;revision.value++;topicGeneration++;topics.value=[];topicsLoading.value=false;error.value='';mediaAbort?.abort();mediaAbort=null;mediaLoading.value=false;previewAbort?.abort();previewAbort=null;previewLoading.value=false;previewLoaded.value=false;previewData.value=null;clearTimeout(contentTimer);previews.value={};clearTimeout(leaseTimer);leaseTimer=undefined;leaseTick.value++;}
watch(entries,()=>{if(!entries.value.some(row=>row.index===selected.value))selected.value=entries.value[0]?.index??-1;},{immediate:true});
watch(selected,()=>{invalidate();},{flush:'sync'});
watch(()=>[props.modelValue,props.editorKey,props.disabled,props.pageId,props.pagePublished,actor()],(next,previous)=>{
  const own=pendingOwnEcho,echo=!!own&&!own.echo&&!!previous&&previous[0]===own.beforeRaw&&next[0]===own.expectedRaw&&next.slice(1).every((value,index)=>value===previous[index+1])&&ownEchoCurrent(own);
  invalidate(echo);if(echo&&own)own.echo=true;
},{flush:'sync'});
window.addEventListener('admin-session-changed',invalidate);window.addEventListener('admin-auth-expired',invalidate);window.addEventListener('storage',invalidate);
onBeforeUnmount(()=>{alive=false;invalidate();window.removeEventListener('admin-session-changed',invalidate);window.removeEventListener('admin-auth-expired',invalidate);window.removeEventListener('storage',invalidate);});
function commit(value:unknown[]){if(!editable())return false;try{
  const raw=JSON.stringify(value,null,2);communityDocument(raw);
  const own:OwnEcho={beforeRaw:props.modelValue,expectedRaw:raw,owner:actor(),editor:props.editorKey,index:selected.value,disabled:props.disabled,pageId:props.pageId,pagePublished:props.pagePublished,leases:{...previews.value},echo:false};
  invalidate();pendingOwnEcho=own;lastCommitted=raw;emit('update:modelValue',raw);
  void nextTick(()=>{
    if(pendingOwnEcho!==own)return;
    if(!own.echo||!ownEchoCurrent(own)){pendingOwnEcho=null;return;}
    const next:Record<string,string>={};
    if(block.value)for(const path of communityMediaPaths(block.value)){const raw=read(block.value,path),identity=imageIdentity(raw),lease=own.leases[identity];if(lease&&communityPreviewUrl(raw,lease))next[identity]=lease;}
    renewLeases(next);
  });return true;
}catch(reason){error.value=reason instanceof Error?reason.message:'无法完整保存';return false;}}
function edit(change:(row:CommunityRecord)=>boolean|void){if(!editable()||!document.value||!block.value||!kind.value)return false;try{const value=structuredClone(document.value),row=record(value[selected.value]);if(!row||change(row)===false)return false;return commit(value);}catch(reason){error.value=reason instanceof Error?reason.message:'当前字段无法修改';return false;}}
function setLeaf(path:CommunityPath,value:unknown){if(read(block.value,path)===value)return false;return edit(row=>communityFieldPatch(row,path,value));}
function select(value:unknown){if(typeof value==='number'&&entries.value.some(entry=>entry.index===value)){invalidate();selected.value=value;}}
function add(duplicate=false){if(!editable()||!document.value)return;try{const k=duplicate?kind.value:addKind.value;if(!k)return;const result=addCommunityBlock(document.value,k,duplicate&&block.value?block.value:undefined);if(commit(result.value))selected.value=result.selected;}catch(reason){error.value=reason instanceof Error?reason.message:'无法添加组件';}}
function remove(){if(!document.value||!kind.value)return;const value=structuredClone(document.value);value.splice(selected.value,1);if(commit(value))selected.value=-1;}
function move(direction:-1|1){if(!document.value)return;try{const result=moveCommunityBlock(document.value,selected.value,direction);if(commit(result.value))selected.value=result.selected;}catch(reason){error.value=reason instanceof Error?reason.message:'不能移动组件';}}
function visible(value:unknown){if(typeof value==='boolean'&&flag(block.value?.isHide)!==!value)setLeaf(['isHide'],!value);}
function mediaPathAllowed(path:CommunityPath){return !!block.value&&communityMediaPaths(block.value).some(p=>JSON.stringify(p)===JSON.stringify(path));}
function setImage(path:CommunityPath,value:string){if(!mediaPathAllowed(path))return false;const canonical=imageIdentity(value);if(canonical&&!(canonical.startsWith('https://')||/^\/(?!\/)/u.test(canonical))||/[\u0000-\u0020\u007f\\]/u.test(canonical))return false;if(imageIdentity(read(block.value,path))===canonical)return false;return edit(row=>{navSet(row,path,canonical);});}
function previewImage(path:CommunityPath){void leaseTick.value;if(!editable()||!block.value||!mediaPathAllowed(path))return '';const raw=read(block.value,path);return communityPreviewUrl(raw,previews.value[imageIdentity(raw)]);}
function renewLeases(next:Record<string,string>){previews.value=next;clearTimeout(leaseTimer);leaseTick.value++;const expires=Object.values(next).flatMap(url=>{const match=/[?&]expires=(\d+)/u.exec(url);return match?[Number(match[1])*1000]:[];});if(expires.length)leaseTimer=setTimeout(()=>{const retained=Object.fromEntries(Object.entries(previews.value).filter(([,url])=>!!communityPreviewUrl(url,url)));renewLeases(retained);},Math.min(2147483647,Math.max(1,Math.min(...expires)-Date.now()+1)));}
function mediaSession(path:CommunityPath){const issued=stamp(),owner=actor(),editor=props.editorKey,index=selected.value;return{key:`${props.editorKey}:${revision.value}:${index}:${JSON.stringify(path)}`,choose:async(reference:string,signed:string)=>{if(!current(issued)||!canChooseMedia.value||!mediaPathAllowed(path))return;const approved=communityPreviewUrl(reference,signed);if(!approved)return;const canonical=imageIdentity(reference);if(imageIdentity(read(block.value,path))===canonical){renewLeases({...previews.value,[canonical]:approved});return;}if(!setImage(path,reference))return;const expected=lastCommitted,own=pendingOwnEcho;await nextTick();if(own&&pendingOwnEcho===own&&own.echo&&ownEchoCurrent(own)&&alive&&editable()&&canChooseMedia.value&&actor()===owner&&props.editorKey===editor&&selected.value===index&&props.modelValue===expected&&mediaPathAllowed(path)&&imageIdentity(read(block.value,path))===canonical&&communityPreviewUrl(reference,approved))renewLeases({...previews.value,[canonical]:approved});}};}
const previewBlock=computed(()=>{const copy=structuredClone(block.value??{});for(const path of communityMediaPaths(copy))navSet(copy,path,previewImage(path));return copy;});
async function loadSavedMedia(){if(!editable()||!block.value||!props.pageId||!props.pagePublished)return;mediaAbort?.abort();const issued=stamp(),id=props.pageId,expected=JSON.stringify(canonicalCommunityBlock(block.value,true)),paths=communityMediaPaths(block.value),controller=new AbortController();mediaAbort=controller;mediaLoading.value=true;renewLeases({});error.value='';try{const response=await fetch(`/api/diy/get_diy/${id}`,{method:'GET',credentials:'omit',cache:'no-store',signal:controller.signal}),body=record(await response.json()),data=record(body?.data);if(!current(issued)||props.pageId!==id||!props.pagePublished||controller.signal.aborted)return;if(!response.ok||body?.status!==200||!Array.isArray(data?.value))throw Error('公开社区图片暂不可用');const found=data.value.map(record).find(row=>row&&JSON.stringify(canonicalCommunityBlock(row,true))===expected);if(!found)throw Error('当前组件与已发布内容不同，请保存后再读取');const next:Record<string,string>={};for(const path of paths){const raw=read(block.value,path),approved=communityPreviewUrl(raw,read(found,path));if(approved)next[imageIdentity(raw)]=approved;}renewLeases(next);}catch(reason){if(current(issued)&&mediaAbort===controller&&!controller.signal.aborted)error.value=reason instanceof Error?reason.message:'组件图片预览失败';}finally{if(mediaAbort===controller){mediaAbort=null;mediaLoading.value=false;}}}

</script>
<style scoped>
.community-author-editor{width:100%;min-width:0}.hint{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary);margin:6px 0 10px}.toolbar,.selection-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:10px 0}.stored{overflow-wrap:anywhere;min-width:0}.image-slot{width:100%;display:flex;align-items:center;gap:8px;flex-wrap:wrap}.image-slot img{width:90px;height:50px;object-fit:contain}.community-author-editor :deep(.el-select){width:100%;max-width:100%}.community-author-editor :deep(.el-form){min-width:0}
</style>
