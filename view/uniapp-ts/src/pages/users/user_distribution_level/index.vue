<template>
  <ThemePage>
  <view class="distribution-page">
    <view class="page-heading"><text class="heading">分销等级</text><button size="mini" :disabled="loading || taskLoading || !auth.isLoggedIn" @tap="load">重新读取</button></view>
    <view v-if="!auth.isLoggedIn" class="card"><text>请先登录后查看分销等级和任务进度。</text><button @tap="login">去登录</button></view>
    <template v-else>
      <view v-if="loading" class="notice">正在读取等级…</view>
      <view v-if="error" class="notice error"><text>{{ error }}</text><text v-if="snapshot">下方保留上次数据，尚未确认最新状态。</text></view>
      <view v-if="snapshot && !snapshot.enabled" class="card">分销等级尚未开启。</view>
      <template v-if="snapshot?.enabled && snapshot.user">
        <view class="current-card" :style="{ color: currentColor || '#263b3a' }">
          <image v-if="currentImage" class="background-image" :src="currentImage" mode="aspectFill" />
          <view class="current-content"><text class="label">当前已授予等级</text><text class="current-name">{{ snapshot.level_info?.name || (snapshot.user.agent_level ? `历史等级 #${snapshot.user.agent_level}` : '暂未获得等级') }}</text><text>等级 {{ snapshot.current_grade }} · {{ snapshot.user.nickname || '当前用户' }}</text>
          <text v-if="snapshot.user.agent_level && !snapshot.level_info" class="history-note">原等级配置已删除，已授予等级记录保留，不会因此降级。</text>
          <text v-if="snapshot.level_info?.status === 0" class="history-note">此等级目前已隐藏，已授予等级仍保留。</text>
          <text>已邀请 {{ snapshot.user.spread_count }} 人 · 当前可用佣金 ¥{{ snapshot.user.brokerage_price }}</text></view>
        </view>
        <view class="card"><text class="name">{{ snapshot.next_level ? `下一可升级等级：${snapshot.next_level.name}` : '暂无下一可升级等级' }}</text><text class="hint">全部开启任务都完成后自动核对升级，历史 is_must 不表示任选任务。分销等级与购物会员等级分别计算。</text></view>
        <view v-if="snapshot.level_list.length" class="card level-selector">
          <text class="name">选择查看等级</text><picker :range="snapshot.level_list" range-key="name" :value="selectedIndex" :disabled="loading || taskLoading" @change="selectLevel"><view class="picker-value">{{ selectedLevel?.name || '请选择等级' }} · 等级 {{ selectedLevel?.grade ?? '—' }}　⌄</view></picker>
          <view v-if="selectedLevel" class="selected-level-card" :style="{ color: selectedLevel.color || '#263b3a' }"><image v-if="selectedLevel.image" class="background-image" :src="selectedLevel.image" mode="aspectFill" /><view class="current-content level-benefit"><text class="name">{{ selectedLevel.name }} · 等级 {{ selectedLevel.grade }}</text><text>一级返佣上浮 {{ selectedLevel.one_brokerage }}% · 二级返佣上浮 {{ selectedLevel.two_brokerage }}%</text><text class="hint">实际返佣比例按平台基础比例计算：基础比例 × (1 + 上浮百分比 ÷ 100)。</text><text v-if="selectedLevel.grade <= snapshot.current_grade && snapshot.user.agent_level" class="complete">已授予达到此级别，任务按已完成展示。</text></view></view>
        </view>
        <view v-else class="card">暂无可查看等级，已授予等级仍保留。</view>
        <view v-if="selectedLevel" class="card progress-summary"><text class="name">{{ selectedLevel.name }} · 全部任务进度</text><text>{{ taskLoading ? '正在读取…' : `${finishedCount} / ${tasks?.list.length ?? 0} 项已完成` }}</text><view class="progress-track"><view class="progress-fill" :style="{ width: `${tasks?.speedAll ?? 0}%` }" /></view><text>{{ tasks?.speedAll ?? 0 }}%</text></view>
        <view v-if="taskError" class="notice error"><text>{{ taskError }}</text><text v-if="tasks">当前进度是上次读取的数据。</text><button size="mini" :disabled="taskLoading || loading" @tap="refreshTasks">重新读取任务</button></view>
        <view v-if="tasks && !tasks.enabled" class="card">分销等级已关闭，请重新读取等级。</view>
        <view v-if="tasks?.enabled && !tasks.list.length && !taskLoading" class="card">该等级没有开启任务，不能凭空完成升级。</view>
        <view v-for="task in tasks?.list || []" :key="task.id" class="card task-card">
          <view class="task-heading"><image v-if="task.image" :src="task.image" class="task-icon" mode="aspectFit" /><view><text class="name">{{ task.name }}</text><text class="hint">{{ distributionTaskName(task.type) }}</text></view><text :class="task.finish ? 'complete' : 'hint'">{{ task.finish ? '已完成' : '进行中' }}</text></view>
          <text class="description">{{ task.desc }}</text><text>要求 {{ task.number }} {{ distributionTaskUnit(task.type) }} · 当前 {{ task.new_number }} {{ distributionTaskUnit(task.type) }}</text><view class="progress-track"><view class="progress-fill" :style="{ width: `${task.speed}%` }" /></view><text>{{ task.task_type_title }} · {{ task.speed }}%</text>
          <button v-if="!task.finish && distributionTaskAction(task.type)" class="action" :disabled="loading || taskLoading || !!error || !!taskError" @tap="act(task)">{{ distributionTaskAction(task.type)?.label }}</button>
        </view>
      </template>
    </template>
  </view>
  </ThemePage>
</template>

<script setup lang="ts">
import ThemePage from '@/components/ThemePage.vue';
import { computed, ref, watch } from 'vue';
import { onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiDistributionLevels, apiDistributionTasks, distributionTaskAction, distributionTaskName, distributionTaskUnit, type DistributionSnapshot, type DistributionTasks, type DistributionTask } from '@/api/distributorLevels';
const auth = useAuthStore(), snapshot = ref<DistributionSnapshot | null>(null), tasks = ref<DistributionTasks | null>(null), selectedId = ref(0);
const loading = ref(false), taskLoading = ref(false), error = ref(''), taskError = ref(''); let epoch = 0, taskEpoch = 0, visible = false;
const owner = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
const selectedLevel = computed(() => snapshot.value?.level_list.find(level => level.id === selectedId.value) ?? null);
const selectedIndex = computed(() => Math.max(0, snapshot.value?.level_list.findIndex(level => level.id === selectedId.value) ?? 0));
const finishedCount = computed(() => tasks.value?.list.filter(task => task.finish === 1).length ?? 0);
const currentColor = computed(() => snapshot.value?.level_info?.color ?? ''), currentImage = computed(() => snapshot.value?.level_info?.image ?? '');
function safeError(reason: unknown): string { const value = reason instanceof Error ? reason.message : '读取失败，请重试'; return value.length <= 1000 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : '读取失败，请重试'; }
async function load(): Promise<void> {
  const generation = ++epoch, identity = owner(); ++taskEpoch; loading.value = true; taskLoading.value = false; error.value = '';
  if (!auth.isLoggedIn) { loading.value = false; return; }
  try {
    const result = await apiDistributionLevels(auth.uid); if (!visible || generation !== epoch || identity !== owner()) return;
    snapshot.value = result; taskError.value = ''; tasks.value = null;
    const retained = result.level_list.some(level => level.id === selectedId.value) ? selectedId.value : 0;
    selectedId.value = retained || result.next_level?.id || result.level_list.find(level => level.id === result.user?.agent_level)?.id || result.level_list[0]?.id || 0;
  } catch (reason) { if (visible && generation === epoch && identity === owner()) error.value = safeError(reason); }
  finally { if (visible && generation === epoch && identity === owner()) loading.value = false; }
  if (visible && generation === epoch && identity === owner() && !error.value && selectedId.value) await refreshTasks();
}
async function refreshTasks(): Promise<void> {
  if (!auth.isLoggedIn || !selectedLevel.value || loading.value) return; const generation = ++taskEpoch, parentEpoch = epoch, identity = owner(), id = selectedId.value;
  taskLoading.value = true; taskError.value = '';
  try { const result = await apiDistributionTasks(id); if (visible && generation === taskEpoch && parentEpoch === epoch && identity === owner() && id === selectedId.value) tasks.value = result; }
  catch (reason) { if (visible && generation === taskEpoch && parentEpoch === epoch && identity === owner()) taskError.value = safeError(reason); }
  finally { if (visible && generation === taskEpoch && parentEpoch === epoch && identity === owner()) taskLoading.value = false; }
}
function selectLevel(event: { detail: { value: string | number } }): void { if (loading.value || taskLoading.value || !snapshot.value) return; const index = Number(event.detail.value), level = Number.isInteger(index) ? snapshot.value.level_list[index] : undefined; if (!level || level.id === selectedId.value) return; selectedId.value = level.id; tasks.value = null; taskError.value = ''; void refreshTasks(); }
function act(task: DistributionTask): void { if (!auth.isLoggedIn || loading.value || taskLoading.value || error.value || taskError.value || !tasks.value?.list.some(item => item.id === task.id && !item.finish)) return; const action = distributionTaskAction(task.type); if (action) uni.navigateTo({ url: action.url }); }
function login(): void { uni.navigateTo({ url: '/pages/auth/login' }); }
function suspend(): void { visible = false; ++epoch; ++taskEpoch; loading.value = taskLoading.value = false; }
watch(() => [auth.uid, auth.token, auth.sessionVersion], () => { ++epoch; ++taskEpoch; snapshot.value = null; tasks.value = null; selectedId.value = 0; loading.value = taskLoading.value = false; error.value = taskError.value = ''; if (visible && auth.isLoggedIn) void load(); }, { flush: 'sync' });
onShow(() => { visible = true; void load(); }); onHide(suspend); onUnload(suspend);
</script>

<style scoped>
.distribution-page{min-height:100vh;box-sizing:border-box;background:#f5f7f8;padding:28rpx;color:#263b3a;font-size:27rpx}.page-heading{display:flex;align-items:center;justify-content:space-between;gap:16rpx;margin-bottom:24rpx}.heading{font-size:38rpx;font-weight:700}.page-heading button{flex:none;margin:0;font-size:23rpx}.card{display:flex;flex-direction:column;gap:16rpx;background:#fff;padding:28rpx;border-radius:18rpx;margin-top:22rpx;box-sizing:border-box;min-width:0;overflow-wrap:anywhere}.current-card,.selected-level-card{position:relative;overflow:hidden;border-radius:20rpx;background:#dceae7}.background-image{position:absolute;width:100%;height:100%;left:0;top:0;opacity:.65}.current-content{position:relative;display:flex;flex-direction:column;gap:15rpx;padding:34rpx;background:linear-gradient(90deg,rgba(255,255,255,.9),rgba(255,255,255,.6));overflow-wrap:anywhere}.current-name{font-size:38rpx;font-weight:700}.name{font-size:30rpx;font-weight:600;display:block}.label,.hint{font-size:25rpx;line-height:1.65}.hint{color:#687d7b;display:block}.history-note{font-size:24rpx}.notice{display:flex;flex-direction:column;gap:12rpx;padding:20rpx;border-radius:12rpx;background:#fff6dc;margin:20rpx 0;overflow-wrap:anywhere}.error{color:#a43626}.picker-value{padding:20rpx;border:1rpx solid #bfd3cf;border-radius:10rpx;overflow-wrap:anywhere}.level-benefit{display:flex;flex-direction:column;gap:12rpx}.progress-track{height:14rpx;background:#e5eeeb;border-radius:8rpx;overflow:hidden}.progress-fill{height:100%;background:#278975}.task-heading{display:flex;align-items:center;gap:16rpx}.task-heading>view{flex:1;min-width:0}.task-icon{width:62rpx;height:62rpx;flex:none}.complete{color:#187761;font-weight:600;font-size:25rpx}.description{white-space:pre-wrap;overflow-wrap:anywhere}.action{font-size:27rpx;border:1rpx solid #278975;background:#f2faf7;color:#176f5d;margin:8rpx 0 0;width:100%}
@media(min-width:800px){.distribution-page{max-width:900px;margin:auto;padding:28px;font-size:16px}.card{padding:24px}.heading{font-size:26px}}
</style>
