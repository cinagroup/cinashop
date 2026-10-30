<template>
  <section v-for="actions in [controls]" :key="'wechat-menu-surface'" class="wechat-menu-author">
    <header><div><h2>公众号自定义菜单</h2><p>设置公众号底部菜单。最多3个一级菜单，每个最多5个子菜单。</p></div><button :disabled="loading || busy" @click="actions.refresh">重新读取</button></header>
    <p v-if="!session.allowed.value" role="alert">当前账号没有公众号菜单查看权限。</p>
    <p v-if="loading" role="status">正在读取完整菜单…</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <template v-if="snapshot && session.allowed.value">
      <p>当前公众号：<strong>{{ snapshot.app_id || '未配置' }}</strong></p>
      <p v-if="!manage" class="notice">当前账号仅可查看，发布需要公众号菜单管理权限。</p>
      <p v-if="!snapshot.runtime_ready" role="alert">此环境尚未安装菜单发布记录能力，暂不可发布。</p>
      <p v-if="!snapshot.configured" role="alert">请先配置公众号 AppID 和 AppSecret；小程序菜单还需要账号认证及微信侧关联。</p>
      <p v-if="snapshot.expired" role="alert">这份历史文档已过期，仍完整显示原内容，请核对后再发布。</p>
      <div v-if="snapshot.issues.length" class="history-warning"><p v-for="issue in snapshot.issues" :key="issue" role="alert">{{ issue }}</p><details><summary>查看完整历史原文</summary><pre>{{ snapshot.raw }}</pre></details><button :disabled="!manage || busy || !!pendingId" @click="actions.replaceHistory">核对后整体重建</button><p v-if="replaceHistory">已选择整体替换。原文会随发布操作保留，最终发布仍需确认。</p></div>
      <aside v-if="pendingId" class="pending" aria-label="待核对的发布">
        <strong>有发布操作待核对，新发布已暂停</strong><p class="break">操作标识：{{ pendingId }}</p><p>响应丢失不表示发布失败。保留原标识，先读取发布记录或核对微信线上菜单。</p>
        <div class="actions"><button :disabled="!manage || busy" @click="actions.receipt">读取发布记录</button><button :disabled="!manage || busy" @click="actions.observe">读取微信线上菜单</button><button v-if="localPending" :disabled="!manage || busy" @click="actions.retry">原样继续或核对原请求</button><button v-if="localPending" :disabled="!manage || busy" @click="actions.resolveMissing">核对并封存未受理请求</button></div><p v-if="localPending">若请求尚未受理，可明确封存原标识，避免迟到请求再发布；已经受理的未知请求不能取消，仍须保留核对。</p>
      </aside>
      <div v-if="observation" class="observation"><p>{{ observation.observed ? observation.matches ? '微信当前默认菜单与原发布内容匹配。此观察不能证明是哪次请求完成的发布。' : '微信当前菜单与原发布内容不同，请在微信后台人工核对。' : '微信未返回可核对的菜单，请检查账号权限。' }}</p><details v-if="observation.observed"><summary>查看完整线上菜单</summary><pre>{{ JSON.stringify(observation.remote_button, null, 2) }}</pre></details><button v-if="observation.matches && pendingId" :disabled="!manage || busy" @click="actions.confirmObservation">人工确认线上匹配并保存本地</button><p v-if="observation.matches">原请求开始至少30秒后，确认已在安全节点完成核对，再封存为“人工核对匹配”。系统会再次读取线上内容，此操作不会重发菜单。</p></div>
      <div v-if="snapshot.menus !== null || replaceHistory" class="editor-layout">
        <div class="menu-tree"><h3>菜单结构</h3><ol><li v-for="row in rows" :key="row.index"><div class="menu-row"><button :aria-pressed="selected === row.item" @click="row.select">{{ row.item.name || '未命名一级菜单' }}</button><button :disabled="!editable" @click="row.remove">删除</button></div><ol><li v-for="child in row.children" :key="child.index"><div class="menu-row"><button :aria-pressed="selected === child.item" @click="child.select">{{ child.item.name || '未命名子菜单' }}</button><button :disabled="!editable" @click="child.remove">删除</button></div></li></ol><button :disabled="!editable || row.children.length >= 5" @click="row.addChild">添加子菜单</button></li></ol><button :disabled="!editable || draft.length >= 3" @click="actions.addRoot">添加一级菜单</button></div>
        <div class="menu-fields"><h3>菜单内容</h3><p v-if="!selected">选择左侧菜单，或添加新菜单。</p><template v-else><label v-for="field in editorFields" :key="field.key">{{ field.label }}<select v-if="field.key === 'type'" :value="field.value" :disabled="!editable" @change="field.change(($event.target as HTMLSelectElement).value)"><option value="click">点击关键词</option><option value="view">打开网页</option><option value="miniprogram">打开小程序</option></select><input v-else :value="field.value" :aria-label="field.label" :disabled="!editable" @input="field.change(($event.target as HTMLInputElement).value)" /></label><p v-if="selected.sub_button?.length">该菜单展开子菜单，仅发布名称和完整子菜单列表。原动作字段仍保留在本地文档。</p><p v-else-if="selected.type === 'click'">关键词将交给已迁移的公众号点击回复流程，最多64个字符单位、128字节。</p><p v-else-if="selected.type === 'miniprogram'">小程序需与公众号关联；不支持小程序的旧版微信使用备用网页。</p><p>名称：{{ wechatMenuBytes(selected.name) }} 字节；一级最多16字节，子菜单最多60字节。过长名称可能在微信中省略显示。</p></template></div>
        <div class="phone-preview"><h3>菜单预览</h3><div class="phone-body"><p>公众号会话</p><p>预览仅展示结构，不会打开外部链接或触发发布。</p></div><div class="phone-menu"><div v-for="row in draft" :key="draft.indexOf(row)"><div v-if="row.sub_button?.length" class="preview-children"><span v-for="child in row.sub_button" :key="row.sub_button.indexOf(child)">{{ child.name || '未命名' }}</span></div><strong>{{ row.name || '未命名' }}</strong></div></div></div>
      </div>
      <footer><p>发布会替换该公众号的默认菜单。微信客户端可能延迟刷新；空菜单不能用于删除线上菜单。</p><button class="publish" :disabled="!editable || !snapshot.runtime_ready || !snapshot.configured || !draft.length" @click="actions.publish">确认并发布到微信</button></footer>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { apiWechatMenu, apiPublishWechatMenu, apiWechatMenuReceipt, apiObserveWechatMenu, apiConfirmWechatMenuObservation, apiResolveMissingWechatMenu, menuOperationId, wechatMenuOutcome,
  type MenuSnapshot, type MenuPublish, type MenuReceipt, type MenuObservation } from '@/api/wechatMenu';
import { normalizeWechatMenu, wechatMenuBytes, type WechatMenuButton } from '../../../../common/wechatMenu';
import { useWechatMenuSession } from './wechatMenuSession';
const auth = useAuthStore(), route = useRoute();
const snapshot = ref<MenuSnapshot | null>(null), draft = ref<WechatMenuButton[]>([]), selected = ref<WechatMenuButton | null>(null);
const loading = ref(false), busy = ref(false), error = ref(''), notice = ref(''), replaceHistory = ref(false), editEpoch = ref(0);
const selectionEpoch = ref(0), observationEpoch = ref(0);
const localPending = ref<MenuPublish | null>(null), serverPending = ref<MenuReceipt | null>(null), observation = ref<MenuObservation | null>(null);
const pendingId = computed(() => localPending.value?.operation_id ?? serverPending.value?.operation_id ?? '');
const manage = computed(() => session.allowed.value && session.has('wechat_menu.manage'));
const editable = computed(() => manage.value && !!snapshot.value && !loading.value && !busy.value && !pendingId.value);
function discard() { editEpoch.value++; selectionEpoch.value++; snapshot.value = null; draft.value = []; selected.value = null; loading.value = busy.value = false; error.value = notice.value = ''; replaceHistory.value = false; localPending.value = serverPending.value = null; observation.value = null; observationEpoch.value++; }
const session = useWechatMenuSession(() => 'wechat_menu.view', () => route.fullPath, discard, load);
const storageKey = () => 'cinashop_wechat_menu_pending_v1_' + auth.userInfo?.id;
function message(reason: unknown) { const e = reason as {response?: {data?: {msg?: unknown}}; message?: unknown}; const text = e?.response?.data?.msg ?? e?.message; return typeof text === 'string' && text.length <= 512 ? text : '菜单请求失败，请保留原操作并稍后核对'; }
function readPending() {
  const raw = localStorage.getItem(storageKey()); if (!raw) return null;
  if (raw.length > 131072) throw Error('本账号待核对操作过大，请保留本地记录并人工维护');
  const record = JSON.parse(raw) as { actor_id: number; payload: MenuPublish };
  if (record.actor_id !== auth.userInfo?.id || !menuOperationId(record.payload?.operation_id) || record.payload.confirmed !== true
    || !/^[a-f0-9]{64}$/u.test(record.payload.revision)) throw Error('本账号待核对操作记录不完整，请人工维护');
  normalizeWechatMenu(record.payload.button); return record.payload;
}
function persist(payload: MenuPublish) {
  const value = JSON.stringify({ actor_id: auth.userInfo?.id, payload }), current = localStorage.getItem(storageKey());
  if (current && current !== value) throw Error('本账号已有其他待核对操作，请先处理原记录');
  localStorage.setItem(storageKey(), value); if (localStorage.getItem(storageKey()) !== value) throw Error('无法保存原发布标识，暂不发出发布');
  localPending.value = payload;
}
function terminal(receipt: MenuReceipt) {
  notice.value = wechatMenuOutcome(receipt);
  if (receipt.state === 'unknown') { serverPending.value = receipt; return; }
  if (localPending.value?.operation_id === receipt.operation_id) {
    const actual = readPending(); if (actual && JSON.stringify(actual) !== JSON.stringify(localPending.value)) throw Error('本地原发布记录已变化，请保留核对');
    localStorage.removeItem(storageKey()); localPending.value = null;
  }
  if (serverPending.value?.operation_id === receipt.operation_id) serverPending.value = null;
}
async function load() {
  const request = session.begin('menu'); if (!request) return;
  loading.value = true; error.value = ''; editEpoch.value++; selectionEpoch.value++; selected.value = null;
  try {
    const stored = readPending(), result = await apiWechatMenu(request.signal); if (!request.current()) return;
    snapshot.value = result; draft.value = result.menus ? structuredClone(result.menus) : []; replaceHistory.value = false;
    localPending.value = stored; serverPending.value = result.pending; observation.value = null; observationEpoch.value++;
  } catch (reason) { if (request.current()) { error.value = message(reason); snapshot.value = null; } }
  finally { if (request.current()) loading.value = false; request.finish(); }
}
function guard() { const lease = session.lease(), epoch = editEpoch.value; return () => lease.current() && epoch === editEpoch.value; }
function changed() { editEpoch.value++; error.value = notice.value = ''; }
function select(item: WechatMenuButton, current: () => boolean) { if (!current() || !session.allowed.value) return; selected.value = item; editEpoch.value++; selectionEpoch.value++; }
function remove(item: WechatMenuButton, parent: WechatMenuButton | null, current: () => boolean) {
  if (!current() || !editable.value || !window.confirm('确认从待发布内容中删除“' + (item.name || '未命名菜单') + '”及其子菜单？线上内容须最终发布后才会改变。')) return;
  if (!current() || !editable.value) return; const list = parent ? parent.sub_button! : draft.value, index = list.indexOf(item); if (index < 0) return;
  list.splice(index, 1); if (selected.value === item || item.sub_button?.includes(selected.value!)) selected.value = null; selectionEpoch.value++; changed();
}
const rows = computed(() => { const current = guard(); return draft.value.map((item, index) => ({ item, index, select: () => select(item, current),
  remove: () => remove(item, null, current), addChild: () => { if (!current() || !editable.value || (item.sub_button?.length ?? 0) >= 5) return;
    const child: WechatMenuButton = { name: '', type: 'click', key: '' }; (item.sub_button ??= []).push(child); selected.value = child; selectionEpoch.value++; changed(); },
  children: (item.sub_button ?? []).map((child, index) => ({ item: child, index, select: () => select(child, current), remove: () => remove(child, item, current) })) })); });
const editorFields = computed(() => {
  const item = selected.value, epoch = selectionEpoch.value, lease = session.lease();
  const current = () => lease.current() && epoch === selectionEpoch.value;
  if (!item) return [];
  const leaf = !item.sub_button?.length, keys = ['name', ...(leaf ? ['type', ...(item.type === 'click' ? ['key'] : item.type === 'miniprogram' ? ['appid', 'pagepath', 'url'] : ['url'])] : [])];
  const labels: Record<string,string> = { name: '菜单名称', type: '响应类型', key: '点击关键词', url: item.type === 'miniprogram' ? '备用网页链接' : '网页链接', appid: '小程序 AppID', pagepath: '小程序页面路径' };
  return keys.map(key => ({ key, label: labels[key], value: String(item[key as keyof WechatMenuButton] ?? ''), change: (value: string) => {
    if (!current() || !editable.value || selected.value !== item) return;
    if (key === 'type') { if (!['click', 'view', 'miniprogram'].includes(value)) return; item.type = value as WechatMenuButton['type']; selectionEpoch.value++; }
    else (item as unknown as Record<string, unknown>)[key] = value; changed();
  } }));
});
async function send(payload: MenuPublish) {
  const request = session.begin('publish'); if (!request || !manage.value || busy.value) return;
  try { persist(payload); busy.value = true; error.value = ''; const result = await apiPublishWechatMenu(payload, request.signal);
    if (request.current()) { terminal(result); if (result.state !== 'unknown') await load(); }
  } catch (reason) { if (request.current()) error.value = message(reason); }
  finally { if (request.current()) busy.value = false; request.finish(); }
}
const controls = computed(() => { const current = guard(), observedEpoch = observationEpoch.value, observedId = pendingId.value, observedStamp = observation.value?.observation, sealPayload = localPending.value; return {
  refresh: () => { if (!current() || busy.value || loading.value) return; if (draft.value.length && !window.confirm('重新读取会放弃当前未发布的编辑，是否继续？')) return; if (current()) void load(); },
  addRoot: () => { if (!current() || !editable.value || draft.value.length >= 3) return; const item: WechatMenuButton = { name: '', type: 'click', key: '', sub_button: [] }; draft.value.push(item); selected.value = item; selectionEpoch.value++; changed(); },
  replaceHistory: () => { if (!current() || !manage.value || busy.value || pendingId.value || !window.confirm('已核对完整历史原文，确认整体重建？发布前仍会再次确认。')) return; if (!current()) return; replaceHistory.value = true; draft.value = []; selected.value = null; selectionEpoch.value++; changed(); },
  publish: () => { if (!current() || !editable.value || !snapshot.value?.runtime_ready || !snapshot.value.configured) return;
    try { const button = normalizeWechatMenu(draft.value), payload: MenuPublish = { operation_id: crypto.randomUUID(), revision: snapshot.value.revision, button, replace_history: replaceHistory.value, confirmed: true };
      if (!window.confirm('确认将以下菜单发布到公众号 ' + snapshot.value.app_id + ' 并替换微信默认菜单？\n' + button.map(v => v.name).join(' / '))) return;
      if (current() && editable.value) void send(payload);
    } catch (reason) { if (current()) error.value = message(reason); }
  },
  retry: () => { if (!current() || !manage.value || busy.value || !localPending.value) return; const payload = JSON.parse(JSON.stringify(localPending.value)) as MenuPublish;
    if (!window.confirm('使用原操作标识和原内容继续。服务器已有发布记录时只读取结果；未受理时可能发出一次发布。确认继续？')) return;
    if (current() && manage.value) void send(payload);
  },
  resolveMissing: async () => {
    if (!current() || !manage.value || busy.value || !sealPayload || localPending.value !== sealPayload || pendingId.value !== sealPayload.operation_id) return;
    const payload = JSON.parse(JSON.stringify(sealPayload)) as MenuPublish, id = payload.operation_id;
    if (!window.confirm('确认核对并封存这个原始请求？服务器仅在从未受理时记录“未发出”，阻止原标识今后发送；已受理的未知请求不会被取消，原记录仍需核对。此操作不会发布菜单。')) return;
    if (!current() || !manage.value || busy.value || localPending.value !== sealPayload || pendingId.value !== id) return;
    let request: ReturnType<typeof session.begin> = null;
    try {
      if (JSON.stringify(readPending()) !== JSON.stringify(payload)) throw Error('本地原发布记录已变化，请保留核对');
      request = session.begin('resolve-missing'); if (!request) return;
      busy.value = true; error.value = ''; observation.value = null; observationEpoch.value++;
      const result = await apiResolveMissingWechatMenu(payload, request.signal);
      if (request.current() && pendingId.value === id && localPending.value === sealPayload) { terminal(result); if (result.state !== 'unknown') await load(); }
    } catch (reason) { if (current() && (!request || request.current())) error.value = message(reason); }
    finally { if (request?.current()) busy.value = false; request?.finish(); }
  },
  receipt: async () => { if (!current() || !manage.value || busy.value || !pendingId.value) return; const id = pendingId.value, request = session.begin('receipt'); if (!request) return;
    busy.value = true; try { const result = await apiWechatMenuReceipt(id, request.signal); if (request.current() && pendingId.value === id) { terminal(result); if (result.state !== 'unknown') await load(); } }
    catch (reason) { if (request.current()) error.value = message(reason); } finally { if (request.current()) busy.value = false; request.finish(); }
  },
  observe: async () => { if (!current() || !manage.value || busy.value || !pendingId.value) return; const id = pendingId.value, request = session.begin('observe'); if (!request) return;
    busy.value = true; try { const result = await apiObserveWechatMenu(id, request.signal); if (request.current() && pendingId.value === id) { observation.value = result; observationEpoch.value++; } }
    catch (reason) { if (request.current()) error.value = message(reason); } finally { if (request.current()) busy.value = false; request.finish(); }
  },
  confirmObservation: async () => { if (!current() || !manage.value || busy.value || !observedId || !observedStamp || observationEpoch.value !== observedEpoch || pendingId.value !== observedId || !observation.value?.matches) return;
    const id = observedId, stamp = observedStamp;
    if (!window.confirm('确认已经核对该公众号线上内容，与原发布内容完整匹配，并在安全节点封存原请求？这仅记录人工核对结果，不证明原发布请求成功。')) return;
    if (!current() || !manage.value || observationEpoch.value !== observedEpoch || pendingId.value !== id || observation.value?.observation !== stamp) return;
    const request = session.begin('confirm-observation'); if (!request) return;
    busy.value = true; try { const result = await apiConfirmWechatMenuObservation(id, stamp, request.signal); if (request.current() && pendingId.value === id) { terminal(result); await load(); } }
    catch (reason) { if (request.current()) error.value = message(reason); } finally { if (request.current()) busy.value = false; request.finish(); }
  },
}; });
</script>
<style scoped>
.wechat-menu-author{padding:20px;color:#303133}.wechat-menu-author header,.actions,.menu-row{display:flex;gap:10px;align-items:center;justify-content:space-between}.wechat-menu-author h2{margin:0}.wechat-menu-author p{line-height:1.6}.wechat-menu-author button{padding:9px 12px;border:1px solid #cdd4de;background:white;border-radius:5px;color:#303133;cursor:pointer}.wechat-menu-author button:disabled{opacity:.55;cursor:not-allowed}.wechat-menu-author button[aria-pressed=true]{border-color:#409eff;background:#edf6ff}.error,.history-warning{color:#ad3030;background:#fff3f1;padding:12px}.notice,.pending,.observation{background:#f1f7ff;padding:12px;margin:12px 0}.editor-layout{display:grid;grid-template-columns:minmax(210px,1fr) minmax(260px,1.5fr) minmax(210px,1fr);gap:20px;margin-top:20px}.menu-tree,.menu-fields,.phone-preview{border:1px solid #e3e7ee;border-radius:8px;padding:15px;min-width:0}.menu-tree ol{padding-left:20px}.menu-tree li{margin:9px 0}.menu-row button:first-child{overflow-wrap:anywhere}.menu-fields label{display:grid;gap:7px;margin:14px 0}.menu-fields input,.menu-fields select{box-sizing:border-box;width:100%;min-width:0;padding:10px;border:1px solid #cdd4de;border-radius:4px}.phone-preview{display:flex;flex-direction:column;min-height:340px}.phone-body{flex:1;background:#f7f8fa;padding:12px;color:#606266}.phone-menu{display:flex;gap:4px;align-items:flex-end;min-height:80px}.phone-menu>div{flex:1;min-width:0;text-align:center;overflow-wrap:anywhere}.phone-menu strong,.preview-children span{display:block;border:1px solid #e3e7ee;padding:8px 3px}.preview-children{background:white}.wechat-menu-author footer{margin-top:20px;border-top:1px solid #e3e7ee;padding-top:12px}.publish{background:#409eff!important;color:white!important}.actions{flex-wrap:wrap;justify-content:flex-start}.break,pre{overflow-wrap:anywhere;white-space:pre-wrap;max-height:360px;overflow:auto}@media(max-width:1000px){.editor-layout{grid-template-columns:1fr 1fr}.phone-preview{grid-column:1/-1;max-width:430px;width:100%;box-sizing:border-box;justify-self:center}}@media(max-width:600px){.wechat-menu-author{padding:10px}.wechat-menu-author header{align-items:flex-start;flex-direction:column}.editor-layout{grid-template-columns:1fr}.phone-preview{grid-column:auto}.menu-row{gap:5px}.wechat-menu-author button{font-size:13px}}
</style>
