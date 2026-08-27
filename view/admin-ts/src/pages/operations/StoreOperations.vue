<template>
  <div class="store-operations">
    <div class="summary-grid">
      <el-card v-for="item in summary" :key="item.label" shadow="never">
        <span>{{ item.label }}</span><strong>{{ item.value }}</strong>
      </el-card>
    </div>

    <el-tabs v-model="activeTab" class="content-card" @tab-change="tabChanged">
      <el-tab-pane label="门店" name="stores">
        <div class="toolbar">
          <el-select v-model="storeType" class="short-select" @change="loadStores(1)">
            <el-option label="全部有效门店" value="" />
            <el-option label="营业中" value="1" />
            <el-option label="已停业" value="-1" />
            <el-option label="回收站" value="2" />
          </el-select>
          <el-input v-model="storeKeyword" clearable class="keyword" placeholder="门店、电话或地址" @keyup.enter="loadStores(1)" />
          <el-button @click="loadStores(1)">查询</el-button>
          <el-button type="primary" @click="openStore()">新增门店</el-button>
        </div>
        <el-table :data="stores" v-loading="storeLoading" border stripe row-key="id">
          <el-table-column prop="id" label="ID" width="70" />
          <el-table-column label="门店" min-width="190">
            <template #default="{ row }"><strong>{{ row.name }}</strong><div class="muted">{{ row.introduction || "—" }}</div></template>
          </el-table-column>
          <el-table-column prop="phone" label="联系电话" width="130" />
          <el-table-column label="地址" min-width="240">
            <template #default="{ row }">{{ row.address }} {{ row.detailed_address }}</template>
          </el-table-column>
          <el-table-column prop="day_time" label="营业时间" width="150" />
          <el-table-column label="营业" width="82">
            <template #default="{ row }">
              <el-switch v-if="!row.is_del" :model-value="row.is_show" :active-value="1" :inactive-value="0" @change="setStoreVisibilityValue(row, $event)" />
              <el-tag v-else type="info">回收站</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="自提" width="70"><template #default="{ row }"><el-tag :type="row.is_store ? 'success' : 'info'">{{ row.is_store ? "开启" : "关闭" }}</el-tag></template></el-table-column>
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openStore(row)">编辑</el-button>
              <el-button link :type="row.is_del ? 'success' : 'danger'" @click="toggleStore(row)">{{ row.is_del ? "恢复" : "回收" }}</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-pagination class="pager" layout="total, prev, pager, next" :total="storeTotal" :page-size="20" :current-page="storePage" @current-change="loadStores" />
      </el-tab-pane>

      <el-tab-pane label="店员与核销" name="staff">
        <div class="toolbar">
          <el-select v-model="staffStoreId" clearable filterable class="short-select" placeholder="全部门店" @change="loadStaff(1)">
            <el-option v-for="item in storeOptions" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
          <el-input v-model="staffKeyword" clearable class="keyword" placeholder="姓名、电话或 UID" @keyup.enter="loadStaff(1)" />
          <el-button @click="loadStaff(1)">查询</el-button>
          <el-button type="primary" @click="openStaff()">新增店员</el-button>
        </div>
        <el-alert title="店员列表不会返回登录密码哈希或最后登录 IP；核销资格还会同时校验门店、店员和关联用户状态。" type="info" show-icon :closable="false" />
        <el-table :data="staff" v-loading="staffLoading" border stripe row-key="id" class="spaced-table">
          <el-table-column prop="id" label="ID" width="70" />
          <el-table-column label="店员" min-width="170"><template #default="{ row }"><strong>{{ row.staff_name }}</strong><div class="muted">UID {{ row.uid }} · {{ row.nickname || "未设置昵称" }}</div></template></el-table-column>
          <el-table-column prop="name" label="所属门店" min-width="150" />
          <el-table-column prop="phone" label="电话" width="130" />
          <el-table-column label="核销" width="76"><template #default="{ row }"><el-tag :type="row.verify_status ? 'success' : 'info'">{{ row.verify_status ? "允许" : "关闭" }}</el-tag></template></el-table-column>
          <el-table-column label="状态" width="82"><template #default="{ row }"><el-switch :model-value="row.status" :active-value="1" :inactive-value="0" @change="setStaffStatusValue(row, $event)" /></template></el-table-column>
          <el-table-column label="操作" width="145" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openStaff(row)">编辑</el-button><el-button link type="danger" @click="removeStaff(row)">删除</el-button></template></el-table-column>
        </el-table>
        <el-pagination class="pager" layout="total, prev, pager, next" :total="staffTotal" :page-size="20" :current-page="staffPage" @current-change="loadStaff" />
      </el-tab-pane>

      <el-tab-pane label="配送员" name="delivery">
        <div class="toolbar">
          <el-input v-model="deliveryKeyword" clearable class="keyword" placeholder="姓名、电话或 UID" @keyup.enter="loadDelivery(1)" />
          <el-button @click="loadDelivery(1)">查询</el-button>
          <el-button type="primary" @click="openDelivery()">新增配送员</el-button>
        </div>
        <el-alert title="订单选择门店配送时只接受这里唯一且有效的配送员身份；姓名和手机号由服务端记录提供，客户端不能覆盖。" type="success" show-icon :closable="false" />
        <el-table :data="delivery" v-loading="deliveryLoading" border stripe row-key="id" class="spaced-table">
          <el-table-column prop="id" label="ID" width="70" />
          <el-table-column prop="uid" label="用户 UID" width="95" />
          <el-table-column label="配送员" min-width="170"><template #default="{ row }"><strong>{{ row.wx_name || row.nickname }}</strong><div class="muted">商城昵称：{{ row.nickname || "—" }}</div></template></el-table-column>
          <el-table-column prop="phone" label="手机号" width="135" />
          <el-table-column label="状态" width="82"><template #default="{ row }"><el-switch :model-value="row.status" :active-value="1" :inactive-value="0" @change="setDeliveryStatusValue(row, $event)" /></template></el-table-column>
          <el-table-column label="添加时间" width="170"><template #default="{ row }">{{ formatTime(row.add_time) }}</template></el-table-column>
          <el-table-column label="操作" width="145" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openDelivery(row)">编辑</el-button><el-button link type="danger" @click="removeDelivery(row)">删除</el-button></template></el-table-column>
        </el-table>
        <el-pagination class="pager" layout="total, prev, pager, next" :total="deliveryTotal" :page-size="20" :current-page="deliveryPage" @current-change="loadDelivery" />
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="storeDialog" class="operations-dialog" :title="storeForm.id ? '编辑门店' : '新增门店'" width="680px">
      <el-form :model="storeForm" label-width="104px">
        <div class="form-grid">
          <el-form-item label="门店名称" required><el-input v-model="storeForm.name" maxlength="100" /></el-form-item>
          <el-form-item label="联系电话" required><el-input v-model="storeForm.phone" maxlength="20" /></el-form-item>
          <el-form-item label="区域地址" required><el-input v-model="storeForm.address" placeholder="省,市,区" /></el-form-item>
          <el-form-item label="详细地址" required><el-input v-model="storeForm.detailed_address" maxlength="255" /></el-form-item>
          <el-form-item label="纬度" required><el-input v-model="storeForm.latitude" /></el-form-item>
          <el-form-item label="经度" required><el-input v-model="storeForm.longitude" /></el-form-item>
          <el-form-item label="营业时间" required><el-input v-model="storeForm.day_time" placeholder="09:00 - 18:00" /></el-form-item>
          <el-form-item label="有效距离"><el-input-number v-model="storeForm.valid_range" :min="0" /><span class="suffix">米</span></el-form-item>
          <el-form-item label="门店图片" class="full"><el-input v-model="storeForm.image" maxlength="255" placeholder="图片 URL" /></el-form-item>
          <el-form-item label="门店简介" class="full"><el-input v-model="storeForm.introduction" type="textarea" :rows="3" maxlength="1000" show-word-limit /></el-form-item>
          <el-form-item label="营业状态"><el-switch v-model="storeForm.is_show" :active-value="1" :inactive-value="0" /></el-form-item>
          <el-form-item label="到店自提"><el-switch v-model="storeForm.is_store" :active-value="1" :inactive-value="0" /></el-form-item>
        </div>
      </el-form>
      <template #footer><el-button @click="storeDialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveStore">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="staffDialog" class="operations-dialog" :title="staffForm.id ? '编辑店员' : '新增店员'" width="560px">
      <el-form :model="staffForm" label-width="100px">
        <el-form-item label="所属门店" required><el-select v-model="staffForm.store_id" filterable><el-option v-for="item in storeOptions" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item>
        <el-form-item label="用户 UID" required><el-input-number v-model="staffForm.uid" :min="1" /></el-form-item>
        <el-form-item label="店员名称" required><el-input v-model="staffForm.staff_name" maxlength="64" /></el-form-item>
        <el-form-item label="联系电话" required><el-input v-model="staffForm.phone" maxlength="15" /></el-form-item>
        <el-form-item label="头像"><el-input v-model="staffForm.avatar" maxlength="255" /></el-form-item>
        <el-form-item label="核销权限"><el-switch v-model="staffForm.verify_status" :active-value="1" :inactive-value="0" /></el-form-item>
        <el-form-item label="账号状态"><el-switch v-model="staffForm.status" :active-value="1" :inactive-value="0" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="staffDialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveStaff">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="deliveryDialog" class="operations-dialog" :title="deliveryForm.id ? '编辑配送员' : '新增配送员'" width="540px">
      <el-form :model="deliveryForm" label-width="100px">
        <el-form-item label="用户 UID" required><el-input-number v-model="deliveryForm.uid" :min="1" :disabled="deliveryForm.id > 0" /></el-form-item>
        <el-form-item label="配送员名称"><el-input v-model="deliveryForm.nickname" maxlength="50" placeholder="留空则使用商城昵称" /></el-form-item>
        <el-form-item label="手机号"><el-input v-model="deliveryForm.phone" maxlength="20" placeholder="留空则使用用户绑定手机号" /></el-form-item>
        <el-form-item label="头像"><el-input v-model="deliveryForm.avatar" maxlength="250" /></el-form-item>
        <el-form-item label="状态"><el-switch v-model="deliveryForm.status" :active-value="1" :inactive-value="0" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="deliveryDialog = false">取消</el-button><el-button type="primary" :loading="saving" @click="saveDelivery">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiDeliveryDelete, apiDeliveryList, apiDeliverySave, apiDeliveryStatus,
  apiStaffDelete, apiStaffList, apiStaffSave, apiStaffStatus,
  apiStoreDelete, apiStoreHeader, apiStoreList, apiStoreOptions, apiStoreSave,
  apiStoreVisibility, type DeliveryItem, type StaffItem, type StoreItem, type StoreOption,
} from "@/api/store";

const activeTab = ref("stores");
const storeHeader = ref({ show: { num: 0 }, hide: { num: 0 }, recycle: { num: 0 } });
const summary = computed(() => [
  { label: "营业中门店", value: storeHeader.value.show.num },
  { label: "已停业门店", value: storeHeader.value.hide.num },
  { label: "回收站", value: storeHeader.value.recycle.num },
  { label: "当前页有效配送员", value: delivery.value.filter((row) => row.status === 1).length },
]);

const stores = ref<StoreItem[]>([]); const storeLoading = ref(false); const storePage = ref(1); const storeTotal = ref(0); const storeKeyword = ref(""); const storeType = ref("");
const staff = ref<StaffItem[]>([]); const staffLoading = ref(false); const staffPage = ref(1); const staffTotal = ref(0); const staffKeyword = ref(""); const staffStoreId = ref<number>();
const delivery = ref<DeliveryItem[]>([]); const deliveryLoading = ref(false); const deliveryPage = ref(1); const deliveryTotal = ref(0); const deliveryKeyword = ref("");
const storeOptions = ref<StoreOption[]>([]); const saving = ref(false);
const storeDialog = ref(false); const staffDialog = ref(false); const deliveryDialog = ref(false);
const storeForm = reactive({ id: 0, name: "", introduction: "", phone: "", address: "", detailed_address: "", latitude: "", longitude: "", day_time: "09:00 - 18:00", valid_range: 0, image: "", is_show: 1, is_store: 1 });
const staffForm = reactive({ id: 0, store_id: 0, uid: 1, staff_name: "", phone: "", avatar: "", verify_status: 1, status: 1 });
const deliveryForm = reactive({ id: 0, uid: 1, nickname: "", phone: "", avatar: "", status: 1 });

function message(error: unknown, fallback: string) { ElMessage.error(error instanceof Error ? error.message : fallback); }
function formatTime(value: number) { return value ? new Date(value * 1000).toLocaleString("zh-CN", { hour12: false }) : "—"; }
async function refreshHeader() { storeHeader.value = (await apiStoreHeader()).count; }
async function refreshOptions() { storeOptions.value = await apiStoreOptions(); }
async function loadStores(page = 1) { storeLoading.value = true; storePage.value = page; try { const data = await apiStoreList({ keywords: storeKeyword.value, type: storeType.value, page, limit: 20 }); stores.value = data.list; storeTotal.value = data.count; } catch (error) { message(error, "门店加载失败"); } finally { storeLoading.value = false; } }
async function loadStaff(page = 1) { staffLoading.value = true; staffPage.value = page; try { const data = await apiStaffList({ store_id: staffStoreId.value, keyword: staffKeyword.value, page, limit: 20 }); staff.value = data.list; staffTotal.value = data.count; } catch (error) { message(error, "店员加载失败"); } finally { staffLoading.value = false; } }
async function loadDelivery(page = 1) { deliveryLoading.value = true; deliveryPage.value = page; try { const data = await apiDeliveryList({ keyword: deliveryKeyword.value, page, limit: 20 }); delivery.value = data.list; deliveryTotal.value = data.count; } catch (error) { message(error, "配送员加载失败"); } finally { deliveryLoading.value = false; } }

function openStore(row?: StoreItem) { Object.assign(storeForm, row ? { id: row.id, name: row.name, introduction: row.introduction, phone: row.phone, address: row.address, detailed_address: row.detailed_address, latitude: row.latitude, longitude: row.longitude, day_time: row.day_time, valid_range: row.valid_range, image: row.image, is_show: row.is_show, is_store: row.is_store } : { id: 0, name: "", introduction: "", phone: "", address: "", detailed_address: "", latitude: "", longitude: "", day_time: "09:00 - 18:00", valid_range: 0, image: "", is_show: 1, is_store: 1 }); storeDialog.value = true; }
async function saveStore() { saving.value = true; try { await apiStoreSave(storeForm.id, { ...storeForm }); ElMessage.success("门店已保存"); storeDialog.value = false; await Promise.all([loadStores(storePage.value), refreshHeader(), refreshOptions()]); } catch (error) { message(error, "门店保存失败"); } finally { saving.value = false; } }
async function setStoreVisibility(row: StoreItem, status: number) { try { await apiStoreVisibility(row.id, status); row.is_show = status; await refreshHeader(); } catch (error) { message(error, "状态更新失败"); } }
function setStoreVisibilityValue(row: StoreItem, value: string | number | boolean) { void setStoreVisibility(row, Number(value)); }
async function toggleStore(row: StoreItem) { try { await ElMessageBox.confirm(`${row.is_del ? "恢复" : "移入回收站"}门店“${row.name}”？`, "门店状态", { type: "warning" }); } catch { return; } try { await apiStoreDelete(row.id); await Promise.all([loadStores(storePage.value), refreshHeader(), refreshOptions()]); } catch (error) { message(error, "门店状态更新失败"); } }

function openStaff(row?: StaffItem) { Object.assign(staffForm, row ? { id: row.id, store_id: row.store_id, uid: row.uid, staff_name: row.staff_name, phone: row.phone, avatar: row.avatar, verify_status: row.verify_status, status: row.status } : { id: 0, store_id: staffStoreId.value ?? storeOptions.value[0]?.id ?? 0, uid: 1, staff_name: "", phone: "", avatar: "", verify_status: 1, status: 1 }); staffDialog.value = true; }
async function saveStaff() { saving.value = true; try { await apiStaffSave(staffForm.id, { ...staffForm }); ElMessage.success("店员已保存"); staffDialog.value = false; await loadStaff(staffPage.value); } catch (error) { message(error, "店员保存失败"); } finally { saving.value = false; } }
async function setStaffStatus(row: StaffItem, status: number) { try { await apiStaffStatus(row.id, status); row.status = status; } catch (error) { message(error, "状态更新失败"); } }
function setStaffStatusValue(row: StaffItem, value: string | number | boolean) { void setStaffStatus(row, Number(value)); }
async function removeStaff(row: StaffItem) { try { await ElMessageBox.confirm(`删除店员“${row.staff_name}”？`, "谨慎操作", { type: "warning" }); } catch { return; } try { await apiStaffDelete(row.id); await loadStaff(staffPage.value); } catch (error) { message(error, "删除失败"); } }

function openDelivery(row?: DeliveryItem) { Object.assign(deliveryForm, row ? { id: row.id, uid: row.uid, nickname: row.wx_name || row.nickname, phone: row.phone, avatar: row.avatar, status: row.status } : { id: 0, uid: 1, nickname: "", phone: "", avatar: "", status: 1 }); deliveryDialog.value = true; }
async function saveDelivery() { saving.value = true; try { const payload: Record<string, unknown> = { uid: deliveryForm.uid, status: deliveryForm.status }; if (deliveryForm.nickname) payload.nickname = deliveryForm.nickname; if (deliveryForm.phone) payload.phone = deliveryForm.phone; if (deliveryForm.avatar) payload.avatar = deliveryForm.avatar; await apiDeliverySave(deliveryForm.id, payload); ElMessage.success("配送员已保存"); deliveryDialog.value = false; await loadDelivery(deliveryPage.value); } catch (error) { message(error, "配送员保存失败"); } finally { saving.value = false; } }
async function setDeliveryStatus(row: DeliveryItem, status: number) { try { await apiDeliveryStatus(row.id, status); row.status = status; } catch (error) { message(error, "状态更新失败"); } }
function setDeliveryStatusValue(row: DeliveryItem, value: string | number | boolean) { void setDeliveryStatus(row, Number(value)); }
async function removeDelivery(row: DeliveryItem) { try { await ElMessageBox.confirm(`删除配送员“${row.wx_name || row.nickname}”？`, "谨慎操作", { type: "warning" }); } catch { return; } try { await apiDeliveryDelete(row.id); await loadDelivery(deliveryPage.value); } catch (error) { message(error, "删除失败"); } }
function tabChanged(name: string | number) { if (name === "staff") void loadStaff(1); if (name === "delivery") void loadDelivery(1); }
onMounted(async () => { await Promise.all([loadStores(1), loadDelivery(1), refreshHeader(), refreshOptions()]); });
</script>

<style scoped>
.store-operations { display: flex; flex-direction: column; gap: 16px; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(140px, 1fr)); gap: 12px; }
.summary-grid :deep(.el-card__body) { display: flex; flex-direction: column; gap: 8px; }
.summary-grid span { color: #64748b; font-size: 13px; }.summary-grid strong { color: #0f172a; font-size: 25px; }
.content-card { background: #fff; border-radius: 8px; padding: 8px 18px 18px; }
.toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin: 8px 0 16px; }
.keyword { width: 260px; }.short-select { width: 180px; }.pager { justify-content: flex-end; margin-top: 16px; }
.muted { color: #8a94a5; font-size: 12px; margin-top: 4px; }.spaced-table { margin-top: 14px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 16px; }.form-grid .full { grid-column: 1 / -1; }.suffix { margin-left: 6px; color: #64748b; }
@media (max-width: 820px) {
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .form-grid { grid-template-columns: 1fr; }
  .form-grid .full { grid-column: auto; }
  .keyword, .short-select { width: 100%; }
  :deep(.operations-dialog) {
    width: calc(100vw - 24px) !important;
    max-height: calc(100vh - 24px);
    margin: 12px auto !important;
    display: flex;
    flex-direction: column;
  }
  :deep(.operations-dialog .el-dialog__body) {
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }
}
</style>
