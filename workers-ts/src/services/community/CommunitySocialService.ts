import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  community,
  communityRelevance,
  communityUser,
  systemUserLevel,
  user,
  userFriends,
} from "@/models/schema";
import { createContainerFromDb, withTx, type Container, type DbClient } from "@/lib/di";
import { NotFoundException, ValidateException } from "@/utils/errors";

const COMMUNITY_SOCIAL_LOCK_NAMESPACE = 17_348;
const COMMUNITY_INTEREST = "community_interest";
const COMMUNITY_BROWSE = "community_browse";

type CommunityProfile = typeof communityUser.$inferSelect;

export interface CommunitySocialUser {
  id: number;
  type: number;
  relation_id: number;
  nickname: string;
  avatar: string;
  desc: string;
  community_num: number;
  follow_num: number;
  fans_num: number;
  friend_num: number;
  like_num: number;
  status: number;
  is_del: number;
  add_time: number;
  author: string;
  author_image: string;
  is_follow: 0 | 1;
  is_fans: 0 | 1;
}

interface SocialFlags {
  follows: Set<number>;
  fans: Set<number>;
}

function pagination(page: unknown, limit: unknown): { page: number; limit: number; offset: number } {
  const parsedPage = Number(page);
  const parsedLimit = Number(limit);
  const safePage = Number.isSafeInteger(parsedPage) ? Math.max(1, Math.min(parsedPage, 1_000_000)) : 1;
  const safeLimit = Number.isSafeInteger(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 100)) : 10;
  return { page: safePage, limit: safeLimit, offset: (safePage - 1) * safeLimit };
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new ValidateException(`${label}格式错误`);
  const normalized = value.trim();
  if ([...normalized].length > maximum) throw new ValidateException(`${label}不能超过${maximum}个字符`);
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) throw new ValidateException(`${label}不能包含控制字符`);
  return normalized;
}

function activeAccount(account: { status: number; isDel: number } | undefined): boolean {
  return account?.status === 1 && account.isDel === 0;
}

async function executeRows<T>(tx: DbClient, query: SQL): Promise<T[]> {
  const result = await tx.execute(query);
  return Array.from(result as unknown as Iterable<T>);
}

export class CommunitySocialService {
  constructor(private readonly container: Container) {}

  async profile(authorUidInput: unknown, viewerUid: number): Promise<CommunitySocialUser & {
    friend_count: number;
    level_name: string;
    vip_status: 0 | 1;
    is_self: 0 | 1;
  }> {
    const authorUid = Number(authorUidInput);
    if (!Number.isSafeInteger(authorUid) || authorUid < 0) throw new ValidateException("用户参数错误");
    const profiles = await this.formatProfiles([authorUid], viewerUid);
    const profile = profiles.get(authorUid);
    if (!profile) throw new NotFoundException("用户不存在");

    let levelName = "";
    let vipStatus: 0 | 1 = 0;
    if (authorUid > 0) {
      const [account] = await this.container.db
        .select({
          level: user.level,
          isMoneyLevel: user.isMoneyLevel,
          isEverLevel: user.isEverLevel,
          overdueTime: user.overdueTime,
        })
        .from(user)
        .where(and(eq(user.uid, authorUid), eq(user.status, 1), eq(user.isDel, 0)))
        .limit(1);
      if (!account) throw new NotFoundException("用户不存在");
      const config = await this.container.systemConfigDao.getValues([
        "member_func_status",
        "member_card_status",
      ]);
      if (String(config.member_func_status ?? "1") === "1" && account.level > 0) {
        const [level] = await this.container.db
          .select({ name: systemUserLevel.name })
          .from(systemUserLevel)
          .where(and(eq(systemUserLevel.id, account.level), eq(systemUserLevel.isDel, 0)))
          .limit(1);
        levelName = level?.name ?? "";
      }
      const now = Math.floor(Date.now() / 1000);
      if (String(config.member_card_status ?? "1") === "1") {
        vipStatus = account.isEverLevel === 1
          || (account.isMoneyLevel === 1 && account.overdueTime > now) ? 1 : 0;
      }
    }
    return {
      ...profile,
      friend_count: await this.friendCount(authorUid),
      level_name: levelName,
      vip_status: vipStatus,
      is_self: authorUid === viewerUid ? 1 : 0,
    };
  }

  async updateDescription(uid: number, raw: unknown): Promise<{ desc: string }> {
    const description = text(raw, "个人简介", 255);
    return withTx(this.container, async (tx) => {
      await this.lockUsers(tx, [uid]);
      const profiles = await this.writableProfiles(tx, [uid]);
      const profile = profiles.get(uid);
      if (!profile) throw new NotFoundException("用户不存在");
      await tx.update(communityUser).set({ description }).where(eq(communityUser.id, profile.id));
      return { desc: description };
    });
  }

  async setInterest(
    uid: number,
    authorUidInput: unknown,
    rawStatus: unknown,
  ): Promise<{ status: 0 | 1; is_follow: 0 | 1; is_fans: 0 | 1 }> {
    const authorUid = Number(authorUidInput);
    if (!Number.isSafeInteger(authorUid) || authorUid < 0) throw new ValidateException("用户参数错误");
    if (authorUid === uid) throw new ValidateException("不能关注自己");
    const desired: 0 | 1 = Number(rawStatus) === 0 ? 0 : 1;

    return withTx(this.container, async (tx) => {
      await this.lockUsers(tx, [uid, authorUid]);
      const profiles = await this.writableProfiles(tx, [uid, authorUid]);
      const actor = profiles.get(uid);
      const author = profiles.get(authorUid);
      if (!actor || !author) throw new NotFoundException("用户不存在");

      const existing = await tx
        .select({ id: communityRelevance.id })
        .from(communityRelevance)
        .where(and(
          eq(communityRelevance.leftId, uid),
          eq(communityRelevance.rightId, authorUid),
          eq(communityRelevance.type, COMMUNITY_INTEREST),
        ));
      if (desired === 1 && existing.length === 0) {
        await tx.insert(communityRelevance).values({
          leftId: uid,
          rightId: authorUid,
          type: COMMUNITY_INTEREST,
        });
        await tx.update(communityUser)
          .set({ followNum: sql`GREATEST(${communityUser.followNum} + 1, 0)` })
          .where(eq(communityUser.id, actor.id));
        await tx.update(communityUser)
          .set({ fansNum: sql`GREATEST(${communityUser.fansNum} + 1, 0)` })
          .where(eq(communityUser.id, author.id));
      } else if (desired === 0 && existing.length > 0) {
        await tx.delete(communityRelevance).where(and(
          eq(communityRelevance.leftId, uid),
          eq(communityRelevance.rightId, authorUid),
          eq(communityRelevance.type, COMMUNITY_INTEREST),
        ));
        await tx.update(communityUser)
          .set({ followNum: sql`GREATEST(${communityUser.followNum} - 1, 0)` })
          .where(eq(communityUser.id, actor.id));
        await tx.update(communityUser)
          .set({ fansNum: sql`GREATEST(${communityUser.fansNum} - 1, 0)` })
          .where(eq(communityUser.id, author.id));
      }
      const [reverse] = await tx
        .select({ id: communityRelevance.id })
        .from(communityRelevance)
        .where(and(
          eq(communityRelevance.leftId, authorUid),
          eq(communityRelevance.rightId, uid),
          eq(communityRelevance.type, COMMUNITY_INTEREST),
        ))
        .limit(1);
      return { status: desired, is_follow: desired, is_fans: reverse ? 1 : 0 };
    });
  }

  async followList(uid: number, kind: "follow" | "fans", page: unknown, limit: unknown) {
    const paging = pagination(page, limit);
    const relations = await withTx(this.container, async (tx) => {
      if (kind === "follow") {
        return executeRows<{ relation_id: number }>(tx, sql`
          SELECT right_id::int AS relation_id
          FROM community_relevance
          WHERE left_id = ${uid} AND type = ${COMMUNITY_INTEREST}
          GROUP BY right_id
          ORDER BY max(id) DESC
          LIMIT ${paging.limit} OFFSET ${paging.offset}
        `);
      }
      return executeRows<{ relation_id: number }>(tx, sql`
        SELECT left_id::int AS relation_id
        FROM community_relevance
        WHERE right_id = ${uid} AND type = ${COMMUNITY_INTEREST}
        GROUP BY left_id
        ORDER BY max(id) DESC
        LIMIT ${paging.limit} OFFSET ${paging.offset}
      `);
    });
    return this.projectRelations(uid, relations.map((row) => row.relation_id));
  }

  async friendList(uid: number, page: unknown, limit: unknown) {
    const paging = pagination(page, limit);
    const relations = await this.container.db
      .select({ id: userFriends.id, uid: userFriends.uid, friendsUid: userFriends.friendsUid })
      .from(userFriends)
      .where(or(eq(userFriends.uid, uid), eq(userFriends.friendsUid, uid)))
      .orderBy(desc(userFriends.id));
    const ids = [...new Set(relations
      .map((row) => row.uid === uid ? row.friendsUid : row.uid)
      .filter((value) => value > 0 && value !== uid))]
      .slice(paging.offset, paging.offset + paging.limit);
    return this.projectRelations(uid, ids);
  }

  async recommendations(uid: number, page: unknown, limit: unknown) {
    const paging = pagination(page, limit);
    const rows = await withTx(this.container, async (tx) => executeRows<{ relation_id: number }>(tx, sql`
      WITH candidates AS (
        SELECT DISTINCT ON (cu.relation_id) cu.relation_id, cu.fans_num, cu.id
        FROM community_user cu
        WHERE cu.status = 1 AND cu.is_del = 0 AND cu.community_num > 0
          AND (cu.type <> 2 OR EXISTS (
            SELECT 1 FROM "user" account
            WHERE account.uid = cu.relation_id
              AND account.status = 1 AND account.is_del = 0
          ))
        ORDER BY cu.relation_id, cu.id DESC
      )
      SELECT candidate.relation_id::int AS relation_id
      FROM candidates candidate
      WHERE candidate.relation_id <> ${uid}
        AND NOT EXISTS (
          SELECT 1 FROM community_relevance cr
          WHERE cr.left_id = ${uid} AND cr.right_id = candidate.relation_id
            AND cr.type = ${COMMUNITY_INTEREST}
        )
      ORDER BY candidate.fans_num DESC, candidate.id DESC
      LIMIT ${paging.limit} OFFSET ${paging.offset}
    `));
    return this.projectRelations(uid, rows.map((row) => row.relation_id));
  }

  async followHighlights(uid: number) {
    const rows = await withTx(this.container, async (tx) => executeRows<{
      relation_id: number;
      is_new: number;
    }>(tx, sql`
      WITH followed AS (
        SELECT right_id, max(id) AS relation_row_id
        FROM community_relevance
        WHERE left_id = ${uid} AND type = ${COMMUNITY_INTEREST}
        GROUP BY right_id
      ), latest_posts AS (
        SELECT DISTINCT ON (type, relation_id) id, type, relation_id
        FROM community
        WHERE status = 1 AND is_verify = 1 AND is_del = 0
        ORDER BY type, relation_id, add_time DESC, id DESC
      )
      SELECT f.right_id::int AS relation_id,
        CASE WHEN p.id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM community_relevance seen
          WHERE seen.left_id = ${uid} AND seen.right_id = p.id
            AND seen.type = ${COMMUNITY_BROWSE}
        ) THEN 1 ELSE 0 END::int AS is_new
      FROM followed f
      LEFT JOIN latest_posts p ON p.relation_id = f.right_id
        AND ((f.right_id = 0 AND p.type = 0) OR (f.right_id > 0 AND p.type = 2))
      ORDER BY is_new DESC, f.relation_row_id DESC
      LIMIT 10
    `));
    const profiles = await this.projectRelations(uid, rows.map((row) => row.relation_id));
    const newest = new Map(rows.map((row) => [row.relation_id, row.is_new === 1 ? 1 : 0] as const));
    return profiles.map((profile) => ({
      author: profile.author,
      author_image: profile.author_image,
      relation_id: profile.relation_id,
      is_new: (newest.get(profile.relation_id) ?? 0) as 0 | 1,
    }));
  }

  async recordBrowse(postIdInput: unknown, uid?: number): Promise<{ play_num: number }> {
    const postId = Number(postIdInput);
    if (!Number.isSafeInteger(postId) || postId <= 0) throw new ValidateException("帖子参数错误");
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(
        ${COMMUNITY_SOCIAL_LOCK_NAMESPACE}, hashtext(${`community-browse:${uid ?? 0}:${postId}`})
      )`);
      const [updated] = await tx.update(community)
        .set({ playNum: sql`${community.playNum} + 1` })
        .where(and(
          eq(community.id, postId),
          eq(community.status, 1),
          eq(community.isVerify, 1),
          eq(community.isDel, 0),
        ))
        .returning({ playNum: community.playNum });
      if (!updated) throw new NotFoundException("帖子不存在");
      if (uid && uid > 0) {
        const [existing] = await tx.select({ id: communityRelevance.id })
          .from(communityRelevance)
          .where(and(
            eq(communityRelevance.leftId, uid),
            eq(communityRelevance.rightId, postId),
            eq(communityRelevance.type, COMMUNITY_BROWSE),
          ))
          .limit(1);
        if (!existing) await tx.insert(communityRelevance).values({
          leftId: uid,
          rightId: postId,
          type: COMMUNITY_BROWSE,
        });
      }
      return { play_num: updated.playNum };
    });
  }

  private async projectRelations(uid: number, ids: number[]): Promise<CommunitySocialUser[]> {
    if (ids.length === 0) return [];
    const profiles = await this.formatProfiles(ids, uid);
    return ids.flatMap((id) => {
      const profile = profiles.get(id);
      if (!profile) return [];
      return [profile];
    });
  }

  private async formatProfiles(ids: number[], viewerUid: number): Promise<Map<number, CommunitySocialUser>> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return new Map();
    const positiveIds = uniqueIds.filter((id) => id > 0);
    const [profiles, accounts, config, flags] = await Promise.all([
      this.container.db.select().from(communityUser)
        .where(and(inArray(communityUser.relationId, uniqueIds), eq(communityUser.isDel, 0)))
        .orderBy(desc(communityUser.id)),
      positiveIds.length
        ? this.container.db.select({
          uid: user.uid,
          nickname: user.nickname,
          avatar: user.avatar,
          status: user.status,
          isDel: user.isDel,
          addTime: user.addTime,
        }).from(user).where(inArray(user.uid, positiveIds))
        : Promise.resolve([]),
      uniqueIds.includes(0)
        ? this.container.systemConfigDao.getValues(["site_name", "wap_login_logo"])
        : Promise.resolve({} as Record<string, string>),
      this.socialFlags(viewerUid, uniqueIds),
    ]);
    const profileById = new Map<number, CommunityProfile>();
    for (const profile of profiles) if (
      !profileById.has(profile.relationId)
      && (profile.relationId !== 0 || profile.type === 0)
    ) {
      profileById.set(profile.relationId, profile);
    }
    const accountById = new Map(accounts.map((account) => [account.uid, account]));
    const result = new Map<number, CommunitySocialUser>();
    for (const relationId of uniqueIds) {
      const profile = profileById.get(relationId);
      const account = accountById.get(relationId);
      if (relationId > 0 && (profile?.type ?? 2) === 2 && !activeAccount(account)) continue;
      if (!profile && relationId > 0 && !activeAccount(account)) continue;
      if (!profile && relationId === 0) continue;
      const type = profile?.type ?? 2;
      const author = type === 0
        ? String(config.site_name || "CinaShop")
        : type === 2 ? (account?.nickname || profile?.nickname || "") : (profile?.nickname || "");
      const authorImage = type === 0
        ? String(config.wap_login_logo || "")
        : type === 2 ? (account?.avatar || profile?.avatar || "") : (profile?.avatar || "");
      result.set(relationId, {
        id: profile?.id ?? 0,
        type,
        relation_id: relationId,
        nickname: profile?.nickname || author,
        avatar: profile?.avatar || authorImage,
        desc: profile?.description ?? "",
        community_num: profile?.communityNum ?? 0,
        follow_num: profile?.followNum ?? 0,
        fans_num: profile?.fansNum ?? 0,
        friend_num: profile?.friendNum ?? 0,
        like_num: profile?.likeNum ?? 0,
        status: profile?.status ?? 1,
        is_del: profile?.isDel ?? 0,
        add_time: profile?.addTime ?? account?.addTime ?? 0,
        author,
        author_image: authorImage,
        is_follow: flags.follows.has(relationId) ? 1 : 0,
        is_fans: flags.fans.has(relationId) ? 1 : 0,
      });
    }
    return result;
  }

  private async socialFlags(uid: number, ids: number[]): Promise<SocialFlags> {
    if (uid <= 0 || ids.length === 0) return { follows: new Set(), fans: new Set() };
    const rows = await this.container.db.select({
      leftId: communityRelevance.leftId,
      rightId: communityRelevance.rightId,
    }).from(communityRelevance).where(and(
      eq(communityRelevance.type, COMMUNITY_INTEREST),
      or(
        and(eq(communityRelevance.leftId, uid), inArray(communityRelevance.rightId, ids)),
        and(eq(communityRelevance.rightId, uid), inArray(communityRelevance.leftId, ids)),
      ),
    ));
    return {
      follows: new Set(rows.filter((row) => row.leftId === uid).map((row) => row.rightId)),
      fans: new Set(rows.filter((row) => row.rightId === uid).map((row) => row.leftId)),
    };
  }

  private async friendCount(uid: number): Promise<number> {
    if (uid <= 0) return 0;
    const rows = await this.container.db.select({ uid: userFriends.uid, friendsUid: userFriends.friendsUid })
      .from(userFriends)
      .where(or(eq(userFriends.uid, uid), eq(userFriends.friendsUid, uid)));
    return new Set(rows
      .map((row) => row.uid === uid ? row.friendsUid : row.uid)
      .filter((value) => value > 0 && value !== uid)).size;
  }

  private async lockUsers(tx: DbClient, ids: number[]): Promise<void> {
    for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(
        ${COMMUNITY_SOCIAL_LOCK_NAMESPACE}, hashtext(${`community-social-user:${id}`})
      )`);
    }
  }

  private async writableProfiles(tx: DbClient, ids: number[]): Promise<Map<number, CommunityProfile>> {
    const result = new Map<number, CommunityProfile>();
    for (const uid of [...new Set(ids)].sort((a, b) => a - b)) {
      if (uid === 0) {
        const rows = await tx.select().from(communityUser)
          .where(and(
            eq(communityUser.type, 0),
            eq(communityUser.relationId, 0),
            eq(communityUser.isDel, 0),
          ))
          .orderBy(desc(communityUser.id)).limit(2).for("update");
        if (rows.length !== 1) throw new ValidateException(
          rows.length ? "平台社区资料存在重复" : "平台社区资料不存在",
        );
        result.set(uid, rows[0]);
        continue;
      }
      const [account] = await tx.select({
        uid: user.uid,
        nickname: user.nickname,
        avatar: user.avatar,
      }).from(user).where(and(eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0)))
        .limit(1).for("update");
      if (!account) throw new NotFoundException("用户不存在");
      const rows = await tx.select().from(communityUser).where(and(
        eq(communityUser.type, 2),
        eq(communityUser.relationId, uid),
        eq(communityUser.isDel, 0),
      )).orderBy(desc(communityUser.id)).limit(2).for("update");
      if (rows.length > 1) throw new ValidateException("社区用户资料存在重复，请先处理历史数据");
      if (rows[0]) {
        result.set(uid, rows[0]);
      } else {
        const [created] = await tx.insert(communityUser).values({
          type: 2,
          relationId: uid,
          nickname: account.nickname,
          avatar: account.avatar,
          status: 1,
          isDel: 0,
          addTime: Math.floor(Date.now() / 1000),
        }).returning();
        result.set(uid, created);
      }
    }
    return result;
  }
}

/** Integration scenarios use the same request-scoped container as production. */
export function communitySocialServiceFromDb(db: DbClient): CommunitySocialService {
  return new CommunitySocialService(createContainerFromDb(db));
}
