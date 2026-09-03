<template>
  <div class="live-page">
    <header class="page-head">
      <div>
        <p class="eyebrow">WECHAT MINI PROGRAM</p>
        <h2>小程序直播目录</h2>
        <p>管理本地直播目录，并通过队列只读同步微信状态。</p>
      </div>
      <el-button type="primary" :loading="syncing" @click="syncStatus">同步微信状态</el-button>
    </header>

    <el-alert
      title="微信远程写操作仍受保护"
      description="本页已支持本地显示、详情、删除及主播资料管理；创建微信直播间、提交或删除微信商品等远程非幂等操作尚未迁移，需先建立耐久 outbox。"
      type="warning"
      show-icon
      :closable="false"
    />

    <section class="summary-grid" aria-label="直播目录概览">
      <article><span>直播间</span><strong>{{ counts.rooms }}</strong><small>本地目录</small></article>
      <article><span>直播商品</span><strong>{{ counts.goods }}</strong><small>审核通过可本地展示</small></article>
      <article><span>主播</span><strong>{{ counts.anchors }}</strong><small>本地管理 + 角色同步</small></article>
      <article class="boundary"><span>运行边界</span><strong>本地管理 + 只读同步</strong><small>无微信资源写入</small></article>
    </section>

    <el-card shadow="never" class="catalog-card">
      <el-tabs v-model="activeTab" @tab-change="changeTab">
        <el-tab-pane label="直播间" name="rooms" />
        <el-tab-pane label="直播商品" name="goods" />
        <el-tab-pane label="主播" name="anchors" />
      </el-tabs>

      <div class="toolbar">
        <div>
          <strong>{{ tabTitle }}</strong>
          <p>{{ tabNote }}</p>
        </div>
        <div class="filters">
          <el-button v-if="activeTab === 'anchors'" type="primary" plain @click="openAnchor(0)">新增主播</el-button>
          <el-select v-if="activeTab === 'rooms'" v-model="roomStatus" aria-label="筛选直播状态" @change="resetAndLoad">
            <el-option label="全部状态" :value="0" />
            <el-option label="直播中" :value="1" />
            <el-option label="未开始" :value="2" />
            <el-option label="已结束" :value="3" />
          </el-select>
          <el-select v-if="activeTab === 'goods'" v-model="goodsStatus" aria-label="筛选审核状态" @change="resetAndLoad">
            <el-option label="全部审核状态" :value="99" />
            <el-option label="审核通过" :value="1" />
            <el-option label="审核中" :value="0" />
            <el-option label="审核失败" :value="-1" />
          </el-select>
          <el-input v-model="keyword" clearable :placeholder="searchPlaceholder" aria-label="搜索直播目录" @clear="resetAndLoad" @keyup.enter="resetAndLoad">
            <template #append><el-button @click="resetAndLoad">查询</el-button></template>
          </el-input>
        </div>
      </div>

      <div class="desktop-table">
        <el-table v-if="activeTab === 'rooms'" :data="rooms" v-loading="loading" stripe row-key="id" empty-text="暂无直播间">
          <el-table-column label="直播间" min-width="260">
            <template #default="{ row }"><strong>{{ row.name }}</strong><div class="sub-text mono">room_id: {{ row.room_id || '-' }}</div></template>
          </el-table-column>
          <el-table-column label="主播" min-width="170"><template #default="{ row }">{{ row.anchor_name || '-' }}<div class="sub-text">{{ row.anchor_wechat || '-' }}</div></template></el-table-column>
          <el-table-column label="状态" width="120"><template #default="{ row }"><el-tag :type="roomTone(row.live_status)">{{ roomStatusText(row.live_status) }}</el-tag></template></el-table-column>
          <el-table-column label="开播时间" min-width="180"><template #default="{ row }">{{ formatTime(row.start_time) }}</template></el-table-column>
          <el-table-column label="展示" width="90"><template #default="{ row }"><el-tag :type="row.is_show ? 'success' : 'info'" effect="plain">{{ row.is_show ? '展示' : '隐藏' }}</el-tag></template></el-table-column>
          <el-table-column label="操作" width="190" fixed="right"><template #default="{ row }"><div class="row-actions"><el-button link type="primary" @click="openRoomDetail(row.id)">详情</el-button><el-button link type="primary" :loading="operationBusy === `room:${row.id}:show`" @click="toggleRoom(row)">{{ row.is_show ? '隐藏' : '显示' }}</el-button><el-button link type="danger" :loading="operationBusy === `room:${row.id}:delete`" @click="deleteRoom(row)">删除</el-button></div></template></el-table-column>
        </el-table>

        <el-table v-else-if="activeTab === 'goods'" :data="goods" v-loading="loading" stripe row-key="id" empty-text="暂无直播商品">
          <el-table-column label="商品" min-width="260"><template #default="{ row }"><strong>{{ row.name }}</strong><div class="sub-text mono">product_id: {{ row.product_id }} · goods_id: {{ row.goods_id || '-' }}</div></template></el-table-column>
          <el-table-column label="直播价" width="145"><template #default="{ row }">¥{{ row.price }}<div v-if="row.price_type === 2" class="sub-text">至 ¥{{ row.price2 }}</div></template></el-table-column>
          <el-table-column label="审核" width="120"><template #default="{ row }"><el-tag :type="goodsTone(row.audit_status)">{{ goodsStatusText(row.audit_status) }}</el-tag></template></el-table-column>
          <el-table-column label="本地展示" width="105"><template #default="{ row }"><el-tag :type="row.is_show ? 'success' : 'info'" effect="plain">{{ row.is_show ? '展示' : '隐藏' }}</el-tag></template></el-table-column>
          <el-table-column label="加入时间" min-width="180"><template #default="{ row }">{{ formatTime(row.add_time) }}</template></el-table-column>
          <el-table-column label="操作" width="150" fixed="right"><template #default="{ row }"><div class="row-actions"><el-button link type="primary" @click="openGoodsDetail(row.id)">详情</el-button><el-button link type="primary" :disabled="row.audit_status !== 2" :loading="operationBusy === `goods:${row.id}:show`" @click="toggleGoods(row)">{{ row.is_show ? '隐藏' : '显示' }}</el-button></div></template></el-table-column>
        </el-table>

        <el-table v-else :data="anchors" v-loading="loading" stripe row-key="id" empty-text="暂无主播">
          <el-table-column label="主播" min-width="220"><template #default="{ row }"><strong>{{ row.name }}</strong><div class="sub-text mono">#{{ row.id }}</div></template></el-table-column>
          <el-table-column prop="wechat" label="微信号" min-width="190" />
          <el-table-column prop="phone" label="手机号" min-width="160" />
          <el-table-column label="展示" width="100"><template #default="{ row }"><el-tag :type="row.is_show ? 'success' : 'info'">{{ row.is_show ? '已启用' : '已停用' }}</el-tag></template></el-table-column>
          <el-table-column label="创建时间" min-width="180"><template #default="{ row }">{{ formatTime(row.add_time) }}</template></el-table-column>
          <el-table-column label="操作" width="220" fixed="right"><template #default="{ row }"><div class="row-actions"><el-button link type="primary" @click="openAnchor(row.id)">编辑</el-button><el-button link type="primary" :loading="operationBusy === `anchor:${row.id}:show`" @click="toggleAnchor(row)">{{ row.is_show ? '停用' : '启用' }}</el-button><el-button link type="danger" :loading="operationBusy === `anchor:${row.id}:delete`" @click="deleteAnchor(row)">删除</el-button></div></template></el-table-column>
        </el-table>
      </div>

      <div class="mobile-list" v-loading="loading">
        <article v-for="row in mobileRows" :key="`${activeTab}-${row.id}`" class="mobile-card">
          <div class="mobile-title">
            <div><strong>{{ rowTitle(row) }}</strong><span class="mono">{{ rowIdentity(row) }}</span></div>
            <el-tag :type="rowTone(row)">{{ rowState(row) }}</el-tag>
          </div>
          <p>{{ rowDetail(row) }}</p>
          <small>{{ formatTime(rowTimestamp(row)) }}</small>
          <div class="mobile-actions">
            <template v-if="isRoom(row)"><el-button size="small" @click="openRoomDetail(row.id)">详情</el-button><el-button size="small" @click="toggleRoom(row)">{{ row.is_show ? '隐藏' : '显示' }}</el-button><el-button size="small" type="danger" plain @click="deleteRoom(row)">删除</el-button></template>
            <template v-else-if="isGood(row)"><el-button size="small" @click="openGoodsDetail(row.id)">详情</el-button><el-button size="small" :disabled="row.audit_status !== 2" @click="toggleGoods(row)">{{ row.is_show ? '隐藏' : '显示' }}</el-button></template>
            <template v-else><el-button size="small" @click="openAnchor(row.id)">编辑</el-button><el-button size="small" @click="toggleAnchor(row)">{{ row.is_show ? '停用' : '启用' }}</el-button><el-button size="small" type="danger" plain @click="deleteAnchor(row)">删除</el-button></template>
          </div>
        </article>
        <el-empty v-if="!mobileRows.length && !loading" description="暂无数据" />
      </div>

      <el-pagination class="pager" background layout="prev, pager, next" :current-page="page" :page-size="20" :total="activeCount" @current-change="changePage" />
    </el-card>

    <el-dialog v-model="roomDialog" title="直播间详情" width="min(620px, 92vw)">
      <div v-loading="detailLoading">
        <el-descriptions v-if="roomDetail" :column="1" border>
          <el-descriptions-item label="直播间">{{ roomDetail.name }}</el-descriptions-item>
          <el-descriptions-item label="微信 room_id">{{ roomDetail.room_id || '-' }}</el-descriptions-item>
          <el-descriptions-item label="主播">{{ roomDetail.anchor_name || '-' }} · {{ roomDetail.anchor_wechat || '-' }}</el-descriptions-item>
          <el-descriptions-item label="时间">{{ formatTime(roomDetail.start_time) }} — {{ formatTime(roomDetail.end_time) }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ roomStatusText(roomDetail.live_status) }} · {{ roomDetail.is_show ? '本地展示' : '本地隐藏' }}</el-descriptions-item>
        </el-descriptions>
      </div>
    </el-dialog>

    <el-dialog v-model="goodsDialog" title="直播商品详情" width="min(620px, 92vw)">
      <div v-loading="detailLoading">
        <el-descriptions v-if="goodsDetail" :column="1" border>
          <el-descriptions-item label="商品">{{ goodsDetail.name }}</el-descriptions-item>
          <el-descriptions-item label="平台商品 ID">{{ goodsDetail.product_id }}</el-descriptions-item>
          <el-descriptions-item label="微信 goods_id">{{ goodsDetail.goods_id || '-' }}</el-descriptions-item>
          <el-descriptions-item label="价格">¥{{ goodsDetail.price }}<span v-if="goodsDetail.price_type === 2"> — ¥{{ goodsDetail.price2 }}</span></el-descriptions-item>
          <el-descriptions-item label="状态">{{ goodsStatusText(goodsDetail.audit_status) }} · {{ goodsDetail.is_show ? '本地展示' : '本地隐藏' }}</el-descriptions-item>
        </el-descriptions>
      </div>
    </el-dialog>

    <el-dialog v-model="anchorDialog" :title="anchorForm.id ? '编辑主播' : '新增主播'" width="min(560px, 92vw)" :close-on-click-modal="false">
      <el-form label-position="top" @submit.prevent="saveAnchor">
        <el-form-item label="主播名称" required><el-input v-model="anchorForm.name" maxlength="20" show-word-limit /></el-form-item>
        <el-form-item label="主播微信号" required><el-input v-model="anchorForm.wechat" maxlength="32" show-word-limit /></el-form-item>
        <el-form-item label="手机号" required><el-input v-model="anchorForm.phone" maxlength="20" /></el-form-item>
        <el-form-item label="主播图像路径" required><el-input v-model="anchorForm.cover_img" maxlength="255" placeholder="HTTPS 地址或站内 /uploads/... 路径" /></el-form-item>
      </el-form>
      <el-alert title="保存前会只读核对小程序主播身份；不会修改微信侧角色。" type="info" :closable="false" show-icon />
      <template #footer><el-button @click="anchorDialog = false">取消</el-button><el-button type="primary" :loading="anchorSaving" @click="saveAnchor">保存并核验</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiWechatLiveAnchorDelete,
  apiWechatLiveAnchorForm,
  apiWechatLiveAnchorSave,
  apiWechatLiveAnchors,
  apiWechatLiveAnchorShow,
  apiWechatLiveGoods,
  apiWechatLiveGoodsDetail,
  apiWechatLiveGoodsShow,
  apiWechatLiveRoomDelete,
  apiWechatLiveRoomDetail,
  apiWechatLiveRooms,
  apiWechatLiveRoomShow,
  apiWechatLiveSync,
  type WechatLiveAnchor,
  type WechatLiveAnchorInput,
  type WechatLiveGood,
  type WechatLiveRoom,
} from "@/api/wechatLive";

type TabName = "rooms" | "goods" | "anchors";
type CatalogRow = WechatLiveRoom | WechatLiveGood | WechatLiveAnchor;

const activeTab = ref<TabName>("rooms");
const keyword = ref("");
const roomStatus = ref(0);
const goodsStatus = ref(99);
const page = ref(1);
const loading = ref(false);
const syncing = ref(false);
const detailLoading = ref(false);
const operationBusy = ref("");
const rooms = ref<WechatLiveRoom[]>([]);
const goods = ref<WechatLiveGood[]>([]);
const anchors = ref<WechatLiveAnchor[]>([]);
const counts = reactive({ rooms: 0, goods: 0, anchors: 0 });
const roomDialog = ref(false);
const goodsDialog = ref(false);
const anchorDialog = ref(false);
const anchorSaving = ref(false);
const roomDetail = ref<WechatLiveRoom | null>(null);
const goodsDetail = ref<WechatLiveGood | null>(null);
const anchorForm = reactive<WechatLiveAnchorInput>({ id: 0, name: "", wechat: "", phone: "", cover_img: "" });

const tabTitle = computed(() => ({ rooms: "直播间状态", goods: "直播商品审核", anchors: "主播资料" })[activeTab.value]);
const tabNote = computed(() => ({ rooms: "可查看详情、切换本地展示或本地删除；状态由队列从微信读取。", goods: "审核状态只读同步；审核通过后可切换本地展示。", anchors: "支持本地资料管理，并只读核对、同步微信主播角色。" })[activeTab.value]);
const searchPlaceholder = computed(() => ({ rooms: "名称、主播或微信号", goods: "名称、商品 ID", anchors: "姓名、微信号或手机号" })[activeTab.value]);
const activeCount = computed(() => counts[activeTab.value]);
const mobileRows = computed<CatalogRow[]>(() => ({ rooms: rooms.value, goods: goods.value, anchors: anchors.value })[activeTab.value]);

function formatTime(timestamp: number) {
  return timestamp ? new Date(timestamp * 1000).toLocaleString("zh-CN", { hour12: false }) : "-";
}

function roomStatusText(status: number) {
  if ([101, 105, 106].includes(status)) return "直播中";
  if (status === 102) return "未开始";
  if ([103, 104, 107].includes(status)) return "已结束";
  return `未知 ${status}`;
}

function roomTone(status: number): "danger" | "warning" | "info" {
  if ([101, 105, 106].includes(status)) return "danger";
  if (status === 102) return "warning";
  return "info";
}

function goodsStatusText(status: number) {
  if (status === 2) return "审核通过";
  if (status === 3) return "审核失败";
  return "审核中";
}

function goodsTone(status: number): "success" | "danger" | "warning" {
  if (status === 2) return "success";
  if (status === 3) return "danger";
  return "warning";
}

function isRoom(row: CatalogRow): row is WechatLiveRoom { return "room_id" in row; }
function isGood(row: CatalogRow): row is WechatLiveGood { return "goods_id" in row; }
function rowTitle(row: CatalogRow) { return row.name || `#${row.id}`; }
function rowIdentity(row: CatalogRow) {
  if (isRoom(row)) return `room_id: ${row.room_id || "-"}`;
  if (isGood(row)) return `product_id: ${row.product_id}`;
  return row.wechat || `#${row.id}`;
}
function rowState(row: CatalogRow) {
  if (isRoom(row)) return roomStatusText(row.live_status);
  if (isGood(row)) return goodsStatusText(row.audit_status);
  return row.is_show ? "已启用" : "已停用";
}
function rowTone(row: CatalogRow): "success" | "danger" | "warning" | "info" {
  if (isRoom(row)) return roomTone(row.live_status);
  if (isGood(row)) return goodsTone(row.audit_status);
  return row.is_show ? "success" : "info";
}
function rowDetail(row: CatalogRow) {
  if (isRoom(row)) return `主播 ${row.anchor_name || "-"} · ${row.anchor_wechat || "未绑定微信号"}`;
  if (isGood(row)) return `直播价 ¥${row.price}${row.price_type === 2 ? ` - ¥${row.price2}` : ""}`;
  return `${row.phone || "未登记手机号"} · ${row.is_show ? "本地展示" : "本地隐藏"}`;
}
function rowTimestamp(row: CatalogRow) { return isRoom(row) ? row.start_time : row.add_time; }

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function openRoomDetail(id: number) {
  roomDialog.value = true;
  roomDetail.value = null;
  detailLoading.value = true;
  try { roomDetail.value = await apiWechatLiveRoomDetail(id); }
  catch (error) { roomDialog.value = false; ElMessage.error(errorText(error, "直播间详情加载失败")); }
  finally { detailLoading.value = false; }
}

async function openGoodsDetail(id: number) {
  goodsDialog.value = true;
  goodsDetail.value = null;
  detailLoading.value = true;
  try { goodsDetail.value = await apiWechatLiveGoodsDetail(id); }
  catch (error) { goodsDialog.value = false; ElMessage.error(errorText(error, "直播商品详情加载失败")); }
  finally { detailLoading.value = false; }
}

async function toggleRoom(row: WechatLiveRoom) {
  const next = row.is_show ? 0 : 1;
  operationBusy.value = `room:${row.id}:show`;
  try {
    const result = await apiWechatLiveRoomShow(row.id, next);
    Object.assign(row, result.room);
    ElMessage.success(next ? "直播间已本地显示" : "直播间已本地隐藏");
  } catch (error) { ElMessage.error(errorText(error, "直播间状态更新失败")); }
  finally { operationBusy.value = ""; }
}

async function deleteRoom(row: WechatLiveRoom) {
  try {
    await ElMessageBox.confirm(`仅删除本地直播间“${row.name}”及其商品关系，不会删除微信直播间。`, "确认本地删除", { type: "warning", confirmButtonText: "本地删除" });
    operationBusy.value = `room:${row.id}:delete`;
    await apiWechatLiveRoomDelete(row.id);
    await Promise.all([loadActive(), loadCounts()]);
    ElMessage.success("直播间已本地删除");
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(errorText(error, "直播间删除失败"));
  } finally { operationBusy.value = ""; }
}

async function toggleGoods(row: WechatLiveGood) {
  if (row.audit_status !== 2) return;
  const next = row.is_show ? 0 : 1;
  operationBusy.value = `goods:${row.id}:show`;
  try {
    const result = await apiWechatLiveGoodsShow(row.id, next);
    Object.assign(row, result.goods);
    ElMessage.success(next ? "直播商品已本地显示" : "直播商品已本地隐藏");
  } catch (error) { ElMessage.error(errorText(error, "直播商品状态更新失败")); }
  finally { operationBusy.value = ""; }
}

async function openAnchor(id: number) {
  try {
    const row = await apiWechatLiveAnchorForm(id);
    Object.assign(anchorForm, {
      id: row.id,
      name: row.name,
      wechat: row.wechat,
      phone: row.phone,
      cover_img: row.cover_img,
    });
    anchorDialog.value = true;
  } catch (error) { ElMessage.error(errorText(error, "主播资料加载失败")); }
}

async function saveAnchor() {
  if (!anchorForm.name.trim() || !anchorForm.wechat.trim() || !anchorForm.phone.trim() || !anchorForm.cover_img.trim()) {
    ElMessage.warning("请完整填写主播名称、微信号、手机号和图像路径");
    return;
  }
  if (!/^1[3-9]\d{9}$/.test(anchorForm.phone.trim())) {
    ElMessage.warning("请输入正确的中国大陆手机号");
    return;
  }
  anchorSaving.value = true;
  try {
    await apiWechatLiveAnchorSave({
      id: anchorForm.id,
      name: anchorForm.name.trim(),
      wechat: anchorForm.wechat.trim(),
      phone: anchorForm.phone.trim(),
      cover_img: anchorForm.cover_img.trim(),
    });
    anchorDialog.value = false;
    await Promise.all([loadActive(), loadCounts()]);
    ElMessage.success("主播已保存并核验身份");
  } catch (error) { ElMessage.error(errorText(error, "主播保存失败")); }
  finally { anchorSaving.value = false; }
}

async function toggleAnchor(row: WechatLiveAnchor) {
  const next = row.is_show ? 0 : 1;
  operationBusy.value = `anchor:${row.id}:show`;
  try {
    const result = await apiWechatLiveAnchorShow(row.id, next);
    Object.assign(row, result.anchor);
    ElMessage.success(next ? "主播已本地启用" : "主播已本地停用");
  } catch (error) { ElMessage.error(errorText(error, "主播状态更新失败")); }
  finally { operationBusy.value = ""; }
}

async function deleteAnchor(row: WechatLiveAnchor) {
  try {
    await ElMessageBox.confirm(`删除本地主播“${row.name}”？仍有关联直播间时服务端会拒绝。`, "确认删除", { type: "warning", confirmButtonText: "删除" });
    operationBusy.value = `anchor:${row.id}:delete`;
    await apiWechatLiveAnchorDelete(row.id);
    await Promise.all([loadActive(), loadCounts()]);
    ElMessage.success("主播已本地删除");
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(errorText(error, "主播删除失败"));
  } finally { operationBusy.value = ""; }
}

async function loadActive() {
  loading.value = true;
  try {
    const base = { page: page.value, limit: 20, keyword: keyword.value || undefined };
    if (activeTab.value === "rooms") {
      const result = await apiWechatLiveRooms({ ...base, status: roomStatus.value });
      rooms.value = result.list; counts.rooms = result.count;
    } else if (activeTab.value === "goods") {
      const result = await apiWechatLiveGoods({ ...base, status: goodsStatus.value });
      goods.value = result.list; counts.goods = result.count;
    } else {
      const result = await apiWechatLiveAnchors(base);
      anchors.value = result.list; counts.anchors = result.count;
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "直播目录加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadCounts() {
  const [roomResult, goodsResult, anchorResult] = await Promise.all([
    apiWechatLiveRooms({ page: 1, limit: 1, status: 0 }),
    apiWechatLiveGoods({ page: 1, limit: 1, status: 99 }),
    apiWechatLiveAnchors({ page: 1, limit: 1 }),
  ]);
  counts.rooms = roomResult.count; counts.goods = goodsResult.count; counts.anchors = anchorResult.count;
}

async function changeTab(name: string | number) { activeTab.value = String(name) as TabName; page.value = 1; keyword.value = ""; await loadActive(); }
async function resetAndLoad() { page.value = 1; await loadActive(); }
async function changePage(next: number) { page.value = next; await loadActive(); }

async function syncStatus() {
  syncing.value = true;
  try {
    const result = await apiWechatLiveSync();
    ElMessage.success(`已排队 ${result.jobs.length} 个只读同步任务`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "状态同步入队失败");
  } finally {
    syncing.value = false;
  }
}

onMounted(async () => {
  try { await loadCounts(); } catch { /* 当前标签仍会给出明确错误 */ }
  await loadActive();
});
</script>

<style scoped>
.live-page { display: grid; gap: 16px; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 24px; border: 1px solid #e5e9f0; border-radius: 14px; background: linear-gradient(135deg, #fff 0%, #f2f8ff 100%); }
.page-head h2 { margin: 2px 0 8px; color: #172033; font-size: 24px; }
.page-head p { margin: 0; color: #6f7a8e; }
.eyebrow { color: #2f70d0 !important; font-size: 11px; font-weight: 700; letter-spacing: .14em; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.summary-grid article { display: grid; gap: 5px; padding: 18px; border: 1px solid #e7eaf0; border-radius: 12px; background: #fff; }
.summary-grid span, .summary-grid small { color: #7d8799; }
.summary-grid strong { color: #1d2a3f; font-size: 25px; }
.summary-grid .boundary { background: #172c4a; border-color: #172c4a; }
.summary-grid .boundary span, .summary-grid .boundary small { color: #b8c7dd; }
.summary-grid .boundary strong { color: #fff; font-size: 18px; }
.catalog-card { border-radius: 12px; }
.toolbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.toolbar p { margin: 6px 0 0; color: #8791a3; font-size: 12px; }
.filters { display: flex; gap: 10px; }
.filters .el-select { width: 160px; }
.filters .el-input { width: 300px; }
.sub-text { margin-top: 5px; color: #8a94a5; font-size: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.row-actions { display: flex; align-items: center; white-space: nowrap; }
.pager { justify-content: flex-end; margin-top: 18px; }
.mobile-list { display: none; }
@media (max-width: 1100px) {
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .toolbar { flex-direction: column; }
  .filters, .filters .el-input { width: 100%; }
}
@media (max-width: 720px) {
  .page-head { flex-direction: column; padding: 18px; }
  .page-head .el-button { width: 100%; }
  .summary-grid { gap: 8px; }
  .summary-grid article { padding: 13px; }
  .summary-grid strong { font-size: 21px; }
  .summary-grid .boundary strong { font-size: 15px; }
  .filters { flex-direction: column; }
  .filters .el-select { width: 100%; }
  .desktop-table { display: none; }
  .mobile-list { display: grid; gap: 10px; min-height: 80px; }
  .mobile-card { padding: 14px; border: 1px solid #e7eaf0; border-radius: 10px; background: #fff; }
  .mobile-card p { margin: 10px 0; color: #6f7a8e; font-size: 12px; line-height: 1.55; }
  .mobile-card small { color: #99a2b2; }
  .mobile-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; padding-top: 12px; border-top: 1px solid #edf0f5; }
  .mobile-actions .el-button { margin-left: 0; }
  .mobile-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
  .mobile-title strong, .mobile-title span { display: block; }
  .mobile-title span { margin-top: 4px; color: #8a94a5; font-size: 11px; }
  .pager { justify-content: center; }
}
</style>
