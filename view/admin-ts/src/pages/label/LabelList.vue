<template>
  <div class="label-page">
    <el-tabs v-model="activeTab">
      <el-tab-pane label="商品标签" name="product">
        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <span>商品标签</span>
              <el-button type="primary" size="small" @click="openForm()">＋ 新增标签</el-button>
            </div>
          </template>
          <el-table :data="list" v-loading="loading" border>
            <el-table-column prop="id" label="ID" width="70" />
            <el-table-column label="标签名" min-width="140">
              <template #default="{ row }">
                <el-tag :style="{ background: row.bgColor || '#fff', color: row.color || '#333', borderColor: row.borderColor || '#ddd' }">
                  {{ row.labelName }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="sort" label="排序" width="80" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? "启用" : "停用" }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="140" fixed="right">
              <template #default="{ row }">
                <el-button size="small" @click="openForm(row)">编辑</el-button>
                <el-button size="small" type="danger" @click="del(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="用户标签" name="user">
        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <span>用户标签</span>
              <el-button type="primary" size="small" @click="openUserForm()">＋ 新增标签</el-button>
            </div>
          </template>
          <el-table :data="userList" v-loading="userLoading" border>
            <el-table-column prop="id" label="ID" width="70" />
            <el-table-column label="标签名" min-width="140">
              <template #default="{ row }">
                <el-tag :style="{ color: row.color || '#e93323', borderColor: row.color || '#e93323' }">{{ row.name }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="sort" label="排序" width="80" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? "启用" : "停用" }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="140" fixed="right">
              <template #default="{ row }">
                <el-button size="small" @click="openUserForm(row)">编辑</el-button>
                <el-button size="small" type="danger" @click="delUser(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <!-- 商品标签弹窗 -->
    <el-dialog v-model="formVisible" :title="form.id ? '编辑标签' : '新增标签'" width="420px">
      <el-form :model="form" label-width="80px">
        <el-form-item label="标签名" required><el-input v-model="form.labelName" /></el-form-item>
        <el-form-item label="文字颜色"><el-color-picker v-model="form.color" /></el-form-item>
        <el-form-item label="背景色"><el-color-picker v-model="form.bgColor" /></el-form-item>
        <el-form-item label="排序"><el-input-number v-model="form.sort" :min="0" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="form.status" :active-value="1" :inactive-value="0" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- 用户标签弹窗 -->
    <el-dialog v-model="userFormVisible" :title="userForm.id ? '编辑标签' : '新增标签'" width="420px">
      <el-form :model="userForm" label-width="80px">
        <el-form-item label="标签名" required><el-input v-model="userForm.name" /></el-form-item>
        <el-form-item label="颜色"><el-color-picker v-model="userForm.color" /></el-form-item>
        <el-form-item label="排序"><el-input-number v-model="userForm.sort" :min="0" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="userForm.status" :active-value="1" :inactive-value="0" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="userFormVisible = false">取消</el-button>
        <el-button type="primary" @click="saveUser">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import request, { getData } from "@/utils/request";

const activeTab = ref("product");

// ── 商品标签 ──
const list = ref<any[]>([]);
const loading = ref(false);
const formVisible = ref(false);
const form = reactive({ id: 0, labelName: "", color: "#e93323", bgColor: "#fff5f4", sort: 0, status: 1 });

async function loadLabels() {
  loading.value = true;
  try { list.value = await getData(request.get("/product_label/list")); } catch { list.value = []; } finally { loading.value = false; }
}
function openForm(row?: any) {
  if (row) { form.id = row.id; form.labelName = row.labelName; form.color = row.color || "#e93323"; form.bgColor = row.bgColor || "#fff5f4"; form.sort = row.sort; form.status = row.status; }
  else { form.id = 0; form.labelName = ""; form.color = "#e93323"; form.bgColor = "#fff5f4"; form.sort = 0; form.status = 1; }
  formVisible.value = true;
}
async function save() {
  if (!form.labelName) return ElMessage.error("请输入标签名");
  try { await getData(request.post("/product_label/save", { id: form.id || undefined, labelName: form.labelName, color: form.color, bgColor: form.bgColor, sort: form.sort, status: form.status })); ElMessage.success("保存成功"); formVisible.value = false; loadLabels(); } catch (e) { ElMessage.error((e as Error).message); }
}
async function del(row: any) {
  try { await ElMessageBox.confirm(`删除标签「${row.labelName}」?`, "确认", { type: "warning" }); } catch { return; }
  try { await getData(request.delete(`/product_label/del/${row.id}`)); ElMessage.success("已删除"); loadLabels(); } catch (e) { ElMessage.error((e as Error).message); }
}

// ── 用户标签 ──
const userList = ref<any[]>([]);
const userLoading = ref(false);
const userFormVisible = ref(false);
const userForm = reactive({ id: 0, name: "", color: "#e93323", sort: 0, status: 1 });

async function loadUserLabels() {
  userLoading.value = true;
  try { userList.value = await getData(request.get("/user_label/list")); } catch { userList.value = []; } finally { userLoading.value = false; }
}
function openUserForm(row?: any) {
  if (row) { userForm.id = row.id; userForm.name = row.name; userForm.color = row.color || "#e93323"; userForm.sort = row.sort; userForm.status = row.status; }
  else { userForm.id = 0; userForm.name = ""; userForm.color = "#e93323"; userForm.sort = 0; userForm.status = 1; }
  userFormVisible.value = true;
}
async function saveUser() {
  if (!userForm.name) return ElMessage.error("请输入标签名");
  try { await getData(request.post("/user_label/save", { id: userForm.id || undefined, name: userForm.name, color: userForm.color, sort: userForm.sort, status: userForm.status })); ElMessage.success("保存成功"); userFormVisible.value = false; loadUserLabels(); } catch (e) { ElMessage.error((e as Error).message); }
}
async function delUser(row: any) {
  try { await ElMessageBox.confirm(`删除标签「${row.name}」?`, "确认", { type: "warning" }); } catch { return; }
  try { await getData(request.delete(`/user_label/del/${row.id}`)); ElMessage.success("已删除"); loadUserLabels(); } catch (e) { ElMessage.error((e as Error).message); }
}

watch(activeTab, (v) => { if (v === "user" && !userList.value.length) loadUserLabels(); });
onMounted(loadLabels);
</script>

<style scoped>
.card-head { display: flex; align-items: center; justify-content: space-between; }
</style>
