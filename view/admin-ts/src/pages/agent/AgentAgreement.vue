<template>
  <div class="agent-agreement-page">
    <div class="heading">
      <div>
        <h2>分销说明</h2>
        <p>编辑推广员和代理商申请时阅读的同一份说明。保存后，公开协议立即使用新内容。</p>
      </div>
      <el-button v-if="canView" :loading="loading" :disabled="saving" @click="load">重新读取</el-button>
    </div>
    <el-alert v-if="!canView" title="当前账号没有分销说明查看权限" type="warning" :closable="false" show-icon />
    <el-card v-else shadow="never" v-loading="loading">
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="notice" />
      <el-alert v-if="notice" :title="notice" type="warning" :closable="false" show-icon class="notice" />
      <div class="field">
        <span class="label">协议名称</span>
        <strong>{{ record.title }}</strong>
      </div>
      <div class="field">
        <span class="label">前台状态</span>
        <el-switch v-model="record.status" :active-value="1" :inactive-value="0"
          active-text="启用" inactive-text="停用" :disabled="!canManage || saving || loading" />
        <p class="hint">停用或清空说明会阻止新的推广员及代理商申请。</p>
      </div>
      <div class="editor-header">
        <span class="label">说明内容</span>
        <el-radio-group v-model="mode" size="small" :disabled="saving" @change="changeMode">
          <el-radio-button value="visual">富文本</el-radio-button>
          <el-radio-button value="html">HTML 源码</el-radio-button>
          <el-radio-button value="preview">预览</el-radio-button>
        </el-radio-group>
      </div>
      <div v-if="mode === 'visual'" class="editor-wrap">
        <div v-if="canManage" class="toolbar">
          <el-button size="small" :disabled="saving || loading" @mousedown.prevent @click="format('bold')">粗体</el-button>
          <el-button size="small" :disabled="saving || loading" @mousedown.prevent @click="format('italic')">斜体</el-button>
          <el-button size="small" :disabled="saving || loading" @mousedown.prevent @click="format('insertUnorderedList')">列表</el-button>
          <el-button size="small" :disabled="saving || loading" @mousedown.prevent @click="format('formatBlock', 'h3')">小标题</el-button>
        </div>
        <div ref="richEditor" class="rich-editor" :contenteditable="canManage && !saving && !loading"
          role="textbox" aria-label="分销说明富文本" @input="readRich" @paste="pasteRich" @drop.prevent />
      </div>
      <el-input v-else-if="mode === 'html' && canManage" v-model="record.content" type="textarea"
        :rows="16" maxlength="200000" show-word-limit :disabled="saving || loading" aria-label="分销说明 HTML 源码" />
      <div v-else class="rich-preview" v-html="safePreview" />
      <p class="hint">可用 HTML 源码保留历史排版；服务端保存时会清理脚本、事件属性和不安全链接。</p>
      <div class="actions">
        <span v-if="record.id">记录 ID {{ record.id }}</span>
        <el-button v-if="canManage" type="primary" :loading="saving" :disabled="loading || !dirty || !record.content.trim()"
          @click="save">保存说明</el-button>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { apiAgentAgreement, apiSaveAgentAgreement, type AgentAgreement } from '@/api/agentAgreement';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { AdminResponseError } from '@/utils/request';
import { sanitizeArticleRichText } from '../../../../common/articleRichText';

const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes('agent_agreement.view')));
const canManage = computed(() => canView.value && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes('agent_agreement.manage')));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ''}:${auth.uniqueAuth.join(',')}`);
const empty = (): AgentAgreement => ({ id: 0, type: 2, title: '分销说明', content: '', sort: 0,
  status: 1, add_time: 0, revision: 'absent' });
const record = ref<AgentAgreement>(empty());
const baseline = ref<AgentAgreement>(empty());
const mode = ref<'visual' | 'html' | 'preview'>('visual');
const richEditor = ref<HTMLElement | null>(null);
const loading = ref(false), saving = ref(false), error = ref(''), notice = ref('');
const safePreview = computed(() => sanitizeArticleRichText(record.value.content));
const dirty = computed(() => record.value.content !== baseline.value.content || record.value.status !== baseline.value.status);
let mounted = false, syncing = false, generation = 0, operation = 0;
let storedSession = localStorage.getItem('admin_session');
let readAbort: AbortController | null = null, writeAbort: AbortController | null = null;
interface Scope { generation: number; session: string; storedSession: string | null }
function scope(): Scope { return { generation, session: sessionKey.value, storedSession }; }
function current(value: Scope) {
  return mounted && canView.value && value.generation === generation && value.session === sessionKey.value &&
    auth.token === getToken() && value.storedSession === localStorage.getItem('admin_session');
}
function invalidate() {
  generation++; operation++; readAbort?.abort(); writeAbort?.abort();
  readAbort = null; writeAbort = null; loading.value = false; saving.value = false;
  record.value = empty(); baseline.value = empty(); error.value = ''; notice.value = '';
  if (richEditor.value) richEditor.value.innerHTML = '';
}
async function hydrateRich() {
  await nextTick();
  if (richEditor.value) richEditor.value.innerHTML = sanitizeArticleRichText(record.value.content);
}
function readRich() { if (canManage.value && richEditor.value) record.value.content = richEditor.value.innerHTML; }
function pasteRich(event: ClipboardEvent) {
  if (!canManage.value) { event.preventDefault(); return; }
  event.preventDefault();
  const html = event.clipboardData?.getData('text/html');
  const text = event.clipboardData?.getData('text/plain') ?? '';
  const safe = html ? sanitizeArticleRichText(html) : text;
  document.execCommand(html ? 'insertHTML' : 'insertText', false, safe);
  readRich();
}
function format(command: string, value?: string) {
  if (!canManage.value || !richEditor.value || saving.value || loading.value) return;
  richEditor.value.focus(); document.execCommand(command, false, value); readRich();
}
async function changeMode() {
  if (mode.value === 'visual') await hydrateRich();
}
async function load() {
  if (!mounted || !canView.value || auth.token !== getToken() || storedSession !== localStorage.getItem('admin_session')) return;
  readAbort?.abort(); const controller = new AbortController(); readAbort = controller;
  const stamp = scope(); loading.value = true; error.value = ''; notice.value = '';
  try {
    const next = await apiAgentAgreement(controller.signal);
    if (!current(stamp) || readAbort !== controller) return;
    record.value = { ...next }; baseline.value = { ...next };
    if (mode.value === 'visual') await hydrateRich();
  } catch (caught) {
    if (current(stamp) && readAbort === controller) error.value = caught instanceof Error ? caught.message : '分销说明加载失败';
  } finally {
    if (readAbort === controller) { readAbort = null; loading.value = false; }
  }
}
async function save() {
  if (!mounted || !canManage.value || saving.value || loading.value || !dirty.value) return;
  if (mode.value === 'visual') readRich();
  if (!record.value.content.trim() || record.value.content.length > 200_000) {
    error.value = '请填写 1–200000 字的说明内容'; return;
  }
  const stamp = scope(), requestId = ++operation, controller = new AbortController();
  writeAbort = controller; saving.value = true; error.value = ''; notice.value = '';
  try {
    const next = await apiSaveAgentAgreement(record.value, controller.signal);
    if (!current(stamp) || requestId !== operation) return;
    record.value = { ...next }; baseline.value = { ...next };
    if (mode.value === 'visual') await hydrateRich();
    ElMessage.success('分销说明已保存');
  } catch (caught) {
    if (!current(stamp) || requestId !== operation) return;
    const detail = caught instanceof Error ? caught.message : '请求失败';
    notice.value = `${caught instanceof AdminResponseError ? '保存未完成' : '保存结果未确认'}：${detail}。请重新读取后核对内容。`;
  } finally {
    if (requestId === operation) { saving.value = false; writeAbort = null; }
  }
}
function syncSession() {
  syncing = true; invalidate(); const session = getAdminSession();
  auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  storedSession = localStorage.getItem('admin_session'); syncing = false; void load();
}
function syncStorage(event: StorageEvent) {
  if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') syncSession();
}
watch(sessionKey, () => { if (mounted && !syncing) { invalidate(); void load(); } }, { flush: 'sync' });
onMounted(() => {
  mounted = true;
  window.addEventListener('admin-session-changed', syncSession);
  window.addEventListener('admin-auth-expired', syncSession);
  window.addEventListener('storage', syncStorage);
  syncSession();
});
onBeforeUnmount(() => {
  mounted = false; invalidate();
  window.removeEventListener('admin-session-changed', syncSession);
  window.removeEventListener('admin-auth-expired', syncSession);
  window.removeEventListener('storage', syncStorage);
});
</script>

<style scoped>
.agent-agreement-page { min-width: 0; }
.heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.heading h2 { margin: 0 0 6px; font-size: 18px; }
.heading p, .hint { margin: 0; color: #737985; font-size: 12px; line-height: 1.6; }
.notice { margin-bottom: 16px; }
.field { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
.field .hint { flex-basis: 100%; }
.label { color: #303133; font-size: 14px; font-weight: 600; }
.editor-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; border-bottom: 1px solid #dcdfe6; }
.toolbar :deep(.el-button) { margin-left: 0; }
.editor-wrap, .rich-preview { border: 1px solid #dcdfe6; border-radius: 4px; background: #fff; }
.rich-editor, .rich-preview { min-height: 360px; max-width: 100%; padding: 14px; overflow: auto; overflow-wrap: anywhere; line-height: 1.6; }
.rich-editor:focus { outline: 2px solid #409eff; outline-offset: -2px; }
.rich-editor :deep(img), .rich-preview :deep(img) { max-width: 100%; height: auto; }
.rich-editor :deep(table), .rich-preview :deep(table) { max-width: 100%; }
.actions { display: flex; justify-content: flex-end; align-items: center; gap: 12px; margin-top: 18px; color: #909399; font-size: 12px; }
@media (max-width: 640px) { .editor-header { align-items: stretch; flex-direction: column; } .editor-header :deep(.el-radio-group) { flex-wrap: wrap; } }
</style>
