<template>
  <view class="refund-detail">
    <view class="actions"><button size="mini" :disabled="busy" @tap="load()">重新读取详情</button>
      <button size="mini" :disabled="busy" @tap="goList">退款记录</button>
      <button v-if="!auth.isLoggedIn" size="mini" :disabled="busy" @tap="login">登录后查看</button></view>
    <view v-if="routeError || state.error || navigationError" class="notice">{{ routeError || state.error || navigationError }}</view>
    <view v-if="state.operationError" class="notice">{{ state.operationError }}</view>
    <view v-if="state.loading" class="notice">正在读取退款详情…</view>
    <template v-if="detail">
      <view class="status-card" :class="{ done: isDone }"><view class="status-text">{{ statusText }}</view><view>{{ statusSub }}</view></view>
      <view class="info-card">
        <view class="info-row"><text>退款单号</text><text>#{{ detail.id }} · {{ detail.refundNo }}</text></view>
        <view class="info-row"><text>订单编号</text><text>{{ detail.orderId }}</text></view>
        <view class="info-row"><text>退款金额</text><text>¥{{ detail.refundPrice }}</text></view>
        <view class="info-row"><text>已退金额</text><text>¥{{ detail.refundedPrice }}</text></view>
        <view class="info-row"><text>申请件数</text><text>{{ detail.refundNum }}</text></view>
        <view class="info-row"><text>退款原因</text><text>{{ detail.refundReason }}</text></view>
        <view v-if="detail.refundExplain" class="info-row"><text>补充说明</text><text>{{ detail.refundExplain }}</text></view>
        <view class="info-row"><text>申请时间</text><text>{{ refundTime(detail.addTime) }}</text></view>
        <view v-if="detail.refuseReason" class="info-row"><text>拒绝原因</text><text>{{ detail.refuseReason }}</text></view>
      </view>
      <view class="items-card"><view class="card-title">退款商品</view>
        <view v-if="detail.itemsError" class="notice">{{ detail.itemsError }}</view>
        <view v-for="item in detail.items" :key="item.id" class="item-row">
          <image v-if="item.image && !failedImages.includes(item.id)" :src="item.image" :alt="item.name" mode="aspectFill" class="item-image" @error="imageFailed(item)" />
          <view v-else class="item-image image-unavailable">{{ item.image ? '图片加载失败' : '暂无商品图片' }}</view>
          <view class="item-text"><view>{{ item.name }}</view><view>{{ item.sku }}</view>
            <view>本次申请数量：{{ item.quantity === null ? '旧快照未注明，请核对总件数' : item.quantity }}</view></view>
        </view>
      </view>
      <view v-if="detail.returnContact" class="info-card"><view class="card-title">退货收件信息</view>
        <view>{{ detail.returnContact.name || '收件人未配置' }} · {{ detail.returnContact.phone || '电话未配置' }}</view>
        <view>{{ detail.returnContact.address || '退货地址未配置，请先联系商家' }}</view>
      </view>
      <view v-if="detail.refundExpress" class="info-card"><view class="card-title">已提交的退货物流</view>
        <view>{{ detail.refundExpressName }} · {{ detail.refundExpress }}</view><view v-if="detail.refundPhone">寄件人电话：{{ detail.refundPhone }}</view><view>{{ detail.refundGoodsExplain }}</view>
        <view v-if="detail.returnImagesError" class="notice">{{ detail.returnImagesError }}</view>
        <view class="evidence"><image v-for="item in detail.returnImages" :key="item.url" :src="item.src" mode="aspectFit" alt="已提交的退货凭证" /></view></view>
      <view v-if="returnEligible(detail)" class="info-card return-form"><view class="card-title">填写退货物流</view>
        <view v-if="state.shipment.outcome === 'unknown'" class="notice">物流提交结果尚未确认，请勿重复操作。请保留运单，先核对提交结果。<button size="mini" :disabled="busy" @tap="load()">核对物流提交结果</button></view>
        <view>请核对上方收件信息，寄出后再提交。重新读取会清空未提交内容。</view>
        <view v-if="state.shipment.carriersError" class="notice">{{ state.shipment.carriersError }}；可重新读取详情重试。</view>
        <view>快递公司</view><picker :disabled="!canReturn" :range="state.shipment.carriers" range-key="name" @change="chooseCarrier"><view class="field">{{ carrierName || '请选择快递公司' }}</view></picker>
        <view>物流单号</view><input v-model="state.shipment.form.tracking" :disabled="!canReturn" :maxlength="100" placeholder="填写物流单号" class="field" />
        <view>寄件人电话（选填）</view><input v-model="state.shipment.form.phone" :disabled="!canReturn" :maxlength="32" placeholder="填写寄件人电话" class="field" />
        <view>退货备注（选填）</view><input v-model="state.shipment.form.explain" :disabled="!canReturn" :maxlength="255" placeholder="填写退货备注" class="field" />
        <view>凭证最多3张，每张10 MiB（PNG/JPEG/WebP/GIF）</view>
        <button size="mini" :disabled="!canReturn || state.shipment.form.images.length >= 3" @tap="uploadReturnImage">上传退货凭证</button>
        <view class="evidence"><view v-for="(item, index) in state.shipment.form.images" :key="item.url"><image :src="item.src" mode="aspectFit" alt="待提交的退货凭证" /><button size="mini" :disabled="!canReturn" @tap="removeReturnImage(index)">移除此凭证</button></view></view>
        <checkbox-group @change="acknowledgeReturn"><label><checkbox value="sent" :checked="state.shipment.form.acknowledged" :disabled="!canReturn" />我已按商家收件信息寄出商品</label></checkbox-group>
        <button class="submit-return" :disabled="!canReturn" @tap="submitReturn">提交退货物流</button>
      </view>
      <view v-if="state.shipment.outcome === 'success'" class="notice">退货物流已回读确认，请以上方售后状态为准；物流提交不代表退款到账。</view>
      <view class="actions"><button size="mini" :disabled="busy" @tap="goOrder">查看原订单</button>
        <button size="mini" :disabled="busy" @tap="goService">联系客服</button>
        <button v-if="refundableCancellation(detail)" size="mini" class="cancel" :disabled="!canCancel" :loading="state.operating" @tap="cancel">撤销售后</button></view>
    </template>
  </view>
  <DiySuspendedNavigation />
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRefundRecords } from '@/composables/useRefundRecords';
import { returnEligible } from '../../../../common/refundReturn';
import { refundStatus, refundStatusDescription, refundTime, refundableCancellation, type RefundRecordDetail } from '../../../../common/refundRecords';
defineOptions({ inheritAttrs: false });
const { auth, state, detail, busy, canCancel, canReturn, uploadReturnImage, submitReturn, removeReturnImage, routeError, navigationError, load, goList, goOrder, goService, login, cancel } = useRefundRecords('detail');
const carrierName = computed(() => state.shipment.carriers.find(row => row.id === state.shipment.form.carrierId)?.name);
function chooseCarrier(event: { detail: { value: string | number } }) {
  const index = Number(event.detail.value);
  if (canReturn.value && Number.isInteger(index) && state.shipment.carriers[index]) state.shipment.form.carrierId = state.shipment.carriers[index].id;
}
function acknowledgeReturn(event: { detail: { value: string[] } }) { if (canReturn.value) state.shipment.form.acknowledged = event.detail.value.includes('sent'); }
const statusText = computed(() => detail.value ? refundStatus(detail.value) : '');
const statusSub = computed(() => detail.value ? refundStatusDescription(detail.value) : '');
const isDone = computed(() => detail.value?.isCancel === 0 && detail.value?.refundType === 6);
const failedImages = ref<number[]>([]);
watch(detail, () => { failedImages.value = []; }, { flush: 'sync' });
function imageFailed(item: RefundRecordDetail['items'][number]) {
  if (detail.value?.items.includes(item) && !failedImages.value.includes(item.id)) failedImages.value.push(item.id);
}
</script>
<style scoped>
.refund-detail { padding: 20rpx; font-size: 26rpx; line-height: 1.6; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 16rpx; margin: 16rpx 0; } .actions button { margin: 0; }
.status-card { background: #a84916; color: white; border-radius: 16rpx; padding: 30rpx; margin: 20rpx 0; }
.status-card.done { background: #26723d; } .status-text { font-size: 36rpx; font-weight: 600; margin-bottom: 12rpx; }
.info-card, .items-card { width: auto; box-sizing: border-box; background: white; border-radius: 16rpx; padding: 24rpx; margin: 20rpx 0; }
.info-row { display: flex; justify-content: space-between; gap: 24rpx; padding: 12rpx 0; border-bottom: 1rpx solid #eee; }
.info-row > text:first-child { flex: 0 0 120rpx; color: #777; } .info-row > text:last-child { min-width: 0; text-align: right; }
.card-title { font-size: 30rpx; font-weight: 600; margin-bottom: 16rpx; }
.item-row { display: flex; gap: 20rpx; margin: 16rpx 0; } .item-image { width: 120rpx; height: 120rpx; flex: 0 0 120rpx; } .item-text { min-width: 0; }
.notice { padding: 20rpx; background: #fff4e5; color: #744500; margin: 12rpx 0; }
.cancel { color: #c93124; }
.image-unavailable { display: flex; align-items: center; justify-content: center; text-align: center; color: #777; background: #f5f5f5; font-size: 22rpx; }
.return-form > view { margin: 12rpx 0; } .field { box-sizing: border-box; border: 1rpx solid #bbb; border-radius: 8rpx; padding: 16rpx; min-height: 72rpx; height: auto; }
.return-form checkbox-group { margin: 24rpx 0; } .submit-return { background: #a84916; color: white; font-size: 28rpx; }
.evidence { display: flex; flex-wrap: wrap; gap: 16rpx; } .evidence image { width: 140rpx; height: 140rpx; display: block; }
</style>
