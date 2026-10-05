<template>
  <el-dialog :model-value="modelValue" title="团成员与订单" width="min(1080px, calc(100vw - 24px))" append-to-body @update:model-value="close">
    <p class="hint">团记录 #{{ groupId }}；当前成员属于同一活动。UID 0 或虚拟标记表示虚拟用户，不提供订单详情。</p>
    <el-alert v-if="!session.allowed.value" title="当前账号没有此范围的团记录查看权限" type="warning" :closable="false" />
    <el-alert v-if="error" :title="error" type="error" :closable="false"><template #default><el-button link @click="load(page)">重试成员</el-button></template></el-alert>
    <p v-if="replacement" class="hint">当前替代团长记录 #{{ replacement }}；显示所选团的有效当前成员，不跨活动读取。</p>
    <div class="table-scroll"><el-table :data="members" v-loading="loading" row-key="pink_id" border>
      <el-table-column prop="pink_id" label="参与记录ID" width="115" />
      <el-table-column label="用户" min-width="210"><template #default="{ row }"><div class="person"><el-avatar v-if="preview(row.avatar_preview)" :src="preview(row.avatar_preview)" :size="32" /><span>{{ row.uid === 0 || row.is_virtual === 1 ? '虚拟用户' : row.nickname || '未知用户' }} · UID {{ row.uid }}</span></div><p class="hint">{{ row.is_leader ? '团长' : '团员' }}{{ row.deleted_user ? ' · 已注销' : row.missing_user ? ' · 用户缺失' : '' }}</p></template></el-table-column>
      <el-table-column prop="price" label="参与金额（元）" width="145" />
      <el-table-column label="参与时间" min-width="180"><template #default="{ row }">{{ time(row.add_time) }}</template></el-table-column>
      <el-table-column label="退款标志" width="105"><template #default="{ row }">{{ row.is_refund > 0 ? '已退款' : row.is_refund === 0 ? '未退款' : '未知' }}</template></el-table-column>
      <el-table-column label="业务订单号" min-width="240"><template #default="{ row }"><el-button v-if="canOrder(row)" link type="primary" @click="openOrder(row)">{{ row.order_id }}</el-button><span v-else>{{ row.order_id || '无可核对订单' }}</span><p v-if="row.order_deleted" class="hint">订单已删除，仅保留历史</p><p v-if="row.issues.length" class="bad">{{ row.issues.join('；') }}</p></template></el-table-column>
    </el-table></div>
    <el-pagination v-if="!loading && !error" :current-page="page" :page-size="15" :total="count" :page-count="Math.min(667,Math.max(1,Math.ceil(count/15)))" :disabled="loading" layout="total, prev, pager, next" @current-change="load" class="pager" />
    <template #footer><el-button @click="close">关闭</el-button></template>
  </el-dialog>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { combinationPreview as preview } from '@/api/combination';
import { apiCombinationMembers, combinationReadId, combinationReadOrderAvailable, type CombinationMember } from '@/api/combinationStatistics';
import { useCombinationReadSession, combinationReadTime as time } from './combinationReadSession';
const props = defineProps<{ modelValue: boolean; groupId: number; activityId?: number }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>(), router = useRouter();
const members = ref<CombinationMember[]>([]), count = ref(0), page = ref(1), loading = ref(false), error = ref(''), replacement = ref<number | null>(null);
function clear() { members.value = []; count.value = 0; page.value = 1; loading.value = false; error.value = ''; replacement.value = null; }
const session = useCombinationReadSession(() => props.activityId === undefined ? 'combination_group.view' : 'combination_statistics.view', clear, () => { if (props.modelValue) void load(1); });
async function load(target = page.value) {
  if (!props.modelValue || !combinationReadId(props.groupId) || !Number.isSafeInteger(target) || target < 1 || target > 667) return;
  const job = session.begin('members'); if (!job) return;
  const group = props.groupId, activity = props.activityId; members.value = []; count.value = 0; error.value = ''; replacement.value = null; page.value = target; loading.value = true;
  try { const result = await apiCombinationMembers(group, { page: target, limit: 15 }, job.signal, activity);
    if (job.current() && props.modelValue && group === props.groupId && activity === props.activityId) { members.value = result.list; count.value = result.count; replacement.value = result.replacement_leader_id; }
  } catch (reason) { if (job.current()) error.value = reason instanceof Error ? reason.message : '成员读取失败'; }
  finally { if (job.current()) loading.value = false; job.finish(); }
}
function close() { session.cancel('members'); clear(); emit('update:modelValue',false); }
function canOrder(row: CombinationMember) { return props.modelValue && session.allowed.value && session.has('order.view') && row.uid > 0 && row.is_virtual === 0 && members.value.includes(row) && combinationReadOrderAvailable(row); }
function openOrder(row: CombinationMember) { if (canOrder(row)) void router.push('/order/' + encodeURIComponent(row.order_id)); }
watch(() => [props.modelValue,props.groupId,props.activityId], () => { session.cancel('members'); clear(); if (props.modelValue) void load(1); }, { flush:'sync' });
</script>
<style scoped>
.table-scroll{max-width:100%;overflow-x:auto;min-width:0}.person{display:flex;align-items:center;gap:8px}.hint,.bad{font-size:12px;line-height:1.5;overflow-wrap:anywhere}.hint{color:#747b87}.bad{color:#c45656}.pager{display:flex;justify-content:flex-end;flex-wrap:wrap;margin-top:16px}@media(max-width:650px){.pager{justify-content:center}}
</style>
