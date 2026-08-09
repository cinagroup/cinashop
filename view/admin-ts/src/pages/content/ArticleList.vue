<template>
  <div>
    <el-card shadow="never">
      <template #header><div class="h"><span>CMS 文章管理</span><el-button type="primary" size="small" @click="openForm()">＋ 新增</el-button></div></template>
      <el-table :data="list" v-loading="loading" border>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="title" label="标题" min-width="200" />
        <el-table-column prop="author" label="作者" width="120" />
        <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? "发布" : "草稿" }}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="140" fixed="right"><template #default="{ row }"><el-button size="small" @click="openForm(row)">编辑</el-button><el-button size="small" type="danger" @click="del(row)">删除</el-button></template></el-table-column>
      </el-table>
    </el-card>
    <el-dialog v-model="formVisible" :title="form.id ? '编辑文章' : '新增文章'" width="640px">
      <el-form :model="form" label-width="80px">
        <el-form-item label="标题" required><el-input v-model="form.title" /></el-form-item>
        <el-form-item label="作者"><el-input v-model="form.author" /></el-form-item>
        <el-form-item label="内容"><el-input v-model="form.content" type="textarea" :rows="8" /></el-form-item>
        <el-form-item label="状态"><el-switch v-model="form.status" :active-value="1" :inactive-value="0" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="formVisible = false">取消</el-button><el-button type="primary" @click="save">保存</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import request, { getData } from "@/utils/request";
const list = ref<any[]>([]); const loading = ref(false); const formVisible = ref(false);
const form = reactive({ id: 0, title: "", author: "", content: "", status: 1 });
async function load() { loading.value = true; try { list.value = await getData(request.get("/article/list")); } catch { list.value = []; } finally { loading.value = false; } }
function openForm(row?: any) { if (row) { form.id = row.id; form.title = row.title; form.author = row.author; form.content = row.content; form.status = row.status; } else { form.id = 0; form.title = ""; form.author = ""; form.content = ""; form.status = 1; } formVisible.value = true; }
async function save() { if (!form.title) return ElMessage.error("请输入标题"); try { await getData(request.post("/article/save", { id: form.id || undefined, title: form.title, author: form.author, content: form.content, status: form.status })); ElMessage.success("保存成功"); formVisible.value = false; load(); } catch (e) { ElMessage.error((e as Error).message); } }
async function del(row: any) { try { await ElMessageBox.confirm(`删除「${row.title}」?`, "确认", { type: "warning" }); } catch { return; } try { await getData(request.delete(`/article/del/${row.id}`)); ElMessage.success("已删除"); load(); } catch (e) { ElMessage.error((e as Error).message); } }
onMounted(load);
</script>
<style scoped>.h { display: flex; align-items: center; justify-content: space-between; }</style>
