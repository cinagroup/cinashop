import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Container } from "@/lib/di";
import {
  pageCategory,
  pageLink,
  storeProductCategory,
  systemDise,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

const MAX_PAGE_SIZE = 100;

export interface PageCategoryTreeNode {
  id: number;
  pid: number;
  type: string;
  name: string;
  title: string;
  expand: true;
  children: PageCategoryTreeNode[];
}

interface PageCategoryRow {
  id: number;
  pid: number;
  type: string;
  name: string;
}

/** Reproduces the PHP pid=0 recursive catalogue while omitting disconnected cycles. */
export function buildPageCategoryTree(
  rows: readonly PageCategoryRow[],
): PageCategoryTreeNode[] {
  const childrenByPid = new Map<number, PageCategoryRow[]>();
  for (const row of rows) {
    const children = childrenByPid.get(row.pid) ?? [];
    children.push(row);
    childrenByPid.set(row.pid, children);
  }

  const visit = (row: PageCategoryRow, ancestors: ReadonlySet<number>): PageCategoryTreeNode => {
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(row.id);
    const children = (childrenByPid.get(row.id) ?? [])
      .filter((child) => !nextAncestors.has(child.id))
      .map((child) => visit(child, nextAncestors));
    return { ...row, title: row.name, expand: true, children };
  };

  return (childrenByPid.get(0) ?? []).map((row) => visit(row, new Set()));
}

function integer(value: unknown, field: string, fallback: number, minimum: number, maximum: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidateException(`${field}格式错误`);
  }
  return parsed;
}

function positiveId(value: unknown, field: string): number {
  return integer(value, field, 0, 1, 2_147_483_647);
}

function pagination(query: Record<string, string>) {
  return {
    page: integer(query.page, "页码", 1, 1, 1_000_000),
    limit: integer(query.limit, "每页数量", 20, 1, MAX_PAGE_SIZE),
  };
}

function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string, maximum: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new ValidateException(`请输入${field}`);
  if (text.length > maximum) throw new ValidateException(`${field}不能超过${maximum}个字符`);
  if (/[\u0000-\u001f\u007f]/u.test(text)) {
    throw new ValidateException(`${field}包含非法控制字符`);
  }
  return text;
}

export function normalizePageLinkInput(value: unknown): { name: string; url: string } {
  const body = inputRecord(value);
  const name = requiredText(body.name, "页面名称", 50);
  const url = requiredText(body.url, "页面链接", 255);
  if (/^(?:javascript|data|vbscript):/iu.test(url)) {
    throw new ValidateException("页面链接协议不安全");
  }
  return { name, url };
}

export class PageNavigationService {
  constructor(private readonly container: Container) {}

  async categoryTree(): Promise<PageCategoryTreeNode[]> {
    const rows = await this.container.db
      .select({
        id: pageCategory.id,
        pid: pageCategory.pid,
        type: pageCategory.type,
        name: pageCategory.name,
      })
      .from(pageCategory)
      .orderBy(desc(pageCategory.sort), asc(pageCategory.id));
    return buildPageCategoryTree(rows);
  }

  async links(cateIdValue: unknown, query: Record<string, string>) {
    const cateId = positiveId(cateIdValue, "页面分类ID");
    const categories = await this.container.db
      .select({ id: pageCategory.id, type: pageCategory.type })
      .from(pageCategory)
      .where(eq(pageCategory.id, cateId))
      .limit(1);
    const category = categories[0];
    if (!category) throw new NotFoundException("页面分类不存在");

    const { page, limit } = pagination(query);
    if (category.type === "special") return this.specialPages(page, limit);
    if (category.type === "product_category") {
      const pid = integer(query.pid, "父级分类ID", 0, 0, 2_147_483_647);
      return this.productCategories(pid, page, limit);
    }
    return this.staticLinks(cateId, page, limit);
  }

  async saveLink(cateIdValue: unknown, input: unknown) {
    const cateId = positiveId(cateIdValue, "页面分类ID");
    const category = await this.container.db
      .select({ id: pageCategory.id })
      .from(pageCategory)
      .where(eq(pageCategory.id, cateId))
      .limit(1);
    if (!category[0]) throw new NotFoundException("页面分类不存在");

    const { name, url } = normalizePageLinkInput(input);
    const inserted = await this.container.db
      .insert(pageLink)
      .values({ cateId, name, url, addTime: Math.floor(Date.now() / 1000) })
      .returning({ id: pageLink.id });
    return { id: inserted[0].id };
  }

  async deleteLink(idValue: unknown): Promise<void> {
    const id = positiveId(idValue, "页面链接ID");
    const deleted = await this.container.db
      .delete(pageLink)
      .where(eq(pageLink.id, id))
      .returning({ id: pageLink.id });
    if (!deleted[0]) throw new NotFoundException("页面链接不存在");
  }

  private async specialPages(page: number, limit: number) {
    const where = and(eq(systemDise.isDel, 0), inArray(systemDise.type, [1, 2]));
    const [list, countRows] = await Promise.all([
      this.container.db
        .select({
          is_diy: systemDise.isDiy,
          template_name: systemDise.templateName,
          id: systemDise.id,
          title: systemDise.title,
          name: systemDise.name,
          type: systemDise.type,
          add_time: systemDise.addTime,
          update_time: systemDise.updateTime,
          status: systemDise.status,
          cover_image: systemDise.coverImage,
        })
        .from(systemDise)
        .where(where)
        .orderBy(desc(systemDise.status), desc(systemDise.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(systemDise)
        .where(where),
    ]);
    return { list, count: countRows[0]?.count ?? 0 };
  }

  private async productCategories(pid: number, page: number, limit: number) {
    const where = and(
      eq(storeProductCategory.type, 0),
      eq(storeProductCategory.relationId, 0),
      eq(storeProductCategory.pid, pid),
      eq(storeProductCategory.isShow, 1),
    );
    const [list, countRows] = await Promise.all([
      this.container.db
        .select({
          id: storeProductCategory.id,
          pid: storeProductCategory.pid,
          type: storeProductCategory.type,
          relation_id: storeProductCategory.relationId,
          cate_name: storeProductCategory.cateName,
          path: storeProductCategory.path,
          level: storeProductCategory.level,
          pic: storeProductCategory.pic,
          big_pic: storeProductCategory.bigPic,
          adv_pic: storeProductCategory.advPic,
          adv_link: storeProductCategory.advLink,
          sort: storeProductCategory.sort,
          is_show: storeProductCategory.isShow,
          add_time: storeProductCategory.addTime,
        })
        .from(storeProductCategory)
        .where(where)
        .orderBy(desc(storeProductCategory.sort), desc(storeProductCategory.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeProductCategory)
        .where(where),
    ]);
    if (!list.length) return { list, count: countRows[0]?.count ?? 0 };

    const childRows = await this.container.db
      .selectDistinct({ pid: storeProductCategory.pid })
      .from(storeProductCategory)
      .where(and(
        eq(storeProductCategory.type, 0),
        eq(storeProductCategory.relationId, 0),
        eq(storeProductCategory.isShow, 1),
        inArray(storeProductCategory.pid, list.map((row) => row.id)),
      ));
    const parents = new Set(childRows.map((row) => row.pid));
    return {
      list: list.map((row) => parents.has(row.id)
        ? { ...row, children: [], loading: false, _loading: false }
        : row),
      count: countRows[0]?.count ?? 0,
    };
  }

  private async staticLinks(cateId: number, page: number, limit: number) {
    const where = eq(pageLink.cateId, cateId);
    const [list, countRows] = await Promise.all([
      this.container.db
        .select({
          id: pageLink.id,
          cate_id: pageLink.cateId,
          type: pageLink.type,
          name: pageLink.name,
          url: pageLink.url,
          param: pageLink.param,
          example: pageLink.example,
          status: pageLink.status,
          sort: pageLink.sort,
          add_time: pageLink.addTime,
        })
        .from(pageLink)
        .where(where)
        .orderBy(desc(pageLink.sort), asc(pageLink.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(pageLink)
        .where(where),
    ]);
    return { list, count: countRows[0]?.count ?? 0 };
  }
}
