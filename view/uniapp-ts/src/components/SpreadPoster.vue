<template>
  <view class="spread-poster">
    <canvas id="spread-poster-canvas" canvas-id="spread-poster-canvas" :width="width" :height="height" class="canvas" :style="{width:width+'px',height:height+'px'}" aria-label="当前账号昵称头像、推广模板与真实二维码海报" />
    <view v-if="error" class="error" role="alert">{{ error }}</view><view v-if="drawing" role="status">正在合成推广海报…</view>
    <view class="buttons"><button :disabled="drawing||saving" @tap="draw">重新合成</button><button :disabled="!ready||drawing||saving" :loading="saving" @tap="save">{{ web?'预览并保存海报':'保存海报到相册' }}</button></view>
    <text class="tip">{{ web?'打开海报后可长按保存；分享码打开对应站点或正式小程序。':'保存后可发送给微信好友；扫码关系由系统按账号资格核对。' }}</text>
  </view>
</template>
<script setup lang="ts">
import { getCurrentInstance, ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { readableShareImage } from '@/utils/shareImage';
import { useAuthStore } from '@/stores/auth';
const props = defineProps<{ template: string; avatar: string; nickname: string; siteName: string; code: string; active: boolean; ownerUid: number; ownerVersion: number }>();
const auth = useAuthStore(), instance = getCurrentInstance(), width = 320, height = 500;
const drawing = ref(false), ready = ref(false), saving = ref(false), error = ref(''); let epoch = 0, disposed = false, web = false;
// #ifdef H5
web = typeof window !== 'undefined';
// #endif
let releases: (() => void)[] = [];
function clean() { releases.forEach(release => release()); releases = []; }
function clearCanvas() { const canvas = uni.createCanvasContext('spread-poster-canvas', instance?.proxy ?? undefined); canvas.setFillStyle('#fff'); canvas.fillRect(0,0,width,height); canvas.draw(false); }
async function draw() {
  const current = ++epoch; clean(); ready.value = false; saving.value = false; drawing.value = false; error.value = ''; if (disposed) return; clearCanvas();
  if (!props.active || !auth.isLoggedIn || props.ownerUid !== auth.uid || props.ownerVersion !== auth.sessionVersion) return;
  const actor = { uid: auth.uid, token: auth.token, version: auth.sessionVersion }, valid = () => !disposed && props.active && current === epoch && actor.uid === auth.uid && actor.token === auth.token && actor.version === auth.sessionVersion;
  drawing.value = true; const own: (() => void)[] = []; let failed = false;
  try {
    const files = await Promise.all([props.template, props.code, props.avatar].map(async source => { if(!source)return '';const file = await readableShareImage(source); let released = false; const release = () => { if (!released) { released = true; file.release(); } };
      if (failed || !valid()) { release(); return ''; } own.push(release); return file.path; }));
    if (!valid()) { own.forEach(release => release()); return; } releases = own;
    await nextTick(); if (!valid()) return;
    const canvas = uni.createCanvasContext('spread-poster-canvas', instance?.proxy ?? undefined);
    canvas.setFillStyle('#fff'); canvas.fillRect(0,0,width,height); canvas.drawImage(files[0]!,0,0,width,320); canvas.setFillStyle('#fff'); canvas.fillRect(0,320,width,180);
    if (props.avatar && files[2]) canvas.drawImage(files[2],18,339,44,44);
    canvas.setFillStyle('#202020'); canvas.setFontSize(14); canvas.fillText([...props.nickname].slice(0,15).join(''),props.avatar?74:18,357);
    canvas.setFillStyle('#666'); canvas.setFontSize(11); canvas.fillText([...props.siteName].slice(0,21).join(''),props.avatar?74:18,378);
    canvas.drawImage(files[1]!,194,340,108,108); canvas.setFillStyle('#666'); canvas.fillText('邀你一起发现好物',18,418); canvas.fillText('扫码进入商城',18,440);
    canvas.draw(false,()=>{if(valid()){ready.value=true;drawing.value=false;}});
  } catch(e) { failed = true; own.forEach(release=>release()); if(valid()){error.value=e instanceof Error?e.message:'海报合成失败，请重试';drawing.value=false;} }
}
function save() {
  if (!ready.value || saving.value || drawing.value || !props.active || disposed) return;
  const current = epoch, valid = () => !disposed && props.active && current === epoch; saving.value = true; error.value = '';
  uni.canvasToTempFilePath({canvasId:'spread-poster-canvas',width,height,destWidth:640,destHeight:1000,fileType:'png',success:file=>{
    if(!valid())return; if(web){uni.previewImage({urls:[file.tempFilePath],current:file.tempFilePath});saving.value=false;return;}
    uni.saveImageToPhotosAlbum({filePath:file.tempFilePath,success:()=>{if(valid()){saving.value=false;uni.showToast({title:'推广海报已保存',icon:'success'});}},fail:()=>{if(valid()){saving.value=false;error.value='相册保存失败，请允许相册权限后重试';}}});
  },fail:()=>{if(valid()){saving.value=false;error.value='海报导出失败，图片来源可能不允许导出，请重试';}}},instance?.proxy ?? undefined);
}
watch(()=>[props.template,props.avatar,props.nickname,props.siteName,props.code,props.active,props.ownerUid,props.ownerVersion,auth.uid,auth.token,auth.sessionVersion],()=>{void draw();},{flush:'sync'});
onMounted(()=>{void draw();}); onUnmounted(()=>{disposed=true;epoch++;clean();});
</script>
<style scoped>.spread-poster{margin-top:24rpx}.canvas{max-width:100%;margin:auto;background:#fff;border-radius:20rpx}.buttons{display:flex;gap:16rpx;margin-top:20rpx}.buttons button{flex:1;font-size:25rpx}.tip{display:block;font-size:24rpx;color:#666;line-height:1.7;margin-top:18rpx}.error{color:#a72823;padding:18rpx 0;font-size:25rpx}</style>
