<template>
  <div class="combination-statistics">
    <div class="heading"><div><h2>拼团活动统计 <small v-if="head">#{{ head.id }} · {{ head.store_name }}</small></h2><p class="hint">历史汇总、团长记录和已支付主订单分别统计。</p></div><el-button v-if="session.allowed.value && id" @click="reload">刷新</el-button></div>
    <el-alert v-if="!session.allowed.value" title="当前账号没有拼团统计查看权限" type="warning" :closable="false" />
    <div v-else-if="!id" class="chooser"><p>输入活动ID查看统计</p><el-input v-model="idInput" aria-label="拼团统计活动ID" inputmode="numeric" maxlength="10" @keyup.enter="openId" /><el-button type="primary" @click="openId">打开统计</el-button><p v-if="idError" class="bad">{{ idError }}</p></div>
    <template v-else>
      <el-alert v-if="headError" :title="headError" type="error" :closable="false"><template #default><el-button link @click="loadHead">重试活动汇总</el-button></template></el-alert>
      <el-alert v-if="head?.activity_deleted" title="活动已删除；这里保留历史统计，不能据此重新购买" type="info" :closable="false" />
      <div class="cards" v-loading="headLoading"><el-card v-for="card in cards" :key="card.label" shadow="never"><p>{{ card.label }}</p><strong>{{ card.value }}</strong></el-card></div>
      <p class="hint">沿旧历史口径：参与人数包含 UID 0；推广人数是团员不同 UID 数，不是推广归因。发起与成团数按团长记录计数，包含退款记录。支付毛额和支付人数只统计 type3、paid1、pid0/-1主单，包含后续退款和已删除订单，不代表净收入。</p>
      <el-tabs v-model="tab" @tab-change="changeTab"><el-tab-pane label="活动参与人（团长记录）" name="groups" /><el-tab-pane label="活动订单" name="orders" /></el-tabs>
      <div class="filters"><label>搜索<el-input v-model="draftKeyword" aria-label="拼团统计搜索" maxlength="100" clearable :placeholder="tab === 'groups' ? '团长昵称 / UID / 活动商品' : '订单号、用户、电话、地址联系人、商品或活动'" @keyup.enter="search" /></label><label v-if="tab === 'groups'">团状态<el-select v-model="draftGroupStatus" aria-label="统计团状态" clearable><el-option value="" label="全部状态" /><el-option :value="1" label="进行中" /><el-option :value="2" label="已成团" /><el-option :value="3" label="未成团" /></el-select></label><label v-else>订单状态<el-select v-model="draftOrderStatus" aria-label="统计订单状态" clearable><el-option value="" label="全部状态" /><el-option :value="0" label="未支付（此页无数据）" /><el-option :value="1" label="待发货" /><el-option :value="2" label="待收货 / 待核销" /><el-option :value="3" label="待评价" /><el-option :value="4" label="已完成" /><el-option :value="5" label="待核销" /></el-select></label><template v-if="tab === 'groups'"><label>开始日期<input v-model="draftStart" type="date" aria-label="统计开始日期" /></label><label>结束日期<input v-model="draftEnd" type="date" aria-label="统计结束日期" /></label></template><div class="actions"><el-button type="primary" :loading="listLoading" @click="search">查询</el-button><el-button @click="reset">重置</el-button></div></div>
      <el-alert v-if="filterError" :title="filterError" type="warning" :closable="false" />
      <el-alert v-if="listError" :title="listError" type="error" :closable="false"><template #default><el-button link @click="loadList(page)">重试统计列表</el-button></template></el-alert>
      <CombinationGroupTable v-if="tab === 'groups'" :groups="groups" :loading="listLoading" :enabled="session.allowed.value" @members="showMembers" />
      <div v-else class="table-scroll"><el-table :data="orders" v-loading="listLoading" row-key="id" border empty-text="暂无已支付主订单">
        <el-table-column label="业务订单号" min-width="240"><template #default="{ row }"><el-button v-if="canOrder(row)" link type="primary" @click="openOrder(row)">{{ row.order_id }}</el-button><span v-else>{{ row.order_id || '订单身份不可核对' }}</span><p v-if="row.deleted" class="hint">订单已删除，仅保留历史</p></template></el-table-column>
        <el-table-column prop="uid" label="UID" width="90" /><el-table-column prop="nickname" label="用户昵称" min-width="130" /><el-table-column prop="real_name" label="订单姓名" min-width="130" /><el-table-column prop="user_phone" label="订单电话" min-width="150" /><el-table-column prop="status" label="订单状态" min-width="130" />
        <el-table-column prop="pay_price" label="支付毛额（元）" min-width="145" /><el-table-column prop="total_num" label="商品数" width="100" />
        <el-table-column label="下单时间" min-width="180"><template #default="{ row }">{{ time(row.add_time) }}</template></el-table-column><el-table-column label="支付时间" min-width="180"><template #default="{ row }">{{ time(row.pay_time) }}</template></el-table-column>
        <el-table-column label="退款状态（原值）" min-width="145"><template #default="{ row }">{{ row.refund_status }} / {{ row.refund_type }}<p v-if="row.issues.length" class="bad">{{ row.issues.join('；') }}</p></template></el-table-column>
      </el-table></div>
      <el-pagination v-if="!listLoading && !listError" :current-page="page" :page-size="15" :total="count" :page-count="Math.min(667,Math.max(1,Math.ceil(count/15)))" :disabled="listLoading" layout="total, prev, pager, next" @current-change="loadList" class="pager" />
      <p v-if="tab === 'orders'" class="hint">列表与总数使用同一已支付主单口径；选择未支付恒为空，不改变历史支付汇总。</p>
    </template>
    <CombinationMembers v-model="membersVisible" :group-id="memberGroup" :activity-id="id || undefined" />
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import CombinationGroupTable from './CombinationGroupTable.vue';
import CombinationMembers from './CombinationMembers.vue';
import { apiCombinationStatisticsHead, apiCombinationStatisticsGroups, apiCombinationStatisticsOrders, combinationReadId, combinationReadDays, combinationReadOrderAvailable, type CombinationStatisticsHead, type CombinationGroup, type CombinationStatisticsOrder, type CombinationGroupQuery, type CombinationOrderQuery } from '@/api/combinationStatistics';
import { useCombinationReadSession, combinationReadTime as time } from './combinationReadSession';
const route = useRoute(), router = useRouter(), id = computed(() => combinationReadId(route.params.id));
const idInput = ref(''), idError = ref(''), head = ref<CombinationStatisticsHead|null>(null), headLoading = ref(false), headError = ref('');
const tab = ref<'groups'|'orders'>('groups'), groups = ref<CombinationGroup[]>([]), orders = ref<CombinationStatisticsOrder[]>([]);
const page = ref(1), count = ref(0), listLoading = ref(false), listError = ref(''), filterError = ref('');
const draftKeyword = ref(''), draftGroupStatus = ref<''|1|2|3>(''), draftOrderStatus = ref<''|0|1|2|3|4|5>(''), draftStart = ref(''), draftEnd = ref('');
const membersVisible = ref(false), memberGroup = ref(0);
let groupQuery: Omit<CombinationGroupQuery,'page'|'limit'|'combination_id'> = { keyword:'',status:'' }, orderQuery: Omit<CombinationOrderQuery,'page'|'limit'> = { keyword:'',status:'' };
function discard() { head.value = null; groups.value = []; orders.value = []; count.value = 0; page.value = 1; headLoading.value = listLoading.value = false; headError.value = listError.value = filterError.value = ''; membersVisible.value = false; memberGroup.value = 0; }
function resetFilters() { draftKeyword.value = draftStart.value = draftEnd.value = ''; draftGroupStatus.value = draftOrderStatus.value = ''; groupQuery = { keyword:'',status:'' }; orderQuery = { keyword:'',status:'' }; }
const session = useCombinationReadSession(() => 'combination_statistics.view', discard, () => { resetFilters(); reload(); });
const cards = computed(() => [
  { label:'活动参与人数（含虚拟UID）',value:head.value?.people_count ?? '—' }, { label:'推广人数（参团不同UID）',value:head.value?.spread_count ?? '—' },
  { label:'发起拼团数（团长记录）',value:head.value?.start_count ?? '—' }, { label:'成团数（已成团队长记录）',value:head.value?.success_count ?? '—' },
  { label:'支付订单毛额（元）',value:head.value?.pay_price ?? '—' }, { label:'支付人数（不同UID）',value:head.value?.pay_count ?? '—' },
]);
function reload() { if (!id.value) return; void loadHead(); void loadList(1); }
async function loadHead() {
  if (!id.value) return; const job = session.begin('head'); if (!job) return; const activity = id.value; head.value = null; headError.value = ''; headLoading.value = true;
  try { const result = await apiCombinationStatisticsHead(activity,job.signal); if (job.current() && activity === id.value) head.value = result; }
  catch (reason) { if (job.current()) headError.value = reason instanceof Error ? reason.message : '活动汇总读取失败'; }
  finally { if (job.current()) headLoading.value = false; job.finish(); }
}
async function loadList(target = page.value) {
  if (!id.value || !Number.isSafeInteger(target) || target < 1 || target > 667) return;
  const job = session.begin('list'); if (!job) return; const activity = id.value, selected = tab.value;
  groups.value = []; orders.value = []; count.value = 0; page.value = target; listLoading.value = true; listError.value = ''; membersVisible.value = false;
  try { const result = selected === 'groups' ? await apiCombinationStatisticsGroups(activity,{ ...groupQuery,page:target,limit:15 },job.signal) : await apiCombinationStatisticsOrders(activity,{ ...orderQuery,page:target,limit:15 },job.signal);
    if (job.current() && activity === id.value && selected === tab.value) { if (selected === 'groups') groups.value = result.list as CombinationGroup[]; else orders.value = result.list as CombinationStatisticsOrder[]; count.value = result.count; }
  } catch (reason) { if (job.current()) listError.value = reason instanceof Error ? reason.message : '统计列表读取失败'; }
  finally { if (job.current()) listLoading.value = false; job.finish(); }
}
function search() {
  if (!session.allowed.value) return;
  try { const keyword = draftKeyword.value.trim(); if (tab.value === 'groups') groupQuery = { keyword,status:draftGroupStatus.value || '',...combinationReadDays(draftStart.value,draftEnd.value) }; else orderQuery = { keyword,status:draftOrderStatus.value ?? '' }; filterError.value = ''; void loadList(1); }
  catch (reason) { filterError.value = reason instanceof Error ? reason.message : '筛选无效'; }
}
function reset() { resetFilters(); filterError.value = ''; void loadList(1); }
function changeTab() { session.cancel('list'); groups.value = []; orders.value = []; count.value = 0; page.value = 1; membersVisible.value = false; void loadList(1); }
function showMembers(group: CombinationGroup) { if (!session.allowed.value || listLoading.value || !groups.value.includes(group)) return; memberGroup.value = group.id; membersVisible.value = true; }
function canOrder(row: CombinationStatisticsOrder) { return session.allowed.value && session.has('order.view') && orders.value.includes(row) && combinationReadOrderAvailable(row); }
function openOrder(row: CombinationStatisticsOrder) { if (canOrder(row)) void router.push('/order/' + encodeURIComponent(row.order_id)); }
function openId() { const target = combinationReadId(idInput.value.trim()); if (!target) { idError.value = '请输入有效拼团活动ID'; return; } if (!session.allowed.value) return; idError.value = ''; void router.push('/activity/combination-statistics/' + target); }
watch(id, () => { session.invalidate(); resetFilters(); tab.value = 'groups'; reload(); }, { flush:'sync' });
</script>
<style scoped>
.combination-statistics{min-width:0}.heading,.actions{display:flex;gap:12px;justify-content:space-between;align-items:center;flex-wrap:wrap}.heading h2{margin:0;font-size:20px}.heading small{font-size:14px;color:#747b87;font-weight:400;overflow-wrap:anywhere}.hint,.bad{font-size:12px;line-height:1.6;overflow-wrap:anywhere}.hint{color:#747b87}.bad{color:#c45656}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:16px 0}.cards p{font-size:12px;color:#747b87}.cards strong{font-size:23px;overflow-wrap:anywhere}.filters{display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin:18px 0}.filters label{display:grid;gap:6px;min-width:0;flex:1 1 180px;font-size:13px}.filters :deep(.el-select){width:100%}.filters input[type=date]{width:100%;box-sizing:border-box;min-width:0;padding:7px;border:1px solid #dcdfe6;border-radius:4px;font:inherit}.table-scroll{max-width:100%;overflow-x:auto;min-width:0}.pager{justify-content:flex-end;flex-wrap:wrap;margin-top:18px}.chooser{display:flex;gap:12px;flex-wrap:wrap;max-width:500px}.chooser p{flex-basis:100%}.chooser :deep(.el-input){min-width:0;flex:1}@media(max-width:650px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.filters{display:grid;grid-template-columns:minmax(0,1fr)}.pager{justify-content:center}}
</style>
