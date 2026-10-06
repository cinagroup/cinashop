<template>
  <div class="supplier-directory">
    <el-card shadow="never">
      <template #header>
        <div class="heading">
          <div><strong>供应商目录</strong><p>管理已建档供应商、主账号与启用状态。</p></div>
          <div class="heading-actions">
            <el-button v-if="canView" :loading="loading" :disabled="saving || mutating" @click="load(page)">刷新</el-button>
            <el-button v-if="canManage" type="primary" :disabled="saving || mutating" @click="openCreate">添加供应商</el-button>
          </div>
        </div>
      </template>
      <el-alert v-if="!canView" title="当前账号没有供应商目录查看权限" type="warning" :closable="false" show-icon />
      <template v-else>
        <div class="filters">
          <el-input v-model="draftKeyword" aria-label="供应商名称搜索" maxlength="80" clearable
            placeholder="请输入供应商名称" :disabled="saving || mutating" @keyup.enter="search" />
          <el-button type="primary" :disabled="saving || mutating" @click="search">查询</el-button>
          <el-button :disabled="saving || mutating" @click="resetFilters">重置</el-button>
        </div>
        <el-alert v-if="notice" :title="notice" type="warning" :closable="false" show-icon class="notice" />
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="notice" />
        <div class="table-scroll">
          <el-table :data="list" v-loading="loading" row-key="id" stripe empty-text="暂无供应商">
            <el-table-column prop="id" label="ID" width="78" />
            <el-table-column prop="supplier_name" label="供应商" min-width="155" show-overflow-tooltip />
            <el-table-column prop="name" label="联系人" min-width="115" />
            <el-table-column prop="phone" label="联系方式" min-width="132" />
            <el-table-column label="状态" min-width="100">
              <template #default="{ row }">
                <el-switch v-if="canManage" :model-value="row.is_show === 1"
                  :disabled="mutating || saving || loading" active-text="开启" inactive-text="关闭"
                  @change="toggleStatus(row)" />
                <el-tag v-else :type="row.is_show === 1 ? 'success' : 'info'">{{ row.is_show === 1 ? "开启" : "关闭" }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="_add_time" label="创建时间（上海）" min-width="175" />
            <el-table-column prop="mark" label="备注" min-width="145" show-overflow-tooltip />
            <el-table-column prop="sort" label="排序" width="85" />
            <el-table-column v-if="canManage" label="操作" min-width="140" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" :disabled="mutating || saving || loading" @click="openEdit(row)">编辑</el-button>
                <el-button link type="danger" :disabled="mutating || saving || loading" @click="remove(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
        <el-pagination class="pager" layout="total, sizes, prev, pager, next, jumper"
          :total="total" :page-size="pageSize" :current-page="page" :page-sizes="[15, 30, 50]"
          :disabled="loading || saving || mutating" @current-change="load" @size-change="changePageSize" />
      </template>
    </el-card>

    <el-dialog v-if="canManage" v-model="editorVisible" :title="editingId ? '编辑供应商' : '添加供应商'"
      width="min(760px, calc(100vw - 24px))" :close-on-click-modal="!saving"
      :close-on-press-escape="!saving" :show-close="!saving" @closed="closeEditor">
      <div v-loading="editorLoading" class="editor">
        <el-alert v-if="editorError" :title="editorError" type="error" :closable="false" show-icon />
        <el-alert v-if="regionError" :title="regionError" type="warning" :closable="false" show-icon />
        <template v-if="!editorLoading && editorReady">
          <div class="form-grid">
            <label><span>供应商名称 *</span><el-input v-model="draft.supplier_name" maxlength="25" :disabled="saving" /></label>
            <label><span>联系人姓名</span><el-input v-model="draft.name" maxlength="25" :disabled="saving" /></label>
            <label><span>联系电话 *</span><el-input v-model="draft.phone" maxlength="15" :disabled="saving" /></label>
            <label><span>供应商邮箱</span><el-input v-model="draft.email" maxlength="50" :disabled="saving" /></label>
            <label><span>省份 *</span><el-select v-model="draft.province" filterable placeholder="请选择省份"
              :disabled="saving || regionLoading" @change="setProvince">
              <el-option v-for="city in provinces" :key="city.value" :label="city.label" :value="city.value" />
            </el-select></label>
            <label><span>城市 *</span><el-select v-model="draft.city" filterable placeholder="请选择城市"
              :disabled="saving || regionLoading || !draft.province" @change="setCity">
              <el-option v-for="city in cities" :key="city.value" :label="city.label" :value="city.value" />
            </el-select></label>
            <label><span>区县 *</span><el-select v-model="draft.area" filterable placeholder="请选择区县"
              :disabled="saving || regionLoading || !draft.city" @change="setArea">
              <el-option v-for="city in areas" :key="city.value" :label="city.label" :value="city.value" />
            </el-select></label>
            <label><span>街道</span><el-select v-model="draft.street" filterable clearable placeholder="可选"
              :disabled="saving || regionLoading || !draft.area" @change="setStreet">
              <el-option v-for="city in streets" :key="city.value" :label="city.label" :value="city.value" />
            </el-select></label>
            <label class="wide"><span>省市区地址</span><el-input v-model="draft.address" maxlength="255"
              placeholder="选择地区后自动填写，可核对并调整" :disabled="saving" /></label>
            <label class="wide"><span>详细地址</span><el-input v-model="draft.detailed_address" maxlength="255" :disabled="saving" /></label>
            <label class="wide"><span>备注</span><el-input v-model="draft.mark" type="textarea" :rows="2" maxlength="255" show-word-limit :disabled="saving" /></label>
            <label><span>供应商登录用户名 *</span><el-input v-model="draft.account" maxlength="32" autocomplete="off" :disabled="saving" /></label>
            <label><span>{{ editingId ? '新登录密码（留空不改）' : '登录密码 *' }}</span>
              <el-input v-model="draft.pwd" type="password" show-password maxlength="72" autocomplete="new-password" :disabled="saving" /></label>
            <label><span>确认登录密码</span><el-input v-model="draft.conf_pwd" type="password" show-password
              maxlength="72" autocomplete="new-password" :disabled="saving" /></label>
            <label><span>排序</span><el-input-number v-model="draft.sort" :min="0" :max="999999" :disabled="saving" /></label>
            <label class="switch-field"><span>是否开启</span><el-switch v-model="draft.is_show"
              :active-value="1" :inactive-value="0" :disabled="saving" /></label>
          </div>
        </template>
      </div>
      <template #footer>
        <el-button :disabled="saving" @click="editorVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="editorLoading || !editorReady || uncertainSave" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { isAxiosError } from "axios";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import { AdminResponseError } from "@/utils/request";
import {
  apiSupplierDirectoryCities, apiSupplierDirectoryCreate, apiSupplierDirectoryDelete,
  apiSupplierDirectoryDetail, apiSupplierDirectoryList, apiSupplierDirectoryStatus,
  apiSupplierDirectoryUpdate, validateSupplierDirectoryForm,
  type SupplierDirectoryCity, type SupplierDirectoryDetail, type SupplierDirectoryForm,
  type SupplierDirectoryRow,
} from "@/api/supplierDirectory";

const auth = useAuthStore();
const stored = ref(localStorage.getItem("admin_session"));
const sessionVersion = ref(0);
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ""}:${auth.uniqueAuth.join(",")}`);
const validSession = computed(() => {
  void sessionVersion.value;
  const session = getAdminSession();
  return !!auth.token && auth.token === getToken() && !!auth.userInfo && !!session &&
    stored.value === localStorage.getItem("admin_session") &&
    session.userInfo.id === auth.userInfo.id && session.userInfo.level === auth.userInfo.level;
});
const canView = computed(() => {
  if (!validSession.value) return false;
  const session = getAdminSession()!;
  return auth.userInfo?.level === 0 || (auth.uniqueAuth.includes("supplier_directory.view") &&
    session.uniqueAuth.includes("supplier_directory.view"));
});
const canManage = computed(() => {
  if (!canView.value) return false;
  const session = getAdminSession()!;
  return auth.userInfo?.level === 0 || (auth.uniqueAuth.includes("supplier_directory.manage") &&
    session.uniqueAuth.includes("supplier_directory.manage"));
});

function blankForm(): SupplierDirectoryForm {
  return { supplier_name: "", name: "", phone: "", email: "", address: "", province: 0,
    city: 0, area: 0, street: 0, detailed_address: "", mark: "", account: "",
    pwd: "", conf_pwd: "", sort: 0, is_show: 0 };
}
const list = ref<SupplierDirectoryRow[]>([]), total = ref(0), page = ref(1), pageSize = ref(15);
const keyword = ref(""), draftKeyword = ref("");
const loading = ref(false), error = ref(""), notice = ref("");
const editorVisible = ref(false), editorLoading = ref(false), editorReady = ref(false), editorError = ref("");
const editingId = ref(0), editingRevision = ref(""), expectedAccount = ref("");
const draft = ref<SupplierDirectoryForm>(blankForm());
const provinces = ref<SupplierDirectoryCity[]>([]), cities = ref<SupplierDirectoryCity[]>([]);
const areas = ref<SupplierDirectoryCity[]>([]), streets = ref<SupplierDirectoryCity[]>([]);
const regionLoading = ref(false), regionError = ref("");
const saving = ref(false), uncertainSave = ref(false), mutating = ref(false), confirming = ref(false);
let alive = false, generation = 0, listVersion = 0, editorVersion = 0, regionVersion = 0;
let saveVersion = 0, mutationVersion = 0, confirmationVersion = 0;
let listAbort: AbortController | null = null, editorAbort: AbortController | null = null;
let regionAbort: AbortController | null = null, saveAbort: AbortController | null = null;
let mutationAbort: AbortController | null = null;
type Stamp = { identity: string; stored: string | null; generation: number };
function stamp(): Stamp { return { identity: identity.value, stored: stored.value, generation }; }
function current(value: Stamp): boolean {
  return alive && canView.value && value.identity === identity.value && value.stored === stored.value &&
    value.stored === localStorage.getItem("admin_session") && generation === value.generation;
}
function failureText(failure: unknown): string { return failure instanceof Error ? failure.message : "供应商目录操作失败"; }
function isConflict(failure: unknown): boolean {
  return (failure instanceof AdminResponseError && Number(failure.status) === 409) ||
    (isAxiosError(failure) && failure.response?.status === 409);
}
function listed(row: SupplierDirectoryRow): boolean {
  return list.value.some((item) => item.id === row.id && item.revision === row.revision);
}
function abortRegions(): void {
  regionVersion++; regionAbort?.abort(); regionAbort = null; regionLoading.value = false; regionError.value = "";
}
function closeEditor(): void {
  editorVersion++; editorAbort?.abort(); editorAbort = null; editorLoading.value = false; editorReady.value = false;
  abortRegions(); editorVisible.value = false; editingId.value = 0; editingRevision.value = "";
  expectedAccount.value = ""; editorError.value = ""; uncertainSave.value = false;
  draft.value = blankForm(); provinces.value = []; cities.value = []; areas.value = []; streets.value = [];
}
function invalidateList(): void {
  listVersion++; listAbort?.abort(); listAbort = null;
  list.value = []; total.value = 0; loading.value = false; error.value = "";
}
function resetSession(): void {
  generation++; invalidateList(); editorVersion++; editorAbort?.abort(); editorAbort = null;
  saveVersion++; saveAbort?.abort(); saveAbort = null; saving.value = false;
  mutationVersion++; mutationAbort?.abort(); mutationAbort = null; mutating.value = false;
  confirmationVersion++; if (confirming.value) ElMessageBox.close(); confirming.value = false;
  closeEditor(); page.value = 1; keyword.value = ""; draftKeyword.value = ""; notice.value = "";
}
async function load(targetPage = page.value): Promise<boolean> {
  if (!canView.value || !Number.isSafeInteger(targetPage) || targetPage < 1 || targetPage > 100_000) return false;
  invalidateList(); const value = stamp(), version = ++listVersion, controller = new AbortController();
  listAbort = controller; loading.value = true; page.value = targetPage;
  try {
    const result = await apiSupplierDirectoryList({ keywords: keyword.value, page: targetPage,
      limit: pageSize.value }, controller.signal);
    if (!current(value) || listVersion !== version || listAbort !== controller) return false;
    if (!result.list.length && targetPage > 1) return load(Math.max(1, Math.ceil(result.count / pageSize.value)));
    list.value = result.list; total.value = result.count;
    return true;
  } catch (failure) {
    if (current(value) && listVersion === version && !controller.signal.aborted) error.value = failureText(failure);
    return false;
  } finally { if (listAbort === controller) { listAbort = null; loading.value = false; } }
}
function search(): void {
  if (!canView.value || saving.value || mutating.value) return;
  keyword.value = draftKeyword.value.trim(); notice.value = ""; void load(1);
}
function resetFilters(): void { draftKeyword.value = ""; search(); }
function changePageSize(size: number): void {
  if (![15, 30, 50].includes(size)) return;
  pageSize.value = size; void load(1);
}
async function loadRegions(detail?: SupplierDirectoryDetail): Promise<void> {
  abortRegions(); const value = stamp(), version = ++regionVersion;
  const controller = new AbortController(); regionAbort = controller; regionLoading.value = true;
  const active = () => current(value) && canManage.value && regionVersion === version &&
    regionAbort === controller && editorVisible.value;
  try {
    const root = await apiSupplierDirectoryCities(0, controller.signal);
    if (!active()) return;
    provinces.value = root;
    if (detail?.province) {
      const loadedCities = await apiSupplierDirectoryCities(detail.province, controller.signal);
      if (!active()) return; cities.value = loadedCities;
      if (detail.city) {
        const loadedAreas = await apiSupplierDirectoryCities(detail.city, controller.signal);
        if (!active()) return; areas.value = loadedAreas;
      }
      if (detail.area) {
        const loadedStreets = await apiSupplierDirectoryCities(detail.area, controller.signal);
        if (!active()) return; streets.value = loadedStreets;
      }
    }
  } catch (failure) {
    if (current(value) && regionVersion === version && !controller.signal.aborted) {
      regionError.value = detail
        ? `${failureText(failure)}；仍可按原行政区 ID 保存已载入资料`
        : `${failureText(failure)}；请稍后重试选择地区`;
    }
  } finally { if (regionAbort === controller) { regionAbort = null; regionLoading.value = false; } }
}
function selectedAddress(): void {
  const names = [provinces.value.find((item) => item.value === draft.value.province)?.label,
    cities.value.find((item) => item.value === draft.value.city)?.label,
    areas.value.find((item) => item.value === draft.value.area)?.label,
    streets.value.find((item) => item.value === draft.value.street)?.label].filter(Boolean);
  if (names.length >= 3) draft.value.address = names.join("");
}
async function children(pid: number, target: "cities" | "areas" | "streets"): Promise<void> {
  abortRegions(); const value = stamp(), version = ++regionVersion;
  const controller = new AbortController(); regionAbort = controller; regionLoading.value = true;
  try {
    const result = await apiSupplierDirectoryCities(pid, controller.signal);
    if (!current(value) || !canManage.value || regionVersion !== version || regionAbort !== controller) return;
    if (target === "cities") cities.value = result;
    else if (target === "areas") areas.value = result;
    else streets.value = result;
    selectedAddress();
  } catch (failure) {
    if (current(value) && regionVersion === version && !controller.signal.aborted) regionError.value = failureText(failure);
  } finally { if (regionAbort === controller) { regionAbort = null; regionLoading.value = false; } }
}
function setProvince(value: number): void {
  draft.value.province = value; draft.value.city = draft.value.area = draft.value.street = 0;
  cities.value = []; areas.value = []; streets.value = []; draft.value.address = "";
  if (value) void children(value, "cities");
}
function setCity(value: number): void {
  draft.value.city = value; draft.value.area = draft.value.street = 0;
  areas.value = []; streets.value = []; draft.value.address = "";
  if (value) void children(value, "areas");
}
function setArea(value: number): void {
  draft.value.area = value; draft.value.street = 0; streets.value = []; selectedAddress();
  if (value) void children(value, "streets");
}
function setStreet(value: number | ""): void { draft.value.street = value || 0; selectedAddress(); }
function openCreate(): void {
  if (!canManage.value || saving.value || mutating.value) return;
  closeEditor(); editorVisible.value = true; editorReady.value = true; void loadRegions();
}
async function openEdit(row: SupplierDirectoryRow): Promise<void> {
  if (!canManage.value || saving.value || mutating.value || !listed(row)) return;
  closeEditor(); editorVisible.value = true; editorLoading.value = true; editingId.value = row.id;
  const value = stamp(), version = ++editorVersion, controller = new AbortController(); editorAbort = controller;
  try {
    const detail = await apiSupplierDirectoryDetail(row.id, controller.signal);
    if (!current(value) || !canManage.value || editorVersion !== version || editorAbort !== controller) return;
    if (detail.id !== row.id || !/^[0-9a-f]{64}$/.test(detail.revision)) throw new Error("供应商详情不完整");
    editingId.value = detail.id; editingRevision.value = detail.revision; expectedAccount.value = detail.account;
    draft.value = { supplier_name: detail.supplier_name, name: detail.name, phone: detail.phone,
      email: detail.email, address: detail.address, province: detail.province, city: detail.city,
      area: detail.area, street: detail.street, detailed_address: detail.detailed_address,
      mark: detail.mark, account: detail.account, pwd: "", conf_pwd: "", sort: detail.sort,
      is_show: detail.is_show };
    editorReady.value = true;
    void loadRegions(detail);
  } catch (failure) {
    if (current(value) && editorVersion === version && !controller.signal.aborted) editorError.value = failureText(failure);
  } finally { if (editorAbort === controller) { editorAbort = null; editorLoading.value = false; } }
}
async function save(): Promise<void> {
  if (!canManage.value || !editorVisible.value || editorLoading.value || !editorReady.value || saving.value || uncertainSave.value) return;
  const id = editingId.value, revision = editingRevision.value, account = expectedAccount.value;
  const payload = { ...draft.value };
  try { validateSupplierDirectoryForm(payload, id === 0); }
  catch (failure) { editorError.value = failureText(failure); return; }
  editorError.value = ""; const value = stamp(), version = ++saveVersion;
  const controller = new AbortController(); saveAbort = controller; saving.value = true;
  try {
    if (id) {
      const result = await apiSupplierDirectoryUpdate(id, payload, revision, account, controller.signal);
      if (result.id !== id || !/^[0-9a-f]{64}$/.test(result.revision)) throw new Error("保存回执不完整");
    } else {
      const result = await apiSupplierDirectoryCreate(payload, controller.signal);
      if (!Number.isSafeInteger(result.id) || result.id <= 0) throw new Error("建档回执不完整");
    }
    if (!current(value) || !canManage.value || saveVersion !== version || saveAbort !== controller) return;
    closeEditor(); const refreshed = await load(id ? page.value : 1);
    if (current(value)) {
      if (refreshed) ElMessage.success(id ? "供应商已更新" : "供应商已添加");
      else ElMessage.warning("保存已提交，目录刷新失败，请手动核对");
    }
  } catch (failure) {
    if (current(value) && saveVersion === version && !controller.signal.aborted) {
      if (isConflict(failure)) {
        closeEditor(); await load(page.value);
        ElMessage.warning("供应商资料已变化，请打开最新记录后重试");
      } else if (failure instanceof AdminResponseError && Number(failure.status) === 400) {
        editorError.value = failureText(failure);
      } else {
        uncertainSave.value = true;
        editorError.value = `${failureText(failure)}；保存结果未知，请关闭表单并刷新目录核对，避免重复提交`;
      }
    }
  } finally { if (saveAbort === controller) { saveAbort = null; saving.value = false; } }
}
async function toggleStatus(row: SupplierDirectoryRow): Promise<void> {
  if (!canManage.value || mutating.value || saving.value || loading.value || !listed(row)) return;
  const next: 0 | 1 = row.is_show === 1 ? 0 : 1;
  const value = stamp(), version = ++mutationVersion, controller = new AbortController();
  mutationAbort = controller; mutating.value = true; notice.value = "";
  try {
    const result = await apiSupplierDirectoryStatus(row.id, next, row.revision, controller.signal);
    if (result.id !== row.id || result.is_show !== next) throw new Error("状态回执不完整");
    if (!current(value) || !canManage.value || mutationVersion !== version || mutationAbort !== controller) return;
    const refreshed = await load(page.value);
    if (current(value)) {
      if (refreshed) ElMessage.success(next === 1 ? "供应商已开启" : "供应商已关闭");
      else notice.value = "状态已提交，目录刷新失败，请手动核对";
    }
  } catch (failure) {
    if (current(value) && mutationVersion === version && !controller.signal.aborted) {
      const conflicted = isConflict(failure);
      await load(page.value);
      if (current(value)) ElMessage.warning(conflicted ? "状态已变化，请核对最新目录" :
        `${failureText(failure)}；请核对目录后再操作`);
    }
  } finally { if (mutationAbort === controller) { mutationAbort = null; mutating.value = false; } }
}
async function remove(row: SupplierDirectoryRow): Promise<void> {
  if (!canManage.value || mutating.value || saving.value || loading.value || !listed(row)) return;
  const value = stamp(), version = ++confirmationVersion; confirming.value = true;
  try {
    await ElMessageBox.confirm(`确认删除供应商「${row.supplier_name}」？账号和商品将停用，历史订单与财务记录保留；仍有待处理订单时无法删除。`,
      "删除供应商", { type: "warning", confirmButtonText: "确认删除", cancelButtonText: "取消" });
  } catch { return; }
  finally { if (confirmationVersion === version) confirming.value = false; }
  if (!current(value) || !canManage.value || confirmationVersion !== version || !listed(row)) return;
  const mutation = ++mutationVersion, controller = new AbortController();
  mutationAbort = controller; mutating.value = true; notice.value = "";
  try {
    const result = await apiSupplierDirectoryDelete(row.id, row.revision, controller.signal);
    if (result.id !== row.id || result.is_del !== 1) throw new Error("删除回执不完整");
    if (!current(value) || !canManage.value || mutationVersion !== mutation || mutationAbort !== controller) return;
    const refreshed = await load(page.value);
    if (current(value)) {
      if (refreshed) ElMessage.success("供应商已删除");
      else notice.value = "删除已提交，目录刷新失败，请手动核对";
    }
  } catch (failure) {
    if (current(value) && mutationVersion === mutation && !controller.signal.aborted) {
      const conflicted = isConflict(failure);
      await load(page.value);
      if (current(value)) ElMessage.warning(conflicted ? "供应商资料已变化，请核对最新目录" :
        `${failureText(failure)}；请核对目录后再操作`);
    }
  } finally { if (mutationAbort === controller) { mutationAbort = null; mutating.value = false; } }
}
function syncSession(): void {
  stored.value = localStorage.getItem("admin_session"); sessionVersion.value++;
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
}
function storage(event: StorageEvent): void {
  if (event.storageArea === localStorage && (event.key === null || event.key === "admin_token" || event.key === "admin_session")) syncSession();
}
watch([identity, canView, canManage, stored], () => {
  resetSession(); if (canView.value) void load(1);
});
onMounted(() => {
  alive = true;
  window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession);
  window.addEventListener("storage", storage);
  const before = `${identity.value}:${stored.value}:${canView.value}:${canManage.value}`;
  syncSession();
  if (before === `${identity.value}:${stored.value}:${canView.value}:${canManage.value}` && canView.value) void load(1);
});
onBeforeUnmount(() => {
  alive = false; resetSession();
  window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession);
  window.removeEventListener("storage", storage);
});
</script>

<style scoped>
.supplier-directory { min-width: 0; }
.heading { display: flex; align-items: start; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.heading p { margin: 5px 0 0; color: #7a8391; font-size: 13px; }
.heading-actions, .filters { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.filters { margin: 16px 0; }.filters :deep(.el-input) { width: min(320px, 100%); }
.notice { margin-bottom: 12px; }.table-scroll { max-width: 100%; overflow-x: auto; }
.pager { display: flex; justify-content: flex-end; margin-top: 16px; flex-wrap: wrap; }
.editor { min-height: 80px; }.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 10px; }
.form-grid label { display: flex; flex-direction: column; gap: 5px; min-width: 0; font-size: 13px; }
.form-grid label span { color: #58616e; }.form-grid label.wide { grid-column: 1 / -1; }
.form-grid :deep(.el-select), .form-grid :deep(.el-input), .form-grid :deep(.el-input-number) { width: 100%; }
.switch-field { justify-content: end; }.switch-field :deep(.el-switch) { align-self: start; }
@media (max-width: 680px) { .form-grid { grid-template-columns: minmax(0, 1fr); }.pager { justify-content: center; } }
</style>
