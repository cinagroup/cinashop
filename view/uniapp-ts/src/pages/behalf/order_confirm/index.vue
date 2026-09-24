<template>
  <view class="assisted-page">
    <view class="eyebrow">管理员 · 代客下单</view><view class="title">确认订单</view>
    <view v-if="!authorized" class="notice">请登录原管理员的代客会话。商城会员登录不能授权此页面。
      <button @tap="goBuyers">前往管理登录／选客</button></view>
    <template v-else>
      <view class="session">管理员 {{ session.id }}<text v-if="scope"> · {{ scope.uid ? `会员 UID ${scope.uid}` : '本次游客' }}</text></view>
      <view v-if="loading" class="empty" role="status">正在核对买家与服务器购物车…</view>
      <view v-if="error" class="notice" role="alert">{{ error }}<button :disabled="loading || submitting" @tap="load">重新检查</button></view>
      <view v-if="notice" class="notice" role="status">{{ notice }}</view>
      <view v-if="pending" class="panel">
        <view class="section-title">原订单结果恢复</view>
        <view class="hint">确认标识：{{ pending.key }} · 已记录请求 {{ pending.attempts }} 次</view>
        <view class="notice">已锁定原买家和提交内容。刷新、退出再登录后，请仍使用原管理员恢复；不要另建新单。本页不会自动收款。</view>
        <view v-if="pending.result" class="result">{{ verified ? '服务器已确认订单' : '本机保存的结果，尚需服务器核验' }}：{{ pending.result.orderId }} · 原建单应付 ¥{{ pending.result.payPrice }}</view>
        <button class="primary" :disabled="!canRecover" :loading="submitting" @tap="submit">{{ pending.result ? '核验原订单结果' : '使用原标识与原内容重试' }}</button>
        <button v-if="verified && pending.result" :disabled="!canRecover" @tap="goDetail">查看已核验订单详情</button>
        <button v-if="verified && pending.result" :disabled="!canRecover" @tap="goCashier">前往独立收银页</button>
        <button v-if="verified && pending.result" :disabled="!canRecover" @tap="clearResult">结果已核实，清除本机恢复记录</button>
        <view v-if="pending.payload.customForm" class="hint">已冻结 {{ pending.payload.customForm.length }} 项表单答案及图片引用，恢复时不可修改。</view>
        <view class="hint">恢复记录可能含收货姓名、电话、地址、表单答案和图片引用，未加密地保存在此设备。核实成功后可在上方清除；结果不明时不自动丢弃。订单付款状态请另到代客记录核对。</view>
      </view>
      <template v-else-if="!loading && !error && items.length">
        <view class="panel"><view class="section-title">本次商品</view>
          <view v-for="item in (quote ? quote.items : items)" :key="item.id" class="cart-item">
            <view class="name">{{ item.name }}</view><view class="hint">{{ item.sku }} · {{ item.quantity }} 件 · 单价{{ quote ? '' : '参考' }} ¥{{ item.price }}</view>
          </view><view v-if="!quote" class="hint">参考价不是应付金额，请取得当前完整报价。</view>
        </view>
        <view class="panel"><view class="section-title">配送与收货</view>
          <view class="row"><button v-for="mode in shippingTypes" :key="mode" :class="{chosen: shipping === mode}" :disabled="locked" @tap="setShipping(mode)">{{ mode === 2 ? '门店自提' : [1,2,3].includes(items[0]?.productType) ? '无需物流交付' : '快递配送' }}</button></view>
          <template v-if="shipping === 2">
            <view v-if="storeError" class="notice" role="alert">{{ storeError }}</view>
            <view v-if="!stores.length" class="hint">暂无可选门店，重新检查可重读目录。</view>
            <button v-for="store in stores" :key="store.id" :class="{chosen:storeId === store.id}" :disabled="locked" @tap="storeId=store.id">{{ store.name }} · {{ store.address }}</button>
            <text class="label">自提联系人</text><input v-model="contact.name" :maxlength="32" :disabled="locked" aria-label="自提联系人" />
            <text class="label">自提电话</text><input v-model="contact.phone" :maxlength="18" :disabled="locked" aria-label="自提电话" />
          </template>
          <template v-else-if="needsAddress">
            <view class="row"><button v-if="scope?.uid" :class="{chosen:!manualMode}" :disabled="locked" @tap="setManual(false)">会员保存地址</button><button :class="{chosen:manualMode}" :disabled="locked" @tap="setManual(true)">手填收货地址</button></view>
            <template v-if="!manualMode">
              <view v-if="addressError" class="notice" role="alert">{{ addressError }}</view><view v-if="!addresses.length" class="hint">暂无可用地址，可切换手填。</view>
              <button v-for="address in addresses" :key="address.id" :class="{chosen:addressId===address.id}" :disabled="locked" @tap="addressId=address.id">{{ address.realName }} · {{ address.phone }}<text class="address">{{ address.province }} {{ address.city }} {{ address.district }} {{ address.street }} {{ address.detail }}</text></button>
            </template>
            <template v-else>
              <text class="label">收货人</text><input v-model="manual.realName" :maxlength="32" :disabled="locked" aria-label="收货人" />
              <text class="label">联系电话</text><input v-model="manual.phone" :maxlength="16" :disabled="locked" aria-label="收货电话" />
              <view v-if="regionError" class="notice" role="alert">{{ regionError }}<button :disabled="locked" @tap="loadRegions">重读地区目录</button></view>
              <view v-for="(rows, level) in regions" :key="level">
                <picker v-if="rows.length" :range="rows" range-key="name" :disabled="locked" @change="selectRegion(level, Number($event.detail.value))">
                  <view class="picker">{{ ['省份','城市','区县','街道'][level] }}：{{ rows.find(row=>row.id===regionIds[level])?.name || '请选择' }}</view>
                </picker>
              </view><view v-if="regionBusy" class="hint" role="status">正在读取下级地区…</view>
              <text class="label">详细地址</text><input v-model="manual.detail" :maxlength="100" :disabled="locked" aria-label="详细地址" placeholder="道路、门牌号等；完整地址最多 100 字" />
              <view class="hint">地区必须从目录选择。手填内容仅用于本次订单，不会新增会员保存地址。</view>
            </template>
          </template>
          <view v-else class="hint">当前商品无需物流地址，具体交付以订单记录为准。</view>
          <view v-if="deliveryError" class="notice">{{ deliveryError }}</view>
          <button v-if="addressError || storeError" :disabled="locked" @tap="load">重新读取购物车和目录（将清空当前填写）</button>
        </view>
        <view class="panel"><view class="section-title">优惠与订单备注</view>
          <template v-if="scope?.uid">
            <button :disabled="locked || couponBusy" @tap="loadCoupons">读取会员候选优惠券</button>
            <view class="hint">最多展示接口返回的 100 张候选券；能否使用及优惠金额以重新报价为准。</view>
            <view v-if="couponError" class="notice" role="alert">{{ couponError }}</view>
            <button :class="{chosen:couponId===0}" :disabled="locked || couponBusy" @tap="selectCoupon(0)">不使用优惠券</button>
            <button v-for="coupon in coupons" :key="coupon.id" :class="{chosen:couponId===coupon.id}" :disabled="locked || couponBusy" @tap="selectCoupon(coupon.id)">{{ coupon.title }} · 候选优惠 ¥{{ coupon.discount }}</button>
            <button :class="{chosen:useIntegral}" :disabled="locked" :aria-pressed="useIntegral" @tap="useIntegral=!useIntegral">{{ useIntegral ? '已申请' : '未申请' }}积分抵扣</button>
            <view class="hint">冻结积分不可使用，实际可抵金额由服务器计算。{{ quote ? `当前余额 ${quote.points} 积分，本次使用 ${quote.usedPoints}，剩余可用 ${quote.remainingPoints}。` : '' }}</view>
            <view v-if="quote && !quote.integralEnabled" class="hint">当前报价未启用积分抵扣。</view>
          </template><view v-else class="hint">游客不使用会员优惠券和积分。</view>
          <text class="label">计划收款方式（此处不执行收款）</text><view class="row">
            <button v-for="method in paymentMethods" :key="method.value" :class="{chosen:payType===method.value}" :disabled="locked" @tap="payType=method.value">{{ method.label }}</button>
          </view>
          <text class="label">订单备注</text><input v-model="mark" :maxlength="512" :disabled="locked" aria-label="订单备注" />
        </view>
        <view v-if="customForm.length" class="panel">
          <SystemFormFields :key="formRevision" :model-value="customForm" :title="formName" :disabled="formLocked"
            :upload-image="uploadFormImage" :preview-urls="previews" @update:model-value="updateForm"
            @pending="onFormPending" @choosing="onFormChoosing" />
          <view v-if="formValidation" class="notice" role="alert">{{ formValidation }}</view>
          <view v-if="formPending" class="hint" role="status">正在选图或上传，完成前不能建单。</view>
          <template v-if="customForm.some(item=>item.name==='uploadPicture')">
            <view class="hint">仅使用此管理员、本次买家和结算范围内上传的图片。临时预览过期时可重新读取；原图片引用不变。移除引用不会删除已上传文件。</view>
            <button :disabled="formLocked || !!formPending || previewBusy" :loading="previewBusy" @tap="refreshPreviews">刷新图片预览</button>
            <view v-if="previewError" class="notice" role="alert">{{ previewError }}</view>
          </template>
        </view>
        <view class="panel"><view class="section-title">服务器完整报价</view>
          <view v-if="quoteBusy" role="status">正在重新报价…</view><view v-if="quoteError" class="notice" role="alert">{{ quoteError }}</view>
          <view v-if="!quote && !quoteBusy" class="hint">选择已变化或尚未报价，不能提交。</view>
          <template v-if="quote">
            <view v-for="line in amountLines" :key="line.key" class="amount-row"><text>{{ line.label }}</text><text>{{ line.discount ? '−' : '' }}¥{{ quote.amounts[line.key] }}</text></view>
            <view class="amount-row total"><text>应付金额</text><text>¥{{ quote.amounts.payable }}</text></view>
          </template>
          <button :disabled="locked || quoteBusy" @tap="refreshQuote">重新获取完整报价</button>
          <button :class="{chosen:consent}" :aria-pressed="consent" :disabled="locked || !quote" @tap="consent=!consent">{{ consent ? '已确认' : '请确认' }}：允许本机暂存收货信息、表单答案和图片引用用于恢复，并按当前报价预占库存、优惠券和积分</button>
          <view class="hint">上述资料未加密地存储在此设备，预览签名不保存；服务器确认订单后可清除恢复记录。不要在不可信或共用设备上操作。</view>
          <button class="primary" :disabled="!canSubmit" :loading="submitting" @tap="confirmSubmit">确认建单 · 不自动收款</button>
        </view>
      </template>
      <view class="row"><button v-if="!pending" :disabled="submitting || confirming" @tap="goCart">返回选品</button><button @tap="goRecords">查看代客订单记录</button><button @tap="goBuyers">前往选客页</button></view>
    </template>
    <DiySuspendedNavigation />
  </view>
</template>
<script setup lang="ts">
import { useAssistedCheckout } from '@/composables/useAssistedCheckout';
import SystemFormFields from '@/components/SystemFormFields.vue';
const { session,scope,authorized,loading,error,notice,items,addresses,stores,addressId,storeId,addressError,storeError,
  shipping,shippingTypes,needsAddress,manualMode,manual,contact,mark,payType,useIntegral,couponId,quote,quoteError,quoteBusy,
  pending,submitting,confirming,verified,consent,locked,canSubmit,canRecover,deliveryError,regions,regionIds,regionBusy,regionError,
  coupons,couponBusy,couponError,load,refreshQuote,loadRegions,selectRegion,setShipping,setManual,loadCoupons,selectCoupon,
  customForm,formName,formRevision,formLocked,formValidation,formPending,previews,previewBusy,previewError,
  updateForm,onFormChoosing,onFormPending,uploadFormImage,refreshPreviews,
  confirmSubmit,submit,clearResult,goBuyers,goRecords,goDetail,goCashier,goCart }=useAssistedCheckout();
const paymentMethods=[{value:'cash',label:'现金'},{value:'weixin',label:'微信'},{value:'alipay',label:'支付宝'}] as const;
const amountLines=[{key:'original',label:'商品原价',discount:false},{key:'membership',label:'会员优惠',discount:true},
  {key:'products',label:'商品小计',discount:false},{key:'coupon',label:'优惠券',discount:true},
  {key:'firstOrder',label:'首单优惠',discount:true},{key:'points',label:'积分抵扣',discount:true},
  {key:'originalPostage',label:'原始运费',discount:false},{key:'postageDiscount',label:'运费优惠',discount:true},{key:'postage',label:'应付运费',discount:false}] as const;
</script>
<style src="../selection.css" scoped></style>
<style scoped>
.address{display:block;font-size:25rpx}.picker{border:1px solid #bac6d5;border-radius:10rpx;padding:22rpx;margin-top:18rpx;font-size:28rpx}.amount-row{display:flex;justify-content:space-between;gap:20rpx;flex-wrap:wrap;margin-top:18rpx;font-size:28rpx}.total{font-size:36rpx;font-weight:700;border-top:1px solid #e5e9ef;padding-top:24rpx}.result{font-size:30rpx;overflow-wrap:anywhere}
</style>
