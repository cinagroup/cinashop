<template>
  <div class="theme-settings">
    <div class="heading"><div><h2>主题风格</h2><p>选择商城全局预设。品牌、价格、按钮、选中项与渐变按各自颜色显示。</p></div><el-button :disabled="!canView || controller.locked" @click="controller.reread()">读取当前版本并保留选择</el-button></div>
    <el-alert v-if="!canView" title="没有主题设置查看权限" type="warning" :closable="false" />
    <template v-else>
      <el-alert v-if="!canManage" title="当前仅有查看权限，主题不可修改" type="info" :closable="false" />
      <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" />
      <el-alert v-if="state.notice" :title="state.notice" :type="state.success ? 'success' : 'warning'" :closable="false" />
      <el-alert v-if="state.recoveryError" :title="state.recoveryError" type="error" :closable="false" />
      <el-alert v-if="state.pending" title="原请求结果尚未确认，已锁定编辑与新的提交" type="warning" :closable="false" show-icon>
        <p>刷新页面会保留本账号的原请求。请先核对回执；服务端明确未找到回执后，可主动原样重试。</p>
        <div class="buttons"><el-button :disabled="state.readingReceipt || state.busy || state.confirming || state.restoring" :loading="state.readingReceipt" @click="controller.readReceipt()">读取原请求回执</el-button><el-button v-if="state.retryReady" :disabled="!canManage || state.readingReceipt || state.busy || state.confirming || state.restoring" @click="controller.retryOriginal()">原样重试</el-button></div>
      </el-alert>
      <el-alert v-if="state.snapshot && !state.snapshot.configured" title="当前没有有效的已保存主题。预览默认采用热情红；首次确认保存会建立配置，读取不会创建记录。" type="info" :closable="false" />
      <el-alert v-if="state.snapshot && !state.snapshot.editable" title="主题记录异常，所有写入已暂停，请先修复数据。" type="error" :closable="false" />
      <el-alert v-if="state.needsReread" title="本次未保存，原选择已保留。请读取当前版本并核对，再确认保存。" type="warning" :closable="false" />
      <ul v-if="state.snapshot?.issues.length" class="diagnostics"><li v-for="issue in state.snapshot.issues" :key="issue">{{ themeIssueLabel(issue) }}</li></ul>
      <el-radio-group :model-value="state.status" :disabled="controller.editorDisabled" aria-label="主题风格" class="presets" @change="(value: unknown) => controller.select(value)">
        <article v-for="preset in THEME_PRESETS" :key="preset.status" class="preset" :class="{chosen:state.status === preset.status}">
          <el-radio :value="preset.status" :disabled="controller.editorDisabled">{{ preset.name }}</el-radio>
          <ThemePreview :status="preset.status" />
        </article>
      </el-radio-group>
      <p class="hint">预览包含首页、商品规格、购物车、优惠券、结算与会员中心。DIY 选择「自定义色」的模块保持原配置，收入支出、错误和退款状态色保持其业务含义。</p>
      <el-button v-if="canManage" type="primary" :disabled="controller.editorDisabled || state.needsReread" :loading="state.busy" @click="controller.save()">保存主题风格</el-button>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { apiThemeSettings, apiSaveThemeSettings, apiThemeReceipt } from '@/api/themeSettings';
import { THEME_PRESETS, themeIssueLabel } from '../../../../common/theme';
import { ThemeSettingsController } from './themeSettingsController';
import ThemePreview from './ThemePreview.vue';
const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('theme_settings.view')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('theme_settings.manage')));
const identity = computed(() => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}`);
const controller = new ThemeSettingsController(() => ({ id: auth.userInfo?.id ?? null, identity: identity.value, stored: localStorage.getItem('admin_session'), view: canView.value, manage: canManage.value }), {
  read: apiThemeSettings, write: apiSaveThemeSettings, receipt: apiThemeReceipt, storage: sessionStorage, uuid: () => crypto.randomUUID(),
  confirm: async message => { await ElMessageBox.confirm(message, '确认保存主题', { type: 'warning', confirmButtonText: '确认提交', cancelButtonText: '取消' }); },
});
const state = controller.state; let alive = false, syncing = false;
function syncStored(event?: Event) { if (syncing || event instanceof StorageEvent && event.key !== null && !['admin_token', 'admin_session'].includes(event.key)) return; syncing = true; if (state.confirming) ElMessageBox.close(); controller.invalidate(); const session = getAdminSession(); auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] }); syncing = false; void controller.activate(); }
watch(identity, () => { if (alive && !syncing) { if (state.confirming) ElMessageBox.close(); void controller.activate(); } }, { flush: 'sync' });
onMounted(() => { alive = true; window.addEventListener('storage', syncStored); window.addEventListener('admin-session-changed', syncStored); window.addEventListener('admin-auth-expired', syncStored); syncStored(); });
onBeforeUnmount(() => { alive = false; controller.dispose(); window.removeEventListener('storage', syncStored); window.removeEventListener('admin-session-changed', syncStored); window.removeEventListener('admin-auth-expired', syncStored); });
</script>
<style scoped>
.theme-settings{display:grid;gap:16px;min-width:0}.heading{display:flex;gap:16px;justify-content:space-between;align-items:center;flex-wrap:wrap}.heading h2{font-size:20px;margin:0}.heading p,.hint{font-size:13px;color:var(--el-text-color-secondary);line-height:1.7}.presets{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;width:100%;align-items:start}.preset{min-width:0;padding:12px;border:2px solid transparent;border-radius:10px;background:#fff}.preset.chosen{border-color:var(--el-color-primary)}.preset .el-radio{height:32px;margin:0 0 10px}.buttons{display:flex;gap:10px;flex-wrap:wrap}.buttons .el-button+.el-button{margin-left:0}.diagnostics{font-size:13px;line-height:1.7}.theme-settings :deep(.el-alert__content){overflow-wrap:anywhere;min-width:0}@media(max-width:1100px){.presets{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:600px){.presets{grid-template-columns:minmax(0,1fr);gap:12px}.preset{padding:10px}.heading h2{font-size:18px}}
</style>
