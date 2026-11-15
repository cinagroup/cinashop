<template>
  <ThemePage><view class="reply-page">
    <view class="heading"><text class="title">逐商品评价</text><view class="muted">每件商品分别评分、填写内容，最多添加8张图片。</view><button :disabled="state.loading || state.busy || state.syncing || state.uploading" @tap="load">刷新评价状态</button></view>
    <view v-if="state.loading" role="status">正在读取评价…</view><view v-if="state.error" class="notice error" role="alert">{{ state.error }}</view><view v-if="state.message" class="notice" role="status">{{ state.message }}</view>
    <template v-if="state.page">
      <view v-if="state.page.reason" class="notice">{{ state.page.reason }}</view>
      <view class="review-lines" role="group" aria-label="选择评价商品"><button v-for="item in state.page.lines" :key="item.id" :class="{selected:state.selected===item.id}" :disabled="state.loading || state.busy || state.syncing || state.uploading" @tap="select(item.id)"><image v-if="item.image" :src="reviewImageSource(item.image)" mode="aspectFill" /><view>{{ item.name }}<view class="muted">{{ item.isGift ? '赠品，无需评价' : item.review ? '已提交' : item.canReply ? '待评价' : '暂不能评价' }}</view></view></button></view>
      <view v-if="line" class="card"><text class="line-title">{{ line.name }}</text><view class="muted">{{ line.sku }}{{ line.price===null?'':' · ¥'+line.price }}</view>
        <template v-if="line.review"><view v-if="communityMessage(line.review.communitySync)" class="notice" role="status">{{ communityMessage(line.review.communitySync) }}</view><button v-if="line.review.communitySync?.status==='pending'" :disabled="!canRetrySync" @tap="retryCommunity">{{ state.syncing ? '同步中…' : '重试社区同步' }}</button><view class="notice">{{ line.review.visible ? '评价已提交' : '评价已提交，暂未公开展示' }}</view><view class="saved-comment">{{ line.review.comment }}</view><view class="muted">总体评价：{{ line.review.replyScore === 3 ? '好评' : line.review.replyScore === 2 ? '中评' : line.review.replyScore === 1 ? '差评' : '历史评分未记录' }} · {{ line.review.addTime }}</view><view v-for="score in scores" :key="score.key" class="muted">{{ score.label }}：{{ line.review?.[score.key] ?? "历史评分未记录" }}</view><view class="images"><image v-for="image in line.review.pics" :key="image" :src="reviewImageSource(image)" mode="aspectFill" /></view></template>
        <view v-else-if="!draft || !line.canReply" class="notice">{{ line.reason || '当前商品无需评价' }}</view>
        <template v-else>
          <view class="field"><text>总体评价</text><view class="ratings"><button v-for="option in overall" :key="option.value" :class="{chosen:draft.body.replyScore===option.value}" :disabled="!canEdit" @tap="draft.body.replyScore=option.value">{{ option.label }}</button></view></view>
          <view v-for="score in scores" :key="score.key" class="field"><text>{{ score.label }}</text><view class="stars" :aria-label="score.label"><button v-for="n in 5" :key="n" :class="{on:n<=draft.body[score.key]}" :disabled="!canEdit" :aria-label="score.label+n+'星'" @tap="draft.body[score.key]=n">★</button></view></view>
          <view class="field"><text>评价内容</text><textarea v-model="draft.body.comment" :disabled="!canEdit" :maxlength="512" class="comment" aria-label="评价内容" placeholder="分享这件商品的使用体验" /><view class="muted">{{ draft.body.comment.length }}/512</view></view>
          <view class="images"><view v-for="(image,index) in draft.images" :key="image.url"><image :src="image.preview" mode="aspectFill" /><button :disabled="!canEdit" @tap="removeImage(index)">移除图片 {{ index+1 }}</button></view></view>
          <button :disabled="!canEdit || draft.images.length>=8" @tap="chooseImages">{{ state.uploading ? '图片上传中…' : '添加评价图片' }}（{{ draft.images.length }}/8）</button><view class="muted">PNG、JPEG、WebP、GIF，每张不超过10 MiB。失败的图片不会随文字提交。</view>
          <view v-if="draft.uploadError" class="notice error" role="alert">{{ draft.uploadError }}<button :disabled="!canEdit" @tap="ignoreUploadError">忽略失败图片，继续文字评价</button></view>
          <checkbox-group class="community-choice" @change="chooseCommunity"><label><checkbox value="community" :checked="draft.body.syncToCommunity===true" :disabled="!canEdit" />同步到社区，按审核规则展示</label></checkbox-group>
          <button class="primary" :disabled="!canEdit || !!draft.uploadError" @tap="submit">{{ state.busy?'提交中…':'提交当前商品评价' }}</button>
        </template>
      </view>
      <button v-if="lottery.allowed" class="primary" @tap="openLottery">评价成功，查看抽奖机会</button>
    </template>
  </view></ThemePage>
</template>
<script setup lang="ts">
import { reviewImageSource } from '@/utils/reviewImage';
import { buyerReviewCommunityMessage as communityMessage } from '../../../../common/buyerReviewCommunitySync';
import ThemePage from '@/components/ThemePage.vue';
import { useBuyerReviews } from '@/composables/useBuyerReviews';
const {state,line,draft,canEdit,canRetrySync,load,select,removeImage,ignoreUploadError,submit,chooseImages,lottery,openLottery,retryCommunity}=useBuyerReviews();
function chooseCommunity(event:{detail:{value:string[]}}){if(canEdit.value&&draft.value)draft.value.body.syncToCommunity=event.detail.value.includes('community');}
const scores=[{key:'productScore',label:'商品质量'},{key:'serviceScore',label:'服务态度'},{key:'logisticsScore',label:'物流速度'}] as const;
const overall=[{value:3,label:'好评'},{value:2,label:'中评'},{value:1,label:'差评'}];
</script>
<style scoped>
.reply-page{min-height:100vh;background:#f6f7f9;padding:28rpx 24rpx 60rpx;box-sizing:border-box;font-size:28rpx;overflow-wrap:anywhere}.reply-page button{font-size:26rpx;margin:16rpx 0;line-height:1.7;padding:16rpx 22rpx;white-space:normal;max-width:100%}.title{font-size:40rpx;font-weight:600}.line-title{font-size:32rpx;font-weight:600}.muted{font-size:24rpx;color:#65717d;line-height:1.7;margin:12rpx 0}.notice{background:#edf5ff;color:#21548b;padding:24rpx;border-radius:12rpx;line-height:1.8;margin:20rpx 0}.error{background:#fff0ef;color:#a32b22}.review-lines button{display:flex;align-items:center;gap:20rpx;text-align:left;background:#fff;border:1px solid #e1e6eb}.review-lines button.selected{border-color:var(--view-theme,#e93323);background:#fff7f6}.review-lines image{width:96rpx;height:96rpx;flex:none}.card{background:#fff;border-radius:16rpx;padding:28rpx;margin:24rpx 0}.field{margin:30rpx 0}.ratings,.stars{display:flex;gap:12rpx}.ratings button{flex:1}.chosen{color:var(--view-theme,#e93323);border:1px solid currentColor}.stars button{padding:8rpx 10rpx;background:transparent;color:#b5bcc5;font-size:44rpx;flex:1;line-height:1.4}.stars button::after{border:none}.stars button.on{color:#e8a12b}.comment{background:#f7f8fa;border-radius:10rpx;margin-top:18rpx;padding:20rpx;width:100%;box-sizing:border-box;min-height:200rpx;font-size:28rpx}.images{display:flex;flex-wrap:wrap;gap:16rpx;margin:20rpx 0}.images image{width:160rpx;height:160rpx;border-radius:10rpx}.images button{font-size:22rpx;padding:8rpx;margin:8rpx 0}.primary{background:var(--view-theme,#e93323);color:#fff}.primary[disabled]{opacity:.5}.community-choice{display:block;margin:28rpx 0;line-height:1.8}.community-choice label{display:flex;align-items:center;gap:12rpx}.saved-comment{white-space:pre-wrap;line-height:1.8;margin:24rpx 0}
</style>
