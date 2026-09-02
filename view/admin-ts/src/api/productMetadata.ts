import request, { getData } from "@/utils/request";

export interface ProductUnit {
  id: number;
  name: string;
  sort: number;
  status: number;
  add_time: number;
}

export interface ProductEnsure {
  id: number;
  name: string;
  image: string;
  desc: string;
  sort: number;
  status: number;
  add_time: number;
}

export interface ProductRuleDimension {
  value: string;
  detail: string[];
}

export interface ProductRuleTemplate {
  id: number;
  rule_name: string;
  rule_value: string | null;
  attr_name: string;
  attr_value: string[];
  spec: ProductRuleDimension[];
}

export interface ProductParameter {
  id?: number;
  name: string;
  value: string;
  sort: number;
  status: number;
}

export interface ProductParameterTemplate {
  id: number;
  name: string;
  sort: number;
  add_time: number;
  specs: ProductParameter[];
}

export interface ProductWord {
  id: number;
  name: string;
  color: string;
  bg_color: string;
  border_color: string;
  icon: string;
  is_show: number;
  sort: number;
  is_search: number;
  add_time: number;
}

export interface PagedResult<T> {
  list: T[];
  count: number;
  page: number;
  limit: number;
}

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

let previewUnits: ProductUnit[] = [
  { id: 1, name: "件", sort: 30, status: 1, add_time: 1_788_210_000 },
  { id: 2, name: "盒", sort: 20, status: 1, add_time: 1_788_210_100 },
];
let previewEnsures: ProductEnsure[] = [
  {
    id: 1,
    name: "七天无理由",
    image: "https://placehold.co/80x80/png?text=7D",
    desc: "商品完好且不影响二次销售时支持退货。",
    sort: 30,
    status: 1,
    add_time: 1_788_210_200,
  },
  {
    id: 2,
    name: "正品保障",
    image: "https://placehold.co/80x80/png?text=OK",
    desc: "平台承诺商品来源真实可追溯。",
    sort: 20,
    status: 0,
    add_time: 1_788_210_300,
  },
];
let previewRules: ProductRuleTemplate[] = [
  {
    id: 1,
    rule_name: "服装颜色尺码",
    rule_value: null,
    attr_name: "颜色,尺码",
    attr_value: ["黑色,白色", "S,M,L"],
    spec: [
      { value: "颜色", detail: ["黑色", "白色"] },
      { value: "尺码", detail: ["S", "M", "L"] },
    ],
  },
  {
    id: 2,
    rule_name: "杯壶容量",
    rule_value: null,
    attr_name: "颜色,容量",
    attr_value: ["蓝色,灰色", "350ml,500ml"],
    spec: [
      { value: "颜色", detail: ["蓝色", "灰色"] },
      { value: "容量", detail: ["350ml", "500ml"] },
    ],
  },
];
let previewParameterTemplates: ProductParameterTemplate[] = [
  {
    id: 1,
    name: "服装基础参数",
    sort: 30,
    add_time: 1_788_210_400,
    specs: [
      { id: 1, name: "材质", value: "棉", sort: 30, status: 1 },
      { id: 2, name: "适用季节", value: "四季", sort: 20, status: 1 },
    ],
  },
];
let previewWords: ProductWord[] = [
  {
    id: 1,
    name: "新品上市",
    color: "#ffffff",
    bg_color: "#409eff",
    border_color: "#337ecc",
    icon: "",
    is_show: 1,
    sort: 30,
    is_search: 1,
    add_time: 1_788_210_500,
  },
  {
    id: 2,
    name: "限时优惠",
    color: "#f56c6c",
    bg_color: "#fef0f0",
    border_color: "#fab6b6",
    icon: "",
    is_show: 0,
    sort: 20,
    is_search: 1,
    add_time: 1_788_210_600,
  },
];

function previewPage<T extends { name: string }>(
  source: T[],
  params: { page?: number; limit?: number; name?: string },
): PagedResult<T> {
  const page = Math.max(1, Number(params.page) || 1);
  const limit = Math.max(1, Number(params.limit) || 20);
  const keyword = params.name?.trim().toLowerCase() ?? "";
  const filtered = keyword
    ? source.filter((item) => item.name.toLowerCase().includes(keyword))
    : source;
  return {
    list: filtered.slice((page - 1) * limit, page * limit).map((item) => ({ ...item })),
    count: filtered.length,
    page,
    limit,
  };
}

export function apiProductUnitList(params: {
  page?: number;
  limit?: number;
  name?: string;
}): Promise<PagedResult<ProductUnit>> {
  if (previewMode) return Promise.resolve(previewPage(previewUnits, params));
  return getData(request.get("/unit", { params }));
}

export function apiProductUnitSave(
  id: number,
  data: { name: string; sort: number },
): Promise<{ id: number }> {
  if (previewMode) {
    if (id) {
      previewUnits = previewUnits.map((item) => item.id === id ? { ...item, ...data } : item);
      return Promise.resolve({ id });
    }
    const nextId = Math.max(0, ...previewUnits.map((item) => item.id)) + 1;
    previewUnits.unshift({ id: nextId, ...data, status: 1, add_time: Math.floor(Date.now() / 1000) });
    return Promise.resolve({ id: nextId });
  }
  return id
    ? getData(request.put(`/unit/${id}`, data))
    : getData(request.post("/unit", data));
}

export function apiProductUnitDelete(id: number): Promise<null> {
  if (previewMode) {
    previewUnits = previewUnits.filter((item) => item.id !== id);
    return Promise.resolve(null);
  }
  return getData(request.delete(`/unit/${id}`));
}

export function apiProductEnsureList(params: {
  page?: number;
  limit?: number;
  name?: string;
}): Promise<PagedResult<ProductEnsure>> {
  if (previewMode) return Promise.resolve(previewPage(previewEnsures, params));
  return getData(request.get("/product/ensure", { params }));
}

export function apiProductEnsureSave(
  id: number,
  data: { name: string; image: string; desc: string; sort: number; status: number },
): Promise<{ id: number }> {
  if (previewMode) {
    if (id) {
      previewEnsures = previewEnsures.map((item) => item.id === id ? { ...item, ...data } : item);
      return Promise.resolve({ id });
    }
    const nextId = Math.max(0, ...previewEnsures.map((item) => item.id)) + 1;
    previewEnsures.unshift({ id: nextId, ...data, add_time: Math.floor(Date.now() / 1000) });
    return Promise.resolve({ id: nextId });
  }
  return id
    ? getData(request.put(`/product/ensure/${id}`, data))
    : getData(request.post("/product/ensure", data));
}

export function apiProductEnsureStatus(id: number, status: number): Promise<null> {
  if (previewMode) {
    previewEnsures = previewEnsures.map((item) => item.id === id ? { ...item, status } : item);
    return Promise.resolve(null);
  }
  return getData(request.put(`/product/ensure/set_show/${id}/${status}`));
}

export function apiProductEnsureDelete(id: number): Promise<null> {
  if (previewMode) {
    previewEnsures = previewEnsures.filter((item) => item.id !== id);
    return Promise.resolve(null);
  }
  return getData(request.delete(`/product/ensure/${id}`));
}

export function apiProductRuleList(params: {
  page?: number;
  limit?: number;
  rule_name?: string;
}): Promise<PagedResult<ProductRuleTemplate>> {
  if (previewMode) {
    return Promise.resolve(previewPage(
      previewRules.map((item) => ({ ...item, name: item.rule_name })),
      { ...params, name: params.rule_name },
    )).then(({ list, ...page }) => ({
      ...page,
      list: list.map(({ name: _name, ...item }) => item),
    })) as Promise<PagedResult<ProductRuleTemplate>>;
  }
  return getData(request.get("/product/rule", { params }));
}

export function apiProductRuleDetail(id: number): Promise<ProductRuleTemplate> {
  if (previewMode) {
    const item = previewRules.find((row) => row.id === id);
    if (!item) return Promise.reject(new Error("规格模板不存在"));
    return Promise.resolve(structuredClone(item));
  }
  return getData<{ info: ProductRuleTemplate }>(request.get(`/product/rule/${id}`))
    .then((result) => result.info);
}

export function apiProductRuleSave(
  id: number,
  data: { rule_name: string; spec: ProductRuleDimension[] },
): Promise<{ id: number }> {
  if (previewMode) {
    const nextId = id || Math.max(0, ...previewRules.map((item) => item.id)) + 1;
    const row: ProductRuleTemplate = {
      id: nextId,
      rule_name: data.rule_name,
      rule_value: JSON.stringify(data.spec),
      attr_name: data.spec.map((item) => item.value).join(","),
      attr_value: data.spec.map((item) => item.detail.join(",")),
      spec: structuredClone(data.spec),
    };
    previewRules = id
      ? previewRules.map((item) => item.id === id ? row : item)
      : [row, ...previewRules];
    return Promise.resolve({ id: nextId });
  }
  return getData(request.post(`/product/rule/${id}`, data));
}

export function apiProductRuleDelete(id: number): Promise<null> {
  if (previewMode) {
    previewRules = previewRules.filter((item) => item.id !== id);
    return Promise.resolve(null);
  }
  return getData(request.delete(`/product/rule/delete/${id}`));
}

export function apiProductParameterTemplateList(params: {
  page?: number;
  limit?: number;
  name?: string;
}): Promise<PagedResult<ProductParameterTemplate>> {
  if (previewMode) return Promise.resolve(previewPage(previewParameterTemplates, params));
  return getData(request.get("/specs", { params }));
}

export function apiProductParameterTemplateDetail(
  id: number,
): Promise<ProductParameterTemplate> {
  if (previewMode) {
    const item = previewParameterTemplates.find((row) => row.id === id);
    if (!item) return Promise.reject(new Error("参数模板不存在"));
    return Promise.resolve(structuredClone(item));
  }
  return getData(request.get(`/specs/${id}`));
}

export function apiProductParameterTemplateSave(
  id: number,
  data: { name: string; sort: number; specs: ProductParameter[] },
): Promise<{ id: number }> {
  if (previewMode) {
    const nextId = id || Math.max(0, ...previewParameterTemplates.map((item) => item.id)) + 1;
    const existing = previewParameterTemplates.find((item) => item.id === id);
    const row: ProductParameterTemplate = {
      id: nextId,
      name: data.name,
      sort: data.sort,
      add_time: existing?.add_time ?? Math.floor(Date.now() / 1000),
      specs: structuredClone(data.specs),
    };
    previewParameterTemplates = id
      ? previewParameterTemplates.map((item) => item.id === id ? row : item)
      : [row, ...previewParameterTemplates];
    return Promise.resolve({ id: nextId });
  }
  return getData(request.post(`/specs/${id}`, data));
}

export function apiProductParameterTemplateDelete(id: number): Promise<null> {
  if (previewMode) {
    previewParameterTemplates = previewParameterTemplates.filter((item) => item.id !== id);
    return Promise.resolve(null);
  }
  return getData(request.delete(`/specs/${id}`));
}

export function apiProductWordList(params: {
  page?: number;
  limit?: number;
  name?: string;
}): Promise<PagedResult<ProductWord>> {
  if (previewMode) return Promise.resolve(previewPage(previewWords, params));
  return getData(request.get("/product/words", { params }));
}

export function apiProductWordSave(
  id: number,
  data: Omit<ProductWord, "id" | "add_time">,
): Promise<{ id: number }> {
  if (previewMode) {
    const nextId = id || Math.max(0, ...previewWords.map((item) => item.id)) + 1;
    const row: ProductWord = {
      id: nextId,
      ...data,
      add_time: previewWords.find((item) => item.id === id)?.add_time
        ?? Math.floor(Date.now() / 1000),
    };
    previewWords = id
      ? previewWords.map((item) => item.id === id ? row : item)
      : [row, ...previewWords];
    return Promise.resolve({ id: nextId });
  }
  return getData(request.post(`/product/words/${id}`, data));
}

export function apiProductWordStatus(id: number, isShow: number): Promise<null> {
  if (previewMode) {
    previewWords = previewWords.map((item) => item.id === id ? { ...item, is_show: isShow } : item);
    return Promise.resolve(null);
  }
  return getData(request.put(`/product/words/set_show/${id}/${isShow}`));
}

export function apiProductWordDelete(id: number): Promise<null> {
  if (previewMode) {
    previewWords = previewWords.filter((item) => item.id !== id);
    return Promise.resolve(null);
  }
  return getData(request.delete(`/product/words/${id}`));
}
