import { API_BASE } from "@/utils/request";

/** Only web media URLs and same-site absolute paths may enter a native video element. */
export function communityVideoSource(value: unknown): string {
  if (typeof value !== "string") return "";
  const source = value.trim();
  if (!source || /[\u0000-\u001f\u007f\\]/.test(source)) return "";
  if (/^\/(?!\/)[^\s]*$/.test(source)) return `${API_BASE}${source}`;
  if (!/^https?:\/\/(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?(?:[/?#][^\s]*)?$/i.test(source)) return "";
  return source;
}
