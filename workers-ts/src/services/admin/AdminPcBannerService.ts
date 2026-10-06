import { and, asc, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemAttachment, systemGroup, systemGroupData, systemLog } from '@/models/schema';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { adminAttachmentScope, parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { parseLevelActivationJson } from './AdminLevelActivationInput';
import { PC_BANNER_DEFAULT_FIELDS, PC_BANNER_DEFAULT_METADATA, PcBannerStaleVersion,
  parsePcBannerFields, parsePcBannerQuery, pcBannerCanonical, pcBannerHash, pcBannerId,
  pcBannerObject, pcBannerRequestId, pcBannerValuesForFields,
  type PcBannerField, type PcBannerOperation, type PcBannerQuery, type PcBannerReceipt, type PcBannerValues } from './AdminPcBannerInput';

const GROUP_NAME = 'pc_home_banner';
const JOURNAL_TYPE = 'pc_home_banner';
export const PC_BANNER_LOCK_NAMESPACE = 731_699;
const MAX_VERSION_ROWS = 100_000;
const groupColumns = { ...getTableColumns(systemGroup), version: sql<string>`xmin::text` };
const rowColumns = { ...getTableColumns(systemGroupData), version: sql<string>`xmin::text` };
type GroupRow = typeof systemGroup.$inferSelect & { version: string };
type DataRow = typeof systemGroupData.$inferSelect & { version: string };
type VersionRow = { id: number; version: string };
type Metadata = ReturnType<typeof parsePcBannerFields>;
export interface PcBannerGroupDto { id: number; name: string; info: string; fields: PcBannerField[]; issues: string[] }
export interface PcBannerRowDto {
  id: number; gid: number; values: Record<string, string | string[] | null>; sort: number; status: number;
  issues: string[]; revision: string; image_preview: string; image_previews: Record<string, string[]>; editable: boolean;
}
const receiptPath = (requestId: string) => `/setting/pc-banners/request/${requestId}`;
async function deadlines(tx: DbClient) {
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
}
function decodedValue(raw: string | null): Record<string, unknown> | null {
  try {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 1024 * 1024) return null;
    return pcBannerObject(parseLevelActivationJson(raw));
  } catch { return null; }
}
function unwrap(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'value')) return (value as Record<string, unknown>).value;
  return value;
}
function decode(row: DataRow, metadata: Metadata) {
  const source = decodedValue(row.value), values: PcBannerRowDto['values'] = {}, issues: string[] = [];
  if (!source) issues.push('历史配置值不是可合并JSON对象，不能编辑；可隐藏或删除后重新添加');
  if (!metadata.valid) issues.push(...metadata.issues);
  for (const field of metadata.fields) {
    let value = unwrap(source?.[field.key]);
    if ((field.type === 'upload' || field.key === 'image') && Array.isArray(value) && value.length) value = value[0];
    if (field.type === 'uploads' && typeof value === 'string' && value.length) value = [value];
    if ((field.type === 'radio' || field.type === 'select') && typeof value === 'number' && Number.isFinite(value)) value = String(value);
    if (field.type === 'checkbox' && Array.isArray(value)) value = value.map(item => typeof item === 'number' && Number.isFinite(item) ? String(item) : item);
    try {
      const candidate = { [field.key]: value } as PcBannerValues;
      pcBannerValuesForFields(candidate, [field]);
      values[field.key] = candidate[field.key];
    } catch {
      values[field.key] = null;
      issues.push(`字段${field.key}内容无效，请编辑修复`);
    }
  }
  if (row.sort < 0) issues.push('历史排序无效，请编辑修复');
  if (row.status !== 0 && row.status !== 1) issues.push('历史显示状态无效，请编辑修复');
  return { source, values, issues, editable: source !== null && metadata.valid };
}
function groupDto(group: GroupRow, metadata: Metadata): PcBannerGroupDto {
  return { id: group.id, name: group.name, info: group.info, fields: metadata.fields, issues: metadata.issues };
}
async function group(tx: DbClient) {
  const rows = await tx.select(groupColumns).from(systemGroup).where(eq(systemGroup.configName, GROUP_NAME)).limit(2);
  if (rows.length > 1) throw new ValidateException('PC轮播配置组重复，请先维护修复');
  return rows[0];
}
async function versions(tx: DbClient, current: GroupRow | undefined): Promise<VersionRow[]> {
  if (!current) return [];
  const rows = await tx.select({ id: systemGroupData.id, version: sql<string>`xmin::text` }).from(systemGroupData)
    .where(eq(systemGroupData.gid, current.id)).orderBy(asc(systemGroupData.id)).limit(MAX_VERSION_ROWS + 1);
  if (rows.length > MAX_VERSION_ROWS) throw new ValidateException('PC轮播历史版本列表超过安全读取容量100000，请维护清理');
  return rows;
}
function collectionRevision(current: GroupRow | undefined, rows: VersionRow[]) { return pcBannerHash({ group_name: GROUP_NAME, group: current ?? null, rows }); }
function rowRevision(current: GroupRow, row: DataRow) { return pcBannerHash({ group_name: GROUP_NAME, group: current, row }); }
function receiptFrom(action: string, requestId: string): PcBannerReceipt | null {
  const match = /^(create|update|status|delete);id=([1-9]\d{0,9});payload=([a-f0-9]{64})$/.exec(action);
  if (!match) return null;
  try { return { operation: match[1] as PcBannerOperation, id: pcBannerId(match[2]), request_id: requestId, payload_hash: match[3] }; } catch { return null; }
}
function savedValue(existing: Record<string, unknown> | null, fields: readonly PcBannerField[], values: PcBannerValues) {
  const source = { ...(existing ?? {}) };
  for (const field of fields) {
    const previous = source[field.key];
    source[field.key] = { ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}), type: field.type, value: values[field.key] };
  }
  const result = JSON.stringify(source);
  if (new TextEncoder().encode(result).byteLength > 1024 * 1024) throw new ValidateException('合并后的PC轮播数据超过安全容量，未保存');
  return result;
}
/** Lock actual platform metadata before availability validation. The current
 * product media policy also proves R2 object-name/MIME/canonical-reference scope.
 * There is no HTTP, object-storage read or signing while these locks are held. */
async function pictures(tx: DbClient, references: string[], lock = false): Promise<string[]> {
  const ids = [...new Set(references.map(parseCanonicalAttachmentId).filter((id): id is number => id !== null))];
  if (lock && ids.length) {
    const scope = adminAttachmentScope();
    await tx.select({ id: systemAttachment.attId }).from(systemAttachment)
      .where(and(inArray(systemAttachment.attId, ids), eq(systemAttachment.type, scope.type), eq(systemAttachment.relationId, scope.relationId),
        eq(systemAttachment.moduleType, scope.moduleType), eq(systemAttachment.fileType, 1))).for('share');
  }
  const result: string[] = [];
  for (let offset = 0; offset < references.length; offset += 1000) {
    result.push(...await publicProductPictures(tx, references.slice(offset, offset + 1000).map(image => ({ type: 0, relationId: 0, image }))));
  }
  return result;
}
function imageValues(values: PcBannerRowDto['values'], fields: readonly PcBannerField[]) {
  return fields.flatMap(field => field.type === 'upload' || field.key === 'image' ? typeof values[field.key] === 'string' ? [values[field.key] as string] : []
    : field.type === 'uploads' && Array.isArray(values[field.key]) ? values[field.key] as string[] : []);
}
async function project(tx: DbClient, current: GroupRow, row: DataRow, metadata: Metadata): Promise<PcBannerRowDto> {
  const decoded = decode(row, metadata), references = imageValues(decoded.values, metadata.fields), validated = await pictures(tx, references);
  const byReference = new Map(references.map((reference, index) => [reference, validated[index]]));
  const image_previews: Record<string, string[]> = {};
  for (const field of metadata.fields) {
    if (field.key !== 'image' && field.type !== 'upload' && field.type !== 'uploads') continue;
    const value = decoded.values[field.key], source = typeof value === 'string' ? [value] : value ?? [];
    image_previews[field.key] = source.map(reference => byReference.get(reference) ?? '');
    if (image_previews[field.key].some(reference => !reference)) decoded.issues.push(`字段${field.key}图片素材不可用或不属于平台，请编辑修复`);
  }
  return { id: row.id, gid: row.gid, values: decoded.values, sort: row.sort, status: row.status, issues: decoded.issues,
    revision: await rowRevision(current, row), image_preview: image_previews.image?.[0] ?? '', image_previews, editable: decoded.editable };
}
export class AdminPcBannerService {
  constructor(private readonly container: Container, private readonly env: Pick<Env, 'APP_KEY'>) {}
  private async render(rows: PcBannerRowDto[]) {
    const references = rows.flatMap(row => Object.values(row.image_previews).flat());
    const signed = await renderProductPictures(this.env.APP_KEY, references); let offset = 0;
    return rows.map(row => {
      const image_previews = Object.fromEntries(Object.entries(row.image_previews).map(([key, images]) => [key, images.map(() => signed[offset++])]));
      return { ...row, image_previews, image_preview: image_previews.image?.[0] ?? '' };
    });
  }
  async list(query: PcBannerQuery = parsePcBannerQuery(new URLSearchParams())) {
    const result = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await deadlines(tx);
      const current = await group(tx), allVersions = await versions(tx, current);
      if (!current) return { group_present: false, group: null, default_fields: PC_BANNER_DEFAULT_FIELDS,
        list: [] as PcBannerRowDto[], count: 0, page: query.page, limit: query.limit, revision: await collectionRevision(undefined, []) };
      const metadata = parsePcBannerFields(current.fields), condition = and(eq(systemGroupData.gid, current.id),
        query.status === undefined ? undefined : eq(systemGroupData.status, query.status));
      const [count] = await tx.select({ value: sql<number>`count(*)::integer` }).from(systemGroupData).where(condition);
      const rows = await tx.select(rowColumns).from(systemGroupData).where(condition)
        .orderBy(desc(systemGroupData.sort), desc(systemGroupData.id)).offset(query.offset).limit(query.limit);
      return { group_present: true, group: groupDto(current, metadata), default_fields: PC_BANNER_DEFAULT_FIELDS,
        list: await Promise.all(rows.map(row => project(tx, current, row, metadata))), count: Number(count.value),
        page: query.page, limit: query.limit, revision: await collectionRevision(current, allVersions) };
    });
    return { ...result, list: await this.render(result.list) };
  }
  async detail(value: unknown) {
    const id = pcBannerId(value);
    const result = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await deadlines(tx);
      const current = await group(tx);
      if (!current) throw new NotFoundException('PC轮播条目不存在');
      const [row] = await tx.select(rowColumns).from(systemGroupData).where(and(eq(systemGroupData.id, id), eq(systemGroupData.gid, current.id)));
      if (!row) throw new NotFoundException('PC轮播条目不存在');
      const metadata = parsePcBannerFields(current.fields);
      return { info: await project(tx, current, row, metadata), group: groupDto(current, metadata) };
    });
    return { ...result, info: (await this.render([result.info]))[0] };
  }
  async receipt(value: unknown, actor: { id: number }): Promise<PcBannerReceipt> {
    const requestId = pcBannerRequestId(value), actorId = pcBannerId(actor?.id);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`); await deadlines(tx);
      const rows = await tx.select({ action: systemLog.action }).from(systemLog)
        .where(and(eq(systemLog.type, JOURNAL_TYPE), eq(systemLog.path, receiptPath(requestId)), eq(systemLog.adminId, actorId))).limit(2);
      if (!rows.length) throw new NotFoundException('PC轮播操作回执不存在');
      const result = rows.length === 1 ? receiptFrom(rows[0].action, requestId) : null;
      if (!result) throw new ValidateException('PC轮播回执异常，无法确认结果');
      return result;
    });
  }
  async mutate(operation: PcBannerOperation, idValue: unknown, raw: unknown, actor: { id: number }): Promise<PcBannerReceipt> {
    const actorId = pcBannerId(actor?.id), { request_id, canonical } = pcBannerCanonical(operation, idValue, raw);
    const payload_hash = await pcBannerHash(canonical);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`); await deadlines(tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PC_BANNER_LOCK_NAMESPACE},1)`);
      const journals = await tx.select({ action: systemLog.action, actor: systemLog.adminId }).from(systemLog)
        .where(and(eq(systemLog.type, JOURNAL_TYPE), eq(systemLog.path, receiptPath(request_id)))).limit(2);
      if (journals.length) {
        const previous = journals.length === 1 ? receiptFrom(journals[0].action, request_id) : null;
        if (!previous || journals[0].actor !== actorId || previous.operation !== operation || previous.payload_hash !== payload_hash
          || (canonical.id !== 0 && previous.id !== canonical.id)) throw new ValidateException('请求标识已用于其他PC轮播操作');
        return previous;
      }
      const locked = await tx.select(groupColumns).from(systemGroup).where(eq(systemGroup.configName, GROUP_NAME)).limit(2).for('share');
      if (locked.length > 1) throw new ValidateException('PC轮播配置组重复，请维护修复');
      await tx.execute(sql`LOCK TABLE ${systemGroupData} IN SHARE ROW EXCLUSIVE MODE`);
      let current = await group(tx);
      if ((locked[0]?.id ?? null) !== (current?.id ?? null)) throw new PcBannerStaleVersion(operation, request_id, payload_hash);
      const allVersions = operation === 'create' ? await versions(tx, current) : [];
      const [row] = current && canonical.id ? await tx.select(rowColumns).from(systemGroupData)
        .where(and(eq(systemGroupData.id, canonical.id), eq(systemGroupData.gid, current.id))) : [];
      const expected = operation === 'create' ? await collectionRevision(current, allVersions) : current && row ? await rowRevision(current, row) : null;
      if (expected === null) throw new NotFoundException('PC轮播条目不存在');
      // This narrow definite rejection is emitted before any business DML.
      // The controller only receives it after withTx has awaited rollback.
      if (canonical.revision !== expected) throw new PcBannerStaleVersion(operation, request_id, payload_hash);
      const metadata = current ? parsePcBannerFields(current.fields) : { fields: PC_BANNER_DEFAULT_FIELDS, issues: [], valid: true };
      if (!metadata.valid) throw new ValidateException('PC轮播元数据无效，禁止写入，请维护修复');
      let merged: string | undefined;
      if (canonical.operation === 'create' || canonical.operation === 'update') {
        const prior = row ? decodedValue(row.value) : null;
        if (row && prior === null) throw new ValidateException('历史PC轮播值无法安全合并，请隐藏或删除后重新添加');
        pcBannerValuesForFields(canonical.values, metadata.fields);
        const images = imageValues(canonical.values, metadata.fields), valid = await pictures(tx, images, true);
        if (valid.some((value, index) => value !== images[index])) throw new ValidateException('图片素材不可用或不属于平台');
        merged = savedValue(prior, metadata.fields, canonical.values);
      } else if (canonical.operation === 'status' && canonical.status === 1) {
        const previous = decode(row!, metadata);
        if (previous.issues.length) throw new ValidateException('PC轮播内容无效，请先编辑修复再显示');
        const images = imageValues(previous.values, metadata.fields), valid = await pictures(tx, images, true);
        if (valid.some((value, index) => value !== images[index])) throw new ValidateException('PC轮播图片素材不可用，请先修复');
      }
      if (!current) {
        const [created] = await tx.insert(systemGroup).values({ cateId: 0, name: 'PC端首页banner', info: 'PC端首页banner',
          configName: GROUP_NAME, fields: PC_BANNER_DEFAULT_METADATA }).onConflictDoNothing({ target: systemGroup.configName }).returning(groupColumns);
        if (!created) throw new ValidateException('PC轮播组已由其他操作创建，请刷新后确认');
        current = created;
      }
      let resultId = canonical.id;
      if (canonical.operation === 'create') {
        const [created] = await tx.insert(systemGroupData).values({ gid: current.id, value: merged!, sort: canonical.sort,
          status: canonical.status, addTime: Math.floor(Date.now() / 1000) }).returning({ id: systemGroupData.id }); resultId = created.id;
      } else if (canonical.operation === 'update') {
        await tx.update(systemGroupData).set({ value: merged!, sort: canonical.sort, status: canonical.status })
          .where(and(eq(systemGroupData.id, canonical.id), eq(systemGroupData.gid, current.id)));
      } else if (canonical.operation === 'status') {
        await tx.update(systemGroupData).set({ status: canonical.status })
          .where(and(eq(systemGroupData.id, canonical.id), eq(systemGroupData.gid, current.id)));
      } else await tx.delete(systemGroupData).where(and(eq(systemGroupData.id, canonical.id), eq(systemGroupData.gid, current.id)));
      await tx.insert(systemLog).values({ adminId: actorId, type: JOURNAL_TYPE, path: receiptPath(request_id), page: GROUP_NAME,
        method: operation === 'create' ? 'POST' : operation === 'delete' ? 'DELETE' : operation === 'status' ? 'PATCH' : 'PUT',
        action: `${operation};id=${resultId};payload=${payload_hash}`, addTime: Math.floor(Date.now() / 1000) });
      return { operation, id: resultId, request_id, payload_hash };
    });
  }
}
