<template>
  <section v-for="actions in [controls]" :key="'wechat-app-surface'" class="wechat-app-author">
    <header><div><h2>原生App微信配置</h2><p>配置移动应用的 AppID 与 AppSecret。</p></div><button :disabled="!session.allowed.value || loading || busy" @click="actions.refresh">重新读取</button></header>
    <p v-if="!session.allowed.value" role="alert">当前账号没有原生App配置查看权限；本人待核对请求仍可读取或封存。</p>
    <p v-if="loading" role="status">正在读取原生App配置…</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="journalError" role="alert" class="error">{{ journalError }}</p><p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <aside v-if="pendingRecords.length" class="pending" aria-label="待核对配置请求"><strong>有配置请求待核对，新的保存已暂停</strong><p>这里只保存请求标识。响应丢失不能说明保存失败；页面不会自动重发密钥。</p>
      <div class="pending-list"><button v-for="row in pendingRows" :key="row.id" :aria-pressed="pendingId === row.id" :disabled="busy" @click="row.select">{{ row.id }}</button></div>
      <div class="actions"><button :disabled="!session.signedIn.value || busy" @click="actions.receipt">读取保存回执</button><button :disabled="!session.signedIn.value || busy" @click="actions.resolve">核对并封存未受理请求</button></div><p>封存会禁止这个未受理标识今后保存。已经提交成功的请求只返回原结果，不会撤销配置。</p>
    </aside>
    <template v-if="snapshot && session.allowed.value">
      <p v-if="!manage" role="status" class="notice">当前账号仅可查看，保存需要原生App配置管理权限。</p>
      <p v-if="!snapshot.runtime_ready" role="alert">当前环境暂不支持保存，请联系管理员维护。</p>
      <p v-for="issue in snapshot.issues" :key="issue.key + issue.message" role="alert" class="history-warning">{{ issue.message }}</p>
      <p role="status">{{ snapshot.credentials_complete ? 'AppID 与 AppSecret 均已填写。' : 'AppID 或 AppSecret 尚未填写。' }}填写状态不代表微信登录或支付已验证可用。</p>
      <form @submit.prevent="actions.save"><fieldset><legend>移动应用</legend>
        <dl><dt>当前AppID</dt><dd>{{ snapshot.settings.wechat_app_appid === null ? '原值缺失或无法解析，可保留原值或明确替换。' : snapshot.settings.wechat_app_appid === '' ? '空值' : snapshot.settings.wechat_app_appid }}</dd></dl>
        <div v-for="field in appFields" :key="field.key" class="field"><label>AppID处理方式<select aria-label="AppID处理方式" :value="field.action" :disabled="!editable" @change="field.intent(($event.target as HTMLSelectElement).value)"><option value="keep">保留原值</option><option value="replace">替换</option></select></label>
          <label v-if="field.action === 'replace'">新AppID<textarea :key="field.inputKey" aria-label="新AppID" :value="field.value" :disabled="!editable" rows="2" autocomplete="off" spellcheck="false" @input="field.change(($event.target as HTMLTextAreaElement).value)" /></label><p v-if="field.action === 'replace'">替换内容按原样保存；留空将清空 AppID。</p></div>
        <div v-for="field in secretFields" :key="field.key" class="field"><label>AppSecret处理方式<select aria-label="AppSecret处理方式" :value="field.action" :disabled="!editable" @change="field.intent(($event.target as HTMLSelectElement).value)"><option value="keep">保留原值</option><option value="replace">替换</option><option value="clear">明确清空</option></select></label><p>{{ field.state }}</p>
          <label v-if="field.action === 'replace'">新AppSecret<textarea :key="field.inputKey" aria-label="新AppSecret" :value="field.value" :disabled="!editable" rows="3" autocomplete="new-password" spellcheck="false" @input="field.change(($event.target as HTMLTextAreaElement).value)" /></label><p v-if="field.action === 'clear'" class="history-warning">确认保存后将清空移动应用的 AppSecret。</p></div>
      </fieldset><footer><p>已存密钥不回显。本次填写仅保留在当前页面，发出保存后立即清除。保留原值不会用空输入覆盖配置。</p><button type="button" class="primary" :disabled="!editable || !snapshot.runtime_ready" @click="actions.save">确认并保存配置</button></footer></form>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { apiWechatApp, apiSaveWechatApp, apiWechatAppReceipt, apiResolveWechatApp, checkedWechatAppReceipt } from '@/api/wechatApp';
import { parseWechatAppSave, wechatAppPending, wechatAppRequestId, type WechatAppSave, type WechatAppSnapshot,
  type WechatAppTextIntent, type WechatAppSecretIntent } from '../../../../common/wechatApp';
import { useWechatAppSession } from '@/utils/wechatAppSession';
type Pending = ReturnType<typeof wechatAppPending>;
const auth = useAuthStore(), route = useRoute(), snapshot = ref<WechatAppSnapshot | null>(null);
const fields = reactive<{ wechat_app_appid: WechatAppTextIntent; wechat_app_appsecret: WechatAppSecretIntent }>({
  wechat_app_appid: { action: 'keep' }, wechat_app_appsecret: { action: 'keep' },
});
const appEpoch = ref(0), secretEpoch = ref(0), loading = ref(false), busy = ref(false);
const error = ref(''), notice = ref(''), journalError = ref(''), generation = ref(0), editEpoch = ref(0), pendingEpoch = ref(0);
const pendingRecords = ref<Pending[]>([]), selectedPending = ref('');
function clearDraft() { fields.wechat_app_appid = { action: 'keep' }; fields.wechat_app_appsecret = { action: 'keep' }; appEpoch.value++; secretEpoch.value++; }
function discard() {
  generation.value++; editEpoch.value++; pendingEpoch.value++; snapshot.value = null; clearDraft();
  loading.value = busy.value = false; error.value = notice.value = journalError.value = ''; pendingRecords.value = []; selectedPending.value = '';
}
const session = useWechatAppSession(() => route.fullPath, discard, activate);
const manage = computed(() => session.allowed.value && session.has('wechat_app.manage'));
const editable = computed(() => manage.value && !!snapshot.value && !loading.value && !busy.value && !pendingRecords.value.length && !journalError.value);
const pendingId = computed(() => pendingRecords.value.some(row => row.request_id === selectedPending.value) ? selectedPending.value : pendingRecords.value[0]?.request_id ?? '');
function message(reason: unknown) {
  const e = reason as { response?: { data?: { msg?: unknown } }; message?: unknown }, msg = e?.response?.data?.msg;
  return typeof msg === 'string' && msg.trim() && msg.length <= 512 ? msg
    : typeof e?.message === 'string' && e.message.length <= 512 ? e.message : '原生App配置请求失败，请保留标识并稍后核对';
}
const prefix = () => `cinashop_wechat_app_pending_v1_${auth.userInfo?.id}_`;
const storageKey = (id: string) => prefix() + id;
function readPending(): Pending[] {
  const records: Pending[] = [], keys: string[] = [];
  for (let index = 0; index < localStorage.length; index++) { const key = localStorage.key(index); if (key?.startsWith(prefix())) keys.push(key); }
  if (keys.length > 128) throw Error('本账号待核对请求超过容量，请保留记录并人工维护');
  for (const key of keys.sort()) {
    const raw = localStorage.getItem(key); if (!raw || raw.length > 512) throw Error('本账号待核对标识不完整，请保留记录');
    const row: unknown = JSON.parse(raw); if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('待核对标识格式无效');
    const value = row as Record<string, unknown>;
    if (Object.keys(value).length !== 4 || value.version !== 1 || value.domain !== 'wechat_app'
      || value.actor_id !== auth.userInfo?.id || !wechatAppRequestId(value.request_id) || key !== storageKey(value.request_id))
      throw Error('待核对标识身份无效，请保留记录');
    records.push(value as Pending);
  }
  return records;
}
function restorePending() {
  try { pendingRecords.value = readPending(); selectedPending.value = pendingRecords.value[0]?.request_id ?? ''; journalError.value = ''; pendingEpoch.value++; }
  catch (reason) { journalError.value = message(reason); }
}
async function activate() { restorePending(); if (session.allowed.value) await load(); }
async function load() {
  if (!session.allowed.value || busy.value) return;
  const request = session.begin('snapshot'); if (!request) return;
  generation.value++; editEpoch.value++; clearDraft(); loading.value = true; error.value = ''; snapshot.value = null;
  try { const result = await apiWechatApp(request.signal); if (request.current() && session.allowed.value) snapshot.value = result; }
  catch (reason) { if (request.current()) error.value = message(reason); }
  finally { if (request.current()) loading.value = false; request.finish(); }
}
function fieldLease() { const lease = session.lease(), source = generation.value; return () => lease.current() && source === generation.value; }
function changed() { editEpoch.value++; error.value = notice.value = ''; }
const appFields = computed(() => {
  const current = fieldLease(), epoch = appEpoch.value, intent = fields.wechat_app_appid;
  const valid = () => current() && epoch === appEpoch.value && editable.value;
  return [{ key: 'wechat_app_appid', action: intent.action, value: intent.action === 'replace' ? intent.value : '', inputKey: `${generation.value}:${epoch}`,
    intent: (value: string) => { if (!valid() || !['keep','replace'].includes(value)) return;
      fields.wechat_app_appid = value === 'replace' ? { action: 'replace', value: snapshot.value?.settings.wechat_app_appid ?? '' } : { action: 'keep' }; appEpoch.value++; changed(); },
    change: (value: string) => { if (valid() && fields.wechat_app_appid.action === 'replace') { fields.wechat_app_appid = { action: 'replace', value }; changed(); } },
  }];
});
const secretFields = computed(() => {
  const current = fieldLease(), epoch = secretEpoch.value, intent = fields.wechat_app_appsecret;
  const valid = () => current() && epoch === secretEpoch.value && editable.value;
  return [{ key: 'wechat_app_appsecret', action: intent.action, value: intent.action === 'replace' ? intent.value : '', inputKey: `${generation.value}:${epoch}`,
    state: !snapshot.value?.fields.wechat_app_appsecret.parseable ? '原值缺失或无法解析；保留不会自动修复。'
      : snapshot.value.secrets.wechat_app_appsecret.present ? '原值已填写，不回显。' : '原值为空。',
    intent: (value: string) => { if (!valid() || !['keep','replace','clear'].includes(value)) return;
      fields.wechat_app_appsecret = value === 'replace' ? { action: 'replace', value: '' } : { action: value as 'keep' | 'clear' }; secretEpoch.value++; changed(); },
    change: (value: string) => { if (valid() && fields.wechat_app_appsecret.action === 'replace') { fields.wechat_app_appsecret = { action: 'replace', value }; changed(); } },
  }];
});
function persist(payload: WechatAppSave): Pending {
  if (readPending().length) throw Error('本账号已有待核对请求，请先处理');
  const row = wechatAppPending(payload, auth.userInfo!.id), key = storageKey(row.request_id), raw = JSON.stringify(row);
  if (localStorage.getItem(key) !== null) throw Error('请求标识已存在，请先核对');
  localStorage.setItem(key, raw); if (localStorage.getItem(key) !== raw) throw Error('无法持久保存请求标识，未发出保存');
  pendingRecords.value = readPending(); selectedPending.value = row.request_id; pendingEpoch.value++; return row;
}
async function terminal(raw: unknown, id: string, actor: number) {
  const receipt = checkedWechatAppReceipt(raw, id, actor), key = storageKey(id);
  const expected = JSON.stringify({ version: 1, domain: 'wechat_app', actor_id: actor, request_id: id });
  if (localStorage.getItem(key) !== expected) throw Error('本地请求标识已变化，请保留核对');
  localStorage.removeItem(key); if (localStorage.getItem(key) !== null) throw Error('回执已确认，但无法清理本地标识，请保留核对');
  restorePending(); clearDraft(); busy.value = false;
  notice.value = receipt.state === 'not_applied' ? '原请求已封存为未应用，请重新读取后编辑。'
    : receipt.cache_status === 'pending' ? '配置已保存，但部分缓存清理尚未完成，请稍后核对。' : '原生App配置已保存。';
  if (session.allowed.value) await load();
}
async function save(current: () => boolean) {
  if (!current() || !editable.value || !snapshot.value?.runtime_ready) return;
  let payload: WechatAppSave;
  try { payload = parseWechatAppSave({ request_id: crypto.randomUUID(), revision: snapshot.value.revision,
    fields: JSON.parse(JSON.stringify(fields)), confirmed: true }); }
  catch (reason) { error.value = message(reason); return; }
  if (!window.confirm('确认保存原生App微信配置？替换或清空可能影响移动应用登录与支付。') || !current() || !editable.value) return;
  try { persist(payload); } catch (reason) { error.value = message(reason); restorePending(); return; }
  generation.value++; editEpoch.value++; clearDraft(); error.value = notice.value = '';
  const request = session.begin('save'); if (!request) return;
  busy.value = true; const actor = auth.userInfo!.id;
  try { const raw = await apiSaveWechatApp(payload, request.signal); if (request.current() && pendingId.value === payload.request_id) await terminal(raw, payload.request_id, actor); }
  catch (reason) { if (request.current()) error.value = '保存结果尚未确认，请保留请求标识。' + message(reason); }
  finally { if (request.current()) busy.value = false; request.finish(); }
}
async function recover(id: string, seal: boolean, current: () => boolean) {
  if (!current() || busy.value || !id || pendingId.value !== id) return;
  if (seal && (!window.confirm('确认核对并封存未受理请求？缺失的原请求将被持久封存，禁止迟到保存；已提交成功的请求仅返回原结果，不会撤销配置。此操作不需要重新提交密钥。') || !current() || pendingId.value !== id)) return;
  try { if (!readPending().some(row => row.request_id === id)) throw Error('本地原请求标识已变化'); }
  catch (reason) { error.value = message(reason); return; }
  const request = session.begin('recovery'); if (!request) return;
  const actor = auth.userInfo!.id; busy.value = true; error.value = notice.value = '';
  try { const raw = await (seal ? apiResolveWechatApp(id, request.signal) : apiWechatAppReceipt(id, request.signal)); if (request.current() && pendingId.value === id) await terminal(raw, id, actor); }
  catch (reason) { if (request.current()) error.value = '尚未确认原请求。' + message(reason) + ' 请保留标识；没有回执不代表未保存。'; }
  finally { if (request.current()) busy.value = false; request.finish(); }
}
const pendingRows = computed(() => {
  const lease = session.lease(), epoch = pendingEpoch.value;
  return pendingRecords.value.map(row => ({ id: row.request_id, select: () => {
    if (lease.current() && epoch === pendingEpoch.value && !busy.value) { selectedPending.value = row.request_id; pendingEpoch.value++; }
  } }));
});
const controls = computed(() => {
  const base = fieldLease(), edit = editEpoch.value, epoch = pendingEpoch.value, id = pendingId.value;
  const current = () => base() && edit === editEpoch.value && epoch === pendingEpoch.value;
  return { refresh: () => { if (current() && session.allowed.value && !busy.value) { restorePending(); notice.value = ''; void load(); } },
    save: () => { void save(current); }, receipt: () => { void recover(id, false, current); }, resolve: () => { void recover(id, true, current); } };
});
</script>
<style scoped>
.wechat-app-author{padding:20px;color:#303133;max-width:1000px;margin:auto}.wechat-app-author header,.actions{display:flex;gap:10px;align-items:center;justify-content:space-between}.wechat-app-author h2{margin:0}.wechat-app-author p{line-height:1.6;overflow-wrap:anywhere}.wechat-app-author button{padding:9px 12px;border:1px solid #cdd4de;background:white;border-radius:5px;color:inherit;cursor:pointer}.wechat-app-author button:disabled{opacity:.55;cursor:not-allowed}.wechat-app-author button[aria-pressed=true]{border-color:#409eff;background:#edf6ff}.wechat-app-author form{display:grid;gap:20px;margin-top:18px}.wechat-app-author fieldset{border:1px solid #dfe4ec;border-radius:8px;min-width:0;padding:18px}.wechat-app-author legend{font-weight:600;padding:0 8px}.wechat-app-author label{display:grid;gap:8px;margin:14px 0;min-width:0}.wechat-app-author textarea,.wechat-app-author select{box-sizing:border-box;width:100%;min-width:0;padding:10px;border:1px solid #cdd4de;border-radius:4px;background:white;color:#303133;font:inherit}.wechat-app-author textarea{resize:vertical}.field{border-bottom:1px solid #edf0f5;padding-bottom:10px}.notice,.pending{background:#f0f6ff;padding:14px;border-radius:6px;margin:14px 0}.error,.history-warning{background:#fff3f1;color:#a83131;padding:10px}.actions{justify-content:flex-start;flex-wrap:wrap}.pending-list{display:grid;gap:6px;margin:12px 0}.pending-list button{overflow-wrap:anywhere;text-align:left}.wechat-app-author footer{border-top:1px solid #e4e8ee;padding-top:12px}.primary{background:#409eff!important;color:white!important}.wechat-app-author dd{margin:5px 0 12px;overflow-wrap:anywhere;white-space:pre-wrap}@media(max-width:600px){.wechat-app-author{padding:10px}.wechat-app-author>header{align-items:flex-start;flex-direction:column}.wechat-app-author fieldset{padding:12px}}
</style>
