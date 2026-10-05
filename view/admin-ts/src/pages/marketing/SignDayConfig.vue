<template>
  <div class="sign-day-config">
    <header class="heading"><div><h2>签到天数组</h2><p class="hint">管理签到展示的文字、数值与顺序。天数文案可以自由填写，不是 1–7 的天数编号。</p></div><el-button v-if="canView" :loading="loading" :disabled="busy || confirming || restoring" @click="reload">重新读取</el-button></header>
    <el-alert title="此组不参与实际发奖，实际奖励由签到奖励规则决定" type="info" :closable="false" show-icon><template #default><router-link to="/marketing/sign-rewards">查看签到奖励规则</router-link></template></el-alert>
    <el-alert v-if="!canView" title="当前账号没有签到天数组查看权限" type="warning" :closable="false" show-icon />
    <template v-else>
      <el-alert v-if="!canManage" title="当前账号仅可查看签到天数组" type="info" :closable="false" />
      <el-alert v-if="recoveryError" :title="recoveryError" type="error" :closable="false" show-icon><template #default>已暂停写入。请保留本地请求记录并核对审计结果，不能用新请求替代它。</template></el-alert>
      <el-alert v-if="pending" title="有一项提交结果尚未确认，已暂停新的写入" type="warning" :closable="false" show-icon>
        <template #default><p>{{ operationName(pending.input.operation) }}{{ pending.input.id ? `记录 #${pending.input.id}` : '一条记录' }}；请求 {{ pending.input.body.request_id }}。</p><p>先读取原请求回执；只有明确未发现回执后，才能主动重试同一请求。</p><div class="buttons"><el-button :loading="readingReceipt" :disabled="busy || confirming || restoring" @click="readReceipt">读取提交结果</el-button><el-button v-if="retryReady && canManage" type="primary" :disabled="readingReceipt || busy || confirming" @click="retryOriginal">重新提交原请求</el-button></div><details><summary>保留的原请求</summary><pre>{{ JSON.stringify(pending.input, null, 2) }}</pre></details></template>
      </el-alert>
      <el-alert v-if="notice" :title="notice" :type="noticeSuccess ? 'success' : 'warning'" :closable="false" show-icon />
      <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon><template #default><el-button link type="primary" :disabled="busy || confirming" @click="reload">重新读取列表</el-button></template></el-alert>
      <div class="content-grid">
        <el-card shadow="never" class="records">
          <template #header><div class="heading"><strong>展示记录 <span v-if="snapshot" class="hint">{{ snapshot.count }}/7（含隐藏）</span></strong><el-button v-if="canManage" type="primary" :disabled="!canAdd" @click="openCreate">添加记录</el-button></div></template>
          <el-alert v-if="snapshot && !snapshot.group_present" title="此配置组尚未初始化。确认添加首条记录后才会建立配置组。" type="info" :closable="false" class="notice" />
          <el-alert v-if="snapshot && snapshot.count > 7" title="历史记录超过七行，不能继续新增；已有记录仍可编辑、隐藏或删除。" type="warning" :closable="false" class="notice" />
          <p v-else-if="snapshot?.count === 7" class="hint">已达到七行上限，隐藏记录也计入上限。</p>
          <div class="table-scroll"><el-table :data="snapshot?.list ?? []" v-loading="loading" row-key="id" border :empty-text="loading ? '正在读取…' : listError ? '读取失败，请重试' : '暂无展示记录'">
            <el-table-column prop="id" label="ID" width="75" />
            <el-table-column label="天数文案" min-width="150"><template #default="{ row }"><span class="preserve-text">{{ row.day ?? '历史文案无法解析' }}</span><p v-for="issue in row.issues" :key="issue" class="issue">{{ issue }}</p></template></el-table-column>
            <el-table-column label="签到数值" width="120"><template #default="{ row }">{{ row.sign_num ?? '待修复' }}</template></el-table-column>
            <el-table-column prop="sort" label="排序" width="85" />
            <el-table-column label="显示状态" width="120"><template #default="{ row }"><el-switch v-if="canManage && (row.status === 0 || row.status === 1)" :model-value="row.status" :active-value="1" :inactive-value="0" inline-prompt active-text="显示" inactive-text="隐藏" :disabled="locked || !ready" :aria-label="`记录 ${row.id} 显示状态`" @change="toggle(row)" /><el-tag v-else :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? '显示' : row.status === 0 ? '隐藏' : `历史状态 ${row.status}` }}</el-tag></template></el-table-column>
            <el-table-column label="操作" min-width="145"><template #default="{ row }"><el-button link type="primary" :disabled="locked || !ready" @click="openDetail(row)">{{ canManage ? '编辑' : '查看' }}</el-button><el-button v-if="canManage" link type="danger" :disabled="locked || !ready" @click="remove(row)">删除</el-button></template></el-table-column>
          </el-table></div>
          <p class="hint count-hint">最多七行，包含隐藏记录。新增和修改都会核对当前版本，其他管理员的改动会要求重新读取。</p>
        </el-card>
        <el-card shadow="never" class="preview-card">
          <template #header><strong>管理预览</strong></template>
          <p class="hint">下方仅为本管理页的静态预览，不会改变商城主题或实际发奖。</p>
          <div class="theme-picker" role="group" aria-label="管理预览颜色"><button v-for="(theme, index) in themes" :key="theme.name" :style="{ backgroundColor: theme.color }" :aria-label="`${theme.name}管理预览`" :aria-pressed="previewTheme === index + 1" @click="previewTheme = index + 1" /></div>
          <p v-if="snapshot?.theme_issue" class="issue">{{ snapshot.theme_issue }}</p>
          <p v-else-if="snapshot?.theme === null" class="hint">未读取到历史主题，暂用蓝色管理预览。</p>
          <div class="phone-preview" :style="{ '--preview-color': themes[previewTheme - 1]?.color ?? themes[0]!.color }">
            <div class="phone-notch" /><div class="preview-banner"><span>签到展示</span><strong>每天一点好心情</strong><small>本管理预览 · 不发放奖励</small></div>
            <div class="preview-days"><div v-for="row in visiblePreview" :key="row.id" class="preview-day"><span>{{ row.day ?? '待修复' }}</span><strong>{{ row.sign_num ?? '—' }}</strong><small>配置数值</small></div><p v-if="!visiblePreview.length" class="hint">暂无显示中的记录</p></div>
            <p v-if="(snapshot?.list.filter(row => row.status === 1).length ?? 0) > 7" class="hint preview-note">仅预览前七条显示记录</p>
            <div class="preview-button">签到展示示意</div><p class="preview-note">实际奖励以签到奖励规则为准</p>
          </div>
        </el-card>
      </div>
      <el-dialog v-model="dialogOpen" :title="formId ? (canManage ? '编辑展示记录' : '查看展示记录') : '添加展示记录'" width="min(520px, calc(100vw - 24px))" :close-on-click-modal="false" :close-on-press-escape="!busy && !confirming" :show-close="!busy && !confirming" @closed="closedDialog">
        <div v-loading="detailLoading">
          <el-alert v-if="detailError" :title="detailError" type="error" :closable="false" show-icon class="notice"><template #default><el-button v-if="formId" link :disabled="busy || confirming || !!pending" @click="rereadDetail">重新读取详情</el-button></template></el-alert>
          <el-alert v-if="formError" :title="formError" type="error" :closable="false" show-icon class="notice" />
          <el-alert v-if="sourceRow?.issues.length" :title="sourceRow.issues.join('；')" type="warning" :closable="false" class="notice" />
          <el-form v-if="form" label-position="top" :disabled="!canManage || busy || confirming || detailLoading || !!pending || !!recoveryError">
            <el-form-item label="天数文案"><el-input v-model="form.day" placeholder="例如：今天签到、周末加油" aria-label="天数文案" /><p class="hint">{{ Array.from(form.day).length }}/64 个字符；自由文字，保留原文与空格。</p></el-form-item>
            <el-form-item label="签到数值"><el-input-number v-model="form.sign_num" :min="1" :max="MAX" :precision="0" aria-label="签到数值" /><p class="hint">只配置展示数值，不影响实际奖励。</p></el-form-item>
            <el-form-item label="排序"><el-input-number v-model="form.sort" :min="0" :max="MAX" :precision="0" aria-label="排序" /></el-form-item>
            <el-form-item label="显示状态"><el-radio-group v-model="form.status" aria-label="显示状态"><el-radio :value="1">显示</el-radio><el-radio :value="0">隐藏</el-radio></el-radio-group><p v-if="form.status === null" class="issue">历史显示状态异常，请明确选择后修复。</p></el-form-item>
          </el-form>
        </div>
        <template #footer><el-button :disabled="busy || confirming" @click="closeDialog">{{ canManage ? '取消' : '关闭' }}</el-button><el-button v-if="canManage" type="primary" :loading="busy" :disabled="!form || detailLoading || !!detailError || locked || !ready" @click="save">保存记录</el-button></template>
      </el-dialog>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import axios from 'axios';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { AdminResponseError } from '@/utils/request';
import { apiSignDayList, apiSignDayDetail, apiSignDayMutate, apiSignDayReceipt, normalizeSignDayOperation,
  signDayFingerprint, signDayPendingKey, parseSignDayPending, assertSignDayReceipt, signDayReceiptNotFound,
  type SignDayRow, type SignDayList, type SignDayOperation, type SignDayPending, type SignDayReceipt } from '@/api/signDayConfig';

const MAX = 2_147_483_647, auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('sign_day_config.view')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('sign_day_config.manage')));
const identity = computed(() => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}`);
type Form = { day: string; sign_num: number | null; sort: number | null; status: 0 | 1 | null };
type Stamp = { generation: number; identity: string; stored: string | null };
type Job = { stamp: Stamp; controller: AbortController };
const snapshot = ref<SignDayList | null>(null), ready = ref(false), loading = ref(false), listError = ref('');
const dialogOpen = ref(false), formId = ref(0), form = ref<Form | null>(null), sourceRow = ref<SignDayRow | null>(null), detailLoading = ref(false), detailError = ref(''), formError = ref('');
const pending = ref<SignDayPending | null>(null), restoring = ref(false), recoveryError = ref(''), retryReady = ref(false);
const busy = ref(false), confirming = ref(false), readingReceipt = ref(false), notice = ref(''), noticeSuccess = ref(false);
const locked = computed(() => busy.value || confirming.value || restoring.value || readingReceipt.value || loading.value || !!pending.value || !!recoveryError.value);
const canAdd = computed(() => canManage.value && ready.value && !locked.value && !!snapshot.value && snapshot.value.count < 7);
const themes = [{ name: '蓝色', color: '#427ed6' }, { name: '绿色', color: '#36a479' }, { name: '红色', color: '#e94e53' }, { name: '粉色', color: '#d95c98' }, { name: '橙色', color: '#ed873a' }, { name: '金色', color: '#b89440' }];
const previewTheme = ref(1), visiblePreview = computed(() => snapshot.value?.list.filter(row => row.status === 1).slice(0, 7) ?? []);
let alive = false, syncing = false, generation = 0, confirmationId = 0, stored = localStorage.getItem('admin_session');
const jobs = new Map<string, Job>();
const message = (reason: unknown) => reason instanceof Error ? reason.message : '请求失败，请重试';
const stamp = (): Stamp => ({ generation, identity: identity.value, stored });
const current = (value: Stamp) => alive && canView.value && value.generation === generation && value.identity === identity.value && auth.token === getToken() && value.stored === localStorage.getItem('admin_session');
function cancel(channel: string) { jobs.get(channel)?.controller.abort(); jobs.delete(channel); }
function start(channel: string): Job { cancel(channel); const job = { stamp: stamp(), controller: new AbortController() }; jobs.set(channel, job); return job; }
function valid(channel: string, job: Job) { return jobs.get(channel) === job && current(job.stamp); }
function finish(channel: string, job: Job) { if (!valid(channel, job)) return false; jobs.delete(channel); return true; }
function rowCurrent(row: SignDayRow) { return !!snapshot.value?.list.some(item => item.id === row.id && item.revision === row.revision); }
function actionable(row: SignDayRow) { return current(stamp()) && canManage.value && ready.value && !locked.value && rowCurrent(row); }
function operationName(operation: SignDayOperation['operation']) { return ({ create: '新增', update: '修改', status: '切换状态', delete: '删除' })[operation]; }
function closeDialog() { if (busy.value || confirming.value) return; dialogOpen.value = false; cancel('detail'); detailLoading.value = false; form.value = null; sourceRow.value = null; detailError.value = formError.value = ''; }
function closedDialog() { if (!dialogOpen.value) closeDialog(); }
async function load() {
  if (!current(stamp()) || busy.value || confirming.value) return;
  const job = start('list'); ready.value = false; loading.value = true; listError.value = ''; snapshot.value = null;
  try { const result = await apiSignDayList(job.controller.signal); if (!valid('list', job)) return; snapshot.value = result; ready.value = true; previewTheme.value = result.theme ?? 1; }
  catch (reason) { if (valid('list', job)) listError.value = message(reason); }
  finally { if (finish('list', job)) loading.value = false; }
}
async function reload() { if (!current(stamp()) || busy.value || confirming.value || restoring.value) return; closeDialog(); await load(); }
function openCreate() { if (!canAdd.value || !current(stamp())) return; cancel('detail'); sourceRow.value = null; formId.value = 0; form.value = { day: '', sign_num: 1, sort: 0, status: 1 }; detailError.value = formError.value = ''; detailLoading.value = false; dialogOpen.value = true; }
async function openDetail(row: SignDayRow) {
  if (!current(stamp()) || locked.value || !ready.value || !rowCurrent(row)) return;
  formId.value = row.id; dialogOpen.value = true; form.value = null; sourceRow.value = null; detailError.value = formError.value = ''; detailLoading.value = true;
  const job = start('detail');
  try { const result = await apiSignDayDetail(row.id, job.controller.signal); if (!valid('detail', job) || !dialogOpen.value || formId.value !== row.id) return;
    if (result.revision !== row.revision) throw Error('记录已发生变化，请重新读取列表后再打开详情');
    sourceRow.value = result; form.value = { day: result.day ?? '', sign_num: result.sign_num, sort: result.sort, status: result.status === 0 || result.status === 1 ? result.status : null };
  } catch (reason) { if (valid('detail', job)) detailError.value = message(reason); }
  finally { if (finish('detail', job)) detailLoading.value = false; }
}
async function rereadDetail() { const row = snapshot.value?.list.find(item => item.id === formId.value); if (row) await openDetail(row); else detailError.value = '当前记录已不在列表中，请重新读取列表'; }
function knownRejection(reason: unknown) { return reason instanceof AdminResponseError && [400, 404, 409, 422].includes(Number(reason.status)) || axios.isAxiosError(reason) && [400, 404, 409, 422].includes(reason.response?.status ?? 0); }
function clearPending(frozen: SignDayPending) {
  const key = signDayPendingKey(frozen.actor), raw = sessionStorage.getItem(key);
  if (raw !== JSON.stringify(frozen)) throw Error('本地原请求记录已发生变化，请保留记录并核对');
  sessionStorage.removeItem(key); pending.value = null; retryReady.value = false;
}
function accept(result: SignDayReceipt, frozen: SignDayPending) { assertSignDayReceipt(result, frozen); clearPending(frozen); noticeSuccess.value = true; notice.value = `${operationName(result.operation)}已完成，记录 #${result.id}。列表将重新读取。`; closeDialog(); }
async function submitOriginal(frozen: SignDayPending) {
  if (!current(stamp()) || !canManage.value || busy.value || readingReceipt.value || pending.value?.input.body.request_id !== frozen.input.body.request_id) return;
  const job = start('write'); busy.value = true; retryReady.value = false; notice.value = ''; noticeSuccess.value = false;
  try { const result = await apiSignDayMutate(frozen.input, job.controller.signal); if (valid('write', job) && canManage.value) accept(result, frozen); }
  catch (reason) { if (!valid('write', job)) return;
    if (knownRejection(reason)) { try { clearPending(frozen); dialogOpen.value = false; notice.value = `操作被拒绝：${message(reason)}。请重新读取当前记录后操作。`; } catch (failure) { recoveryError.value = message(failure); } }
    else notice.value = `提交结果未确认：${message(reason)}。请读取原请求回执，不能发起新的写入。`;
  } finally { if (finish('write', job)) busy.value = false; }
  if (current(job.stamp)) { closeDialog(); if (!pending.value && !recoveryError.value) await load(); }
}
async function confirmOperation(input: SignDayOperation, summary: string) {
  if (!current(stamp()) || !canManage.value || locked.value || !ready.value) return;
  const scope = stamp(), version = ++confirmationId; confirming.value = true; formError.value = ''; notice.value = ''; noticeSuccess.value = false;
  let frozen: SignDayPending | null = null;
  try {
    const normalized = normalizeSignDayOperation(input), fingerprint = await signDayFingerprint(normalized);
    if (!current(scope) || !canManage.value || version !== confirmationId) return;
    await ElMessageBox.confirm(summary, `确认${operationName(input.operation)}`, { type: 'warning', confirmButtonText: '确认提交', cancelButtonText: '取消' });
    if (!current(scope) || !canManage.value || version !== confirmationId || pending.value || recoveryError.value) return;
    frozen = { version: 1, actor: auth.userInfo!.id, input: normalized, fingerprint };
    sessionStorage.setItem(signDayPendingKey(frozen.actor), JSON.stringify(frozen)); pending.value = frozen;
  } catch (reason) { if (current(scope) && reason !== 'cancel' && reason !== 'close') { if (dialogOpen.value) formError.value = message(reason); else notice.value = message(reason); } }
  finally { if (current(scope) && version === confirmationId) confirming.value = false; }
  if (current(scope) && frozen) await submitOriginal(frozen);
}
async function save() {
  if (!form.value || !snapshot.value || !canManage.value || locked.value || detailLoading.value || detailError.value || !ready.value) return;
  const value = form.value, id = formId.value;
  if (id ? !sourceRow.value || !rowCurrent(sourceRow.value) : !canAdd.value) return;
  const body = { revision: id ? sourceRow.value!.revision : snapshot.value.revision, day: value.day, sign_num: value.sign_num as number, sort: value.sort as number, status: value.status as 0 | 1, request_id: crypto.randomUUID() };
  const input = id ? { operation: 'update' as const, id, body } : { operation: 'create' as const, id: 0 as const, body };
  await confirmOperation(input, `${id ? `修改记录 #${id}` : snapshot.value.group_present ? '新增一条展示记录' : '初始化配置组并新增首条记录'}。\n文案：${JSON.stringify(value.day)}\n签到数值：${value.sign_num}；排序：${value.sort}；${value.status === 1 ? '显示' : '隐藏'}。\n此组不参与实际发奖。`);
}
async function toggle(row: SignDayRow) { if (!actionable(row) || ![0, 1].includes(row.status)) return; const status = row.status === 1 ? 0 : 1;
  await confirmOperation({ operation: 'status', id: row.id, body: { revision: row.revision, status, request_id: crypto.randomUUID() } }, `确认${status ? '显示' : '隐藏'}记录 #${row.id}“${row.day ?? '历史文案'}”？隐藏记录仍计入七行上限。`);
}
async function remove(row: SignDayRow) { if (!actionable(row)) return; await confirmOperation({ operation: 'delete', id: row.id, body: { revision: row.revision, request_id: crypto.randomUUID() } }, `确认删除展示记录 #${row.id}“${row.day ?? '历史文案'}”？此操作不改变签到奖励规则。`); }
async function readReceipt() {
  if (!current(stamp()) || !pending.value || busy.value || confirming.value || readingReceipt.value || restoring.value) return;
  const frozen = pending.value, job = start('receipt'); readingReceipt.value = true; retryReady.value = false; notice.value = ''; noticeSuccess.value = false;
  try { const result = await apiSignDayReceipt(frozen.input.body.request_id, job.controller.signal); if (valid('receipt', job)) accept(result, frozen); }
  catch (reason) { if (valid('receipt', job)) { if (signDayReceiptNotFound(reason)) { retryReady.value = true; notice.value = '明确未发现该请求回执。可主动重试原请求；请求ID、版本和全部内容保持原样。'; } else notice.value = `提交结果仍未确认：${message(reason)}`; } }
  finally { if (finish('receipt', job)) readingReceipt.value = false; }
  if (current(job.stamp) && !pending.value && !recoveryError.value) await load();
}
async function retryOriginal() {
  if (!pending.value || !retryReady.value || !canManage.value || busy.value || readingReceipt.value || confirming.value || !current(stamp())) return;
  const frozen = pending.value, scope = stamp(), version = ++confirmationId; confirming.value = true;
  try { await ElMessageBox.confirm(`确认重新提交原${operationName(frozen.input.operation)}请求？将复用请求 ${frozen.input.body.request_id} 和全部原内容，不生成新的请求ID。`, '重试原请求', { type: 'warning', confirmButtonText: '重试原请求', cancelButtonText: '取消' }); }
  catch { return; } finally { if (current(scope) && version === confirmationId) confirming.value = false; }
  if (current(scope) && version === confirmationId && canManage.value && pending.value === frozen && retryReady.value) await submitOriginal(frozen);
}
async function restore() {
  if (!current(stamp()) || !auth.userInfo) return; const scope = stamp(); restoring.value = true;
  try { const raw = sessionStorage.getItem(signDayPendingKey(auth.userInfo.id)); if (!raw) return; const saved = await parseSignDayPending(raw, auth.userInfo.id); if (current(scope)) pending.value = saved; }
  catch (reason) { if (current(scope)) recoveryError.value = `未完成请求记录无法安全恢复：${message(reason)}`; }
  finally { if (current(scope)) restoring.value = false; }
}
function invalidate() {
  generation++; confirmationId++; if (confirming.value) ElMessageBox.close(); for (const job of jobs.values()) job.controller.abort(); jobs.clear();
  snapshot.value = null; ready.value = loading.value = detailLoading.value = busy.value = confirming.value = readingReceipt.value = restoring.value = retryReady.value = false;
  dialogOpen.value = false; form.value = sourceRow.value = null; formId.value = 0; pending.value = null; listError.value = detailError.value = formError.value = notice.value = recoveryError.value = ''; noticeSuccess.value = false; previewTheme.value = 1;
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
.sign-day-config{display:grid;gap:16px;min-width:0}.heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.heading h2{margin:0 0 7px;font-size:20px}.hint{color:var(--el-text-color-secondary);font-size:13px;line-height:1.7;margin:5px 0}.content-grid{display:grid;grid-template-columns:minmax(0,1fr) 318px;gap:16px;align-items:start}.records{min-width:0}.table-scroll{overflow-x:auto;max-width:100%}.table-scroll>.el-table{min-width:680px}.issue{color:var(--el-color-danger);font-size:12px;line-height:1.6;margin:4px 0;overflow-wrap:anywhere}.notice{margin-bottom:12px}.count-hint{margin-top:14px}.preserve-text{white-space:pre-wrap;overflow-wrap:anywhere}.buttons{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.buttons .el-button+.el-button{margin-left:0}pre{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:200px;overflow:auto}.theme-picker{display:flex;justify-content:space-between;gap:12px;margin:18px 0}.theme-picker button{height:27px;width:27px;border:2px solid white;border-radius:50%;cursor:pointer;outline:1px solid var(--el-border-color)}.theme-picker button[aria-pressed=true]{outline:3px solid var(--el-color-primary)}.phone-preview{border:6px solid #303541;border-radius:30px;max-width:264px;background:#f5f6f8;margin:0 auto;padding:11px 9px 17px;color:#313641;overflow:hidden}.phone-notch{height:7px;width:66px;border-radius:8px;background:#303541;margin:0 auto 17px}.preview-banner{background:var(--preview-color);border-radius:14px;padding:19px 13px;color:white;display:grid;gap:9px}.preview-banner>span{font-size:12px}.preview-banner>strong{font-size:18px}.preview-banner>small{font-size:10px;opacity:.9}.preview-days{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin:14px 0}.preview-day{border-radius:10px;padding:10px 4px;background:white;display:grid;gap:7px;text-align:center;min-width:0}.preview-day span{font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}.preview-day strong{color:var(--preview-color);font-size:16px}.preview-day small{font-size:9px;color:#7d8490}.preview-button{background:var(--preview-color);color:white;font-size:13px;text-align:center;padding:10px;border-radius:18px}.preview-note{color:#7d8490;font-size:10px;text-align:center;line-height:1.7;margin:13px 0 0}.el-form-item .hint{width:100%}.el-input-number{width:100%}
@media(max-width:1050px){.content-grid{grid-template-columns:minmax(0,1fr)}.preview-card{max-width:400px;justify-self:center;width:100%}}@media(max-width:600px){.heading{align-items:flex-start}.heading h2{font-size:18px}.preview-card{max-width:100%}.el-card :deep(.el-card__body){padding:14px}.table-scroll>.el-table{min-width:680px}}
</style>
