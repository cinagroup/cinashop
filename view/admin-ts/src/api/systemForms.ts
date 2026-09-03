import request, { getData } from "@/utils/request";

export type SystemFormComponentName =
  | "checkboxs"
  | "citys"
  | "dates"
  | "dateranges"
  | "radios"
  | "selects"
  | "texts"
  | "times"
  | "timeranges"
  | "uploadPicture";

export interface SystemFormChoice {
  val: string;
  show?: boolean;
}

export interface SystemFormComponent {
  id: string;
  timestamp: number;
  name: SystemFormComponentName;
  titleConfig: { value: string };
  titleShow: { val: boolean };
  tipConfig?: { value: string };
  wordsConfig?: { list: SystemFormChoice[] };
  defaultValConfig?: { value: string };
  valConfig?: { tabVal: number };
  numConfig?: { val: number };
  value: string | string[];
}

export interface SystemFormListItem {
  id: number;
  version: string;
  name: string;
  cover_image: string;
  status: number;
  update_time: number;
  add_time: number;
}

export interface SystemFormInfo extends SystemFormListItem {
  value: SystemFormComponent[];
  default_value: string | null;
  is_del: number;
}

export interface SystemFormDataItem {
  id: number;
  uid: number;
  system_form_id: string;
  type: number;
  relation_id: number;
  value: Array<{
    id?: string | number;
    type?: string;
    name?: string;
    title?: string;
    value?: unknown;
  }>;
  add_time: number;
  nickname: string | null;
  avatar: string | null;
  phone: string | null;
  system_form_name: string | null;
}

export interface PageResult<T> {
  list: T[];
  count: number;
  page: number;
  limit: number;
}

export interface SystemFormDataQuery {
  page: number;
  limit: number;
  uid?: string;
  type?: string;
  relation_id?: string;
  start_time?: number;
  end_time?: number;
}

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const previewNow = Math.floor(Date.now() / 1_000);
let previewForms: Array<SystemFormListItem & { value: SystemFormComponent[] }> = [
  {
    id: 12,
    version: "",
    name: "企业采购信息",
    cover_image: "",
    status: 1,
    add_time: previewNow - 86_400 * 20,
    update_time: previewNow - 3_600,
    value: [
      {
        id: "preview-company",
        timestamp: 1,
        name: "texts",
        titleConfig: { value: "公司名称" },
        titleShow: { val: true },
        tipConfig: { value: "请输入公司全称" },
        defaultValConfig: { value: "" },
        valConfig: { tabVal: 0 },
        value: "",
      },
      {
        id: "preview-purpose",
        timestamp: 2,
        name: "selects",
        titleConfig: { value: "采购用途" },
        titleShow: { val: true },
        tipConfig: { value: "请选择" },
        wordsConfig: { list: [{ val: "办公" }, { val: "生产" }, { val: "福利" }] },
        value: "",
      },
    ],
  },
  {
    id: 11,
    version: "",
    name: "定制商品资料",
    cover_image: "",
    status: 0,
    add_time: previewNow - 86_400 * 45,
    update_time: previewNow - 86_400 * 2,
    value: [
      {
        id: "preview-image",
        timestamp: 3,
        name: "uploadPicture",
        titleConfig: { value: "参考图片" },
        titleShow: { val: false },
        tipConfig: { value: "请上传参考图" },
        numConfig: { val: 3 },
        value: [],
      },
    ],
  },
];

const previewData: SystemFormDataItem[] = [
  {
    id: 91,
    uid: 10023,
    system_form_id: "12",
    type: 1,
    relation_id: 20260903001,
    value: [
      { id: "preview-company", type: "texts", name: "文本框", title: "公司名称", value: "示例科技有限公司" },
      { id: "preview-purpose", type: "selects", name: "下拉框", title: "采购用途", value: "生产" },
    ],
    add_time: previewNow - 2_400,
    nickname: "采购员示例",
    avatar: "",
    phone: "138****8000",
    system_form_name: "企业采购信息",
  },
];

export async function apiSystemFormList(params: {
  page: number;
  limit: number;
  name?: string;
  status?: string;
}): Promise<PageResult<SystemFormListItem>> {
  if (previewMode) {
    const name = params.name?.trim().toLowerCase() ?? "";
    const rows = previewForms.filter((item) => (
      (!name || item.name.toLowerCase().includes(name))
      && (params.status === undefined || params.status === "" || item.status === Number(params.status))
    ));
    const start = (params.page - 1) * params.limit;
    return { list: clone(rows.slice(start, start + params.limit)), count: rows.length, page: params.page, limit: params.limit };
  }
  return getData(request.get<PageResult<SystemFormListItem>>("/form/index", { params }));
}

export async function apiSystemFormInfo(id: number): Promise<SystemFormInfo> {
  if (previewMode) {
    const row = previewForms.find((item) => item.id === id);
    if (!row) throw new Error("系统表单不存在");
    return clone({ ...row, default_value: null, is_del: 0 });
  }
  const result = await getData<{ info: SystemFormInfo }>(request.get(`/form/info/${id}`));
  return result.info;
}

export async function apiSaveSystemForm(
  id: number,
  payload: { name: string; value: SystemFormComponent[] },
): Promise<{ id: number }> {
  if (previewMode) {
    const now = Math.floor(Date.now() / 1_000);
    if (id > 0) {
      const index = previewForms.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("系统表单不存在");
      previewForms[index] = { ...previewForms[index], name: payload.name.trim(), value: clone(payload.value), update_time: now };
      return { id };
    }
    const nextId = Math.max(0, ...previewForms.map((item) => item.id)) + 1;
    previewForms.unshift({
      id: nextId,
      version: "",
      name: payload.name.trim(),
      cover_image: "",
      status: 0,
      add_time: now,
      update_time: now,
      value: clone(payload.value),
    });
    return { id: nextId };
  }
  return getData(request.post<{ id: number }>(`/form/save/${id}`, payload));
}

export async function apiSetSystemFormStatus(id: number, status: number): Promise<void> {
  if (previewMode) {
    const row = previewForms.find((item) => item.id === id);
    if (!row) throw new Error("系统表单不存在");
    row.status = status;
    row.update_time = Math.floor(Date.now() / 1_000);
    return;
  }
  await getData(request.put(`/form/set_show/${id}/${status}`));
}

export async function apiDeleteSystemForm(id: number): Promise<void> {
  if (previewMode) {
    previewForms = previewForms.filter((item) => item.id !== id);
    return;
  }
  await getData(request.delete(`/form/del/${id}`));
}

export async function apiSystemFormData(
  id: number,
  params: SystemFormDataQuery,
): Promise<PageResult<SystemFormDataItem>> {
  if (previewMode) {
    const rows = previewData.filter((item) => (
      item.system_form_id === String(id)
      && (!params.uid || item.uid === Number(params.uid))
      && (!params.type || item.type === Number(params.type))
      && (!params.relation_id || item.relation_id === Number(params.relation_id))
      && (!params.start_time || item.add_time >= params.start_time)
      && (!params.end_time || item.add_time <= params.end_time)
    ));
    const start = (params.page - 1) * params.limit;
    return { list: clone(rows.slice(start, start + params.limit)), count: rows.length, page: params.page, limit: params.limit };
  }
  return getData(request.get<PageResult<SystemFormDataItem>>(`/form/data/${id}`, { params }));
}
