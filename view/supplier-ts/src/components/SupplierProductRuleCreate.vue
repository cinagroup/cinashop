<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import SupplierProductRuleEditor from '@/components/SupplierProductRuleEditor.vue';
import { useSupplierProductRuleEditor } from '@/utils/supplierProductRuleEditor';
import { getSupplierProductRuleTemplates } from '@/api/productRules';
import type { SupplierProductRuleTemplate } from '@/types/productRules';

const props = defineProps<{ context: string; disabled?: boolean }>();
const emit = defineEmits<{ updated: [value: { context: string; templates: SupplierProductRuleTemplate[] }] }>();
const invalid = ref(false), refreshing = ref(false), directoryError = ref(''), notice = ref('');
let directoryGeneration = 0, directoryRequest: AbortController | undefined;
const editor = useSupplierProductRuleEditor({
  blocked: () => !!props.disabled || invalid.value || refreshing.value,
  onInvalidate() { invalid.value = true; directoryGeneration++; directoryRequest?.abort(); notice.value = ''; directoryError.value = ''; },
  onVerified: async () => { await refreshDirectory(); },
});
const { busy, loading, canManage, attempt, error } = editor;

async function refreshDirectory() {
  if (props.disabled || invalid.value || !editor.current()) return;
  const context = props.context, generation = ++directoryGeneration;
  directoryRequest?.abort(); directoryRequest = new AbortController(); refreshing.value = true; directoryError.value = '';
  try {
    const templates = await getSupplierProductRuleTemplates(directoryRequest.signal);
    if (props.disabled || invalid.value || !editor.current() || generation !== directoryGeneration || context !== props.context) return;
    emit('updated', { context, templates });
    notice.value = '规格模板已保存并核对。商品草稿与所选模板保持不变，请明确选择后套用。';
  } catch (value) {
    if (!invalid.value && editor.current() && generation === directoryGeneration)
      directoryError.value = `模板已确认保存，但商品目录刷新失败。原目录和商品草稿已保留。${value instanceof Error ? value.message : '请重试读取目录'}`;
  } finally { if (generation === directoryGeneration) refreshing.value = false; }
}
async function openCreate() {
  if (props.disabled || invalid.value || refreshing.value || !editor.current() || !canManage.value || busy.value || loading.value || attempt.value) return;
  directoryError.value = ''; notice.value = '';
  const context = props.context, catalog = await editor.load();
  if (catalog && !props.disabled && !invalid.value && editor.current() && context === props.context) await editor.openCreate();
}
watch(() => props.context, () => {
  invalid.value = true; directoryGeneration++; directoryRequest?.abort(); refreshing.value = false; notice.value = ''; directoryError.value = '';
  editor.invalidateContext();
}, { flush: 'sync' });
onBeforeUnmount(() => { directoryGeneration++; directoryRequest?.abort(); });
</script>
<template>
  <div class="product-rule-create">
    <el-button v-if="canManage" :disabled="disabled || invalid || busy || loading || refreshing || !!attempt" :loading="busy || loading || refreshing" @click="openCreate">添加规格模板</el-button>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="invalid" role="alert">商品入口或登录身份已改变，请重新进入商品页。</p>
    <p v-else-if="directoryError" role="alert">{{ directoryError }} <el-button :disabled="disabled || refreshing || busy" @click="refreshDirectory">重读商品规格模板目录</el-button></p>
    <p v-else-if="error && !editor.editing.value" role="alert">{{ error }}</p>
    <SupplierProductRuleEditor :editor="editor" product-context />
  </div>
</template>
<style scoped>
.product-rule-create { min-width: 0; }
p { margin: 8px 0 0; max-width: 560px; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
</style>
