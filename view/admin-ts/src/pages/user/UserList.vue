<template>
  <div class="user-list">
    <el-alert v-if="!owner.canView.value" title="当前账号没有用户查看权限" type="warning" :closable="false" show-icon />
    <template v-else>
      <el-card shadow="never" class="filter-card">
        <el-form class="user-filters" label-width="90px" @submit.prevent="search">
          <div class="filter-heading">
            <el-form-item label="用户搜索：" class="search-field">
              <el-input v-model="draft.nickname" aria-label="用户搜索" placeholder="请输入" maxlength="100" clearable @keyup.enter="search">
                <template #prepend><el-select v-model="draft.field_key" aria-label="用户搜索范围" style="width: 96px">
                  <el-option label="全部" value="all" /><el-option label="UID" value="uid" />
                  <el-option label="手机号" value="phone" /><el-option label="用户昵称" value="nickname" />
                </el-select></template>
              </el-input>
            </el-form-item>
            <div class="filter-actions">
              <el-button type="primary" :loading="loading" :disabled="moneyDialog.loading" @click="search">搜索</el-button>
              <el-button :disabled="moneyDialog.loading" @click="resetFilters">重置</el-button>
              <el-button link type="primary" :aria-expanded="expanded" aria-controls="user-advanced-filters" @click="expanded = !expanded">{{ expanded ? '收起' : '展开' }} {{ expanded ? '⌃' : '⌄' }}</el-button>
            </div>
          </div>
          <div v-if="expanded" id="user-advanced-filters" class="filter-grid">
            <el-form-item label="用户分组：">
              <div class="picker-field"><el-button class="picker-trigger" aria-label="选择用户分组" @click="openPicker('groups')">{{ chosen.groups[0]?.name ?? '请选择' }}</el-button>
                <el-button v-if="draft.group_id !== null" link aria-label="清除用户分组" @click="clearChoice('groups')">×</el-button></div>
            </el-form-item>
            <el-form-item label="用户标签：">
              <div class="picker-field"><el-button class="picker-trigger" aria-label="选择用户标签" @click="openPicker('labels')">{{ chosen.labels.length ? `已选择 ${chosen.labels.length} 个标签` : '请选择' }}</el-button>
                <el-button v-if="chosen.labels.length" link aria-label="清除用户标签" @click="clearChoice('labels')">×</el-button></div>
            </el-form-item>
            <el-form-item label="性别："><el-select v-model="draft.sex" @clear="draft.sex = ''" aria-label="性别" placeholder="请选择" clearable><el-option label="男" value="1" /><el-option label="女" value="2" /><el-option label="未知" value="0" /></el-select></el-form-item>
            <el-form-item label="会员等级："><div class="picker-field"><el-button class="picker-trigger" aria-label="选择会员等级" @click="openPicker('levels')">{{ chosen.levels[0]?.name ?? '请选择' }}</el-button><el-button v-if="draft.level !== null" link aria-label="清除会员等级" @click="clearChoice('levels')">×</el-button></div></el-form-item>
            <el-form-item label="付费会员："><el-select v-model="draft.isMember" @clear="draft.isMember = ''" aria-label="付费会员" placeholder="请选择" clearable><el-option label="是" value="1" /><el-option label="否" value="0" /></el-select></el-form-item>
            <el-form-item label="身份："><el-select v-model="draft.is_promoter" @clear="draft.is_promoter = ''" aria-label="身份" placeholder="请选择" clearable><el-option label="推广员" value="1" /><el-option label="普通用户" value="0" /></el-select></el-form-item>
            <el-form-item label="访问时间："><el-date-picker v-model="draft.dates" aria-label="访问时间（上海）" type="daterange" value-format="YYYY/MM/DD" format="YYYY/MM/DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" :editable="false" clearable /></el-form-item>
            <el-form-item label="访问情况："><el-select v-model="draft.user_time_type" @clear="draft.user_time_type = ''" aria-label="访问情况" placeholder="请选择" clearable><el-option label="时间段未访问" value="visitno" /><el-option label="时间段访问过" value="visit" /><el-option label="首次访问" value="add_time" /></el-select></el-form-item>
            <el-form-item label="下单次数："><el-select v-model="draft.pay_count" @clear="draft.pay_count = ''" aria-label="下单次数" placeholder="请选择" clearable><el-option label="0次" value="-1" /><el-option v-for="n in 5" :key="n" :label="`${n}次以上`" :value="String(n - 1)" /></el-select></el-form-item>
            <el-form-item label="国家："><el-select v-model="draft.country" @clear="draft.country = ''" aria-label="国家" placeholder="请选择" clearable @change="changeCountry"><el-option label="中国" value="domestic" /><el-option label="其他" value="abroad" /></el-select></el-form-item>
            <el-form-item v-if="draft.country === 'domestic'" label="省份："><el-select v-model="provinceId" aria-label="省份" filterable clearable placeholder="请选择" :loading="regionLoading" @visible-change="showProvinces" @change="chooseProvince"><el-option v-for="item in provinces" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item>
            <el-form-item v-if="draft.country === 'domestic'" label="城市："><el-select v-model="cityId" aria-label="城市" filterable clearable placeholder="请选择" :disabled="!provinceId || regionLoading" @change="chooseCity"><el-option v-for="item in cities" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item>
          </div>
          <div v-if="expanded && chosen.labels.length" class="selected-tags" aria-label="已选用户标签"><el-tag v-for="item in chosen.labels" :key="item.id" closable @close="removeLabel(item.id)">{{ item.name }}</el-tag></div>
          <p v-if="expanded" class="filter-help">访问时间按上海时间、最近访问或注册时间筛选；所选标签匹配任意一个，地区匹配省份或城市。“其他”沿用原版未填写地址的范围。</p>
          <el-alert v-if="validationError || regionError" :title="validationError || regionError" type="warning" :closable="false" show-icon class="filter-notice" />
        </el-form>
      </el-card>
      <el-card shadow="never" class="list-card">
        <nav class="source-tabs" role="tablist" aria-label="用户来源">
          <button v-for="tab in USER_SOURCE_TABS" :key="tab.value" type="button" role="tab" :aria-selected="source === tab.value"
            :class="{ active: source === tab.value }" :disabled="moneyDialog.loading" @click="changeSource(tab.value)">{{ tab.label }}</button>
        </nav>
        <div class="list-toolbar"><span>用户列表 <small>共 {{ total }} 位用户</small></span><el-button :loading="loading" :disabled="moneyDialog.loading" @click="load(page)">刷新</el-button></div>
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="notice"><template #default><el-button link type="primary" @click="load(page)">重试</el-button></template></el-alert>
        <el-alert v-if="unavailable.length" :title="`部分已应用条件已不可用：${unavailable.join('、')}。筛选仍保留，可重新选择或重置。`" type="warning" :closable="false" class="notice" />
        <div class="table-scroll">
          <el-table :data="list" v-loading="loading" row-key="uid" stripe empty-text="暂无匹配用户">
            <el-table-column prop="uid" label="UID" width="90" />
            <el-table-column label="用户信息" min-width="205"><template #default="{ row }"><div class="user-info"><el-avatar :src="row.avatar" :size="36">{{ row.nickname?.slice(0, 1) || '用' }}</el-avatar><div><div>{{ row.nickname || '—' }}</div><small>{{ row.phone || '—' }}</small></div></div></template></el-table-column>
            <el-table-column label="余额" min-width="110"><template #default="{ row }">¥{{ row.now_money }}</template></el-table-column>
            <el-table-column prop="integral" label="积分" width="95" />
            <el-table-column prop="level" label="会员等级" width="100" />
            <el-table-column label="状态" width="95"><template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : 'danger'">{{ row.status === 1 ? '正常' : '禁用' }}</el-tag></template></el-table-column>
            <el-table-column label="注册时间（上海）" min-width="165"><template #default="{ row }">{{ formatTime(row.add_time) }}</template></el-table-column>
            <el-table-column label="操作" :width="owner.canManage.value ? 175 : 95" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="showDetail(row)">详情</el-button><el-button v-if="owner.canManage.value" link type="primary" :disabled="moneyDialog.loading" @click="adjustMoney(row)">调整余额</el-button></template></el-table-column>
          </el-table>
        </div>
        <el-pagination v-if="!loading && !error" :current-page="page" :page-size="pageSize" :page-sizes="[15, 30, 50, 100]" :total="total" :disabled="loading || moneyDialog.loading"
          layout="total, sizes, prev, pager, next, jumper" class="pagination" @current-change="paginate" @size-change="changePageSize" />
      </el-card>
      <UserDirectoryOptionPicker v-if="pickerOpen" v-model="pickerOpen" :kind="pickerKind" :initial="chosen[pickerKind]" @apply="applyChoice" />
    </template>
    <!-- 调整余额弹窗 -->
    <el-dialog v-if="owner.canView.value" v-model="moneyDialog.show" title="调整余额" width="400px">
      <el-form label-width="80px">
        <el-form-item label="用户">
          <span>{{ moneyDialog.nickname }}</span>
        </el-form-item>
        <el-form-item label="操作">
          <el-radio-group v-model="moneyDialog.type">
            <el-radio value="add">增加</el-radio>
            <el-radio value="sub">减少</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="金额">
          <el-input-number v-model="moneyDialog.amount" :min="0" :precision="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="moneyDialog.show = false">取消</el-button>
        <el-button type="primary" :loading="moneyDialog.loading" @click="submitMoney">
          确定
        </el-button>
      </template>
    </el-dialog>

    <!-- 用户详情弹窗 -->
    <el-dialog v-if="owner.canView.value" v-model="detailDialog.show" title="用户详情" width="600px">
      <el-skeleton v-if="detailDialog.loading" :rows="6" animated />
      <template v-else-if="detail">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="UID">{{ detail.uid }}</el-descriptions-item>
          <el-descriptions-item label="昵称">{{ detail.nickname || "—" }}</el-descriptions-item>
          <el-descriptions-item label="手机号">{{ detail.phone || "—" }}</el-descriptions-item>
          <el-descriptions-item label="账号">{{ detail.account || "—" }}</el-descriptions-item>
          <el-descriptions-item label="余额">¥{{ detail.nowMoney || detail.now_money || "0" }}</el-descriptions-item>
          <el-descriptions-item label="积分">{{ detail.integral || 0 }}</el-descriptions-item>
          <el-descriptions-item label="会员等级">{{ detail.level || 0 }}</el-descriptions-item>
          <el-descriptions-item label="推广人UID">{{ detail.spreadUid || detail.spread_uid || 0 }}</el-descriptions-item>
          <el-descriptions-item label="推广人数">{{ detail.spreadCount || detail.spread_count || 0 }}</el-descriptions-item>
          <el-descriptions-item label="佣金">¥{{ detail.brokeragePrice || detail.brokerage_price || "0" }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="detail.status === 1 ? 'success' : 'danger'">
              {{ detail.status === 1 ? "正常" : "禁用" }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="注册时间">{{ formatTime(detail.addTime || detail.add_time) }}</el-descriptions-item>
        </el-descriptions>
      </template>
    </el-dialog>
  </div>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { apiAdminUserInfo, apiAdminUserMoney } from '@/api/order';
import { apiUserDirectory, apiUserFilterOptions, apiUserFilterRegions, type UserFilterRegion } from '@/api/userDirectory';
import { useUserDirectoryOwner } from '@/composables/useUserDirectoryOwner';
import { applyUserFilters, emptyUserFilters, USER_SOURCE_TABS, type DirectoryOption, type OptionKind, type UserDirectoryQuery, type UserSource } from '@/utils/userDirectoryFilters';
import type { AdminUser } from '@/types/admin';
import UserDirectoryOptionPicker from './UserDirectoryOptionPicker.vue';
const owner = useUserDirectoryOwner();
const list = ref<AdminUser[]>([]), total = ref(0), page = ref(1), pageSize = ref(15), loading = ref(false), error = ref('');
const draft = reactive(emptyUserFilters()), applied = ref<UserDirectoryQuery>({ field_key: 'all' }), source = ref<UserSource>('');
const chosen = reactive<Record<OptionKind, DirectoryOption[]>>({ groups: [], labels: [], levels: [] });
const appliedChoices = ref<Record<OptionKind, DirectoryOption[]>>({ groups: [], labels: [], levels: [] });
const unavailable = ref<string[]>([]), validationError = ref(''), expanded = ref(false);
const pickerOpen = ref(false), pickerKind = ref<OptionKind>('groups');
const provinceId = ref<number | undefined>(), cityId = ref<number | undefined>(), provinces = ref<UserFilterRegion[]>([]), cities = ref<UserFilterRegion[]>([]);
const regionLoading = ref(false), regionError = ref('');
const moneyDialog = reactive({ show: false, uid: 0, nickname: '', type: 'add' as 'add' | 'sub', amount: 0, loading: false });
const detailDialog = reactive({ show: false, loading: false });
const detail = ref<Record<string, any> | null>(null);
let mounted = false, listVersion = 0, regionVersion = 0, detailVersion = 0, moneyVersion = 0;
let listAbort: AbortController | null = null, regionAbort: AbortController | null = null, detailAbort: AbortController | null = null, moneyAbort: AbortController | null = null;
let moneyOwner = '';
function formatTime(value: number): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(value * 1000);
}
function closeDetail() { detailVersion++; detailAbort?.abort(); detailAbort = null; detail.value = null; detailDialog.show = false; detailDialog.loading = false; }
function clearList() { listVersion++; listAbort?.abort(); listAbort = null; list.value = []; total.value = 0; loading.value = false; error.value = ''; closeDetail(); }
function clearRegions() { regionVersion++; regionAbort?.abort(); regionAbort = null; regionLoading.value = false; regionError.value = ''; provinces.value = []; cities.value = []; provinceId.value = undefined; cityId.value = undefined; draft.province = ''; draft.city = ''; }
function resetState() {
  clearList(); clearRegions(); moneyVersion++; moneyAbort?.abort(); moneyAbort = null; moneyDialog.show = false; moneyDialog.loading = false; moneyOwner = '';
  Object.assign(draft, emptyUserFilters()); chosen.groups = []; chosen.labels = []; chosen.levels = []; appliedChoices.value = { groups: [], labels: [], levels: [] };
  applied.value = { field_key: 'all' }; source.value = ''; page.value = 1; pageSize.value = 15; unavailable.value = []; validationError.value = ''; pickerOpen.value = false;
}
async function load(target = page.value, fallback = true, checkChoices = true): Promise<boolean> {
  if (!mounted || !owner.has() || moneyDialog.loading || !Number.isSafeInteger(target) || target < 1 || target > 10000) return false;
  clearList(); const version = ++listVersion, stamp = owner.stamp(), controller = new AbortController(); listAbort = controller; loading.value = true; page.value = target;
  const limit = pageSize.value, query = { ...applied.value, user_type: source.value || undefined, page: target, limit };
  const choices = JSON.parse(JSON.stringify(appliedChoices.value)) as Record<OptionKind, DirectoryOption[]>;
  const active = () => mounted && owner.current(stamp) && version === listVersion && !controller.signal.aborted;
  try {
    const optionWork = checkChoices ? (Object.keys(choices) as OptionKind[]).filter(kind => choices[kind].some(item => item.id > 0)).map(async kind => {
      try {
        const ids = choices[kind].filter(item => item.id > 0).map(item => item.id);
        const options = await apiUserFilterOptions({ kind, page: 1, limit: 1, selected_ids: ids.join(',') }, controller.signal);
        return options.missing_ids.map(id => choices[kind].find(item => item.id === id)?.name ?? `#${id}`);
      } catch { return ['筛选选项校验失败，请刷新重试']; }
    }) : [];
    const [result, availability] = await Promise.all([apiUserDirectory(query, controller.signal), Promise.all(optionWork)]);
    if (!active()) return false;
    if (result.page !== target || result.limit !== limit) throw Error('用户分页结果与请求不一致');
    if (checkChoices) unavailable.value = [...new Set(availability.flat())];
    if (!result.list.length && target > 1 && fallback) return await load(Math.max(1, Math.min(10000, Math.ceil(result.count / limit))), false, false);
    list.value = result.list; total.value = result.count; page.value = result.count === 0 ? 1 : target; return true;
  } catch (failure) { if (active()) error.value = failure instanceof Error ? failure.message : '读取用户列表失败'; return false; }
  finally { if (version === listVersion) { listAbort = null; loading.value = false; } }
}
function search() {
  if (!owner.has() || moneyDialog.loading) return;
  try { const next = applyUserFilters(draft); applied.value = next; validationError.value = ''; unavailable.value = [];
    appliedChoices.value = { groups: chosen.groups.map(item => ({ ...item })), labels: chosen.labels.map(item => ({ ...item })), levels: chosen.levels.map(item => ({ ...item })) }; void load(1);
  } catch (failure) { validationError.value = failure instanceof Error ? failure.message : '筛选条件无效'; }
}
function resetFilters() {
  if (!owner.has() || moneyDialog.loading) return;
  Object.assign(draft, emptyUserFilters()); chosen.groups = []; chosen.labels = []; chosen.levels = []; clearRegions();
  source.value = ''; applied.value = { field_key: 'all' }; appliedChoices.value = { groups: [], labels: [], levels: [] }; unavailable.value = []; validationError.value = ''; pickerOpen.value = false; void load(1);
}
function changeSource(value: UserSource) { if (owner.has() && !moneyDialog.loading && USER_SOURCE_TABS.some(tab => tab.value === value)) { source.value = value; void load(1); } }
function paginate(value: number) { void load(value, true, false); }
function showProvinces(visible: boolean) { if (visible) void loadProvinces(); }
function changePageSize(value: number) { if (owner.has() && !moneyDialog.loading && [15, 30, 50, 100].includes(value)) { pageSize.value = value; void load(1); } }
function openPicker(kind: OptionKind) { if (owner.has() && !moneyDialog.loading) { pickerKind.value = kind; pickerOpen.value = true; } }
function applyChoice(value: DirectoryOption[]) {
  if (!owner.has() || !pickerOpen.value || moneyDialog.loading) return;
  const kind = pickerKind.value; chosen[kind] = value.map(item => ({ ...item }));
  if (kind === 'groups') draft.group_id = value[0]?.id ?? null;
  if (kind === 'levels') draft.level = value[0]?.id ?? null;
  if (kind === 'labels') draft.label_ids = value.map(item => item.id);
}
function clearChoice(kind: OptionKind) { if (owner.has()) { chosen[kind] = []; if (kind === 'groups') draft.group_id = null; if (kind === 'levels') draft.level = null; if (kind === 'labels') draft.label_ids = []; } }
function removeLabel(id: number) { if (owner.has()) { chosen.labels = chosen.labels.filter(item => item.id !== id); draft.label_ids = chosen.labels.map(item => item.id); } }
function changeCountry() { if (!owner.has()) return; clearRegions(); if (draft.country === 'domestic') void loadProvinces(); }
async function loadProvinces() { if (provinces.value.length || regionLoading.value || draft.country !== 'domestic') return; await readRegions(0); }
async function readRegions(pid: number) {
  if (!mounted || !owner.has() || draft.country !== 'domestic') return;
  regionVersion++; regionAbort?.abort(); const version = regionVersion, stamp = owner.stamp(), controller = new AbortController(); regionAbort = controller; regionLoading.value = true; regionError.value = '';
  const active = () => mounted && owner.current(stamp) && version === regionVersion && draft.country === 'domestic' && !controller.signal.aborted && (!pid || provinceId.value === pid);
  try { const data = await apiUserFilterRegions(pid, controller.signal); if (active()) { if (pid) cities.value = data; else provinces.value = data; } }
  catch (failure) { if (active()) regionError.value = failure instanceof Error ? failure.message : '读取地区失败'; }
  finally { if (version === regionVersion) { regionAbort = null; regionLoading.value = false; } }
}
function chooseProvince(id: number | undefined) {
  if (!owner.has()) return; const row = provinces.value.find(item => item.id === id); provinceId.value = row?.id; draft.province = row?.name ?? ''; draft.city = ''; cityId.value = undefined; cities.value = [];
  regionVersion++; regionAbort?.abort(); regionLoading.value = false; if (row) void readRegions(row.id);
}
function chooseCity(id: number | undefined) { if (owner.has()) { const row = cities.value.find(item => item.id === id); cityId.value = row?.id; draft.city = row?.name ?? ''; } }
function listed(row: AdminUser) { return !loading.value && list.value.some(item => item.uid === row.uid && item.account === row.account); }
async function showDetail(row: AdminUser) {
  if (!owner.has() || !listed(row)) return;
  closeDetail(); const version = ++detailVersion, stamp = owner.stamp(), controller = new AbortController(); detailAbort = controller; detailDialog.show = true; detailDialog.loading = true;
  const active = () => mounted && owner.current(stamp) && version === detailVersion && detailDialog.show && !controller.signal.aborted && listed(row);
  try { const data = await apiAdminUserInfo(row.uid, controller.signal) as unknown as Record<string, unknown>;
    if (!active()) return; if (data.uid !== row.uid) throw Error('用户详情与请求不一致');
    detail.value = Object.fromEntries(['uid', 'nickname', 'phone', 'account', 'nowMoney', 'now_money', 'integral', 'level', 'spreadUid', 'spread_uid', 'spreadCount', 'spread_count', 'brokeragePrice', 'brokerage_price', 'status', 'addTime', 'add_time'].map(key => [key, data[key]]));
  } catch (failure) { if (active()) { detailDialog.show = false; ElMessage.error(failure instanceof Error ? failure.message : '读取用户详情失败'); } }
  finally { if (version === detailVersion) { detailAbort = null; detailDialog.loading = false; } }
}
function adjustMoney(row: AdminUser) {
  if (!owner.has('user.manage') || !listed(row) || moneyDialog.loading) return;
  moneyOwner = owner.stamp(); Object.assign(moneyDialog, { show: true, uid: row.uid, nickname: row.nickname || row.phone, type: 'add', amount: 0 });
}
async function submitMoney() {
  if (!owner.has('user.manage') || !owner.current(moneyOwner) || !moneyDialog.show || moneyDialog.loading || !list.value.some(row => row.uid === moneyDialog.uid)) return;
  if (!Number.isFinite(moneyDialog.amount) || moneyDialog.amount <= 0 || !/^\d{1,10}(?:\.\d{1,2})?$/.test(String(moneyDialog.amount))) { ElMessage.error('请输入有效金额'); return; }
  const version = ++moneyVersion, stamp = owner.stamp(), controller = new AbortController(); moneyAbort = controller; moneyDialog.loading = true;
  try { await apiAdminUserMoney(moneyDialog.uid, String(moneyDialog.amount), moneyDialog.type, controller.signal);
    if (!owner.current(stamp) || version !== moneyVersion || !owner.has('user.manage')) return;
    moneyDialog.show = false; ElMessage.success('调整已提交，请核对最新余额'); moneyDialog.loading = false; await load(page.value);
  } catch (failure) { if (owner.current(stamp) && version === moneyVersion) ElMessage.error(failure instanceof Error ? failure.message : '调整失败'); }
  finally { if (version === moneyVersion) { moneyAbort = null; moneyDialog.loading = false; } }
}
watch([owner.identity, owner.canView], () => { resetState(); if (mounted && owner.has()) void load(1); }, { flush: 'sync' });
onMounted(() => { mounted = true; if (owner.has()) void load(1); });
onBeforeUnmount(() => { mounted = false; resetState(); });
</script>
<style scoped>
.user-list { min-width: 0; --directory-primary: #2d8cf0; }
.filter-card { margin-bottom: 15px; border: 0; border-radius: 4px; }
.filter-card :deep(.el-card__body) { padding: 20px 20px 6px; }
.filter-heading { display: flex; justify-content: space-between; gap: 20px; flex-wrap: wrap; align-items: flex-start; }
.search-field { width: min(450px, 100%); }
.filter-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding-bottom: 18px; }
.filter-actions :deep(.el-button + .el-button) { margin-left: 0; }
.filter-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 24px; }
.user-filters :deep(.el-form-item) { margin-bottom: 20px; min-width: 0; }
.user-filters :deep(.el-form-item__content) { min-width: 0; }
.user-filters :deep(.el-input), .user-filters :deep(.el-select), .user-filters :deep(.el-date-editor) { width: 100%; max-width: 250px; min-width: 0; }
.picker-field { display: flex; align-items: center; width: 100%; max-width: 250px; gap: 4px; }
.picker-trigger { flex: 1; min-width: 0; justify-content: flex-start; color: #606266; overflow: hidden; text-overflow: ellipsis; }
.filter-help { color: #909399; font-size: 12px; line-height: 1.6; margin: 0 0 14px 90px; }
.selected-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 16px 90px; }
.filter-notice { margin-bottom: 14px; }
.list-card { border: 0; border-radius: 4px; }
.list-card :deep(.el-card__body) { padding: 0 20px 20px; }
.source-tabs { display: flex; gap: 28px; overflow-x: auto; border-bottom: 1px solid #e8eaec; margin-bottom: 20px; }
.source-tabs button { border: 0; background: transparent; white-space: nowrap; color: #515a6e; cursor: pointer; padding: 17px 0 14px; border-bottom: 2px solid transparent; font: inherit; font-size: 14px; }
.source-tabs button.active { color: var(--directory-primary); border-bottom-color: var(--directory-primary); }
.source-tabs button:focus-visible { outline: 2px solid var(--directory-primary); outline-offset: -2px; }
.list-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 18px; font-size: 14px; }
.list-toolbar small { margin-left: 12px; font-size: 12px; color: #909399; }
.table-scroll { max-width: 100%; overflow-x: auto; }
.user-info { display: flex; align-items: center; gap: 10px; }
.user-info > div { min-width: 0; overflow-wrap: anywhere; }
.user-info small { color: #909399; }
.pagination { margin-top: 20px; justify-content: flex-end; flex-wrap: wrap; }
.notice { margin-bottom: 14px; }
@media (max-width: 1200px) { .filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 700px) { .filter-grid { grid-template-columns: minmax(0, 1fr); } .filter-heading { gap: 0; } .search-field { width: 100%; } .filter-help, .selected-tags { margin-left: 0; } .source-tabs { gap: 22px; } .pagination { justify-content: flex-start; } }
</style>
