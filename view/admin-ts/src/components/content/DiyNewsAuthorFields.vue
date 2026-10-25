<template>
  <div class="news-author-fields">
    <p v-if="!fields.validBlock" class="news-warning" role="alert">未选择新闻公告组件</p>
    <template v-else>
      <div class="news-options">
        <el-form-item label="新闻风格">
          <el-select :model-value="fields.style" :disabled="disabled" @update:model-value="change(['styleConfig','tabVal'], $event)">
            <el-option label="播报" :value="0" /><el-option label="列表" :value="1" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题类型">
          <el-select :model-value="fields.titleType" :disabled="disabled" @update:model-value="change(['titleConfig','tabVal'], $event)">
            <el-option label="图片" :value="0" /><el-option label="文字" :value="1" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="fields.titleType === 1" label="标题文字">
          <el-input :model-value="fields.titleText" :maxlength="limits.title" show-word-limit :disabled="disabled"
            @update:model-value="change(['titleTxtConfig','value'], $event)" />
        </el-form-item>
        <el-form-item v-else label="标题图片">
          <div class="news-destination">
            <span class="news-reference">{{ fields.imageReference || '尚未选择图片' }}</span>
            <slot name="image" :path="imagePath" :disabled="disabled || !fields.imageEditable">
              <el-button :disabled="disabled || !fields.imageEditable" @click="pickImage">选择图片</el-button>
            </slot>
          </div>
        </el-form-item>
        <el-form-item v-if="fields.showRoll" label="滚动方式">
          <el-select :model-value="fields.roll" :disabled="disabled" @update:model-value="change(['rollConfig','tabVal'], $event)">
            <el-option label="上下滚动" :value="0" /><el-option label="左右滚动（首条）" :value="1" />
          </el-select>
        </el-form-item>
        <el-form-item label="右侧按钮">
          <el-select :model-value="fields.button" :disabled="disabled" @update:model-value="change(['buttonConfig','tabVal'], $event)">
            <el-option label="显示" :value="0" /><el-option label="隐藏" :value="1" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="fields.showTone" label="播报标题色调">
          <el-select :model-value="fields.tone" :disabled="disabled" @update:model-value="change(['toneConfig','tabVal'], $event)">
            <el-option label="跟随主题风格" :value="0" /><el-option label="自定义" :value="1" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="fields.showMoreText" label="列表更多文字">
          <el-input :model-value="fields.moreText" :maxlength="limits.moreText" show-word-limit :disabled="disabled"
            @update:model-value="change(['textConfig','value'], $event)" />
        </el-form-item>
        <el-form-item v-if="fields.showMoreLink" label="更多跳转链接">
          <div class="news-destination">
            <el-input :model-value="fields.moreLink" readonly :disabled="disabled" placeholder="留空打开文章列表" />
            <slot name="link" :path="moreLinkPath" :disabled="disabled || !canPickLink(moreLinkPath)">
              <el-button :disabled="disabled || !canPickLink(moreLinkPath)" @click="pickLink(moreLinkPath)">选择链接</el-button>
            </slot>
          </div>
        </el-form-item>
      </div>
      <p v-if="fields.showRoll && fields.roll === 1" class="news-hint">左右滚动仅展示第一条已显示的公告；上下滚动每 2.5 秒切换。</p>
      <div class="news-list-heading">
        <strong>公告内容</strong>
        <el-button :disabled="disabled || !fields.canAdd" @click="rowsAction('add')">添加公告</el-button>
      </div>
      <p v-if="fields.rows.length > rowLimit" class="news-hint">已导入 {{ fields.rows.length }} 条公告，全部保留；新添加最多 {{ rowLimit }} 条。</p>
      <p v-if="!fields.listEditable" class="news-warning" role="alert">公告列表结构异常，请先在 JSON 中明确修复；原配置保持不变。</p>
      <article v-for="row in fields.rows" :key="row.index" class="news-row" :data-news-source-index="row.index">
        <div class="news-row-heading">
          <strong>第 {{ row.index + 1 }} 条</strong>
          <div class="news-row-actions">
            <el-button :disabled="disabled || row.index === 0" :aria-label="`第${row.index+1}条上移`" @click="rowsAction('move', row.index, -1)">上移</el-button>
            <el-button :disabled="disabled || row.index === fields.rows.length - 1" :aria-label="`第${row.index+1}条下移`" @click="rowsAction('move', row.index, 1)">下移</el-button>
            <el-button type="danger" plain :disabled="disabled" :aria-label="`删除第${row.index+1}条`" @click="rowsAction('remove', row.index)">删除</el-button>
          </div>
        </div>
        <p v-if="!row.record || !row.titleEditable || !row.linkEditable" class="news-warning" role="alert">该条公告包含异常字段，已原样保留。可明确删除，或在 JSON 中修复。</p>
        <el-form-item :label="`第${row.index+1}条显示`">
          <el-switch :model-value="row.shown" :disabled="disabled || !row.record" @update:model-value="change(['listConfig','list',row.index,'show'], $event)" />
        </el-form-item>
        <el-form-item :label="`第${row.index+1}条标题`">
          <el-input :model-value="row.title" :maxlength="limits.rowTitle" show-word-limit :disabled="disabled || !row.titleEditable"
            @update:model-value="change(rowTitlePath(row.index), $event)" />
        </el-form-item>
        <el-form-item :label="`第${row.index+1}条链接`">
          <div class="news-destination">
            <el-input :model-value="row.link" readonly :disabled="disabled || !row.linkEditable" />
            <slot name="link" :path="rowLinkPath(row.index)" :disabled="disabled || !row.linkEditable">
              <el-button :disabled="disabled || !row.linkEditable" @click="pickLink(rowLinkPath(row.index))">选择链接</el-button>
            </slot>
          </div>
        </el-form-item>
      </article>
      <p v-if="fields.listEditable && !fields.rows.length" class="news-hint">暂无公告，可添加后编辑标题和跳转链接。</p>
      <p v-if="error" class="news-warning" role="alert">{{ error }}</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  NEWS_AUTHOR_IMAGE_PATH, NEWS_AUTHOR_MORE_LINK_PATH, NEWS_AUTHOR_LIMITS, NEWS_AUTHOR_MAX_ROWS,
  projectNewsAuthorFields, newsAuthorPatch, newsAuthorRowsPatch, newsAuthorCanPickLink,
  newsAuthorRowTitlePath as rowTitlePath, newsAuthorRowLinkPath as rowLinkPath,
  type NewsAuthorPath,
} from '../../utils/diyNewsAuthorFields';

const props = withDefaults(defineProps<{ block: Record<string, unknown>; disabled?: boolean }>(), { disabled: false });
const emit = defineEmits<{
  change: [path: NewsAuthorPath, value: unknown];
  'pick-image': [];
  'pick-link': [path: NewsAuthorPath];
}>();
const fields = computed(() => projectNewsAuthorFields(props.block));
const limits = NEWS_AUTHOR_LIMITS, rowLimit = NEWS_AUTHOR_MAX_ROWS;
const imagePath: NewsAuthorPath = [...NEWS_AUTHOR_IMAGE_PATH], moreLinkPath: NewsAuthorPath = [...NEWS_AUTHOR_MORE_LINK_PATH];
const error = ref('');
watch(() => props.block, () => { error.value = ''; });
function change(path: NewsAuthorPath, value: unknown) {
  if (props.disabled) return;
  try { const patch = newsAuthorPatch(props.block, path, value); error.value = ''; if (patch) emit('change', patch.path, patch.value); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '新闻字段修改失败'; }
}
function rowsAction(action: 'add' | 'remove' | 'move', index = -1, direction: -1 | 1 = 1) {
  if (props.disabled) return;
  try { const patch = newsAuthorRowsPatch(props.block, action, index, direction); error.value = ''; emit('change', patch.path, patch.value); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '公告操作失败'; }
}
function canPickLink(path: NewsAuthorPath) { return newsAuthorCanPickLink(props.block, path); }
function pickImage() { if (!props.disabled && fields.value.validBlock && fields.value.titleType === 0 && fields.value.imageEditable) emit('pick-image'); }
function pickLink(path: NewsAuthorPath) { if (!props.disabled && canPickLink(path)) emit('pick-link', [...path]); }
</script>

<style scoped>
.news-author-fields{display:grid;gap:12px;width:100%;min-width:0}.news-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}.news-options :deep(.el-select){width:100%}.news-list-heading,.news-row-heading{display:flex;justify-content:space-between;align-items:center;gap:12px}.news-row{padding:12px;border:1px solid var(--el-border-color-light);border-radius:6px;min-width:0}.news-row-heading{margin-bottom:12px;flex-wrap:wrap}.news-row-actions{display:flex;gap:8px;flex-wrap:wrap}.news-row-actions :deep(.el-button+.el-button){margin-left:0}.news-destination{display:flex;align-items:center;gap:8px;width:100%;min-width:0;flex-wrap:wrap}.news-destination :deep(.el-input){flex:1;min-width:150px}.news-reference{min-width:0;overflow-wrap:anywhere;font-size:12px;color:var(--el-text-color-secondary)}.news-hint,.news-warning{margin:0;font-size:12px;line-height:1.7;overflow-wrap:anywhere}.news-hint{color:var(--el-text-color-secondary)}.news-warning{color:var(--el-color-warning-dark-2)}.news-author-fields :deep(.el-form-item){margin-bottom:14px}@media(max-width:620px){.news-options{grid-template-columns:1fr}.news-row{padding:10px}}
</style>
