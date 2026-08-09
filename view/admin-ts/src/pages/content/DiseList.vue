<template>
  <div>
    <el-card shadow="never">
      <template #header><div class="h"><span>DIY 装修 / 自定义页面</span><el-button type="primary" size="small" @click="openForm()">＋ 新增页面</el-button></div></template>
      <el-table :data="list" v-loading="loading" border>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="页面名称" min-width="160" />
        <el-table-column prop="title" label="页面标题" min-width="200" />
        <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? "启用" : "停用" }}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="140" fixed="right"><template #default="{ row }"><el-button size="small" @click="openForm(row)">编辑</el-button><el-button size="small" type="danger" @click="del(row)">删除</el-button></template></el-table-column>
      </el-table>
    </el-card>
    <el-dialog v-model="formVisible" :title="form.id ? '编辑页面' : '新增页面'" width="640px">
      <el-form :model="form" label-width="80px">
        <el-form-item label="名称" required><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="标题"><el-input v-model="form.title" /></el-form-item>
        <el-form-item label="内容"><el-input v-model="form.content" type="textarea" :rows="10" placeholder="HTML/JSON 模板内容" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="form.status" :active-value="1" :inactive-value="0" /></el-form-item>
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
const form = reactive({ id: 0, name: "", title: "", content: "", status: 1 });
async function load() { loading.value = true; try { list.value = await getData(request.get("/dise/list")); } catch { list.value = []; } finally { loading.value = false; } }
function openForm(row?: any) { if (row) { form.id = row.id; form.name = row.name; form.title = row.title; form.content = row.content || ""; form.status = row.status; } else { form.id = 0; form.name = ""; form.title = ""; form.content = ""; form.status = 1; } formVisible.value = true; }
async function save() { if (!form.name) return ElMessage.error("请输入名称"); try { await getData(request.post("/dise/save", { id: form.id || undefined, name: form.name, title: form.title, content: form.content, status: form.status })); ElMessage.success("保存成功"); formVisible.value = false; load(); } catch (e) { ElMessage.error((e as Error).message); } }
async function del(row: any) { try { await ElMessageBox.confirm(`删除页面「${row.name}」?`, "确认", { type: "warning" }); } catch { return; } try { await getData(request.delete(`/dise/del/${row.id}`)); ElMessage.success("已删除"); load(); } catch (e) { ElMessage.error((e as Error).message); } }
onMounted(load);
</script>
<style scoped>.h { display: flex; align-items: center; justify-content: space-between; }</style>
