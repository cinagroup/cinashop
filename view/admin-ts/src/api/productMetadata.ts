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
