<template>
  <view class="lottery-page">
    <view class="factor-tabs">
      <view v-for="item in factors" :key="item.value" class="factor-tab" :class="{ active: factor === item.value }" @tap="switchFactor(item.value)">{{ item.label }}</view>
    </view>

    <view v-if="loading" class="state-card">活动加载中…</view>
    <view v-else-if="!info" class="state-card empty-state">
      <text class="state-icon">🎯</text><text>当前条件暂无可参与活动</text>
      <text class="state-hint">支付订单抽奖需在获得次数后的 2 分钟内进入</text>
    </view>
    <template v-else>
      <view class="hero" :style="heroStyle">
        <view class="hero-shade">
          <text class="eyebrow">CINASHOP LUCKY DRAW</text>
          <text class="hero-title">{{ info.name }}</text>
          <text class="hero-desc">{{ info.desc || factorHint }}</text>
          <view class="chance-pill">可抽 <strong>{{ info.lottery_num }}</strong> 次</view>
        </view>
      </view>

      <view class="board">
        <view v-for="(item, index) in boardItems" :key="item.key" class="board-cell" :class="{ draw: item.draw, active: !item.draw && activePrizeId === item.prize?.id }" @tap="item.draw && startDraw()">
          <template v-if="item.draw">
            <text class="draw-title">{{ drawing ? "开奖中" : "立即抽奖" }}</text>
            <text class="draw-count">{{ drawing ? "请稍候" : `${info.lottery_num} 次机会` }}</text>
          </template>
          <template v-else-if="item.prize">
            <image :src="item.prize.image || '/static/logo.png'" mode="aspectFill" class="prize-image" />
            <text class="prize-name">{{ item.prize.name }}</text>
          </template>
        </view>
      </view>

      <view class="action-row">
        <view class="secondary-btn" @tap="goRecords">我的奖品</view>
        <view class="secondary-btn" @tap="showRules = !showRules">活动规则</view>
      </view>
      <view v-if="showRules" class="rules-card"><text class="section-title">活动规则</text><text class="rules-text">{{ info.content }}</text></view>
      <view v-if="info.all_record?.length" class="records-card">
        <text class="section-title">最新中奖</text>
        <view v-for="record in info.all_record" :key="record.id" class="record-line"><text>用户 {{ record.uid }}</text><text>{{ record.prize?.name || "获得奖品" }}</text></view>
      </view>
    </template>

    <view v-if="result" class="result-mask" @tap.self="closeResult">
      <view class="result-card">
        <text class="result-icon">{{ result.type === 1 ? "✨" : "🎉" }}</text>
        <text class="result-title">{{ result.type === 1 ? "再接再厉" : "恭喜中奖" }}</text>
        <image :src="result.image || '/static/logo.png'" mode="aspectFill" class="result-image" />
        <text class="result-name">{{ result.name }}</text>
        <text class="result-prompt">{{ result.prompt || awardHint(result.type) }}</text>
        <view v-if="result.type === 6 && !claimVisible" class="primary-btn" @tap="claimVisible = true">填写收货信息</view>
        <view v-else-if="result.type !== 6" class="primary-btn" @tap="closeResult">知道了</view>
        <view v-if="claimVisible" class="claim-form">
          <input v-model="claim.name" class="claim-input" placeholder="收货人姓名" />
          <input v-model="claim.phone" class="claim-input" type="number" maxlength="11" placeholder="手机号" />
          <textarea v-model="claim.address" class="claim-textarea" placeholder="详细收货地址" />
          <view class="primary-btn" @tap="submitClaim">确认领取</view>
        </view>
      </view>
    </view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { onLoad, onPullDownRefresh } from "@dcloudio/uni-app";
import { apiLotteryDraw, apiLotteryInfo, apiLotteryReceive, type LotteryInfo, type LotteryPrize } from "@/api/lottery";

const factors = [{ value: 1, label: "积分" }, { value: 2, label: "余额" }, { value: 3, label: "支付" }, { value: 4, label: "评价" }, { value: 5, label: "邀请" }];
const factor = ref(1);
const loading = ref(true);
const drawing = ref(false);
const info = ref<LotteryInfo | null>(null);
const activePrizeId = ref(0);
const result = ref<(LotteryPrize & { lottery_record_id: number }) | null>(null);
const showRules = ref(false);
const claimVisible = ref(false);
const claim = reactive({ name: "", phone: "", address: "" });
let animationTimer: ReturnType<typeof setInterval> | undefined;
const factorHint = computed(() => factors.find((item) => item.value === factor.value)?.label + "参与抽奖");
const heroStyle = computed(() => info.value?.image ? `background-image:url('${info.value.image}')` : "");
const boardItems = computed(() => {
  const prizes = info.value?.prize?.slice(0, 8) ?? [];
  const order = [0, 1, 2, 7, -1, 3, 6, 5, 4];
  return order.map((index, key) => ({ key, draw: index === -1, prize: index >= 0 ? prizes[index] : undefined }));
});

async function load() {
  loading.value = true;
  try { const data = await apiLotteryInfo(factor.value); info.value = Array.isArray(data) ? null : data; }
  catch (error) { info.value = null; uni.showToast({ title: (error as Error).message || "活动加载失败", icon: "none" }); }
  finally { loading.value = false; uni.stopPullDownRefresh(); }
}
function switchFactor(value: number) { if (drawing.value) return; factor.value = value; activePrizeId.value = 0; void load(); }
function animate() { const prizes = info.value?.prize ?? []; let index = 0; animationTimer = setInterval(() => { activePrizeId.value = prizes[index % prizes.length]?.id ?? 0; index += 1; }, 90); }
async function startDraw() {
  if (!info.value || drawing.value) return;
  if (info.value.lottery_num < 1) return uni.showToast({ title: "暂无抽奖次数", icon: "none" });
  drawing.value = true; animate();
  try {
    const drawn = await apiLotteryDraw(info.value.id, info.value.type);
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (animationTimer) clearInterval(animationTimer);
    activePrizeId.value = drawn.id; result.value = drawn; claimVisible.value = false;
    info.value.lottery_num = Math.max(0, info.value.lottery_num - 1);
  } catch (error) { if (animationTimer) clearInterval(animationTimer); uni.showToast({ title: (error as Error).message || "抽奖失败", icon: "none" }); }
  finally { drawing.value = false; }
}
function awardHint(type: number) { return [2, 3, 5, 7, 9].includes(type) ? "奖品已自动到账" : type === 6 ? "请填写收货信息" : "感谢参与"; }
function closeResult() { result.value = null; claimVisible.value = false; }
async function submitClaim() {
  if (!result.value || !claim.name || !/^1\d{10}$/.test(claim.phone) || !claim.address) return uni.showToast({ title: "请完整填写正确的收货信息", icon: "none" });
  try { await apiLotteryReceive({ id: result.value.lottery_record_id, ...claim }); uni.showToast({ title: "领取成功", icon: "success" }); closeResult(); }
  catch (error) { uni.showToast({ title: (error as Error).message || "领取失败", icon: "none" }); }
}
function goRecords() { uni.navigateTo({ url: "/pages/activity/lotteryRecords" }); }
onLoad((options) => { const value = Number(options?.factor ?? 1); if (value >= 1 && value <= 5) factor.value = value; });
onMounted(load);
onPullDownRefresh(load);
</script>

<style scoped>
.lottery-page { min-height: 100vh; padding: 24rpx; background: linear-gradient(180deg, #fff5ef 0, #f6f7fb 520rpx); box-sizing: border-box; }
.factor-tabs { display: flex; gap: 10rpx; padding: 8rpx; border-radius: 18rpx; background: rgba(255,255,255,.92); margin-bottom: 20rpx; }
.factor-tab { flex: 1; text-align: center; padding: 16rpx 4rpx; border-radius: 14rpx; color: #7d6d68; font-size: 24rpx; }
.factor-tab.active { color: #fff; background: linear-gradient(135deg, #ef4b2f, #ff8a45); box-shadow: 0 8rpx 18rpx rgba(239,75,47,.24); }
.state-card { padding: 100rpx 30rpx; text-align: center; color: #8a8f9d; background: #fff; border-radius: 24rpx; }
.empty-state text { display: block; } .state-icon { font-size: 70rpx; margin-bottom: 20rpx; } .state-hint { margin-top: 12rpx; font-size: 22rpx; color: #b0b4bf; }
.hero { min-height: 320rpx; border-radius: 28rpx; overflow: hidden; background: linear-gradient(135deg, #732413, #e74a2d); background-size: cover; background-position: center; box-shadow: 0 18rpx 40rpx rgba(102,44,28,.2); }
.hero-shade { min-height: 320rpx; padding: 48rpx 36rpx; box-sizing: border-box; background: linear-gradient(90deg, rgba(57,15,7,.76), rgba(57,15,7,.12)); color: #fff; }
.eyebrow, .hero-title, .hero-desc { display: block; } .eyebrow { font-size: 20rpx; letter-spacing: 3rpx; opacity: .72; } .hero-title { font-size: 48rpx; font-weight: 800; margin-top: 22rpx; } .hero-desc { font-size: 25rpx; margin-top: 14rpx; opacity: .86; }
.chance-pill { display: inline-flex; margin-top: 28rpx; padding: 12rpx 22rpx; border: 1rpx solid rgba(255,255,255,.45); border-radius: 999rpx; background: rgba(255,255,255,.14); font-size: 24rpx; } .chance-pill strong { margin: 0 8rpx; color: #ffd66b; }
.board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12rpx; padding: 18rpx; margin-top: 24rpx; border-radius: 28rpx; background: linear-gradient(145deg, #d94b2d, #ff8351); box-shadow: 0 16rpx 36rpx rgba(217,75,45,.2); }
.board-cell { height: 190rpx; border-radius: 18rpx; background: #fffaf6; border: 5rpx solid transparent; display: flex; flex-direction: column; align-items: center; justify-content: center; box-sizing: border-box; transition: .15s; }
.board-cell.active { border-color: #ffe36c; transform: scale(.96); box-shadow: inset 0 0 22rpx rgba(255,181,0,.28); }
.board-cell.draw { color: #fff; background: linear-gradient(145deg, #ffcb42, #ff8c24); box-shadow: inset 0 -8rpx 0 rgba(159,67,0,.18); }
.draw-title { font-size: 31rpx; font-weight: 800; } .draw-count { margin-top: 8rpx; font-size: 20rpx; opacity: .9; }
.prize-image { width: 92rpx; height: 92rpx; border-radius: 14rpx; } .prize-name { max-width: 150rpx; margin-top: 10rpx; font-size: 22rpx; color: #5a4239; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.action-row { display: flex; gap: 18rpx; margin-top: 24rpx; } .secondary-btn { flex: 1; padding: 22rpx; text-align: center; color: #d54a2d; background: #fff; border-radius: 18rpx; font-size: 26rpx; }
.rules-card, .records-card { margin-top: 20rpx; padding: 28rpx; background: #fff; border-radius: 22rpx; } .section-title { display: block; font-size: 30rpx; font-weight: 700; color: #2f3440; margin-bottom: 18rpx; } .rules-text { white-space: pre-wrap; color: #737987; font-size: 25rpx; line-height: 1.8; }
.record-line { display: flex; justify-content: space-between; padding: 16rpx 0; border-top: 1rpx solid #f1f2f5; color: #6f7582; font-size: 24rpx; }
.result-mask { position: fixed; z-index: 20; inset: 0; display: flex; align-items: center; justify-content: center; padding: 40rpx; background: rgba(25,16,13,.68); }
.result-card { width: 100%; max-width: 600rpx; padding: 44rpx 34rpx 34rpx; border-radius: 30rpx; text-align: center; background: linear-gradient(180deg, #fff8ef, #fff); box-sizing: border-box; }
.result-icon, .result-title, .result-name, .result-prompt { display: block; } .result-icon { font-size: 70rpx; } .result-title { font-size: 38rpx; font-weight: 800; color: #dc4d2e; margin-top: 8rpx; }
.result-image { width: 160rpx; height: 160rpx; margin-top: 24rpx; border-radius: 24rpx; } .result-name { margin-top: 18rpx; font-size: 30rpx; font-weight: 700; } .result-prompt { margin: 10rpx 0 26rpx; color: #8a8f9c; font-size: 24rpx; }
.primary-btn { padding: 22rpx; color: #fff; background: linear-gradient(135deg, #ef4b2f, #ff7b40); border-radius: 999rpx; font-size: 28rpx; }
.claim-form { display: grid; gap: 14rpx; margin-top: 20rpx; text-align: left; } .claim-input, .claim-textarea { width: 100%; padding: 18rpx; border-radius: 14rpx; background: #f6f7f9; box-sizing: border-box; font-size: 26rpx; } .claim-textarea { height: 120rpx; }
</style>
