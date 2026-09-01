<template>
  <view class="page">
    <view v-if="addresses.length" class="addr-list">
      <view class="addr-card" v-for="addr in addresses" :key="addr.id">
        <view class="addr-top">
          <text class="addr-name">{{ addr.real_name }}</text>
          <text class="addr-phone">{{ addr.phone }}</text>
          <text v-if="addr.is_default" class="default-tag">默认</text>
        </view>
        <view class="addr-detail">
          {{ addr.province }}{{ addr.city }}{{ addr.district }}{{ addr.detail }}
        </view>
        <view class="addr-actions">
          <text v-if="!addr.is_default" class="act" @tap="setDefault(addr)">设为默认</text>
          <text class="act" @tap="openEdit(addr)">编辑</text>
          <text class="act danger" @tap="del(addr)">删除</text>
        </view>
      </view>
    </view>
    <view v-else class="empty">暂无地址</view>

    <!-- 新增按钮 -->
    <view class="add-btn" @tap="openEdit()">＋ 新增地址</view>

    <!-- 编辑弹窗 -->
    <view v-if="showForm" class="mask" @tap="showForm = false">
      <view class="sheet" @tap.stop>
        <view class="sheet-title">{{ form.id ? "编辑地址" : "新增地址" }}</view>
        <input v-model="form.real_name" class="sheet-input" type="text" placeholder="收货人姓名" />
        <input v-model="form.phone" class="sheet-input" type="text" placeholder="手机号" />

        <!-- 省市区三级选择器 -->
        <view class="region-picker" @tap="regionVisible = true">
          <text v-if="form.province" class="region-text">
            {{ form.province }} {{ form.city }} {{ form.district }}
          </text>
          <text v-else class="region-placeholder">请选择省市区</text>
          <text class="region-arrow">›</text>
        </view>

        <input v-model="form.detail" class="sheet-input" type="text" placeholder="详细地址 (街道门牌号)" />
        <view class="sheet-btn" @tap="save">保存</view>
      </view>
    </view>

    <!-- 省市区选择弹窗 (三列联动) -->
    <view v-if="regionVisible" class="mask" @tap="regionVisible = false">
      <view class="sheet" @tap.stop>
        <view class="sheet-title">选择省市区</view>
        <view class="region-cols">
          <!-- 省 -->
          <scroll-view scroll-y class="region-col">
            <view
              v-for="(p, pi) in regionProvs"
              :key="p.name"
              class="region-opt"
              :class="{ active: pi === provIdx }"
              @tap="pickProv(pi)"
            >
              {{ p.name }}
            </view>
          </scroll-view>
          <!-- 市 -->
          <scroll-view scroll-y class="region-col">
            <view
              v-for="(c, ci) in currentCities"
              :key="c.name"
              class="region-opt"
              :class="{ active: ci === cityIdx }"
              @tap="pickCity(ci)"
            >
              {{ c.name }}
            </view>
          </scroll-view>
          <!-- 区 -->
          <scroll-view scroll-y class="region-col">
            <view
              v-for="(d, di) in currentDistricts"
              :key="d"
              class="region-opt"
              :class="{ active: di === districtIdx }"
              @tap="pickDistrict(di)"
            >
              {{ d }}
            </view>
          </scroll-view>
        </view>
        <view class="sheet-btn" @tap="confirmRegion">确定</view>
      </view>
    </view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { ref, reactive, computed } from "vue";
import { onShow } from "@dcloudio/uni-app";
import {
  apiAddressList,
  apiAddressSave,
  apiAddressSetDefault,
  apiAddressDel,
} from "@/api/order";
import { REGIONS } from "@/utils/region";
import type { UserAddress } from "@/types/order";

const addresses = ref<UserAddress[]>([]);
const showForm = ref(false);
const regionVisible = ref(false);
const provIdx = ref(0);
const cityIdx = ref(0);
const districtIdx = ref(0);
const form = reactive({
  id: 0,
  real_name: "",
  phone: "",
  province: "",
  city: "",
  district: "",
  city_id: 0,
  detail: "",
});

const regionProvs = REGIONS;
const currentCities = computed(() => regionProvs[provIdx.value]?.cities ?? []);
const currentDistricts = computed(
  () => currentCities.value[cityIdx.value]?.districts ?? [],
);

function pickProv(pi: number) {
  provIdx.value = pi;
  cityIdx.value = 0;
  districtIdx.value = 0;
}

function pickCity(ci: number) {
  cityIdx.value = ci;
  districtIdx.value = 0;
}

function pickDistrict(di: number) {
  districtIdx.value = di;
}

function confirmRegion() {
  const p = regionProvs[provIdx.value];
  const c = currentCities.value[cityIdx.value];
  const d = currentDistricts.value[districtIdx.value];
  if (p && c && d) {
    const regionChanged = form.province !== p.name
      || form.city !== c.name
      || form.district !== d;
    form.province = p.name;
    form.city = c.name;
    form.district = d;
    // 静态地区数据不含数据库 ID；地区变化后交由后端按名称重新解析，
    // 避免把编辑前的 city_id 与新省市区组合保存。
    if (regionChanged) form.city_id = 0;
  }
  regionVisible.value = false;
}

async function load() {
  try {
    addresses.value = await apiAddressList();
  } catch (e) {
    console.error("地址加载失败", e);
  }
}

function openEdit(addr?: UserAddress) {
  if (addr) {
    form.id = addr.id;
    form.real_name = addr.real_name;
    form.phone = addr.phone;
    form.province = addr.province || "";
    form.city = addr.city || "";
    form.district = addr.district || "";
    form.city_id = addr.city_id ?? 0;
    form.detail = addr.detail;
    // 回填选择器索引
    const pi = regionProvs.findIndex((p) => p.name === form.province);
    if (pi >= 0) {
      provIdx.value = pi;
      const ci = regionProvs[pi].cities.findIndex((c) => c.name === form.city);
      if (ci >= 0) {
        cityIdx.value = ci;
        const di = regionProvs[pi].cities[ci].districts.findIndex(
          (district) => district === form.district,
        );
        districtIdx.value = di >= 0 ? di : 0;
      } else {
        cityIdx.value = 0;
        districtIdx.value = 0;
      }
    } else {
      provIdx.value = 0;
      cityIdx.value = 0;
      districtIdx.value = 0;
    }
  } else {
    form.id = 0;
    form.real_name = "";
    form.phone = "";
    form.province = "";
    form.city = "";
    form.district = "";
    form.city_id = 0;
    form.detail = "";
    provIdx.value = 0;
    cityIdx.value = 0;
    districtIdx.value = 0;
  }
  showForm.value = true;
}

async function save() {
  if (!form.real_name || !form.phone) {
    return uni.showToast({ title: "请填写姓名和手机号", icon: "none" });
  }
  if (!form.province) {
    return uni.showToast({ title: "请选择省市区", icon: "none" });
  }
  if (!form.detail) {
    return uni.showToast({ title: "请填写详细地址", icon: "none" });
  }
  try {
    await apiAddressSave({
      id: form.id || undefined,
      real_name: form.real_name,
      phone: form.phone,
      province: form.province,
      city: form.city,
      district: form.district,
      city_id: form.city_id,
      detail: form.detail,
    });
    uni.showToast({ title: "保存成功", icon: "success" });
    showForm.value = false;
    load();
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : "保存失败", icon: "none" });
  }
}

async function setDefault(addr: UserAddress) {
  try {
    await apiAddressSetDefault(addr.id);
    uni.showToast({ title: "已设为默认", icon: "success" });
    await load();
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : "操作失败", icon: "none" });
  }
}

async function del(addr: UserAddress) {
  try {
    await apiAddressDel(addr.id);
    uni.showToast({ title: "已删除", icon: "success" });
    load();
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : "删除失败", icon: "none" });
  }
}

onShow(load);
</script>

<style scoped>
.page {
  padding: 20rpx;
  padding-bottom: 140rpx;
}

.addr-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.addr-top {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.addr-name {
  font-size: 30rpx;
  font-weight: 600;
}

.addr-phone {
  color: #999;
  font-size: 26rpx;
}

.default-tag {
  background: #e93323;
  color: #fff;
  font-size: 20rpx;
  border-radius: 6rpx;
  padding: 2rpx 10rpx;
}

.addr-detail {
  font-size: 26rpx;
  color: #666;
  margin: 12rpx 0;
  line-height: 1.5;
}

.addr-actions {
  display: flex;
  justify-content: flex-end;
  gap: 24rpx;
  border-top: 1rpx solid #f5f5f5;
  padding-top: 16rpx;
}

.act {
  font-size: 24rpx;
  color: #666;
}

.act.danger {
  color: #e93323;
}

.empty {
  text-align: center;
  color: #999;
  padding: 100rpx 0;
  font-size: 26rpx;
}

.add-btn {
  position: fixed;
  bottom: 30rpx;
  left: 30rpx;
  right: 30rpx;
  background: #e93323;
  color: #fff;
  text-align: center;
  padding: 24rpx;
  border-radius: 44rpx;
  font-size: 30rpx;
  padding-bottom: calc(24rpx + env(safe-area-inset-bottom));
}

.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 100;
  display: flex;
  align-items: flex-end;
}

.sheet {
  background: #fff;
  width: 100%;
  border-radius: 24rpx 24rpx 0 0;
  padding: 30rpx;
  max-height: 75vh;
  display: flex;
  flex-direction: column;
}

.sheet-title {
  font-size: 32rpx;
  font-weight: 600;
  text-align: center;
  margin-bottom: 24rpx;
}

.sheet-input {
  background: #f7f7f7;
  border-radius: 12rpx;
  padding: 20rpx 24rpx;
  margin-bottom: 20rpx;
  font-size: 28rpx;
}

.sheet-btn {
  background: #e93323;
  color: #fff;
  text-align: center;
  padding: 22rpx;
  border-radius: 40rpx;
  font-size: 30rpx;
  margin-top: 10rpx;
}

.region-picker {
  background: #f7f7f7;
  border-radius: 12rpx;
  padding: 20rpx 24rpx;
  margin-bottom: 20rpx;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.region-text {
  font-size: 28rpx;
}

.region-placeholder {
  font-size: 28rpx;
  color: #999;
}

.region-arrow {
  color: #bbb;
  font-size: 32rpx;
}

.region-cols {
  display: flex;
  height: 420rpx;
  margin-bottom: 20rpx;
}

.region-col {
  flex: 1;
  height: 100%;
  border-right: 1rpx solid #f2f2f2;
}

.region-col:last-child {
  border-right: none;
}

.region-opt {
  padding: 22rpx 16rpx;
  font-size: 26rpx;
  color: #555;
  text-align: center;
}

.region-opt.active {
  color: #e93323;
  font-weight: 600;
  background: #fff5f4;
}
</style>
