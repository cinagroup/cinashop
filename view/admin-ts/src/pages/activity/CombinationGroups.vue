<template>
  <div class="combination-groups">
    <div class="heading"><div><h2>拼团团记录</h2><p class="hint">全局汇总独立于下方筛选；团列表每页15条，只显示团长记录。</p></div><el-button v-if="session.allowed.value" @click="reload">刷新</el-button></div>
    <el-alert v-if="!session.allowed.value" title="当前账号没有团记录查看权限" type="warning" :closable="false" />
    <template v-else>
      <el-alert v-if="headError" :title="headError" type="error" :closable="false"><template #default><el-button link @click="loadHead">重试全局汇总</el-button></template></el-alert>
      <div class="cards" v-loading="headLoading"><el-card shadow="never"><p>全历史参与记录数</p><strong>{{ head?.participant_record_count ?? '—' }}</strong></el-card><el-card shadow="never"><p>已成团团长记录数</p><strong>{{ head?.success_count ?? '—' }}</strong></el-card></div>
      <p class="hint">参与记录不是去重人数，包含退款和虚拟行。当前实际成员仅表示当前非退款、非虚拟且 UID 大于0的记录，不代表付款或成团资格。</p>
      <div class="filters"><label>搜索<el-input v-model="draftKeyword" aria-label="团记录搜索" maxlength="100" clearable placeholder="团长昵称 / UID / 活动商品" @keyup.enter="search" /></label><label>团状态<el-select v-model="draftStatus" aria-label="团记录状态" clearable><el-option label="全部状态" value="" /><el-option label="进行中" :value="1" /><el-option label="已成团" :value="2" /><el-option label="未成团" :value="3" /></el-select></label><label>活动ID<el-input v-model="draftActivity" aria-label="团记录活动ID" inputmode="numeric" clearable /></label><label>开始日期<input v-model="draftStart" type="date" aria-label="团记录开始日期" /></label><label>结束日期<input v-model="draftEnd" type="date" aria-label="团记录结束日期" /></label><div class="actions"><el-button :loading="listLoading" type="primary" @click="search">查询</el-button><el-button @click="reset">重置</el-button></div></div>
      <el-alert v-if="filterError" :title="filterError" type="warning" :closable="false" />
      <el-alert v-if="listError" :title="listError" type="error" :closable="false"><template #default><el-button link @click="loadList(page)">重试团列表</el-button></template></el-alert>
      <CombinationGroupTable :groups="groups" :loading="listLoading" :enabled="session.allowed.value" @members="showMembers" />
      <el-pagination v-if="!listLoading && !listError" :current-page="page" :page-size="15" :total="count" :page-count="Math.min(667,Math.max(1,Math.ceil(count/15)))" :disabled="listLoading" layout="total, prev, pager, next" @current-change="loadList" class="pager" />
    </template>
    <CombinationMembers v-model="membersVisible" :group-id="memberGroup" />
  </div>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import CombinationGroupTable from './CombinationGroupTable.vue';
import CombinationMembers from './CombinationMembers.vue';
import { apiCombinationGlobalHead, apiCombinationGroups, combinationReadDays, combinationReadId, type CombinationGlobalHead, type CombinationGroup, type CombinationGroupQuery } from '@/api/combinationStatistics';
import { useCombinationReadSession } from './combinationReadSession';
const head = ref<CombinationGlobalHead|null>(null), headLoading = ref(false), headError = ref(''), groups = ref<CombinationGroup[]>([]);
const listLoading = ref(false), listError = ref(''), filterError = ref(''), page = ref(1), count = ref(0);
const draftKeyword = ref(''), draftStatus = ref<''|1|2|3>(''), draftStart = ref(''), draftEnd = ref(''), draftActivity = ref('');
const membersVisible = ref(false), memberGroup = ref(0);
let applied: Omit<CombinationGroupQuery,'page'|'limit'> = { keyword:'',status:'' };
function discard() { head.value = null; groups.value = []; count.value = 0; page.value = 1; headLoading.value = listLoading.value = false; headError.value = listError.value = filterError.value = ''; membersVisible.value = false; memberGroup.value = 0; }
function resetFilters() { draftKeyword.value = draftStart.value = draftEnd.value = draftActivity.value = ''; draftStatus.value = ''; applied = { keyword:'',status:'' }; }
const session = useCombinationReadSession(() => 'combination_group.view', discard, () => { resetFilters(); reload(); });
function reload() { void loadHead(); void loadList(1); }
async function loadHead() {
  const job = session.begin('head'); if (!job) return; head.value = null; headLoading.value = true; headError.value = '';
  try { const result = await apiCombinationGlobalHead(job.signal); if (job.current()) head.value = result; }
  catch (reason) { if (job.current()) headError.value = reason instanceof Error ? reason.message : '全局汇总读取失败'; }
  finally { if (job.current()) headLoading.value = false; job.finish(); }
}
async function loadList(target = page.value) {
  if (!Number.isSafeInteger(target) || target < 1 || target > 667) return;
  const job = session.begin('list'); if (!job) return; groups.value = []; count.value = 0; page.value = target; listLoading.value = true; listError.value = ''; membersVisible.value = false;
  try { const result = await apiCombinationGroups({ ...applied,page:target,limit:15 },job.signal); if (job.current()) { groups.value = result.list; count.value = result.count; } }
  catch (reason) { if (job.current()) listError.value = reason instanceof Error ? reason.message : '团列表读取失败'; }
  finally { if (job.current()) listLoading.value = false; job.finish(); }
}
function search() {
  if (!session.allowed.value) return;
  try { const activity = draftActivity.value.trim(); if (activity && !combinationReadId(activity)) throw Error('请输入有效活动ID');
    const status = draftStatus.value || ''; if (![1,2,3,''].includes(status)) throw Error('团状态无效');
    applied = { keyword:draftKeyword.value.trim(),status,...combinationReadDays(draftStart.value,draftEnd.value),...(activity ? { combination_id:Number(activity) } : {}) }; filterError.value = ''; void loadList(1);
  } catch (reason) { filterError.value = reason instanceof Error ? reason.message : '筛选无效'; }
}
function reset() { resetFilters(); filterError.value = ''; void loadList(1); }
function showMembers(group: CombinationGroup) { if (!session.allowed.value || listLoading.value || !groups.value.includes(group)) return; memberGroup.value = group.id; membersVisible.value = true; }
</script>
<style scoped>
.combination-groups{min-width:0}.heading,.actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.heading h2{font-size:20px;margin:0}.hint{color:#747b87;font-size:12px;line-height:1.6;overflow-wrap:anywhere}.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:16px 0}.cards p{font-size:13px;color:#747b87}.cards strong{font-size:24px;overflow-wrap:anywhere}.filters{display:flex;align-items:end;gap:12px;flex-wrap:wrap;margin:18px 0}.filters label{display:grid;gap:6px;flex:1 1 160px;min-width:0;font-size:13px}.filters :deep(.el-select){width:100%}.filters input[type=date]{width:100%;box-sizing:border-box;min-width:0;padding:7px;border:1px solid #dcdfe6;border-radius:4px;font:inherit}.pager{display:flex;justify-content:flex-end;flex-wrap:wrap;margin:18px 0}@media(max-width:650px){.filters{display:grid;grid-template-columns:minmax(0,1fr)}.pager{justify-content:center}}
</style>
