<template>
  <section v-for="actions in [controls]" :key="'wechat-open-surface'" class="wechat-open-author">
    <header><div><h2>微信开放平台</h2><p>配置商城与客服网页登录使用的网站应用。</p></div><button :disabled="!session.allowed.value || loading || busy" @click="actions.refresh">重新读取</button></header>
    <p v-if="!session.allowed.value" role="alert">当前账号没有微信开放平台查看权限；本人待核对请求仍可读取或封存。</p>
    <p v-if="loading" role="status">正在读取开放平台配置…</p><p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="journalError" role="alert" class="error">{{ journalError }}</p><p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <aside v-if="pendingRecords.length" class="pending" aria-label="待核对配置请求"><strong>有配置请求待核对，新的保存已暂停</strong><p>这里只保存请求标识，未在浏览器持久保存密钥或原稿。响应丢失不能说明保存失败；不会自动重发密钥。</p>
      <div class="pending-list"><button v-for="row in pendingRows" :key="row.id" :aria-pressed="pendingId === row.id" :disabled="busy" @click="row.select">{{ row.id }}</button></div>
      <div class="actions"><button :disabled="!session.signedIn.value || busy" @click="actions.receipt">读取保存回执</button><button :disabled="!session.signedIn.value || busy" @click="actions.resolve">核对并封存未受理请求</button></div><p>封存会禁止这个未受理标识今后保存。已经提交成功的请求只返回原结果，不会撤销配置。</p>
    </aside>
    <template v-if="snapshot && session.allowed.value">
      <p v-if="!manage" role="status" class="notice">当前账号仅可查看，保存需要微信开放平台管理权限。</p>
      <p v-if="!snapshot.runtime_ready" role="alert">当前环境尚未安装配置保存记录能力，暂不可保存。</p>
      <p v-for="issue in snapshot.issues" :key="issue.key + issue.message" role="alert" class="history-warning">{{ issue.message }}</p>
      <div class="authority"><strong>当前凭据来源：{{ authorityLabel }}</strong><span>{{ snapshot.credentials.ready ? '网页登录配置已就绪' : '网页登录配置尚未就绪' }}</span>
        <p v-if="snapshot.credentials.authority === 'deployment'">部署密钥优先生效。这里保存的数据库密钥不会覆盖部署绑定。切换AppID前，请先维护部署密钥，再明确启用完整的数据库凭据。</p>
        <p v-else-if="snapshot.credentials.authority === 'disabled'">数据库凭据尚未启用。仅保存两项设置不会自动启用网页登录。</p>
      </div>
      <form @submit.prevent="actions.save" @keydown.enter="actions.enter"><fieldset><legend>网站应用</legend>
        <label v-for="field in appFields" :key="field.key">网站应用AppID<input aria-label="网站应用AppID" :value="field.value ?? ''" :disabled="!editable || snapshot.credentials.deployment_secret_present" autocomplete="off" spellcheck="false" @input="field.change(($event.target as HTMLInputElement).value)" /></label>
        <div v-for="field in secretFields" :key="field.key" class="secret-field"><label>AppSecret处理方式<select aria-label="AppSecret处理方式" :value="field.action" :disabled="!editable" @change="field.intent(($event.target as HTMLSelectElement).value)"><option value="keep">保留原值</option><option value="replace">替换</option><option value="clear">明确清空</option></select></label><p>{{ field.state }}</p>
          <label v-if="field.action === 'replace'">新AppSecret<input :key="field.inputKey" type="password" aria-label="新AppSecret" :value="field.value" :disabled="!editable" autocomplete="new-password" spellcheck="false" @input="field.change(($event.target as HTMLInputElement).value)" /></label><p v-if="field.action === 'clear'" class="history-warning">确认保存后将清空数据库中的网站应用密钥。</p></div>
        <label v-for="field in authorityFields" :key="field.key">数据库凭据<select aria-label="数据库凭据" :value="field.value ? '1' : '0'" :disabled="!editable" @change="field.change(($event.target as HTMLSelectElement).value)"><option value="0">不启用数据库凭据</option><option value="1">明确启用数据库凭据</option></select></label>
        <p>数据库凭据仅在部署密钥未绑定时生效；启用前须填写完整有效的AppID和AppSecret。</p>
      </fieldset><details v-if="snapshot.issues.length"><summary>查看原公开配置值</summary><dl><dt>网站应用AppID</dt><dd>{{ snapshot.raw_public_values.wechat_open_app_id === null ? '未配置' : snapshot.raw_public_values.wechat_open_app_id }}</dd></dl></details>
        <footer><p>已存密钥不回显；保留原值不会把空输入覆盖到已有密钥。保存后，旧配置下尚未完成的登录需要重新扫码。</p><button type="button" class="primary" :disabled="!editable || !snapshot.runtime_ready" @click="actions.save">确认并保存配置</button></footer>
      </form>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { apiWechatOpen, apiSaveWechatOpen, apiWechatOpenReceipt, apiResolveWechatOpen, checkedWechatOpenReceipt } from '@/api/wechatOpen';
import { parseWechatOpenSave, wechatOpenPending, wechatOpenRequestId, type WechatOpenSave, type WechatOpenSnapshot, type WechatOpenSecretIntent } from '../../../../common/wechatOpen';
import { useWechatOpenSession } from '@/utils/wechatOpenSession';
type Pending = ReturnType<typeof wechatOpenPending>;
const emptyDraft = () => ({ wechat_open_app_id: null as string | null });
const auth = useAuthStore(), route = useRoute(), snapshot = ref<WechatOpenSnapshot | null>(null), draft = reactive(emptyDraft());
const secrets = reactive<{ wechat_open_app_secret: WechatOpenSecretIntent }>({ wechat_open_app_secret: { action: 'keep' } }), secretEpoch = ref(0);
const loading = ref(false), busy = ref(false), error = ref(''), notice = ref(''), journalError = ref(''), generation = ref(0), editEpoch = ref(0), pendingEpoch = ref(0);
const pendingRecords = ref<Pending[]>([]), selectedPending = ref(''), databaseCredentials = ref(false);
function clearSecrets() { secrets.wechat_open_app_secret = { action: 'keep' }; secretEpoch.value++; }
function discard() { generation.value++; editEpoch.value++; pendingEpoch.value++; snapshot.value = null; Object.assign(draft, emptyDraft()); clearSecrets(); databaseCredentials.value = false;
  loading.value = busy.value = false; error.value = notice.value = journalError.value = ''; pendingRecords.value = []; selectedPending.value = ''; }
const session = useWechatOpenSession(() => route.fullPath, discard, activate);
const manage = computed(() => session.allowed.value && session.has('wechat_open.manage'));
const editable = computed(() => manage.value && !!snapshot.value && !loading.value && !busy.value && !pendingRecords.value.length && !journalError.value);
const pendingId = computed(() => pendingRecords.value.some(row => row.request_id === selectedPending.value) ? selectedPending.value : pendingRecords.value[0]?.request_id ?? '');
const authorityLabel = computed(() => snapshot.value?.credentials.authority === 'deployment' ? '部署绑定' : snapshot.value?.credentials.authority === 'database' ? '数据库配置' : '未启用');
function message(reason: unknown) { const e = reason as { response?: { data?: { msg?: unknown } }; message?: unknown }; const msg = e?.response?.data?.msg;
  return typeof msg === 'string' && msg.trim() && msg.length <= 512 ? msg : typeof e?.message === 'string' && e.message.length <= 512 ? e.message : '开放平台配置请求失败，请保留标识并稍后核对'; }
const prefix = () => `cinashop_wechat_open_pending_v1_${auth.userInfo?.id}_`;
const storageKey = (id: string) => prefix() + id;
function readPending(): Pending[] {
  const records: Pending[] = [], keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(prefix())) keys.push(key); }
  if (keys.length > 128) throw Error('本账号待核对请求超过容量，请保留记录并人工维护');
  for (const key of keys.sort()) { const raw = localStorage.getItem(key); if (!raw || raw.length > 512) throw Error('本账号待核对标识不完整，请保留记录');
    const row: unknown = JSON.parse(raw); if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('待核对标识格式无效');
    const r = row as Record<string, unknown>; if (Object.keys(r).length !== 3 || r.version !== 1 || r.actor_id !== auth.userInfo?.id || !wechatOpenRequestId(r.request_id) || key !== storageKey(r.request_id)) throw Error('待核对标识身份无效，请保留记录');
    records.push(r as Pending);
  } return records;
}
function restorePending() { try { pendingRecords.value = readPending(); selectedPending.value = pendingRecords.value[0]?.request_id ?? ''; journalError.value = ''; pendingEpoch.value++; } catch (reason) { journalError.value = message(reason); } }
async function activate() { restorePending(); if (session.allowed.value) await load(); }
async function load() {
  if (!session.allowed.value || busy.value) return; const request = session.begin('snapshot'); if (!request) return;
  generation.value++; editEpoch.value++; clearSecrets(); loading.value = true; error.value = ''; snapshot.value = null;
  try { const result = await apiWechatOpen(request.signal); if (!request.current() || !session.allowed.value) return;
    snapshot.value = result; Object.assign(draft, result.settings); databaseCredentials.value = result.credentials.database_enabled;
  } catch (reason) { if (request.current()) error.value = message(reason); }
  finally { if (request.current()) loading.value = false; request.finish(); }
}
function fieldLease() { const lease = session.lease(), source = generation.value; return () => lease.current() && source === generation.value; }
function changed() { editEpoch.value++; error.value = notice.value = ''; }
const appFields = computed(() => { const current = fieldLease(); return [{ key: 'appId', value: draft.wechat_open_app_id,
  change: (value: string) => { if (!current() || !editable.value || snapshot.value?.credentials.deployment_secret_present) return; draft.wechat_open_app_id = value; changed(); } }]; });
const authorityFields = computed(() => { const current = fieldLease(); return [{ key: 'authority', value: databaseCredentials.value,
  change: (value: string) => { if (current() && editable.value && /^[01]$/u.test(value)) { databaseCredentials.value = value === '1'; changed(); } } }]; });
const secretFields = computed(() => { const current = fieldLease(), epoch = secretEpoch.value, intent = secrets.wechat_open_app_secret;
  const valid = () => current() && epoch === secretEpoch.value && editable.value;
  return [{ key: 'wechat_open_app_secret', action: intent.action, value: intent.action === 'replace' ? intent.value : '', inputKey: `${generation.value}:${epoch}`,
    state: snapshot.value?.secrets.wechat_open_app_secret.present ? snapshot.value.secrets.wechat_open_app_secret.valid ? '原值已配置，不回显。' : '存在历史值，格式需要核对；保留不会自动修复。' : '尚未配置原值。',
    intent: (value: string) => { if (!valid() || !['keep','clear','replace'].includes(value)) return; secrets.wechat_open_app_secret = value === 'replace' ? { action: 'replace', value: '' } : { action: value as 'keep' | 'clear' }; secretEpoch.value++; changed(); },
    change: (value: string) => { if (!valid() || secrets.wechat_open_app_secret.action !== 'replace') return; secrets.wechat_open_app_secret = { action: 'replace', value }; changed(); } }]; });
function persist(payload: WechatOpenSave): Pending {
  if (readPending().length) throw Error('本账号已有待核对请求，请先处理'); const actor = auth.userInfo!.id, row = wechatOpenPending(payload, actor), key = storageKey(row.request_id), raw = JSON.stringify(row);
  if (localStorage.getItem(key) !== null) throw Error('请求标识已存在，请先核对');
  localStorage.setItem(key, raw); if (localStorage.getItem(key) !== raw) throw Error('无法持久保存请求标识，未发出保存');
  pendingRecords.value = readPending(); selectedPending.value = row.request_id; pendingEpoch.value++; return row;
}
async function terminal(raw: unknown, id: string, actor: number) {
  const receipt = checkedWechatOpenReceipt(raw, id, actor), key = storageKey(id), expected = JSON.stringify({ version: 1, actor_id: actor, request_id: id });
  if (localStorage.getItem(key) !== expected) throw Error('本地请求标识已变化，请保留核对');
  localStorage.removeItem(key); if (localStorage.getItem(key) !== null) throw Error('回执已确认，但无法清理本地标识，请保留核对');
  restorePending(); clearSecrets(); busy.value = false;
  notice.value = receipt.state === 'not_applied' ? '原请求已封存为未应用，请重新读取后编辑。' : receipt.cache_status === 'pending' ? '配置已保存，但部分缓存清理尚未完成，请稍后核对。' : '开放平台配置已保存。';
  if (session.allowed.value) await load();
}
async function save(current: () => boolean) {
  if (!current() || !editable.value || !snapshot.value?.runtime_ready) return;
  if (databaseCredentials.value && draft.wechat_open_app_id !== snapshot.value.settings.wechat_open_app_id && secrets.wechat_open_app_secret.action !== 'replace') { error.value = '切换启用中的网站应用AppID时，请明确替换新应用的AppSecret'; return; }
  let payload: WechatOpenSave; try { payload = parseWechatOpenSave({ request_id: crypto.randomUUID(), revision: snapshot.value.revision, settings: { ...draft }, secrets: JSON.parse(JSON.stringify(secrets)), database_credentials: databaseCredentials.value, confirmed: true }); }
  catch (reason) { error.value = message(reason); return; }
  if (!window.confirm('确认保存微信开放平台配置？替换或清空凭据可能影响商城和客服网页登录；部署密钥仍优先生效。') || !current() || !editable.value) return;
  try { persist(payload); } catch (reason) { error.value = message(reason); restorePending(); return; }
  generation.value++; editEpoch.value++; clearSecrets(); error.value = notice.value = ''; const request = session.begin('save'); if (!request) return; busy.value = true; const actor = auth.userInfo!.id;
  try { const result = await apiSaveWechatOpen(payload, request.signal); if (request.current() && pendingId.value === payload.request_id) await terminal(result, payload.request_id, actor); }
  catch (reason) { if (request.current()) error.value = '保存结果尚未确认，请保留请求标识。' + message(reason); }
  finally { if (request.current()) busy.value = false; request.finish(); }
}
async function recover(id: string, seal: boolean, current: () => boolean) {
  if (!current() || busy.value || !id || pendingId.value !== id) return;
  if (seal && (!window.confirm('确认核对并封存未受理请求？缺失的原请求将被持久封存，禁止迟到保存；已提交成功的请求仅返回原结果，不会撤销配置。此操作不需要重新提交密钥。') || !current() || pendingId.value !== id)) return;
  try { if (!readPending().some(row => row.request_id === id)) throw Error('本地原请求标识已变化'); } catch (reason) { error.value = message(reason); return; }
  const request = session.begin('recovery'); if (!request) return; const actor = auth.userInfo!.id; busy.value = true; error.value = notice.value = '';
  try { const raw = await (seal ? apiResolveWechatOpen(id, request.signal) : apiWechatOpenReceipt(id, request.signal)); if (request.current() && pendingId.value === id) await terminal(raw, id, actor); }
  catch (reason) { if (request.current()) error.value = '尚未确认原请求。' + message(reason) + ' 请保留标识；没有回执不代表未保存。'; }
  finally { if (request.current()) busy.value = false; request.finish(); }
}
const pendingRows = computed(() => { const lease = session.lease(), epoch = pendingEpoch.value; return pendingRecords.value.map(row => ({ id: row.request_id, select: () => { if (lease.current() && epoch === pendingEpoch.value && !busy.value) { selectedPending.value = row.request_id; pendingEpoch.value++; } } })); });
const controls = computed(() => { const base = fieldLease(), edit = editEpoch.value, epoch = pendingEpoch.value, id = pendingId.value;
  const current = () => base() && edit === editEpoch.value && epoch === pendingEpoch.value;
  return { refresh: () => { if (current() && session.allowed.value && !busy.value) { restorePending(); notice.value = ''; void load(); } }, save: () => { void save(current); },
    enter: (event: KeyboardEvent) => { const target = event.target as HTMLInputElement | null; if (target?.tagName === 'INPUT' && !target.readOnly && !target.disabled) { event.preventDefault(); void save(current); } },
    receipt: () => { void recover(id, false, current); }, resolve: () => { void recover(id, true, current); } };
});
</script>
<style scoped>
.wechat-open-author{padding:20px;color:#303133;max-width:1200px;margin:auto}.wechat-open-author header,.actions{display:flex;gap:10px;align-items:center;justify-content:space-between}.wechat-open-author h2,.wechat-open-author h3{margin:0}.wechat-open-author p{line-height:1.6;overflow-wrap:anywhere}.wechat-open-author button{padding:9px 12px;border:1px solid #cdd4de;background:white;border-radius:5px;color:inherit;cursor:pointer}.wechat-open-author button:disabled{opacity:.55;cursor:not-allowed}.wechat-open-author button[aria-pressed=true]{border-color:#409eff;background:#edf6ff}.wechat-open-author form{display:grid;gap:20px;margin-top:18px}.wechat-open-author fieldset{border:1px solid #dfe4ec;border-radius:8px;min-width:0;padding:18px}.wechat-open-author legend{font-weight:600;padding:0 8px}.wechat-open-author label{display:grid;gap:8px;margin:14px 0;min-width:0}.wechat-open-author input,.wechat-open-author select{box-sizing:border-box;width:100%;min-width:0;padding:10px;border:1px solid #cdd4de;border-radius:4px;background:white;color:#303133;font:inherit}.wechat-open-author input[readonly]{background:#f4f6f8}.secret-field{border-bottom:1px solid #edf0f5;padding-bottom:10px}.notice,.pending,.authority{background:#f0f6ff;padding:14px;border-radius:6px;margin:14px 0}.authority span{display:inline-block;margin:0 12px 6px 0}.authority strong{display:block;margin-bottom:8px}.error,.history-warning{background:#fff3f1;color:#a83131;padding:10px}.actions{justify-content:flex-start;flex-wrap:wrap}.pending-list{display:grid;gap:6px;margin:12px 0}.pending-list button{overflow-wrap:anywhere;text-align:left}.qr-preview img{width:180px;height:180px;object-fit:contain;background:#f5f7fa}.wechat-open-author footer{border-top:1px solid #e4e8ee;padding-top:12px}.primary{background:#409eff!important;color:white!important}.wechat-open-author dd{margin:5px 0 12px;overflow-wrap:anywhere;white-space:pre-wrap}@media(max-width:600px){.wechat-open-author{padding:10px}.wechat-open-author>header{align-items:flex-start;flex-direction:column}.wechat-open-author fieldset{padding:12px}.authority span{display:block}}
</style>
