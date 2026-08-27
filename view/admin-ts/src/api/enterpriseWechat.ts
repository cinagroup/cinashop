import request, { getData } from "@/utils/request";

export interface EnterpriseWechatSummary {
  members: number;
  active_members: number;
  clients: number;
  groups: number;
  channels: number;
  templates: number;
  moments: number;
  pending_delivery_results: number;
  catalog_authority: "postgresql_imported_history";
  remote_write_authority: "not_migrated_requires_idempotent_outbox";
  pii_display: "masked";
}

export interface EnterpriseWechatPage<T extends Record<string, unknown>> {
  list: T[];
  count: number;
  catalog_authority: "postgresql_imported_history";
  remote_write_authority: "not_migrated_requires_idempotent_outbox";
  pii_display: "masked";
}

export type EnterpriseWechatRow = Record<string, string | number | boolean | null>;

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

const meta = {
  catalog_authority: "postgresql_imported_history" as const,
  remote_write_authority: "not_migrated_requires_idempotent_outbox" as const,
  pii_display: "masked" as const,
};

const preview: Record<string, EnterpriseWechatRow[]> = {
  member: [
    { id: 18, name: "陈晓林", position: "客户运营", userid: "zhang***007", mobile: "138****5268", status: 1, enable: 1, main_department: 4, update_time: 1786254200 },
    { id: 21, name: "林嘉怡", position: "渠道负责人", userid: "linj***021", mobile: "139****1836", status: 1, enable: 1, main_department: 2, update_time: 1786248800 },
    { id: 27, name: "周远", position: "售后顾问", userid: "zhou***027", mobile: "136****7904", status: 4, enable: 0, main_department: 6, update_time: 1786102100 },
  ],
  client: [
    { id: 9021, name: "苏女士", external_userid: "wm8A***2Wd", corp_name: "零售客户", position: "", remark: "七月会员活动", uid: 3812, gender: 2, update_time: 1786252100 },
    { id: 9017, name: "Nova 采购", external_userid: "wm9F***7Ke", corp_name: "Nova Studio", position: "采购经理", remark: "企业礼品", uid: 0, gender: 0, update_time: 1786245100 },
  ],
  group: [
    { id: 311, name: "CinaShop 新品体验群", chat_id: "wr2E***1Ks", owner: "linj***021", member_num: 186, retreat_group_num: 12, status: 0, update_time: 1786253200 },
    { id: 307, name: "八月会员福利群", chat_id: "wr8C***7Qp", owner: "zhan***007", member_num: 93, retreat_group_num: 4, status: 0, update_time: 1786231100 },
  ],
  channel: [
    { id: 61, name: "官网售前咨询", type: 0, assigned_member_count: 4, client_num: 1238, status: 1, skip_verify: 1, welcome_type: 0, create_time: 1785800000 },
    { id: 64, name: "线下展会 A 区", type: 1, assigned_member_count: 6, client_num: 327, status: 1, skip_verify: 0, welcome_type: 1, create_time: 1786010000 },
  ],
  template: [
    { id: 77, name: "新品预售提醒", type: 0, assigned_member_count: 12, client_type: 1, template_type: 1, send_time: 1786302000, send_type: 0, content_preview: "新品预售将在今晚 20:00 开启…", has_failure_detail: false, create_time: 1786200000 },
    { id: 75, name: "会员积分月报", type: 1, assigned_member_count: 8, client_type: 0, template_type: 0, send_time: 1786160000, send_type: 1, content_preview: "本月积分与专属权益已更新。", has_failure_detail: true, create_time: 1786159000 },
  ],
  moment: [
    { id: 42, name: "秋季新品朋友圈", type: 1, assigned_member_count: 9, client_type: 1, send_type: 1, send_time: 1786312800, remote_job_state: "recorded", remote_moment_state: "not_recorded", has_invalid_recipients: false, create_time: 1786210000 },
    { id: 39, name: "七夕会员礼遇", type: 0, assigned_member_count: 0, client_type: 0, send_type: 1, send_time: 1786068000, remote_job_state: "recorded", remote_moment_state: "recorded", has_invalid_recipients: true, create_time: 1786000000 },
  ],
  welcome: [
    { id: 15, type: 0, content_preview: "你好，欢迎添加 CinaShop 客户顾问。回复 1 获取新品目录。", attachment_count: 1, sort: 20, create_time: 1785900000, update_time: 1786200000 },
    { id: 18, type: 1, content_preview: "感谢关注企业采购服务，我会在工作时间尽快回复。", attachment_count: 0, sort: 10, create_time: 1786010000, update_time: 1786010000 },
  ],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function previewPage(section: string, params: Record<string, unknown>): EnterpriseWechatPage<EnterpriseWechatRow> {
  const search = String(params.keyword ?? "").trim().toLowerCase();
  const status = params.status === "" || params.status === undefined ? undefined : Number(params.status);
  const rows = (preview[section] ?? []).filter((row) => {
    const searchable = Object.values(row).join(" ").toLowerCase();
    const matchesStatus = status === undefined || Number(row.status) === status;
    return (!search || searchable.includes(search)) && matchesStatus;
  });
  return { list: clone(rows), count: rows.length, ...meta };
}

export function apiEnterpriseWechatSummary(): Promise<EnterpriseWechatSummary> {
  if (previewMode) {
    return Promise.resolve({
      members: 27, active_members: 23, clients: 9021, groups: 311, channels: 64,
      templates: 77, moments: 42, pending_delivery_results: 18, ...meta,
    });
  }
  return getData(request.get("/work/summary"));
}

export function apiEnterpriseWechatCatalog(
  section: "member" | "client" | "group" | "channel" | "template" | "moment" | "welcome",
  params: Record<string, unknown> = {},
): Promise<EnterpriseWechatPage<EnterpriseWechatRow>> {
  if (previewMode) return Promise.resolve(previewPage(section, params));
  const paths = {
    member: "/work/member",
    client: "/work/client",
    group: "/work/group_chat",
    channel: "/work/channel_code",
    template: "/work/group_template",
    moment: "/work/moment",
    welcome: "/work/welcome",
  } as const;
  return getData(request.get(paths[section], { params }));
}
