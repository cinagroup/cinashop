/**
 * 公共 API
 */
import request, { getData } from "@/utils/request";

export interface SiteConfig {
  record_No: string;
  site_name: string;
  site_logo: string;
  site_logo_square: string;
  login_logo: string;
  ico_path: string;
  admin_login_slide: string[];
}

export interface ShareConfig {
  img: string;
  title: string;
  synopsis: string;
}

/** 站点配置 (GET /api/site_config) */
export function getSiteConfig(): Promise<SiteConfig> {
  return getData(request.get<SiteConfig>("/site_config"));
}

/** 全局分享默认值 (GET /api/share) */
export function getShareConfig(): Promise<ShareConfig> {
  return getData(request.get<ShareConfig>("/share"));
}
