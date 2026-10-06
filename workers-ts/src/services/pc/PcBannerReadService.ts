import { and, desc, eq, sql } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { systemGroup, systemGroupData } from '@/models/schema';
import { pcBannerImage, pcBannerLink, pcBannerText } from '@/services/admin/AdminPcBannerInput';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { canonicalizePublishedAttachmentReference } from '@/services/content/ArticleContentPolicy';

// Match the dedicated Admin merged-value capacity; a legitimate new save must
// not disappear solely because the public reader has a smaller byte limit.
const MAX_VALUE_BYTES = 1024 * 1024;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
type MediaSlot = { key: string; index: number | null; value: unknown };
export interface PcBannerDecoded {
  fields: Record<string, unknown>;
  media: MediaSlot[];
}
export interface PublicPcBanner extends Record<string, unknown> {
  id: number;
  title: string;
  image: string;
  url: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Flatten PHP's {type,value} fields without exposing corrupt raw JSON or
 * prototype keys. Dynamic input/textarea/choice values remain independent of
 * the three default fields. Upload fields are resolved separately before any
 * canonical private attachment reference becomes public. */
export function decodePcBannerValue(raw: string | null): PcBannerDecoded | null {
  if (!raw || new TextEncoder().encode(raw).byteLength > MAX_VALUE_BYTES) return null;
  let source: unknown;
  try { source = JSON.parse(raw); } catch { return null; }
  if (!record(source)) return null;
  const unwrap = (wrapped: unknown) => record(wrapped) && Object.hasOwn(wrapped, 'value') ? wrapped.value : wrapped;
  try {
    // Decode the display contract first. Opaque extensions must not decide
    // whether a valid title, principal image and navigation can be shown.
    const principal = unwrap(source.image);
    const image = Array.isArray(principal) ? principal[0] : principal;
    if (typeof image !== 'string' || !image) return null;
    const title = pcBannerText(unwrap(source.title) ?? '', 4096, '轮播标题', false, true);
    const target = unwrap(source.url) ?? '';
    if (typeof target !== 'string') return null;
    const url = target === '' ? '' : pcBannerLink(target);
    const fields: Record<string, unknown> = { title, image, url };
    const media: MediaSlot[] = [{ key: 'image', index: null, value: image }];
    let extensions = 0;
    for (const [key, wrapped] of Object.entries(source)) {
      if (UNSAFE_KEYS.has(key) || key.length > 100 || ['title', 'image', 'url'].includes(key)) continue;
      if (extensions++ >= 100) break;
      try {
        let visited = 0;
        const copy = (value: unknown, depth: number): unknown => {
          if (++visited > 10_000 || depth > 16) throw Error('PC banner extension exceeds read capacity');
          if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
          if (typeof value === 'string') {
            if (value.length > 100_000) throw Error('PC banner field exceeds read capacity');
            return value;
          }
          if (Array.isArray(value)) return value.map(item => copy(item, depth + 1));
          if (record(value)) return Object.fromEntries(Object.entries(value)
            .filter(([nestedKey]) => !UNSAFE_KEYS.has(nestedKey)).map(([nestedKey, item]) => [nestedKey, copy(item, depth + 1)]));
          throw Error('Invalid PC banner value');
        };
        let field = unwrap(wrapped);
        const type = record(wrapped) ? wrapped.type : undefined;
        // PHP uses the first single-upload value and wraps historical multi-
        // upload strings. Later single-upload items never become fallbacks.
        if (type === 'upload' && Array.isArray(field)) field = field[0];
        if (type === 'uploads' && typeof field === 'string') field = field ? [field] : [];
        const value = copy(field, 0);
        if (type === 'uploads' && (!Array.isArray(value) || value.length > 5)) continue;
        fields[key] = value;
        if (type === 'upload') media.push({ key, index: null, value });
        else if (type === 'uploads') (value as unknown[]).forEach((item, index) => media.push({ key, index, value: item }));
      } catch {
        // Keep other bounded extensions and the independent display contract.
      }
    }
    return { fields, media };
  } catch { return null; }
}

/** The legacy PC template renders indices 0..9. Limit the ordered SQL window
 * before filtering invalid rows: the eleventh row must not silently replace a
 * corrupt or unreadable earlier row. This does not limit Admin CRUD capacity. */
export class PcBannerReadService {
  constructor(private readonly container: Container, private readonly env: { APP_KEY?: string }) {}

  async banner(): Promise<{ list: PublicPcBanner[] }> {
    const snapshot = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SELECT set_config('statement_timeout', '5s', true), set_config('idle_in_transaction_session_timeout', '5s', true)`);
      const rows = await tx.select({ id: systemGroupData.id, value: systemGroupData.value })
        .from(systemGroupData).innerJoin(systemGroup, eq(systemGroupData.gid, systemGroup.id))
        .where(and(eq(systemGroup.configName, 'pc_home_banner'), eq(systemGroupData.status, 1)))
        .orderBy(desc(systemGroupData.sort), desc(systemGroupData.id)).limit(10);
      const decoded = rows.flatMap(row => {
        const value = decodePcBannerValue(row.value);
        return value ? [{ id: row.id, ...value }] : [];
      });
      const slots = decoded.flatMap(row => row.media);
      const pictures = slots.map(slot => {
        try { return typeof slot.value === 'string' ? pcBannerImage(canonicalizePublishedAttachmentReference(slot.value)) : ''; }
        catch { return ''; }
      });
      const references = await publicProductPictures(tx, pictures.map(image => ({ image, type: 0, relationId: 0 })));
      return { decoded, references };
    });
    // The existing resolver signs only canonical references; static HTTPS and
    // root-relative legacy images are retained without HTTP or R2 requests.
    const rendered = await renderProductPictures(this.env.APP_KEY, snapshot.references);
    let index = 0;
    const list: PublicPcBanner[] = [];
    for (const row of snapshot.decoded) {
      for (const slot of row.media) {
        const reference = rendered[index++] ?? '';
        if (slot.index === null) row.fields[slot.key] = reference;
        else (row.fields[slot.key] as unknown[])[slot.index] = reference;
      }
      if (!row.fields.image) continue;
      list.push({ ...row.fields, id: row.id, title: row.fields.title as string,
        image: row.fields.image as string, url: row.fields.url as string });
    }
    return { list };
  }
}
