<template>
  <ThemePage>
    <view class="member-center" :data-level-owner="s.overview?.actor_uid || 0">
      <image v-if="s.image(s.selected, 'image')" class="header-background" :src="s.image(s.selected, 'image')" mode="aspectFill" @error="s.imageFailed(s.selectedId, 'image')" />
      <view v-if="!s.loggedIn" class="member-state"><view>登录后查看会员等级</view><button @tap="s.login">去登录</button></view>
      <template v-else>
        <view v-if="s.loading && !s.overview" class="member-state" role="status">{{ s.checking ? '正在检查会员等级…' : '正在读取会员等级…' }}</view>
        <view v-if="s.error" class="member-notice error" role="alert">{{ s.error }}</view>
        <view v-if="s.checkNotice" class="member-notice" role="status">{{ s.checkNotice }}</view>
        <template v-if="s.overview">
          <view v-if="!s.overview.enabled" class="member-state">会员等级暂未开放</view>
          <template v-else>
            <view v-if="s.overview.preview_only" class="preview-notice">当前为等级预览，实际权益以已生效的会员等级为准</view>
            <view v-if="!s.levels.length" class="member-state">暂无可展示的会员等级</view>
            <view class="member-header">
              <swiper v-if="s.levels.length" class="level-swiper" :current="s.selectedIndex" previous-margin="48rpx" next-margin="48rpx" @change="s.swipe">
                <swiper-item v-for="level in s.levels" :key="level.id">
                  <view class="level-card" :class="{ selected: s.selectedId === level.id }" :style="{ color: level.color || '#62431c' }" :data-member-level-id="level.id">
                    <image v-if="s.image(level, 'icon')" class="card-texture" :src="s.image(level, 'icon')" mode="scaleToFill" @error="s.imageFailed(level.id, 'icon')" />
                    <view class="level-card-content">
                      <view class="level-state"><view class="badge-background" :style="{ backgroundColor: level.color || '#62431c' }" /><text>{{ s.state(level) }}</text></view>
                      <view class="level-name"><view class="crown" aria-hidden="true"><view /><view /><view /></view><text>{{ level.name }}</text></view>
                      <view class="level-discount">商城购物可享 <text class="numeric">{{ memberLevelDiscount(level) }}</text> 折</view>
                      <view class="growth-row">
                        <view v-if="level.lack_exp_num === '0' && s.overview.current_grade !== null && level.grade <= s.overview.current_grade" class="growth-summary">您已经是尊贵的{{ level.name }}会员</view>
                        <view v-else class="growth-summary"><text class="numeric">{{ s.overview.exp }}</text> 成长值 还差 <text class="numeric">{{ level.lack_exp_num }}</text></view>
                        <navigator class="growth-record-link" url="/pages/user/growthRecords" hover-class="none">我的成长值记录 <text aria-hidden="true">›</text></navigator>
                      </view>
                      <view class="level-progress"><view :style="{ width: memberLevelProgress(level) + '%', backgroundColor: level.color || '#62431c' }" /></view>
                    </view>
                  </view>
                </swiper-item>
              </swiper>
              <scroll-view v-if="s.levels.length" class="level-steps" :class="{ compact: s.levels.length < 6 }" scroll-x :show-scrollbar="false" :scroll-into-view="'member-step-' + s.selectedId" scroll-with-animation>
                <view class="steps-track">
                  <button v-for="level in s.levels" :id="'member-step-' + level.id" :key="level.id" class="step" :class="{ active: level.id === s.selectedId }" :aria-label="'查看' + level.name" @tap="s.select(level.id)">
                    <view class="step-head"><view class="step-line" /><view class="step-dot"><view /></view></view><view class="step-name">{{ level.name }}</view>
                  </button>
                </view>
              </scroll-view>
              <view class="privilege-section">
                <view class="section-title">会员特权</view>
                <view class="privileges">
                  <view v-for="(label, index) in privileges" :key="label" class="privilege"><view class="privilege-art"><image :src="'/static/php-level/userVip' + (index + 1) + '.png'" mode="aspectFit" /></view><view>{{ label }}</view></view>
                </view>
              </view>
            </view>
            <view class="skill-wrapper">
              <view class="skill-section">
                <view class="section-title">快速升级技巧</view>
                <view class="task-list">
                  <view v-if="s.overview.task.sign_enabled" class="task-row" data-level-task="sign"><image class="task-art" src="/static/php-level/user-vip-qd.png" mode="aspectFit" /><view class="task-description"><view class="task-title">签到 <text class="task-rate">可获得{{ s.overview.task.sign || 0 }}点经验</text></view><view class="task-info">每日签到可获得经验值，已签到{{ s.overview.task.sign_count }}天</view></view><button class="task-link" @tap="s.openTask('sign')">去签到</button></view>
                  <view class="task-row" data-level-task="order"><image class="task-art" src="/static/php-level/user-vip-gm.png" mode="aspectFit" /><view class="task-description"><view class="task-title">购买商品 <text class="task-rate">+{{ s.overview.task.order || 0 }}点经验/元</text></view><view class="task-info">购买商品可获得对应的经验值</view></view><button class="task-link" @tap="s.openTask('order')">去购买</button></view>
                  <view class="task-row" data-level-task="invite"><image class="task-art" src="/static/php-level/user-vip-yq.png" mode="aspectFit" /><view class="task-description"><view class="task-title">邀请好友 <text class="task-rate">可获得{{ s.overview.task.invite || 0 }}点经验</text></view><view class="task-info">邀请好友注册可获得经验值</view></view><button class="task-link" @tap="s.openTask('invite')">去邀请</button></view>
                </view>
              </view>
            </view>
            <view class="recommendations" aria-label="会员等级商品推荐" :data-level-recommendation-page="recommendations.page">
              <template v-if="recommendations.items.length">
                <view class="recommendation-heading"><image src="/static/php-assets/images/recommend_zs.png" mode="aspectFit" /><text>商品推荐</text><image src="/static/php-assets/images/recommend_zs.png" mode="aspectFit" /></view>
                <view class="recommendation-grid">
                  <view v-for="item in recommendations.items" :key="item.id" class="recommendation-card" role="button" :aria-label="'查看推荐商品：' + item.title" :aria-disabled="recommendations.navigating" :data-level-product-id="item.id" @tap="recommendations.openProduct(item.id)">
                    <view class="recommendation-picture"><image v-if="item.image.src" :key="item.image.key" class="recommendation-image" :src="item.image.src" mode="aspectFill" @error="item.image.error" /><view v-else class="recommendation-image recommendation-placeholder">商品图片暂不可用</view><image v-if="item.frameImage.src" :key="item.frameImage.key" class="recommendation-frame" :src="item.frameImage.src" mode="scaleToFill" @error="item.frameImage.error" /></view>
                    <view class="recommendation-copy">
                      <view class="recommendation-name"><text v-if="item.brand" class="recommendation-brand">{{ item.brand }}</text>{{ item.title }}</view>
                      <view v-if="item.labels.length" class="recommendation-labels"><view v-for="label in item.labels" :key="label.id" class="recommendation-label" :style="{color:label.color,backgroundColor:label.background,borderColor:label.border}"><image v-if="label.image.src" :key="label.image.key" :src="label.image.src" @error="label.image.error" />{{ label.name }}</view></view>
                      <view class="recommendation-price-row"><text class="recommendation-price"><text class="recommendation-symbol">¥</text>{{ item.price }}</text><view v-if="item.vipOffer || item.levelOffer" class="recommendation-offer"><text>{{ item.vipOffer ? 'SVIP' : '等级价' }}</text><text>¥{{ item.vipPrice }}</text></view></view>
                    </view>
                  </view>
                </view>
              </template>
              <view v-if="recommendations.loading" class="recommendation-state" role="status">正在加载商品推荐…</view>
              <view v-if="recommendations.error" class="recommendation-state" role="alert">{{ recommendations.error }}<button :disabled="recommendations.loading" @tap="recommendations.retry">重试商品推荐</button></view>
              <view v-if="recommendations.mediaExpired" class="recommendation-state">商品图片已过期，请刷新商品推荐</view>
              <button v-if="recommendations.hasMore && !recommendations.error" class="recommendation-more" :disabled="recommendations.loading || recommendations.navigating" @tap="recommendations.load(true)">加载更多推荐</button>
              <view v-if="recommendations.items.length && !recommendations.hasMore && !recommendations.loading" class="recommendation-state">没有更多推荐了</view>
              <button v-if="recommendations.items.length || recommendations.error || recommendations.mediaExpired" class="recommendation-refresh" :disabled="recommendations.loading || recommendations.navigating" @tap="recommendations.refresh">刷新商品推荐</button>
            </view>
          </template>
          <view v-if="s.mediaUnavailable" class="member-notice">等级图片已过期，刷新信息后重试</view>
        </template>
        <view class="member-actions"><button :disabled="s.loading" @tap="s.load()">{{ s.loading ? '加载中…' : '刷新等级信息' }}</button><button v-if="s.checkNotice" :disabled="s.loading" @tap="s.recheck">重新检查等级</button></view>
      </template>
    </view>
    <DiySuspendedNavigation />
  </ThemePage>
</template>
<script setup lang="ts">
import { reactive } from 'vue';
import ThemePage from '@/components/ThemePage.vue';
import { useMemberLevels } from '@/composables/useMemberLevels';
import { useMemberLevelRecommendations } from '@/composables/useMemberLevelRecommendations';
import { memberLevelDiscount, memberLevelProgress } from '@/api/memberLevels';
const s = reactive(useMemberLevels());
const recommendations = reactive(useMemberLevelRecommendations(() => s.overview?.enabled === true));
const privileges = ['购物折扣', '专属徽章', '经验累积', '尊享客服'];
</script>
<style scoped>
.member-center{position:relative;min-height:100vh;max-width:960px;margin:auto;overflow:hidden;background:#302b2c;padding:24rpx 0 calc(32rpx + env(safe-area-inset-bottom));box-sizing:border-box}.header-background{position:absolute;top:0;left:0;width:100%;height:990rpx;pointer-events:none}.member-header,.skill-wrapper,.member-state,.member-actions,.member-notice,.preview-notice{position:relative}.level-swiper{height:299rpx}.level-card{height:299rpx;border-radius:40rpx;overflow:hidden;box-sizing:border-box;transform:scale(.9);transition:transform .2s;background:linear-gradient(120deg,#f6dfb7,#dfba82)}.level-card.selected{transform:scale(1)}.card-texture{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.level-card-content{position:relative;padding:42rpx 48rpx 36rpx;box-sizing:border-box}.level-state{position:absolute;top:0;left:0;width:158rpx;height:38rpx;border-radius:40rpx 0 24rpx 0;text-align:center;font-size:20rpx;line-height:38rpx;overflow:hidden}.badge-background{position:absolute;inset:0;opacity:.3}.level-state text{position:relative}.level-name{display:flex;align-items:center;gap:12rpx;font-size:44rpx;line-height:62rpx;white-space:nowrap;overflow:hidden}.level-name>text{overflow:hidden;text-overflow:ellipsis}.crown{display:flex;align-items:flex-end;justify-content:space-around;position:relative;flex-shrink:0;width:42rpx;height:27rpx;border-bottom:7rpx solid currentColor;margin-right:4rpx}.crown view{width:12rpx;height:21rpx;background:currentColor;transform:skewY(20deg)}.crown view:nth-child(2){height:28rpx;transform:skewY(0)}.crown view:last-child{transform:skewY(-20deg)}.level-discount{font-size:24rpx;line-height:34rpx}.numeric{font-family:'CinaShop DIN',sans-serif;font-variant-numeric:tabular-nums}.level-discount .numeric{font-size:28rpx}.growth-row{display:flex;align-items:center;gap:12rpx;margin-top:60rpx;font-size:24rpx;line-height:34rpx}.growth-summary{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.growth-summary .numeric{font-size:32rpx}.growth-record-link{flex-shrink:0;font-size:22rpx;line-height:34rpx}.growth-record-link text{margin-left:4rpx}.level-progress{height:8rpx;border-radius:4rpx;background:rgba(0,0,0,.08);margin-top:20rpx;overflow:hidden}.level-progress>view{height:100%;border-radius:4rpx;opacity:.8}.level-steps{padding:48rpx 0 76rpx;box-sizing:border-box}.steps-track{display:flex;width:max-content;min-width:100%;box-sizing:border-box;padding:0 40rpx}.step{position:relative;width:160rpx;min-width:160rpx;padding:0;border:0;border-radius:0;background:transparent;color:rgba(255,255,255,.6);font-size:20rpx;line-height:28rpx;flex-shrink:0;overflow:visible}.step::after{border:0}.compact .steps-track{width:100%}.compact .step{flex:1;width:auto;min-width:0}.step-head{height:24rpx;position:relative;display:flex;align-items:center;justify-content:center}.step-line{position:absolute;left:0;right:0;height:2rpx;background:rgba(255,255,255,.2)}.step:first-child .step-line{left:50%}.step:last-child .step-line{right:50%}.step-dot{position:relative;width:24rpx;height:24rpx;border-radius:50%;background:#655d55;display:flex;align-items:center;justify-content:center}.step-dot>view{width:12rpx;height:12rpx;border-radius:50%;background:#a99b84}.step.active{color:#fff}.step.active .step-dot{background:#f4d7a7}.step.active .step-dot>view{background:#fff}.step-name{margin-top:16rpx;padding:0 8rpx;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.privilege-section{margin:0 20rpx;border-radius:32rpx;background:rgba(255,255,255,.05);color:#fff}.section-title{padding:32rpx;font-size:30rpx;line-height:42rpx}.privileges{display:flex;padding:8rpx 0 82rpx}.privilege{width:25%;text-align:center;font-size:24rpx;line-height:34rpx}.privilege-art{display:flex;align-items:center;justify-content:center;width:88rpx;height:88rpx;border-radius:32rpx;margin:0 auto 16rpx;background:rgba(255,255,255,.05)}.privilege-art image{width:48rpx;height:48rpx}.skill-wrapper{margin-top:-56rpx;padding:24rpx 20rpx;border-radius:40rpx 40rpx 0 0;background:#f3f4f7}.skill-section{border-radius:32rpx;background:#fff;color:#333}.skill-section .section-title{font-size:32rpx}.task-list{padding:0 24rpx 40rpx}.task-row{display:flex;align-items:center;gap:20rpx;margin-top:44rpx}.task-row:first-child{margin-top:0}.task-art{flex-shrink:0;width:100rpx;height:105rpx}.task-description{flex:1;min-width:0}.task-title{font-size:28rpx;line-height:40rpx;display:flex;flex-wrap:wrap;gap:0 12rpx}.task-rate{font-size:24rpx;color:#b7833f;overflow-wrap:anywhere}.task-info{margin-top:4rpx;font-size:22rpx;line-height:32rpx;color:#999}.task-link{flex-shrink:0;margin:0;padding:0 24rpx;height:48rpx;border-radius:24rpx;background:linear-gradient(90deg,#e7b667,#ffeab5);color:#7e4b06;font-size:24rpx;line-height:48rpx}.task-link::after{border:0}.member-state{padding:80rpx 32rpx;text-align:center;color:#fff;font-size:28rpx;line-height:44rpx}.member-state button{max-width:320rpx;margin:30rpx auto;background:#efcf9a;color:#62431c;font-size:28rpx}.member-notice,.preview-notice{margin:0 24rpx 24rpx;padding:16rpx 20rpx;font-size:24rpx;line-height:36rpx;color:#f3dfbe;background:rgba(0,0,0,.16);border-radius:16rpx;overflow-wrap:anywhere}.error{color:#ffb2a7}.member-actions{display:flex;justify-content:center;gap:20rpx;margin:24rpx}.member-actions button{margin:0;padding:0 24rpx;background:rgba(255,255,255,.08);font-size:24rpx;line-height:64rpx;color:#e8d3b1}.member-actions button::after{border:0}
.recommendations{position:relative;padding:0 20rpx 24rpx;background:#f3f4f7;color:#333}.recommendation-heading{display:flex;align-items:center;justify-content:center;gap:6rpx;padding:40rpx 0 24rpx;font-size:32rpx;font-weight:500;line-height:44rpx}.recommendation-heading image{width:42rpx;height:36rpx}.recommendation-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20rpx;align-items:start}.recommendation-card{min-width:0;background:#fff;border-radius:20rpx;overflow:hidden;text-align:left}.recommendation-picture{position:relative;height:345rpx;overflow:hidden;border-radius:16rpx 16rpx 0 0}.recommendation-image{display:block;width:100%;height:100%}.recommendation-placeholder{display:flex;align-items:center;justify-content:center;background:#eaeaea;color:#999;font-size:22rpx}.recommendation-frame{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.recommendation-copy{padding:16rpx 20rpx}.recommendation-name{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;font-size:28rpx;line-height:40rpx}.recommendation-brand{display:inline;padding:0 6rpx;margin-right:6rpx;border-radius:4rpx;background:#333;color:#fff;font-size:20rpx;vertical-align:2rpx}.recommendation-labels{display:flex;align-items:center;flex-wrap:wrap;gap:6rpx;margin-top:12rpx}.recommendation-label{display:flex;align-items:center;max-width:100%;padding:0 6rpx;border:1rpx solid transparent;border-radius:6rpx;font-size:20rpx;line-height:28rpx;overflow-wrap:anywhere}.recommendation-label image{width:24rpx;height:24rpx;margin-right:4rpx;flex:none}.recommendation-price-row{display:flex;align-items:flex-end;flex-wrap:wrap;gap:8rpx;margin-top:14rpx}.recommendation-price{font-family:'CinaShop DIN',sans-serif;font-size:40rpx;font-weight:600;line-height:44rpx;color:var(--view-priceColor,#e93323);overflow-wrap:anywhere}.recommendation-symbol{font-size:24rpx;margin-right:2rpx}.recommendation-offer{display:flex;align-items:center;background:#f9ecd3;border-radius:6rpx;font-size:20rpx;line-height:30rpx;color:#53402c;overflow-wrap:anywhere}.recommendation-offer text:first-child{padding:0 5rpx;background:#333;color:#f9ecd3;border-radius:6rpx 0 0 6rpx}.recommendation-offer text:last-child{padding:0 8rpx}.recommendation-state{padding:24rpx 12rpx;color:#888;text-align:center;font-size:24rpx;line-height:36rpx;overflow-wrap:anywhere}.recommendation-state button,.recommendation-more,.recommendation-refresh{width:max-content;max-width:100%;margin:16rpx auto 0;padding:0 24rpx;border-radius:32rpx;background:#fff;color:#78532d;font-size:24rpx;line-height:60rpx}.recommendation-state button::after,.recommendation-more::after,.recommendation-refresh::after{border:0}
</style>
