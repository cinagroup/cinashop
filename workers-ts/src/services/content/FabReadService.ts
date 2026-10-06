import { getTableColumns, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemDise } from '@/models/schema';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { parseLevelActivationJson } from '@/services/admin/AdminLevelActivationInput';
import { FAB_MAX_HISTORY_BUTTONS, FAB_MAX_VALUE_BYTES, FAB_TEMPLATE_NAME, fabDefaults, fabHash, fabImage, fabLink, fabObject,
  validateFabValues, type FabValues } from '@/services/admin/AdminFabSettingsInput';

const columns = { ...getTableColumns(systemDise), xmin: sql<string>`xmin::text` };
export type FabRow = typeof systemDise.$inferSelect & { xmin: string };
export interface FabViewValues {
  is_show: 0 | 1 | null; index: 1 | 2 | 3 | 4 | null; shifting: number | null;
  main_ago_image: string | null; main_after_image: string | null;
  button: Array<{ source_id: string | null; img: string | null; url: string | null }>;
}
export interface FabSnapshot {
  present: boolean; row: { id: number; status: number; is_show: number; is_del: number } | null;
  revision: string; values: FabViewValues | null; raw_values: Record<string, unknown> | null;
  editable: boolean; issues: string[];
  image_previews: { main_ago_image: string; main_after_image: string; button: string[] };
}
export async function fabDeadlines(tx: DbClient) {
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
}
/** JSON has already passed the duplicate/depth validator. Check opaque numeric
 * literals by decimal coefficient/exponent, without expanding huge exponents.
 * Formatting changes such as 1e3 -> 1000 are harmless; rounded decimals and
 * nonzero underflow are not. Known invalid fields remain explicitly repairable. */
export function fabOpaqueNumbersExact(text: string): boolean {
  type Role = 'root' | 'buttons' | 'button' | 'known' | 'opaque';
  let offset = 0, exact = true;
  const known = new Set(Object.keys(fabDefaults()));
  const whitespace = () => { while (/\s/u.test(text[offset] ?? '') && offset < text.length) offset++; };
  const string = () => {
    const start = offset++;
    while (offset < text.length) { const next = text[offset++]; if (next === '\\') offset++; else if (next === '"') break; }
    return JSON.parse(text.slice(start, offset)) as string;
  };
  const decimal = (token: string): string | null => {
    if (token.length > 512) return null;
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
    if (!match || (match[4]?.length ?? 0) > 64) return null;
    let coefficient = `${match[2]}${match[3] ?? ''}`.replace(/^0+/, '');
    if (!coefficient) return '0';
    const trimmed = coefficient.replace(/0+$/, ''), zeros = coefficient.length - trimmed.length;
    coefficient = trimmed;
    const exponent = BigInt(match[4] ?? '0') - BigInt((match[3] ?? '').length) + BigInt(zeros);
    return `${match[1]}${coefficient}e${exponent}`;
  };
  const visit = (role: Role) => {
    whitespace();
    if (text[offset] === '{') {
      offset++; whitespace();
      while (text[offset] !== '}') {
        whitespace(); const key = string(); whitespace(); offset++;
        const child: Role = role === 'root' ? known.has(key) ? key === 'button' ? 'buttons' : 'known' : 'opaque'
          : role === 'button' ? key === 'img' || key === 'url' ? 'known' : 'opaque' : role;
        visit(child); whitespace(); if (text[offset] !== ',') break; offset++;
      }
      offset++;
    } else if (text[offset] === '[') {
      offset++; whitespace();
      while (text[offset] !== ']') { visit(role === 'buttons' ? 'button' : role); whitespace(); if (text[offset] !== ',') break; offset++; }
      offset++;
    } else if (text[offset] === '"') string();
    else {
      const start = offset; while (offset < text.length && !/[\s,}\]]/u.test(text[offset])) offset++;
      const token = text.slice(start, offset);
      if (role === 'opaque' && token !== 'true' && token !== 'false' && token !== 'null') {
        const number = Number(token), serialized = Number.isFinite(number) ? JSON.stringify(number) : '';
        const original = decimal(token), current = decimal(serialized);
        if (original === null || current === null || original !== current) exact = false;
      }
    }
  };
  visit('root'); return exact;
}
export function decodeFabObject(value: string | null): Record<string, unknown> | null {
  try {
    if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > FAB_MAX_VALUE_BYTES) return null;
    const source = fabObject(parseLevelActivationJson(value));
    if (!fabOpaqueNumbersExact(value)) return null;
    // We preserve parsed extension semantics, not raw JSON bytes. Reject
    // opaque numbers that JS would silently round before merging a known key.
    const known = new Set(Object.keys(fabDefaults())), queue: unknown[] = [];
    for (const [key, item] of Object.entries(source)) if (!known.has(key)) queue.push(item);
    if (Array.isArray(source.button)) for (const item of source.button) {
      if (item && typeof item === 'object' && !Array.isArray(item)) for (const [key, extra] of Object.entries(item)) if (key !== 'img' && key !== 'url') queue.push(extra);
    }
    let visited = 0;
    while (queue.length) {
      if (++visited > 100_000) return null;
      const item = queue.pop();
      if (typeof item === 'number' && (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))) return null;
      if (item && typeof item === 'object') queue.push(...Object.values(item));
    }
    return source;
  } catch { return null; }
}
export async function fabCatalog(tx: DbClient) {
  // No status/is_del filter: the old identity is the template, not a visible
  // row id. Include mistyped identities in diagnostics instead of reseeding.
  const rows = await tx.select(columns).from(systemDise).where(sql`lower(btrim(${systemDise.templateName}))=${FAB_TEMPLATE_NAME}`).orderBy(systemDise.id).limit(3);
  const revision = await fabHash({ template_name: FAB_TEMPLATE_NAME, type: 3, rows });
  return { rows, revision };
}
function image(value: unknown): string | null {
  if (value === '') return '';
  try { return fabImage(value); } catch { return null; }
}
function original(source: Record<string, unknown>, key: string, fallback: unknown) { return Object.hasOwn(source, key) ? source[key] : fallback; }
export async function fabProject(tx: DbClient, catalog: Awaited<ReturnType<typeof fabCatalog>>) {
  const { rows, revision } = catalog, issues: string[] = [], sourceIds = new Map<string, unknown>();
  const snapshot: FabSnapshot = { present: rows.length > 0, row: null, revision, values: null, raw_values: null,
    editable: false, issues, image_previews: { main_ago_image: '', main_after_image: '', button: [] } };
  if (rows.length > 1) { issues.push('悬浮按钮模板重复，无法确定配置；请由维护人员核对'); return { snapshot, source: null, sourceIds }; }
  if (!rows.length) {
    snapshot.values = fabDefaults(); snapshot.image_previews.button = snapshot.values.button.map(()=>'');
    snapshot.editable = true; return { snapshot, source: null, sourceIds };
  }
  const row = rows[0]; snapshot.row = { id: row.id, status: row.status, is_show: row.isShow, is_del: row.isDel };
  if (row.templateName !== FAB_TEMPLATE_NAME || row.type !== 3 || row.isDel !== 0) { issues.push('悬浮按钮模板身份、名称归一化或删除标记异常，不能自动覆盖'); return { snapshot, source: null, sourceIds }; }
  const source = decodeFabObject(row.value);
  if (!source) { issues.push('历史配置不是可合并的有界JSON对象，或扩展属性含不安全数值，不能自动覆盖'); return { snapshot, source: null, sourceIds }; }
  const defaults = fabDefaults(), raw = Object.fromEntries(Object.keys(defaults).map(key => [key, original(source, key,
    key === 'button' ? defaults.button.map(({img,url}) => ({img,url})) : defaults[key as keyof FabValues])]));
  snapshot.raw_values = raw;
  const flag = raw.is_show === 0 || raw.is_show === 1 ? raw.is_show : null;
  const index = typeof raw.index === 'number' && Number.isInteger(raw.index) && raw.index >= 1 && raw.index <= 4 ? raw.index as FabValues['index'] : null;
  const shifting = typeof raw.shifting === 'number' && Number.isInteger(raw.shifting) && raw.shifting >= 0 && raw.shifting <= 100 ? raw.shifting : null;
  let buttons: FabViewValues['button'] = [];
  if (!Array.isArray(raw.button) || raw.button.length > FAB_MAX_HISTORY_BUTTONS) issues.push('历史子按钮列表无效或超过100项，请明确修复');
  else buttons = await Promise.all(raw.button.map(async (item, button_index) => {
    const source_id = await fabHash({ revision, button_index }); sourceIds.set(source_id, item);
    let row: Record<string, unknown> = {}; try { row = fabObject(item); } catch { issues.push(`子按钮${button_index + 1}结构无效，请修复或删除`); }
    const img = image(row.img); let url: string | null = null;
    try { url = row.url === '' ? '' : fabLink(row.url).value; } catch { issues.push(`子按钮${button_index + 1}链接无效或尚无可执行落点`); }
    return { source_id, img, url };
  }));
  const values: FabViewValues = { is_show: flag, index, shifting, main_ago_image: image(raw.main_ago_image), main_after_image: image(raw.main_after_image), button: buttons };
  snapshot.values = values; snapshot.editable = true;
  if (flag === null || index === null || shifting === null || values.main_ago_image === null || values.main_after_image === null) issues.push('部分历史字段无效；原值已保留，请修复');
  try { validateFabValues(values as FabValues); } catch (error) { issues.push(error instanceof Error ? error.message : '历史配置无效，请修复'); }
  const references = [values.main_ago_image ?? '', values.main_after_image ?? '', ...buttons.map(row => row.img ?? '')];
  const valid = await publicProductPictures(tx, references.map(image => ({ image, type: 0, relationId: 0 })));
  snapshot.image_previews = { main_ago_image: valid[0], main_after_image: valid[1], button: valid.slice(2) };
  if (references.some((reference, index) => reference !== '' && valid[index] === '')) issues.push('图片素材不可用或不属于平台，请修复');
  return { snapshot, source, sourceIds };
}
export async function renderFabSnapshot(env: Pick<Env, 'APP_KEY'>, snapshot: FabSnapshot): Promise<FabSnapshot> {
  const images = snapshot.image_previews;
  const signed = await renderProductPictures(env.APP_KEY, [images.main_ago_image, images.main_after_image, ...images.button]);
  return { ...snapshot, image_previews: { main_ago_image: signed[0], main_after_image: signed[1], button: signed.slice(2) } };
}
export class FabReadService {
  constructor(private readonly container: Container, private readonly env: Pick<Env, 'APP_KEY'>) {}
  async read() {
    const snapshot = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await fabDeadlines(tx);
      return (await fabProject(tx, await fabCatalog(tx))).snapshot;
    });
    // The public DTO is deliberately only the old six keys. No raw/opaque
    // extensions, table identity or Admin source ids become public content.
    const hidden = { is_show: 0 as const, index: 1, shifting: 1, main_ago_image: '', main_after_image: '', button: [] as Array<{ img: string; url: string }> };
    if (!snapshot.present || !snapshot.editable || !snapshot.values) return hidden;
    const value = snapshot.values;
    if (value.is_show === null || value.index === null || value.shifting === null || value.button.length > 5 || (value.index >= 3 && value.button.length < 3)) return hidden;
    const media = (await renderFabSnapshot(this.env, snapshot)).image_previews;
    if ((value.index !== 4 && !media.main_ago_image) || (value.index === 3 && !media.main_after_image)) return hidden;
    return { is_show: value.is_show!, index: value.index!, shifting: value.shifting!, main_ago_image: value.index === 4 ? '' : media.main_ago_image,
      main_after_image: value.index === 3 ? media.main_after_image : '',
      button: value.button.map((row, index) => ({ img: media.button[index], url: media.button[index] ? row.url ?? '' : '' })) };
  }
}
