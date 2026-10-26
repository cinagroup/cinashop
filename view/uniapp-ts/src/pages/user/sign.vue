<template>
  <ThemePage>
    <view class="sign-page">
      <image class="page-art" src="/static/php-sign/sign-bg.png" mode="scaleToFill" aria-hidden="true" />
      <view v-if="!s.loggedIn" class="state-card"><view class="state-title">登录后开启每日签到</view><text>积累积分，查看你的签到日历</text><button @tap="s.login">去登录</button></view>
      <template v-else>
        <view class="sign-content">
          <view class="continue"><view class="top">连续签到</view><view class="bottom"><text class="numeric">{{ s.config?.continuousSignDays ?? '—' }}</text> 天</view></view>
          <view class="total"><image class="card-art" src="/static/php-sign/sign-total.png" mode="scaleToFill" aria-hidden="true" /><view class="total-number"><text class="numeric">{{ s.config?.cumulativeSignDays ?? '—' }}</text> 天</view></view>
          <view v-if="s.config" class="bubbles">
            <view v-if="reward.point > 0" class="bubble"><view class="bubble-number numeric"><image class="card-art" src="/static/php-sign/sign-bubble.png" mode="scaleToFill" aria-hidden="true" /><text class="bubble-value">{{ reward.point }}</text></view><text>{{ s.status?.signedToday ? '已得积分' : '签到领积分' }}</text></view>
            <view v-if="reward.exp > 0" class="bubble"><view class="bubble-number numeric"><image class="card-art" src="/static/php-sign/sign-bubble.png" mode="scaleToFill" aria-hidden="true" /><text class="bubble-value">{{ reward.exp }}</text></view><text>{{ s.status?.signedToday ? '已得经验' : '签到领经验' }}</text></view>
          </view>
          <button class="calendar-link" :disabled="!s.loaded || s.loading || s.writing" @tap="s.showCalendar">查看我的签到日历 ›</button>
          <view v-if="s.config?.signRemindSwitch === 1" class="remind"><switch :key="s.reminderVersion" :checked="s.config.signRemindStatus === 1" :disabled="s.blocked" color="#FAAD14" aria-label="签到提醒" @change="remindChanged" /><text>签到提醒</text></view>
          <button class="sign-button" :class="{ done: !s.canSign }" :disabled="!s.canSign" @tap="s.doSign"><image class="card-art" :src="s.canSign ? '/static/php-sign/sign-btn-bg.png' : '/static/php-sign/sign-disabled-btn-bg.png'" mode="scaleToFill" aria-hidden="true" /><text class="button-label">{{ s.buttonText }}</text><image v-if="s.canSign" class="hand" src="/static/php-sign/hand.png" mode="aspectFit" /></button>
          <view v-if="s.status && !s.status.signedToday && s.status.enabled && !s.pendingDay" class="today-reward">今日签到可得 <text>{{ s.status.integral }} 积分</text><text v-if="s.status.exp > 0">、{{ s.status.exp }} 经验</text></view>
          <view v-if="s.notice" class="notice" role="status">{{ s.notice }}</view>
          <button v-if="s.canRetry" class="reload retry-sign" @tap="s.retryUnknown">重新尝试今日签到</button>
          <view v-if="s.loading" class="read-state">正在读取签到状态…</view>
          <view v-if="s.error" class="read-state error" role="alert">{{ s.error }}</view>
          <button v-if="s.error || s.pendingDay || !s.loaded" class="reload" :disabled="s.loading || s.writing" @tap="s.load">{{ s.loading ? '加载中…' : '刷新核对' }}</button>
          <view v-if="s.config" class="board">
            <scroll-view class="reward-rail" scroll-x>
              <view v-for="(cell, index) in s.config.signList" :key="cell.day" class="rail-cell" :class="{ today: cell.sign_day }" :data-sign-day="cell.day">
                <image :src="cell.is_sign ? '/static/php-sign/sign-today.png' : cell.type === 2 ? '/static/php-sign/sign-icon-02.png' : '/static/php-sign/sign-icon-01.png'" mode="aspectFit" />
                <text>{{ s.config.signMode === 1 ? weekLabels[index] : cell.day }}</text><text class="rail-state">{{ cell.is_sign ? '已签' : cell.sign_day ? '今日' : cell.sign_type > 0 ? '奖励日' : '' }}</text>
              </view>
            </scroll-view>
          </view>
        </view>
        <view v-if="s.loaded" class="record-card">
          <view class="card-header"><text>签到记录</text><button class="more" @tap="s.history">更多 ›</button></view>
          <SignRecordList v-if="s.recent.length" :rows="s.recent" /><view v-else class="empty">还没有签到记录，来开启第一天吧</view>
          <view class="points">我的积分 <text class="numeric">{{ s.points }}</text><navigator url="/pages/user/integral">逛积分商城 ›</navigator></view>
        </view>
        <view v-if="s.config?.signRemindSwitch === 1" class="preference-hint">提醒开关用于保存签到提醒偏好</view>
      </template>
    </view>
    <view v-if="s.calendarOpen" class="calendar-mask" @tap="s.closeCalendar">
      <view class="calendar-panel" role="dialog" aria-label="我的签到日历" @tap.stop>
        <view class="card-header"><text>我的签到日历</text><button class="more" aria-label="关闭日历" @tap="s.closeCalendar">关闭</button></view>
        <view class="calendar-summary">已连续签到 <text class="numeric">{{ s.calendar?.continuousSignDays ?? '—' }}</text> 天</view>
        <view class="month-navigation"><button :disabled="s.calendarLoading || s.calendar?.month === '1970-01'" aria-label="上个月" @tap="s.changeMonth(-1)">‹</button><text>{{ s.calendar?.month }}</text><button :disabled="s.calendarLoading || s.calendar?.month === '2037-12'" aria-label="下个月" @tap="s.changeMonth(1)">›</button></view>
        <view v-if="s.calendarLoading" class="read-state">日历加载中…</view>
        <view v-else-if="s.calendarError" class="read-state error">{{ s.calendarError }}<button class="reload" @tap="s.calendar && s.loadCalendar(s.calendar.month)">重试日历</button></view>
        <view v-else-if="s.calendar" class="calendar-grid">
          <text v-for="day in weekdays" :key="day" class="weekday">{{ day }}</text><view v-for="i in Number(s.calendar.w)" :key="`blank-${i}`" />
          <view v-for="(cell, i) in s.calendar.signList" :key="cell.day" class="calendar-day" :class="{ signed: cell.is_sign, today: cell.sign_day }" :data-calendar-day="i + 1"><text>{{ i + 1 }}</text><image v-if="cell.is_sign" src="/static/php-sign/sign-today.png" mode="aspectFit" /><text v-else class="day-label">{{ cell.sign_day ? '今日' : '' }}</text></view>
        </view>
        <view class="calendar-footnote">已签日期以签到记录为准，历史日期不支持补签</view>
      </view>
    </view>
    <DiySuspendedNavigation />
  </ThemePage>
</template>
<script setup lang="ts">
import { computed, reactive } from 'vue';
import ThemePage from '@/components/ThemePage.vue';
import SignRecordList from '@/components/SignRecordList.vue';
import { useSignCentre } from '@/composables/useSignCentre';
const s = reactive(useSignCentre());
const reward = computed(() => {
  if (!s.status) return { point: 0, exp: 0 };
  if (!s.status.signedToday) return { point: s.status.integral, exp: s.status.exp };
  const row = s.recent.find(item => item.add_time === s.calendar?.today);
  return { point: row?.number ?? 0, exp: row?.exp_num ?? 0 };
});
const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
const weekLabels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
function remindChanged(event: unknown) { const value = (event as { detail?: { value?: unknown } })?.detail?.value; if (typeof value === 'boolean') void s.setRemind(value); }
</script>
<style scoped>
.sign-page{position:relative;min-height:100vh;max-width:960px;margin:auto;background:#f5f5f5;padding-bottom:40rpx}.sign-content{position:relative;padding-top:44rpx}.numeric{font-family:'CinaShop DIN',sans-serif}.continue{position:absolute;top:26rpx;left:0;width:112rpx;text-align:center;color:#981007;font-size:20rpx}.continue .top{height:48rpx;line-height:48rpx;border-radius:24rpx 24rpx 0 0;background:linear-gradient(#fff4c7,#f9efe6)}.continue .bottom{height:58rpx;line-height:58rpx;border-radius:0 0 24rpx 24rpx;background:linear-gradient(90deg,#fbeffc,#e7f9ff)}.continue .numeric{font-size:40rpx}.total{position:relative;width:554rpx;height:419rpx;margin:0 auto;text-align:center;color:#e93323}.total-number{position:absolute;top:205rpx;left:0;width:100%;font-size:24rpx}.total-number .numeric{font-size:80rpx}.bubbles{position:absolute;top:0;left:0;right:0;pointer-events:none}.bubble{position:absolute;top:205rpx;left:34rpx;text-align:center;font-size:20rpx;color:#4851a3}.bubble+.bubble{top:92rpx;left:auto;right:30rpx}.bubble-number{width:96rpx;height:99rpx;line-height:99rpx;margin:0 auto 4rpx;position:relative;font-size:32rpx;color:#333}.calendar-link{width:296rpx;margin:24rpx auto 0;padding:0;line-height:44rpx;border-radius:24rpx;background:linear-gradient(#fff,rgba(255,255,255,.5));font-size:22rpx;color:#333}.calendar-link::after,.sign-button::after,.more::after,.month-navigation button::after{border:0}.remind{position:absolute;top:394rpx;right:0;display:flex;flex-direction:column;align-items:center;padding:6rpx 12rpx 12rpx 24rpx;border-radius:46rpx 0 0 46rpx;background:linear-gradient(90deg,#fbeffc,#e7f9ff);font-size:22rpx;color:#981007}.remind switch{transform:scale(.7);height:48rpx}.sign-button{position:relative;width:438rpx;height:160rpx;line-height:140rpx;margin:43rpx auto 0;padding:0 12rpx 12rpx;background:transparent;font-size:38rpx;color:#fff;font-weight:500}.sign-button.done{color:#fff}.sign-button[disabled]{color:#fff;background-color:transparent}.hand{position:absolute;top:63rpx;right:4rpx;width:108rpx;height:116rpx}.today-reward{text-align:center;font-size:24rpx;color:#795b3e;margin:8rpx 32rpx 0}.board{border-radius:24rpx;margin:30rpx 32rpx 0;border:1px solid #fff;background:linear-gradient(90deg,#ffe8f5,#f1fbfd);overflow:hidden}.reward-rail{width:100%;white-space:nowrap}.rail-cell{display:inline-flex;vertical-align:top;flex-direction:column;align-items:center;justify-content:center;width:94rpx;height:170rpx;font-size:22rpx;color:#3d3d3d}.rail-cell image{width:48rpx;height:48rpx;margin-bottom:12rpx}.rail-state{font-size:18rpx;min-height:26rpx;color:#888}.rail-cell.today{color:#b74902}.record-card{background:#fff;border-radius:24rpx;margin:24rpx 32rpx;padding:24rpx}.card-header{display:flex;align-items:center;justify-content:space-between;font-size:30rpx;font-weight:500}.more{margin:0;padding:8rpx 0 8rpx 20rpx;line-height:1.5;background:transparent;font-size:24rpx;color:#999}.points{display:flex;gap:12rpx;align-items:center;border-top:1px solid #f4f4f4;padding-top:24rpx;font-size:24rpx;color:#888}.points .numeric{font-size:32rpx;color:#d15802}.points navigator{margin-left:auto;color:#a64e1c}.empty{padding:60rpx 0;text-align:center;font-size:24rpx;color:#999}.notice,.read-state{margin:18rpx 32rpx;text-align:center;font-size:24rpx;line-height:1.6;overflow-wrap:anywhere;color:#7e5835}.error{color:#b23f27}.reload{font-size:26rpx;line-height:2.4;margin:12rpx auto;max-width:360rpx;background:#fff;color:#9b4c1e}.state-card{padding:160rpx 40rpx;text-align:center;font-size:26rpx;color:#7a6c67}.state-title{font-size:34rpx;font-weight:600;margin-bottom:20rpx}.state-card button{margin:36rpx auto;width:280rpx;background:#ef7138;color:#fff;font-size:28rpx}.preference-hint{text-align:center;color:#999;font-size:22rpx}.calendar-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:flex-end;justify-content:center}.calendar-panel{width:100%;max-width:750px;max-height:90vh;overflow-y:auto;box-sizing:border-box;padding:28rpx 32rpx calc(24rpx + env(safe-area-inset-bottom));border-radius:32rpx 32rpx 0 0;background:#fff}.calendar-summary{margin-top:16rpx;text-align:center;font-size:26rpx;color:#888}.calendar-summary .numeric{font-size:40rpx;color:#d15802}.month-navigation{display:flex;align-items:center;justify-content:space-between;margin:14rpx 0;font-size:30rpx}.month-navigation button{margin:0;background:transparent;font-size:42rpx;width:80rpx;padding:0;line-height:1.5}.calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:10rpx 0;text-align:center}.weekday{font-size:24rpx;color:#999;padding:10rpx 0}.calendar-day{height:76rpx;display:flex;align-items:center;flex-direction:column;font:28rpx 'CinaShop DIN',sans-serif;border-radius:14rpx}.calendar-day image{width:28rpx;height:28rpx;margin-top:4rpx}.calendar-day.today{background:#fff4e7;color:#d15802}.calendar-day.signed{color:#d15802}.day-label{height:28rpx;font:18rpx sans-serif;margin-top:4rpx}.calendar-footnote{text-align:center;margin-top:22rpx;font-size:22rpx;color:#999}
.page-art{position:absolute;top:0;left:0;width:100%;height:1056rpx;z-index:0;pointer-events:none}.sign-content,.record-card,.state-card,.preference-hint{position:relative;z-index:1}.card-art{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none}.bubble-value,.button-label{position:relative;z-index:1}
</style>
