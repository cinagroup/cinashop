import request, { getData } from "@/utils/request";

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

export interface SupplierApplicationItem {
  id: number;
  uid: number;
  relation_id: number;
  phone: string;
  system_name: string;
  name: string;
  images: string[];
  image_refs?: string[];
  mark: string;
  status: 0 | 1 | 2;
  status_label: string;
  fail_msg: string;
  status_time: number;
  add_time: number;
  account: string;
  activation_required: boolean;
  activated: boolean;
}

const previewApplications: SupplierApplicationItem[] = [
  {
    id: 106, uid: 8206, relation_id: 0, phone: "13800008206",
    system_name: "苏州澄明家居供应链", name: "林澄", images: ["https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=900"],
    mark: "资质待复核", status: 0, status_label: "待审核", fail_msg: "", status_time: 0,
    add_time: 1786323600, account: "", activation_required: false, activated: false,
  },
  {
    id: 105, uid: 8188, relation_id: 46, phone: "13800008188",
    system_name: "宁波海岸生活选品", name: "周予安", images: ["https://images.unsplash.com/photo-1556740749-887f6717d7e4?w=900"],
    mark: "审核通过", status: 1, status_label: "已通过", fail_msg: "", status_time: 1786240800,
    add_time: 1786154400, account: "13800008188", activation_required: true, activated: false,
  },
  {
    id: 104, uid: 8161, relation_id: 41, phone: "13800008161",
    system_name: "杭州青岚户外用品", name: "沈青", images: [], mark: "", status: 1,
    status_label: "已通过", fail_msg: "", status_time: 1786068000, add_time: 1785981600,
    account: "13800008161", activation_required: false, activated: true,
  },
];

export async function apiSupplierApplicationList(params: Record<string, unknown>) {
  if (previewMode) {
    const status = params.status === "" || params.status === "all" || params.status === undefined
      ? null : Number(params.status);
    const keyword = String(params.keyword ?? "").toLowerCase();
    const list = previewApplications.filter((row) =>
      (status === null || row.status === status) &&
      (!keyword || `${row.uid}${row.system_name}${row.name}${row.phone}`.toLowerCase().includes(keyword)),
    );
    return Promise.resolve({ list, count: list.length });
  }
  return getData<{ list: SupplierApplicationItem[]; count: number }>(
    request.get("/supplier/apply/list", { params }),
  );
}

export async function apiSupplierApplicationReview(
  id: number,
  body: { status: 1 | 2; fail_msg?: string },
) {
  if (previewMode) {
    const row = previewApplications.find((item) => item.id === id);
    if (row) {
      row.status = body.status;
      row.status_label = body.status === 1 ? "已通过" : "已拒绝";
      row.fail_msg = body.fail_msg ?? "";
      if (body.status === 1) {
        row.account = row.phone;
        row.activation_required = true;
      }
    }
    return Promise.resolve({ id, status: body.status, activation_required: body.status === 1 });
  }
  return getData<{ id: number; status: number; account?: string; activation_required?: boolean }>(
    request.post(`/supplier/apply/verify/${id}`, body),
  );
}

export async function apiSupplierApplicationMark(id: number, mark: string) {
  if (previewMode) {
    const row = previewApplications.find((item) => item.id === id);
    if (row) row.mark = mark;
    return Promise.resolve({ id, mark });
  }
  return getData<{ id: number; mark: string }>(
    request.post(`/supplier/apply/mark/${id}`, { mark }),
  );
}

export async function apiSupplierApplicationDelete(id: number) {
  if (previewMode) {
    const index = previewApplications.findIndex((item) => item.id === id);
    if (index >= 0) previewApplications.splice(index, 1);
    return Promise.resolve({ id });
  }
  return getData<{ id: number }>(request.delete(`/supplier/apply/del/${id}`));
}
