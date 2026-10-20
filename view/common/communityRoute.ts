/** Keep author identities distinct from post identities in legacy links. */
export function resolveCommunityPageRoute(path: string, query: string): string | null {
  const author = path === "/pages/discover/discoverUser/index";
  if (!author && path !== "/pages/discover/discoverCreate/index") return null;
  if (query.length > 2048) return "";
  const values = new Map<string, string>();
  try {
    for (const part of query ? query.split("&") : []) {
      const offset = part.indexOf("="), key = decodeURIComponent(offset < 0 ? part : part.slice(0, offset));
      if (values.has(key)) return "";
      values.set(key, decodeURIComponent(offset < 0 ? "" : part.slice(offset + 1)));
    }
  } catch { return ""; }
  const id = values.get("id"), topic = values.get("topic_id");
  const valid = (value: string, zero = false) => (zero ? /^(0|[1-9]\d{0,9})$/ : /^[1-9]\d{0,9}$/).test(value)
    && Number(value) <= 2147483647;
  if (id !== undefined && !valid(id, author) || topic !== undefined && !valid(topic)) return "";
  if (author) return `/pages/discover/workspace?author_id=${id ?? "self"}`;
  return `/pages/discover/workspace?publish=1${id ? `&edit_id=${id}` : topic ? `&topic_id=${topic}` : ""}`;
}
