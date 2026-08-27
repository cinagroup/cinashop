import { http } from "@/utils/request";

export interface OpenAdvItem {
  img: string;
  link: string;
  status: number;
  comment: string;
}

export interface OpenAdvConfig {
  status: number;
  time: number;
  interval_time: number;
  type: "pic" | "video";
  value: OpenAdvItem[];
  video_link: string;
}

export function apiOpenAdv(): Promise<OpenAdvConfig> {
  return http.get<OpenAdvConfig>("/get_open_adv", {}, { noAuth: true });
}

export function apiKfAdv(): Promise<{ content: string }> {
  return http.get<{ content: string }>("/user/service/get_adv", {}, { noAuth: true });
}
