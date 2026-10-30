<template>
  <section v-for="actions in [controls]" :key="'pc-base-author'" class="pc-base-author">
    <header><div><h2>PC基础配置</h2><p>配置首页、手机购买入口、联系方式和页脚内容。</p></div><button :disabled="!session.allowed.value || loading || busy" @click="actions.refresh">重新读取</button></header>
    <p v-if="!session.signedIn.value" role="alert">请使用有效的管理员会话登录；待核对请求标识会保留。</p>
    <p v-else-if="!session.allowed.value" role="alert">当前账号没有PC配置查看权限；本人待核对请求仍可读取或封存。</p>
    <p v-if="loading" role="status">正在读取PC配置…</p><p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="journalError" role="alert" class="error">{{ journalError }}</p><p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <aside v-if="pendingRecords.length" class="pending" aria-label="待核对PC配置请求"><strong>有配置请求待核对，新的保存已暂停</strong><p>浏览器只保留账号和请求标识。保存响应丢失不能说明未保存；不会自动重发原稿。</p>
      <div class="pending-list"><button v-for="row in pendingRows" :key="row.id" :aria-pressed="pendingId === row.id" :disabled="busy" @click="row.select">{{ row.id }}</button></div>
      <div class="actions"><button :disabled="!session.signedIn.value || busy" @click="actions.receipt">读取保存回执</button><button :disabled="!session.signedIn.value || busy" @click="actions.resolve">核对并封存未受理请求</button></div><p>封存会禁止这个未受理标识今后保存。已经提交成功的请求只返回原结果。</p>
    </aside>
    <form v-if="snapshot && session.allowed.value" @submit.prevent="actions.save">
      <p v-if="!manage" role="status" class="notice">当前账号仅可查看，保存需要PC配置管理权限。</p><p v-if="!snapshot.runtime_ready" role="alert" class="history-warning">当前环境尚未就绪保存记录能力，暂不可保存。</p>
      <p class="hint">每项默认保留原值；编辑后仅替换该项。缺失或无法安全显示的历史内容也可保留，其他项仍可独立编辑。</p>
      <p v-for="issue in snapshot.issues" :key="issue.key + issue.code + issue.message" role="alert" class="history-warning">{{ labels[issue.key] }}：{{ issue.message }}</p>
      <fieldset v-for="group in scalarGroups" :key="group.name"><legend>{{ group.name }}</legend>
        <div v-for="field in group.fields" :key="field.key" class="field">
          <div class="field-heading"><label :for="'pc-' + field.key">{{ field.label }}</label><label class="intent">{{ field.label }}处理方式<select :aria-label="field.label + '处理方式'" :value="field.action" :disabled="!editable" @change="field.intent(($event.target as HTMLSelectElement).value)"><option value="keep">保留原值</option><option value="replace">明确替换</option></select></label></div>
          <p v-if="field.state" class="hint">{{ field.state }}</p>
          <textarea v-if="field.kind === 'textarea'" :id="'pc-' + field.key" :aria-label="field.label" :value="field.value" :disabled="!editable" rows="4" @input="field.change(($event.target as HTMLTextAreaElement).value)" />
          <select v-else-if="field.kind === 'select'" :id="'pc-' + field.key" :aria-label="field.label" :value="field.value" :disabled="!editable" @change="field.change(($event.target as HTMLSelectElement).value)"><option value="" disabled>请选择</option><option v-for="option in field.options" :key="option.value" :value="option.value">{{ option.label }}</option></select>
          <input v-else :id="'pc-' + field.key" :aria-label="field.label" :type="field.kind === 'number' ? 'number' : 'text'" :step="field.kind === 'number' ? '1' : undefined" :min="field.kind === 'number' ? '1' : undefined" :value="field.value" :disabled="!editable" autocomplete="off" spellcheck="false" @input="field.change(($event.target as HTMLInputElement).value)" />
          <button v-if="field.kind === 'image'" type="button" :disabled="!editable" @click="field.gallery">从图库选择PC端LOGO</button><p v-if="field.hint" class="hint">{{ field.hint }}</p><img v-if="field.preview" :src="field.preview" :alt="field.label + '预览'" class="image-preview" referrerpolicy="no-referrer" />
        </div>
      </fieldset>
      <fieldset v-for="table in [linkTable]" :key="'links'"><legend>友情链接列表</legend><div class="table-heading"><p>分别保存行顺序和排序值；名称与地址不能为空。</p><label class="intent">友情链接列表处理方式<select aria-label="友情链接列表处理方式" :value="table.action" :disabled="!editable" @change="table.intent(($event.target as HTMLSelectElement).value)"><option value="keep">保留原值</option><option value="replace">明确替换</option></select></label></div><p v-if="table.state" class="hint">{{ table.state }}</p>
        <div v-for="(row, index) in table.rows" :key="row.id" class="table-row"><h3>友情链接 {{ index + 1 }}</h3><label>名称<input :aria-label="'友情链接名称' + (index + 1)" :value="row.name" :disabled="!editable" @input="row.nameInput(($event.target as HTMLInputElement).value)" /></label><label>地址<input :aria-label="'友情链接地址' + (index + 1)" :value="row.url" :disabled="!editable" @input="row.urlInput(($event.target as HTMLInputElement).value)" /></label><label>排序<input type="number" min="0" step="any" :aria-label="'友情链接排序' + (index + 1)" :value="row.sort" :disabled="!editable" @input="row.sortInput(($event.target as HTMLInputElement).value)" /></label><div class="actions"><button type="button" :disabled="!editable || index === 0" :aria-label="'上移友情链接' + (index + 1)" @click="row.up">上移</button><button type="button" :disabled="!editable || index === table.rows.length - 1" :aria-label="'下移友情链接' + (index + 1)" @click="row.down">下移</button><button type="button" :disabled="!editable" :aria-label="'删除友情链接' + (index + 1)" @click="row.remove">删除</button></div></div>
        <button type="button" :disabled="!editable" @click="table.add">添加友情链接</button>
      </fieldset>
      <fieldset v-for="table in [filingTable]" :key="'filings'"><legend>底部自定义</legend><div class="table-heading"><p>图标、名称、链接可留空，支持小数排序值。</p><label class="intent">底部自定义处理方式<select aria-label="底部自定义处理方式" :value="table.action" :disabled="!editable" @change="table.intent(($event.target as HTMLSelectElement).value)"><option value="keep">保留原值</option><option value="replace">明确替换</option></select></label></div><p v-if="table.state" class="hint">{{ table.state }}</p>
        <div v-for="(row, index) in table.rows" :key="row.id" class="table-row"><h3>底部项目 {{ index + 1 }}</h3><label>图标地址或素材引用<input :aria-label="'底部图标' + (index + 1)" :value="row.icon" :disabled="!editable" autocomplete="off" @input="row.iconInput(($event.target as HTMLInputElement).value)" /></label><button type="button" :disabled="!editable" :aria-label="'选择底部图标' + (index + 1)" @click="row.gallery">从图库选择底部图标</button><img v-if="row.preview" :src="row.preview" alt="底部图标预览" class="image-preview" referrerpolicy="no-referrer" /><label>名称<input :aria-label="'底部名称' + (index + 1)" :value="row.name" :disabled="!editable" @input="row.nameInput(($event.target as HTMLInputElement).value)" /></label><label>链接<input :aria-label="'底部链接' + (index + 1)" :value="row.url" :disabled="!editable" @input="row.urlInput(($event.target as HTMLInputElement).value)" /></label><label>排序<input type="number" min="0" step="any" :aria-label="'底部排序' + (index + 1)" :value="row.sort" :disabled="!editable" @input="row.sortInput(($event.target as HTMLInputElement).value)" /></label><div class="actions"><button type="button" :disabled="!editable || index === 0" :aria-label="'上移底部项目' + (index + 1)" @click="row.up">上移</button><button type="button" :disabled="!editable || index === table.rows.length - 1" :aria-label="'下移底部项目' + (index + 1)" @click="row.down">下移</button><button type="button" :disabled="!editable" :aria-label="'删除底部项目' + (index + 1)" @click="row.remove">删除</button></div></div>
        <button type="button" :disabled="!editable" @click="table.add">添加底部项目</button><p class="hint">图片可填写安全的HTTP、HTTPS、站内地址或 /api/assets/数字 素材引用。签名预览地址仅用于显示；新素材引用保存并重新读取后生成预览。</p>
      </fieldset>
      <footer><p>确认后只替换明确编辑的字段。恢复“保留原值”会放弃该项本次编辑。</p><button type="button" class="primary" :disabled="!editable || !snapshot.runtime_ready" @click="actions.save">确认并保存配置</button></footer>
    </form>
    <PcBaseImagePicker v-if="picker && editable" :key="picker.id" :choose="picker.choose" :close="picker.close" />
  </section>
</template>
<script setup lang="ts">
import PcBaseImagePicker from '@/components/PcBaseImagePicker.vue';
import type { PcBaseImage } from '@/api/pcBase';
import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { apiPcBase, apiSavePcBase, apiPcBaseReceipt, apiResolvePcBase, checkedPcBaseReceipt, checkedPcBasePreview, pcBasePreviewDeadline } from '@/api/pcBase';
import { usePcBaseSession } from '@/utils/pcBaseSession';
import { PC_BASE_KEYS, pcBaseImage, pcBaseRequestId, type PcBaseKey, type PcBaseSnapshot } from '../../../../common/pcBase';
import { parsePcBaseIntentSave, pcBaseIntentPending, type PcBaseIntentSave } from '../../../../common/pcBaseIntent';
type ScalarKey = Exclude<PcBaseKey, 'links_list' | 'filing_list'>;
type Pending = ReturnType<typeof pcBaseIntentPending>;
type LinkRow = { id: number; name: string; url: string; sort: string };
type FilingRow = LinkRow & { icon: string; previewSource: string; preview: string };
type ScalarDefinition = { key: ScalarKey; label: string; group: string; kind: 'text' | 'image' | 'number' | 'select' | 'textarea'; hint?: string; options?: Array<{ value: string; label: string }> };
const definitions: ScalarDefinition[] = [
  { key: 'pc_logo', label: 'PC端LOGO', group: '首页与购买入口', kind: 'image', hint: '建议140 × 60px；可填写安全HTTP、HTTPS、站内图片地址或 /api/assets/数字 素材引用。' },
  { key: 'bast_number', label: '精品推荐个数', group: '首页与购买入口', kind: 'number', hint: '填写正整数，原值超过100也可完整保留。' },
  { key: 'first_number', label: '首发新品个数', group: '首页与购买入口', kind: 'number' },
  { key: 'product_phone_buy_url', label: '商品手机购买跳转地址', group: '首页与购买入口', kind: 'select', options: [{ value: '1', label: '公众号' }, { value: '2', label: '小程序' }] },
  { key: 'contact_number', label: '联系电话', group: '联系与网站信息', kind: 'text' },
  { key: 'company_address', label: '公司地址', group: '联系与网站信息', kind: 'text' },
  { key: 'copyright', label: '版权信息', group: '联系与网站信息', kind: 'text' },
  { key: 'seo_title', label: '历史SEO标题（仅存储）', group: '联系与网站信息', kind: 'text' },
  { key: 'site_keywords', label: '关键词', group: '联系与网站信息', kind: 'text' },
  { key: 'site_description', label: '网站描述', group: '联系与网站信息', kind: 'textarea' },
  { key: 'links_open', label: '友情链接开关', group: '友情链接', kind: 'select', options: [{ value: '1', label: '开启' }, { value: '0', label: '关闭' }] },
];
const labels = Object.fromEntries([...definitions.map(row => [row.key, row.label]), ['links_list', '友情链接列表'], ['filing_list', '底部自定义']]) as Record<PcBaseKey, string>;
const auth = useAuthStore(), route = useRoute(), snapshot = ref<PcBaseSnapshot | null>(null);
const draft = reactive(Object.fromEntries(definitions.map(row => [row.key, ''])) as Record<ScalarKey, string>);
const modes = reactive(Object.fromEntries(PC_BASE_KEYS.map(key => [key, 'keep'])) as Record<PcBaseKey, 'keep' | 'replace'>);
const fieldEpoch = reactive(Object.fromEntries(PC_BASE_KEYS.map(key => [key, 0])) as Record<PcBaseKey, number>);
const links = ref<LinkRow[]>([]), filings = ref<FilingRow[]>([]); let rowSerial = 0;
const loading = ref(false), busy = ref(false), error = ref(''), notice = ref(''), journalError = ref('');
const generation = ref(0), editEpoch = ref(0), pendingEpoch = ref(0), previewClock = ref(Date.now());
const pendingRecords = ref<Pending[]>([]), selectedPending = ref('');
const pickedLogo = ref<{ source: string; preview: string } | null>(null);
const picker = ref<{ id: number; choose: (image: PcBaseImage) => void; close: () => void } | null>(null); let pickerSerial = 0;
function openPicker(key: 'pc_logo' | 'filing_list', current: () => boolean, row?: FilingRow) {
  if (!current() || !editable.value) return;
  const source = generation.value, epoch = fieldEpoch[key], id = ++pickerSerial;
  const valid = () => current() && editable.value && generation.value === source && fieldEpoch[key] === epoch && picker.value?.id === id && (!row || filings.value.includes(row));
  picker.value = { id, close: () => { if (valid()) picker.value = null; }, choose: image => {
    if (!valid()) return;
    if (key === 'pc_logo') { draft.pc_logo = image.reference; pickedLogo.value = { source: image.reference, preview: image.preview }; }
    else if (row) { row.icon = image.reference; row.previewSource = image.reference; row.preview = image.preview; }
    picker.value = null; fieldEpoch[key]++; changed(key); armPreviews();
  } };
}
let previewTimer: ReturnType<typeof setTimeout> | undefined;
function stopPreviewTimer() { if (previewTimer !== undefined) clearTimeout(previewTimer); previewTimer = undefined; }
function resetField(key: PcBaseKey) {
  modes[key] = 'keep'; fieldEpoch[key]++; picker.value = null; if (key === 'pc_logo') pickedLogo.value = null;
  if (key === 'links_list') links.value = (snapshot.value?.settings.links_list ?? []).map(row => ({ id: ++rowSerial, name: row.name, url: row.url, sort: String(row.sort) }));
  else if (key === 'filing_list') filings.value = (snapshot.value?.settings.filing_list ?? []).map((row, index) => ({ id: ++rowSerial, icon: row.icon, name: row.name, url: row.url,
    sort: String(row.sort), previewSource: row.icon, preview: snapshot.value?.asset_previews[`filing_list.${index}.icon`] ?? '' }));
  else { const value = snapshot.value?.settings[key]; draft[key] = value === null || value === undefined ? '' : String(value); }
}
function clearDraft() { for (const key of PC_BASE_KEYS) resetField(key); }
function discard() {
  picker.value = null; pickedLogo.value = null; generation.value++; editEpoch.value++; pendingEpoch.value++; stopPreviewTimer(); snapshot.value = null; clearDraft();
  loading.value = busy.value = false; error.value = notice.value = journalError.value = ''; pendingRecords.value = []; selectedPending.value = '';
}
const session = usePcBaseSession(() => route.fullPath, discard, activate);
const manage = computed(() => session.allowed.value && session.has('pc_base.manage'));
const editable = computed(() => manage.value && !!snapshot.value && !loading.value && !busy.value && !pendingRecords.value.length && !journalError.value);
const pendingId = computed(() => pendingRecords.value.some(row => row.request_id === selectedPending.value) ? selectedPending.value : pendingRecords.value[0]?.request_id ?? '');
function message(reason: unknown): string {
  const value = reason as { response?: { data?: { msg?: unknown } }; message?: unknown }, text = value?.response?.data?.msg ?? value?.message;
  return typeof text === 'string' && text.trim() && text.length <= 512 ? text : 'PC配置请求失败，请保留标识并稍后核对';
}
const prefix = (actor = auth.userInfo?.id) => `cinashop_pc_base_pending_v1_${actor}_`;
const storageKey = (id: string, actor = auth.userInfo?.id) => prefix(actor) + id;
function readPending(): Pending[] {
  const actor = auth.userInfo?.id; if (!Number.isSafeInteger(actor) || !actor || actor < 1) return [];
  const records: Pending[] = [], keys: string[] = [];
  for (let index = 0; index < localStorage.length; index++) { const key = localStorage.key(index); if (key?.startsWith(prefix(actor))) keys.push(key); }
  if (keys.length > 128) throw Error('本账号待核对请求超过容量，请保留记录并人工维护');
  for (const key of keys.sort()) {
    const raw = localStorage.getItem(key); if (!raw || raw.length > 512) throw Error('本账号待核对标识不完整，请保留记录');
    let value: unknown; try { value = JSON.parse(raw); } catch { throw Error('本账号待核对标识格式无效，请保留记录'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('本账号待核对标识格式无效');
    const row = value as Record<string, unknown>;
    if (Object.keys(row).sort().join(',') !== 'actor_id,domain,request_id,version' || row.version !== 1 || row.domain !== 'pc_base' || row.actor_id !== actor
      || !pcBaseRequestId(row.request_id) || key !== storageKey(row.request_id, actor)) throw Error('本账号待核对标识身份无效，请保留记录');
    records.push(row as Pending);
  }
  return records;
}
function restorePending() {
  try { pendingRecords.value = readPending(); selectedPending.value = pendingRecords.value[0]?.request_id ?? ''; journalError.value = ''; pendingEpoch.value++; }
  catch (reason) { journalError.value = message(reason); }
}
async function activate() { const view = session.lease(); restorePending(); if (view.current() && session.allowed.value) await load(); }
function armPreviews() {
  stopPreviewTimer(); previewClock.value = Date.now();
  const deadlines = [...Object.values(snapshot.value?.asset_previews ?? {}), pickedLogo.value?.preview ?? '', ...filings.value.map(row => row.preview)].map(pcBasePreviewDeadline).filter((value): value is number => value !== null && value > Date.now());
  if (deadlines.length) previewTimer = setTimeout(() => { previewClock.value = Date.now(); armPreviews(); }, Math.min(2147483647, Math.max(1, Math.min(...deadlines) - Date.now() + 1)));
}
async function load() {
  if (!session.allowed.value || busy.value) return; const request = session.begin('snapshot'); if (!request) return;
  generation.value++; editEpoch.value++; snapshot.value = null; clearDraft(); stopPreviewTimer(); loading.value = true; error.value = '';
  try {
    const result = await apiPcBase(request.signal); if (!request.current() || !session.allowed.value) return;
    snapshot.value = result; clearDraft(); armPreviews();
  } catch (reason) { if (request.current()) error.value = message(reason); }
  finally { if (request.current()) loading.value = false; request.finish(); }
}
function fieldLease() { const view = session.lease(), epoch = generation.value; return () => view.current() && epoch === generation.value; }
function changed(key: PcBaseKey) { picker.value = null; modes[key] = 'replace'; editEpoch.value++; error.value = notice.value = ''; }
function state(key: PcBaseKey): string {
  const value = snapshot.value?.fields[key];
  return !value?.present ? '原值缺失，保留不会创建默认值。' : value.redacted ? '历史原值未安全显示；保留即可继续编辑其他项。' : !value.parseable ? '历史原值需要核对；保留不会自动修复。' : '';
}
function changeIntent(key: PcBaseKey, value: string, current: () => boolean) {
  if (!current() || !editable.value || value !== 'keep' && value !== 'replace') return;
  if (value === 'keep') resetField(key); else { modes[key] = 'replace'; fieldEpoch[key]++; }
  editEpoch.value++; error.value = notice.value = '';
}
function preview(source: string, original: string, ticket: string): string {
  previewClock.value;
  try {
    const reference = pcBaseImage(source); if (!reference) return '';
    if (!/^\/api\/assets\/[1-9]\d*$/u.test(reference)) return reference;
    if (reference !== original) return '';
    const safe = checkedPcBasePreview(reference, ticket), deadline = pcBasePreviewDeadline(safe);
    return deadline !== null && Date.now() < deadline ? safe : '';
  } catch { return ''; }
}
const scalarGroups = computed(() => {
  const groups = ['首页与购买入口', '联系与网站信息', '友情链接'];
  return groups.map(name => ({ name, fields: definitions.filter(row => row.group === name).map(definition => {
    const key = definition.key, lease = fieldLease(), epoch = fieldEpoch[key], current = () => lease() && epoch === fieldEpoch[key];
    return { ...definition, value: draft[key], action: modes[key], state: state(key), options: definition.options ?? [],
      preview: key === 'pc_logo' ? preview(draft[key], pickedLogo.value?.source ?? snapshot.value?.settings.pc_logo ?? '', pickedLogo.value?.preview ?? snapshot.value?.asset_previews.pc_logo ?? '') : '',
      gallery: () => { if (key === 'pc_logo') openPicker(key, current); },
      intent: (value: string) => changeIntent(key, value, current), change: (value: string) => { if (!current() || !editable.value) return; draft[key] = value; changed(key); } };
  }) }));
});
function linkView(row: LinkRow, key: 'links_list' | 'filing_list', captured: () => boolean) {
  const collection = (): LinkRow[] => key === 'links_list' ? links.value : filings.value;
  const valid = () => captured() && editable.value && collection().includes(row);
  const input = (name: 'name' | 'url' | 'sort', value: string) => { if (valid()) { row[name] = value; changed(key); } };
  const move = (direction: -1 | 1) => {
    if (!valid()) return; const list = collection(), index = list.indexOf(row), target = index + direction;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]]; fieldEpoch[key]++; changed(key);
  };
  return { id: row.id, name: row.name, url: row.url, sort: row.sort, nameInput: (value: string) => input('name', value), urlInput: (value: string) => input('url', value), sortInput: (value: string) => input('sort', value),
    up: () => move(-1), down: () => move(1), remove: () => { if (valid()) { const list = collection(); list.splice(list.indexOf(row), 1); fieldEpoch[key]++; changed(key); } } };
}
const linkTable = computed(() => {
  const lease = fieldLease(), epoch = fieldEpoch.links_list, current = () => lease() && epoch === fieldEpoch.links_list;
  return { action: modes.links_list, state: state('links_list'), intent: (value: string) => changeIntent('links_list', value, current),
    rows: links.value.map(row => linkView(row, 'links_list', current)), add: () => { if (current() && editable.value) { links.value.push({ id: ++rowSerial, name: '', url: '', sort: '0' }); fieldEpoch.links_list++; changed('links_list'); } } };
});
const filingTable = computed(() => {
  const lease = fieldLease(), epoch = fieldEpoch.filing_list, current = () => lease() && epoch === fieldEpoch.filing_list;
  return { action: modes.filing_list, state: state('filing_list'), intent: (value: string) => changeIntent('filing_list', value, current),
    rows: filings.value.map(row => ({ ...linkView(row, 'filing_list', current), icon: row.icon, preview: preview(row.icon, row.previewSource, row.preview),
      gallery: () => openPicker('filing_list', current, row),
      iconInput: (value: string) => { if (current() && editable.value && filings.value.includes(row)) { row.icon = value; changed('filing_list'); } } })),
    add: () => { if (current() && editable.value) { filings.value.push({ id: ++rowSerial, icon: '', name: '', url: '', sort: '0', preview: '', previewSource: '' }); fieldEpoch.filing_list++; changed('filing_list'); } } };
});
function number(value: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value)) throw Error('数量与排序须为有效数字');
  return Number(value);
}
function input(): PcBaseIntentSave {
  if (!snapshot.value) throw Error('请先重新读取配置');
  const fields = Object.fromEntries(PC_BASE_KEYS.map(key => {
    if (modes[key] === 'keep') return [key, { action: 'keep' }];
    const value = key === 'links_list' ? links.value.map(row => ({ name: row.name, url: row.url, sort: number(row.sort) }))
      : key === 'filing_list' ? filings.value.map(row => ({ icon: row.icon, name: row.name, url: row.url, sort: number(row.sort) }))
        : ['bast_number','first_number','product_phone_buy_url','links_open'].includes(key) ? number(draft[key]) : draft[key];
    return [key, { action: 'replace', value }];
  }));
  return parsePcBaseIntentSave({ request_id: crypto.randomUUID(), revision: snapshot.value.revision, fields, confirmed: true });
}
function persist(payload: PcBaseIntentSave, current: () => boolean): Pending {
  if (!current() || !editable.value) throw Error('原编辑会话已变化');
  if (readPending().length) throw Error('本账号已有待核对请求，请先处理');
  const actor = auth.userInfo!.id, row = pcBaseIntentPending(payload, actor), key = storageKey(row.request_id, actor), raw = JSON.stringify(row);
  if (!current() || localStorage.getItem(key) !== null) throw Error('请求标识已存在或原会话已变化');
  localStorage.setItem(key, raw);
  if (!current()) throw Error('原编辑会话已变化，请保留请求标识核对');
  if (localStorage.getItem(key) !== raw) throw Error('无法持久保存请求标识，未发出保存');
  if (!current()) throw Error('原编辑会话已变化，请保留请求标识核对');
  pendingRecords.value = readPending(); selectedPending.value = row.request_id; pendingEpoch.value++;
  return row;
}
async function terminal(raw: unknown, id: string, actor: number, current: () => boolean) {
  if (!current()) return;
  const receipt = checkedPcBaseReceipt(raw, id, actor), key = storageKey(id, actor), expected = JSON.stringify({ version: 1, domain: 'pc_base', actor_id: actor, request_id: id });
  if (localStorage.getItem(key) !== expected) throw Error('本地原请求标识已变化，请保留核对');
  if (!current()) return; localStorage.removeItem(key);
  if (!current()) return;
  if (localStorage.getItem(key) !== null) throw Error('回执已确认，但无法清理本地标识，请保留核对');
  if (!current()) return; restorePending(); clearDraft(); busy.value = false;
  notice.value = receipt.state === 'not_applied' ? '原请求已封存为未应用，请重新读取后编辑。' : receipt.cache_status === 'pending' ? '配置已保存，但部分缓存清理尚未完成，请稍后核对。' : 'PC配置已保存。';
  if (session.allowed.value && current()) await load();
}
async function save(current: () => boolean) {
  if (!current() || !editable.value || !snapshot.value?.runtime_ready) return;
  let payload: PcBaseIntentSave;
  try { payload = input(); } catch (reason) { if (current()) error.value = message(reason); return; }
  if (!window.confirm('确认保存PC配置？仅替换明确编辑的字段，保留项的历史原值不变。') || !current() || !editable.value) return;
  const owner = auth.userInfo!.id;
  try { persist(payload, current); }
  catch (reason) { if (current()) { error.value = message(reason); restorePending(); } return; }
  // Persist changes pendingEpoch, so the pre-confirmation edit callback is
  // intentionally retired. A new live session lease gates dispatch itself.
  const dispatch = session.lease();
  if (!dispatch.current() || auth.userInfo?.id !== owner || pendingId.value !== payload.request_id) return;
  generation.value++; editEpoch.value++; clearDraft(); error.value = notice.value = '';
  const request = session.begin('save'); if (!request || !dispatch.current()) return; busy.value = true;
  try {
    if (!request.current() || !dispatch.current() || auth.userInfo?.id !== owner) return;
    const result = await apiSavePcBase(payload, request.signal);
    if (request.current() && pendingId.value === payload.request_id) await terminal(result, payload.request_id, owner, request.current);
  } catch (reason) { if (request.current()) error.value = '保存结果尚未确认，请保留请求标识。' + message(reason); }
  finally { if (request.current()) busy.value = false; request.finish(); }
}
async function recover(id: string, seal: boolean, current: () => boolean) {
  if (!current() || busy.value || !id || pendingId.value !== id) return;
  if (seal && (!window.confirm('确认核对并封存未受理请求？缺失的原请求将被持久封存，禁止迟到保存；已提交成功的请求只返回原结果。') || !current() || pendingId.value !== id)) return;
  try { if (!readPending().some(row => row.request_id === id)) throw Error('本地原请求标识已变化'); }
  catch (reason) { if (current()) error.value = message(reason); return; }
  if (!current()) return; const request = session.begin('recovery'); if (!request) return;
  const owner = auth.userInfo!.id; busy.value = true; error.value = notice.value = '';
  try {
    if (!request.current()) return;
    const raw = await (seal ? apiResolvePcBase(id, request.signal) : apiPcBaseReceipt(id, request.signal));
    if (request.current() && pendingId.value === id) await terminal(raw, id, owner, request.current);
  } catch (reason) { if (request.current()) error.value = '尚未确认原请求。' + message(reason) + ' 请保留标识；没有回执不代表未保存。'; }
  finally { if (request.current()) busy.value = false; request.finish(); }
}
const pendingRows = computed(() => {
  const lease = session.lease(), epoch = pendingEpoch.value;
  return pendingRecords.value.map(row => ({ id: row.request_id, select: () => { if (lease.current() && epoch === pendingEpoch.value && !busy.value) { selectedPending.value = row.request_id; pendingEpoch.value++; } } }));
});
const controls = computed(() => {
  const lease = fieldLease(), edit = editEpoch.value, pending = pendingEpoch.value, id = pendingId.value;
  const current = () => lease() && edit === editEpoch.value && pending === pendingEpoch.value;
  return { refresh: () => { if (current() && session.allowed.value && !busy.value) { restorePending(); if (lease() && session.allowed.value) { notice.value = ''; void load(); } } },
    save: () => { void save(current); }, receipt: () => { void recover(id, false, current); }, resolve: () => { void recover(id, true, current); } };
});
onBeforeUnmount(stopPreviewTimer);
</script>
<style scoped>
.pc-base-author{padding:20px;color:#303133;max-width:1200px;margin:auto}.pc-base-author header,.actions,.field-heading,.table-heading{display:flex;gap:12px;align-items:center;justify-content:space-between}.pc-base-author h2{margin:0}.pc-base-author h3{font-size:15px;margin:0 0 12px}.pc-base-author p{line-height:1.6;overflow-wrap:anywhere}.pc-base-author button{padding:9px 12px;border:1px solid #cdd4de;background:white;border-radius:5px;color:inherit;cursor:pointer}.pc-base-author button:disabled{opacity:.55;cursor:not-allowed}.pc-base-author button[aria-pressed=true]{border-color:#409eff;background:#edf6ff}.pc-base-author form{display:grid;gap:20px;margin-top:18px}.pc-base-author fieldset{border:1px solid #dfe4ec;border-radius:8px;min-width:0;padding:18px}.pc-base-author legend{font-weight:600;padding:0 8px}.pc-base-author label{display:grid;gap:8px;margin:10px 0;min-width:0}.pc-base-author input,.pc-base-author select,.pc-base-author textarea{box-sizing:border-box;width:100%;min-width:0;padding:10px;border:1px solid #cdd4de;border-radius:4px;background:white;color:#303133;font:inherit}.pc-base-author textarea{resize:vertical}.field{padding-bottom:18px;margin-bottom:12px;border-bottom:1px solid #edf0f5}.intent{font-size:13px;min-width:160px!important}.field-heading>label:first-child{font-weight:600}.hint{color:#606266;font-size:13px}.notice,.pending{background:#f0f6ff;padding:14px;border-radius:6px;margin:14px 0}.error,.history-warning{background:#fff3f1;color:#a83131;padding:10px}.actions{justify-content:flex-start;flex-wrap:wrap}.pending-list{display:grid;gap:6px;margin:12px 0}.pending-list button{overflow-wrap:anywhere;text-align:left}.image-preview{display:block;width:180px;height:90px;object-fit:contain;background:#f5f7fa;margin-top:10px}.table-row{border:1px solid #e4e8ee;padding:14px;margin:14px 0;border-radius:6px;min-width:0}.pc-base-author footer{border-top:1px solid #e4e8ee;padding-top:12px}.primary{background:#409eff!important;color:white!important}@media(max-width:600px){.pc-base-author{padding:10px}.pc-base-author>header,.field-heading,.table-heading{align-items:stretch;flex-direction:column}.pc-base-author fieldset{padding:12px}.field-heading{gap:0}.pc-base-author .intent{margin:0 0 10px}.table-row{padding:10px}.pc-base-author button{font-size:13px}}
</style>
