<template>
  <div class="paid-settings">
    <div class="heading"><div><h2>付费会员功能设置</h2><p class="hint">管理付费会员启用与会员价格开关。普通等级、套餐和权益定义分别管理。</p></div>
      <el-button v-if="canManage" type="primary" :disabled="!editable" :loading="writing" @click="save">保存配置</el-button></div>
    <el-alert v-if="!canView" title="当前账号没有配置查看权限" type="warning" :closable="false" />
    <template v-else>
      <el-alert v-if="notice" :title="notice" type="warning" :closable="false" class="section" />
      <el-alert v-if="uncertainOperation" title="保存结果未确认，已暂停新的保存" type="warning" :closable="false" class="section">
        <p>重新读取只核对当前配置，不会重发保存；当前值相同也不能证明原请求结果。</p>
        <details><summary>保留的原请求与确认内容</summary><pre>{{ JSON.stringify(uncertainOperation, null, 2) }}</pre></details>
        <div class="actions"><el-button :disabled="busy || loading" @click="load">重新读取核对</el-button><el-button v-if="canManage" :disabled="busy || loading || !ready" @click="acknowledge">结束本地待核对状态</el-button></div>
      </el-alert>
      <div v-if="loading" class="loading" v-loading="true">正在读取配置…</div>
      <el-alert v-else-if="loadError" title="配置读取失败" type="error" :closable="false"><p>{{ loadError }}</p><el-button @click="load">重新读取</el-button></el-alert>
      <template v-else-if="config && form">
        <el-alert title="保存影响之后读取配置的业务操作" type="info" :closable="false" class="section">
          影响新购卡、卡密兑换、会员入口展示、之后读取配置的付费会员计价及收货结算赠积分的付费会员倍数。收货、核销仍会继续完成，仅会员赠积分倍数按之后读取的总开关决定；不追改已结算订单。个人资料和会员入口展示按读取时的数据库配置判断。关闭不会删除既有会员资格；保存不改写既有订单金额，也不改动既有支付回调的结算流程。已开始的操作可能按原配置完成。
        </el-alert>
        <el-alert v-if="config.missing_keys.length" title="部分配置缺失" type="warning" :closable="false" class="section"><p>{{ config.missing_keys.map(keyLabel).join('、') }}。读取不会补写默认值，请明确选择后保存。</p></el-alert>
        <el-alert v-if="config.issues.length" title="历史配置需要核对" type="warning" :closable="false" class="section"><p v-for="(issue, index) in config.issues" :key="index">{{ keyLabel(issue.key) }}：{{ issue.message }}</p></el-alert>
        <el-card shadow="never" class="section">
          <div v-for="key in paidMembershipKeys" :key="key" class="field">
            <div class="heading"><strong>{{ keyLabel(key) }}</strong>
              <el-radio-group v-if="canManage" :model-value="form[key]" :disabled="!editable" :aria-label="keyLabel(key)" @update:model-value="(value: unknown) => setFlag(key, value)"><el-radio-button :value="1">开启</el-radio-button><el-radio-button :value="0">关闭</el-radio-button></el-radio-group>
              <span v-else>{{ flagLabel(form[key]) }}</span>
            </div>
            <p v-if="form[key] === null" class="error">待明确选择：缺失、空值或异常历史值不能自动视为开启或关闭。</p>
            <p v-if="key === 'member_card_status'" class="hint">付费会员总开关。关闭时仍保留下面的价格开关值，不修改用户已有的会员期限。</p>
            <template v-else><p class="hint">沿用旧“付费会员价展示”开关，当前系统同时用于付费会员计价。实际取得会员价格还需要总开关开启、有效付费会员资格和已启用的 vip_price 权益。</p><p v-if="form.member_card_status === 0" class="hint">总开关已关闭；价格开关仍可配置并保存，当前不启用付费会员价格。</p></template>
          </div>
        </el-card>
        <details class="section"><summary>查看保存的原始值</summary><p class="hint">以下是本次读取的原文，不随未保存草稿变化；缺失值显示为 null。历史值在不同消费者中的解释可能不同，请结合上方诊断核对。</p><pre>{{ JSON.stringify(config.raw_values, null, 2) }}</pre></details>
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" class="section" />
        <div class="actions section"><el-button :disabled="busy || loading" @click="reloadDraft">重新读取配置</el-button><span v-if="!canManage" class="hint">当前账号仅可查看，需要 config.manage 才能保存。</span></div>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiPaidMembershipConfig, apiSavePaidMembershipConfig, normalizePaidMembershipSave, paidMembershipKeys,
  type PaidMembershipConfig, type PaidMembershipKey, type PaidMembershipSave, type PaidMembershipSettings } from '@/api/paidMembershipConfig';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { AdminResponseError } from '@/utils/request';

const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('config.view') || auth.uniqueAuth.includes('config.manage')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('config.manage')));
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? ''}:${auth.userInfo?.level ?? ''}:${auth.uniqueAuth.join(',')}`);
const config = ref<PaidMembershipConfig | null>(null), form = ref<PaidMembershipSettings | null>(null);
const loading = ref(false), ready = ref(false), loadError = ref(''), formError = ref(''), notice = ref('');
const writing = ref(false), confirming = ref(false), busy = computed(() => writing.value || confirming.value);
type Stamp = { identity: string; generation: number; stored: string | null };
type Job = { stamp: Stamp; controller: AbortController };
type Pending = { body: PaidMembershipSave; summary: string };
const uncertainOperation = ref<Pending | null>(null);
const editable = computed(() => canManage.value && ready.value && !loading.value && !busy.value && !uncertainOperation.value);
let alive = false, syncing = false, generation = 0, configVersion = 0, confirmVersion = 0, stored = localStorage.getItem('admin_session');
const jobs = new Map<string, Job>();
function stamp(): Stamp { return { identity: identity.value, generation, stored }; }
function current(value: Stamp) { return alive && canView.value && value.generation === generation && value.identity === identity.value && auth.token === getToken() && value.stored === localStorage.getItem('admin_session'); }
function start(channel: string): Job { jobs.get(channel)?.controller.abort(); const job = { stamp: stamp(), controller: new AbortController() }; jobs.set(channel, job); return job; }
function valid(channel: string, job: Job) { return jobs.get(channel) === job && current(job.stamp); }
function finish(channel: string, job: Job) { if (!valid(channel, job)) return false; jobs.delete(channel); return true; }
function message(error: unknown) { return error instanceof Error ? error.message : '请求失败，请重试'; }
function keyLabel(key: string) { return ({ member_card_status: '付费会员启用', svip_price_status: '付费会员价展示与计价' } as Record<string, string>)[key] ?? key; }
function flagLabel(value: 0 | 1 | null) { return value === null ? '待明确选择' : value === 1 ? '开启' : '关闭'; }
function setFlag(key: PaidMembershipKey, value: unknown) { if (editable.value && current(stamp()) && form.value && (value === 0 || value === 1)) { form.value[key] = value; formError.value = ''; } }
async function load() {
  if (busy.value || !current(stamp())) return;
  configVersion++; config.value = null; form.value = null; ready.value = false; loadError.value = formError.value = '';
  const job = start('config'); loading.value = true;
  try { const result = await apiPaidMembershipConfig(job.controller.signal); if (!valid('config', job)) return; config.value = result; form.value = { ...result.settings }; ready.value = true; }
  catch (error) { if (valid('config', job)) loadError.value = message(error); }
  finally { if (finish('config', job)) loading.value = false; }
}
async function reloadDraft() {
  if (busy.value || !current(stamp())) return;
  if (form.value && config.value && JSON.stringify(form.value) !== JSON.stringify(config.value.settings)) {
    const scope = stamp(), version = ++confirmVersion; confirming.value = true;
    try { await ElMessageBox.confirm('重新读取将放弃当前未保存草稿，是否继续？', '重新读取配置', { type: 'warning', confirmButtonText: '放弃草稿并读取', cancelButtonText: '取消' }); }
    catch { return; } finally { if (version === confirmVersion) confirming.value = false; }
    if (!current(scope) || version !== confirmVersion) return;
  }
  await load();
}
function saveSummary(body: PaidMembershipSave) {
  return paidMembershipKeys.map(key => `${keyLabel(key)}：${flagLabel(config.value!.settings[key])} → ${flagLabel(body[key])}`).join('；')
    + '。\n价格开关同时影响之后读取配置的付费会员计价，并需要有效会员资格与启用的 vip_price 权益；关闭总开关仍保留价格开关值。\n总开关还影响收货结算赠积分的付费会员倍数。收货、核销仍会继续完成，仅会员赠积分倍数按之后读取的总开关决定；不追改已结算订单。\n保存不删除已有会员资格、不改写既有订单金额，也不改变既有支付回调的结算流程。已开始的操作可能按原配置完成。';
}
async function save() {
  if (!editable.value || !current(stamp()) || !config.value || !form.value) return;
  let body: PaidMembershipSave;
  try { body = normalizePaidMembershipSave({ ...form.value, revision: config.value.revision, request_id: crypto.randomUUID() }); }
  catch (error) { formError.value = message(error); return; }
  const scope = stamp(), version = configVersion, confirmId = ++confirmVersion, before = JSON.stringify(form.value), operation = { body, summary: saveSummary(body) };
  formError.value = ''; confirming.value = true;
  try { await ElMessageBox.confirm(operation.summary, '确认保存付费会员功能设置', { type: 'warning', confirmButtonText: '确认保存', cancelButtonText: '取消' }); }
  catch { return; } finally { if (confirmId === confirmVersion) confirming.value = false; }
  if (!current(scope) || !canManage.value || confirmId !== confirmVersion || version !== configVersion || before !== JSON.stringify(form.value) || uncertainOperation.value) return;
  const job = start('write'); writing.value = true; notice.value = '';
  try {
    const result = await apiSavePaidMembershipConfig(body, job.controller.signal);
    if (!valid('write', job) || !canManage.value) return;
    uncertainOperation.value = null;
    if (result.cache_status === 'pending') notice.value = '配置已保存，部分缓存清理待恢复。数据库与审计已提交；请勿重复保存来处理缓存。';
    ElMessage.success(result.cache_status === 'pending' ? '配置已保存，缓存清理待恢复' : '付费会员功能设置已保存');
  } catch (error) {
    if (!valid('write', job) || !canManage.value) return;
    const rejected = error instanceof AdminResponseError && [400, 403, 404, 409, 422].includes(Number(error.status));
    uncertainOperation.value = rejected ? null : operation;
    notice.value = `${rejected ? '保存未完成' : '保存结果未确认'}：${message(error)}。请核对重新读取的配置，再决定后续操作。`;
  } finally { if (finish('write', job)) writing.value = false; }
  if (current(scope)) await load();
}
async function acknowledge() {
  if (!uncertainOperation.value || !canManage.value || !ready.value || loading.value || busy.value || !current(stamp())) return;
  const scope = stamp(), operation = uncertainOperation.value, version = ++confirmVersion; confirming.value = true;
  try { await ElMessageBox.confirm('仅清除本地待核对状态，不证明服务器成功或失败，不会重发保存。请先核对当前配置；之后使用新请求 ID 保存是一次新的配置变更。', '结束本地待核对状态', { type: 'warning', confirmButtonText: '已人工核对', cancelButtonText: '取消' }); }
  catch { return; } finally { if (version === confirmVersion) confirming.value = false; }
  if (current(scope) && canManage.value && version === confirmVersion && uncertainOperation.value === operation) { uncertainOperation.value = null; notice.value = ''; }
}
function invalidate() {
  generation++; configVersion++; confirmVersion++; for (const job of jobs.values()) job.controller.abort(); jobs.clear();
  if (confirming.value) ElMessageBox.close(); writing.value = confirming.value = false;
  config.value = null; form.value = null; ready.value = loading.value = false;
  loadError.value = formError.value = notice.value = ''; uncertainOperation.value = null;
}
function syncSession() { syncing = true; invalidate(); const session = getAdminSession(); auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] }); stored = localStorage.getItem('admin_session'); syncing = false; void load(); }
function syncStorage(event: StorageEvent) { if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') syncSession(); }
watch(identity, () => { if (alive && !syncing) { invalidate(); void load(); } }, { flush: 'sync' });
onMounted(() => { alive = true; window.addEventListener('admin-session-changed', syncSession); window.addEventListener('admin-auth-expired', syncSession); window.addEventListener('storage', syncStorage); syncSession(); });
onBeforeUnmount(() => { alive = false; invalidate(); window.removeEventListener('admin-session-changed', syncSession); window.removeEventListener('admin-auth-expired', syncSession); window.removeEventListener('storage', syncStorage); });
</script>

<style scoped>
.paid-settings { min-width: 0; max-width: 1100px; }
.heading, .actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.heading { justify-content: space-between; }.heading h2 { margin: 0; font-size: 20px; }
.section { margin-top: 18px; }.field + .field { margin-top: 24px; padding-top: 24px; border-top: 1px solid var(--el-border-color-lighter); }
.hint { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.7; }.error { color: var(--el-color-danger); }
.loading { min-height: 130px; padding: 24px 0; }.paid-settings :deep(.el-alert__content) { min-width: 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; } summary { cursor: pointer; }
@media (max-width: 600px) { .heading h2 { font-size: 18px; }.actions { align-items: flex-start; } }
</style>
