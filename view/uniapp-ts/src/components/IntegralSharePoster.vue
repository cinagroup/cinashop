<template>
  <view class="poster-panel">
    <view class="poster-title">商品分享海报</view>
    <view class="poster-note">{{ note || '二维码打开商品网页；不代表微信小程序码。商品价格为所选规格参考价，库存与积分以结算复核为准。' }}</view>
    <canvas :id="canvasId || 'integral-share-poster'" :canvas-id="canvasId || 'integral-share-poster'" :width="width" :height="height"
      class="poster-canvas" :style="{width:`${width}px`,height:`${height}px`}" aria-label="商品图片、参考价格与真实页面URL二维码海报" />
    <view v-if="error" class="poster-error" role="alert">{{ error }}</view>
    <button size="mini" :disabled="drawing || saving || (!url && !qrImage)" @tap="draw">{{ drawing ? '正在生成海报' : '重新生成海报' }}</button>
    <button :disabled="!ready || drawing || saving" :loading="saving" @tap="save">{{ web ? '打开海报图片' : '保存海报到相册' }}</button>
  </view>
</template>
<script setup lang="ts">
import { getCurrentInstance, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import QRCode from 'qrcode-terminal/vendor/QRCode';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel';
import { integralImage } from '../../../common/integralPurchase';
import { useThemeStore } from '@/stores/theme';
import { productShareCode } from '@/api/productDetailDesign';
const theme = useThemeStore();
const props = defineProps<{ url: string; title: string; image: string; price: string; integral: number; siteName: string; tagline: string; quoteText?:string;note?:string;canvasId?:string;qrImage?:string }>();
const instance = getCurrentInstance(), width = 320, height = 580;
const drawing = ref(false), saving = ref(false), ready = ref(false), error = ref('');
let generation = 0, disposed = false;
let web = false;
// #ifdef H5
web = typeof window !== 'undefined';
// #endif
function imageInfo(source: string): Promise<string> {
  return new Promise((resolve, reject) => { uni.getImageInfo({ src: source, success: result => resolve(result.path), fail: () => reject(new Error('商品图片无法读取，请刷新商品后重试')) }); });
}
function lines(text: string, count: number, maxLines: number): string[] {
  const chars = [...text], result: string[] = [];
  for (let index = 0; index < Math.min(chars.length, count * maxLines); index += count) result.push(chars.slice(index, index + count).join(''));
  if (chars.length > count * maxLines && result.length) result[result.length - 1] = result[result.length - 1].slice(0, -1) + '…';
  return result;
}
async function draw() {
  const current = ++generation;
  ready.value = false; error.value = ''; drawing.value = true;
  try {
    if (!props.url && !props.qrImage) throw new Error('商家尚未配置可分享的站点链接');
    const qr = props.qrImage ? null : new QRCode(0, QRErrorCorrectLevel.M);
    if(qr){qr.addData(props.url);qr.make();}
    const count = qr?.getModuleCount() ?? 0; if (qr && (count < 21 || count > 177)) throw new Error('分享链接超出二维码容量');
    const safeImage = integralImage(props.image), image = safeImage ? await imageInfo(safeImage) : '';
    if(disposed || current!==generation)return;
    const officialImage=props.qrImage?await imageInfo(productShareCode(props.qrImage,props.qrImage.startsWith('data:')?'routine':'wechat')):'';
    await nextTick(); if (disposed || current !== generation) return;
    const context = uni.createCanvasContext(props.canvasId || 'integral-share-poster', instance?.proxy ?? undefined);
    context.setFillStyle('#ffffff'); context.fillRect(0,0,width,height);
    if (image) context.drawImage(image,12,12,296,210);
    else { context.setFillStyle('#f4f4f4'); context.fillRect(12,12,296,210); context.setFillStyle('#777777'); context.setFontSize(12); context.fillText('暂无商品图片',110,118); }
    context.setFillStyle('#202020'); context.setFontSize(14); lines(props.title,20,2).forEach((line,index)=>context.fillText(line,12,243+index*20));
    context.setFillStyle(theme.preset.priceColor); context.setFontSize(14); context.fillText(props.quoteText ?? `${props.integral}积分 + ¥${props.price}`,12,292);
    context.setFillStyle('#666666'); context.setFontSize(11); lines([props.siteName, props.tagline].filter(Boolean).join(' · '),22,2).forEach((line,index)=>context.fillText(line,12,315+index*15));
    if(officialImage)context.drawImage(officialImage,60,345,200,200);
    else if(qr){const quiet=4,cell=Math.max(1,Math.floor(200/(count+quiet*2))),size=(count+quiet*2)*cell,x=Math.floor((width-size)/2),y=345;
      context.setFillStyle('#ffffff'); context.fillRect(x,y,size,size); context.setFillStyle('#172a42');
      for(let row=0;row<count;row++) for(let column=0;column<count;column++) if(qr.isDark(row,column)) context.fillRect(x+(column+quiet)*cell,y+(row+quiet)*cell,cell,cell);
    }
    context.setFillStyle('#666666');context.setFontSize(11);context.fillText('扫码查看商品 · 最终价格以结算为准',65,566);
    context.draw(false,()=>{if(!disposed && current===generation){ready.value=true;drawing.value=false;}});
  } catch(e) {if(!disposed && current===generation){error.value=e instanceof Error?e.message:'海报生成失败';drawing.value=false;}}
}
function save() {
  if (!ready.value || drawing.value || saving.value || disposed) return;
  const current=generation;saving.value=true;error.value='';
  uni.canvasToTempFilePath({canvasId:props.canvasId || 'integral-share-poster',width,height,destWidth:width*2,destHeight:height*2,fileType:'png',success:result=>{
    if(disposed || current!==generation)return;
    if(web){uni.previewImage({urls:[result.tempFilePath],current:result.tempFilePath});saving.value=false;return;}
    uni.saveImageToPhotosAlbum({filePath:result.tempFilePath,success:()=>{if(!disposed && current===generation){saving.value=false;uni.showToast({title:'海报已保存',icon:'success'});}},fail:()=>{if(!disposed && current===generation){saving.value=false;error.value='保存失败，请检查相册权限后重试';}}});
  },fail:()=>{if(!disposed && current===generation){saving.value=false;error.value='海报导出失败，请重试；外部图片可能未允许导出';}}},instance?.proxy ?? undefined);
}
onMounted(()=>{void draw();});
watch(()=>[props.url,props.title,props.image,props.price,props.integral,props.quoteText,props.canvasId,props.qrImage,theme.displayStatus],()=>{saving.value=false;void draw();});
onUnmounted(()=>{disposed=true;generation++;});
</script>
<style scoped>
.poster-panel {margin-top:24rpx;border-top:1rpx solid #eee;padding-top:24rpx;}.poster-title {font-size:30rpx;font-weight:600;}.poster-note {font-size:24rpx;color:#666;line-height:1.7;margin:16rpx 0;}.poster-canvas {display:block;max-width:420px;margin:0 auto;background:#fff;}.poster-error {color:#a72823;font-size:25rpx;line-height:1.7;margin:16rpx 0;}
</style>
