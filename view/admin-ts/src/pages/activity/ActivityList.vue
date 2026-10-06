<template>
  <div class="activity-page">
    <div class="page-head">
      <h2>营销活动</h2>
      <div v-if="activeTab !== 'discounts' && canView" class="head-actions">
        <el-tag type="success">{{ loading ? '加载中' : listError ? '加载失败' : `共 ${count} 个活动` }}</el-tag>
        <el-button v-if="canManage" type="primary" size="small" @click="openForm()">＋ 新增活动</el-button>
        <el-button v-if="activeTab === 'integral' && canIntegralBatch" type="primary" plain size="small" @click="router.push('/activity/integral-batch')">批量添加积分商品</el-button>
      </div>
    </div>

    <!-- Tab 切换 -->
    <el-tabs v-model="activeTab">
      <el-tab-pane label="秒杀" name="seckill" />
      <el-tab-pane label="拼团" name="combination" />
      <el-tab-pane label="砍价" name="bargain" />
      <el-tab-pane label="积分商城" name="integral" />
      <el-tab-pane label="优惠套餐" name="discounts" />
    </el-tabs>

    <DiscountPackageManager v-if="activeTab === 'discounts'" />
    <el-alert v-else-if="!canView" title="当前账号没有营销活动查看权限" type="warning" :closable="false" show-icon />
    <template v-else>
    <div class="filters">
      <label class="filter-field">
        <span>活动名称</span>
        <el-input v-model="draftKeyword" aria-label="活动名称" maxlength="100" clearable placeholder="输入活动名称关键词" @keyup.enter="search" />
      </label>
      <label class="filter-field status-field">
        <span>活动状态</span>
        <el-select v-model="draftStatus" aria-label="活动状态" clearable placeholder="全部状态">
          <el-option label="启用" :value="1" /><el-option label="停用" :value="0" />
        </el-select>
      </label>
      <div class="filter-actions">
        <el-button type="primary" @click="search">查询</el-button>
        <el-button @click="reset">重置</el-button>
      </div>
    </div>
    <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon class="list-error">
      <template #default><el-button link type="primary" @click="load()">重试列表</el-button></template>
    </el-alert>
    <div v-else class="table-scroll">
    <el-table :data="list" v-loading="loading" border row-key="id" :empty-text="loading ? '加载中…' : '暂无活动数据'">
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column prop="storeName" label="活动名称" min-width="180" />
      <el-table-column label="价格" width="110">
        <template #default="{ row }">
          ¥{{ row.price }}<span v-if="row.otPrice" class="ot-price"> / {{ row.otPrice }}</span>
        </template>
      </el-table-column>
      <el-table-column label="积分" width="90" v-if="activeTab === 'integral'">
        <template #default="{ row }">{{ row.integral }}</template>
      </el-table-column>
      <el-table-column label="库存" width="90" prop="stock" />
      <el-table-column label="销量" width="90" prop="sales" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 1 ? 'success' : 'info'">
            {{ row.status === 1 ? "启用" : "停用" }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="220">
        <template #default="{ row }">
          <el-button
            v-if="activeTab === 'seckill' && canSeckillStatistics"
            link
            type="primary"
            @click="openSeckillStatistics(row)"
          >
            统计
          </el-button>
          <el-button
            v-if="activeTab === 'combination'"
            link
            type="primary"
            @click="showPinks(row)"
          >
            团列表
          </el-button>
          <el-button
            v-if="activeTab === 'bargain'"
            link
            type="primary"
            @click="showBargainUsers(row)"
          >
            明细
          </el-button>
          <el-button v-if="canManage" link type="primary" @click="openForm(row)">编辑</el-button>
          <el-button v-if="canManage" link :type="row.status === 1 ? 'warning' : 'success'" @click="toggleStatus(row)">
            {{ row.status === 1 ? "停用" : "启用" }}
          </el-button>
          <el-button v-if="canManage" link type="danger" @click="del(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    </div>
    <el-pagination v-if="!listError && !loading" :current-page="page" :page-size="PAGE_SIZE" :total="count"
      :page-count="Math.min(Math.max(1, Math.ceil(count / PAGE_SIZE)), MAX_PAGE)" :pager-count="5"
      :disabled="loading" layout="total, prev, pager, next" class="pager" @current-change="load" />
    <p v-if="count > MAX_PAGE * PAGE_SIZE" class="time-hint">可浏览前 {{ MAX_PAGE * PAGE_SIZE }} 项，请使用名称或状态筛选缩小范围。</p>

    <!-- 活动创建/编辑弹窗 -->
    <el-dialog v-model="formVisible" :title="form.id ? '编辑活动' : '新增活动'" width="min(560px, calc(100vw - 24px))" top="5vh" :style="{ maxHeight: '90vh', overflowY: 'auto' }">
      <div v-if="formError" ref="formErrorElement">
        <el-alert :title="formError" type="error" :closable="false" show-icon class="form-error" />
      </div>
      <el-form :model="form" label-width="100px">
        <el-form-item label="商品ID" required>
          <el-input-number v-model="form.productId" :min="1" :disabled="formType === 'bargain' && !!form.id" />
        </el-form-item>
        <template v-if="formType === 'bargain'">
          <el-form-item label="活动规格" required>
            <el-button :loading="skuLoading" @click="loadBargainSkus">加载商品规格</el-button>
            <el-select v-model="selectedBaseUnique" placeholder="选择一个原商品规格" style="width:100%; margin-top:8px" @change="selectBargainSku">
              <el-option v-for="sku in skuOptions?.options ?? []" :key="sku.id" :value="sku.unique" :label="`${sku.suk || '默认规格'}（库存 ${sku.stock}）`" />
            </el-select>
          </el-form-item>
          <p class="time-hint">新活动必须选择一个原商品规格；已有规格身份不可替换。仅改名不会重写规格库存。</p>
          <fieldset class="shipping-fields" :disabled="shippingProductId !== form.productId || !skuOptions?.shipping">
            <legend>配送与运费</legend>
            <p v-if="shippingProductId !== form.productId || !skuOptions?.shipping" class="time-hint">请先加载商品规格，以读取配送规则和可用模板。</p>
            <el-form-item label="配送方式">
              <el-checkbox-group v-model="shipping.methods" :disabled="skuOptions?.shipping?.productType !== 0">
                <el-checkbox value="1">快递</el-checkbox><el-checkbox value="2">到店自提</el-checkbox><el-checkbox value="3">门店配送</el-checkbox>
              </el-checkbox-group>
            </el-form-item>
            <p v-if="originalShipping?.deliveryType === ''" class="time-hint">旧活动未限定配送方式；不修改此组配置会保留原规则。</p>
            <p v-if="skuOptions?.shipping && skuOptions.shipping.productType !== 0" class="time-hint">非实物商品按原商品类型继承配送规则。类型1/2/3不收物流运费。</p>
            <el-form-item label="运费方式">
              <el-select v-model="shipping.freight" aria-label="运费方式" :disabled="[1,2,3].includes(skuOptions?.shipping?.productType ?? -1)" style="width:100%">
                <el-option :value="1" label="包邮" /><el-option :value="2" label="固定运费" /><el-option :value="3" label="运费模板" />
              </el-select>
            </el-form-item>
            <el-form-item v-if="shipping.freight === 2 && ![1,2,3].includes(skuOptions?.shipping?.productType ?? -1)" label="固定运费">
              <el-input v-model="shipping.postage" placeholder="元，例如 8.50" inputmode="decimal" />
            </el-form-item>
            <el-form-item v-if="shipping.freight === 3" label="运费模板">
              <el-select v-model="shipping.tempId" aria-label="运费模板" placeholder="选择所属方的可用模板" style="width:100%">
                <el-option v-for="item in skuOptions?.shipping?.templates ?? []" :key="item.id" :value="item.id" :label="item.name" />
              </el-select>
            </el-form-item>
            <p class="time-hint">配送仍受门店及结算端开关约束；这里不启用门店或修改模板内容。</p>
          </fieldset>
        </template>
        <el-form-item label="活动名称" required>
          <el-input v-model="form.storeName" placeholder="如: 夏季促销商品" />
        </el-form-item>
        <el-form-item label="图片URL" v-if="formType !== 'bargain'">
          <el-input v-model="form.image" placeholder="商品图 URL" />
        </el-form-item>
        <template v-if="formType === 'bargain'">
          <p v-if="!contentReady" class="time-hint">正在等待活动内容加载；可点击“加载商品规格”重试。</p>
          <el-form-item label="展示标题"><el-input v-model="content.title" :disabled="!contentReady" maxlength="255" placeholder="留空使用活动名称" /></el-form-item>
          <el-form-item label="活动简介"><el-input v-model="content.info" :disabled="!contentReady" maxlength="255" /></el-form-item>
          <el-form-item label="商品单位"><el-input v-model="content.unitName" :disabled="!contentReady" maxlength="16" placeholder="如：件、盒" /></el-form-item>
          <el-form-item label="轮播图URL"><el-input v-model="content.imageLines" :disabled="!contentReady" type="textarea" :rows="3" placeholder="每行一张，最多8张；首张为主图。HTTPS或站内绝对路径。" /></el-form-item>
          <el-form-item label="活动描述HTML"><el-input v-model="content.description" :disabled="!contentReady" type="textarea" :rows="4" maxlength="16000" placeholder="支持段落、列表、表格和图片；脚本及事件属性会被移除。" /></el-form-item>
        </template>
        <el-form-item label="活动价" required>
          <el-input v-model="form.price" placeholder="如: 49.90" />
        </el-form-item>
        <el-form-item label="原价" v-if="formType !== 'bargain'">
          <el-input v-model="form.otPrice" placeholder="如: 99.90" />
        </el-form-item>
        <el-form-item label="库存">
          <el-input-number v-model="form.stock" :min="0" />
        </el-form-item>
        <el-form-item label="活动额度" v-if="formType === 'bargain'">
          <el-input-number v-model="form.quota" :min="0" />
        </el-form-item>
        <el-form-item label="砍价人数" v-if="formType === 'bargain'">
          <el-input-number v-model="form.people" :min="2" />
        </el-form-item>
        <el-form-item label="限购/成团人数" v-if="formType !== 'integral' && formType !== 'bargain'">
          <el-input-number v-model="form.num" :min="1" />
          <span class="hint" v-if="formType === 'combination'">成团人数</span>
          <span class="hint" v-else>秒杀限购</span>
        </el-form-item>
        <el-form-item label="成团人数" v-if="formType === 'combination'">
          <el-input-number v-model="form.people" :min="2" />
        </el-form-item>
        <el-form-item label="底价" v-if="formType === 'bargain'">
          <el-input v-model="form.minPrice" placeholder="可砍至最低价" />
        </el-form-item>
        <template v-if="formType === 'bargain'">
          <el-form-item label="开始时间" required>
            <el-date-picker v-model="form.startTime" type="datetime" format="YYYY-MM-DD HH:mm:ss" placeholder="选择开始时间" style="width: 100%" />
          </el-form-item>
          <el-form-item label="结束时间" required>
            <el-date-picker v-model="form.stopTime" type="datetime" format="YYYY-MM-DD HH:mm:ss" placeholder="选择结束时间" style="width: 100%" />
          </el-form-item>
          <p class="time-hint">时间按本地时区 {{ browserTimeZone }} 显示，保存为 UTC；已结束活动不可直接编辑重启。</p>
        </template>
        <el-form-item label="积分" v-if="formType === 'integral'">
          <el-input-number v-model="form.integral" :min="0" />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sort" :min="0" />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="form.status" :active-value="1" :inactive-value="0" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <el-card v-if="activeTab === 'seckill' && canSeckillActivities" shadow="never" class="time-card">
      <template #header>秒杀父活动</template>
      <p class="time-hint">设置活动日期、多场次及参与商品规格。当前列表展示活动内的子商品。</p>
      <el-button type="primary" plain @click="router.push('/activity/seckill-activities')">管理秒杀父活动</el-button>
    </el-card>
    <el-card v-if="activeTab === 'seckill' && canSeckillTimes" shadow="never" class="time-card">
      <template #header>秒杀时段</template>
      <p class="time-hint">在时段管理中设置每日秒杀时间、图片及显示状态。</p>
      <el-button type="primary" plain @click="router.push('/activity/seckill-times')">管理秒杀时段</el-button>
    </el-card>

    <el-card v-if="activeTab === 'combination' && canCombinations" shadow="never" class="time-card">
      <template #header>拼团商品管理</template>
      <p class="time-hint">设置拼团日期、商品规格额度、成团人数、虚拟成团比例及配送方式。</p>
      <el-button type="primary" plain @click="router.push('/activity/combinations')">管理拼团商品</el-button>
    </el-card>

    <!-- 拼团团列表弹窗 -->
    <el-dialog v-model="pinkVisible" title="拼团团列表" width="680px">
      <el-table :data="pinks" border>
        <el-table-column prop="id" label="团ID" width="80" />
        <el-table-column prop="uid" label="团长UID" width="90" />
        <el-table-column prop="orderId" label="订单号" min-width="200" />
        <el-table-column label="人数" width="80">
          <template #default="{ row }">{{ row.people }} 人</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'info'">
              {{ row.status === 1 ? "拼团中" : "已完成" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="开团时间" width="160">
          <template #default="{ row }">{{ formatTime(row.addTime) }}</template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!pinks.length" description="暂无团记录" />
    </el-dialog>

    <!-- 砍价明细弹窗 -->
    <el-dialog v-model="bargainVisible" title="砍价参与明细" width="680px">
      <el-table :data="bargainUsers" border>
        <el-table-column prop="id" label="记录ID" width="80" />
        <el-table-column prop="uid" label="用户UID" width="90" />
        <el-table-column label="当前价" width="110">
          <template #default="{ row }">¥{{ row.bargainPrice }}</template>
        </el-table-column>
        <el-table-column label="底价" width="110">
          <template #default="{ row }">¥{{ row.bargainPriceMin }}</template>
        </el-table-column>
        <el-table-column label="已砍" width="100">
          <template #default="{ row }">¥{{ row.price }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'info'">
              {{ row.status === 1 ? "参与中" : "已结束" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="160">
          <template #default="{ row }">{{ formatTime(row.addTime) }}</template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!bargainUsers.length" description="暂无砍价记录" />
    </el-dialog>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onBeforeUnmount, nextTick, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import { computed } from "vue";
import { useAuthStore } from "@/stores/auth";
import { getAdminSession, getToken } from "@/utils/auth";
import { ElMessage } from "element-plus";
import {
  apiAdminSeckillList,
  apiAdminCombinationList,
  apiAdminBargainList,
  apiAdminIntegralList,
  apiAdminActivityStatus,
  apiAdminPinkList,
  apiAdminBargainUsers,
  apiAdminSeckillTimes,
  apiAdminActivitySave,
  apiAdminActivityDel,
  apiAdminBargainSkuOptions,
  type BargainSkuOptions,
  type ActivityItem,
  type ActivityListQuery,
} from "@/api/activity";
import { ElMessageBox } from "element-plus";
import DiscountPackageManager from "@/pages/activity/DiscountPackageManager.vue";
import { bargainEditPayload, bargainFormDate } from "@/api/bargainEdit";
import { withBargainSku } from "@/api/bargainSkuEdit";
import { contentForm, withBargainContent, type BargainContentForm } from '@/api/bargainContentEdit';
import { shippingForm, withBargainShipping, type BargainShippingFields } from '@/api/bargainShippingEdit';

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
const requestedTab = useRoute().query.tab;
const activeTab = ref(typeof requestedTab === 'string' && ['seckill','combination','bargain','integral','discounts'].includes(requestedTab) ? requestedTab : previewMode ? "discounts" : "seckill");
const router = useRouter();
const auth = useAuthStore();
const canIntegralBatch = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes('integral_batch.view')));
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes("activity.view")));
const canManage = computed(() => activeTab.value !== 'combination' && canView.value && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes("activity.manage")));
const canSeckillStatistics = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes("seckill_statistics.view")));
const canSeckillTimes = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes('seckill_time.view')));
const canSeckillActivities = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes('seckill_activity.view')));
const canCombinations = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes('combination.view')));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ''}:${auth.uniqueAuth.join(',')}`);
const PAGE_SIZE = 20;
const MAX_PAGE = Math.floor(10_000 / PAGE_SIZE) + 1;
const page = ref(1);
const count = ref(0);
const draftKeyword = ref('');
const draftStatus = ref<'' | 0 | 1>('');
const keyword = ref('');
const status = ref<0 | 1 | undefined>();
const list = ref<ActivityItem[]>([]);
const loading = ref(false);
const listError = ref('');
let mounted = false;
let listRequest = 0;
let listAbort: AbortController | null = null;
const pinkVisible = ref(false);
const pinks = ref<{ id: number; uid: number; orderId: string; people: number; status: number; addTime: number }[]>([]);
const bargainVisible = ref(false);
const bargainUsers = ref<{ id: number; uid: number; bargainPrice: string; bargainPriceMin: string; price: string; status: number; addTime: number }[]>([]);
const seckillTimes = ref<{ id: number; startTime: string; endTime: string; status: number }[]>([]);

// M20: 表单
const formVisible = ref(false);
const saving = ref(false);
const formError = ref("");
const formErrorElement = ref<HTMLElement | null>(null);
const formType = ref("seckill");
const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let bargainOriginal: Record<string, unknown> | null = null;
const skuOptions = ref<BargainSkuOptions | null>(null);
const skuLoading = ref(false);
const selectedBaseUnique = ref('');
let originalBaseUnique = '';
let skuRequest = 0;
const content = reactive(contentForm()), contentReady = ref(false);
let originalContent: BargainContentForm | null = null;
const shipping = reactive(shippingForm()), shippingProductId = ref(0);
const originalShipping = ref<BargainShippingFields | null>(null);
const form = reactive({
  id: 0,
  productId: 1,
  storeName: "",
  image: "",
  price: "",
  otPrice: "",
  stock: 100,
  quota: 100,
  num: 2,
  people: 2,
  minPrice: "",
  integral: 100,
  sort: 90,
  status: 1,
  startTime: null as Date | null,
  stopTime: null as Date | null,
});

function formatTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openSeckillStatistics(row: ActivityItem) {
  if (!Number.isSafeInteger(row.id) || row.id <= 0) return;
  void router.push({ name: "seckill-statistics", params: { id: String(row.id) } });
}

async function showPinks(row: ActivityItem) {
  pinkVisible.value = true;
  try {
    pinks.value = await apiAdminPinkList(row.id);
  } catch (e) {
    pinks.value = [];
    ElMessage.error((e as Error).message || "加载失败");
  }
}

async function showBargainUsers(row: ActivityItem) {
  bargainVisible.value = true;
  try {
    bargainUsers.value = await apiAdminBargainUsers(row.id);
  } catch (e) {
    bargainUsers.value = [];
    ElMessage.error((e as Error).message || "加载失败");
  }
}

function currentList(requestId: number, tab: string, session: string) {
  return mounted && canView.value && requestId === listRequest && activeTab.value === tab &&
    sessionKey.value === session && auth.token === getToken();
}

async function loadTimes(requestId: number, tab: string, session: string) {
  try {
    const result = await apiAdminSeckillTimes();
    if (currentList(requestId, tab, session)) seckillTimes.value = result;
  } catch {
    if (currentList(requestId, tab, session)) seckillTimes.value = [];
  }
}

function discardList() {
  listRequest++;
  listAbort?.abort(); listAbort = null;
  list.value = []; count.value = 0; seckillTimes.value = [];
  loading.value = false; listError.value = '';
}

async function load(targetPage = page.value) {
  if (!mounted || !canView.value || activeTab.value === 'discounts') return;
  if (!Number.isSafeInteger(targetPage) || targetPage < 1 || targetPage > MAX_PAGE) return;
  discardList();
  page.value = targetPage;
  const requestId = listRequest, tab = activeTab.value, session = sessionKey.value;
  const controller = new AbortController();
  listAbort = controller;
  loading.value = true;
  const query: ActivityListQuery = { page: targetPage, limit: PAGE_SIZE, keyword: keyword.value };
  if (status.value !== undefined) query.status = status.value;
  try {
    const fetchList = { seckill: apiAdminSeckillList, combination: apiAdminCombinationList,
      bargain: apiAdminBargainList, integral: apiAdminIntegralList }[tab];
    if (!fetchList) return;
    const result = await fetchList(query, controller.signal);
    if (!currentList(requestId, tab, session)) return;
    // A deletion or concurrent change may remove the final row on this page.
    if (!result.list.length && targetPage > 1) {
      await load(Math.max(1, Math.min(targetPage - 1, Math.ceil(result.count / PAGE_SIZE))));
      return;
    }
    list.value = result.list;
    count.value = result.count;
    if (tab === 'seckill') void loadTimes(requestId, tab, session);
  } catch (e) {
    if (currentList(requestId, tab, session)) listError.value = e instanceof Error ? e.message : "活动列表加载失败";
  } finally {
    if (listAbort === controller) { listAbort = null; loading.value = false; }
  }
}

function search() {
  keyword.value = draftKeyword.value.trim();
  status.value = draftStatus.value === 0 || draftStatus.value === 1 ? draftStatus.value : undefined;
  void load(1);
}

function reset() {
  draftKeyword.value = ''; draftStatus.value = ''; keyword.value = ''; status.value = undefined;
  void load(1);
}

function changeTab() {
  discardList(); page.value = 1;
  pinkVisible.value = false; bargainVisible.value = false;
  reset();
}

async function toggleStatus(row: ActivityItem) {
  if (!canManage.value || activeTab.value === 'discounts') return;
  const tab = activeTab.value, session = sessionKey.value;
  try {
    await apiAdminActivityStatus(
      tab as "seckill" | "combination" | "bargain" | "integral",
      row.id,
      row.status === 1 ? 0 : 1,
    );
    ElMessage.success("操作成功");
    if (activeTab.value === tab && sessionKey.value === session) void load();
  } catch (e) {
    ElMessage.error((e as Error).message || "操作失败");
  }
}

function openForm(row?: ActivityItem) {
  if (!canManage.value || activeTab.value === 'discounts') return;
  saving.value = false;
  Object.assign(shipping, shippingForm()); shippingProductId.value = 0; originalShipping.value = null;
  Object.assign(content,contentForm()); contentReady.value = !row; originalContent = null;
  skuRequest++;
  skuOptions.value = null;
  skuLoading.value = false;
  selectedBaseUnique.value = '';
  originalBaseUnique = '';
  formError.value = "";
  formType.value = activeTab.value;
  try {
    form.startTime = row && formType.value === "bargain" ? bargainFormDate(row.startTime) : null;
    form.stopTime = row && formType.value === "bargain" ? bargainFormDate(row.stopTime) : null;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "活动时间无效");
    return;
  }
  if (row) {
    form.id = row.id;
    form.productId = row.productId ?? 1;
    form.storeName = row.storeName ?? "";
    form.image = row.image ?? "";
    form.price = row.price ?? "";
    form.otPrice = row.otPrice ?? "";
    form.stock = row.stock ?? 0;
    form.quota = row.quota ?? row.stock ?? 0;
    form.num = (row as any).num ?? 2;
    form.people = (row as any).people ?? 2;
    form.minPrice = (row as any).minPrice ?? "";
    form.integral = (row as any).integral ?? 100;
    form.sort = row.sort ?? 90;
    form.status = row.status ?? 1;
  } else {
    form.id = 0;
    form.productId = 1;
    form.storeName = "";
    form.image = "";
    form.price = "";
    form.otPrice = "";
    form.stock = 100;
    form.quota = 100;
    form.num = 2;
    form.people = 2;
    form.minPrice = "";
    form.integral = 100;
    form.sort = 90;
    form.status = 1;
  }
  bargainOriginal = row && formType.value === "bargain" ? { ...form } : null;
  formVisible.value = true;
  if (row && formType.value === 'bargain') void loadBargainSkus();
}

async function loadBargainSkus() {
  const requestId = ++skuRequest, productId = form.productId, activityId = form.id;
  skuLoading.value = true;
  try {
    const result = await apiAdminBargainSkuOptions(productId, activityId || undefined);
    if (requestId !== skuRequest || form.productId !== productId || form.id !== activityId || !formVisible.value) return;
    skuOptions.value = result;
    if (result.shipping && shippingProductId.value !== productId) {
      originalShipping.value = result.shipping.current ? { ...result.shipping.current } : null;
      Object.assign(shipping, shippingForm(result.shipping.current));
      if (!activityId && result.shipping.productType !== 0) shipping.methods = ['2'];
      if (!activityId && [1,2,3].includes(result.shipping.productType)) shipping.freight = 2;
      shippingProductId.value = productId;
    }
    if (activityId && !contentReady.value && result.content) {
      Object.assign(content,contentForm(result.content)); originalContent = {...content}; contentReady.value = true;
    }
    const matching = result.current.length === 1 ? result.options.find(row => row.suk === result.current[0].suk) : undefined;
    originalBaseUnique = matching?.unique ?? '';
    selectedBaseUnique.value = originalBaseUnique;
  } catch (error) {
    if (requestId === skuRequest) { skuOptions.value = null; formError.value = error instanceof Error ? error.message : '规格加载失败'; }
  } finally { if (requestId === skuRequest) skuLoading.value = false; }
}
function selectBargainSku() {
  if (form.id) return;
  const sku = skuOptions.value?.options.find(row => row.unique === selectedBaseUnique.value);
  if (sku) { form.stock = sku.stock; form.quota = sku.stock; }
}

async function save() {
  if (!canManage.value) return;
  if (!form.storeName) return ElMessage.error("请输入活动名称");
  if (!form.price) return ElMessage.error("请输入活动价");
  saving.value = true;
  formError.value = "";
  const session = sessionKey.value, formRequest = skuRequest, savedType = formType.value;
  const currentForm = () => mounted && canManage.value && sessionKey.value === session && formRequest === skuRequest;
  try {
    await apiAdminActivitySave(formType.value === "bargain" ? withBargainShipping(withBargainContent(withBargainSku(bargainEditPayload(form, bargainOriginal),
      skuOptions.value, selectedBaseUnique.value, originalBaseUnique, form.productId),content,originalContent,contentReady.value),
      shipping, originalShipping.value, shippingProductId.value, form.productId, skuOptions.value?.shipping) : {
      type: formType.value,
      id: form.id || undefined,
      productId: form.productId,
      storeName: form.storeName,
      image: form.image,
      price: form.price,
      otPrice: form.otPrice,
      stock: form.stock,
      quota: form.quota,
      num: form.num,
      people: form.people,
      minPrice: form.minPrice,
      integral: form.integral,
      sort: form.sort,
      status: form.status,
    });
    if (!currentForm()) return;
    ElMessage.success("保存成功");
    formVisible.value = false;
    if (activeTab.value === savedType) void load();
  } catch (e) {
    if (!currentForm()) return;
    formError.value = e instanceof Error ? e.message : "保存失败";
    await nextTick();
    formErrorElement.value?.scrollIntoView({ block: "nearest" });
  } finally {
    if (currentForm()) saving.value = false;
  }
}

async function del(row: ActivityItem) {
  if (!canManage.value || activeTab.value === 'discounts') return;
  const tab = activeTab.value, session = sessionKey.value;
  try {
    await ElMessageBox.confirm(`确认删除活动「${row.storeName}」?`, "删除确认", { type: "warning" });
  } catch {
    return;
  }
  if (!canManage.value || activeTab.value !== tab || sessionKey.value !== session) return;
  try {
    await apiAdminActivityDel(tab, row.id);
    ElMessage.success("已删除");
    if (activeTab.value === tab && sessionKey.value === session) void load();
  } catch (e) {
    ElMessage.error((e as Error).message || "删除失败");
  }
}

function syncSession() {
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
}
function syncStoredSession(event: StorageEvent) {
  if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') syncSession();
}

watch(activeTab, changeTab, { flush: 'sync' });
watch(sessionKey, () => {
  if (!mounted) return;
  formVisible.value = false; pinkVisible.value = false; bargainVisible.value = false;
  saving.value = false;
  skuRequest++;
  discardList(); page.value = 1;
  reset();
});
onMounted(() => {
  mounted = true;
  window.addEventListener('admin-session-changed', syncSession);
  window.addEventListener('admin-auth-expired', syncSession);
  window.addEventListener('storage', syncStoredSession);
  const previous = sessionKey.value;
  syncSession();
  if (previous === sessionKey.value) void load();
});
onBeforeUnmount(() => {
  mounted = false; skuRequest++;
  window.removeEventListener('admin-session-changed', syncSession);
  window.removeEventListener('admin-auth-expired', syncSession);
  window.removeEventListener('storage', syncStoredSession);
  discardList();
});
</script>

<style scoped>
.activity-page { min-width: 0; }
.page-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.head-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.page-head h2 {
  font-size: 18px;
  margin: 0;
}

.filters { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; margin: 8px 0 18px; }
.filter-field { display: flex; flex: 1 1 240px; min-width: 0; flex-direction: column; gap: 6px; font-size: 13px; }
.status-field { flex: 0 1 180px; }
.filter-field :deep(.el-input), .filter-field :deep(.el-select) { width: 100%; }
.filter-actions { display: flex; gap: 8px; }
.filter-actions :deep(.el-button + .el-button) { margin-left: 0; }
.list-error { margin-bottom: 12px; }
.table-scroll { width: 100%; max-width: 100%; overflow-x: auto; }
.pager { margin: 16px 0; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
@media (max-width: 600px) {
  .filters { display: grid; grid-template-columns: minmax(0, 1fr); }
  .pager { justify-content: center; }
  .pager :deep(.el-pagination__total) { width: 100%; text-align: center; margin-right: 0; }
}

.ot-price {
  color: #999;
  text-decoration: line-through;
  font-size: 12px;
}

.time-card {
  margin-top: 16px;
}

.form-error {
  margin-bottom: 16px;
}

.time-hint { color: #606266; font-size: 12px; margin: 0 0 16px 0; }
.shipping-fields { min-width: 0; margin: 0 0 20px; padding: 12px; border: 1px solid #dcdfe6; border-radius: 6px; }
.shipping-fields legend { color: #303133; padding: 0 6px; }
.shipping-fields :deep(.el-checkbox) { margin-right: 16px; }
</style>
