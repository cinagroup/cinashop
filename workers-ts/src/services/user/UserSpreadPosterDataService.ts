import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemAttachment, systemConfig, systemGroup, systemGroupData, user } from '@/models/schema';
import { themeDeadlines, themeHash } from '@/services/content/ThemeReadService';
import { parseCanonicalAttachmentId, R2_IMAGE_TYPE, signAttachmentReferences } from '@/services/system/AttachmentService';
import { normalizeConfigScalar } from '@/utils/config';
import { ApiErrorCode, AuthException, ValidateException } from '@/utils/errors';

export const SPREAD_POSTER_TEMPLATE_LIMIT = 30;
const MAX_JSON_BYTES = 65536, MAX_REFERENCE = 2048;
export interface SpreadPosterActor { uid: number; authVersion: string; expiresAt: number }
export interface SpreadPosterData { spread: Array<{ pic: string }>; qrcode: ''; nickname: string; avatar: string; site_name: string }
interface PosterSnapshot { references: string[]; nickname: string; siteName: string; revision: string }

function currentActor(value: SpreadPosterActor): SpreadPosterActor {
  if (!value || !Number.isSafeInteger(value.uid) || value.uid <= 0 || value.uid > 2147483647
    || !/^[a-f0-9]{32}$/.test(value.authVersion) || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= Math.floor(Date.now() / 1000)) throw new AuthException('推广海报登录已失效', ApiErrorCode.ERR_EXPIRED);
  return Object.freeze({ ...value });
}

function label(value: string, maximum: number): string {
  if (value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new ValidateException('推广海报文字超过完整读取容量或格式无效');
  return value;
}

/** Refresh only canonical bare or structurally valid stored asset tickets.
 * No URI normalization, foreign origin or unknown ticket fields grants an ID. */
export function spreadPosterAssetReference(value: string): string | null {
  if (!value.startsWith('/api/assets/')) return null;
  const parts = value.split('?');
  const id = parseCanonicalAttachmentId(parts[0]);
  if (!id || id > 2147483647 || parts.length > 2 || value.includes('#')) throw new ValidateException('推广海报素材地址无效');
  if (parts.length === 2) {
    const query = new URLSearchParams(parts[1]);
    const allowed = ['expires', 'signature', 'variant', 'width', 'height'];
    if ([...query.keys()].some(key => !allowed.includes(key) || query.getAll(key).length !== 1)
      || !/^[1-9]\d{0,10}$/.test(query.get('expires') ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(query.get('signature') ?? '')) {
      throw new ValidateException('推广海报历史素材签名格式无效');
    }
    const variant = query.has('variant') || query.has('width') || query.has('height');
    if (variant && (query.get('variant') !== 'mid' || !/^[1-9]\d{0,3}$/.test(query.get('width') ?? '')
      || !/^[1-9]\d{0,3}$/.test(query.get('height') ?? '') || Number(query.get('width')) > 2048 || Number(query.get('height')) > 2048)) {
      throw new ValidateException('推广海报历史素材变体无效');
    }
  }
  return parts[0];
}

function legacyOrigin(value: string): string {
  let origin: URL;
  try { origin = new URL(value); } catch { throw new ValidateException('旧海报上传图片须配置平台站点HTTPS源'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new ValidateException('旧海报上传图片须配置平台站点根HTTPS源');
  }
  return origin.origin;
}

function media(value: unknown, siteUrl: string, empty = false): string {
  if (typeof value !== 'string' || value.length > MAX_REFERENCE || value !== value.trim()
    || /[\\\u0000-\u0020\u007f]/u.test(value)) throw new ValidateException('推广海报图片地址无效');
  if (!value) { if (empty) return ''; throw new ValidateException('推广海报模板缺少图片'); }
  const asset = spreadPosterAssetReference(value);
  if (asset) return asset;
  const upload = value.startsWith('uploads/') ? `/${value}` : value;
  if (upload.startsWith('/uploads/')) {
    if (!/^\/uploads\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:jpe?g|png|gif|webp)$/i.test(upload)
      || upload.split('/').some(piece => piece === '.' || piece === '..')) throw new ValidateException('旧海报上传图片路径无效');
    return new URL(upload, legacyOrigin(siteUrl)).href;
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new ValidateException('推广海报相对图片尚无受控映射'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || url.pathname.startsWith('/api/assets/')) throw new ValidateException('推广海报图片须为稳定HTTPS或已核验R2素材');
  return value;
}

function configuredTemplates(raw: string): string[] {
  const normalized = normalizeConfigScalar(raw);
  if (!normalized) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(normalized); } catch { throw new ValidateException('推广海报模板JSON无效'); }
  if (!Array.isArray(parsed) || parsed.length > SPREAD_POSTER_TEMPLATE_LIMIT || parsed.some(item => typeof item !== 'string')) {
    throw new ValidateException('推广海报须为最多30项的完整图片列表');
  }
  return parsed as string[];
}

async function groupTemplates(db: DbClient) {
  const groups = await db.select({ id: systemGroup.id }).from(systemGroup)
    .where(eq(systemGroup.configName, 'routine_spread_banner')).limit(2);
  if (groups.length > 1) throw new ValidateException('推广海报分组身份重复');
  if (!groups.length) return { references: [] as string[], facts: [] as unknown[] };
  const rows = await db.select({ id: systemGroupData.id, sort: systemGroupData.sort,
    value: sql<string | null>`CASE WHEN octet_length(${systemGroupData.value}) <= ${MAX_JSON_BYTES} THEN ${systemGroupData.value} ELSE NULL END`,
    oversized: sql<boolean>`COALESCE(octet_length(${systemGroupData.value}),0) > ${MAX_JSON_BYTES}`,
  }).from(systemGroupData).where(and(eq(systemGroupData.gid, groups[0].id), eq(systemGroupData.status, 1)))
    .orderBy(desc(systemGroupData.sort), asc(systemGroupData.id)).limit(SPREAD_POSTER_TEMPLATE_LIMIT + 1);
  if (rows.length > SPREAD_POSTER_TEMPLATE_LIMIT || rows.some(row => row.oversized)) throw new ValidateException('推广海报分组超过完整读取容量');
  const references = rows.map(row => {
    let value: unknown;
    try { value = JSON.parse(row.value ?? ''); } catch { throw new ValidateException('推广海报分组JSON无效'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('推广海报分组结构无效');
    const pic = (value as Record<string, unknown>).pic;
    const reference = pic && typeof pic === 'object' && !Array.isArray(pic) && Object.hasOwn(pic, 'value')
      ? (pic as Record<string, unknown>).value : pic;
    if (typeof reference !== 'string') throw new ValidateException('推广海报分组缺少图片');
    return reference;
  });
  return { references, facts: [groups[0], ...rows] };
}

async function checkedAttachments(db: DbClient, references: string[], uid: number) {
  const ids = [...new Set(references.map(parseCanonicalAttachmentId).filter((id): id is number => id !== null))];
  if (!ids.length) return [];
  const rows = await db.select({ id: systemAttachment.attId, type: systemAttachment.type, owner: systemAttachment.relationId,
    module: systemAttachment.moduleType, file: systemAttachment.fileType, image: systemAttachment.imageType,
    path: systemAttachment.attDir, key: systemAttachment.name, mime: systemAttachment.attType, time: systemAttachment.time,
  }).from(systemAttachment).where(inArray(systemAttachment.attId, ids)).limit(SPREAD_POSTER_TEMPLATE_LIMIT + 2);
  const byId = new Map(rows.map(row => [row.id, row]));
  references.forEach((reference, index) => {
    const id = parseCanonicalAttachmentId(reference);
    if (id === null) return;
    const row = byId.get(id), platform = row?.type === 1 && row.owner === 0 && row.module === 1;
    const ownerAvatar = index === 0 && row?.type === 3 && row.owner === uid && row.module === 3;
    if (!row || (!platform && !ownerAvatar) || row.path !== reference || row.file !== 1 || row.image !== R2_IMAGE_TYPE) {
      throw new ValidateException('推广海报头像或模板素材不属于当前允许范围');
    }
    const prefix = platform ? 'attachments/admin/1/' : `attachments/user/${uid}/`;
    const extension = /\.(jpe?g|png|gif|webp)$/i.exec(row.key)?.[1]?.toLowerCase();
    const expected = extension ? `image/${extension === 'jpg' ? 'jpeg' : extension}` : '';
    const actual = row.mime.trim().toLowerCase().replace(/^image\/jpg$/, 'image/jpeg');
    if (!row.key.startsWith(prefix) || !/^[A-Za-z0-9_./-]+$/.test(row.key)
      || row.key.split('/').some(part => !part || part === '.' || part === '..') || !expected || actual && actual !== expected) {
      throw new ValidateException('推广海报素材路径或图片类型无效');
    }
  });
  return rows.sort((a, b) => a.id - b.id);
}

/** No KV, remote HTTP, R2 object read or SQL DML. Current actor and persisted
 * media authority are checked in a fresh second snapshot after signing. */
export class UserSpreadPosterDataService {
  constructor(private readonly container: Container, private readonly env: { APP_KEY: string },
    private readonly signer: typeof signAttachmentReferences = signAttachmentReferences) {}

  private async snapshot(actor: SpreadPosterActor): Promise<PosterSnapshot> {
    currentActor(actor);
    return withTx(this.container, async db => {
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await themeDeadlines(db);
      const [account] = await db.select({ uid: user.uid, auth: sql<string>`md5(${user.pwd})`,
        avatar: sql<string | null>`CASE WHEN octet_length(${user.avatar}) <= ${MAX_REFERENCE * 4} THEN ${user.avatar} ELSE NULL END`,
        nickname: sql<string | null>`CASE WHEN octet_length(${user.nickname}) <= 1020 THEN ${user.nickname} ELSE NULL END`,
        oversized: sql<boolean>`octet_length(${user.avatar}) > ${MAX_REFERENCE * 4} OR octet_length(${user.nickname}) > 1020`,
      })
        .from(user).where(and(eq(user.uid, actor.uid), eq(user.status, 1), eq(user.isDel, 0), isNull(user.deleteTime))).limit(1);
      if (!account || account.auth !== actor.authVersion) throw new AuthException('推广海报账户已变化', ApiErrorCode.ERR_EXPIRED);
      if (account.oversized || account.avatar === null || account.nickname === null) throw new ValidateException('推广海报账户图片或文字超过完整读取容量');
      const configs = await db.selectDistinctOn([systemConfig.menuName], { id: systemConfig.id, name: systemConfig.menuName, sort: systemConfig.sort,
        value: sql<string | null>`CASE WHEN octet_length(${systemConfig.value}) <= ${MAX_JSON_BYTES} THEN ${systemConfig.value} ELSE NULL END`,
        oversized: sql<boolean>`COALESCE(octet_length(${systemConfig.value}),0) > ${MAX_JSON_BYTES}`,
      }).from(systemConfig).where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, ['spread_banner', 'site_name', 'site_url'])))
        .orderBy(systemConfig.menuName, desc(systemConfig.sort), desc(systemConfig.id)).limit(4);
      if (configs.length > 3 || configs.some(row => row.oversized)) throw new ValidateException('推广海报配置超过完整读取容量');
      const config = new Map<string, string>();
      for (const row of configs) if (!config.has(row.name)) config.set(row.name, row.value ?? '');
      let templates = configuredTemplates(config.get('spread_banner') ?? ''), groupFacts: unknown[] = [];
      if (!templates.length) { const fallback = await groupTemplates(db); templates = fallback.references; groupFacts = fallback.facts; }
      const siteUrl = normalizeConfigScalar(config.get('site_url') ?? '');
      const references = [media(account.avatar, siteUrl, true), ...templates.map(reference => media(reference, siteUrl))];
      const attachments = await checkedAttachments(db, references, actor.uid);
      const nickname = label(account.nickname, 255), siteName = label(normalizeConfigScalar(config.get('site_name') ?? ''), 255);
      return { references, nickname, siteName, revision: await themeHash({ account, configs, groupFacts, references, attachments }) };
    });
  }

  async read(actorValue: SpreadPosterActor): Promise<SpreadPosterData> {
    const actor = currentActor(actorValue), first = await this.snapshot(actor);
    const signed = first.references.some(reference => parseCanonicalAttachmentId(reference) !== null)
      ? await this.signer(this.env.APP_KEY, first.references) : first.references;
    const fresh = await this.snapshot(actor);
    currentActor(actor);
    if (first.revision !== fresh.revision) throw new ValidateException('推广海报身份、配置或素材已变化，请重新读取');
    return { spread: signed.slice(1).map(pic => ({ pic })), qrcode: '', nickname: first.nickname, avatar: signed[0], site_name: first.siteName };
  }
}
