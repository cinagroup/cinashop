<template>
  <div class="detail-design-settings" data-testid="product-detail-design-page">
    <div class="heading"><div><h2>商品详情设计</h2><p>设置商品详情各个模块，点击手机预览或模块名称即可编辑。</p></div><el-button data-testid="detail-reread" :disabled="!canView || controller.locked" @click="controller.reread()">读取当前版本并保留草稿</el-button></div>
    <el-alert v-if="!canView" title="没有商品详情设计查看权限" type="warning" :closable="false" />
    <template v-else>
      <el-alert v-if="!canManage" title="当前仅有查看权限，商品详情设计不可修改" type="info" :closable="false" data-testid="detail-view-only" />
      <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" data-testid="detail-read-error" />
      <el-alert v-if="state.notice" :title="state.notice" :type="state.success ? 'success' : 'warning'" :closable="false" data-testid="detail-notice" />
      <el-alert v-if="state.recoveryError" :title="state.recoveryError" type="error" :closable="false" data-testid="detail-recovery-error" />
      <el-alert v-if="state.pending" title="原请求结果尚未确认，已锁定编辑与新的提交" type="warning" :closable="false" show-icon data-testid="detail-unknown">
        <p>刷新页面会保留本账号的原请求。请先核对回执；服务端明确未找到回执后，可主动原样重试。</p>
        <div class="buttons"><el-button data-testid="detail-receipt" :disabled="state.readingReceipt || state.busy || state.confirming || state.restoring" :loading="state.readingReceipt" @click="controller.readReceipt()">读取原请求回执</el-button><el-button v-if="state.retryReady" data-testid="detail-retry-original" :disabled="!canManage || state.readingReceipt || state.busy || state.confirming || state.restoring" @click="controller.retryOriginal()">原样重试</el-button></div>
      </el-alert>
      <el-alert v-if="state.snapshot && !state.snapshot.configured && state.snapshot.editable" title="尚未保存商品详情设计，当前采用原商城默认设置。首次保存会建立配置，读取不会创建记录。" type="info" :closable="false" data-testid="detail-unconfigured" />
      <el-alert v-if="state.snapshot && !state.snapshot.editable" title="商品详情设计记录异常，所有写入已暂停，请先修复数据。下方默认示例不代表已保存的配置。" type="error" :closable="false" data-testid="detail-damaged" />
      <el-alert v-if="state.needsReread" title="本次未保存，原草稿已保留。请读取当前版本并核对，再确认保存。" type="warning" :closable="false" data-testid="detail-needs-reread" />
      <ul v-if="state.snapshot?.issues.length" class="diagnostics" data-testid="detail-diagnostics"><li v-for="issue in state.snapshot.issues" :key="issue">{{ issueLabel(issue) }}</li></ul>
      <details v-if="state.rejected" class="rejected-content" data-testid="detail-rejected-intent"><summary>核对上次未保存的全部设置</summary><p>此处保留上次请求的十九项内容。重新读取后，只读会员展示项和历史保留项会同步当前配置，新的保存需再次确认。</p><dl class="intent-grid"><template v-for="key in designKeys" :key="key"><dt>{{ fieldNames[key] }}</dt><dd>{{ formatValue(state.rejected.input.value[key]) }}</dd></template></dl></details>
      <div class="design-workspace" v-loading="state.loading || state.restoring">
        <section class="preview-panel"><div class="panel-heading"><strong>实时预览</strong><span>示例商品</span></div><div class="preview-viewport" data-testid="detail-preview-viewport"><ProductDetailDesignPreview :value="state.draft" :active="active" @select="selectModule" /></div><p class="preview-note">点击预览中的模块可编辑。隐藏模块保留编辑入口；商城展示实际商品、库存、服务与评价。</p></section>
        <section class="editor-panel" aria-label="商品详情模块设置">
          <nav class="module-picker" aria-label="选择编辑模块"><button v-for="module in modules" :key="module.id" type="button" :data-testid="`detail-module-${module.id}`" :aria-pressed="active === module.id" :class="{ chosen:active === module.id }" @click="selectModule(module.id)">{{ module.title }}</button></nav>
          <div class="editor-content" :data-testid="`detail-editor-${active}`"><h3>{{ currentModule.title }}</h3><p class="section-description">{{ currentModule.description }}</p>
            <template v-if="active === 0">
              <fieldset class="field" :disabled="controller.editorDisabled" data-testid="detail-control-navList"><legend>顶部导航</legend><div class="selection-list"><el-checkbox v-for="option in navOptions" :key="option.id" :model-value="state.draft.navList.includes(option.id)" :disabled="controller.editorDisabled" @change="(checked: unknown) => controller.toggleSelection('navList', option.id, checked)">{{ option.label }}</el-checkbox></div><p v-if="!state.draft.navList.length" class="field-warning" data-testid="detail-empty-nav">该导航请至少选择一个。当前空选择仍可保存。</p></fieldset>
              <div class="field" data-testid="detail-control-openShare"><label>顶部分享入口</label><el-radio-group :model-value="state.draft.openShare" :disabled="controller.editorDisabled" @change="(value: unknown) => controller.setFlag('openShare', value)"><el-radio :value="1">显示</el-radio><el-radio :value="0">隐藏</el-radio></el-radio-group></div>
              <div class="field" data-testid="detail-control-pictureConfig"><label>商品主图</label><el-radio-group :model-value="state.draft.pictureConfig" :disabled="controller.editorDisabled" @change="(value: unknown) => controller.setFlag('pictureConfig', value)"><el-radio :value="0">固定方图</el-radio><el-radio :value="1">高度自适应</el-radio></el-radio-group><p class="field-hint">自适应按照商品主图比例展示，视频采用固定方图。</p></div>
              <div class="field" data-testid="detail-control-swiperDot"><label>轮播指示点</label><el-radio-group :model-value="state.draft.swiperDot" :disabled="controller.editorDisabled" @change="(value: unknown) => controller.setFlag('swiperDot', value)"><el-radio :value="1">显示</el-radio><el-radio :value="0">隐藏</el-radio></el-radio-group></div>
              <fieldset class="field" :disabled="controller.editorDisabled" data-testid="detail-control-isOpen"><legend>商品信息</legend><div class="selection-list"><el-checkbox v-for="option in infoOptions" :key="option.id" :model-value="state.draft.isOpen.includes(option.id)" :disabled="controller.editorDisabled" @change="(checked: unknown) => controller.toggleSelection('isOpen', option.id, checked)">{{ option.label }}</el-checkbox></div><p v-if="historicalSelections.length" class="field-hint" data-testid="detail-historical-selections">历史保留项：{{ historicalSelections.join('、') }}。随保存原样保留。</p></fieldset>
              <div class="readonly-field" data-testid="detail-readonly-showPrice"><label>会员价格展示项</label><div class="preserved-tags"><el-tag v-for="value in state.draft.showPrice" :key="value" type="info">{{ value === 0 ? '等级会员' : 'SVIP会员' }}</el-tag><span v-if="!state.draft.showPrice.length">不展示会员价格提示</span></div><p>沿用商城已有会员价格展示设置，保存时完整保留。</p></div>
            </template>
            <template v-else-if="active === 3"><fieldset class="field" :disabled="controller.editorDisabled" data-testid="detail-control-showService"><legend>显示内容</legend><div class="selection-list service-options"><el-checkbox v-for="option in serviceOptions" :key="option.id" :model-value="state.draft.showService.includes(option.id)" :disabled="controller.editorDisabled" @change="(checked: unknown) => controller.toggleSelection('showService', option.id, checked)">{{ option.label }}</el-checkbox></div><p class="field-hint">隐藏规格入口后，购买时仍可选择商品规格。</p></fieldset></template>
            <template v-else-if="active === 7">
              <fieldset class="field" :disabled="controller.editorDisabled" data-testid="detail-control-menuList"><legend>底部菜单</legend><div class="selection-list"><el-checkbox v-for="option in footerOptions" :key="option.id" :model-value="state.draft.menuList.includes(option.id)" :disabled="controller.editorDisabled || !state.draft.menuList.includes(option.id) && state.draft.menuList.length >= 3" @change="(checked: unknown) => controller.toggleSelection('menuList', option.id, checked)">{{ option.label }}</el-checkbox></div><p class="field-hint">最多选择三项。购物车菜单与加入购物车按钮分别设置。</p></fieldset>
              <div class="field" data-testid="detail-control-showCart"><label>加入购物车按钮</label><el-radio-group :model-value="state.draft.showCart" :disabled="controller.editorDisabled" @change="(value: unknown) => controller.setFlag('showCart', value)"><el-radio :value="1">显示</el-radio><el-radio :value="0">隐藏</el-radio></el-radio-group><p class="field-hint">实际购买入口同时遵循商品库存、购买方式与购物车规则。</p></div>
            </template>
            <template v-else>
              <div v-if="currentModule.flag" class="field" :data-testid="`detail-control-${currentModule.flag}`"><label>是否显示</label><el-radio-group :model-value="state.draft[currentModule.flag]" :disabled="controller.editorDisabled" @change="(value: unknown) => currentModule.flag && controller.setFlag(currentModule.flag, value)"><el-radio :value="1">显示</el-radio><el-radio :value="0">隐藏</el-radio></el-radio-group></div>
              <div v-if="currentModule.count" class="field" :data-testid="`detail-control-${currentModule.count}`"><label>{{ currentModule.countLabel }}</label><div class="count-control"><el-slider :model-value="state.draft[currentModule.count]" :min="1" :max="currentModule.max" :step="1" :disabled="controller.editorDisabled" @change="(value: unknown) => currentModule.count && controller.setCount(currentModule.count, value)" /><el-input-number :model-value="state.draft[currentModule.count]" :min="1" :max="currentModule.max" :precision="0" controls-position="right" :disabled="controller.editorDisabled" @change="(value: unknown) => currentModule.count && controller.setCount(currentModule.count, value)" /></div><p class="field-hint">可设置 1 至 {{ currentModule.max }} 条，商城按实际可见内容展示。</p></div>
            </template>
          </div>
          <div class="editor-actions"><span class="dirty-state" data-testid="detail-dirty">{{ controller.dirty ? '草稿有未保存的修改' : '当前草稿尚未修改' }}</span><el-button v-if="canManage" data-testid="detail-save" type="primary" :disabled="controller.editorDisabled || state.needsReread" :loading="state.busy" @click="controller.save()">保存商品详情设计</el-button></div>
        </section>
      </div>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { apiProductDetailDesign, apiSaveProductDetailDesign, apiProductDetailDesignReceipt } from '@/api/productDetailDesign';
import { PRODUCT_DETAIL_DESIGN_KEYS, type ProductDetailDesignValue } from '../../../../common/productDetailDesign';
import { ProductDetailDesignController } from '../../../../common/productDetailDesignController';
import ProductDetailDesignPreview from './ProductDetailDesignPreview.vue';
type ModuleFlag = 'showSvip' | 'showRank' | 'showReply' | 'showMatch' | 'showRecommend' | 'showCommunity';
type ModuleCount = 'replyNum' | 'matchNum' | 'recommendNum' | 'communityNum';
interface Module { id:number; title:string; description:string; flag?:ModuleFlag; count?:ModuleCount; countLabel?:string; max?:number }
const modules: Module[] = [
  { id:0,title:'商品信息',description:'设置顶部导航、分享入口、主图和商品基本信息。' },
  { id:1,title:'会员信息',description:'设置 SVIP 开通卡片，商城根据会员资格和商品实际优惠展示。',flag:'showSvip' },
  { id:2,title:'排行榜',description:'设置排行入口，商城展示商品实际榜单与名次。',flag:'showRank' },
  { id:3,title:'服务与参数',description:'分别控制活动、规格入口、服务保障和商品参数。' },
  { id:4,title:'商品评价',description:'设置评价模块与预览数量。',flag:'showReply',count:'replyNum',countLabel:'评价数量',max:10 },
  { id:8,title:'种草秀',description:'设置与商品关联的种草内容和预览数量。',flag:'showCommunity',count:'communityNum',countLabel:'内容数量',max:10 },
  { id:5,title:'搭配购',description:'设置搭配套餐入口与预览数量。',flag:'showMatch',count:'matchNum',countLabel:'套餐数量',max:10 },
  { id:6,title:'优品推荐',description:'设置推荐商品与显示数量。',flag:'showRecommend',count:'recommendNum',countLabel:'商品数量',max:24 },
  { id:7,title:'底部菜单',description:'设置底部菜单和加入购物车按钮。' },
];
const navOptions = [{ id:0,label:'首页' },{ id:1,label:'搜索' },{ id:2,label:'购物车' },{ id:3,label:'我的收藏' },{ id:4,label:'个人中心' }];
const infoOptions = [{ id:0,label:'划线价' },{ id:1,label:'累计销量' },{ id:2,label:'库存' }];
const serviceOptions = [{ id:0,label:'活动' },{ id:1,label:'规格选择' },{ id:2,label:'服务保障' },{ id:3,label:'商品参数' }];
const footerOptions = [{ id:0,label:'首页' },{ id:1,label:'分享' },{ id:2,label:'客服' },{ id:3,label:'收藏' },{ id:4,label:'购物车' }];
const active = ref(0), currentModule = computed(() => modules.find(item => item.id === active.value) ?? modules[0]!);
function selectModule(id: number) { if (modules.some(item => item.id === id)) active.value = id; }
const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('product_detail_design.view')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('product_detail_design.manage')));
const identity = computed(() => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}`);
const controller = new ProductDetailDesignController(() => ({ id:auth.userInfo?.id ?? null, identity:identity.value, stored:localStorage.getItem('admin_session'), view:canView.value, manage:canManage.value }), {
  read:apiProductDetailDesign, write:apiSaveProductDetailDesign, receipt:apiProductDetailDesignReceipt, storage:sessionStorage, uuid:() => crypto.randomUUID(),
  confirm:async message => { await ElMessageBox.confirm(message, '确认保存商品详情设计', { type:'warning', confirmButtonText:'确认提交', cancelButtonText:'取消', customClass:'product-detail-design-confirm' }); },
}, value => reactive(value));
const state = controller.state, historicalSelections = computed(() => state.draft.isOpen.filter(item => item >= 3));
const labels: Record<string, string> = {
  product_detail_missing:'尚未保存商品详情设计，使用原商城默认设置。', product_detail_duplicate:'发现多条商品详情设计记录，不能自动选择其中一条。',
  product_detail_identity_invalid:'商品详情设计记录的名称、类型或生命周期异常。', product_detail_value_invalid:'商品详情设计内容损坏、字段类型错误或数量超出范围。',
};
const issueLabel = (issue: string) => labels[issue] ?? `诊断：${issue}`;
const designKeys = PRODUCT_DETAIL_DESIGN_KEYS;
const fieldNames: Record<keyof ProductDetailDesignValue, string> = { navList:'顶部导航',openShare:'顶部分享入口',pictureConfig:'主图模式',swiperDot:'轮播指示点',showPrice:'会员价格展示项（保留）',isOpen:'商品信息与历史保留项',showSvip:'会员信息',showRank:'排行榜',showService:'服务与参数',showReply:'商品评价',replyNum:'评价数量',showMatch:'搭配购',matchNum:'套餐数量',showRecommend:'优品推荐',recommendNum:'推荐数量',menuList:'底部菜单',showCart:'加入购物车按钮',showCommunity:'种草秀',communityNum:'种草内容数量' };
const formatValue = (value: ProductDetailDesignValue[keyof ProductDetailDesignValue]) => Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
let alive = false, syncing = false;
function syncStored(event?: Event) {
  if (syncing || event instanceof StorageEvent && event.key !== null && !['admin_token','admin_session'].includes(event.key)) return;
  syncing = true; if (state.confirming) ElMessageBox.close(); controller.invalidate(); active.value = 0;
  const session = getAdminSession(); auth.$patch({ token:getToken() ?? '', userInfo:session?.userInfo ?? null, menus:(session?.menus as typeof auth.menus) ?? [], uniqueAuth:session?.uniqueAuth ?? [] });
  syncing = false; void controller.activate();
}
watch(identity, () => { if (alive && !syncing) { if (state.confirming) ElMessageBox.close(); active.value = 0; void controller.activate(); } }, { flush:'sync' });
onMounted(() => { alive = true; window.addEventListener('storage', syncStored); window.addEventListener('admin-session-changed', syncStored); window.addEventListener('admin-auth-expired', syncStored); syncStored(); });
onBeforeUnmount(() => { alive = false; if (state.confirming) ElMessageBox.close(); controller.dispose(); window.removeEventListener('storage', syncStored); window.removeEventListener('admin-session-changed', syncStored); window.removeEventListener('admin-auth-expired', syncStored); });
</script>
<style scoped>
.detail-design-settings{display:grid;gap:16px;min-width:0}.heading{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}.heading h2{font-size:20px;margin:0}.heading p{color:var(--el-text-color-secondary);font-size:13px;line-height:1.6;margin:8px 0 0}.design-workspace{display:grid;grid-template-columns:minmax(350px,.85fr) minmax(380px,1.15fr);gap:20px;align-items:start;min-width:0}.preview-panel{padding:16px 12px;border-radius:12px;border:1px solid var(--el-border-color-lighter);background:#f5f7fa;min-width:0}.panel-heading{display:flex;justify-content:space-between;align-items:center;padding:0 7px 14px;font-size:14px}.panel-heading>span{color:var(--el-text-color-secondary);font-size:12px}.preview-viewport{height:690px;overflow-y:auto;overflow-x:hidden;overscroll-behavior-y:contain;display:flex;justify-content:center;scrollbar-width:thin;align-items:flex-start;padding:0 4px}.preview-note{font-size:12px;color:var(--el-text-color-secondary);line-height:1.7;padding:0 7px;margin:12px 0 0}.editor-panel{border:1px solid var(--el-border-color-lighter);border-radius:12px;background:var(--el-bg-color);overflow:hidden;min-width:0}.module-picker{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;padding:14px;background:var(--el-fill-color-lighter);border-bottom:1px solid var(--el-border-color-lighter)}.module-picker button{padding:10px 4px;border:1px solid var(--el-border-color);border-radius:6px;background:var(--el-bg-color);color:var(--el-text-color-regular);font-size:12px;cursor:pointer;white-space:normal}.module-picker button.chosen{color:var(--el-color-primary);border-color:var(--el-color-primary);background:var(--el-color-primary-light-9)}.editor-content{padding:22px;min-height:285px}.editor-content h3{font-size:16px;margin:0 0 10px}.section-description,.field-hint,.readonly-field p{font-size:12px;color:var(--el-text-color-secondary);line-height:1.7;margin:8px 0}.field{border:0;padding:0;margin:20px 0;min-width:0}.field>label,.field>legend,.readonly-field>label{display:block;font-size:13px;font-weight:500;margin-bottom:10px;padding:0}.selection-list{display:flex;gap:8px 18px;flex-wrap:wrap}.selection-list :deep(.el-checkbox){margin-right:0;height:auto;min-height:26px}.service-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.field :deep(.el-radio-group){display:flex;flex-wrap:wrap;gap:8px 18px}.field :deep(.el-radio){margin-right:0}.field-warning{font-size:12px;color:var(--el-color-warning);line-height:1.7;margin:8px 0}.readonly-field{padding:12px;border-radius:7px;background:var(--el-fill-color-lighter);border:1px solid var(--el-border-color-lighter)}.readonly-field p{margin-bottom:0}.preserved-tags{display:flex;flex-wrap:wrap;gap:7px;font-size:12px;color:var(--el-text-color-secondary)}.count-control{display:flex;align-items:center;gap:18px}.count-control .el-slider{flex:1;min-width:70px}.count-control .el-input-number{width:100px;flex:none}.editor-actions{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:15px 22px;border-top:1px solid var(--el-border-color-lighter);flex-wrap:wrap}.dirty-state{font-size:12px;color:var(--el-text-color-secondary)}.buttons{display:flex;gap:10px;flex-wrap:wrap}.buttons .el-button+.el-button{margin-left:0}.diagnostics{font-size:13px;line-height:1.7;margin:0;padding-left:22px;color:var(--el-text-color-secondary)}.rejected-content{padding:14px;border:1px solid var(--el-border-color-lighter);border-radius:8px;font-size:12px}.rejected-content summary{cursor:pointer;font-weight:500}.rejected-content p{color:var(--el-text-color-secondary);line-height:1.7}.intent-grid{display:grid;grid-template-columns:minmax(125px,1fr) minmax(90px,2fr);gap:7px 15px;margin:12px 0 0}.intent-grid dt{color:var(--el-text-color-secondary)}.intent-grid dd{margin:0;overflow-wrap:anywhere}.detail-design-settings :deep(.el-alert__content){min-width:0;overflow-wrap:anywhere}.detail-design-settings :deep(.el-alert__description p){margin:8px 0;line-height:1.7}@media(max-width:1100px){.design-workspace{grid-template-columns:minmax(330px,.8fr) minmax(320px,1fr);gap:12px}.editor-content{padding:18px}.editor-actions{padding:15px 18px}}@media(max-width:880px){.design-workspace{grid-template-columns:minmax(0,1fr)}.editor-panel{order:1}.preview-panel{order:2}.preview-viewport{height:610px}.editor-content{min-height:0}.preview-panel{padding:14px 6px}}@media(max-width:480px){.heading h2{font-size:18px}.heading .el-button{max-width:100%;white-space:normal;height:auto;min-height:32px}.module-picker{padding:10px;gap:6px}.module-picker button{font-size:11px;padding:9px 3px}.editor-content{padding:16px}.selection-list{gap:7px 12px}.editor-actions{padding:14px 16px}.editor-actions .el-button{width:100%;margin:0}.count-control{gap:14px}.preview-viewport{height:580px;padding:0}.intent-grid{grid-template-columns:minmax(105px,1fr) minmax(70px,1.2fr)}}
</style>
