<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import ShippingTemplatePicker from '@/components/ShippingTemplatePicker.vue';
import SupplierShippingTemplateEditor from '@/components/SupplierShippingTemplateEditor.vue';
import { useSupplierShippingTemplateEditor } from '@/utils/supplierShippingTemplateEditor';
import { useAuthStore } from '@/stores/auth';
import { previewMode } from '@/api/supplier';

const props = defineProps<{ modelValue: number; context: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [id: number] }>();
const auth = useAuthStore(), catalogVersion = ref(0), invalid = ref(false), savedMessage = ref('');
const editor = useSupplierShippingTemplateEditor({
  blocked: () => !!props.disabled || invalid.value,
  onInvalidate() { invalid.value = true; savedMessage.value = ''; },
  onSaved(event) {
    if (invalid.value || !editor.current()) return;
    catalogVersion.value++;
    savedMessage.value = event.kind === 'created'
      ? `已确认创建模板 #${event.id}。商品模板选择保持不变，请从目录选择。`
      : '运费模板已更新。商品草稿及所选模板保持不变。';
  },
});
const { canView, canManage, reading, saving, sessionInvalidated, uncertainMutation, dialogVisible, editError } = editor;
watch(() => props.context, () => {
  invalid.value = true; savedMessage.value = ''; catalogVersion.value++;
  editor.session.dispose(); editor.dialogVisible.value = false;
}, { flush: 'sync' });
onBeforeUnmount(() => editor.session.dispose());

function choose(id: number) {
  if (props.disabled || invalid.value || !editor.current() || (!previewMode && !auth.can('supplier.product.manage'))) return;
  emit('update:modelValue', id);
}
function viewTemplate() {
  if (!props.disabled && !invalid.value && props.modelValue > 0) return editor.openEdit(props.modelValue);
}
function createTemplate() {
  if (!props.disabled && !invalid.value) return editor.openCreate();
}
</script>

<template>
  <div class="product-shipping-templates">
    <ShippingTemplatePicker :key="`${context}:${catalogVersion}`" :model-value="modelValue"
      :disabled="disabled || invalid || sessionInvalidated || (!previewMode && !auth.can('supplier.product.manage'))" @update:model-value="choose" />
    <div class="template-actions">
      <el-button v-if="canView && modelValue" :disabled="disabled || invalid || saving || reading" :loading="reading" @click="viewTemplate">查看运费模板</el-button>
      <el-button v-if="canManage" :disabled="disabled || invalid || saving || reading || !!uncertainMutation" @click="createTemplate">添加运费模板</el-button>
    </div>
    <p v-if="savedMessage" role="status">{{ savedMessage }}</p>
    <p v-if="invalid || sessionInvalidated" role="alert">商品入口或登录身份已改变，请重新进入商品页。</p>
    <p v-else-if="!dialogVisible && (editError || uncertainMutation)" role="alert">{{ editError || uncertainMutation }}</p>
    <SupplierShippingTemplateEditor :editor="editor" product-context />
  </div>
</template>

<style scoped>
.product-shipping-templates { width: 100%; min-width: 0; }
.template-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.template-actions .el-button + .el-button { margin-left: 0; }
p { margin: 8px 0 0; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
</style>
