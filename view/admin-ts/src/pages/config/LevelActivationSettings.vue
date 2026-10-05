<template>
  <div class="level-settings">
    <div class="heading"><div><h2>普通等级卡激活</h2><p class="hint">管理普通等级功能、激活资料与激活赠礼。付费 SVIP、经验策略和等级定义在各自页面管理。</p></div>
      <el-button v-if="canManage" type="primary" :disabled="!editable" :loading="writing" @click="save">保存配置</el-button></div>
    <el-alert v-if="!canView" title="当前账号没有配置查看权限" type="warning" :closable="false" />
    <template v-else>
      <el-alert v-if="notice" :title="notice" type="warning" :closable="false" class="section" />
      <el-alert v-if="uncertainOperation" title="保存结果未确认，已暂停新的保存" type="warning" :closable="false" class="section">
        <p>重新读取仅核对当前配置，不会重发保存；当前值相同也不能证明原请求结果。</p>
        <details><summary>保留的原请求与确认内容</summary><pre>{{ JSON.stringify(uncertainOperation, null, 2) }}</pre></details>
        <div class="actions"><el-button :disabled="busy || loading" @click="load">重新读取核对</el-button><el-button :disabled="busy || loading" @click="acknowledge">结束本地待核对状态</el-button></div>
      </el-alert>
      <div v-if="loading" class="loading" v-loading="true">正在读取配置…</div>
      <el-alert v-else-if="loadError" title="配置读取失败" type="error" :closable="false"><p>{{ loadError }}</p><el-button @click="load">重新读取</el-button></el-alert>
      <template v-else-if="config && form">
        <el-alert title="保存仅影响之后读取配置的业务操作" type="info" :closable="false" class="section">
          已读取配置的激活操作可按原配置完成；不会重置既有用户激活状态、追补奖励或改写历史订单。关闭任一开关不会自动删除已配置的数量和集合。
        </el-alert>
        <el-alert v-if="config.missing_keys.length" title="部分配置尚未保存" type="warning" :closable="false" class="section">
          <p>{{ config.missing_keys.map(keyLabel).join('、') }}。当前按缺失时实际消费语义展示；读取不会写入默认值。</p>
        </el-alert>
        <el-alert v-if="config.issues.length" title="历史配置需要核对" type="warning" :closable="false" class="section">
          <p v-for="(issue, index) in config.issues" :key="index">{{ keyLabel(issue.key) }}：{{ issue.message }}</p>
          <p>未能安全转换的字段保留为待修复，必须明确修复后才能保存。</p>
        </el-alert>
        <el-card shadow="never" class="section"><template #header><strong>普通等级功能</strong></template>
          <div class="settings-grid">
            <div class="field"><div class="switch-line"><label>会员等级启用</label><el-switch v-model="form.member_func_status" :active-value="1" :inactive-value="0" :disabled="!editable" aria-label="会员等级启用" /></div><p class="hint">影响整个普通等级功能，包含新读取的等级价格策略。</p></div>
            <div class="field"><div class="switch-line"><label>需要激活会员卡</label><el-switch v-model="form.level_activate_status" :active-value="1" :inactive-value="0" :disabled="!editable" aria-label="需要激活会员卡" /></div><p class="hint">开启后用户需按配置提交资料并激活；关闭不补发手动激活赠礼。</p></div>
          </div>
        </el-card>
        <el-card shadow="never" class="section"><template #header><div class="heading"><strong>激活资料</strong><el-button v-if="canManage" :disabled="!editable || form.level_extend_info === null" @click="openProfiles">选择资料</el-button></div></template>
          <p class="hint">从基础资料候选选择，仅设置必填和移除；不会修改基础字段定义或用户已提交的资料。最多 {{ config.limits.fields }} 项，保存后的模板不超过 {{ config.limits.config_value_characters }} 字符。</p>
          <div v-if="form.level_extend_info === null" class="repair"><p>原资料集合无法安全转换，请查看下方原值。</p><el-button v-if="canManage" :disabled="!editable" @click="repair('level_extend_info')">明确清空资料并重新选择</el-button></div>
          <el-empty v-else-if="!form.level_extend_info.length" description="未选择激活资料" :image-size="65" />
          <article v-for="item in selectedProfiles" :key="item.field_key" class="profile-row">
            <div class="grow"><strong>{{ item.option?.definition?.info || '无效历史资料' }}</strong><p class="hint">{{ item.option?.definition?.label || '定义无效' }} · {{ item.option?.definition?.tip || item.field_key }}</p>
              <p v-if="item.option?.definition?.singlearr.length" class="hint">选项：{{ item.option.definition.singlearr.join('、') }}</p>
              <p v-if="item.option?.source === 'selected_legacy'" class="hint">已选历史定义，保留原有含义</p><p v-if="item.option?.issues.length" class="error">{{ item.option.issues.join('；') }}</p></div>
            <el-checkbox v-if="canManage" :model-value="item.required === 1" :disabled="!editable || !item.option?.selectable" @change="(value: unknown) => setRequired(item.field_key, !!value)">必填</el-checkbox><span v-else>{{ item.required ? '必填' : '选填' }}</span>
            <el-button v-if="canManage" link type="danger" :disabled="!editable" @click="removeProfile(item.field_key)">移除</el-button>
          </article>
        </el-card>
        <el-card shadow="never" class="section"><template #header><strong>激活赠礼</strong></template>
          <p class="hint">普通等级与激活开关均开启时，手动激活才按各赠礼开关执行。数量为 0 时不产生对应赠礼流水。</p>
          <div class="settings-grid">
            <div class="field"><div class="switch-line"><label>赠送积分</label><el-switch v-model="form.level_integral_status" :active-value="1" :inactive-value="0" :disabled="!editable" aria-label="赠送积分" /></div>
              <template v-if="form.level_give_integral !== null"><el-input-number :model-value="form.level_give_integral" :min="0" :max="2147483647" :precision="0" :disabled="!editable" controls-position="right" aria-label="赠送积分数量" @update:model-value="(value: unknown) => form && (form.level_give_integral = typeof value === 'number' ? value : null)" /><span class="hint">积分（非负整数）</span></template>
              <div v-else class="repair"><p>积分数量待明确修复</p><el-button v-if="canManage" :disabled="!editable" @click="repair('level_give_integral')">明确重新填写积分（从0开始）</el-button></div>
            </div>
            <div class="field"><div class="switch-line"><label>赠送储值余额</label><el-switch v-model="form.level_money_status" :active-value="1" :inactive-value="0" :disabled="!editable" aria-label="赠送储值余额" /></div>
              <el-input v-if="form.level_give_money !== null" v-model="form.level_give_money" :disabled="!editable" inputmode="numeric" maxlength="10" aria-label="赠送余额整数元"><template #append>元（整数）</template></el-input>
              <div v-else class="repair"><p>余额数量待明确修复</p><el-button v-if="canManage" :disabled="!editable" @click="repair('level_give_money')">采用当前有效整元余额重新填写</el-button></div>
              <p class="hint">仅接受整数元；历史小数实际按整元截断，原值与有效值见下方。</p>
            </div>
          </div>
          <div class="heading coupon-heading"><div class="switch-line"><label>赠送优惠券</label><el-switch v-model="form.level_coupon_status" :active-value="1" :inactive-value="0" :disabled="!editable" aria-label="赠送优惠券" /></div><el-button v-if="canManage" :disabled="!editable || form.level_give_coupon === null" @click="openCoupons">选择已发行券</el-button></div>
          <p class="hint">选择后台发放券，最多 {{ config.limits.coupons }} 张；保存不发券、不占库存，实际激活时重新核对资格。已失效历史券保留诊断，不会静默移除。</p>
          <div v-if="form.level_give_coupon === null" class="repair"><p>原优惠券集合无法安全转换，请查看原值。</p><el-button v-if="canManage" :disabled="!editable" @click="repair('level_give_coupon')">明确清空赠券并重新选择</el-button></div>
          <el-empty v-else-if="!selectedCoupons.length" description="未选择激活赠券" :image-size="65" />
          <article v-for="row in selectedCoupons" :key="row.id" class="coupon-row">
            <div class="grow"><strong>#{{ row.id }} {{ row.title || '发行不存在' }}</strong><p>{{ faceLabel(row) }} · 满 {{ row.use_min_price || '0' }} 元可用</p>
              <p class="hint">{{ couponSummary(row) }}</p><p class="hint">使用：{{ useLabel(row) }}</p><p v-if="row.issues.length" class="error">{{ row.issues.join('；') }}</p></div>
            <el-button v-if="canManage" link type="danger" :disabled="!editable" @click="removeCoupon(row.id)">移除</el-button>
          </article>
        </el-card>
        <details class="raw-section section"><summary>已保存原值与当前消费解释</summary>
          <p>当前实际配置：普通等级{{ config.effective.member_enabled ? '开启' : '关闭' }}；激活{{ config.effective.activation_required ? '开启' : '关闭' }}；积分数量 {{ config.effective.integral === null ? '非有限值，无法形成合法奖励' : config.effective.integral }}；余额 {{ config.effective.money_units }} 元；赠券 ID {{ config.effective.coupon_ids.join('、') || '无' }}。赠券组合{{ config.effective.gift_active ? '开启' : '关闭' }}。</p>
          <p>各奖励开关：积分{{ config.effective.integral_enabled ? '开启' : '关闭' }}，余额{{ config.effective.money_enabled ? '开启' : '关闭' }}，优惠券{{ config.effective.coupon_enabled ? '开启' : '关闭' }}。</p>
          <dl><template v-for="key in levelActivationKeys" :key="key"><dt>{{ keyLabel(key) }} · {{ key }}</dt><dd><pre>{{ config.raw_values[key] === null ? '（配置缺失）' : config.raw_values[key] }}</pre></dd></template></dl>
          <details v-if="config.profile_options.some(row => !row.selectable)"><summary>异常资料定义（只读）</summary><pre>{{ JSON.stringify(config.profile_options.filter(row => !row.selectable), null, 2) }}</pre></details>
        </details>
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" class="section" />
        <div class="actions footer"><span v-if="!canManage" class="hint">当前账号只读</span><el-button :disabled="busy || loading" @click="reloadDraft">重新读取配置</el-button><el-button v-if="canManage" type="primary" :disabled="!editable" :loading="writing" @click="save">保存配置</el-button></div>
      </template>
    </template>
    <el-dialog v-model="profilesVisible" title="选择激活资料" width="min(760px, 94vw)" destroy-on-close @closed="onProfilesClosed">
      <el-input v-model="profileKeyword" placeholder="搜索资料名称或提示" clearable maxlength="100" aria-label="搜索激活资料" />
      <p class="hint">已选 {{ profileChoices.size }} 项；确认只更新页面草稿，保存后才生效。</p>
      <article v-for="row in filteredProfiles" :key="row.field_key" class="profile-row"><el-checkbox :model-value="profileChoices.has(row.field_key)" :disabled="!row.selectable || !editable" @change="(value: unknown) => selectProfile(row, !!value)" :aria-label="`选择资料 ${row.definition?.info || '无效定义'}`" />
        <div class="grow"><strong>{{ row.definition?.info || '无效历史资料' }}</strong><p class="hint">{{ row.definition?.label }} · {{ row.definition?.tip }}</p><p v-if="row.definition?.singlearr.length" class="hint">{{ row.definition.singlearr.join('、') }}</p><p v-if="row.issues.length" class="error">{{ row.issues.join('；') }}</p></div></article>
      <el-empty v-if="!filteredProfiles.length" description="无匹配资料" :image-size="65" />
      <template #footer><el-button @click="closeProfiles">取消</el-button><el-button type="primary" :disabled="!editable" @click="confirmProfiles">确认选择</el-button></template>
    </el-dialog>
    <el-dialog v-model="couponsVisible" title="选择激活赠券" width="min(980px, 94vw)" destroy-on-close @closed="onCouponsClosed">
      <div class="actions search"><el-input v-model="couponKeyword" placeholder="发行券标题或精确 ID" clearable maxlength="100" aria-label="搜索激活赠券" @keyup.enter="searchCoupons" /><el-button :disabled="couponLoading" @click="searchCoupons">查询</el-button><el-button :disabled="couponLoading" @click="resetCoupons">重置</el-button></div>
      <p class="hint">跨页已选 {{ couponChoices.size }} 张；取消不更改页面草稿。时间按上海时间显示。</p>
      <div v-if="couponLoading" class="loading" v-loading="true">正在读取候选券…</div>
      <el-alert v-else-if="couponError" title="候选券读取失败" type="error" :closable="false"><p>{{ couponError }}</p><el-button @click="loadCoupons(couponPage)">重试本页</el-button></el-alert>
      <template v-else-if="couponReady"><div class="table-scroll"><el-table :data="couponRows" row-key="id" size="small" style="width: 100%">
        <el-table-column label="选择" width="60"><template #default="{ row }"><el-checkbox :model-value="couponChoices.has(row.id)" :disabled="!editable || !row.selectable" @change="(value: unknown) => selectCoupon(row, !!value)" :aria-label="`选择发行券 ${row.id}`" /></template></el-table-column>
        <el-table-column prop="id" label="ID" width="70" /><el-table-column prop="title" label="发行券" min-width="170"><template #default="{ row }"><strong>{{ row.title }}</strong><p class="hint">{{ couponSummary(row) }}</p><p v-if="row.issues.length" class="error">{{ row.issues.join('；') }}</p></template></el-table-column>
        <el-table-column label="优惠与门槛" min-width="170"><template #default="{ row }">{{ faceLabel(row) }}<p class="hint">满 {{ row.use_min_price }} 元可用</p></template></el-table-column>
        <el-table-column label="使用期限" min-width="180"><template #default="{ row }">{{ useLabel(row) }}<p class="hint">领取：{{ rangeLabel(row.start_time, row.end_time) }}</p></template></el-table-column>
      </el-table></div><p class="hint">共 {{ couponCount }} 张候选券</p><div class="pagination"><el-pagination v-model:current-page="couponPage" :page-size="10" :total="couponCount" layout="prev, pager, next" :pager-count="5" @current-change="loadCoupons" /></div></template>
      <template #footer><el-button @click="closeCoupons">取消</el-button><el-button type="primary" :disabled="!editable || couponLoading || !!couponError || !couponReady" @click="confirmCoupons">确认选择</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiLevelActivation, apiLevelActivationCoupons, apiSaveLevelActivation, levelActivationKeys, normalizeLevelActivation,
  type LevelActivationConfig, type LevelActivationSettings, type LevelActivationSave, type LevelCoupon, type LevelProfileOption, type LevelProfileSelection } from '@/api/levelActivation';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { AdminResponseError } from '@/utils/request';

const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('config.view') || auth.uniqueAuth.includes('config.manage')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('config.manage')));
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? ''}:${auth.userInfo?.level ?? ''}:${auth.uniqueAuth.join(',')}`);
const config = ref<LevelActivationConfig | null>(null), form = ref<LevelActivationSettings | null>(null);
const loading = ref(false), ready = ref(false), loadError = ref(''), formError = ref(''), notice = ref('');
const writing = ref(false), confirming = ref(false), busy = computed(() => writing.value || confirming.value);
type Stamp = { identity: string; generation: number; stored: string | null };
type Job = { stamp: Stamp; controller: AbortController };
type Pending = { body: LevelActivationSave; summary: string };
const uncertainOperation = ref<Pending | null>(null);
const editable = computed(() => canManage.value && ready.value && !loading.value && !busy.value && !uncertainOperation.value);
const couponDetails = ref(new Map<number, LevelCoupon>());
const selectedCoupons = computed(() => (form.value?.level_give_coupon ?? []).map(id => couponDetails.value.get(id)).filter((row): row is LevelCoupon => !!row));
const selectedProfiles = computed(() => (form.value?.level_extend_info ?? []).map(row => ({ ...row, option: config.value?.profile_options.find(option => option.field_key === row.field_key) })));
const profilesVisible = ref(false), profileKeyword = ref(''), profileChoices = ref(new Map<string, LevelProfileSelection>());
const filteredProfiles = computed(() => (config.value?.profile_options ?? []).filter(row => `${row.definition?.info ?? ''} ${row.definition?.tip ?? ''}`.includes(profileKeyword.value.trim())));
const couponsVisible = ref(false), couponKeyword = ref(''), couponRows = ref<LevelCoupon[]>([]), couponChoices = ref(new Map<number, LevelCoupon>());
const couponPage = ref(1), couponCount = ref(0), couponLoading = ref(false), couponReady = ref(false), couponError = ref('');
let alive = false, syncing = false, generation = 0, configVersion = 0, confirmVersion = 0, stored = localStorage.getItem('admin_session');
let couponFilter = '', profileScope: Stamp | null = null, couponScope: Stamp | null = null;
const jobs = new Map<string, Job>();
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function stamp(): Stamp { return { identity: identity.value, generation, stored }; }
function current(value: Stamp) { return alive && canView.value && value.generation === generation && value.identity === identity.value && auth.token === getToken() && value.stored === localStorage.getItem('admin_session'); }
function cancel(channel: string) { jobs.get(channel)?.controller.abort(); jobs.delete(channel); }
function start(channel: string): Job { cancel(channel); const job = { stamp: stamp(), controller: new AbortController() }; jobs.set(channel, job); return job; }
function valid(channel: string, job: Job) { return jobs.get(channel) === job && current(job.stamp); }
function finish(channel: string, job: Job) { if (!valid(channel, job)) return false; jobs.delete(channel); return true; }
function message(error: unknown) { return error instanceof Error ? error.message : '请求失败，请重试'; }
function keyLabel(key: string) { return ({ member_func_status: '会员等级启用', level_activate_status: '需要激活会员卡', level_extend_info: '激活资料', level_integral_status: '赠送积分开关', level_give_integral: '积分数量', level_money_status: '赠送余额开关', level_give_money: '余额整数元', level_coupon_status: '赠送优惠券开关', level_give_coupon: '已选发行券' } as Record<string, string>)[key] ?? key; }
function faceLabel(row: LevelCoupon) { if (row.discount_type === 1) return `满减 ${row.coupon_price} 元`; if (row.discount_type !== 2 || row.effective_pay_percent === null) return `历史优惠类型 ${row.discount_type} · 原值 ${row.coupon_price}`; const percent = BigInt(row.effective_pay_percent); return `${percent / 10n}${percent % 10n ? `.${percent % 10n}` : ''} 折（按 ${percent}% 结算；原值 ${row.coupon_price}%）`; }
function couponSummary(row: LevelCoupon) { const scope = ({ 0: '通用', 1: '品类', 2: '指定商品', 3: '品牌' } as Record<number, string>)[row.scope_type] ?? `历史范围 ${row.scope_type}`; return `${row.category === 2 ? '会员券' : row.category === 0 || row.category === 1 ? '普通券' : `历史种类 ${row.category}`} · ${scope} · 受众 ${row.app_type} · ${row.is_permanent === 1 ? '不限量' : `剩余 ${row.remain_count}`}（仅表示发行属性）`; }
function timeLabel(value: string | null) { return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未设置'; }
function rangeLabel(start: string | null, end: string | null) { return !start && !end ? '不限制' : `${timeLabel(start)} 至 ${timeLabel(end)}`; }
function useLabel(row: LevelCoupon) { return row.valid_days > 0 ? `领取后 ${row.valid_days} 天` : rangeLabel(row.use_start_time, row.use_end_time); }
function closeProfiles() { profilesVisible.value = false; profileChoices.value = new Map(); profileKeyword.value = ''; profileScope = null; }
function onProfilesClosed() { if (!profilesVisible.value) closeProfiles(); }
function closeCoupons() { cancel('coupons'); couponsVisible.value = false; couponChoices.value = new Map(); couponRows.value = []; couponLoading.value = couponReady.value = false; couponError.value = ''; couponScope = null; }
function onCouponsClosed() { if (!couponsVisible.value) closeCoupons(); }
async function load() {
  if (!current(stamp()) || busy.value) return;
  configVersion++; closeProfiles(); closeCoupons(); config.value = null; form.value = null; couponDetails.value = new Map(); ready.value = false; loadError.value = ''; formError.value = '';
  const job = start('config'); loading.value = true;
  try { const result = await apiLevelActivation(job.controller.signal); if (!valid('config', job)) return; config.value = result; form.value = clone(result.settings); couponDetails.value = new Map(result.selected_coupons.map(row => [row.id, row])); ready.value = true; }
  catch (error) { if (valid('config', job)) loadError.value = message(error); }
  finally { if (finish('config', job)) loading.value = false; }
}
async function reloadDraft() { if (busy.value || !current(stamp())) return; if (form.value && config.value && JSON.stringify(form.value) !== JSON.stringify(config.value.settings)) { const scope = stamp(), version = ++confirmVersion; confirming.value = true; try { await ElMessageBox.confirm('重新读取将放弃当前未保存草稿，是否继续？', '重新读取配置', { type: 'warning', confirmButtonText: '放弃草稿并读取', cancelButtonText: '取消' }); } catch { return; } finally { if (version === confirmVersion) confirming.value = false; } if (!current(scope) || version !== confirmVersion) return; } await load(); }
function repair(key: 'level_give_integral' | 'level_give_money' | 'level_extend_info' | 'level_give_coupon') {
  if (!editable.value || !current(stamp()) || !form.value || !config.value) return;
  if (key === 'level_give_integral') form.value.level_give_integral = 0;
  else if (key === 'level_give_money') form.value.level_give_money = config.value.effective.money_units;
  else if (key === 'level_extend_info') form.value.level_extend_info = [];
  else { form.value.level_give_coupon = []; couponDetails.value = new Map(); }
  formError.value = '';
}
function openProfiles() { if (!editable.value || !current(stamp()) || !form.value?.level_extend_info) return; closeProfiles(); profileScope = stamp(); profileChoices.value = new Map(form.value.level_extend_info.map(row => [row.field_key, { ...row }])); profilesVisible.value = true; }
function selectProfile(row: LevelProfileOption, selected: boolean) { if (!editable.value || !profilesVisible.value || !profileScope || !current(profileScope) || !row.selectable) return; const next = new Map(profileChoices.value); if (selected) { if (next.size >= 64 && !next.has(row.field_key)) return; next.set(row.field_key, next.get(row.field_key) ?? { field_key: row.field_key, required: 0 }); } else next.delete(row.field_key); profileChoices.value = next; }
function confirmProfiles() { if (!editable.value || !form.value || !profilesVisible.value || !profileScope || !current(profileScope)) return; form.value.level_extend_info = [...profileChoices.value.values()].map(row => ({ ...row })); closeProfiles(); }
function removeProfile(key: string) { if (editable.value && current(stamp()) && form.value?.level_extend_info) form.value.level_extend_info = form.value.level_extend_info.filter(row => row.field_key !== key); }
function setRequired(key: string, required: boolean) { if (!editable.value || !current(stamp()) || !config.value?.profile_options.some(row => row.field_key === key && row.selectable)) return; const row = form.value?.level_extend_info?.find(row => row.field_key === key); if (row) row.required = required ? 1 : 0; }
async function openCoupons() { if (!editable.value || !current(stamp()) || !form.value?.level_give_coupon) return; closeCoupons(); couponScope = stamp(); couponChoices.value = new Map(selectedCoupons.value.map(row => [row.id, clone(row)])); couponsVisible.value = true; couponKeyword.value = couponFilter = ''; await loadCoupons(1); }
async function loadCoupons(target = couponPage.value) {
  if (!couponsVisible.value || !couponScope || !current(couponScope) || !canManage.value || !Number.isInteger(target) || target < 1) return;
  const job = start('coupons'); couponPage.value = target; couponLoading.value = true; couponReady.value = false; couponRows.value = []; couponCount.value = 0; couponError.value = '';
  try { const result = await apiLevelActivationCoupons({ page: target, limit: 10, keyword: couponFilter }, job.controller.signal); if (!valid('coupons', job) || !couponsVisible.value) return; couponRows.value = result.list; couponCount.value = result.count; couponReady.value = true; }
  catch (error) { if (valid('coupons', job)) couponError.value = message(error); }
  finally { if (finish('coupons', job)) couponLoading.value = false; }
}
function searchCoupons() { couponFilter = couponKeyword.value.trim(); void loadCoupons(1); }
function resetCoupons() { couponKeyword.value = ''; searchCoupons(); }
function selectCoupon(row: LevelCoupon, selected: boolean) { if (!editable.value || !couponScope || !current(couponScope) || !couponReady.value || !couponRows.value.some(item => item.id === row.id && item.revision === row.revision) || !row.selectable) return; const next = new Map(couponChoices.value); if (selected) { if (next.size >= 100 && !next.has(row.id)) return; next.set(row.id, clone(row)); } else next.delete(row.id); couponChoices.value = next; }
function confirmCoupons() { if (!editable.value || !form.value || !couponScope || !current(couponScope) || !couponReady.value || couponLoading.value || couponError.value) return; form.value.level_give_coupon = [...couponChoices.value.keys()]; couponDetails.value = new Map(couponChoices.value); closeCoupons(); }
function removeCoupon(id: number) { if (!editable.value || !current(stamp()) || !form.value?.level_give_coupon) return; form.value.level_give_coupon = form.value.level_give_coupon.filter(value => value !== id); couponDetails.value.delete(id); }
function saveSummary(body: LevelActivationSave) { return `会员等级：${body.member_func_status ? '开启' : '关闭'}；需要激活：${body.level_activate_status ? '开启' : '关闭'}。\n积分：${body.level_integral_status ? '开启' : '关闭'}，${body.level_give_integral} 积分；余额：${body.level_money_status ? '开启' : '关闭'}，${body.level_give_money} 整元。\n资料：${(body.level_extend_info ?? []).map(row => `${config.value?.profile_options.find(item => item.field_key === row.field_key)?.definition?.info ?? row.field_key}（${row.required ? '必填' : '选填'}）`).join('、') || '无'}。\n赠券：${body.level_coupon_status ? '开启' : '关闭'}，${selectedCoupons.value.map(row => `#${row.id} ${row.title || '不存在'}`).join('、') || '无'}。\n仅影响之后读取配置的操作，不重置用户、不追补奖励；已开始的激活可按旧配置完成。`; }
async function save() {
  if (!editable.value || !current(stamp()) || !config.value || !form.value) return;
  let body: LevelActivationSave;
  try {
    body = normalizeLevelActivation({ ...clone(form.value), revision: config.value.revision, request_id: crypto.randomUUID(), coupon_revisions: selectedCoupons.value.map(row => ({ id: row.id, revision: row.revision })) });
    if (body.level_extend_info?.some(ref => !config.value?.profile_options.some(row => row.field_key === ref.field_key && row.selectable))) throw Error('请明确移除或重新选择无效历史资料，不能静默替换定义');
  } catch (error) { formError.value = message(error); return; }
  const scope = stamp(), version = configVersion, confirmId = ++confirmVersion, before = JSON.stringify(form.value), operation = { body, summary: saveSummary(body) };
  formError.value = ''; confirming.value = true;
  try { await ElMessageBox.confirm(operation.summary, '确认保存普通等级激活配置', { type: 'warning', confirmButtonText: '确认保存', cancelButtonText: '取消' }); }
  catch { return; } finally { if (confirmId === confirmVersion) confirming.value = false; }
  if (!current(scope) || !canManage.value || confirmId !== confirmVersion || version !== configVersion || before !== JSON.stringify(form.value) || uncertainOperation.value) return;
  const job = start('write'); writing.value = true; notice.value = '';
  try {
    const result = await apiSaveLevelActivation(body, job.controller.signal);
    if (!valid('write', job) || !canManage.value) return;
    uncertainOperation.value = null;
    if (result.cache_status === 'pending') notice.value = '配置已保存，部分缓存清理待恢复。数据库与审计已提交；请勿重复保存来处理缓存。';
    ElMessage.success(result.cache_status === 'pending' ? '配置已保存，缓存清理待恢复' : '普通等级激活配置已保存');
  } catch (error) {
    if (!valid('write', job) || !canManage.value) return;
    const rejected = error instanceof AdminResponseError && [400, 403, 404, 409, 422].includes(Number(error.status));
    uncertainOperation.value = rejected ? null : operation;
    notice.value = `${rejected ? '保存未完成' : '保存结果未确认'}：${message(error)}。请核对重新读取的配置，再决定后续操作。`;
  } finally { if (finish('write', job)) writing.value = false; }
  if (current(scope)) await load();
}
async function acknowledge() {
  if (!uncertainOperation.value || busy.value || !current(stamp())) return;
  const scope = stamp(), operation = uncertainOperation.value, version = ++confirmVersion; confirming.value = true;
  try { await ElMessageBox.confirm('仅清除本地待核对状态，不证明服务器成功或失败，不会重发保存。请先核对当前配置；之后使用新请求ID保存是一次新的配置变更。', '结束本地待核对状态', { type: 'warning', confirmButtonText: '已人工核对', cancelButtonText: '取消' }); }
  catch { return; } finally { if (version === confirmVersion) confirming.value = false; }
  if (current(scope) && version === confirmVersion && uncertainOperation.value === operation) { uncertainOperation.value = null; notice.value = ''; }
}
function invalidate() {
  generation++; configVersion++; confirmVersion++; for (const job of jobs.values()) job.controller.abort(); jobs.clear();
  if (confirming.value) ElMessageBox.close(); writing.value = confirming.value = false; closeProfiles(); closeCoupons();
  config.value = null; form.value = null; couponDetails.value = new Map(); ready.value = loading.value = false;
  loadError.value = formError.value = notice.value = ''; uncertainOperation.value = null;
}
function syncSession() { syncing = true; invalidate(); const session = getAdminSession(); auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] }); stored = localStorage.getItem('admin_session'); syncing = false; void load(); }
function syncStorage(event: StorageEvent) { if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') syncSession(); }
watch(identity, () => { if (alive && !syncing) { invalidate(); void load(); } }, { flush: 'sync' });
onMounted(() => { alive = true; window.addEventListener('admin-session-changed', syncSession); window.addEventListener('admin-auth-expired', syncSession); window.addEventListener('storage', syncStorage); syncSession(); });
onBeforeUnmount(() => { alive = false; invalidate(); window.removeEventListener('admin-session-changed', syncSession); window.removeEventListener('admin-auth-expired', syncSession); window.removeEventListener('storage', syncStorage); });
</script>

<style scoped>
.level-settings { min-width: 0; max-width: 1120px; margin: 0 auto; overflow-wrap: anywhere; }
.heading, .actions, .switch-line, .profile-row, .coupon-row { display: flex; align-items: center; gap: 12px; }
.heading, .switch-line { justify-content: space-between; }
.heading, .actions { flex-wrap: wrap; }
.heading h2 { margin: 0 0 8px; font-size: 20px; }.heading { margin-bottom: 12px; }
.hint { color: #737985; font-size: 12px; line-height: 1.7; margin: 6px 0; }.section { margin-bottom: 16px; }
.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 28px; }
.field, .grow { min-width: 0; }.grow { flex: 1; }.field .el-input-number { max-width: 100%; width: 100%; }
.profile-row, .coupon-row { padding: 14px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.coupon-row p { margin: 5px 0; }.coupon-heading { margin-top: 25px; }
.error { color: var(--el-color-danger); font-size: 12px; }.repair { color: var(--el-color-warning-dark-2); }
.repair .el-button { max-width: 100%; height: auto; white-space: normal; line-height: 1.5; }
.loading { padding: 45px 15px; text-align: center; color: #737985; }
.raw-section { border: 1px solid var(--el-border-color); border-radius: 6px; padding: 16px; font-size: 13px; }
summary { cursor: pointer; }pre { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; font-size: 12px; max-width: 100%; }
dd { margin: 5px 0 15px; }.footer { justify-content: flex-end; }.search .el-input { flex: 1; min-width: 160px; }
.table-scroll { width: 100%; max-width: 100%; overflow-x: auto; }.pagination { max-width: 100%; overflow-x: auto; }
@media (max-width: 600px) { .settings-grid { grid-template-columns: minmax(0, 1fr); }.profile-row, .coupon-row { flex-wrap: wrap; }.grow { min-width: 150px; }.heading h2 { font-size: 18px; } }
</style>
