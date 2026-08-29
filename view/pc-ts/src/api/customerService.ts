import axios, { type AxiosResponse } from "axios";
import request, { getData } from "@/utils/request";
import type { ApiResponse } from "@/types/api";

const VISITOR_TOKEN_KEY = "cinashop_pc_kefu_visitor_token";
const visitorRequest = axios.create({
  baseURL: "/kefuapi",
  timeout: 30_000,
  validateStatus: () => true,
});

export interface CustomerServiceMessage {
  id: number;
  uid: number;
  to_uid: number;
  msn: string;
  msn_type: number;
  add_time: number;
  is_tourist: 0 | 1;
  type: number;
}

export interface RegisteredServiceRecord {
  serviceList: CustomerServiceMessage[];
  uid: number;
  nickname: string;
  avatar: string;
  online: number;
}

export interface VisitorServiceRecord {
  uid: number;
  nickname: string;
  avatar: string;
  online: number;
  tourist_uid: number;
  tourist_avatar: string;
  is_tourist: true;
  visitor_token: string;
  expires_in: number;
}

export interface CustomerServiceUpload {
  att_id: number;
  name: string;
  url: string;
}

class VisitorRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VisitorRequestError";
  }
}

function visitorTokenHeader(token: string): Record<string, string> {
  return token ? { "X-Visitor-Token": token, "Form-type": "pc" } : { "Form-type": "pc" };
}

async function visitorData<T>(promise: Promise<AxiosResponse<unknown>>): Promise<T> {
  const response = await promise;
  const body = response.data as Partial<ApiResponse<T>> | null;
  if (!body || body.status !== 200) {
    throw new VisitorRequestError(body?.msg || `游客客服请求失败 (${response.status})`, Number(body?.status ?? response.status));
  }
  return body.data as T;
}

export function storedVisitorToken(): string {
  return localStorage.getItem(VISITOR_TOKEN_KEY)?.trim() ?? "";
}

export function clearStoredVisitorToken(): void {
  localStorage.removeItem(VISITOR_TOKEN_KEY);
}

export async function apiRegisteredServiceRecord(limit = 60): Promise<RegisteredServiceRecord> {
  return getData(request.get<RegisteredServiceRecord>("/user/service/record", { params: { limit } }));
}

export async function apiRegisteredServiceSend(
  toUid: number,
  message: string,
  messageType: 1 | 3,
): Promise<CustomerServiceMessage> {
  return getData(request.post<CustomerServiceMessage>("/service/send", {
    to_uid: toUid,
    msn: message,
    msn_type: messageType,
  }));
}

export async function apiRegisteredServiceUpload(file: File): Promise<CustomerServiceUpload> {
  const body = new FormData();
  body.set("file", file);
  body.set("pid", "0");
  return getData(request.post<CustomerServiceUpload>("/upload/image", body));
}

export async function apiVisitorBootstrap(): Promise<VisitorServiceRecord> {
  const existing = storedVisitorToken();
  try {
    const result = await visitorData<VisitorServiceRecord>(visitorRequest.get("/tourist/user", {
      headers: visitorTokenHeader(existing),
    }));
    localStorage.setItem(VISITOR_TOKEN_KEY, result.visitor_token);
    return result;
  } catch (error) {
    if (!existing || !(error instanceof VisitorRequestError) || ![401, 410000, 410001, 410002].includes(error.status)) {
      throw error;
    }
    clearStoredVisitorToken();
    const result = await visitorData<VisitorServiceRecord>(visitorRequest.get("/tourist/user", {
      headers: visitorTokenHeader(""),
    }));
    localStorage.setItem(VISITOR_TOKEN_KEY, result.visitor_token);
    return result;
  }
}

export async function apiVisitorServiceHistory(token: string, limit = 60): Promise<CustomerServiceMessage[]> {
  return visitorData(visitorRequest.get("/tourist/chat", {
    headers: visitorTokenHeader(token),
    params: { limit },
  }));
}

export async function apiVisitorServiceUpload(token: string, file: File): Promise<CustomerServiceUpload> {
  const body = new FormData();
  body.set("file", file);
  body.set("pid", "0");
  return visitorData(visitorRequest.post("/tourist/upload", body, {
    headers: visitorTokenHeader(token),
  }));
}
