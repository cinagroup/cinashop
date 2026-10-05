<template>
  <div class="category-style-settings">
    <div class="heading"><div><h2>商品分类页面</h2><p>选择分类层级和页面样式。二级分类提供 6 种样式，三级分类提供 4 种样式。</p></div><el-button :disabled="!canView || controller.locked" @click="controller.reread()">读取当前版本并保留选择</el-button></div>
    <el-alert v-if="!canView" title="没有商品分类样式查看权限" type="warning" :closable="false" />
    <template v-else>
      <el-alert v-if="!canManage" title="当前仅有查看权限，分类样式不可修改" type="info" :closable="false" />
      <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" />
      <el-alert v-if="state.notice" :title="state.notice" :type="state.success ? 'success' : 'warning'" :closable="false" />
      <el-alert v-if="state.recoveryError" :title="state.recoveryError" type="error" :closable="false" />
      <el-alert v-if="state.pending" title="原请求结果尚未确认，已锁定编辑与新的提交" type="warning" :closable="false" show-icon>
        <p>刷新页面会保留本账号的原请求。请先核对回执；服务端明确未找到回执后，可主动原样重试。</p>
        <div class="buttons"><el-button :disabled="state.readingReceipt || state.busy || state.confirming || state.restoring" :loading="state.readingReceipt" @click="controller.readReceipt()">读取原请求回执</el-button><el-button v-if="state.retryReady" :disabled="!canManage || state.readingReceipt || state.busy || state.confirming || state.restoring" @click="controller.retryOriginal()">原样重试</el-button></div>
      </el-alert>
      <el-alert v-if="state.snapshot && !state.snapshot.configured && state.snapshot.editable" title="尚未保存分类样式，当前采用原商城默认的二级分类样式 2。首次保存会建立配置，读取不会创建记录。" type="info" :closable="false" />
      <el-alert v-if="state.snapshot && !state.snapshot.editable" title="分类样式记录异常，所有写入已暂停，请先修复数据。" type="error" :closable="false" />
      <el-alert v-if="state.needsReread" title="本次未保存，原选择已保留。请读取当前版本并核对，再确认保存。" type="warning" :closable="false" />
      <ul v-if="state.snapshot?.issues.length" class="diagnostics"><li v-for="issue in state.snapshot.issues" :key="issue">{{ issueLabel(issue) }}</li></ul>
      <div class="layout-options"><span>分类等级</span><el-radio-group :model-value="state.selected.level" :disabled="controller.editorDisabled" aria-label="分类等级" @change="(value: unknown) => controller.setLevel(value)"><el-radio :value="2">二级分类</el-radio><el-radio :value="3">三级分类</el-radio></el-radio-group><span class="selected-label">已选择：{{ state.selected.level }} 级 · 样式 {{ state.selected.index + 1 }}</span></div>
      <section class="preview-panel" aria-label="商品分类样式预览">
        <el-carousel :key="state.selected.level" ref="carousel" type="card" height="550px" :autoplay="false" :initial-index="state.selected.index" trigger="click" indicator-position="none" @change="(index: number) => controller.select(index)">
          <el-carousel-item v-for="preset in available" :key="preset.key"><article class="preview-card" :class="{chosen:state.selected.index === preset.index}" :data-preview-index="preset.index"><ProductCategoryStylePreview :value="preset" /><h3>{{ preset.index + 1 }} · {{ preset.title }}</h3><p>{{ preset.description }}</p></article></el-carousel-item>
        </el-carousel>
        <div class="style-picker" role="group" aria-label="选择分类样式"><button v-for="preset in available" :key="preset.key" type="button" :aria-pressed="state.selected.index === preset.index" :disabled="controller.editorDisabled" :class="{chosen:state.selected.index === preset.index}" :data-style-index="preset.index" @click="controller.select(preset.index)">{{ preset.index + 1 }} · {{ preset.title }}</button></div>
      </section>
      <p class="hint">点击预览卡片、左右切换或选择下方样式。切换分类等级会从该等级的样式 1 开始。预览采用示例商品，商城使用实际分类、商品、规格与购物车。</p>
      <el-button v-if="canManage" type="primary" :disabled="controller.editorDisabled || state.needsReread" :loading="state.busy" @click="controller.save()">保存商品分类样式</el-button>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessageBox, type CarouselInstance } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { apiProductCategoryStyle, apiSaveProductCategoryStyle, apiProductCategoryStyleReceipt } from '@/api/productCategoryStyle';
import { PRODUCT_CATEGORY_STYLES } from '../../../../common/productCategoryStyle';
import { ProductCategoryStyleController } from '../../../../common/productCategoryStyleController';
import ProductCategoryStylePreview from './ProductCategoryStylePreview.vue';
const details: Record<string, { title: string; description: string }> = {
  '1-2': { title:'分类图标目录', description:'左侧一级分类，右侧二级分类图标，点击进入商品列表。' },
  '2-2': { title:'左侧导航 · 大图商品', description:'左侧一级分类，顶部二级分类，大图商品与购物操作。' },
  '3-2': { title:'顶部导航 · 小图商品', description:'顶部一级图标，左侧二级分类，小图商品与数量操作。' },
  '2-2-1': { title:'顶部导航 · 大图商品', description:'顶部一级图标，左侧二级分类，大图商品与购物操作。' },
  '3-2-1': { title:'左侧导航 · 小图商品', description:'左侧一级分类，顶部二级分类，小图商品与数量操作。' },
  '4-2': { title:'商品大卡片', description:'全幅商品、分类筛选、分页加载、购物车入口与商品购买。' },
  '1-3': { title:'三级分类图标目录', description:'左侧一级分类，顶部二级分类，右侧三级分类图标。' },
  '2-3': { title:'三级导航 · 大图商品', description:'顶部一级图标，左侧二级分类，三级选项与大图商品。' },
  '3-3': { title:'三级导航 · 小图商品', description:'顶部一级图标，左侧二级分类，三级选项与小图商品。' },
  '4-3': { title:'三级商品大卡片', description:'三级分类筛选、全幅商品、分页加载、购物车入口与商品购买。' },
};
const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('product_category_style.view')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('product_category_style.manage')));
const identity = computed(() => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}`);
const controller = new ProductCategoryStyleController(() => ({ id:auth.userInfo?.id ?? null, identity:identity.value, stored:localStorage.getItem('admin_session'), view:canView.value, manage:canManage.value }), {
  read:apiProductCategoryStyle, write:apiSaveProductCategoryStyle, receipt:apiProductCategoryStyleReceipt, storage:sessionStorage, uuid:() => crypto.randomUUID(),
  confirm:async message => { await ElMessageBox.confirm(message, '确认保存分类样式', { type:'warning', confirmButtonText:'确认提交', cancelButtonText:'取消' }); },
}, value => reactive(value));
const state = controller.state, carousel = ref<CarouselInstance>();
const available = computed(() => PRODUCT_CATEGORY_STYLES.filter(row => row.level === state.selected.level).map(row => ({ ...row, ...details[row.key]! })));
const labels: Record<string, string> = { category_style_missing:'尚未保存分类样式，使用默认二级分类样式 2。', category_style_duplicate:'发现多条分类样式记录，不能自动选择其中一条。', category_style_identity_invalid:'分类样式记录的名称、类型或生命周期异常。', category_style_value_invalid:'分类样式内容损坏或包含非法等级、样式编号。' };
const issueLabel = (issue: string) => labels[issue] ?? `诊断：${issue}`;
watch(() => `${state.selected.level}:${state.selected.index}`, async () => { await nextTick(); carousel.value?.setActiveItem(state.selected.index); });
let alive = false, syncing = false;
function syncStored(event?: Event) { if (syncing || event instanceof StorageEvent && event.key !== null && !['admin_token','admin_session'].includes(event.key)) return; syncing = true; if (state.confirming) ElMessageBox.close(); controller.invalidate(); const session = getAdminSession(); auth.$patch({ token:getToken() ?? '', userInfo:session?.userInfo ?? null, menus:(session?.menus as typeof auth.menus) ?? [], uniqueAuth:session?.uniqueAuth ?? [] }); syncing = false; void controller.activate(); }
watch(identity, () => { if (alive && !syncing) { if (state.confirming) ElMessageBox.close(); void controller.activate(); } }, { flush:'sync' });
onMounted(() => { alive = true; window.addEventListener('storage', syncStored); window.addEventListener('admin-session-changed', syncStored); window.addEventListener('admin-auth-expired', syncStored); syncStored(); });
onBeforeUnmount(() => { alive = false; controller.dispose(); window.removeEventListener('storage', syncStored); window.removeEventListener('admin-session-changed', syncStored); window.removeEventListener('admin-auth-expired', syncStored); });
</script>
<style scoped>
.category-style-settings{display:grid;gap:16px;min-width:0}.heading{display:flex;gap:16px;justify-content:space-between;align-items:center;flex-wrap:wrap}.heading h2{font-size:20px;margin:0}.heading p,.hint{font-size:13px;color:var(--el-text-color-secondary);line-height:1.7}.layout-options{display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:10px 16px;border:1px solid var(--el-border-color-lighter);border-radius:8px;background:#fff}.layout-options>span:first-child{font-size:14px}.selected-label{font-size:13px;color:var(--el-color-primary);margin-left:auto}.preview-panel{background:#f5f7fb;border:1px solid var(--el-border-color-lighter);padding:16px 12px;border-radius:12px;overflow:hidden;min-width:0}.preview-card{max-width:320px;margin:auto;padding:9px 6px;border:2px solid transparent;border-radius:23px}.preview-card.chosen{border-color:var(--el-color-primary)}.preview-card h3{font-size:13px;text-align:center;margin:10px 0 4px}.preview-card>p{font-size:11px;color:#777;text-align:center;margin:0;line-height:1.6}.style-picker{display:flex;flex-wrap:wrap;justify-content:center;gap:8px}.style-picker>button{border:1px solid var(--el-border-color);border-radius:6px;padding:9px 11px;background:#fff;color:var(--el-text-color-regular);cursor:pointer;font-size:12px}.style-picker>button.chosen{border-color:var(--el-color-primary);background:var(--el-color-primary-light-9);color:var(--el-color-primary)}.style-picker>button:disabled{cursor:default;opacity:.6}.buttons{display:flex;gap:10px;flex-wrap:wrap}.buttons .el-button+.el-button{margin-left:0}.diagnostics{font-size:13px;line-height:1.7}.category-style-settings :deep(.el-alert__content){overflow-wrap:anywhere;min-width:0}.category-style-settings :deep(.el-carousel__mask){background:transparent}.category-style-settings :deep(.el-carousel__arrow){background:#6c7a92b8}.category-style-settings :deep(.el-carousel__item){overflow:visible}.category-style-settings :deep(.el-carousel__container){min-width:0}@media(max-width:900px){.category-style-settings :deep(.el-carousel__item--card){width:80%;left:-15%}.preview-panel{padding:12px 6px}}@media(max-width:600px){.heading h2{font-size:18px}.heading .el-button{max-width:100%;white-space:normal;height:auto;min-height:32px}.layout-options{gap:8px 12px;padding:10px}.selected-label{margin-left:0;width:100%}.preview-panel{padding:12px 0}.preview-card{max-width:292px}.category-style-settings :deep(.el-carousel__item--card){width:100%;left:-25%}.style-picker{padding:0 10px}.style-picker>button{flex:1 1 125px}.category-style-settings :deep(.el-carousel__arrow){z-index:5}}
</style>
