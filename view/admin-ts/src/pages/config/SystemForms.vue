<template>
  <div class="system-forms" v-loading="loading">
    <div class="page-heading">
      <div>
        <h2>系统表单</h2>
        <p>构建下单时需要用户补充的受控字段；已提交订单继续使用保存时的不可变表单快照。</p>
      </div>
      <el-button type="primary" :disabled="!canManage" @click="openCreate">新增表单</el-button>
    </div>

    <el-alert
      v-if="!canManage"
      type="warning"
      :closable="false"
      show-icon
      title="当前账号只有查看权限，需要 config.manage 才能新增、编辑、停用或删除。"
    />

    <el-card shadow="never">
      <div class="filters">
        <el-input v-model="query.name" clearable placeholder="模板名称" @keyup.enter="search">
          <template #prefix>搜索</template>
        </el-input>
        <el-select v-model="query.status" clearable placeholder="全部状态">
          <el-option label="启用" value="1" />
          <el-option label="停用" value="0" />
        </el-select>
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="reset">重置</el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="list-card">
      <el-table :data="rows" class="desktop-table">
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="name" label="模板名称" min-width="180" />
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-switch
              v-model="row.status"
              :active-value="1"
              :inactive-value="0"
              :disabled="!canManage || statusSavingId === row.id"
              @change="changeStatus(row, $event)"
            />
          </template>
        </el-table-column>
        <el-table-column label="添加时间" min-width="170">
          <template #default="{ row }">{{ formatTime(row.add_time) }}</template>
        </el-table-column>
        <el-table-column label="更新时间" min-width="170">
          <template #default="{ row }">{{ formatTime(row.update_time) }}</template>
        </el-table-column>
        <el-table-column label="操作" min-width="250" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openData(row)">提交数据</el-button>
            <el-button link type="primary" :disabled="!canManage" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" :disabled="!canManage" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="mobile-list">
        <article v-for="row in rows" :key="row.id" class="mobile-card">
          <div class="mobile-heading">
            <strong>{{ row.name }}</strong>
            <el-tag :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? "启用" : "停用" }}</el-tag>
          </div>
          <p>ID {{ row.id }} · 更新于 {{ formatTime(row.update_time) }}</p>
          <div class="mobile-actions">
            <el-button @click="openData(row)">提交数据</el-button>
            <el-button :disabled="!canManage" @click="openEdit(row)">编辑</el-button>
            <el-button type="danger" plain :disabled="!canManage" @click="remove(row)">删除</el-button>
          </div>
        </article>
      </div>

      <el-empty v-if="!rows.length && !loading" description="暂无系统表单" />
      <el-pagination
        v-if="total > query.limit"
        v-model:current-page="query.page"
        :page-size="query.limit"
        :total="total"
        layout="prev, pager, next, total"
        @current-change="loadList"
      />
    </el-card>

    <el-dialog
      v-model="editorVisible"
      :title="editorId ? '编辑系统表单' : '新增系统表单'"
      width="min(1180px, 96vw)"
      top="3vh"
      destroy-on-close
      class="form-editor-dialog"
    >
      <div v-loading="editorLoading" class="editor-shell">
        <el-form label-position="top">
          <el-form-item label="模板名称" required>
            <el-input v-model="editorName" maxlength="255" show-word-limit placeholder="例如：企业采购信息" />
          </el-form-item>
        </el-form>

        <div class="palette" aria-label="表单组件库">
          <span>点击添加：</span>
          <el-button
            v-for="item in palette"
            :key="item.name"
            size="small"
            @click="addComponent(item.name)"
          >{{ item.label }}</el-button>
        </div>

        <el-alert
          type="info"
          :closable="false"
          title="组件可拖动排序，也可使用上下移动按钮；最多 100 项。"
        />

        <div class="builder-grid">
          <section class="builder-canvas">
            <div class="section-title">表单画布（{{ editorComponents.length }} 项）</div>
            <div
              v-for="(item, index) in editorComponents"
              :key="item.id"
              class="component-card"
              :class="{ active: selectedIndex === index }"
              draggable="true"
              role="button"
              tabindex="0"
              @click="selectedIndex = index"
              @keydown.enter="selectedIndex = index"
              @keydown.space.prevent="selectedIndex = index"
              @dragstart="dragStart(index, $event)"
              @dragover.prevent
              @drop.prevent="dropAt(index)"
            >
              <span class="drag-handle" aria-hidden="true">⋮⋮</span>
              <span class="component-copy">
                <strong>{{ item.titleConfig.value || typeLabel(item.name) }}</strong>
                <small>{{ typeLabel(item.name) }}{{ item.titleShow.val ? " · 必填" : "" }}</small>
              </span>
              <span class="component-actions" @click.stop>
                <el-button link :disabled="index === 0" aria-label="上移" @click="move(index, -1)">↑</el-button>
                <el-button link :disabled="index === editorComponents.length - 1" aria-label="下移" @click="move(index, 1)">↓</el-button>
                <el-button link type="danger" aria-label="删除组件" @click="removeComponent(index)">删除</el-button>
              </span>
            </div>
            <el-empty v-if="!editorComponents.length" description="请从上方添加组件" :image-size="72" />
          </section>

          <section class="inspector">
            <div class="section-title">组件设置</div>
            <el-form v-if="selectedComponent" label-position="top">
              <el-form-item label="字段标题" required>
                <el-input v-model="selectedComponent.titleConfig.value" maxlength="100" show-word-limit />
              </el-form-item>
              <el-form-item label="提示语">
                <el-input v-model="selectedTip" maxlength="200" show-word-limit />
              </el-form-item>
              <el-form-item label="是否必填">
                <el-switch v-model="selectedComponent.titleShow.val" />
              </el-form-item>

              <template v-if="selectedComponent.name === 'texts'">
                <el-form-item label="文本类型">
                  <el-select v-model="selectedTextSubtype" class="full-width">
                    <el-option v-for="item in textSubtypes" :key="item.value" :label="item.label" :value="item.value" />
                  </el-select>
                </el-form-item>
                <el-form-item label="默认值">
                  <el-input v-model="selectedDefaultValue" maxlength="10000" />
                </el-form-item>
              </template>

              <template v-if="hasChoices(selectedComponent)">
                <el-form-item label="选项（1～50 项）" required>
                  <div class="choice-list">
                    <div v-for="(choice, index) in selectedChoices" :key="index" class="choice-row">
                      <el-input v-model="choice.val" maxlength="100" />
                      <el-button type="danger" plain :disabled="selectedChoices.length === 1" @click="removeChoice(index)">删除</el-button>
                    </div>
                    <el-button :disabled="selectedChoices.length >= 50" @click="addChoice">添加选项</el-button>
                  </div>
                </el-form-item>
              </template>

              <el-form-item v-if="selectedComponent.name === 'uploadPicture'" label="最多上传图片数">
                <el-input-number v-model="selectedUploadLimit" :min="1" :max="9" />
              </el-form-item>
            </el-form>
            <el-empty v-else description="选择一个组件后编辑" :image-size="72" />
          </section>

          <section class="form-preview">
            <div class="section-title">用户端预览</div>
            <div v-for="(item, index) in editorComponents" :key="item.id" class="preview-field">
              <label>{{ item.titleConfig.value || `表单项 ${index + 1}` }}<em v-if="item.titleShow.val">*</em></label>
              <div v-if="hasChoices(item)" class="preview-choices">
                <el-tag v-for="choice in item.wordsConfig?.list" :key="choice.val" effect="plain">{{ choice.val || "未命名" }}</el-tag>
              </div>
              <el-button v-else-if="item.name === 'uploadPicture'" disabled>上传图片（最多 {{ item.numConfig?.val || 9 }} 张）</el-button>
              <el-input v-else disabled :placeholder="item.tipConfig?.value || previewPlaceholder(item.name)" />
            </div>
            <el-empty v-if="!editorComponents.length" description="暂无预览" :image-size="72" />
          </section>
        </div>
      </div>
      <template #footer>
        <el-button @click="editorVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!canManage" @click="saveEditor">保存表单</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="dataVisible" :title="`${dataFormName} · 提交数据`" size="min(1080px, 96vw)">
      <div v-loading="dataLoading" class="submission-panel">
        <div class="data-filters">
          <el-input v-model="dataQuery.uid" clearable placeholder="用户 ID" />
          <el-input v-model="dataQuery.relation_id" clearable placeholder="关联订单/业务 ID" />
          <el-select v-model="dataQuery.type" clearable placeholder="全部来源">
            <el-option label="订单" value="1" />
            <el-option label="其他" value="2" />
          </el-select>
          <el-date-picker
            v-model="dataDateRange"
            type="datetimerange"
            value-format="X"
            start-placeholder="开始时间"
            end-placeholder="结束时间"
          />
          <el-button type="primary" @click="searchData">查询</el-button>
          <el-button @click="resetData">重置</el-button>
          <el-button :loading="dataExporting" :disabled="dataTotal > 5000" @click="exportData">导出 CSV</el-button>
        </div>

        <article v-for="item in dataRows" :key="item.id" class="submission-card">
          <div class="submission-heading">
            <div>
              <strong>{{ item.nickname || `用户 ${item.uid}` }}</strong>
              <span>UID {{ item.uid }} · {{ item.phone || "无手机号" }}</span>
            </div>
            <el-tag effect="plain">关联 ID {{ item.relation_id }}</el-tag>
          </div>
          <dl>
            <template v-for="(field, index) in item.value" :key="String(field.id ?? index)">
              <dt>{{ field.title || field.name || `表单项 ${index + 1}` }}</dt>
              <dd>{{ displayValue(field.value) }}</dd>
            </template>
          </dl>
          <time>{{ formatTime(item.add_time) }}</time>
        </article>
        <el-empty v-if="!dataRows.length && !dataLoading" description="暂无提交数据" />
        <el-pagination
          v-if="dataTotal > dataQuery.limit"
          v-model:current-page="dataQuery.page"
          :page-size="dataQuery.limit"
          :total="dataTotal"
          layout="prev, pager, next, total"
          @current-change="loadData"
        />
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiDeleteSystemForm,
  apiSaveSystemForm,
  apiSetSystemFormStatus,
  apiSystemFormData,
  apiSystemFormInfo,
  apiSystemFormList,
  type SystemFormChoice,
  type SystemFormComponent,
  type SystemFormComponentName,
  type SystemFormDataItem,
  type SystemFormDataQuery,
  type SystemFormListItem,
} from "@/api/systemForms";
import { useAuthStore } from "@/stores/auth";

const authStore = useAuthStore();
const previewMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
const canManage = computed(() => previewMode || authStore.userInfo?.level === 0 || authStore.uniqueAuth.includes("config.manage"));
const loading = ref(false);
const rows = ref<SystemFormListItem[]>([]);
const total = ref(0);
const query = ref({ page: 1, limit: 15, name: "", status: "" });
const statusSavingId = ref(0);

const editorVisible = ref(false);
const editorLoading = ref(false);
const saving = ref(false);
const editorId = ref(0);
const editorName = ref("");
const editorComponents = ref<SystemFormComponent[]>([]);
const selectedIndex = ref(-1);
const draggedIndex = ref(-1);
let componentSequence = 0;

const dataVisible = ref(false);
const dataLoading = ref(false);
const dataFormId = ref(0);
const dataFormName = ref("");
const dataRows = ref<SystemFormDataItem[]>([]);
const dataTotal = ref(0);
const dataExporting = ref(false);
const dataDateRange = ref<Array<string | number>>([]);
const emptyDataQuery = (): SystemFormDataQuery => ({ page: 1, limit: 20, uid: "", type: "", relation_id: "" });
const dataQuery = ref<SystemFormDataQuery>(emptyDataQuery());

const palette: Array<{ name: SystemFormComponentName; label: string }> = [
  { name: "texts", label: "文本框" },
  { name: "radios", label: "单选框" },
  { name: "checkboxs", label: "多选框" },
  { name: "selects", label: "下拉框" },
  { name: "citys", label: "城市" },
  { name: "dates", label: "日期" },
  { name: "dateranges", label: "日期范围" },
  { name: "times", label: "时间" },
  { name: "timeranges", label: "时间范围" },
  { name: "uploadPicture", label: "图片" },
];
const allowedNames = new Set(palette.map((item) => item.name));
const textSubtypes = [
  { label: "普通文本", value: 0 },
  { label: "手机号", value: 1 },
  { label: "身份证号", value: 2 },
  { label: "邮箱", value: 3 },
  { label: "正数", value: 4 },
];

const selectedComponent = computed(() => editorComponents.value[selectedIndex.value] ?? null);
const selectedTip = computed({
  get: () => selectedComponent.value?.tipConfig?.value ?? "",
  set: (value: string) => {
    if (selectedComponent.value) selectedComponent.value.tipConfig = { value };
  },
});
const selectedTextSubtype = computed({
  get: () => selectedComponent.value?.valConfig?.tabVal ?? 0,
  set: (value: number) => {
    if (selectedComponent.value) selectedComponent.value.valConfig = { tabVal: value };
  },
});
const selectedDefaultValue = computed({
  get: () => selectedComponent.value?.defaultValConfig?.value ?? "",
  set: (value: string) => {
    if (selectedComponent.value) selectedComponent.value.defaultValConfig = { value };
  },
});
const selectedChoices = computed<SystemFormChoice[]>(() => selectedComponent.value?.wordsConfig?.list ?? []);
const selectedUploadLimit = computed({
  get: () => selectedComponent.value?.numConfig?.val ?? 9,
  set: (value: number | undefined) => {
    if (selectedComponent.value) selectedComponent.value.numConfig = { val: Number(value ?? 1) };
  },
});

function typeLabel(name: SystemFormComponentName): string {
  return palette.find((item) => item.name === name)?.label ?? name;
}

function componentId(): { id: string; timestamp: number } {
  const timestamp = Date.now() * 100 + componentSequence++;
  return { id: `admin-form-${timestamp}`, timestamp };
}

function makeComponent(name: SystemFormComponentName): SystemFormComponent {
  const base: SystemFormComponent = {
    ...componentId(),
    name,
    titleConfig: { value: typeLabel(name) },
    titleShow: { val: true },
    tipConfig: { value: name === "uploadPicture" ? "请上传图片" : "请填写" },
    value: name === "uploadPicture" || name === "dateranges" ? [] : "",
  };
  if (["checkboxs", "radios", "selects"].includes(name)) {
    base.wordsConfig = { list: [{ val: "选项一" }, { val: "选项二" }] };
  }
  if (name === "texts") {
    base.valConfig = { tabVal: 0 };
    base.defaultValConfig = { value: "" };
  }
  if (name === "uploadPicture") base.numConfig = { val: 3 };
  return base;
}

function choiceText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const candidate = record.val ?? record.value ?? record.label;
  return typeof candidate === "string" || typeof candidate === "number" ? String(candidate) : "";
}

function normalizeEditorComponent(raw: unknown, index: number): SystemFormComponent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, any>;
  if (!allowedNames.has(item.name as SystemFormComponentName)) return null;
  const name = item.name as SystemFormComponentName;
  const timestamp = Number.isSafeInteger(Number(item.timestamp)) ? Number(item.timestamp) : Date.now() * 100 + index;
  const id = typeof item.id === "string" || typeof item.id === "number" ? String(item.id) : `legacy-form-${timestamp}`;
  const component: SystemFormComponent = {
    id,
    timestamp,
    name,
    titleConfig: { value: String(item.titleConfig?.value ?? typeLabel(name)).slice(0, 100) },
    titleShow: { val: Boolean(item.titleShow?.val) },
    tipConfig: { value: String(item.tipConfig?.value ?? "").slice(0, 200) },
    value: name === "uploadPicture" || name === "dateranges" ? [] : "",
  };
  if (["checkboxs", "radios", "selects"].includes(name)) {
    const choices = Array.isArray(item.wordsConfig?.list)
      ? item.wordsConfig.list.map(choiceText).map((val: string) => ({ val: val.slice(0, 100) })).filter((choice: SystemFormChoice) => choice.val)
      : [];
    component.wordsConfig = { list: choices.length ? choices.slice(0, 50) : [{ val: "选项一" }] };
  }
  if (name === "texts") {
    const subtype = Number(item.valConfig?.tabVal ?? 0);
    component.valConfig = { tabVal: Number.isSafeInteger(subtype) && subtype >= 0 && subtype <= 4 ? subtype : 0 };
    component.defaultValConfig = { value: String(item.defaultValConfig?.value ?? "").slice(0, 10_000) };
  }
  if (name === "uploadPicture") {
    const limit = Number(item.numConfig?.val ?? 9);
    component.numConfig = { val: Number.isSafeInteger(limit) ? Math.max(1, Math.min(9, limit)) : 9 };
  }
  return component;
}

async function loadList() {
  loading.value = true;
  try {
    const result = await apiSystemFormList(query.value);
    rows.value = result.list;
    total.value = result.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "系统表单加载失败");
  } finally {
    loading.value = false;
  }
}

function search() { query.value.page = 1; loadList(); }
function reset() { query.value = { page: 1, limit: 15, name: "", status: "" }; loadList(); }
function formatTime(value: number) {
  return value > 0 ? new Date(value * 1_000).toLocaleString("zh-CN", { hour12: false }) : "-";
}

function openCreate() {
  editorId.value = 0;
  editorName.value = "";
  editorComponents.value = [];
  selectedIndex.value = -1;
  editorVisible.value = true;
}

async function openEdit(row: SystemFormListItem) {
  editorVisible.value = true;
  editorLoading.value = true;
  try {
    const info = await apiSystemFormInfo(row.id);
    editorId.value = info.id;
    editorName.value = info.name;
    editorComponents.value = info.value.map(normalizeEditorComponent).filter((item): item is SystemFormComponent => Boolean(item));
    selectedIndex.value = editorComponents.value.length ? 0 : -1;
  } catch (error) {
    editorVisible.value = false;
    ElMessage.error(error instanceof Error ? error.message : "表单详情加载失败");
  } finally {
    editorLoading.value = false;
  }
}

function addComponent(name: SystemFormComponentName) {
  if (editorComponents.value.length >= 100) return ElMessage.error("表单组件不能超过100项");
  editorComponents.value.push(makeComponent(name));
  selectedIndex.value = editorComponents.value.length - 1;
}

function move(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= editorComponents.value.length) return;
  const [item] = editorComponents.value.splice(index, 1);
  editorComponents.value.splice(target, 0, item);
  selectedIndex.value = target;
}

function removeComponent(index: number) {
  editorComponents.value.splice(index, 1);
  if (!editorComponents.value.length) selectedIndex.value = -1;
  else selectedIndex.value = Math.min(index, editorComponents.value.length - 1);
}

function dragStart(index: number, event: DragEvent) {
  draggedIndex.value = index;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
  }
}

function dropAt(index: number) {
  const source = draggedIndex.value;
  draggedIndex.value = -1;
  if (source < 0 || source === index) return;
  const [item] = editorComponents.value.splice(source, 1);
  const target = index;
  editorComponents.value.splice(target, 0, item);
  selectedIndex.value = target;
}

function hasChoices(item: SystemFormComponent) {
  return ["checkboxs", "radios", "selects"].includes(item.name);
}
function addChoice() {
  if (!selectedComponent.value || !hasChoices(selectedComponent.value)) return;
  selectedComponent.value.wordsConfig!.list.push({ val: `选项${selectedChoices.value.length + 1}` });
}
function removeChoice(index: number) {
  if (selectedChoices.value.length <= 1) return;
  selectedChoices.value.splice(index, 1);
}
function previewPlaceholder(name: SystemFormComponentName) {
  if (name === "dates" || name === "dateranges") return "请选择日期";
  if (name === "times" || name === "timeranges") return "请选择时间";
  if (name === "citys") return "请选择省市区";
  return "请填写";
}

async function saveEditor() {
  if (!editorName.value.trim()) return ElMessage.error("请输入模板名称");
  if (!editorComponents.value.length) return ElMessage.error("请至少添加一个表单组件");
  saving.value = true;
  try {
    await apiSaveSystemForm(editorId.value, {
      name: editorName.value.trim(),
      value: JSON.parse(JSON.stringify(editorComponents.value)) as SystemFormComponent[],
    });
    editorVisible.value = false;
    ElMessage.success("系统表单已保存");
    await loadList();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "系统表单保存失败");
  } finally {
    saving.value = false;
  }
}

async function changeStatus(row: SystemFormListItem, value: string | number | boolean) {
  const status = Number(value);
  const previous = status === 1 ? 0 : 1;
  statusSavingId.value = row.id;
  try {
    await apiSetSystemFormStatus(row.id, status);
    ElMessage.success(status === 1 ? "系统表单已启用" : "系统表单已停用");
  } catch (error) {
    row.status = previous;
    ElMessage.error(error instanceof Error ? error.message : "状态修改失败");
  } finally {
    statusSavingId.value = 0;
  }
}

async function remove(row: SystemFormListItem) {
  try {
    await ElMessageBox.confirm(
      `确定删除“${row.name}”吗？仍被商品或活动使用的表单会被服务端拒绝。`,
      "删除系统表单",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
    );
    await apiDeleteSystemForm(row.id);
    if (rows.value.length === 1 && query.value.page > 1) query.value.page--;
    ElMessage.success("系统表单已删除");
    await loadList();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : "删除失败");
  }
}

async function openData(row: SystemFormListItem) {
  dataFormId.value = row.id;
  dataFormName.value = row.name;
  dataQuery.value = emptyDataQuery();
  dataDateRange.value = [];
  dataVisible.value = true;
  await loadData();
}

async function loadData() {
  dataLoading.value = true;
  try {
    const result = await apiSystemFormData(dataFormId.value, dataParams());
    dataRows.value = result.list;
    dataTotal.value = result.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "提交数据加载失败");
  } finally {
    dataLoading.value = false;
  }
}

function dataParams(page = dataQuery.value.page, limit = dataQuery.value.limit): SystemFormDataQuery {
  const params: SystemFormDataQuery = { ...dataQuery.value, page, limit };
  if (dataDateRange.value.length === 2) {
    params.start_time = Number(dataDateRange.value[0]);
    params.end_time = Number(dataDateRange.value[1]);
  }
  return params;
}

function csvCell(value: unknown): string {
  const raw = String(value ?? "");
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

async function exportData() {
  dataExporting.value = true;
  try {
    const collected: SystemFormDataItem[] = [];
    let page = 1;
    let count = 0;
    do {
      const result = await apiSystemFormData(dataFormId.value, dataParams(page, 100));
      count = result.count;
      if (count > 5_000) throw new Error("提交数据超过5000条，请先缩小筛选范围");
      collected.push(...result.list);
      page++;
    } while (collected.length < count);
    if (!collected.length) return ElMessage.info("当前筛选条件没有可导出的提交数据");
    const lines = [
      ["记录ID", "模板", "用户", "UID", "手机号", "来源类型", "关联ID", "表单内容", "提交时间"],
      ...collected.map((item) => [
        item.id,
        item.system_form_name ?? dataFormName.value,
        item.nickname ?? "",
        item.uid,
        item.phone ?? "",
        item.type,
        item.relation_id,
        item.value.map((field, index) => `${field.title || field.name || `表单项${index + 1}`}：${displayValue(field.value)}`).join("；"),
        formatTime(item.add_time),
      ]),
    ];
    const csv = `\uFEFF${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${dataFormName.value || "系统表单"}-提交数据.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    ElMessage.success(`已导出 ${collected.length} 条提交数据`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "提交数据导出失败");
  } finally {
    dataExporting.value = false;
  }
}

function searchData() { dataQuery.value.page = 1; loadData(); }
function resetData() { dataQuery.value = emptyDataQuery(); dataDateRange.value = []; loadData(); }
function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join("、") || "-";
  if (value && typeof value === "object") return JSON.stringify(value).slice(0, 1_000);
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 10_000) : "-";
}

onMounted(loadList);
</script>

<style scoped>
.system-forms { display: grid; gap: 16px; min-width: 0; max-width: 1400px; margin: 0 auto; }
.page-heading, .filters, .mobile-heading, .mobile-actions, .palette, .submission-heading { display: flex; align-items: center; }
.page-heading, .mobile-heading, .submission-heading { justify-content: space-between; }
.page-heading { gap: 20px; }
.page-heading h2 { margin: 0 0 6px; font-size: 22px; }
.page-heading p { margin: 0; color: var(--el-text-color-secondary); }
.filters { gap: 10px; flex-wrap: wrap; }
.filters .el-input { width: min(320px, 100%); }
.filters .el-select { width: 160px; }
.list-card :deep(.el-card__body) { display: grid; gap: 16px; }
.mobile-list { display: none; }
.editor-shell { display: grid; gap: 14px; min-height: 480px; }
.palette { gap: 8px; flex-wrap: wrap; }
.palette > span { color: var(--el-text-color-secondary); }
.builder-grid { display: grid; grid-template-columns: minmax(260px, .9fr) minmax(290px, 1fr) minmax(260px, .9fr); gap: 14px; min-height: 420px; }
.builder-canvas, .inspector, .form-preview { min-width: 0; padding: 14px; border: 1px solid var(--el-border-color-lighter); border-radius: 10px; background: var(--el-bg-color); overflow: auto; }
.section-title { margin-bottom: 12px; font-weight: 700; }
.component-card { display: flex; align-items: center; width: 100%; min-width: 0; margin-bottom: 9px; padding: 10px; color: inherit; text-align: left; border: 1px solid var(--el-border-color); border-radius: 8px; background: var(--el-bg-color); cursor: grab; }
.component-card.active { border-color: var(--el-color-primary); box-shadow: 0 0 0 2px var(--el-color-primary-light-8); }
.drag-handle { color: var(--el-text-color-placeholder); font-weight: 700; }
.component-copy { display: grid; gap: 3px; min-width: 0; margin-left: 8px; }
.component-copy strong, .component-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.component-copy small { color: var(--el-text-color-secondary); }
.component-actions { display: flex; align-items: center; margin-left: auto; }
.full-width { width: 100%; }
.choice-list { display: grid; gap: 8px; width: 100%; }
.choice-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.preview-field { display: grid; gap: 8px; margin-bottom: 14px; }
.preview-field label { font-size: 13px; font-weight: 600; }
.preview-field em { margin-left: 3px; color: var(--el-color-danger); font-style: normal; }
.preview-choices { display: flex; gap: 6px; flex-wrap: wrap; }
.submission-panel { display: grid; gap: 14px; }
.data-filters { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)) minmax(260px, 1.6fr) auto auto; gap: 8px; }
.submission-card { padding: 15px; border: 1px solid var(--el-border-color-lighter); border-radius: 10px; }
.submission-heading { gap: 12px; }
.submission-heading > div { display: grid; gap: 4px; }
.submission-heading span, .submission-card time { color: var(--el-text-color-secondary); font-size: 12px; }
.submission-card dl { display: grid; grid-template-columns: minmax(100px, 180px) minmax(0, 1fr); gap: 8px 14px; margin: 14px 0; }
.submission-card dt { color: var(--el-text-color-secondary); }
.submission-card dd { min-width: 0; margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
@media (max-width: 1040px) {
  .builder-grid { grid-template-columns: 1fr 1fr; }
  .form-preview { grid-column: 1 / -1; }
  .data-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 680px) {
  .page-heading { align-items: stretch; flex-direction: column; }
  .desktop-table { display: none; }
  .mobile-list { display: grid; gap: 10px; }
  .mobile-card { padding: 14px; border: 1px solid var(--el-border-color-lighter); border-radius: 9px; }
  .mobile-card p { color: var(--el-text-color-secondary); }
  .mobile-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .mobile-actions .el-button { width: 100%; margin: 0; }
  .builder-grid { grid-template-columns: 1fr; }
  .form-preview { grid-column: auto; }
  .data-filters { grid-template-columns: 1fr; }
  .data-filters :deep(.el-date-editor) { width: 100%; }
  .submission-heading { align-items: flex-start; flex-direction: column; }
  .submission-card dl { grid-template-columns: 1fr; gap: 4px; }
  .submission-card dd { margin-bottom: 8px; }
}
</style>
