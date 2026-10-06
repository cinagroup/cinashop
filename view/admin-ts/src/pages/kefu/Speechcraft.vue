<template>
  <div class="speechcraft-page">
    <div class="heading"><div><h2>客服话术</h2><p class="hint">平台公共话术与客服个人话术分开管理。</p></div>
      <div class="heading-actions"><el-button v-if="canView" :loading="loading || categoriesLoading" @click="refresh">刷新</el-button>
        <el-button v-if="canManage" type="primary" :disabled="busy" @click="openCreate">添加话术</el-button>
        <el-button v-if="canManage" type="success" :disabled="busy" @click="openCategoryCreate">添加分类</el-button></div></div>
    <el-alert v-if="!canView" title="当前账号没有话术查看权限" type="warning" :closable="false" show-icon />
    <div v-else class="work-area">
      <el-card shadow="never" class="category-panel"><template #header><strong>话术分类</strong></template>
        <el-alert v-if="categoryError" :title="categoryError" type="error" :closable="false" show-icon>
          <el-button link type="primary" @click="loadCategories">重试</el-button></el-alert>
        <div v-loading="categoriesLoading" class="categories">
          <button type="button" class="category" :class="{ selected: selectedCategory === '' }" @click="selectCategory('')">全部</button>
          <button type="button" class="category" :class="{ selected: selectedCategory === 0 }" @click="selectCategory(0)">未分类</button>
          <div v-for="category in categories" :key="category.id" class="category-row">
            <button type="button" class="category" :class="{ selected: selectedCategory === category.id }"
              @click="selectCategory(category.id)">{{ category.name }}</button>
            <el-dropdown v-if="canManage" trigger="click" @command="(command: string) => categoryCommand(command, category)">
              <el-button link type="primary" :disabled="busy">⋯</el-button>
              <template #dropdown><el-dropdown-menu><el-dropdown-item command="edit">编辑分类</el-dropdown-item>
                <el-dropdown-item command="delete">删除分类</el-dropdown-item></el-dropdown-menu></template>
            </el-dropdown>
          </div>
        </div>
      </el-card>
      <div class="main-panel">
        <el-card shadow="never" class="filter-panel">
          <div class="filters">
            <label class="field"><span>话术标题</span><el-input v-model="draftTitle" clearable maxlength="100" placeholder="按标题搜索" @keyup.enter="search" /></label>
            <label class="field"><span>话术内容</span><el-input v-model="draftMessage" clearable maxlength="255" placeholder="内容精确匹配" @keyup.enter="search" /></label>
            <el-button type="primary" @click="search">查询</el-button><el-button @click="resetSearch">重置</el-button>
          </div>
          <el-alert v-if="filterError" :title="filterError" type="error" :closable="false" show-icon />
        </el-card>
        <el-card shadow="never" class="list-panel">
          <p class="hint">匹配 {{ count }} 条，每页 10 条，按排序值降序；同排序值按 ID 升序。</p>
          <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon>
            <el-button link type="primary" @click="load(page)">重试</el-button></el-alert>
          <div class="table-scroll"><el-table :data="list" v-loading="loading" border row-key="id"
            :empty-text="loading ? '读取中…' : '暂无话术'">
            <el-table-column prop="id" label="ID" width="75" />
            <el-table-column label="分类" min-width="130"><template #default="{ row }">{{ categoryName(row.cate_id) }}</template></el-table-column>
            <el-table-column prop="title" label="标题" min-width="150" />
            <el-table-column label="详情" min-width="280"><template #default="{ row }"><span class="message">{{ row.message }}</span></template></el-table-column>
            <el-table-column prop="sort" label="排序" width="80" />
            <el-table-column label="添加时间" min-width="170"><template #default="{ row }">{{ speechcraftTime(row.add_time) }}</template></el-table-column>
            <el-table-column label="操作" width="150"><template #default="{ row }">
              <el-button link type="primary" @click="openDetail(row)">{{ canManage ? '编辑' : '查看' }}</el-button>
              <el-button v-if="canManage" link type="danger" :disabled="busy" @click="removePhrase(row)">删除</el-button>
            </template></el-table-column>
          </el-table></div>
          <el-pagination class="pager" :current-page="page" :page-size="10" :total="count"
            layout="total, prev, pager, next" @current-change="load" />
        </el-card>
      </div>
    </div>
    <el-dialog v-model="editorVisible" :title="editorMode === 'create' ? '添加话术' : canManage ? '编辑话术' : '话术详情'"
      width="min(640px, calc(100vw - 24px))" @closed="closeEditor">
      <div v-loading="detailLoading">
        <el-alert v-if="detailError" :title="detailError" type="error" :closable="false" show-icon>
          <el-button v-if="editorMode === 'edit'" link type="primary" @click="reloadDetail">重试</el-button></el-alert>
        <el-form v-else label-position="top" class="editor-form">
          <el-form-item label="话术分类"><el-select v-model="editor.cate_id" :disabled="!canManage || busy" class="full">
            <el-option label="未分类" :value="0" />
            <el-option v-if="editor.cate_id > 0 && !categories.some(item => item.id === editor.cate_id)"
              :label="`已删除分类 #${editor.cate_id}（保留原关联）`" :value="editor.cate_id" />
            <el-option v-for="category in categories" :key="category.id" :label="category.name" :value="category.id" />
          </el-select></el-form-item>
          <el-form-item label="话术标题"><el-input v-model="editor.title" type="textarea" :rows="2" maxlength="100" show-word-limit :disabled="!canManage || busy" /></el-form-item>
          <el-form-item label="话术内容" required><el-input v-model="editor.message" type="textarea" :rows="5" maxlength="255" show-word-limit :disabled="!canManage || busy" /></el-form-item>
          <el-form-item label="排序"><el-input-number v-model="editor.sort" :min="0" :max="2147483647" :precision="0" :disabled="!canManage || busy" /></el-form-item>
        </el-form>
      </div>
      <el-alert v-if="mutationError" :title="mutationError" type="error" :closable="false" show-icon />
      <template #footer><el-button @click="editorVisible = false">关闭</el-button>
        <el-button v-if="canManage && !detailLoading && !detailError" type="primary" :loading="busy" @click="savePhrase">保存</el-button></template>
    </el-dialog>
    <el-dialog v-model="categoryEditorVisible" :title="categoryEditorId ? '编辑分类' : '添加分类'" width="min(480px, calc(100vw - 24px))" @closed="closeCategoryEditor">
      <el-form label-position="top"><el-form-item label="分类名称" required><el-input v-model="categoryEditor.name" maxlength="255" show-word-limit :disabled="busy" /></el-form-item>
        <el-form-item label="排序"><el-input-number v-model="categoryEditor.sort" :min="0" :max="2147483647" :precision="0" :disabled="busy" /></el-form-item></el-form>
      <el-alert v-if="mutationError" :title="mutationError" type="error" :closable="false" show-icon />
      <template #footer><el-button @click="categoryEditorVisible = false">取消</el-button>
        <el-button v-if="canManage" type="primary" :loading="busy" @click="saveCategory">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import { apiSpeechcraftCategories, apiSpeechcraftCategoryCreate, apiSpeechcraftCategoryDelete,
  apiSpeechcraftCategoryUpdate, apiSpeechcraftCreate, apiSpeechcraftDelete, apiSpeechcraftDetail,
  apiSpeechcraftList, apiSpeechcraftUpdate, normalizeSpeechcraftCategoryInput,
  normalizeSpeechcraftInput, normalizeSpeechcraftQuery, speechcraftTime,
  type SpeechcraftCategory, type SpeechcraftCategoryInput, type SpeechcraftInput,
  type SpeechcraftRow } from "@/api/speechcraft";

const auth = useAuthStore();
const categories = ref<SpeechcraftCategory[]>([]), categoriesLoading = ref(false), categoryError = ref("");
const selectedCategory = ref<"" | number>("");
const draftTitle = ref(""), draftMessage = ref(""), appliedTitle = ref(""), appliedMessage = ref("");
const page = ref(1), count = ref(0), list = ref<SpeechcraftRow[]>([]), loading = ref(false);
const filterError = ref(""), listError = ref("");
const editorVisible = ref(false), editorMode = ref<"create" | "edit">("create"), editorId = ref(0);
const editor = reactive<SpeechcraftInput>({ cate_id: 0, title: "", message: "", sort: 0 });
const detailLoading = ref(false), detailError = ref("");
const categoryEditorVisible = ref(false), categoryEditorId = ref(0);
const categoryEditor = reactive<SpeechcraftCategoryInput>({ name: "", sort: 0 });
const mutationError = ref(""), busy = ref(false);
let alive = false, syncing = false, generation = 0, detailGeneration = 0;
let stored = localStorage.getItem("admin_session");
let listAbort: AbortController | null = null, categoriesAbort: AbortController | null = null;
let detailAbort: AbortController | null = null;
const sessionVersion = ref(0);
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ""}:${auth.uniqueAuth.join(",")}`);
function hasPermission(key: string): boolean {
  void sessionVersion.value;
  const session = getAdminSession();
  return !!auth.token && auth.token === getToken() && stored === localStorage.getItem("admin_session") &&
    !!auth.userInfo && !!session && session.userInfo.id === auth.userInfo.id &&
    session.userInfo.level === auth.userInfo.level &&
    (auth.userInfo.level === 0 || (auth.uniqueAuth.includes(key) && session.uniqueAuth.includes(key)));
}
const canView = computed(() => hasPermission("speechcraft.view") || hasPermission("speechcraft.manage"));
const canManage = computed(() => hasPermission("speechcraft.manage"));
type Stamp = { identity: string; stored: string | null; generation: number };
function stamp(): Stamp { return { identity: identity.value, stored, generation }; }
function current(value: Stamp): boolean { return alive && canView.value && value.identity === identity.value &&
  value.stored === stored && stored === localStorage.getItem("admin_session") &&
  value.generation === generation && auth.token === getToken(); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : "请求失败"; }
function categoryName(id: number): string {
  if (!id) return "未分类";
  return categories.value.find((item) => item.id === id)?.name ?? `已删除分类 #${id}`;
}
function clearEditor(): void {
  detailGeneration++; detailAbort?.abort(); detailAbort = null; editorVisible.value = false;
  editorId.value = 0; detailLoading.value = false; detailError.value = ""; mutationError.value = "";
  Object.assign(editor, { cate_id: 0, title: "", message: "", sort: 0 });
}
function closeEditor(): void { if (!editorVisible.value) clearEditor(); }
function closeCategoryEditor(): void { if (!categoryEditorVisible.value) {
  categoryEditorId.value = 0; Object.assign(categoryEditor, { name: "", sort: 0 }); mutationError.value = "";
} }
function clear(): void {
  generation++; listAbort?.abort(); categoriesAbort?.abort(); listAbort = categoriesAbort = null;
  clearEditor(); categoryEditorVisible.value = false; closeCategoryEditor();
  categories.value = []; list.value = []; count.value = 0; page.value = 1; selectedCategory.value = "";
  draftTitle.value = draftMessage.value = appliedTitle.value = appliedMessage.value = "";
  loading.value = categoriesLoading.value = false; listError.value = categoryError.value = filterError.value = "";
  busy.value = false;
}
async function loadCategories(): Promise<void> {
  if (!current(stamp())) return;
  categoriesAbort?.abort(); const scope = stamp(), controller = new AbortController(); categoriesAbort = controller;
  categoriesLoading.value = true; categoryError.value = "";
  try {
    const rows = await apiSpeechcraftCategories(controller.signal);
    if (current(scope) && categoriesAbort === controller) {
      categories.value = rows;
      if (selectedCategory.value !== "" && selectedCategory.value !== 0 &&
          !rows.some((row) => row.id === selectedCategory.value)) {
        selectedCategory.value = ""; void load(1);
      }
    }
  } catch (error) { if (current(scope) && categoriesAbort === controller) categoryError.value = errorText(error); }
  finally { if (categoriesAbort === controller) { categoriesAbort = null; categoriesLoading.value = false; } }
}
async function load(target = page.value): Promise<void> {
  if (!current(stamp())) return;
  listAbort?.abort(); const scope = stamp(), controller = new AbortController(); listAbort = controller;
  page.value = target; loading.value = true; listError.value = ""; list.value = []; count.value = 0;
  try {
    const result = await apiSpeechcraftList({ page: target, limit: 10, cate_id: selectedCategory.value,
      title: appliedTitle.value, message: appliedMessage.value }, controller.signal);
    if (current(scope) && listAbort === controller) {
      if (!result.list.length && target > 1 && result.count > 0) {
        await load(Math.min(target - 1, Math.ceil(result.count / 10)));
        return;
      }
      list.value = result.list; count.value = result.count;
    }
  } catch (error) { if (current(scope) && listAbort === controller) listError.value = errorText(error); }
  finally { if (listAbort === controller) { listAbort = null; loading.value = false; } }
}
function refresh(): void { if (!current(stamp())) return; void loadCategories(); void load(page.value); }
function selectCategory(value: "" | number): void { if (!current(stamp())) return;
  selectedCategory.value = value; void load(1); }
function search(): void {
  if (!current(stamp())) return;
  try {
    const query = normalizeSpeechcraftQuery({ page: 1, limit: 10, cate_id: selectedCategory.value,
      title: draftTitle.value, message: draftMessage.value });
    appliedTitle.value = query.title; appliedMessage.value = query.message; filterError.value = ""; void load(1);
  } catch (error) { filterError.value = errorText(error); }
}
function resetSearch(): void { draftTitle.value = draftMessage.value = ""; search(); }
function openCreate(): void {
  if (!canManage.value || !current(stamp()) || busy.value) return;
  clearEditor(); editorMode.value = "create"; editor.cate_id = selectedCategory.value === "" ? 0 : selectedCategory.value;
  editorVisible.value = true;
}
async function openDetail(row: SpeechcraftRow): Promise<void> {
  if (!current(stamp()) || !list.value.some((item) => item.id === row.id) || busy.value) return;
  clearEditor(); editorMode.value = "edit"; editorId.value = row.id; editorVisible.value = true;
  await reloadDetail();
}
async function reloadDetail(): Promise<void> {
  if (!editorVisible.value || editorMode.value !== "edit" || !editorId.value || !current(stamp())) return;
  detailGeneration++; detailAbort?.abort(); const version = detailGeneration;
  const scope = stamp(), controller = new AbortController(); detailAbort = controller;
  detailLoading.value = true; detailError.value = "";
  try {
    const row = await apiSpeechcraftDetail(editorId.value, controller.signal);
    if (current(scope) && editorVisible.value && detailGeneration === version && detailAbort === controller) {
      Object.assign(editor, { cate_id: row.cate_id, title: row.title, message: row.message, sort: row.sort });
    }
  } catch (error) { if (current(scope) && detailGeneration === version && detailAbort === controller) detailError.value = errorText(error); }
  finally { if (detailAbort === controller) { detailAbort = null; detailLoading.value = false; } }
}
async function savePhrase(): Promise<void> {
  if (!canManage.value || !current(stamp()) || !editorVisible.value || detailLoading.value || detailError.value || busy.value) return;
  let input: SpeechcraftInput;
  try { input = normalizeSpeechcraftInput({ ...editor }); mutationError.value = ""; }
  catch (error) { mutationError.value = errorText(error); return; }
  const scope = stamp(), mode = editorMode.value, id = editorId.value;
  if (mode === "edit" && !id) return;
  busy.value = true;
  try {
    if (mode === "create") await apiSpeechcraftCreate(input);
    else await apiSpeechcraftUpdate(id, input);
    if (current(scope)) { ElMessage.success(mode === "create" ? "话术已添加" : "话术已更新");
      editorVisible.value = false; clearEditor(); await load(mode === "create" ? 1 : page.value); }
  } catch (error) { if (current(scope)) mutationError.value = `${errorText(error)}；请刷新列表核对结果后再操作`; }
  finally { if (current(scope)) busy.value = false; }
}
async function removePhrase(row: SpeechcraftRow): Promise<void> {
  if (!canManage.value || !current(stamp()) || busy.value || !list.value.some((item) => item.id === row.id)) return;
  const scope = stamp();
  try { await ElMessageBox.confirm(`确认删除话术 #${row.id}？此操作不能撤销。`, "删除话术", { type: "warning" }); }
  catch { return; }
  if (!current(scope) || !canManage.value || busy.value || !list.value.some((item) => item.id === row.id)) return;
  busy.value = true;
  try { await apiSpeechcraftDelete(row.id);
    if (current(scope)) { ElMessage.success("话术已删除"); await load(page.value); }
  } catch (error) { if (current(scope)) listError.value = `${errorText(error)}；请刷新列表核对结果后再操作`; }
  finally { if (current(scope)) busy.value = false; }
}
function openCategoryCreate(): void {
  if (!canManage.value || !current(stamp()) || busy.value) return;
  closeCategoryEditor(); categoryEditorId.value = 0; categoryEditorVisible.value = true;
}
function categoryCommand(command: string, row: SpeechcraftCategory): void {
  if (!canManage.value || !current(stamp()) || busy.value || !categories.value.some((item) => item.id === row.id)) return;
  if (command === "delete") { void removeCategory(row); return; }
  if (command === "edit") { closeCategoryEditor(); categoryEditorId.value = row.id;
    Object.assign(categoryEditor, { name: row.name, sort: row.sort }); categoryEditorVisible.value = true; }
}
async function saveCategory(): Promise<void> {
  if (!canManage.value || !current(stamp()) || !categoryEditorVisible.value || busy.value) return;
  let input: SpeechcraftCategoryInput;
  try { input = normalizeSpeechcraftCategoryInput({ ...categoryEditor }); mutationError.value = ""; }
  catch (error) { mutationError.value = errorText(error); return; }
  const scope = stamp(), id = categoryEditorId.value; busy.value = true;
  try {
    if (id) await apiSpeechcraftCategoryUpdate(id, input); else await apiSpeechcraftCategoryCreate(input);
    if (current(scope)) { ElMessage.success(id ? "分类已更新" : "分类已添加");
      categoryEditorVisible.value = false; closeCategoryEditor(); await loadCategories(); }
  } catch (error) { if (current(scope)) mutationError.value = `${errorText(error)}；请刷新分类核对结果后再操作`; }
  finally { if (current(scope)) busy.value = false; }
}
async function removeCategory(row: SpeechcraftCategory): Promise<void> {
  if (!canManage.value || !current(stamp()) || busy.value) return;
  const scope = stamp();
  try { await ElMessageBox.confirm(`确认删除分类“${row.name}”？已有话术会保留原分类 ID，并在“全部”中标记为已删除分类。`,
    "删除分类", { type: "warning" }); } catch { return; }
  if (!current(scope) || !canManage.value || busy.value || !categories.value.some((item) => item.id === row.id)) return;
  busy.value = true;
  try { await apiSpeechcraftCategoryDelete(row.id);
    if (current(scope)) { ElMessage.success("分类已删除，话术已保留");
      if (selectedCategory.value === row.id) selectedCategory.value = "";
      await loadCategories(); await load(1); }
  } catch (error) { if (current(scope)) categoryError.value = `${errorText(error)}；请刷新分类核对结果后再操作`; }
  finally { if (current(scope)) busy.value = false; }
}
function syncSession(): void {
  syncing = true; clear(); const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  stored = localStorage.getItem("admin_session"); sessionVersion.value++; syncing = false;
  if (canView.value) { void loadCategories(); void load(1); }
}
function syncStorage(event: StorageEvent): void {
  if (event.key === null || event.key === "admin_token" || event.key === "admin_session") syncSession();
}
watch(identity, () => { if (alive && !syncing) syncSession(); }, { flush: "sync" });
watch(editorVisible, (visible) => { if (!visible) clearEditor(); }, { flush: "sync" });
watch(categoryEditorVisible, (visible) => { if (!visible) closeCategoryEditor(); }, { flush: "sync" });
onMounted(() => { alive = true; window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession); window.addEventListener("storage", syncStorage);
  syncSession(); });
onBeforeUnmount(() => { alive = false; clear(); window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession); window.removeEventListener("storage", syncStorage); });
</script>

<style scoped>
.speechcraft-page { min-width: 0; }.heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.heading h2 { margin: 0 0 6px; font-size: 20px; }.hint { color: var(--el-text-color-secondary); font-size: 13px; }
.heading-actions, .filters { display: flex; align-items: end; flex-wrap: wrap; gap: 8px; }
.heading-actions :deep(.el-button + .el-button), .filters :deep(.el-button + .el-button) { margin-left: 0; }
.work-area { display: grid; grid-template-columns: minmax(175px, 230px) minmax(0, 1fr); gap: 16px; margin-top: 16px; }
.category-panel, .main-panel { min-width: 0; }.list-panel { margin-top: 16px; }.categories { display: grid; gap: 5px; }
.category-row { display: flex; align-items: center; justify-content: space-between; gap: 2px; }
.category { text-align: left; border: 0; width: 100%; background: transparent; border-radius: 4px;
  padding: 8px 10px; cursor: pointer; color: var(--el-text-color-primary); overflow-wrap: anywhere; }
.category:hover, .category.selected { color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.field { display: flex; flex: 1 1 200px; flex-direction: column; gap: 6px; min-width: 170px; font-size: 13px; }
.table-scroll { width: 100%; overflow-x: auto; }.pager { margin-top: 16px; justify-content: flex-end; }
.message { white-space: pre-wrap; overflow-wrap: anywhere; }.full { width: 100%; }
@media (max-width: 850px) { .work-area { grid-template-columns: 1fr; }.categories { display: flex; flex-wrap: wrap; }
  .category-row { max-width: 100%; } }
</style>
