<template>
  <el-button :disabled="disabled || !canChoose" @click="open">选择链接</el-button>
  <el-dialog v-model="visible" title="选择悬浮按钮链接" width="min(860px, calc(100vw - 24px))" append-to-body @closed="closed">
    <p class="hint">选择可执行的商城目标，或填写安全网页 / 外部小程序。旧页面替代落点会明确说明。</p>
    <el-radio-group v-model="mode" :disabled="disabled || loading || !canChoose" aria-label="链接选择方式" @change="changeMode"><el-radio value="catalog">商城目标</el-radio><el-radio value="web">自定义网页</el-radio><el-radio value="mini">外部小程序</el-radio></el-radio-group>
    <template v-if="mode === 'catalog'">
      <div class="toolbar">
        <el-select :model-value="kind" :disabled="disabled || loading || !canChoose || !categories.length" aria-label="链接目标分类" @change="changeKind"><el-option v-for="category in categories" :key="category.kind" :label="category.group + ' · ' + category.name" :value="category.kind" /></el-select>
        <el-input v-model="search" :disabled="disabled || loading || !canChoose" maxlength="100" aria-label="链接目标搜索" placeholder="搜索名称" @keyup.enter="query" clearable />
        <el-button :disabled="disabled || loading || !canChoose" @click="query">查询</el-button>
        <el-button v-if="kind === 'product'" :disabled="disabled || loading || !canChoose" @click="browseCategories">按分类筛选</el-button>
      </div>
      <div v-if="kind === 'product_category' || productParent > 0" class="breadcrumbs"><span v-if="categoryFilter">为商品选择分类：</span><el-button link :disabled="disabled || loading || !canChoose" @click="rootCategory">全部分类</el-button><el-button v-for="(item, index) in ancestors" :key="item.id" link :disabled="disabled || loading || !canChoose" @click="backTo(index)">{{ item.name }}</el-button><span v-if="kind === 'product' && productParent > 0">商品分类 #{{ productParent }}</span></div>
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <ul v-if="catalogIssues.length" class="issues"><li v-for="(issue, n) in catalogIssues" :key="n">{{ issue }}</li></ul>
      <div v-loading="loading" class="targets">
        <article v-for="item in result?.list ?? []" :key="item.kind + ':' + item.id" class="target-card">
          <el-image v-if="fabPreview(item.image_preview)" :src="fabPreview(item.image_preview)" fit="contain" />
          <div class="target-text"><strong>{{ item.name }}</strong><p v-if="item.price" class="hint">¥ {{ item.price }}</p><p v-if="item.url" class="hint">{{ item.url }}</p><p v-if="item.partial" class="issue">旧页面由当前页面承接，实际目标：{{ actualTarget(item.url) }}</p><ul class="issues"><li v-for="(issue, n) in item.issues" :key="n">{{ issue }}</li></ul></div>
          <div class="actions"><el-button v-if="kind === 'product_category' && item.has_children" :disabled="disabled || loading || !ready || !canChoose" @click="descend(item)">查看子分类</el-button><el-button :disabled="disabled || loading || !ready || !canChoose || !item.selectable" @click="choose(item)">{{ categoryFilter ? '筛选此分类商品' : '选择' }}</el-button></div>
        </article>
        <p v-if="result && !result.list.length && !loading" class="hint">暂无可选目标</p>
      </div>
      <el-pagination v-if="result" :disabled="disabled || loading || !ready || !canChoose" :current-page="result.page" :page-size="15" :total="result.count" layout="total, prev, pager, next" @current-change="load" />
    </template>
    <template v-else>
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <el-form label-position="top" :disabled="disabled || !canChoose" class="custom-form">
        <el-form-item v-if="mode === 'web'" label="HTTP / HTTPS 网页" required><el-input v-model="web" :disabled="disabled || !canChoose" maxlength="2048" aria-label="自定义网页地址" placeholder="https://example.com/path" /></el-form-item>
        <template v-else><el-form-item label="外部小程序 AppID" required><el-input v-model="appId" :disabled="disabled || !canChoose" maxlength="18" aria-label="外部小程序 AppID" placeholder="wx0123456789abcdef" /></el-form-item><el-form-item label="外部页面路径（含可选查询）" required><el-input v-model="miniPath" :disabled="disabled || !canChoose" maxlength="2000" aria-label="外部小程序页面路径" placeholder="packageA/detail/index?id=1" /></el-form-item><p class="hint">保留外部小程序原路径；仅小程序端可打开，H5 / App 会明确提示不支持。</p></template>
      </el-form>
      <el-button type="primary" :disabled="disabled || !canChoose" @click="chooseCustom">使用此链接</el-button>
    </template>
    <template #footer><el-button @click="visible = false">关闭</el-button></template>
  </el-dialog>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getToken } from '@/utils/auth';
import { apiFabLinkCategories, apiFabLinkTargets, fabLinkSafe, fabPreview, fabErrorMessage, type FabLinkCategory, type FabLinkTargets, type FabLinkKind, type FabLinkTarget } from '@/api/fabSettings';
import { resolveRegisteredPageRoute } from '../../../../uniapp-ts/src/config/navigation';
import { FabRequestScope } from './fabSettingsController';
const props = defineProps<{ disabled: boolean; editorKey: string }>(), emit = defineEmits<{ choose: [url: string, label: string] }>();
const auth = useAuthStore(), canChoose = computed(() => !props.disabled && !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('fab_settings.view')));
const identity = computed(() => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}:${props.editorKey}`);
const visible = ref(false), loading = ref(false), ready = ref(false), categories = ref<FabLinkCategory[]>([]), result = ref<FabLinkTargets | null>(null), error = ref(''), catalogIssues = ref<string[]>([]);
const mode = ref<'catalog' | 'web' | 'mini'>('catalog'), kind = ref<FabLinkKind>('basic'), search = ref(''), appliedSearch = ref(''), parent = ref(0), productParent = ref(0), categoryFilter = ref(false), ancestors = ref<Array<{ id: number; name: string }>>([]);
const web = ref(''), appId = ref(''), miniPath = ref(''); let alive = true;
const scope = new FabRequestScope(() => identity.value, () => localStorage.getItem('admin_session'), () => alive && visible.value && canChoose.value);
function actualTarget(value: string) { const split = value.indexOf('?'); return resolveRegisteredPageRoute(split < 0 ? value : value.slice(0, split), split < 0 ? '' : value.slice(split + 1)) || value; }
function clear() { scope.invalidate(); loading.value = ready.value = false; result.value = null; categories.value = []; error.value = ''; catalogIssues.value = []; }
function closed() { if (!visible.value) clear(); }
async function open() { if (!canChoose.value) return; visible.value = true; mode.value = 'catalog'; kind.value = 'basic'; search.value = appliedSearch.value = ''; parent.value = productParent.value = 0; categoryFilter.value = false; ancestors.value = []; result.value = null; web.value = appId.value = miniPath.value = ''; const job = scope.begin('categories'); loading.value = true;
  try { const response = await apiFabLinkCategories(job.controller.signal); if (!scope.valid('categories', job)) return; categories.value = response.list; catalogIssues.value = response.issues; } catch (reason) { if (scope.valid('categories', job)) error.value = fabErrorMessage(reason); } finally { if (scope.finish('categories', job)) loading.value = false; }
  if (scope.current(job.stamp) && categories.value.length) await load();
}
async function load(page = 1) { if (!scope.current(scope.stamp()) || mode.value !== 'catalog') return; const job = scope.begin('targets'); loading.value = true; ready.value = false; error.value = '';
  try { const response = await apiFabLinkTargets({ kind: kind.value, page, limit: 15, ...(appliedSearch.value ? { search: appliedSearch.value } : {}), ...(['product', 'product_category'].includes(kind.value) ? { parent_id: kind.value === 'product' ? productParent.value : parent.value } : {}) }, job.controller.signal); if (!scope.valid('targets', job)) return; result.value = response; catalogIssues.value = response.issues; ready.value = true; } catch (reason) { if (scope.valid('targets', job)) error.value = `链接读取失败，原结果仅供查看：${fabErrorMessage(reason)}`; } finally { if (scope.finish('targets', job)) loading.value = false; }
}
function query() { if (!scope.current(scope.stamp()) || loading.value) return; appliedSearch.value = search.value; void load(); }
function changeKind(value: unknown) { if (!scope.current(scope.stamp()) || loading.value || !categories.value.some(item => item.kind === value)) return; kind.value = value as FabLinkKind; parent.value = productParent.value = 0; categoryFilter.value = false; ancestors.value = []; search.value = appliedSearch.value = ''; result.value = null; void load(); }
function changeMode() { scope.invalidate(); result.value = null; ready.value = false; loading.value = false; error.value = ''; if (mode.value === 'catalog') void load(); }
function browseCategories() { if (!scope.current(scope.stamp()) || loading.value) return; kind.value = 'product_category'; parent.value = 0; categoryFilter.value = true; ancestors.value = []; search.value = appliedSearch.value = ''; void load(); }
function rootCategory() { if (!scope.current(scope.stamp()) || loading.value) return; parent.value = productParent.value = 0; ancestors.value = []; search.value = appliedSearch.value = ''; void load(); }
function descend(item: FabLinkTarget) { if (!scope.current(scope.stamp()) || loading.value || !ready.value || !item.has_children) return; parent.value = item.id; ancestors.value.push({ id: item.id, name: item.name }); search.value = appliedSearch.value = ''; void load(); }
function backTo(index: number) { if (!scope.current(scope.stamp()) || loading.value) return; ancestors.value = ancestors.value.slice(0, index + 1); parent.value = ancestors.value[index]?.id ?? 0; search.value = appliedSearch.value = ''; void load(); }
function choose(item: FabLinkTarget) { if (!scope.current(scope.stamp()) || loading.value || !ready.value || !item.selectable || !fabLinkSafe(item.url)) return; if (categoryFilter.value) { productParent.value = item.id; kind.value = 'product'; categoryFilter.value = false; parent.value = 0; search.value = appliedSearch.value = ''; void load(); return; } emit('choose', item.url, item.name + (item.partial ? '（实际目标：' + actualTarget(item.url) + '）' : '')); visible.value = false; }
function chooseCustom() { if (!scope.current(scope.stamp())) return; const value = mode.value === 'web' ? web.value.trim() : miniPath.value.trim() + '@APPID=' + appId.value.trim(); if (!fabLinkSafe(value) || mode.value === 'web' && !/^https?:\/\//iu.test(value)) { error.value = '请输入安全有效的网页，或外部小程序 AppID 与原页面路径'; return; } emit('choose', value, mode.value === 'web' ? '自定义网页' : '外部小程序（仅小程序端可打开）'); visible.value = false; }
watch(() => [identity.value, props.disabled], () => { visible.value = false; clear(); }, { flush: 'sync' });
onBeforeUnmount(() => { alive = false; scope.dispose(); });
</script>
<style scoped>
.hint{font-size:12px;color:var(--el-text-color-secondary);line-height:1.7;overflow-wrap:anywhere}.issue,.issues{font-size:12px;line-height:1.6;color:var(--el-color-warning);overflow-wrap:anywhere}.issues{margin:5px 0;padding-left:16px}.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}.toolbar .el-select{width:240px}.toolbar .el-input{width:230px}.toolbar .el-button+.el-button{margin-left:0}.targets{min-height:140px;max-height:48vh;overflow:auto;margin:12px 0}.target-card{display:flex;gap:12px;padding:12px;border:1px solid var(--el-border-color);border-radius:6px;margin:10px 0}.target-card .el-image{width:65px;height:65px;flex-shrink:0}.target-text{min-width:0;flex:1;overflow-wrap:anywhere}.actions{display:flex;flex-direction:column;gap:8px;align-items:stretch}.actions .el-button+.el-button{margin-left:0}.breadcrumbs{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px}.custom-form{margin-top:16px}.el-pagination{flex-wrap:wrap;gap:8px}
@media(max-width:600px){.toolbar .el-select,.toolbar .el-input{width:100%}.target-card{flex-wrap:wrap;padding:10px}.target-text{flex-basis:calc(100% - 80px)}.actions{flex-direction:row;flex-wrap:wrap}.targets{max-height:42vh}}
</style>

