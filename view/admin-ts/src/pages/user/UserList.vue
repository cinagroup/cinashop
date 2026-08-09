<template>
  <div class="user-list">
    <el-card shadow="never" class="filter-card">
      <el-form inline>
        <el-form-item label="手机号">
          <el-input v-model="query.phone" placeholder="手机号" clearable />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="reload">搜索</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never">
      <el-table :data="list" v-loading="loading">
        <el-table-column prop="uid" label="UID" width="70" />
        <el-table-column prop="nickname" label="昵称" min-width="140" />
        <el-table-column prop="phone" label="手机号" width="130" />
        <el-table-column label="余额" width="110">
          <template #default="{ row }">¥{{ row.now_money }}</template>
        </el-table-column>
        <el-table-column prop="integral" label="积分" width="90" />
        <el-table-column label="等级" width="80">
          <template #default="{ row }">{{ row.level }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 1 ? 'success' : 'danger'">
              {{ row.status === 1 ? "正常" : "禁用" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="注册时间" width="160">
          <template #default="{ row }">{{ formatTime(row.add_time) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="showDetail(row)">详情</el-button>
            <el-button link type="primary" @click="adjustMoney(row)">调整余额</el-button>
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

    <!-- 调整余额弹窗 -->
    <el-dialog v-model="moneyDialog.show" title="调整余额" width="400px">
      <el-form label-width="80px">
        <el-form-item label="用户">
          <span>{{ moneyDialog.nickname }}</span>
        </el-form-item>
        <el-form-item label="操作">
          <el-radio-group v-model="moneyDialog.type">
            <el-radio value="add">增加</el-radio>
            <el-radio value="sub">减少</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="金额">
          <el-input-number v-model="moneyDialog.amount" :min="0" :precision="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="moneyDialog.show = false">取消</el-button>
        <el-button type="primary" :loading="moneyDialog.loading" @click="submitMoney">
          确定
        </el-button>
      </template>
    </el-dialog>

    <!-- 用户详情弹窗 -->
    <el-dialog v-model="detailDialog.show" title="用户详情" width="600px">
      <el-skeleton v-if="detailDialog.loading" :rows="6" animated />
      <template v-else-if="detail">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="UID">{{ detail.uid }}</el-descriptions-item>
          <el-descriptions-item label="昵称">{{ detail.nickname || "—" }}</el-descriptions-item>
          <el-descriptions-item label="手机号">{{ detail.phone || "—" }}</el-descriptions-item>
          <el-descriptions-item label="账号">{{ detail.account || "—" }}</el-descriptions-item>
          <el-descriptions-item label="余额">¥{{ detail.nowMoney || detail.now_money || "0" }}</el-descriptions-item>
          <el-descriptions-item label="积分">{{ detail.integral || 0 }}</el-descriptions-item>
          <el-descriptions-item label="会员等级">{{ detail.level || 0 }}</el-descriptions-item>
          <el-descriptions-item label="推广人UID">{{ detail.spreadUid || detail.spread_uid || 0 }}</el-descriptions-item>
          <el-descriptions-item label="推广人数">{{ detail.spreadCount || detail.spread_count || 0 }}</el-descriptions-item>
          <el-descriptions-item label="佣金">¥{{ detail.brokeragePrice || detail.brokerage_price || "0" }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="detail.status === 1 ? 'success' : 'danger'">
              {{ detail.status === 1 ? "正常" : "禁用" }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="注册时间">{{ formatTime(detail.addTime || detail.add_time) }}</el-descriptions-item>
        </el-descriptions>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { apiAdminUserList, apiAdminUserInfo, apiAdminUserMoney } from "@/api/order";
import type { AdminUser } from "@/types/admin";
import dayjs from "dayjs";

const list = ref<AdminUser[]>([]);
const loading = ref(false);
const total = ref(0);
const query = reactive({ page: 1, limit: 10, phone: "" });

const moneyDialog = reactive({
  show: false,
  uid: 0,
  nickname: "",
  type: "add" as "add" | "sub",
  amount: 0,
  loading: false,
});

const detailDialog = reactive({ show: false, loading: false });
const detail = ref<Record<string, any> | null>(null);

function formatTime(ts: number): string {
  return ts ? dayjs(ts * 1000).format("YYYY-MM-DD HH:mm") : "-";
}

async function showDetail(row: AdminUser) {
  detailDialog.show = true;
  detailDialog.loading = true;
  try {
    detail.value = await apiAdminUserInfo(row.uid);
  } catch (e) {
    ElMessage.error((e as Error).message || "加载失败");
  } finally {
    detailDialog.loading = false;
  }
}

async function fetch() {
  loading.value = true;
  try {
    const result = await apiAdminUserList({
      page: query.page,
      limit: query.limit,
      phone: query.phone || undefined,
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

function adjustMoney(row: AdminUser) {
  moneyDialog.show = true;
  moneyDialog.uid = row.uid;
  moneyDialog.nickname = row.nickname || row.phone;
  moneyDialog.type = "add";
  moneyDialog.amount = 0;
}

async function submitMoney() {
  if (moneyDialog.amount <= 0) return ElMessage.error("请输入金额");
  moneyDialog.loading = true;
  try {
    const result = await apiAdminUserMoney(
      moneyDialog.uid,
      String(moneyDialog.amount),
      moneyDialog.type,
    );
    ElMessage.success(`调整成功, 当前余额 ¥${result.balance}`);
    moneyDialog.show = false;
    fetch();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "调整失败");
  } finally {
    moneyDialog.loading = false;
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
</style>
