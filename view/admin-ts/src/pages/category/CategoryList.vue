<template>
  <main class="category-page">
    <header class="page-head"><div><h2>商品分类管理</h2><p>维护三级分类层级、商城图片和显示状态。</p></div><el-button v-if="canManage" type="primary" :disabled="!workflow.writable()||formLoading" @click="openForm()">新增分类</el-button></header>
    <el-alert v-if="state.error" :title="state.error" type="warning" :closable="false" class="notice" />
    <el-alert v-if="state.pending&&!dialog" title="操作结果待核对，原内容已保留" type="warning" :closable="false" class="notice"><div class="pending-actions"><el-button :disabled="state.busy" @click="reconcilePending">核对服务器状态</el-button><el-button :disabled="state.busy||!canManage" @click="retryPending">重试原操作</el-button></div></el-alert>
    <section class="category-panel">
      <div class="toolbar"><el-input v-model="state.name" maxlength="100" placeholder="搜索当前父级下的分类" clearable :disabled="state.busy||!!state.pending" @keyup.enter="workflow.load()" /><el-select v-model="state.show" aria-label="显示状态筛选" placeholder="全部状态" :disabled="state.busy||!!state.pending"><el-option label="全部状态" value="" /><el-option label="显示" :value="1" /><el-option label="隐藏" :value="0" /></el-select><el-button :disabled="state.busy||!!state.pending" @click="workflow.load()">查询</el-button><el-button :disabled="state.loading||state.busy||!!state.pending" @click="refresh">刷新</el-button><span>{{ state.count }} 个顶级分类</span></div>
      <div class="table-scroll"><el-table :key="state.treeRevision" :data="state.rows" v-loading="state.loading" row-key="id" lazy :load="loadChildren" :tree-props="{children:'children',hasChildren:'has_children'}">
        <el-table-column prop="cate_name" label="分类名称" min-width="230"><template #default="{row}">{{ row.cate_name }}<small v-if="row.level!==row.depth" class="repair-note">保存后整理历史层级</small></template></el-table-column>
        <el-table-column label="移动端图" width="105"><template #default="{row}"><img v-if="row.pic_preview" :src="row.pic_preview" :alt="`${row.cate_name}移动端图`" class="category-image" /><span v-else>—</span></template></el-table-column>
        <el-table-column label="PC端大图" width="105"><template #default="{row}"><img v-if="row.big_pic_preview" :src="row.big_pic_preview" :alt="`${row.cate_name}PC端图`" class="category-image" /><span v-else>—</span></template></el-table-column>
        <el-table-column prop="sort" label="排序" width="75" /><el-table-column label="显示" width="90"><template #default="{row}"><el-switch :model-value="row.is_show" :active-value="1" :inactive-value="0" :disabled="!workflow.writable()" :aria-label="`显示${row.cate_name}`" @change="setShow(row,Number($event))" /></template></el-table-column>
        <el-table-column prop="add_time" label="创建时间" min-width="175" /><el-table-column v-if="canManage" label="操作" width="230"><template #default="{row}"><el-button text :disabled="!workflow.writable()||formLoading||row.depth>=2" @click="openForm(undefined,row)">添加子分类</el-button><el-button text :disabled="!workflow.writable()||formLoading" @click="openForm(row)">编辑</el-button><el-button text type="danger" :disabled="!workflow.writable()" @click="remove(row)">删除</el-button></template></el-table-column>
      </el-table></div><el-empty v-if="!state.loading&&!state.rows.length" description="当前没有匹配分类" /><p class="hint">显示开关修改当前分类和直接子级。隐藏的上级及其后代不会进入商品选择树；有子级或引用的分类不能删除。</p>
    </section>
    <el-dialog v-model="dialog" :title="form.id?'编辑分类':'新增分类'" width="min(640px,94vw)" :close-on-click-modal="false" :before-close="closeDialog">
      <el-alert v-if="state.pending" title="操作结果待核对，原内容已保留" type="warning" :closable="false" class="notice"><div class="pending-actions"><el-button :disabled="state.busy" @click="reconcilePending">核对服务器状态</el-button><el-button :disabled="state.busy||!canManage" @click="retryPending">重试原操作</el-button></div></el-alert>
      <el-form label-position="top" :disabled="state.busy||!!state.pending"><el-form-item label="上级分类"><el-cascader v-model="form.pid" :options="parents" :props="{checkStrictly:true,emitPath:true}" clearable filterable placeholder="顶级分类" /></el-form-item><el-form-item label="分类名称" required><el-input v-model="form.cate_name" maxlength="30" show-word-limit /></el-form-item>
        <div class="image-fields"><el-form-item label="移动端图（180 × 180）"><el-input v-model="form.pic" maxlength="512" placeholder="素材中心长期引用或公共HTTPS图片地址" /><img v-if="draftPic" :src="draftPic" alt="移动端图片预览" class="draft-image" /></el-form-item><el-form-item label="PC端大图（468 × 340）"><el-input v-model="form.big_pic" maxlength="255" placeholder="素材中心长期引用或公共HTTPS图片地址" /><img v-if="draftBigPic" :src="draftBigPic" alt="PC端图片预览" class="draft-image" /></el-form-item></div><router-link to="/assets">打开素材中心</router-link><p class="hint">授权素材保存长期引用，预览地址由服务器生成。</p>
        <div class="form-grid"><el-form-item label="排序"><el-input-number v-model="form.sort" :min="0" :max="2147483647" /></el-form-item><el-form-item label="显示"><el-switch v-model="form.is_show" :active-value="1" :inactive-value="0" /></el-form-item></div></el-form>
      <template #footer><el-button :disabled="state.busy||!!state.pending" @click="dialog=false">取消</el-button><el-button type="primary" :loading="state.busy" :disabled="!workflow.writable()" @click="save">保存分类</el-button></template>
    </el-dialog>
  </main>
</template>
<script setup lang="ts">
import {computed,onMounted,onUnmounted,reactive,ref,watch} from 'vue';
import {ElMessageBox} from 'element-plus';
import {getToken,getAdminSession} from '@/utils/auth';
import {categoryList,categoryForm,mutateProductCategory,categoryProof,type ProductCategoryItem,type ProductCategoryForm,type ProductCategoryNode} from '@/api/productCategoryCatalog';
import {productCategoryCatalogState} from '@/utils/productCategoryCatalogState';
import {classifyProductMediaReference} from '../../../../common/productMediaReference';
const sessionEpoch=ref(0),identity=()=>`${getToken()??''}:${JSON.stringify(getAdminSession())}`;
const canManage=computed(()=>{sessionEpoch.value;const session=getAdminSession();return !!getToken()&&(session?.userInfo.level===0||!!session?.uniqueAuth.includes('category.manage'));});
const workflow=productCategoryCatalogState({identity,manage:()=>canManage.value,list:categoryList,mutate:mutateProductCategory,proof:categoryProof},value=>reactive(value) as typeof value);
const state=workflow.state,dialog=ref(false),formLoading=ref(false),parents=ref<ProductCategoryNode[]>([]),preview=ref({pic:'',bigPic:'',picRef:'',bigPicRef:''});let formRequest=0;
const empty=():ProductCategoryForm&{id:number}=>({id:0,pid:[0],cate_name:'',pic:'',big_pic:'',sort:0,is_show:1}),form=reactive(empty());
function image(value:string,original:string,url:string){if(value===original)return url;const ref=classifyProductMediaReference(value);return ref.kind==='public'?ref.reference:'';}
const draftPic=computed(()=>image(form.pic,preview.value.picRef,preview.value.pic)),draftBigPic=computed(()=>image(form.big_pic,preview.value.bigPicRef,preview.value.bigPic));
function clearDraft(){formRequest++;formLoading.value=false;dialog.value=false;Object.assign(form,empty());delete form.expected_revision;parents.value=[];preview.value={pic:'',bigPic:'',picRef:'',bigPicRef:''};}
function sessionChanged(){sessionEpoch.value++;workflow.reset();clearDraft();void refresh();}
function storageChanged(event:StorageEvent){if(event.key===null||event.key==='admin_token'||event.key==='admin_session')sessionChanged();}
watch(()=>state.revoked,value=>{if(value)clearDraft();},{flush:'sync'});
async function refresh(){await workflow.load();}
async function openForm(row?:ProductCategoryItem,parent?:ProductCategoryItem){if(!workflow.writable()||formLoading.value||parent&&parent.depth>=2)return;const key=identity(),request=++formRequest;formLoading.value=true;
  try{const snapshot=await categoryForm(row?.id??0);if(key!==identity()||request!==formRequest||!workflow.writable())return;
    const values=Object.fromEntries(snapshot.rules.map(rule=>[rule.field,rule.value]));if(!Array.isArray(values.pid)||!/^([a-f0-9]{64})$/.test(snapshot.revision)||typeof values.cate_name!=='string'||typeof values.pic!=='string'||typeof values.big_pic!=='string')throw Error('分类表单资料不完整');
    Object.assign(form,empty(),{id:row?.id??0,pid:[...values.pid],cate_name:values.cate_name,pic:values.pic,big_pic:values.big_pic,sort:values.sort,is_show:values.is_show,expected_revision:snapshot.revision});parents.value=snapshot.rules.find(rule=>rule.field==='pid')?.props?.data??[];
    if(parent){const path=parent.path?parent.path.split(',').map(Number):[];if(path.length!==parent.depth||path.some(id=>!Number.isSafeInteger(id)||id<=0)){state.error='父级历史路径需要先编辑整理';return;}form.pid=[...path,parent.id];}
    preview.value={pic:snapshot.pic_preview,bigPic:snapshot.big_pic_preview,picRef:form.pic,bigPicRef:form.big_pic};dialog.value=true;
  }catch(error){if(key===identity()&&request===formRequest)workflow.reject(error,key);}finally{if(request===formRequest)formLoading.value=false;}}
async function save(){if(!workflow.writable())return;if(!form.cate_name.trim()){state.error='请输入分类名称';return;}const {id,...body}=form;if(await workflow.run({kind:'save',id,body:{...body,pid:[...(body.pid??[])]}}))clearDraft();}
async function retryPending(){if(await workflow.retry())clearDraft();}
async function reconcilePending(){if(await workflow.reconcile())clearDraft();}
async function remove(row:ProductCategoryItem){const key=identity();try{await ElMessageBox.confirm(`删除分类「${row.cate_name}」？有子分类、商品或优惠券引用时会拒绝删除。`,'确认删除',{type:'warning',confirmButtonText:'删除',cancelButtonText:'取消'});if(identity()===key&&workflow.writable())await workflow.run({kind:'delete',id:row.id,revision:row.revision});}catch{/* Cancellation preserves the current rows. */}}
function setShow(row:ProductCategoryItem,value:number){void workflow.run({kind:'show',id:row.id,value,revision:row.revision});}
async function loadChildren(row:ProductCategoryItem,_node:unknown,resolve:(rows:ProductCategoryItem[])=>void){resolve(await workflow.children(row.id));}
function closeDialog(done:()=>void){if(!state.busy&&!state.pending)done();}
onMounted(()=>{window.addEventListener('admin-session-changed',sessionChanged);window.addEventListener('admin-auth-expired',sessionChanged);window.addEventListener('storage',storageChanged);void refresh();});onUnmounted(()=>{workflow.reset();window.removeEventListener('admin-session-changed',sessionChanged);window.removeEventListener('admin-auth-expired',sessionChanged);window.removeEventListener('storage',storageChanged);});
defineExpose({state,workflow,form,dialog,parents,openForm,save,retryPending,reconcilePending,sessionChanged,refresh,setShow,remove});
</script>
<style scoped>
.category-page{max-width:1440px;margin:auto}.page-head{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px}.page-head h2{margin:0 0 8px;font-size:23px}.page-head p,.hint{margin:0;color:#6b7280;font-size:14px;line-height:1.7}.notice{margin-bottom:16px}.category-panel{padding:20px;background:#fff;border:1px solid #e5e7eb;border-radius:10px}.toolbar{display:flex;align-items:center;gap:10px;margin-bottom:18px}.toolbar .el-input{max-width:300px}.toolbar .el-select{width:130px}.toolbar span{margin-left:auto;white-space:nowrap;color:#6b7280;font-size:14px}.table-scroll{overflow:auto}.table-scroll .el-table{min-width:1050px}.category-image{width:48px;height:48px;object-fit:contain}.draft-image{max-width:140px;height:90px;object-fit:contain;margin-top:10px}.repair-note{display:block;color:#b45309;font-size:12px}.hint{margin-top:14px}.form-grid,.image-fields{display:grid;grid-template-columns:1fr 1fr;gap:18px}.form-grid{margin-top:20px}.el-cascader{width:100%}.pending-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.pending-actions .el-button{margin-left:0}@media(max-width:760px){.page-head{align-items:flex-start}.page-head h2{font-size:21px}.category-panel{padding:14px}.toolbar{flex-wrap:wrap;gap:8px}.toolbar .el-input{max-width:none;flex-basis:100%}.toolbar span{margin-left:auto}.form-grid,.image-fields{grid-template-columns:1fr;gap:0}}
</style>
