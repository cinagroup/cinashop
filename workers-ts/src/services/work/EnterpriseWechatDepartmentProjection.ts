import type { WorkCallbackPayload } from "@/models/schema";
import {
  EnterpriseWechatProviderError,
  type EnterpriseWechatProviderClient,
} from "@/services/work/EnterpriseWechatProviderClient";

/** Maximum number of parent edges accepted and traversed for one department. */
export const MAX_DEPARTMENT_ANCESTOR_DEPTH = 256;

const encoder = new TextEncoder();
const MEMBER_ID = /^[A-Za-z0-9][A-Za-z0-9_@.-]{0,63}$/;
const MAX_DEPARTMENT_ID = 2_147_483_647;
// Enterprise WeChat documents at most ten department leaders. Keep this
// provider boundary strict so one response cannot create an oversized bind
// list while a projection transaction holds ordering locks.
const MAX_DEPARTMENT_LEADERS = 10;

type JsonRecord = Record<string, unknown>;
type DirectoryDepartmentProvider = Pick<EnterpriseWechatProviderClient, "directoryDepartment">;

export class EnterpriseWechatDepartmentProjectionError extends Error {
  constructor(
    readonly errorCode: string,
    readonly terminal = true,
  ) {
    super(errorCode);
    this.name = "EnterpriseWechatDepartmentProjectionError";
  }
}

export interface DepartmentProjectionClaim {
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

export interface EnterpriseWechatDepartmentSnapshot {
  departmentId: number;
  name: string;
  nameEn: string;
  parentDepartmentId: number | null;
  sortOrder: number;
  leaders: string[];
}

export type PreparedDepartmentProjection =
  | {
      kind: "snapshot";
      departmentId: number;
      snapshot: EnterpriseWechatDepartmentSnapshot;
    }
  | {
      kind: "absent";
      departmentId: number;
      source: "delete_callback";
    }
  | {
      kind: "not_found";
      departmentId: number;
      source: "provider_not_found";
    }
  | {
      kind: "incomplete";
      departmentId: number;
      source: "provider_scope_incomplete";
    };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidSnapshot(): never {
  throw new EnterpriseWechatDepartmentProjectionError("callback_department_snapshot_invalid");
}

function incompleteSnapshot(): never {
  throw new EnterpriseWechatDepartmentProjectionError(
    "callback_department_snapshot_incomplete",
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

function requiredString(
  data: JsonRecord,
  field: string,
  maximumCharacters: number,
  allowEmpty: boolean,
): string {
  if (!Object.hasOwn(data, field)) return incompleteSnapshot();
  const value = data[field];
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

function leaderIdentifier(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || !MEMBER_ID.test(value)) {
    return invalidSnapshot();
  }
  return value.toLowerCase();
}

function requiredLeaders(data: JsonRecord): string[] {
  if (!Object.hasOwn(data, "department_leader")) return incompleteSnapshot();
  const value = data.department_leader;
  if (!Array.isArray(value) || value.length > MAX_DEPARTMENT_LEADERS) {
    return invalidSnapshot();
  }
  const leaders = value.map(leaderIdentifier);
  if (new Set(leaders).size !== leaders.length) return invalidSnapshot();
  return leaders;
}

export function isDepartmentProjectionEvent(
  event: Pick<DepartmentProjectionClaim, "msgType" | "eventType" | "changeType">,
): boolean {
  return event.msgType === "event"
    && event.eventType === "change_contact"
    && ["create_party", "update_party", "delete_party"].includes(event.changeType);
}

export function departmentProjectionIdentity(claim: DepartmentProjectionClaim): number {
  if (!isDepartmentProjectionEvent(claim)) {
    throw new EnterpriseWechatDepartmentProjectionError("callback_department_event_invalid");
  }
  const raw = claim.payload.Id;
  if (typeof raw !== "string" || !/^[1-9]\d{0,9}$/.test(raw)) {
    throw new EnterpriseWechatDepartmentProjectionError("callback_projection_field_invalid");
  }
  const departmentId = Number(raw);
  if (!Number.isSafeInteger(departmentId) || departmentId > MAX_DEPARTMENT_ID) {
    throw new EnterpriseWechatDepartmentProjectionError("callback_projection_field_invalid");
  }
  return departmentId;
}

/** Parse only a complete, authoritative department detail response. */
export function parseEnterpriseWechatDepartmentSnapshot(
  response: JsonRecord,
  expectedDepartmentId: number,
): EnterpriseWechatDepartmentSnapshot {
  if (requiredInteger(response, "errcode", 0, 0) !== 0) return invalidSnapshot();
  if (!Object.hasOwn(response, "department")) return incompleteSnapshot();
  if (!isRecord(response.department)) return invalidSnapshot();
  const data = response.department;
  const departmentId = requiredInteger(data, "id", 1, MAX_DEPARTMENT_ID);
  if (departmentId !== expectedDepartmentId) return invalidSnapshot();
  const parentId = requiredInteger(data, "parentid", 0, MAX_DEPARTMENT_ID);
  if (parentId === departmentId) return invalidSnapshot();

  return {
    departmentId,
    name: requiredString(data, "name", 128, false),
    nameEn: requiredString(data, "name_en", 128, true),
    parentDepartmentId: parentId === 0 ? null : parentId,
    sortOrder: requiredInteger(data, "order", 0, 4_294_967_295),
    leaders: requiredLeaders(data),
  };
}

/** Phase 2: execute the provider read outside every PostgreSQL transaction. */
export async function prepareDepartmentProjection(
  claim: DepartmentProjectionClaim,
  provider?: DirectoryDepartmentProvider,
): Promise<PreparedDepartmentProjection> {
  const departmentId = departmentProjectionIdentity(claim);
  if (claim.changeType === "delete_party") {
    return { kind: "absent", departmentId, source: "delete_callback" };
  }
  if (!provider) {
    throw new EnterpriseWechatProviderError(
      "configuration",
      "directory_provider_config",
      -1,
      0,
    );
  }

  try {
    const response = await provider.directoryDepartment(departmentId);
    return {
      kind: "snapshot",
      departmentId,
      snapshot: parseEnterpriseWechatDepartmentSnapshot(response, departmentId),
    };
  } catch (error) {
    if (
      error instanceof EnterpriseWechatDepartmentProjectionError
      && error.errorCode === "callback_department_snapshot_incomplete"
    ) {
      return {
        kind: "incomplete",
        departmentId,
        source: "provider_scope_incomplete",
      };
    }
    if (error instanceof EnterpriseWechatProviderError && error.kind === "not_found") {
      // 60003/60123 can also mean that the department is outside the
      // credential's visible scope. Only delete_party is deletion authority.
      return { kind: "not_found", departmentId, source: "provider_not_found" };
    }
    throw error;
  }
}
