<template>
  <main class="catalog-page">
    <header class="catalog-heading"><div><h2>商品标签管理</h2><p>按分组管理文字、图片标签，分别控制启用和商城展示。</p></div>
      <el-button v-if="canManage" type="primary" :disabled="!workflow.writable()" @click="openLabel()">新增标签</el-button></header>
    <el-alert v-if="state.error" :title="state.error" type="warning" :closable="false" show-icon class="notice" />
    <el-alert v-if="state.pending && !categoryDialog && !labelDialog" title="操作结果待核对，原内容已保留" type="warning" :closable="false" class="notice pending-actions">
      <el-button :disabled="state.busy" @click="recoverPending()">核对服务器状态</el-button>
      <el-button :disabled="state.busy || !canManage" @click="recoverPending(true)">重试原操作</el-button>
    </el-alert>
    <div class="catalog-layout">
      <aside class="groups">
        <div class="group-heading"><h3>标签分组</h3><el-button v-if="canManage" text :disabled="!workflow.writable()" @click="openCategory()">新增分组</el-button></div>
        <el-input v-model="state.name" placeholder="搜索分组或标签" clearable :disabled="state.busy || !!state.pending" @change="searchGroups" />
        <button class="group-item" :class="{active:state.category===0}" :disabled="state.busy || !!state.pending" @click="workflow.selectCategory(0)"><span>全部标签</span></button>
        <div v-for="group in state.categories" :key="group.id" class="group-row">
          <button class="group-item" :class="{active:state.category===group.id}" :disabled="state.busy || !!state.pending" @click="workflow.selectCategory(group.id)"><span>{{ group.name }}</span><small v-if="group.id===1">默认</small></button>
          <div v-if="canManage" class="group-actions"><el-button text size="small" :disabled="!workflow.writable()" :aria-label="`编辑分组${group.name}`" @click="openCategory(group)">编辑</el-button>
            <el-button text size="small" type="danger" :disabled="group.id===1 || !workflow.writable()" :aria-label="`删除分组${group.name}`" @click="removeCategory(group)">删除</el-button></div>
        </div>
        <el-pagination v-if="state.categoryCount>100" :current-page="state.categoryPage" :page-size="100" :total="state.categoryCount" layout="prev,next" @current-change="categoryPage" />
      </aside>
      <section class="labels">
        <div class="table-heading"><span>{{ state.count }} 个标签</span><div>
          <el-button :disabled="state.loading || state.busy" @click="refresh">刷新</el-button>
          <el-button v-if="canManage" type="danger" plain :disabled="!state.selected.length || !workflow.writable()" @click="removeSelected">删除选中 {{ state.selected.length || '' }}</el-button></div></div>
        <div class="table-scroll"><el-table :data="state.labels" v-loading="state.loading" row-key="id" @selection-change="selectionChange">
          <el-table-column v-if="canManage" type="selection" width="48" :selectable="selectable" />
          <el-table-column prop="id" label="ID" width="68" />
          <el-table-column label="标签" min-width="155"><template #default="{row}">
            <img v-if="row.style_type===2 && row.icon_preview" :src="row.icon_preview" :alt="row.label_name" class="label-image" />
            <span v-else class="label-preview" :style="previewStyle(row)">{{ row.label_name }}</span>
            <small v-if="row.label_cate===0" class="legacy-note">未分组历史标签</small>
          </template></el-table-column>
          <el-table-column label="分组" min-width="110"><template #default="{row}">{{ groupName(row.label_cate) }}</template></el-table-column>
          <el-table-column prop="sort" label="排序" width="80" />
          <el-table-column label="启用" width="90"><template #default="{row}"><el-switch :model-value="row.status" :active-value="1" :inactive-value="0" :disabled="!workflow.writable()" :aria-label="`启用${row.label_name}`" @change="setFlag(row,'status',Number($event))" /></template></el-table-column>
          <el-table-column label="商城展示" width="100"><template #default="{row}"><el-switch :model-value="row.is_show" :active-value="1" :inactive-value="0" :disabled="!workflow.writable()" :aria-label="`展示${row.label_name}`" @change="setFlag(row,'is_show',Number($event))" /></template></el-table-column>
          <el-table-column v-if="canManage" label="操作" width="126"><template #default="{row}"><el-button text :disabled="!workflow.writable()" @click="openLabel(row)">编辑</el-button>
            <el-button text type="danger" :disabled="row.id<=5 && row.label_cate===1 || !workflow.writable()" @click="removeLabel(row)">删除</el-button></template></el-table-column>
        </el-table></div>
        <el-empty v-if="!state.loading&&!state.labels.length" description="当前分组暂无标签" />
        <el-pagination :current-page="state.page" :page-size="20" :total="state.count" layout="total,prev,pager,next" :disabled="state.busy || !!state.pending" @current-change="workflow.selectPage" />
      </section>
    </div>
    <el-dialog v-model="categoryDialog" :title="categoryForm.id?'编辑标签分组':'新增标签分组'" width="min(440px,92vw)" :close-on-click-modal="false" :before-close="closeCategory">
      <el-alert v-if="state.pending" title="操作结果待核对，原内容已保留" type="warning" :closable="false" class="notice pending-actions">
        <el-button :disabled="state.busy" @click="recoverPending()">核对服务器状态</el-button>
        <el-button :disabled="state.busy || !canManage" @click="recoverPending(true)">重试原操作</el-button>
      </el-alert>
      <el-form label-position="top"><el-form-item label="分组名称" required><el-input v-model="categoryForm.name" maxlength="30" :disabled="state.busy || !!state.pending" /></el-form-item>
        <el-form-item label="排序"><el-input-number v-model="categoryForm.sort" :min="0" :max="2147483647" :disabled="state.busy || !!state.pending" /></el-form-item></el-form>
      <template #footer><el-button :disabled="state.busy || !!state.pending" @click="categoryDialog=false">取消</el-button><el-button type="primary" :disabled="!workflow.writable()" :loading="state.busy" @click="saveCategory">保存分组</el-button></template>
    </el-dialog>
    <el-dialog v-model="labelDialog" :title="labelForm.id?'编辑商品标签':'新增商品标签'" width="min(600px,94vw)" :close-on-click-modal="false" :before-close="closeLabel">
      <el-alert v-if="state.pending" title="操作结果待核对，原内容已保留" type="warning" :closable="false" class="notice pending-actions">
        <el-button :disabled="state.busy" @click="recoverPending()">核对服务器状态</el-button>
        <el-button :disabled="state.busy || !canManage" @click="recoverPending(true)">重试原操作</el-button>
      </el-alert>
      <el-form label-position="top" :disabled="state.busy || !!state.pending">
        <div class="form-grid"><el-form-item label="标签分组" required><el-select v-model="labelForm.label_cate" placeholder="请选择分组"><el-option v-for="item in options" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
          <el-form-item label="标签名称" required><el-input v-model="labelForm.label_name" maxlength="20" show-word-limit /></el-form-item></div>
        <el-form-item label="标签样式"><el-radio-group v-model="labelForm.style_type"><el-radio :value="1">文字标签</el-radio><el-radio :value="2">图片标签</el-radio></el-radio-group></el-form-item>
        <div v-if="labelForm.style_type===1" class="colors"><el-form-item label="文字颜色"><el-color-picker v-model="labelForm.color" show-alpha /></el-form-item><el-form-item label="背景颜色"><el-color-picker v-model="labelForm.bg_color" show-alpha /></el-form-item><el-form-item label="边框颜色"><el-color-picker v-model="labelForm.border_color" show-alpha /></el-form-item></div>
        <el-form-item v-else label="图片地址" required><el-input v-model="labelForm.icon" maxlength="255" placeholder="素材中心长期图片地址或公共HTTPS图片地址" /><router-link to="/assets">打开素材中心</router-link></el-form-item>
        <div class="form-grid"><el-form-item label="排序"><el-input-number v-model="labelForm.sort" :min="0" :max="2147483647" /></el-form-item><div class="flags"><el-form-item label="启用"><el-switch v-model="labelForm.status" :active-value="1" :inactive-value="0" /></el-form-item><el-form-item label="商城展示"><el-switch v-model="labelForm.is_show" :active-value="1" :inactive-value="0" /></el-form-item></div></div>
        <div class="draft-preview"><span>预览</span><span v-if="labelForm.style_type===1" class="label-preview" :style="previewStyle(labelForm)">{{ labelForm.label_name||'标签' }}</span><img v-else-if="draftPreview" :src="draftPreview" alt="标签图标预览" class="label-image" /><span v-else>保存后显示授权图片预览</span></div>
      </el-form>
      <template #footer><el-button :disabled="state.busy || !!state.pending" @click="labelDialog=false">取消</el-button><el-button type="primary" :disabled="!workflow.writable()" :loading="state.busy" @click="saveLabel">保存标签</el-button></template>
    </el-dialog>
  </main>
</template>
<script setup lang="ts">
import {computed,onMounted,onUnmounted,reactive,ref,watch} from 'vue';
import {ElMessageBox} from 'element-plus';
import {getToken,getAdminSession} from '@/utils/auth';
import {productLabelCatalogState} from '@/utils/productLabelCatalogState';
import {labelCategories,labelPage,labelGroupOptions,mutateProductLabel,labelProof,type ProductLabelItem,type ProductLabelCategory,type ProductLabelAction,type ProductLabelForm} from '@/api/productLabelCatalog';
const sessionEpoch=ref(0);
const identity=()=>`${getToken()??''}:${JSON.stringify(getAdminSession())}`;
const canManage=computed(()=>{sessionEpoch.value;const session=getAdminSession();return !!getToken()&&(session?.userInfo.level===0||!!session?.uniqueAuth.includes('label.manage'));});
const workflow=productLabelCatalogState({identity,manage:()=>canManage.value,categories:labelCategories,labels:labelPage,mutate:mutateProductLabel,proof:labelProof},value=>reactive(value) as typeof value);
const state=workflow.state,categoryDialog=ref(false),labelDialog=ref(false),options=ref<Array<{value:number;label:string}>>([]),draftPreview=ref('');
const categoryForm=reactive({id:0,name:'',sort:0});
const emptyLabel=():ProductLabelForm&{id:number}=>({id:0,label_cate:0,label_name:'',style_type:1,color:'#e93323',bg_color:'#fff5f4',border_color:'',icon:'',is_show:1,status:1,sort:0});
const labelForm=reactive(emptyLabel());
function clearDrafts(){categoryDialog.value=false;labelDialog.value=false;options.value=[];Object.assign(categoryForm,{id:0,name:'',sort:0});Object.assign(labelForm,emptyLabel());draftPreview.value='';}
function sessionChanged(){sessionEpoch.value++;workflow.reset();clearDrafts();void refresh();}
function storageChanged(event:StorageEvent){if(event.key===null||event.key==='admin_token'||event.key==='admin_session')sessionChanged();}
watch(()=>state.revoked,value=>{if(value)clearDrafts();},{flush:'sync'});
async function refresh(){await Promise.all([workflow.loadCategories(),workflow.loadLabels()]);}
function searchGroups(){state.categoryPage=1;void workflow.loadCategories();}
function categoryPage(page:number){state.categoryPage=page;void workflow.loadCategories();}
function groupName(id:number){return state.categories.find(row=>row.id===id)?.name??(id===0?'未分组':`分组 #${id}`);}
function previewStyle(row:{color:string;bg_color:string;border_color:string}){
  const color=(value:string)=>/^#[0-9a-f]{3,8}$/i.test(value)||/^rgba?\([\d\s,.]+\)$/.test(value)||value==='transparent'?value:'';
  return {color:color(row.color),backgroundColor:color(row.bg_color),borderColor:color(row.border_color)};
}
function openCategory(row?:ProductLabelCategory){if(!workflow.writable())return;Object.assign(categoryForm,{id:row?.id??0,name:row?.name??'',sort:row?.sort??0});categoryDialog.value=true;}
async function openLabel(row?:ProductLabelItem){
  if(!workflow.writable())return;const key=identity();Object.assign(labelForm,emptyLabel(),row?{id:row.id,label_cate:row.label_cate,label_name:row.label_name,style_type:row.style_type,color:row.color,bg_color:row.bg_color,border_color:row.border_color,icon:row.icon,is_show:row.is_show,status:row.status,sort:row.sort}:{label_cate:state.category});
  draftPreview.value=row?.icon_preview??'';labelDialog.value=true;
  try{const form=await labelGroupOptions();if(identity()===key&&!state.revoked)options.value=form.rules.find(rule=>rule.field==='label_cate')?.options??[];}catch(error){workflow.reject(error,key);}
}
async function saveCategory(){if(!categoryForm.name.trim()){state.error='请输入分组名称';return;}if(await workflow.run({kind:'category-save',id:categoryForm.id,body:{name:categoryForm.name,sort:categoryForm.sort}}))categoryDialog.value=false;}
async function saveLabel(){
  if(!labelForm.label_cate||!labelForm.label_name.trim()){state.error='请选择分组并填写标签名称';return;}
  const {id,...body}=labelForm;if(await workflow.run({kind:'label-save',id,body:{...body}}))labelDialog.value=false;
}
async function recoverPending(retry=false){
  const action=state.pending;if(!action)return;
  if(await (retry?workflow.retry():workflow.reconcile())){
    if(action.kind==='label-save')labelDialog.value=false;
    if(action.kind==='category-save')categoryDialog.value=false;
  }
}
async function confirm(action:ProductLabelAction,title:string){const key=identity();try{await ElMessageBox.confirm(title,'确认删除',{confirmButtonText:'删除',cancelButtonText:'取消',type:'warning'});if(identity()===key&&workflow.writable())await workflow.run(action);}catch{/* User cancellation leaves selection and draft intact. */}}
function removeCategory(row:ProductLabelCategory){void confirm({kind:'category-delete',id:row.id},`删除分组「${row.name}」？分组下有标签时会拒绝删除。`);}
function removeLabel(row:ProductLabelItem){void confirm({kind:'label-delete',id:row.id},`删除标签「${row.label_name}」？仍被商品使用的标签会保留。`);}
function removeSelected(){const ids=[...state.selected];void confirm({kind:'label-batch',ids},`删除选中的 ${ids.length} 个标签？默认标签会保留，存在商品引用时整批拒绝。`);}
function setFlag(row:ProductLabelItem,field:'status'|'is_show',value:number){void workflow.run({kind:'label-flag',id:row.id,field,value});}
function selectionChange(rows:ProductLabelItem[]){state.selected=rows.filter(selectable).map(row=>row.id);}
function selectable(row:ProductLabelItem){return workflow.writable()&&row.id>5;}
function closeCategory(done:()=>void){if(!state.busy&&!state.pending)done();}
function closeLabel(done:()=>void){if(!state.busy&&!state.pending)done();}
onMounted(()=>{window.addEventListener('admin-session-changed',sessionChanged);window.addEventListener('admin-auth-expired',sessionChanged);window.addEventListener('storage',storageChanged);void refresh();});
onUnmounted(()=>{workflow.reset();window.removeEventListener('admin-session-changed',sessionChanged);window.removeEventListener('admin-auth-expired',sessionChanged);window.removeEventListener('storage',storageChanged);});
defineExpose({state,workflow,categoryForm,labelForm,categoryDialog,labelDialog,openCategory,openLabel,saveCategory,saveLabel,recoverPending,sessionChanged,refresh});
</script>
<style scoped>
.pending-actions :deep(.el-alert__description){display:flex;flex-wrap:wrap;gap:8px}.pending-actions .el-button{margin-left:0}
.catalog-page{max-width:1440px;margin:auto}.catalog-heading,.group-heading,.table-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.catalog-heading{margin-bottom:22px}.catalog-heading h2{margin:0 0 8px;font-size:23px}.catalog-heading p{margin:0;color:#6b7280;font-size:14px}.notice{margin-bottom:16px}.catalog-layout{display:grid;grid-template-columns:260px minmax(0,1fr);gap:20px}.groups,.labels{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:18px;min-width:0}.group-heading h3{font-size:15px;margin:0}.groups .el-input{margin:16px 0}.group-row{margin:4px 0}.group-item{display:flex;align-items:center;justify-content:space-between;width:100%;padding:12px;border:0;background:transparent;text-align:left;border-radius:6px;cursor:pointer;color:#374151}.group-item.active{background:#eff6ff;color:#2563eb}.group-item:disabled{cursor:default}.group-actions{text-align:right}.group-item small,.legacy-note{color:#9ca3af;font-size:12px}.legacy-note{display:block;margin-top:5px}.table-heading{margin-bottom:15px;font-size:14px;color:#6b7280}.table-scroll{overflow:auto;min-width:0}.labels .el-table{min-width:670px}.label-preview{display:inline-block;padding:4px 10px;border:1px solid transparent;border-radius:4px;max-width:180px;overflow-wrap:anywhere}.label-image{max-width:112px;height:32px;object-fit:contain}.labels .el-pagination{margin-top:20px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.form-grid .el-select{width:100%}.colors,.flags{display:flex;gap:30px}.draft-preview{display:flex;align-items:center;gap:16px;background:#f8fafc;padding:16px;color:#6b7280;border-radius:7px}.el-form-item a{font-size:12px}.table-heading>div{display:flex;gap:8px}@media(max-width:760px){.catalog-layout{grid-template-columns:minmax(0,1fr)}.catalog-heading{align-items:flex-start}.catalog-heading h2{font-size:21px}.catalog-heading p{max-width:230px;line-height:1.7}.groups,.labels{padding:14px}.group-row{display:flex;align-items:center}.group-item{flex:1}.group-actions{white-space:nowrap}.form-grid{grid-template-columns:1fr;gap:0}.colors{gap:24px}.table-heading{align-items:flex-start}.table-heading>div{flex-wrap:wrap;justify-content:flex-end}.labels .el-pagination{max-width:100%;overflow:auto}}
</style>
