/** Pure enterprise corporate-tag wire schemas. No credentials, transport, or
 * provider error text is retained by these validators. */
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** This author's bounded create batch, not a documented provider batch limit. */
export interface CorpTagCreateRequest {
  group_id?: string;
  group_name?: string;
  order?: number;
  tag: Array<{ name: string; order?: number }>;
}


function corpTagName(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0
    && [...value].length <= 30 && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value);
}
function corpTagOrder(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
}
function corpTagId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_@.-]{0,63}$/u.test(value);
}
/** The caller supplies its metadata-only failure policy; all field validation
 * and the defensive request copy stay in this protocol module. */
/** No implicit strings, duplicate names, ignored group-name/order fields, or
 * caller mutation may change the exact durable command after dispatch. */
export function copyCorpTagCreateRequest(value: unknown, invalid: () => never): CorpTagCreateRequest {
  if (!isRecord(value) || Object.keys(value).some(key => !["group_id", "group_name", "order", "tag"].includes(key))) return invalid();
  const byId = Object.hasOwn(value, "group_id"), byName = Object.hasOwn(value, "group_name");
  if (byId === byName || byId && (!corpTagId(value.group_id) || Object.hasOwn(value, "order"))
    || byName && (!corpTagName(value.group_name) || Object.hasOwn(value, "order") && !corpTagOrder(value.order))
    || !Array.isArray(value.tag) || value.tag.length < 1 || value.tag.length > 100) return invalid();
  const names = new Set<string>();
  const tags = value.tag.map(item => {
    if (!isRecord(item) || Object.keys(item).some(key => !["name", "order"].includes(key)) || !corpTagName(item.name)
      || Object.hasOwn(item, "order") && !corpTagOrder(item.order) || names.has(item.name)) return invalid();
    names.add(item.name);
    return { name: item.name, ...(Object.hasOwn(item, "order") ? { order: item.order as number } : {}) };
  });
  return { ...(byId ? { group_id: value.group_id as string } : { group_name: value.group_name as string }),
    ...(Object.hasOwn(value, "order") ? { order: value.order as number } : {}), tag: tags };
}

/** A success ACK is not a complete directory or an idempotency receipt. A
 * malformed/partial ACK remains UNKNOWN and requires a fresh directory read. */
export function isCorpTagCreateResponse(value: unknown, expected: CorpTagCreateRequest): value is JsonRecord {
  if (!isRecord(value) || value.errcode !== 0 || Object.keys(value).some(key => !["errcode", "errmsg", "tag_group"].includes(key))
    || Object.hasOwn(value, "errmsg") && typeof value.errmsg !== "string" || !isRecord(value.tag_group)) return false;
  const group = value.tag_group;
  if (Object.keys(group).some(key => !["group_id", "group_name", "create_time", "order", "tag"].includes(key))
    || !corpTagId(group.group_id) || !corpTagName(group.group_name) || !corpTagOrder(group.order)
    || !corpTagOrder(group.create_time) || expected.group_id !== undefined && group.group_id !== expected.group_id
    || expected.group_name !== undefined && group.group_name !== expected.group_name
    || !Array.isArray(group.tag) || group.tag.length !== expected.tag.length) return false;
  const names = new Set<string>(), ids = new Set<string>();
  for (const tag of group.tag) {
    if (!isRecord(tag) || Object.keys(tag).some(key => !["id", "name", "create_time", "order"].includes(key))
      || !corpTagId(tag.id) || !corpTagName(tag.name) || !corpTagOrder(tag.order) || !corpTagOrder(tag.create_time)
      || ids.has(tag.id) || names.has(tag.name) || !expected.tag.some(item => item.name === tag.name)) return false;
    ids.add(tag.id); names.add(tag.name);
  }
  return true;
}
