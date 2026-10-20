<template><view class="legacy-share-code"><button :disabled="loading" @tap="generate">{{ loading?'正在生成二维码…':code?'重新生成二维码':title||'生成分享二维码' }}</button><view v-if="error" class="error" role="alert">{{error}}</view><image v-if="code" class="qr" :src="code" mode="aspectFit" show-menu-by-longpress @tap="preview"/><view v-if="code" class="buttons"><button @tap="preview">预览二维码</button><button :loading="saving" :disabled="saving" @tap="save">{{ web?'打开图片保存':'保存到相册' }}</button></view><text v-if="type===90||type===91" class="hint">此码只供授权人员查询与核对，请勿公开分享。生成二维码不会执行付款或核销。</text></view></template>
<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue';
import { onHide, onShow } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiLegacyShareCode, type LegacyShareType } from '@/api/legacyShare';
import { getFormType } from '@/utils/request';
import { readableShareImage } from '@/utils/shareImage';
const props=defineProps<{type:LegacyShareType;id:number;bargainUserId?:number;orderId?:string;time?:string;status?:string;title?:string}>();
const auth=useAuthStore(),code=ref(''),loading=ref(false),saving=ref(false),error=ref('');let epoch=0,active=true,disposed=false,web=false;
// #ifdef H5
web=typeof window!=='undefined';
// #endif
function clear(){epoch++;code.value='';loading.value=false;saving.value=false;error.value='';}
async function generate(){if(!active||disposed||loading.value)return;clear();const current=epoch;loading.value=true;
  try{const value=await apiLegacyShareCode(props.type,props.id,{...(props.bargainUserId!==undefined?{bargain_user_id:props.bargainUserId}:{}),...(props.orderId?{order_id:props.orderId}:{}),...(props.time?{time:props.time}:{}),...(props.status?{status:props.status}:{})});if(current!==epoch||!active||disposed)return;const image=getFormType()==='routine'?value.routineUrl:value.wechatUrl;if(!image)throw Error('当前平台二维码暂不可用，请重试');code.value=image;}
  catch(e){if(current===epoch&&active&&!disposed)error.value=e instanceof Error?e.message:'二维码生成失败，请重试';}finally{if(current===epoch&&active&&!disposed)loading.value=false;}}
async function preview(){if(!code.value||!active||disposed)return;const current=epoch;try{const file=await readableShareImage(code.value);if(current===epoch&&active&&!disposed)uni.previewImage({urls:[file.path],current:file.path,complete:file.release});else file.release();}catch(e){if(current===epoch&&active&&!disposed)error.value=e instanceof Error?e.message:'图片预览失败';}}
async function save(){if(!code.value||saving.value||!active||disposed)return;if(web){await preview();return;}const current=epoch;saving.value=true;try{const file=await readableShareImage(code.value);if(current!==epoch||!active||disposed){file.release();return;}uni.saveImageToPhotosAlbum({filePath:file.path,success:()=>{if(current===epoch&&active&&!disposed)uni.showToast({title:'图片已保存',icon:'success'});},fail:()=>{if(current===epoch&&active&&!disposed)error.value='保存失败，请允许相册权限后重试';},complete:()=>{file.release();if(current===epoch&&active&&!disposed)saving.value=false;}});}catch(e){if(current===epoch&&active&&!disposed){error.value=e instanceof Error?e.message:'图片保存失败';saving.value=false;}}}
watch(()=>[props.type,props.id,props.bargainUserId,props.orderId,props.time,props.status,auth.uid,auth.token,auth.sessionVersion],clear,{flush:'sync'});onHide(()=>{active=false;clear();});onShow(()=>{active=true;});onUnmounted(()=>{disposed=true;clear();});
</script>
<style scoped>.legacy-share-code{margin:24rpx 0;padding:24rpx;background:#fff;border-radius:20rpx}.qr{display:block;width:360rpx;height:360rpx;margin:20rpx auto}.buttons{display:flex;gap:12rpx}.buttons button{flex:1;font-size:25rpx}.hint{display:block;color:#666;font-size:23rpx;line-height:1.7;margin-top:18rpx}.error{color:#a72823;font-size:25rpx;padding:18rpx 0}</style>
