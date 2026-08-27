import { getFormType, http } from "@/utils/request";

const previewMode = typeof window !== "undefined"
  && ["127.0.0.1", "localhost"].includes(window.location.hostname)
  && new URLSearchParams(window.location.search).get("preview") === "1";

export interface MembershipPlan {
  id: number;
  title: string;
  type: "free" | "month" | "quarter" | "year" | "ever";
  vip_day: number;
  price: string;
  pre_price: string;
  is_label: number;
  overdue_time: string;
}

export interface MembershipRight {
  id: number;
  right_type: string;
  title: string;
  pic: string;
  explain: string;
  content: string;
  number: number;
}

export interface MembershipHome {
  member_rights: MembershipRight[];
  member_type: MembershipPlan[];
  is_get_free: {
    title: string;
    vip_day: number;
    is_record: number;
    user_info: {
      now_money: string;
      is_ever_level: number;
      is_money_level: number;
      overdue_time: number;
      economize_money: string;
      shop_name: string;
    };
  };
  member_explain: { title?: string; content?: string } | "";
}

export interface MembershipOrderResult {
  order_id: string;
  pay_price: string;
  paid: boolean;
  overdue_time: number;
}

export interface MembershipPayResult {
  order_id: string;
  paid: boolean;
  overdue_time?: number | null;
  pay_type?: string;
  payUrl?: string;
  jsConfig?: Record<string, unknown>;
}

const previewHome: MembershipHome = {
  member_rights: [
    { id: 1, right_type: "discount", title: "会员专享价", pic: "", explain: "指定商品享受会员优惠", content: "", number: 1 },
    { id: 2, right_type: "integral", title: "双倍积分", pic: "", explain: "确认收货后按权益倍率发放", content: "", number: 2 },
  ],
  member_type: [
    { id: 1, title: "月度会员", type: "month", vip_day: 30, price: "29.90", pre_price: "19.90", is_label: 0, overdue_time: "2026-09-12" },
    { id: 2, title: "年度会员", type: "year", vip_day: 365, price: "238.00", pre_price: "168.00", is_label: 1, overdue_time: "2027-08-13" },
    { id: 3, title: "7 天体验会员", type: "free", vip_day: 7, price: "0.00", pre_price: "0.00", is_label: 0, overdue_time: "2026-08-20" },
  ],
  is_get_free: {
    title: "免费会员",
    vip_day: 7,
    is_record: 0,
    user_info: {
      now_money: "250.00",
      is_ever_level: 0,
      is_money_level: 0,
      overdue_time: 0,
      economize_money: "36.80",
      shop_name: "CinaShop",
    },
  },
  member_explain: { title: "付费会员服务协议", content: "开通前请确认套餐期限与权益范围。" },
};

export function apiMembershipHome(): Promise<MembershipHome> {
  if (previewMode) return Promise.resolve(structuredClone(previewHome));
  return http.get<MembershipHome>("/user/member/card/index");
}

export function apiCreateMembershipOrder(memberType: number): Promise<MembershipOrderResult> {
  if (previewMode) {
    const plan = previewHome.member_type.find((item) => item.id === memberType);
    return Promise.resolve({
      order_id: `hy-preview-${memberType}`,
      pay_price: plan?.pre_price ?? "0.00",
      paid: plan?.type === "free",
      overdue_time: 0,
    });
  }
  return http.post<MembershipOrderResult>("/user/member/card/create", {
    member_type: memberType,
    from: getFormType(),
  });
}

export function apiPayMembershipOrder(
  orderId: string,
  paytype: "yue" | "weixin" | "alipay",
): Promise<MembershipPayResult> {
  if (previewMode) return Promise.resolve({ order_id: orderId, paid: paytype === "yue", pay_type: paytype });
  return http.post<MembershipPayResult>("/user/member/card/pay", {
    uni: orderId,
    paytype,
    from: getFormType(),
  });
}

export function apiRedeemMembershipCard(
  code: string,
  password: string,
): Promise<{ order_id: string; overdue_time: number }> {
  if (previewMode) return Promise.resolve({ order_id: `hy-preview-card-${code.slice(-4)}`, overdue_time: 1_789_000_000 });
  return http.post("/user/member/card/draw", {
    member_card_code: code,
    member_card_pwd: password,
    from: getFormType(),
  });
}

export function apiProjectedMembershipExpiry(planId: number): Promise<{ data: string }> {
  if (previewMode) return Promise.resolve({ data: previewHome.member_type.find((item) => item.id === planId)?.overdue_time ?? "" });
  return http.get("/user/member/overdue/time", { member_type: planId });
}
