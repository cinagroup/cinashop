<template><view class="activity-menu"><template v-for="id in menu" :key="id"><!-- #ifdef MP-WEIXIN --><button v-if="id===1" class="menu-item" open-type="share">分享</button><view v-else class="menu-item" @tap="act(id)">{{names[id]}}</view><!-- #endif --><!-- #ifndef MP-WEIXIN --><view class="menu-item" @tap="act(id)">{{names[id]}}</view><!-- #endif --></template><view v-if="error" class="menu-error" role="alert">{{error}}</view></view></template>
<script setup lang="ts">
import { ref,watch,onUnmounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { apiGoodsDetail } from '@/api/product';
import { http } from '@/utils/request';
import { integralSiteOrigin } from '../../../../common/integralPurchase';
import { shareOrdinaryInApp } from '@/utils/ordinaryShare';
const props=defineProps<{menu:number[];productId:number;path:string;title:string;image:string;active:boolean}>();
const names=['首页','分享','客服','收藏','购物车'],auth=useAuthStore(),error=ref('');let generation=0,disposed=false,busy=false;
watch(()=>[props.active,props.productId,props.path,auth.sessionVersion,auth.token,auth.uid],()=>{generation++;busy=false;error.value='';},{flush:'sync'});
async function act(id:number){if(disposed||!props.active||!props.menu.includes(id)||busy)return;const epoch=generation,actor={version:auth.sessionVersion,uid:auth.uid,token:auth.token};
  const current=()=>!disposed&&props.active&&epoch===generation&&actor.version===auth.sessionVersion&&actor.uid===auth.uid&&actor.token===auth.token;
  const fail=()=>{if(current())error.value='页面未打开，请重试';};
  if(id===0||id===4){uni.switchTab({url:id===0?'/pages/index/index':'/pages/cart/index',fail});return;}
  if(id===2){if(props.productId>0)uni.navigateTo({url:`/pages/user/kefu?productId=${props.productId}`,fail});else error.value='活动关联商品暂不可用';return;}
  if(!auth.isLoggedIn&&id===3){uni.navigateTo({url:'/pages/auth/login',fail});return;}
  busy=true;error.value='';try{const goods=await apiGoodsDetail(props.productId);if(!current())return;
    if(id===3){await http.post(goods.userCollect?'/collect/del':'/collect/add',{id:goods.userCollect?[props.productId]:props.productId,category:'product'});if(current())uni.showToast({title:goods.userCollect?'已取消收藏':'已收藏关联商品',icon:'success'});return;}
    const path=`${props.path}${auth.isLoggedIn&&auth.uid?`&spid=${auth.uid}`:''}`;let url='';
    // #ifdef H5
    if(typeof window!=='undefined'){const address=new URL(window.location.href);if(['http:','https:'].includes(address.protocol)&&!address.username&&!address.password){address.search='';address.hash=path;url=address.href;}}
    // #endif
    if(!url){const origin=integralSiteOrigin(goods.display?.siteUrl??'');if(origin)url=`${origin}/#${path}`;}
    if(!url){error.value='商家尚未配置可分享的商品网页';return;}
    // #ifdef APP-PLUS
    shareOrdinaryInApp({url,title:props.title,image:props.image,summary:goods.display?.posterTitle??''},'WXSceneSession',message=>{if(current())error.value=message;},current);return;
    // #endif
    uni.setClipboardData({data:url,success:()=>{if(current())error.value='活动商品链接已复制，可发送给朋友';},fail:()=>{if(current())error.value='链接复制失败，请重试';}});
  }catch{if(current())error.value='活动关联商品或操作结果未确认，请重新读取后再试';}finally{if(current())busy=false;}
}
onUnmounted(()=>{disposed=true;generation++;});
</script>
<style scoped>.activity-menu{display:flex;flex-wrap:wrap;align-items:center;gap:18rpx;margin-bottom:12rpx;width:100%;flex-basis:100%}.menu-item{flex:1;min-width:66rpx;text-align:center;font-size:23rpx;padding:10rpx}.menu-error{width:100%;font-size:24rpx;color:#a72823}</style>
