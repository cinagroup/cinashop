<template>
  <section class="asset-page">
    <header class="hero">
      <div>
        <p class="eyebrow">PRIVATE MEDIA</p>
        <h1>素材中心</h1>
        <p>图片写入私有 R2，访问链接由 Worker 临时签名；旧云存储记录仅作迁移审计。</p>
      </div>
      <div class="storage-pill">
        <span class="pulse" />{{ storage.name }} · {{ storage.binding }}
      </div>
    </header>

    <el-card shadow="never" class="toolbar-card">
      <div class="toolbar">
        <el-select v-model="query.pid" placeholder="全部分类" clearable @change="load">
          <el-option label="全部分类" :value="0" />
          <el-option v-for="item in categories" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
        <el-input v-model="query.name" clearable placeholder="搜索文件名" @keyup.enter="load" />
        <el-button @click="load">查询</el-button>
        <el-button @click="categoryDialog = true">新建分类</el-button>
        <el-upload :show-file-list="false" accept="image/jpeg,image/png,image/webp,image/gif" :http-request="upload">
          <el-button type="primary" :loading="uploading">上传图片</el-button>
        </el-upload>
      </div>
      <p class="upload-note">单张最大 10 MiB；服务端会校验文件魔数，不接受 SVG 或仅伪造 MIME 的文件。</p>
    </el-card>

    <div v-loading="loading" class="asset-grid">
      <article v-for="item in items" :key="item.att_id" class="asset-card">
        <el-image :src="item.satt_dir || item.att_dir" :preview-src-list="[item.att_dir]" fit="cover" class="preview" />
        <div class="asset-body">
          <strong :title="item.real_name">{{ item.real_name }}</strong>
          <span>{{ item.att_size }} · {{ item.time || "时间未知" }}</span>
          <el-button type="danger" link @click="remove(item)">删除</el-button>
        </div>
      </article>
      <el-empty v-if="!loading && !items.length" description="暂无图片素材" />
    </div>

    <el-pagination v-if="count > query.limit" v-model:current-page="query.page" :page-size="query.limit" :total="count" layout="prev, pager, next" @current-change="load" />

    <el-dialog v-model="categoryDialog" title="新建根分类" width="420px">
      <el-input v-model="categoryName" maxlength="50" show-word-limit placeholder="分类名称" />
      <template #footer><el-button @click="categoryDialog = false">取消</el-button><el-button type="primary" @click="createCategory">保存</el-button></template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import type { UploadRequestOptions } from "element-plus";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiAttachmentCategories,
  apiAttachmentCategoryCreate,
  apiAttachmentDelete,
  apiAttachmentList,
  apiAttachmentStorage,
  apiAttachmentUpload,
  type AttachmentCategoryItem,
  type AttachmentItem,
} from "@/api/attachment";

const items = ref<AttachmentItem[]>([]);
const categories = ref<AttachmentCategoryItem[]>([]);
const count = ref(0);
const loading = ref(false);
const uploading = ref(false);
const categoryDialog = ref(false);
const categoryName = ref("");
const storage = reactive({ name: "Cloudflare R2", binding: "ASSETS_BUCKET", configured: false, private: true });
const query = reactive({ page: 1, limit: 20, pid: 0, name: "" });

async function load() {
  loading.value = true;
  try {
    const result = await apiAttachmentList(query);
    items.value = result.list;
    count.value = result.count;
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "素材加载失败"); }
  finally { loading.value = false; }
}

async function upload(options: UploadRequestOptions) {
  uploading.value = true;
  try {
    await apiAttachmentUpload(options.file, query.pid);
    ElMessage.success("图片已安全上传");
    await load();
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "上传失败"); }
  finally { uploading.value = false; }
}

async function remove(item: AttachmentItem) {
  await ElMessageBox.confirm(`确认删除“${item.real_name}”？元数据删除后对象将由队列清理。`, "删除素材", { type: "warning" });
  await apiAttachmentDelete([item.att_id]);
  ElMessage.success("删除任务已提交");
  await load();
}

async function loadCategories() {
  categories.value = (await apiAttachmentCategories()).list;
}

async function createCategory() {
  const name = categoryName.value.trim();
  if (!name) { ElMessage.warning("请输入分类名称"); return; }
  try {
    await apiAttachmentCategoryCreate(name);
    categoryDialog.value = false;
    categoryName.value = "";
    await loadCategories();
    ElMessage.success("分类已创建");
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "分类创建失败"); }
}

onMounted(async () => {
  await Promise.all([
    load(),
    loadCategories(),
    apiAttachmentStorage().then((result) => Object.assign(storage, result.active)),
  ]);
});
</script>

<style scoped>
.asset-page { display: grid; gap: 20px; }
.hero { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 28px 32px; border-radius: 18px; color: #edf9f5; background: radial-gradient(circle at 85% 20%, rgba(211,166,82,.3), transparent 25%), linear-gradient(135deg, #102f2b, #17695f); box-shadow: 0 18px 45px rgba(16,61,55,.16); }
.hero h1 { margin: 4px 0 8px; font-size: 28px; }.hero p { margin: 0; color: rgba(237,249,245,.74); }.eyebrow { color: #e9c983 !important; font-size: 11px; font-weight: 750; letter-spacing: 3px; }
.storage-pill { flex: 0 0 auto; padding: 10px 16px; border: 1px solid rgba(255,255,255,.18); border-radius: 999px; background: rgba(255,255,255,.08); font-size: 13px; }.pulse { display: inline-block; width: 8px; height: 8px; margin-right: 8px; border-radius: 50%; background: #6de0b4; box-shadow: 0 0 0 5px rgba(109,224,180,.12); }
.toolbar-card { border: 0; border-radius: 14px; }.toolbar { display: flex; flex-wrap: wrap; gap: 10px; }.toolbar .el-select { width: 180px; }.toolbar .el-input { width: min(280px, 100%); }.upload-note { margin: 12px 0 0; color: #89938f; font-size: 12px; }
.asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 16px; min-height: 220px; }.asset-card { overflow: hidden; border: 1px solid #e8ecea; border-radius: 15px; background: #fff; box-shadow: 0 8px 24px rgba(25,52,47,.05); }.preview { width: 100%; height: 160px; background: #eef3f1; }.asset-body { display: grid; gap: 7px; padding: 14px; }.asset-body strong { overflow: hidden; color: #263d39; text-overflow: ellipsis; white-space: nowrap; }.asset-body span { color: #909a97; font-size: 12px; }.asset-body .el-button { justify-self: start; padding: 0; }
@media (max-width: 700px) { .hero { align-items: flex-start; flex-direction: column; padding: 24px; }.toolbar > * { width: 100% !important; }.asset-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }.preview { height: 125px; } }
</style>
