import { and, eq, inArray } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import { systemAttachment } from "@/models/schema";
import { ValidateException } from "@/utils/errors";
import { parseCanonicalAttachmentId, R2_IMAGE_TYPE, signAttachmentReferences } from "@/services/system/AttachmentService";
import { assertActiveMediaUser } from "@/services/system/CustomerVideoPolicy";

function ownedVideo(row: typeof systemAttachment.$inferSelect, uid: number): boolean {
  return row.type === 3 && row.moduleType === 3 && row.relationId === uid && row.fileType === 2
    && row.imageType === R2_IMAGE_TYPE && row.attType.trim() === "video/mp4"
    && row.name.startsWith(`attachments/user/${uid}/`)
    && row.attDir === `/api/assets/${row.attId}` && row.sattDir === row.attDir;
}

export async function assertCommunityVideo(tx: DbClient, uid: number, reference: string,
  existingReference?: string): Promise<void> {
  const id = parseCanonicalAttachmentId(reference);
  // Retain unchanged historical URLs on edits; new uploads use owned private references.
  if (!id && reference === existingReference) return;
  if (!id) throw new ValidateException("请先上传自己的MP4视频");
  await assertActiveMediaUser(tx, uid);
  const [row] = await tx.select().from(systemAttachment).where(eq(systemAttachment.attId, id))
    .limit(1).for("share");
  if (!row || !ownedVideo(row, uid)) throw new ValidateException("视频不存在或不属于当前用户");
}

/** Called only after the community visibility query, including the author's pending preview. */
export async function communityVideoSources(db: DbClient, appKey: string | undefined,
  posts: Array<{ id: number; type: number; relationId: number; videoUrl: string }>): Promise<Map<number, string>> {
  const ids = [...new Set(posts.map(post => parseCanonicalAttachmentId(post.videoUrl)).filter((id): id is number => id !== null))];
  if (!ids.length) return new Map();
  const attachments = await db.select().from(systemAttachment).where(and(
    inArray(systemAttachment.attId, ids), eq(systemAttachment.fileType, 2), eq(systemAttachment.imageType, R2_IMAGE_TYPE),
  ));
  const byId = new Map(attachments.map(row => [row.attId, row]));
  const output = new Map<number, string>();
  for (const post of posts) {
    const id = parseCanonicalAttachmentId(post.videoUrl);
    if (!id) continue;
    const row = byId.get(id);
    // Never mint a capability for another actor's attachment from a legacy/dirty row.
    const valid = post.type === 2 && row && ownedVideo(row, post.relationId);
    output.set(post.id, valid ? (await signAttachmentReferences(appKey, [post.videoUrl]))[0] : "");
  }
  return output;
}
