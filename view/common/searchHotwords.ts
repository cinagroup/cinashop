/** Public business hotwords. These URLs carry no attachment publication rights. */
export interface SearchHotword {
  id: number;
  name: string;
  color: string;
  bg_color: string;
  border_color: string;
  icon: string;
}

const controls = /[\u0000-\u001f\u007f]/u;
function color(value: unknown): string {
  if (typeof value !== 'string') throw Error('热词颜色响应无效');
  if (value === '' || value === 'transparent' || /^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/iu.test(value)) return value;
  const m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/iu.exec(value);
  if (!m || m.slice(1, 4).some(v => Number(v) > 255)) throw Error('热词颜色响应无效');
  return value;
}

/** Lexical checks work on native platforms without the browser URL global.
 * Unsafe display sources hide the icon; they never remove or rewrite the word. */
export function searchHotwordIcon(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return '';
  if (!value) return '';
  if (/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]+$/u.test(value)) {
    let path = value.split(/[?#]/u)[0];
    for (let i = 0; i < 4; i++) {
      if (!/^\/(?!\/)/u.test(path) || /[\\\u0000-\u0020\u007f]/u.test(path) || path.split('/').some(v => v === '.' || v === '..')) return '';
      if (!/%[a-f\d]{2}/iu.test(path)) return value;
      try { path = decodeURIComponent(path); } catch { return ''; }
    }
    return '';
  }
  // The producer canonicalizes HTTPS authority to ASCII and excludes userinfo.
  return /^https:\/\/(?:[a-z\d](?:[a-z\d.-]*[a-z\d])?|\[[a-f\d:]+\])(?::\d{1,5})?(?:[/?#][\x21-\x7e]*)?$/iu.test(value) ? value : '';
}

export function parseSearchHotwords(value: unknown): SearchHotword[] {
  if (!Array.isArray(value) || value.length > 20) throw Error('热词列表响应无效');
  const ids = new Set<number>();
  return Array.from(value, row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('热词条目响应无效');
    const r = row as Record<string, unknown>;
    if (!Number.isSafeInteger(r.id) || Number(r.id) < 1 || Number(r.id) > 2147483647 || ids.has(Number(r.id))) throw Error('热词标识响应无效');
    ids.add(Number(r.id));
    if (typeof r.name !== 'string' || !r.name.trim() || Array.from(r.name).length > 128 || controls.test(r.name) || (r.keyword !== undefined && r.keyword !== r.name)) throw Error('热词名称响应无效');
    if (typeof r.icon !== 'string') throw Error('热词图标响应无效');
    return { id: Number(r.id), name: r.name, color: color(r.color), bg_color: color(r.bg_color), border_color: color(r.border_color), icon: searchHotwordIcon(r.icon) };
  });
}

/** Match the existing Worker keyword bound (UTF-16 length), without truncation. */
export function searchQuery(value: unknown): string {
  if (typeof value !== 'string') throw Error('搜索关键词无效');
  const word = value.trim();
  if (!word) throw Error('请输入搜索关键词');
  if (controls.test(word)) throw Error('搜索关键词包含无效字符');
  if (word.length > 255) throw Error('搜索关键词不能超过255个字符');
  return word;
}

export function parseSearchHistory(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string') throw Error('本机搜索历史格式无效，请清空后重试');
  const rows: unknown = JSON.parse(value);
  if (!Array.isArray(rows) || rows.length > 10) throw Error('本机搜索历史格式无效，请清空后重试');
  return Array.from(rows, v => {
    const word = searchQuery(v);
    if (word !== v) throw Error('本机搜索历史格式无效，请清空后重试');
    return word;
  });
}
