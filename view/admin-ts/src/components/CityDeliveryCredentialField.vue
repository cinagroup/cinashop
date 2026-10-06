<template>
  <section class="credential-field" :aria-label="label">
    <div class="credential-heading"><strong>{{ label }}</strong><span class="credential-status">{{ statusLabel }}</span></div>
    <el-radio-group :model-value="action" :disabled="disabled" :aria-label="`${label}处理方式`" @change="changeAction">
      <el-radio value="keep" :disabled="disabled">保留</el-radio>
      <el-radio value="replace" :disabled="disabled">替换</el-radio>
      <el-radio value="clear" :disabled="disabled">清除</el-radio>
    </el-radio-group>
    <el-input v-if="action === 'replace'" :model-value="value" :disabled="disabled" :maxlength="limit" type="password" show-password
      autocomplete="new-password" :aria-label="`${label}新值`" placeholder="输入新的凭据；不会回显现有值" @update:model-value="(next: string) => emit('value', next)" />
    <p v-if="action === 'replace'" class="hint">最多 {{ limit }} 个 UTF-8 字节。新值仅用于这次准备，不保存到浏览器存储。</p>
    <p v-else-if="action === 'clear'" class="clear-note">确认保存后清除该项。若相关配送仍开启且需要此项，保存会被拒绝。</p>
    <p v-else class="hint">保持现有配置。关闭配送开关不会清除凭据。</p>
  </section>
</template>
<script setup lang="ts">
defineProps<{ label: string; statusLabel: string; action: 'keep' | 'replace' | 'clear'; value: string; limit: number; disabled: boolean }>();
const emit = defineEmits<{ action: [value: 'keep' | 'replace' | 'clear']; value: [value: string] }>();
function changeAction(value: unknown) { if (value === 'keep' || value === 'replace' || value === 'clear') emit('action', value); }
</script>
<style scoped>
.credential-field{display:grid;gap:10px;padding:16px;border:1px solid var(--el-border-color-lighter);border-radius:8px;min-width:0}.credential-heading{display:flex;gap:12px;justify-content:space-between;align-items:baseline;flex-wrap:wrap}.credential-status,.hint{font-size:12px;color:var(--el-text-color-secondary)}.hint,.clear-note{margin:0;line-height:1.7;overflow-wrap:anywhere}.clear-note{font-size:12px;color:#b54708}.credential-field :deep(.el-radio-group){display:flex;gap:12px;flex-wrap:wrap}.credential-field :deep(.el-radio){margin-right:0}.credential-field :deep(.el-input){width:100%;min-width:0}@media(max-width:600px){.credential-field{padding:12px}.credential-heading{align-items:flex-start;flex-direction:column;gap:6px}}
</style>
