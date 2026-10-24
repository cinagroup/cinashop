<template>
  <el-button :disabled="disabled || !authorized" @click="open">从真实目录选择</el-button>
  <el-dialog v-model="visible" :title="`选择${labels[kind]}`" width="min(860px, calc(100vw - 24px))" append-to-body @closed="closed">
    <section class="list-author-picker" :data-kind="catalogKind">
      <div class="toolbar">
        <el-input v-model="search" aria-label="列表目录搜索" placeholder="搜索名称" :disabled="loading || !authorized" @keyup.enter="query" />
        <el-button :disabled="loading || !authorized" @click="query">查询</el-button>
        <el-button v-if="kind==='product' && catalogKind==='product'" :disabled="loading || !authorized" @click="browseCategories">按商品分类筛选</el-button>
      </div>
      <div v-if="catalogKind==='brand' || catalogKind==='category' || productParent" class="breadcrumbs">
        <el-button link :disabled="loading || !authorized" @click="root">全部{{catalogKind==='brand'?'品牌':'分类'}}</el-button>
        <el-button v-for="(row,index) in ancestors" :key="row.id" link :disabled="loading || !authorized" @click="back(index)">{{row.name}}</el-button>
        <span v-if="productParent">筛选分类 #{{productParent}}</span>
      </div>
      <p v-if="catalogKind==='brand'" class="hint">展开父品牌后选择子品牌；已导入的选择仍完整保留。</p>
      <p v-if="catalogKind==='article_category'" class="hint">“热门文章”是公开接口的热门聚合；只在明确选择后生效。</p>
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <ul v-if="result?.issues.length" class="issues"><li v-for="(issue,index) in result.issues" :key="index">{{issue}}</li></ul>
      <div v-loading="loading" class="targets">
        <article v-for="item in result?.list ?? []" :key="item.id" class="list-author-target" :data-target-id="item.id">
          <el-image v-if="preview(item.image_preview)" :src="preview(item.image_preview)" fit="contain" />
          <div class="target-copy"><strong>{{item.name}}</strong><p v-if="item.price" class="hint">¥ {{item.price}}</p><ul v-if="item.issues.length" class="issues"><li v-for="(issue,index) in item.issues" :key="index">{{issue}}</li></ul></div>
          <div class="actions">
            <el-button v-if="item.has_children" :disabled="disabled || !authorized || loading || !ready" @click="descend(item)">查看子级</el-button>
            <el-button :disabled="disabled || !authorized || loading || !ready || !item.selectable || !item.selection || catalogKind==='brand' && item.has_children" @click="choose(item)">{{browsingCategories?'筛选此分类商品':'选择'}}</el-button>
          </div>
        </article>
        <p v-if="result && !result.list.length && !loading" class="hint">暂无可选目标</p>
      </div>
      <el-pagination v-if="result" :disabled="disabled || !authorized || loading || !ready" :current-page="result.page" :page-size="15" :total="result.count" layout="total, prev, pager, next" @current-change="load" />
    </section>
    <template #footer><el-button @click="visible=false">关闭</el-button></template>
  </el-dialog>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { getToken } from '@/utils/auth';
import { useAuthStore } from '@/stores/auth';
import { apiDiyListCatalog, type ListCatalogEntry, type ListCatalogPage } from '@/api/diyListAuthor';
import { presentationPreviewUrl } from '@/utils/diyPresentationEditor';
import { FabRequestScope } from '@/pages/setting/fabSettingsController';
import type { ListSelection, ListSelectionKind } from '@/utils/diyListEditor';
const props=defineProps<{kind:ListSelectionKind;editorKey:string;disabled:boolean}>(),emit=defineEmits<{choose:[choice:ListSelection]}>(),auth=useAuthStore();
const labels:Record<ListSelectionKind,string>={product:'商品',brand:'品牌',category:'商品分类',label:'商品标签',article_category:'文章分类'};
const visible=ref(false),loading=ref(false),ready=ref(false),error=ref(''),search=ref(''),appliedSearch=ref(''),parent=ref(0),productParent=ref(0),browsingCategories=ref(false),catalogKind=ref<ListSelectionKind>(props.kind),ancestors=ref<Array<{id:number;name:string}>>([]),result=ref<ListCatalogPage|null>(null);
let alive=true;
const authorizedNow=()=>alive&&!props.disabled&&!!auth.token&&auth.token===getToken()&&!!auth.userInfo&&(auth.userInfo.level===0||auth.uniqueAuth.includes('dise.manage'));
const authorized=computed(authorizedNow);
const identity=()=>`${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}:${props.editorKey}:${props.kind}`;
const scope=new FabRequestScope(identity,()=>localStorage.getItem('admin_session'),()=>authorizedNow()&&visible.value);
const preview=(value:unknown)=>presentationPreviewUrl(value);
function clear(){scope.invalidate();loading.value=ready.value=false;result.value=null;error.value='';}
function closed(){if(!visible.value)clear();}
watch(visible,(value,previous)=>{if(previous&&!value)clear();},{flush:'sync'});
async function open(){if(!authorizedNow())return;clear();catalogKind.value=props.kind;search.value=appliedSearch.value='';parent.value=productParent.value=0;ancestors.value=[];browsingCategories.value=false;visible.value=true;await load();}
async function load(page=1){if(!visible.value||!authorizedNow())return;const job=scope.begin('directory');loading.value=true;ready.value=false;error.value='';result.value=null;
  try{const data=await apiDiyListCatalog(catalogKind.value,{page,limit:15,search:appliedSearch.value,...(['product','brand','category'].includes(catalogKind.value)?{parent_id:catalogKind.value==='product'?productParent.value:parent.value}:{})},job.controller.signal);if(scope.valid('directory',job)){result.value=data;ready.value=true;}}
  catch(reason){if(scope.valid('directory',job))error.value=reason instanceof Error?reason.message:'目录读取失败';}
  finally{if(scope.finish('directory',job))loading.value=false;}
}
function query(){if(loading.value||!authorizedNow())return;scope.invalidate();appliedSearch.value=search.value;void load();}
function browseCategories(){if(loading.value||!authorizedNow())return;scope.invalidate();catalogKind.value='category';browsingCategories.value=true;parent.value=0;ancestors.value=[];search.value=appliedSearch.value='';void load();}
function root(){if(loading.value||!authorizedNow())return;scope.invalidate();if(props.kind==='product'){catalogKind.value=browsingCategories.value?'category':'product';productParent.value=0;}parent.value=0;ancestors.value=[];search.value=appliedSearch.value='';void load();}
function descend(item:ListCatalogEntry){if(!authorizedNow()||loading.value||!ready.value||!result.value?.list.includes(item)||!item.has_children||!['brand','category'].includes(catalogKind.value))return;scope.invalidate();parent.value=item.id;ancestors.value.push({id:item.id,name:item.name});search.value=appliedSearch.value='';void load();}
function back(index:number){if(loading.value||!authorizedNow()||!ancestors.value[index])return;scope.invalidate();ancestors.value=ancestors.value.slice(0,index+1);parent.value=ancestors.value[index]!.id;search.value=appliedSearch.value='';void load();}
function choose(item:ListCatalogEntry){if(!authorizedNow()||loading.value||!ready.value||!result.value?.list.includes(item)||!item.selectable||!item.selection||catalogKind.value==='brand'&&item.has_children)return;
  if(browsingCategories.value){scope.invalidate();productParent.value=item.id;catalogKind.value='product';parent.value=0;ancestors.value=[];browsingCategories.value=false;search.value=appliedSearch.value='';void load();return;}
  if(item.selection.kind!==props.kind)return;emit('choose',{kind:item.selection.kind,id:item.selection.id,name:item.selection.name});visible.value=false;
}
function invalidate(){visible.value=false;clear();}
watch(()=>[identity(),props.disabled],invalidate,{flush:'sync'});window.addEventListener('admin-session-changed',invalidate);window.addEventListener('admin-auth-expired',invalidate);window.addEventListener('storage',invalidate);
onBeforeUnmount(()=>{alive=false;scope.dispose();window.removeEventListener('admin-session-changed',invalidate);window.removeEventListener('admin-auth-expired',invalidate);window.removeEventListener('storage',invalidate);});
</script>
<style scoped>
.toolbar,.breadcrumbs{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0}.toolbar .el-input{width:260px}.targets{min-height:140px;max-height:48vh;overflow:auto}.list-author-target{display:flex;align-items:center;gap:12px;padding:12px;border:1px solid var(--el-border-color);border-radius:6px;margin:10px 0}.list-author-target .el-image{width:65px;height:65px;flex-shrink:0}.target-copy{flex:1;min-width:0;overflow-wrap:anywhere}.hint,.issues{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary)}.issues{color:var(--el-color-warning);padding-left:16px}.actions{display:flex;gap:8px;flex-wrap:wrap}.el-pagination{flex-wrap:wrap;gap:8px}@media(max-width:600px){.toolbar .el-input{width:100%}.list-author-target{flex-wrap:wrap}.target-copy{flex-basis:calc(100% - 80px)}}
</style>
