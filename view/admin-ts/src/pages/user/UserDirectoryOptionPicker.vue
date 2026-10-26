<template>
  <el-dialog :model-value="modelValue" :title="titles[kind]" width="min(620px, calc(100vw - 24px))"
    :close-on-click-modal="false" @update:model-value="close">
    <el-alert v-if="!owner.canView.value" title="当前账号没有用户查看权限" type="warning" :closable="false" />
    <template v-else>
      <form class="option-search" @submit.prevent="search">
        <el-input v-model="searchDraft" aria-label="筛选选项名称" placeholder="搜索名称" maxlength="64" clearable />
        <el-button native-type="submit" type="primary" :loading="loading">搜索</el-button>
      </form>
      <p v-if="kind === 'labels'" class="hint">匹配任一所选标签，最多选择100个。</p>
      <div class="chosen" aria-label="当前已选条件">
        <span v-if="!selected.length" class="hint">尚未选择</span>
        <el-tag v-for="item in selected" :key="item.id" :type="missing.includes(item.id) ? 'danger' : 'info'"
          closable @close="remove(item.id)">{{ missing.includes(item.id) ? '已不可用：' : '' }}{{ item.name }}（{{ item.id }}）</el-tag>
      </div>
      <el-alert v-if="error" :title="error" type="error" :closable="false" class="notice" />
      <el-button v-if="kind === 'groups'" class="ungrouped" :aria-pressed="selected.some(item => item.id === 0)"
        @click="chooseUngrouped">未分组</el-button>
      <div v-loading="loading" class="option-rows">
        <p v-if="!loading && !error && !rows.length" class="hint">暂无匹配选项</p>
        <div v-for="row in rows" :key="row.id" class="option-row">
          <span>{{ row.name }} <small>#{{ row.id }}</small></span>
          <el-button :aria-label="`选择${row.name}`" :aria-pressed="selected.some(item => item.id === row.id)"
            :type="selected.some(item => item.id === row.id) ? 'primary' : 'default'" @click="choose(row)">
            {{ selected.some(item => item.id === row.id) ? '已选择' : '选择' }}
          </el-button>
        </div>
      </div>
      <el-pagination v-if="!loading && !error" :current-page="page" :page-size="PAGE_SIZE" :total="count" :disabled="loading"
        layout="total, prev, pager, next" class="option-pager" @current-change="load" />
    </template>
    <template #footer>
      <el-button @click="close(false)">取消</el-button>
      <el-button type="primary" :disabled="!owner.canView.value || loading || !!error || missing.some(id => selected.some(item => item.id === id))" @click="apply">确定</el-button>
    </template>
  </el-dialog>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useUserDirectoryOwner } from '@/composables/useUserDirectoryOwner';
import { apiUserFilterOptions } from '@/api/userDirectory';
import type { DirectoryOption, OptionKind } from '@/utils/userDirectoryFilters';
const props = defineProps<{ modelValue: boolean; kind: OptionKind; initial: DirectoryOption[] }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean]; apply: [value: DirectoryOption[]];
  availability: [value: { kind: OptionKind; missing_ids: number[] }];
}>();
const owner = useUserDirectoryOwner(), PAGE_SIZE = 15;
const titles = { groups: '选择用户分组', labels: '选择用户标签', levels: '选择会员等级' };
const selected = ref<DirectoryOption[]>([]), missing = ref<number[]>([]), rows = ref<DirectoryOption[]>([]);
const searchDraft = ref(''), keyword = ref(''), count = ref(0), page = ref(1), loading = ref(false), error = ref('');
let mounted = false, version = 0, abort: AbortController | null = null;
function discard() { version++; abort?.abort(); abort = null; rows.value = []; count.value = 0; loading.value = false; error.value = ''; }
function open() {
  discard(); selected.value = []; missing.value = [];
  if (!mounted || !props.modelValue || !owner.has()) return;
  selected.value = props.initial.map(item => ({ ...item })); searchDraft.value = ''; keyword.value = ''; void load(1);
}
async function load(target = page.value, fallback = true): Promise<void> {
  if (!mounted || !props.modelValue || !owner.has() || !Number.isSafeInteger(target) || target < 1 || target > 10000) return;
  discard(); const currentVersion = ++version, stamp = owner.stamp(), kind = props.kind;
  const controller = new AbortController(); abort = controller; loading.value = true; page.value = target;
  const active = () => mounted && props.modelValue && props.kind === kind && currentVersion === version && owner.current(stamp) && !controller.signal.aborted;
  const ids = selected.value.filter(item => item.id > 0).map(item => item.id);
  try {
    const result = await apiUserFilterOptions({ kind, page: target, limit: PAGE_SIZE, keyword: keyword.value || undefined,
      selected_ids: ids.length ? ids.join(',') : undefined }, controller.signal);
    if (!active()) return;
    if (!result.list.length && target > 1 && fallback) { await load(Math.max(1, Math.min(10000, Math.ceil(result.count / PAGE_SIZE))), false); return; }
    rows.value = result.list; count.value = result.count; page.value = result.count === 0 ? 1 : target; missing.value = result.missing_ids;
    selected.value = selected.value.map(item => result.selected.find(row => row.id === item.id) ?? item);
    emit('availability', { kind, missing_ids: result.missing_ids });
  } catch (failure) { if (active()) error.value = failure instanceof Error ? failure.message : '读取筛选选项失败'; }
  finally { if (currentVersion === version) { abort = null; loading.value = false; } }
}
function search() { if (!owner.has()) return; keyword.value = searchDraft.value.trim(); void load(1); }
function choose(row: DirectoryOption) {
  if (!owner.has() || !props.modelValue || loading.value || !rows.value.some(item => item.id === row.id && item.name === row.name)) return;
  if (selected.value.some(item => item.id === row.id)) { remove(row.id); return; }
  if (props.kind !== 'labels') selected.value = [{ ...row }];
  else if (selected.value.length < 100) selected.value = [...selected.value, { ...row }];
  else error.value = '最多选择100个标签，请先移除部分已选项';
}
function chooseUngrouped() { if (owner.has() && props.modelValue && props.kind === 'groups') selected.value = [{ id: 0, name: '未分组' }]; }
function remove(id: number) { if (owner.has() && props.modelValue) { selected.value = selected.value.filter(item => item.id !== id); error.value = ''; } }
function apply() {
  if (!mounted || !props.modelValue || !owner.has() || loading.value || error.value || missing.value.some(id => selected.value.some(item => item.id === id))) return;
  emit('apply', selected.value.map(item => ({ ...item }))); emit('update:modelValue', false);
}
function close(value: boolean) { if (!value) { discard(); emit('update:modelValue', false); } }
watch([() => props.modelValue, () => props.kind, owner.identity, owner.canView], open, { flush: 'sync' });
onMounted(() => { mounted = true; open(); });
onBeforeUnmount(() => { mounted = false; discard(); selected.value = []; });
</script>
<style scoped>
.option-search, .option-row { display: flex; gap: 12px; align-items: center; }
.option-search { margin-bottom: 12px; }
.option-search :deep(.el-input) { flex: 1; }
.chosen { min-height: 42px; padding: 10px; border: 1px solid #e8eaec; display: flex; flex-wrap: wrap; gap: 6px; border-radius: 4px; margin-bottom: 14px; }
.hint, small { color: #909399; font-size: 12px; }
.option-rows { min-height: 100px; }
.option-row { padding: 8px 0; justify-content: space-between; border-bottom: 1px solid #f0f0f0; }
.option-row > span { min-width: 0; overflow-wrap: anywhere; }
.option-pager { margin-top: 16px; justify-content: flex-end; flex-wrap: wrap; }
.notice, .ungrouped { margin-bottom: 12px; }
</style>
