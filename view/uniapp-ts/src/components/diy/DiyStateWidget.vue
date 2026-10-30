<template>
  <view v-if="active && c.config.value.enabled" class="diy-state-widget" :data-kind="c.config.value.kind" :data-component-key="c.config.value.key" :data-style="c.config.value.style" :style="c.config.value.wrapperStyle">
    <view class="diy-state-panel" :style="c.config.value.panelStyle">
      <view v-if="c.loading.value" class="diy-state-message" role="status">正在加载{{ label }}…</view>
      <view v-else-if="c.error.value" class="diy-state-error" role="alert">{{ c.closed.value ? '站点暂未开放：' : '' }}{{ c.error.value }}</view>
      <template v-else-if="c.loaded.value">
        <view v-if="c.config.value.kind === 'userInfor'" class="diy-member" :class="{ inline: c.config.value.style === 1 }">
          <view class="diy-member-identity" @tap="c.openMember('profile')">
            <image v-if="c.media(c.data.value.user?.avatar || c.config.value.avatar)" class="diy-member-avatar" :src="c.media(c.data.value.user?.avatar || c.config.value.avatar)" mode="aspectFill" />
            <view v-else class="diy-member-avatar placeholder">人</view>
            <view class="diy-member-copy">
              <text class="diy-member-name">{{ c.data.value.user?.nickname || '请点击登录' }}</text>
              <text v-if="c.data.value.user && c.data.value.user.level > 0" class="diy-member-badge" :style="c.badgeStyle.value">{{ c.data.value.user.vip_name }}</text>
              <template v-if="c.data.value.user && c.data.value.user.level > 0">
                <view class="diy-member-progress" :style="c.config.value.progressTrackStyle"><view class="diy-member-progress-fill" :style="{ ...c.config.value.progressFillStyle, width: `${c.progress.value}%` }" /></view>
                <text class="diy-member-experience">{{ c.data.value.user.exp }}/{{ c.data.value.user.next_exp }}</text>
              </template>
              <text v-else-if="c.data.value.user?.phone" class="diy-member-phone">{{ c.data.value.user.phone }}</text>
              <text v-else-if="!c.data.value.user" class="diy-member-hint">登录查看会员权益</text>
            </view>
          </view>
          <text v-if="c.levelError.value" class="diy-member-level-error">等级资料暂不可用，会员信息仍可查看</text>
          <button v-if="c.data.value.user && c.config.value.style === 0 && c.config.value.checks.includes(3)" class="diy-member-code" @tap="c.openMember('code')">▦ 会员码</button>
          <view v-if="c.data.value.user" class="diy-member-metrics" :class="{ inline: c.config.value.style === 1 }">
            <button v-for="item in metrics" :key="item.action" class="diy-member-action" :data-action="item.action" @tap="c.openMember(item.action)"><text class="diy-member-count">{{ item.value }}</text><text>{{ item.label }}</text></button>
          </view>
        </view>
        <view v-else-if="c.config.value.kind === 'newVip' && c.data.value.newcomer" class="diy-newcomer" :class="{ modern: c.config.value.style === 1 }">
          <view class="diy-state-header"><text class="diy-state-title">{{ c.config.value.style === 1 ? '超值优惠 限时专享' : '新人专享福利' }}</text><button class="diy-state-more" @tap="c.openMore">{{ c.config.value.style === 1 ? '去逛逛' : '更多优惠' }} ›</button></view>
          <view v-if="c.config.value.checks.includes(0)" class="diy-newcomer-bonus" :style="c.config.value.bonusStyle"><text>新用户注册即得 <text class="diy-newcomer-points">{{ points }}</text> 积分</text><button :style="c.config.value.buttonStyle" class="diy-state-action" @tap="c.openMore">去看看</button></view>
          <view v-if="c.config.value.checks.includes(1) && c.data.value.newcomer.newcomer_coupon.length" class="diy-newcomer-coupons" :style="c.config.value.couponListStyle">
            <text class="diy-state-subtitle">{{ c.config.value.style === 1 ? '新人红包' : '专属优惠券' }}</text>
            <scroll-view scroll-x :show-scrollbar="false"><view class="diy-coupon-list"><view v-for="coupon in c.data.value.newcomer.newcomer_coupon" :key="coupon.id" class="diy-coupon" :data-coupon-id="coupon.id" :style="c.config.value.couponStyle">
              <text class="diy-coupon-money" :style="c.config.value.couponMoneyStyle">{{ diyCouponLabel(coupon) }}</text>
              <text class="diy-coupon-title">{{ coupon.coupon_title || '新人优惠券' }}</text><text class="diy-coupon-type" :style="c.config.value.couponTypeStyle">{{ diyCouponScope(coupon) }}</text>
              <text class="diy-coupon-minimum" :style="c.config.value.couponInfoStyle">{{ Number(coupon.use_min_price) > 0 ? `满${coupon.use_min_price}可用` : '无门槛券' }}</text>
              <text v-if="diyCouponStatus(coupon)" class="diy-coupon-status">{{ diyCouponStatus(coupon) }}</text>
            </view></view></scroll-view>
            <view class="diy-coupon-station" :style="c.config.value.couponStationStyle"><text>{{ couponSummary }}</text><button class="diy-coupon-destination" :style="c.config.value.couponButtonStyle" @tap="c.openCoupons">查看我的优惠券 ›</button></view>
          </view>
          <view v-if="c.config.value.checks.includes(2) && c.data.value.newcomer.newcomer_products.length" class="diy-newcomer-products">
            <text class="diy-state-subtitle">新人商品专区</text><scroll-view scroll-x :show-scrollbar="false"><view class="diy-product-strip"><view v-for="product in c.data.value.newcomer.newcomer_products" :key="product.id" class="diy-newcomer-product" :data-product-id="product.id" @tap="c.openNewcomer(product.id)">
              <image class="diy-product-image" :src="c.media(product.image)" mode="aspectFill" /><text class="diy-product-name">{{ product.store_name }}</text><text class="diy-product-price" :style="c.config.value.priceStyle">¥{{ product.price }}</text>
            </view></view></scroll-view>
          </view>
          <text v-if="!points && !c.data.value.newcomer.newcomer_products.length && !c.data.value.newcomer.newcomer_coupon.length" class="diy-state-message">暂无新人专享内容</text>
        </view>
        <view v-else-if="c.config.value.kind === 'signIn' && c.data.value.sign" class="diy-sign-preview" :class="{ reward: c.config.value.style === 1 }">
          <template v-if="c.config.value.style === 1"><text class="diy-state-title">签到立即获取</text><text class="diy-sign-points" :style="c.config.value.rewardStyle">+{{ c.data.value.sign.sign_give_point }} 积分</text>
            <text class="diy-sign-next-reward">连续签到{{ nextReward.days }}天，额外获得{{ nextReward.point }}积分<text v-if="nextReward.exp">、{{ nextReward.exp }}经验</text></text>
          </template>
          <view v-else class="diy-sign-week"><view v-for="(day,index) in c.data.value.sign.signList[0]" :key="day.day" class="diy-sign-day" :class="{ signed: day.is_sign, today: day.sign_day }" :data-day="day.day"><text>周{{ weekdays[index] }}</text><text>{{ day.is_sign ? '✓' : day.type === 2 ? '经验' : '积分' }}</text><text>{{ day.day }}</text></view></view>
          <text v-if="!c.data.value.sign.signStatus" class="diy-sign-closed">签到暂未开启</text>
          <button class="diy-sign-destination" :style="c.config.value.buttonStyle" @tap="c.openMore">{{ c.data.value.sign.checkSign ? '已签到，查看记录' : c.data.value.sign.signStatus ? '立即签到' : '查看签到规则' }}</button>
        </view>
        <view v-else-if="c.config.value.kind === 'ranking' && c.data.value.ranks" class="diy-rank-preview" :class="{ collage: c.config.value.style === 1 }">
          <view class="diy-state-header"><text v-if="c.config.value.titleMode === 'text'" class="diy-state-title" :style="c.config.value.titleStyle">{{ c.config.value.title }}</text><image v-else-if="c.config.value.titleImage" class="diy-state-title-image" :src="c.config.value.titleImage" mode="aspectFit" /><button class="diy-state-more" :style="c.config.value.moreStyle" @tap="c.openMore">{{ c.config.value.more }} ›</button></view>
          <scroll-view scroll-x :show-scrollbar="false"><view class="diy-rank-groups"><view v-for="group in rankGroups" :key="group.key" class="diy-rank-group" :data-rank="group.key" :style="c.config.value.rankCardStyle" @tap="c.openMore">
            <text class="diy-rank-label" :style="c.config.value.rankLabelStyle">{{ group.label }}</text><view class="diy-rank-products"><view v-for="(product,index) in group.items" :key="product.id" class="diy-rank-product" :class="{ first:index===0 }" :data-product-id="product.id"><image class="diy-rank-image" :src="c.media(product.image)" :style="c.config.value.rankImageStyle" mode="aspectFill" /><text class="diy-rank-position">{{ index+1 }}</text><view class="diy-rank-copy"><text class="diy-product-name">{{ product.store_name }}</text><text class="diy-product-price" :style="c.config.value.priceStyle">¥{{ product.price }}</text><text v-if="c.config.value.style === 1 && index === 0 && product.ot_price !== undefined" class="diy-product-original">¥{{ product.ot_price }}</text></view></view></view>
            <text v-if="!group.items.length" class="diy-state-message">暂无榜单商品</text>
          </view></view></scroll-view>
        </view>
      </template>
      <button class="diy-state-refresh" :disabled="c.loading.value" @tap="c.load">{{ c.error.value ? '重试加载' : '刷新内容' }}</button>
    </view>
  </view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { DiyComponent } from '@/api/diy';
import { useDiyStateWidget } from '@/composables/useDiyStateWidget';
import { diyCouponLabel, diyCouponScope, diyCouponStatus } from '@/utils/diyStateWidget';
const props = defineProps<{ block: DiyComponent; active: boolean }>();
const emit = defineEmits<{ closed: [message: string] }>();
const c = useDiyStateWidget(() => props.block, () => props.active, message => emit('closed', message));
const label = computed(() => ({ userInfor: '会员信息', newVip: '新人权益', signIn: '签到预览', ranking: '排行榜' })[c.config.value.kind ?? 'ranking']);
const metrics = computed(() => {
  const user = c.data.value.user; if (!user) return [];
  return [{ action:'integral', checkbox:1, label:'积分', value:user.integral },{ action:'money', checkbox:2, label:'余额', value:user.now_money },
    { action:'coupon', checkbox:0, label:'优惠券', value:user.coupon_num },{ action:'code', checkbox:3, label:'会员码', value:'▦' },
    { action:'collect', checkbox:4, label:'收藏', value:user.collectCount },{ action:'visit', checkbox:5, label:'浏览', value:user.visit_num }].filter(item => c.config.value.checks.includes(item.checkbox) && (c.config.value.style === 1 || item.action !== 'code'));
});
const points = computed(() => Array.isArray(c.data.value.newcomer?.newcomer_integral) ? 0 : Number(c.data.value.newcomer?.newcomer_integral ?? 0));
const couponSummary = computed(() => {
  const coupons = c.data.value.newcomer?.newcomer_coupon ?? [], cash = coupons.filter(row => Number(row.coupon_type) === 1), discounts = coupons.filter(row => Number(row.coupon_type) === 2).length, unclassified = coupons.length - cash.length - discounts;
  const total = cash.reduce((sum,row) => sum + Math.round(Number(row.coupon_price) * 100), 0);
  return `金额券合计 ¥${(total/100).toFixed(2)}${discounts ? ` · ${discounts}张折扣券` : ''}${unclassified ? ` · ${unclassified}张其他优惠券` : ''}`;
});
const nextReward = computed(() => c.data.value.sign?.nextContinuousSignRewardList[0] ?? { days:0, point:0, exp:0 });
const weekdays = ['一','二','三','四','五','六','日'];
const rankGroups = computed(() => (c.config.value.style === 0 ? ['sales','collect','star'] as const : ['sales','star','collect'] as const).map(key => ({ key, label:({ sales:'销量榜', collect:'收藏榜', star:'好评榜' })[key],items:c.data.value.ranks?.[key] ?? [] })));
</script>
<style scoped>
.diy-state-widget{min-width:0;box-sizing:border-box;overflow-wrap:anywhere}.diy-state-panel{padding:24rpx;overflow:hidden;box-sizing:border-box}.diy-state-header{display:flex;align-items:center;justify-content:space-between;gap:16rpx;margin-bottom:20rpx}.diy-state-title{font-size:32rpx;font-weight:600;min-width:0}.diy-state-title-image{width:102rpx;height:32rpx}.diy-state-more{flex-shrink:0;padding:0;margin:0;background:transparent;font-size:24rpx;color:#777}.diy-state-more::after,.diy-member-action::after{border:0}.diy-state-message,.diy-state-error{display:block;padding:20rpx 0;font-size:25rpx}.diy-state-error{color:#a32920}.diy-state-refresh{margin:24rpx 0 0;font-size:24rpx}.diy-member{display:flex;flex-wrap:wrap;align-items:center;gap:24rpx}.diy-member-identity{display:flex;align-items:center;gap:20rpx;min-width:0;flex:1}.diy-member-avatar{width:96rpx;height:96rpx;border-radius:50%;flex-shrink:0}.placeholder{display:flex;align-items:center;justify-content:center;background:#eee;color:#888}.diy-member-copy{min-width:0;flex:1}.diy-member-name{display:block;font-size:30rpx;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.diy-member-badge{display:inline-block;font-size:21rpx;border-radius:16rpx;padding:2rpx 10rpx;margin-top:8rpx}.diy-member-progress{height:12rpx;border-radius:12rpx;margin-top:14rpx;overflow:hidden}.diy-member-progress-fill{height:100%;border-radius:12rpx}.diy-member-experience,.diy-member-phone,.diy-member-hint{display:block;font-size:22rpx;color:#777;margin-top:6rpx}.diy-member-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16rpx;width:100%}.diy-member-metrics.inline{width:48%;min-width:220rpx;flex-shrink:0}.diy-member-action{font-size:22rpx;display:flex;align-items:center;flex-direction:column;padding:0;background:transparent;line-height:1.7;margin:0;min-width:0}.diy-member-count{font-size:28rpx;word-break:break-all}.diy-newcomer-bonus{display:flex;gap:16rpx;justify-content:space-between;align-items:center;padding:20rpx;border-radius:12rpx;font-size:24rpx}.diy-newcomer-points{font-size:32rpx;font-weight:bold}.diy-state-action{font-size:22rpx;flex-shrink:0}.diy-state-subtitle{display:block;font-size:27rpx;font-weight:600;margin:22rpx 0 16rpx}.diy-coupon-list,.diy-product-strip{display:flex;width:max-content}.diy-coupon{width:220rpx;display:flex;flex-direction:column;gap:8rpx;padding:18rpx;border:1rpx solid #ddd;border-radius:12rpx;box-sizing:border-box}.diy-coupon-money{font-size:36rpx;font-weight:bold}.diy-coupon-title,.diy-coupon-type,.diy-coupon-minimum,.diy-coupon-status{font-size:22rpx}.diy-coupon-minimum{border-radius:8rpx;padding:5rpx 8rpx}.diy-coupon-station{display:flex;align-items:center;gap:12rpx;justify-content:space-between;padding:18rpx;font-size:22rpx}.diy-coupon-destination{font-size:22rpx;flex-shrink:0}.modern .diy-coupon-station{flex-direction:column;align-items:flex-start}.diy-newcomer-product{width:180rpx;margin-right:20rpx}.diy-product-image{width:180rpx;height:180rpx;border-radius:12rpx}.diy-product-name{display:block;font-size:24rpx;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.diy-product-price{display:block;font-size:28rpx}.diy-product-original{text-decoration:line-through;font-size:22rpx;color:#999}.diy-sign-week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6rpx}.diy-sign-day{display:flex;align-items:center;flex-direction:column;gap:8rpx;font-size:21rpx;padding:12rpx 0;border-radius:12rpx;color:#888}.diy-sign-day.signed{background:var(--diy-theme);color:#fff}.diy-sign-day.today{outline:2rpx solid var(--diy-theme)}.diy-sign-points{display:inline-block;padding:6rpx 14rpx;margin:12rpx;border-radius:12rpx;font-size:30rpx}.diy-sign-next-reward,.diy-sign-closed{display:block;font-size:24rpx;margin:16rpx 0}.diy-sign-destination{margin-top:22rpx;font-size:26rpx}.diy-rank-groups{display:flex;gap:20rpx;width:max-content}.diy-rank-group{width:320rpx;padding:18rpx;box-sizing:border-box}.diy-rank-label{font-weight:600;font-size:28rpx}.diy-rank-product{display:flex;gap:12rpx;align-items:center;position:relative;margin-top:16rpx}.diy-rank-image{width:96rpx;height:96rpx;flex-shrink:0}.diy-rank-copy{min-width:0;flex:1}.diy-rank-position{position:absolute;left:0;top:0;background:#f7b23a;color:#fff;font-size:20rpx;padding:0 6rpx}.collage .diy-rank-group{width:450rpx}.collage .diy-rank-products{display:grid;grid-template-columns:2fr 1fr;gap:10rpx}.collage .diy-rank-product{display:block;margin-top:14rpx;min-width:0}.collage .diy-rank-product.first{grid-row:span 2}.collage .diy-rank-image{width:100%;height:90rpx}.collage .first .diy-rank-image{height:200rpx}.collage .diy-rank-copy .diy-product-name{font-size:22rpx}.collage .diy-rank-copy .diy-product-price{font-size:23rpx}
</style>
