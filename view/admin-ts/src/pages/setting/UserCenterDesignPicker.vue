<template>
  <el-dialog :model-value="open" :title="mode==='asset'?'选择图片素材':'选择页面链接'" width="min(820px, calc(100vw - 32px))" append-to-body @close="emit('close')">
    <el-alert v-if="error" :title="error" type="error" :closable="false" data-testid="user-center-picker-error" />
    <form class="filters" @submit.prevent="searchPage">
      <el-select v-if="mode==='link'" v-model="kind" aria-label="链接分类" @change="searchPage"><el-option v-for="row in categories" :key="row.kind" :label="row.name" :value="row.kind" /></el-select>
      <el-input v-model="search" :maxlength="100" placeholder="搜索名称" aria-label="搜索素材或链接" clearable />
      <el-button native-type="submit" :disabled="loading || !canEdit">搜索</el-button>
    </form>
    <div v-loading="loading" class="results" data-testid="user-center-picker-results">
      <template v-if="mode==='asset'"><button v-for="row in assets" :key="row.id" type="button" :disabled="!canEdit || loading" @click="choose(row.canonical_url,row.preview_url)"><img :src="row.preview_url" alt="" loading="lazy" /><span>{{ row.name }}</span></button></template>
      <template v-else><button v-for="row in links" :key="`${row.kind}:${row.id}`" type="button" :disabled="!canEdit || loading || !row.selectable" @click="choose(row.url)"><strong>{{ row.name }}</strong><small>{{ row.url }}</small><span v-if="row.partial">部分能力待验证</span><span v-if="!row.selectable">当前不可选择</span></button></template>
      <p v-if="!loading && !(mode==='asset'?assets.length:links.length)">当前筛选没有可用结果。</p>
    </div>
    <ul v-if="issues.length" class="issues"><li v-for="issue in issues" :key="issue">{{ issue }}</li></ul>
    <template #footer><div class="pagination"><span>共 {{ count }} 项，第 {{ page }} 页</span><el-button :disabled="page<=1 || loading || !canEdit" @click="turn(-1)">上一页</el-button><el-button :disabled="page*limit>=count || loading || !canEdit" @click="turn(1)">下一页</el-button><el-button @click="emit('close')">关闭</el-button></div></template>
  </el-dialog>
</template>
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { apiUserCenterAssets, apiUserCenterLinkCategories, apiUserCenterLinkTargets, type UserCenterAsset } from '@/api/userCenterDesign';
import type { FabLinkCategory, FabLinkKind, FabLinkTarget } from '@/api/fabSettings';
import { userCenterDesignErrorMessage } from '../../../../common/userCenterDesignController';
const props=defineProps<{open:boolean;mode:'asset'|'link';identity:string;canEdit:boolean}>();
const emit=defineEmits<{close:[];choose:[value:string,preview?:string]}>();
const categories=ref<FabLinkCategory[]>([]),kind=ref<FabLinkKind>('basic'),search=ref(''),page=ref(1),limit=20,count=ref(0),loading=ref(false),error=ref(''),issues=ref<string[]>([]),assets=ref<UserCenterAsset[]>([]),links=ref<FabLinkTarget[]>([]);
let epoch=0,alive=true,abort:AbortController|null=null;
function current(version:number,identity:string){return alive&&props.open&&props.canEdit&&version===epoch&&identity===props.identity;}
function reset(){epoch++;abort?.abort();abort=null;assets.value=[];links.value=[];categories.value=[];issues.value=[];count.value=0;error.value='';loading.value=false;}
async function load(){reset();if(!props.open||!props.canEdit)return;const version=epoch,identity=props.identity,request=new AbortController();abort=request;loading.value=true;
  try{if(props.mode==='asset'){const data=await apiUserCenterAssets({page:page.value,limit,search:search.value.trim()},request.signal);if(!current(version,identity))return;assets.value=data.list;count.value=data.count;}
    else{const categoryData=await apiUserCenterLinkCategories(request.signal);if(!current(version,identity))return;categories.value=categoryData.list;const data=await apiUserCenterLinkTargets({kind:kind.value,page:page.value,limit,search:search.value.trim()},request.signal);if(!current(version,identity))return;links.value=data.list;count.value=data.count;issues.value=[...categoryData.issues,...data.issues];}
  }catch(reason){if(current(version,identity))error.value=userCenterDesignErrorMessage(reason);}finally{if(current(version,identity)){loading.value=false;abort=null;}}
}
function searchPage(){page.value=1;void load();}function turn(direction:number){page.value+=direction;void load();}
function choose(value:string,preview?:string){if(props.open&&props.canEdit&&!loading.value){emit('choose',value,preview);emit('close');}}
watch(()=>[props.open,props.mode,props.identity,props.canEdit],()=>{reset();search.value='';page.value=1;if(props.open&&props.canEdit)void load();},{flush:'sync'});
onBeforeUnmount(()=>{alive=false;reset();});
</script>
<style scoped>
.filters{display:flex;gap:10px;margin:14px 0}.filters>.el-select{width:190px;flex-shrink:0}.results{min-height:240px;display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;align-items:start}.results button{display:grid;gap:8px;min-width:0;border:1px solid var(--el-border-color);border-radius:8px;padding:10px;background:var(--el-bg-color);cursor:pointer;text-align:left;overflow-wrap:anywhere}.results button:disabled{opacity:.6;cursor:default}.results img{width:100%;height:108px;object-fit:contain}.results small{color:var(--el-text-color-secondary);font-size:11px}.results span{font-size:12px}.pagination{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap}.issues{font-size:12px;color:var(--el-color-warning)}@media(max-width:600px){.filters{flex-wrap:wrap}.filters>.el-select{width:100%}.results{grid-template-columns:repeat(2,minmax(0,1fr))}.pagination{justify-content:flex-start}}
</style>
