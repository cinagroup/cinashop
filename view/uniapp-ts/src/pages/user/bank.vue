<template>
  <view class="bank-page">
    <view v-if="banks.length" class="bank-list">
      <view class="bank-card" v-for="b in banks" :key="b.id">
        <view class="bank-top">
          <text class="bank-name">{{ b.bank_name || '银行卡' }}</text>
          <text class="bank-default" v-if="b.is_default">默认</text>
        </view>
        <text class="bank-num">{{ b.bank_code || b.card_no || '****' }}</text>
        <text class="bank-holder">{{ b.real_name }}</text>
        <view class="bank-actions">
          <text class="act" @tap="del(b)">删除</text>
        </view>
      </view>
    </view>
    <view v-else class="empty">暂无银行卡</view>
    <view class="add-btn" @tap="openForm">＋ 添加银行卡</view>
    <!-- 弹窗 -->
    <view v-if="showForm" class="mask" @tap="showForm = false">
      <view class="sheet" @tap.stop>
        <view class="sheet-title">添加银行卡</view>
        <input v-model="form.bank_name" class="sheet-input" placeholder="银行名称 (如: 工商银行)" />
        <input v-model="form.bank_code" class="sheet-input" placeholder="银行卡号" />
        <input v-model="form.real_name" class="sheet-input" placeholder="持卡人姓名" />
        <view class="sheet-btn" @tap="save">保存</view>
      </view>
    </view>
  </view>
</template>
<script setup lang="ts">
import { ref, reactive } from "vue";
import { onShow } from "@dcloudio/uni-app";
const banks = ref<any[]>([]);
const showForm = ref(false);
const form = reactive({ bank_name: "", bank_code: "", real_name: "" });
async function load() { banks.value = []; /* 后端暂无银行卡表, 使用本地存储 */ try { banks.value = JSON.parse(uni.getStorageSync("banks") || "[]"); } catch {} }
function openForm() { form.bank_name = ""; form.bank_code = ""; form.real_name = ""; showForm.value = true; }
function save() {
  if (!form.bank_name || !form.bank_code) return uni.showToast({ title: "请填写完整", icon: "none" });
  banks.value.push({ id: Date.now(), ...form, is_default: banks.value.length === 0 });
  uni.setStorageSync("banks", JSON.stringify(banks.value));
  showForm.value = false;
  uni.showToast({ title: "已保存", icon: "success" });
}
function del(b: any) {
  banks.value = banks.value.filter((x) => x.id !== b.id);
  uni.setStorageSync("banks", JSON.stringify(banks.value));
  uni.showToast({ title: "已删除", icon: "success" });
}
onShow(load);
</script>
<style scoped>
.bank-page { padding: 20rpx; padding-bottom: 140rpx; }
.bank-card { background: linear-gradient(135deg, #4a90d9, #357abd); border-radius: 16rpx; padding: 30rpx; margin-bottom: 16rpx; }
.bank-top { display: flex; justify-content: space-between; align-items: center; }
.bank-name { font-size: 30rpx; color: #fff; font-weight: 600; }
.bank-default { background: rgba(255,255,255,0.3); color: #fff; font-size: 20rpx; border-radius: 6rpx; padding: 2rpx 12rpx; }
.bank-num { display: block; color: rgba(255,255,255,0.9); font-size: 32rpx; letter-spacing: 4rpx; margin-top: 20rpx; }
.bank-holder { display: block; color: rgba(255,255,255,0.7); font-size: 24rpx; margin-top: 8rpx; }
.bank-actions { display: flex; justify-content: flex-end; margin-top: 16rpx; }
.act { font-size: 24rpx; color: rgba(255,255,255,0.8); }
.empty { text-align: center; color: #999; padding: 100rpx 0; font-size: 26rpx; }
.add-btn { position: fixed; bottom: 30rpx; left: 30rpx; right: 30rpx; background: #e93323; color: #fff; text-align: center; padding: 24rpx; border-radius: 44rpx; font-size: 30rpx; padding-bottom: calc(24rpx + env(safe-area-inset-bottom)); }
.mask { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 100; display: flex; align-items: flex-end; }
.sheet { background: #fff; width: 100%; border-radius: 24rpx 24rpx 0 0; padding: 30rpx; }
.sheet-title { font-size: 32rpx; font-weight: 600; text-align: center; margin-bottom: 24rpx; }
.sheet-input { background: #f7f7f7; border-radius: 12rpx; padding: 20rpx 24rpx; margin-bottom: 20rpx; font-size: 28rpx; }
.sheet-btn { background: #e93323; color: #fff; text-align: center; padding: 22rpx; border-radius: 40rpx; font-size: 30rpx; }
</style>
