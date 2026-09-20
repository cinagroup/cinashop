<template>
  <section class="offline-orders" aria-label="线下消费记录">
    <div class="heading">
      <div><h1>线下消费记录</h1><p>独立收银记录 · 只读核验，不在此发起支付或修改账本</p></div>
      <div class="heading-actions"><el-button :disabled="!sessionValid || !canRead" @click="openScan">查看收银码</el-button><el-button :disabled="!sessionValid || !canRead" @click="search">刷新首页</el-button></div>
    </div>
    <el-alert title="收款以凭据核验为准，原支付标记不代表到账。新消费应付至少 0.01 元，历史零元不可付款。" type="info" :closable="false" show-icon />
    <el-card shadow="never" class="filters">
      <el-form label-position="top" @submit.prevent="search">
        <div class="filter-grid">
          <el-form-item label="完整消费订单号"><el-input v-model="form.order_id" aria-label="完整消费订单号" maxlength="32" clearable :disabled="!sessionValid || !canRead" /></el-form-item>
          <el-form-item label="昵称或电话"><el-input v-model="form.name" aria-label="昵称或电话" maxlength="64" clearable :disabled="!sessionValid || !canRead" /></el-form-item>
          <el-form-item label="用户 UID"><el-input v-model="form.uid" aria-label="用户 UID" maxlength="10" inputmode="numeric" clearable :disabled="!sessionValid || !canRead" /></el-form-item>
          <el-form-item label="原支付标记（非收款结论）">
            <el-select v-model="form.recorded_paid" aria-label="原支付标记" placeholder="全部记录" :disabled="!sessionValid || !canRead">
              <el-option label="全部记录" value="" /><el-option label="原标记已付" value="1" /><el-option label="原标记未付" value="0" />
            </el-select>
          </el-form-item>
          <el-form-item label="创建起始（包含）"><el-input v-model="form.from" aria-label="创建起始" type="datetime-local" :disabled="!sessionValid || !canRead" /></el-form-item>
          <el-form-item label="创建截止（不含）"><el-input v-model="form.to" aria-label="创建截止" type="datetime-local" :disabled="!sessionValid || !canRead" /></el-form-item>
        </div>
        <div class="filter-actions">
          <el-button native-type="submit" type="primary" :disabled="!sessionValid || !canRead">查询</el-button>
          <el-button :disabled="!sessionValid || !canRead" @click="reset">重置</el-button>
          <span class="hint">时间按本机时区 {{ timeZone }}；起止时间需同时填写。</span>
        </div>
      </el-form>
    </el-card>
    <el-alert v-if="readError" :title="readError" type="error" :closable="false" show-icon />
    <el-button v-if="readError && sessionValid && canRead" @click="loadPage(currentPage)">重试当前查询</el-button>
    <div v-if="loading" role="status" class="empty">正在核验记录，请稍候…</div>
    <div v-else-if="!loaded && !readError" role="status" class="empty">筛选条件已改变，请点击查询。</div>
    <el-empty v-else-if="loaded && !records.length" description="没有符合条件的消费记录" />
    <ul v-if="records.length" class="records" aria-label="消费结果">
      <li v-for="record in records" :key="record.id">
        <article class="record">
          <div class="identity">
            <h2>{{ record.order_id || '（无订单号）' }}</h2>
            <p>{{ record.nickname || '未记录昵称' }} · UID {{ record.uid }} <span v-if="record.phone">· {{ record.phone }}</span></p>
            <p class="hint">创建 {{ offlineTime(record.add_time) }} · 记录 #{{ record.id }}</p>
          </div>
          <div class="amount"><span class="hint">记录应付</span><strong>{{ amount(record.pay_price) }}</strong><small>原价 {{ amount(record.money) }} · 优惠 {{ amount(record.true_price) }}</small></div>
          <div class="verification">
            <el-tag :type="record.state === 'UNVERIFIED' ? 'danger' : tagType(record)">{{ offlineStateLabel(record) }}</el-tag>
            <p v-if="offlineReasonLabel(record)" class="hint">{{ offlineReasonLabel(record) }}</p>
            <p v-if="record.hidden || !record.account_available" class="hint">{{ record.hidden ? '已隐藏记录' : '' }} {{ !record.account_available ? '客户当前不可用' : '' }}</p>
          </div>
          <el-button :aria-label="`核验详情 ${record.id}`" :disabled="!sessionValid" @click="openDetail(record.id)">核验详情</el-button>
        </article>
      </li>
    </ul>
    <div v-if="loaded" class="pager" aria-label="消费记录分页">
      <span>第 {{ currentPage + 1 }} 页 · 本页 {{ records.length }} 条</span>
      <el-button :disabled="loading || currentPage === 0 || !sessionValid" @click="loadPage(currentPage - 1)">上一页</el-button>
      <el-button :disabled="loading || !nextCursor || !sessionValid" @click="nextPage">下一页</el-button>
      <span class="hint">每页最多20条；新记录请刷新首页，不提供未核验的收款总额。</span>
    </div>
    <el-dialog :model-value="detailOpen" title="线下消费核验详情" width="min(680px, 94vw)" destroy-on-close @close="closeDetail">
      <p v-if="detailLoading" role="status">正在核对原记录…</p>
      <el-alert v-if="detailError" :title="detailError" type="error" :closable="false" show-icon />
      <template v-if="detail">
        <el-alert :title="offlineStateLabel(detail)" :description="offlineReasonLabel(detail) || '此结果来自服务器对本地收款凭据的核验，不发起支付。'" :type="detail.state === 'UNVERIFIED' ? 'error' : tagType(detail)" :closable="false" show-icon />
        <el-descriptions :column="1" border class="detail-values">
          <el-descriptions-item label="消费订单号">{{ detail.order_id || '（无订单号）' }}</el-descriptions-item>
          <el-descriptions-item label="客户">{{ detail.nickname || '未记录昵称' }} · UID {{ detail.uid }} · {{ detail.phone || '无电话' }}</el-descriptions-item>
          <el-descriptions-item label="记录金额">原价 {{ amount(detail.money) }} / 应付 {{ amount(detail.pay_price) }} / 优惠 {{ amount(detail.true_price) }}</el-descriptions-item>
          <el-descriptions-item label="原支付标记">{{ detail.recorded_paid }}（仅原数据，不作为收款证明）</el-descriptions-item>
          <el-descriptions-item label="核验收款">{{ detail.paid === null ? '无法确认' : detail.paid ? '本地收款凭据已核验' : '没有已核验的收款凭据' }}</el-descriptions-item>
          <el-descriptions-item label="支付路径">{{ offlinePayLabel(detail.pay_type) }}</el-descriptions-item>
          <el-descriptions-item label="核验到账时间">{{ offlineTime(detail.paid_at) }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ offlineTime(detail.add_time) }}（{{ timeZone }}）</el-descriptions-item>
          <el-descriptions-item label="来源渠道">{{ detail.channel || '未记录' }}</el-descriptions-item>
          <el-descriptions-item label="记录状态">{{ detail.hidden ? '已隐藏' : '未隐藏' }} / 客户{{ detail.account_available ? '可用' : '不可用' }}</el-descriptions-item>
        </el-descriptions>
        <p class="hint">待核对或异常不等于未付款。请保留原订单核查，不在此代付、确认关闭、补账或退款。</p>
      </template>
      <template #footer><el-button :disabled="detailLoading || !sessionValid || selectedId === null" @click="refreshDetail">重新核验</el-button><el-button @click="closeDetail">关闭</el-button></template>
    </el-dialog>
    <el-dialog :model-value="scanOpen" title="线下消费收银码" width="min(960px, 94vw)" destroy-on-close @close="closeScan">
      <el-alert title="此码只打开收银入口，不代表付款成功。顾客须登录并核对金额，应付至少 0.01 元。" type="info" :closable="false" show-icon />
      <div class="scan-toolbar">
        <el-radio-group :model-value="scanType" aria-label="收银码格式" :disabled="!sessionValid" @change="changeScanType">
          <el-radio-button :value="1">收银海报</el-radio-button><el-radio-button :value="0">原始二维码</el-radio-button>
        </el-radio-group>
        <el-button :disabled="scanLoading || !sessionValid" @click="loadScan">重新获取</el-button>
      </div>
      <p v-if="scanLoading" role="status">正在获取收银码，小程序服务可能需要一些时间…</p>
      <el-alert v-if="scanError" :title="scanError" type="error" :closable="false" show-icon />
      <template v-if="scan">
        <p class="scan-url"><strong>H5 收银地址：</strong>{{ scan.wechatUrl }}</p>
        <p class="hint">展示或打印前请用手机试扫，确认实际进入本站收银页；保存的图片不会随域名变更自动更新。</p>
        <div class="scan-grid">
          <article v-for="surface in scanSurfaces" :key="surface.key" class="scan-card">
            <h2>{{ surface.label }}</h2>
            <template v-if="scan[surface.key] && !scanImageErrors[surface.key]">
              <img :key="scan[surface.key]" :src="scan[surface.key]" :alt="`${surface.label}${scan.type === 1 ? '收银海报' : '原始二维码'}`"
                @load="scanImageLoaded(surface.key, $event)" @error="scanImageFailed(surface.key, $event)" />
              <a v-if="scanImagesReady[surface.key]" class="scan-save" :href="scanDownloadUrls[surface.key]" :download="offlineScanFilename(scan, surface.key)"
                @click="beforeScanDownload($event, surface.key)">保存{{ surface.label }}{{ scan.type === 1 ? '海报' : '二维码' }}</a>
              <p v-else role="status">正在载入图片…</p>
            </template>
            <el-alert v-else-if="scanImageErrors[surface.key]" title="图片无法显示，不能保存；请重新获取后再试。" type="error" :closable="false" />
            <el-alert v-else :title="scan.routineStatus === 'not_configured' ? '小程序未配置，暂不提供小程序码' : '小程序码暂不可用，可使用 H5 收银入口'" type="warning" :closable="false" />
          </article>
        </div>
      </template>
      <template #footer><el-button @click="closeScan">关闭收银码</el-button></template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { isAxiosError } from 'axios';
import { apiOfflineRecord, apiOfflineRecords, apiOfflineScan } from '@/api/offline';
import { offlineScanFilename, type OfflineScan, type OfflineScanSurface, type OfflineScanType } from '@/utils/offlineScan';
import { createAdminSessionScope } from '@/utils/adminSessionScope';
import { getAdminSession } from '@/utils/auth';
import { AdminResponseError } from '@/utils/request';
import { emptyOfflineFilters, offlineQueryFromFilters, offlineStateLabel, offlineReasonLabel, offlinePayLabel, offlineTime, type OfflineRecord } from '@/utils/offlineOrderRead';

const form = reactive(emptyOfflineFilters()), records = ref<OfflineRecord[]>([]);
const loading = ref(false), loaded = ref(false), readError = ref(''), sessionValid = ref(true);
const currentPage = ref(0), nextCursor = ref('');
const detailOpen = ref(false), detailLoading = ref(false), detailError = ref(''), detail = ref<OfflineRecord | null>(null), selectedId = ref<number | null>(null);
const scanOpen = ref(false), scanLoading = ref(false), scanError = ref(''), scan = ref<OfflineScan | null>(null), scanType = ref<OfflineScanType>(1);
const scanImagesReady = reactive({ wechat: false, routine: false }), scanImageErrors = reactive({ wechat: false, routine: false });
const scanDownloadUrls = reactive({ wechat: '', routine: '' });
const scanSurfaces: { key: OfflineScanSurface; label: string }[] = [{ key: 'wechat', label: 'H5' }, { key: 'routine', label: '小程序' }];
const stored = getAdminSession();
const canRead = stored?.userInfo.level === 0 || !!stored?.uniqueAuth.some(key => key === 'order.view' || key === 'order.manage');
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let cursors = [''], generation = 0, detailGeneration = 0;
let listAbort: AbortController | undefined, detailAbort: AbortController | undefined;
let scanAbort: AbortController | undefined, scanGeneration = 0;
const scope = createAdminSessionScope(() => {
  sessionValid.value = false;
  Object.assign(form, emptyOfflineFilters());
  invalidate(); readError.value = '登录或权限会话已变化，旧记录已清空，请重新打开页面';
});
function closeDetail() {
  ++detailGeneration; detailAbort?.abort(); detailAbort = undefined;
  detailOpen.value = false; detailLoading.value = false; detailError.value = ''; detail.value = null; selectedId.value = null;
}
function invalidate() {
  ++generation; listAbort?.abort(); listAbort = undefined;
  records.value = []; nextCursor.value = ''; loading.value = false; loaded.value = false; readError.value = '';
  currentPage.value = 0; cursors = ['']; closeDetail(); closeScan();
}
watch(form, invalidate, { deep: true, flush: 'sync' });
function revoked(error: unknown) {
  if ((error instanceof AdminResponseError && error.status === 400011) || (isAxiosError(error) && error.response?.status === 403)) {
    scope.dispose(); sessionValid.value = false; Object.assign(form, emptyOfflineFilters()); invalidate();
    readError.value = '线下消费查看权限已失效，旧记录已清空，请重新打开页面';
    return true;
  }
  return false;
}
// Transport failures are not business conclusions. Keep their UI copy local;
// neither Axios's English message nor an upstream diagnostic is useful here.
function readFailure(error: unknown, fallback: string) {
  return !isAxiosError(error) && error instanceof Error ? error.message : fallback;
}
async function loadPage(index = 0) {
  if (!scope.isCurrent() || !canRead) return;
  if (!Number.isSafeInteger(index) || index < 0 || index >= cursors.length) return;
  const own = ++generation; listAbort?.abort(); const abort = new AbortController(); listAbort = abort;
  closeDetail(); closeScan(); records.value = []; nextCursor.value = ''; loaded.value = false; readError.value = ''; loading.value = true; currentPage.value = index;
  try {
    const query = offlineQueryFromFilters(form, cursors[index]);
    const result = await apiOfflineRecords(query, abort.signal);
    if (!scope.isCurrent() || own !== generation) return;
    records.value = result.list; nextCursor.value = result.nextCursor; loaded.value = true;
  } catch (error) {
    if (scope.isCurrent() && own === generation && !revoked(error)) readError.value = readFailure(error, '消费记录暂时无法读取，请重试原查询');
  } finally { if (own === generation) loading.value = false; }
}
function search() { cursors = ['']; void loadPage(0); }
function reset() { Object.assign(form, emptyOfflineFilters()); search(); }
function nextPage() {
  if (loading.value || !loaded.value || !nextCursor.value || !scope.isCurrent()) return;
  cursors = [...cursors.slice(0,currentPage.value+1),nextCursor.value]; void loadPage(currentPage.value+1);
}
async function openDetail(id: number) {
  if (!scope.isCurrent() || !canRead || !records.value.some(record => record.id === id)) return;
  closeScan(); closeDetail(); selectedId.value = id; detailOpen.value = true;
  await refreshDetail();
}
async function refreshDetail() {
  if (!scope.isCurrent() || selectedId.value === null || !records.value.some(record => record.id === selectedId.value)) return;
  const id = selectedId.value, own = ++detailGeneration, page = generation;
  detailAbort?.abort(); const abort = new AbortController(); detailAbort = abort;
  detail.value = null; detailError.value = ''; detailLoading.value = true;
  try {
    const result = await apiOfflineRecord(String(id), abort.signal);
    if (!scope.isCurrent() || own !== detailGeneration || page !== generation || selectedId.value !== id) return;
    detail.value = result;
  } catch (error) {
    if (scope.isCurrent() && own === detailGeneration && page === generation && !revoked(error)) detailError.value = readFailure(error, '收款状态暂时无法核验，请重新核验原记录；不能据此判断未付款');
  } finally { if (own === detailGeneration) detailLoading.value = false; }
}
const amount = (value: string | null) => value === null ? '未知' : `¥${value}`;
function clearScanImages() {
  for (const surface of scanSurfaces) {
    if (scanDownloadUrls[surface.key]) URL.revokeObjectURL(scanDownloadUrls[surface.key]);
    scanDownloadUrls[surface.key] = '';
  }
  scan.value = null; scanError.value = '';
  Object.assign(scanImagesReady, { wechat: false, routine: false }); Object.assign(scanImageErrors, { wechat: false, routine: false });
}
function closeScan() {
  ++scanGeneration; scanAbort?.abort(); scanAbort = undefined; scanOpen.value = false; scanLoading.value = false; clearScanImages();
}
async function openScan() {
  if (!scope.isCurrent() || !canRead) return;
  closeDetail(); closeScan(); scanOpen.value = true; scanType.value = 1; await loadScan();
}
async function changeScanType(value: unknown) {
  if (value !== 0 && value !== 1 || value === scanType.value || !scanOpen.value || !scope.isCurrent()) return;
  scanType.value = value; await loadScan();
}
async function loadScan() {
  if (!scope.isCurrent() || !canRead || !scanOpen.value) return;
  const own = ++scanGeneration, type = scanType.value;
  scanAbort?.abort(); const abort = new AbortController(); scanAbort = abort; clearScanImages(); scanLoading.value = true;
  try {
    const result = await apiOfflineScan(type, abort.signal);
    if (!scope.isCurrent() || own !== scanGeneration || !scanOpen.value || type !== scanType.value) return;
    scan.value = result;
    for (const surface of scanSurfaces) {
      const image = result[surface.key]; if (!image) continue;
      const comma = image.indexOf(','), mime = image.slice(5, image.indexOf(';'));
      const bytes = Uint8Array.from(atob(image.slice(comma + 1)), character => character.charCodeAt(0));
      scanDownloadUrls[surface.key] = URL.createObjectURL(new Blob([bytes], { type: mime }));
    }
  } catch (error) {
    if (scope.isCurrent() && own === scanGeneration && !revoked(error)) {
      clearScanImages(); scanError.value = readFailure(error, '收银码暂时无法获取，请重新获取');
    }
  } finally { if (own === scanGeneration) scanLoading.value = false; }
}
function currentScanImage(surface: OfflineScanSurface, event: Event) {
  return scope.isCurrent() && scanOpen.value && !!scan.value?.[surface] && event.target instanceof HTMLImageElement
    && event.target.getAttribute('src') === scan.value[surface];
}
function scanImageLoaded(surface: OfflineScanSurface, event: Event) {
  if (currentScanImage(surface, event) && event.target instanceof HTMLImageElement && event.target.naturalWidth > 0) scanImagesReady[surface] = true;
}
function scanImageFailed(surface: OfflineScanSurface, event: Event) {
  if (currentScanImage(surface, event)) { scanImageErrors[surface] = true; scanImagesReady[surface] = false; }
}
function beforeScanDownload(event: Event, surface: OfflineScanSurface) {
  if (!scope.isCurrent() || !scanOpen.value || !scan.value?.[surface] || !scanDownloadUrls[surface] || !scanImagesReady[surface] || scanImageErrors[surface]) event.preventDefault();
}
const tagType = (record: OfflineRecord) => record.state === 'PAID' ? 'success'
  : ['PENDING','REVIEW_REQUIRED'].includes(record.state) ? 'warning' : 'info';
onMounted(() => { if (!canRead) readError.value = '没有线下消费查看权限，请联系管理员'; else void loadPage(); });
onUnmounted(() => { invalidate(); scope.dispose(); });
</script>

<style scoped>
.offline-orders { display: grid; gap: 16px; min-width: 0; color: #303133; }
.heading, .filter-actions, .pager { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.heading { justify-content: space-between; }
h1 { margin: 0; font-size: 23px; } .heading p { margin: 8px 0 0; font-size: 14px; color: #606266; }
.filter-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 0 18px; }
.filter-grid :deep(.el-select) { width: 100%; }
.hint { color: #606266; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.empty { padding: 32px 16px; text-align: center; background: white; color: #606266; }
.records { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.record { display: grid; grid-template-columns: minmax(230px,2fr) minmax(160px,1fr) minmax(150px,1fr) auto; gap: 18px; align-items: center; background: #fff; border: 1px solid #e4e7ed; border-radius: 6px; padding: 18px; }
.record > * { min-width: 0; } .record h2 { font-size: 14px; margin: 0; overflow-wrap: anywhere; } .record p { margin: 7px 0 0; font-size: 13px; overflow-wrap: anywhere; }
.amount { display: grid; gap: 5px; } .amount strong { font-size: 20px; font-variant-numeric: tabular-nums; } .amount small { color: #606266; line-height: 1.6; }
.verification :deep(.el-tag) { max-width: 100%; height: auto; white-space: normal; line-height: 1.5; padding: 3px 8px; }
.pager { background: white; padding: 16px; font-size: 14px; }
.detail-values { margin: 16px 0; } .detail-values :deep(.el-descriptions__body) { overflow-wrap: anywhere; } .detail-values :deep(.el-descriptions__table) { table-layout: fixed; }
.detail-values :deep(.el-descriptions__label) { width: 112px; }
.heading-actions, .scan-toolbar { display: flex; flex-wrap: wrap; gap: 10px; }
.heading-actions :deep(.el-button + .el-button), .scan-toolbar :deep(.el-button) { margin-left: 0; }
.scan-toolbar { margin: 18px 0; align-items: center; } .scan-url { overflow-wrap: anywhere; line-height: 1.6; }
.scan-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.scan-card { min-width: 0; border: 1px solid #dcdfe6; border-radius: 6px; padding: 14px; text-align: center; background: white; }
.scan-card h2 { margin: 0 0 14px; font-size: 18px; } .scan-card img { display: block; max-width: 100%; height: auto; margin: 0 auto 16px; }
.scan-save { display: inline-block; padding: 10px 18px; color: #005fa8; border: 1px solid #005fa8; border-radius: 4px; text-decoration: none; }
.scan-save:focus-visible { outline: 3px solid #005fa8; outline-offset: 3px; }
@media (max-width: 1100px) { .record { grid-template-columns: minmax(0,2fr) minmax(0,1fr); } .record > .el-button { justify-self: end; } }
@media (max-width: 650px) {
  h1 { font-size: 20px; } .filter-grid, .record { grid-template-columns: minmax(0,1fr); }
  .record { gap: 13px; padding: 14px; } .record > .el-button { justify-self: stretch; }
  .filters :deep(.el-card__body) { padding: 14px; } .pager { gap: 8px; } .pager .hint { width: 100%; }
  .detail-values :deep(.el-descriptions__label) { width: 88px; }
  .scan-grid { grid-template-columns: minmax(0, 1fr); } .scan-card { padding: 10px; }
}
</style>
