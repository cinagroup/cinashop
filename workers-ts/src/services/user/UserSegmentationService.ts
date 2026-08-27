import { and, asc, desc, eq, ilike, inArray, ne, sql } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  legacyCategory,
  user as userTable,
  userGroup,
  userLabel,
  userLabelRelation,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

const PLATFORM_TYPE = 0;
const PLATFORM_RELATION_ID = 0;
const GROUP_LOCK_NAMESPACE = 731_621;
const MAX_PAGE_SIZE = 100;
const MAX_BULK_USERS = 500;
const MAX_LABELS_PER_REQUEST = 200;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, field: string, defaultValue: number, max = 2_147_483_647) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new ValidateException(`${field}必须是非负整数`);
  }
  return parsed;
}

export function normalizeSegmentationIds(
  value: unknown,
  field: string,
  maxItems: number,
): number[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",").map((item) => item.trim()).filter(Boolean)
      : value === undefined || value === null || value === ""
        ? []
        : [value];
  if (raw.length > maxItems) throw new ValidateException(`${field}不能超过${maxItems}项`);
  const ids = raw.map((item) => integer(item, field, 0)).filter((item) => item > 0);
  if (ids.length !== raw.length) throw new ValidateException(`${field}包含无效ID`);
  return [...new Set(ids)].sort((a, b) => a - b);
}

function platformRelationScope() {
  return and(
    eq(userLabelRelation.type, PLATFORM_TYPE),
    eq(userLabelRelation.relationId, PLATFORM_RELATION_ID),
  );
}

export class UserSegmentationService {
  constructor(private readonly container: Container) {}

  async groupList(query: Record<string, string>) {
    const page = Math.max(1, integer(query.page, "页码", 1));
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, integer(query.limit, "每页数量", 20)));
    const conditions = [];
    const name = query.group_name?.trim() ?? query.name?.trim();
    if (name) conditions.push(ilike(userGroup.groupName, `%${name}%`));
    const where = conditions.length ? and(...conditions) : undefined;
    const [list, countRows] = await Promise.all([
      this.container.db
        .select({ id: userGroup.id, group_name: userGroup.groupName })
        .from(userGroup)
        .where(where)
        .orderBy(desc(userGroup.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(userGroup)
        .where(where),
    ]);
    return { list, count: countRows[0]?.count ?? 0, page, limit };
  }

  async saveGroup(input: unknown) {
    const body = record(input);
    const id = integer(body.id, "分组ID", 0);
    const groupName = typeof body.group_name === "string" ? body.group_name.trim() : "";
    if (!groupName) throw new ValidateException("请输入分组名称");
    if (groupName.length > 64) throw new ValidateException("分组名称不能超过64个字符");
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${GROUP_LOCK_NAMESPACE}, 0)`);
      if (id > 0) {
        const existing = await tx
          .select({ id: userGroup.id })
          .from(userGroup)
          .where(eq(userGroup.id, id))
          .limit(1);
        if (!existing[0]) throw new NotFoundException("用户分组不存在");
      }
      const duplicateConditions = [eq(userGroup.groupName, groupName)];
      if (id > 0) duplicateConditions.push(ne(userGroup.id, id));
      const duplicate = await tx
        .select({ id: userGroup.id })
        .from(userGroup)
        .where(and(...duplicateConditions))
        .limit(1);
      if (duplicate[0]) throw new ValidateException("该分组已经存在");
      if (id > 0) {
        await tx.update(userGroup).set({ groupName }).where(eq(userGroup.id, id));
        return { id };
      }
      const inserted = await tx
        .insert(userGroup)
        .values({ groupName })
        .returning({ id: userGroup.id });
      return { id: inserted[0].id };
    });
  }

  async deleteGroup(id: number) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("分组ID错误");
    return withTx(this.container, async (tx) => {
      const group = await tx
        .select({ id: userGroup.id })
        .from(userGroup)
        .where(eq(userGroup.id, id))
        .limit(1)
        .for("update");
      if (!group[0]) throw new NotFoundException("用户分组不存在");
      const used = await tx
        .select({ uid: userTable.uid })
        .from(userTable)
        .where(and(eq(userTable.groupId, id), eq(userTable.isDel, 0)))
        .limit(1);
      if (used[0]) throw new ValidateException("该分组仍有用户，不能删除");
      await tx.delete(userGroup).where(eq(userGroup.id, id));
    });
  }

  async userLabels(uid: number) {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("用户ID错误");
    const exists = await this.container.db
      .select({ uid: userTable.uid })
      .from(userTable)
      .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0)))
      .limit(1);
    if (!exists[0]) throw new NotFoundException("用户不存在");
    const rows = await this.container.db
      .select({
        relation_id: userLabelRelation.id,
        id: userLabel.id,
        label_name: userLabel.name,
        color: userLabel.color,
      })
      .from(userLabelRelation)
      .innerJoin(userLabel, eq(userLabel.id, userLabelRelation.labelId))
      .where(and(eq(userLabelRelation.uid, uid), platformRelationScope()))
      .orderBy(asc(userLabelRelation.id));
    // Historical duplicate relation rows stay in storage but are collapsed for UI display.
    return [...new Map(rows.map((item) => [item.id, item])).values()];
  }

  /** PHP-compatible label selector used by the dedicated customer-service UI. */
  async userLabelOptions(uid: number) {
    const selected = await this.userLabels(uid);
    const selectedIds = new Set(selected.map((item) => item.id));
    const [categories, labels] = await Promise.all([
      this.container.db
        .select({
          id: legacyCategory.id,
          name: legacyCategory.name,
          sort: legacyCategory.sort,
        })
        .from(legacyCategory)
        .where(and(
          eq(legacyCategory.ownerId, 0),
          eq(legacyCategory.type, PLATFORM_TYPE),
          eq(legacyCategory.relationId, PLATFORM_RELATION_ID),
          eq(legacyCategory.group, 0),
          eq(legacyCategory.isShow, 1),
        ))
        .orderBy(desc(legacyCategory.sort), asc(legacyCategory.id)),
      this.container.db
        .select({
          id: userLabel.id,
          label_cate: userLabel.labelCate,
          label_name: userLabel.name,
          color: userLabel.color,
          sort: userLabel.sort,
        })
        .from(userLabel)
        .where(and(
          eq(userLabel.type, PLATFORM_TYPE),
          eq(userLabel.relationId, PLATFORM_RELATION_ID),
          eq(userLabel.status, 1),
        ))
        .orderBy(desc(userLabel.sort), asc(userLabel.id)),
    ]);
    const labelsByCategory = new Map<number, Array<{
      id: number;
      label_name: string;
      color: string;
      disabled: boolean;
    }>>();
    for (const label of labels) {
      const group = labelsByCategory.get(label.label_cate) ?? [];
      group.push({
        id: label.id,
        label_name: label.label_name,
        color: label.color,
        disabled: selectedIds.has(label.id),
      });
      labelsByCategory.set(label.label_cate, group);
    }
    return categories.flatMap((category) => {
      const label = labelsByCategory.get(category.id) ?? [];
      return label.length ? [{ ...category, label }] : [];
    });
  }

  async setUserLabels(uid: number, input: unknown) {
    const body = record(input);
    const add = normalizeSegmentationIds(
      body.label_ids ?? body.label_id,
      "标签ID",
      MAX_LABELS_PER_REQUEST,
    );
    const remove = normalizeSegmentationIds(
      body.un_label_ids,
      "取消标签ID",
      MAX_LABELS_PER_REQUEST,
    );
    if (add.some((id) => remove.includes(id))) {
      throw new ValidateException("同一标签不能同时设置和取消");
    }
    await this.updateLabels([uid], add, remove, false);
  }

  async replaceUserLabels(uid: number, labels: unknown) {
    const normalized = normalizeSegmentationIds(labels, "标签ID", MAX_LABELS_PER_REQUEST);
    await this.updateLabels([uid], normalized, [], true);
  }

  async addUserLabels(uids: unknown, labels: unknown) {
    const normalizedUsers = normalizeSegmentationIds(uids, "用户ID", MAX_BULK_USERS);
    const normalizedLabels = normalizeSegmentationIds(labels, "标签ID", MAX_LABELS_PER_REQUEST);
    if (!normalizedUsers.length) throw new ValidateException("请选择用户");
    if (!normalizedLabels.length) throw new ValidateException("请选择标签");
    await this.updateLabels(normalizedUsers, normalizedLabels, [], false);
  }

  async assignGroup(uids: unknown, groupIdValue: unknown) {
    const normalizedUsers = normalizeSegmentationIds(uids, "用户ID", MAX_BULK_USERS);
    const groupId = integer(groupIdValue, "分组ID", 0);
    if (!normalizedUsers.length) throw new ValidateException("请选择用户");
    return withTx(this.container, async (tx) => {
      if (groupId > 0) {
        const group = await tx
          .select({ id: userGroup.id })
          .from(userGroup)
          .where(eq(userGroup.id, groupId))
          .limit(1)
          .for("key share");
        if (!group[0]) throw new NotFoundException("用户分组不存在");
      }
      const users = await tx
        .select({ uid: userTable.uid })
        .from(userTable)
        .where(and(inArray(userTable.uid, normalizedUsers), eq(userTable.isDel, 0)))
        .orderBy(asc(userTable.uid))
        .for("update");
      if (users.length !== normalizedUsers.length) throw new NotFoundException("部分用户不存在");
      await tx.update(userTable).set({ groupId }).where(inArray(userTable.uid, normalizedUsers));
    });
  }

  async updateUserAssignments(
    uid: number,
    groupIdValue: unknown | undefined,
    labelsValue: unknown | undefined,
  ) {
    if (groupIdValue === undefined && labelsValue === undefined) return;
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("用户ID错误");
    const groupId = groupIdValue === undefined ? undefined : integer(groupIdValue, "分组ID", 0);
    const labels = labelsValue === undefined
      ? undefined
      : normalizeSegmentationIds(labelsValue, "标签ID", MAX_LABELS_PER_REQUEST);
    return withTx(this.container, async (tx) => {
      const users = await tx
        .select({ uid: userTable.uid })
        .from(userTable)
        .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0)))
        .limit(1)
        .for("update");
      if (!users[0]) throw new NotFoundException("用户不存在");
      if (groupId !== undefined && groupId > 0) {
        const groups = await tx
          .select({ id: userGroup.id })
          .from(userGroup)
          .where(eq(userGroup.id, groupId))
          .limit(1)
          .for("key share");
        if (!groups[0]) throw new NotFoundException("用户分组不存在");
      }
      if (labels?.length) {
        const validLabels = await tx
          .select({ id: userLabel.id })
          .from(userLabel)
          .where(
            and(
              inArray(userLabel.id, labels),
              eq(userLabel.type, PLATFORM_TYPE),
              eq(userLabel.relationId, PLATFORM_RELATION_ID),
              eq(userLabel.status, 1),
            ),
          )
          .for("key share");
        if (validLabels.length !== labels.length) {
          throw new NotFoundException("部分用户标签不存在或已停用");
        }
      }
      if (groupId !== undefined) {
        await tx.update(userTable).set({ groupId }).where(eq(userTable.uid, uid));
      }
      if (labels !== undefined) {
        await tx
          .delete(userLabelRelation)
          .where(and(eq(userLabelRelation.uid, uid), platformRelationScope()));
        if (labels.length) {
          await tx.insert(userLabelRelation).values(
            labels.map((labelId) => ({
              uid,
              type: PLATFORM_TYPE,
              relationId: PLATFORM_RELATION_ID,
              labelId,
            })),
          );
        }
      }
    });
  }

  async deletePlatformLabel(id: number) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("标签ID错误");
    return withTx(this.container, async (tx) => {
      const labels = await tx
        .select({ id: userLabel.id })
        .from(userLabel)
        .where(
          and(
            eq(userLabel.id, id),
            eq(userLabel.type, PLATFORM_TYPE),
            eq(userLabel.relationId, PLATFORM_RELATION_ID),
          ),
        )
        .limit(1)
        .for("update");
      if (!labels[0]) throw new NotFoundException("用户标签不存在");
      await tx
        .delete(userLabelRelation)
        .where(and(eq(userLabelRelation.labelId, id), platformRelationScope()));
      await tx.delete(userLabel).where(eq(userLabel.id, id));
    });
  }

  private async updateLabels(
    uids: number[],
    add: number[],
    remove: number[],
    replace: boolean,
  ) {
    if (!uids.length) throw new ValidateException("请选择用户");
    return withTx(this.container, async (tx) => {
      const users = await tx
        .select({ uid: userTable.uid })
        .from(userTable)
        .where(and(inArray(userTable.uid, uids), eq(userTable.isDel, 0)))
        .orderBy(asc(userTable.uid))
        .for("update");
      if (users.length !== uids.length) throw new NotFoundException("部分用户不存在");
      if (add.length) {
        const labels = await tx
          .select({ id: userLabel.id })
          .from(userLabel)
          .where(
            and(
              inArray(userLabel.id, add),
              eq(userLabel.type, PLATFORM_TYPE),
              eq(userLabel.relationId, PLATFORM_RELATION_ID),
              eq(userLabel.status, 1),
            ),
          )
          .for("key share");
        if (labels.length !== add.length) throw new NotFoundException("部分用户标签不存在或已停用");
      }
      if (replace) {
        await tx
          .delete(userLabelRelation)
          .where(and(inArray(userLabelRelation.uid, uids), platformRelationScope()));
      } else if (remove.length) {
        await tx
          .delete(userLabelRelation)
          .where(
            and(
              inArray(userLabelRelation.uid, uids),
              inArray(userLabelRelation.labelId, remove),
              platformRelationScope(),
            ),
          );
      }
      if (!add.length) return;
      const existing = replace
        ? []
        : await tx
            .select({ uid: userLabelRelation.uid, labelId: userLabelRelation.labelId })
            .from(userLabelRelation)
            .where(
              and(
                inArray(userLabelRelation.uid, uids),
                inArray(userLabelRelation.labelId, add),
                platformRelationScope(),
              ),
            );
      const existingPairs = new Set(existing.map((item) => `${item.uid}:${item.labelId}`));
      const rows = uids.flatMap((uid) =>
        add
          .filter((labelId) => !existingPairs.has(`${uid}:${labelId}`))
          .map((labelId) => ({
            uid,
            type: PLATFORM_TYPE,
            relationId: PLATFORM_RELATION_ID,
            labelId,
          })),
      );
      if (rows.length) await tx.insert(userLabelRelation).values(rows);
    });
  }
}
