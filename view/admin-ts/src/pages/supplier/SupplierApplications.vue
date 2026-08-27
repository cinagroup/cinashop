<template>
  <div class="supplier-applications">
    <section class="hero">
      <div>
        <span class="eyebrow">SUPPLIER ONBOARDING</span>
        <h1>供应商入驻审核</h1>
        <p>审核通过后只创建冻结账号，申请人必须通过原手机号验证并设置新密码后才能登录。</p>
      </div>
      <div class="hero-stat"><strong>{{ pendingCount }}</strong><span>当前待审核</span></div>
    </section>

    <el-card shadow="never" class="content-card">
      <div class="toolbar">
        <el-radio-group v-model="status" @change="load(1)">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="0">待审核</el-radio-button>
          <el-radio-button value="1">已通过</el-radio-button>
          <el-radio-button value="2">已拒绝</el-radio-button>
        </el-radio-group>
        <div class="search-row">
          <el-input v-model="keyword" clearable placeholder="供应商、联系人、手机号或 UID" @keyup.enter="load(1)" />
          <el-button type="primary" @click="load(1)">查询</el-button>
        </div>
      </div>

      <el-alert
        title="安全迁移说明：不再下发“手机号后六位”默认密码；账号激活状态在列表中单独显示。"
        type="warning" :closable="false" show-icon class="security-alert"
      />

      <el-table class="desktop-table" :data="list" v-loading="loading" row-key="id" stripe>
        <el-table-column label="申请主体" min-width="240">
          <template #default="{ row }">
            <strong>{{ row.system_name }}</strong>
            <div class="sub">UID {{ row.uid }} · {{ row.name }} · {{ row.phone }}</div>
          </template>
        </el-table-column>
        <el-table-column label="资质" width="90">
          <template #default="{ row }">
            <el-link v-if="row.images.length" :href="row.images[0]" target="_blank" type="primary">
              {{ row.images.length }} 张
            </el-link>
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
        <el-table-column label="操作" width="235" fixed="right">
          <template #default="{ row }">
            <template v-if="row.status === 0">
              <el-button type="success" size="small" @click="approve(row)">通过</el-button>
              <el-button type="danger" plain size="small" @click="openReject(row)">拒绝</el-button>
            </template>
            <el-button size="small" @click="openMark(row)">备注</el-button>
            <el-button v-if="row.status !== 1" text type="danger" size="small" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-loading="loading" class="mobile-list">
        <article v-for="row in list" :key="row.id" class="mobile-card">
          <div class="mobile-head">
            <div><strong>{{ row.system_name }}</strong><span>申请 #{{ row.id }} · UID {{ row.uid }}</span></div>
            <el-tag :type="statusTone(row.status)" size="small">{{ row.status_label }}</el-tag>
          </div>
          <div class="mobile-detail"><span>联系人</span><b>{{ row.name }} · {{ row.phone }}</b></div>
          <div class="mobile-detail"><span>账号状态</span><b>{{ row.activated ? "已激活" : row.activation_required ? "等待短信激活" : "尚未创建" }}</b></div>
          <div v-if="row.account" class="mobile-detail"><span>登录账号</span><b>{{ row.account }}</b></div>
          <div class="mobile-detail"><span>申请时间</span><b>{{ formatTime(row.add_time) }}</b></div>
          <p v-if="row.mark" class="mobile-note">备注：{{ row.mark }}</p>
          <p v-if="row.fail_msg" class="mobile-note danger">拒绝原因：{{ row.fail_msg }}</p>
          <div class="mobile-actions">
            <template v-if="row.status === 0">
              <el-button type="success" size="small" @click="approve(row)">通过</el-button>
              <el-button type="danger" plain size="small" @click="openReject(row)">拒绝</el-button>
            </template>
            <el-button size="small" @click="openMark(row)">备注</el-button>
            <el-button v-if="row.status !== 1" text type="danger" size="small" @click="remove(row)">删除</el-button>
          </div>
        </article>
        <el-empty v-if="!loading && !list.length" description="暂无供应商申请" :image-size="64" />
      </div>
      <el-pagination class="pager" layout="total, prev, pager, next" :total="total" :page-size="20" :current-page="page" @current-change="load" />
    </el-card>

    <el-dialog v-model="rejectVisible" title="拒绝供应商申请" width="440px">
      <p class="dialog-note">拒绝原因会展示给申请人，申请人可修正资料后重新提交。</p>
      <el-input v-model="rejectReason" type="textarea" :rows="4" maxlength="255" show-word-limit placeholder="请填写明确的拒绝原因" />
      <template #footer><el-button @click="rejectVisible = false">取消</el-button><el-button type="danger" :loading="submitting" @click="confirmReject">确认拒绝</el-button></template>
    </el-dialog>

    <el-dialog v-model="markVisible" title="内部审核备注" width="440px">
      <el-input v-model="markText" type="textarea" :rows="4" maxlength="255" show-word-limit />
      <template #footer><el-button @click="markVisible = false">取消</el-button><el-button type="primary" :loading="submitting" @click="confirmMark">保存备注</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiSupplierApplicationDelete,
  apiSupplierApplicationList,
  apiSupplierApplicationMark,
  apiSupplierApplicationReview,
  type SupplierApplicationItem,
} from "@/api/supplierApplication";

const list = ref<SupplierApplicationItem[]>([]);
const total = ref(0);
const page = ref(1);
const status = ref("all");
const keyword = ref("");
const loading = ref(false);
const submitting = ref(false);
const rejectVisible = ref(false);
const markVisible = ref(false);
const rejectReason = ref("");
const markText = ref("");
const current = ref<SupplierApplicationItem | null>(null);
const pendingCount = computed(() => list.value.filter((row) => row.status === 0).length);

function statusTone(value: number): "success" | "warning" | "danger" {
  return value === 1 ? "success" : value === 2 ? "danger" : "warning";
}
function formatTime(value: number) {
  return value ? new Date(value * 1000).toLocaleString("zh-CN", { hour12: false }) : "-";
}
async function load(targetPage = 1) {
  loading.value = true;
  page.value = targetPage;
  try {
    const result = await apiSupplierApplicationList({
      page: targetPage, limit: 20, status: status.value, keyword: keyword.value,
    });
    list.value = result.list;
    total.value = result.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "供应商申请加载失败");
  } finally { loading.value = false; }
}
async function approve(row: SupplierApplicationItem) {
  try {
    await ElMessageBox.confirm(
      `确认通过“${row.system_name}”的申请？系统只会创建冻结账号，申请人需短信验证后设置密码。`,
      "通过供应商申请",
      { type: "warning", confirmButtonText: "通过并等待激活", cancelButtonText: "取消" },
    );
  } catch { return; }
  submitting.value = true;
  try {
    await apiSupplierApplicationReview(row.id, { status: 1 });
    await load(page.value);
    ElMessage.success("审核通过，账号正在等待申请人短信激活");
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "审核失败"); }
  finally { submitting.value = false; }
}
function openReject(row: SupplierApplicationItem) {
  current.value = row; rejectReason.value = ""; rejectVisible.value = true;
}
async function confirmReject() {
  if (!current.value || rejectReason.value.trim().length < 2) {
    ElMessage.warning("请填写至少 2 个字符的拒绝原因"); return;
  }
  submitting.value = true;
  try {
    await apiSupplierApplicationReview(current.value.id, { status: 2, fail_msg: rejectReason.value.trim() });
    rejectVisible.value = false; await load(page.value); ElMessage.success("申请已拒绝");
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "审核失败"); }
  finally { submitting.value = false; }
}
function openMark(row: SupplierApplicationItem) {
  current.value = row; markText.value = row.mark; markVisible.value = true;
}
async function confirmMark() {
  if (!current.value) return;
  submitting.value = true;
  try {
    await apiSupplierApplicationMark(current.value.id, markText.value.trim());
    markVisible.value = false; await load(page.value); ElMessage.success("备注已保存");
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "备注保存失败"); }
  finally { submitting.value = false; }
}
async function remove(row: SupplierApplicationItem) {
  try { await ElMessageBox.confirm("确认删除这条未通过的申请记录？", "删除申请", { type: "warning" }); }
  catch { return; }
  try { await apiSupplierApplicationDelete(row.id); await load(page.value); ElMessage.success("申请已删除"); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "删除失败"); }
}
onMounted(() => load(1));
</script>

<style scoped>
.supplier-applications { display: grid; gap: 16px; }
.hero { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 28px 32px; border-radius: 16px; color: #fff; background: linear-gradient(125deg, #102d2b, #176e65 64%, #d7a94f); box-shadow: 0 14px 34px rgba(16, 45, 43, .18); }
.eyebrow { color: #f1d49d; font-size: 11px; font-weight: 700; letter-spacing: .16em; }
.hero h1 { margin: 7px 0; font-size: 27px; }
.hero p { max-width: 720px; margin: 0; color: rgba(255,255,255,.78); line-height: 1.65; }
.hero-stat { min-width: 124px; padding: 16px 20px; border: 1px solid rgba(255,255,255,.22); border-radius: 12px; text-align: center; background: rgba(255,255,255,.09); }
.hero-stat strong { display: block; font-size: 30px; }.hero-stat span { font-size: 12px; color: rgba(255,255,255,.72); }
.content-card { border-radius: 12px; }.toolbar { display: flex; justify-content: space-between; gap: 14px; margin-bottom: 14px; }.search-row { display: flex; gap: 8px; }.search-row .el-input { width: 300px; }
.security-alert { margin-bottom: 15px; }.sub { margin-top: 6px; color: #8992a3; font-size: 12px; }.danger { color: #e54d42; }.second-tag { margin-left: 6px; }.pager { margin-top: 18px; justify-content: flex-end; }
.mobile-list { display: none; }.mobile-card { padding: 16px 0; border-bottom: 1px solid #edf0ef; }.mobile-card:first-child { padding-top: 2px; }.mobile-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }.mobile-head strong,.mobile-head span { display: block; }.mobile-head strong { color: #17332f; font-size: 15px; }.mobile-head span { margin-top: 5px; color: #929c99; font-size: 11px; }.mobile-detail { display: flex; justify-content: space-between; gap: 16px; margin-top: 12px; font-size: 12px; }.mobile-detail span { color: #929c99; }.mobile-detail b { color: #465653; font-weight: 500; text-align: right; }.mobile-note { margin: 12px 0 0; padding: 9px 10px; border-radius: 7px; color: #64706d; background: #f5f7f6; font-size: 12px; line-height: 1.5; }.mobile-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }.mobile-actions .el-button { margin-left: 0; }
.dialog-note { padding: 10px 12px; border-left: 3px solid #e6a23c; color: #735b2e; background: #fff8e8; font-size: 13px; line-height: 1.6; }
@media (max-width: 900px) { .hero { align-items: flex-start; padding: 22px; }.hero-stat { min-width: 94px; }.toolbar { align-items: stretch; flex-direction: column; }.search-row .el-input { width: 100%; } }
@media (max-width: 620px) { .hero-stat { display: none; }.hero h1 { font-size: 23px; }.search-row { flex-direction: column; } }
@media (max-width: 760px) { .desktop-table { display: none; }.mobile-list { display: block; }.security-alert :deep(.el-alert__content) { min-width: 0; }.pager { justify-content: center; } }
</style>
