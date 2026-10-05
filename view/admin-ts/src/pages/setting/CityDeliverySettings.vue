<template>
  <div class="city-delivery-settings">
    <header class="heading"><div><h2>同城配送设置</h2><p>维护自主配送、达达与 UU 的开关和凭据。保存配置不会发单或测试第三方连接。</p></div><el-button :disabled="!canView || controller.locked" @click="controller.reread()">读取当前版本并保留草稿</el-button></header>
    <el-alert v-if="!canView" title="没有同城配送设置查看权限" type="warning" :closable="false" />
    <template v-else>
      <el-alert v-if="!canManage" title="当前仅有查看权限，配送配置不可修改" type="info" :closable="false" />
      <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" />
      <el-alert v-if="state.notice" :title="state.notice" :type="state.success ? 'success' : 'warning'" :closable="false" />
      <el-alert v-if="state.recoveryError" :title="state.recoveryError" type="error" :closable="false" />
      <el-alert v-if="state.snapshot && !state.snapshot.editable" title="配置来源存在异常，写入已暂停，请先修复记录" type="error" :closable="false" />
      <el-alert v-if="state.snapshot && !state.snapshot.readiness.cipher_ready" title="安全保存条件尚未就绪，暂不能准备保存" type="warning" :closable="false" />
      <el-alert v-if="state.needsReread" title="本次未保存。请先读取当前版本，保留的替换动作需要重新输入新值" type="warning" :closable="false" />
      <section v-if="state.journal" class="prepared-card" aria-label="原准备恢复">
        <h3>{{ state.journal.phase === 'confirm-unknown' ? '原确认结果待核对' : '待确认的原准备' }}</h3>
        <p>{{ state.journal.phase === 'confirm-unknown' ? '确认已经发出，不能另起保存。刷新后仍可核对或主动原样确认同一准备。' : '准备仅保存到服务器，尚未由本页发送应用确认。刷新可继续核对；不会自动保存。' }}</p>
        <p v-if="state.intent">{{ state.intent.state === 'expired' ? '准备已过期，需核对原确认或回执结果' : '准备保留期限：' + expiry(state.intent.expires_at) }}</p>
        <ul><li v-for="key in CITY_DELIVERY_FLAG_KEYS" :key="key">{{ CITY_DELIVERY_FLAG_LABELS[key] }}：{{ state.journal.flags[key] ? '开启' : '关闭' }}</li><li v-for="key in CITY_DELIVERY_CREDENTIAL_KEYS" :key="key">{{ CITY_DELIVERY_LABELS[key] }}：{{ actionLabel(state.journal.actions[key]) }}</li></ul>
        <div class="buttons">
          <el-button :disabled="state.busy || state.loading || state.reading || state.asking || state.restoring" @click="controller.readIntent()">读取原准备</el-button>
          <el-button :disabled="state.busy || state.loading || state.reading || state.asking || state.restoring" @click="controller.readReceipt()">读取原请求回执</el-button>
          <el-button v-if="canManage" type="primary" :disabled="!controller.canConfirm" @click="controller.confirmPrepared()">{{ state.journal.phase === 'confirm-unknown' ? '原样重试确认' : '核对并确认应用' }}</el-button>
          <el-button v-if="canManage && state.journal.phase !== 'confirm-unknown'" :disabled="!controller.canAbandon" @click="controller.abandonUnconfirmed()">放弃未确认准备</el-button>
        </div>
        <p class="hint">替换内容不会下载到浏览器。未确认准备通常保留 30 分钟；本账号最多保留 5 个有效准备。明确放弃本页准备不会删除服务器记录。</p>
      </section>
      <section class="settings-card">
        <div class="flag-row"><strong>同城配送</strong><el-switch :model-value="state.draft.flags.city_delivery_status ?? 0" :active-value="1" :inactive-value="0" :disabled="controller.editorDisabled" aria-label="同城配送" @change="(value: unknown) => controller.setFlag('city_delivery_status', value)" /></div>
        <el-select v-if="state.draft.flags.city_delivery_status === null" :model-value="state.draft.flags.city_delivery_status" :disabled="controller.editorDisabled" placeholder="历史开关无效，请明确选择" aria-label="修复同城配送开关" @change="(value: unknown) => controller.setFlag('city_delivery_status', value)"><el-option label="关闭" :value="0" /><el-option label="开启" :value="1" /></el-select>
        <p class="hint">关闭后保留下层开关及凭据，之后可以继续开启；不会隐式清空配置。</p>
      </section>
      <section v-if="state.draft.flags.city_delivery_status === 1 || needsFlagRepair" class="settings-card modes">
        <p v-if="state.draft.flags.city_delivery_status !== 1" class="hint">下层开关有缺失或异常值，关闭总开关前仍需明确其保留值。</p>
        <div v-for="key in childFlags" :key="key" class="flag-row">
          <div><strong>{{ CITY_DELIVERY_FLAG_LABELS[key] }}</strong><p v-if="key === 'self_delivery_status'" class="hint">由商城自行安排配送。</p></div>
          <el-switch :model-value="state.draft.flags[key] ?? 0" :active-value="1" :inactive-value="0" :disabled="controller.editorDisabled" :aria-label="CITY_DELIVERY_FLAG_LABELS[key]" @change="(value: unknown) => controller.setFlag(key, value)" />
          <el-select v-if="state.draft.flags[key] === null" :model-value="state.draft.flags[key]" :disabled="controller.editorDisabled" placeholder="请明确选择" :aria-label="`修复${CITY_DELIVERY_FLAG_LABELS[key]}开关`" @change="(value: unknown) => controller.setFlag(key, value)"><el-option label="关闭" :value="0" /><el-option label="开启" :value="1" /></el-select>
        </div>
      </section>
      <div v-if="state.draft.flags.city_delivery_status === 1" class="providers">
        <section v-for="provider in providers" v-show="state.draft.flags[provider.flag] === 1" :key="provider.flag" class="settings-card provider-card">
          <h3>{{ provider.label }}凭据</h3><p class="hint">现有值仅显示配置状态。请选择保留、替换或明确清除。</p>
          <CityDeliveryCredentialField v-for="key in provider.keys" :key="key" :label="CITY_DELIVERY_LABELS[key]" :status-label="credentialStatus(key)" :action="state.draft.credentials[key].action" :value="state.draft.credentials[key].value" :limit="CITY_DELIVERY_CREDENTIAL_BYTE_LIMITS[key]" :disabled="controller.editorDisabled"
            @action="(value: CityDeliveryCredentialAction) => controller.setAction(key, value)" @value="(value: string) => controller.setValue(key, value)" />
        </section>
      </div>
      <section v-if="state.snapshot" class="settings-card" aria-label="部署条件">
        <h3>部署条件</h3><p class="hint">这些状态只检查部署配置是否就绪，不证明服务商已连通。部署凭据不在此页编辑。</p>
        <ul><li v-for="item in readinessLabels" :key="item.key">{{ item.label }}：{{ state.snapshot.readiness[item.key] ? '已配置' : '未就绪' }}</li></ul>
        <p class="hint">凭据来源为「部署兼容来源」时，保留动作继续沿用原来源；空的历史数据库值不会自动覆盖它。第三方发单、取消费用和回退能力需按各自链路核实。</p>
        <ul v-if="state.snapshot.issues.length" class="issues"><li v-for="(issue, index) in state.snapshot.issues" :key="index">{{ issueLabel(issue) }}</li></ul>
        <template v-for="key in CITY_DELIVERY_CREDENTIAL_KEYS" :key="key"><ul v-if="state.snapshot.credentials[key].issues.length" class="issues"><li v-for="(issue, index) in state.snapshot.credentials[key].issues" :key="index">{{ CITY_DELIVERY_LABELS[key] }}：{{ issueLabel(issue) }}</li></ul></template>
      </section>
      <section v-if="!state.journal" class="settings-card" aria-label="当前草稿摘要">
        <h3>本次草稿</h3><p class="hint">隐藏项的动作同样保留并参与准备。确认摘要只列字段及动作，不显示凭据。</p>
        <ul><li v-for="key in CITY_DELIVERY_CREDENTIAL_KEYS" :key="key">{{ CITY_DELIVERY_LABELS[key] }}：{{ actionLabel(state.draft.credentials[key].action) }}（{{ credentialStatus(key) }}）</li></ul>
        <el-button v-if="canManage" type="primary" :disabled="controller.editorDisabled || state.needsReread || !state.snapshot?.readiness.cipher_ready" :loading="state.busy" @click="controller.prepare()">准备保存并核对</el-button>
      </section>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { apiCityDeliverySettings, apiPrepareCityDelivery, apiCityDeliveryIntent, apiConfirmCityDelivery, apiCityDeliveryReceipt, CITY_DELIVERY_FLAG_KEYS, CITY_DELIVERY_CREDENTIAL_KEYS, CITY_DELIVERY_CREDENTIAL_BYTE_LIMITS, CITY_DELIVERY_LABELS, CITY_DELIVERY_FLAG_LABELS, type CityDeliveryCredentialKey, type CityDeliveryCredentialAction, type CityDeliveryFlagKey } from '@/api/cityDeliverySettings';
import { CityDeliverySettingsController } from './cityDeliverySettingsController';
import CityDeliveryCredentialField from '@/components/CityDeliveryCredentialField.vue';
const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('city_delivery_settings.view')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('city_delivery_settings.manage')));
const identity = computed(() => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}`);
const controller = new CityDeliverySettingsController(() => ({ id: auth.userInfo?.id ?? null, identity: identity.value, stored: localStorage.getItem('admin_session'), view: canView.value, manage: canManage.value }), {
  read: apiCityDeliverySettings, prepare: apiPrepareCityDelivery, intent: apiCityDeliveryIntent, confirm: apiConfirmCityDelivery, receipt: apiCityDeliveryReceipt, storage: sessionStorage, uuid: () => crypto.randomUUID(),
  ask: async message => { await ElMessageBox.confirm(message, '确认同城配送配置', { type: 'warning', confirmButtonText: '确认', cancelButtonText: '取消' }); },
});
const state = controller.state;
const childFlags: CityDeliveryFlagKey[] = ['self_delivery_status', 'dada_delivery_status', 'uu_delivery_status'];
const needsFlagRepair = computed(() => childFlags.some(key => state.draft.flags[key] === null));
const providers: { label: string; flag: CityDeliveryFlagKey; keys: CityDeliveryCredentialKey[] }[] = [{ label: '达达', flag: 'dada_delivery_status', keys: ['dada_app_key', 'dada_app_sercret', 'dada_source_id'] }, { label: 'UU', flag: 'uu_delivery_status', keys: ['uupt_appkey', 'uupt_app_id', 'uupt_open_id'] }];
const readinessLabels = [{ key: 'dada_client_id', label: '达达客户端标识' }, { key: 'dada_callback_token', label: '达达回调认证' }, { key: 'uu_callback_token', label: 'UU 回调认证' }, { key: 'uu_timestamp_unit', label: 'UU 请求时间单位' }] as const;
function credentialStatus(key: CityDeliveryCredentialKey) { const field = state.snapshot?.credentials[key]; if (!field) return '尚未读取'; return ({ encrypted: field.configured ? '已配置（后台加密配置）' : '加密配置异常', env: field.configured ? '已配置（部署兼容来源）' : '部署配置未就绪', cleared: '已明确清除', none: '未配置', invalid: '历史资料异常，需修复' })[field.source]; }
function actionLabel(action: CityDeliveryCredentialAction) { return ({ keep: '保留原配置', replace: '替换新值', clear: '明确清除' })[action]; }
function issueLabel(issue: string) { const labels: Record<string, string> = { city_delivery_missing: '部分配置尚未初始化，首次保存会明确建立配置', city_delivery_duplicate: '存在重复配置，需先修复', city_delivery_identity_invalid: '配置身份异常，需先修复', city_delivery_cipher_missing: '安全保存条件尚未就绪' }; return labels[issue] ?? `配置诊断：${issue}`; }
function expiry(seconds: number) { return new Date(seconds * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }
let alive = false, syncing = false;
function syncStored(event?: Event) { if (syncing || event instanceof StorageEvent && event.key !== null && !['admin_token', 'admin_session'].includes(event.key)) return; syncing = true; if (state.asking) ElMessageBox.close(); controller.invalidate(); const session = getAdminSession(); auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] }); syncing = false; void controller.activate(); }
watch(identity, () => { if (alive && !syncing) { if (state.asking) ElMessageBox.close(); void controller.activate(); } }, { flush: 'sync' });
onMounted(() => { alive = true; window.addEventListener('storage', syncStored); window.addEventListener('admin-session-changed', syncStored); window.addEventListener('admin-auth-expired', syncStored); syncStored(); });
onBeforeUnmount(() => { alive = false; controller.dispose(); window.removeEventListener('storage', syncStored); window.removeEventListener('admin-session-changed', syncStored); window.removeEventListener('admin-auth-expired', syncStored); });
</script>
<style scoped>
.city-delivery-settings{display:grid;gap:16px;min-width:0;max-width:1200px}.heading{display:flex;gap:16px;justify-content:space-between;align-items:center;flex-wrap:wrap}.heading h2{margin:0;font-size:20px}.heading p,.hint{color:var(--el-text-color-secondary);font-size:13px;line-height:1.7}.settings-card,.prepared-card{padding:20px;background:#fff;border:1px solid var(--el-border-color-lighter);border-radius:10px;min-width:0}.prepared-card{border-color:var(--el-color-warning-light-5);background:var(--el-color-warning-light-9)}h3{margin:0 0 12px;font-size:16px}.flag-row{display:flex;gap:16px;justify-content:space-between;align-items:center;flex-wrap:wrap}.flag-row+.flag-row{border-top:1px solid var(--el-border-color-lighter);margin-top:16px;padding-top:16px}.providers{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;min-width:0}.provider-card{display:grid;align-content:start;gap:12px}.hint{margin:6px 0}.buttons{display:flex;gap:10px;flex-wrap:wrap}.buttons .el-button+.el-button{margin-left:0}ul{padding-left:22px;font-size:13px;line-height:1.9;overflow-wrap:anywhere}.issues{color:#b54708}.city-delivery-settings :deep(.el-alert__content){min-width:0;overflow-wrap:anywhere}.city-delivery-settings :deep(.el-select){max-width:100%}@media(max-width:800px){.providers{grid-template-columns:minmax(0,1fr)}}@media(max-width:600px){.heading h2{font-size:18px}.settings-card,.prepared-card{padding:14px}.buttons .el-button{max-width:100%;white-space:normal;height:auto;min-height:32px}.flag-row{gap:10px}}
</style>
