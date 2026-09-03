import request, { getData } from "@/utils/request";

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

export interface ArticleCategoryItem {
  id: number;
  pid: number;
  title: string;
  intr: string;
  image: string;
  image_preview?: string;
  status: number;
  sort: number;
  hidden: number;
  add_time: number;
}

export interface ArticleListItem {
  id: number;
  cid: number;
  category_title: string | null;
  title: string;
  author: string;
  synopsis: string;
  status: number;
  add_time: number;
  image_input: string;
  image_preview?: string;
  visit: number;
  sort: number;
  product_id: number;
  product_name: string | null;
  is_hot: number;
  is_banner: number;
}

export interface ArticleDetail extends ArticleListItem {
  content: string;
  share_title: string;
  share_synopsis: string;
  likes: number;
  url: string;
}

export interface ArticleInput {
  id?: number;
  cid: number;
  title: string;
  author: string;
  content: string;
  synopsis: string;
  status: number;
  image_input: string;
  share_title: string;
  share_synopsis: string;
  sort: number;
  url: string;
  product_id: number;
  is_hot: number;
  is_banner: number;
}

export interface ArticleCategoryInput {
  title: string;
  intr: string;
  image: string;
  status: number;
  sort: number;
}

export interface ProductOption {
  id: number;
  name: string;
  image: string;
  image_preview?: string;
  is_show: number;
}

export interface ArticleAttachmentOption {
  att_id: number;
  att_dir: string;
  satt_dir: string;
  att_size: string;
  real_name: string;
}

export interface ArticleAttachmentCategoryOption {
  id: number;
  pid: number;
  title: string;
}

const previewCategories: ArticleCategoryItem[] = [
  { id: 2, pid: 0, title: "运营指南", intr: "店铺运营、选品和活动指南", image: "/logo.png", status: 1, sort: 20, hidden: 0, add_time: 1_786_000_000 },
  { id: 1, pid: 0, title: "平台公告", intr: "平台规则与服务更新", image: "/logo.png", status: 1, sort: 10, hidden: 0, add_time: 1_785_000_000 },
];

const previewArticles: ArticleDetail[] = [
  {
    id: 18, cid: 2, category_title: "运营指南", title: "秋季上新运营指南", author: "CinaShop 运营团队",
    synopsis: "从选品、素材到活动节奏，完成一次可复用的上新计划。", status: 1, add_time: 1_788_000_000,
    image_input: "/logo.png", visit: 286, sort: 30, product_id: 120, product_name: "示例关联商品",
    is_hot: 1, is_banner: 1, content: "<h2>上新准备</h2><p>先确认库存、主图与履约范围，再安排活动节奏。</p>",
    share_title: "秋季上新运营指南", share_synopsis: "一份可直接执行的上新清单", likes: 32, url: "",
  },
  {
    id: 17, cid: 1, category_title: "平台公告", title: "服务时间调整公告", author: "平台服务中心",
    synopsis: "本周末客服在线时间调整说明。", status: 0, add_time: 1_787_000_000,
    image_input: "/logo.png", visit: 46, sort: 10, product_id: 0, product_name: null,
    is_hot: 0, is_banner: 0, content: "<p>本周末客服在线时间将临时调整，订单履约不受影响。</p>",
    share_title: "", share_synopsis: "", likes: 3, url: "",
  },
];

const previewProducts: ProductOption[] = [
  { id: 120, name: "示例关联商品", image: "/logo.png", is_show: 1 },
  { id: 116, name: "秋季限定礼盒", image: "/logo.png", is_show: 1 },
];

function previewFilteredArticles(params: Record<string, unknown>) {
  const title = String(params.title ?? "").trim().toLowerCase();
  const cid = Number(params.cid ?? 0);
  const status = params.status === "" || params.status === undefined ? null : Number(params.status);
  return previewArticles.filter((item) =>
    (!title || item.title.toLowerCase().includes(title))
    && (!cid || item.cid === cid)
    && (status === null || item.status === status)
  );
}

export async function apiArticleList(params: Record<string, unknown>) {
  if (previewMode) {
    const filtered = previewFilteredArticles(params);
    return { list: filtered, count: filtered.length, page: 1, limit: 20 };
  }
  return getData<{ list: ArticleListItem[]; count: number; page: number; limit: number }>(
    request.get("/article/list", { params }),
  );
}

export async function apiArticleDetail(id: number) {
  if (previewMode) {
    const item = previewArticles.find((article) => article.id === id);
    if (!item) throw new Error("文章不存在");
    return { ...item };
  }
  return getData<ArticleDetail>(request.get(`/article/detail/${id}`));
}

export async function apiArticleSave(input: ArticleInput) {
  if (previewMode) {
    const category = previewCategories.find((item) => item.id === input.cid);
    const product = previewProducts.find((item) => item.id === input.product_id);
    const existing = input.id ? previewArticles.find((item) => item.id === input.id) : undefined;
    const article: ArticleDetail = {
      ...(existing ?? { id: Date.now(), add_time: Math.floor(Date.now() / 1_000), visit: 0, likes: 0 }),
      ...input,
      id: existing?.id ?? Date.now(),
      category_title: category?.title ?? null,
      product_name: product?.name ?? null,
    };
    if (existing) Object.assign(existing, article); else previewArticles.unshift(article);
    return { article, verified: true as const };
  }
  return getData<{ article: ArticleDetail; verified: true }>(request.post("/article/save", input));
}

export async function apiArticleDelete(id: number) {
  if (previewMode) {
    const index = previewArticles.findIndex((item) => item.id === id);
    if (index >= 0) previewArticles.splice(index, 1);
    return { id, deleted: true, verified: true };
  }
  return getData<{ id: number; deleted: true; verified: true }>(request.delete(`/article/del/${id}`));
}

export async function apiArticleCategories(params: Record<string, unknown> = {}) {
  if (previewMode) {
    const title = String(params.title ?? "").trim().toLowerCase();
    const status = params.status === "" || params.status === undefined ? null : Number(params.status);
    const list = previewCategories.filter((item) =>
      (!title || item.title.toLowerCase().includes(title)) && (status === null || item.status === status)
    );
    return { list, count: list.length, page: 1, limit: 500 };
  }
  return getData<{ list: ArticleCategoryItem[]; count: number; page: number; limit: number }>(
    request.get("/article/category", { params }),
  );
}

export async function apiArticleCategorySave(input: ArticleCategoryInput, id = 0) {
  if (previewMode) {
    const existing = id ? previewCategories.find((item) => item.id === id) : undefined;
    const category: ArticleCategoryItem = {
      ...(existing ?? { id: Date.now(), pid: 0, hidden: 0, add_time: Math.floor(Date.now() / 1_000) }),
      ...input,
    };
    if (existing) Object.assign(existing, category); else previewCategories.unshift(category);
    return { category, verified: true as const };
  }
  return getData<{ category: ArticleCategoryItem; verified: true }>(
    id ? request.put(`/article/category/${id}`, input) : request.post("/article/category", input),
  );
}

export async function apiArticleCategoryStatus(id: number, status: number) {
  if (previewMode) {
    const category = previewCategories.find((item) => item.id === id);
    if (category) category.status = status;
    return { id, status, verified: true as const };
  }
  return getData<{ id: number; status: number; verified: true }>(
    request.put(`/article/category/${id}/status`, { status }),
  );
}

export async function apiArticleCategoryDelete(id: number) {
  if (previewMode) {
    if (previewArticles.some((item) => item.cid === id)) throw new Error("该分类下仍有文章，不能删除");
    const index = previewCategories.findIndex((item) => item.id === id);
    if (index >= 0) previewCategories.splice(index, 1);
    return { id, deleted: true, verified: true as const };
  }
  return getData<{ id: number; deleted: true; verified: true }>(request.delete(`/article/category/${id}`));
}

export async function apiArticleProductOptions(keyword = "") {
  if (previewMode) return previewProducts.filter((item) => item.name.includes(keyword));
  return getData<ProductOption[]>(request.get("/article/product-options", { params: { keyword, limit: 30 } }));
}

export async function apiArticleAttachmentOptions(params: Record<string, unknown>) {
  if (previewMode) {
    const list: ArticleAttachmentOption[] = [
      { att_id: 31, att_dir: "/logo.png", satt_dir: "/logo.png", att_size: "48.2 KiB", real_name: "cinashop-brand.png" },
      { att_id: 30, att_dir: "/favicon.ico", satt_dir: "/favicon.ico", att_size: "2.1 KiB", real_name: "storefront-reference.ico" },
    ];
    return { list, count: list.length };
  }
  return getData<{ list: ArticleAttachmentOption[]; count: number }>(
    request.get("/article/attachment-options", { params }),
  );
}

export async function apiArticleAttachmentCategories(pid = 0) {
  if (previewMode) {
    return { list: [{ id: 9, pid: 0, title: "文章封面" }] satisfies ArticleAttachmentCategoryOption[] };
  }
  return getData<{ list: ArticleAttachmentCategoryOption[] }>(
    request.get("/article/attachment-categories", { params: { pid } }),
  );
}
