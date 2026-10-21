import { communityInbound, communityQuery, communitySharePath } from './communityShare';
export type CommunityPeopleTab = "friend" | "follow" | "fans" | "recommend";

/** A legacy numeric type selects a list; it never selects another actor. */
export function parseCommunityPeopleTab(query: Readonly<Record<string, unknown>> = {}): CommunityPeopleTab | null {
  const tab = query.tab, type = query.type;
  if (tab !== undefined && type !== undefined) return null;
  if (tab !== undefined) return typeof tab === "string" && ["friend", "follow", "fans", "recommend"].includes(tab)
    ? tab as CommunityPeopleTab : null;
  if (type !== undefined) return type === "0" ? "follow" : type === "1" ? "friend" : type === "2" ? "fans" : null;
  return "friend";
}

export type CommunityWorkspaceEntry = { kind: "feed" } | { kind: "author"; authorId: number | "self" }
  | { kind: "publish"; editId: number; topicId: number };
function entryQuery(input: Readonly<Record<string, unknown>>): Record<string, string | undefined> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("社区地址参数无效");
  for (const value of Object.values(input)) if (value !== undefined && (typeof value !== "string" || value.length > 2048)) throw Error("社区地址参数无效");
  return input as Record<string, string | undefined>;
}
function entryId(value: string, zero = false): number {
  if (!(zero ? /^(0|[1-9]\d{0,9})$/u : /^[1-9]\d{0,9}$/u).test(value) || Number(value) > 2147483647) throw Error("社区地址编号无效");
  return Number(value);
}
/** Validate every mode before a page starts reads or consumes referral intent. */
export function parseCommunityWorkspaceEntry(input: Readonly<Record<string, unknown>>): CommunityWorkspaceEntry {
  const q = entryQuery(input), publishing = q.publish !== undefined, author = q.author_id !== undefined;
  const post = [q.id, q.post_id, q.post_type].some(value => value !== undefined);
  if (publishing && q.publish !== "1" || publishing && author || post && (publishing || author)
    || !publishing && (q.edit_id !== undefined || q.topic_id !== undefined)) throw Error("社区地址参数冲突或无效");
  if (author) return { kind: "author", authorId: q.author_id === "self" ? "self" : entryId(q.author_id!, true) };
  if (!publishing) return { kind: "feed" };
  const editId = q.edit_id === undefined ? 0 : entryId(q.edit_id);
  const topicId = q.topic_id === undefined ? 0 : entryId(q.topic_id);
  // PHP gives an existing post priority over the incoming topic, retaining its own associations.
  return { kind: "publish", editId, topicId: editId ? 0 : topicId };
}
/** Shared by raw registered legacy pages and managed navigation; never forwards credentials. */
export function resolveCommunityLegacyPageEntry(path: string, input: Readonly<Record<string, unknown>>): string | null {
  const author = path === "/pages/discover/discoverUser/index", people = path === "/pages/discover/discoverFollow/index";
  if (!author && !people && path !== "/pages/discover/discoverCreate/index") return null;
  try {
    const q = entryQuery(input);
    if (people) {
      const tab = parseCommunityPeopleTab(q);
      return tab === null ? "" : `/pages/discover/people?tab=${tab}`;
    }
    const id = q.id === undefined ? undefined : entryId(q.id, author);
    const topic = q.topic_id === undefined ? undefined : entryId(q.topic_id);
    if (author) return `/pages/discover/workspace?author_id=${id ?? "self"}`;
    return `/pages/discover/workspace?publish=1${id ? `&edit_id=${id}` : topic ? `&topic_id=${topic}` : ""}`;
  } catch { return ""; }
}
/** Keep author identities distinct from post identities in legacy links. */
export function resolveCommunityPageRoute(path: string, query: string): string | null {
  if (!["/pages/discover/discoverDetails/index", "/pages/discover/discoverUser/index",
    "/pages/discover/discoverFollow/index", "/pages/discover/discoverCreate/index"].includes(path)) return null;
  try {
    const input = communityQuery(query);
    if (path === '/pages/discover/discoverDetails/index') {
      const post = communityInbound(path, input); return post ? communitySharePath(post.id, post.contentType, post.spid) : '';
    }
    return resolveCommunityLegacyPageEntry(path, input);
  } catch { return ""; }
}
