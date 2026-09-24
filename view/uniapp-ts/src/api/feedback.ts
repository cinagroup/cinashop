import { http } from "@/utils/request";

export interface FeedbackInput {
  rela_name: string;
  phone: string;
  content: string;
}

const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };

export function feedbackValidationError(input: FeedbackInput): string {
  if (!input.rela_name || input.rela_name.length > 255) return "请填写姓名（最多255字）";
  if (!/^1[3-9]\d{9}$/.test(input.phone)) return "请填写正确的手机号";
  const escaped = input.content.replace(/[&<>"']/g, (character) => escapes[character]);
  if (!input.content || escaped.length > 500) return "请填写反馈内容（转义后最多500字）";
  return "";
}

export function getFeedbackMessage() {
  return http.get<{ feedback: string }>("/user/service/feedback");
}

export function submitFeedback(input: FeedbackInput) {
  return http.post<{ id: number }>("/user/service/feedback", { ...input });
}
