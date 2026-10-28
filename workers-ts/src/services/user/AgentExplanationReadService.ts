import { desc, eq, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { agreement } from '@/models/schema';
import { parseCanonicalAttachmentId, signAttachmentReferences } from '@/services/system/AttachmentService';
import { publicDiyPresentationImages, publicDiyPresentationVideos } from '@/services/content/DiyPresentationVideoPolicy';
import { canonicalDiyPresentationReference, diyPresentationHtmlMediaReferences,
  mapDiyPresentationHtmlMedia, sanitizeDiyPresentationHtml } from '../../../../view/common/diyPresentationHtml';
import { ValidateException } from '@/utils/errors';

export const AGENT_EXPLANATION_HTML_BYTES = 4_000_000;
export const AGENT_EXPLANATION_MEDIA_LIMIT = 9999;
export interface AgentExplanationDocument {
  /** Preserve the persisted signed int4 identity, including historical zero. */
  id: number;
  type: 2;
  content_preview: string;
}
export interface AgentExplanationRead { version: 1; member_explain: AgentExplanationDocument | null }

function stableReference(value: string): string {
  const reference = canonicalDiyPresentationReference(value);
  try {
    const url = new URL(reference);
    if (url.protocol === 'https:' && !url.username && !url.password && /^\/api\/assets\/[1-9]\d*$/u.test(url.pathname)) {
      const local = canonicalDiyPresentationReference(url.pathname + url.search + url.hash);
      if (parseCanonicalAttachmentId(local) !== null) return local;
    }
  } catch { /* Static and canonical relative references use the common grammar. */ }
  return reference;
}

async function previewExplanation(db: Pick<DbClient, 'select'>, key: string | undefined, content: string): Promise<string> {
  const stable = mapDiyPresentationHtmlMedia(content, stableReference);
  // Count every actual authored media slot before dropping unsafe attributes.
  // Reject an over-capacity document; never silently keep a partial document.
  if (diyPresentationHtmlMediaReferences(stable).length > AGENT_EXPLANATION_MEDIA_LIMIT)
    throw new ValidateException('分销说明图片与视频超过完整9999项预览容量');
  const clean = sanitizeDiyPresentationHtml(stable), slots = diyPresentationHtmlMediaReferences(clean);
  const images = await publicDiyPresentationImages(db, slots.filter(slot => slot.kind === 'image').map(slot => slot.value));
  const videos = await publicDiyPresentationVideos(db, slots.filter(slot => slot.kind === 'video').map(slot => slot.value));
  let image = 0, video = 0;
  const approved = slots.map(slot => slot.kind === 'image' ? images[image++]! : videos[video++]!);
  const safe = sanitizeDiyPresentationHtml(mapDiyPresentationHtmlMedia(clean, (_value, _kind, index) => approved[index]!));
  const references = [...new Set(approved.filter(value => parseCanonicalAttachmentId(value) !== null))];
  const tickets = references.length ? await signAttachmentReferences(key, references) : [];
  const byReference = new Map(references.map((value, index) => [value, tickets[index]!]));
  return mapDiyPresentationHtmlMedia(safe, value => byReference.get(value) ?? value);
}

/** Public additive reader for PHP user_distribution_info. Status0 is a
 * configured explanation, exactly like PHP's public agreement type2 lookup.
 * Only the stored record authorizes platform media; no R2/provider is read. */
export class AgentExplanationReadService {
  constructor(private readonly container: Container, private readonly env: Pick<Env, 'APP_KEY'>) {}

  async read(): Promise<AgentExplanationRead> {
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      const [row] = await tx.select().from(agreement).where(eq(agreement.type, 2))
        .orderBy(desc(agreement.sort), desc(agreement.id)).limit(1);
      if (!row || row.type !== 2) return { version: 1, member_explain: null };
      const content = row.content ?? '';
      if (typeof content !== 'string' || new TextEncoder().encode(content).byteLength > AGENT_EXPLANATION_HTML_BYTES)
        throw new ValidateException('分销说明超过完整4MB UTF8读取容量');
      let preview: string;
      try { preview = await previewExplanation(tx, this.env.APP_KEY, content); }
      catch (error) {
        if (error instanceof ValidateException || error instanceof Error && error.message.startsWith('DIY'))
          throw new ValidateException(error.message.replaceAll('DIY', '分销说明'));
        throw error;
      }
      if (new TextEncoder().encode(preview).byteLength > AGENT_EXPLANATION_HTML_BYTES)
        throw new ValidateException('分销说明超过完整4MB UTF8预览容量');
      return { version: 1, member_explain: { id: row.id, type: 2, content_preview: preview } };
    });
  }
}
