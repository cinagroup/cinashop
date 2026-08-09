/** 通用 API 类型 (与后端信封一致) */
export interface ApiResponse<T = unknown> {
  status: number;
  msg: string;
  data: T;
}

export interface LoginResult {
  token: string;
  expires_time: number;
}

export interface PageResult<T> {
  list: T[];
  count: number | null;
}
