<template>
  <div class="fab-settings">
    <div class="heading"><div><h2>悬浮按钮设置</h2><p class="hint">四种商城悬浮导航样式，最多五个子按钮。拖动预览可体验上下位置。</p></div><el-button :disabled="!canView || locked" @click="reread">读取当前版本并保留编辑</el-button></div>
    <el-alert v-if="!canView" title="没有悬浮按钮查看权限" type="warning" :closable="false" />
    <template v-else>
      <el-alert v-if="!canManage" title="当前仅有查看权限，设置不可修改" type="info" :closable="false" />
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <el-alert v-if="notice" :title="notice" :type="noticeSuccess ? 'success' : 'warning'" :closable="false" />
      <el-alert v-if="recoveryError" :title="recoveryError" type="error" :closable="false" />
      <el-alert v-if="pending" title="原请求结果尚未确认，已锁定编辑与新的提交" type="warning" :closable="false" show-icon>
        <p>请先核对原请求回执；只有明确未找到回执，才能主动重试相同请求。</p>
        <div class="buttons"><el-button :disabled="readingReceipt || busy || confirming || restoring" :loading="readingReceipt" @click="readReceipt">读取原请求回执</el-button><el-button v-if="retryReady" :disabled="!canManage || readingReceipt || busy || confirming || restoring" @click="retryOriginal">原样重试</el-button></div>
      </el-alert>
      <el-alert v-if="snapshot && !snapshot.present" title="尚未建立悬浮配置。填写完整设置并保存后创建，读取操作不会创建记录。" type="info" :closable="false" />
      <el-alert v-if="snapshot && !snapshot.editable" title="存在重复记录或配置无法安全编辑，所有写入已暂停，请先修复数据。" type="error" :closable="false" />
      <el-alert v-if="needsReread" title="本次未保存，原字段已保留。请读取当前版本并核对，再确认保存。" type="warning" :closable="false" />
      <details v-if="snapshot?.issues.length"><summary>历史配置诊断（{{ snapshot.issues.length }}）</summary><ul><li v-for="(issue, n) in snapshot.issues" :key="n">{{ issue }}</li></ul></details>
      <div v-if="snapshot?.values || pending || rejected" v-loading="loading" class="settings-layout">
        <el-card shadow="never">
          <el-form label-position="top" :disabled="editorDisabled">
            <el-form-item label="显示悬浮按钮"><el-radio-group v-model="form.is_show" aria-label="显示悬浮按钮" :disabled="editorDisabled"><el-radio :value="1">开启</el-radio><el-radio :value="0">关闭</el-radio></el-radio-group><p class="hint">关闭仍须保存有效的样式、图片与链接。</p></el-form-item>
            <el-form-item label="展示样式" required><el-radio-group :model-value="form.index" aria-label="展示样式" :disabled="editorDisabled" @change="changeStyle"><el-radio v-for="n in 4" :key="n" :value="n">{{ ['纵向列表', '横向收起', '圆弧图标', '圆弧灰球'][n - 1] }}</el-radio></el-radio-group></el-form-item>
            <el-form-item label="纵向位置（0—100）" required><el-slider v-model="form.shifting" :min="0" :max="100" show-input :disabled="editorDisabled" aria-label="纵向位置" /><p class="hint">0 贴顶、100 贴底，展开时按整个悬浮组件高度限制位置。商城用户可上下拖动。</p></el-form-item>
            <el-form-item v-if="form.index !== 4" label="展开前主图" required><div class="image-field"><el-image v-if="beforePreview" :src="beforePreview" fit="contain" /><el-input v-model="form.main_ago_image" aria-label="展开前主图地址" :disabled="editorDisabled" maxlength="255" placeholder="稳定图片地址或图库素材" /><ImagePicker :disabled="editorDisabled" :editor-key="pickerKey + ':before'" title="选择展开前主图" @choose="chooseBefore" /></div></el-form-item>
            <el-form-item v-if="form.index === 3" label="展开后主图" required><div class="image-field"><el-image v-if="afterPreview" :src="afterPreview" fit="contain" /><el-input v-model="form.main_after_image" aria-label="展开后主图地址" :disabled="editorDisabled" maxlength="255" /><ImagePicker :disabled="editorDisabled" :editor-key="pickerKey + ':after'" title="选择展开后主图" @choose="chooseAfter" /></div></el-form-item>
            <p class="hint">{{ form.index === 4 ? '灰球样式不使用主图。' : form.index === 3 ? '圆弧样式需要展开前、展开后两张主图。' : '列表样式仅使用展开前主图，保存时展开后图为空。' }}</p>
            <div class="child-heading"><strong>子按钮（{{ form.button.length }}/5）</strong><el-button :disabled="editorDisabled || form.button.length >= 5" @click="addButton">新增按钮</el-button></div>
            <p class="hint">列表样式允许 0—5 个，圆弧样式须 3—5 个。拖动卡片排序，也可使用上移、下移，触屏操作同样可用。</p>
            <article v-for="(item, n) in form.button" :key="item.key" class="button-card" :draggable="!editorDisabled" @dragstart="dragStart(n, $event)" @dragover.prevent @drop.prevent="drop(n)">
              <div class="button-heading"><strong>按钮 {{ n + 1 }}</strong><div class="buttons"><el-button size="small" :disabled="editorDisabled || n === 0" @click="moveButton(n, -1)">上移</el-button><el-button size="small" :disabled="editorDisabled || n === form.button.length - 1" @click="moveButton(n, 1)">下移</el-button><el-button size="small" type="danger" :disabled="editorDisabled || form.index !== null && form.index >= 3 && form.button.length <= 3" @click="removeButton(n)">删除</el-button></div></div>
              <el-form-item :label="'按钮 ' + (n + 1) + ' 图片'" required><div class="image-field"><el-image v-if="buttonPreview(item)" :src="buttonPreview(item)" fit="contain" /><el-input v-model="item.img" :aria-label="'按钮 ' + (n + 1) + ' 图片地址'" maxlength="255" :disabled="editorDisabled" /><ImagePicker :disabled="editorDisabled" :editor-key="pickerKey + ':' + item.key" :title="'选择按钮 ' + (n + 1) + ' 图片'" @choose="(reference, preview) => chooseButton(item.key, reference, preview)" /></div></el-form-item>
              <el-form-item :label="'按钮 ' + (n + 1) + ' 链接'" required><el-input v-model="item.url" :aria-label="'按钮 ' + (n + 1) + ' 链接'" maxlength="2048" :disabled="editorDisabled" placeholder="/pages/...、HTTP(S) 或外部小程序路径@APPID=wx..." /><LinkPicker :disabled="editorDisabled" :editor-key="pickerKey + ':' + item.key" @choose="(url, label) => chooseLink(item.key, url, label)" /><p v-if="item.target_label" class="hint">已选择：{{ item.target_label }}</p></el-form-item>
              <p v-if="!fabLinkSafe(item.url.trim())" class="issue">请配置已登记商城页面、安全 HTTP/HTTPS 网页或有效的外部小程序目标。H5/App 无法打开外部小程序。</p>
              <div v-if="item.unresolved" class="source-repair"><p class="issue">原按钮的附加设置无法自动对应，请明确选择要保留的当前按钮。</p><el-select :model-value="''" :disabled="editorDisabled" :aria-label="'按钮 ' + (n + 1) + ' 保留附加设置'" placeholder="核对原按钮附加设置" @change="(value: unknown) => chooseSource(item.key, value)"><el-option v-for="(old, j) in snapshot?.values?.button ?? []" :key="old.source_id ?? j" :value="old.source_id ?? ''" :disabled="!old.source_id || form.button.some(other => other.key !== item.key && !other.unresolved && other.source_id === old.source_id)" :label="'保留当前按钮 ' + (j + 1) + ' 的附加设置：' + (old.url || '链接待修复')" /><el-option value="__new" label="作为新按钮，不继承原附加设置" /></el-select></div>
              <p v-else class="hint">{{ item.source_id ? '保存时保留此原按钮的附加设置，移动顺序不会丢失。' : '新按钮，仅保存图片与链接。' }}</p>
            </article>
          </el-form>
          <p class="hint">图库预览地址可能短期有效，保存使用稳定素材引用。商城以本页面的显示开关为准。</p>
          <el-button v-if="canManage" type="primary" :disabled="editorDisabled || needsReread || form.button.some(item => item.unresolved)" :loading="busy" @click="save">保存悬浮按钮设置</el-button>
        </el-card>
        <FabPreview :index="form.index" :shifting="form.shifting" :before="beforePreview" :after="afterPreview" :buttons="previewButtons" />
      </div>
      <p v-if="loading && !snapshot" class="hint">正在读取悬浮配置…</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import ImagePicker from '@/pages/activity/SeckillActivityImagePicker.vue';
import FabPreview from './FabPreview.vue';
import LinkPicker from './FabLinkPicker.vue';
import { FabRequestScope } from './fabSettingsController';
import { apiFabSettings, apiSaveFabSettings, apiFabReceipt, fabEditor, fabEditorValues, fabFingerprint, normalizeFabWrite, fabPendingKey, fabDraftKey, parseFabPending, assertFabReceipt, isFabStale, isFabRejected, fabReceiptNotFound, fabErrorMessage, fabPreview, fabLinkSafe, remapFabEditor, type FabSnapshot, type FabEditor, type FabEditorButton, type FabPending, type FabReceipt, type FabValues, type FabReadButton } from '@/api/fabSettings';
const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('fab_settings.view')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('fab_settings.manage')));
const identity = computed(() => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}`);
const scope = new FabRequestScope(() => identity.value, () => localStorage.getItem('admin_session'), () => alive && canView.value);
const blank = (): FabEditor => ({ is_show: null, index: null, shifting: 0, main_ago_image: '', main_after_image: '', button: [] });
const form = ref<FabEditor>(blank()), snapshot = ref<FabSnapshot | null>(null), baseline = ref<FabReadButton[]>([]), previewMap = ref<Record<string, string>>({});
const pending = ref<FabPending | null>(null), rejected = ref<FabPending | null>(null), ready = ref(false), needsReread = ref(false), retryReady = ref(false);
const loading = ref(false), busy = ref(false), confirming = ref(false), restoring = ref(false), readingReceipt = ref(false), error = ref(''), notice = ref(''), noticeSuccess = ref(false), recoveryError = ref('');
const locked = computed(() => loading.value || busy.value || confirming.value || restoring.value || readingReceipt.value || !!pending.value || !!recoveryError.value);
const editorDisabled = computed(() => !canManage.value || locked.value || !ready.value || !snapshot.value?.editable);
const pickerKey = computed(() => identity.value + ':' + (snapshot.value?.revision ?? '') + ':' + generation);
let alive = false, syncing = false, confirmation = 0, generation = 0, dragging: number | null = null;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function image(reference: string, picked = '') { const known = previewMap.value[reference] || picked; return fabPreview(known) || (reference.startsWith('/api/assets/') ? '' : fabPreview(reference)); }
const beforePreview = computed(() => image(form.value.main_ago_image)), afterPreview = computed(() => image(form.value.main_after_image));
const previewButtons = computed(() => form.value.button.map(item => ({ ...item, preview: buttonPreview(item) })));
function buttonPreview(item: FabEditorButton) { return image(item.img); }
function collectPreviews(value: FabSnapshot) { const values = value.values; if (!values) return; const pairs: Array<[string | null, string]> = [[values.main_ago_image, value.image_previews.main_ago_image], [values.main_after_image, value.image_previews.main_after_image], ...values.button.map((item, n): [string | null, string] => [item.img, value.image_previews.button[n] ?? ''])]; for (const [ref, preview] of pairs) if (ref && fabPreview(preview)) previewMap.value[ref] = preview; }
function hydratePending(value: FabPending) { form.value = fabEditor(value.input.values); baseline.value = clone(value.baseline); }
async function load(preserve = false) {
  if (!scope.current(scope.stamp()) || busy.value || confirming.value || readingReceipt.value || restoring.value) return;
  const job = scope.begin('load'); loading.value = true; ready.value = false; error.value = ''; const editing = clone(form.value), old = clone(baseline.value);
  try { const latest = await apiFabSettings(job.controller.signal); if (!scope.valid('load', job)) return; snapshot.value = latest; collectPreviews(latest);
    if (pending.value) hydratePending(pending.value);
    else if (preserve && latest.values && latest.editable) { form.value = remapFabEditor(editing, old, latest.values.button); baseline.value = clone(latest.values.button); needsReread.value = false; notice.value = form.value.button.some(item => item.unresolved) ? '原字段已保留。请核对不能自动对应的按钮附加设置，再保存。' : '已读取当前版本并保留原字段，请核对后再次确认保存。'; }
    else if (rejected.value) { hydratePending(rejected.value); needsReread.value = true; }
    else if (latest.values) { form.value = fabEditor(latest.values, latest.image_previews); baseline.value = clone(latest.values.button); needsReread.value = false; }
    ready.value = true;
  } catch (reason) { if (scope.valid('load', job)) error.value = `读取失败，现有字段已保留且不能保存：${fabErrorMessage(reason)}`; }
  finally { if (scope.finish('load', job)) loading.value = false; }
}
async function reread() { if (locked.value || !canView.value) return; if (snapshot.value?.values || rejected.value) await load(true); else await load(); }
function changeStyle(value: unknown) { if (editorDisabled.value || !Number.isInteger(value) || Number(value) < 1 || Number(value) > 4) return; form.value.index = value as FabValues['index']; if (value !== 3) form.value.main_after_image = ''; if (value === 4) form.value.main_ago_image = ''; if (Number(value) >= 3) while (form.value.button.length < 3) form.value.button.push(newButton()); }
function newButton(): FabEditorButton { return { key: crypto.randomUUID(), source_id: null, img: '', url: '', preview: '', unresolved: false }; }
function addButton() { if (!editorDisabled.value && form.value.button.length < 5) form.value.button.push(newButton()); }
function removeButton(n: number) { if (editorDisabled.value || form.value.index !== null && form.value.index >= 3 && form.value.button.length <= 3) return; form.value.button.splice(n, 1); }
function moveButton(n: number, delta: number) { if (editorDisabled.value || n + delta < 0 || n + delta >= form.value.button.length) return; const [item] = form.value.button.splice(n, 1); form.value.button.splice(n + delta, 0, item!); }
function dragStart(n: number, event: DragEvent) { if (editorDisabled.value) { event.preventDefault(); return; } dragging = n; event.dataTransfer?.setData('text/plain', String(n)); }
function drop(n: number) { if (editorDisabled.value || dragging === null || dragging === n) return; const from = dragging; dragging = null; moveButton(from, n - from); }
function chooseMain(field: 'main_ago_image' | 'main_after_image', reference: string, preview: string) { if (editorDisabled.value) return; form.value[field] = reference; previewMap.value[reference] = fabPreview(preview); }
function chooseBefore(reference: string, preview: string) { chooseMain('main_ago_image', reference, preview); }
function chooseAfter(reference: string, preview: string) { chooseMain('main_after_image', reference, preview); }
function chooseButton(key: string, reference: string, preview: string) { if (editorDisabled.value) return; const item = form.value.button.find(row => row.key === key); if (item) { item.img = reference; item.preview = fabPreview(preview); previewMap.value[reference] = fabPreview(preview); } }
function chooseLink(key: string, url: string, label: string) { if (editorDisabled.value || !fabLinkSafe(url)) return; const item = form.value.button.find(row => row.key === key); if (item) { item.url = url; item.target_label = label; } }
function chooseSource(key: string, value: unknown) { if (editorDisabled.value) return; const item = form.value.button.find(row => row.key === key); if (!item || !item.unresolved) return; if (value === '__new') { item.source_id = null; item.unresolved = false; } else if (typeof value === 'string' && snapshot.value?.values?.button.some(row => row.source_id === value) && !form.value.button.some(other => other.key !== key && !other.unresolved && other.source_id === value)) { item.source_id = value; item.unresolved = false; } }
function clearPending(value: FabPending) { const key = fabPendingKey(value.actor); if (sessionStorage.getItem(key) !== JSON.stringify(value)) throw Error('本地原请求已变化，请保留记录并核对'); sessionStorage.removeItem(key); pending.value = null; retryReady.value = false; }
function accept(value: FabReceipt, frozen: FabPending) { assertFabReceipt(value, frozen); clearPending(frozen); sessionStorage.removeItem(fabDraftKey(frozen.actor)); rejected.value = null; needsReread.value = false; noticeSuccess.value = true; notice.value = '悬浮按钮已确认保存，将读取当前配置。'; }
async function submitOriginal(frozen: FabPending) {
  if (!scope.current(scope.stamp()) || !canManage.value || busy.value || readingReceipt.value || pending.value?.input.request_id !== frozen.input.request_id) return;
  const job = scope.begin('write'); busy.value = true; retryReady.value = false; noticeSuccess.value = false; notice.value = '';
  try { const receipt = await apiSaveFabSettings(frozen.input, job.controller.signal); if (scope.valid('write', job) && canManage.value) accept(receipt, frozen); }
  catch (reason) { if (!scope.valid('write', job)) return;
    if (isFabRejected(reason, frozen) || isFabStale(reason, frozen)) { try { sessionStorage.setItem(fabDraftKey(frozen.actor), JSON.stringify(frozen)); rejected.value = frozen; clearPending(frozen); hydratePending(frozen); needsReread.value = true; notice.value = `本次未保存：${isFabStale(reason, frozen) ? '配置版本已改变' : fabErrorMessage(reason)}。原字段已保留，请读取当前版本并核对后再提交。`; } catch (failure) { recoveryError.value = fabErrorMessage(failure); } }
    else notice.value = `提交结果尚未确认：${fabErrorMessage(reason)}。请先读取原请求回执，不能发起新的写入。`;
  } finally { if (scope.finish('write', job)) busy.value = false; }
  if (scope.current(job.stamp) && !pending.value && !rejected.value && !recoveryError.value) await load();
}
async function save() {
  if (editorDisabled.value || needsReread.value || !snapshot.value || !auth.userInfo || !scope.current(scope.stamp())) return; const stamp = scope.stamp(), version = ++confirmation; confirming.value = true; notice.value = ''; noticeSuccess.value = false; let frozen: FabPending | null = null;
  try { const input = normalizeFabWrite({ request_id: crypto.randomUUID(), revision: snapshot.value.revision, values: fabEditorValues(form.value) }), fingerprint = await fabFingerprint(input); if (!scope.current(stamp) || version !== confirmation || !canManage.value) return;
    await ElMessageBox.confirm(`确认同时保存显示开关、样式、纵向位置、主图和${input.values.button.length}个按钮？原按钮附加设置按核对的对应关系保留。`, '确认保存悬浮按钮', { type: 'warning', confirmButtonText: '确认提交', cancelButtonText: '取消' });
    if (!scope.current(stamp) || version !== confirmation || !canManage.value || pending.value || recoveryError.value) return;
    frozen = { version: 1, actor: auth.userInfo.id, id: snapshot.value.row?.id ?? null, input, fingerprint, baseline: clone(baseline.value) }; const key = fabPendingKey(frozen.actor); if (sessionStorage.getItem(key) !== null) throw Error('已有未完成请求，请重新打开页面并核对');
    sessionStorage.setItem(key, JSON.stringify(frozen)); pending.value = frozen;
  } catch (reason) { if (scope.current(stamp) && reason !== 'cancel' && reason !== 'close') notice.value = fabErrorMessage(reason); }
  finally { if (scope.current(stamp) && version === confirmation) confirming.value = false; }
  if (scope.current(stamp) && frozen && pending.value?.input.request_id === frozen.input.request_id) await submitOriginal(frozen);
}
async function readReceipt() {
  if (!pending.value || busy.value || confirming.value || readingReceipt.value || restoring.value || !scope.current(scope.stamp())) return; const frozen = pending.value, job = scope.begin('receipt'); readingReceipt.value = true; retryReady.value = false; notice.value = '';
  try { const result = await apiFabReceipt(frozen.input.request_id, job.controller.signal); if (scope.valid('receipt', job)) accept(result, frozen); }
  catch (reason) { if (scope.valid('receipt', job)) { if (fabReceiptNotFound(reason)) { retryReady.value = true; notice.value = '服务端明确未找到原请求回执，可主动原样重试，原标识、版本和全部内容保持不变。'; } else notice.value = `原请求仍未确认：${fabErrorMessage(reason)}`; } }
  finally { if (scope.finish('receipt', job)) readingReceipt.value = false; }
  if (scope.current(job.stamp) && !pending.value && !recoveryError.value) await load();
}
async function retryOriginal() {
  if (!pending.value || !retryReady.value || !canManage.value || busy.value || readingReceipt.value || confirming.value || !scope.current(scope.stamp())) return; const frozen = pending.value, stamp = scope.stamp(), version = ++confirmation; confirming.value = true;
  try { await ElMessageBox.confirm('确认重试相同悬浮设置请求？原标识、版本及全部字段均保持不变。', '原样重试', { type: 'warning', confirmButtonText: '原样重试', cancelButtonText: '取消' }); } catch { return; } finally { if (scope.current(stamp) && version === confirmation) confirming.value = false; }
  if (scope.current(stamp) && version === confirmation && canManage.value && pending.value === frozen && retryReady.value) await submitOriginal(frozen);
}
async function restore() { if (!scope.current(scope.stamp()) || !auth.userInfo) return; const stamp = scope.stamp(); restoring.value = true;
  try { const raw = sessionStorage.getItem(fabPendingKey(auth.userInfo.id)), draft = raw ? null : sessionStorage.getItem(fabDraftKey(auth.userInfo.id)); if (raw || draft) { const value = await parseFabPending((raw || draft)!, auth.userInfo.id); if (!scope.current(stamp)) return; if (raw) pending.value = value; else { rejected.value = value; needsReread.value = true; } hydratePending(value); } }
  catch (reason) { if (scope.current(stamp)) recoveryError.value = `原请求无法安全恢复：${fabErrorMessage(reason)}`; }
  finally { if (scope.current(stamp)) restoring.value = false; }
}
function invalidate() { scope.invalidate(); generation++; confirmation++; if (confirming.value) ElMessageBox.close(); snapshot.value = null; form.value = blank(); baseline.value = []; previewMap.value = {}; pending.value = rejected.value = null; ready.value = needsReread.value = loading.value = busy.value = confirming.value = restoring.value = readingReceipt.value = retryReady.value = false; error.value = notice.value = recoveryError.value = ''; noticeSuccess.value = false; dragging = null; }
async function boot() { const stamp = scope.stamp(); await restore(); if (scope.current(stamp)) await load(); }
function syncStored(event?: Event) { if (syncing || event instanceof StorageEvent && event.key !== null && !['admin_token', 'admin_session'].includes(event.key)) return; syncing = true; invalidate(); const session = getAdminSession(); auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] }); syncing = false; void boot(); }
watch(identity, () => { if (alive && !syncing) { invalidate(); void boot(); } }, { flush: 'sync' });
onMounted(() => { alive = true; window.addEventListener('storage', syncStored); window.addEventListener('admin-session-changed', syncStored); window.addEventListener('admin-auth-expired', syncStored); syncStored(); });
onBeforeUnmount(() => { alive = false; invalidate(); scope.dispose(); window.removeEventListener('storage', syncStored); window.removeEventListener('admin-session-changed', syncStored); window.removeEventListener('admin-auth-expired', syncStored); });
</script>
<style scoped>
.fab-settings{display:grid;gap:16px;min-width:0}.heading{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:center}.heading h2{margin:0;font-size:20px}.hint{font-size:12px;line-height:1.7;color:var(--el-text-color-secondary);overflow-wrap:anywhere;margin:7px 0}.issue{font-size:12px;color:var(--el-color-danger);overflow-wrap:anywhere}.settings-layout{display:grid;grid-template-columns:minmax(0,1fr) 375px;gap:24px;align-items:start}.settings-layout>.el-card{min-width:0}.image-field{display:grid;gap:8px;width:100%;justify-items:start}.image-field .el-image{width:90px;height:70px}.image-field .el-input{width:100%}.child-heading,.button-heading{display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap}.buttons{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.buttons .el-button+.el-button{margin-left:0}.button-card{padding:14px;margin:12px 0;border:1px solid var(--el-border-color);border-radius:8px}.button-card .el-form-item{margin-top:12px}.source-repair .el-select{width:100%}.fab-settings :deep(.el-alert__content){min-width:0;overflow-wrap:anywhere}.fab-settings :deep(.el-slider){width:100%;margin-left:6px;margin-right:6px}.fab-settings :deep(.el-slider__input){width:112px}.fab-settings :deep(.el-radio-group){display:flex;flex-wrap:wrap}.fab-settings :deep(.el-form-item__content){min-width:0}.fab-settings :deep(.el-radio){margin-right:18px}details{font-size:13px}details ul{padding-left:20px}
@media(max-width:1100px){.settings-layout{grid-template-columns:minmax(0,1fr)}}@media(max-width:600px){.heading h2{font-size:18px}.button-card{padding:10px}.fab-settings :deep(.el-card__body){padding:14px}.fab-settings :deep(.el-slider__runway.show-input){margin-right:120px}.settings-layout{gap:16px}}
</style>

