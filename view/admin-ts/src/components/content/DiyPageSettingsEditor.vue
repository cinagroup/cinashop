<template>
  <section class="page-settings-editor">
    <p class="hint">页面状态与首页启用分别设置。关闭背景选项会保留已选颜色和图片。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-form-item label="页面显示"><el-switch :model-value="modelValue.is_show" :active-value="1" :inactive-value="0" :disabled="!canEdit || !pageId" @update:model-value="setFlag('is_show', $event)" /><span v-if="!pageId" class="hint">新增页先保存为关闭状态</span></el-form-item>
    <el-form-item label="使用背景色"><el-switch :model-value="modelValue.is_bg_color" :active-value="1" :inactive-value="0" :disabled="!canEdit" @update:model-value="setFlag('is_bg_color', $event)" /></el-form-item>
    <el-form-item label="页面背景色"><el-input :model-value="modelValue.color_picker" maxlength="50" :disabled="!canEdit" @update:model-value="setColor" /><el-color-picker :model-value="modelValue.color_picker" :disabled="!canEdit" @update:model-value="setColor" /></el-form-item>
    <el-form-item label="使用背景图"><el-switch :model-value="modelValue.is_bg_pic" :active-value="1" :inactive-value="0" :disabled="!canEdit" @update:model-value="setFlag('is_bg_pic', $event)" /></el-form-item>
    <el-form-item label="背景图模式"><el-select :model-value="modelValue.bg_tab_val" :disabled="!canEdit" @update:model-value="setMode"><el-option label="单图" :value="0" /><el-option label="平铺" :value="1" /><el-option label="拉伸" :value="2" /></el-select></el-form-item>
    <el-form-item label="背景图地址"><el-input :model-value="modelValue.bg_pic" :disabled="!canEdit" @change="setImage" /></el-form-item>
    <div class="toolbar"><SeckillActivityImagePicker :key="mediaSession.key" :editor-key="mediaSession.key" :disabled="!canChooseMedia" title="选择页面背景图" @choose="mediaSession.choose" /><el-button :disabled="!canEdit || !pageId || !pagePublished || previewLoading" :loading="previewLoading" @click="loadPreview">读取已发布背景预览</el-button></div>
    <p class="hint">建议图片尺寸 690 × 240。图库预览仅用于当前编辑，保存使用稳定地址。</p>
    <div class="page-settings-preview" :style="previewStyle"><span>{{ modelValue.is_show === 1 ? pageTitle || '页面预览' : '页面暂未开放' }}</span></div>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getToken } from '@/utils/auth';
import SeckillActivityImagePicker from '@/pages/activity/SeckillActivityImagePicker.vue';
import { canonicalPresentationReference, presentationPreviewForReference } from '@/utils/diyPresentationEditor';
import { pageSettingsColor, pageSettingsFingerprint, pageSettingsPreviewStyle, pageSettingsReference, readDiyPageSettings, type DiyPageSettings } from '@/utils/diyPageSettingsEditor';
const props = withDefaults(defineProps<{modelValue: DiyPageSettings; editorKey: string; contextValue: string; pageTitle?: string; disabled?: boolean; pageId?: number; pagePublished?: boolean}>(), {disabled: false, pageId: 0, pagePublished: false, pageTitle: ''});
const emit = defineEmits<{'update:modelValue': [value: DiyPageSettings]}>(), auth = useAuthStore();
const error = ref(''), preview = ref(''), previewLoading = ref(false), revision = ref(0);
let alive = true, controller: AbortController | null = null;
const actor = () => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}:${getToken()}:${localStorage.getItem('admin_session')}`;
const canEdit = computed(() => !props.disabled && !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('dise.manage')));
const canChooseMedia = computed(() => canEdit.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('attachment.view')));
const stamp = () => JSON.stringify([actor(), props.editorKey, props.pageId, props.pageTitle, props.contextValue, props.modelValue, revision.value]);
const current = (issued: string) => alive && canEdit.value && issued === stamp();
const previewStyle = computed(() => canEdit.value ? pageSettingsPreviewStyle(props.modelValue, preview.value || (props.modelValue.bg_pic.startsWith('/api/assets/') ? '' : props.modelValue.bg_pic)) : {});
function invalidate() { revision.value++; controller?.abort(); controller = null; preview.value = ''; previewLoading.value = false; error.value = ''; }
watch(() => JSON.stringify([props.modelValue, props.contextValue, props.pageId, props.pageTitle, props.editorKey, props.pagePublished]), invalidate, {flush: 'sync'});
watch(() => props.disabled, value => { if (value) invalidate(); }, {flush: 'sync'});
watch(() => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}`, invalidate, {flush: 'sync'});
window.addEventListener('admin-session-changed', invalidate); window.addEventListener('admin-auth-expired', invalidate); window.addEventListener('storage', invalidate);
onBeforeUnmount(() => { alive = false; invalidate(); window.removeEventListener('admin-session-changed', invalidate); window.removeEventListener('admin-auth-expired', invalidate); window.removeEventListener('storage', invalidate); });
function commit(patch: Partial<DiyPageSettings>) {
  if (!alive || !canEdit.value) return null;
  const next = {...props.modelValue, ...patch}; invalidate(); emit('update:modelValue', next); return next;
}
function setFlag(key: 'is_show' | 'is_bg_color' | 'is_bg_pic', value: unknown) { if ((value === 0 || value === 1) && (key !== 'is_show' || props.pageId)) commit({[key]: value}); }
function setMode(value: unknown) { if (value === 0 || value === 1 || value === 2) commit({bg_tab_val: value}); }
function setColor(value: unknown) { if (typeof value !== 'string' || value.length > 50) return; commit({color_picker: value}); if (value !== '' && !pageSettingsColor(value)) error.value = '请输入有效背景色'; }
function setImage(value: unknown) { try { return commit({bg_pic: pageSettingsReference(value)}); } catch (reason) { error.value = reason instanceof Error ? reason.message : '图片地址无效'; return null; } }
const mediaSession = computed(() => {
  const issued = stamp(), identity = actor(), editor = props.editorKey, context = props.contextValue, id = props.pageId, title = props.pageTitle;
  return {key: `${props.editorKey}:${revision.value}`, choose: async (reference: string, signed: string) => {
    if (!current(issued) || !canChooseMedia.value) return;
    const approved = presentationPreviewForReference(reference, signed), next = setImage(reference);
    if (!next) return;
    await nextTick();
    if (alive && canChooseMedia.value && actor() === identity && props.editorKey === editor && props.pageId === id && props.pageTitle === title && props.contextValue === context && JSON.stringify(props.modelValue) === JSON.stringify(next) && canonicalPresentationReference(props.modelValue.bg_pic) === canonicalPresentationReference(reference)) preview.value = approved;
  }};
});
async function loadPreview() {
  if (!alive || !canEdit.value || !props.pageId || !props.pagePublished) return;
  controller?.abort(); preview.value = ''; const pending = new AbortController(), issued = stamp(), id = props.pageId; controller = pending; previewLoading.value = true; error.value = '';
  try {
    const response = await fetch(`/api/diy/get_diy/${id}`, {credentials: 'omit', cache: 'no-store', signal: pending.signal});
    const body = await response.json() as {status?: unknown; data?: Partial<DiyPageSettings>};
    if (!current(issued) || props.pageId !== id || !props.pagePublished || pending.signal.aborted) return;
    if (!response.ok || body.status !== 200 || !body.data || Array.isArray(body.data) || pageSettingsFingerprint(readDiyPageSettings(body.data)) !== pageSettingsFingerprint(props.modelValue)) throw Error('当前背景与已发布页面不一致，请保存后再读取');
    const approved = presentationPreviewForReference(props.modelValue.bg_pic, body.data.bg_pic);
    if (!approved) throw Error('背景图尚未获准公开预览，请检查素材');
    preview.value = approved;
  } catch (reason) { if (current(issued)) error.value = reason instanceof Error ? reason.message : '背景预览读取失败'; }
  finally { if (controller === pending) { controller = null; previewLoading.value = false; } }
}
</script>
<style scoped>
.page-settings-editor{display:grid;gap:12px;width:100%;padding:14px;box-sizing:border-box;border:1px solid var(--el-border-color);border-radius:8px}.page-settings-editor :deep(.el-input){flex:1;min-width:0}.toolbar{display:flex;flex-wrap:wrap;gap:10px}.hint{margin:0;color:var(--el-text-color-secondary);font-size:12px;line-height:1.7}.page-settings-preview{width:min(375px,100%);min-height:260px;box-sizing:border-box;border:1px solid #ddd;background-color:#f5f5f5;position:relative}.page-settings-preview span{display:inline-block;max-width:100%;overflow-wrap:anywhere;margin:12px;padding:4px 8px;background:#ffffffd9;color:#333;font-size:13px}
</style>
