import type { WorkCallbackPayload } from "@/models/schema";
import {
  EnterpriseWechatProviderError,
  type EnterpriseWechatProviderClient,
} from "@/services/work/EnterpriseWechatProviderClient";

const encoder = new TextEncoder();
const MEMBER_ID = /^[A-Za-z0-9][A-Za-z0-9_@.-]{0,63}$/;
const MAX_DEPARTMENTS = 100;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_NODES = 2_000;

type JsonRecord = Record<string, unknown>;
type DirectoryMemberProvider = Pick<EnterpriseWechatProviderClient, "directoryMember">;

export class EnterpriseWechatMemberProjectionError extends Error {
  constructor(
    readonly errorCode: string,
    readonly terminal = true,
  ) {
    super(errorCode);
    this.name = "EnterpriseWechatMemberProjectionError";
  }
}

export interface MemberProjectionClaim {
  eventId: number;
  eventKey: string;
  eventTime: number;
  sequenceRank: number;
  corpId: string;
  msgType: string;
  eventType: string;
  changeType: string;
  payload: WorkCallbackPayload;
}

export interface EnterpriseWechatMemberSnapshot {
  userid: string;
  name: string;
  position?: string;
  mobile?: string;
  gender?: number;
  email?: string;
  bizMail?: string;
  directLeader?: string;
  avatar?: string;
  thumbAvatar?: string;
  telephone?: string;
  alias?: string;
  enable: number;
  isLeader: number;
  hideMobile?: number;
  address?: string;
  openUserid?: string;
  mainDepartment: number;
  status: number;
  qrCode?: string;
  externalPosition?: string;
  extattr?: string;
  externalProfile?: string;
  profileComplete: boolean;
  departments: Array<{
    departmentId: number;
    sortOrder: number;
    isLeaderInDepartment: number;
  }>;
}

export type PreparedMemberProjection =
  | {
      kind: "snapshot";
      previousUserid: string;
      targetUserid: string;
      renamed: boolean;
      snapshot: EnterpriseWechatMemberSnapshot;
    }
  | {
      kind: "absent";
      previousUserid: string;
      targetUserid: string;
      renamed: false;
      source: "delete_callback";
    }
  | {
      kind: "not_found";
      previousUserid: string;
      targetUserid: string;
      renamed: boolean;
      source: "provider_not_found";
    }
  | {
      kind: "incomplete";
      previousUserid: string;
      targetUserid: string;
      renamed: boolean;
      source: "provider_scope_incomplete";
    };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function invalidSnapshot(): never {
  throw new EnterpriseWechatMemberProjectionError("callback_member_snapshot_invalid");
}

function incompleteSnapshot(): never {
  throw new EnterpriseWechatMemberProjectionError("callback_member_snapshot_incomplete", false);
}

function memberIdentifier(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || !MEMBER_ID.test(value)) {
    return invalidSnapshot();
  }
  return value.toLowerCase();
}

function callbackIdentifier(payload: WorkCallbackPayload, field: string, required = true): string {
  const raw = payload[field];
  if ((raw === undefined || raw === "") && !required) return "";
  if (typeof raw !== "string" || raw !== raw.trim() || !MEMBER_ID.test(raw)) {
    throw new EnterpriseWechatMemberProjectionError("callback_projection_field_invalid");
  }
  return raw.toLowerCase();
}

function requiredString(
  data: JsonRecord,
  field: string,
  maximumCharacters: number,
  allowEmpty = true,
): string {
  if (!Object.hasOwn(data, field)) return incompleteSnapshot();
  if (typeof data[field] !== "string") return invalidSnapshot();
  const value = data[field];
  if (
    (!allowEmpty && value.length === 0)
    || Array.from(value).length > maximumCharacters
    || bytes(value) > maximumCharacters * 4
    || value.includes("\0")
  ) {
    return invalidSnapshot();
  }
  return value;
}

function optionalString(data: JsonRecord, field: string, maximumCharacters: number): string | undefined {
  return Object.hasOwn(data, field)
    ? requiredString(data, field, maximumCharacters)
    : undefined;
}

function canonicalInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    return invalidSnapshot();
  }
  return Number(value);
}

function requiredInteger(data: JsonRecord, field: string, minimum: number, maximum: number): number {
  if (!Object.hasOwn(data, field)) return incompleteSnapshot();
  return canonicalInteger(data[field], minimum, maximum);
}

function optionalInteger(data: JsonRecord, field: string, minimum: number, maximum: number): number | undefined {
  return Object.hasOwn(data, field) ? canonicalInteger(data[field], minimum, maximum) : undefined;
}

function requiredIntegerArray(
  data: JsonRecord,
  field: string,
  minimum: number,
  maximum: number,
): number[] {
  const value = data[field];
  if (!Object.hasOwn(data, field)) return incompleteSnapshot();
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DEPARTMENTS) {
    return invalidSnapshot();
  }
  return value.map((item) => {
    if (typeof item !== "number") return invalidSnapshot();
    return canonicalInteger(item, minimum, maximum);
  });
}

function requiredIdentifierArray(data: JsonRecord, field: string, maximumItems: number): string[] {
  const value = data[field];
  if (!Object.hasOwn(data, field)) return incompleteSnapshot();
  if (!Array.isArray(value) || value.length > maximumItems) return invalidSnapshot();
  return value.map(memberIdentifier);
}

function optionalIdentifierArray(data: JsonRecord, field: string, maximumItems: number): string[] | undefined {
  return Object.hasOwn(data, field)
    ? requiredIdentifierArray(data, field, maximumItems)
    : undefined;
}

function normalizedJson(value: unknown): string {
  let nodes = 0;
  const normalize = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return invalidSnapshot();
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) return invalidSnapshot();
      return candidate;
    }
    if (typeof candidate === "string") {
      if (bytes(candidate) > 8 * 1024 || candidate.includes("\0")) return invalidSnapshot();
      return candidate;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > 200) return invalidSnapshot();
      return candidate.map((item) => normalize(item, depth + 1));
    }
    if (!isRecord(candidate)) return invalidSnapshot();
    const keys = Object.keys(candidate).sort();
    if (keys.length > 200 || keys.some((key) => bytes(key) > 256 || key.includes("\0"))) {
      return invalidSnapshot();
    }
    const output: JsonRecord = {};
    for (const key of keys) output[key] = normalize(candidate[key], depth + 1);
    return output;
  };
  const canonical = JSON.stringify(normalize(value, 0));
  if (bytes(canonical) > MAX_JSON_BYTES) return invalidSnapshot();
  return canonical;
}

function requiredJsonObject(data: JsonRecord, field: string): string {
  if (!Object.hasOwn(data, field)) return incompleteSnapshot();
  if (!isRecord(data[field])) return invalidSnapshot();
  return normalizedJson(data[field]);
}

function optionalJsonObject(data: JsonRecord, field: string): string | undefined {
  return Object.hasOwn(data, field) ? requiredJsonObject(data, field) : undefined;
}

/**
 * Parse only a complete directory snapshot. Missing provider fields are not
 * replaced with database defaults, so an under-scoped credential fails closed.
 */
export function parseEnterpriseWechatMemberSnapshot(
  data: JsonRecord,
  expectedUserid: string,
): EnterpriseWechatMemberSnapshot {
  if (requiredInteger(data, "errcode", 0, 0) !== 0) return invalidSnapshot();
  const userid = memberIdentifier(data.userid);
  if (userid !== expectedUserid) return invalidSnapshot();

  const departments = requiredIntegerArray(data, "department", 1, 2_147_483_647);
  const order = requiredIntegerArray(data, "order", 0, 4_294_967_295);
  const leaders = requiredIntegerArray(data, "is_leader_in_dept", 0, 1);
  if (departments.length !== order.length || departments.length !== leaders.length) {
    return invalidSnapshot();
  }
  if (new Set(departments).size !== departments.length) return invalidSnapshot();
  const mainDepartment = requiredInteger(data, "main_department", 1, 2_147_483_647);
  if (!departments.includes(mainDepartment)) return invalidSnapshot();
  const directLeaders = optionalIdentifierArray(data, "direct_leader", 1);
  const status = requiredInteger(data, "status", 1, 5);
  if (![1, 2, 4, 5].includes(status)) return invalidSnapshot();
  const optionalProfileFields = [
    "position", "mobile", "gender", "email", "biz_mail", "direct_leader",
    "avatar", "thumb_avatar", "telephone", "alias", "hide_mobile", "address",
    "open_userid", "qr_code", "external_position", "extattr", "external_profile",
  ];

  return {
    userid,
    name: requiredString(data, "name", 64, false),
    position: optionalString(data, "position", 128),
    mobile: optionalString(data, "mobile", 32),
    gender: optionalInteger(data, "gender", 0, 2),
    email: optionalString(data, "email", 254),
    bizMail: optionalString(data, "biz_mail", 254),
    directLeader: directLeaders === undefined ? undefined : JSON.stringify(directLeaders),
    avatar: optionalString(data, "avatar", 1_024),
    thumbAvatar: optionalString(data, "thumb_avatar", 1_024),
    telephone: optionalString(data, "telephone", 64),
    alias: optionalString(data, "alias", 64),
    enable: status === 1 || status === 4 ? 1 : 0,
    isLeader: leaders.some((value) => value === 1) ? 1 : 0,
    hideMobile: optionalInteger(data, "hide_mobile", 0, 1),
    address: optionalString(data, "address", 512),
    openUserid: optionalString(data, "open_userid", 128),
    mainDepartment,
    status,
    qrCode: optionalString(data, "qr_code", 1_024),
    externalPosition: optionalString(data, "external_position", 128),
    extattr: optionalJsonObject(data, "extattr"),
    externalProfile: optionalJsonObject(data, "external_profile"),
    profileComplete: optionalProfileFields.every((field) => Object.hasOwn(data, field)),
    departments: departments.map((departmentId, index) => ({
      departmentId,
      sortOrder: order[index],
      isLeaderInDepartment: leaders[index],
    })),
  };
}

export function isMemberProjectionEvent(
  event: Pick<MemberProjectionClaim, "msgType" | "eventType" | "changeType">,
): boolean {
  return event.msgType === "event"
    && event.eventType === "change_contact"
    && ["create_user", "update_user", "delete_user"].includes(event.changeType);
}

export function memberProjectionIdentity(claim: MemberProjectionClaim): {
  previousUserid: string;
  targetUserid: string;
  renamed: boolean;
} {
  if (!isMemberProjectionEvent(claim)) {
    throw new EnterpriseWechatMemberProjectionError("callback_member_event_invalid");
  }
  const previousUserid = callbackIdentifier(claim.payload, "UserID");
  const newUserid = claim.changeType === "update_user"
    ? callbackIdentifier(claim.payload, "NewUserID", false)
    : "";
  const targetUserid = newUserid || previousUserid;
  return {
    previousUserid,
    targetUserid,
    renamed: targetUserid !== previousUserid,
  };
}

/** Phase 2: execute the provider read outside every PostgreSQL transaction. */
export async function prepareMemberProjection(
  claim: MemberProjectionClaim,
  provider?: DirectoryMemberProvider,
): Promise<PreparedMemberProjection> {
  const { previousUserid, targetUserid, renamed } = memberProjectionIdentity(claim);

  if (claim.changeType === "delete_user") {
    return {
      kind: "absent",
      previousUserid,
      targetUserid: previousUserid,
      renamed: false,
      source: "delete_callback",
    };
  }

  if (!provider) {
    throw new EnterpriseWechatProviderError("configuration", "directory_provider_config", -1, 0);
  }

  try {
    const response = await provider.directoryMember(targetUserid);
    return {
      kind: "snapshot",
      previousUserid,
      targetUserid,
      renamed,
      snapshot: parseEnterpriseWechatMemberSnapshot(response, targetUserid),
    };
  } catch (error) {
    if (
      error instanceof EnterpriseWechatMemberProjectionError
      && error.errorCode === "callback_member_snapshot_incomplete"
    ) {
      return {
        kind: "incomplete",
        previousUserid,
        targetUserid,
        renamed,
        source: "provider_scope_incomplete",
      };
    }
    if (error instanceof EnterpriseWechatProviderError && error.kind === "not_found") {
      // 60111 also covers members outside this application's visible scope.
      // Keep the projection unresolved; only delete_user is deletion authority.
      return {
        kind: "not_found",
        previousUserid,
        targetUserid,
        renamed,
        source: "provider_not_found",
      };
    }
    throw error;
  }
}
