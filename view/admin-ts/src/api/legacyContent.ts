import request, { getData } from "@/utils/request";

export interface OpenAdvItem {
  id: number;
  gid: number;
  img: string;
  link: string;
  sort: number;
  status: number;
  comment: string;
  add_time: string | number;
}

export interface OpenAdvConfig {
  status: number;
  time: number;
  interval_time: number;
  type: "pic" | "video";
  value: OpenAdvItem[];
  video_link: string;
}

export interface LegacyRuntimeContent {
  kf_adv: string;
  open_adv: OpenAdvConfig;
  uni_app_url: Array<Record<string, unknown>>;
  agreements: Record<"privacy" | "user" | "cancel" | "supplier" | "agent", string>;
}

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

let previewContent: LegacyRuntimeContent = {
  kf_adv: "<p>工作时间：周一至周五 09:00—18:00</p>",
  open_adv: {
    status: 1,
    time: 3,
    interval_time: 24,
    type: "pic",
    value: [{
      id: 0,
      gid: 0,
      img: "https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=900",
      link: "/pages/activity/index",
      sort: 0,
      status: 1,
      comment: "活动开屏",
      add_time: "",
    }],
    video_link: "",
  },
  uni_app_url: [
    { id: 1, name: "商品列表", url: "/pages/goods/list", parameter: "keyword=" },
    { id: 2, name: "营销活动", url: "/pages/activity/index", parameter: "" },
  ],
  agreements: {
    privacy: "<p>隐私政策示例</p>",
    user: "<p>用户协议示例</p>",
    cancel: "<p>账号注销协议示例</p>",
    supplier: "<p>供应商入驻协议示例</p>",
    agent: "<p>代理商入驻协议示例</p>",
  },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function apiLegacyRuntimeContent(): Promise<LegacyRuntimeContent> {
  if (previewMode) return clone(previewContent);
  return getData(request.get<LegacyRuntimeContent>("/config/runtime_content"));
}

export async function apiSaveLegacyRuntimeContent(
  payload: Pick<LegacyRuntimeContent, "kf_adv" | "open_adv" | "agreements">,
): Promise<LegacyRuntimeContent> {
  if (previewMode) {
    previewContent = { ...clone(previewContent), ...clone(payload) };
    return clone(previewContent);
  }
  return getData(request.post<LegacyRuntimeContent>("/config/runtime_content", payload));
}
