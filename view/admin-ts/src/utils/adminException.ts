export type AdminExceptionKind = '403' | '404' | '500' | 'other';
export const ADMIN_EXCEPTION_COPY = Object.freeze({
  '403': Object.freeze({ code: '403', title: '无权访问', description: '抱歉，你无权访问该页面' }),
  '404': Object.freeze({ code: '404', title: '页面不存在', description: '抱歉，你访问的页面不存在' }),
  '500': Object.freeze({ code: '500', title: '服务器错误', description: '抱歉，服务器出错了' }),
  other: Object.freeze({ code: '403', title: '浏览器兼容提示', description: '请使用 chrome / Microsoft Edge 等非IE浏览器打开' }),
});

interface HomeRoute {
  path: string; name?: unknown; redirect?: unknown; meta: Record<string, unknown>;
  aliasOf?: HomeRoute;
}

/** Menu order remains authoritative; only registered, fixed internal pages qualify. */
export function adminExceptionHome(token: string | null, session: unknown, routes: readonly HomeRoute[]): string {
  if (!token) return '/login';
  const fallback = '/dashboard';
  const fixedPath = (value: unknown): value is string => typeof value === 'string' && value.length <= 256 && /^\/[A-Za-z0-9_/-]*$/u.test(value) && !value.includes('//');
  const data = (value: unknown, key: string): unknown => {
    if (!value || typeof value !== 'object') return undefined;
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field && 'value' in field ? field.value : undefined;
  };
  try {
    const allowed = new Map<string, string>();
    for (const row of routes) {
      const target = row.aliasOf ?? row;
      if (!row.name || row.redirect || target.redirect || row.meta.exceptionPage === true || target.meta.exceptionPage === true || !fixedPath(row.path) || !fixedPath(target.path) || target.path === '/login') continue;
      allowed.set(row.path, target.path);
    }
    const menus = data(session, 'menus');
    if (!Array.isArray(menus)) return fallback;
    const pending = menus.slice().reverse().map(node => ({ node, emit: false })), seen = new WeakSet<object>();
    let remaining = 4096;
    while (pending.length && remaining-- > 0) {
      const item = pending.pop()!;
      if (!item.node || typeof item.node !== 'object') continue;
      if (!item.emit) {
        if (seen.has(item.node)) continue; seen.add(item.node);
        pending.push({ node: item.node, emit: true });
        const children = data(item.node, 'children');
        if (Array.isArray(children)) for (let i = Math.min(children.length, 2048) - 1; i >= 0; i--) pending.push({ node: children[i], emit: false });
      } else {
        const path = data(item.node, 'path');
        if (fixedPath(path) && allowed.has(path)) return allowed.get(path)!;
      }
    }
  } catch { /* Malformed local menu data cannot turn the return action into an external redirect. */ }
  return fallback;
}
