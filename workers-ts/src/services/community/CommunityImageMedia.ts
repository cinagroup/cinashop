import { inArray } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import { systemAttachment } from "@/models/schema";
import { ValidateException } from "@/utils/errors";
import { parseCanonicalAttachmentId, R2_IMAGE_TYPE, signAttachmentReferences } from "@/services/system/AttachmentService";
import { assertActiveMediaUser } from "@/services/system/CustomerVideoPolicy";

function ownedImage(row: typeof systemAttachment.$inferSelect, uid: number): boolean {
  return row.type === 3 && row.moduleType === 3 && row.relationId === uid && row.fileType === 1
    && row.imageType === R2_IMAGE_TYPE && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(row.attType.trim())
    && row.name.startsWith(`attachments/user/${uid}/`)
    && row.attDir === `/api/assets/${row.attId}` && row.sattDir === row.attDir;
}

/** Existing remote image URLs retain the PHP contract. Private references must
 * be canonical and owned; a preview signature cannot become stored authority. */
export async function assertCommunityImages(tx: DbClient, uid: number, references: string[]): Promise<void> {
  const refs = [...new Set(references.filter(Boolean))];
  const privateRefs = refs.filter(ref => ref.startsWith("/api/assets/"));
  const ids = privateRefs.map(parseCanonicalAttachmentId);
  if (ids.some(id => id === null)) throw new ValidateException("请使用上传后的固定图片引用");
  if (!ids.length) return;
  await assertActiveMediaUser(tx, uid);
  const rows = await tx.select().from(systemAttachment)
    .where(inArray(systemAttachment.attId, ids as number[])).orderBy(systemAttachment.attId).for("share");
  if (rows.length !== ids.length || rows.some(row => !ownedImage(row, uid))) {
    throw new ValidateException("图片不存在或不属于当前用户");
  }
}

function gallery(value: string | null): string[] {
  try { const items: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(items) ? items.filter((x): x is string => typeof x === "string").slice(0, 20) : [];
  } catch { return []; }
}

/** Run only after visibility filtering. Dirty cross-owner rows never mint image capabilities. */
export async function communityImageSources(db: DbClient, appKey: string | undefined,
  posts: Array<{ id: number; type: number; relationId: number; image: string; sliderImage: string | null }>,
): Promise<Map<number, { image: string; sliderImage: string[] }>> {
  const users = posts.filter(post => post.type === 2);
  const ids = [...new Set(users.flatMap(post => [post.image, ...gallery(post.sliderImage)])
    .map(parseCanonicalAttachmentId).filter((id): id is number => id !== null))];
  const rows = ids.length ? await db.select().from(systemAttachment).where(inArray(systemAttachment.attId, ids)) : [];
  const byId = new Map(rows.map(row => [row.attId, row]));
  const result = new Map<number, { image: string; sliderImage: string[] }>();
  for (const post of users) {
    const source = async (ref: string) => {
      if (!ref.startsWith("/api/assets/")) return ref;
      const id = parseCanonicalAttachmentId(ref), row = id === null ? undefined : byId.get(id);
      return row && ownedImage(row, post.relationId) ? (await signAttachmentReferences(appKey, [ref]))[0] : "";
    };
    result.set(post.id, { image: await source(post.image),
      sliderImage: (await Promise.all(gallery(post.sliderImage).map(source))).filter(Boolean) });
  }
  return result;
}
