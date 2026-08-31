import type { WorkCallbackPayload } from "@/models/schema";
import {
  EnterpriseWechatProviderError,
  type EnterpriseWechatProviderClient,
} from "@/services/work/EnterpriseWechatProviderClient";

const encoder = new TextEncoder();
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_@.-]{0,63}$/;
const MAX_GROUP_MEMBERS = 2_000;
const MAX_GROUP_ADMINS = 64;
const MAX_EPOCH = 2_147_483_647;

type JsonRecord = Record<string, unknown>;
type ExternalGroupChatProvider = Pick<EnterpriseWechatProviderClient, "externalGroupChat">;

export class EnterpriseWechatGroupChatProjectionError extends Error {
  constructor(
    readonly errorCode: string,
    readonly terminal = true,
  ) {
    super(errorCode);
    this.name = "EnterpriseWechatGroupChatProjectionError";
  }
}

export interface GroupChatProjectionClaim {
  eventId: number;
  eventKey: string;
  subjectKeyHash: string;
  eventTime: number;
  sequenceRank: number;
  corpId: string;
  msgType: string;
  eventType: string;
  changeType: string;
  payload: WorkCallbackPayload;
}

export interface EnterpriseWechatGroupChatMemberSnapshot {
  userid: string;
  type: 1 | 2;
  unionid: string | null;
  joinTime: number;
  joinScene: number;
  invitorUserid: string | null;
  groupNickname: string;
  name: string | null;
  state: string | null;
}

export interface EnterpriseWechatGroupChatSnapshot {
  chatId: string;
  name: string;
  owner: string;
  groupCreatedTime: number;
  notice: string;
  adminList: string[];
  providerStatus: number;
  members: EnterpriseWechatGroupChatMemberSnapshot[];
}

export type PreparedGroupChatProjection =
  | { kind: "snapshot"; chatId: string; snapshot: EnterpriseWechatGroupChatSnapshot }
  | { kind: "absent"; chatId: string; source: "dismiss_callback" }
  | { kind: "not_found"; chatId: string; source: "provider_not_found" }
  | { kind: "incomplete"; chatId: string; source: "provider_scope_incomplete" };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidSnapshot(): never {
  throw new EnterpriseWechatGroupChatProjectionError("callback_group_chat_snapshot_invalid");
}

function incompleteSnapshot(): never {
  throw new EnterpriseWechatGroupChatProjectionError(
    "callback_group_chat_snapshot_incomplete",
    false,
  );
}

function canonicalInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    return invalidSnapshot();
  }
  return Number(value);
}

function requiredInteger(
  data: JsonRecord,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Object.hasOwn(data, field)) return incompleteSnapshot();
  return canonicalInteger(data[field], minimum, maximum);
}

function safeString(
  value: unknown,
  maximumCharacters: number,
  options: { allowEmpty: boolean; allowLineBreaks?: boolean },
): string {
  if (typeof value !== "string" || value !== value.trim()) return invalidSnapshot();
  if (!options.allowEmpty && value.length === 0) return invalidSnapshot();
  if (
    Array.from(value).length > maximumCharacters
    || encoder.encode(value).byteLength > maximumCharacters * 4
  ) return invalidSnapshot();
  const unsafeControl = options.allowLineBreaks
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;
  if (unsafeControl.test(value)) return invalidSnapshot();
  return value;
}

function requiredString(
  data: JsonRecord,
  field: string,
  maximumCharacters: number,
  options: { allowEmpty: boolean; allowLineBreaks?: boolean },
): string {
  if (!Object.hasOwn(data, field)) return incompleteSnapshot();
  return safeString(data[field], maximumCharacters, options);
}

function optionalString(
  data: JsonRecord,
  field: string,
  maximumCharacters: number,
): string | null {
  if (!Object.hasOwn(data, field) || data[field] === null || data[field] === "") return null;
  return safeString(data[field], maximumCharacters, { allowEmpty: false });
}

function providerIdentifier(value: unknown, lowerCase: boolean): string {
  if (typeof value !== "string" || value !== value.trim() || !IDENTIFIER.test(value)) {
    return invalidSnapshot();
  }
  return lowerCase ? value.toLowerCase() : value;
}

function callbackIdentifier(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || !IDENTIFIER.test(value)) {
    throw new EnterpriseWechatGroupChatProjectionError("callback_projection_field_invalid");
  }
  return value;
}

function parseInvitor(data: JsonRecord): string | null {
  if (!Object.hasOwn(data, "invitor") || data.invitor === null) return null;
  if (!isRecord(data.invitor) || !Object.hasOwn(data.invitor, "userid")) {
    return invalidSnapshot();
  }
  return providerIdentifier(data.invitor.userid, true);
}

function parseMember(value: unknown): EnterpriseWechatGroupChatMemberSnapshot {
  if (!isRecord(value)) return invalidSnapshot();
  const type = requiredInteger(value, "type", 1, 2) as 1 | 2;
  return {
    userid: providerIdentifier(value.userid, type === 1),
    type,
    unionid: optionalString(value, "unionid", 128),
    joinTime: requiredInteger(value, "join_time", 0, MAX_EPOCH),
    joinScene: requiredInteger(value, "join_scene", 0, 255),
    invitorUserid: parseInvitor(value),
    groupNickname: Object.hasOwn(value, "group_nickname")
      ? safeString(value.group_nickname, 128, { allowEmpty: true })
      : "",
    name: optionalString(value, "name", 128),
    state: optionalString(value, "state", 128),
  };
}

function parseMembers(data: JsonRecord): EnterpriseWechatGroupChatMemberSnapshot[] {
  if (!Object.hasOwn(data, "member_list")) return incompleteSnapshot();
  if (!Array.isArray(data.member_list) || data.member_list.length > MAX_GROUP_MEMBERS) {
    return invalidSnapshot();
  }
  const members = data.member_list.map(parseMember);
  if (new Set(members.map((member) => member.userid)).size !== members.length) {
    return invalidSnapshot();
  }
  return members.sort((left, right) => left.userid.localeCompare(right.userid));
}

function parseAdmins(
  data: JsonRecord,
  employees: ReadonlySet<string>,
): string[] {
  if (!Object.hasOwn(data, "admin_list")) return incompleteSnapshot();
  if (!Array.isArray(data.admin_list) || data.admin_list.length > MAX_GROUP_ADMINS) {
    return invalidSnapshot();
  }
  const admins = data.admin_list.map((value) => {
    if (!isRecord(value) || !Object.hasOwn(value, "userid")) return invalidSnapshot();
    return providerIdentifier(value.userid, true);
  }).sort();
  if (
    new Set(admins).size !== admins.length
    || admins.some((userid) => !employees.has(userid))
  ) return invalidSnapshot();
  return admins;
}

export function isGroupChatProjectionEvent(
  event: Pick<GroupChatProjectionClaim, "msgType" | "eventType" | "changeType">,
): boolean {
  return event.msgType === "event"
    && event.eventType === "change_external_chat"
    && ["create", "update", "dismiss"].includes(event.changeType);
}

export function groupChatProjectionIdentity(claim: GroupChatProjectionClaim): string {
  if (!isGroupChatProjectionEvent(claim)) {
    throw new EnterpriseWechatGroupChatProjectionError("callback_group_chat_event_invalid");
  }
  return callbackIdentifier(claim.payload.ChatId);
}

/** Parse only one complete, authoritative group and member response. */
export function parseEnterpriseWechatGroupChatSnapshot(
  response: JsonRecord,
  expectedChatId: string,
): EnterpriseWechatGroupChatSnapshot {
  if (requiredInteger(response, "errcode", 0, 0) !== 0) return invalidSnapshot();
  if (!Object.hasOwn(response, "group_chat")) return incompleteSnapshot();
  if (!isRecord(response.group_chat)) return invalidSnapshot();
  const data = response.group_chat;
  const chatId = providerIdentifier(data.chat_id, false);
  if (chatId !== expectedChatId) return invalidSnapshot();
  const members = parseMembers(data);
  const employees = new Set(
    members.filter((member) => member.type === 1).map((member) => member.userid),
  );
  const owner = providerIdentifier(data.owner, true);
  if (!employees.has(owner)) return invalidSnapshot();

  return {
    chatId,
    name: requiredString(data, "name", 255, { allowEmpty: true }),
    owner,
    groupCreatedTime: requiredInteger(data, "create_time", 0, MAX_EPOCH),
    notice: requiredString(data, "notice", 2048, {
      allowEmpty: true,
      allowLineBreaks: true,
    }),
    adminList: parseAdmins(data, employees),
    providerStatus: requiredInteger(data, "status", 0, 255),
    members,
  };
}

/** Phase 2: execute the provider read outside every PostgreSQL transaction. */
export async function prepareGroupChatProjection(
  claim: GroupChatProjectionClaim,
  provider?: ExternalGroupChatProvider,
): Promise<PreparedGroupChatProjection> {
  const chatId = groupChatProjectionIdentity(claim);
  if (claim.changeType === "dismiss") {
    return { kind: "absent", chatId, source: "dismiss_callback" };
  }
  if (!provider) {
    throw new EnterpriseWechatProviderError(
      "configuration",
      "external_group_chat_provider_config",
      -1,
      0,
    );
  }

  try {
    const response = await provider.externalGroupChat(chatId);
    return {
      kind: "snapshot",
      chatId,
      snapshot: parseEnterpriseWechatGroupChatSnapshot(response, chatId),
    };
  } catch (error) {
    if (
      error instanceof EnterpriseWechatGroupChatProjectionError
      && error.errorCode === "callback_group_chat_snapshot_incomplete"
    ) {
      return { kind: "incomplete", chatId, source: "provider_scope_incomplete" };
    }
    if (error instanceof EnterpriseWechatProviderError && error.kind === "not_found") {
      // Provider not-found can also mean visibility or eventual-consistency
      // lag. Only the dismiss callback is terminal deletion authority.
      return { kind: "not_found", chatId, source: "provider_not_found" };
    }
    throw error;
  }
}
