<template>
  <section class="promotion-editor" aria-label="商品选项卡作者编辑器">
    <strong>商品选项卡</strong><p class="hint">配置与装修 JSON 同步，保存页面后生效。切换来源保留原选择，导入的隐藏字段、超量项与未知资料完整保留。</p>
    <el-alert v-if="parsed.error" :title="parsed.error" type="warning" :closable="false" />
    <template v-else>
      <div class="toolbar"><el-button :disabled="!canEdit" @click="formSession.add">添加商品选项卡组件</el-button></div>
      <template v-if="entries.length">
        <el-select :model-value="selected" aria-label="选择商品选项卡组件" @update:model-value="formSession.select"><el-option v-for="entry in entries" :key="entry.index" :value="entry.index" :label="`第 ${entry.index+1} 项 · 商品选项卡`" /></el-select>
        <div class="toolbar"><el-button :disabled="!canEdit" @click="formSession.moveUp">上移商品选项卡组件</el-button><el-button :disabled="!canEdit" @click="formSession.moveDown">下移商品选项卡组件</el-button><el-button :disabled="!canEdit" type="danger" @click="formSession.remove">删除商品选项卡组件</el-button></div>
        <template v-if="block">
          <el-form :key="contextEpoch" label-position="top" :disabled="!canEdit">
            <div class="fields">
              <el-form-item label="商品选项卡显示"><el-switch :model-value="!flag(block.isHide)" @update:model-value="formSession.setVisible" /></el-form-item>
              <el-form-item label="选项卡编辑分组"><el-select :model-value="number(read(block,['setUp','tabVal']))" @update:model-value="formSession.enums.setUp"><el-option label="内容" :value="0" /><el-option label="样式" :value="1" /></el-select></el-form-item>
              <el-form-item label="选项卡风格"><el-select :model-value="view.style" @update:model-value="formSession.setStyle"><el-option v-for="(label,index) in ['标题与简介','下划线','弧线','胶囊','图片与标题']" :key="index" :value="index" :label="label" /></el-select></el-form-item>
              <el-form-item label="选项卡滑动置顶"><el-select :model-value="view.sticky?0:1" @update:model-value="formSession.enums.slideConfig"><el-option label="启用" :value="0" /><el-option label="不启用" :value="1" /></el-select></el-form-item>
            </div>
            <h4>选项卡内容</h4>
            <p class="hint">公开页消费前12项，所有选项卡仍可编辑、添加和保存。新增项使用完整默认，不复制上一项的商品、品牌或图片。</p>
            <el-select v-if="tabs.length" :model-value="tabIndex" aria-label="选择编辑选项卡" @update:model-value="formSession.selectTab"><el-option v-for="(row,index) in tabs" :key="index" :value="index" :label="`${index+1} · ${tabTitle(row)}`" /></el-select>
            <div class="toolbar"><el-button :disabled="!canEdit" @click="formSession.addTab">添加选项卡</el-button><el-button :disabled="!canEdit || tabIndex<=0" @click="formSession.tabUp">上移选项卡</el-button><el-button :disabled="!canEdit || tabIndex<0 || tabIndex>=tabs.length-1" @click="formSession.tabDown">下移选项卡</el-button><el-button :disabled="!canEdit || tabIndex<0" @click="formSession.removeTab">删除选项卡</el-button></div>
            <template v-if="tab">
              <div class="fields">
                <el-form-item label="选项卡标题"><el-input :model-value="text(read(tab,['chiild',0,'val']))" :maxlength="Math.max(4,text(read(tab,['chiild',0,'val'])).length)" aria-label="选项卡标题" @update:model-value="formSession.texts[0]" /></el-form-item>
                <el-form-item label="选项卡简介"><el-input :model-value="text(read(tab,['chiild',1,'val']))" :maxlength="Math.max(4,text(read(tab,['chiild',1,'val'])).length)" aria-label="选项卡简介" @update:model-value="formSession.texts[1]" /></el-form-item>
                <el-form-item label="选项卡商品来源"><el-select :model-value="number(tab.tabVal)" @update:model-value="formSession.setSource"><el-option v-if="number(tab.tabVal)===0" label="导入值0（按分类消费）" :value="0" /><el-option v-for="(label,index) in ['指定商品','指定品牌','指定分类','商品标签']" :key="index" :value="index+1" :label="label" /></el-select></el-form-item>
                <el-form-item label="分组展示数量"><el-input-number :model-value="number(read(tab,['numConfig','val']),6)" :min="Math.min(0,number(read(tab,['numConfig','val']),6))" :max="Math.max(100,number(read(tab,['numConfig','val']),6))" aria-label="分组展示数量" @update:model-value="formSession.setTabCount" /></el-form-item>
                <el-form-item label="分组商品排序"><el-select :model-value="number(tab.goodsSort)" :disabled="!canEdit || selectionKind==='product'" @update:model-value="formSession.setTabSort"><el-option label="综合" :value="0" /><el-option label="销量降序" :value="1" /><el-option label="价格降序" :value="2" /></el-select></el-form-item>
              </div>
              <p class="hint">简介仅风格一展示，图片仅风格五展示。指定商品沿用已选顺序；排序配置保留供其他来源使用。普通数量为0–100，完整导入值不会在查看或失焦时改写。</p>
              <template v-if="selectionKind">
                <DiyListSelectionPicker :kind="selectionKind" :editor-key="picker.key" :disabled="!canEdit" @choose="picker.choose" /><el-button :disabled="!canEdit" @click="formSession.clearSelection">清空当前分组范围</el-button>
                <p class="hint">已选 {{selections.length}} 项。普通新增最多100项；所有导入项仍可查看、移除和排序。目录预览图和公开商品资料不写入配置。</p>
                <el-select v-if="selections.length" :model-value="itemIndex" aria-label="选择分组已选项" @update:model-value="formSession.selectItem"><el-option v-for="(raw,index) in selections" :key="index" :value="index" :label="`${index+1} · ${selectionName(raw)}`" /></el-select>
                <div v-if="selections.length" class="toolbar"><el-button :disabled="!canEdit || itemIndex<=0" @click="formSession.itemUp">上移分组已选项</el-button><el-button :disabled="!canEdit || itemIndex>=selections.length-1" @click="formSession.itemDown">下移分组已选项</el-button><el-button :disabled="!canEdit" @click="formSession.removeItem">移除分组已选项</el-button></div>
              </template>
              <el-alert v-else title="此导入来源无效，请明确选择来源或在装修 JSON 中修复；不会读取无范围的商品。" type="warning" :closable="false" />
              <el-form-item v-if="view.style===4" label="选项卡图片"><p class="stored">{{text(tab.image)||'未选择图片'}}</p><SeckillActivityImagePicker :disabled="!canChooseMedia" :editor-key="media.key" title="选项卡图片" @choose="media.choose" /><el-button :disabled="!canEdit" @click="formSession.clearImage">清空选项卡图片</el-button></el-form-item>
            </template>
            <el-alert v-else-if="tabIndex>=0" title="此导入选项卡结构无效；可明确删除或在装修 JSON 中修复，其余配置不会丢失。" type="warning" :closable="false" />
            <h4>商品按钮与样式</h4>
            <div class="fields">
              <el-form-item v-for="field in enums" :key="field.key" :label="field.label"><el-select :model-value="number(read(block,[field.key,'tabVal']))" @update:model-value="formSession.enums[field.key]"><el-option v-for="(label,index) in field.options" :key="index" :value="index" :label="label" /></el-select></el-form-item>
              <el-form-item v-for="field in colours" :key="field.key+field.index" :label="field.label"><el-input :model-value="colour(field)" :aria-label="field.label" @update:model-value="formSession.colours[field.label]" /><el-color-picker :model-value="colour(field)" show-alpha @update:model-value="formSession.colours[field.label]" /></el-form-item>
              <el-form-item v-for="field in lengths" :key="field.key" :label="field.label+'（设计 px）'"><el-input-number :model-value="number(read(block,[field.key,'val']))" :min="0" :max="Math.max(100,number(read(block,[field.key,'val'])))" :aria-label="field.label" @update:model-value="formSession.lengths[field.key]" /></el-form-item>
              <el-form-item label="背景圆角元数据方式"><el-select :model-value="flag(read(block,['fillet','type']))?1:0" @update:model-value="formSession.setRadiusMode"><el-option label="统一圆角" :value="0" /><el-option label="独立四角" :value="1" /></el-select></el-form-item>
              <el-form-item v-for="(label,index) in flag(read(block,['fillet','type']))?['左上','右上','左下','右下']:['统一']" :key="label" :label="'背景圆角元数据'+label"><el-input-number :model-value="number(read(block,radiusPath(index)))" :min="0" :max="Math.max(100,number(read(block,radiusPath(index))))" @update:model-value="formSession.radii[index]" /></el-form-item>
            </div>
            <p class="hint">按原公开组件，风格二文字固定深色，风格四／五选中文字固定白色；textColor、textColor3、decorateColor2及背景圆角保留为元数据。商品卡片委托固定双列列表，不使用选项卡色调改变商品资料。</p>
          </el-form>
          <el-alert v-if="error" :title="error" type="warning" :closable="false" />
          <div class="toolbar"><el-button :disabled="!canEdit || !pageId || !pagePublished || mediaLoading" :loading="mediaLoading" @click="formSession.loadSavedMedia">读取已发布选项卡图片</el-button><el-button :disabled="!canEdit || !delegated || previewLoading" :loading="previewLoading" @click="formSession.loadPreview">读取当前分组公开商品</el-button></div>
          <DiyPromotionPreview :block="block" :tab-index="tabIndex" :capabilities="capabilities" :products="products" :loaded="previewLoaded" :loading="previewLoading" :error="previewError" :allowed="previewLease" />
        </template>
      </template>
      <p v-else class="hint">此页面暂无商品选项卡组件。</p>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getToken } from '@/utils/auth';
import { navRead as read, navFlag as flag, navText as text } from '@/utils/diyNavigationEditor';
import { promotionDocument, promotionRecord as record, promotionEntries, promotionTabs, promotionScope, promotionSelections, promotionStoredName, promotionSelectionId,
  addPromotionBlock, movePromotionBlock, removePromotionBlock, addPromotionTab, selectPromotionTab, movePromotionTab, removePromotionTab,
  promotionNumber as number, promotionSet, setPromotionNumber, setPromotionSource, choosePromotionSelection, clearPromotionSelection, movePromotionSelection, removePromotionSelection,
  canonicalPromotionBlock, canonicalPromotionImage, promotionImageScope, type PromotionRecord, type PromotionSelection, type PromotionImageCapability } from '@/utils/diyPromotionEditor';
import { normalizeDiyPromotionPreview, promotionPreviewProducts } from '@/utils/diyPromotionProjection';
import { listSafeColor } from '@/utils/diyListProjection';
import { canonicalPresentationReference, presentationPreviewForReference } from '@/utils/diyPresentationEditor';
import { apiDiyListProductPreview, type ListPreviewProduct } from '@/api/diyListAuthor';
import type { ListSelection } from '@/utils/diyListEditor';
import DiyListSelectionPicker from './DiyListSelectionPicker.vue';
import SeckillActivityImagePicker from '@/pages/activity/SeckillActivityImagePicker.vue';
import DiyPromotionPreview from './DiyPromotionPreview.vue';
const props=withDefaults(defineProps<{modelValue:string;editorKey:string;disabled?:boolean;pageId?:number;pagePublished?:boolean}>(),{disabled:false,pageId:0,pagePublished:false}),emit=defineEmits<{'update:modelValue':[value:string]}>(),auth=useAuthStore();
const selected=ref(-1),tabIndex=ref(-1),itemIndex=ref(0),revision=ref(0),contextEpoch=ref(0),error=ref(''),capabilities=ref<PromotionImageCapability[]>([]),mediaLoading=ref(false);
const products=ref<ListPreviewProduct[]>([]),previewLoading=ref(false),previewLoaded=ref(false),previewError=ref(''),names=ref<Record<string,string>>({});
let alive=true,lastCommitted='',pendingReceipt:null|{raw:string;id:number}=null,preserveRows=false,receiptEpoch=0,previewAbort:AbortController|null=null,mediaAbort:AbortController|null=null;
const actor=()=>`${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}:${getToken()}:${localStorage.getItem('admin_session')}`;
const editable=()=>alive&&!props.disabled&&!!auth.token&&auth.token===getToken()&&!!auth.userInfo&&(auth.userInfo.level===0||auth.uniqueAuth.includes('dise.manage'));
const canEdit=computed(()=>{void revision.value;return editable();}),canChooseMedia=computed(()=>canEdit.value&&!!auth.userInfo&&(auth.userInfo.level===0||auth.uniqueAuth.includes('attachment.view')));
const parsed=computed(()=>{try{return{value:promotionDocument(props.modelValue),error:''};}catch(reason){return{value:null,error:reason instanceof Error?reason.message:'装修 JSON 无效'};}}),document=computed(()=>parsed.value.value),entries=computed(()=>promotionEntries(document.value??[]));
const block=computed(()=>{const row=record(document.value?.[selected.value]);return row?.name==='promotionList'?row:null;}),tabs=computed(()=>promotionTabs(block.value)),tab=computed(()=>record(tabs.value[tabIndex.value])),selectionKind=computed(()=>promotionScope(tab.value)),selections=computed(()=>selectionKind.value?promotionSelections(tab.value,selectionKind.value):[]);
const view=computed(()=>normalizeDiyPromotionPreview(block.value)),delegated=computed(()=>promotionPreviewProducts(block.value,tabIndex.value));
function stamp(){return{actor:actor(),editor:props.editorKey,index:selected.value,tab:tabIndex.value,revision:revision.value,raw:props.modelValue};}
function current(issued:ReturnType<typeof stamp>){return editable()&&issued.actor===actor()&&issued.editor===props.editorKey&&issued.index===selected.value&&issued.tab===tabIndex.value&&issued.revision===revision.value&&issued.raw===props.modelValue;}
function invalidate(keepRows=false,clearNames=false){revision.value++;previewAbort?.abort();mediaAbort?.abort();previewAbort=mediaAbort=null;previewLoading.value=mediaLoading.value=false;capabilities.value=[];error.value='';if(!keepRows){products.value=[];previewLoaded.value=false;previewError.value='';}if(clearNames)names.value={};}
function invalidateContext(){receiptEpoch++;contextEpoch.value++;invalidate(false,true);}
watch(entries,()=>{if(!entries.value.some(row=>row.index===selected.value))selected.value=entries.value[0]?.index??-1;},{immediate:true});
function chooseStoredTab(resetItem=true){const configured=Number(read(block.value,['tabConfig','tabCur'])),next=Number.isInteger(configured)&&configured>=0&&configured<tabs.value.length?configured:tabs.value.length?0:-1;if(resetItem||tabIndex.value!==next)itemIndex.value=0;tabIndex.value=next;}
watch(selected,()=>{contextEpoch.value++;chooseStoredTab();},{immediate:true,flush:'sync'});
watch(()=>props.modelValue,value=>{const own=pendingReceipt?.raw===value;pendingReceipt=null;if(!own){receiptEpoch++;contextEpoch.value++;invalidate(false,true);chooseStoredTab();}else{invalidate(preserveRows);chooseStoredTab(false);}},{flush:'sync'});
watch(()=>[props.editorKey,props.disabled,props.pageId,props.pagePublished,actor()],invalidateContext,{flush:'sync'});
for(const event of ['admin-session-changed','admin-auth-expired','storage'])window.addEventListener(event,invalidateContext);
onBeforeUnmount(()=>{alive=false;invalidateContext();for(const event of ['admin-session-changed','admin-auth-expired','storage'])window.removeEventListener(event,invalidateContext);});
function commit(value:unknown[],keepRows=false){if(!editable())return false;try{const raw=JSON.stringify(value,null,2);promotionDocument(raw);receiptEpoch++;const receipt=receiptEpoch;invalidate(keepRows);lastCommitted=raw;pendingReceipt={raw,id:receipt};preserveRows=keepRows;emit('update:modelValue',raw);void nextTick(()=>{if(pendingReceipt?.id===receipt)pendingReceipt=null;});return true;}catch(reason){error.value=reason instanceof Error?reason.message:'当前内容无法完整保存';return false;}}
function edit(change:(row:PromotionRecord)=>void,keepData=true){if(!editable()||!document.value||!block.value)return false;try{const copy=structuredClone(document.value),row=record(copy[selected.value])!;change(row);if(JSON.stringify(copy)===JSON.stringify(document.value))return false;const previous=delegated.value?.config,next=promotionPreviewProducts(row,tabIndex.value)?.config;return commit(copy,keepData&&JSON.stringify(previous?.query)===JSON.stringify(next?.query)&&previous?.error===next?.error);}catch(reason){error.value=reason instanceof Error?reason.message:'当前字段无法修改';return false;}}
function setLeaf(path:Array<string|number>,value:unknown){return edit(row=>{promotionSet(row,path,value);});}
function select(value:unknown){if(typeof value==='number'&&entries.value.some(row=>row.index===value)){invalidateContext();selected.value=value;}}
function add(){if(!editable()||!document.value)return;try{const result=addPromotionBlock(document.value);if(commit(result.value)){selected.value=result.selected;chooseStoredTab();}}catch(reason){error.value=reason instanceof Error?reason.message:'无法添加组件';}}
function move(direction:-1|1){if(!editable()||!document.value)return;try{const result=movePromotionBlock(document.value,selected.value,direction);if(commit(result.value))selected.value=result.selected;}catch(reason){error.value=reason instanceof Error?reason.message:'无法移动组件';}}
function remove(){if(!editable()||!document.value)return;try{const result=removePromotionBlock(document.value,selected.value);if(commit(result.value))selected.value=result.selected;}catch(reason){error.value=reason instanceof Error?reason.message:'无法删除组件';}}
function setVisible(value:unknown){if(typeof value==='boolean'&&flag(block.value?.isHide)!==!value)setLeaf(['isHide'],!value);}
function tabTitle(value:unknown){return text(read(value,['chiild',0,'val']))||'未命名／导入项';}
function selectTab(value:unknown){if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>=tabs.value.length||value===tabIndex.value)return;invalidateContext();if(record(tabs.value[value]))edit(row=>{selectPromotionTab(row,value);},false);tabIndex.value=value;itemIndex.value=0;}
function addTab(){let index=-1;if(edit(row=>{index=addPromotionTab(row);},false)){contextEpoch.value++;tabIndex.value=index;itemIndex.value=0;}}
function moveTab(direction:-1|1){let index=tabIndex.value;if(edit(row=>{index=movePromotionTab(row,tabIndex.value,direction);},false)){contextEpoch.value++;tabIndex.value=index;itemIndex.value=0;}}
function removeTab(){let index=-1;if(edit(row=>{index=removePromotionTab(row,tabIndex.value);},false)){contextEpoch.value++;tabIndex.value=index;itemIndex.value=0;}}
function setTabText(index:number,value:unknown){if(typeof value==='string'&&value.length<=Math.max(4,text(read(tab.value,['chiild',index,'val'])).length)&&!/[\u0000-\u001f\u007f]/u.test(value))setLeaf(['tabConfig','list',tabIndex.value,'chiild',index,'val'],value);}
function setSource(value:unknown){if(typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=4&&number(tab.value?.tabVal)!==value&&edit(row=>{setPromotionSource(row,tabIndex.value,value);},false))itemIndex.value=0;}
function setTabCount(value:unknown){if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Math.max(100,number(read(tab.value,['numConfig','val']),6))&&value!==number(read(tab.value,['numConfig','val']),6))edit(row=>{setPromotionNumber(row,['tabConfig','list',tabIndex.value,'numConfig','val'],value,0,Math.max(100,number(read(tab.value,['numConfig','val']),6)));});}
function setTabSort(value:unknown){if(selectionKind.value!=='product'&&typeof value==='number'&&[0,1,2].includes(value)&&value!==number(tab.value?.goodsSort))setLeaf(['tabConfig','list',tabIndex.value,'goodsSort'],value);}
const picker=computed(()=>{const issued=stamp(),expected=selectionKind.value;return{key:`${props.editorKey}:${revision.value}:${selected.value}:${tabIndex.value}:${expected}`,choose:(choice:ListSelection)=>{if(!current(issued)||!expected||choice.kind!==expected)return;if(edit(row=>{choosePromotionSelection(row,tabIndex.value,choice as PromotionSelection);})){names.value={...names.value,[`${expected}:${choice.id}`]:choice.name};}}};});
function selectionName(raw:unknown){const kind=selectionKind.value,id=promotionSelectionId(raw);return kind?(names.value[`${kind}:${id}`]??promotionStoredName(tab.value,kind,raw)):'无效来源';}
function selectItem(value:unknown){if(typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<selections.value.length)itemIndex.value=value;}
function clearSelection(){const kind=selectionKind.value;if(kind&&edit(row=>{clearPromotionSelection(row,tabIndex.value,kind);}))itemIndex.value=0;}
function moveItem(direction:-1|1){const kind=selectionKind.value;let index=itemIndex.value;if(kind&&edit(row=>{index=movePromotionSelection(row,tabIndex.value,kind,itemIndex.value,direction);}))itemIndex.value=index;}
function removeItem(){const kind=selectionKind.value;let index=-1;if(kind&&edit(row=>{index=removePromotionSelection(row,tabIndex.value,kind,itemIndex.value);}))itemIndex.value=Math.max(0,index);}
const enums=[{key:'cartConfig',label:'商品按钮显示',options:['显示','隐藏并保留配置']},{key:'bntConfig',label:'商品按钮效果',options:['进入商品详情','选择规格加入购物车']},{key:'bntStyleConfig',label:'双列商品按钮样式',options:['加号图标','购物车图标','购物车图标（导入值2）']},{key:'toneConfig',label:'选项卡色调',options:['跟随主题','自定义']},{key:'toneCartConfig',label:'商品按钮色调',options:['跟随主题','自定义']}];
function setEnum(key:string,value:unknown){const maximum=key==='bntStyleConfig'?2:1;if(['setUp','slideConfig',...enums.map(row=>row.key)].includes(key)&&typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=maximum&&number(read(block.value,[key,'tabVal']))!==value)setLeaf([key,'tabVal'],value);}
function setStyle(value:unknown){if(typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=4&&number(read(block.value,['styleConfig','tabVal']))!==value)setLeaf(['styleConfig','tabVal'],value);}
interface Colour{key:string;index:number;label:string;fallback:string}
const colours:Colour[]=[{key:'decorateColor',index:0,label:'选项卡装饰起始色',fallback:'#E93323'},{key:'decorateColor',index:1,label:'选项卡装饰结束色',fallback:'#FF7931'},{key:'decorateColor2',index:0,label:'装饰纯色元数据',fallback:'#E93323'},{key:'textColor',index:0,label:'选中文字元数据',fallback:'#333333'},{key:'textColor2',index:0,label:'选项卡强调文字颜色',fallback:'#E93323'},{key:'textColor3',index:0,label:'胶囊文字元数据',fallback:'#ffffff'},{key:'bntBgColor',index:0,label:'商品按钮起始色',fallback:'#E93323'},{key:'bntBgColor',index:1,label:'商品按钮结束色',fallback:'#FF7931'},{key:'bottomBgColor',index:0,label:'选项卡背景颜色',fallback:'#f5f5f5'}];
function colour(field:Colour){return listSafeColor(read(block.value,[field.key,'color',field.index,'item']),field.fallback);}
function setColour(field:Colour,value:unknown){if(colours.includes(field)&&typeof value==='string'&&listSafeColor(value,'')===value.trim())setLeaf([field.key,'color',field.index,'item'],value.trim());}
const lengths=[{key:'topConfig',label:'选项卡上边距'},{key:'bottomConfig',label:'选项卡下边距'},{key:'prConfig',label:'左右边距'},{key:'mbConfig',label:'页面上间距'}];
function setLength(key:string,value:unknown){if(lengths.some(field=>field.key===key)&&typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Math.max(100,number(read(block.value,[key,'val'])))&&value!==number(read(block.value,[key,'val'])))edit(row=>{setPromotionNumber(row,[key,'val'],value);});}
function radiusPath(index:number):Array<string|number>{return flag(read(block.value,['fillet','type']))?['fillet','valList',index,'val']:['fillet','val'];}
function setRadiusMode(value:unknown){if((value===0||value===1)&&flag(read(block.value,['fillet','type']))!==!!value)setLeaf(['fillet','type'],value);}
function setRadius(index:number,value:unknown){const path=radiusPath(index);if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Math.max(100,number(read(block.value,path)))&&value!==number(read(block.value,path)))edit(row=>{setPromotionNumber(row,path,value);});}
function clearImage(){setLeaf(['tabConfig','list',tabIndex.value,'image'],'');}
const media=computed(()=>{const issued=stamp();return{key:`${props.editorKey}:${revision.value}:${selected.value}:${tabIndex.value}`,choose:async(reference:string,signed:string)=>{if(!current(issued)||!canChooseMedia.value||!block.value||!tab.value)return;const approved=presentationPreviewForReference(reference,signed);if(!approved)return;let canonical:string;try{canonical=canonicalPromotionImage(reference);}catch{return;}
 if(canonicalPresentationReference(text(tab.value.image))===canonical){capabilities.value=[{...promotionImageScope(block.value,tabIndex.value),preview:approved}];return;}
 if(!setLeaf(['tabConfig','list',tabIndex.value,'image'],canonical))return;const expected=lastCommitted,page=props.pageId,published=props.pagePublished,receipt=receiptEpoch;await nextTick();
 if(editable()&&canChooseMedia.value&&receiptEpoch===receipt&&actor()===issued.actor&&props.editorKey===issued.editor&&selected.value===issued.index&&tabIndex.value===issued.tab&&props.pageId===page&&props.pagePublished===published&&props.modelValue===expected&&block.value&&canonicalPresentationReference(text(tab.value?.image))===canonical)capabilities.value=[{...promotionImageScope(block.value,tabIndex.value),preview:approved}];
}};});
async function loadSavedMedia(){if(!editable()||!block.value||!props.pageId||!props.pagePublished)return;mediaAbort?.abort();const controller=new AbortController(),issued=stamp(),id=props.pageId,expected=JSON.stringify(canonicalPromotionBlock(block.value));mediaAbort=controller;mediaLoading.value=true;capabilities.value=[];error.value='';
 try{const response=await fetch(`/api/diy/get_diy/${id}`,{method:'GET',credentials:'omit',cache:'no-store',signal:controller.signal});const body=record(await response.json()),data=record(body?.data);if(!current(issued)||controller.signal.aborted||props.pageId!==id||!props.pagePublished)return;if(!response.ok||body?.status!==200||!Array.isArray(data?.value))throw Error('公开选项卡图片暂不可用');const found=data.value.map(record).find(row=>row?.name==='promotionList'&&JSON.stringify(canonicalPromotionBlock(row))===expected);if(!found)throw Error('当前选项卡与已发布配置不同，请保存后再读取');const next:PromotionImageCapability[]=[];promotionTabs(block.value).forEach((value,index)=>{const row=record(value),remote=record(promotionTabs(found)[index]);if(!row||!remote||typeof row.image!=='string')return;const approved=presentationPreviewForReference(row.image,remote.image);if(approved)next.push({...promotionImageScope(block.value!,index),preview:approved});});capabilities.value=next;
 }catch(reason){if(current(issued)&&mediaAbort===controller&&!controller.signal.aborted)error.value=reason instanceof Error?reason.message:'选项卡图片读取失败';}finally{if(mediaAbort===controller){mediaAbort=null;mediaLoading.value=false;}}}
const previewLease=computed(()=>{const issued=stamp();return()=>current(issued);});
async function loadPreview(){if(!editable()||previewLoading.value||!delegated.value)return;previewAbort?.abort();const controller=new AbortController(),issued=stamp(),config=delegated.value.config;previewAbort=controller;previewLoading.value=true;previewLoaded.value=false;previewError.value='';products.value=[];
 try{if(config.error)throw Error(config.error);const result=config.query?await apiDiyListProductPreview(config.query,controller.signal):[];if(!current(issued)||previewAbort!==controller||controller.signal.aborted)return;products.value=result;previewLoaded.value=true;
 }catch(reason){if(current(issued)&&previewAbort===controller&&!controller.signal.aborted)previewError.value=reason instanceof Error?reason.message:'商品读取失败，请重试';}finally{if(previewAbort===controller){previewAbort=null;previewLoading.value=false;}}}
// Ordinary inputs/buttons own the same complete editor lease as async pickers.
const formSession=computed(()=>{
 const issued=stamp();const guard=<T extends unknown[]>(fn:(...args:T)=>unknown)=>(...args:T)=>{if(current(issued))return fn(...args);};
 return{add:guard(add),select:guard(select),moveUp:guard(()=>move(-1)),moveDown:guard(()=>move(1)),remove:guard(remove),setVisible:guard(setVisible),setStyle:guard(setStyle),selectTab:guard(selectTab),addTab:guard(addTab),tabUp:guard(()=>moveTab(-1)),tabDown:guard(()=>moveTab(1)),removeTab:guard(removeTab),setSource:guard(setSource),setTabCount:guard(setTabCount),setTabSort:guard(setTabSort),clearSelection:guard(clearSelection),selectItem:guard(selectItem),itemUp:guard(()=>moveItem(-1)),itemDown:guard(()=>moveItem(1)),removeItem:guard(removeItem),clearImage:guard(clearImage),setRadiusMode:guard(setRadiusMode),loadSavedMedia:guard(loadSavedMedia),loadPreview:guard(loadPreview),
 enums:Object.fromEntries(['setUp','slideConfig',...enums.map(field=>field.key)].map(key=>[key,guard((value:unknown)=>setEnum(key,value))])),
 texts:[0,1].map(index=>guard((value:unknown)=>setTabText(index,value))),
 colours:Object.fromEntries(colours.map(field=>[field.label,guard((value:unknown)=>setColour(field,value))])),
 lengths:Object.fromEntries(lengths.map(field=>[field.key,guard((value:unknown)=>setLength(field.key,value))])),
 radii:[0,1,2,3].map(index=>guard((value:unknown)=>setRadius(index,value)))};
});
</script>
<style scoped>
.promotion-editor{width:100%;min-width:0;overflow-wrap:anywhere}.hint,.stored{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary);overflow-wrap:anywhere}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 14px}.el-form-item{min-width:0}.el-select{max-width:100%}.el-form-item :deep(.el-input-number){max-width:100%}@media(max-width:600px){.fields{grid-template-columns:1fr}}
</style>
