import type { WorkCallbackPayload } from "@/models/schema";
import { shaHex } from "@/services/work/EnterpriseWechatCallbackCrypto";
import {
  EnterpriseWechatProviderError,
  type EnterpriseWechatProviderClient,
} from "@/services/work/EnterpriseWechatProviderClient";

const encoder = new TextEncoder();
const PROVIDER_IDENTIFIER = /^[A-Za-z0-9_@.-]+$/;
const MEMBER_ID = /^[A-Za-z0-9][A-Za-z0-9_@.-]{0,63}$/;
const MAX_PROVIDER_PAGES = 32;
const MAX_FOLLOWS_PER_PAGE = 500;
const MAX_TOTAL_FOLLOWS = 5_000;
const MAX_TOTAL_TAGS = 20_000;
const MAX_AGGREGATE_CANONICAL_BYTES = 4 * 1024 * 1024;
const MAX_TAGS_PER_FOLLOW = 256;
const MAX_REMARK_MOBILES = 20;
const MAX_JSON_DEPTH = 16;
const MAX_EXTERNAL_PROFILE_BYTES = 65_536;

type JsonRecord = Record<string, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type ExternalContactProvider = Pick<EnterpriseWechatProviderClient, "externalContact">;

export class EnterpriseWechatClientProjectionError extends Error {
  constructor(
    readonly errorCode: string,
    readonly terminal = true,
  ) {
    super(errorCode);
    this.name = "EnterpriseWechatClientProjectionError";
  }
}

export interface ClientProjectionClaim {
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
  /** Profile fence observed in phase 1 immediately before provider I/O. */
  clientProfileFenceEventIdAtFetch?: number;
}

export interface EnterpriseWechatClientTagSnapshot {
  tagKeyHash: string;
  tagId: string | null;
  groupName: string | null;
  tagName: string;
  type: number;
  sortOrder: number;
}

export interface EnterpriseWechatClientFollowSnapshot {
  userid: string;
  remark: string;
  description: string;
  followCreatedTime: number;
  remarkCorpName: string;
  remarkMobiles: string[];
  addWay: number;
  operUserid: string | null;
  state: string;
  tags: EnterpriseWechatClientTagSnapshot[];
}

export interface EnterpriseWechatClientSnapshot {
  externalUserid: string;
  name: string;
  avatar: string;
  type: number;
  gender: number;
  unionid: string;
  position: string;
  corpName: string;
  corpFullName: string;
  externalProfile: Record<string, unknown>;
  follows: EnterpriseWechatClientFollowSnapshot[];
}

export type PreparedClientProjection =
  | {
      kind: "snapshot";
      externalUserid: string;
      callbackUserid: string;
      snapshot: EnterpriseWechatClientSnapshot;
    }
  | {
      kind: "absent";
      externalUserid: string;
      userid: string;
      source: "delete_callback";
    }
  | {
      kind: "not_found";
      externalUserid: string;
      callbackUserid: string;
      source: "provider_not_found";
    }
  | {
      kind: "incomplete";
      externalUserid: string;
      callbackUserid: string;
      source: "provider_scope_incomplete";
    };

interface ParsedClientPage {
  profile: Omit<EnterpriseWechatClientSnapshot, "follows">;
  follows: Array<Omit<EnterpriseWechatClientFollowSnapshot, "tags"> & {
    tags: Array<Omit<EnterpriseWechatClientTagSnapshot, "tagKeyHash">>;
  }>;
  nextCursor?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidSnapshot(): never {
  throw new EnterpriseWechatClientProjectionError("callback_client_snapshot_invalid");
}

function incompleteSnapshot(): never {
  throw new EnterpriseWechatClientProjectionError(
    "callback_client_snapshot_incomplete",
    false,
  );
}

function driftingSnapshot(): never {
  throw new EnterpriseWechatClientProjectionError(
    "callback_client_snapshot_drift",
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

function boundedString(
  value: unknown,
  maximumCharacters: number,
  allowEmpty: boolean,
): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || (!allowEmpty && value.length === 0)
    || Array.from(value).length > maximumCharacters
    || encoder.encode(value).byteLength > maximumCharacters * 4
    || /[\u0000-\u001f\u007f]/.test(value)
  ) return invalidSnapshot();
  return value;
}

function requiredString(
  data: JsonRecord,
  field: string,
  maximumCharacters: number,
  allowEmpty: boolean,
): string {
  if (!Object.hasOwn(data, field)) return incompleteSnapshot();
  return boundedString(data[field], maximumCharacters, allowEmpty);
}

function optionalString(
  data: JsonRecord,
  field: string,
  maximumCharacters: number,
): string {
  if (!Object.hasOwn(data, field) || data[field] === null) return "";
  return boundedString(data[field], maximumCharacters, true);
}

function externalIdentity(value: unknown): string {
  const normalized = boundedString(value, 64, false);
  if (!PROVIDER_IDENTIFIER.test(normalized)) return invalidSnapshot();
  return normalized;
}

function memberIdentity(value: unknown): string {
  const normalized = boundedString(value, 64, false);
  if (!MEMBER_ID.test(normalized)) return invalidSnapshot();
  return normalized.toLowerCase();
}

function optionalMemberIdentity(data: JsonRecord, field: string): string | null {
  if (!Object.hasOwn(data, field) || data[field] === null || data[field] === "") return null;
  return memberIdentity(data[field]);
}

function canonicalJson(value: unknown, depth = 0): JsonValue {
  if (depth > MAX_JSON_DEPTH) return invalidSnapshot();
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalidSnapshot();
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalJson(item, depth + 1));
  if (!isRecord(value)) return invalidSnapshot();
  const output: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value).sort()) {
    if (
      key.length === 0
      || encoder.encode(key).byteLength > 256
      || /[\u0000-\u001f\u007f]/.test(key)
    ) return invalidSnapshot();
    output[key] = canonicalJson(value[key], depth + 1);
  }
  return output;
}

function externalProfile(data: JsonRecord): Record<string, unknown> {
  if (!Object.hasOwn(data, "external_profile")) return {};
  if (!isRecord(data.external_profile)) return invalidSnapshot();
  const normalized = canonicalJson(data.external_profile);
  if (!isRecord(normalized)) return invalidSnapshot();
  if (encoder.encode(JSON.stringify(normalized)).byteLength > MAX_EXTERNAL_PROFILE_BYTES) {
    return invalidSnapshot();
  }
  return normalized;
}

function remarkMobiles(data: JsonRecord): string[] {
  if (!Object.hasOwn(data, "remark_mobiles") || data.remark_mobiles === null) return [];
  if (!Array.isArray(data.remark_mobiles) || data.remark_mobiles.length > MAX_REMARK_MOBILES) {
    return invalidSnapshot();
  }
  const values = data.remark_mobiles.map((value) => boundedString(value, 32, false));
  if (new Set(values).size !== values.length) return invalidSnapshot();
  return values;
}

function tags(data: JsonRecord): ParsedClientPage["follows"][number]["tags"] {
  // The provider omits tags (or returns null) when the follow has no current
  // tag declaration. Only a present non-array value is malformed.
  if (!Object.hasOwn(data, "tags") || data.tags === null) return [];
  if (!Array.isArray(data.tags) || data.tags.length > MAX_TAGS_PER_FOLLOW) {
    return invalidSnapshot();
  }
  return data.tags.map((value, sortOrder) => {
    if (!isRecord(value)) return invalidSnapshot();
    const type = requiredInteger(value, "type", 1, 3);
    const rawTagId = optionalString(value, "tag_id", 128);
    const tagId = rawTagId || null;
    if (type !== 2 && !tagId) return incompleteSnapshot();
    const rawGroupName = optionalString(value, "group_name", 256);
    return {
      tagId,
      groupName: rawGroupName || null,
      tagName: requiredString(value, "tag_name", 256, false),
      type,
      sortOrder,
    };
  });
}

function follow(data: JsonRecord) {
  const userid = memberIdentity(data.userid);
  return {
    userid,
    remark: optionalString(data, "remark", 512),
    description: optionalString(data, "description", 1024),
    followCreatedTime: requiredInteger(data, "createtime", 0, 2_147_483_647),
    remarkCorpName: optionalString(data, "remark_corp_name", 128),
    remarkMobiles: remarkMobiles(data),
    addWay: requiredInteger(data, "add_way", 0, 1000),
    operUserid: optionalMemberIdentity(data, "oper_userid"),
    state: optionalString(data, "state", 128),
    tags: tags(data),
  };
}

/** Parse one provider page without treating an omitted critical collection as empty. */
export function parseEnterpriseWechatClientPage(
  response: JsonRecord,
  expectedExternalUserid: string,
): ParsedClientPage {
  if (requiredInteger(response, "errcode", 0, 0) !== 0) return invalidSnapshot();
  if (!Object.hasOwn(response, "external_contact") || !isRecord(response.external_contact)) {
    return incompleteSnapshot();
  }
  if (!Object.hasOwn(response, "follow_user")) return incompleteSnapshot();
  if (!Array.isArray(response.follow_user) || response.follow_user.length > MAX_FOLLOWS_PER_PAGE) {
    return invalidSnapshot();
  }
  const contact = response.external_contact;
  const externalUserid = externalIdentity(contact.external_userid);
  if (externalUserid !== expectedExternalUserid) return invalidSnapshot();
  const profile = {
    externalUserid,
    name: requiredString(contact, "name", 128, false),
    avatar: optionalString(contact, "avatar", 1024),
    type: requiredInteger(contact, "type", 1, 2),
    gender: requiredInteger(contact, "gender", 0, 2),
    unionid: optionalString(contact, "unionid", 128),
    position: optionalString(contact, "position", 128),
    corpName: optionalString(contact, "corp_name", 128),
    corpFullName: optionalString(contact, "corp_full_name", 256),
    externalProfile: externalProfile(contact),
  };
  const follows = response.follow_user.map((value) => {
    if (!isRecord(value)) return invalidSnapshot();
    return follow(value);
  });
  let nextCursor: string | undefined;
  if (Object.hasOwn(response, "next_cursor") && response.next_cursor !== null) {
    const cursor = boundedString(response.next_cursor, 512, true);
    if (cursor) {
      if (/\s/.test(cursor)) return invalidSnapshot();
      nextCursor = cursor;
    }
  }
  return { profile, follows, nextCursor };
}

export function isClientProjectionEvent(
  event: Pick<ClientProjectionClaim, "msgType" | "eventType" | "changeType">,
): boolean {
  return event.msgType === "event"
    && event.eventType === "change_external_contact"
    && [
      "add_external_contact",
      "edit_external_contact",
      "del_external_contact",
      "del_follow_user",
    ].includes(event.changeType);
}

export function clientProjectionIdentity(claim: ClientProjectionClaim): {
  externalUserid: string;
  userid: string;
} {
  if (!isClientProjectionEvent(claim)) {
    throw new EnterpriseWechatClientProjectionError("callback_client_event_invalid");
  }
  try {
    return {
      externalUserid: externalIdentity(claim.payload.ExternalUserID),
      userid: memberIdentity(claim.payload.UserID),
    };
  } catch {
    throw new EnterpriseWechatClientProjectionError("callback_projection_field_invalid");
  }
}

async function tagKeyHash(
  tag: Omit<EnterpriseWechatClientTagSnapshot, "tagKeyHash">,
): Promise<string> {
  return shaHex(
    "SHA-256",
    `${tag.type}\0${tag.tagId ?? ""}\0${tag.groupName ?? ""}\0${tag.tagName}`,
  );
}

/** Phase 2: exhaust every provider cursor outside all PostgreSQL transactions. */
export async function prepareClientProjection(
  claim: ClientProjectionClaim,
  provider?: ExternalContactProvider,
): Promise<PreparedClientProjection> {
  const identity = clientProjectionIdentity(claim);
  if (claim.changeType === "del_external_contact" || claim.changeType === "del_follow_user") {
    return { kind: "absent", ...identity, source: "delete_callback" };
  }
  if (!provider || typeof provider.externalContact !== "function") {
    throw new EnterpriseWechatProviderError(
      "configuration",
      "external_contact_provider_config",
      -1,
      0,
    );
  }

  try {
    const cursors = new Set<string>();
    const follows = new Map<string, EnterpriseWechatClientFollowSnapshot>();
    let aggregateCanonicalBytes = 0;
    let totalTags = 0;
    let expectedProfile: ParsedClientPage["profile"] | undefined;
    let expectedProfileJson = "";
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < MAX_PROVIDER_PAGES; pageNumber += 1) {
      const page = parseEnterpriseWechatClientPage(
        await provider.externalContact(identity.externalUserid, cursor),
        identity.externalUserid,
      );
      const profileJson = JSON.stringify(page.profile);
      aggregateCanonicalBytes += encoder.encode(JSON.stringify(page)).byteLength;
      if (aggregateCanonicalBytes > MAX_AGGREGATE_CANONICAL_BYTES) return invalidSnapshot();
      if (!expectedProfile) {
        expectedProfile = page.profile;
        expectedProfileJson = profileJson;
      } else if (profileJson !== expectedProfileJson) {
        return driftingSnapshot();
      }
      for (const rawFollow of page.follows) {
        if (follows.has(rawFollow.userid)) return driftingSnapshot();
        totalTags += rawFollow.tags.length;
        if (totalTags > MAX_TOTAL_TAGS) return invalidSnapshot();
        const hydratedTags = await Promise.all(rawFollow.tags.map(async (tag) => ({
          ...tag,
          tagKeyHash: await tagKeyHash(tag),
        })));
        if (new Set(hydratedTags.map((tag) => tag.tagKeyHash)).size !== hydratedTags.length) {
          return invalidSnapshot();
        }
        follows.set(rawFollow.userid, { ...rawFollow, tags: hydratedTags });
        if (follows.size > MAX_TOTAL_FOLLOWS) return invalidSnapshot();
      }
      if (!page.nextCursor) break;
      if (cursors.has(page.nextCursor)) return driftingSnapshot();
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
      if (pageNumber === MAX_PROVIDER_PAGES - 1) return driftingSnapshot();
    }
    if (!expectedProfile || !follows.has(identity.userid)) {
      return {
        kind: "incomplete",
        externalUserid: identity.externalUserid,
        callbackUserid: identity.userid,
        source: "provider_scope_incomplete",
      };
    }
    return {
      kind: "snapshot",
      externalUserid: identity.externalUserid,
      callbackUserid: identity.userid,
      snapshot: {
        ...expectedProfile,
        follows: [...follows.values()],
      },
    };
  } catch (error) {
    if (
      error instanceof EnterpriseWechatClientProjectionError
      && error.errorCode === "callback_client_snapshot_incomplete"
    ) {
      return {
        kind: "incomplete",
        externalUserid: identity.externalUserid,
        callbackUserid: identity.userid,
        source: "provider_scope_incomplete",
      };
    }
    if (error instanceof EnterpriseWechatProviderError && error.kind === "not_found") {
      return {
        kind: "not_found",
        externalUserid: identity.externalUserid,
        callbackUserid: identity.userid,
        source: "provider_not_found",
      };
    }
    throw error;
  }
}
