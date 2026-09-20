<template>
  <view class="cashier">
    <view class="heading">{{ resultOnly ? '核对线下消费结果' : '线下消费收银' }}</view>
    <view class="note">独立的无商品消费。支付结果只以服务器收款记录为准。</view>
    <view v-if="!resultOnly && !cashier.linked" class="card history">
      <view class="status">找回已有消费</view>
      <view class="note">换设备或本地记录丢失后，请先查询原消费。列表不是付款凭据；恢复只核对原单，不会另建或自动付款。</view>
      <view v-if="state.intent?.version === 2" class="note order-id">已保留原消费 {{ state.intent.orderId }}，请在下方查看服务器核验结果。</view>
      <label for="offline-history-search">原订单号（可留空查看最近记录）</label>
      <input id="offline-history-search" class="history-search" :maxlength="32" :value="state.history.query" :disabled="state.busy || !loggedIn" @input="search" />
      <button :disabled="state.busy || !loggedIn" @tap="cashier.loadHistory()">{{ state.history.pageCursor ? '重新读取本页' : '查询已有消费' }}</button>
      <button v-if="state.history.nextCursor" :disabled="state.busy" @tap="cashier.loadHistory(true)">下一页消费记录</button>
      <button v-if="state.history.pageCursor" :disabled="state.busy" @tap="cashier.searchHistory(''); cashier.loadHistory()">返回最近记录</button>
      <view v-if="state.error && state.errorSource === 'history'" class="error" role="alert">{{ state.error }}</view>
      <view v-if="state.history.loaded && !state.history.items.length" class="note">本次查询没有记录。请核对账号或订单号；这不代表其他账号或尚未确认的请求没有消费。</view>
      <view v-for="item in state.history.items" :key="item.order_id" class="history-item">
        <view class="order-id">{{ item.order_id }}</view>
        <view>原价 ¥{{ item.money }} · 应付 ¥{{ item.pay_price }}</view>
        <view class="note">{{ new Date(item.created_at * 1000).toLocaleString() }} · {{ item.channel }}{{ item.hidden ? ' · 已隐藏，仍需核对' : '' }} · 收款状态需核对</view>
        <button :disabled="state.busy || !loggedIn" @tap="cashier.recover(item.order_id)">恢复并核对这笔消费</button>
      </view>
    </view>
    <view v-if="!resultOnly" class="card">
      <label for="offline-money">消费金额（元）</label>
      <view class="note">折扣后应付须至少0.01元；不足时请调整消费金额，不会自动加价或零元结算。</view>
      <input id="offline-money" type="digit" :maxlength="11" placeholder="0.00" :value="state.money" :disabled="state.busy || cashier.linked || !!state.intent || !!state.detail || !loggedIn"
        @input="input" />
      <view v-if="state.quote" class="price">确认应付 ¥{{ state.quote }}</view>
      <template v-if="!state.intent && !state.detail && !cashier.linked">
        <button :disabled="state.busy || !loggedIn" @tap="cashier.quote()">查询应付金额</button>
        <button class="primary" :disabled="state.busy || !state.quote || state.quote === '0.00' || !loggedIn" @tap="cashier.create()">确认金额并建单</button>
      </template>
      <view v-if="state.quote === '0.00' || state.reprice === '0.00'" class="note">线下消费应付须至少0.01元，原零元记录仅可核对，不能付款。</view>
      <template v-if="state.intent && !state.intent.orderId">
        <view class="note">原请求已保存，刷新或超时后仍使用同一请求，不会自动另建单。</view>
        <button :disabled="state.busy || !loggedIn || state.intent.draft?.expected_pay_price === '0.00'" @tap="cashier.create()">重试原建单请求</button>
        <button v-if="state.reprice" :disabled="state.busy || state.reprice === '0.00'" @tap="cashier.create(true)">重新确认应付 ¥{{ state.reprice }}</button>
      </template>
    </view>
    <view class="card">
      <view class="status" role="status">{{ state.busy ? '正在核对，请稍候…' : offlineStatus(state.detail) }}</view>
      <view v-if="state.intent?.orderId || state.detail" class="order-id">原订单号：{{ state.intent?.orderId || state.detail?.order_id }}</view>
      <view v-if="state.detail" class="price">原价 ¥{{ state.detail.money }} · 应付 ¥{{ state.detail.pay_price }}</view>
      <view v-if="state.detail?.state === 'PAID'" class="note">服务器已核验本次收款，请保留原订单号。</view>
      <view v-else class="note">未确认到账不代表失败。返回或取消都不会重新发起支付，请勿重复付款。</view>
      <view v-if="!resultOnly && state.detail?.state === 'UNSELECTED'">
        <view v-if="!state.capabilities" class="note">支付方式尚未核验，请重新读取原消费后再付款。</view>
        <template v-else>
          <view class="note">当前余额 ¥{{ state.capabilities.now_money }}。付款前会再次核验，可用方式不代表已经收款。</view>
          <button :disabled="state.busy || state.capabilities.methods.yue !== 'available'" @tap="cashier.pay('yue')">余额支付 ¥{{ state.detail.pay_price }} · {{ offlineMethodMessage(state.capabilities.methods.yue) }}</button>
          <button :disabled="state.busy || state.capabilities.methods.weixin !== 'available'" @tap="cashier.pay('weixin')">微信支付 ¥{{ state.detail.pay_price }} · {{ offlineMethodMessage(state.capabilities.methods.weixin) }}</button>
          <button v-if="h5" :disabled="state.busy || state.capabilities.methods.alipay !== 'available'" @tap="cashier.pay('alipay')">支付宝支付 ¥{{ state.detail.pay_price }} · {{ offlineMethodMessage(state.capabilities.methods.alipay) }}</button>
        </template>
      </view>
      <button v-if="!resultOnly && state.detail?.state === 'READY'" class="primary" :disabled="state.busy" @tap="cashier.open(launch)">继续原支付入口</button>
      <button :disabled="state.busy || !loggedIn" @tap="cashier.refresh()">重新读取原消费</button>
      <button v-if="!resultOnly && !cashier.linked && state.detail?.state === 'PAID' && state.intent" :disabled="state.busy" @tap="cashier.newPurchase()">已核对，开始另一笔消费</button>
      <view v-if="state.error && state.errorSource !== 'history'" class="error" role="alert">{{ state.error }}</view>
      <button v-if="!loggedIn" @tap="login">登录后恢复原消费</button>
      <navigator v-if="resultOnly || (state.error && !state.intent)" url="/pages/annex/offline_pay/index">返回收银入口恢复原记录</navigator>
    </view>
  </view>
</template>
<script setup lang="ts">
import { offlineStatus, offlineMethodMessage, type OfflineCashier, type OfflineTicket, type OfflineView } from '../../../common/offlineCashier';
const props = defineProps<{ state:OfflineView; cashier:OfflineCashier; loggedIn:boolean; resultOnly:boolean; login:()=>void; launch:(ticket:OfflineTicket)=>Promise<void> }>();
function input(event: unknown) {
  if (event && typeof event==='object' && 'detail' in event && event.detail && typeof event.detail==='object'
    && 'value' in event.detail && typeof event.detail.value==='string') props.cashier.edit(event.detail.value);
}
function search(event: unknown) {
  if (event && typeof event==='object' && 'detail' in event && event.detail && typeof event.detail==='object'
    && 'value' in event.detail && typeof event.detail.value==='string') props.cashier.searchHistory(event.detail.value);
}
let h5 = false;
// #ifdef H5
h5 = true;
// #endif
</script>
<style scoped>
.cashier{max-width:720px;margin:0 auto;padding:32rpx 24rpx 80rpx;color:#282828}.heading{font-size:42rpx;font-weight:700;margin-bottom:20rpx}.card{margin-top:28rpx;background:#fff;padding:32rpx;border:1px solid #e5e7eb;border-radius:20rpx}.note{font-size:26rpx;color:#666;line-height:1.7;margin:18rpx 0}.status{font-size:34rpx;font-weight:600;line-height:1.5}.order-id{font-size:24rpx;overflow-wrap:anywhere;margin:24rpx 0}.price{color:#c52d22;font-size:30rpx;margin:24rpx 0}input{font-size:48rpx;line-height:1.5;height:100rpx;border-bottom:1px solid #bbb;margin:20rpx 0}button{font-size:28rpx;line-height:1.5;padding:24rpx 18rpx;margin:22rpx 0;background:#fff;border:1px solid #ccc;border-radius:14rpx}button::after{border:0}button.primary{background:#e93323;color:#fff;border-color:#e93323}button[disabled]{opacity:.5}.error{background:#fff4e8;color:#934312;padding:24rpx;font-size:26rpx;line-height:1.6;overflow-wrap:anywhere}navigator{color:#b6291c;padding-top:24rpx;font-size:28rpx}
</style>
<style scoped>
/* Keep the reason legible while the native disabled control stays inert. */
.cashier button[disabled]{opacity:1;color:#606266;background:#f5f6f7;border-color:#d1d5db}
.history .history-search{font-size:26rpx}.history-item{padding:16rpx 0;border-bottom:1px solid #ddd}
</style>
