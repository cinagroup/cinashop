<template>
  <div v-if="canView" class="supplier-applications">
    <section class="hero">
      <div>
        <span class="eyebrow">SUPPLIER ONBOARDING</span>
        <h1>供应商入驻审核</h1>
        <p>审核通过后只创建冻结账号，申请人必须通过原手机号验证并设置新密码后才能登录。</p>
      </div>
      <div class="hero-stat"><strong>{{ pendingCount }}</strong><span>本页待审核</span></div>
    </section>

    <el-card shadow="never" class="content-card">
      <div class="toolbar">
        <el-radio-group v-model="draftStatus" :disabled="submitting || confirming" @change="search">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button :value="0">待审核</el-radio-button>
          <el-radio-button :value="1">已通过</el-radio-button>
          <el-radio-button :value="2">已拒绝</el-radio-button>
        </el-radio-group>
        <el-date-picker v-model="draftDateRange" type="datetimerange" clearable
          format="YYYY-MM-DD HH:mm:ss" value-format="YYYY-MM-DD HH:mm:ss"
          start-placeholder="申请开始时间（上海）" end-placeholder="申请结束时间（上海）"
          :disabled="submitting || confirming" @change="search" />
        <div class="search-row">
          <el-input v-model="draftKeyword" clearable maxlength="80" placeholder="申请 ID、UID、供应商、联系人、电话、拒绝原因或备注"
            :disabled="submitting || confirming" @keyup.enter="search" />
          <el-button type="primary" :disabled="submitting || confirming" @click="search">查询</el-button>
          <el-button :disabled="submitting || confirming" @click="reset">重置</el-button>
        </div>
      </div>

      <el-alert
        title="安全迁移说明：不再下发“手机号后六位”默认密码；账号激活状态在列表中单独显示。"
        type="warning" :closable="false" show-icon class="security-alert"
      />
      <el-alert v-if="actionNotice" :title="actionNotice" type="warning" :closable="false" show-icon class="security-alert" />
      <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon class="security-alert">
        <template #default><el-button link type="primary" @click="load(page)">重新读取申请</el-button></template>
      </el-alert>

      <el-table v-if="!listError" class="desktop-table" :data="list" v-loading="loading" row-key="id" stripe>
        <el-table-column label="申请主体" min-width="240">
          <template #default="{ row }">
            <strong>{{ row.system_name }}</strong>
            <div class="sub">UID {{ row.uid }} · {{ row.name }} · {{ row.phone }}</div>
          </template>
        </el-table-column>
        <el-table-column label="资质图片" min-width="220">
          <template #default="{ row }">
            <div v-if="row.images.length" class="image-list">
              <el-image v-for="(image, index) in row.images" :key="index" class="qualification-image"
                :src="image" :preview-src-list="row.images" :initial-index="index" preview-teleported fit="cover"
                :alt="`申请 ${row.id} 资质图片 ${index + 1}`" />
            </div>
            <span v-else class="sub">无</span>
          </template>
        </el-table-column>
        <el-table-column label="审核 / 激活" min-width="170">
          <template #default="{ row }">
            <el-tag :type="statusTone(row.status)">{{ row.status_label }}</el-tag>
            <el-tag v-if="row.activated" type="success" effect="plain" class="second-tag">账号已激活</el-tag>
            <el-tag v-else-if="row.activation_required" type="warning" effect="plain" class="second-tag">等待短信激活</el-tag>
            <div v-if="row.account" class="sub">账号 {{ row.account }}</div>
            <div v-if="row.fail_msg" class="sub danger">{{ row.fail_msg }}</div>
          </template>
        </el-table-column>
        <el-table-column label="备注" min-width="150">
          <template #default="{ row }">{{ row.mark || "-" }}</template>
        </el-table-column>
        <el-table-column label="申请时间" width="165">
          <template #default="{ row }">{{ formatTime(row.add_time) }}</template>
        </el-table-column>
        <el-table-column v-if="canManage" label="操作" width="235" fixed="right">
          <template #default="{ row }">
            <template v-if="row.status === 0">
              <el-button type="success" size="small" :disabled="submitting || confirming" @click="approve(row)">通过</el-button>
              <el-button type="danger" plain size="small" :disabled="submitting || confirming" @click="openReject(row)">拒绝</el-button>
            </template>
            <el-button size="small" :disabled="submitting || confirming" @click="openMark(row)">备注</el-button>
            <el-button v-if="row.status !== 1" text type="danger" size="small" :disabled="submitting || confirming" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!listError" v-loading="loading" class="mobile-list">
        <article v-for="row in list" :key="row.id" class="mobile-card">
          <div class="mobile-head">
            <div><strong>{{ row.system_name }}</strong><span>申请 #{{ row.id }} · UID {{ row.uid }}</span></div>
            <el-tag :type="statusTone(row.status)" size="small">{{ row.status_label }}</el-tag>
          </div>
          <div class="mobile-detail"><span>联系人</span><b>{{ row.name }} · {{ row.phone }}</b></div>
          <div class="mobile-detail"><span>账号状态</span><b>{{ row.activated ? "已激活" : row.activation_required ? "等待短信激活" : "尚未创建" }}</b></div>
          <div v-if="row.account" class="mobile-detail"><span>登录账号</span><b>{{ row.account }}</b></div>
          <div class="mobile-detail"><span>申请时间</span><b>{{ formatTime(row.add_time) }}</b></div>
          <div class="mobile-qualification"><span>资质图片（{{ row.images.length }}）</span>
            <div v-if="row.images.length" class="image-list">
              <el-image v-for="(image, index) in row.images" :key="index" class="qualification-image"
                :src="image" :preview-src-list="row.images" :initial-index="index" preview-teleported fit="cover"
                :alt="`申请 ${row.id} 资质图片 ${index + 1}`" />
            </div>
            <b v-else>无</b>
          </div>
          <p v-if="row.mark" class="mobile-note">备注：{{ row.mark }}</p>
          <p v-if="row.fail_msg" class="mobile-note danger">拒绝原因：{{ row.fail_msg }}</p>
          <div v-if="canManage" class="mobile-actions">
            <template v-if="row.status === 0">
              <el-button type="success" size="small" :disabled="submitting || confirming" @click="approve(row)">通过</el-button>
              <el-button type="danger" plain size="small" :disabled="submitting || confirming" @click="openReject(row)">拒绝</el-button>
            </template>
            <el-button size="small" :disabled="submitting || confirming" @click="openMark(row)">备注</el-button>
            <el-button v-if="row.status !== 1" text type="danger" size="small" :disabled="submitting || confirming" @click="remove(row)">删除</el-button>
          </div>
        </article>
        <el-empty v-if="!loading && !list.length" description="暂无供应商申请" :image-size="64" />
      </div>
      <el-pagination v-if="!listError" class="pager" layout="total, prev, pager, next" :total="total"
        :page-size="PAGE_SIZE" :current-page="page" :disabled="submitting || confirming || loading" @current-change="load" />
    </el-card>

    <el-dialog v-if="canManage" v-model="rejectVisible" title="拒绝供应商申请" width="440px"
      :close-on-click-modal="false" :close-on-press-escape="!submitting" :show-close="!submitting">
      <p class="dialog-note">拒绝原因会展示给申请人，申请人可修正资料后重新提交。</p>
      <el-input v-model="rejectReason" type="textarea" :rows="4" maxlength="255" show-word-limit placeholder="请填写明确的拒绝原因" />
      <template #footer><el-button :disabled="submitting" @click="rejectVisible = false">取消</el-button><el-button type="danger" :loading="submitting" @click="confirmReject">确认拒绝</el-button></template>
    </el-dialog>

    <el-dialog v-if="canManage" v-model="markVisible" title="内部审核备注" width="440px"
      :close-on-click-modal="false" :close-on-press-escape="!submitting" :show-close="!submitting">
      <el-input v-model="markText" type="textarea" :rows="4" maxlength="255" show-word-limit :disabled="submitting" />
      <template #footer><el-button :disabled="submitting" @click="markVisible = false">取消</el-button><el-button type="primary" :loading="submitting" @click="confirmMark">保存备注</el-button></template>
    </el-dialog>
  </div>
  <el-empty v-else description="无供应商入驻查看权限" />
</template>

<script setup lang="ts">
import { isAxiosError } from "axios";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import { AdminResponseError } from "@/utils/request";
import {
  apiSupplierApplicationDelete,
  apiSupplierApplicationList,
  apiSupplierApplicationMark,
  apiSupplierApplicationReview,
  supplierApplicationTimeRange,
  type SupplierApplicationItem,
  type SupplierApplicationQuery,
} from "@/api/supplierApplication";

const previewMode = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
const auth = useAuthStore();
const storedSession = ref(localStorage.getItem("admin_session"));
const sessionVersion = ref(0);
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ""}:${auth.uniqueAuth.join(",")}`);
const validSession = computed(() => {
  void sessionVersion.value;
  if (previewMode) return true;
  const session = getAdminSession();
  return !!auth.token && auth.token === getToken() && !!auth.userInfo && !!session &&
    storedSession.value === localStorage.getItem("admin_session") &&
    session.userInfo.id === auth.userInfo.id && session.userInfo.level === auth.userInfo.level;
});
const canView = computed(() => !!(validSession.value && (previewMode || auth.userInfo?.level === 0 ||
  (auth.uniqueAuth.includes("supplier_application.view") &&
    getAdminSession()?.uniqueAuth.includes("supplier_application.view")))));
const canManage = computed(() => !!(canView.value && (previewMode || auth.userInfo?.level === 0 ||
  (auth.uniqueAuth.includes("supplier_application.manage") &&
    getAdminSession()?.uniqueAuth.includes("supplier_application.manage")))));

const PAGE_SIZE = 20;
const MAX_PAGE = Math.floor(10_000 / PAGE_SIZE) + 1;
const list = ref<SupplierApplicationItem[]>([]);
const total = ref(0);
const page = ref(1);
const draftStatus = ref<"all" | 0 | 1 | 2>("all");
const status = ref<"all" | 0 | 1 | 2>("all");
const draftKeyword = ref("");
const keyword = ref("");
const draftDateRange = ref<string[] | null>(null);
const dateRange = ref<string[] | null>(null);
const loading = ref(false);
const listError = ref("");
const actionNotice = ref("");
const submitting = ref(false);
const confirming = ref(false);
const rejectVisible = ref(false);
const markVisible = ref(false);
const rejectReason = ref("");
const markText = ref("");
const selectedRow = ref<SupplierApplicationItem | null>(null);
let selectedScope: Scope | null = null;
let alive = false;
let syncing = false;
let generation = 0;
let listVersion = 0;
let mutationVersion = 0;
let confirmationVersion = 0;
let listAbort: AbortController | null = null;
let mutationAbort: AbortController | null = null;
type Scope = { identity: string; stored: string | null; generation: number };
function scope(): Scope { return { identity: sessionKey.value, stored: storedSession.value, generation }; }
function sameSession(value: Scope): boolean {
  return alive && canView.value && value.identity === sessionKey.value &&
    value.stored === storedSession.value && value.stored === localStorage.getItem("admin_session") &&
    (previewMode || auth.token === getToken());
}
function current(value: Scope): boolean { return sameSession(value) && value.generation === generation; }
function listed(row: SupplierApplicationItem): boolean {
  return list.value.some((item) => item.id === row.id && item.uid === row.uid &&
    item.status === row.status && item.version === row.version);
}
function actionable(row: SupplierApplicationItem, pendingOnly = false): boolean {
  return current(scope()) && canManage.value && !loading.value && !submitting.value && !confirming.value &&
    listed(row) && (!pendingOnly || row.status === 0);
}
function closeDialogs(): void {
  rejectVisible.value = false; markVisible.value = false; selectedRow.value = null;
  selectedScope = null; rejectReason.value = ""; markText.value = "";
}
function invalidateList(): void {
  generation++; listVersion++; listAbort?.abort(); listAbort = null;
  list.value = []; total.value = 0; loading.value = false; listError.value = "";
}
function resetSession(): void {
  invalidateList(); mutationVersion++; confirmationVersion++;
  mutationAbort?.abort(); mutationAbort = null;
  if (confirming.value) ElMessageBox.close();
  confirming.value = false; submitting.value = false; closeDialogs(); actionNotice.value = "";
  page.value = 1; draftStatus.value = "all"; status.value = "all";
  draftKeyword.value = ""; keyword.value = "";
  draftDateRange.value = null; dateRange.value = null;
}
const pendingCount = computed(() => list.value.filter((row) => row.status === 0).length);

function statusTone(value: number): "success" | "warning" | "danger" {
  return value === 1 ? "success" : value === 2 ? "danger" : "warning";
}
const shanghaiFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric",
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function formatTime(value: number) {
  if (!value) return "-";
  const parts = Object.fromEntries(shanghaiFormat.formatToParts(new Date(value * 1000)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
function listQuery(targetPage: number): SupplierApplicationQuery {
  return { page: targetPage, limit: PAGE_SIZE, status: status.value, keyword: keyword.value,
    ...supplierApplicationTimeRange(dateRange.value) };
}
async function load(targetPage = page.value): Promise<boolean> {
  if (!sameSession(scope()) || !Number.isSafeInteger(targetPage) || targetPage < 1 || targetPage > MAX_PAGE) return false;
  invalidateList();
  page.value = targetPage;
  let query: SupplierApplicationQuery;
  try { query = listQuery(targetPage); }
  catch (failure) { listError.value = failure instanceof Error ? failure.message : "申请时间范围错误"; return false; }
  const stamp = scope(), version = ++listVersion, controller = new AbortController();
  listAbort = controller; loading.value = true;
  try {
    const result = await apiSupplierApplicationList(query, controller.signal);
    if (!current(stamp) || listVersion !== version || listAbort !== controller) return false;
    if (!result.list.length && targetPage > 1) {
      return load(Math.max(1, Math.min(targetPage - 1, Math.ceil(result.count / PAGE_SIZE))));
    }
    list.value = result.list; total.value = result.count;
    return true;
  } catch (failure) {
    if (current(stamp) && listVersion === version && !controller.signal.aborted) {
      listError.value = failure instanceof Error ? failure.message : "供应商申请加载失败";
    }
    return false;
  } finally { if (listAbort === controller) { listAbort = null; loading.value = false; } }
}
function search(): void {
  if (!sameSession(scope()) || submitting.value || confirming.value) return;
  status.value = draftStatus.value; keyword.value = draftKeyword.value.trim();
  dateRange.value = draftDateRange.value ? [...draftDateRange.value] : null;
  actionNotice.value = ""; void load(1);
}
function reset(): void {
  draftStatus.value = "all"; draftKeyword.value = ""; draftDateRange.value = null; search();
}
function isConflict(failure: unknown): boolean {
  return (failure instanceof AdminResponseError && Number(failure.status) === 409) ||
    (isAxiosError(failure) && failure.response?.status === 409);
}
async function mutate(row: SupplierApplicationItem, action: "approve" | "reject" | "mark" | "delete",
  stamp: Scope, value = ""): Promise<void> {
  if (!current(stamp) || !canManage.value || !listed(row) || submitting.value ||
    ((action === "approve" || action === "reject") && row.status !== 0) ||
    (action === "delete" && row.status === 1)) return;
  const version = ++mutationVersion, controller = new AbortController();
  mutationAbort = controller; submitting.value = true; actionNotice.value = "";
  try {
    if (action === "approve" || action === "reject") {
      const result = await apiSupplierApplicationReview(row.id,
        action === "approve" ? { status: 1, expected_version: row.version }
          : { status: 2, fail_msg: value, expected_version: row.version }, controller.signal);
      if (result.id !== row.id || result.status !== (action === "approve" ? 1 : 2)) throw new Error("审核结果与当前申请不一致");
    } else if (action === "mark") {
      const result = await apiSupplierApplicationMark(row.id, value, row.version, controller.signal);
      if (result.id !== row.id || result.mark !== value) throw new Error("备注结果与当前申请不一致");
    } else {
      const result = await apiSupplierApplicationDelete(row.id, row.version, controller.signal);
      if (result.id !== row.id) throw new Error("删除结果与当前申请不一致");
    }
    if (!current(stamp) || mutationVersion !== version || mutationAbort !== controller || !canManage.value) return;
    closeDialogs();
    const success = action === "approve" ? "审核通过，账号等待短信激活" : action === "reject"
      ? "申请已拒绝" : action === "mark" ? "备注已保存" : "申请已删除";
    const refreshed = await load(page.value);
    if (sameSession(stamp)) {
      if (refreshed) ElMessage.success(success);
      else ElMessage.warning("操作已提交，列表刷新失败，请手动核对");
    }
  } catch (failure) {
    if (!current(stamp) || mutationVersion !== version || controller.signal.aborted || !canManage.value) return;
    closeDialogs();
    const conflict = isConflict(failure);
    const detail = failure instanceof Error ? failure.message : "请求失败";
    const refreshed = await load(page.value);
    if (sameSession(stamp)) {
      actionNotice.value = conflict
        ? refreshed ? "申请材料或状态已更新，已重新读取；请核对后重新审核。"
          : "申请材料或状态已更新，列表刷新失败；请手动重试。"
        : `${failure instanceof AdminResponseError ? "操作未完成" : "操作结果未确认"}：${detail}。${refreshed ? "请核对重新读取的申请状态后再操作。" : "列表刷新失败，请手动重试。"}`;
    }
  } finally { if (mutationAbort === controller) { mutationAbort = null; submitting.value = false; } }
}
async function confirmAction(row: SupplierApplicationItem, action: "approve" | "delete"): Promise<void> {
  if (!actionable(row, action === "approve") || (action === "delete" && row.status === 1)) return;
  row = { ...row };
  const stamp = scope(), version = ++confirmationVersion;
  confirming.value = true;
  try {
    await ElMessageBox.confirm(
      action === "approve"
        ? `确认通过“${row.system_name}”的申请？请先核对全部 ${row.images.length} 张资质图片。系统将创建冻结账号，申请人需短信验证后设置密码。`
        : `确认删除“${row.system_name}”的申请记录？删除后这条记录不再对申请人显示。`,
      action === "approve" ? "通过供应商申请" : "删除供应商申请",
      { type: "warning", confirmButtonText: action === "approve" ? "通过并等待激活" : "确认删除", cancelButtonText: "取消" },
    );
  } catch { return; }
  finally { if (version === confirmationVersion) confirming.value = false; }
  if (version === confirmationVersion && current(stamp) && listed(row)) await mutate(row, action, stamp);
}
function approve(row: SupplierApplicationItem): Promise<void> { return confirmAction(row, "approve"); }
function remove(row: SupplierApplicationItem): Promise<void> { return confirmAction(row, "delete"); }
function openReject(row: SupplierApplicationItem) {
  if (!actionable(row, true)) return;
  selectedRow.value = { ...row }; selectedScope = scope();
  rejectReason.value = ""; rejectVisible.value = true;
}
async function confirmReject() {
  if (!rejectVisible.value || !selectedRow.value || !selectedScope || !current(selectedScope) ||
    !canManage.value || !listed(selectedRow.value) || submitting.value) return;
  if (rejectReason.value.trim().length < 2) {
    ElMessage.warning("请填写至少 2 个字符的拒绝原因"); return;
  }
  await mutate(selectedRow.value, "reject", selectedScope, rejectReason.value.trim());
}
function openMark(row: SupplierApplicationItem) {
  if (!actionable(row)) return;
  selectedRow.value = { ...row }; selectedScope = scope();
  markText.value = row.mark; markVisible.value = true;
}
async function confirmMark() {
  if (!markVisible.value || !selectedRow.value || !selectedScope || !current(selectedScope) ||
    !canManage.value || !listed(selectedRow.value) || submitting.value) return;
  const mark = markText.value.trim();
  if (!mark || [...mark].length > 255) { ElMessage.warning("请填写 1–255 字的备注"); return; }
  await mutate(selectedRow.value, "mark", selectedScope, mark);
}
function syncSession(): void {
  syncing = true;
  storedSession.value = localStorage.getItem("admin_session"); sessionVersion.value++;
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  syncing = false;
  resetSession();
  if (alive && canView.value) void load(1);
}
function syncStorage(event: StorageEvent): void {
  if (event.key === null || event.key === "admin_token" || event.key === "admin_session") syncSession();
}
watch([sessionKey, canView, canManage, storedSession], () => {
  if (!alive || syncing) return;
  resetSession(); if (canView.value) void load(1);
}, { flush: "sync" });
onMounted(() => {
  alive = true;
  window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession);
  window.addEventListener("storage", syncStorage);
  syncSession();
});
onBeforeUnmount(() => {
  alive = false; resetSession();
  window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession);
  window.removeEventListener("storage", syncStorage);
});
</script>

<style scoped>
.supplier-applications { display: grid; gap: 16px; }
.hero { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 28px 32px; border-radius: 16px; color: #fff; background: linear-gradient(125deg, #102d2b, #176e65 64%, #d7a94f); box-shadow: 0 14px 34px rgba(16, 45, 43, .18); }
.eyebrow { color: #f1d49d; font-size: 11px; font-weight: 700; letter-spacing: .16em; }
.hero h1 { margin: 7px 0; font-size: 27px; }
.hero p { max-width: 720px; margin: 0; color: rgba(255,255,255,.78); line-height: 1.65; }
.hero-stat { min-width: 124px; padding: 16px 20px; border: 1px solid rgba(255,255,255,.22); border-radius: 12px; text-align: center; background: rgba(255,255,255,.09); }
.hero-stat strong { display: block; font-size: 30px; }.hero-stat span { font-size: 12px; color: rgba(255,255,255,.72); }
.content-card { border-radius: 12px; }.toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; margin-bottom: 14px; }.search-row { display: flex; flex: 1; gap: 8px; }.search-row .el-input { min-width: 260px; flex: 1; }
.security-alert { margin-bottom: 15px; }.sub { margin-top: 6px; color: #8992a3; font-size: 12px; }.danger { color: #e54d42; }.second-tag { margin-left: 6px; }.pager { margin-top: 18px; justify-content: flex-end; }
.image-list { display: flex; flex-wrap: wrap; gap: 6px; padding: 3px 0; }.qualification-image { width: 42px; height: 42px; border-radius: 5px; cursor: pointer; background: #f2f5f3; }.mobile-qualification { margin-top: 12px; font-size: 12px; }.mobile-qualification > span { display: block; margin-bottom: 5px; color: #929c99; }.mobile-qualification > b { color: #465653; font-weight: 500; }
.mobile-list { display: none; }.mobile-card { padding: 16px 0; border-bottom: 1px solid #edf0ef; }.mobile-card:first-child { padding-top: 2px; }.mobile-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }.mobile-head strong,.mobile-head span { display: block; }.mobile-head strong { color: #17332f; font-size: 15px; }.mobile-head span { margin-top: 5px; color: #929c99; font-size: 11px; }.mobile-detail { display: flex; justify-content: space-between; gap: 16px; margin-top: 12px; font-size: 12px; }.mobile-detail span { color: #929c99; }.mobile-detail b { color: #465653; font-weight: 500; text-align: right; }.mobile-note { margin: 12px 0 0; padding: 9px 10px; border-radius: 7px; color: #64706d; background: #f5f7f6; font-size: 12px; line-height: 1.5; }.mobile-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }.mobile-actions .el-button { margin-left: 0; }
.dialog-note { padding: 10px 12px; border-left: 3px solid #e6a23c; color: #735b2e; background: #fff8e8; font-size: 13px; line-height: 1.6; }
@media (max-width: 900px) { .hero { align-items: flex-start; padding: 22px; }.hero-stat { min-width: 94px; }.toolbar { align-items: stretch; flex-direction: column; }.search-row .el-input { width: 100%; } }
@media (max-width: 620px) { .hero-stat { display: none; }.hero h1 { font-size: 23px; }.search-row { flex-direction: column; }.search-row .el-input { min-width: 0; } }
@media (max-width: 760px) { .desktop-table { display: none; }.mobile-list { display: block; }.security-alert :deep(.el-alert__content) { min-width: 0; }.pager { justify-content: center; } }
</style>
