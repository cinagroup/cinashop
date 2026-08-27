import request, { getData } from "@/utils/request";

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

export interface DiscountPackageSkuOption {
  unique: string;
  suk: string;
  price: string;
  ot_price: string;
  stock: number;
  image: string;
}

export interface DiscountPackageProductOption {
  id: number;
  product_id: number;
  store_name: string;
  image: string;
  price: string;
  ot_price: string;
  stock: number;
  product_type: number;
  spec_type: number;
  temp_id: number;
  skus: DiscountPackageSkuOption[];
}

export interface DiscountPackageListItem {
  id: number;
  title: string;
  image: string;
  type: number;
  is_limit: number;
  limit_num: number;
  is_time: number;
  start_time: number;
  stop_time: number;
  sort: number;
  free_shipping: number;
  status: number;
  is_support_refund: number;
  product_count: number;
  available: boolean;
  invalid_reason: string;
  effective_status: number;
  min_price: string;
}

export interface DiscountPackageDetailProduct {
  id: number;
  entry_id: number;
  product_id: number;
  product_type: number;
  store_name: string;
  image: string;
  type: number;
  temp_id: number;
  skus: Array<{
    unique: string;
    base_unique: string;
    activity_unique: string;
    suk: string;
    value: string;
    price: string;
    p_price: string;
    stock: number;
    image: string;
  }>;
  product?: {
    id: number;
    storeName: string;
    image: string;
    price: string;
    otPrice: string;
    stock: number;
    productType: number;
    specType: number;
    tempId: number;
  };
}

export interface DiscountPackageDetail extends DiscountPackageListItem {
  time: string[];
  link_id_values: number[];
  delivery_type: string;
  freight: number;
  custom_form: string | null;
  products: DiscountPackageDetailProduct[];
}

export interface DiscountPackagePayload {
  id?: number;
  title: string;
  image: string;
  type: number;
  is_limit: number;
  limit_num: number;
  link_ids: number[];
  is_time: number;
  time: string[];
  sort: number;
  free_shipping: number;
  status: number;
  is_support_refund: number;
  products: Array<{
    product_id: number;
    type: number;
    skus: Array<{ base_unique: string; price: string }>;
  }>;
}

const previewProducts: DiscountPackageProductOption[] = [
  {
    id: 101,
    product_id: 101,
    store_name: "CinaShop 轻盈保温杯",
    image: "/logo.png",
    price: "39.90",
    ot_price: "59.90",
    stock: 128,
    product_type: 0,
    spec_type: 1,
    temp_id: 0,
    skus: [
      { unique: "CUPBLACK", suk: "曜石黑", price: "39.90", ot_price: "59.90", stock: 68, image: "/logo.png" },
      { unique: "CUPWHITE", suk: "云雾白", price: "39.90", ot_price: "59.90", stock: 60, image: "/logo.png" },
    ],
  },
  {
    id: 205,
    product_id: 205,
    store_name: "便携咖啡滤杯",
    image: "/logo.png",
    price: "26.80",
    ot_price: "36.80",
    stock: 76,
    product_type: 0,
    spec_type: 0,
    temp_id: 0,
    skus: [
      { unique: "FILTER01", suk: "默认", price: "26.80", ot_price: "36.80", stock: 76, image: "/logo.png" },
    ],
  },
  {
    id: 309,
    product_id: 309,
    store_name: "精品咖啡豆 250g",
    image: "/logo.png",
    price: "58.00",
    ot_price: "68.00",
    stock: 95,
    product_type: 0,
    spec_type: 1,
    temp_id: 0,
    skus: [
      { unique: "BEANLIGHT", suk: "浅烘焙", price: "58.00", ot_price: "68.00", stock: 45, image: "/logo.png" },
      { unique: "BEANDARK", suk: "深烘焙", price: "58.00", ot_price: "68.00", stock: 50, image: "/logo.png" },
    ],
  },
];

let previewRows: DiscountPackageListItem[] = [
  {
    id: 18,
    title: "咖啡随行组合",
    image: "/logo.png",
    type: 0,
    is_limit: 1,
    limit_num: 42,
    is_time: 0,
    start_time: 0,
    stop_time: 0,
    sort: 100,
    free_shipping: 1,
    status: 1,
    is_support_refund: 1,
    product_count: 2,
    available: true,
    invalid_reason: "",
    effective_status: 1,
    min_price: "52.70",
  },
  {
    id: 12,
    title: "自选咖啡搭配包",
    image: "/logo.png",
    type: 1,
    is_limit: 0,
    limit_num: 0,
    is_time: 1,
    start_time: 1786032000,
    stop_time: 1788710399,
    sort: 80,
    free_shipping: 1,
    status: 1,
    is_support_refund: 0,
    product_count: 3,
    available: false,
    invalid_reason: "主商品库存不足",
    effective_status: 0,
    min_price: "29.90",
  },
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function apiDiscountPackageList(params: Record<string, unknown>) {
  if (previewMode) {
    const title = String(params.title ?? "").trim();
    const type = params.type === "" || params.type === undefined ? null : Number(params.type);
    const status = params.status === "" || params.status === undefined ? null : Number(params.status);
    const list = previewRows.filter((row) =>
      (!title || row.title.includes(title))
      && (type === null || row.type === type)
      && (status === null || row.status === status),
    );
    return Promise.resolve({ list: clone(list), count: list.length });
  }
  return getData<{ list: DiscountPackageListItem[]; count: number }>(request.get("/discounts/list", { params }));
}

export function apiDiscountPackageDetail(id: number) {
  if (previewMode) {
    const row = previewRows.find((item) => item.id === id);
    if (!row) return Promise.reject(new Error("套餐不存在"));
    const products = previewProducts.slice(0, row.type === 0 ? 2 : 3).map((product, index) => ({
      id: 1_000 + index,
      entry_id: 1_000 + index,
      product_id: product.id,
      product_type: product.product_type,
      store_name: product.store_name,
      image: product.image,
      type: row.type === 1 && index === 0 ? 1 : 0,
      temp_id: product.temp_id,
      skus: product.skus.slice(0, 1).map((sku) => ({
        unique: sku.unique,
        base_unique: sku.unique,
        activity_unique: `PKG${sku.unique}`.slice(0, 8),
        suk: sku.suk,
        value: sku.suk,
        price: index === 0 ? "29.90" : "22.80",
        p_price: sku.price,
        stock: sku.stock,
        image: sku.image,
      })),
      product: {
        id: product.id,
        storeName: product.store_name,
        image: product.image,
        price: product.price,
        otPrice: product.ot_price,
        stock: product.stock,
        productType: product.product_type,
        specType: product.spec_type,
        tempId: product.temp_id,
      },
    }));
    return Promise.resolve(clone({
      ...row,
      time: row.is_time ? ["2026-08-03", "2026-09-02"] : [],
      link_id_values: [1],
      delivery_type: "1",
      freight: 2,
      custom_form: null,
      products,
    }));
  }
  return getData<DiscountPackageDetail>(request.get(`/discounts/info/${id}`));
}

export function apiDiscountPackageProducts(params: Record<string, unknown>) {
  if (previewMode) {
    const keyword = String(params.keyword ?? "").trim().toLowerCase();
    const list = keyword
      ? previewProducts.filter((product) => `${product.id}${product.store_name}`.toLowerCase().includes(keyword))
      : previewProducts;
    return Promise.resolve({ list: clone(list), count: list.length });
  }
  return getData<{ list: DiscountPackageProductOption[]; count: number }>(request.get("/discounts/products", { params }));
}

export function apiDiscountPackageLabels(params: Record<string, unknown> = {}) {
  if (previewMode) return Promise.resolve([{ id: 1, name: "咖啡爱好者" }, { id: 2, name: "高复购会员" }]);
  return getData<Array<{ id: number; name: string }>>(request.get("/discounts/labels", { params }));
}

export function apiDiscountPackageSave(payload: DiscountPackagePayload) {
  if (previewMode) {
    const id = payload.id ?? Math.max(0, ...previewRows.map((row) => row.id)) + 1;
    const next: DiscountPackageListItem = {
      id,
      title: payload.title,
      image: payload.image,
      type: payload.type,
      is_limit: payload.is_limit,
      limit_num: payload.limit_num,
      is_time: payload.is_time,
      start_time: 0,
      stop_time: 0,
      sort: payload.sort,
      free_shipping: payload.free_shipping,
      status: payload.status,
      is_support_refund: payload.is_support_refund,
      product_count: payload.products.length,
      available: true,
      invalid_reason: "",
      effective_status: payload.status,
      min_price: payload.products.reduce((sum, product) => sum + Number(product.skus[0]?.price ?? 0), 0).toFixed(2),
    };
    const index = previewRows.findIndex((row) => row.id === id);
    if (index >= 0) previewRows[index] = next; else previewRows.unshift(next);
    return apiDiscountPackageDetail(id);
  }
  return getData<DiscountPackageDetail>(request.post("/discounts/save", payload));
}

export function apiDiscountPackageStatus(id: number, status: number) {
  if (previewMode) {
    const row = previewRows.find((item) => item.id === id);
    if (row) row.status = status;
    return Promise.resolve({ id, status });
  }
  return getData<{ id: number; status: number }>(request.put(`/discounts/set_status/${id}/${status}`));
}

export function apiDiscountPackageDelete(id: number) {
  if (previewMode) {
    previewRows = previewRows.filter((row) => row.id !== id);
    return Promise.resolve({ id });
  }
  return getData<{ id: number }>(request.delete(`/discounts/del/${id}`));
}
