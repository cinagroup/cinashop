<template><ThemePage><view class="product-community">
  <view class="heading">商品晒单</view><view class="notice">仅显示与当前商品关联的公开内容</view>
  <view v-if="error" class="error" role="alert">{{error}}<button :disabled="loading" @tap="load(page)">重新读取</button></view>
  <view v-if="loading" role="status">正在读取商品晒单…</view>
  <view v-for="post in list" :key="post.id" class="post" @tap="open(post)"><image v-if="post.image" :src="post.image" mode="aspectFill"/><view>{{post.title || '商品晒单'}}<text>{{post.contentType===2?'视频':'图文'}} ›</text></view></view>
  <view v-if="!loading&&!error&&!list.length" class="notice">当前页暂无商品晒单</view>
  <view class="pagination"><button size="mini" :disabled="loading||page===1" @tap="load(page-1)">上一页</button><text>第 {{page}} 页 · 共 {{count}} 条</text><button size="mini" :disabled="loading||page*10>=count" @tap="load(page+1)">下一页</button></view>
</view><DiySuspendedNavigation/></ThemePage></template>
<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import { ref,watch } from 'vue';
import { onLoad,onShow,onHide,onUnload } from '@dcloudio/uni-app';
import { apiProductCommunity,type DetailCommunity } from '@/api/productDetailDesign';
import { useAuthStore } from '@/stores/auth';
import { productDetailId } from '../../../../common/productDetailRoute';
const auth=useAuthStore(),list=ref<DetailCommunity[]>([]),count=ref(0),page=ref(1),loading=ref(false),error=ref('');
let productId=0,visible=false,disposed=false,generation=0,queued=false;
function clear(){generation++;list.value=[];count.value=0;loading.value=false;error.value='';}
async function load(target=1){if(!visible||disposed||!productId||!Number.isSafeInteger(target)||target<1||target>1000)return;
  const current=++generation,owner={version:auth.sessionVersion,token:auth.token,uid:auth.uid};
  const same=()=>!disposed&&visible&&current===generation&&owner.version===auth.sessionVersion&&owner.token===auth.token&&owner.uid===auth.uid;
  loading.value=true;error.value='';try{const result=await apiProductCommunity(productId,target,10);if(same()){list.value=result.list;count.value=result.count;page.value=target;}}
  catch{if(same())error.value='商品晒单读取失败，当前内容可能已过期，请重新读取';}finally{if(same())loading.value=false;}
}
function open(post:DetailCommunity){if(!visible||disposed||!list.value.includes(post))return;const epoch=generation,owner={version:auth.sessionVersion,token:auth.token,uid:auth.uid};uni.navigateTo({url:post.contentType===2?`/pages/discover/discoverVideo/index?id=${post.id}`:`/pages/discover/index?id=${post.id}`,fail:()=>{if(visible&&!disposed&&epoch===generation&&owner.version===auth.sessionVersion&&owner.token===auth.token&&owner.uid===auth.uid)error.value='晒单页面未打开，请重试';}});}
function routeId(value:unknown){clear();try{productId=productDetailId(value);}catch{productId=0;error.value='商品晒单链接无效';}}
function hashRoute():boolean{
  // #ifdef H5
  if(typeof window!=='undefined'){const route=window.location.hash.replace(/^#/u,'').split('?');if(route[0]!=='/pages/goods/productCommunity')return false;
    try{if(window.location.hash.length>8192)throw Error('链接过长');const query=new URLSearchParams(route[1]??'');if(query.getAll('productId').length!==1)throw Error('商品标识重复');const id=productDetailId(query.get('productId'));if(id!==productId)routeId(String(id));}
    catch{routeId(undefined);}return true;
  }
  // #endif
  return false;
}
function changed(){if(visible&&!disposed&&hashRoute())void load(1);}
onLoad(query=>{routeId(query?.productId);hashRoute();});
onShow(()=>{visible=true;hashRoute();void load(page.value);});onHide(()=>{visible=false;clear();});onUnload(()=>{disposed=true;visible=false;clear();
  // #ifdef H5
  if(typeof window!=='undefined')window.removeEventListener('hashchange',changed);
  // #endif
});
// #ifdef H5
if(typeof window!=='undefined')window.addEventListener('hashchange',changed);
// #endif
watch(()=>[auth.sessionVersion,auth.token,auth.uid],()=>{clear();if(!queued){queued=true;Promise.resolve().then(()=>{queued=false;void load(1);});}},{flush:'sync'});
</script>
<style scoped>.product-community{padding:24rpx 24rpx calc(60rpx + env(safe-area-inset-bottom))}.heading{font-size:34rpx;font-weight:600}.notice{font-size:25rpx;color:#777;padding:20rpx 0}.error{color:#a72823;padding:20rpx;background:#fff0ed}.post{background:#fff;padding:20rpx;margin:18rpx 0;display:flex;gap:20rpx}.post image{width:180rpx;height:180rpx;flex-shrink:0}.post>view{flex:1;overflow-wrap:anywhere}.post text{display:block;color:#888;font-size:24rpx;margin-top:14rpx}.pagination{display:flex;justify-content:space-between;align-items:center;gap:16rpx;font-size:24rpx}</style>
