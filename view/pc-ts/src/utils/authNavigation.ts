/** Same-origin return paths only. Preserve SKU/cart/activity queries and anchors without accepting login loops. */
export function safeLoginRedirect(value: unknown, origin: string): string {
  if (typeof value !== "string") return "/";
  const candidate = value.trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(candidate)) return "/";
  try {
    const resolved = new URL(candidate, origin);
    const path = decodeURIComponent(resolved.pathname).replace(/\/+$/, "").toLowerCase();
    if (resolved.origin !== origin || path === "/login" || path.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(path)) return "/";
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch { return "/"; }
}

export function requiresPcAuth(path: string): boolean {
  const normalized = path.toLowerCase();
  return ["/cart", "/checkout", "/order", "/user", "/refund", "/express"]
    .some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

export function expiredLoginDestination(location: { origin: string; pathname: string; search: string; hash: string }): string | null {
  if (location.pathname.replace(/\/+$/, "").toLowerCase() === "/login") return null;
  const path = safeLoginRedirect(`${location.pathname}${location.search}${location.hash}`, location.origin);
  return `/login?redirect=${encodeURIComponent(path)}`;
}
