<template>
  <div class="sign-rewards">
    <el-card shadow="never">
      <template #header>
        <div class="heading">
          <div><strong>签到奖励</strong><p>管理连续和累积签到的积分、经验奖励。</p></div>
          <el-button v-if="canView" :loading="loading" @click="loadList(page)">刷新</el-button>
        </div>
      </template>
      <el-alert v-if="!canView" title="当前账号没有系统配置查看权限" type="warning" :closable="false" show-icon />
      <template v-else>
        <el-tabs v-model="tab">
          <el-tab-pane label="连续签到奖励" name="0" />
          <el-tab-pane label="累积签到奖励" name="1" />
        </el-tabs>
        <div class="toolbar">
          <el-button v-if="canManage" type="primary" @click="openForm(0)">
            添加{{ tab === "0" ? "连续" : "累积" }}签到奖励
          </el-button>
          <span v-else class="read-only">当前账号仅可查看签到奖励</span>
        </div>
        <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon class="notice">
          <template #default><el-button link type="primary" @click="loadList(requestedPage)">重试</el-button></template>
        </el-alert>
        <div class="table-scroll">
          <el-table v-loading="loading" :data="rows" row-key="id" stripe empty-text="暂无签到奖励" class="reward-table">
            <el-table-column label="类型" min-width="150"><template #default="{ row }">{{ row.type === 0 ? "连续" : "累积" }}签到{{ row.days }}天奖励</template></el-table-column>
            <el-table-column prop="days" label="天数" min-width="100" />
            <el-table-column prop="point" label="奖励积分" min-width="120" />
            <el-table-column prop="exp" label="奖励经验" min-width="120" />
            <el-table-column v-if="canManage" label="操作" min-width="150">
              <template #default="{ row }">
                <el-button link type="primary" @click="openForm(row.id)">编辑</el-button>
                <el-button link type="danger" @click="remove(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
        <el-pagination :current-page="page" :page-size="PAGE_SIZE" :total="count" :disabled="loading"
          layout="total, prev, pager, next, jumper" class="pager" @current-change="loadList" />
      </template>
    </el-card>

    <el-dialog v-model="dialogOpen" :title="form?.id ? '编辑签到奖励' : '添加签到奖励'"
      width="min(480px, 94vw)" :close-on-click-modal="false" :close-on-press-escape="!saving"
      :show-close="!saving" @closed="onDialogClosed">
      <div v-loading="formLoading">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" show-icon class="notice">
          <template #default><el-button link type="primary" @click="openForm(formId)">重试</el-button></template>
        </el-alert>
        <el-form v-if="form" label-position="top" :disabled="saving">
          <el-form-item label="奖励类型"><span>{{ form.type === 0 ? "连续签到" : "累积签到" }}</span></el-form-item>
          <el-form-item label="签到天数"><el-input-number v-model="form.days" aria-label="签到天数" :min="1" :max="form.maxDays" :step="1" :precision="0" /></el-form-item>
          <el-form-item label="奖励积分"><el-input-number v-model="form.point" aria-label="奖励积分" :min="0" :max="999" :step="1" :precision="0" /></el-form-item>
          <el-form-item label="奖励经验"><el-input-number v-model="form.exp" aria-label="奖励经验" :min="0" :max="999" :step="1" :precision="0" /></el-form-item>
          <p class="form-hint">当前签到模式最多配置 {{ form.maxDays }} 天；已有规则如超出范围，请先核对配置。</p>
        </el-form>
      </div>
      <template #footer>
        <el-button :disabled="saving" @click="dialogOpen = false">取消</el-button>
        <el-button v-if="canManage" type="primary" :loading="saving" :disabled="!form || formLoading" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import {
  apiDeleteSignReward, apiSaveSignReward, apiSignRewardForm, apiSignRewardList,
  type SignRewardInput, type SignRewardRow, type SignRewardType,
} from "@/api/signRewards";

const PAGE_SIZE = 15;
type Editor = SignRewardInput & { id: number; maxDays: number };
const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes("config.view")));
const canManage = computed(() => canView.value &&
  (auth.userInfo?.level === 0 || auth.uniqueAuth.includes("config.manage")));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.uniqueAuth.join(",")}`);
const tab = ref<"0" | "1">("0");
const rewardType = computed<SignRewardType>(() => tab.value === "1" ? 1 : 0);
const rows = ref<SignRewardRow[]>([]);
const count = ref(0);
const page = ref(1);
const requestedPage = ref(1);
const loading = ref(false);
const listError = ref("");
const dialogOpen = ref(false);
const formId = ref(0);
const form = ref<Editor | null>(null);
const formLoading = ref(false);
const formError = ref("");
const saving = ref(false);
let mounted = false;
let listGeneration = 0;
let formGeneration = 0;
let listAbort: AbortController | null = null;
let formAbort: AbortController | null = null;

function active(stamp: string): boolean {
  return mounted && canView.value && sessionKey.value === stamp && auth.token === getToken();
}

function closeForm(): void {
  formGeneration++;
  formAbort?.abort();
  formAbort = null;
  form.value = null;
  formLoading.value = false;
  formError.value = "";
}

function onDialogClosed(): void {
  if (!dialogOpen.value) closeForm();
}

function discard(): void {
  listGeneration++;
  listAbort?.abort();
  listAbort = null;
  rows.value = [];
  count.value = 0;
  page.value = 1;
  requestedPage.value = 1;
  loading.value = false;
  listError.value = "";
  dialogOpen.value = false;
  closeForm();
}

async function loadList(targetPage = page.value): Promise<void> {
  if (!mounted || !canView.value) return;
  requestedPage.value = targetPage;
  const stamp = sessionKey.value;
  const selectedType = rewardType.value;
  const generation = ++listGeneration;
  listAbort?.abort();
  const controller = new AbortController();
  listAbort = controller;
  loading.value = true;
  listError.value = "";
  rows.value = [];
  count.value = 0;
  try {
    const result = await apiSignRewardList(selectedType, targetPage, controller.signal);
    if (!active(stamp) || generation !== listGeneration || rewardType.value !== selectedType) return;
    if (result.page !== targetPage || result.limit !== PAGE_SIZE ||
        result.list.some((item) => item.type !== selectedType)) throw new Error("签到奖励分页结果与请求不一致");
    if (targetPage > 1 && result.count <= (targetPage - 1) * PAGE_SIZE) {
      void loadList(targetPage - 1);
      return;
    }
    rows.value = result.list;
    count.value = result.count;
    page.value = targetPage;
  } catch (error) {
    if (active(stamp) && generation === listGeneration && !controller.signal.aborted) {
      listError.value = error instanceof Error ? error.message : "加载签到奖励失败";
    }
  } finally {
    if (generation === listGeneration) {
      listAbort = null;
      loading.value = false;
    }
  }
}

async function openForm(id: number): Promise<void> {
  if (!mounted || !canManage.value) return;
  const stamp = sessionKey.value;
  const selectedType = rewardType.value;
  const generation = ++formGeneration;
  formAbort?.abort();
  const controller = new AbortController();
  formAbort = controller;
  formId.value = id;
  dialogOpen.value = true;
  form.value = null;
  formLoading.value = true;
  formError.value = "";
  try {
    const result = await apiSignRewardForm(id, selectedType, controller.signal);
    if (!active(stamp) || !canManage.value || generation !== formGeneration || !dialogOpen.value || rewardType.value !== selectedType) return;
    if (result.info.id !== id || result.info.type !== selectedType) throw new Error("签到奖励表单与当前记录不一致");
    form.value = { ...result.info, maxDays: result.maxDays };
  } catch (error) {
    if (active(stamp) && generation === formGeneration && !controller.signal.aborted) {
      formError.value = error instanceof Error ? error.message : "加载签到奖励表单失败";
    }
  } finally {
    if (generation === formGeneration) {
      formAbort = null;
      formLoading.value = false;
    }
  }
}

async function save(): Promise<void> {
  const current = form.value;
  if (!current || !canManage.value || saving.value) return;
  if (![current.days, current.point, current.exp].every(Number.isSafeInteger) ||
      current.days < 1 || current.days > current.maxDays ||
      current.point < 0 || current.point > 999 || current.exp < 0 || current.exp > 999) {
    ElMessage.error("请核对签到天数、奖励积分和经验");
    return;
  }
  const stamp = sessionKey.value;
  const generation = formGeneration;
  const selectedType = rewardType.value;
  saving.value = true;
  try {
    const result = await apiSaveSignReward(current.id, {
      type: current.type, days: current.days, point: current.point, exp: current.exp,
    });
    if (!active(stamp) || !canManage.value || generation !== formGeneration ||
        !dialogOpen.value || form.value !== current || rewardType.value !== selectedType) return;
    if (!Number.isSafeInteger(result.id) || result.id <= 0) throw new Error("保存结果缺少奖励 ID，请刷新核对");
    dialogOpen.value = false;
    ElMessage.success("签到奖励已保存");
    await loadList(page.value);
  } catch (error) {
    if (active(stamp) && generation === formGeneration && dialogOpen.value &&
        form.value === current && rewardType.value === selectedType) {
      ElMessage.error(error instanceof Error ? error.message : "保存结果未确认，请刷新列表核对");
    }
  } finally {
    saving.value = false;
  }
}

async function remove(item: SignRewardRow): Promise<void> {
  if (!canManage.value) return;
  const stamp = sessionKey.value;
  try {
    await ElMessageBox.confirm(`确定删除${item.type === 0 ? "连续" : "累积"}签到 ${item.days} 天奖励？`, "删除签到奖励", {
      type: "warning", confirmButtonText: "删除", cancelButtonText: "取消",
    });
  } catch { return; }
  if (!active(stamp) || !canManage.value || item.type !== rewardType.value) return;
  try {
    await apiDeleteSignReward(item.id);
    if (!active(stamp)) return;
    ElMessage.success("签到奖励已删除");
    await loadList(page.value);
  } catch (error) {
    if (active(stamp)) ElMessage.error(error instanceof Error ? error.message : "删除结果未确认，请刷新列表核对");
  }
}

function syncSession(): void {
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? "", userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
}

watch(tab, () => {
  discard();
  if (mounted && canView.value) void loadList(1);
});
watch(sessionKey, () => {
  discard();
  if (mounted && canView.value) void loadList(1);
});
onMounted(() => {
  mounted = true;
  window.addEventListener("admin-session-changed", syncSession);
  window.addEventListener("admin-auth-expired", syncSession);
  const previous = sessionKey.value;
  syncSession();
  if (previous === sessionKey.value && canView.value) void loadList(1);
});
onBeforeUnmount(() => {
  mounted = false;
  window.removeEventListener("admin-session-changed", syncSession);
  window.removeEventListener("admin-auth-expired", syncSession);
  discard();
});
</script>

<style scoped>
.sign-rewards { min-width: 0; }
.heading, .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.heading p, .read-only, .form-hint { margin: 4px 0 0; color: #737985; font-size: 12px; }
.toolbar { margin: 4px 0 16px; }
.notice { margin-bottom: 14px; }
.table-scroll { max-width: 100%; overflow-x: auto; }
.reward-table { min-width: 580px; }
.pager { margin-top: 16px; justify-content: flex-end; flex-wrap: wrap; }
@media (max-width: 600px) { .pager { justify-content: center; } }
</style>
