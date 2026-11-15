<template>
  <section class="buyer-reviews" aria-label="逐商品评价">
    <div class="review-heading"><div><strong>逐商品评价</strong><p>每件商品分别评分、填写内容，最多添加8张图片。</p></div><el-button :disabled="state.loading || state.busy || state.uploading" @click="load">刷新评价状态</el-button></div>
    <p v-if="state.loading" role="status">正在读取评价…</p><p v-if="state.error" class="notice error" role="alert">{{ state.error }}</p><p v-if="state.message" class="notice" role="status">{{ state.message }}</p>
    <template v-if="state.page">
      <p v-if="state.page.reason" class="notice">{{ state.page.reason }}</p>
      <div class="review-lines" role="group" aria-label="选择评价商品"><button v-for="item in state.page.lines" :key="item.id" type="button" :class="{selected:state.selected===item.id}" :disabled="state.loading || state.busy || state.uploading" :aria-pressed="state.selected===item.id" @click="select(item.id)"><ProductImage :src="item.image" :alt="item.name" /><span>{{ item.name }}<small>{{ item.isGift ? '赠品，无需评价' : item.review ? '已提交' : item.canReply ? '待评价' : '暂不能评价' }}</small></span></button></div>
      <article v-if="line" class="review-editor"><h3>{{ line.name }}</h3><p class="muted">{{ line.sku }}{{ line.price === null ? '' : ' · ¥'+line.price }}</p>
        <template v-if="line.review"><p class="notice">{{ line.review.visible ? '评价已提交' : '评价已提交，暂未公开展示' }}</p><p class="saved-comment">{{ line.review.comment }}</p><p class="muted">总体评价：{{ line.review.replyScore === 3 ? '好评' : line.review.replyScore === 2 ? '中评' : line.review.replyScore === 1 ? '差评' : '历史评分未记录' }} · {{ line.review.addTime }}</p><p v-for="score in scores" :key="score.key" class="muted">{{ score.label }}：{{ line.review?.[score.key] ?? "历史评分未记录" }}</p><div class="review-images"><img v-for="image in line.review.pics" :key="image" :src="image" alt="已提交评价图片" /></div></template>
        <p v-else-if="!draft || !line.canReply" class="notice">{{ line.reason || '当前商品无需评价' }}</p>
        <el-form v-else label-position="top" :disabled="!canEdit" @submit.prevent="submit">
          <el-form-item label="总体评价"><el-radio-group v-model="draft.body.replyScore" aria-label="总体评价"><el-radio :value="3">好评</el-radio><el-radio :value="2">中评</el-radio><el-radio :value="1">差评</el-radio></el-radio-group></el-form-item>
          <el-form-item v-for="score in scores" :key="score.key" :label="score.label"><el-rate v-model="draft.body[score.key]" :aria-label="score.label" /></el-form-item>
          <el-form-item label="评价内容"><el-input v-model="draft.body.comment" type="textarea" :rows="4" :maxlength="512" show-word-limit aria-label="评价内容" placeholder="分享这件商品的使用体验" /></el-form-item>
          <div class="review-images"><div v-for="(image,index) in draft.images" :key="image.url"><img :src="image.preview" alt="待提交评价图片" /><el-button :disabled="!canEdit" @click="removeImage(index)">移除图片 {{ index+1 }}</el-button></div></div>
          <label class="file-label">{{ state.uploading ? '图片上传中…' : '添加评价图片' }}（{{ draft.images.length }}/8）<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple :disabled="!canEdit || draft.images.length>=8" aria-label="添加评价图片" @change="filesChanged" /></label>
          <p class="muted">PNG、JPEG、WebP、GIF，每张不超过10 MiB。失败的图片不会随文字提交。</p>
          <div v-if="draft.uploadError" class="notice error" role="alert">{{ draft.uploadError }} <el-button :disabled="!canEdit" @click="ignoreUploadError">忽略失败图片，继续文字评价</el-button></div>
          <el-button type="primary" native-type="submit" :loading="state.busy" :disabled="!canEdit || !!draft.uploadError">提交当前商品评价</el-button>
        </el-form>
      </article>
      <p v-if="lottery" class="notice">本次评价已获得抽奖机会，可前往手机端抽奖页查看。</p>
    </template>
  </section>
</template>
<script setup lang="ts">
import { ref,toRef,watch } from 'vue';
import ProductImage from './ProductImage.vue';
import { useBuyerReviews } from '@/composables/useBuyerReviews';
const props=defineProps<{orderNo:string}>(),emit=defineEmits<{busy:[value:boolean];completed:[]}>(),lottery=ref(false);
const {state,line,draft,canEdit,load,select,removeImage,ignoreUploadError,submit,upload}=useBuyerReviews(toRef(props,'orderNo'),ack=>{lottery.value=ack.toLottery;if(ack.completed)emit('completed');});
const scores=[{key:'productScore',label:'商品质量'},{key:'serviceScore',label:'服务态度'},{key:'logisticsScore',label:'物流速度'}] as const;
watch(()=>state.busy||state.uploading,value=>emit('busy',value),{flush:'sync'});
function filesChanged(event:Event){const input=event.target as HTMLInputElement,files=Array.from(input.files??[]);input.value='';void upload(files);}
</script>
<style scoped>
.buyer-reviews{overflow-wrap:anywhere;max-height:calc(80vh - 120px);overflow-y:auto}.review-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}.review-heading strong{font-size:18px}.review-heading p,.muted{font-size:13px;color:#65717d;line-height:1.7}.review-lines{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}.review-lines button{display:flex;flex:1 1 200px;min-width:0;align-items:center;gap:10px;text-align:left;border:1px solid #dce2e8;background:white;border-radius:8px;padding:10px;max-width:100%;cursor:pointer;color:inherit}.review-lines button.selected{border-color:#e93323;background:#fff7f6}.review-lines :deep(img),.review-lines :deep(.product-media){width:48px;height:48px;flex:none;object-fit:cover}.review-lines button>span:last-child{flex:1;min-width:0}.review-lines small{display:block;margin-top:5px;color:#65717d}.review-editor{padding:16px 0;border-top:1px solid #e7ebf0}.review-editor h3{margin:0}.notice{background:#edf5ff;color:#21548b;padding:12px;border-radius:8px;line-height:1.7}.notice.error{background:#fff0ef;color:#a32b22}.saved-comment{white-space:pre-wrap}.review-images{display:flex;flex-wrap:wrap;gap:12px;margin:14px 0}.review-images>div{display:flex;flex-direction:column;gap:6px}.review-images img{width:90px;height:90px;object-fit:cover;border-radius:6px}.file-label{display:flex;gap:12px;flex-wrap:wrap;font-size:14px;line-height:1.8}.file-label input{max-width:100%}
</style>
