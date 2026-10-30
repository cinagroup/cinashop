<template>
  <section v-for="actions in [controls]" :key="'wechat-base-surface'" class="wechat-base-author">
    <header><div><h2>公众号基础设置</h2><p>配置公众号开发者信息、服务器回调和关注分享。</p></div><button :disabled="!session.allowed.value || loading || busy" @click="actions.refresh">重新读取</button></header>
    <p v-if="!session.allowed.value" role="alert">当前账号没有公众号基础设置查看权限；本人待核对请求仍可读取或封存。</p>
    <p v-if="loading" role="status">正在读取公众号配置…</p><p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="journalError" role="alert" class="error">{{ journalError }}</p><p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <aside v-if="pendingRecords.length" class="pending" aria-label="待核对配置请求">
      <strong>有配置请求待核对，新的保存已暂停</strong><p>只保存了请求标识，未在浏览器持久保存密钥或原稿。响应丢失不能说明保存失败；不会自动重发密钥。</p>
      <div class="pending-list"><button v-for="row in pendingRows" :key="row.id" :aria-pressed="pendingId === row.id" :disabled="busy" @click="row.select">{{ row.id }}</button></div>
      <div class="actions"><button :disabled="!session.signedIn.value || busy" @click="actions.receipt">读取保存回执</button><button :disabled="!session.signedIn.value || busy" @click="actions.resolve">核对并封存未受理请求</button></div>
      <p>封存会禁止这个未受理标识今后保存。已经提交成功的请求只返回原结果，不会撤销配置。</p>
    </aside>
    <template v-if="snapshot && session.allowed.value">
      <p v-if="!manage" role="status" class="notice">当前账号仅可查看，保存和图库选择需要公众号基础设置管理权限。</p>
      <p v-if="!snapshot.runtime_ready" role="alert">当前环境尚未安装配置保存记录能力，暂不可保存。</p>
      <p v-for="issue in snapshot.issues" :key="issue.key + issue.message" role="alert" class="history-warning">{{ issue.message }}</p>
      <div class="authority"><strong>当前回调权威：{{ authorityLabel }}</strong><span>当前生效模式：{{ effectiveMode }}</span><span>{{ snapshot.callback.ready ? '回调配置已就绪' : '回调配置尚未就绪' }}</span>
        <p v-if="snapshot.callback.authority === 'deployment'">当前由部署绑定的 Token / EncodingAESKey 生效，继续采用安全模式。这里保存的数据库回调配置不会覆盖部署绑定。</p>
        <p v-else-if="snapshot.callback.authority === 'disabled'">尚未启用数据库回调权威，也没有有效部署绑定。保存普通设置不会自动启用回调。</p>
      </div>
      <form @submit.prevent="actions.save" @keydown.enter="actions.enter">
        <fieldset><legend>公众号开发者信息</legend>
          <label v-for="field in publicFields.filter(row => row.key === 'wechat_appid')" :key="field.key">{{ field.label }}<input :aria-label="field.label" :value="field.value ?? ''" :disabled="!editable" autocomplete="off" spellcheck="false" @input="field.change(($event.target as HTMLInputElement).value)" /></label>
          <div v-for="field in secretFields.filter(row => row.key === 'wechat_appsecret')" :key="field.key" class="secret-field"><label>{{ field.label }}处理方式<select :aria-label="field.label + '处理方式'" :value="field.action" :disabled="!editable" @change="field.intent(($event.target as HTMLSelectElement).value)"><option value="keep">保留原值</option><option value="replace">替换</option><option value="clear">明确清空</option></select></label><p>{{ field.state }}</p><label v-if="field.action === 'replace'">新{{ field.label }}<input :key="field.inputKey" type="password" :aria-label="'新' + field.label" :value="field.value" :disabled="!editable" autocomplete="new-password" spellcheck="false" @input="field.change(($event.target as HTMLInputElement).value)" /></label><p v-if="field.action === 'clear'" class="history-warning">确认保存后将清空数据库中的此项。</p></div>
        </fieldset>
        <fieldset><legend>服务器配置</legend>
          <div v-for="field in secretFields.filter(row => row.key !== 'wechat_appsecret')" :key="field.key" class="secret-field"><label>{{ field.label }}处理方式<select :aria-label="field.label + '处理方式'" :value="field.action" :disabled="!editable" @change="field.intent(($event.target as HTMLSelectElement).value)"><option value="keep">保留原值</option><option value="replace">替换</option><option value="clear">明确清空</option></select></label><p>{{ field.state }}</p><div class="actions"><button type="button" :disabled="!editable" @click="field.generate">随机生成新{{ field.label }}</button><button v-if="field.action === 'replace' && field.value" type="button" :disabled="!editable" @click="field.copy">复制新{{ field.label }}</button></div><label v-if="field.action === 'replace'">新{{ field.label }}<input :key="field.inputKey" type="password" :aria-label="'新' + field.label" :value="field.value" :disabled="!editable" autocomplete="new-password" spellcheck="false" @input="field.change(($event.target as HTMLInputElement).value)" /></label><p v-if="field.action === 'clear'" class="history-warning">确认保存后将清空数据库中的此项。</p></div>
          <label>接口地址<input aria-label="接口地址" :value="snapshot.api ?? ''" readonly /></label><button type="button" :disabled="!snapshot.api" @click="actions.copyApi">复制接口地址</button>
          <label>消息加解密方式<select v-for="field in publicFields.filter(row => row.key === 'wechat_encode')" :key="field.key" aria-label="消息加解密方式" :value="field.value ?? ''" :disabled="!editable" @change="field.change(($event.target as HTMLSelectElement).value)"><option value="" disabled>请选择有效模式</option><option value="0">明文模式</option><option value="1">兼容模式</option><option value="2">安全模式（推荐）</option></select></label>
          <label v-for="field in authorityFields" :key="field.key">数据库回调权威<select aria-label="数据库回调权威" :value="field.value ? '1' : '0'" :disabled="!editable" @change="field.change(($event.target as HTMLSelectElement).value)"><option value="0">不启用数据库回调</option><option value="1">明确启用数据库回调</option></select></label>
          <p>数据库回调仅在部署的 Token 和 EncodingAESKey 都未绑定时生效。兼容和安全模式必须填写有效 EncodingAESKey；兼容模式收到密文时会严格验证密文。</p>
        </fieldset>
        <fieldset><legend>微信公众号</legend>
          <label v-for="field in publicFields.filter(row => row.key === 'share_qrcode' || row.key === 'spread_share_forever' || row.key === 'create_wechat_user')" :key="field.key">{{ field.label }}<select :aria-label="field.label" :value="field.value ?? ''" :disabled="!editable" @change="field.change(($event.target as HTMLSelectElement).value)"><option value="" disabled>请选择有效设置</option><option v-for="option in field.options" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <label>公众号关注二维码<input aria-label="关注二维码引用" :value="draft.wechat_qrcode ?? ''" readonly /></label>
          <div class="qr-preview"><img v-if="imagePreview" :src="imagePreview" alt="当前公众号关注二维码" /><p v-else>没有可安全显示的图片。历史原引用仍保留，可重新选择。</p></div>
          <div class="actions"><button type="button" :disabled="!editable" @click="actions.gallery">从图库选择关注二维码</button><button type="button" :disabled="!editable" @click="actions.clearImage">清空关注二维码</button></div><p>建议尺寸：363 × 363 像素。保存稳定图片引用，预览签名不会写入配置。</p>
        </fieldset>
        <details v-if="snapshot.issues.length"><summary>查看原公开配置值</summary><dl><template v-for="key in WECHAT_BASE_PUBLIC_KEYS" :key="key"><dt>{{ key }}</dt><dd>{{ snapshot.raw_public_values[key] === null ? '未配置' : snapshot.raw_public_values[key] }}</dd></template></dl></details>
        <footer><p>密钥不会回显或写入本地记录；保留原值不会把空输入覆盖到已有密钥。保存不会向微信发布菜单或调用远端接口。</p><button type="button" class="primary" :disabled="!editable || !snapshot.runtime_ready" @click="actions.save">确认并保存配置</button></footer>
      </form>
    </template>
    <div v-for="panel in galleryViews" :key="panel.id" class="overlay" @click.self="panel.close"><section class="gallery-dialog" role="dialog" aria-modal="true" aria-label="选择公众号关注二维码"><header><h3>选择公众号关注二维码</h3><button @click="panel.close">关闭图库</button></header><div class="gallery-body"><div class="gallery-filter"><label>图片分类<select aria-label="图片分类" :value="panel.pid" :disabled="panel.loading" @change="panel.category(($event.target as HTMLSelectElement).value)"><option value="0">未分类</option><option v-for="category in panel.categories" :key="category.id" :value="category.id">{{ category.name }}</option></select></label><label>图片名称<input aria-label="图片名称" :value="panel.name" :disabled="panel.loading" @input="panel.nameInput(($event.target as HTMLInputElement).value)" @keydown.enter.prevent="panel.search" /></label><button :disabled="panel.loading" @click="panel.search">搜索图片</button></div><p v-if="panel.loading" role="status">正在读取图库…</p><p v-if="panel.error" role="alert">{{ panel.error }}</p><div class="image-grid"><button v-for="image in panel.images" :key="image.id" :disabled="panel.loading || panel.dirty" @click="image.choose"><img :src="image.preview" :alt="image.name" /><span :title="image.name">{{ image.name }}</span></button></div><p v-if="!panel.loading && !panel.images.length">当前分类没有可选的平台图片。</p></div><footer><p>共 {{ panel.count }} 张，第 {{ panel.page }} / {{ panel.pages }} 页</p><div class="actions"><button :disabled="panel.loading || panel.page <= 1" @click="panel.previous">图库上一页</button><button :disabled="panel.loading || panel.page >= panel.pages" @click="panel.next">图库下一页</button></div></footer></section></div>
  </section>
</template>
<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { apiWechatBase, apiSaveWechatBase, apiWechatBaseReceipt, apiResolveWechatBase, apiWechatBaseAttachmentCategories, apiWechatBaseAttachmentOptions,
  checkedWechatBaseReceipt, checkedWechatBaseCategories, checkedWechatBaseImages, type WechatBaseCategory, type WechatBaseImage } from '@/api/wechatBase';
import { WECHAT_BASE_PUBLIC_KEYS, WECHAT_BASE_SECRET_KEYS, parseWechatBaseSave, wechatBasePending, wechatBaseRequestId,
  type WechatBaseValues, type WechatBaseSave, type WechatBaseSnapshot, type WechatBaseSecretKey, type WechatBaseSecretIntent } from '../../../../common/wechatBase';
import { useWechatBaseSession } from '@/utils/wechatBaseSession';

type Draft = { [K in keyof WechatBaseValues]: WechatBaseValues[K] | null };
type Pending = ReturnType<typeof wechatBasePending>;
const emptyDraft = (): Draft => ({ wechat_appid: null, wechat_encode: null, share_qrcode: null, spread_share_forever: null, wechat_qrcode: null, create_wechat_user: null });
const emptySecrets = () => Object.fromEntries(WECHAT_BASE_SECRET_KEYS.map(key => [key, { action: 'keep' }])) as Record<WechatBaseSecretKey, WechatBaseSecretIntent>;
const auth = useAuthStore(), route = useRoute(), snapshot = ref<WechatBaseSnapshot | null>(null), draft = reactive(emptyDraft());
const secrets = reactive(emptySecrets()), secretEpoch = reactive<Record<WechatBaseSecretKey, number>>({ wechat_token: 0, wechat_encodingaeskey: 0, wechat_appsecret: 0 });
const loading = ref(false), busy = ref(false), error = ref(''), notice = ref(''), journalError = ref(''), generation = ref(0), editEpoch = ref(0), pendingEpoch = ref(0);
const pendingRecords = ref<Pending[]>([]), selectedPending = ref(''), imagePreview = ref('');
interface Gallery { id: number; page: number; pid: number; name: string; loading: boolean; dirty: boolean; error: string; categories: WechatBaseCategory[]; images: WechatBaseImage[]; count: number; request: number }
const gallery = ref<Gallery | null>(null); let gallerySerial = 0;
function clearSecrets() { for (const key of WECHAT_BASE_SECRET_KEYS) { secrets[key] = { action: 'keep' }; secretEpoch[key]++; } }
function closeGallery() { gallery.value = null; session.cancel('gallery'); generation.value++; editEpoch.value++; }
function discard() { generation.value++; editEpoch.value++; pendingEpoch.value++; snapshot.value = null; Object.assign(draft, emptyDraft()); clearSecrets(); gallery.value = null;
  loading.value = busy.value = false; error.value = notice.value = journalError.value = ''; pendingRecords.value = []; selectedPending.value = ''; imagePreview.value = ''; }
const session = useWechatBaseSession(() => route.fullPath, discard, activate);
const manage = computed(() => session.allowed.value && session.has('wechat_base.manage'));
const writable = () => manage.value && !!snapshot.value && !loading.value && !busy.value && !pendingRecords.value.length && !journalError.value;
const editable = computed(() => writable() && !gallery.value);
const pendingId = computed(() => pendingRecords.value.some(row => row.request_id === selectedPending.value) ? selectedPending.value : pendingRecords.value[0]?.request_id ?? '');
const authorityLabel = computed(() => snapshot.value?.callback.authority === 'deployment' ? '部署绑定' : snapshot.value?.callback.authority === 'database' ? '数据库配置' : '未启用');
const effectiveMode = computed(() => snapshot.value?.callback.mode === 0 ? '明文模式' : snapshot.value?.callback.mode === 1 ? '兼容模式' : snapshot.value?.callback.mode === 2 ? '安全模式' : '未就绪');
function message(reason: unknown) { const e = reason as { response?: { data?: { msg?: unknown } }; message?: unknown }; const msg = e?.response?.data?.msg;
  return typeof msg === 'string' && msg.trim() && msg.length <= 512 ? msg : typeof e?.message === 'string' && e.message.length <= 512 ? e.message : '公众号配置请求失败，请保留标识并稍后核对'; }
const prefix = () => `cinashop_wechat_base_pending_v1_${auth.userInfo?.id}_`;
const storageKey = (id: string) => prefix() + id;
function readPending(): Pending[] {
  const records: Pending[] = [], keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(prefix())) keys.push(key); }
  if (keys.length > 128) throw Error('本账号待核对请求超过容量，请保留记录并人工维护');
  for (const key of keys.sort()) { const raw = localStorage.getItem(key); if (!raw || raw.length > 512) throw Error('本账号待核对标识不完整，请保留记录');
    const row: unknown = JSON.parse(raw); if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('待核对标识格式无效');
    const r = row as Record<string, unknown>; if (Object.keys(r).length !== 3 || r.version !== 1 || r.actor_id !== auth.userInfo?.id || !wechatBaseRequestId(r.request_id) || key !== storageKey(r.request_id)) throw Error('待核对标识身份无效，请保留记录');
    records.push(r as Pending);
  } return records;
}
function restorePending() { try { pendingRecords.value = readPending(); selectedPending.value = pendingRecords.value[0]?.request_id ?? ''; journalError.value = ''; pendingEpoch.value++; } catch (reason) { journalError.value = message(reason); } }
async function activate() { restorePending(); if (session.allowed.value) await load(); }
async function load() {
  if (!session.allowed.value || busy.value) return; const request = session.begin('snapshot'); if (!request) return;
  generation.value++; editEpoch.value++; clearSecrets(); gallery.value = null; session.cancel('gallery'); loading.value = true; error.value = ''; snapshot.value = null;
  try { const result = await apiWechatBase(request.signal); if (!request.current() || !session.allowed.value) return;
    snapshot.value = result; Object.assign(draft, result.settings); databaseCallback.value = result.callback.database_enabled; imagePreview.value = result.asset_previews.wechat_qrcode;
  } catch (reason) { if (request.current()) error.value = message(reason); }
  finally { if (request.current()) loading.value = false; request.finish(); }
}
const databaseCallback = ref(false);
function fieldLease() { const lease = session.lease(), source = generation.value; return () => lease.current() && source === generation.value; }
function changed() { editEpoch.value++; error.value = notice.value = ''; }
const labels = { wechat_appid: 'AppID', wechat_encode: '消息加解密方式', share_qrcode: '公众号分享二维码', spread_share_forever: '推广海报有效期', create_wechat_user: '关注公众号是否生成用户', wechat_qrcode: '公众号关注二维码' };
const publicFields = computed(() => { const current = fieldLease(); return WECHAT_BASE_PUBLIC_KEYS.map(key => ({ key, label: labels[key], value: draft[key],
  options: key === 'share_qrcode' ? [{ value: 0, label: '商城链接' }, { value: 1, label: '关注公众号' }] : key === 'spread_share_forever' ? [{ value: 0, label: '30天' }, { value: 1, label: '永久' }] : [{ value: 1, label: '开启' }, { value: 0, label: '关闭' }],
  change: (value: string) => { if (!current() || !editable.value) return;
    if (key === 'wechat_appid') draft.wechat_appid = value;
    else if (key === 'wechat_qrcode') return;
    else if (key === 'wechat_encode') { if (!/^[012]$/u.test(value)) return; draft.wechat_encode = Number(value) as 0 | 1 | 2; }
    else { if (!/^[01]$/u.test(value)) return; draft[key] = Number(value) as 0 | 1; } changed(); },
})); });
const authorityFields = computed(() => { const current = fieldLease(); return [{ key: 'authority', value: databaseCallback.value, change: (value: string) => { if (current() && editable.value && /^[01]$/u.test(value)) { databaseCallback.value = value === '1'; changed(); } } }]; });
function randomText(length: number) { const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; let result = '';
  while (result.length < length) for (const byte of crypto.getRandomValues(new Uint8Array(64))) { if (byte < 248) result += alphabet[byte % 62]; if (result.length === length) break; } return result; }
function generated(key: WechatBaseSecretKey) { if (key === 'wechat_token') return randomText(32); const last = 'AEIMQUYcgkosw048'; return randomText(42) + last[crypto.getRandomValues(new Uint8Array(1))[0] % 16]; }
const secretFields = computed(() => { const current = fieldLease(); return WECHAT_BASE_SECRET_KEYS.map(key => {
  const intent = secrets[key], epoch = secretEpoch[key], label = key === 'wechat_appsecret' ? 'AppSecret' : key === 'wechat_token' ? 'Token' : 'EncodingAESKey';
  const valid = () => current() && epoch === secretEpoch[key] && editable.value;
  return { key, label, action: intent.action, value: intent.action === 'replace' ? intent.value : '', inputKey: `${generation.value}:${key}:${epoch}`,
    state: snapshot.value?.secrets[key].present ? snapshot.value.secrets[key].valid ? '原值已配置，不回显。' : '存在历史值，格式需要核对；保留不会自动修复。' : '尚未配置原值。',
    intent: (value: string) => { if (!valid() || !['keep', 'clear', 'replace'].includes(value)) return; secrets[key] = value === 'replace' ? { action: 'replace', value: '' } : { action: value as 'keep' | 'clear' }; secretEpoch[key]++; changed(); },
    change: (value: string) => { if (!valid() || secrets[key].action !== 'replace') return; secrets[key] = { action: 'replace', value }; changed(); },
    generate: () => { if (!valid() || key === 'wechat_appsecret') return;
      if (!window.confirm('生成新的' + label + '只替换本次草稿，确认保存后才生效。请同步核对微信后台配置。继续？') || !valid()) return;
      try { secrets[key] = { action: 'replace', value: generated(key) }; secretEpoch[key]++; changed(); } catch { error.value = '无法安全生成新值，请使用支持安全随机数的浏览器'; } },
    copy: async () => { if (!valid() || secrets[key].action !== 'replace') return; const value = (secrets[key] as { action: 'replace'; value: string }).value;
      try { await window.navigator.clipboard.writeText(value); if (valid()) notice.value = '新值已复制，请妥善保存并同步核对微信后台'; } catch { if (valid()) error.value = '复制失败，请检查浏览器剪贴板权限'; } },
  }; }); });
function persist(payload: WechatBaseSave): Pending {
  if (readPending().length) throw Error('本账号已有待核对请求，请先处理'); const actor = auth.userInfo!.id, row = wechatBasePending(payload, actor), key = storageKey(row.request_id), raw = JSON.stringify(row);
  if (localStorage.getItem(key) !== null) throw Error('请求标识已存在，请先核对');
  localStorage.setItem(key, raw); if (localStorage.getItem(key) !== raw) throw Error('无法持久保存请求标识，未发出保存');
  pendingRecords.value = readPending(); selectedPending.value = row.request_id; pendingEpoch.value++; return row;
}
async function terminal(raw: unknown, id: string, actor: number) {
  const receipt = checkedWechatBaseReceipt(raw, id, actor), key = storageKey(id), expected = JSON.stringify({ version: 1, actor_id: actor, request_id: id });
  if (localStorage.getItem(key) !== expected) throw Error('本地请求标识已变化，请保留核对');
  localStorage.removeItem(key); if (localStorage.getItem(key) !== null) throw Error('回执已确认，但无法清理本地标识，请保留核对');
  restorePending(); clearSecrets(); busy.value = false;
  notice.value = receipt.state === 'not_applied' ? '原请求已封存为未应用，请重新读取后编辑。' : receipt.cache_status === 'pending' ? '配置已保存，但部分缓存清理尚未完成，请稍后核对。' : '公众号配置已保存。';
  if (session.allowed.value) await load();
}
async function save(current: () => boolean) {
  if (!current() || !editable.value || !snapshot.value?.runtime_ready) return;
  let payload: WechatBaseSave; try { payload = parseWechatBaseSave({ request_id: crypto.randomUUID(), revision: snapshot.value.revision, settings: { ...draft }, secrets: JSON.parse(JSON.stringify(secrets)), database_callback: databaseCallback.value, confirmed: true }); }
  catch (reason) { error.value = message(reason); return; }
  if (!window.confirm('确认保存公众号基础设置？替换或清空的密钥可能影响登录、回调、分享和消息发送；部署回调绑定仍优先生效。') || !current() || !editable.value) return;
  try { persist(payload); } catch (reason) { error.value = message(reason); restorePending(); return; }
  generation.value++; editEpoch.value++; clearSecrets(); error.value = notice.value = ''; const request = session.begin('save'); if (!request) return; busy.value = true; const actor = auth.userInfo!.id;
  try { const result = await apiSaveWechatBase(payload, request.signal); if (request.current() && pendingId.value === payload.request_id) await terminal(result, payload.request_id, actor); }
  catch (reason) { if (request.current()) error.value = '保存结果尚未确认，请保留请求标识。' + message(reason); }
  finally { if (request.current()) busy.value = false; request.finish(); }
}
async function recover(id: string, seal: boolean, current: () => boolean) {
  if (!current() || busy.value || !id || pendingId.value !== id) return;
  if (seal && (!window.confirm('确认核对并封存未受理请求？缺失的原请求将被持久封存，禁止迟到保存；已提交成功的请求仅返回原结果，不会撤销配置。此操作不需要重新提交密钥。') || !current() || pendingId.value !== id)) return;
  try { if (!readPending().some(row => row.request_id === id)) throw Error('本地原请求标识已变化'); } catch (reason) { error.value = message(reason); return; }
  const request = session.begin('recovery'); if (!request) return; const actor = auth.userInfo!.id; busy.value = true; error.value = notice.value = '';
  try { const raw = await (seal ? apiResolveWechatBase(id, request.signal) : apiWechatBaseReceipt(id, request.signal)); if (request.current() && pendingId.value === id) await terminal(raw, id, actor); }
  catch (reason) { if (request.current()) error.value = '尚未确认原请求。' + message(reason) + ' 请保留标识；没有回执不代表未保存。'; }
  finally { if (request.current()) busy.value = false; request.finish(); }
}
async function galleryLoad(g: Gallery) {
  const lease = session.lease(), source = generation.value, n = ++g.request, query = { page: g.page, limit: 20, pid: g.pid, name: g.name }, request = session.begin('gallery'); if (!request) return;
  const valid = () => lease.current() && request.current() && gallery.value === g && generation.value === source && g.request === n && g.page === query.page && g.pid === query.pid && g.name === query.name && writable();
  g.loading = true; g.error = ''; g.images = []; g.dirty = false;
  try { const categories = checkedWechatBaseCategories(await apiWechatBaseAttachmentCategories(request.signal)); if (!valid()) return; const result = checkedWechatBaseImages(await apiWechatBaseAttachmentOptions(query, request.signal), query);
    if (valid()) { g.categories = categories; g.images = result.list; g.count = result.count; }
  } catch (reason) { if (valid()) g.error = message(reason); }
  finally { if (valid()) g.loading = false; request.finish(); }
}
const galleryViews = computed(() => { const g = gallery.value; if (!g) return []; const lease = session.lease(), source = generation.value, sequence = g.request, query = { name: g.name, pid: g.pid, page: g.page };
  const current = () => lease.current() && gallery.value === g && generation.value === source && writable();
  const ready = () => current() && sequence === g.request && !g.loading;
  return [{ ...g, pages: Math.max(1, Math.ceil(g.count / 20)), close: () => { if (current()) closeGallery(); },
    nameInput: (value: string) => { if (ready()) { g.name = value; g.dirty = true; g.error = ''; } },
    search: () => { if (!ready()) return; if ([...g.name].length > 80 || /[\u0000-\u001f\u007f]/u.test(g.name)) { g.error = '图片名称须为最多80个字符的有效文本'; return; } g.page = 1; void galleryLoad(g); },
    category: (value: string) => { if (!ready() || !/^(?:0|[1-9]\d*)$/u.test(value)) return; const id = Number(value); if (id && !g.categories.some(row => row.id === id)) return; g.pid = id; g.page = 1; void galleryLoad(g); },
    previous: () => { if (ready() && !g.dirty && g.page > 1) { g.page--; void galleryLoad(g); } }, next: () => { if (ready() && !g.dirty && g.page < Math.ceil(g.count / 20)) { g.page++; void galleryLoad(g); } },
    images: g.images.map(image => ({ id: image.att_id, preview: image.preview, name: image.real_name, choose: () => { if (!ready() || g.dirty || query.name !== g.name || query.pid !== g.pid || query.page !== g.page || !g.images.includes(image)) return;
      draft.wechat_qrcode = image.reference; imagePreview.value = image.preview; changed(); closeGallery(); } })),
  }]; });
const pendingRows = computed(() => { const lease = session.lease(), epoch = pendingEpoch.value; return pendingRecords.value.map(row => ({ id: row.request_id, select: () => { if (lease.current() && epoch === pendingEpoch.value && !busy.value) { selectedPending.value = row.request_id; pendingEpoch.value++; } } })); });
const controls = computed(() => { const base = fieldLease(), edit = editEpoch.value, epoch = pendingEpoch.value, id = pendingId.value;
  const current = () => base() && edit === editEpoch.value && epoch === pendingEpoch.value;
  return { refresh: () => { if (current() && session.allowed.value && !busy.value) { restorePending(); notice.value = ''; void load(); } }, save: () => { void save(current); },
    enter: (event: KeyboardEvent) => { const target = event.target as HTMLInputElement | null; if (target?.tagName === 'INPUT' && !target.readOnly && !target.disabled) { event.preventDefault(); void save(current); } },
    receipt: () => { void recover(id, false, current); }, resolve: () => { void recover(id, true, current); },
    copyApi: async () => { if (!current() || !snapshot.value?.api) return; try { await window.navigator.clipboard.writeText(snapshot.value.api); if (current()) notice.value = '接口地址已复制'; } catch { if (current()) error.value = '复制失败，请检查浏览器剪贴板权限'; } },
    gallery: () => { if (!current() || !editable.value) return; generation.value++; editEpoch.value++; const g: Gallery = { id: ++gallerySerial, page: 1, pid: 0, name: '', loading: false, dirty: false, error: '', categories: [], images: [], count: 0, request: 0 }; gallery.value = g; void galleryLoad(gallery.value); },
    clearImage: () => { if (current() && editable.value) { draft.wechat_qrcode = ''; imagePreview.value = ''; changed(); } },
  };
});
</script>
<style scoped>
.wechat-base-author{padding:20px;color:#303133;max-width:1200px;margin:auto}.wechat-base-author header,.actions{display:flex;gap:10px;align-items:center;justify-content:space-between}.wechat-base-author h2,.wechat-base-author h3{margin:0}.wechat-base-author p{line-height:1.6;overflow-wrap:anywhere}.wechat-base-author button{padding:9px 12px;border:1px solid #cdd4de;background:white;border-radius:5px;color:inherit;cursor:pointer}.wechat-base-author button:disabled{opacity:.55;cursor:not-allowed}.wechat-base-author button[aria-pressed=true]{border-color:#409eff;background:#edf6ff}.wechat-base-author form{display:grid;gap:20px;margin-top:18px}.wechat-base-author fieldset{border:1px solid #dfe4ec;border-radius:8px;min-width:0;padding:18px}.wechat-base-author legend{font-weight:600;padding:0 8px}.wechat-base-author label{display:grid;gap:8px;margin:14px 0;min-width:0}.wechat-base-author input,.wechat-base-author select{box-sizing:border-box;width:100%;min-width:0;padding:10px;border:1px solid #cdd4de;border-radius:4px;background:white;color:#303133;font:inherit}.wechat-base-author input[readonly]{background:#f4f6f8}.secret-field{border-bottom:1px solid #edf0f5;padding-bottom:10px}.notice,.pending,.authority{background:#f0f6ff;padding:14px;border-radius:6px;margin:14px 0}.authority span{display:inline-block;margin:0 12px 6px 0}.authority strong{display:block;margin-bottom:8px}.error,.history-warning{background:#fff3f1;color:#a83131;padding:10px}.actions{justify-content:flex-start;flex-wrap:wrap}.pending-list{display:grid;gap:6px;margin:12px 0}.pending-list button{overflow-wrap:anywhere;text-align:left}.qr-preview img{width:180px;height:180px;object-fit:contain;background:#f5f7fa}.wechat-base-author footer{border-top:1px solid #e4e8ee;padding-top:12px}.primary{background:#409eff!important;color:white!important}.wechat-base-author dd{margin:5px 0 12px;overflow-wrap:anywhere;white-space:pre-wrap}.overlay{position:fixed;inset:0;background:#0006;z-index:2100;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}.gallery-dialog{width:min(820px,100%);max-height:calc(100dvh - 32px);display:flex;flex-direction:column;background:white;border-radius:8px;overflow:hidden;box-sizing:border-box}.gallery-dialog>header,.gallery-dialog>footer{padding:14px;flex:none}.gallery-body{padding:0 14px 14px;overflow:auto;min-height:0}.gallery-filter{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}.gallery-filter label{flex:1;min-width:150px}.image-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.image-grid button{display:flex;flex-direction:column;gap:6px;min-width:0}.image-grid img{width:100%;height:105px;object-fit:contain}.image-grid span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.gallery-dialog footer p{margin:0 0 8px}@media(max-width:600px){.wechat-base-author{padding:10px}.wechat-base-author>header{align-items:flex-start;flex-direction:column}.wechat-base-author fieldset{padding:12px}.image-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.gallery-dialog>header{align-items:flex-start;gap:8px}.gallery-dialog h3{font-size:16px}.gallery-filter label{min-width:110px}.overlay{padding:12px}.gallery-dialog{max-height:calc(100dvh - 24px)}.wechat-base-author button{font-size:13px}.authority span{display:block}}
</style>
