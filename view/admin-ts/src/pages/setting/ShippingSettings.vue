<template>
  <div class="shipping-settings">
    <header class="heading">
      <div><h2>发货设置</h2><p class="hint">设置包邮规则与到店自提，保存时核对全部设置和默认提货点的当前版本。</p></div>
      <el-button v-if="canView" :loading="loading" :disabled="busy || confirming || restoring || readingReceipt" @click="reload">重新读取</el-button>
    </header>
    <el-alert v-if="!canView" title="当前账号没有发货设置查看权限" type="warning" :closable="false" show-icon />
    <template v-else>
      <el-alert v-if="!canManage" title="当前账号仅可查看发货设置" type="info" :closable="false" show-icon />
      <el-alert v-if="recoveryError" :title="recoveryError" type="error" :closable="false" show-icon><template #default>已暂停写入。请保留本地请求记录并核对提交结果。</template></el-alert>
      <el-alert v-if="pending" title="有一项提交结果尚未确认，已暂停新的写入" type="warning" :closable="false" show-icon>
        <template #default><p>请求 {{ pending.input.request_id }}。先读取原请求回执；只有明确未发现回执后，才能主动重试同一请求。</p>
          <div class="buttons"><el-button :loading="readingReceipt" :disabled="busy || confirming || restoring" @click="readReceipt">读取提交结果</el-button><el-button v-if="retryReady && canManage" type="primary" :disabled="readingReceipt || busy || confirming" @click="retryOriginal">重新提交原请求</el-button></div>
          <details><summary>保留的原请求</summary><pre>{{ JSON.stringify(pending.input, null, 2) }}</pre></details>
        </template>
      </el-alert>
      <el-alert v-if="notice" :title="notice" :type="noticeSuccess ? 'success' : 'warning'" :closable="false" show-icon />
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon><template #default><el-button link type="primary" :disabled="busy || confirming" @click="reload">重新读取设置</el-button></template></el-alert>
      <el-alert v-if="snapshot?.missing_keys.length" title="部分历史配置键缺失" type="warning" :closable="false" show-icon><template #default><p>{{ snapshot.missing_keys.join('、') }}</p><p>读取不会补写；请明确选择全部开关和金额，再确认保存。</p></template></el-alert>
      <el-alert v-if="snapshot?.issues.length" title="历史数据需要核对" type="warning" :closable="false" show-icon><template #default><ul class="issues"><li v-for="(issue, index) in snapshot.issues" :key="`${issue.key}:${index}`">{{ issue.message }}</li></ul></template></el-alert>
      <div v-loading="loading" class="settings-grid">
        <el-card shadow="never">
          <template #header><strong>包邮规则</strong></template>
          <el-form label-position="top" :disabled="!canManage || locked || !ready">
            <el-form-item label="全场包邮"><el-radio-group v-model="form.whole_free_shipping" aria-label="全场包邮"><el-radio :value="1">开启</el-radio><el-radio :value="0">关闭</el-radio></el-radio-group><p v-if="form.whole_free_shipping === null" class="issue">请明确选择全场包邮开关。</p></el-form-item>
            <el-form-item label="满额包邮金额（元）"><el-input v-model="form.store_free_postage" inputmode="decimal" maxlength="11" placeholder="例如：99.90" aria-label="满额包邮金额" /><p class="hint">金额精确到分，0 表示不限金额。关闭全场包邮时，此金额继续保留，暂不参与满额包邮判断。</p></el-form-item>
            <el-form-item label="线下支付是否包邮"><el-radio-group v-model="form.offline_postage" aria-label="线下支付是否包邮"><el-radio :value="1">包邮</el-radio><el-radio :value="0">不包邮</el-radio></el-radio-group><p class="hint">适用于线下支付的配送订单，不会改变其他支付方式开关。</p><p v-if="form.offline_postage === null" class="issue">请明确选择线下支付包邮开关。</p></el-form-item>
          </el-form>
          <p class="hint">新规则用于后续订单的报价与创建校验，已创建订单保留原运费。</p>
        </el-card>
        <el-card shadow="never">
          <template #header><strong>到店自提</strong></template>
          <el-form label-position="top" :disabled="!canManage || locked || !ready">
            <el-form-item label="是否开启到店自提"><el-radio-group v-model="form.store_self_mention" aria-label="是否开启到店自提"><el-radio :value="1">开启</el-radio><el-radio :value="0">关闭</el-radio></el-radio-group><p v-if="form.store_self_mention === null" class="issue">请明确选择到店自提开关。</p></el-form-item>
          </el-form>
          <p v-if="form.store_self_mention !== 1" class="hint">关闭自提时，保存只修改设置开关，保留已存在的提货点资料。</p>
          <div v-if="snapshot?.pickup" class="pickup-source"><el-tag>默认提货点 #{{ snapshot.pickup.id }}</el-tag><p class="hint">{{ snapshot.pickup.address_labels.join(' / ') || '历史地区待修复' }}</p><p v-if="snapshot.pickup.is_show !== 1 || snapshot.pickup.is_store !== 1" class="issue">当前提货点未处于正常营业自提状态。开启自提并保存后，将明确启用此提货点。</p></div>
          <el-alert v-if="form.store_self_mention === 1 && !snapshot?.pickup && ready" title="尚无默认提货点。填写完整资料并确认保存后创建。" type="info" :closable="false" class="inline-alert" />
          <template v-if="form.store_self_mention === 1">
            <el-alert v-if="regionError" :title="regionError" type="error" :closable="false" show-icon class="inline-alert"><template #default><el-button link :disabled="locked" @click="loadRegions">重新读取行政区</el-button></template></el-alert>
            <el-form label-position="top" :disabled="!canManage || locked || !ready">
              <div class="field-grid">
                <el-form-item label="提货点名称"><el-input v-model="form.pickup.name" maxlength="100" aria-label="提货点名称" /></el-form-item>
                <el-form-item label="提货点手机号"><el-input v-model="form.pickup.phone" inputmode="tel" maxlength="11" placeholder="11位中国大陆手机号" aria-label="提货点手机号" /></el-form-item>
                <el-form-item label="省份"><el-select :model-value="form.pickup.address_ids[0] || undefined" :loading="regionLoading" :disabled="!canManage || locked || !ready || regionLoading" filterable placeholder="请选择省份" aria-label="提货点省份" @change="setRegion(0, $event)"><el-option v-for="item in regions[0]" :key="item.id" :label="item.label" :value="item.id" /></el-select></el-form-item>
                <el-form-item label="城市"><el-select :model-value="form.pickup.address_ids[1] || undefined" :disabled="!canManage || locked || !ready || regionLoading || !form.pickup.address_ids[0]" filterable placeholder="请选择城市" aria-label="提货点城市" @change="setRegion(1, $event)"><el-option v-for="item in regions[1]" :key="item.id" :label="item.label" :value="item.id" /></el-select></el-form-item>
                <el-form-item label="区县"><el-select :model-value="form.pickup.address_ids[2] || undefined" :disabled="!canManage || locked || !ready || regionLoading || !form.pickup.address_ids[1]" filterable placeholder="请选择区县" aria-label="提货点区县" @change="setRegion(2, $event)"><el-option v-for="item in regions[2]" :key="item.id" :label="item.label" :value="item.id" /></el-select></el-form-item>
                <el-form-item label="街道（可选）"><el-select :model-value="form.pickup.address_ids[3] || undefined" :disabled="!canManage || locked || !ready || regionLoading || !form.pickup.address_ids[2]" filterable clearable placeholder="请选择街道" aria-label="提货点街道" @change="setRegion(3, $event)"><el-option v-for="item in regions[3]" :key="item.id" :label="item.label" :value="item.id" /></el-select></el-form-item>
                <el-form-item label="详细地址" class="full"><el-input v-model="form.pickup.detailed_address" maxlength="255" placeholder="楼栋、门牌等详细地址" aria-label="提货点详细地址" /></el-form-item>
                <el-form-item label="营业开始时间"><el-time-picker v-model="form.pickup.day_time[0]" format="HH:mm" value-format="HH:mm" placeholder="选择开始时间" aria-label="营业开始时间" /></el-form-item>
                <el-form-item label="营业结束时间"><el-time-picker v-model="form.pickup.day_time[1]" format="HH:mm" value-format="HH:mm" placeholder="选择结束时间" aria-label="营业结束时间" /></el-form-item>
                <p class="hint full">开始时间晚于结束时间表示跨日营业；两者相同表示全天营业。</p>
                <el-form-item label="纬度"><el-input v-model="form.pickup.latitude" inputmode="decimal" placeholder="-90 至 90" aria-label="提货点纬度" /></el-form-item>
                <el-form-item label="经度"><el-input v-model="form.pickup.longitude" inputmode="decimal" placeholder="-180 至 180" aria-label="提货点经度" /></el-form-item>
                <p class="hint full">填写提货点真实坐标，最多六位小数；本页不提供地图自动定位。</p>
              </div>
            </el-form>
          </template>
        </el-card>
      </div>
      <footer v-if="canManage" class="save-bar"><p class="hint">同时保存包邮规则、自提开关和已启用的默认提货点。</p><el-button type="primary" :loading="busy" :disabled="!ready || locked || form.store_self_mention === 1 && (regionLoading || !!regionError)" @click="save">保存发货设置</el-button></footer>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { apiShippingSettings, apiSaveShippingSettings, apiShippingSettingsReceipt, apiShippingSettingsCities,
  normalizeShippingSettingsWrite, shippingSettingsFingerprint, shippingSettingsPendingKey,
  parseShippingSettingsPending, assertShippingSettingsReceipt, shippingSettingsReceiptNotFound, isShippingSettingsStale,
  type ShippingSettingsSnapshot, type ShippingSettingsPending, type ShippingSettingsReceipt,
  type ShippingSettingsCity, type ShippingFlag, type ShippingPickupInput } from '@/api/shippingSettings';

const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('shipping_settings.view')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('shipping_settings.manage')));
const identity = computed(() => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}`);
type Form = { whole_free_shipping: ShippingFlag | null; store_free_postage: string; offline_postage: ShippingFlag | null; store_self_mention: ShippingFlag | null; pickup: ShippingPickupInput };
const blank = (): Form => ({ whole_free_shipping: null, store_free_postage: '', offline_postage: null, store_self_mention: null,
  pickup: { name: '', phone: '', address_ids: [], detailed_address: '', day_time: ['', ''], latitude: '', longitude: '' } });
const form = ref<Form>(blank()), snapshot = ref<ShippingSettingsSnapshot | null>(null), ready = ref(false), loading = ref(false), error = ref('');
const regions = ref<ShippingSettingsCity[][]>([[], [], [], []]), regionLoading = ref(false), regionError = ref('');
const pending = ref<ShippingSettingsPending | null>(null), restoring = ref(false), recoveryError = ref(''), retryReady = ref(false);
const busy = ref(false), confirming = ref(false), readingReceipt = ref(false), notice = ref(''), noticeSuccess = ref(false);
const locked = computed(() => busy.value || confirming.value || restoring.value || readingReceipt.value || loading.value || !!pending.value || !!recoveryError.value);
type Stamp = { generation: number; identity: string; stored: string | null };
type Job = { stamp: Stamp; controller: AbortController };
let alive = false, syncing = false, generation = 0, confirmationId = 0, stored = localStorage.getItem('admin_session');
const jobs = new Map<string, Job>();
const message = (reason: unknown) => reason instanceof Error ? reason.message : '请求失败，请重试';
const stamp = (): Stamp => ({ generation, identity: identity.value, stored });
const current = (value: Stamp) => alive && canView.value && value.generation === generation && value.identity === identity.value && auth.token === getToken() && value.stored === localStorage.getItem('admin_session');
function cancel(channel: string) { jobs.get(channel)?.controller.abort(); jobs.delete(channel); }
function start(channel: string): Job { cancel(channel); const job = { stamp: stamp(), controller: new AbortController() }; jobs.set(channel, job); return job; }
function valid(channel: string, job: Job) { return jobs.get(channel) === job && current(job.stamp); }
function finish(channel: string, job: Job) { if (!valid(channel, job)) return false; jobs.delete(channel); return true; }
function hydrate(value: ShippingSettingsSnapshot) {
  const pickup = value.pickup;
  form.value = { ...value.settings, store_free_postage: value.settings.store_free_postage ?? value.raw_values.store_free_postage ?? '',
    pickup: pickup ? { name: pickup.name, phone: pickup.phone, address_ids: [...pickup.address_ids], detailed_address: pickup.detailed_address,
      day_time: pickup.day_time.length === 2 ? [...pickup.day_time] : ['', ''], latitude: pickup.latitude, longitude: pickup.longitude } : blank().pickup };
}
async function load() {
  if (!current(stamp()) || busy.value || confirming.value) return;
  cancel('regions'); regionLoading.value = false; regionError.value = ''; regions.value = [[], [], [], []];
  const job = start('settings'); ready.value = false; loading.value = true; error.value = ''; snapshot.value = null; form.value = blank();
  try { const result = await apiShippingSettings(job.controller.signal); if (!valid('settings', job)) return; snapshot.value = result; hydrate(result); ready.value = true; }
  catch (reason) { if (valid('settings', job)) error.value = message(reason); }
  finally { if (finish('settings', job)) loading.value = false; }
  if (current(job.stamp) && ready.value) await loadRegions();
}
async function reload() { if (!current(stamp()) || busy.value || confirming.value || restoring.value || readingReceipt.value) return; await load(); }
function checkRegionLevel(rows: ShippingSettingsCity[], level: number) { if (rows.some(row => row.level !== level)) throw Error('行政区层级不一致，请重新读取'); }
async function loadRegions() {
  if (!current(stamp()) || !ready.value || busy.value || confirming.value) return;
  const job = start('regions'); regionLoading.value = true; regionError.value = ''; regions.value = [[], [], [], []];
  const ids = [...form.value.pickup.address_ids];
  try {
    for (let level = 0; level < 4; level++) {
      const parent = level === 0 ? 0 : ids[level - 1] ?? 0; if (level > 0 && parent === 0) break;
      const result = await apiShippingSettingsCities(parent, job.controller.signal); if (!valid('regions', job)) return;
      checkRegionLevel(result, level + 1); regions.value[level] = result;
      if (ids[level] && !result.some(row => row.id === ids[level])) throw Error('历史提货点行政区已失效，请重新选择完整省市区');
      if (!ids[level]) break;
    }
  } catch (reason) { if (valid('regions', job)) regionError.value = message(reason); }
  finally { if (finish('regions', job)) regionLoading.value = false; }
}
async function setRegion(level: number, value: number | '' | undefined) {
  if (!current(stamp()) || !canManage.value || locked.value || regionLoading.value || !ready.value) return;
  const id = typeof value === 'number' ? value : 0;
  if (id && !regions.value[level]?.some(row => row.id === id)) return;
  form.value.pickup.address_ids = form.value.pickup.address_ids.slice(0, level);
  if (id) form.value.pickup.address_ids.push(id);
  for (let index = level + 1; index < 4; index++) regions.value[index] = [];
  regionError.value = '';
  if (!id || level === 3) return;
  const job = start('regions'); regionLoading.value = true;
  try { const result = await apiShippingSettingsCities(id, job.controller.signal); if (!valid('regions', job)) return; checkRegionLevel(result, level + 2); regions.value[level + 1] = result; }
  catch (reason) { if (valid('regions', job)) regionError.value = message(reason); }
  finally { if (finish('regions', job)) regionLoading.value = false; }
}
function clearPending(frozen: ShippingSettingsPending) {
  const key = shippingSettingsPendingKey(frozen.actor);
  if (sessionStorage.getItem(key) !== JSON.stringify(frozen)) throw Error('本地原请求记录已发生变化，请保留记录并核对');
  sessionStorage.removeItem(key); pending.value = null; retryReady.value = false;
}
function accept(result: ShippingSettingsReceipt, frozen: ShippingSettingsPending) {
  assertShippingSettingsReceipt(result, frozen); clearPending(frozen); noticeSuccess.value = true; notice.value = '发货设置已保存，将重新读取当前设置。';
}
async function submitOriginal(frozen: ShippingSettingsPending) {
  if (!current(stamp()) || !canManage.value || busy.value || readingReceipt.value || pending.value?.input.request_id !== frozen.input.request_id) return;
  cancel('regions'); regionLoading.value = false;
  const job = start('write'); busy.value = true; retryReady.value = false; notice.value = ''; noticeSuccess.value = false;
  try { const result = await apiSaveShippingSettings(frozen.input, job.controller.signal); if (valid('write', job) && canManage.value) accept(result, frozen); }
  catch (reason) { if (!valid('write', job)) return;
    if (isShippingSettingsStale(reason, frozen)) { try { clearPending(frozen); ready.value = false; notice.value = '设置或默认提货点版本已改变，本次未保存。重新读取最新设置后，请核对并再次确认保存。'; } catch (failure) { recoveryError.value = message(failure); } }
    else notice.value = `提交结果未确认：${message(reason)}。请读取原请求回执，不能发起新的写入。`;
  } finally { if (finish('write', job)) busy.value = false; }
  if (current(job.stamp) && !pending.value && !recoveryError.value) await load();
}
async function save() {
  if (!current(stamp()) || !canManage.value || locked.value || !ready.value || !snapshot.value || form.value.store_self_mention === 1 && (regionLoading.value || regionError.value)) return;
  const scope = stamp(), version = ++confirmationId; confirming.value = true; notice.value = ''; noticeSuccess.value = false;
  let frozen: ShippingSettingsPending | null = null;
  try {
    if (form.value.store_self_mention === 1 && form.value.pickup.address_ids.some((id, level) => !regions.value[level]?.some(row => row.id === id))) throw Error('请重新选择完整且有效的省市区');
    const input = normalizeShippingSettingsWrite({ request_id: crypto.randomUUID(), revision: snapshot.value.revision,
      whole_free_shipping: form.value.whole_free_shipping as ShippingFlag, store_free_postage: form.value.store_free_postage,
      offline_postage: form.value.offline_postage as ShippingFlag, store_self_mention: form.value.store_self_mention as ShippingFlag,
      pickup: form.value.store_self_mention === 1 ? form.value.pickup : null });
    const fingerprint = await shippingSettingsFingerprint(input);
    if (!current(scope) || !canManage.value || version !== confirmationId) return;
    await ElMessageBox.confirm(`全场包邮：${input.whole_free_shipping ? '开启' : '关闭'}；满额包邮：${input.store_free_postage}元。\n线下支付：${input.offline_postage ? '包邮' : '不包邮'}。\n${input.store_self_mention ? `开启到店自提，${snapshot.value.pickup ? '更新' : '创建'}默认提货点“${input.pickup!.name}”。` : '关闭到店自提，保留已有提货点资料。'}`, '确认保存发货设置', { type: 'warning', confirmButtonText: '确认提交', cancelButtonText: '取消' });
    if (!current(scope) || !canManage.value || version !== confirmationId || pending.value || recoveryError.value) return;
    frozen = { version: 1, actor: auth.userInfo!.id, input, fingerprint };
    const key = shippingSettingsPendingKey(frozen.actor);
    if (sessionStorage.getItem(key) !== null) { recoveryError.value = '已有未完成请求记录，请重新读取页面并核对'; throw Error(recoveryError.value); }
    sessionStorage.setItem(key, JSON.stringify(frozen)); pending.value = frozen;
  } catch (reason) { if (current(scope) && reason !== 'cancel' && reason !== 'close') notice.value = message(reason); }
  finally { if (current(scope) && version === confirmationId) confirming.value = false; }
  if (current(scope) && frozen && pending.value?.input.request_id === frozen.input.request_id) await submitOriginal(frozen);
}
async function readReceipt() {
  if (!current(stamp()) || !pending.value || busy.value || confirming.value || readingReceipt.value || restoring.value) return;
  const frozen = pending.value, job = start('receipt'); readingReceipt.value = true; retryReady.value = false; notice.value = ''; noticeSuccess.value = false;
  try { const result = await apiShippingSettingsReceipt(frozen.input.request_id, job.controller.signal); if (valid('receipt', job)) accept(result, frozen); }
  catch (reason) { if (valid('receipt', job)) { if (shippingSettingsReceiptNotFound(reason)) { retryReady.value = true; notice.value = '明确未发现该请求回执。可主动重试原请求；请求ID、版本和全部内容保持原样。'; } else notice.value = `提交结果仍未确认：${message(reason)}`; } }
  finally { if (finish('receipt', job)) readingReceipt.value = false; }
  if (current(job.stamp) && !pending.value && !recoveryError.value) await load();
}
async function retryOriginal() {
  if (!pending.value || !retryReady.value || !canManage.value || busy.value || readingReceipt.value || confirming.value || !current(stamp())) return;
  const frozen = pending.value, scope = stamp(), version = ++confirmationId; confirming.value = true;
  try { await ElMessageBox.confirm(`确认重新提交原发货设置？将复用请求 ${frozen.input.request_id}、原版本和全部原内容。`, '重试原请求', { type: 'warning', confirmButtonText: '重试原请求', cancelButtonText: '取消' }); }
  catch { return; } finally { if (current(scope) && version === confirmationId) confirming.value = false; }
  if (current(scope) && version === confirmationId && canManage.value && pending.value === frozen && retryReady.value) await submitOriginal(frozen);
}
async function restore() {
  if (!current(stamp()) || !auth.userInfo) return; const scope = stamp(); restoring.value = true;
  try { const raw = sessionStorage.getItem(shippingSettingsPendingKey(auth.userInfo.id)); if (!raw) return; const saved = await parseShippingSettingsPending(raw, auth.userInfo.id); if (current(scope)) pending.value = saved; }
  catch (reason) { if (current(scope)) recoveryError.value = `未完成请求记录无法安全恢复：${message(reason)}`; }
  finally { if (current(scope)) restoring.value = false; }
}
function invalidate() {
  generation++; confirmationId++; if (confirming.value) ElMessageBox.close(); for (const job of jobs.values()) job.controller.abort(); jobs.clear();
  snapshot.value = null; form.value = blank(); regions.value = [[], [], [], []];
  ready.value = loading.value = regionLoading.value = busy.value = confirming.value = readingReceipt.value = restoring.value = retryReady.value = false;
  pending.value = null; error.value = regionError.value = notice.value = recoveryError.value = ''; noticeSuccess.value = false;
}
async function boot() { const scope = stamp(); await restore(); if (current(scope)) await load(); }
function syncStored(event?: Event) {
  if (syncing || event instanceof StorageEvent && event.key !== null && !['admin_token', 'admin_session'].includes(event.key)) return;
  syncing = true; invalidate(); const session = getAdminSession(); auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] }); stored = localStorage.getItem('admin_session'); syncing = false; void boot();
}
watch(identity, () => { if (alive && !syncing) { invalidate(); stored = localStorage.getItem('admin_session'); void boot(); } }, { flush: 'sync' });
onMounted(() => { alive = true; window.addEventListener('storage', syncStored); window.addEventListener('admin-session-changed', syncStored); window.addEventListener('admin-auth-expired', syncStored); syncStored(); });
onBeforeUnmount(() => { alive = false; invalidate(); window.removeEventListener('storage', syncStored); window.removeEventListener('admin-session-changed', syncStored); window.removeEventListener('admin-auth-expired', syncStored); });
</script>

<style scoped>
.shipping-settings{display:grid;gap:16px;min-width:0}.heading{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}.heading h2{font-size:20px;margin:0 0 6px}.hint{color:var(--el-text-color-secondary);font-size:13px;line-height:1.7;margin:6px 0;overflow-wrap:anywhere}.settings-grid{display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr);gap:16px;align-items:start;min-height:260px}.settings-grid>.el-card{min-width:0}.field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}.full{grid-column:1/-1}.field-grid .el-select,.field-grid :deep(.el-date-editor.el-input){width:100%}.el-form-item .hint,.el-form-item .issue{width:100%}.issue{font-size:13px;color:var(--el-color-danger);line-height:1.7;margin:6px 0}.issues{margin:0;padding-left:18px}.issues li{line-height:1.7}.pickup-source{margin:4px 0 16px}.inline-alert{margin:12px 0 16px}.save-bar{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:16px;background:var(--el-bg-color);border:1px solid var(--el-border-color-lighter);border-radius:8px}.buttons{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.buttons .el-button+.el-button{margin-left:0}pre{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto}details{margin:8px 0}.shipping-settings :deep(.el-alert__content){min-width:0;overflow-wrap:anywhere}
@media(max-width:1050px){.settings-grid{grid-template-columns:minmax(0,1fr)}}@media(max-width:600px){.heading{align-items:flex-start}.heading h2{font-size:18px}.field-grid{grid-template-columns:minmax(0,1fr)}.full{grid-column:auto}.save-bar{align-items:stretch;flex-direction:column;gap:10px}.save-bar .el-button{width:100%}.el-card :deep(.el-card__body){padding:14px}}
</style>
