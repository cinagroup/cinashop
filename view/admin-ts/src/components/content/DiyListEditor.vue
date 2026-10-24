<template>
  <section class="list-author-editor" aria-label="商品文章列表作者编辑器">
    <h3>商品列表与文章列表</h3>
    <p class="hint">配置与装修 JSON 同步，保存页面后生效。导入的列表、隐藏样式、非当前范围及未知字段完整保留。</p>
    <el-alert v-if="parsed.error" :title="parsed.error" type="warning" :closable="false" />
    <template v-else-if="document">
      <div class="toolbar"><el-select v-model="addKind" aria-label="新增列表组件类型" :disabled="!canEdit"><el-option v-for="name in names" :key="name" :label="labels[name]" :value="name" /></el-select><el-button :disabled="!canEdit" @click="add">添加列表组件</el-button></div>
      <template v-if="entries.length">
        <el-select :model-value="selected" aria-label="选择列表组件" @update:model-value="select"><el-option v-for="entry in entries" :key="entry.index" :label="`第 ${entry.index+1} 项 · ${labels[entry.kind]}`" :value="entry.index" /></el-select>
        <div class="toolbar"><el-button :disabled="!canEdit" @click="move(-1)">上移列表组件</el-button><el-button :disabled="!canEdit" @click="move(1)">下移列表组件</el-button><el-button :disabled="!canEdit" type="danger" @click="remove">删除当前列表组件</el-button></div>
        <template v-if="block && kind">
          <el-form label-position="top" :disabled="!canEdit">
            <div class="fields">
              <el-form-item label="列表组件显示"><el-select :model-value="!flag(block.isHide)" @update:model-value="visible"><el-option label="显示" :value="true" /><el-option label="隐藏并保留配置" :value="false" /></el-select></el-form-item>
              <el-form-item v-if="block.isShow!==undefined" label="导入列表启用"><el-select :model-value="flag(block.isShow)" @update:model-value="enabled"><el-option label="启用" :value="true" /><el-option label="停用并保留配置" :value="false" /></el-select></el-form-item>
              <el-form-item label="列表展示风格"><el-select :model-value="layout" @update:model-value="setLayout"><el-option v-for="(label,index) in styles" :key="index" :label="label" :value="index" /></el-select></el-form-item>
              <el-form-item v-if="kind==='goodList'" label="商品选择方式"><el-select :model-value="ordinal(read(block,['typeConfig','activeValue']),1,4)" @update:model-value="setScope"><el-option v-for="(label,index) in ['指定商品','指定品牌','指定分类','商品标签']" :key="index" :label="label" :value="index+1" /></el-select></el-form-item>
              <el-form-item :label="kind==='goodList'?'商品展示数量':'文章展示数量'"><el-input-number :model-value="number(read(block,[countKey,'val']),3)" :min="Math.min(1,number(read(block,[countKey,'val']),3))" :max="Math.max(100,number(read(block,[countKey,'val']),3))" @update:model-value="setCount" /></el-form-item>
              <el-form-item v-if="kind==='goodList'" label="商品排序"><el-select :model-value="ordinal(read(block,['goodsSort','tabVal']),1,2)" :disabled="!canEdit || selectionKind==='product'" @update:model-value="setSort"><el-option label="综合" :value="0" /><el-option label="销量降序" :value="1" /><el-option label="价格降序" :value="2" /></el-select></el-form-item>
            </div>
            <p class="hint">普通修改数量为 1–100；导入的 0、超量数量及字符串在查看或失焦时保留。指定商品按已选顺序展示，保存原有排序配置供其他范围使用。</p>
            <h4>{{kind==='goodList'?'真实商品范围':'真实文章分类'}}</h4>
            <DiyListSelectionPicker :kind="selectionKind" :editor-key="picker.key" :disabled="!canEdit" @choose="picker.choose" />
            <el-button :disabled="!canEdit" @click="clearRange">清空当前范围</el-button>
            <p v-if="kind==='articleList'" class="selection-current">{{selectionName(read(block,['selectConfig','activeValue']))}}</p>
            <template v-else>
              <p class="hint">已选 {{selections.length}} 项。普通新增最多100项，全部导入项仍可查看、移除和排序；切换范围保留原选择。</p>
              <el-select v-if="selections.length" :model-value="selectionIndex" aria-label="选择已选范围项" @update:model-value="selectIdentity"><el-option v-for="(raw,index) in selections" :key="index" :label="`${index+1} · ${selectionName(raw)}`" :value="index" /></el-select>
              <div v-if="selections.length" class="toolbar"><el-button :disabled="!canEdit || selectionIndex<=0" @click="moveIdentity(-1)">上移已选项</el-button><el-button :disabled="!canEdit || selectionIndex>=selections.length-1" @click="moveIdentity(1)">下移已选项</el-button><el-button :disabled="!canEdit" @click="removeIdentity">移除已选项</el-button></div>
              <p v-if="selectionKind==='product'" class="hint">只有明确选择的商品编号用于公开列表。已存商品资料保留，不会自动转换为新选择；预览从当前公开接口重新读取。</p>
            </template>
            <h4>展示信息</h4>
            <div class="checks"><el-checkbox v-for="(label,index) in checkLabels" :key="index" :model-value="projection.checks.includes(index)" @update:model-value="setCheck(index,$event)">{{label}}</el-checkbox></div>
            <div v-if="kind==='goodList' && layout!==3" class="fields">
              <el-form-item label="商品按钮显示"><el-select :model-value="ordinal(read(block,['cartConfig','tabVal']),0,1)" @update:model-value="setEnum('cartConfig',$event)"><el-option label="显示" :value="0" /><el-option label="隐藏并保留样式" :value="1" /></el-select></el-form-item>
              <template v-if="projection.showAction">
                <el-form-item label="商品按钮效果"><el-select :model-value="ordinal(read(block,['bntConfig','tabVal']),1,1)" @update:model-value="setEnum('bntConfig',$event)"><el-option label="进入商品详情" :value="0" /><el-option label="选择规格加入购物车" :value="1" /></el-select></el-form-item>
                <el-form-item label="商品按钮样式"><el-select :model-value="ordinal(read(block,['bntStyleConfig','tabVal']),0,2)" @update:model-value="setButtonStyle"><el-option v-for="entry in buttonStyles" :key="entry.value" :label="entry.label" :value="entry.value" /></el-select></el-form-item>
                <el-form-item label="商品按钮色调"><el-select :model-value="ordinal(read(block,['toneCartConfig','tabVal']),0,1)" @update:model-value="setEnum('toneCartConfig',$event)"><el-option label="跟随主题" :value="0" /><el-option label="自定义" :value="1" /></el-select></el-form-item>
              </template>
            </div>
            <h4>列表样式</h4>
            <div class="fields">
              <el-form-item label="列表标题字重"><el-select :model-value="ordinal(read(block,[kind==='goodList'?'goodsName':'nameConfig','tabVal']),1,1)" @update:model-value="setEnum(kind==='goodList'?'goodsName':'nameConfig',$event)"><el-option label="加粗" :value="0" /><el-option label="正常" :value="1" /></el-select></el-form-item>
              <el-form-item label="列表色调"><el-select :model-value="ordinal(read(block,['toneConfig','tabVal']),0,1)" @update:model-value="setEnum('toneConfig',$event)"><el-option label="跟随主题" :value="0" /><el-option label="自定义" :value="1" /></el-select></el-form-item>
              <el-form-item v-for="field in colours" :key="`${field.key}:${field.index}`" :label="field.label"><el-input :model-value="colour(field)" @update:model-value="setColour(field,$event)" /><el-color-picker :model-value="colour(field)" show-alpha @update:model-value="setColour(field,$event)" /></el-form-item>
              <el-form-item v-for="field in lengths" :key="field.key" :label="field.label"><el-input-number :model-value="number(read(block,[field.key,'val']),field.fallback)" :min="0" :max="Math.max(100,number(read(block,[field.key,'val']),field.fallback))" @update:model-value="setLength(field.key,$event)" /></el-form-item>
            </div>
            <template v-for="field in ['filletImg','fillet']" :key="field">
              <el-form-item :label="field==='filletImg'?'列表图片圆角方式':'列表背景圆角方式'"><el-select :model-value="separate(field)?1:0" @update:model-value="setRadiusMode(field,$event)"><el-option label="统一圆角" :value="0" /><el-option label="四角分别设置" :value="1" /></el-select></el-form-item>
              <div class="fields"><el-form-item v-for="(corner,index) in separate(field)?['左上','右上','右下','左下']:['统一']" :key="corner" :label="`${field==='filletImg'?'列表图片':'列表背景'}圆角${corner}（设计 px）`"><el-input-number :model-value="number(read(block,radiusPath(field,index)))" :min="0" :max="Math.max(100,number(read(block,radiusPath(field,index))))" @update:model-value="setRadius(field,index,$event)" /></el-form-item></div>
            </template>
          </el-form>
          <div class="toolbar"><el-button :disabled="!canEdit || previewLoading" :loading="previewLoading" @click="loadPreview">读取当前公开列表预览</el-button></div>
          <DiyListPreview :block="block" :products="products" :articles="articles" :loaded="previewLoaded" :loading="previewLoading" :error="previewError" :allowed="previewLease" />
        </template>
      </template>
    </template>
    <el-alert v-if="error" :title="error" type="warning" :closable="false" />
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { getToken } from '@/utils/auth';
import { useAuthStore } from '@/stores/auth';
import { navRead as read, navSet, navFlag as flag } from '@/utils/diyNavigationEditor';
import { LIST_NAMES as names, listLabels as labels, listKind, listEntries, listDocument, listRecord, listRawNumber as number, listOrdinal as ordinal, addListBlock, moveListBlock, listScope, listSelections, listStoredName, chooseListSelection, removeListSelection, moveListSelection, clearListSelection, type ListKind, type ListRecord, type ListSelection, type ListSelectionKind } from '@/utils/diyListEditor';
import { normalizeDiyList, listPreviewTheme, listSafeColor } from '@/utils/diyListProjection';
import { apiDiyListProductPreview, apiDiyListArticlePreview, type ListPreviewProduct, type ListPreviewArticle } from '@/api/diyListAuthor';
import { FabRequestScope } from '@/pages/setting/fabSettingsController';
import DiyListSelectionPicker from '@/components/content/DiyListSelectionPicker.vue';
import DiyListPreview from '@/components/content/DiyListPreview.vue';
const props=withDefaults(defineProps<{modelValue:string;editorKey:string;disabled?:boolean}>(),{disabled:false}),emit=defineEmits<{'update:modelValue':[value:string]}>(),auth=useAuthStore();
const selected=ref(-1),selectionIndex=ref(0),addKind=ref<ListKind>('goodList'),revision=ref(0),error=ref(''),previewError=ref(''),previewLoading=ref(false),previewLoaded=ref(false),products=ref<ListPreviewProduct[]>([]),articles=ref<ListPreviewArticle[]>([]),namesByIdentity=ref<Record<string,string>>({});let alive=true;
const actor=()=>`${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}`;
const editable=()=>alive&&!props.disabled&&!!auth.token&&auth.token===getToken()&&!!auth.userInfo&&(auth.userInfo.level===0||auth.uniqueAuth.includes('dise.manage'));
const canEdit=computed(editable),parsed=computed(()=>{try{return{value:listDocument(props.modelValue),error:''};}catch(reason){return{value:null,error:reason instanceof Error?reason.message:'装修 JSON 无效'};}}),document=computed(()=>parsed.value.value),entries=computed(()=>listEntries(document.value??[])),block=computed(()=>listRecord(document.value?.[selected.value])),kind=computed(()=>listKind(block.value?.name)),layout=computed(()=>ordinal(read(block.value,['styleConfig','tabVal']),0,kind.value==='goodList'?5:2)),selectionKind=computed<ListSelectionKind>(()=>kind.value==='articleList'?'article_category':listScope(block.value)),selections=computed(()=>listSelections(block.value,selectionKind.value)),countKey=computed(()=>kind.value==='goodList'?'numberConfig':'numConfig'),projection=computed(()=>normalizeDiyList(block.value,listPreviewTheme));
const styles=computed(()=>kind.value==='goodList'?['单列展示','两列展示（纵向）','三列展示','两列展示（横向）','大图展示','左右滑动展示']:['大图展示','两列展示（纵向）','两列展示（横向）']),checkLabels=computed(()=>kind.value==='goodList'?['商品名称','商品标签','商品价格','商品销量','商品评分','会员价格']:['时间日期','浏览量','点赞']);
const scope=new FabRequestScope(()=>`${actor()}:${props.editorKey}:${revision.value}:${selected.value}:${props.modelValue}`,()=>localStorage.getItem('admin_session'),editable);
function invalidate(clearNames=false){revision.value++;scope.invalidate();previewLoading.value=previewLoaded.value=false;products.value=[];articles.value=[];previewError.value='';if(clearNames)namesByIdentity.value={};}
watch(entries,()=>{if(!entries.value.some(entry=>entry.index===selected.value)){selected.value=entries.value[0]?.index??-1;selectionIndex.value=0;}},{immediate:true});
watch(()=>props.modelValue,()=>invalidate(),{flush:'sync'});watch(()=>[props.editorKey,props.disabled,actor()],()=>{invalidate(true);selectionIndex.value=0;},{flush:'sync'});
function invalidateSession(){invalidate(true);}window.addEventListener('admin-session-changed',invalidateSession);window.addEventListener('admin-auth-expired',invalidateSession);window.addEventListener('storage',invalidateSession);
onBeforeUnmount(()=>{alive=false;scope.dispose();window.removeEventListener('admin-session-changed',invalidateSession);window.removeEventListener('admin-auth-expired',invalidateSession);window.removeEventListener('storage',invalidateSession);});
function commit(value:unknown[]){if(!editable())return false;try{const raw=JSON.stringify(value,null,2);listDocument(raw);invalidate();emit('update:modelValue',raw);error.value='';return true;}catch(reason){error.value=reason instanceof Error?reason.message:'不能完整保存';return false;}}
function edit(change:(row:ListRecord)=>void){if(!editable()||!document.value||!block.value||!kind.value)return false;try{const value=structuredClone(document.value),row=listRecord(value[selected.value]);if(!row)return false;change(row);return commit(value);}catch(reason){error.value=reason instanceof Error?reason.message:'当前字段无法修改';return false;}}
function setLeaf(path:Array<string|number>,value:unknown){return edit(row=>navSet(row,path,value));}
function select(value:unknown){if(typeof value==='number'&&entries.value.some(entry=>entry.index===value)){invalidate(true);selected.value=value;selectionIndex.value=0;}}
function add(){if(!document.value)return;try{const result=addListBlock(document.value,addKind.value);if(commit(result.value)){selected.value=result.selected;selectionIndex.value=0;}}catch(reason){error.value=reason instanceof Error?reason.message:'无法添加列表';}}
function remove(){if(!document.value||!kind.value)return;const value=structuredClone(document.value);value.splice(selected.value,1);if(commit(value))selected.value=-1;}
function move(direction:-1|1){if(!document.value)return;try{const result=moveListBlock(document.value,selected.value,direction);if(commit(result.value))selected.value=result.selected;}catch(reason){error.value=reason instanceof Error?reason.message:'不能移动列表';}}
function visible(value:unknown){if(typeof value==='boolean')setLeaf(['isHide'],!value);}function enabled(value:unknown){if(typeof value==='boolean'&&block.value?.isShow!==undefined)setLeaf(['isShow'],value);}
function setLayout(value:unknown){if(typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<(kind.value==='goodList'?6:3))setLeaf(['styleConfig','tabVal'],value);}
function setScope(value:unknown){if(kind.value==='goodList'&&typeof value==='number'&&Number.isInteger(value)&&value>=1&&value<=4){if(setLeaf(['typeConfig','activeValue'],value))selectionIndex.value=0;}}
function setCount(value:unknown){if(typeof value==='number'&&Number.isInteger(value)&&value>=1&&value<=100&&value!==number(read(block.value,[countKey.value,'val']),3))setLeaf([countKey.value,'val'],value);}
function setSort(value:unknown){if(selectionKind.value!=='product'&&typeof value==='number'&&[0,1,2].includes(value))setLeaf(['goodsSort','tabVal'],value);}
function setEnum(key:string,value:unknown){if(typeof value==='number'&&[0,1].includes(value))setLeaf([key,'tabVal'],value);}
const buttonStyles=computed(()=>{const full=layout.value===0||layout.value===4,entries=full?[{value:0,label:'购买文字'},{value:1,label:'加号图标'},{value:2,label:'购物车图标'}]:[{value:0,label:'加号图标'},{value:1,label:'购物车图标'}];if(!full&&ordinal(read(block.value,['bntStyleConfig','tabVal']),0,2)===2)entries.push({value:2,label:'购物车图标（导入值2）'});return entries;});
function setButtonStyle(value:unknown){if(typeof value==='number'&&buttonStyles.value.some(entry=>entry.value===value))setLeaf(['bntStyleConfig','tabVal'],value);}
function selectionName(raw:unknown){return namesByIdentity.value[`${selectionKind.value}:${String(raw)}`]??listStoredName(block.value,selectionKind.value,raw);}
const picker=computed(()=>{const issued=scope.stamp(),expected=selectionKind.value;return{key:`${props.editorKey}:${revision.value}:${selected.value}:${expected}`,choose:(choice:ListSelection)=>{if(!scope.current(issued)||choice.kind!==expected)return;if(edit(row=>chooseListSelection(row,choice)))namesByIdentity.value={...namesByIdentity.value,[`${choice.kind}:${choice.id}`]:choice.name};}};});
const previewLease=computed(()=>{const issued=scope.stamp();return()=>scope.current(issued);});
function clearRange(){if(edit(row=>clearListSelection(row,selectionKind.value)))selectionIndex.value=0;}
function selectIdentity(value:unknown){if(typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<selections.value.length){invalidate();selectionIndex.value=value;}}
function removeIdentity(){if(edit(row=>removeListSelection(row,selectionKind.value,selectionIndex.value)))selectionIndex.value=Math.max(0,selectionIndex.value-1);}
function moveIdentity(direction:-1|1){const to=selectionIndex.value+direction;if(edit(row=>moveListSelection(row,selectionKind.value,selectionIndex.value,direction)))selectionIndex.value=to;}
function setCheck(id:number,checked:unknown){if(typeof checked!=='boolean')return;edit(row=>{const key=kind.value==='goodList'?'checkboxInfo':'checkboxList',raw=read(row,[key,'type']),items=Array.isArray(raw)?structuredClone(raw):[...projection.value.checks];const next=items.filter(value=>value!==id);if(checked)next.push(id);navSet(row,[key,'type'],next);});}
type ColourField={key:string;index:number;label:string;fallback:string};
const colours=computed(()=>{const f=(key:string,label:string,fallback:string,index=0):ColourField=>({key,label,fallback,index}),goods=kind.value==='goodList';return[...(goods?[f('goodsNameColor','商品名称颜色','#333333'),f('goodsPriceColor','商品价格颜色','#e93323'),...([0,1,4,5].includes(layout.value)?[f('soldNumColor','商品销量颜色','#999999')]:[]),...([0,4].includes(layout.value)?[f('scoreColor','商品评分颜色','#999999')]:[]),...(projection.value.showAction?[f('bntBgColor','商品按钮渐变起始色','#e93323'),f('bntBgColor','商品按钮渐变结束色','#FF7931',1)]:[])]:[f('nameColor','文章标题颜色','#333333'),f('timeColor','文章时间颜色','#999999'),f('browseColor','文章浏览图标颜色','#999999'),f('likeColor','文章点赞图标颜色','#999999'),f('statisticColor','文章统计文字颜色','#999999'),...(ordinal(read(block.value,['toneConfig','tabVal']),0,1)===1?[f('likeSuccessColor','文章已赞颜色','#e93323')]:[])]),f(goods?'moduleColor':'bgColor','列表渐变起始色','#ffffff'),f(goods?'moduleColor':'bgColor','列表渐变结束色','#ffffff',1),f('bottomBgColor','列表外层背景色','transparent')];});
function colour(field:ColourField){return listSafeColor(read(block.value,[field.key,'color',field.index,'item']),field.fallback);}
function setColour(field:ColourField,value:unknown){if(typeof value==='string'&&colours.value.some(row=>row.key===field.key&&row.index===field.index)&&listSafeColor(value,'')===value.trim())setLeaf([field.key,'color',field.index,'item'],value.trim());}
const lengths=[{key:'topConfig',label:'列表上内边距（设计 px）',fallback:0},{key:'bottomConfig',label:'列表下内边距（设计 px）',fallback:0},{key:'prConfig',label:'列表左右内边距（设计 px）',fallback:10},{key:'mbConfig',label:'列表页面上间距（设计 px）',fallback:0}];
function setLength(key:string,value:unknown){if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100&&value!==number(read(block.value,[key,'val']),lengths.find(field=>field.key===key)?.fallback))setLeaf([key,'val'],value);}
const separate=(key:string)=>flag(read(block.value,[key,'type']));
function radiusPath(key:string,index:number):Array<string|number>{const order=key==='filletImg'&&kind.value==='goodList'?[0,1,2,3]:[0,1,3,2];return separate(key)?[key,'valList',order[index]!,'val']:[key,'val'];}
function setRadiusMode(key:string,value:unknown){if(value===0||value===1)setLeaf([key,'type'],value);}
function setRadius(key:string,index:number,value:unknown){const path=radiusPath(key,index);if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100&&value!==number(read(block.value,path)))setLeaf(path,value);}
async function loadPreview(){if(!editable()||!block.value)return;const config=projection.value;invalidate();const job=scope.begin('preview');previewLoading.value=true;previewLoaded.value=false;previewError.value='';products.value=[];articles.value=[];
  try{if(config.error)throw Error(config.error);if(config.kind==='goodList'){if(config.query){const rows=await apiDiyListProductPreview(config.query,job.controller.signal);if(scope.valid('preview',job))products.value=rows;}}else if(config.limit>0){const rows=await apiDiyListArticlePreview(config.cid,config.limit,job.controller.signal);if(scope.valid('preview',job))articles.value=rows;}if(scope.valid('preview',job))previewLoaded.value=true;}
  catch(reason){if(scope.valid('preview',job))previewError.value=reason instanceof Error?reason.message:'公开列表预览读取失败';}
  finally{if(scope.finish('preview',job))previewLoading.value=false;}
}
</script>
<style scoped>
.list-author-editor{width:100%;min-width:0}h3,h4{margin:10px 0}.hint{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary)}.toolbar,.checks{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0}.toolbar .el-select{width:220px}.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:4px 18px}.selection-current{font-size:13px;overflow-wrap:anywhere}.el-select{max-width:100%}.fields .el-form-item{margin-bottom:14px}.checks .el-checkbox{margin-right:12px}
</style>
