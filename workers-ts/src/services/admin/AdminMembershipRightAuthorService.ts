import { createHash, timingSafeEqual } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { memberRight, systemAdmin } from '@/models/schema';
import { ApiErrorCode, ApiException, AuthException, NotFoundException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { AdminPermissionService, hasAdminPermission } from './AdminPermissionService';
import { loadAdminLegacyRoleReferenceHistory } from './AdminLegacyRoleDeletionProof';
import { assertAdminAuthoritySession, normalizeAdminAuthorityRules, parseAdminAuthorityRoleIds, withAdminAuthorityWriteTx, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { MEMBERSHIP_RIGHT_AUTHOR_FIELDS, membershipRightAuthorId, membershipRightAuthorInput, membershipRightAuthorQuery,
  membershipRightInteger, membershipRightText, type MembershipRightAuthorField } from './AdminMembershipRightInput';
import { assertMembershipRightMedia, membershipRightMedia, newMembershipRightContent, newMembershipRightImage,
  stableMembershipRightContent, stableMembershipRightImage } from '@/services/user/MembershipRightMediaPolicy';

type Right = typeof memberRight.$inferSelect;
type Values = Partial<typeof memberRight.$inferInsert>;
export interface MembershipRightAuthorRow {
  id: number; right_type: string; title: string; show_title: string; image: string; explain: string; content: string;
  number: number; sort: number; status: number; add_time: number; version: string; image_preview: string; content_preview: string;
}
export interface MembershipRightAuthorPage { author: 1; actor_id: number; page: number; limit: number; count: number; list: MembershipRightAuthorRow[] }
/** Versions cover every actual persisted column, including null and hidden fields. */
export function membershipRightVersion(row: Right): string {
  return createHash('sha256').update(JSON.stringify(['membership-right-author-v1', row.id, row.rightType, row.title, row.showTitle,
    row.image, row.explain, row.content, row.number, row.sort, row.status, row.addTime])).digest('hex');
}
function editing(row: Right) {
  return { id: row.id, right_type: row.rightType, title: row.title, show_title: row.showTitle,
    image: stableMembershipRightImage(row.image), explain: row.explain, content: stableMembershipRightContent(row.content),
    number: row.number, sort: row.sort, status: row.status, add_time: row.addTime, version: membershipRightVersion(row) };
}
const columns: Record<MembershipRightAuthorField, keyof typeof memberRight.$inferInsert> = {
  right_type: 'rightType', title: 'title', show_title: 'showTitle', image: 'image', explain: 'explain', number: 'number', sort: 'sort',
};
const conflict = (): never => { throw new ApiException('会员权益已变化，请重新读取后核对草稿', 409); };

/** Additive author contract only. Legacy save/list behavior remains in the
 * original service; no card, purchase, payment or account tables are written. */
export class AdminMembershipRightAuthorService {
  constructor(private readonly container: Container, private readonly env: Pick<Env, 'APP_KEY'>) {}
  async list(query: URLSearchParams, actor: AdminAuthorityActor): Promise<MembershipRightAuthorPage> {
    const page = membershipRightAuthorQuery(query); assertAdminAuthoritySession(actor);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      // A repeatable read verifies live authority without the write-only
      // SELECT FOR SHARE locks used by loadAdminAuthorityLiveActor.
      const [live] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
      if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0
        || !Number.isInteger(live.level) || live.level < 0 || live.level > 9) throw new AuthException('管理员已禁用或身份已变化', ApiErrorCode.ERR_BANNED);
      if (!timingSafeEqual(new TextEncoder().encode(md5(live.pwd)), new TextEncoder().encode(actor.authVersion))) {
        throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
      }
      const roleIds = parseAdminAuthorityRoleIds(live.roles);
      const history = await loadAdminLegacyRoleReferenceHistory(tx, roleIds, live.level);
      for (const role of history.roles) normalizeAdminAuthorityRules(role.rules);
      const assignment = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(live.roles);
      if (live.level !== 0 && !hasAdminPermission(assignment.keys, 'paid_membership.view')) {
        throw new AuthException('管理员权限已变化', ApiErrorCode.ERR_AUTH);
      }
      const [total] = await tx.select({ count: sql<number>`COUNT(*)::int` }).from(memberRight);
      const rows = await tx.select().from(memberRight).orderBy(desc(memberRight.sort), desc(memberRight.id)).limit(page.limit).offset((page.page - 1) * page.limit);
      const previews = await membershipRightMedia(tx, this.env.APP_KEY, rows, true);
      const list = rows.map((row, index) => ({ ...editing(row), image_preview: previews.images[index]!, content_preview: previews.contents[index]! }));
      assertAdminAuthoritySession(actor);
      return { author: 1, actor_id: live.id, ...page, count: total?.count ?? 0, list };
    });
  }
  private write<T>(actor: AdminAuthorityActor, work: (tx: DbClient) => Promise<T>): Promise<T> {
    return withAdminAuthorityWriteTx(this.container, actor, 'paid_membership.manage', work);
  }
  async save(idValue: unknown, body: Record<string, unknown>, actor: AdminAuthorityActor): Promise<{ id: number; version: string }> {
    const id = membershipRightAuthorId(idValue, true), input = membershipRightAuthorInput(body, id);
    return this.write(actor, async tx => {
      const current = id ? (await tx.select().from(memberRight).where(eq(memberRight.id, id)).limit(1).for('update'))[0] : undefined;
      if (id && !current) throw new NotFoundException('会员权益不存在');
      if (current && input.version !== membershipRightVersion(current)) conflict();
      const values: Values = {};
      if (input.statusOnly) {
        const status = membershipRightInteger(input.fields.status, 0, 1, '权益状态'); if (status !== current!.status) values.status = status;
      } else {
        const stable = current ? editing(current) : undefined;
        for (const field of MEMBERSHIP_RIGHT_AUTHOR_FIELDS) {
          if (!Object.hasOwn(input.fields, field)) continue;
          const value = input.fields[field];
          // The unchanged projected value may represent an invalid/long/raw
          // imported field; do not trim or rewrite any such stored bytes.
          if (stable && value === stable[field]) continue;
          if (field === 'number') values.number = membershipRightInteger(value, 0, 2147483647, '权益数值');
          else if (field === 'sort') values.sort = membershipRightInteger(value, -2147483648, 2147483647, '排序');
          else if (field === 'image') values.image = newMembershipRightImage(value);
          else {
            const max = field === 'right_type' ? 100 : field === 'title' ? 200 : 8;
            const text = membershipRightText(value, max, field === 'explain' ? '权益简介' : '权益名称', true, field === 'explain');
            const key = columns[field] as 'rightType' | 'title' | 'showTitle' | 'explain';
            values[key] = field === 'explain' ? text : text.trim();
          }
        }
        const type = values.rightType ?? current?.rightType, number = values.number ?? current?.number;
        if (values.rightType !== undefined || values.number !== undefined || !current) {
          if (number === undefined) throw Error('Missing membership right number');
          if (['integral', 'express', 'sign'].includes(type ?? '')) membershipRightInteger(number, 1, 10000, '积分倍数或运费折扣');
          if (type === 'offline') membershipRightInteger(number, 1, 100, '线下付款折扣');
        }
        if (input.create) values.status = membershipRightInteger(input.fields.status, 0, 1, '权益状态');
        await assertMembershipRightMedia(tx, values.image);
      }
      if (current) {
        const next = Object.keys(values).length ? (await tx.update(memberRight).set(values).where(eq(memberRight.id, id)).returning())[0]! : current;
        return { id, version: membershipRightVersion(next) };
      }
      const [created] = await tx.insert(memberRight).values({ ...values, addTime: Math.floor(Date.now() / 1000) } as typeof memberRight.$inferInsert).returning();
      if (!created) throw Error('Missing created membership right');
      return { id: created.id, version: membershipRightVersion(created) };
    });
  }
  async saveContent(idValue: unknown, body: Record<string, unknown>, actor: AdminAuthorityActor): Promise<{ id: number; version: string }> {
    const id = membershipRightAuthorId(idValue), input = membershipRightAuthorInput(body, id, true);
    return this.write(actor, async tx => {
      const [current] = await tx.select().from(memberRight).where(eq(memberRight.id, id)).limit(1).for('update');
      if (!current) throw new NotFoundException('会员权益不存在');
      if (input.version !== membershipRightVersion(current)) conflict();
      if (input.fields.content === stableMembershipRightContent(current.content)) return { id, version: membershipRightVersion(current) };
      const content = newMembershipRightContent(input.fields.content); await assertMembershipRightMedia(tx, undefined, content);
      const [next] = await tx.update(memberRight).set({ content }).where(eq(memberRight.id, id)).returning();
      if (!next) throw Error('Missing saved membership right'); return { id, version: membershipRightVersion(next) };
    });
  }
}
