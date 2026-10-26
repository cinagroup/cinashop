<template>
  <div class="level-management" :data-level-owner="canView ? owner.auth.userInfo?.id : 0">
    <el-alert v-if="!canView" title="当前账号没有会员等级查看权限" type="warning" :closable="false" show-icon />
    <template v-else>
      <el-card shadow="never" class="filter-card">
        <el-form class="level-filters" inline label-width="96px" @submit.prevent="search">
          <el-form-item label="状态："><el-select v-model="draft.is_show" aria-label="等级显示状态" clearable placeholder="请选择" :disabled="!!busy" @clear="draft.is_show = ''"><el-option label="显示" value="1" /><el-option label="不显示" value="0" /></el-select></el-form-item>
          <el-form-item label="等级名称："><el-input v-model="draft.title" aria-label="查询等级名称" placeholder="请输入等级名称" maxlength="255" clearable :disabled="!!busy" @keyup.enter="search" /></el-form-item>
          <div class="filter-actions"><el-button type="primary" :loading="loading" :disabled="!!busy" @click="search">查询</el-button><el-button :disabled="!!busy" @click="resetFilters">重置</el-button></div>
        </el-form>
      </el-card>
      <el-card shadow="never" class="catalogue-card">
        <div class="list-toolbar"><el-button v-if="canManage" type="primary" :disabled="locked || needsReview" @click="openForm()">添加会员等级</el-button><span v-else class="hint">会员等级列表</span><el-button :loading="loading" :disabled="!!busy" @click="load(page)">{{ needsReview ? '重新读取并核对' : '刷新' }}</el-button></div>
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="notice" />
        <el-alert v-if="notice" :title="notice" type="success" :closable="false" show-icon class="notice" />
        <div class="table-scroll">
          <el-table :data="list" v-loading="loading" row-key="id" stripe empty-text="暂无匹配的会员等级">
            <el-table-column prop="id" label="ID" width="80" />
            <el-table-column label="等级图标" width="110"><template #default="{ row }"><el-image v-if="image(row.icon,row.icon_preview)" :src="image(row.icon,row.icon_preview)" :preview-src-list="[image(row.icon,row.icon_preview)]" preview-teleported class="level-icon" fit="cover" @error="imageFailed(row.icon_preview || '')" /><span v-else class="hint">暂无预览</span></template></el-table-column>
            <el-table-column prop="name" label="等级名称" min-width="140" />
            <el-table-column prop="grade" label="等级" width="90" />
            <el-table-column prop="discount" label="享受折扣 (%)" width="130" />
            <el-table-column prop="expNum" label="解锁经验值" width="130" />
            <el-table-column label="是否显示" width="125"><template #default="{ row }"><el-switch v-if="row.isShow === 0 || row.isShow === 1" :model-value="row.isShow" :active-value="1" :inactive-value="0" inline-prompt active-text="显示" inactive-text="隐藏" :aria-label="`${row.name}是否显示`" :disabled="!canManage || locked || needsReview" @change="(value: unknown) => toggle(row,value)" /><el-tag v-else type="warning">未知 ({{ row.isShow }})</el-tag></template></el-table-column>
            <el-table-column prop="explain" label="等级说明" min-width="170" show-overflow-tooltip />
            <el-table-column label="操作" width="125" fixed="right"><template #default="{ row }"><template v-if="canManage"><el-button link type="primary" :disabled="locked || needsReview" @click="openForm(row)">编辑</el-button><el-divider direction="vertical" /><el-button link type="primary" :disabled="locked || needsReview" @click="remove(row)">删除</el-button></template><span v-else class="hint">仅查看</span></template></el-table-column>
          </el-table>
        </div>
        <el-pagination v-if="!loading && (!error || list.length > 0)" :current-page="page" :page-size="10" :total="count" :disabled="locked" layout="total, prev, pager, next, jumper" @current-change="changePage" />
      </el-card>
    </template>
    <el-dialog :model-value="formVisible" :title="form.id ? '编辑会员等级' : '添加会员等级'" width="min(780px, calc(100vw - 24px))" destroy-on-close :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @update:model-value="closeForm">
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="notice"><template #default><el-button v-if="needsReview" link type="primary" :loading="loading" @click="load(page)">重新读取并核对</el-button></template></el-alert>
      <el-alert v-if="notice" :title="notice" type="info" :closable="false" class="notice" />
      <el-form :model="form" label-width="112px" :disabled="locked || !canManage || needsReview" @submit.prevent="save">
        <div class="field-grid">
          <el-form-item label="等级名称" required><el-input :model-value="form.name" aria-label="等级名称" maxlength="255" placeholder="请输入等级名称" @update:model-value="(value: unknown) => updateField('name',value)" /></el-form-item>
          <el-form-item label="等级" required><el-input-number :model-value="form.grade" aria-label="等级" :min="form.id ? 0 : 1" :max="2147483647" :precision="0" @update:model-value="(value: unknown) => updateField('grade',value)" /></el-form-item>
          <el-form-item label="享受折扣 (%)" required><div><el-input :model-value="form.discount" aria-label="享受折扣" inputmode="decimal" maxlength="6" @update:model-value="(value: unknown) => updateField('discount',value)" /><p class="hint">填写0至100，90表示9折。</p></div></el-form-item>
          <el-form-item label="解锁经验值" required><el-input-number :model-value="form.exp_num" aria-label="解锁经验值" :min="form.id ? 0 : 1" :max="2147483647" :precision="0" @update:model-value="(value: unknown) => updateField('exp_num',value)" /></el-form-item>
          <el-form-item label="字体颜色" required><div class="color-field"><el-color-picker :model-value="form.color" aria-label="字体颜色" @update:model-value="(value: unknown) => updateField('color',value)" /><el-input :model-value="form.color" aria-label="字体颜色值" maxlength="32" @update:model-value="(value: unknown) => updateField('color',value)" /></div></el-form-item>
          <el-form-item label="是否显示"><el-switch :model-value="form.is_show" :active-value="1" :inactive-value="0" inline-prompt active-text="显示" inactive-text="隐藏" aria-label="编辑等级显示状态" @change="(value: unknown) => updateField('is_show',value)" /></el-form-item>
        </div>
        <div class="media-grid">
          <el-form-item label="等级图标" required><div class="media-field"><div class="media-preview card-face"><el-image v-if="image(form.icon,previews.icon)" :src="image(form.icon,previews.icon)" fit="contain" @error="imageFailed(previews.icon)" /><span v-else>图标预览</span></div><p class="hint">建议尺寸656 × 300，用于会员等级卡片。</p><el-input :model-value="form.icon" aria-label="等级图标地址" maxlength="255" placeholder="选择图库图片或填写原有图片地址" @update:model-value="(value: unknown) => updateField('icon',value)" /><ImagePicker :disabled="locked || !canManage || needsReview" :editor-key="`${editorKey()}:icon`" title="选择等级图标" @choose="(reference,preview) => setMedia('icon',reference,preview)" /></div></el-form-item>
          <el-form-item label="会员背景" required><div class="media-field"><div class="media-preview header-face"><el-image v-if="image(form.image,previews.image)" :src="image(form.image,previews.image)" fit="contain" @error="imageFailed(previews.image)" /><span v-else>背景预览</span></div><p class="hint">建议尺寸750 × 990，用于会员页面背景。</p><el-input :model-value="form.image" aria-label="会员背景地址" maxlength="255" placeholder="选择图库图片或填写原有图片地址" @update:model-value="(value: unknown) => updateField('image',value)" /><ImagePicker :disabled="locked || !canManage || needsReview" :editor-key="`${editorKey()}:image`" title="选择会员背景" @choose="(reference,preview) => setMedia('image',reference,preview)" /></div></el-form-item>
        </div>
        <el-form-item label="等级说明" required><el-input :model-value="form.explain" aria-label="等级说明" type="textarea" :rows="3" maxlength="10000" show-word-limit @update:model-value="(value: unknown) => updateField('explain',value)" /></el-form-item>
        <p class="hint import-note">新等级和解锁经验须为正整数。导入等级已有的0值或空图片可保持原样；图片预览失效时可刷新列表或重新从图库选择。</p>
      </el-form>
      <template #footer><el-button :disabled="!!busy" @click="closeForm">取消</el-button><el-button type="primary" :loading="!!busy" :disabled="locked || !canManage || needsReview" @click="save">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { useLevelDefinitions } from '@/composables/useLevelDefinitions';
import ImagePicker from '@/pages/activity/SeckillActivityImagePicker.vue';
const { owner, canView, canManage, list, count, page, loading, draft, error, notice, busy, needsReview,
  formVisible, form, previews, locked, image, imageFailed, load, search, changePage, resetFilters, openForm, closeForm,
  setMedia, updateField, editorKey, save, toggle, remove } = useLevelDefinitions();
</script>

<style scoped>
.level-management { display: grid; gap: 16px; min-width: 0; color: #303133; }.filter-card,.catalogue-card { border: 0; border-radius: 6px; }
.level-filters { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 0 14px; }.level-filters :deep(.el-form-item) { margin: 0 0 4px; }.level-filters :deep(.el-select),.level-filters :deep(.el-input) { width: 250px; }.filter-actions { display: flex; gap: 8px; margin-left: 0; }.filter-actions :deep(.el-button + .el-button) { margin-left: 0; }
.list-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 25px; }.table-scroll { min-width: 0; overflow-x: auto; }.level-icon { width: 36px; height: 36px; border-radius: 4px; cursor: pointer; }.hint { color: #8b9098; font-size: 12px; line-height: 1.65; margin: 5px 0; }.notice { margin-bottom: 14px; }.catalogue-card :deep(.el-pagination) { justify-content: flex-end; margin-top: 24px; flex-wrap: wrap; gap: 8px; }
.field-grid,.media-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 0 18px; }.field-grid :deep(.el-input-number) { width: 100%; }.color-field { display: flex; gap: 8px; width: 100%; }.color-field :deep(.el-input) { flex: 1; min-width: 0; }.media-grid { margin-top: 2px; }.media-field { display: grid; gap: 8px; width: 100%; }.media-field .hint { margin: 0; }.media-preview { height: 120px; display: flex; align-items: center; justify-content: center; overflow: hidden; background: #f7f8fa; border: 1px dashed #dcdfe6; border-radius: 4px; color: #a0a5ae; font-size: 12px; }.media-preview :deep(.el-image) { width: 100%; height: 100%; }.header-face :deep(.el-image) { max-width: 92px; }.import-note { margin-left: 112px; }
@media(max-width: 900px) { .level-filters :deep(.el-select),.level-filters :deep(.el-input) { width: 210px; } }
@media(max-width: 600px) { .level-filters { display: grid; gap: 12px; }.level-filters :deep(.el-form-item) { margin: 0; }.level-filters :deep(.el-select),.level-filters :deep(.el-input) { width: 100%; }.filter-actions { margin-left: 96px; }.field-grid,.media-grid { grid-template-columns: 1fr; }.import-note { margin-left: 0; }.catalogue-card :deep(.el-card__body),.filter-card :deep(.el-card__body) { padding: 16px; } }
</style>
