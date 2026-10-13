/** The legacy statistics setting is a script, so it must be loaded as a script. */
export interface StatisticsScriptElement {
  src: string;
  async: boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(name: 'error', listener: () => void, options: { once: boolean }): void;
  remove(): void;
}
interface StatisticsDocument {
  querySelectorAll(selector: string): ArrayLike<StatisticsScriptElement>;
  createElement(name: 'script'): StatisticsScriptElement;
  head: { appendChild(script: StatisticsScriptElement): unknown } | null;
  documentElement: { appendChild(script: StatisticsScriptElement): unknown };
}
export function statisticsScriptUrl(apiBase = ''): string {
  const base = apiBase.trim().replace(/\/+$/, '');
  if (/[\u0000-\u0020\u007f\\?#]/u.test(base) || base.startsWith('//')) {
    throw new Error('统计脚本接口地址无效');
  }
  let origin = '', path = base;
  if (/^https?:\/\//i.test(base)) {
    const parts = /^(https?:\/\/[^/]+)(\/.*)?$/i.exec(base);
    if (!parts || parts[1].includes('@')) throw new Error('统计脚本接口地址无效');
    origin = parts[1]; path = parts[2] ?? '';
  } else if (base && !base.startsWith('/')) {
    throw new Error('统计脚本接口地址无效');
  }
  const suffix = /\/(?:adminapi|supplierapi|api(?:\/(?:admin|supplier))?)$/;
  path = path.replace(suffix, '');
  if (path.split('/').some(part => part === '.' || part === '..') || /%/u.test(path)) {
    throw new Error('统计脚本接口地址无效');
  }
  return `${origin}${path}/api/get_script`;
}

export function loadStatisticsScript(apiBase = '', surface?: StatisticsDocument): StatisticsScriptElement | undefined {
  const doc = surface ?? (globalThis as unknown as { document?: StatisticsDocument }).document;
  if (!doc) return undefined;
  const src = statisticsScriptUrl(apiBase);
  for (const script of Array.from(doc.querySelectorAll('script[data-cinashop-statistics]'))) {
    if (script.getAttribute('src') === src) return script;
  }
  const script = doc.createElement('script');
  script.src = src;
  script.async = true;
  script.setAttribute('data-cinashop-statistics', '');
  // A failed fetch permits a later launch to retry; a loaded script stays idempotent.
  script.addEventListener('error', () => script.remove(), { once: true });
  (doc.head ?? doc.documentElement).appendChild(script);
  return script;
}
