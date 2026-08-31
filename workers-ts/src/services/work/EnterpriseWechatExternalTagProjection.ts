import type { WorkCallbackPayload } from "@/models/schema";
import {
  EnterpriseWechatProviderError,
  type EnterpriseWechatProviderClient,
} from "@/services/work/EnterpriseWechatProviderClient";

const encoder = new TextEncoder();
const REMOTE_ID = /^[A-Za-z0-9][A-Za-z0-9_@.-]{0,127}$/;
const MAX_TAG_GROUPS = 1_000;
const MAX_TAGS = 3_000;
const MAX_EPOCH = 2_147_483_647;

type JsonRecord = Record<string, unknown>;
type ExternalTagProvider = Pick<
  EnterpriseWechatProviderClient,
  "corpTagList" | "strategyTagList"
>;

export class EnterpriseWechatExternalTagProjectionError extends Error {
  constructor(
    readonly errorCode: string,
    readonly terminal = true,
  ) {
    super(errorCode);
    this.name = "EnterpriseWechatExternalTagProjectionError";
  }
}

export interface ExternalTagProjectionClaim {
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

export type ExternalTagSubjectType = "tag" | "tag_group" | "catalog";

export interface ExternalTagProjectionIdentity {
  strategyId: number;
  subjectType: ExternalTagSubjectType;
  remoteId: string;
  /** Provider omission is authoritative only inside this scope. */
  scope: "tag" | "group" | "catalog";
}

export interface EnterpriseWechatExternalTagSnapshot {
  tagId: string;
  name: string;
  sortOrder: number;
  providerCreateTime: number;
  deleted: boolean;
}

export interface EnterpriseWechatExternalTagGroupSnapshot {
  groupId: string;
  groupName: string;
  sortOrder: number;
  providerCreateTime: number;
  deleted: boolean;
  tags: EnterpriseWechatExternalTagSnapshot[];
}

export interface EnterpriseWechatExternalTagCatalogSnapshot {
  strategyId: number;
  scope: "tag" | "group" | "catalog";
  expectedRemoteId: string;
  groups: EnterpriseWechatExternalTagGroupSnapshot[];
}

export type PreparedExternalTagProjection =
  | {
      kind: "snapshot";
      identity: ExternalTagProjectionIdentity;
      snapshot: EnterpriseWechatExternalTagCatalogSnapshot;
    }
  | {
      kind: "absent";
      identity: ExternalTagProjectionIdentity;
      source: "delete_callback";
    }
  | {
      kind: "not_found";
      identity: ExternalTagProjectionIdentity;
      source: "provider_not_found";
    }
  | {
      kind: "incomplete";
      identity: ExternalTagProjectionIdentity;
      source: "provider_scope_incomplete";
    };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidSnapshot(): never {
  throw new EnterpriseWechatExternalTagProjectionError(
    "callback_external_tag_snapshot_invalid",
  );
}

function incompleteSnapshot(): never {
  throw new EnterpriseWechatExternalTagProjectionError(
    "callback_external_tag_snapshot_incomplete",
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

function callbackStrategyId(payload: WorkCallbackPayload): number {
  const value = payload.StrategyId;
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > MAX_EPOCH) {
    throw new EnterpriseWechatExternalTagProjectionError(
      "callback_external_tag_strategy_invalid",
    );
  }
  return Number(value);
}

function remoteIdentifier(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || !REMOTE_ID.test(value)) {
    return invalidSnapshot();
  }
  return value;
}

function callbackRemoteIdentifier(value: unknown, allowEmpty = false): string {
  if (allowEmpty && (value === undefined || value === "")) return "";
  if (typeof value !== "string" || value !== value.trim() || !REMOTE_ID.test(value)) {
    throw new EnterpriseWechatExternalTagProjectionError(
      "callback_projection_field_invalid",
    );
  }
  return value;
}

function requiredName(data: JsonRecord, field: string): string {
  if (!Object.hasOwn(data, field)) return incompleteSnapshot();
  const value = data[field];
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length === 0
    || Array.from(value).length > 256
    || encoder.encode(value).byteLength > 1_024
    || /[\u0000-\u001f\u007f]/.test(value)
  ) return invalidSnapshot();
  return value;
}

function deletedFlag(data: JsonRecord, strategyId: number): boolean {
  if (strategyId > 0) {
    if (Object.hasOwn(data, "deleted")) return invalidSnapshot();
    return false;
  }
  if (!Object.hasOwn(data, "deleted")) return incompleteSnapshot();
  if (typeof data.deleted !== "boolean") return invalidSnapshot();
  return data.deleted;
}

function parseTag(value: unknown, strategyId: number): EnterpriseWechatExternalTagSnapshot {
  if (!isRecord(value)) return invalidSnapshot();
  return {
    tagId: remoteIdentifier(value.id),
    name: requiredName(value, "name"),
    sortOrder: requiredInteger(value, "order", 0, MAX_EPOCH),
    providerCreateTime: requiredInteger(value, "create_time", 0, MAX_EPOCH),
    deleted: deletedFlag(value, strategyId),
  };
}

function parseGroup(
  value: unknown,
  strategyId: number,
): EnterpriseWechatExternalTagGroupSnapshot {
  if (!isRecord(value)) return invalidSnapshot();
  if (strategyId > 0) {
    if (!Object.hasOwn(value, "strategy_id")) return incompleteSnapshot();
    if (canonicalInteger(value.strategy_id, 1, MAX_EPOCH) !== strategyId) {
      return invalidSnapshot();
    }
  } else if (Object.hasOwn(value, "strategy_id") && value.strategy_id !== 0) {
    return invalidSnapshot();
  }
  if (!Object.hasOwn(value, "tag")) return incompleteSnapshot();
  if (!Array.isArray(value.tag) || value.tag.length > MAX_TAGS) return invalidSnapshot();
  const tags = value.tag.map((tag) => parseTag(tag, strategyId));
  if (new Set(tags.map((tag) => tag.tagId)).size !== tags.length) return invalidSnapshot();
  return {
    groupId: remoteIdentifier(value.group_id),
    groupName: requiredName(value, "group_name"),
    sortOrder: requiredInteger(value, "order", 0, MAX_EPOCH),
    providerCreateTime: requiredInteger(value, "create_time", 0, MAX_EPOCH),
    deleted: deletedFlag(value, strategyId),
    tags: tags.sort((left, right) =>
      left.sortOrder - right.sortOrder || left.tagId.localeCompare(right.tagId)),
  };
}

export function isExternalTagProjectionEvent(
  event: Pick<ExternalTagProjectionClaim, "msgType" | "eventType" | "changeType">,
): boolean {
  return event.msgType === "event"
    && event.eventType === "change_external_tag"
    && ["create", "update", "delete", "shuffle"].includes(event.changeType);
}

export function externalTagProjectionIdentity(
  claim: ExternalTagProjectionClaim,
): ExternalTagProjectionIdentity {
  if (!isExternalTagProjectionEvent(claim)) {
    throw new EnterpriseWechatExternalTagProjectionError(
      "callback_external_tag_event_invalid",
    );
  }
  const strategyId = callbackStrategyId(claim.payload);
  if (claim.changeType === "shuffle") {
    const id = callbackRemoteIdentifier(claim.payload.Id, true);
    return {
      strategyId,
      subjectType: "catalog",
      remoteId: id || "*",
      scope: id ? "group" : "catalog",
    };
  }
  const tagType = claim.payload.TagType;
  if (tagType !== "tag" && tagType !== "tag_group") {
    throw new EnterpriseWechatExternalTagProjectionError(
      "callback_external_tag_type_invalid",
    );
  }
  return {
    strategyId,
    subjectType: tagType,
    remoteId: callbackRemoteIdentifier(claim.payload.Id),
    scope: tagType === "tag" ? "tag" : "group",
  };
}

export function parseEnterpriseWechatExternalTagCatalogSnapshot(
  response: JsonRecord,
  identity: ExternalTagProjectionIdentity,
): EnterpriseWechatExternalTagCatalogSnapshot {
  if (requiredInteger(response, "errcode", 0, 0) !== 0) return invalidSnapshot();
  if (!Object.hasOwn(response, "tag_group")) return incompleteSnapshot();
  if (!Array.isArray(response.tag_group) || response.tag_group.length > MAX_TAG_GROUPS) {
    return invalidSnapshot();
  }
  const groups = response.tag_group.map((group) => parseGroup(group, identity.strategyId));
  if (new Set(groups.map((group) => group.groupId)).size !== groups.length) {
    return invalidSnapshot();
  }
  const allTagIds = groups.flatMap((group) => group.tags.map((tag) => tag.tagId));
  if (allTagIds.length > MAX_TAGS || new Set(allTagIds).size !== allTagIds.length) {
    return invalidSnapshot();
  }
  if (identity.scope !== "catalog" && groups.length !== 1) return invalidSnapshot();

  if (
    identity.scope === "group"
    && !groups.some((group) => group.groupId === identity.remoteId)
  ) return incompleteSnapshot();
  if (
    identity.scope === "tag"
    && !groups.some((group) => group.tags.some((tag) => tag.tagId === identity.remoteId))
  ) return incompleteSnapshot();

  return {
    strategyId: identity.strategyId,
    scope: identity.scope,
    expectedRemoteId: identity.remoteId,
    groups: groups.sort((left, right) =>
      left.sortOrder - right.sortOrder || left.groupId.localeCompare(right.groupId)),
  };
}

/** Phase 2: execute the provider read outside every PostgreSQL transaction. */
export async function prepareExternalTagProjection(
  claim: ExternalTagProjectionClaim,
  provider?: ExternalTagProvider,
): Promise<PreparedExternalTagProjection> {
  const identity = externalTagProjectionIdentity(claim);
  if (claim.changeType === "delete") {
    return { kind: "absent", identity, source: "delete_callback" };
  }
  if (!provider) {
    throw new EnterpriseWechatProviderError(
      "configuration",
      "external_tag_provider_config",
      -1,
      0,
    );
  }

  const tagIds = identity.scope === "tag" ? [identity.remoteId] : [];
  const groupIds = identity.scope === "group" ? [identity.remoteId] : [];
  try {
    const response = identity.strategyId > 0
      ? await provider.strategyTagList(identity.strategyId, tagIds, groupIds)
      : await provider.corpTagList(tagIds, groupIds);
    return {
      kind: "snapshot",
      identity,
      snapshot: parseEnterpriseWechatExternalTagCatalogSnapshot(response, identity),
    };
  } catch (error) {
    if (
      error instanceof EnterpriseWechatExternalTagProjectionError
      && error.errorCode === "callback_external_tag_snapshot_incomplete"
    ) {
      return { kind: "incomplete", identity, source: "provider_scope_incomplete" };
    }
    if (error instanceof EnterpriseWechatProviderError && error.kind === "not_found") {
      return { kind: "not_found", identity, source: "provider_not_found" };
    }
    throw error;
  }
}
