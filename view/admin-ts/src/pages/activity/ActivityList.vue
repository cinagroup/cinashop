<template>
  <div class="activity-page">
    <div class="page-head">
      <h2>营销活动</h2>
      <div>
        <el-tag type="success" class="count-tag">当前 {{ list.length }} 个活动</el-tag>
        <el-button type="primary" size="small" @click="openForm()">＋ 新增活动</el-button>
      </div>
    </div>

    <!-- Tab 切换 -->
    <el-tabs v-model="activeTab" @tab-change="load">
      <el-tab-pane label="秒杀" name="seckill" />
      <el-tab-pane label="拼团" name="combination" />
      <el-tab-pane label="砍价" name="bargain" />
      <el-tab-pane label="积分商城" name="integral" />
    </el-tabs>

    <el-table :data="list" v-loading="loading" border>
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column prop="storeName" label="活动名称" />
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
          <el-button link type="primary" @click="openForm(row)">编辑</el-button>
          <el-button link :type="row.status === 1 ? 'warning' : 'success'" @click="toggleStatus(row)">
            {{ row.status === 1 ? "停用" : "启用" }}
          </el-button>
          <el-button link type="danger" @click="del(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 活动创建/编辑弹窗 -->
    <el-dialog v-model="formVisible" :title="form.id ? '编辑活动' : '新增活动'" width="560px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="商品ID" required>
          <el-input-number v-model="form.productId" :min="1" />
        </el-form-item>
        <el-form-item label="活动名称" required>
          <el-input v-model="form.storeName" placeholder="如: 夏季促销商品" />
        </el-form-item>
        <el-form-item label="图片URL">
          <el-input v-model="form.image" placeholder="商品图 URL" />
        </el-form-item>
        <el-form-item label="活动价" required>
          <el-input v-model="form.price" placeholder="如: 49.90" />
        </el-form-item>
        <el-form-item label="原价">
          <el-input v-model="form.otPrice" placeholder="如: 99.90" />
        </el-form-item>
        <el-form-item label="库存">
          <el-input-number v-model="form.stock" :min="0" />
        </el-form-item>
        <el-form-item label="限购/成团人数" v-if="activeTab !== 'integral' && activeTab !== 'bargain'">
          <el-input-number v-model="form.num" :min="1" />
          <span class="hint" v-if="activeTab === 'combination'">成团人数</span>
          <span class="hint" v-else>秒杀限购</span>
        </el-form-item>
        <el-form-item label="成团人数" v-if="activeTab === 'combination'">
          <el-input-number v-model="form.people" :min="2" />
        </el-form-item>
        <el-form-item label="底价" v-if="activeTab === 'bargain'">
          <el-input v-model="form.minPrice" placeholder="可砍至最低价" />
        </el-form-item>
        <el-form-item label="积分" v-if="activeTab === 'integral'">
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
    <el-empty v-if="!list.length && !loading" description="暂无活动数据" />

    <!-- 秒杀时段表 -->
    <el-card v-if="activeTab === 'seckill' && seckillTimes.length" shadow="never" class="time-card">
      <template #header>秒杀时段</template>
      <el-table :data="seckillTimes" border>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column label="开始时间" prop="startTime" width="120" />
        <el-table-column label="结束时间" prop="endTime" width="120" />
        <el-table-column label="持续天数" prop="continuedTime" width="100" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'info'">
              {{ row.status === 1 ? "启用" : "停用" }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
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
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
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
  type ActivityItem,
} from "@/api/activity";
import { ElMessageBox } from "element-plus";

const activeTab = ref("seckill");
const list = ref<ActivityItem[]>([]);
const loading = ref(true);
const pinkVisible = ref(false);
const pinks = ref<{ id: number; uid: number; orderId: string; people: number; status: number; addTime: number }[]>([]);
const bargainVisible = ref(false);
const bargainUsers = ref<{ id: number; uid: number; bargainPrice: string; bargainPriceMin: string; price: string; status: number; addTime: number }[]>([]);
const seckillTimes = ref<{ id: number; startTime: string; endTime: string; continuedTime: number; status: number }[]>([]);

// M20: 表单
const formVisible = ref(false);
const saving = ref(false);
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
});

function formatTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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

async function loadTimes() {
  try {
    seckillTimes.value = await apiAdminSeckillTimes();
  } catch {
    seckillTimes.value = [];
  }
}

async function load() {
  loading.value = true;
  try {
    switch (activeTab.value) {
      case "seckill":
        list.value = await apiAdminSeckillList();
        loadTimes();
        break;
      case "combination":
        list.value = await apiAdminCombinationList();
        break;
      case "bargain":
        list.value = await apiAdminBargainList();
        break;
      case "integral":
        list.value = await apiAdminIntegralList();
        break;
    }
  } catch (e) {
    ElMessage.error((e as Error).message || "加载失败");
  } finally {
    loading.value = false;
  }
}

async function toggleStatus(row: ActivityItem) {
  try {
    await apiAdminActivityStatus(
      activeTab.value as "seckill" | "combination" | "bargain" | "integral",
      row.id,
      row.status === 1 ? 0 : 1,
    );
    ElMessage.success("操作成功");
    load();
  } catch (e) {
    ElMessage.error((e as Error).message || "操作失败");
  }
}

function openForm(row?: ActivityItem) {
  if (row) {
    form.id = row.id;
    form.productId = row.productId;
    form.storeName = row.storeName;
    form.image = row.image;
    form.price = row.price;
    form.otPrice = row.otPrice;
    form.stock = row.stock;
    form.quota = row.quota;
    form.num = (row as any).num ?? 2;
    form.people = (row as any).people ?? 2;
    form.minPrice = (row as any).minPrice ?? "";
    form.integral = (row as any).integral ?? 100;
    form.sort = row.sort ?? 90;
    form.status = row.status;
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
  formVisible.value = true;
}

async function save() {
  if (!form.storeName) return ElMessage.error("请输入活动名称");
  if (!form.price) return ElMessage.error("请输入活动价");
  saving.value = true;
  try {
    await apiAdminActivitySave({
      type: activeTab.value,
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
    ElMessage.success("保存成功");
    formVisible.value = false;
    load();
  } catch (e) {
    ElMessage.error((e as Error).message || "保存失败");
  } finally {
    saving.value = false;
  }
}

async function del(row: ActivityItem) {
  try {
    await ElMessageBox.confirm(`确认删除活动「${row.storeName}」?`, "删除确认", { type: "warning" });
  } catch {
    return;
  }
  try {
    await apiAdminActivityDel(activeTab.value, row.id);
    ElMessage.success("已删除");
    load();
  } catch (e) {
    ElMessage.error((e as Error).message || "删除失败");
  }
}

onMounted(load);
</script>

<style scoped>
.page-head h2 {
  font-size: 18px;
  margin: 0 0 16px;
}

.count-tag {
  margin-bottom: 16px;
}

.ot-price {
  color: #999;
  text-decoration: line-through;
  font-size: 12px;
}

.time-card {
  margin-top: 16px;
}
</style>
