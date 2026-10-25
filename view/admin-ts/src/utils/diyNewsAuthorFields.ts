/** Read-only news-field projection and explicit edits; document/media ownership stays in the parent. */
export type NewsAuthorRecord = Record<string, unknown>;
export type NewsAuthorPath = Array<string | number>;
export interface NewsAuthorPatch { path: NewsAuthorPath; value: unknown }
export const NEWS_AUTHOR_MAX_ROWS = 10;
export const NEWS_AUTHOR_LIMITS = { title: 4, moreText: 4, moreLink: 100, rowTitle: 20, rowLink: 200 } as const;

export function newsAuthorRecord(value: unknown): NewsAuthorRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as NewsAuthorRecord : null;
}
export function newsAuthorRead(root: unknown, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>((value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key)
    ? (value as Record<string | number, unknown>)[key] : undefined, root);
}
/** Same Number-style binary projection as the installed client, without changing the stored value. */
export function newsAuthorOrdinal(value: unknown, fallback: 0 | 1 = 0): 0 | 1 {
  let number: number;
  try { number = Number(value); } catch { return fallback; }
  return number === 0 || number === 1 ? number : fallback;
}
export function newsAuthorEnabled(value: unknown): boolean {
  return value === true || value === 1 || typeof value === 'string' && ['1', 'true'].includes(value.trim().toLowerCase());
}
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const pathEqual = (a: readonly (string | number)[], b: readonly (string | number)[]) => a.length === b.length && a.every((key, i) => key === b[i]);
function writableAncestors(root: unknown, path: NewsAuthorPath): boolean {
  let owner = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (owner === undefined) return true;
    if (owner === null || typeof owner !== 'object') return false;
    const child = (owner as Record<string | number, unknown>)[path[i]!];
    if (child === undefined) return true;
    if (child === null || typeof child !== 'object' || Array.isArray(child) !== (typeof path[i + 1] === 'number')) return false;
    owner = child;
  }
  return true;
}
export const newsAuthorRowTitlePath = (index: number): NewsAuthorPath => ['listConfig', 'list', index, 'chiild', 0, 'val'];
export const newsAuthorRowLinkPath = (index: number): NewsAuthorPath => ['listConfig', 'list', index, 'chiild', 1, 'val'];
export const NEWS_AUTHOR_IMAGE_PATH: readonly string[] = ['imgConfig', 'url'];
export const NEWS_AUTHOR_MORE_LINK_PATH: readonly string[] = ['linkConfig', 'value'];

export function projectNewsAuthorFields(block: NewsAuthorRecord) {
  const read = (path: NewsAuthorPath) => newsAuthorRead(block, path);
  const style = newsAuthorOrdinal(read(['styleConfig', 'tabVal']));
  // The full ordinary default is image0; the current client uses text1 for missing/invalid imports.
  const titleType = newsAuthorOrdinal(read(['titleConfig', 'tabVal']), 1);
  const roll = newsAuthorOrdinal(read(['rollConfig', 'tabVal']));
  const button = newsAuthorOrdinal(read(['buttonConfig', 'tabVal']));
  const tone = newsAuthorOrdinal(read(['toneConfig', 'tabVal']));
  const rawList = read(['listConfig', 'list']);
  const rows = (Array.isArray(rawList) ? rawList : []).map((raw, index) => ({
    index, record: !!newsAuthorRecord(raw), shown: newsAuthorEnabled(newsAuthorRecord(raw)?.show),
    title: text(newsAuthorRead(raw, ['chiild', 0, 'val'])),
    link: text(newsAuthorRead(raw, ['chiild', 1, 'val'])),
    titleEditable: !!newsAuthorRecord(raw) && writableAncestors(raw, ['chiild', 0, 'val']),
    linkEditable: !!newsAuthorRecord(raw) && writableAncestors(raw, ['chiild', 1, 'val']),
  }));
  const listEditable = (block.listConfig === undefined || !!newsAuthorRecord(block.listConfig))
    && (rawList === undefined || Array.isArray(rawList));
  const validBlock = block.name === 'news';
  return {
    validBlock, style, titleType, roll, button, tone,
    titleText: text(read(['titleTxtConfig', 'value'])), imageReference: text(read(['imgConfig', 'url'])),
    moreText: text(read(['textConfig', 'value'])), moreLink: text(read(['linkConfig', 'value'])),
    rows, listEditable, canAdd: validBlock && listEditable && rows.length < NEWS_AUTHOR_MAX_ROWS,
    imageEditable: writableAncestors(block, ['imgConfig', 'url']),
    showRoll: style === 0, showMoreLink: style === 1 && button === 0,
    showMoreText: style === 1 && button === 0, showTone: style === 0 && titleType === 1,
    showTitleBackground: style === 0 && titleType === 1 && tone === 1,
    showTitleColor: titleType === 1 && (style === 1 || tone === 1), showButtonColor: button === 0,
  };
}
export type NewsAuthorFields = ReturnType<typeof projectNewsAuthorFields>;

function requireNews(block: NewsAuthorRecord) {
  if (block.name !== 'news') throw Error('未选择新闻公告组件');
}
/** A leaf intent only; imported metadata, inactive branches and original numeric spellings are untouched. */
export function newsAuthorPatch(block: NewsAuthorRecord, path: NewsAuthorPath, value: unknown): NewsAuthorPatch | null {
  requireNews(block);
  if (!Array.isArray(path) || path.some(key => typeof key === 'string' && ['__proto__', 'prototype', 'constructor'].includes(key))) throw Error('新闻字段路径无效');
  const fields = projectNewsAuthorFields(block), old = newsAuthorRead(block, path);
  const enumKey = path.length === 2 && path[1] === 'tabVal' ? path[0] : null;
  if (['styleConfig', 'titleConfig', 'rollConfig', 'buttonConfig', 'toneConfig'].includes(String(enumKey))) {
    if (enumKey === 'rollConfig' && !fields.showRoll || enumKey === 'toneConfig' && !fields.showTone) return null;
    if (value !== 0 && value !== 1) throw Error('请选择有效的新闻选项');
    if (newsAuthorOrdinal(old, enumKey === 'titleConfig' ? 1 : 0) === value) return null;
  } else {
    const index = path[2];
    const row = typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 ? fields.rows[index] : undefined;
    let limit: number | null = null;
    if (pathEqual(path, ['titleTxtConfig', 'value'])) { if (fields.titleType !== 1) return null; limit = NEWS_AUTHOR_LIMITS.title; }
    else if (pathEqual(path, ['textConfig', 'value'])) { if (!fields.showMoreText) return null; limit = NEWS_AUTHOR_LIMITS.moreText; }
    else if (pathEqual(path, ['linkConfig', 'value'])) { if (!fields.showMoreLink) return null; limit = NEWS_AUTHOR_LIMITS.moreLink; }
    else if (row && pathEqual(path, newsAuthorRowTitlePath(row.index))) { if (!row.titleEditable) throw Error('该公告标题结构异常，请先在 JSON 中明确修复'); limit = NEWS_AUTHOR_LIMITS.rowTitle; }
    else if (row && pathEqual(path, newsAuthorRowLinkPath(row.index))) { if (!row.linkEditable) throw Error('该公告链接结构异常，请先在 JSON 中明确修复'); limit = NEWS_AUTHOR_LIMITS.rowLink; }
    else if (row && row.record && pathEqual(path, ['listConfig', 'list', row.index, 'show'])) {
      if (typeof value !== 'boolean') throw Error('公告显示状态无效');
      if (newsAuthorEnabled(old) === value) return null;
    } else throw Error('新闻字段路径无效');
    if (limit !== null) {
      if (value === old) return null;
      if (typeof value !== 'string' || [...value].length > limit) throw Error(`新编辑内容不能超过${limit}个字符`);
    }
  }
  if (!writableAncestors(block, path)) throw Error('已存字段结构异常，请先在 JSON 中明确修复');
  return { path: [...path], value };
}
export function newsAuthorCanPickLink(block: NewsAuthorRecord, path: NewsAuthorPath): boolean {
  if (block.name !== 'news' || !Array.isArray(path)) return false;
  const fields = projectNewsAuthorFields(block);
  if (pathEqual(path, NEWS_AUTHOR_MORE_LINK_PATH)) return fields.showMoreLink && writableAncestors(block, path);
  const index = path[2], row = typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 ? fields.rows[index] : undefined;
  return !!row?.linkEditable && pathEqual(path, newsAuthorRowLinkPath(row.index));
}
/** Clone JSON configuration through Vue proxies as well as plain records; never share row metadata. */
export function cloneNewsAuthorValue<T>(value: T, seen = new Map<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value) as T;
  const output: unknown[] | NewsAuthorRecord = Array.isArray(value) ? [] : {};
  seen.set(value, output);
  for (const key of Object.keys(value)) Object.defineProperty(output, key, {
    value: cloneNewsAuthorValue((value as Record<string, unknown>)[key], seen), enumerable: true, configurable: true, writable: true,
  });
  return output as T;
}
/** PHP clones the last row; its optional empty flag clears only the first two values. */
export function newNewsAuthorRow(source?: unknown): NewsAuthorRecord {
  const record = newsAuthorRecord(source), children = record?.chiild;
  if (record && Array.isArray(children) && newsAuthorRecord(children[0]) && newsAuthorRecord(children[1])) {
    const next = cloneNewsAuthorValue(record), values = next.chiild as NewsAuthorRecord[];
    if (values[0]!.empty) { values[0]!.val = ''; values[1]!.val = ''; }
    return next;
  }
  // Empty-table recovery has the complete original row metadata, without cross-page localStorage.
  return { chiild: [{ title: '标题', val: '', max: 20, pla: '输入标题' }, { title: '链接', val: '', max: 200, pla: '输入连接' }], show: true };
}
export function newsAuthorRowsPatch(block: NewsAuthorRecord, action: 'add' | 'remove' | 'move', index = -1, direction: -1 | 1 = 1): NewsAuthorPatch {
  requireNews(block);
  const fields = projectNewsAuthorFields(block);
  if (!fields.listEditable) throw Error('公告列表结构异常，请先在 JSON 中明确修复');
  const raw = newsAuthorRead(block, ['listConfig', 'list']), rows = cloneNewsAuthorValue(Array.isArray(raw) ? raw : []);
  if (action === 'add') {
    if (rows.length >= NEWS_AUTHOR_MAX_ROWS) throw Error('新添加公告最多10条，已导入内容会完整保留');
    rows.push(newNewsAuthorRow(rows.at(-1)));
  } else {
    if (!Number.isSafeInteger(index) || index < 0 || index >= rows.length) throw Error('公告索引无效');
    if (action === 'remove') rows.splice(index, 1);
    else if (action === 'move') {
      if (direction !== -1 && direction !== 1 || index + direction < 0 || index + direction >= rows.length) throw Error('公告已位于列表边界');
      [rows[index], rows[index + direction]] = [rows[index + direction], rows[index]];
    } else throw Error('公告操作无效');
  }
  return { path: ['listConfig', 'list'], value: rows };
}
