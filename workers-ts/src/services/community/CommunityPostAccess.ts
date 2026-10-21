/** Pure lifecycle predicates shared by detail and comment paths. Reading a
 * thread must never call detail(), whose public path records a browse. */
export interface CommunityPostAccessRow {
  type: number;
  relationId: number;
  status: number;
  isVerify: number;
  isDel: number;
}

export function isPublicCommunityPost(post: CommunityPostAccessRow | undefined): boolean {
  return Boolean(post && post.isDel === 0 && post.status === 1 && post.isVerify === 1);
}

export function canReadCommunityPost(post: CommunityPostAccessRow | undefined, uid?: number): boolean {
  return Boolean(post && post.isDel === 0 && (isPublicCommunityPost(post)
    || (Number.isSafeInteger(uid) && uid! > 0 && post.type === 2 && post.relationId === uid)));
}
