<template>
  <ThemePage>
  <view class="goods-list">
    <!-- 分类 tab (一级) -->
    <scroll-view scroll-x class="cate-bar" v-if="categories.length">
      <view
        class="cate-tab"
        :class="{ active: activeCateId === undefined }"
        @tap="switchCate(undefined)"
      >
        全部
      </view>
      <view
        class="cate-tab"
        v-for="cate in categories"
        :key="cate.id"
        :class="{ active: activeCateId === cate.id }"
        @tap="switchCate(cate.id)"
      >
        {{ cate.cate_name }}
      </view>
    </scroll-view>

    <!-- 排序栏 -->
    <view class="sort-bar">
      <view
        class="sort-item"
        :class="{ active: sortType === '' }"
        @tap="setSort('')"
      >
        综合
      </view>
      <view
        class="sort-item"
        :class="{ active: sortType === 'sales' }"
        @tap="setSort('sales')"
      >
        销量
      </view>
      <view
        class="sort-item"
        :class="{ active: sortType.startsWith('price') }"
        @tap="togglePrice"
      >
        价格 {{ sortType === "price_desc" ? "↓" : "↑" }}
      </view>
    </view>

    <!-- 商品网格 -->
    <view class="goods-grid">
      <view
        class="goods-card"
        v-for="item in goods"
        :key="item.id"
        @tap="goDetail(item.id)"
      >
        <image class="goods-image" :src="item.image || placeholder" mode="aspectFill" />
        <view class="goods-info">
          <view class="goods-name">{{ item.store_name }}</view>
          <view class="goods-bottom">
            <text class="price">¥{{ item.price }}</text>
            <text class="sales">已售 {{ item.sales }}</text>
          </view>
        </view>
      </view>
    </view>

    <view v-if="error" class="empty" role="alert">{{ error }}<button size="mini" @tap="fetch(!goods.length)">重新读取商品</button></view>
    <view v-else-if="!goods.length && !loading" class="empty">暂无商品</view>
    <view v-if="loading" class="empty" role="status">正在读取商品…</view>

    <!-- 加载更多 -->
    <view v-if="goods.length && hasMore" class="load-more" @tap="loadMore">加载更多</view>
    <view v-if="goods.length && !hasMore" class="load-more">没有更多了</view>
  </view>
  <DiySuspendedNavigation />
  </ThemePage>
</template>

<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import { ref, watch } from "vue";
import { onLoad, onShow, onHide, onUnload, onReachBottom } from "@dcloudio/uni-app";
import { apiCategoryProducts, apiCategoryTree } from "@/api/product";
import { useAuthStore } from '@/stores/auth';
import { categoryQuery, categoryPath, type CategoryScope } from '../../../../common/categoryCatalog';
import type { GoodsItem, CategoryNode } from "@/types/product";

const goods = ref<GoodsItem[]>([]);
const loading = ref(true);
const page = ref(1);
const limit = 10;
const hasMore = ref(true);
const sortType = ref("");
const keyword = ref("");
const cid = ref<number | undefined>();
const sid = ref<number | undefined>(), tid = ref<number | undefined>();
const categories = ref<CategoryNode[]>([]);
const activeCateId = ref<number | undefined>();
const auth = useAuthStore(), visible = ref(false), error = ref('');
let generation = 0, categoryGeneration = 0, disposed = false, routeValid = true;
function owner() { const actor = {version:auth.sessionVersion,token:auth.token,uid:auth.uid}; return ()=>visible.value&&!disposed&&actor.version===auth.sessionVersion&&actor.token===auth.token&&actor.uid===auth.uid; }

const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

async function fetch(reset = false) {
  if (!visible.value || disposed || !routeValid || !reset && (loading.value || !hasMore.value)) return;
  if (reset) {
    page.value = 1;
    goods.value = [];
  }
  const current=owner(),request=++generation,requestedPage=page.value;
  loading.value = true; error.value='';
  try {
    const params = { page: requestedPage, limit, ...(keyword.value ? {keyword:keyword.value} : {}), ...(cid.value?{cid:cid.value}:{}), ...(sid.value?{sid:sid.value}:{}), ...(tid.value?{tid:tid.value}:{}) };
    const result = await apiCategoryProducts({...params,...(sortType.value==='sales'?{salesOrder:'desc' as const}:sortType.value==='price_asc'?{priceOrder:'asc' as const}:sortType.value==='price_desc'?{priceOrder:'desc' as const}:{})});
    if(!current()||request!==generation)return;
    const seen=new Set(goods.value.map(item=>item.id)); goods.value=goods.value.concat(result.list.filter(item=>!seen.has(item.id)));
    hasMore.value = requestedPage * limit < result.count && result.list.length === limit;
    page.value = requestedPage + 1;
  } catch (e) {
    if(current()&&request===generation)error.value=e instanceof Error?e.message:'商品列表读取失败';
  } finally {
    if(current()&&request===generation)loading.value=false;
  }
}

function setSort(type: string) {
  sortType.value = type;
  fetch(true);
}

/** 切换一级分类 tab */
function switchCate(cateId: number | undefined) {
  activeCateId.value = cateId;
  cid.value = cateId;
  sid.value=undefined;tid.value=undefined;
  fetch(true);
}

/** 从分类树中找 cid 所属的一级分类 (二级分类定位到父级高亮) */
function findParentId(tree: CategoryNode[], target: number): number | undefined {
  return categoryPath(tree,target)[0]?.id;
}

function togglePrice() {
  sortType.value = sortType.value === "price_asc" ? "price_desc" : "price_asc";
  fetch(true);
}

function goDetail(id: number) {
  if(visible.value&&goods.value.some(item=>item.id===id))uni.navigateTo({ url: `/pages/goods/detail?id=${id}` });
}

function loadMore() {
  if (hasMore.value) fetch();
}

function setRoute(options:Record<string,unknown>){
  generation++;categoryGeneration++;goods.value=[];error.value='';routeValid=true;
  try{const scope:CategoryScope=categoryQuery(options);cid.value=scope.cid;sid.value=scope.sid;tid.value=scope.tid;
    const word=options.keyword??options.searchValue??'';if(typeof word!=='string'||[...word].length>100||/[\u0000-\u001f\u007f]/u.test(word))throw Error('搜索文字无效');keyword.value=word.trim();}
  catch(e){routeValid=false;error.value=e instanceof Error?e.message:'商品分类链接无效';}
}
async function readCategories(){const current=owner(),request=++categoryGeneration;try{const tree=await apiCategoryTree();if(current()&&request===categoryGeneration){categories.value=tree;const selected=tid.value??sid.value??cid.value;activeCateId.value=selected?findParentId(tree,selected):undefined;}}catch{/* 商品列表仍按原范围读取，分类导航不猜测。 */}}
function readHashRoute(){
  // #ifdef H5
  if(typeof window!=='undefined'&&window.location.hash.split('?')[0]==='#/pages/goods/list'){
    try{const params=new URLSearchParams(window.location.hash.split('?').slice(1).join('?'));for(const key of ['cid','sid','tid','keyword','searchValue'])if(params.getAll(key).length>1)throw Error();setRoute(Object.fromEntries(params));}
    catch{setRoute({cid:'invalid'});}return true;
  }
  // #endif
  return false;
}
function show(){if(disposed)return;visible.value=true;readHashRoute();void fetch(true);void readCategories();}
function hide(){visible.value=false;generation++;categoryGeneration++;loading.value=false;}
function hashChanged(){if(visible.value&&!disposed){readHashRoute();void fetch(true);void readCategories();}}
onLoad(options=>setRoute(options??{}));onShow(show);onHide(hide);onUnload(()=>{disposed=true;hide();
  // #ifdef H5
  if(typeof window!=='undefined')window.removeEventListener('hashchange',hashChanged);
  // #endif
});
watch(()=>auth.sessionVersion,()=>{generation++;categoryGeneration++;goods.value=[];categories.value=[];void Promise.resolve().then(()=>{if(visible.value&&!disposed){void fetch(true);void readCategories();}});},{flush:'sync'});
// #ifdef H5
if(typeof window!=='undefined')window.addEventListener('hashchange',hashChanged);
// #endif

onReachBottom(() => {
  if (hasMore.value) fetch();
});
</script>

<style scoped>
.goods-list {
  padding: 20rpx;
}

.cate-bar {
  white-space: nowrap;
  margin-bottom: 16rpx;
}

.cate-tab {
  display: inline-block;
  padding: 10rpx 28rpx;
  margin-right: 16rpx;
  font-size: 26rpx;
  color: #555;
  background: #f5f5f5;
  border-radius: 30rpx;
}

.cate-tab.active {
  color: #fff;
  background: var(--view-theme, #e93323);
  font-weight: 600;
}

.sort-bar {
  display: flex;
  background: #fff;
  border-radius: 12rpx;
  padding: 20rpx;
  margin-bottom: 20rpx;
}

.sort-item {
  flex: 1;
  text-align: center;
  font-size: 28rpx;
  color: #555;
}

.sort-item.active {
  color: var(--view-theme, #e93323);
  font-weight: 600;
}

.load-more {
  text-align: center;
  color: #999;
  padding: 30rpx;
  font-size: 26rpx;
}
</style>
