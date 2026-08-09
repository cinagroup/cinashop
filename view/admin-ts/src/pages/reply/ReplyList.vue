<template>
  <div class="reply-page">
    <div class="page-head">
      <h2>商品评价</h2>
    </div>

    <el-table :data="list" v-loading="loading" border>
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column label="用户" width="120">
        <template #default="{ row }">{{ row.nickname || "用户" }}</template>
      </el-table-column>
      <el-table-column label="评分" width="100">
        <template #default="{ row }">
          <span class="stars">{{ starText(row.productScore) }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="comment" label="评价内容" min-width="260" show-overflow-tooltip />
      <el-table-column label="图片" width="120">
        <template #default="{ row }">
          <el-image
            v-if="row.pics && row.pics.length"
            :src="row.pics[0]"
            class="pic"
            fit="cover"
            :preview-src-list="row.pics"
          />
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 1 ? 'success' : 'info'">
            {{ row.status === 1 ? "显示" : "隐藏" }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="时间" width="160">
        <template #default="{ row }">{{ formatTime(row.addTime) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="140">
        <template #default="{ row }">
          <el-button link :type="row.status === 1 ? 'warning' : 'success'" @click="toggle(row)">
            {{ row.status === 1 ? "隐藏" : "显示" }}
          </el-button>
          <el-button link type="danger" @click="del(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="!list.length && !loading" description="暂无评价" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiAdminReplyList, apiAdminReplyStatus, apiAdminReplyDel, type AdminReplyItem } from "@/api/reply";

const list = ref<AdminReplyItem[]>([]);
const loading = ref(true);

function formatTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function starText(score: number): string {
  const n = Math.min(5, Math.max(1, Number(score) || 5));
  return "★".repeat(n);
}

async function load() {
  loading.value = true;
  try {
    list.value = await apiAdminReplyList();
  } finally {
    loading.value = false;
  }
}

async function toggle(row: AdminReplyItem) {
  try {
    await apiAdminReplyStatus(row.id, row.status === 1 ? 0 : 1);
    ElMessage.success("操作成功");
    load();
  } catch (e) {
    ElMessage.error((e as Error).message || "操作失败");
  }
}

async function del(row: AdminReplyItem) {
  try {
    await ElMessageBox.confirm("确认删除该评价?", "确认");
    await apiAdminReplyDel(row.id);
    ElMessage.success("已删除");
    load();
  } catch {
    // 取消
  }
}

onMounted(load);
</script>

<style scoped>
.page-head h2 {
  font-size: 18px;
  margin: 0 0 16px;
}
.stars {
  color: #ff9900;
  font-size: 14px;
}
.pic {
  width: 48px;
  height: 48px;
  border-radius: 6px;
}
</style>
