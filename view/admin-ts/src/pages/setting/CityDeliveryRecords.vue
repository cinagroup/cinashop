<template>
  <div class="city-delivery-records">
    <header class="heading"><div><h2>同城配送记录</h2><p class="hint">查看本地保存的配送记录，每次发单尝试分别保留。</p></div><el-tag type="info">仅查询</el-tag></header>
    <el-alert v-if="!canView" title="当前账号没有同城配送记录查看权限" type="warning" :closable="false" show-icon />
    <template v-else>
      <el-alert title="取消发单、取消费用确认与订单回退尚未贯通" type="info" :closable="false" show-icon>
        <template #default>本页展示已保存的记录与历史状态，不向配送平台刷新状态，也不能取消发单。</template>
      </el-alert>
      <el-card shadow="never">
        <el-form label-position="top" :disabled="!canView || loading" @submit.prevent="search">
          <div class="filters">
            <el-form-item label="配送时间（上海时间，起止秒均包含）" class="date-field">
              <div v-if="viewportWidth <= 700" class="mobile-dates">
                <label><span>开始时间</span><el-date-picker v-model="draftStart" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm:ss" placeholder="选择开始时间" :disabled="!canView || loading" :popper-options="mobileDatePopper" aria-label="配送开始时间" /></label>
                <label><span>结束时间</span><el-date-picker v-model="draftEnd" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm:ss" placeholder="选择结束时间" :disabled="!canView || loading" :popper-options="mobileDatePopper" aria-label="配送结束时间" /></label>
              </div>
              <el-date-picker v-else v-model="draftDates" type="datetimerange" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm:ss" range-separator="至" start-placeholder="开始时间" end-placeholder="结束时间" :disabled="!canView || loading" aria-label="配送时间范围" />
            </el-form-item>
            <el-form-item label="门店选择" class="store-field">
              <el-select v-model="draftStoreId" clearable filterable placeholder="全部门店" aria-label="配送门店" :disabled="!canView || loading || storesLoading" @change="selectStore">
                <el-option v-for="store in storeOptions" :key="store.id" :label="cityDeliveryStoreLabel(store)" :value="store.id" />
              </el-select>
              <div class="store-search"><el-input v-model="storeKeyword" maxlength="200" placeholder="门店名称关键词" aria-label="门店搜索关键词" :disabled="!canView || loading || storesLoading" @keyup.enter="searchStores" /><el-button :loading="storesLoading" :disabled="!canView || loading || storesLoading" @click="searchStores">搜索门店</el-button></div>
              <p v-if="selectedStore?.issues.length" class="hint issue">{{ selectedStore.issues.map(cityDeliveryIssueLabel).join('；') }}</p>
              <el-alert v-if="storesError" :title="storesError" type="warning" :closable="false" show-icon class="store-error" />
              <div class="store-pager"><span>门店第 {{ stores?.page ?? 1 }} 页，共 {{ stores?.total ?? 0 }} 个</span><el-button size="small" :disabled="!canView || loading || storesLoading || !stores || stores.page <= 1" @click="loadStores((stores?.page ?? 1) - 1)">上一页门店</el-button><el-button size="small" :disabled="!canView || loading || storesLoading || !stores || stores.page * stores.limit >= stores.total || stores.page * stores.limit > 100000" @click="loadStores((stores?.page ?? 1) + 1)">下一页门店</el-button></div>
            </el-form-item>
            <el-form-item label="配送平台"><el-select v-model="draftStation" clearable placeholder="全部平台" aria-label="配送平台筛选" :disabled="!canView || loading"><el-option label="达达配送" value="1" /><el-option label="UU跑腿" value="2" /></el-select></el-form-item>
            <el-form-item label="配送状态"><el-select v-model="draftStatus" clearable filterable allow-create default-first-option placeholder="全部状态，可输入状态码" aria-label="配送状态筛选" :disabled="!canView || loading"><el-option v-for="status in statusOptions" :key="status.value" :label="status.label" :value="status.value" /></el-select><p class="hint">状态 1 的历史含义需核对；未知状态可按原始代码查询。</p></el-form-item>
            <el-form-item label="配送订单号 / 配送编号 / 原订单号" class="keyword-field"><el-input v-model="draftKeyword" maxlength="200" clearable placeholder="输入订单号的一部分" aria-label="配送订单搜索" :disabled="!canView || loading" @keyup.enter="search" /></el-form-item>
            <div class="actions"><el-button type="primary" :loading="loading" :disabled="!canView || loading" @click="search">查询</el-button><el-button :disabled="!canView || loading" @click="resetFilters">重置</el-button></div>
          </div>
        </el-form>
        <p class="hint">修改筛选条件后点击查询。翻页和调整每页条数沿用上次确认的筛选条件；门店搜索单独分页，已选择的隐藏或删除门店会继续保留。</p>
        <el-alert v-if="filterError" :title="filterError" type="error" :closable="false" show-icon />
      </el-card>
      <el-card shadow="never" class="results">
        <el-alert v-if="listError" :title="result ? '本次读取失败，以下为上次读取结果，可能已过时' : '配送记录读取失败'" type="error" :closable="false" show-icon><template #default><p>{{ listError }}</p><el-button link type="primary" :disabled="!canView || loading" @click="load(applied)">重新读取本次查询</el-button></template></el-alert>
        <p v-if="loading && result" class="hint stale" role="status">正在读取新的查询，下方仍为上次读取结果。</p>
        <p v-if="result" class="hint result-caption">已显示：{{ resultCaption }}。时间为上海时间。</p>
        <div class="table-container">
          <el-table :data="result?.items ?? []" v-loading="loading" border row-key="id" :empty-text="loading ? '读取中…' : listError ? '本次读取失败' : '暂无配送记录'">
            <el-table-column prop="id" label="记录 ID" width="95" />
            <el-table-column label="归属名称" min-width="240"><template #default="{ row }"><div class="owner"><el-avatar :size="34" shape="square" :src="cityDeliveryImage(row.owner.image)">{{ row.owner.label.slice(0, 1) || '？' }}</el-avatar><div><span>{{ cityDeliveryOwnerLabel(row.owner) }}</span><div class="tags"><el-tag v-if="row.owner.is_show === 0" size="small" type="info">已隐藏</el-tag><el-tag v-if="row.owner.is_del === 1" size="small" type="warning">已删除</el-tag></div></div></div></template></el-table-column>
            <el-table-column label="配送平台" min-width="140"><template #default="{ row }">{{ row.provider_label }}<p class="hint">平台代码 {{ row.station_type }}</p></template></el-table-column>
            <el-table-column label="配送订单号 / 编号" min-width="220"><template #default="{ row }"><div>{{ row.order_id || '未记录配送订单号' }}</div><p class="hint">配送编号：{{ row.delivery_no || '未记录' }}</p></template></el-table-column>
            <el-table-column label="原订单号" min-width="200"><template #default="{ row }"><span :class="{ issue: !row.origin_order }">{{ cityDeliveryOriginLabel(row) }}</span><el-tag v-if="row.origin_order?.is_del === 1" size="small" type="info">已删除</el-tag><p class="hint">关联 OID {{ row.oid }} · UID {{ row.uid }}</p></template></el-table-column>
            <el-table-column prop="from_address" label="配送起点" min-width="210" show-overflow-tooltip />
            <el-table-column prop="to_address" label="配送终点" min-width="210" show-overflow-tooltip />
            <el-table-column label="配送状态" min-width="165"><template #default="{ row }"><el-tag :type="row.issues.length ? 'warning' : 'info'">{{ row.status_label }}</el-tag><p class="hint">状态代码 {{ row.status }}</p></template></el-table-column>
            <el-table-column label="配送距离" min-width="155"><template #default="{ row }">{{ cityDeliveryDistance(row.distance_km) }}<p v-if="row.distance_meters !== null" class="hint">保存值 {{ row.distance_meters }} 米</p></template></el-table-column>
            <el-table-column label="货物金额" min-width="155"><template #default="{ row }">{{ cityDeliveryMoney(row.cargo_price) }}</template></el-table-column>
            <el-table-column label="配送费用" min-width="155"><template #default="{ row }">{{ cityDeliveryMoney(row.fee) }}</template></el-table-column>
            <el-table-column label="扣除费用" min-width="155"><template #default="{ row }">{{ cityDeliveryMoney(row.deduct_fee) }}</template></el-table-column>
            <el-table-column label="记录时间" min-width="180"><template #default="{ row }">{{ cityDeliveryTime(row.add_time) }}</template></el-table-column>
            <el-table-column prop="mark" label="备注" min-width="210" show-overflow-tooltip />
            <el-table-column label="本地详情" width="120" fixed="right"><template #default="{ row }"><el-button link type="primary" :disabled="!canView || loading" :aria-label="`查看配送记录 ${row.id}`" @click="openDetail(row)">详情</el-button><el-tag v-if="row.issues.length || Object.keys(row.invalid_values).length" size="small" type="warning">需核对</el-tag></template></el-table-column>
          </el-table>
        </div>
        <el-pagination class="pager" :current-page="result?.page ?? applied.page" :page-size="result?.limit ?? applied.limit" :page-sizes="[10, 20, 50, 100]" :total="paginationTotal" :disabled="!canView || loading" layout="total, sizes, prev, pager, next" @current-change="changePage" @size-change="changeSize" />
        <p v-if="result && result.total > paginationTotal" class="hint">分页偏移上限为 100000 条，请缩小筛选范围查看后续记录；符合条件的记录共 {{ result.total }} 条。</p>
      </el-card>
      <el-dialog v-model="detailVisible" title="配送记录本地详情" width="min(940px, calc(100vw - 24px))" @closed="closeDetail">
        <p class="hint">这些是本地保存的发单与回调快照，未向配送平台重新查询。</p>
        <div v-loading="detailLoading" class="detail-content">
          <el-alert v-if="detailError" :title="detail ? '详情读取失败，保留上次读取的详情，可能已过时' : '详情读取失败'" type="error" :closable="false" show-icon><template #default><p>{{ detailError }}</p><el-button link type="primary" :disabled="!canView || detailLoading" @click="loadDetail">重新读取本地详情</el-button></template></el-alert>
          <template v-if="detail">
            <el-descriptions :column="descriptionColumns" border>
              <el-descriptions-item label="记录 ID">{{ detail.record.id }}</el-descriptions-item>
              <el-descriptions-item label="归属">{{ cityDeliveryOwnerLabel(detail.record.owner) }}</el-descriptions-item>
              <el-descriptions-item label="配送平台">{{ detail.record.provider_label }}（代码 {{ detail.record.station_type }}）</el-descriptions-item>
              <el-descriptions-item label="配送状态">{{ detail.record.status_label }}（代码 {{ detail.record.status }}）</el-descriptions-item>
              <el-descriptions-item label="配送订单号">{{ detail.record.order_id || '未记录' }}</el-descriptions-item>
              <el-descriptions-item label="配送编号">{{ detail.record.delivery_no || '未记录' }}</el-descriptions-item>
              <el-descriptions-item label="原订单号">{{ cityDeliveryOriginLabel(detail.record) }}</el-descriptions-item>
              <el-descriptions-item label="原订单关联">OID {{ detail.record.oid }} · UID {{ detail.record.uid }}<template v-if="detail.record.origin_order"> · 父订单 {{ detail.record.origin_order.pid }} · 状态 {{ detail.record.origin_order.status }} · 删除标记 {{ detail.record.origin_order.is_del }}</template></el-descriptions-item>
              <el-descriptions-item label="归属原始关联">类型 {{ detail.record.type }} · 关联 ID {{ detail.record.relation_id }} · 显示标记 {{ detail.record.owner.is_show ?? '未记录' }} · 删除标记 {{ detail.record.owner.is_del ?? '未记录' }}</el-descriptions-item>
              <el-descriptions-item label="配送距离">{{ cityDeliveryDistance(detail.record.distance_km) }}<template v-if="detail.record.distance_meters !== null">（保存值 {{ detail.record.distance_meters }} 米）</template></el-descriptions-item>
              <el-descriptions-item label="货物金额">{{ cityDeliveryMoney(detail.record.cargo_price) }}</el-descriptions-item>
              <el-descriptions-item label="配送费用">{{ cityDeliveryMoney(detail.record.fee) }}</el-descriptions-item>
              <el-descriptions-item label="扣除费用">{{ cityDeliveryMoney(detail.record.deduct_fee) }}</el-descriptions-item>
              <el-descriptions-item label="记录时间（上海）">{{ cityDeliveryTime(detail.record.add_time) }}</el-descriptions-item>
              <el-descriptions-item label="收货人">{{ detail.metadata.receiver_name || '未记录' }}</el-descriptions-item>
              <el-descriptions-item label="收货手机号">{{ detail.metadata.receiver_phone || '未记录' }}</el-descriptions-item>
              <el-descriptions-item label="配送起点" :span="descriptionColumns">{{ detail.metadata.from_address || '未记录' }}</el-descriptions-item>
              <el-descriptions-item label="配送终点" :span="descriptionColumns">{{ detail.metadata.to_address || '未记录' }}</el-descriptions-item>
              <el-descriptions-item label="城市代码">{{ detail.metadata.city_code || '未记录' }}</el-descriptions-item>
              <el-descriptions-item label="记录商户 ID">{{ detail.metadata.mer_id }}</el-descriptions-item>
              <el-descriptions-item label="备注" :span="descriptionColumns">{{ detail.metadata.mark || '未记录' }}</el-descriptions-item>
              <el-descriptions-item label="原因" :span="descriptionColumns">{{ detail.metadata.reason || '未记录' }}</el-descriptions-item>
            </el-descriptions>
            <el-alert v-if="detail.record.issues.length" title="历史记录需要核对" type="warning" :closable="false" show-icon class="detail-issues"><template #default><ul><li v-for="(issue, index) in detail.record.issues" :key="index">{{ cityDeliveryIssueLabel(issue) }}</li></ul></template></el-alert>
            <div v-if="Object.keys(detail.record.invalid_values).length" class="invalid-values"><strong>无效历史值（原样保留）</strong><dl><template v-for="(value, key) in detail.record.invalid_values" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></template></dl></div>
          </template>
        </div>
        <template #footer><el-button @click="detailVisible = false">关闭</el-button></template>
      </el-dialog>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { apiCityDeliveryRecords, apiCityDeliveryDetail, apiCityDeliveryStores, normalizeCityDeliveryQuery,
  normalizeCityDeliveryStoreQuery, cityDeliveryShanghaiSeconds, cityDeliveryTime, cityDeliveryMoney, cityDeliveryDistance,
  cityDeliveryOwnerLabel, cityDeliveryStoreLabel, cityDeliveryOriginLabel, cityDeliveryImage, cityDeliveryIssueLabel, cityDeliveryReadError, createCityDeliveryReadGuard,
  type CityDeliveryQuery, type CityDeliveryPage, type CityDeliveryRecord, type CityDeliveryStore, type CityDeliveryDetail } from '@/api/cityDeliveryRecords';

const auth = useAuthStore(), sessionVersion = ref(0);
let alive = false, syncing = false, stored = localStorage.getItem('admin_session');
const identity = computed(() => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}`);
const canView = computed(() => {
  void sessionVersion.value;
  const session = getAdminSession();
  return !!auth.token && auth.token === getToken() && stored === localStorage.getItem('admin_session') && !!auth.userInfo && !!session
    && session.userInfo.id === auth.userInfo.id && session.userInfo.level === auth.userInfo.level
    && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('city_delivery_record.view') && session.uniqueAuth.includes('city_delivery_record.view'));
});
const guard = createCityDeliveryReadGuard(() => alive && canView.value ? `${identity.value}:${localStorage.getItem('admin_session')}` : null);
const draftDates = ref<[string, string] | null>(null), draftStoreId = ref<number | ''>(''), draftStation = ref(''), draftStatus = ref(''), draftKeyword = ref('');
const mobileDatePopper = { modifiers: [
  { name: 'preventOverflow', options: { padding: 8, altAxis: true, tether: false, rootBoundary: 'viewport' } },
  { name: 'flip', options: { padding: 8, rootBoundary: 'viewport' } }
] };
function setDate(index: 0 | 1, value: string | null) { const pair: [string, string] = draftDates.value ? [...draftDates.value] : ['', '']; pair[index] = value ?? ''; draftDates.value = pair.some(Boolean) ? pair : null; }
const draftStart = computed({ get: () => draftDates.value?.[0] || null, set: (value: string | null) => setDate(0, value) });
const draftEnd = computed({ get: () => draftDates.value?.[1] || null, set: (value: string | null) => setDate(1, value) });
const applied = ref<CityDeliveryQuery>({ page: 1, limit: 20 }), result = ref<CityDeliveryPage<CityDeliveryRecord> | null>(null), resultQuery = ref<CityDeliveryQuery | null>(null);
const loading = ref(false), listError = ref(''), filterError = ref('');
const stores = ref<CityDeliveryPage<CityDeliveryStore> | null>(null), selectedStore = ref<CityDeliveryStore | null>(null), storesLoading = ref(false), storesError = ref(''), storeKeyword = ref(''), appliedStoreKeyword = ref('');
const storeOptions = computed(() => selectedStore.value && !stores.value?.items.some(store => store.id === selectedStore.value?.id) ? [selectedStore.value, ...(stores.value?.items ?? [])] : stores.value?.items ?? []);
const detailVisible = ref(false), detailId = ref(0), detail = ref<CityDeliveryDetail | null>(null), detailLoading = ref(false), detailError = ref(''), viewportWidth = ref(window.innerWidth);
const descriptionColumns = computed(() => viewportWidth.value <= 680 ? 1 : 2);
const paginationTotal = computed(() => result.value ? Math.min(result.value.total, (Math.floor(100000 / result.value.limit) + 1) * result.value.limit) : 0);
const knownStatuses = [{ value: '-1', label: '已取消（-1）' }, { value: '0', label: '初始记录（0）' }, { value: '1', label: '历史状态，含义待核对（1）' },
  { value: '2', label: '待取货（2）' }, { value: '3', label: '配送中（3）' }, { value: '4', label: '已完成（4）' }, { value: '9', label: '物品返回中（9）' }, { value: '10', label: '物品返回完成（10）' }, { value: '100', label: '骑士到店（100）' }];
const statusOptions = computed(() => { const options = [...knownStatuses]; for (const row of result.value?.items ?? []) if (!options.some(option => option.value === String(row.status))) options.push({ value: String(row.status), label: `${row.status_label}（${row.status}）` }); return options; });
const resultCaption = computed(() => {
  const query = resultQuery.value; if (!result.value || !query) return '';
  const parts = [`第 ${result.value.page} 页，每页 ${result.value.limit} 条，共 ${result.value.total} 条`];
  if (query.store_id !== undefined) parts.push(`门店 #${query.store_id}`);
  if (query.station_type !== undefined) parts.push(`平台代码 ${query.station_type}`);
  if (query.status !== undefined) parts.push(`状态代码 ${query.status}`);
  if (query.keyword !== undefined) parts.push(`关键词「${query.keyword}」`);
  if (query.date_from !== undefined && query.date_to !== undefined) parts.push(`${cityDeliveryTime(query.date_from, false)} 至 ${cityDeliveryTime(query.date_to, false)}（包含起止秒）`);
  return parts.join('，');
});
const message = cityDeliveryReadError;
function closeDetail() {
  if (detailVisible.value) return;
  guard.cancel('detail'); detailId.value = 0; detail.value = null; detailLoading.value = false; detailError.value = '';
}
function clear() {
  guard.reset(); detailVisible.value = false; closeDetail(); result.value = null; resultQuery.value = null; loading.value = false; listError.value = filterError.value = '';
  draftDates.value = null; draftStoreId.value = ''; draftStation.value = draftStatus.value = draftKeyword.value = ''; applied.value = { page: 1, limit: 20 };
  stores.value = null; selectedStore.value = null; storesLoading.value = false; storesError.value = storeKeyword.value = appliedStoreKeyword.value = '';
}
async function load(input: CityDeliveryQuery) {
  if (!canView.value) return;
  let query: CityDeliveryQuery;
  try { query = normalizeCityDeliveryQuery(input); } catch (reason) { filterError.value = message(reason); return; }
  const job = guard.begin('list'); if (!job) return;
  applied.value = query; loading.value = true; listError.value = ''; filterError.value = '';
  try { const value = await apiCityDeliveryRecords(query, job.controller.signal); if (guard.current('list', job)) { result.value = value; resultQuery.value = { ...query }; } }
  catch (reason) { if (guard.current('list', job)) listError.value = message(reason); }
  finally { if (guard.finish('list', job)) loading.value = false; }
}
function search() {
  if (!canView.value || loading.value) return;
  try {
    if (draftDates.value && (!draftDates.value[0] || !draftDates.value[1])) throw Error('配送时间须同时填写起止值');
    const query = normalizeCityDeliveryQuery({ page: 1, limit: applied.value.limit, store_id: draftStoreId.value,
      station_type: draftStation.value, status: draftStatus.value, keyword: draftKeyword.value,
      date_from: draftDates.value ? cityDeliveryShanghaiSeconds(draftDates.value[0]) : undefined,
      date_to: draftDates.value ? cityDeliveryShanghaiSeconds(draftDates.value[1]) : undefined });
    void load(query);
  } catch (reason) { filterError.value = message(reason); }
}
function resetFilters() { if (!canView.value || loading.value) return; draftDates.value = null; draftStoreId.value = ''; selectedStore.value = null; draftStation.value = draftStatus.value = draftKeyword.value = ''; search(); }
function changePage(page: number) { if (canView.value && !loading.value) void load({ ...applied.value, page }); }
function changeSize(limit: number) { if (canView.value && !loading.value) void load({ ...applied.value, page: 1, limit }); }
function selectStore(id: number | '' | undefined) { if (!canView.value || loading.value || storesLoading.value) return; selectedStore.value = storeOptions.value.find(store => store.id === id) ?? null; }
async function loadStores(page = 1) {
  if (!canView.value) return;
  let query;
  try { query = normalizeCityDeliveryStoreQuery({ page, limit: 20, keyword: appliedStoreKeyword.value }); } catch (reason) { storesError.value = message(reason); return; }
  const job = guard.begin('stores'); if (!job) return;
  storesLoading.value = true; storesError.value = '';
  try { const value = await apiCityDeliveryStores(query, job.controller.signal); if (guard.current('stores', job)) {
    stores.value = value; if (selectedStore.value) selectedStore.value = value.items.find(store => store.id === selectedStore.value?.id) ?? selectedStore.value;
  } } catch (reason) { if (guard.current('stores', job)) storesError.value = `${message(reason)}${stores.value ? '；门店选项保留上次读取结果，可能已过时。' : ''}`; }
  finally { if (guard.finish('stores', job)) storesLoading.value = false; }
}
function searchStores() {
  if (!canView.value || loading.value || storesLoading.value) return;
  try { const query = normalizeCityDeliveryStoreQuery({ page: 1, limit: 20, keyword: storeKeyword.value }); appliedStoreKeyword.value = query.keyword ?? ''; void loadStores(1); }
  catch (reason) { storesError.value = message(reason); }
}
async function openDetail(row: CityDeliveryRecord) {
  if (!canView.value || loading.value || !result.value?.items.some(item => item.id === row.id)) return;
  detailVisible.value = false; closeDetail(); detailId.value = row.id; detailVisible.value = true; await loadDetail();
}
async function loadDetail() {
  if (!canView.value || !detailVisible.value || !detailId.value) return;
  const id = detailId.value, job = guard.begin('detail'); if (!job) return;
  detailLoading.value = true; detailError.value = '';
  try { const value = await apiCityDeliveryDetail(id, job.controller.signal); if (guard.current('detail', job) && detailVisible.value && detailId.value === id) detail.value = value; }
  catch (reason) { if (guard.current('detail', job) && detailVisible.value && detailId.value === id) detailError.value = message(reason); }
  finally { if (guard.finish('detail', job)) detailLoading.value = false; }
}
function syncSession() {
  syncing = true; clear(); const session = getAdminSession();
  auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  stored = localStorage.getItem('admin_session'); sessionVersion.value++; syncing = false;
  if (canView.value) { void load({ page: 1, limit: 20 }); void loadStores(1); }
}
function syncStorage(event: StorageEvent) { if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') syncSession(); }
function resize() { viewportWidth.value = window.innerWidth; }
watch(identity, () => {
  if (!alive || syncing) return;
  clear(); stored = localStorage.getItem('admin_session'); sessionVersion.value++;
  if (canView.value) { void load({ page: 1, limit: 20 }); void loadStores(1); }
}, { flush: 'sync' });
watch(detailVisible, visible => { if (!visible) closeDetail(); }, { flush: 'sync' });
onMounted(() => { alive = true; window.addEventListener('admin-session-changed', syncSession); window.addEventListener('admin-auth-expired', syncSession); window.addEventListener('storage', syncStorage); window.addEventListener('resize', resize); syncSession(); });
onBeforeUnmount(() => { alive = false; clear(); guard.dispose(); window.removeEventListener('admin-session-changed', syncSession); window.removeEventListener('admin-auth-expired', syncSession); window.removeEventListener('storage', syncStorage); window.removeEventListener('resize', resize); });
</script>

<style scoped>
.mobile-dates{display:grid;gap:10px;width:100%}.mobile-dates label{display:grid;gap:4px;min-width:0}.mobile-dates label>span{font-size:12px;color:var(--el-text-color-secondary)}
.city-delivery-records{display:grid;gap:16px;min-width:0}.heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.heading h2{font-size:20px;margin:0 0 6px}.hint{font-size:13px;color:var(--el-text-color-secondary);line-height:1.65;margin:6px 0;overflow-wrap:anywhere}.filters{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 16px}.filters .date-field{grid-column:span 2}.filters .store-field{grid-row:span 2}.filters .el-form-item{min-width:0}.filters .el-select,.filters :deep(.el-date-editor),.filters :deep(.el-input){width:100%;min-width:0}.store-search{display:flex;gap:8px;width:100%;margin-top:8px}.store-pager{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px;line-height:1.5;font-size:12px}.store-pager .el-button+.el-button{margin-left:0}.store-error{margin-top:8px}.keyword-field{grid-column:span 2}.actions{display:flex;align-items:end;gap:8px;margin-bottom:18px}.actions .el-button+.el-button{margin-left:0}.table-container{max-width:100%;overflow:hidden}.pager{margin-top:16px;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;max-width:100%}.owner{display:flex;gap:8px;align-items:center}.owner .el-avatar{flex-shrink:0}.tags{display:flex;gap:4px;margin-top:4px}.issue{color:var(--el-color-warning-dark-2)}.stale{color:var(--el-color-warning-dark-2)}.detail-content{min-height:80px;overflow-wrap:anywhere}.detail-content :deep(.el-descriptions__cell){overflow-wrap:anywhere;word-break:break-word}.detail-issues,.invalid-values{margin-top:16px}.invalid-values dl{display:grid;grid-template-columns:minmax(90px,.3fr) minmax(0,1fr);gap:8px;margin:12px 0}.invalid-values dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.detail-issues ul{margin:8px 0;padding-left:18px}.city-delivery-records :deep(.el-alert__content){min-width:0;overflow-wrap:anywhere}
@media(max-width:700px){.filters{grid-template-columns:minmax(0,1fr)}.filters .date-field,.filters .keyword-field{grid-column:auto}.filters .store-field{grid-row:auto}.actions{justify-content:flex-start}.pager{justify-content:flex-start}.filters :deep(.el-range-input){min-width:0;font-size:12px}.filters :deep(.el-range-separator){padding:0 2px;flex:0}.filters :deep(.el-date-editor--datetimerange){padding-left:6px;padding-right:6px}.city-delivery-records :deep(.el-card__body){padding:14px}.heading{align-items:flex-start}}
</style>
