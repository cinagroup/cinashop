<template><ThemePage><view class="share-landing"><text class="title">{{scene&&(scene.type===90||scene.type===91)?'核销资料待核对':'打开分享内容'}}</text><text v-if="loading" role="status">正在核对分享目标…</text><text v-if="error" class="error" role="alert">{{error}}</text><text v-if="notice" class="hint">{{notice}}</text><template v-if="scene"><text class="hint">{{scene.viewer_scope==='owner'?'查看本人资料与订单。':scene.type===90||scene.type===91?'二维码只提供查询目标。进入工作台后仍须核验经营资格、订单与实际次数。':'分享目标已核对，可继续浏览商城。'}}</text><button @tap="open">{{scene.viewer_scope==='owner'?'查看本人资料':scene.type===90||scene.type===91?'前往工作台核对':'打开分享内容'}}</button></template><button v-if="!loading&&token" @tap="load">重新核对分享码</button><button v-if="!auth.isLoggedIn" @tap="login">登录后继续</button><button @tap="home">返回商城首页</button></view></ThemePage></template>
<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import { ref,watch } from 'vue';
import { onLoad,onShow,onHide,onUnload } from '@dcloudio/uni-app';
import { apiShareScene,shareToken,shareDestination,type ShareScene } from '@/api/legacyShare';
import { useAuthStore } from '@/stores/auth';
import { useShareReferral } from '@/composables/useShareReferral';
import { shareScanTransfer } from '@/utils/shareScanTransfer';
const auth=useAuthStore(),{capture,notice}=useShareReferral(),token=ref(''),scene=ref<ShareScene|null>(null),loading=ref(false),error=ref('');let epoch=0,active=true,disposed=false;
async function load(){if(!token.value||loading.value||!active||disposed)return;const current=++epoch;scene.value=null;error.value='';loading.value=true;try{const value=await apiShareScene(token.value);if(current!==epoch||!active||disposed)return;if(value.spid>0)capture(token.value,value.spid);scene.value=value;}catch(e){if(current===epoch&&active&&!disposed)error.value=e instanceof Error?e.message:'分享码暂不可用，请重试';}finally{if(current===epoch&&active&&!disposed)loading.value=false;}}
function open(){if(!scene.value||!active||disposed)return;const value=scene.value,path=shareDestination(value);try{if(value.type===90||value.type===91){if(!auth.isLoggedIn)throw Error('请登录后核对分享资料');if(value.viewer_scope!=='owner')shareScanTransfer.stage(value,auth);}if(path==='/pages/index/index')uni.switchTab({url:path});else uni.navigateTo({url:path,fail:()=>{shareScanTransfer.clear();error.value='分享页面未打开，请重试';}});}catch(e){error.value=e instanceof Error?e.message:'分享资料已变化，请重新核对';}}
function login(){uni.navigateTo({url:'/pages/auth/login'});}function home(){uni.switchTab({url:'/pages/index/index'});}
function applyToken(options:Record<string,unknown>|undefined){try{const next=shareToken(options);if(next===token.value)return;epoch++;shareScanTransfer.clear();token.value=next;scene.value=null;loading.value=false;error.value='';}catch(e){epoch++;shareScanTransfer.clear();token.value='';scene.value=null;loading.value=false;error.value=e instanceof Error?e.message:'分享码无效';}}
function hashToken():Record<string,unknown>|null{
  // #ifdef H5
  if(typeof window!=='undefined'){const hash=window.location.hash.replace(/^#/u,''),at=hash.indexOf('?');if((at<0?hash:hash.slice(0,at))!=='/pages/share/landing')return null;const query=new URLSearchParams(at<0?'':hash.slice(at+1)),options:Record<string,unknown>={};for(const key of query.keys()){if(!['q','scene'].includes(key)||query.getAll(key).length!==1)return {};options[key]=query.get(key);}return options;}
  // #endif
  return null;
}
let removeHashListener=()=>{};
// #ifdef H5
if(typeof window!=='undefined'&&typeof window.addEventListener==='function'){const ownerWindow=window;const changed=()=>{if(!active||disposed)return;const options=hashToken();if(options===null)return;applyToken(options);void load();};ownerWindow.addEventListener('hashchange',changed);removeHashListener=()=>ownerWindow.removeEventListener('hashchange',changed);}
// #endif
onLoad(options=>{applyToken(hashToken()??options);});onShow(()=>{active=true;const options=hashToken();if(options!==null)applyToken(options);void load();});onHide(()=>{active=false;epoch++;scene.value=null;loading.value=false;});onUnload(()=>{disposed=true;epoch++;scene.value=null;removeHashListener();});watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{shareScanTransfer.clear();epoch++;scene.value=null;loading.value=false;error.value='';},{flush:'sync'});
</script>
<style scoped>.share-landing{max-width:680rpx;margin:40rpx auto;padding:32rpx;display:flex;flex-direction:column;gap:24rpx}.title{font-size:36rpx;font-weight:600}.hint{font-size:26rpx;color:#666;line-height:1.8}.error{font-size:26rpx;color:#a72823}.share-landing button{width:100%;font-size:28rpx}</style>
