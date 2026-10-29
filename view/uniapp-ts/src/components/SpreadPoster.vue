<template>
 <view class="spread-poster">
  <view class="poster-art">
   <image v-if="poster" :key="preview.key" class="poster-image" :src="poster" mode="aspectFit" show-menu-by-longpress aria-label="本人推广海报" @error="preview.fail" />
   <image v-else-if="!selected" class="poster-image" :src="template" mode="aspectFit" aria-label="待生成的推广模板" />
   <canvas :id="canvasId" :canvas-id="canvasId" :width="width" :height="height" class="canvas" :style="{width:width+'px',height:height+'px'}" aria-label="当前账号昵称头像、推广模板与真实二维码海报" />
  </view>
  <template v-if="selected">
   <view v-if="error" class="error" role="alert">{{error}}</view><view v-if="drawing" role="status" class="status">海报生成中…</view>
   <view class="pic-list">
    <button class="item" :disabled="!ready||drawing||saving" :loading="saving" @tap="save"><image src="/static/php-spread-poster/haibao.png"/><text>{{web?'预览海报':'保存海报'}}</text></button>
    <!-- #ifdef MP-WEIXIN -->
    <button v-if="sharePath" class="item" open-type="share" :disabled="!ready||drawing||saving"><image src="/static/php-spread-poster/weixin.png"/><text>微信好友</text></button>
    <!-- #endif -->
    <!-- #ifdef APP-PLUS -->
    <button class="item" :disabled="!ready||drawing||saving" @tap="share"><image src="/static/php-spread-poster/weixin.png"/><text>微信好友</text></button>
    <!-- #endif -->
   </view>
   <text class="tip">{{web?'长按海报保存图片，或打开预览后保存。':'保存海报后可分享给好友。'}}</text>
   <button class="retry" :disabled="drawing||saving" @tap="draw">重新生成当前海报</button>
  </template>
 </view>
</template>
<script setup lang="ts">
import {getCurrentInstance,ref,computed,watch,onMounted,onUnmounted,onScopeDispose,nextTick} from 'vue';
import {readableShareImage} from '@/utils/shareImage';
import {spreadPosterDeadline,spreadInvitation} from '@/utils/spreadPoster';
import {useAuthStore} from '@/stores/auth';
const props=withDefaults(defineProps<{template:string;avatar:string;nickname:string;siteName:string;code:string;active:boolean;ownerUid:number;ownerVersion:number;canvasId?:string;selected?:boolean;sharePath?:string}>(),{canvasId:'spread-poster-canvas',selected:true,sharePath:''});
const emit=defineEmits<{generated:[image:string]}>();
const auth=useAuthStore(),instance=getCurrentInstance(),width=305,height=473;
const drawing=ref(false),ready=ref(false),saving=ref(false),error=ref(''),poster=ref(''),revision=ref(0);let epoch=0,disposed=false,web=false,previewing=false;
// #ifdef H5
web=typeof window!=='undefined';
// #endif
let releases:(()=>void)[]=[];
function clean(){releases.forEach(release=>release());releases=[];}
function owned(){try{return !disposed&&props.active&&auth.isLoggedIn&&props.ownerUid===auth.uid&&props.ownerVersion===auth.sessionVersion&&uni.getStorageSync('uni_token')===auth.token&&Number(uni.getStorageSync('uni_uid'))===auth.uid;}catch{return false;}}
function unexpired(){const deadline=spreadPosterDeadline([props.template,props.avatar,props.code]);return deadline===null||Date.now()<deadline;}
function allowed(){return owned()&&props.selected!==false&&unexpired();}
function reset(){epoch++;revision.value++;clean();if(previewing){previewing=false;uni.closePreviewImage?.({success:()=>{},fail:()=>{}});}poster.value='';ready.value=drawing.value=saving.value=false;error.value='';emit('generated','');}
function clearCanvas(){const canvas=uni.createCanvasContext(props.canvasId,instance?.proxy??undefined);canvas.setFillStyle('#fff');canvas.fillRect(0,0,width,height);canvas.draw(false);}
async function draw(){
 reset();if(!allowed()){if(owned()&&!unexpired())error.value='推广图片已过期，请重新读取推广资料';return;}
 const current=epoch,actor={uid:auth.uid,token:auth.token,version:auth.sessionVersion};
 const valid=()=>allowed()&&current===epoch&&actor.uid===auth.uid&&actor.token===auth.token&&actor.version===auth.sessionVersion;
 clearCanvas();drawing.value=true;const own:(()=>void)[]=[];let failed=false;
 try{
  const files=await Promise.all([props.template,props.code,props.avatar].map(async source=>{if(!source)return '';const file=await readableShareImage(source);let released=false;const release=()=>{if(!released){released=true;file.release();}};if(failed||!valid()){release();return '';}own.push(release);return file.path;}));
  if(!valid()){own.forEach(release=>release());return;}releases=own;await nextTick();if(!valid())return;
  const canvas=uni.createCanvasContext(props.canvasId,instance?.proxy??undefined);
  canvas.setFillStyle('#fff');canvas.fillRect(0,0,width,height);canvas.drawImage(files[0]!,0,0,width,height);
  canvas.drawImage(files[1]!,width-86,386,70,70);canvas.setFontSize(16);canvas.setFillStyle('#333');canvas.fillText([...props.nickname].slice(0,15).join(''),45,414);
  canvas.setFillStyle('#999999');canvas.setFontSize(12);spreadInvitation(props.siteName).forEach((row,index)=>canvas.fillText(row,16,index?456:440));
  if(props.avatar&&files[2]){canvas.save();canvas.beginPath();canvas.arc(28,408,12,0,Math.PI*2);canvas.clip();canvas.drawImage(files[2],16,396,24,24);canvas.restore();}
  await new Promise<void>((resolve,reject)=>canvas.draw(false,()=>{
   if(!valid()){resolve();return;}
   uni.canvasToTempFilePath({canvasId:props.canvasId,width,height,destWidth:610,destHeight:946,fileType:'png',success:file=>{if(valid()){poster.value=file.tempFilePath;ready.value=true;emit('generated',file.tempFilePath);}resolve();},fail:()=>reject(Error('海报导出失败，图片来源可能不允许导出，请重试'))},instance?.proxy??undefined);
  }));
 }catch(reason){failed=true;if(valid()){error.value=reason instanceof Error?reason.message:'海报合成失败，请重试';poster.value='';ready.value=false;emit('generated','');}}
 finally{own.forEach(release=>release());if(current===epoch){releases=[];drawing.value=false;}}
}
const preview=computed(()=>{const ticket=revision.value,image=poster.value;return{key:ticket+':'+image,fail:()=>{if(owned()&&ticket===revision.value&&image===poster.value){reset();error.value='海报图片无法显示，请重新生成';}}};});
function save(){
 if(!ready.value||saving.value||drawing.value||!allowed()||!poster.value)return;
 const current=epoch,image=poster.value,valid=()=>allowed()&&current===epoch&&poster.value===image;saving.value=true;error.value='';
 if(web){previewing=true;uni.previewImage({urls:[image],current:image,fail:()=>{if(valid()){previewing=false;error.value='海报预览失败，请重试';}}});saving.value=false;return;}
 uni.saveImageToPhotosAlbum({filePath:image,success:()=>{if(valid()){saving.value=false;uni.showToast({title:'推广海报已保存',icon:'success'});}},fail:()=>{if(valid()){saving.value=false;error.value='相册保存失败，请允许相册权限后重试';}}});
}
function share(){
 // #ifdef APP-PLUS
 if(!ready.value||saving.value||drawing.value||!allowed()||!poster.value)return;
 const ticket=epoch;saving.value=true;error.value='';uni.share({provider:'weixin',scene:'WXSceneSession',type:2,imageUrl:poster.value,success:()=>{if(ticket===epoch&&allowed())saving.value=false;},fail:()=>{if(ticket===epoch&&allowed()){saving.value=false;error.value='微信分享未完成，请重试';}}});
 // #endif
}
watch(()=>[props.template,props.avatar,props.nickname,props.siteName,props.code,props.active,props.ownerUid,props.ownerVersion,auth.uid,auth.token,auth.sessionVersion],()=>{reset();if(props.selected!==false)void draw();},{flush:'sync'});
watch(()=>props.selected,selected=>{epoch++;clean();drawing.value=saving.value=false;if(selected){if(poster.value&&owned()&&unexpired()){ready.value=true;emit('generated',poster.value);}else void draw();}else ready.value=false;},{flush:'sync'});
onMounted(()=>{if(props.selected!==false)void draw();});
function dispose(){if(disposed)return;disposed=true;reset();}onUnmounted(dispose);onScopeDispose(dispose);
</script>
<style scoped>
.spread-poster{width:100%;height:100%}.poster-art{width:100%;aspect-ratio:305/473;position:relative;background:#fff;border-radius:32rpx;overflow:hidden}.poster-image{display:block;width:100%;height:100%}.canvas{position:absolute;left:-10000px;top:0;transform-origin:left top}.pic-list{display:flex;justify-content:center;align-items:flex-start;gap:80rpx;margin-top:30rpx}.item{padding:0;margin:0;background:transparent;font-size:26rpx;color:#666;line-height:1.4;display:flex;flex-direction:column;align-items:center}.item:after{border:0}.item image{width:96rpx;height:96rpx;margin-bottom:24rpx}.item[disabled]{opacity:.5}.tip{display:block;text-align:center;font-size:24rpx;color:#666;line-height:1.7;margin:18rpx 0}.retry{background:transparent;font-size:24rpx;color:#666}.retry:after{border:0}.error,.status{text-align:center;padding:14rpx 0;font-size:24rpx}.error{color:#a72823}
</style>
