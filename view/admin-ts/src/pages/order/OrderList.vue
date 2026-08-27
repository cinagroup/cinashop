<template>
  <div class="order-list">
    <el-card shadow="never" class="filter-card">
      <el-form inline>
        <el-form-item label="订单号">
          <el-input v-model="query.order_id" placeholder="订单号" clearable />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="query.status" placeholder="全部" clearable style="width: 140px">
            <el-option label="待发货" :value="0" />
            <el-option label="待收货" :value="1" />
            <el-option label="已收货" :value="2" />
            <el-option label="已完成" :value="3" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="reload">搜索</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never">
      <el-table :data="list" v-loading="loading">
        <el-table-column prop="orderId" label="订单号" min-width="200" />
        <el-table-column prop="realName" label="收货人" width="100" />
        <el-table-column prop="userPhone" label="电话" width="120" />
        <el-table-column prop="totalNum" label="数量" width="70" />
        <el-table-column label="金额" width="110">
          <template #default="{ row }">¥{{ row.payPrice }}</template>
        </el-table-column>
        <el-table-column label="支付状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.paid === 1 ? 'success' : 'warning'">
              {{ row.paid === 1 ? "已支付" : "未支付" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="订单状态" width="100">
          <template #default="{ row }">{{ statusText(row.status) }}</template>
        </el-table-column>
        <el-table-column label="下单时间" width="160">
          <template #default="{ row }">{{ formatTime(row.addTime) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="$router.push(`/order/${row.orderId}`)">
              详情
            </el-button>
            <el-button link type="primary" @click="printOrder(row)">打印</el-button>
            <el-button
              v-if="row.paid === 1 && row.status === 0 && row.shippingType !== 2"
              link
              type="primary"
              @click="deliver(row)"
            >
              发货
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-model:current-page="query.page"
        :page-size="query.limit"
        :total="total"
        layout="total, prev, pager, next"
        class="pagination"
        @current-change="fetch"
      />
    </el-card>

    <el-dialog v-model="deliveryVisible" title="订单发货" width="min(560px, 94vw)" destroy-on-close>
      <el-form label-position="top">
        <el-form-item label="订单号"><strong>{{ deliveryOrder?.orderId }}</strong></el-form-item>
        <el-form-item label="发货方式">
          <el-radio-group v-model="deliveryForm.delivery_type">
            <el-radio-button value="waybill">电子面单</el-radio-button>
            <el-radio-button value="express">手填快递</el-radio-button>
            <el-radio-button value="send">平台配送</el-radio-button>
            <el-radio-button value="fictitious">虚拟交付</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <template v-if="deliveryForm.delivery_type === 'express' || deliveryForm.delivery_type === 'waybill'">
          <el-form-item label="快递公司"><el-select v-model="deliveryForm.carrier_id" filterable placeholder="请选择" style="width:100%" @change="selectCarrier"><el-option v-for="item in expressOptions" :key="item.id" :value="item.id" :label="item.name" /></el-select></el-form-item>
          <el-form-item v-if="deliveryForm.delivery_type === 'express'" label="快递单号"><el-input v-model="deliveryForm.delivery_id" maxlength="64" /></el-form-item>
          <el-alert v-else title="签发异步执行；超时或断线后不会自动重复申请单号，请在电子面单账本核对。" type="info" :closable="false" show-icon />
        </template>
        <el-form-item v-else-if="deliveryForm.delivery_type === 'send'" label="配送员">
          <el-select v-model="deliveryForm.delivery_uid" filterable placeholder="选择有效平台配送员" style="width: 100%">
            <el-option
              v-for="item in deliveryOptions"
              :key="item.id"
              :label="`${item.nickname} ${item.phone}`"
              :value="item.uid"
            />
          </el-select>
          <div v-if="!deliveryOptions.length" class="form-tip">请先在“配送员管理”中添加并启用配送员。</div>
        </el-form-item>
        <el-form-item v-else label="交付说明">
          <el-input v-model="deliveryForm.fictitious_content" type="textarea" :rows="4" maxlength="500" show-word-limit />
        </el-form-item>
        <el-alert
          v-if="deliveryForm.delivery_type === 'send'"
          title="平台配送发货后会生成12位送达核销码；客户不能绕过配送员自行确认收货。"
          type="warning"
          :closable="false"
          show-icon
        />
      </el-form>
      <template #footer>
        <el-button @click="deliveryVisible = false">取消</el-button>
        <el-button type="primary" :loading="deliverySubmitting" @click="submitDelivery">{{ deliveryForm.delivery_type === 'waybill' ? '创建签发任务' : '确认发货' }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { ElMessage } from "element-plus";
import {
  apiAdminDeliveryOptions,
  apiAdminOrderList,
  apiAdminOrderDelivery,
  apiAdminCreateWaybill,
  type AdminDeliveryOption,
} from "@/api/order";
import { apiAdminExpressList, type ExpressItem } from "@/api/shipping";
import { apiAdminManualPrint } from "@/api/printing";
import type { AdminOrder } from "@/types/admin";
import dayjs from "dayjs";

const list = ref<AdminOrder[]>([]);
const loading = ref(false);
const total = ref(0);
const deliveryVisible = ref(false);
const deliverySubmitting = ref(false);
const deliveryOrder = ref<AdminOrder | null>(null);
const deliveryOptions = ref<AdminDeliveryOption[]>([]);
const expressOptions = ref<ExpressItem[]>([]);
const deliveryForm = reactive({
  delivery_type: "express" as "express" | "waybill" | "send" | "fictitious",
  carrier_id: 0,
  delivery_name: "",
  delivery_id: "",
  delivery_uid: 0,
  fictitious_content: "",
});
const query = reactive({ page: 1, limit: 10, order_id: "", status: undefined as number | undefined });

function statusText(status: number): string {
  switch (status) {
    case 0: return "待发货";
    case 1: return "待收货";
    case 2: return "已收货";
    case 3: return "已完成";
    default: return "未知";
  }
}

function formatTime(ts: number): string {
  return ts ? dayjs(ts * 1000).format("YYYY-MM-DD HH:mm") : "-";
}

async function fetch() {
  loading.value = true;
  try {
    const result = await apiAdminOrderList({
      page: query.page,
      limit: query.limit,
      order_id: query.order_id || undefined,
      status: query.status,
    });
    list.value = result.list;
    total.value =
      result.list.length < query.limit
        ? (query.page - 1) * query.limit + result.list.length
        : query.page * query.limit + 1;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

function reload() {
  query.page = 1;
  fetch();
}

async function deliver(row: AdminOrder) {
  deliveryOrder.value = row;
  Object.assign(deliveryForm, {
    delivery_type: "express",
    delivery_name: "",
    carrier_id: 0,
    delivery_id: "",
    delivery_uid: 0,
    fictitious_content: "",
  });
  deliveryVisible.value = true;
  try {
    const [deliveries, carriers] = await Promise.all([apiAdminDeliveryOptions(), apiAdminExpressList()]);
    deliveryOptions.value = deliveries.list;
    expressOptions.value = carriers.filter((item) => item.status === 1 && item.isShow === 1);
  } catch (error) {
    deliveryOptions.value = [];
    ElMessage.warning(error instanceof Error ? error.message : "配送员列表加载失败");
  }
}

function selectCarrier(id: number) {
  const carrier = expressOptions.value.find((item) => item.id === id);
  deliveryForm.delivery_name = carrier?.name ?? "";
}

async function printOrder(row: AdminOrder) {
  try {
    const result = await apiAdminManualPrint(row.id);
    ElMessage.success(result.duplicate ? "该打印请求已受理" : `已创建 ${result.jobs.length} 个打印任务`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "创建打印任务失败");
  }
}

async function submitDelivery() {
  if (!deliveryOrder.value || deliverySubmitting.value) return;
  if (["express", "waybill"].includes(deliveryForm.delivery_type) && deliveryForm.carrier_id <= 0) {
    return ElMessage.warning("请选择快递公司");
  }
  if (deliveryForm.delivery_type === "express" && !deliveryForm.delivery_id.trim()) {
    return ElMessage.warning("请输入快递单号");
  }
  if (deliveryForm.delivery_type === "send" && deliveryForm.delivery_uid <= 0) {
    return ElMessage.warning("请选择配送员");
  }
  if (deliveryForm.delivery_type === "fictitious" && !deliveryForm.fictitious_content.trim()) {
    return ElMessage.warning("请输入交付说明");
  }
  deliverySubmitting.value = true;
  try {
    if (deliveryForm.delivery_type === "waybill") {
      const result = await apiAdminCreateWaybill(deliveryOrder.value.orderId, deliveryForm.carrier_id);
      ElMessage.success(result.duplicate ? "该签发请求已受理" : "电子面单任务已创建，请在面单账本查看结果");
      deliveryVisible.value = false;
      return;
    }
    await apiAdminOrderDelivery(deliveryOrder.value.orderId, {
      delivery_type: deliveryForm.delivery_type as "express" | "send" | "fictitious",
      delivery_name: deliveryForm.delivery_name.trim(),
      delivery_id: deliveryForm.delivery_id.trim(),
      delivery_uid: deliveryForm.delivery_uid,
      fictitious_content: deliveryForm.fictitious_content.trim(),
    });
    ElMessage.success("发货成功");
    deliveryVisible.value = false;
    await fetch();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "发货失败");
  } finally {
    deliverySubmitting.value = false;
  }
}

onMounted(fetch);
</script>

<style scoped>
.filter-card {
  margin-bottom: 16px;
}

.pagination {
  margin-top: 16px;
  justify-content: flex-end;
}

.form-tip {
  margin-top: 8px;
  color: #909399;
  font-size: 12px;
}
</style>
