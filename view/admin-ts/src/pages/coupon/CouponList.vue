<template>
  <div class="coupon-page">
    <div class="page-head">
      <h2>优惠券管理</h2>
      <div class="head-right">
        <el-radio-group v-model="typeFilter" @change="load">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="1">满减</el-radio-button>
          <el-radio-button value="2">折扣</el-radio-button>
        </el-radio-group>
        <el-button type="primary" @click="openForm()">＋ 新增优惠券</el-button>
      </div>
    </div>

    <el-table :data="filteredList" v-loading="loading" border>
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column prop="couponTitle" label="名称" />
      <el-table-column label="类型" width="80">
        <template #default="{ row }">
          <el-tag :type="row.type === 1 ? 'primary' : 'warning'">
            {{ row.type === 1 ? "满减" : "折扣" }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="面额/折扣" width="110">
        <template #default="{ row }">
          {{ row.type === 2 ? `${row.couponPrice}折` : `¥${row.couponPrice}` }}
        </template>
      </el-table-column>
      <el-table-column label="门槛" width="100">
        <template #default="{ row }">满¥{{ row.useMinPrice }}</template>
      </el-table-column>
      <el-table-column label="有效天数" width="100" prop="day" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 1 ? 'success' : 'info'">
            {{ row.status === 1 ? "可用" : "停发" }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="200">
        <template #default="{ row }">
          <el-button link type="primary" @click="openForm(row)">编辑</el-button>
          <el-button link :type="row.status === 1 ? 'warning' : 'success'" @click="toggleStatus(row)">
            {{ row.status === 1 ? "停发" : "上架" }}
          </el-button>
          <el-button link type="danger" @click="del(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 新增/编辑弹窗 -->
    <el-dialog v-model="showForm" :title="formData.id ? '编辑优惠券' : '新增优惠券'" width="500px">
      <el-form label-width="90px">
        <el-form-item label="名称">
          <el-input v-model="formData.title" placeholder="优惠券名称" />
        </el-form-item>
        <el-form-item label="面额">
          <el-input v-model="formData.coupon_price" placeholder="如 10.00">
            <template #prepend>¥</template>
          </el-input>
        </el-form-item>
        <el-form-item label="使用门槛">
          <el-input v-model="formData.use_min_price" placeholder="如 100.00">
            <template #prepend>满¥</template>
          </el-input>
        </el-form-item>
        <el-form-item label="有效天数">
          <el-input-number v-model="formData.day" :min="1" :max="365" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showForm = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiAdminCouponList,
  apiAdminCouponSave,
  apiAdminCouponStatus,
  apiAdminCouponDel,
  type CouponItem,
} from "@/api/coupon";

const list = ref<CouponItem[]>([]);
const loading = ref(true);
const showForm = ref(false);
const typeFilter = ref("all");

const filteredList = computed(() => {
  if (typeFilter.value === "all") return list.value;
  return list.value.filter((c) => c.type === Number(typeFilter.value));
});
const formData = reactive({
  id: 0,
  title: "",
  coupon_price: "",
  use_min_price: "",
  day: 7,
});

async function load() {
  loading.value = true;
  try {
    list.value = await apiAdminCouponList();
  } finally {
    loading.value = false;
  }
}

function openForm(row?: CouponItem) {
  if (row) {
    formData.id = row.id;
    formData.title = row.couponTitle;
    formData.coupon_price = row.couponPrice;
    formData.use_min_price = row.useMinPrice;
    formData.day = row.day;
  } else {
    formData.id = 0;
    formData.title = "";
    formData.coupon_price = "";
    formData.use_min_price = "";
    formData.day = 7;
  }
  showForm.value = true;
}

async function save() {
  if (!formData.title) return ElMessage.warning("请输入名称");
  try {
    await apiAdminCouponSave({
      id: formData.id || undefined,
      title: formData.title,
      coupon_price: formData.coupon_price,
      use_min_price: formData.use_min_price,
      day: formData.day,
    });
    ElMessage.success(formData.id ? "更新成功" : "创建成功");
    showForm.value = false;
    load();
  } catch (e) {
    ElMessage.error((e as Error).message || "操作失败");
  }
}

async function toggleStatus(row: CouponItem) {
  try {
    await apiAdminCouponStatus(row.id, row.status === 1 ? 0 : 1);
    ElMessage.success("操作成功");
    load();
  } catch (e) {
    ElMessage.error((e as Error).message || "操作失败");
  }
}

async function del(row: CouponItem) {
  try {
    await ElMessageBox.confirm(`确认删除优惠券「${row.couponTitle}」?`, "确认");
    await apiAdminCouponDel(row.id);
    ElMessage.success("已删除");
    load();
  } catch {
    // 取消
  }
}

onMounted(load);
</script>

<style scoped>
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.head-right {
  display: flex;
  align-items: center;
  gap: 16px;
}
.page-head h2 {
  font-size: 18px;
  margin: 0;
}
</style>
