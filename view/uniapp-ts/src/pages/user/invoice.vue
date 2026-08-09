<template>
  <view class="invoice-page">
    <!-- 发票列表 -->
    <view class="inv-card" v-for="inv in list" :key="inv.id">
      <view class="inv-head">
        <view class="inv-type">
          {{ inv.headerType === 1 ? "个人" : "企业" }} · {{ inv.type === 1 ? "普通发票" : "增值税专票" }}
        </view>
        <view v-if="inv.isDefault === 1" class="inv-default">默认</view>
      </view>
      <view class="inv-name">{{ inv.name }}</view>
      <view v-if="inv.dutyNumber" class="inv-duty">税号: {{ inv.dutyNumber }}</view>
      <view v-if="inv.email" class="inv-duty">邮箱: {{ inv.email }}</view>
      <view class="inv-actions">
        <text class="inv-act" @tap="setDefault(inv)">设为默认</text>
        <text class="inv-act danger" @tap="del(inv)">删除</text>
      </view>
    </view>
    <view v-if="!list.length" class="empty">暂无发票信息</view>

    <!-- 新建按钮 -->
    <view class="add-btn" @tap="showForm = true">＋ 新增发票</view>

    <!-- 新建/编辑表单 -->
    <view v-if="showForm" class="mask" @tap="showForm = false">
      <view class="sheet" @tap.stop>
        <view class="sheet-title">新增发票</view>
        <view class="seg">
          <view class="seg-item" :class="{ active: form.header_type === 1 }" @tap="form.header_type = 1">个人</view>
          <view class="seg-item" :class="{ active: form.header_type === 2 }" @tap="form.header_type = 2">企业</view>
        </view>
        <input v-model="form.name" class="sheet-input" type="text" placeholder="发票抬头名称" />
        <input v-model="form.duty_number" class="sheet-input" type="text" placeholder="税号 (企业必填)" />
        <input v-model="form.email" class="sheet-input" type="text" placeholder="接收邮箱 (选填)" />
        <view class="sheet-btn" @tap="save">保存</view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import {
  apiInvoiceList,
  apiInvoiceSave,
  apiInvoiceDel,
  apiInvoiceSetDefault,
  type Invoice,
} from "@/api/finance";

const list = ref<Invoice[]>([]);
const showForm = ref(false);
const form = ref({ header_type: 1, name: "", duty_number: "", email: "" });

async function load() {
  try {
    list.value = await apiInvoiceList();
  } catch {
    list.value = [];
  }
}

async function save() {
  if (!form.value.name) return uni.showToast({ title: "请填写发票抬头", icon: "none" });
  if (form.value.header_type === 2 && !form.value.duty_number) {
    return uni.showToast({ title: "企业抬头请填写税号", icon: "none" });
  }
  try {
    await apiInvoiceSave({
      header_type: form.value.header_type,
      type: 1,
      name: form.value.name,
      duty_number: form.value.duty_number || undefined,
      email: form.value.email || undefined,
    });
    uni.showToast({ title: "保存成功", icon: "success" });
    showForm.value = false;
    form.value = { header_type: 1, name: "", duty_number: "", email: "" };
    load();
  } catch (e) {
    uni.showToast({ title: (e as Error).message || "保存失败", icon: "none" });
  }
}

async function setDefault(inv: Invoice) {
  try {
    await apiInvoiceSetDefault(inv.id);
    uni.showToast({ title: "已设为默认", icon: "success" });
    load();
  } catch (e) {
    uni.showToast({ title: (e as Error).message || "操作失败", icon: "none" });
  }
}

async function del(inv: Invoice) {
  uni.showModal({
    title: "提示",
    content: "确认删除该发票信息?",
    success: async (res) => {
      if (!res.confirm) return;
      try {
        await apiInvoiceDel(inv.id);
        uni.showToast({ title: "已删除", icon: "success" });
        load();
      } catch (e) {
        uni.showToast({ title: (e as Error).message || "删除失败", icon: "none" });
      }
    },
  });
}

onMounted(load);
</script>

<style scoped>
.invoice-page {
  padding: 20rpx;
}

.inv-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.inv-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12rpx;
}

.inv-type {
  font-size: 24rpx;
  color: #e93323;
  background: #fff0f0;
  padding: 6rpx 16rpx;
  border-radius: 8rpx;
}

.inv-default {
  font-size: 22rpx;
  color: #fff;
  background: #e93323;
  padding: 4rpx 14rpx;
  border-radius: 8rpx;
}

.inv-name {
  font-size: 30rpx;
  font-weight: 600;
  color: #333;
}

.inv-duty {
  font-size: 24rpx;
  color: #888;
  margin-top: 8rpx;
}

.inv-actions {
  display: flex;
  justify-content: flex-end;
  gap: 30rpx;
  margin-top: 16rpx;
  border-top: 1rpx solid #f7f7f7;
  padding-top: 16rpx;
}

.inv-act {
  font-size: 24rpx;
  color: #666;
}

.inv-act.danger {
  color: #e93323;
}

.empty {
  text-align: center;
  color: #999;
  font-size: 24rpx;
  padding: 100rpx 0;
}

.add-btn {
  position: fixed;
  left: 40rpx;
  right: 40rpx;
  bottom: 40rpx;
  background: #e93323;
  color: #fff;
  text-align: center;
  border-radius: 44rpx;
  padding: 24rpx 0;
  font-size: 28rpx;
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

.seg {
  display: flex;
  gap: 20rpx;
  margin-bottom: 20rpx;
}

.seg-item {
  flex: 1;
  text-align: center;
  padding: 18rpx 0;
  border-radius: 12rpx;
  background: #f7f7f7;
  font-size: 26rpx;
  color: #666;
}

.seg-item.active {
  background: #e93323;
  color: #fff;
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
</style>
