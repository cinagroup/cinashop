import request, { getData } from "@/utils/request";

export interface LegacyTimerItem {
  id: number;
  name: string;
  mark: string;
  type: number;
  title: string;
  is_open: number;
  cycle: string;
  execution_cycle: string;
  last_execution_time: number;
  update_execution_time: number;
  add_time: number;
  runtime_status: "implemented_independently" | "partially_implemented" | "not_migrated";
  worker_job: string | null;
  runtime_note: string;
}

export interface LegacyQueueItem {
  id: number;
  type: number;
  source: string;
  execute_key: string;
  title: string;
  status: number;
  first_time: number;
  again_time: number;
  finish_time: number;
  surplus_num: number;
  total_num: number;
  success_num: number;
  is_del: number;
  add_time: number;
  status_cn: string;
  type_cn: string;
  cache_type: string | number;
  is_show_log: boolean;
  has_payload: boolean;
  runtime_authority: "legacy_history_only";
}

export interface LegacyQueueLogItem {
  id: number;
  binding_id: number;
  relation_id: number;
  type: number;
  other: string;
  status: number;
  status_cn: string;
  update_time: number;
  add_time: number;
}

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

const previewTimers: LegacyTimerItem[] = [
  {
    id: 1, name: "自动确认收货", mark: "auto_take", type: 1, title: "", is_open: 1,
    cycle: "30", execution_cycle: "每隔 30 分钟", last_execution_time: 1_786_252_200,
    update_execution_time: 1_669_879_367, add_time: 1_669_879_367,
    runtime_status: "implemented_independently", worker_job: "auto_receipt",
    runtime_note: "Worker 已通过可重放 scheduled 根任务和 Queue 消费者实现；执行阈值来自商城配置。",
  },
  {
    id: 2, name: "自动好评", mark: "auto_comment", type: 1, title: "", is_open: 1,
    cycle: "30", execution_cycle: "每隔 30 分钟", last_execution_time: 1_786_252_200,
    update_execution_time: 1_669_879_383, add_time: 1_669_879_383,
    runtime_status: "implemented_independently", worker_job: "auto_comment",
    runtime_note: "Worker 已通过可重放 scheduled 根任务和 Queue 消费者实现；执行阈值来自商城配置。",
  },
  {
    id: 3, name: "自动取消订单", mark: "auto_cancel", type: 1, title: "", is_open: 1,
    cycle: "20", execution_cycle: "每隔 20 分钟", last_execution_time: 0,
    update_execution_time: 1_669_967_682, add_time: 1_669_967_682,
    runtime_status: "not_migrated", worker_job: null,
    runtime_note: "该 PHP 任务消费者尚未迁移；目录行仅供核对，is_open 与 cycle 不会配置 Cloudflare。",
  },
  {
    id: 4, name: "更新直播状态", mark: "auto_live", type: 1, title: "", is_open: 1,
    cycle: "1", execution_cycle: "每隔 1 分钟", last_execution_time: 0,
    update_execution_time: 1_669_968_223, add_time: 1_669_968_223,
    runtime_status: "partially_implemented", worker_job: "live_room_sync + live_goods_sync + live_anchor_sync",
    runtime_note: "Worker 已迁移直播间、商品状态与主播角色读取；微信直播间创建、商品提审/删除等非幂等远程写操作仍未迁移。",
  },
];

const previewQueues: LegacyQueueItem[] = [
  {
    id: 208, type: 7, source: "admin", execute_key: "3", title: "批量手动发货", status: 2,
    first_time: 1_786_250_500, again_time: 0, finish_time: 1_786_250_880, surplus_num: 0,
    total_num: 36, success_num: 36, is_del: 0, add_time: 1_786_250_480, status_cn: "完成",
    type_cn: "批量手动发货", cache_type: 3, is_show_log: true, has_payload: true,
    runtime_authority: "legacy_history_only",
  },
  {
    id: 207, type: 3, source: "admin", execute_key: "DrivingUserLabel-ADMIN", title: "批量设置用户标签",
    status: 3, first_time: 1_786_240_500, again_time: 1_786_245_000, finish_time: 0, surplus_num: 18,
    total_num: 120, success_num: 102, is_del: 0, add_time: 1_786_240_480, status_cn: "失败",
    type_cn: "批量设置用户标签", cache_type: "DrivingUserLabel-ADMIN", is_show_log: false,
    has_payload: true, runtime_authority: "legacy_history_only",
  },
  {
    id: 206, type: 10, source: "admin", execute_key: "6", title: "批量虚拟发货", status: 1,
    first_time: 1_786_230_500, again_time: 0, finish_time: 0, surplus_num: 4, total_num: 12,
    success_num: 8, is_del: 0, add_time: 1_786_230_480, status_cn: "正在处理",
    type_cn: "批量虚拟发货", cache_type: 6, is_show_log: true, has_payload: true,
    runtime_authority: "legacy_history_only",
  },
];

const previewLogs: LegacyQueueLogItem[] = [
  { id: 901, binding_id: 208, relation_id: 8751, type: 3, other: '{"order_id":"wx202608100001","delivery_status":1}', status: 1, status_cn: "成功", update_time: 1_786_250_860, add_time: 1_786_250_500 },
  { id: 902, binding_id: 208, relation_id: 8752, type: 3, other: '{"order_id":"wx202608100002","delivery_status":1}', status: 1, status_cn: "成功", update_time: 1_786_250_865, add_time: 1_786_250_501 },
  { id: 903, binding_id: 208, relation_id: 8753, type: 3, other: '{"order_id":"wx202608100003","error_info":"快递单号格式错误"}', status: 2, status_cn: "失败", update_time: 1_786_250_870, add_time: 1_786_250_502 },
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function apiLegacyTimers(params: Record<string, unknown> = {}): Promise<{
  list: LegacyTimerItem[];
  count: number;
  runtime_authority: string;
  catalog_authority: string;
}> {
  if (previewMode) {
    const keyword = String(params.keyword ?? "").trim().toLowerCase();
    const rows = previewTimers.filter((row) => !keyword || `${row.name}${row.mark}`.toLowerCase().includes(keyword));
    return Promise.resolve({ list: clone(rows), count: rows.length, runtime_authority: "cloudflare_scheduled_queue", catalog_authority: "legacy_history_only" });
  }
  return getData(request.get("/system/timer/index", { params }));
}

export function apiLegacyQueues(params: Record<string, unknown> = {}): Promise<{
  list: LegacyQueueItem[];
  count: number;
  runtime_authority: string;
  history_authority: string;
}> {
  if (previewMode) {
    const type = params.type === undefined || params.type === "" ? null : Number(params.type);
    const status = params.status === undefined || params.status === "" ? null : Number(params.status);
    const rows = previewQueues.filter((row) => (type === null || row.type === type) && (status === null || row.status === status));
    return Promise.resolve({ list: clone(rows), count: rows.length, runtime_authority: "cloudflare_queues", history_authority: "legacy_history_only" });
  }
  return getData(request.get("/queue/index", { params }));
}

export function apiLegacyQueueLogs(id: number, type: string | number): Promise<{
  list: LegacyQueueLogItem[];
  count: number;
  history_authority: string;
}> {
  if (previewMode) {
    const rows = previewLogs.map((row) => ({ ...row, binding_id: id, type: Number(type) }));
    return Promise.resolve({ list: rows, count: rows.length, history_authority: "legacy_history_only" });
  }
  return getData(request.get(`/queue/delivery/log/${id}/${type}`, { params: { page: 1, limit: 100 } }));
}
