<template>
  <section class="cms-page">
    <el-card shadow="never" class="intro-card">
      <div class="intro">
        <div>
          <p class="eyebrow">CONTENT OPERATIONS</p>
          <h1>CMS 内容中心</h1>
          <p>文章、分类、封面素材与关联商品在一个工作区完成；保存后由服务端事务核验正文双表。</p>
        </div>
        <el-tag type="success" effect="plain">旧版三屏已合并</el-tag>
      </div>
    </el-card>

    <el-card shadow="never" class="workspace-card">
      <el-tabs v-model="activeTab" @tab-change="handleTabChange">
        <el-tab-pane label="文章管理" name="articles">
          <div class="toolbar">
            <div class="filters">
              <el-input v-model="articleQuery.title" clearable placeholder="搜索文章标题" @keyup.enter="searchArticles" />
              <el-select v-model="articleQuery.cid" clearable placeholder="全部分类">
                <el-option v-for="item in categories" :key="item.id" :label="item.title" :value="item.id" />
              </el-select>
              <el-select v-model="articleQuery.status" clearable placeholder="全部状态">
                <el-option label="已发布" :value="1" />
                <el-option label="草稿" :value="0" />
              </el-select>
              <el-button @click="searchArticles">查询</el-button>
            </div>
            <el-button type="primary" @click="openArticleForm()">新增文章</el-button>
          </div>

          <div class="table-scroll">
            <el-table :data="articles" v-loading="articleLoading" border class="article-table">
              <el-table-column label="文章" min-width="310">
                <template #default="{ row }">
                  <div class="article-cell">
                    <el-image :src="row.image_preview || firstCover(row.image_input)" fit="cover" class="cover" />
                    <div>
                      <strong>{{ row.title }}</strong>
                      <span>{{ row.synopsis || "暂无摘要" }}</span>
                    </div>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="分类 / 商品" min-width="190">
                <template #default="{ row }">
                  <div class="stacked-meta">
                    <span>{{ row.category_title || `分类 #${row.cid}` }}</span>
                    <small>{{ row.product_name || "未关联商品" }}</small>
                  </div>
                </template>
              </el-table-column>
              <el-table-column prop="author" label="作者" width="150" />
              <el-table-column label="运营标记" width="150">
                <template #default="{ row }">
                  <div class="tag-row">
                    <el-tag v-if="row.is_hot" size="small" type="danger">热门</el-tag>
                    <el-tag v-if="row.is_banner" size="small" type="warning">轮播</el-tag>
                    <span v-if="!row.is_hot && !row.is_banner" class="muted">普通</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="100">
                <template #default="{ row }">
                  <el-tag :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? "已发布" : "草稿" }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="浏览 / 排序" width="120">
                <template #default="{ row }"><span>{{ row.visit }} / {{ row.sort }}</span></template>
              </el-table-column>
              <el-table-column label="创建时间" width="165">
                <template #default="{ row }">{{ formatTime(row.add_time) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="145" fixed="right">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openArticleForm(row)">编辑</el-button>
                  <el-button link type="danger" @click="deleteArticle(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <el-empty v-if="!articleLoading && !articles.length" description="暂无符合条件的文章" />
          <el-pagination
            v-if="articleCount > articleQuery.limit"
            v-model:current-page="articleQuery.page"
            :page-size="articleQuery.limit"
            :total="articleCount"
            layout="prev, pager, next"
            @current-change="loadArticles"
          />
        </el-tab-pane>

        <el-tab-pane label="文章分类" name="categories">
          <div class="toolbar">
            <div class="filters category-filters">
              <el-input v-model="categoryQuery.title" clearable placeholder="搜索分类名称" @keyup.enter="searchCategories" />
              <el-select v-model="categoryQuery.status" clearable placeholder="全部状态">
                <el-option label="启用" :value="1" />
                <el-option label="停用" :value="0" />
              </el-select>
              <el-button @click="searchCategories">查询</el-button>
            </div>
            <el-button type="primary" @click="openCategoryForm()">新增分类</el-button>
          </div>
          <div class="table-scroll">
            <el-table :data="categories" v-loading="categoryLoading" border class="category-table">
              <el-table-column label="分类" min-width="260">
                <template #default="{ row }">
                  <div class="article-cell">
                    <el-image :src="row.image_preview || row.image" fit="cover" class="category-cover" />
                    <div><strong>{{ row.title }}</strong><span>{{ row.intr }}</span></div>
                  </div>
                </template>
              </el-table-column>
              <el-table-column prop="sort" label="排序" width="90" />
              <el-table-column label="状态" width="120">
                <template #default="{ row }">
                  <el-switch
                    :model-value="row.status"
                    :active-value="1"
                    :inactive-value="0"
                    :loading="categoryStatusId === row.id"
                    @change="setCategoryStatus(row, Number($event))"
                  />
                </template>
              </el-table-column>
              <el-table-column label="创建时间" width="165">
                <template #default="{ row }">{{ formatTime(row.add_time) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="145" fixed="right">
                <template #default="{ row }">
                  <el-button link type="primary" @click="openCategoryForm(row)">编辑</el-button>
                  <el-button link type="danger" @click="deleteCategory(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <el-pagination
            v-if="categoryCount > categoryQuery.limit"
            v-model:current-page="categoryQuery.page"
            :page-size="categoryQuery.limit"
            :total="categoryCount"
            layout="prev, pager, next"
            @current-change="loadCategories"
          />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-dialog v-model="articleDialog" :title="articleForm.id ? '编辑文章' : '新增文章'" width="min(920px, calc(100vw - 32px))" destroy-on-close>
      <el-form label-position="top" class="article-form">
        <div class="form-grid two-columns">
          <el-form-item label="标题" required><el-input v-model="articleForm.title" maxlength="255" show-word-limit /></el-form-item>
          <el-form-item label="作者"><el-input v-model="articleForm.author" maxlength="255" /></el-form-item>
          <el-form-item label="文章分类" required>
            <el-select v-model="articleForm.cid" placeholder="请选择分类" class="full-width">
              <el-option v-for="item in categories" :key="item.id" :label="`${item.title}${item.status ? '' : '（停用）'}`" :value="item.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="关联商品">
            <el-select
              v-model="articleForm.product_id"
              filterable remote clearable reserve-keyword
              :remote-method="loadProductOptions"
              :loading="productLoading"
              placeholder="输入商品名称搜索"
              class="full-width"
            >
              <el-option label="不关联商品" :value="0" />
              <el-option v-for="item in productOptions" :key="item.id" :label="item.name" :value="item.id" />
            </el-select>
          </el-form-item>
        </div>

        <el-form-item label="文章摘要"><el-input v-model="articleForm.synopsis" type="textarea" :rows="2" maxlength="500" show-word-limit /></el-form-item>
        <el-form-item label="封面图片" required>
          <div class="cover-field">
            <el-image v-if="articleForm.image_input" :src="articleCoverPreview || articleForm.image_input" fit="cover" class="form-cover" />
            <div class="cover-controls">
              <el-input v-model="articleForm.image_input" placeholder="HTTPS 地址或站内素材路径" @input="articleCoverPreview = ''" />
              <el-button @click="openAssets('article')">从素材库选择</el-button>
            </div>
          </div>
        </el-form-item>

        <el-form-item label="HTML 正文" required>
          <div class="editor-shell">
            <div class="editor-toolbar" aria-label="正文快捷格式">
              <el-button size="small" @click="wrapContent('<strong>', '</strong>')">加粗</el-button>
              <el-button size="small" @click="wrapContent('<h2>', '</h2>')">二级标题</el-button>
              <el-button size="small" @click="wrapContent('<p>', '</p>')">段落</el-button>
              <el-button size="small" @click="wrapContent('<ul><li>', '</li></ul>')">列表</el-button>
              <el-button size="small" @click="wrapContent('<a href=&quot;https://example.com&quot;>', '</a>')">链接</el-button>
            </div>
            <el-input
              ref="contentInput"
              v-model="articleForm.content"
              type="textarea"
              :autosize="{ minRows: 10, maxRows: 18 }"
              placeholder="可输入 HTML；脚本、事件属性和不安全链接会在服务端清理"
            />
            <small class="editor-note">最多 200,000 字符；保存时同步 system_article 与 article_content，任一读回不一致都会回滚。</small>
          </div>
        </el-form-item>

        <div class="form-grid two-columns">
          <el-form-item label="分享标题"><el-input v-model="articleForm.share_title" maxlength="255" /></el-form-item>
          <el-form-item label="分享摘要"><el-input v-model="articleForm.share_synopsis" maxlength="255" /></el-form-item>
          <el-form-item label="跳转链接"><el-input v-model="articleForm.url" maxlength="255" placeholder="可选：HTTPS 或站内路径" /></el-form-item>
          <el-form-item label="排序"><el-input-number v-model="articleForm.sort" :min="0" :max="2147483647" controls-position="right" /></el-form-item>
        </div>
        <div class="switch-row">
          <label><span>发布</span><el-switch v-model="articleForm.status" :active-value="1" :inactive-value="0" /></label>
          <label><span>热门</span><el-switch v-model="articleForm.is_hot" :active-value="1" :inactive-value="0" /></label>
          <label><span>轮播</span><el-switch v-model="articleForm.is_banner" :active-value="1" :inactive-value="0" /></label>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="articleDialog = false">取消</el-button>
        <el-button type="primary" :loading="articleSaving" @click="saveArticle">保存并核验</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="categoryDialog" :title="categoryForm.id ? '编辑分类' : '新增分类'" width="min(560px, calc(100vw - 32px))">
      <el-form label-position="top">
        <el-form-item label="分类名称" required><el-input v-model="categoryForm.title" maxlength="20" show-word-limit /></el-form-item>
        <el-form-item label="分类简介" required><el-input v-model="categoryForm.intr" type="textarea" :rows="3" maxlength="255" show-word-limit /></el-form-item>
        <el-form-item label="分类图片" required>
          <div class="cover-field compact">
            <el-image v-if="categoryForm.image" :src="categoryCoverPreview || categoryForm.image" fit="cover" class="form-cover" />
            <div class="cover-controls">
              <el-input v-model="categoryForm.image" placeholder="HTTPS 地址或站内素材路径" @input="categoryCoverPreview = ''" />
              <el-button @click="openAssets('category')">从素材库选择</el-button>
            </div>
          </div>
        </el-form-item>
        <div class="form-grid two-columns">
          <el-form-item label="排序"><el-input-number v-model="categoryForm.sort" :min="0" :max="2147483647" /></el-form-item>
          <el-form-item label="状态"><el-switch v-model="categoryForm.status" :active-value="1" :inactive-value="0" /></el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="categoryDialog = false">取消</el-button>
        <el-button type="primary" :loading="categorySaving" @click="saveCategory">保存并核验</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="assetDialog" title="选择现有图片素材" width="min(760px, calc(100vw - 32px))">
      <div class="asset-toolbar">
        <el-select v-model="assetQuery.pid" placeholder="素材分类" @change="searchAssets">
          <el-option label="未分类" :value="0" />
          <el-option v-for="item in assetCategories" :key="item.id" :label="attachmentCategoryLabel(item)" :value="item.id" />
        </el-select>
        <el-input v-model="assetQuery.name" clearable placeholder="搜索素材文件名" @keyup.enter="searchAssets" />
        <el-button @click="searchAssets">查询</el-button>
      </div>
      <div v-loading="assetLoading" class="asset-grid">
        <button v-for="item in assets" :key="item.att_id" type="button" class="asset-item" @click="chooseAsset(item)">
          <el-image :src="item.satt_dir || item.att_dir" fit="cover" />
          <strong :title="item.real_name">{{ item.real_name }}</strong>
          <span>{{ item.att_size }}</span>
        </button>
        <el-empty v-if="!assetLoading && !assets.length" description="暂无可选素材" />
      </div>
      <el-pagination
        v-if="assetCount > assetQuery.limit"
        v-model:current-page="assetQuery.page"
        :page-size="assetQuery.limit"
        :total="assetCount"
        layout="prev, pager, next"
        @current-change="loadAssets"
      />
      <p class="asset-note">这里只读取已有素材；上传与删除仍在“素材中心”按独立权限管理。</p>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { nextTick, onMounted, reactive, ref } from "vue";
import dayjs from "dayjs";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  apiArticleAttachmentCategories,
  apiArticleAttachmentOptions,
  apiArticleCategories,
  apiArticleCategoryDelete,
  apiArticleCategorySave,
  apiArticleCategoryStatus,
  apiArticleDelete,
  apiArticleDetail,
  apiArticleList,
  apiArticleProductOptions,
  apiArticleSave,
  type ArticleAttachmentCategoryOption,
  type ArticleAttachmentOption,
  type ArticleCategoryItem,
  type ArticleDetail,
  type ArticleListItem,
  type ProductOption,
} from "@/api/article";

const activeTab = ref("articles");
const articles = ref<ArticleListItem[]>([]);
const categories = ref<ArticleCategoryItem[]>([]);
const productOptions = ref<ProductOption[]>([]);
const assets = ref<ArticleAttachmentOption[]>([]);
const assetCategories = ref<ArticleAttachmentCategoryOption[]>([]);
const articleLoading = ref(false);
const categoryLoading = ref(false);
const productLoading = ref(false);
const assetLoading = ref(false);
const articleSaving = ref(false);
const categorySaving = ref(false);
const categoryStatusId = ref(0);
const articleCount = ref(0);
const categoryCount = ref(0);
const assetCount = ref(0);
const articleDialog = ref(false);
const categoryDialog = ref(false);
const assetDialog = ref(false);
const assetTarget = ref<"article" | "category">("article");
const articleCoverPreview = ref("");
const categoryCoverPreview = ref("");
const contentInput = ref<{ textarea?: HTMLTextAreaElement } | null>(null);

const articleQuery = reactive<{ page: number; limit: number; title: string; cid: number | ""; status: number | "" }>({
  page: 1, limit: 20, title: "", cid: "", status: "",
});
const categoryQuery = reactive<{ page: number; limit: number; title: string; status: number | "" }>({
  page: 1, limit: 500, title: "", status: "",
});
const assetQuery = reactive({ page: 1, limit: 20, pid: 0, name: "" });

const articleForm = reactive({
  id: 0, cid: 0, title: "", author: "", content: "", synopsis: "", status: 1,
  image_input: "", share_title: "", share_synopsis: "", sort: 0, url: "", product_id: 0,
  is_hot: 0, is_banner: 0,
});
const categoryForm = reactive({ id: 0, title: "", intr: "", image: "", status: 1, sort: 0 });

function formatTime(epoch: number) {
  return epoch > 0 ? dayjs.unix(epoch).format("YYYY-MM-DD HH:mm") : "—";
}

function firstCover(value: string) {
  return value.split(",").map((item) => item.trim()).find(Boolean) ?? "";
}

function attachmentCategoryLabel(item: ArticleAttachmentCategoryOption) {
  const labels = [item.title];
  const visited = new Set([item.id]);
  let pid = item.pid;
  while (pid > 0 && !visited.has(pid)) {
    visited.add(pid);
    const parent = assetCategories.value.find((candidate) => candidate.id === pid);
    if (!parent) break;
    labels.unshift(parent.title);
    pid = parent.pid;
  }
  return labels.join(" / ");
}

async function loadArticles() {
  articleLoading.value = true;
  try {
    const result = await apiArticleList(articleQuery);
    articles.value = result.list;
    articleCount.value = result.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "文章加载失败");
  } finally { articleLoading.value = false; }
}

async function loadCategories() {
  categoryLoading.value = true;
  try {
    const result = await apiArticleCategories(categoryQuery);
    categories.value = result.list;
    categoryCount.value = result.count;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "分类加载失败");
  } finally { categoryLoading.value = false; }
}

function searchArticles() { articleQuery.page = 1; void loadArticles(); }
function searchCategories() { categoryQuery.page = 1; void loadCategories(); }
function handleTabChange(name: string | number) { if (name === "categories") void loadCategories(); }

function resetArticleForm() {
  articleCoverPreview.value = "";
  Object.assign(articleForm, {
    id: 0, cid: categories.value.find((item) => item.status === 1)?.id ?? 0, title: "", author: "",
    content: "", synopsis: "", status: 1, image_input: "", share_title: "", share_synopsis: "",
    sort: 0, url: "", product_id: 0, is_hot: 0, is_banner: 0,
  });
}

async function openArticleForm(row?: ArticleListItem) {
  resetArticleForm();
  if (row) {
    articleLoading.value = true;
    try {
      const detail: ArticleDetail = await apiArticleDetail(row.id);
      Object.assign(articleForm, {
        id: detail.id,
        cid: detail.cid,
        title: detail.title,
        author: detail.author,
        content: detail.content,
        synopsis: detail.synopsis,
        status: detail.status,
        image_input: detail.image_input,
        share_title: detail.share_title,
        share_synopsis: detail.share_synopsis,
        sort: detail.sort,
        url: detail.url,
        product_id: detail.product_id,
        is_hot: detail.is_hot,
        is_banner: detail.is_banner,
      });
      articleCoverPreview.value = detail.image_preview ?? "";
      if (detail.product_id && detail.product_name) {
        productOptions.value = [{ id: detail.product_id, name: detail.product_name, image: "", is_show: 1 }];
      }
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : "文章详情加载失败");
      return;
    } finally { articleLoading.value = false; }
  }
  articleDialog.value = true;
}

async function saveArticle() {
  if (!articleForm.title.trim()) return ElMessage.error("请输入标题");
  if (!articleForm.cid) return ElMessage.error("请选择文章分类");
  if (!articleForm.image_input.trim()) return ElMessage.error("请选择文章封面");
  if (!articleForm.content.trim()) return ElMessage.error("请输入文章正文");
  articleSaving.value = true;
  try {
    const result = await apiArticleSave({
      ...articleForm,
      id: articleForm.id || undefined,
    });
    if (!result.verified) throw new Error("服务端未完成保存核验");
    ElMessage.success("文章已保存并完成双表核验");
    articleDialog.value = false;
    await loadArticles();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "文章保存失败");
  } finally { articleSaving.value = false; }
}

async function deleteArticle(row: ArticleListItem) {
  try { await ElMessageBox.confirm(`删除文章「${row.title}」？删除后前台将立即不可见。`, "确认删除", { type: "warning" }); }
  catch { return; }
  try {
    const result = await apiArticleDelete(row.id);
    if (!result.verified) throw new Error("服务端未完成删除核验");
    ElMessage.success("文章已安全删除");
    await loadArticles();
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "文章删除失败"); }
}

function openCategoryForm(row?: ArticleCategoryItem) {
  Object.assign(categoryForm, row
    ? { id: row.id, title: row.title, intr: row.intr, image: row.image, status: row.status, sort: row.sort }
    : { id: 0, title: "", intr: "", image: "", status: 1, sort: 0 });
  categoryCoverPreview.value = row?.image_preview ?? "";
  categoryDialog.value = true;
}

async function saveCategory() {
  if (!categoryForm.title.trim()) return ElMessage.error("请输入分类名称");
  if (!categoryForm.intr.trim()) return ElMessage.error("请输入分类简介");
  if (!categoryForm.image.trim()) return ElMessage.error("请选择分类图片");
  categorySaving.value = true;
  try {
    const result = await apiArticleCategorySave({
      title: categoryForm.title,
      intr: categoryForm.intr,
      image: categoryForm.image,
      status: categoryForm.status,
      sort: categoryForm.sort,
    }, categoryForm.id);
    if (!result.verified) throw new Error("服务端未完成分类核验");
    ElMessage.success("分类已保存并核验");
    categoryDialog.value = false;
    await loadCategories();
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "分类保存失败"); }
  finally { categorySaving.value = false; }
}

async function setCategoryStatus(row: ArticleCategoryItem, status: number) {
  categoryStatusId.value = row.id;
  try {
    const result = await apiArticleCategoryStatus(row.id, status);
    if (!result.verified) throw new Error("服务端未完成状态核验");
    row.status = status;
    ElMessage.success(status ? "分类已启用" : "分类已停用");
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "分类状态更新失败"); }
  finally { categoryStatusId.value = 0; }
}

async function deleteCategory(row: ArticleCategoryItem) {
  try { await ElMessageBox.confirm(`删除分类「${row.title}」？分类下存在文章时服务端会拒绝。`, "确认删除", { type: "warning" }); }
  catch { return; }
  try {
    const result = await apiArticleCategoryDelete(row.id);
    if (!result.verified) throw new Error("服务端未完成删除核验");
    ElMessage.success("分类已安全删除");
    await loadCategories();
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "分类删除失败"); }
}

async function loadProductOptions(keyword = "") {
  productLoading.value = true;
  try { productOptions.value = await apiArticleProductOptions(keyword); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "商品候选加载失败"); }
  finally { productLoading.value = false; }
}

async function openAssets(target: "article" | "category") {
  assetTarget.value = target;
  assetQuery.page = 1;
  assetQuery.name = "";
  assetDialog.value = true;
  try {
    const result = await apiArticleAttachmentCategories(0);
    assetCategories.value = result.list;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "素材分类加载失败");
  }
  await loadAssets();
}

async function loadAssets() {
  assetLoading.value = true;
  try {
    const result = await apiArticleAttachmentOptions(assetQuery);
    assets.value = result.list;
    assetCount.value = result.count;
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "素材加载失败"); }
  finally { assetLoading.value = false; }
}

function searchAssets() { assetQuery.page = 1; void loadAssets(); }
function chooseAsset(item: ArticleAttachmentOption) {
  if (assetTarget.value === "article") {
    articleForm.image_input = item.att_dir;
    articleCoverPreview.value = item.satt_dir || item.att_dir;
  } else {
    categoryForm.image = item.att_dir;
    categoryCoverPreview.value = item.satt_dir || item.att_dir;
  }
  assetDialog.value = false;
  ElMessage.success("已选择素材");
}

async function wrapContent(before: string, after: string) {
  const textarea = contentInput.value?.textarea;
  const start = textarea?.selectionStart ?? articleForm.content.length;
  const end = textarea?.selectionEnd ?? start;
  const selection = articleForm.content.slice(start, end) || "正文";
  articleForm.content = `${articleForm.content.slice(0, start)}${before}${selection}${after}${articleForm.content.slice(end)}`;
  await nextTick();
  const cursor = start + before.length + selection.length + after.length;
  textarea?.focus();
  textarea?.setSelectionRange(cursor, cursor);
}

onMounted(async () => {
  await Promise.all([loadCategories(), loadArticles()]);
});
</script>

<style scoped>
.cms-page { display: grid; gap: 16px; color: #243047; }
.intro-card { border: 1px solid #dce6f5; background: linear-gradient(135deg, #f7fbff 0%, #f3f8ff 58%, #fffaf2 100%); }
.intro { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
.intro h1 { margin: 3px 0 8px; font-size: 26px; color: #17233b; }
.intro p { margin: 0; color: #65738b; line-height: 1.65; }
.eyebrow { color: #3976cf !important; font-size: 12px; font-weight: 700; letter-spacing: .12em; }
.workspace-card { min-width: 0; }
.toolbar, .filters { display: flex; align-items: center; gap: 10px; }
.toolbar { justify-content: space-between; margin-bottom: 16px; }
.filters .el-input { width: 220px; }
.filters .el-select { width: 150px; }
.category-filters .el-input { width: 260px; }
.table-scroll { max-width: 100%; overflow-x: auto; }
.article-table { min-width: 1190px; }
.category-table { min-width: 760px; }
.article-cell { display: flex; align-items: center; gap: 12px; min-width: 0; }
.article-cell > div { display: grid; min-width: 0; gap: 4px; }
.article-cell strong { color: #26344f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.article-cell span { color: #7b879c; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cover, .category-cover { flex: 0 0 auto; border-radius: 7px; background: #edf2f8; }
.cover { width: 66px; height: 48px; }
.category-cover { width: 48px; height: 48px; }
.stacked-meta { display: grid; gap: 5px; }
.stacked-meta small, .muted { color: #8a95a8; }
.tag-row { display: flex; gap: 5px; flex-wrap: wrap; }
.form-grid { display: grid; gap: 0 18px; }
.two-columns { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.full-width { width: 100%; }
.cover-field { display: flex; align-items: stretch; width: 100%; gap: 12px; }
.form-cover { width: 120px; height: 82px; flex: 0 0 auto; border-radius: 8px; background: #edf2f8; }
.cover-controls { flex: 1; display: grid; align-content: center; gap: 8px; min-width: 0; }
.cover-controls .el-button { justify-self: start; }
.editor-shell { width: 100%; border: 1px solid #dfe5ee; border-radius: 8px; overflow: hidden; }
.editor-toolbar { display: flex; flex-wrap: wrap; gap: 6px; padding: 9px; background: #f6f8fb; border-bottom: 1px solid #dfe5ee; }
.editor-shell :deep(.el-textarea__inner) { border: 0; border-radius: 0; box-shadow: none; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; line-height: 1.6; }
.editor-note { display: block; padding: 8px 12px; color: #78859b; background: #fafbfd; }
.switch-row { display: flex; gap: 28px; padding: 3px 0 8px; }
.switch-row label { display: flex; align-items: center; gap: 10px; color: #506079; }
.asset-toolbar { display: flex; gap: 10px; margin-bottom: 14px; }
.asset-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; min-height: 180px; }
.asset-item { display: grid; gap: 6px; min-width: 0; padding: 8px; text-align: left; color: #43516a; border: 1px solid #dfe6f0; border-radius: 9px; background: #fff; cursor: pointer; }
.asset-item:hover { border-color: #409eff; box-shadow: 0 4px 14px rgb(34 86 150 / 10%); }
.asset-item .el-image { width: 100%; aspect-ratio: 4 / 3; border-radius: 6px; background: #edf2f8; }
.asset-item strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asset-item span, .asset-note { color: #7b879c; font-size: 12px; }
.asset-note { margin: 12px 0 0; }
.el-pagination { justify-content: flex-end; margin-top: 16px; }

@media (max-width: 760px) {
  .intro { display: grid; gap: 12px; }
  .intro h1 { font-size: 22px; }
  .toolbar { align-items: stretch; flex-direction: column; }
  .filters { display: grid; grid-template-columns: 1fr 1fr; }
  .filters .el-input, .filters .el-select, .category-filters .el-input { width: 100%; }
  .filters .el-input { grid-column: 1 / -1; }
  .toolbar > .el-button { width: 100%; }
  .two-columns { grid-template-columns: 1fr; }
  .cover-field { flex-direction: column; }
  .cover-field.compact { flex-direction: row; }
  .form-cover { width: 100%; height: 140px; }
  .compact .form-cover { width: 92px; height: 76px; }
  .switch-row { justify-content: space-between; gap: 10px; }
  .asset-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .el-pagination { justify-content: center; overflow-x: auto; }
}
</style>
