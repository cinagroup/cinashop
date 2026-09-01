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
      <view class="action-btn" @tap="showExtract = true">
        <text class="action-icon">💸</text>
        <text class="action-text">提现</text>
      </view>
      <view class="action-btn" @tap="showBind = true">
        <text class="action-icon">🔗</text>
        <text class="action-text">绑定推广人</text>
      </view>
      <view class="action-btn" @tap="showPeople = true">
        <text class="action-icon">👥</text>
        <text class="action-text">我的推广</text>
      </view>
    </view>

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
      <view v-else class="empty">暂无佣金明细</view>
    </view>

    <!-- 提现弹窗 -->
    <view v-if="showExtract" class="mask" @tap="showExtract = false">
      <view class="sheet" @tap.stop>
        <view class="sheet-title">佣金提现</view>
        <input v-model="extractForm.extract_price" class="sheet-input" type="digit" placeholder="提现金额" />
        <input v-model="extractForm.real_name" class="sheet-input" type="text" placeholder="收款人姓名" />
        <input v-model="extractForm.extract_number" class="sheet-input" type="text" placeholder="收款账号" />
        <input v-model="extractForm.bank_name" class="sheet-input" type="text" placeholder="开户行 (选填)" />
        <view class="sheet-btn" @tap="doExtract">提交申请</view>
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
        <view class="sheet-title">我的推广 ({{ info.spreadCount ?? 0 }})</view>
        <view v-if="people.length" class="people-list">
          <view v-for="p in people" :key="p.uid" class="people-item">
            <text class="people-avatar">👤</text>
            <view class="people-info">
              <view class="people-name">{{ p.nickname || "用户" }}</view>
              <view class="people-time">{{ formatTime(p.addTime) }}</view>
            </view>
          </view>
        </view>
        <view v-else class="empty">暂无推广用户</view>
      </view>
    </view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { onLoad } from "@dcloudio/uni-app";
import {
  apiCommission,
  apiCommissionList,
  apiSpreadPeople,
  apiBindSpread,
  apiExtractCash,
  type CommissionInfo,
  type CommissionItem,
  type SpreadUser,
} from "@/api/finance";

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
const extractForm = ref({
  extract_price: "",
  real_name: "",
  extract_number: "",
  bank_name: "",
});

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function loadInfo() {
  try {
    info.value = await apiCommission();
  } catch {
    // 静默
  }
}

async function switchTab(type: number) {
  activeTab.value = type;
  try {
    list.value = await apiCommissionList(type);
  } catch {
    list.value = [];
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
  const price = Number(extractForm.value.extract_price);
  if (!price || price <= 0) return uni.showToast({ title: "请输入有效金额", icon: "none" });
  if (!extractForm.value.real_name || !extractForm.value.extract_number) {
    return uni.showToast({ title: "请填写姓名和账号", icon: "none" });
  }
  try {
    await apiExtractCash({
      extract_type: "bank",
      real_name: extractForm.value.real_name,
      extract_number: extractForm.value.extract_number,
      extract_price: extractForm.value.extract_price,
      bank_name: extractForm.value.bank_name || undefined,
    });
    uni.showToast({ title: "提现申请已提交", icon: "success" });
    showExtract.value = false;
    extractForm.value = { extract_price: "", real_name: "", extract_number: "", bank_name: "" };
    loadInfo();
    switchTab(3);
  } catch (e) {
    uni.showToast({ title: (e as Error).message || "提现失败", icon: "none" });
  }
}

async function openPeople() {
  showPeople.value = true;
  try {
    people.value = await apiSpreadPeople();
  } catch {
    people.value = [];
  }
}

onLoad(() => {
  loadInfo();
  switchTab(1);
});
onMounted(() => {
  loadInfo();
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
