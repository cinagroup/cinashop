<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { getShippingTemplate, getShippingTemplates, previewMode } from '@/api/supplier';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { useShippingTemplateList } from '@/utils/shippingTemplateList';
import { useShippingTemplateSelection } from '@/utils/shippingTemplateSelection';

const props = defineProps<{ modelValue: number; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [id: number] }>();
const visible = ref(false), filter = ref(''), invalidated = ref(false);
const list = useShippingTemplateList(query => getShippingTemplates({ ...query }, session.signal), () => session.isCurrent());
const selection = useShippingTemplateSelection(id => getShippingTemplate(id, session.signal), () => session.isCurrent());
const { rows, count, loading, error, applied, pages } = list;
const { selected, loading: readingSelected, error: selectedError } = selection;
const session = createSupplierSessionScope(() => {
  invalidated.value = true; visible.value = false; filter.value = ''; list.reset(); selection.reset();
}, previewMode);
const label = computed(() => selected.value?.id === props.modelValue
  ? `${selected.value.name}（${selected.value.type}） #${props.modelValue}`
  : props.modelValue ? `当前模板 #${props.modelValue}${readingSelected.value ? '（读取中）' : '（未核验）'}` : '尚未选择模板');
watch(() => props.modelValue, id => { void selection.hydrate(id); }, { immediate: true });
onBeforeUnmount(() => { list.reset(); selection.reset(); session.dispose(); });

async function open() {
  if (props.disabled || !session.isCurrent()) return;
  visible.value = true;
  await list.load({ name: filter.value, page: 1, limit: 20 });
}
async function search() { await list.load({ name: filter.value, page: 1, limit: 20 }); }
async function page(value: number) { await list.load({ ...applied.value, page: value }); }
function choose(id: number) {
  if (props.disabled || !session.isCurrent() || loading.value || error.value || !rows.value.some(row => row.id === id)) return;
  emit('update:modelValue', id); visible.value = false;
}
function clear() {
  if (!props.disabled && session.isCurrent()) emit('update:modelValue', 0);
}
</script>

<template>
  <div class="shipping-picker">
    <p role="status" aria-label="当前商品运费模板" class="selected-template">{{ invalidated ? '登录身份或权限已改变，请重新进入商品页' : label }}</p>
    <div class="picker-actions">
      <el-button :disabled="disabled || invalidated" @click="open">选择运费模板</el-button>
      <el-button v-if="modelValue" :disabled="disabled || invalidated" @click="clear">清除选择</el-button>
    </div>
    <div v-if="selectedError" role="alert">
      <p>{{ selectedError }}</p>
      <el-button :disabled="disabled || invalidated || readingSelected" @click="selection.hydrate(modelValue)">重读当前模板</el-button>
    </div>
    <el-dialog v-model="visible" title="选择商品运费模板" width="min(760px, 94vw)" append-to-body @close="list.reset">
      <p>只修改当前表单的模板选择；保存商品时服务器会再次校验归属和可用性。</p>
      <div class="picker-search">
        <el-input v-model="filter" aria-label="搜索供应商运费模板" maxlength="255" placeholder="搜索全部模板名称" @keyup.enter="search" />
        <el-button :disabled="invalidated || disabled" @click="search">搜索模板</el-button>
      </div>
      <div v-if="error" role="alert"><p>{{ error }}；列表未更新，请重试。当前商品模板选择不变。</p><el-button :disabled="loading || invalidated" @click="list.retry">重试模板列表</el-button></div>
      <div v-loading="loading" class="picker-results">
        <p v-if="!rows.length && !loading && !error">暂无匹配模板</p>
        <div v-for="row in rows" :key="row.id" class="picker-row">
          <span>#{{ row.id }} · {{ row.name }}（{{ row.type }}）</span>
          <el-button :aria-label="`选择模板 ${row.id}`" :disabled="disabled || invalidated || loading || !!error" @click="choose(row.id)">{{ row.id === modelValue ? '保持此模板' : '选择' }}</el-button>
        </div>
      </div>
      <nav v-if="!error" aria-label="商品运费模板分页" class="picker-pages">
        <span>共 {{ count }} 条 · 第 {{ applied.page }} / {{ pages }} 页</span>
        <span v-if="applied.name">查询：{{ applied.name }}</span>
        <el-button :disabled="loading || invalidated || applied.page <= 1" @click="page(applied.page - 1)">上一页模板</el-button>
        <label>跳至 <input aria-label="模板选择页码" type="number" :value="applied.page" min="1" :max="pages" :disabled="loading || invalidated" @change="page(Number(($event.target as HTMLInputElement).value))" /></label>
        <el-button :disabled="loading || invalidated || applied.page >= pages" @click="page(applied.page + 1)">下一页模板</el-button>
      </nav>
      <template #footer><el-button @click="visible = false">取消选择</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.shipping-picker { width: 100%; }
.selected-template { margin: 0 0 10px; overflow-wrap: anywhere; }
.picker-actions, .picker-search, .picker-pages { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.picker-search { margin: 12px 0; }
.picker-search .el-input { flex: 1; min-width: 160px; }
.picker-results { max-height: 45vh; overflow-y: auto; min-height: 80px; }
.picker-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.picker-row span { overflow-wrap: anywhere; min-width: 0; }
.picker-pages { margin-top: 12px; }
.picker-pages input { width: 64px; }
</style>
