<template>
  <view class="level-page">
    <!-- 当前等级 -->
    <view class="level-card">
      <view class="level-name" v-if="info.level">
        {{ info.level.name }} ({{ info.level.discount / 10 }}折)
      </view>
      <view class="level-name" v-else>普通会员</view>
      <view class="level-exp">
        当前经验: {{ info.currentExp }}
        <text v-if="info.nextLevel"> / 升级还需 {{ info.nextExpNeed }}</text>
      </view>
      <view class="progress">
        <view
          class="progress-bar"
          :style="{ width: progressPercent + '%' }"
        />
      </view>
    </view>

    <!-- 等级列表 -->
    <view class="grade-list">
      <view
        v-for="lv in grades"
        :key="lv.id"
        class="grade-item"
        :class="{ current: info.level && info.level.id === lv.id }"
      >
        <view class="grade-info">
          <view class="grade-name">{{ lv.name }}</view>
          <view class="grade-desc">
            等级 {{ lv.grade }} · {{ lv.discount / 10 }}折 · 经验 {{ lv.expNum || "—" }}
          </view>
        </view>
        <view class="grade-action">
          <text v-if="info.level && info.level.id === lv.id" class="grade-current">当前</text>
          <text v-else-if="lv.id === info.nextLevel?.id" class="grade-next">下一级</text>
          <text v-else class="grade-lock">🔒</text>
        </view>
      </view>
    </view>
  </view>
  <DiySuspendedNavigation />
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { http } from "@/utils/request";

interface LevelInfo {
  id: number;
  name: string;
  discount: number;
  grade: number;
  money: string | null;
  expNum: number | null;
  icon: string;
  image: string;
  isForever: number;
}

const grades = ref<LevelInfo[]>([]);
const info = ref<{ level: LevelInfo | null; currentExp: number; nextLevel: LevelInfo | null; nextExpNeed: number }>({
  level: null,
  currentExp: 0,
  nextLevel: null,
  nextExpNeed: 0,
});

const progressPercent = computed(() => {
  if (!info.value.nextLevel) return 100;
  const cur = info.value.currentExp;
  const need = info.value.nextLevel.expNum || 0;
  const prev = info.value.level?.expNum || 0;
  if (need <= prev) return 100;
  return Math.min(100, Math.max(0, Math.round(((cur - prev) / (need - prev)) * 100)));
});

onMounted(async () => {
  try {
    grades.value = await http.get<LevelInfo[]>("/user/level/grade");
  } catch {
    grades.value = [];
  }
  try {
    info.value = await http.get("/user/level/info");
  } catch {
    // 未登录静默
  }
});
</script>

<style scoped>
.level-page {
  padding: 20rpx;
}

.level-card {
  background: linear-gradient(135deg, #f5a623, #f76b1c);
  border-radius: 16rpx;
  padding: 36rpx 30rpx;
  color: #fff;
  margin-bottom: 20rpx;
}

.level-name {
  font-size: 34rpx;
  font-weight: 700;
}

.level-exp {
  font-size: 24rpx;
  opacity: 0.9;
  margin-top: 12rpx;
}

.progress {
  height: 14rpx;
  background: rgba(255, 255, 255, 0.3);
  border-radius: 8rpx;
  margin-top: 20rpx;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  background: #fff;
  border-radius: 8rpx;
}

.grade-list {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}

.grade-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  border: 2rpx solid transparent;
}

.grade-item.current {
  border-color: #f5a623;
}

.grade-name {
  font-size: 28rpx;
  font-weight: 600;
  color: #333;
}

.grade-desc {
  font-size: 22rpx;
  color: #999;
  margin-top: 6rpx;
}

.grade-current {
  font-size: 22rpx;
  color: #fff;
  background: #f5a623;
  padding: 6rpx 18rpx;
  border-radius: 20rpx;
}

.grade-next {
  font-size: 22rpx;
  color: #f5a623;
}

.grade-lock {
  font-size: 28rpx;
}
</style>
