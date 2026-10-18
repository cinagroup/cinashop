<script setup lang="ts">
import type { SupplierProductRuleEditor } from '@/utils/supplierProductRuleEditor';
const props = defineProps<{ editor: SupplierProductRuleEditor; productContext?: boolean }>();
const { editing, editId, busy, attempt, blocked, canManage, form, error, submitDisabled, recoveryRead,
  addDimension, removeDimension, closeEditor, finishAttempt, recover, submit } = props.editor;
</script>
<template>
    <el-dialog v-model="editing" class="supplier-product-rule-dialog" append-to-body align-center :title="editId ? '编辑规格模板' : '新增规格模板'" width="min(760px, 94vw)" :before-close="closeEditor" :close-on-click-modal="false" :close-on-press-escape="!busy && !attempt">
      <p v-if="productContext" class="product-context-note">这里只保存规格模板，不会自动套用或保存当前商品。商品草稿保持不变；请明确选择模板并确认套用。</p>
      <el-alert v-if="error" class="editor-error" :title="error" type="error" :closable="false" show-icon />
      <el-form label-position="top" class="rule-form"><el-form-item label="模板名称" required><el-input v-model="form.rule_name" :disabled="blocked || !canManage || busy || !!attempt" show-word-limit placeholder="例如：服装颜色尺码" /></el-form-item><section class="dimension-editor"><div class="dimension-heading"><div><h3>规格维度</h3><p>每个模板支持1至3个维度，每个维度最多50个值</p></div><el-button :disabled="blocked || !canManage || busy || !!attempt || form.spec.length >= 3" @click="addDimension">添加维度</el-button></div><div v-for="(dimension, index) in form.spec" :key="index" class="dimension-row"><el-input v-model="dimension.value" :disabled="blocked || !canManage || busy || !!attempt" placeholder="规格名称，如颜色" /><el-select v-model="dimension.detail" :disabled="blocked || !canManage || busy || !!attempt" multiple filterable allow-create default-first-option placeholder="输入规格值后回车" /><el-button text type="danger" :disabled="blocked || !canManage || busy || !!attempt || form.spec.length === 1" aria-label="删除规格维度" @click="removeDimension(index)">删除</el-button></div></section><el-alert title="模板只复制规格结构" type="info" :closable="false" show-icon description="模板不会改写已保存商品。套用时将生成新的规格行，请核对价格、库存与图片后保存商品。" /><el-alert v-if="attempt" title="结果待核对，请读取当前模板事实，不要重复保存" type="warning" :closable="false" /></el-form>
      <template #footer><template v-if="attempt"><el-button :disabled="blocked || busy || !recoveryRead" @click="finishAttempt">结束本次操作</el-button><el-button type="primary" :loading="busy" :disabled="blocked || busy" @click="recover">核对执行结果</el-button></template><template v-else><el-button :disabled="busy" @click="closeEditor()">取消</el-button><el-button type="primary" :loading="busy" :disabled="submitDisabled" @click="submit">保存模板</el-button></template></template>
    </el-dialog>
</template>
<style scoped>
.product-context-note { margin: 0 0 12px; line-height: 1.6; }
.editor-error { margin-bottom: 12px; flex-shrink: 0; }
:global(.supplier-product-rule-dialog) { display: flex; flex-direction: column; max-height: calc(100dvh - 24px); }
:global(.supplier-product-rule-dialog .el-dialog__body) { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
:global(.supplier-product-rule-dialog .el-dialog__header), :global(.supplier-product-rule-dialog .el-dialog__footer) { flex-shrink: 0; }
.rule-form { display: grid; gap: 4px; min-height: 0; max-height: 64dvh; overflow-y: auto; }
.dimension-editor { padding: 18px 0; border-top: 1px solid var(--border); }
.dimension-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 14px; }
.dimension-heading h3 { margin: 0 0 4px; font-size: 16px; }
.dimension-heading p { margin: 0; color: var(--text-muted); font-size: 13px; }
.dimension-row { display: grid; grid-template-columns: minmax(150px, .7fr) minmax(280px, 1.6fr) 60px; align-items: start; gap: 12px; margin-bottom: 12px; }
.dimension-row .el-select { width: 100%; }
@media (max-width: 720px) {
  .dimension-heading { align-items: stretch; flex-direction: column; }
  .dimension-row { grid-template-columns: 1fr 60px; }
  .dimension-row .el-select { grid-column: 1 / -1; grid-row: 2; }
  :global(.supplier-product-rule-dialog .el-dialog__footer) { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
  :global(.supplier-product-rule-dialog .el-dialog__footer .el-button + .el-button) { margin-left: 0; }
}
</style>
