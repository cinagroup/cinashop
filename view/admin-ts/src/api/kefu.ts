/**
 * Admin 客服会话管理 API
 */
import request, { getData } from "@/utils/request";

export interface ChatSession {
  peerUid: number;
  msn: string;
  addTime: number;
  unread: number;
  nickname: string;
  avatar: string;
  phone: string;
}

export interface ChatMessage {
  id: number;
  uid: number;
  toUid: number;
  msn: string;
  addTime: number;
  type: number;
}

/** 会话列表 (GET /adminapi/service/sessions) */
export function apiAdminChatSessions(): Promise<ChatSession[]> {
  return getData(request.get<ChatSession[]>("/service/sessions"));
}

/** 聊天记录 (GET /adminapi/service/chat?uid=) */
export function apiAdminChatHistory(uid: number): Promise<ChatMessage[]> {
  return getData(request.get<ChatMessage[]>("/service/chat", { params: { uid } }));
}

/** 客服回复 (POST /adminapi/service/send) */
export function apiAdminServiceSend(toUid: number, msn: string): Promise<{ id: number }> {
  return getData(request.post<{ id: number }>("/service/send", { to_uid: toUid, msn, msn_type: 1 }));
}
