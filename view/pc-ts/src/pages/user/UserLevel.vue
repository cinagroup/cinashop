<template>
  <div class="level-page container">
    <h2 class="title">会员等级</h2>

    <!-- 当前等级 -->
    <el-card shadow="never" class="current-card">
      <div class="current-info">
        <div class="level-name">
          {{ info.level?.name ?? "普通用户" }}
        </div>
        <div class="level-discount" v-if="info.level">
          购物享 {{ info.level.discount }} 折
        </div>
        <div v-else class="level-discount">消费升级会员, 享受折扣</div>
        <div class="exp-bar" v-if="info.level">
          <div class="exp-fill" :style="{ width: expPercent + '%' }"></div>
        </div>
        <div class="exp-text">
          <template v-if="info.nextLevel">
            距离「{{ info.nextLevel.name }}」还差 {{ info.nextExpNeed }} 经验
          </template>
          <template v-else>已达最高等级</template>
        </div>
      </div>
    </el-card>

    <!-- 等级列表 -->
    <h3 class="subtitle">全部等级</h3>
    <div class="level-grid">
      <div
        v-for="level in levels"
        :key="level.id"
        class="level-card"
        :class="{ current: info.level?.id === level.id }"
      >
        <div class="level-name">{{ level.name }}</div>
        <div class="level-discount">{{ level.discount }} 折</div>
        <div class="level-exp">升级需 {{ level.expNum }} 经验</div>
      </div>
    </div>
    <el-empty v-if="!levels.length" description="暂无等级" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { apiLevelGrade, apiLevelInfo, type LevelGrade } from "@/api/community";

const levels = ref<LevelGrade[]>([]);
const info = ref<{
  level: LevelGrade | null;
  currentExp: number;
  nextLevel: LevelGrade | null;
  nextExpNeed: number;
}>({ level: null, currentExp: 0, nextLevel: null, nextExpNeed: 0 });

const expPercent = computed(() => {
  if (!info.value.level || !info.value.nextLevel) return 100;
  const cur = info.value.currentExp;
  const need = info.value.nextLevel.expNum;
  if (!need) return 0;
  return Math.min(100, Math.round((cur / need) * 100));
});

onMounted(async () => {
  try {
    const [l, i] = await Promise.all([apiLevelGrade(), apiLevelInfo()]);
    // 去重 (按 name+grade)
    const seen = new Set<string>();
    levels.value = l.filter((x) => {
      const k = `${x.name}-${x.grade}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    info.value = i;
  } catch (e) {
    console.error("等级加载失败", e);
  }
});
</script>

<style scoped>
.title {
  font-size: 20px;
  margin: 20px 0;
}

.current-card {
  margin-bottom: 20px;
  background: linear-gradient(135deg, #fdf6ec, #fff);
}

.current-info {
  text-align: center;
  padding: 20px;
}

.level-name {
  font-size: 28px;
  font-weight: 700;
  color: #e64340;
}

.level-discount {
  color: #666;
  margin-top: 8px;
}

.exp-bar {
  height: 10px;
  background: #eee;
  border-radius: 5px;
  margin: 16px auto;
  max-width: 400px;
  overflow: hidden;
}

.exp-fill {
  height: 100%;
  background: linear-gradient(90deg, #e64340, #ff7a45);
  border-radius: 5px;
  transition: width 0.5s;
}

.exp-text {
  color: #999;
  font-size: 13px;
}

.subtitle {
  font-size: 16px;
  margin: 20px 0 12px;
}

.level-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}

.level-card {
  background: #fff;
  border-radius: 8px;
  padding: 20px;
  text-align: center;
  border: 2px solid transparent;
}

.level-card.current {
  border-color: #e64340;
}

.level-name {
  font-weight: 600;
}

.level-discount {
  color: #e64340;
  margin-top: 6px;
  font-size: 20px;
  font-weight: 700;
}

.level-exp {
  color: #999;
  font-size: 13px;
  margin-top: 6px;
}
</style>
