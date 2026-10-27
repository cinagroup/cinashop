<template>
  <section class="right-editor" :data-editor-key="editorKey">
    <div class="editor-tabs" role="tablist" aria-label="权益介绍编辑方式">
      <el-button :type="mode==='visual'?'primary':'default'" :disabled="disabled" @click="changeMode('visual')">可视编辑</el-button>
      <el-button :type="mode==='html'?'primary':'default'" :disabled="disabled" @click="changeMode('html')">HTML 源码</el-button>
      <el-button :type="mode==='preview'?'primary':'default'" :disabled="disabled" @click="changeMode('preview')">预览</el-button>
    </div>
    <div v-if="mode==='visual'" class="editor-toolbar" aria-label="文字格式">
      <el-button v-for="item in formats" :key="item.command" :disabled="disabled" @mousedown.prevent @click="format(item.command)">{{item.label}}</el-button>
      <label>字号<select aria-label="字号" :disabled="disabled" @change="changeFontSize($event)"><option value="3">正文</option><option value="2">小</option><option value="5">大</option><option value="7">特大</option></select></label>
      <label>文字颜色<input aria-label="文字颜色" type="color" :disabled="disabled" @input="changeColor($event)" /></label>
      <SeckillActivityImagePicker :disabled="disabled" :editor-key="editorKey" title="插入权益介绍图片" @choose="chooseImage" />
    </div>
    <p v-if="notice" class="editor-notice" role="status">{{notice}}</p>
    <div v-show="mode==='visual'" ref="editable" class="editable" :contenteditable="!disabled" role="textbox" aria-label="权益介绍正文" aria-multiline="true" @input="inputVisual" @paste="paste" @drop.prevent @keyup="rememberSelection" @mouseup="rememberSelection" />
    <el-input v-if="mode==='html'" :model-value="modelValue" type="textarea" :rows="14" :disabled="disabled" aria-label="权益介绍HTML源码" @update:model-value="inputHtml" />
    <div v-if="mode==='preview'" class="editor-preview" v-html="previewHtml" />
    <p class="editor-hint">展示名称与简要说明在“编辑”中修改；这里仅保存权益介绍。</p>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import SeckillActivityImagePicker from '@/pages/activity/SeckillActivityImagePicker.vue';
import { canonicalDiyPresentationReference, canonicalizeDiyPresentationHtml, diyPresentationHtmlMediaReferences, mapDiyPresentationHtmlMedia, sanitizeDiyPresentationHtml } from '../../../../common/diyPresentationHtml';
import { memberRightImage, memberRightPreviewHtml, memberRightMediaDeadline, memberRightResolvedMedia } from '../../../../common/memberRightMedia';
const props=defineProps<{modelValue:string;preview:string;disabled:boolean;editorKey:string}>();
const emit=defineEmits<{'update:modelValue':[value:string]}>();
const editable=ref<HTMLElement>(),mode=ref<'visual'|'html'|'preview'>('visual'),notice=ref(''),clock=ref(0);
const formats=[{command:'bold',label:'加粗'},{command:'italic',label:'斜体'},{command:'underline',label:'下划线'},{command:'justifyLeft',label:'左对齐'},{command:'justifyCenter',label:'居中'},{command:'insertUnorderedList',label:'列表'},{command:'removeFormat',label:'清除格式'}];
let alive=true,selection:Range|undefined,timer:ReturnType<typeof setTimeout>|undefined;
const leases=new Map<string,string>();
function hydrateLeases(){leases.clear();for(const media of diyPresentationHtmlMediaReferences(props.preview)){const safe=memberRightResolvedMedia(media.value);if(safe)leases.set(canonicalDiyPresentationReference(media.value),safe);}}
function display(value:string){void clock.value;return memberRightPreviewHtml(mapDiyPresentationHtmlMedia(value,ref=>{const key=canonicalDiyPresentationReference(ref);return key.startsWith('/api/assets/')?leases.get(key)??'':ref;}));}
const previewHtml=computed(()=>display(props.modelValue));
function schedule(){clearTimeout(timer);timer=undefined;const deadlines=[...leases.values()].map(value=>memberRightMediaDeadline([value],[])).filter((at):at is number=>at!==null&&at>Date.now());const at=deadlines.length?Math.min(...deadlines):null;if(at!==null)timer=setTimeout(()=>{clock.value++;notice.value='部分图片预览已过期，请关闭介绍后重新读取权益';if(editable.value)editable.value.innerHTML=display(props.modelValue);schedule();},Math.min(2147483647,Math.max(1,at-Date.now()+1)));}
function render(){selection=undefined;if(editable.value)editable.value.innerHTML=display(props.modelValue);}
function rememberSelection(){if(props.disabled||!editable.value)return;const range=window.getSelection()?.rangeCount?window.getSelection()!.getRangeAt(0):undefined;if(range&&editable.value.contains(range.commonAncestorContainer))selection=range.cloneRange();}
function restore(){if(!editable.value)return;editable.value.focus();if(selection&&editable.value.contains(selection.commonAncestorContainer)){const active=window.getSelection();active?.removeAllRanges();active?.addRange(selection);}}
function source(value:string){return canonicalizeDiyPresentationHtml(sanitizeDiyPresentationHtml(value));}
function inputVisual(){if(props.disabled||!alive||!editable.value)return;try{emit('update:modelValue',source(editable.value.innerHTML));notice.value='';rememberSelection();}catch(reason){notice.value=reason instanceof Error?reason.message:'内容无法解析';}}
function inputHtml(value:string|number){if(props.disabled||!alive||typeof value!=='string')return;try{const canonical=canonicalizeDiyPresentationHtml(value);emit('update:modelValue',canonical);notice.value='';}catch(reason){notice.value=reason instanceof Error?reason.message:'内容无法解析';}}
function format(command:string,value?:string){if(props.disabled||!alive||mode.value!=='visual')return;restore();document.execCommand('styleWithCSS',false,'true');document.execCommand(command,false,value);inputVisual();}
function changeFontSize(event:Event){format('fontSize',(event.target as HTMLSelectElement).value);}
function changeColor(event:Event){format('foreColor',(event.target as HTMLInputElement).value);}
function paste(event:ClipboardEvent){event.preventDefault();if(props.disabled||!alive)return;restore();const clipboard=event.clipboardData;try{const html=clipboard?.getData('text/html');if(html)document.execCommand('insertHTML',false,display(source(html)));else document.execCommand('insertText',false,clipboard?.getData('text/plain')??'');inputVisual();}catch(reason){notice.value=reason instanceof Error?reason.message:'粘贴内容无法解析';}}
const chooseImage=computed(()=>{const key=props.editorKey;return(reference:string,preview:string)=>{if(props.disabled||!alive||key!==props.editorKey||!memberRightImage(reference,preview))return;leases.set(reference,preview);restore();const image=document.createElement('img');image.src=preview;image.alt='权益介绍图片';document.execCommand('insertHTML',false,image.outerHTML);inputVisual();schedule();};});
async function changeMode(value:'visual'|'html'|'preview'){if(props.disabled)return;mode.value=value;await nextTick();if(value==='visual')render();}
watch(()=>props.editorKey,()=>{mode.value='visual';notice.value='';hydrateLeases();schedule();void nextTick(render);});
// Busy/conflict disables authoring but keeps the same owner's safe draft copyable.
// Parent owner reset closes/unmounts this keyed editor; unmount erases its DOM.
watch(()=>props.disabled,()=>{selection=undefined;if(!props.disabled){hydrateLeases();schedule();}void nextTick(render);},{flush:'sync'});
watch(()=>props.modelValue,()=>{if(mode.value!=='visual'||typeof document==='undefined'||document.activeElement!==editable.value)void nextTick(render);});
onMounted(()=>{hydrateLeases();schedule();render();});onBeforeUnmount(()=>{alive=false;selection=undefined;leases.clear();clearTimeout(timer);if(editable.value)editable.value.innerHTML='';});
</script>
<style scoped>
.right-editor{border:1px solid #dcdee2;border-radius:4px;background:#fff}.editor-tabs,.editor-toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:10px;border-bottom:1px solid #eee}.editor-toolbar :deep(.el-button){margin:0}.editor-toolbar label{display:flex;align-items:center;gap:5px;font-size:12px;color:#515a6e}.editor-toolbar input[type=color]{width:32px;height:28px;padding:0;border:1px solid #ddd}.editable,.editor-preview{min-height:320px;max-height:52vh;overflow:auto;padding:18px;outline:none;color:#333;font-size:14px;line-height:1.7;overflow-wrap:anywhere}.editable:focus{box-shadow:inset 0 0 0 1px #2d8cf0}.editable :deep(img),.editor-preview :deep(img){max-width:100%;height:auto}.editor-hint,.editor-notice{margin:10px 14px;font-size:12px;line-height:1.5;color:#808695}.editor-notice{color:#a56715}.right-editor :deep(textarea){font-family:Consolas,monospace}
</style>
