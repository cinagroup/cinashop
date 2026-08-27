import request, { getData } from "@/utils/request";

export interface WechatMemberCardSummary {
  cards: number;
  active_cards: number;
  claims: number;
  active_claims: number;
  activated_claims: number;
  deleted_claims: number;
  legacy_applications: number;
  catalog_authority: "postgresql_imported_history";
  remote_write_authority: "not_migrated_requires_idempotent_outbox";
  callback_authority: "disabled";
  pii_display: "masked";
}

export type WechatMemberCardRow = Record<string, string | number | boolean | null>;

export interface WechatMemberCardPage {
  list: WechatMemberCardRow[];
  count: number;
  catalog_authority: "postgresql_imported_history";
  remote_write_authority: "not_migrated_requires_idempotent_outbox";
  callback_authority: "disabled";
  pii_display: "masked";
}

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

const meta = {
  catalog_authority: "postgresql_imported_history" as const,
  remote_write_authority: "not_migrated_requires_idempotent_outbox" as const,
  callback_authority: "disabled" as const,
  pii_display: "masked" as const,
};

const previewCards: WechatMemberCardRow[] = [
  {
    id: 3,
    brand_name: "CinaShop 会员中心",
    title: "臻享会员卡",
    remote_card_id_masked: "pM2***8Hx",
    card_type: "member_card",
    code_type: "CODE_TYPE_QRCODE",
    color: "Color010",
    status: 1,
    is_del: 0,
    add_time: 1786248000,
  },
  {
    id: 2,
    brand_name: "CinaShop 城市生活",
    title: "城市权益卡",
    remote_card_id_masked: "pF7***2Qa",
    card_type: "member_card",
    code_type: "CODE_TYPE_ONLY_QRCODE",
    color: "Color082",
    status: 0,
    is_del: 0,
    add_time: 1783483200,
  },
];

const previewClaims: WechatMemberCardRow[] = [
  { id: 9058, uid: 31082, code_masked: "2861****7104", openid_masked: "oYp***X6a", remote_card_id_masked: "pM2***8Hx", store_id: 12, staff_id: 38, is_submit: 1, is_del: 0, add_time: 1786332600, submit_time: 1786332720 },
  { id: 9057, uid: 30991, code_masked: "5927****3149", openid_masked: "oBs***P9m", remote_card_id_masked: "pM2***8Hx", store_id: 12, staff_id: 0, is_submit: 0, is_del: 0, add_time: 1786328100, submit_time: 0 },
  { id: 9056, uid: 30774, code_masked: "8403****0207", openid_masked: "oQk***N2v", remote_card_id_masked: "pF7***2Qa", store_id: 8, staff_id: 21, is_submit: 1, is_del: 0, add_time: 1786309200, submit_time: 1786309380 },
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function apiWechatMemberCardSummary(): Promise<WechatMemberCardSummary> {
  if (previewMode) {
    return Promise.resolve({
      cards: 3,
      active_cards: 1,
      claims: 9058,
      active_claims: 8914,
      activated_claims: 7346,
      deleted_claims: 144,
      legacy_applications: 27,
      ...meta,
    });
  }
  return getData(request.get("/wechat/card/summary"));
}

export function apiWechatMemberCardCatalog(
  section: "cards" | "claims",
  params: Record<string, unknown> = {},
): Promise<WechatMemberCardPage> {
  if (previewMode) {
    const rows = section === "cards" ? previewCards : previewClaims;
    const keyword = String(params.keyword ?? params.uid ?? "").trim().toLowerCase();
    const status = params.status === "" || params.status === undefined ? undefined : Number(params.status);
    const isSubmit = params.is_submit === "" || params.is_submit === undefined ? undefined : Number(params.is_submit);
    const filtered = rows.filter((row) => {
      const searchable = Object.values(row).join(" ").toLowerCase();
      const matchesStatus = status === undefined || Number(row.status) === status;
      const matchesSubmit = isSubmit === undefined || Number(row.is_submit) === isSubmit;
      return (!keyword || searchable.includes(keyword)) && matchesStatus && matchesSubmit;
    });
    return Promise.resolve({ list: clone(filtered), count: filtered.length, ...meta });
  }
  const path = section === "cards" ? "/wechat/card" : "/wechat/card/users";
  return getData(request.get(path, { params }));
}
