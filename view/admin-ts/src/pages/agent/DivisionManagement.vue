<template>
  <div class="division-page">
    <div class="summary-grid">
      <el-card v-for="item in summaryCards" :key="item.label" shadow="never" class="summary-card">
        <span>{{ item.label }}</span><strong>{{ item.value }}</strong>
      </el-card>
    </div>

    <el-tabs v-model="activeTab" class="content-card" @tab-change="handleTabChange">
      <el-tab-pane label="层级管理" name="roles">
        <div class="toolbar">
          <el-segmented v-model="roleType" :options="roleTypeOptions" @change="loadRoles(1)" />
          <el-input v-model="keyword" clearable placeholder="名称、昵称或 UID" class="keyword" @keyup.enter="loadRoles(1)" />
          <el-button @click="loadRoles(1)">查询</el-button>
          <el-button type="primary" @click="openRoleForm()">新增{{ roleLabel }}</el-button>
        </div>
        <el-table :data="roles" v-loading="roleLoading" border>
          <el-table-column prop="uid" label="UID" width="76" />
          <el-table-column label="名称" min-width="160"><template #default="{ row }">{{ row.divisionName || row.nickname || `#${row.uid}` }}</template></el-table-column>
          <el-table-column prop="phone" label="手机号" width="130" />
          <el-table-column label="比例" width="82"><template #default="{ row }">{{ row.divisionPercent }}%</template></el-table-column>
          <el-table-column label="到期时间" width="130"><template #default="{ row }">{{ formatDate(row.divisionEndTime) }}</template></el-table-column>
          <el-table-column prop="downNum" label="直属下级" width="92" />
          <el-table-column label="状态" width="82">
            <template #default="{ row }"><el-switch :model-value="row.divisionStatus" :active-value="1" :inactive-value="0" @change="changeStatusValue(row, $event)" /></template>
          </el-table-column>
          <el-table-column label="操作" width="145" fixed="right">
            <template #default="{ row }"><el-button link type="primary" @click="openRoleForm(row)">编辑</el-button><el-button link type="danger" @click="removeRole(row)">解除</el-button></template>
          </el-table-column>
        </el-table>
        <el-pagination class="pager" layout="total, prev, pager, next" :total="roleTotal" :page-size="20" :current-page="rolePage" @current-change="loadRoles" />
      </el-tab-pane>

      <el-tab-pane label="代理申请" name="applications">
        <div class="toolbar">
          <el-select v-model="applicationStatus" clearable placeholder="审核状态" class="short-select" @change="loadApplications(1)">
            <el-option label="待审核" :value="0" /><el-option label="已通过" :value="1" /><el-option label="已拒绝" :value="2" />
          </el-select>
          <el-input v-model="applicationKeyword" clearable placeholder="名称、联系人或手机号" class="keyword" @keyup.enter="loadApplications(1)" />
          <el-button @click="loadApplications(1)">查询</el-button>
        </div>
        <el-table :data="applications" v-loading="applicationLoading" border>
          <el-table-column prop="id" label="ID" width="70" /><el-table-column prop="uid" label="UID" width="76" />
          <el-table-column prop="divisionName" label="代理商名称" min-width="140" /><el-table-column prop="name" label="联系人" width="105" />
          <el-table-column prop="phone" label="手机号" width="130" /><el-table-column prop="divisionId" label="事业部 UID" width="110" />
          <el-table-column label="状态" width="88"><template #default="{ row }"><el-tag :type="applicationTag(row.status)">{{ applicationLabel(row.status) }}</el-tag></template></el-table-column>
          <el-table-column label="申请时间" width="165"><template #default="{ row }">{{ formatTime(row.addTime) }}</template></el-table-column>
          <el-table-column label="操作" width="180" fixed="right">
            <template #default="{ row }"><template v-if="row.status === 0"><el-button link type="success" @click="openReview(row, true)">通过</el-button><el-button link type="warning" @click="openReview(row, false)">拒绝</el-button></template><el-button link type="danger" @click="removeApplication(row)">删除</el-button></template>
          </el-table-column>
        </el-table>
        <el-pagination class="pager" layout="total, prev, pager, next" :total="applicationTotal" :page-size="20" :current-page="applicationPage" @current-change="loadApplications" />
      </el-tab-pane>

      <el-tab-pane label="事业部订单" name="orders">
        <div class="toolbar">
          <el-select v-model="orderDivisionId" clearable placeholder="事业部" class="short-select" @change="divisionChanged">
            <el-option v-for="item in divisionOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select v-model="orderAgentId" clearable placeholder="代理商" class="short-select">
            <el-option v-for="item in orderAgentOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-input v-model="orderKeyword" clearable placeholder="订单号、收货人或手机号" class="keyword" @keyup.enter="loadOrders(1)" />
          <el-button @click="loadOrders(1)">查询</el-button>
        </div>
        <el-table :data="orders" v-loading="orderLoading" border>
          <el-table-column prop="orderId" label="订单号" min-width="190" /><el-table-column label="用户" width="130"><template #default="{ row }">{{ row.realName || `UID ${row.uid}` }}</template></el-table-column>
          <el-table-column label="实付" width="100"><template #default="{ row }">¥{{ row.payPrice }}</template></el-table-column>
          <el-table-column prop="divisionId" label="事业部" width="90" /><el-table-column prop="divisionAgentId" label="代理商" width="90" /><el-table-column prop="divisionStaffId" label="员工" width="90" />
          <el-table-column label="角色佣金" width="120"><template #default="{ row }">¥{{ commissionTotal(row) }}</template></el-table-column>
          <el-table-column label="支付" width="80"><template #default="{ row }"><el-tag :type="row.paid ? 'success' : 'info'">{{ row.paid ? "已支付" : "未支付" }}</el-tag></template></el-table-column>
          <el-table-column label="下单时间" width="165"><template #default="{ row }">{{ formatTime(row.addTime) }}</template></el-table-column>
        </el-table>
        <el-pagination class="pager" layout="total, prev, pager, next" :total="orderTotal" :page-size="20" :current-page="orderPage" @current-change="loadOrders" />
      </el-tab-pane>

      <el-tab-pane label="业绩排行" name="ranking">
        <el-table :data="ranking" v-loading="rankingLoading" border>
          <el-table-column type="index" label="排名" width="76" /><el-table-column prop="nickname" label="团队" min-width="180" />
          <el-table-column prop="downNum" label="直属下级" width="100" /><el-table-column prop="orderNum" label="订单数" width="100" />
          <el-table-column label="订单金额" width="140"><template #default="{ row }">¥{{ row.orderPrice }}</template></el-table-column>
          <el-table-column label="角色佣金" width="140"><template #default="{ row }">¥{{ row.brokeragePrice }}</template></el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="roleDialog" :title="`${editing ? '编辑' : '新增'}${roleLabel}`" width="560px">
      <el-form :model="roleForm" label-width="112px">
        <el-form-item label="用户 UID" required><el-input-number v-model="roleForm.uid" :disabled="editing" :min="1" /></el-form-item>
        <el-form-item v-if="roleType === 2" label="上级事业部" required><el-select v-model="roleForm.parentUid" filterable><el-option v-for="item in divisionOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
        <template v-if="roleType === 3">
          <el-form-item label="所属事业部" required><el-select v-model="roleForm.parentDivisionId" filterable @change="formDivisionChanged"><el-option v-for="item in divisionOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
          <el-form-item label="上级代理商" required><el-select v-model="roleForm.parentUid" filterable><el-option v-for="item in formAgentOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
        </template>
        <el-form-item v-if="roleType !== 3" label="名称" required><el-input v-model="roleForm.divisionName" maxlength="32" /></el-form-item>
        <el-form-item label="佣金比例" required><el-input-number v-model="roleForm.divisionPercent" :min="0" :max="100" /><span class="suffix">%</span></el-form-item>
        <el-form-item v-if="roleType !== 3" label="到期时间"><el-date-picker v-model="roleForm.divisionEndTime" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="状态"><el-switch v-model="roleForm.divisionStatus" :active-value="1" :inactive-value="0" /></el-form-item>
        <template v-if="roleType === 1">
          <el-divider content-position="left">事业部管理员</el-divider>
          <el-form-item label="管理员账号" :required="!editing"><el-input v-model="roleForm.account" /></el-form-item>
          <el-form-item label="管理员手机"><el-input v-model="roleForm.phone" /></el-form-item>
          <el-form-item label="角色 ID"><el-input v-model="roleForm.roles" placeholder="多个角色用逗号分隔" /></el-form-item>
          <el-form-item label="管理员密码" :required="!editing"><el-input v-model="roleForm.password" type="password" show-password /></el-form-item>
          <el-form-item label="确认密码" :required="!editing"><el-input v-model="roleForm.passwordConfirm" type="password" show-password /></el-form-item>
        </template>
      </el-form>
      <template #footer><el-button @click="roleDialog = false">取消</el-button><el-button type="primary" :loading="roleSaving" @click="saveRole">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="reviewDialog" :title="reviewForm.approved ? '通过代理商申请' : '拒绝代理商申请'" width="500px">
      <el-form :model="reviewForm" label-width="100px">
        <template v-if="reviewForm.approved"><el-form-item label="佣金比例" required><el-input-number v-model="reviewForm.percent" :min="0" :max="100" /><span class="suffix">%</span></el-form-item><el-form-item label="到期时间" required><el-date-picker v-model="reviewForm.endTime" type="date" value-format="YYYY-MM-DD" /></el-form-item><el-form-item label="状态"><el-switch v-model="reviewForm.status" :active-value="1" :inactive-value="0" /></el-form-item></template>
        <el-form-item v-else label="拒绝原因" required><el-input v-model="reviewForm.reason" type="textarea" :rows="4" maxlength="1000" show-word-limit /></el-form-item>
      </el-form>
      <template #footer><el-button @click="reviewDialog = false">取消</el-button><el-button type="primary" :loading="reviewSaving" @click="submitReview">确认</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiAgentOptions, apiDivisionApplicationDelete, apiDivisionApplicationReview,
  apiDivisionApplications, apiDivisionOptions, apiDivisionOrders, apiDivisionRanking,
  apiDivisionRoleDelete, apiDivisionRoleDetail, apiDivisionRoleList, apiDivisionRoleSave,
  apiDivisionRoleStatus, apiDivisionStatistics, type DivisionApplication, type DivisionOption,
  type DivisionOrderItem, type DivisionRankingItem, type DivisionRoleItem,
  type DivisionRoleType, type DivisionStatistics,
} from "@/api/division";

const activeTab = ref("roles");
const statistics = ref<DivisionStatistics>({ divisionNum: 0, agentNum: 0, staffNum: 0, orderNum: 0, orderPrice: "0", brokeragePrice: "0" });
const summaryCards = computed(() => [
  { label: "事业部", value: statistics.value.divisionNum }, { label: "代理商", value: statistics.value.agentNum },
  { label: "员工", value: statistics.value.staffNum }, { label: "支付订单", value: statistics.value.orderNum },
  { label: "订单金额", value: `¥${statistics.value.orderPrice}` }, { label: "角色佣金", value: `¥${statistics.value.brokeragePrice}` },
]);
const roleType = ref<DivisionRoleType>(1);
const roleTypeOptions = [{ label: "事业部", value: 1 }, { label: "代理商", value: 2 }, { label: "员工", value: 3 }];
const roleLabel = computed(() => roleTypeOptions.find((item) => item.value === roleType.value)?.label ?? "角色");
const roles = ref<DivisionRoleItem[]>([]); const roleLoading = ref(false); const rolePage = ref(1); const roleTotal = ref(0); const keyword = ref("");
const roleDialog = ref(false); const roleSaving = ref(false); const editing = ref(false);
const divisionOptions = ref<DivisionOption[]>([]); const formAgentOptions = ref<DivisionOption[]>([]);
const roleForm = reactive({ uid: 1, parentUid: undefined as number | undefined, parentDivisionId: undefined as number | undefined, divisionName: "", divisionPercent: 0, divisionEndTime: "", divisionStatus: 1, account: "", phone: "", roles: "", password: "", passwordConfirm: "" });
const applications = ref<DivisionApplication[]>([]); const applicationLoading = ref(false); const applicationPage = ref(1); const applicationTotal = ref(0); const applicationStatus = ref<number | undefined>(0); const applicationKeyword = ref("");
const reviewDialog = ref(false); const reviewSaving = ref(false); const reviewForm = reactive({ id: 0, approved: true, percent: 0, endTime: "", status: 1, reason: "" });
const orders = ref<DivisionOrderItem[]>([]); const orderLoading = ref(false); const orderPage = ref(1); const orderTotal = ref(0); const orderDivisionId = ref<number | undefined>(); const orderAgentId = ref<number | undefined>(); const orderKeyword = ref(""); const orderAgentOptions = ref<DivisionOption[]>([]);
const ranking = ref<DivisionRankingItem[]>([]); const rankingLoading = ref(false);

function formatDate(ts: number) { return ts ? new Date(ts * 1000).toLocaleDateString("zh-CN") : "长期"; }
function formatTime(ts: number) { return ts ? new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false }) : "-"; }
function dateValue(ts: number) { return ts ? new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 10) : ""; }
function commissionTotal(row: DivisionOrderItem) { return (Number(row.divisionBrokerage) + Number(row.divisionAgentBrokerage) + Number(row.divisionStaffBrokerage)).toFixed(2); }
function applicationLabel(status: number) { return ["待审核", "已通过", "已拒绝"][status] ?? "未知"; }
function applicationTag(status: number): "warning" | "success" | "danger" { return status === 1 ? "success" : status === 2 ? "danger" : "warning"; }
async function loadSummary() { statistics.value = await apiDivisionStatistics(); }
async function loadOptions() { divisionOptions.value = await apiDivisionOptions(); }
async function loadRoles(page = 1) { roleLoading.value = true; rolePage.value = page; try { const data = await apiDivisionRoleList({ division_type: roleType.value, keyword: keyword.value, page, limit: 20 }); roles.value = data.list; roleTotal.value = data.count; } finally { roleLoading.value = false; } }
function resetRoleForm() { Object.assign(roleForm, { uid: 1, parentUid: undefined, parentDivisionId: undefined, divisionName: "", divisionPercent: 0, divisionEndTime: "", divisionStatus: 1, account: "", phone: "", roles: "", password: "", passwordConfirm: "" }); }
async function formDivisionChanged(value: number) { roleForm.parentUid = undefined; formAgentOptions.value = value ? await apiAgentOptions(value) : []; }
async function openRoleForm(row?: DivisionRoleItem) { resetRoleForm(); editing.value = Boolean(row); roleDialog.value = true; if (!row) return; const detail = await apiDivisionRoleDetail(row.uid); roleType.value = row.divisionType; if (row.divisionType === 3) formAgentOptions.value = await apiAgentOptions(row.divisionId); Object.assign(roleForm, { uid: row.uid, parentUid: row.divisionType === 2 ? row.divisionId : row.agentId, parentDivisionId: row.divisionId, divisionName: row.divisionName, divisionPercent: row.divisionPercent, divisionEndTime: dateValue(row.divisionEndTime), divisionStatus: row.divisionStatus, account: detail.admin?.account ?? "", phone: detail.admin?.phone ?? row.phone, roles: detail.admin?.roles ?? "" }); }
async function saveRole() { roleSaving.value = true; try { await apiDivisionRoleSave(roleType.value, { uid: roleForm.uid, division_id: roleType.value === 2 ? roleForm.parentUid : undefined, agent_id: roleType.value === 3 ? roleForm.parentUid : undefined, division_name: roleForm.divisionName, division_percent: roleForm.divisionPercent, division_end_time: roleForm.divisionEndTime, division_status: roleForm.divisionStatus, account: roleForm.account, phone: roleForm.phone, roles: roleForm.roles, pwd: roleForm.password || undefined, conf_pwd: roleForm.passwordConfirm || undefined }); ElMessage.success("保存成功"); roleDialog.value = false; await Promise.all([loadRoles(rolePage.value), loadSummary(), loadOptions()]); } finally { roleSaving.value = false; } }
async function changeStatus(row: DivisionRoleItem, status: number) { await apiDivisionRoleStatus(row.uid, status); row.divisionStatus = status; ElMessage.success("状态已更新"); }
function changeStatusValue(row: DivisionRoleItem, value: string | number | boolean) { void changeStatus(row, Number(value)); }
async function removeRole(row: DivisionRoleItem) { await ElMessageBox.confirm(`解除 ${row.divisionName || row.nickname || row.uid} 的事业部角色？下级角色会同步解除。`, "谨慎操作", { type: "warning" }); await apiDivisionRoleDelete(row.uid); ElMessage.success("已解除"); await Promise.all([loadRoles(rolePage.value), loadSummary(), loadOptions()]); }
async function loadApplications(page = 1) { applicationLoading.value = true; applicationPage.value = page; try { const data = await apiDivisionApplications({ status: applicationStatus.value, keyword: applicationKeyword.value, page, limit: 20 }); applications.value = data.list; applicationTotal.value = data.count; } finally { applicationLoading.value = false; } }
function openReview(row: DivisionApplication, approved: boolean) { Object.assign(reviewForm, { id: row.id, approved, percent: 0, endTime: "", status: 1, reason: "" }); reviewDialog.value = true; }
async function submitReview() { reviewSaving.value = true; try { await apiDivisionApplicationReview({ id: reviewForm.id, type: reviewForm.approved ? 1 : 0, division_percent: reviewForm.percent, division_end_time: reviewForm.endTime, division_status: reviewForm.status, refusal_reason: reviewForm.reason }); ElMessage.success(reviewForm.approved ? "审核通过" : "已拒绝"); reviewDialog.value = false; await Promise.all([loadApplications(applicationPage.value), loadSummary()]); } finally { reviewSaving.value = false; } }
async function removeApplication(row: DivisionApplication) { await ElMessageBox.confirm("删除这条申请记录？", "提示", { type: "warning" }); await apiDivisionApplicationDelete(row.id); await loadApplications(applicationPage.value); }
async function divisionChanged(value: number | undefined) { orderAgentId.value = undefined; orderAgentOptions.value = value ? await apiAgentOptions(value) : []; }
async function loadOrders(page = 1) { orderLoading.value = true; orderPage.value = page; try { const data = await apiDivisionOrders({ division_id: orderDivisionId.value, division_agent_id: orderAgentId.value, keyword: orderKeyword.value, page, limit: 20 }); orders.value = data.list; orderTotal.value = data.count; } finally { orderLoading.value = false; } }
async function loadRanking() { rankingLoading.value = true; try { ranking.value = (await apiDivisionRanking()).list; } finally { rankingLoading.value = false; } }
function handleTabChange(name: string | number) { if (name === "applications") void loadApplications(1); if (name === "orders") void loadOrders(1); if (name === "ranking") void loadRanking(); }
onMounted(async () => { await Promise.all([loadSummary(), loadRoles(1), loadOptions()]); });
</script>

<style scoped>
.division-page { display: flex; flex-direction: column; gap: 16px; }
.summary-grid { display: grid; grid-template-columns: repeat(6, minmax(125px, 1fr)); gap: 12px; }
.summary-card :deep(.el-card__body) { display: flex; flex-direction: column; gap: 8px; }
.summary-card span { color: #64748b; font-size: 13px; }.summary-card strong { color: #0f172a; font-size: 24px; }
.content-card { background: #fff; border-radius: 8px; padding: 8px 18px 18px; }.toolbar { display: flex; align-items: center; gap: 10px; margin: 8px 0 16px; flex-wrap: wrap; }
.keyword { width: 260px; }.short-select { width: 160px; }.pager { margin-top: 16px; justify-content: flex-end; }.suffix { margin-left: 6px; color: #64748b; }
@media (max-width: 1100px) { .summary-grid { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 640px) {
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .content-card { padding: 6px 10px 12px; }
  .toolbar { align-items: stretch; }
  .keyword, .short-select { width: 100%; }
  .summary-card strong { font-size: 18px; letter-spacing: -0.3px; white-space: nowrap; }
}
</style>
