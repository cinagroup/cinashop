<template>
  <view class="finance-page">
    <!-- 佣金总览 -->
    <view class="balance-card">
      <view class="balance-label">可提现佣金 (元)</view>
      <view class="balance-num">{{ info.withdrawable ?? "0.00" }}</view>
      <view class="balance-sub">
        <view class="sub-item">
          <text class="sub-val">{{ info.totalCommission ?? "0.00" }}</text>
          <text class="sub-label">累计佣金</text>
        </view>
        <view class="sub-item">
          <text class="sub-val">{{ info.frozenCommission ?? "0.00" }}</text>
          <text class="sub-label">冻结佣金</text>
        </view>
        <view class="sub-item">
          <text class="sub-val">{{ info.spreadCount ?? 0 }}</text>
          <text class="sub-label">推广人数</text>
        </view>
      </view>
    </view>

    <!-- 操作 -->
    <view class="action-row">
      <view class="action-btn" @tap="openExtract">
        <text class="action-icon">💸</text>
        <text class="action-text">提现</text>
      </view>
      <view class="action-btn" @tap="showBind = true">
        <text class="action-icon">🔗</text>
        <text class="action-text">绑定推广人</text>
      </view>
      <view class="action-btn" @tap="openPeople">
        <text class="action-icon">👥</text>
        <text class="action-text">我的推广</text>
      </view>
    </view>

    <view v-if="uncertain" class="notice" @tap="openExtract">上一笔提现结果待确认，点击查询或重试同一申请。请勿重复发起新申请。</view>
    <view v-if="pageError" class="notice">{{ pageError }}</view>

    <!-- 明细 tab -->
    <view class="list-card">
      <view class="tabs">
        <view
          v-for="(t, i) in tabs"
          :key="t.type"
          class="tab"
          :class="{ active: activeTab === t.type }"
          @tap="switchTab(t.type)"
        >
          {{ t.name }}
        </view>
      </view>
      <view v-if="list.length" class="items">
        <view v-for="item in list" :key="item.id" class="item">
          <view class="item-left">
            <view class="item-title">{{ item.title }}</view>
            <view class="item-time">{{ formatTime(item.addTime) }}</view>
          </view>
          <view class="item-right" :class="{ income: item.pm === 1 }">
            {{ item.pm === 1 ? "+" : "-" }}¥{{ item.number }}
          </view>
        </view>
      </view>
      <view v-else class="empty">{{ listLoading ? "加载中…" : "暂无佣金明细" }}</view>
      <button v-if="listMore" class="more-btn" :disabled="listLoading" @tap="loadList(true)">{{ listLoading ? "加载中…" : "加载更多明细" }}</button>
    </view>

    <!-- 提现弹窗 -->
    <view v-if="showExtract" class="mask" @tap="showExtract = false">
      <view :key="extractFormEpoch" class="sheet" @tap.stop>
        <view class="sheet-title">佣金提现</view>
        <view v-if="extractConfig" class="form-hint">可提现 ¥{{ extractConfig.commissionCount }} · 单次 ¥{{ extractConfig.minPrice }}–{{ extractConfig.maxPrice }}</view>
        <view class="method-row">
          <button v-for="method in methods" :key="method.value" size="mini" :disabled="extractBusy || uncertain" :class="{ selected: extractForm.extract_type === method.value }" @tap="extractForm.extract_type = method.value; clearExtractError()">{{ method.label }}</button>
        </view>
        <input v-model="extractForm.extract_price" :disabled="extractBusy || uncertain" class="sheet-input" type="digit" placeholder="提现金额" @input="clearExtractError" />
        <template v-if="extractForm.extract_type !== 'balance'">
          <input v-model="extractForm.real_name" :disabled="extractBusy || uncertain" class="sheet-input" type="text" placeholder="收款人姓名" @input="clearExtractError" />
          <input v-model="extractForm.extract_number" :disabled="extractBusy || uncertain" class="sheet-input" type="text" :placeholder="extractForm.extract_type === 'bank' ? '银行卡号' : extractForm.extract_type === 'alipay' ? '支付宝账号' : '微信账号'" @input="clearExtractError" />
          <input v-if="extractForm.extract_type === 'bank'" v-model="extractForm.bank_name" :disabled="extractBusy || uncertain" class="sheet-input" type="text" placeholder="开户行（必填）" @input="clearExtractError" />
        </template>
        <view v-if="estimate" class="form-hint">手续费 ¥{{ estimate.fee }} · 预计到账 ¥{{ estimate.net }}</view>
        <view v-if="uncertain" class="notice">结果尚未确认，信息已锁定。重试会使用同一请求标识，不会重复扣款。</view>
        <view v-if="extractError" class="notice">{{ extractError }}</view>
        <button class="sheet-btn" :disabled="extractBusy || !extractConfig" @tap="doExtract">{{ extractBusy ? "提交中…" : uncertain ? "重试同一申请" : "提交申请" }}</button>
        <view class="form-hint">银行卡、支付宝与人工微信提现需审核；转入余额立即入账。</view>
      </view>
    </view>

    <!-- 绑定推广人弹窗 -->
    <view v-if="showBind" class="mask" @tap="showBind = false">
      <view class="sheet" @tap.stop>
        <view class="sheet-title">绑定推广人</view>
        <input v-model="bindUid" class="sheet-input" type="number" placeholder="推广人 UID" />
        <view class="sheet-btn" @tap="doBind">确认绑定</view>
      </view>
    </view>

    <!-- 推广人列表弹窗 -->
    <view v-if="showPeople" class="mask" @tap="showPeople = false">
      <view class="sheet" @tap.stop>
        <view class="sheet-title">我的推广（一级 {{ peopleTotal }} / 二级 {{ peopleTotalLevel }}）</view>
        <view class="method-row">
          <button size="mini" :class="{ selected: peopleGrade === 0 }" @tap="changeGrade(0)">一级推荐</button>
          <button size="mini" :class="{ selected: peopleGrade === 1 }" @tap="changeGrade(1)">二级推荐</button>
        </view>
        <input v-model="peopleKeyword" class="sheet-input" placeholder="搜索昵称或手机号" @confirm="loadPeople(false)" />
        <button size="mini" @tap="loadPeople(false)">搜索推广用户</button>
        <view v-if="peopleError" class="notice">{{ peopleError }}</view>
        <view v-if="people.length" class="people-list">
          <view v-for="p in people" :key="p.uid" class="people-item">
            <text class="people-avatar">👤</text>
            <view class="people-info">
              <view class="people-name">{{ p.nickname || "用户" }}</view>
              <view class="people-time">{{ formatTime(p.addTime) }}</view>
              <view class="people-time">团队 {{ p.childCount }} · 订单 {{ p.orderCount }} · 消费 ¥{{ p.numberCount }}</view>
            </view>
          </view>
        </view>
        <view v-else class="empty">{{ peopleLoading ? "加载中…" : "暂无推广用户" }}</view>
        <button v-if="peopleMore" class="more-btn" :disabled="peopleLoading" @tap="loadPeople(true)">加载更多推广用户</button>
      </view>
    </view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";
import {
  apiCommission,
  apiCommissionList,
  apiSpreadPeople,
  apiBindSpread,
  apiExtractCash,
  apiExtractConfig,
  apiExtractRequests,
  type ExtractConfig,
  type ExtractInput,
  type CommissionInfo,
  type CommissionItem,
  type SpreadUser,
} from "@/api/finance";
import { RequestError } from "@/utils/request";
import { useAuthStore } from "@/stores/auth";
import { estimateWithdrawal, newWithdrawalKey, withdrawalStorageKey } from "@/utils/withdrawal";

const info = ref<CommissionInfo>({
  yesterdayCommission: "0.00",
  totalCommission: "0.00",
  frozenCommission: "0.00",
  withdrawable: "0.00",
  spreadCount: 0,
});
const tabs = [
  { type: 1, name: "一级佣金" },
  { type: 2, name: "二级佣金" },
  { type: 3, name: "提现记录" },
];
const activeTab = ref(1);
const list = ref<CommissionItem[]>([]);
const people = ref<SpreadUser[]>([]);
const showExtract = ref(false);
const showBind = ref(false);
const showPeople = ref(false);
const bindUid = ref("");
const auth = useAuthStore();
const emptyExtract = (): ExtractInput => ({ extract_type: "bank", extract_price: "", real_name: "", extract_number: "", bank_name: "" });
const extractForm = ref<ExtractInput>(emptyExtract());
const extractFormEpoch = ref(0);
const extractConfig = ref<ExtractConfig | null>(null);
const extractBusy = ref(false);
const extractError = ref("");
const uncertain = ref(false);
const pageError = ref("");
const listLoading = ref(false);
const listMore = ref(false);
let listPage = 1;
let listGeneration = 0;
const peopleGrade = ref(0);
const peopleKeyword = ref("");
const peopleTotal = ref(0);
const peopleTotalLevel = ref(0);
const peopleLoading = ref(false);
const peopleError = ref("");
const peopleMore = ref(false);
let peoplePage = 1;
let peopleGeneration = 0;
const methods = computed(() => [
  { value: "bank", label: "银行卡" }, { value: "alipay", label: "支付宝" },
  ...(extractConfig.value?.extract_wechat_type === 0 ? [{ value: "weixin", label: "微信" }] : []),
  ...(extractConfig.value?.user_extract_balance_status === 1 ? [{ value: "balance", label: "余额" }] : []),
]);
const estimate = computed(() => estimateWithdrawal(extractForm.value, extractConfig.value));

function clearExtractError() {
  if (!uncertain.value) extractError.value = "";
}

function resetExtractForm() {
  extractForm.value = emptyExtract();
  // UniApp's native digit input can retain its DOM value after a restored intent is cleared.
  extractFormEpoch.value++;
}

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function loadInfo() {
  try {
    info.value = await apiCommission();
  } catch (error) {
    pageError.value = (error as Error).message || "财务概览加载失败";
  }
}

async function switchTab(type: number) {
  activeTab.value = type;
  list.value = [];
  await loadList(false);
}

async function loadList(more: boolean) {
  if (more && listLoading.value) return;
  const generation = ++listGeneration;
  const page = more ? listPage + 1 : 1;
  listLoading.value = true;
  pageError.value = "";
  try {
    const rows = await apiCommissionList(activeTab.value, page, 20);
    if (generation !== listGeneration) return;
    list.value = more ? [...list.value, ...rows] : rows;
    listPage = page;
    listMore.value = rows.length === 20;
  } catch (error) {
    if (generation === listGeneration) pageError.value = (error as Error).message || "明细加载失败";
  } finally {
    if (generation === listGeneration) listLoading.value = false;
  }
}

async function doBind() {
  if (!bindUid.value) return uni.showToast({ title: "请输入推广人 UID", icon: "none" });
  try {
    await apiBindSpread(Number(bindUid.value));
    uni.showToast({ title: "绑定成功", icon: "success" });
    showBind.value = false;
    loadInfo();
  } catch (e) {
    uni.showToast({ title: (e as Error).message || "绑定失败", icon: "none" });
  }
}

async function doExtract() {
  if (extractBusy.value || !extractConfig.value) return;
  const preview = estimate.value;
  const policy = extractConfig.value;
  if (!uncertain.value) {
    if (!preview) { extractError.value = "请输入最多两位小数的有效金额"; return; }
    if (preview.gross < Number(policy.minPrice) || preview.gross > Number(policy.maxPrice) || preview.gross > Number(policy.commissionCount)) {
      extractError.value = "金额超出可提现余额或单次限额"; return;
    }
    if (extractForm.value.extract_type !== "balance" && (!extractForm.value.real_name.trim() || !extractForm.value.extract_number.trim())) {
      extractError.value = "请填写姓名和收款账号"; return;
    }
    if (extractForm.value.extract_type === "bank" && (!/^[1-9](?:\d{15}|\d{16}|\d{18})$/.test(extractForm.value.extract_number) || !extractForm.value.bank_name?.trim())) {
      extractError.value = "请填写正确银行卡号及开户行"; return;
    }
    extractForm.value.request_id = newWithdrawalKey();
  }
  // Persist before sending. A network error or reload must not generate a fresh intent key.
  try {
    uni.setStorageSync(withdrawalStorageKey(auth.uid), { ...extractForm.value });
  } catch {
    extractError.value = "无法保存申请标识，请检查设备存储后重试；本次未发送申请";
    return;
  }
  extractBusy.value = true;
  extractError.value = "";
  try {
    await apiExtractCash({ ...extractForm.value });
    uni.removeStorageSync(withdrawalStorageKey(auth.uid));
    uncertain.value = false;
    uni.showToast({ title: extractForm.value.extract_type === "balance" ? "已转入余额" : "提现申请已提交", icon: "success" });
    showExtract.value = false;
    resetExtractForm();
    await Promise.all([loadInfo(), switchTab(3)]);
  } catch (e) {
    const definitive = e instanceof RequestError && e.status === 400;
    uncertain.value = !definitive;
    if (definitive) {
      uni.removeStorageSync(withdrawalStorageKey(auth.uid));
      delete extractForm.value.request_id;
    }
    extractError.value = definitive ? (e as Error).message : "网络结果不确定，请查询或重试同一申请";
  } finally { extractBusy.value = false; }
}

async function openExtract() {
  if (extractBusy.value) return;
  showExtract.value = true;
  extractError.value = "";
  extractConfig.value = null;
  try {
    if (uncertain.value && extractForm.value.request_id) {
      const records = await apiExtractRequests(extractForm.value.request_id);
      if (records.length) {
        uni.removeStorageSync(withdrawalStorageKey(auth.uid));
        uncertain.value = false;
        resetExtractForm();
        extractError.value = `上一笔申请 #${records[0].id} 已登记${records[0].status === -1 ? "并已拒绝" : records[0].status === 1 ? "并已通过" : "，等待审核"}`;
        await Promise.all([loadInfo(), switchTab(3)]);
      }
    }
    extractConfig.value = await apiExtractConfig();
  } catch (error) {
    extractConfig.value = null;
    extractError.value = (error as Error).message || "提现配置加载失败";
  }
}

async function openPeople() {
  showPeople.value = true;
  await loadPeople(false);
}

async function changeGrade(grade: number) {
  peopleGrade.value = grade;
  people.value = [];
  await loadPeople(false);
}

async function loadPeople(more: boolean) {
  if (more && peopleLoading.value) return;
  const generation = ++peopleGeneration;
  const page = more ? peoplePage + 1 : 1;
  peopleLoading.value = true;
  peopleError.value = "";
  try {
    const result = await apiSpreadPeople(page, 20, { grade: peopleGrade.value, keyword: peopleKeyword.value });
    if (generation !== peopleGeneration) return;
    people.value = more ? [...people.value, ...result.list] : result.list;
    peopleTotal.value = result.total;
    peopleTotalLevel.value = result.totalLevel;
    peoplePage = page;
    peopleMore.value = result.list.length === 20;
  } catch (error) {
    if (generation === peopleGeneration) peopleError.value = (error as Error).message || "推广用户加载失败";
  } finally {
    if (generation === peopleGeneration) peopleLoading.value = false;
  }
}

onLoad(() => {
  const pending = uni.getStorageSync(withdrawalStorageKey(auth.uid)) as ExtractInput | undefined;
  if (pending?.request_id && /^[A-Za-z0-9_-]{16,96}$/.test(pending.request_id)) {
    extractForm.value = pending;
    uncertain.value = true;
  }
  loadInfo();
  switchTab(1);
});
</script>

<style scoped>
.finance-page {
  padding: 20rpx;
}

.balance-card {
  background: linear-gradient(135deg, #e93323, #ff7a45);
  border-radius: 16rpx;
  padding: 40rpx 30rpx;
  color: #fff;
}

.balance-label {
  font-size: 24rpx;
  opacity: 0.9;
}

.balance-num {
  font-size: 64rpx;
  font-weight: 700;
  margin: 12rpx 0 30rpx;
}

.balance-sub {
  display: flex;
  justify-content: space-between;
}

.sub-item {
  text-align: center;
}

.sub-val {
  display: block;
  font-size: 30rpx;
  font-weight: 600;
}

.sub-label {
  display: block;
  font-size: 22rpx;
  opacity: 0.85;
  margin-top: 6rpx;
}

.action-row {
  display: flex;
  gap: 20rpx;
  margin: 24rpx 0;
}

.action-btn {
  flex: 1;
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx 0;
  text-align: center;
}

.action-icon {
  display: block;
  font-size: 40rpx;
}

.action-text {
  display: block;
  font-size: 24rpx;
  color: #555;
  margin-top: 8rpx;
}

.list-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 20rpx;
}

.tabs {
  display: flex;
  border-bottom: 1rpx solid #f0f0f0;
  margin-bottom: 16rpx;
}

.tab {
  flex: 1;
  text-align: center;
  padding: 16rpx 0;
  font-size: 26rpx;
  color: #888;
}

.tab.active {
  color: #e93323;
  font-weight: 600;
  border-bottom: 4rpx solid #e93323;
}

.items {
  max-height: 600rpx;
  overflow-y: auto;
}

.item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20rpx 0;
  border-bottom: 1rpx solid #f7f7f7;
}

.item-title {
  font-size: 26rpx;
  color: #333;
}

.item-time {
  font-size: 22rpx;
  color: #999;
  margin-top: 6rpx;
}

.item-right {
  font-size: 28rpx;
  color: #999;
}

.item-right.income {
  color: #e93323;
  font-weight: 600;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 24rpx;
  padding: 60rpx 0;
}

.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: flex-end;
  z-index: 99;
}

.sheet {
  width: 100%;
  max-width: 640px;
  max-height: 85vh;
  overflow-y: auto;
  margin: 0 auto;
  background: #fff;
  border-radius: 24rpx 24rpx 0 0;
  padding: 30rpx;
  box-sizing: border-box;
}

.sheet-title {
  font-size: 30rpx;
  font-weight: 600;
  text-align: center;
  margin-bottom: 24rpx;
}

.sheet-input {
  background: #f7f7f7;
  border-radius: 12rpx;
  padding: 20rpx 24rpx;
  font-size: 26rpx;
  margin-bottom: 16rpx;
}

.sheet-btn {
  background: #e93323;
  color: #fff;
  text-align: center;
  border-radius: 12rpx;
  padding: 22rpx 0;
  font-size: 28rpx;
  margin-top: 10rpx;
}

.sheet-btn[disabled] { opacity: 0.55; }
.notice { margin: 16rpx 0; padding: 18rpx; border-radius: 12rpx; background: #fff4df; color: #805000; font-size: 24rpx; line-height: 1.6; }
.form-hint { color: #666; font-size: 24rpx; line-height: 1.7; margin: 16rpx 0; }
.method-row { display: flex; gap: 12rpx; flex-wrap: wrap; margin-bottom: 20rpx; }
.method-row button { margin: 0; }
.method-row .selected { color: #e93323; border: 1px solid #e93323; }
.more-btn { margin: 20rpx 0 0; font-size: 24rpx; background: #fff; color: #666; }

.people-list {
  max-height: 600rpx;
  overflow-y: auto;
}

.people-item {
  display: flex;
  align-items: center;
  padding: 16rpx 0;
  border-bottom: 1rpx solid #f7f7f7;
}

.people-avatar {
  font-size: 48rpx;
  margin-right: 16rpx;
}

.people-name {
  font-size: 26rpx;
  color: #333;
}

.people-time {
  font-size: 22rpx;
  color: #999;
  margin-top: 4rpx;
}
</style>
