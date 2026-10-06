<template>
  <main class="distributor-catalog">
    <header class="heading"><div><h2>{{ title }}</h2><p class="hint">{{ kind === 'level' ? '维护分销等级和一级、二级返佣上浮。等级与购物会员等级分别管理。' : '每个等级的所有开启任务全部完成才能升级；历史 is_must 仅供核对，不改变规则。' }}</p></div><el-button v-if="canView" :disabled="loading || busy || confirming || restoring || readingReceipt" @click="reload">重新读取</el-button></header>
    <el-alert v-if="!canView" :title="`当前账号没有${title}查看权限`" type="warning" :closable="false" show-icon />
    <template v-else>
      <el-alert v-if="!canManage" title="当前账号仅可查看" type="info" :closable="false" show-icon />
      <el-alert v-if="recoveryError" :title="recoveryError" type="error" :closable="false" show-icon />
      <el-alert v-if="pending" title="有一项分销设置提交结果尚未确认，已暂停新的写入" type="warning" :closable="false" show-icon>
        <template #default><template v-if="canReadPending"><p>{{ operationLabel(pending.operation) }}；原请求 {{ pending.input.request_id }}。</p><div class="buttons"><el-button :loading="readingReceipt" :disabled="busy || confirming || restoring" @click="readReceipt">读取提交结果</el-button><el-button v-if="retryReady && canRetryPending" type="primary" :disabled="busy || confirming || readingReceipt" @click="retryOriginal">重新提交原请求</el-button></div><details><summary>保留的原请求</summary><pre>{{ JSON.stringify(pending, null, 2) }}</pre></details></template><p v-else>原提交所属页面的查看权限已变化，请恢复相应权限后核对原请求结果。</p></template>
      </el-alert>
      <el-alert v-if="notice" :title="notice" :type="noticeSuccess ? 'success' : 'warning'" :closable="false" show-icon />
      <el-alert v-if="rejectedDraft && !draftMatchesPage" title="此前有已确认未保存的编辑字段，可前往原页面恢复" type="info" :closable="false"><template #default><el-button v-if="canRestoreOtherDraft" :disabled="locked" @click="goRejectedDraft">前往原编辑页面</el-button></template></el-alert>
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon><template #default><p v-if="snapshot">下方保留上次读取的数据，尚未确认最新状态；请重新读取后再修改。</p></template></el-alert>
      <el-alert v-if="snapshot?.issues.length" title="请核对历史数据或基础配置" type="warning" :closable="false"><template #default><ul><li v-for="(issue, index) in snapshot.issues.slice(0, 50)" :key="index">{{ issue }}</li></ul><p v-if="snapshot.issues.length > 50">共 {{ snapshot.issues.length }} 项诊断，此处列前 50 项；各记录诊断随列表分页显示，孤儿任务可在下方分页处理。</p></template></el-alert>
      <section v-if="kind === 'task'" class="parents" aria-label="选择任务所属等级">
        <p v-if="currentParent" class="parent-title">当前等级：{{ currentParent.name }} · 等级 {{ currentParent.grade }} · {{ statusLabel(currentParent.status) }}</p>
        <div class="toolbar"><el-input v-model="parentKeyword" aria-label="搜索父等级" maxlength="100" placeholder="搜索等级名称" :disabled="locked || parentLoading" @keyup.enter="searchParents" /><el-button :disabled="locked || parentLoading" @click="searchParents">查询父等级</el-button><el-select :model-value="selectedParentId || undefined" aria-label="任务所属等级" placeholder="请选择等级" :disabled="locked || parentLoading" @update:model-value="selectParent"><el-option v-for="item in parentOptions" :key="item.id" :value="item.id" :label="`${item.name} · 等级${item.grade} · ${statusLabel(item.status)}`" /></el-select></div>
        <p v-if="parentError" class="error">{{ parentError }}</p><el-pagination v-if="parents" :current-page="parents.page" :page-size="20" :total="parents.count" layout="total, prev, pager, next" :disabled="locked || parentLoading" @current-change="parentPageChanged" />
        <p class="hint">此选择器只返回等级名称、级别与显示状态，不授予等级编辑权限。</p>
      </section>
      <section v-if="kind === 'task' && orphanIds.length" class="parents orphan-tasks" aria-label="孤儿任务修复">
        <p class="parent-title">孤儿任务（{{ orphanIds.length }} 项）</p><p class="hint">以下任务的原父等级不存在或已删除。可确认删除任务；已有完成历史保留，不提供移动或修改操作。</p>
        <div v-for="id in visibleOrphanIds" :key="id" class="orphan-row"><span>孤儿任务 #{{ id }}</span><el-button v-if="canManage" type="danger" link :disabled="locked || !orphanReady" @click="removeOrphan(id)">删除孤儿任务 #{{ id }}</el-button><span v-else class="hint">仅查看</span></div>
        <el-pagination :current-page="orphanPage" :page-size="20" :total="orphanIds.length" layout="total, prev, pager, next" :disabled="locked" @current-change="orphanPage = $event" />
      </section>
      <section v-if="kind === 'level' && levelSnapshot" class="config-summary">
        <p>基础分销状态：{{ levelSnapshot.config.enabled === null ? '未能确认' : levelSnapshot.config.enabled ? '已开启' : '已关闭' }} · 一级基础返佣 {{ ratioLabel(levelSnapshot.config.one_ratio) }} · 二级基础返佣 {{ ratioLabel(levelSnapshot.config.two_ratio) }}</p>
        <p class="hint">上浮后比例 = 基础返佣比例 × (1 + 上浮百分比 ÷ 100)。例如一级上浮 10% 后为 {{ ratioLabel(distributorRatio(levelSnapshot.config.one_ratio, 10)) }}。基础值缺失或无效时不猜测比例。</p>
      </section>
      <section v-if="kind === 'level' || selectedParentId" class="toolbar" aria-label="分销设置筛选">
        <el-input v-model="draftKeyword" aria-label="名称查询" maxlength="100" :placeholder="kind === 'level' ? '搜索等级名称' : '搜索任务名称'" :disabled="locked" @keyup.enter="query" />
        <el-select v-model="draftStatus" aria-label="显示状态筛选" placeholder="全部状态" :disabled="!canView || locked"><el-option label="全部状态" value="all" /><el-option label="显示" :value="1" /><el-option label="隐藏" :value="0" /></el-select><el-button :disabled="locked" @click="query">查询</el-button><el-button v-if="canManage" type="primary" :disabled="!writable || locked" @click="add">{{ kind === 'level' ? '添加等级' : '添加等级任务' }}</el-button>
      </section>
      <div v-if="kind === 'level' || selectedParentId" v-loading="loading" class="table-wrap">
        <el-table :data="snapshot?.list || []" row-key="id" border empty-text="暂无记录" :max-height="620">
          <el-table-column prop="id" label="ID" width="76" /><el-table-column prop="name" label="名称" min-width="150" />
          <template v-if="kind === 'level'">
            <el-table-column label="背景图" width="130"><template #default="{ row }"><el-image v-if="distributorImagePreview(row.image_preview)" :src="distributorImagePreview(row.image_preview)" fit="cover" :preview-src-list="[distributorImagePreview(row.image_preview)]" preview-teleported /><span v-else class="hint">无可读预览</span></template></el-table-column>
            <el-table-column prop="grade" label="等级" width="80" /><el-table-column label="字体颜色" width="140"><template #default="{ row }"><span class="color-sample" :style="{ color: distributorColor(row.color) || undefined }">{{ row.color || '未设置' }}</span></template></el-table-column>
            <el-table-column prop="one_brokerage" label="一级上浮 (%)" width="140" /><el-table-column label="一级上浮后 (%)" width="160"><template #default="{ row }">{{ row.one_brokerage_ratio ?? '未能确认' }}</template></el-table-column><el-table-column prop="two_brokerage" label="二级上浮 (%)" width="140" /><el-table-column label="二级上浮后 (%)" width="160"><template #default="{ row }">{{ row.two_brokerage_ratio ?? '未能确认' }}</template></el-table-column><el-table-column prop="task_count" label="任务数" width="90" />
          </template>
          <template v-else><el-table-column label="任务类型" min-width="150"><template #default="{ row }">{{ row.type_name || `未知类型 ${row.type}` }}</template></el-table-column><el-table-column prop="number" label="任务要求" width="130" /><el-table-column prop="desc" label="任务描述" min-width="190" /><el-table-column prop="sort" label="排序" width="85" /><el-table-column label="已完成记录" width="130"><template #default="{ row }">{{ row.completed ? '已有用户完成' : '暂无' }}</template></el-table-column><el-table-column prop="is_must" label="历史 is_must" width="130" /></template>
          <el-table-column label="显示状态" width="110"><template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : 'info'">{{ statusLabel(row.status) }}</el-tag></template></el-table-column><el-table-column label="创建时间" width="180"><template #default="{ row }">{{ distributorTime(row.add_time) }}</template></el-table-column><el-table-column label="历史诊断" min-width="200"><template #default="{ row }"><ul v-if="row.issues.length"><li v-for="(issue, index) in row.issues" :key="index">{{ issue }}</li></ul><span v-else>—</span></template></el-table-column>
          <el-table-column label="操作" :width="kind === 'level' ? 300 : 218"><template #default="{ row }"><div class="row-actions"><el-button v-if="kind === 'level' && hasPermission('agent_level_task', 'view')" link type="primary" :disabled="locked" @click="openTasks(row.id)">等级任务</el-button><template v-if="canManage"><el-button link type="primary" :disabled="!writable || locked" @click="edit(row)">编辑</el-button><el-button link :disabled="!writable || locked" @click="setStatus(row)">{{ row.status === 0 ? '显示' : '隐藏' }}</el-button><el-button link type="danger" :disabled="!writable || locked" @click="remove(row)">删除</el-button></template><span v-if="!canManage && !(kind === 'level' && hasPermission('agent_level_task', 'view'))">仅查看</span></div></template></el-table-column>
        </el-table>
      </div>
      <el-pagination v-if="snapshot" :current-page="applied.page" :page-size="applied.limit" :page-sizes="[20, 50, 100]" :total="snapshot.count" layout="total, sizes, prev, pager, next" :disabled="locked" @current-change="pageChanged" @size-change="sizeChanged" />
      <el-dialog :model-value="!!editor" :title="editor?.id ? `编辑${kind === 'level' ? '等级' : '任务'} #${editor.id}` : kind === 'level' ? '添加分销等级' : '添加等级任务'" width="min(720px, calc(100vw - 24px))" :close-on-click-modal="false" :close-on-press-escape="!busy && !confirming" @close="closeEditor">
        <template v-if="editor">
          <el-alert v-if="editorError" :title="editorError" type="error" :closable="false" show-icon /><el-alert v-if="editor.issues.length" title="请核对以下历史诊断" type="warning" :closable="false"><template #default><ul><li v-for="(issue, index) in editor.issues" :key="index">{{ issue }}</li></ul></template></el-alert>
          <el-alert v-if="editor.needsReread" title="这些字段已确认未保存。请读取当前版本并核对后再提交。" type="warning" :closable="false"><template #default><el-button :disabled="editorLocked" @click="rereadEditor">读取当前版本并保留编辑</el-button></template></el-alert>
          <el-form label-position="top" :disabled="editorLocked" class="editor-form">
            <el-form-item :label="kind === 'level' ? '等级名称' : '任务名称'" required><el-input v-model="editor.values.name" :aria-label="kind === 'level' ? '等级名称' : '任务名称'" maxlength="100" :disabled="editorLocked" /></el-form-item>
            <template v-if="levelValues">
              <el-form-item label="等级" required><el-input-number v-model="levelValues.grade" aria-label="等级" :min="1" :max="32767" :precision="0" :disabled="editorLocked" /></el-form-item>
              <el-form-item label="背景图" required><div class="image-field"><el-image v-if="distributorImagePreview(editor.preview)" :src="distributorImagePreview(editor.preview)" fit="cover" /><el-input :model-value="levelValues.image" aria-label="背景图稳定地址" maxlength="255" :disabled="editorLocked" @update:model-value="setImage" /><SeckillActivityImagePicker :disabled="editorLocked" :editor-key="`${identity}:${editor.key}`" title="选择等级背景图" @choose="chooseImage" /><p class="hint">保存稳定素材地址，签名预览链接仅用于显示。</p></div></el-form-item>
              <el-form-item label="字体颜色" required><el-input v-model="levelValues.color" aria-label="字体颜色" maxlength="32" :disabled="editorLocked" placeholder="#333333 或 rgb(51,51,51)" /><span class="color-sample" :style="{ color: distributorColor(levelValues.color) || undefined }">分销等级预览</span></el-form-item>
              <el-form-item label="一级返佣上浮 (%)" required><el-input-number v-model="levelValues.one_brokerage" aria-label="一级返佣上浮" :min="0" :max="1000" :precision="0" :disabled="editorLocked" /><p class="hint">基础 {{ ratioLabel(editor.config?.one_ratio) }}，上浮后 {{ ratioLabel(distributorRatio(editor.config?.one_ratio ?? null, levelValues.one_brokerage)) }}。</p></el-form-item>
              <el-form-item label="二级返佣上浮 (%)" required><el-input-number v-model="levelValues.two_brokerage" aria-label="二级返佣上浮" :min="0" :max="1000" :precision="0" :disabled="editorLocked" /><p class="hint">基础 {{ ratioLabel(editor.config?.two_ratio) }}，上浮后 {{ ratioLabel(distributorRatio(editor.config?.two_ratio ?? null, levelValues.two_brokerage)) }}；二级上浮不能大于一级。</p></el-form-item>
            </template>
            <template v-if="taskValues"><p class="hint">所属等级 #{{ taskValues.level_id }}。全部开启任务须完成，不能改成任选其一。</p><el-alert v-if="editor.completed" title="已有用户完成该任务，类型与任务要求不可修改" type="info" :closable="false" />
              <el-form-item label="任务类型" required><el-select v-model="taskValues.type" aria-label="任务类型" :disabled="editorLocked || editor.completed"><el-option v-for="item in types" :key="item.type" :value="item.type" :label="`${item.name} (${item.unit})`" /></el-select></el-form-item>
              <el-form-item :label="`任务要求 (${taskUnit})`" required><el-input-number v-model="taskValues.number" aria-label="任务要求" :min="1" :max="2147483647" :precision="0" :disabled="editorLocked || editor.completed" /><p class="hint">同等级同类型只保留一个任务，高等级的同类要求须更高。金额任务以整数元设定。</p></el-form-item>
              <el-form-item label="任务描述"><el-input v-model="taskValues.desc" aria-label="任务描述" type="textarea" :rows="3" maxlength="510" :disabled="editorLocked" /></el-form-item><el-form-item label="排序" required><el-input-number v-model="taskValues.sort" aria-label="任务排序" :min="0" :max="32767" :precision="0" :disabled="editorLocked" /></el-form-item><p class="hint">历史 is_must：{{ editor.isMust }}（只读，保存时保留）。</p>
            </template>
            <el-form-item label="显示状态" required><el-radio-group v-model="editor.values.status" aria-label="编辑显示状态" :disabled="editorLocked"><el-radio :value="1">显示</el-radio><el-radio :value="0">隐藏</el-radio></el-radio-group></el-form-item>
          </el-form>
        </template><template #footer><el-button :disabled="busy || confirming" @click="closeEditor">取消</el-button><el-button type="primary" :disabled="editorLocked || !!editor?.needsReread" @click="saveEditor">保存{{ kind === 'level' ? '等级' : '任务' }}</el-button></template>
      </el-dialog>
    </template>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import SeckillActivityImagePicker from '@/pages/activity/SeckillActivityImagePicker.vue';
import { apiDistributorList, apiDistributorParents, apiDistributorDetail, apiDistributorWrite, apiDistributorReceipt, distributorKind, distributorAction,
  normalizeDistributorIntent, distributorFingerprint, distributorPendingKey, parseDistributorPending, assertDistributorReceipt, distributorReceiptNotFound, isDistributorStale,
  isDistributorRejected, distributorErrorMessage, distributorOrphanIds, distributorRejectedDraftKey,
  distributorColor, distributorImagePreview, distributorRatio, distributorTime,
  type DistributorKind, type DistributorOperation, type DistributorQuery, type DistributorLevelValues, type DistributorTaskValues, type DistributorLevel, type DistributorTask,
  type DistributorConfig, type DistributorParentsSnapshot, type DistributorLevelsSnapshot, type DistributorTasksSnapshot, type DistributorSnapshot,
  type DistributorIntent, type DistributorPending, type DistributorReceipt } from '@/api/distributorLevels';
const props = defineProps<{ kind: DistributorKind; levelId?: string }>(), kind = props.kind, auth = useAuthStore(), router = useRouter();
const title = kind === 'level' ? '分销等级' : '分销等级任务', module = kind === 'level' ? 'agent_level' : 'agent_level_task';
function hasPermission(key: string, action: 'view' | 'manage') { return !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes(`${key}.${action}`)); }
const canView = computed(() => hasPermission(module, 'view')), canManage = computed(() => canView.value && hasPermission(module, 'manage'));
const identity = computed(() => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}`);
const snapshot = ref<DistributorSnapshot | null>(null), applied = ref<DistributorQuery>({ page: 1, limit: 20 }), draftKeyword = ref(''), draftStatus = ref<'all' | 0 | 1>('all');
const levelSnapshot = computed(() => kind === 'level' ? snapshot.value as DistributorLevelsSnapshot | null : null), taskSnapshot = computed(() => kind === 'task' ? snapshot.value as DistributorTasksSnapshot | null : null);
const initialParent = props.levelId && /^(?:0|[1-9]\d{0,9})$/u.test(props.levelId) && Number(props.levelId) <= 2147483647 ? Number(props.levelId) : 0;
const selectedParentId = ref(initialParent), parents = ref<DistributorParentsSnapshot | null>(null), parentKeyword = ref(''), appliedParentKeyword = ref(''), parentLoading = ref(false), parentError = ref('');
const currentParent = computed(() => taskSnapshot.value?.parent ?? parents.value?.list.find(item => item.id === selectedParentId.value) ?? null);
const parentOptions = computed(() => { const rows = [...(parents.value?.list || [])]; if (currentParent.value && !rows.some(item => item.id === currentParent.value!.id)) rows.unshift(currentParent.value); return rows; });
const ready = ref(false), loading = ref(false), detailLoading = ref(false), error = ref(''), notice = ref(''), noticeSuccess = ref(false);
const pending = ref<DistributorPending | null>(null), recoveryError = ref(''), restoring = ref(false), retryReady = ref(false), busy = ref(false), confirming = ref(false), readingReceipt = ref(false);
const rejectedDraft = ref<DistributorPending | null>(null), submittedEditor = ref<{ request_id: string; editor: Editor } | null>(null);
const draftMatchesPage = computed(() => !!rejectedDraft.value && distributorKind(rejectedDraft.value.operation) === kind && (kind === 'level' || (rejectedDraft.value.input.values as DistributorTaskValues).level_id === selectedParentId.value));
const canRestoreOtherDraft = computed(() => { if (!rejectedDraft.value) return false; const key = distributorKind(rejectedDraft.value.operation) === 'level' ? 'agent_level' : 'agent_level_task'; return hasPermission(key, 'view') && hasPermission(key, 'manage'); });
const pendingModule = computed(() => pending.value && distributorKind(pending.value.operation) === 'level' ? 'agent_level' : 'agent_level_task');
const canReadPending = computed(() => !!pending.value && hasPermission(pendingModule.value, 'view')), canRetryPending = computed(() => canReadPending.value && hasPermission(pendingModule.value, 'manage'));
const locked = computed(() => loading.value || detailLoading.value || busy.value || confirming.value || restoring.value || readingReceipt.value || !!pending.value || !!recoveryError.value);
const writable = computed(() => canManage.value && ready.value && !!snapshot.value);
type Editor = { id: number; key: string; revision: string; values: DistributorLevelValues | DistributorTaskValues; preview: string; issues: string[]; config?: DistributorConfig; completed: boolean; isMust: number; needsReread?: boolean };
const editor = ref<Editor | null>(null), editorError = ref(''), editorLocked = computed(() => !canManage.value || locked.value);
const levelValues = computed(() => kind === 'level' ? editor.value?.values as DistributorLevelValues | undefined : undefined), taskValues = computed(() => kind === 'task' ? editor.value?.values as DistributorTaskValues | undefined : undefined);
const types = computed(() => taskSnapshot.value?.task_types ?? []), taskUnit = computed(() => types.value.find(item => item.type === taskValues.value?.type)?.unit || '人数／金额／订单数');
const orphanIds = computed(() => distributorOrphanIds([...(snapshot.value?.issues ?? []), ...(parents.value?.issues ?? [])]));
const orphanRevision = computed(() => selectedParentId.value ? ready.value ? snapshot.value?.revision : undefined : !parentLoading.value && !parentError.value ? parents.value?.revision : undefined);
const orphanReady = computed(() => canManage.value && kind === 'task' && !!orphanRevision.value && !parentLoading.value), orphanPage = ref(1);
const visibleOrphanIds = computed(() => orphanIds.value.slice((orphanPage.value - 1) * 20, orphanPage.value * 20));
type Stamp = { generation: number; identity: string; stored: string | null }; type Job = { stamp: Stamp; controller: AbortController };
let alive = false, syncing = false, generation = 0, confirmationId = 0, stored = localStorage.getItem('admin_session'); const jobs = new Map<string, Job>();
const stamp = (): Stamp => ({ generation, identity: identity.value, stored });
const current = (scope: Stamp) => alive && canView.value && scope.generation === generation && scope.identity === identity.value && scope.stored === localStorage.getItem('admin_session') && auth.token === getToken();
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const message = distributorErrorMessage;
const statusLabel = (value: number) => value === 1 ? '显示' : value === 0 ? '隐藏' : `异常 ${value}`;
const ratioLabel = (value: string | null | undefined) => value == null ? '未能确认' : `${value}%`;
const operationLabel = (value: DistributorOperation) => `${distributorKind(value) === 'level' ? '等级' : '任务'}${({ create: '新增', update: '编辑', status: '显隐修改', delete: '删除' })[distributorAction(value)]}`;
function cancel(channel: string) { jobs.get(channel)?.controller.abort(); jobs.delete(channel); }
function start(channel: string): Job { cancel(channel); const job = { stamp: stamp(), controller: new AbortController() }; jobs.set(channel, job); return job; }
function valid(channel: string, job: Job) { return jobs.get(channel) === job && current(job.stamp); }
function finish(channel: string, job: Job) { if (!valid(channel, job)) return false; jobs.delete(channel); return true; }
async function load(query: DistributorQuery = applied.value) {
  if (!current(stamp()) || busy.value || confirming.value || kind === 'task' && !selectedParentId.value) return;
  const params = { ...query, ...(kind === 'task' ? { level_id: selectedParentId.value } : {}) }, job = start('list'); loading.value = true; ready.value = false; error.value = '';
  try { const result = await apiDistributorList(kind, params, job.controller.signal); if (valid('list', job)) { snapshot.value = result; applied.value = params; ready.value = true; if (editor.value?.needsReread && kind === 'level') { const matching = (result as DistributorLevelsSnapshot).list.find(row => row.image === (editor.value!.values as DistributorLevelValues).image); if (!editor.value.preview && matching) editor.value.preview = matching.image_preview; editor.value.config = (result as DistributorLevelsSnapshot).config; } } }
  catch (reason) { if (valid('list', job)) error.value = message(reason); } finally { if (finish('list', job)) loading.value = false; }
}
async function loadParents(page = 1, keyword = appliedParentKeyword.value) { if (kind !== 'task' || !current(stamp()) || busy.value || confirming.value) return; const job = start('parents'); parentLoading.value = true; parentError.value = '';
  try { const result = await apiDistributorParents({ page, limit: 20, ...(keyword ? { keyword } : {}) }, job.controller.signal); if (valid('parents', job)) { parents.value = result; appliedParentKeyword.value = keyword; } } catch (reason) { if (valid('parents', job)) parentError.value = message(reason); } finally { if (finish('parents', job)) parentLoading.value = false; }
}
function searchParents() { if (!locked.value && !parentLoading.value) void loadParents(1, parentKeyword.value); }
function parentPageChanged(page: number) { if (!locked.value && !parentLoading.value) void loadParents(page); }
function selectParent(value: unknown) { if (!locked.value && !parentLoading.value && typeof value === 'number' && parentOptions.value.some(item => item.id === value)) void router.push(`/setting/distributor-levels/tasks/${value}`); }
function openTasks(id: number) { if (!locked.value && hasPermission('agent_level_task', 'view')) void router.push(`/setting/distributor-levels/tasks/${id}`); }
async function reload() { if (!current(stamp()) || busy.value || confirming.value || restoring.value || readingReceipt.value) return; closeEditor(); await load(); if (kind === 'task') await loadParents(parents.value?.page ?? 1); }
function query() { if (!locked.value) { closeEditor(); void load({ page: 1, limit: applied.value.limit, keyword: draftKeyword.value, ...(draftStatus.value === 'all' ? {} : { status: draftStatus.value }) }); } }
function pageChanged(page: number) { if (!locked.value && page !== applied.value.page) { closeEditor(); void load({ ...applied.value, page }); } }
function sizeChanged(limit: number) { if (!locked.value && limit !== applied.value.limit) { closeEditor(); void load({ ...applied.value, page: 1, limit }); } }
function closeEditor() { if (busy.value || confirming.value) return; cancel('detail'); detailLoading.value = false; editor.value = null; editorError.value = ''; if (rejectedDraft.value && distributorKind(rejectedDraft.value.operation) === kind && auth.userInfo) { sessionStorage.removeItem(distributorRejectedDraftKey(auth.userInfo.id)); rejectedDraft.value = null; } }
function add() { if (!current(stamp()) || !writable.value || locked.value || !snapshot.value) return; editorError.value = ''; editor.value = { id: 0, key: crypto.randomUUID(), revision: snapshot.value.revision,
  values: kind === 'level' ? { name: '', grade: 1, image: '', color: '#333333', one_brokerage: 0, two_brokerage: 0, status: 1 } : { level_id: selectedParentId.value, name: '', type: 1, number: 1, desc: '', sort: 0, status: 1 }, preview: '', issues: [], config: levelSnapshot.value?.config, completed: false, isMust: 0 }; }
async function edit(row: DistributorLevel | DistributorTask) { if (!current(stamp()) || !writable.value || locked.value) return; closeEditor(); const job = start('detail'); detailLoading.value = true; notice.value = '';
  try { const result = await apiDistributorDetail(kind, row.id, job.controller.signal); if (!valid('detail', job) || !canManage.value) return;
    const info = result.info; if (kind === 'task' && (info as DistributorTask).level_id !== selectedParentId.value) throw Error('任务所属等级已改变，请重新读取');
    const values = kind === 'level' ? ((item: DistributorLevel) => ({ name: item.name, grade: item.grade, image: item.image, color: item.color, one_brokerage: item.one_brokerage, two_brokerage: item.two_brokerage, status: item.status as 0 | 1 }))(info as DistributorLevel) : ((item: DistributorTask) => ({ level_id: item.level_id, name: item.name, type: item.type, number: item.number, desc: item.desc, sort: item.sort, status: item.status as 0 | 1 }))(info as DistributorTask);
    editor.value = { id: row.id, key: crypto.randomUUID(), revision: info.revision, values, preview: kind === 'level' ? (info as DistributorLevel).image_preview : '', issues: [...result.issues, ...info.issues], config: result.config, completed: kind === 'task' && (info as DistributorTask).completed, isMust: kind === 'task' ? (info as DistributorTask).is_must : 0 };
  } catch (reason) { if (valid('detail', job)) notice.value = message(reason); } finally { if (finish('detail', job)) detailLoading.value = false; }
}
function setImage(value: string) { if (!current(stamp()) || editorLocked.value || !editor.value || !levelValues.value) return; levelValues.value.image = value; editor.value.preview = ''; }
function chooseImage(reference: string, preview: string) { if (!current(stamp()) || editorLocked.value || !editor.value) return; setImage(reference); editor.value.preview = preview; }
function clearPending(frozen: DistributorPending) { const key = distributorPendingKey(frozen.actor); if (sessionStorage.getItem(key) !== JSON.stringify(frozen)) throw Error('本地原请求已发生变化，请保留记录并核对'); sessionStorage.removeItem(key); pending.value = null; retryReady.value = false; }
function restoreRejectedEditor(frozen: DistributorPending) {
  if (distributorKind(frozen.operation) !== kind || !canManage.value || !frozen.input.values || kind === 'task' && (frozen.input.values as DistributorTaskValues).level_id !== selectedParentId.value) return;
  const before = submittedEditor.value?.request_id === frozen.input.request_id ? clone(submittedEditor.value.editor) : null;
  const existing = snapshot.value?.list.find(row => row.id === frozen.id), matching = levelSnapshot.value?.list.find(row => row.image === (frozen.input.values as DistributorLevelValues).image);
  editor.value = { id: frozen.id, key: crypto.randomUUID(), revision: frozen.input.revision, values: clone(frozen.input.values), preview: before?.preview || matching?.image_preview || '',
    issues: before?.issues ?? existing?.issues ?? [], config: before?.config ?? levelSnapshot.value?.config, completed: before?.completed ?? (kind === 'task' && !!(existing as DistributorTask | undefined)?.completed), isMust: before?.isMust ?? (kind === 'task' ? (existing as DistributorTask | undefined)?.is_must ?? 0 : 0), needsReread: true };
}
function goRejectedDraft() { if (!rejectedDraft.value || !canRestoreOtherDraft.value || locked.value) return; const draft = rejectedDraft.value; void router.push(distributorKind(draft.operation) === 'level' ? '/setting/distributor-levels' : `/setting/distributor-levels/tasks/${(draft.input.values as DistributorTaskValues).level_id}`); }
async function rereadEditor() {
  if (!editor.value?.needsReread || editorLocked.value || !current(stamp())) return; const item = editor.value, job = start('detail'); detailLoading.value = true; editorError.value = '';
  try {
    if (!item.id) {
      const query = { ...applied.value, ...(kind === 'task' ? { level_id: selectedParentId.value } : {}) }, result = await apiDistributorList(kind, query, job.controller.signal);
      if (!valid('detail', job) || editor.value !== item) return; snapshot.value = result; ready.value = true; item.revision = result.revision; item.config = kind === 'level' ? (result as DistributorLevelsSnapshot).config : undefined;
    } else {
      const result = await apiDistributorDetail(kind, item.id, job.controller.signal); if (!valid('detail', job) || editor.value !== item) return;
      if (kind === 'task' && (result.info as DistributorTask).level_id !== (item.values as DistributorTaskValues).level_id) throw Error('任务所属等级已改变，请取消并重新选择等级');
      item.revision = result.info.revision; item.config = result.config; item.issues = [...result.issues, ...result.info.issues];
      if (kind === 'level' && (item.values as DistributorLevelValues).image === (result.info as DistributorLevel).image) item.preview = (result.info as DistributorLevel).image_preview;
      if (kind === 'task') { const latest = result.info as DistributorTask; item.completed = latest.completed; item.isMust = latest.is_must; if (latest.completed) { (item.values as DistributorTaskValues).type = latest.type; (item.values as DistributorTaskValues).number = latest.number; notice.value = '任务已有完成记录，类型与要求已恢复为当前不可修改值；其它未保存字段保留。'; } }
      const query = { ...applied.value, ...(kind === 'task' ? { level_id: selectedParentId.value } : {}) }, latestList = await apiDistributorList(kind, query, job.controller.signal);
      if (!valid('detail', job) || editor.value !== item) return; snapshot.value = latestList; item.revision = latestList.revision; ready.value = true;
    }
    item.needsReread = false;
  } catch (reason) { if (valid('detail', job)) editorError.value = message(reason); } finally { if (finish('detail', job)) detailLoading.value = false; }
}
async function refreshAfterWrite() { await load(); if (kind === 'task' && current(stamp())) await loadParents(parents.value?.page ?? 1); }
function accept(result: DistributorReceipt, frozen: DistributorPending) { assertDistributorReceipt(result, frozen); clearPending(frozen); if (rejectedDraft.value?.input.request_id === submittedEditor.value?.request_id || rejectedDraft.value && distributorKind(rejectedDraft.value.operation) === distributorKind(frozen.operation)) { sessionStorage.removeItem(distributorRejectedDraftKey(frozen.actor)); rejectedDraft.value = null; } editor.value = null; submittedEditor.value = null; noticeSuccess.value = true; notice.value = `${operationLabel(frozen.operation)}已确认，将重新读取当前列表。`; }
async function submitOriginal(frozen: DistributorPending) { if (!current(stamp()) || !canRetryPending.value || busy.value || readingReceipt.value || pending.value?.input.request_id !== frozen.input.request_id) return; const job = start('write'); busy.value = true; retryReady.value = false; notice.value = ''; noticeSuccess.value = false;
  try { const result = await apiDistributorWrite({ operation: frozen.operation, id: frozen.id, input: frozen.input }, job.controller.signal); if (valid('write', job) && canRetryPending.value) accept(result, frozen); }
  catch (reason) { if (!valid('write', job)) return;
    if (isDistributorRejected(reason, frozen)) { try { if (frozen.input.values) { sessionStorage.setItem(distributorRejectedDraftKey(frozen.actor), JSON.stringify(frozen)); rejectedDraft.value = frozen; } clearPending(frozen); ready.value = false; restoreRejectedEditor(frozen); notice.value = `服务端已确认本次未保存：${message(reason)}。已保留原字段，请读取当前版本并核对后再提交。`; } catch (failure) { recoveryError.value = message(failure); } }
    else if (isDistributorStale(reason, frozen)) { try { clearPending(frozen); editor.value = null; ready.value = false; notice.value = '分销设置版本已改变，本次未保存。重新读取最新数据后，请核对并再次确认。'; } catch (failure) { recoveryError.value = message(failure); } }
    else notice.value = `提交结果未确认：${message(reason)}。请读取原请求回执，不能发起新的写入。`;
  }
  finally { if (finish('write', job)) busy.value = false; } if (current(job.stamp) && !pending.value && !recoveryError.value && !editor.value?.needsReread) await refreshAfterWrite();
}
async function confirmWrite(intent: DistributorIntent, description: string) { const orphan = kind === 'task' && intent.operation === 'task:delete' && orphanReady.value && orphanIds.value.includes(intent.id) && intent.input.revision === orphanRevision.value; if (!current(stamp()) || !(writable.value || orphan) || locked.value) return; const scope = stamp(), version = ++confirmationId; confirming.value = true; notice.value = editorError.value = ''; noticeSuccess.value = false; let frozen: DistributorPending | null = null;
  try { const normalized = normalizeDistributorIntent(intent), fingerprint = await distributorFingerprint(normalized); if (!current(scope) || !canManage.value || version !== confirmationId) return;
    await ElMessageBox.confirm(description, `确认${operationLabel(intent.operation)}`, { type: 'warning', confirmButtonText: '确认提交', cancelButtonText: '取消' });
    if (!current(scope) || !canManage.value || version !== confirmationId || pending.value || recoveryError.value) return;
    frozen = { version: 1, actor: auth.userInfo!.id, ...normalized, fingerprint }; const key = distributorPendingKey(frozen.actor); if (sessionStorage.getItem(key) !== null) { recoveryError.value = '已有未完成分销请求，请重新读取页面并核对'; throw Error(recoveryError.value); }
    if (editor.value) submittedEditor.value = { request_id: frozen.input.request_id, editor: clone(editor.value) }; sessionStorage.setItem(key, JSON.stringify(frozen)); pending.value = frozen; editor.value = null;
  } catch (reason) { if (current(scope) && reason !== 'cancel' && reason !== 'close') { notice.value = message(reason); if (editor.value) editorError.value = notice.value; } } finally { if (current(scope) && version === confirmationId) confirming.value = false; }
  if (current(scope) && frozen && pending.value?.input.request_id === frozen.input.request_id) await submitOriginal(frozen);
}
function saveEditor() { if (!editor.value || editor.value.needsReread || editorLocked.value) return; const item = editor.value; void confirmWrite({ operation: `${kind}:${item.id ? 'update' : 'create'}`, id: item.id, input: { request_id: crypto.randomUUID(), revision: item.revision, values: clone(item.values) } }, `确认${item.id ? '保存' : '新增'}${title}的全部字段？${kind === 'task' ? '所有开启任务全部完成才能升级。' : '新的上浮比例将用于后续订单的分销佣金计算。'}`); }
function setStatus(row: DistributorLevel | DistributorTask) { void confirmWrite({ operation: `${kind}:status`, id: row.id, input: { request_id: crypto.randomUUID(), revision: row.revision, status: row.status === 0 ? 1 : 0 } }, `确认${row.status === 0 ? '显示' : '隐藏'}${title} #${row.id}？`); }
function remove(row: DistributorLevel | DistributorTask) { void confirmWrite({ operation: `${kind}:delete`, id: row.id, input: { request_id: crypto.randomUUID(), revision: row.revision } }, kind === 'level' ? `确认删除等级 #${row.id}「${row.name}」及该等级的全部任务？已有用户的等级和任务完成历史保留，后续升级与佣金不再使用该等级。` : `确认删除任务 #${row.id}「${row.name}」？已有完成历史保留，后续升级不再要求该任务。`); }
function removeOrphan(id: number) { if (!orphanReady.value || locked.value || !orphanRevision.value || !orphanIds.value.includes(id)) return; void confirmWrite({ operation: 'task:delete', id, input: { request_id: crypto.randomUUID(), revision: orphanRevision.value } }, `确认删除孤儿任务 #${id}？原父等级不存在或已删除，已有完成历史保留。此次仅删除该任务，不移动任务或创建父等级。`); }
async function readReceipt() { if (!current(stamp()) || !pending.value || !canReadPending.value || busy.value || confirming.value || readingReceipt.value || restoring.value) return; const frozen = pending.value, job = start('receipt'); readingReceipt.value = true; retryReady.value = false; notice.value = ''; noticeSuccess.value = false;
  try { const result = await apiDistributorReceipt(distributorKind(frozen.operation), frozen.input.request_id, job.controller.signal); if (valid('receipt', job) && canReadPending.value) accept(result, frozen); }
  catch (reason) { if (valid('receipt', job)) { if (distributorReceiptNotFound(reason)) { retryReady.value = true; notice.value = '明确未发现该请求回执。可主动重试原请求，UUID、版本和全部原内容保持不变。'; } else notice.value = `提交结果仍未确认：${message(reason)}`; } }
  finally { if (finish('receipt', job)) readingReceipt.value = false; } if (current(job.stamp) && !pending.value && !recoveryError.value) await refreshAfterWrite();
}
async function retryOriginal() { if (!pending.value || !retryReady.value || !canRetryPending.value || busy.value || readingReceipt.value || confirming.value || !current(stamp())) return; const frozen = pending.value, scope = stamp(), version = ++confirmationId; confirming.value = true;
  try { await ElMessageBox.confirm(`确认重新提交原请求 ${frozen.input.request_id}？原操作、版本及全部内容保持不变。`, '重试原请求', { type: 'warning', confirmButtonText: '重试原请求', cancelButtonText: '取消' }); } catch { return; } finally { if (current(scope) && version === confirmationId) confirming.value = false; }
  if (current(scope) && version === confirmationId && canRetryPending.value && pending.value === frozen && retryReady.value) await submitOriginal(frozen);
}
async function restore() { if (!current(stamp()) || !auth.userInfo) return; const scope = stamp(); restoring.value = true;
  try { const raw = sessionStorage.getItem(distributorPendingKey(auth.userInfo.id)); if (raw) { const saved = await parseDistributorPending(raw, auth.userInfo.id); if (current(scope)) pending.value = saved; }
    else { const rejected = sessionStorage.getItem(distributorRejectedDraftKey(auth.userInfo.id)); if (rejected) { const saved = await parseDistributorPending(rejected, auth.userInfo.id); if (!saved.input.values) throw Error('未保存编辑不包含完整字段'); if (current(scope)) { rejectedDraft.value = saved; restoreRejectedEditor(saved); } } }
  } catch (reason) { if (current(scope)) recoveryError.value = `原分销请求无法安全恢复：${message(reason)}`; } finally { if (current(scope)) restoring.value = false; }
}
function invalidate() { generation++; confirmationId++; if (confirming.value) ElMessageBox.close(); for (const job of jobs.values()) job.controller.abort(); jobs.clear(); snapshot.value = null; editor.value = null; pending.value = null; rejectedDraft.value = null; submittedEditor.value = null; parents.value = null; orphanPage.value = 1; applied.value = { page: 1, limit: 20 }; draftKeyword.value = parentKeyword.value = appliedParentKeyword.value = ''; draftStatus.value = 'all'; ready.value = loading.value = detailLoading.value = busy.value = confirming.value = readingReceipt.value = restoring.value = retryReady.value = parentLoading.value = false; error.value = notice.value = recoveryError.value = editorError.value = parentError.value = ''; noticeSuccess.value = false; }
async function boot() { const scope = stamp(); await restore(); if (!current(scope)) return; await load(); if (current(scope) && kind === 'task') await loadParents(); }
function syncStored(event?: Event) { if (syncing || event instanceof StorageEvent && event.key !== null && !['admin_token', 'admin_session'].includes(event.key)) return; syncing = true; invalidate(); const session = getAdminSession(); auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] }); stored = localStorage.getItem('admin_session'); syncing = false; void boot(); }
watch(identity, () => { if (alive && !syncing) { invalidate(); stored = localStorage.getItem('admin_session'); void boot(); } }, { flush: 'sync' });
watch(orphanIds, ids => { orphanPage.value = Math.min(orphanPage.value, Math.max(1, Math.ceil(ids.length / 20))); });
onMounted(() => { alive = true; window.addEventListener('storage', syncStored); window.addEventListener('admin-session-changed', syncStored); window.addEventListener('admin-auth-expired', syncStored); syncStored(); });
onBeforeUnmount(() => { alive = false; invalidate(); window.removeEventListener('storage', syncStored); window.removeEventListener('admin-session-changed', syncStored); window.removeEventListener('admin-auth-expired', syncStored); });
</script>

<style scoped>
.distributor-catalog{display:grid;gap:16px;min-width:0}.heading{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}.heading h2{font-size:20px;margin:0}.hint{font-size:13px;line-height:1.65;color:var(--el-text-color-secondary);overflow-wrap:anywhere;margin:7px 0}.toolbar,.buttons,.row-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.toolbar>.el-input{width:210px}.toolbar>.el-select{width:190px}.buttons{margin:10px 0}.buttons .el-button+.el-button,.row-actions .el-button+.el-button{margin-left:0}.parents,.config-summary{padding:14px;background:var(--el-fill-color-light);border-radius:6px}.parent-title{font-weight:600}.orphan-row{display:flex;justify-content:space-between;gap:16px;padding:7px 0;flex-wrap:wrap}.orphan-tasks :deep(.el-pagination){margin-top:12px}.table-wrap{min-width:0;overflow:hidden}.table-wrap :deep(.el-image){width:80px;height:52px}.table-wrap :deep(.cell){overflow-wrap:anywhere;white-space:pre-wrap}ul{padding-left:17px;font-size:12px}.error{color:var(--el-color-danger);font-size:13px}.color-sample{padding:6px 9px;overflow-wrap:anywhere}.editor-form{max-height:60vh;overflow-y:auto;padding-right:5px;margin-top:12px}.editor-form .el-select{width:100%}.image-field{display:grid;gap:10px;width:100%;justify-items:start}.image-field .el-image{width:160px;height:92px}.image-field .el-input{width:100%}.editor-form .hint{width:100%}pre{max-height:230px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.distributor-catalog :deep(.el-alert__content){min-width:0;overflow-wrap:anywhere}.distributor-catalog :deep(.el-pagination){flex-wrap:wrap;gap:8px}
@media(max-width:600px){.toolbar{align-items:stretch}.toolbar>.el-input,.toolbar>.el-select{width:100%}.toolbar>.el-button{margin-left:0}.editor-form{max-height:55vh}.heading h2{font-size:18px}.distributor-catalog :deep(.el-dialog__body){padding:12px}}
</style>
