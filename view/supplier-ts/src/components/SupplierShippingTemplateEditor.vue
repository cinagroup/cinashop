<script setup lang="ts">
import { Delete, Plus } from '@element-plus/icons-vue';
import type { SupplierShippingEditor } from '@/utils/supplierShippingTemplateEditor';
const props = defineProps<{ editor: SupplierShippingEditor; productContext?: boolean }>();
const { form, saving, reading, editError, needsReload, sessionInvalidated, uncertainMutation, dialogVisible, creation, cities,
  canManage, blocked, cascaderProps, unitLabel, isNationwide, addRegion, addFreeRule, addNoDeliveryRule, cancelEditor, reloadEditor, creationAction, submit } = props.editor;
</script>
<template>
    <el-dialog v-if="!sessionInvalidated" v-model="dialogVisible" class="supplier-shipping-dialog" align-center :title="form.id ? (canManage ? '编辑运费模板' : '查看运费模板') : '新增运费模板'" width="min(1080px, 94vw)" append-to-body destroy-on-close @close="cancelEditor"
      :close-on-click-modal="!saving && !reading" :close-on-press-escape="!saving && !reading" :show-close="!saving && !reading">
      <p v-if="productContext" class="product-context-note">保存模板会影响已绑定它的商品；当前商品草稿不会自动保存。</p>
      <el-alert v-if="uncertainMutation" class="edit-error" :title="uncertainMutation" type="error" :closable="false" show-icon />
      <el-alert v-if="editError" class="edit-error" :title="editError" type="error" :closable="false" show-icon
        :description="needsReload ? '当前输入已保留；保存已暂停。请先复制需要的内容，再重新读取最新模板核对。' : '当前输入已保留。'" />
      <el-alert v-if="creation" class="edit-error" :title="creation.receipt ? `已确认创建，模板 ID：${creation.receipt.id}` : '已保存原始创建请求，刷新或重入后可恢复'"
        :type="creation.receipt ? 'success' : 'warning'" :closable="false" show-icon
        description="当前表单已冻结。回执仅证明曾创建；模板之后被删除或转移时不代表仍可访问。不要清除浏览器数据。" />
      <el-form label-position="top" class="shipping-form" :disabled="saving || reading || blocked || !canManage || !!creation">
        <div class="form-grid top-grid">
          <el-form-item label="模板名称" required><el-input v-model="form.name" maxlength="255" show-word-limit /></el-form-item>
          <el-form-item label="计费方式"><el-radio-group v-model="form.type"><el-radio-button :value="1">按件数</el-radio-button><el-radio-button :value="2">按重量</el-radio-button><el-radio-button :value="3">按体积</el-radio-button></el-radio-group></el-form-item>
          <el-form-item label="排序"><el-input-number v-model="form.sort" :min="0" :max="2147483647" /></el-form-item>
        </div>

        <section class="rule-section">
          <div class="rule-heading"><div><h3>配送区域及运费</h3><p>默认全国规则必须保留；更具体的城市规则优先匹配</p></div><el-button :icon="Plus" @click="addRegion">添加区域</el-button></div>
          <div v-for="(rule, index) in form.region_info" :key="`region-${index}`" class="rule-row region-row">
            <div class="region-picker">
              <strong>{{ index === 0 && isNationwide(rule) ? "默认全国" : `配送区域 ${index + 1}` }}</strong>
              <el-cascader v-if="!(index === 0 && isNationwide(rule))" v-model="rule.city_ids" :options="cities" :props="cascaderProps" collapse-tags collapse-tags-tooltip clearable filterable placeholder="选择省/市" />
            </div>
            <label>首{{ unitLabel }}<el-input v-model="rule.first" /></label>
            <label>首费（元）<el-input v-model="rule.first_price" /></label>
            <label>续{{ unitLabel }}<el-input v-model="rule.continue" /></label>
            <label>续费（元）<el-input v-model="rule.continue_price" /></label>
            <el-button v-if="index > 0" text type="danger" :icon="Delete" aria-label="删除配送规则" @click="form.region_info.splice(index, 1)" />
          </div>
        </section>

        <section class="rule-section">
          <div class="rule-heading"><div><h3>指定包邮</h3><p>计量和商品金额同时达到门槛时免运费</p></div><el-switch v-model="form.appoint" :active-value="1" :inactive-value="0" /></div>
          <template v-if="form.appoint">
            <div v-for="(rule, index) in form.appoint_info" :key="`free-${index}`" class="rule-row compact-rule">
              <el-cascader v-model="rule.city_ids" :options="cities" :props="cascaderProps" collapse-tags collapse-tags-tooltip clearable filterable placeholder="选择包邮区域" />
              <label>包邮计量（{{ unitLabel }}）<el-input v-model="rule.number" /></label>
              <label>商品金额（元）<el-input v-model="rule.price" /></label>
              <el-button text type="danger" :icon="Delete" aria-label="删除包邮规则" @click="form.appoint_info.splice(index, 1)" />
            </div>
            <el-button plain :icon="Plus" @click="addFreeRule">添加包邮区域</el-button>
          </template>
        </section>

        <section class="rule-section">
          <div class="rule-heading"><div><h3>指定不送达</h3><p>命中禁配区域时，下单会明确失败，不会退化成零运费</p></div><el-switch v-model="form.no_delivery" :active-value="1" :inactive-value="0" /></div>
          <template v-if="form.no_delivery">
            <div v-for="(rule, index) in form.no_delivery_info" :key="`deny-${index}`" class="rule-row no-delivery-row">
              <el-cascader v-model="rule.city_ids" :options="cities" :props="cascaderProps" collapse-tags collapse-tags-tooltip clearable filterable placeholder="选择禁配区域" />
              <el-button text type="danger" :icon="Delete" aria-label="删除禁配规则" @click="form.no_delivery_info.splice(index, 1)" />
            </div>
            <el-button plain :icon="Plus" @click="addNoDeliveryRule">添加禁配区域</el-button>
          </template>
        </section>
      </el-form>
      <template #footer>
        <el-button :disabled="saving || reading" @click="cancelEditor">取消</el-button>
        <el-button v-if="form.id" :disabled="saving || reading" :loading="reading" @click="reloadEditor">重新读取模板</el-button>
        <template v-if="creation">
          <el-button :disabled="saving || blocked || !canManage" @click="creationAction('recover')">恢复查询</el-button>
          <el-button v-if="!creation.receipt" :disabled="saving || blocked || !canManage" @click="creationAction('send')">使用原请求重试</el-button>
          <el-button v-else type="primary" :disabled="saving || blocked || !canManage" @click="creationAction('acknowledge')">确认完成</el-button>
        </template>
        <el-button v-else type="primary" :loading="saving" :disabled="reading || blocked || needsReload || !canManage || !!uncertainMutation" @click="submit">保存模板</el-button>
      </template>
    </el-dialog>
</template>
<style scoped>
.product-context-note { margin: 0 0 12px; line-height: 1.6; }

.edit-error { margin-bottom: 12px; }
:global(.supplier-shipping-dialog) { display: flex; flex-direction: column; max-height: calc(100dvh - 24px); }
:global(.supplier-shipping-dialog .el-dialog__body) { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
:global(.supplier-shipping-dialog .el-dialog__header), :global(.supplier-shipping-dialog .el-dialog__footer), .edit-error { flex-shrink: 0; }
.shipping-form { flex: 1; min-height: 0; max-height: 68vh; overflow-y: auto; padding-right: 8px; }
.top-grid { grid-template-columns: minmax(240px, 1fr) minmax(300px, 1fr) 160px; }
.rule-section { padding: 20px 0; border-top: 1px solid var(--border); }
.rule-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 14px; }
.rule-heading h3 { margin: 0 0 4px; font-size: 16px; }
.rule-heading p { margin: 0; color: var(--text-muted); font-size: 13px; }
.rule-row { display: grid; align-items: end; gap: 12px; padding: 14px; margin-bottom: 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); }
.region-row { grid-template-columns: minmax(220px, 2fr) repeat(4, minmax(105px, 1fr)) 34px; }
.compact-rule { grid-template-columns: minmax(260px, 2fr) minmax(140px, 1fr) minmax(140px, 1fr) 34px; }
.no-delivery-row { grid-template-columns: minmax(260px, 1fr) 34px; }
.rule-row label { display: grid; gap: 6px; color: var(--text-muted); font-size: 12px; }
.region-picker { display: grid; gap: 8px; }
.region-picker .el-cascader, .compact-rule .el-cascader, .no-delivery-row .el-cascader { width: 100%; }
@media (max-width: 900px) {
  .top-grid { grid-template-columns: 1fr; }
  .region-row, .compact-rule { grid-template-columns: 1fr 1fr; }
  .region-picker, .compact-rule .el-cascader { grid-column: 1 / -1; }
  .no-delivery-row { grid-template-columns: 1fr auto; }
}
</style>
