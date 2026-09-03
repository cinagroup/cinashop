import { http } from "@/utils/request";

export interface ShareConfig {
  img: string;
  title: string;
  synopsis: string;
}

export function apiShareConfig(): Promise<ShareConfig> {
  return http.get<ShareConfig>("share", {}, { noAuth: true });
}
