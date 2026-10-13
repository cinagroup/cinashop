<template>
  <main class="brand-page">
    <header class="page-head"><div><h2>商品品牌管理</h2><p>维护三级品牌层级、排序和显示状态。</p></div><el-button v-if="canManage" type="primary" :disabled="!workflow.writable()" @click="openForm()">新增品牌</el-button></header>
    <el-alert v-if="state.error" :title="state.error" type="warning" :closable="false" class="notice" />
    <el-alert v-if="state.pending&&!dialog" title="操作结果待核对，原内容已保留" type="warning" :closable="false" class="notice"><div class="pending-actions"><el-button :disabled="state.busy" @click="reconcilePending">核对服务器状态</el-button><el-button :disabled="state.busy||!canManage" @click="retryPending">重试原操作</el-button></div></el-alert>
    <section class="brand-panel">
      <div class="toolbar"><el-input v-model="state.name" maxlength="64" placeholder="搜索当前父级下的品牌" clearable :disabled="state.busy||!!state.pending" @keyup.enter="workflow.load()" /><el-button :disabled="state.busy||!!state.pending" @click="workflow.load()">查询</el-button><el-button :disabled="state.loading||state.busy||!!state.pending" @click="refresh">刷新</el-button><span>{{ state.count }} 个顶级品牌</span></div>
      <div class="table-scroll"><el-table :key="state.treeRevision" :data="state.rows" v-loading="state.loading" row-key="id" lazy :load="loadChildren" :tree-props="{children:'children',hasChildren:'has_children'}">
        <el-table-column prop="brand_name" label="品牌名称" min-width="220" /><el-table-column prop="brand_num" label="使用商品" width="100" /><el-table-column prop="sort" label="排序" width="80" />
        <el-table-column label="显示" width="90"><template #default="{row}"><el-switch :model-value="row.is_show" :active-value="1" :inactive-value="0" :disabled="!workflow.writable()" :aria-label="`显示${row.brand_name}`" @change="setShow(row,Number($event))" /></template></el-table-column>
        <el-table-column prop="add_time" label="创建时间" min-width="175" />
        <el-table-column v-if="canManage" label="操作" width="230"><template #default="{row}"><el-button text :disabled="!workflow.writable()||row.fid.length>=2" @click="openForm(undefined,row)">添加子品牌</el-button><el-button text :disabled="!workflow.writable()" @click="openForm(row)">编辑</el-button><el-button text type="danger" :disabled="!workflow.writable()" @click="remove(row)">删除</el-button></template></el-table-column>
      </el-table></div><el-empty v-if="!state.loading&&!state.rows.length" description="当前没有匹配品牌" />
      <p class="hint">显示开关只修改当前品牌。上级隐藏时，其下级不会进入商品选择树；使用商品数按直接所属品牌统计。</p>
    </section>
    <el-dialog v-model="dialog" :title="form.id?'编辑品牌':'新增品牌'" width="min(520px,94vw)" :close-on-click-modal="false" :before-close="closeDialog">
      <el-alert v-if="state.pending" title="操作结果待核对，原内容已保留" type="warning" :closable="false" class="notice"><div class="pending-actions"><el-button :disabled="state.busy" @click="reconcilePending">核对服务器状态</el-button><el-button :disabled="state.busy||!canManage" @click="retryPending">重试原操作</el-button></div></el-alert>
      <el-form label-position="top" :disabled="state.busy||!!state.pending"><el-form-item label="上级品牌"><el-cascader v-model="form.fid" :options="state.parents" :props="{checkStrictly:true,emitPath:true}" clearable filterable placeholder="顶级品牌" /></el-form-item><el-form-item label="品牌名称" required><el-input v-model="form.brand_name" maxlength="10" show-word-limit /></el-form-item>
        <div class="form-grid"><el-form-item label="排序"><el-input-number v-model="form.sort" :min="0" :max="2147483647" /></el-form-item><el-form-item label="显示"><el-switch v-model="form.is_show" :active-value="1" :inactive-value="0" /></el-form-item></div></el-form>
      <template #footer><el-button :disabled="state.busy||!!state.pending" @click="dialog=false">取消</el-button><el-button type="primary" :loading="state.busy" :disabled="!workflow.writable()" @click="save">保存品牌</el-button></template>
    </el-dialog>
  </main>
</template>
<script setup lang="ts">
import {computed,onMounted,onUnmounted,reactive,ref,watch} from 'vue';
import {ElMessageBox} from 'element-plus';
import {getToken,getAdminSession} from '@/utils/auth';
import {brandList,brandParents,mutateProductBrand,brandProof,type ProductBrandItem,type ProductBrandForm} from '@/api/productBrandCatalog';
import {productBrandCatalogState} from '@/utils/productBrandCatalogState';
const sessionEpoch=ref(0),identity=()=>`${getToken()??''}:${JSON.stringify(getAdminSession())}`;
const canManage=computed(()=>{sessionEpoch.value;const session=getAdminSession();return !!getToken()&&(session?.userInfo.level===0||!!session?.uniqueAuth.includes('brand.manage'));});
const workflow=productBrandCatalogState({identity,manage:()=>canManage.value,list:brandList,parents:brandParents,mutate:mutateProductBrand,proof:brandProof},value=>reactive(value) as typeof value);
const state=workflow.state,dialog=ref(false),empty=():ProductBrandForm&{id:number}=>({id:0,fid:[0],brand_name:'',sort:0,is_show:1}),form=reactive(empty());
function clearDraft(){dialog.value=false;Object.assign(form,empty());}
function sessionChanged(){sessionEpoch.value++;workflow.reset();clearDraft();void refresh();}
function storageChanged(event:StorageEvent){if(event.key===null||event.key==='admin_token'||event.key==='admin_session')sessionChanged();}
watch(()=>state.revoked,value=>{if(value)clearDraft();},{flush:'sync'});
async function refresh(){await Promise.all([workflow.load(),workflow.loadParents()]);}
function openForm(row?:ProductBrandItem,parent?:ProductBrandItem){if(!workflow.writable())return;Object.assign(form,empty(),row?{id:row.id,fid:row.fid.length?[...row.fid]:[0],brand_name:row.brand_name,sort:row.sort,is_show:row.is_show}:parent?{fid:[...parent.fid,parent.id]}:{});dialog.value=true;}
async function save(){if(!workflow.writable())return;if(!form.brand_name.trim()){state.error='请输入品牌名称';return;}const {id,...body}=form;if(await workflow.run({kind:'save',id,body:{...body,fid:[...(body.fid??[])]}}))dialog.value=false;}
async function retryPending(){if(await workflow.retry())clearDraft();}
async function reconcilePending(){if(await workflow.reconcile())clearDraft();}
async function remove(row:ProductBrandItem){const key=identity();try{await ElMessageBox.confirm(`删除品牌「${row.brand_name}」？有子品牌或引用时会拒绝删除。`,'确认删除',{type:'warning',confirmButtonText:'删除',cancelButtonText:'取消'});if(identity()===key&&workflow.writable())await workflow.run({kind:'delete',id:row.id});}catch{/* Cancellation preserves current rows. */}}
function setShow(row:ProductBrandItem,value:number){void workflow.run({kind:'show',id:row.id,value});}
async function loadChildren(row:ProductBrandItem,_node:unknown,resolve:(rows:ProductBrandItem[])=>void){resolve(await workflow.children(row.id));}
function closeDialog(done:()=>void){if(!state.busy&&!state.pending)done();}
onMounted(()=>{window.addEventListener('admin-session-changed',sessionChanged);window.addEventListener('admin-auth-expired',sessionChanged);window.addEventListener('storage',storageChanged);void refresh();});
onUnmounted(()=>{workflow.reset();window.removeEventListener('admin-session-changed',sessionChanged);window.removeEventListener('admin-auth-expired',sessionChanged);window.removeEventListener('storage',storageChanged);});
defineExpose({state,workflow,form,dialog,openForm,save,retryPending,reconcilePending,sessionChanged,refresh});
</script>
<style scoped>
.pending-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.pending-actions .el-button{margin-left:0}
.brand-page{max-width:1440px;margin:auto}.page-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}.page-head h2{margin:0 0 8px;font-size:23px}.page-head p,.hint{margin:0;color:#6b7280;font-size:14px;line-height:1.7}.notice{margin-bottom:16px}.brand-panel{padding:20px;background:#fff;border:1px solid #e5e7eb;border-radius:10px}.toolbar{display:flex;align-items:center;gap:12px;margin-bottom:18px}.toolbar .el-input{max-width:300px}.toolbar span{margin-left:auto;white-space:nowrap;color:#6b7280;font-size:14px}.table-scroll{overflow:auto}.table-scroll .el-table{min-width:900px}.hint{margin-top:16px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.el-cascader{width:100%}@media(max-width:760px){.page-head{align-items:flex-start}.page-head h2{font-size:21px}.brand-panel{padding:14px}.toolbar{flex-wrap:wrap;gap:8px}.toolbar .el-input{max-width:none;flex-basis:100%}.toolbar span{margin-left:auto}.form-grid{grid-template-columns:1fr;gap:0}}
</style>
