import request, { getData } from "@/utils/request";

export interface SystemLogRow {
  id: number;
  admin_id: number;
  admin_name: string;
  path: string;
  page: string;
  action: string;
  ip: string;
  type: string;
  add_time: number;
}

export interface SystemLogQuery {
  page: number;
  limit: number;
  admin_id?: number;
  path?: string;
  ip?: string;
  start_time?: number;
  end_time?: number;
}

export const apiSystemLogs = (params: SystemLogQuery, signal?: AbortSignal) =>
  getData<{ list: SystemLogRow[]; total: number; count: number }>(request.get("/log/list", { params, signal }));

export const apiSystemLogAdmins = (signal?: AbortSignal) =>
  getData<{ info: Array<{ id: number; real_name: string }> }>(request.get("/log/admin-options", { signal }));
