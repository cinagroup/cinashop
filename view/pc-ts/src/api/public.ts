/**
 * 公共 API
 */
import request, { getData } from "@/utils/request";

/** 站点配置 (GET /api/site_config) */
export function getSiteConfig(): Promise<{ record_No: string }> {
  return getData(request.get<{ record_No: string }>("/site_config"));
}
